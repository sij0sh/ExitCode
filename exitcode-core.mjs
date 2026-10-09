/**
 * exitcode-core.mjs — supervisor logic for the exitcode Pi extension.
 *
 * Contract-first recursive execution (lean v1):
 * every goal starts with a sealed acceptance contract, gets bounded
 * implementation attempts, and can create one smaller child at a time.
 * Only a fresh supervisor evaluation can close a goal.
 *
 * This module is Pi-agnostic on purpose: no Pi imports, no UI. The thin
 * adapter in exitcode.ts wires it to the extension runtime. File IO uses
 * node builtins against <cwd>/.exitcode/; command execution is injected
 * so tests can substitute a fake.
 */

import { createHash, randomUUID } from "node:crypto";
export { RECIPE_KINDS, MUTATION_KINDS } from "./exitcode-evaluator.mjs";
import { sandboxCommand, evaluatorCommand, candidateIdentity, evaluatorEnvironment, normalizeEvaluator, runRecipe, diagnostic, fileDigest, inventory, fixtureDirectory, captureEvaluatorAssets, verifyEvaluatorAssets, installEvaluatorAssets, restoreEvaluatorAssets, compatibleEnvironment, digest, safePath, criterionRequirement, validateEvaluatorAssetDefinitions } from "./exitcode-evaluator.mjs";
import { prepareGate, emptyMetrics, addMetrics, copyCandidate, releasePreparation } from "./exitcode-preparation.mjs";
import { ensureRunning, operationSignal, operationError } from "./exitcode-operation.mjs";
import { validateExecution, preflightExecution, createExecution, runExecution } from "./exitcode-parallel.mjs";
export { createPiWorkerBackend } from "./exitcode-workers.mjs";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXITCODE_DIR = ".exitcode";
export const MODE_ENTRY_TYPE = "exitcode-mode";

/**
 * Generation of everything persisted under .exitcode/. A store from any other
 * generation is archived whole and never interpreted; the candidate is untouched.
 */
export const STORE_FORMAT_VERSION = 2;

/** Persisted node states. FAIL is a check result, not a node state. BLOCKED is a withdrawn child only. */
export const NodeState = Object.freeze({
  DRAFT: "DRAFT",
  EVALUATOR_PREPARATION: "EVALUATOR_PREPARATION",
  READY_FOR_APPROVAL: "READY_FOR_APPROVAL",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  PASS: "PASS",
  BLOCKED: "BLOCKED",
});

/** Root policy locks at first approval; children inherit. */
export const DEFAULT_POLICY = Object.freeze({
  localRepairs: 2,
  maxDepth: 3,
  maxTotalAttempts: 12,
  deadlineMinutes: 60,
  evalTimeoutSeconds: 900,
  evaluatorAttempts: 6,
  maxParallelWorkers: 2,
});

/** Consecutive no-progress nudges before an explicit resumable pause. */
export const MAX_SETTLE_NUDGES = 3;

/** Rolling checkpoints kept per node. */
const MAX_CHECKPOINTS_PER_NODE = 3;

/** Snapshot size cap (logical bytes of file content, including build artifacts). */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * The agent may request only what ExitCode cannot know: user or external input.
 * NO_PATH withdraws a focused child. Configuration, runner, Git, worker, and
 * budget conditions are supervisor-owned and never chosen by the agent.
 */
export const BLOCK_CODES = Object.freeze([
  "REQUIREMENT_MISSING",
  "CREDENTIAL_MISSING",
  "AUTHORIZATION_MISSING",
  "EXTERNAL_BLOCKED",
  "NO_PATH",
]);

/**
 * Failure dispositions. Only INTERVENTION pauses the root; RETRY and REPAIR
 * keep it ACTIVE with the fault recorded as the next action.
 */
export const Disposition = Object.freeze({ RETRY: "retry", REPAIR: "repair", INTERVENTION: "intervention" });

/** Only the user or the external world can unblock these. */
const INTERVENTION_CODES = new Set([
  "REQUIREMENT_MISSING", "CREDENTIAL_MISSING", "AUTHORIZATION_MISSING", "EXTERNAL_BLOCKED",
  "BUDGET_EXHAUSTED", "DEADLINE_EXCEEDED", "EVALUATOR_UNBUILDABLE",
  // Continuing could lose work or trust damaged supervisor-owned evidence.
  "EVIDENCE_CORRUPT", "CHECKPOINT_INVALID", "RESTORATION_FAILED",
]);

/** Transient infrastructure: the same operation can simply run again. */
const RETRY_CODES = new Set([
  "RUNNER_ERROR", "CHECK_TIMEOUT", "OUTPUT_INCOMPLETE", "ISOLATION_UNAVAILABLE", "CANCELLED", "IO_ERROR",
  "GIT_FAILED", "GIT_UNAVAILABLE", "WORKER_FAILED", "WORKER_UNAVAILABLE", "CANDIDATE_MUTATED",
  "ENVIRONMENT_CHANGED", "CHECKPOINT_UNAVAILABLE", "OPERATION_BUSY", "INTERRUPTED", "REVIEW_TIMEOUT",
]);

/** One immediate evaluation retry for plausibly transient infrastructure, not waits or concurrent edits. */
const AUTO_RETRY_CODES = new Set(["RUNNER_ERROR", "IO_ERROR", "GIT_FAILED", "WORKER_FAILED"]);

export function faultDisposition(code) {
  if (INTERVENTION_CODES.has(code)) return Disposition.INTERVENTION;
  return RETRY_CODES.has(code) ? Disposition.RETRY : Disposition.REPAIR;
}

/**
 * Default attempt, time, and evaluator budgets are soft: crossing them asks the
 * agent to reconsider strategy. Explicit policy values are hard limits; a
 * default budget hard-stops only at this multiple of its soft threshold.
 */
export const SAFETY_CEILING_FACTOR = 4;
const SOFT_LIMIT_KEYS = Object.freeze(["maxTotalAttempts", "deadlineMinutes", "evaluatorAttempts"]);

/** Discarded pre-seal change sets kept for recovery. */
export const MAX_DISCARDED_CHANGES = 3;

/** Supervisor tools. Other agent tools are not classified; candidate state is verified instead. */
export const EXITCODE_TOOL_NAMES = Object.freeze([
  "exitcode_status", "exitcode_draft", "exitcode_seal",
  "exitcode_evaluate", "exitcode_child", "exitcode_block",
]);

/** The loop only. Tools explain how to act; the supervisor enforces invariants. */
export const PROTOCOL_PROMPT =
  "EXITCODE MODE. Understand the user's goal and inspect the project before changing it. " +
  "Before implementation, submit the smallest acceptance contract that observes outcomes to ExitCode; ask the user only when ambiguity materially changes success. " +
  "Keep product files unchanged until ExitCode validates the evaluator and the user approves the plan; submit contract-specific tests as assets with test_asset recipes, and follow diagnostics to repair the evaluator. " +
  "After sealing, implement toward failing criteria, evaluate after meaningful changes, and use a child only when a smaller goal helps one failing parent criterion. " +
  "For independent root work, declare an execution DAG with slice ids, verify, and after; exitcode_evaluate runs isolated workers and reconciles their fresh proofs. " +
  "Only a fresh root PASS completes the goal; pauses, errors, and child PASS do not.";

/** Upper bound on supervisor state injected into every agent turn. */
export const PROMPT_STATUS_MAX_BYTES = 4096;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Root G1 has depth 0; G1.1 depth 1; G1.1.2 depth 2. */
function depthOf(id) {
  return String(id).split(".").length - 1;
}

function isValidNodeId(id) {
  return typeof id === "string" && /^G\d+(\.\d+)*$/.test(id);
}

export function fingerprintGoal(goal) {
  return sha256Hex(String(goal).trim()).slice(0, 12);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Store layout and IO (<cwd>/.exitcode/)
// ---------------------------------------------------------------------------

export function storePaths(cwd) {
  const root = path.join(cwd, EXITCODE_DIR);
  return {
    root,
    index: path.join(root, "index.json"),
    rootsDir: path.join(root, "roots"),
    draftsDir: path.join(root, "drafts"),
    contractsDir: path.join(root, "contracts"),
    nodesDir: path.join(root, "nodes"),
    checkpointsDir: path.join(root, "checkpoints"),
    tmpDir: path.join(root, "tmp"),
    baselineDir: path.join(root, "baseline"),
    discardedDir: path.join(root, "discarded"),
    assetsDir: path.join(root, "assets"),
    archiveDir: path.join(root, "archive"),
    operation: path.join(root, "operation.lock"),
  };
}

/**
 * Move a store written by another generation, untouched, to
 * .exitcode/archive/<timestamp> and start fresh. Archives stay supervisor-private
 * and outside the candidate. Only the index records the generation; a store
 * without one holds no roots.
 */
function ensureStoreFormat(cwd) {
  const p = storePaths(cwd);
  const index = readJson(p.index);
  if (index === null || index.formatVersion === STORE_FORMAT_VERSION) return null;
  const moving = `${p.root}.archiving-${process.pid}-${randomUUID()}`;
  const archive = path.join(p.archiveDir, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.renameSync(p.root, moving);
  fs.mkdirSync(p.archiveDir, { recursive: true });
  fs.renameSync(moving, archive);
  return archive;
}

function ensureStoreDirs(cwd) {
  ensureStoreFormat(cwd);
  const p = storePaths(cwd);
  for (const dir of [p.root, p.rootsDir, p.draftsDir, p.contractsDir, p.nodesDir, p.checkpointsDir, p.tmpDir, p.assetsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`malformed JSON in ${file}: ${error.message}`);
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function loadIndex(cwd) {
  ensureStoreFormat(cwd);
  return readJson(storePaths(cwd).index) ?? { formatVersion: STORE_FORMAT_VERSION, rootCounter: 0, activeRootId: null, roots: [] };
}

export function saveIndex(cwd, index) {
  writeJsonAtomic(storePaths(cwd).index, index);
}

function rootFile(cwd, rootId) {
  return path.join(storePaths(cwd).rootsDir, `${rootId}.json`);
}

export function draftFile(cwd, nodeId) {
  return path.join(storePaths(cwd).draftsDir, `${nodeId}.json`);
}

export function sealedFile(cwd, nodeId) {
  return path.join(storePaths(cwd).contractsDir, `${nodeId}.sealed.json`);
}

function nodeFile(cwd, nodeId) {
  return path.join(storePaths(cwd).nodesDir, `${nodeId}.json`);
}

// ---------------------------------------------------------------------------
// Contract structure validation (gate: structure + traceability)
// ---------------------------------------------------------------------------

function validateExpect(expect, where, errors) {
  if (expect === undefined) return;
  if (!isRecord(expect)) {
    errors.push(`${where}: expect must be an object`);
    return;
  }
  if (expect.exit !== undefined && (!Number.isInteger(expect.exit) || expect.exit < 0 || expect.exit > 255)) {
    errors.push(`${where}: expect.exit must be an integer 0-255`);
  }
  for (const key of ["stdoutContains", "stdoutNotContains"]) {
    if (expect[key] === undefined) continue;
    if (!Array.isArray(expect[key]) || !expect[key].every((s) => typeof s === "string")) {
      errors.push(`${where}: expect.${key} must be an array of strings`);
    }
  }
}

function validateCheck(check, where, errors) {
  if (!isRecord(check) || !isRecord(check.recipe)) {
    errors.push(`${where}: check must be an object with a recipe (custom_command for an isolated shell check)`);
    return;
  }
  if (check.timeoutSeconds !== undefined && !(Number.isFinite(check.timeoutSeconds) && check.timeoutSeconds > 0 && Number.isFinite(check.timeoutSeconds*1000))) {
    errors.push(`${where}: check.timeoutSeconds must be a positive number`);
  }
  if(check.assets !== undefined && (!Array.isArray(check.assets) || !check.assets.every(nonEmptyString)))errors.push(`${where}: check.assets must contain candidate-relative paths`);
  validateExpect(check.expect, `${where}.check`, errors);
}

/** Controls are optional confined witnesses; E0 supplies deterministic negatives. */
const isWitness = (control) => isRecord(control) && Array.isArray(control.mutations) && control.mutations.length > 0;

function validateControls(controls, where, errors) {
  if (controls === undefined) return;
  if (!isRecord(controls)) {
    errors.push(`${where}: controls must be an object`);
    return;
  }
  if (controls.accept !== undefined && !isWitness(controls.accept)) {
    errors.push(`${where}: controls.accept needs nonempty mutations`);
  }
  if (controls.reject === undefined) return;
  if (!Array.isArray(controls.reject) || controls.reject.length === 0) {
    errors.push(`${where}: controls.reject must be a nonempty array when supplied`);
  } else {
    controls.reject.forEach((entry, i) => {
      if (!isWitness(entry)) errors.push(`${where}: controls.reject[${i}] needs nonempty mutations`);
    });
  }
}

/**
 * Validate draft structure. opts: { parent, parentDepth, parentLastResult, policy }
 * parent is the sealed parent bundle (or null for roots).
 */
export function validateStructure(draft, opts = {}) {
  const errors = [];
  const { parent = null, parentDepth = -1, parentLastResult = null, policy = DEFAULT_POLICY } = opts;

  if (!isRecord(draft)) return { ok: false, errors: ["draft must be an object"] };
  if (!isValidNodeId(draft.id)) errors.push("id must look like G1 or G1.2 (supervisor-assigned)");
  if (!nonEmptyString(draft.goal)) errors.push("goal must be a nonempty string");
  if (!nonEmptyString(draft.originalRequest)) {
    errors.push("originalRequest must retain the user's request (traceability)");
  }

  for (const key of ["assumptions", "exclusions"]) {
    if (draft[key] !== undefined && (!Array.isArray(draft[key]) || !draft[key].every(nonEmptyString))) {
      errors.push(`${key} must be an array of nonempty strings`);
    }
  }
  if(draft.specificationPaths !== undefined && (!Array.isArray(draft.specificationPaths) || !draft.specificationPaths.every(nonEmptyString)))errors.push("specificationPaths must be an array of paths");
  if(draft.mutableDependencies !== undefined && typeof draft.mutableDependencies !== "boolean")errors.push("mutableDependencies must be boolean");
  let assetErrorCode;
  try { validateEvaluatorAssetDefinitions(draft); } catch (e) { assetErrorCode=e.code;errors.push(`${e.code}: ${e.message}`); }

  const isChild = draft.parent !== null && draft.parent !== undefined;
  if (!isChild) {
    if (draft.parent !== null && draft.parent !== undefined) errors.push("parent must be null for a root goal");
  } else {
    if (!isRecord(draft.parent)) {
      errors.push("parent must be null or { id, targets }");
    } else {
      if (!parent) errors.push(`parent ${draft.parent.id} is not sealed`);
      else if (draft.parent.id !== parent.contract.id) errors.push("parent.id must reference the sealed parent contract");
      if (!Array.isArray(draft.parent.targets) || draft.parent.targets.length !== 1) {
        errors.push("parent.targets must name exactly one failing parent criterion");
      } else if (parent) {
        const target = draft.parent.targets[0];
        const known = parent.contract.criteria.some((c) => c.id === target);
        if (!known) errors.push(`parent target ${target} does not exist in ${parent.contract.id}`);
        else if (parentLastResult) {
          const outcome = parentLastResult.outcomes.find((o) => o.criterionId === target);
          if (outcome && outcome.status === "PASS") {
            errors.push(`parent target ${target} currently passes; a child must target a failing criterion`);
          }
        }
      }
      if (parentDepth + 1 > (policy.maxDepth ?? DEFAULT_POLICY.maxDepth)) {
        errors.push(`depth ${parentDepth + 1} exceeds maxDepth ${policy.maxDepth}`);
      }
    }
  }

  if (!Array.isArray(draft.criteria) || draft.criteria.length === 0) {
    errors.push("criteria must be a nonempty array");
  } else {
    const seen = new Set();
    draft.criteria.forEach((criterion, index) => {
      const where = `criteria[${index}]`;
      if (!isRecord(criterion)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!nonEmptyString(criterion.id)) errors.push(`${where}.id must be a nonempty string`);
      else if (seen.has(criterion.id)) errors.push(`duplicate criterion id ${criterion.id}`);
      else seen.add(criterion.id);
      const type = criterion.type ?? "behavior";
      if (type !== "behavior" && type !== "regression") {
        errors.push(`${criterion.id || where}: type must be "behavior" or "regression"`);
      }
      if (type === "regression" && !nonEmptyString(criterion.requirement)) errors.push(`${criterion.id || where}: regression requirement must be a nonempty string`);
      if (type === "behavior" && criterion.requirement !== undefined) errors.push(`${criterion.id || where}: behavior text comes from outcome.requirement; remove criterion.requirement`);
      if (criterion.outcome !== undefined && !nonEmptyString(criterion.outcome))
        errors.push(`${criterion.id || where}: outcome must be a nonempty outcome id when supplied`);
      if (type === "regression" && criterion.outcome !== undefined)
        errors.push(`${criterion.id || where}: regression criteria must not claim a requested outcome`);
      validateCheck(criterion.check, `${criterion.id || where}`, errors);
      validateControls(criterion.controls, `${criterion.id || where}`, errors);
    });
  }

  if (draft.outcomes !== undefined) {
    if (!Array.isArray(draft.outcomes) || draft.outcomes.length === 0) {
      errors.push("outcomes must be a nonempty array when supplied");
    } else {
      const seen = new Set();
      draft.outcomes.forEach((outcome, index) => {
        const where = `outcomes[${index}]`;
        if (!isRecord(outcome)) { errors.push(`${where} must be an object`); return; }
        if (!nonEmptyString(outcome.id)) errors.push(`${where}.id must be a nonempty string`);
        else if (seen.has(outcome.id)) errors.push(`duplicate outcome id ${outcome.id}`);
        else seen.add(outcome.id);
        if (!nonEmptyString(outcome.requirement)) errors.push(`${outcome.id || where}: requirement must be a nonempty string`);
      });
    }
  }

  if (draft.sequence !== undefined) {
    if (isChild) {
      errors.push("sequence is root-only");
    } else if (!Array.isArray(draft.sequence) || draft.sequence.length === 0) {
      errors.push("sequence must be a nonempty array when supplied");
    } else if (draft.sequence.length > 12) {
      errors.push("sequence must contain at most 12 slices");
    } else {
      const criteria = Array.isArray(draft.criteria) ? draft.criteria : [];
      const behaviorIds = new Set(criteria.filter(c => (c?.type ?? "behavior") === "behavior").map(c => c?.id));
      const seen = new Set();
      const sliceOf = new Map();
      draft.sequence.forEach((slice, index) => {
        const where = `sequence[${index}]`;
        if (!isRecord(slice)) { errors.push(`${where} must be an object`); return; }
        if (!nonEmptyString(slice.objective)) errors.push(`${where}.objective must be a nonempty string`);
        else if (slice.objective.trim().length > 200) errors.push(`${where}.objective must be at most 200 characters`);
        if (!Array.isArray(slice.verify) || slice.verify.length === 0) {
          errors.push(`${where}.verify must be a nonempty array of behavior criterion ids`);
        } else {
          for (const id of slice.verify) {
            if (typeof id !== "string" || !id) { errors.push(`${where}.verify must contain nonempty criterion ids`); continue; }
            if (!behaviorIds.has(id)) {
              const exists = criteria.some(c => c?.id === id);
              errors.push(exists ? `${where}.verify must reference behavior criteria only` : `${where}.verify references unknown criterion ${id}`);
            }
            if (seen.has(id)) errors.push(`criterion ${id} appears in more than one sequence slice`);
            seen.add(id);
            sliceOf.set(id, index);
          }
        }
        if (slice.after !== undefined) {
          if (!Array.isArray(slice.after) || !slice.after.every(id => typeof id === "string" && id)) {
            errors.push(`${where}.after must be an array of criterion ids when supplied`);
          } else {
            for (const id of slice.after) {
              if (!behaviorIds.has(id)) { errors.push(`${where}.after references unknown behavior criterion ${id}`); continue; }
              const depSlice = sliceOf.get(id);
              if (depSlice === undefined || depSlice >= index)
                errors.push(`${where}.after requires ${id} in an earlier slice`);
            }
          }
        }
      });
      for (const id of behaviorIds)
        if (!seen.has(id)) errors.push(`behavior criterion ${id} is missing from the sequence`);
    }
  }

  errors.push(...validateExecution(draft));
  return { ok: errors.length === 0, errors, ...(assetErrorCode?{code:assetErrorCode}:{}) };
}

/** Assign O1..On to outcomes missing an id; returns a new array. */
export function assignOutcomeIds(outcomes) {
  let next = 1;
  const used = new Set((outcomes ?? []).filter((o) => nonEmptyString(o.id)).map((o) => o.id));
  return (outcomes ?? []).map((outcome) => {
    if (nonEmptyString(outcome.id)) return outcome;
    while (used.has(`O${next}`)) next += 1;
    const id = `O${next}`;
    next += 1;
    used.add(id);
    return { ...outcome, id };
  });
}

/** Assign C1..Cn to criteria missing an id; returns a new array. */
export function assignCriterionIds(criteria) {
  let next = 1;
  const used = new Set(criteria.filter((c) => nonEmptyString(c.id)).map((c) => c.id));
  return criteria.map((criterion) => {
    if (nonEmptyString(criterion.id)) return criterion;
    while (used.has(`C${next}`)) next += 1;
    const id = `C${next}`;
    next += 1;
    used.add(id);
    return { ...criterion, id };
  });
}

// ---------------------------------------------------------------------------
// Expectation predicate (verifier side; candidate stdout is evidence only)
// ---------------------------------------------------------------------------

/**
 * Apply a criterion's fixed expectation to one run.
 * run: { exit: number|null, stdout: string, timedOut: boolean, error?: string }
 */
export function matchesExpect(run, expect) {
  const reasons = [];
  const wanted = { exit: 0, ...(expect ?? {}) };
  if (run.timedOut) {
    reasons.push(`timed out`);
    return { pass: false, reasons };
  }
  if (run.error) {
    reasons.push(`runner error: ${run.error}`);
    return { pass: false, reasons };
  }
  if (wanted.exit !== undefined && run.exit !== wanted.exit) {
    reasons.push(`exit ${run.exit}, wanted ${wanted.exit}`);
  }
  const stdout = run.stdout ?? "";
  for (const needle of wanted.stdoutContains ?? []) {
    if (!stdout.includes(needle)) reasons.push(`stdout missing ${JSON.stringify(needle)}`);
  }
  for (const needle of wanted.stdoutNotContains ?? []) {
    if (stdout.includes(needle)) reasons.push(`stdout contains forbidden ${JSON.stringify(needle)}`);
  }
  return { pass: reasons.length === 0, reasons };
}

function tailText(text, maxBytes = 4000) {
  const value = String(text ?? "");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, truncated: false };
  const buf = Buffer.from(value, "utf8");
  return { text: buf.subarray(bytes - maxBytes).toString("utf8"), truncated: true };
}

// ---------------------------------------------------------------------------
// Checks and evaluation
// ---------------------------------------------------------------------------

function checkTimeoutMs(criterion, defaultTimeoutMs) {
  const seconds = criterion?.check?.timeoutSeconds;
  if(seconds!==undefined){if(!Number.isFinite(seconds)||seconds<=0||!Number.isFinite(seconds*1000))throw operationError("INVALID_SPEC","check timeout must be finite and positive");return seconds*1000;}
  return defaultTimeoutMs;
}

export async function runCheck(criterion, exec, cwd, defaultTimeoutMs, {signal,deadlineAt,nowMs=Date.now,readOnlyPaths=[],capabilities,onExecution}={}) {
  const started=Date.now();
  let operation;
  try {
    const requested=checkTimeoutMs(criterion,defaultTimeoutMs);
    const timeoutMs=Number.isFinite(deadlineAt)?Math.min(requested,Math.max(0,deadlineAt-nowMs())):requested;
    ensureRunning(signal,deadlineAt,nowMs);
    operation=operationSignal(signal,{timeoutMs,deadlineAt,nowMs});
    const options={cwd,timeoutMs,signal:operation.signal,deadlineAt,nowMs,writable:true,readOnlyPaths};
    // The default sandbox resolves only after process-group exit. Trusted executors
    // must honor cancellation and settle only after their executable has stopped.
    const run=await runRecipe(criterion.check.recipe,{...options,exec,capabilities,onExecution});
    ensureRunning(operation.signal,deadlineAt,nowMs);
    if(run?.truncated && criterion.check.expect?.stdoutNotContains?.length)throw operationError("OUTPUT_INCOMPLETE","truncated output cannot prove the absence of forbidden content");
    if(!isRecord(run) || !run.error && !run.timedOut && (!Number.isInteger(run.exit) || run.exit<0 || run.exit>255))throw operationError("RUNNER_ERROR","runner did not report a complete process exit");
    const {pass,reasons}=matchesExpect({exit:run.exit,stdout:run.stdout??"",timedOut:Boolean(run.timedOut),error:run.error},criterion.check.expect);
    return {criterionId:criterion.id,status:run.timedOut||run.error?"ERROR":pass?"PASS":"FAIL",exit:run.exit,timedOut:Boolean(run.timedOut),
      ...(run.errorCode?{errorCode:run.errorCode}:{}),reasons,stdoutTail:tailText(run.stdout??"").text,stderrTail:tailText(run.stderr??"").text,durationMs:Date.now()-started};
  } catch(error) {
    return {criterionId:criterion.id,status:"ERROR",exit:null,timedOut:error.code==="CHECK_TIMEOUT",errorCode:error.code??"RUNNER_ERROR",
      reasons:[`runner error: ${error.message}`],stdoutTail:"",stderrTail:"",durationMs:Date.now()-started};
  } finally {operation?.dispose();}
}

export function allPass(outcomes) {
  return outcomes.length > 0 && outcomes.every((o) => o.status === "PASS");
}

/** Only a conclusive PASS -> FAIL establishes a regression. */
export function detectRegression(prevOutcomes, nextOutcomes) {
  const prev = new Map(prevOutcomes.map((o) => [o.criterionId, o.status]));
  const regressed = [];
  for (const outcome of nextOutcomes) {
    if (prev.get(outcome.criterionId) === "PASS" && outcome.status === "FAIL") regressed.push(outcome.criterionId);
  }
  return regressed;
}

export function formatVector(outcomes) {
  return outcomes.map((o) => `${o.criterionId}=${o.status}`).join(" ");
}

/** Ordered root proof: cumulative slices, regressions always in horizon. */
function isOrdered(contract) {
  return Array.isArray(contract?.sequence) && contract.sequence.length > 0;
}
function horizonIds(contract, index) {
  const seq = contract.sequence;
  const idx = Math.max(0, Math.min(index ?? 0, seq.length - 1));
  const behavior = [];
  for (let i = 0; i <= idx; i++) for (const id of seq[i].verify) if (!behavior.includes(id)) behavior.push(id);
  const regressions = contract.criteria.filter(c => c.type === "regression").map(c => c.id);
  return [...behavior, ...regressions];
}
function isLastSlice(contract, index) {
  return (index ?? 0) >= (contract.sequence.length - 1);
}

// ---------------------------------------------------------------------------
// Candidate identity and environment
// ---------------------------------------------------------------------------

/** Full relevant candidate content identity, including modes and symlink targets. */
export function digestTree(cwd,options) { return candidateIdentity(cwd,options); }

// ---------------------------------------------------------------------------
// Checkpoints (file-tree snapshots; restore on regression)
// ---------------------------------------------------------------------------

export function snapshotTree(cwd, destDir, { maxBytes = SNAPSHOT_MAX_BYTES, writeManifest = true, signal, deadlineAt, nowMs=Date.now } = {}) {
  try {
    ensureRunning(signal,deadlineAt,nowMs);
    const entries = inventory(cwd,{dependencies:true,signal,deadlineAt,nowMs});
    const totalBytes=entries.reduce((n,f)=>n+(f.size??0),0);
    if(totalBytes>maxBytes)throw operationError("CAPACITY_UNAVAILABLE",`working tree exceeds snapshot cap (${maxBytes} bytes): ${totalBytes} bytes across ${entries.length} files; fixtures cannot reduce the pre-copy size`);
    // Metadata is never stored inside the candidate payload.
    const payload=writeManifest?path.join(destDir,"tree"):destDir;
    fs.mkdirSync(payload,{recursive:true});
    const files=[];
    for(const entry of entries) {
      ensureRunning(signal,deadlineAt,nowMs);
      const dest=path.join(payload,entry.rel);fs.mkdirSync(path.dirname(dest),{recursive:true});
      if(entry.link!==undefined){fs.symlinkSync(entry.link,dest);files.push({path:entry.rel,link:entry.link,bytes:0});continue;}
      fs.copyFileSync(entry.full,dest,fs.constants.COPYFILE_FICLONE);fs.chmodSync(dest,entry.mode);
      if(fs.statSync(dest).size!==entry.size || fileDigest(dest,{signal,deadlineAt,nowMs})!==entry.sha)throw operationError("CANDIDATE_MUTATED",`file changed while snapshotting ${entry.rel}`);
      files.push({path:entry.rel,bytes:entry.size,sha:entry.sha,mode:entry.mode});
    }
    const manifest={at:new Date().toISOString(),totalBytes,files,...(writeManifest?{payload:"tree"}:{})};
    if(writeManifest)writeJsonAtomic(path.join(destDir,"manifest.json"),manifest);
    return {ok:true,manifest};
  } catch(error) {
    fs.rmSync(destDir,{recursive:true,force:true});
    return {ok:false,errorCode:error.code??"IO_ERROR",reason:`snapshot failed (${error.code??"IO_ERROR"}): ${error.message}`};
  }
}

/** Validate the entire restoration point before deleting any candidate files. */
function checkpointPayload(snapDir,manifest,{signal,deadlineAt,nowMs=Date.now}={}) {
  ensureRunning(signal,deadlineAt,nowMs);
  if(!manifest || !Array.isArray(manifest.files) || (manifest.payload!==undefined && manifest.payload!=="tree"))throw operationError("CHECKPOINT_INVALID","invalid checkpoint manifest");
  const source=manifest.payload?path.join(snapDir,manifest.payload):snapDir,seen=new Set();
  for(const file of manifest.files) {
    ensureRunning(signal,deadlineAt,nowMs);
    if(seen.has(file.path))throw operationError("CHECKPOINT_INVALID","duplicate checkpoint path");seen.add(file.path);
    const full=safePath(source,file.path,{allowFinalSymlink:true,allowConfig:true}),stat=fs.lstatSync(full);
    if(file.link!==undefined) {
      if(!stat.isSymbolicLink() || fs.readlinkSync(full)!==file.link)throw operationError("CHECKPOINT_INVALID",`checkpoint symlink changed: ${file.path}`);
    } else if(!stat.isFile() || stat.size!==file.bytes || fileDigest(full,{signal,deadlineAt,nowMs})!==file.sha || file.mode!==undefined && (stat.mode&0o777)!==file.mode)
      throw operationError("CHECKPOINT_INVALID",`checkpoint bytes changed: ${file.path}`);
  }
  ensureRunning(signal,deadlineAt,nowMs);
  return source;
}

/** A manifest file still matches a current inventory entry. */
function sameEntry(file, entry) {
  return file.link !== undefined ? entry.link === file.link
    : entry.link === undefined && entry.sha === file.sha && entry.mode === file.mode;
}

/** Restore cwd to a snapshot: rewrite changed manifest files, delete files added later. */
export function restoreTree(cwd, snapDir, manifest,options={}) {
  const running=()=>ensureRunning(options.signal,options.deadlineAt,options.nowMs);
  const payload=checkpointPayload(snapDir,manifest,options);
  const wanted = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const restored = [];
  const removed = [];
  const current = new Map();
  for (const entry of inventory(cwd,{...options,dependencies:true})) {
    running();
    if (wanted.has(entry.rel)) {
      current.set(entry.rel, entry);
      continue;
    }
    fs.rmSync(entry.full, { force: true });
    removed.push(entry.rel);
  }
  // Prune only directories emptied by removals, before restored files may need their paths.
  for (const rel of removed) {
    for (let dir = path.dirname(path.join(cwd, rel)); dir !== cwd && dir.startsWith(cwd + path.sep); dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; }
    }
  }
  for (const file of wanted.values()) {
    running();
    // Unchanged files keep their inode and timestamps.
    if (current.has(file.path) && sameEntry(file, current.get(file.path))) continue;
    const dest = path.join(cwd, file.path);
    // Never follow an added symlink when restoring trusted checkpoint bytes.
    let parent = path.dirname(dest);
    const parents=[];
    while(parent!==cwd&&parent.startsWith(cwd+path.sep)){parents.unshift(parent);parent=path.dirname(parent);}
    for(const dir of parents){try{if(fs.lstatSync(dir).isSymbolicLink())fs.unlinkSync(dir);}catch(e){if(e.code!=="ENOENT")throw e;}fs.mkdirSync(dir,{recursive:true});}
    try{const stat=fs.lstatSync(dest);if(stat.isSymbolicLink() || stat.isFile())fs.unlinkSync(dest);else if(stat.isDirectory())fs.rmSync(dest,{recursive:true});}catch(e){if(e.code!=="ENOENT")throw e;}
    if(file.link!==undefined){fs.symlinkSync(file.link,dest);restored.push(file.path);continue;}
    fs.copyFileSync(path.join(payload, file.path), dest, fs.constants.COPYFILE_FICLONE);
    if(file.mode!==undefined)fs.chmodSync(dest,file.mode);
    restored.push(file.path);
  }
  for(const file of wanted.values()) {
    running();
    const full=path.join(cwd,file.path);
    if(file.link!==undefined?fs.readlinkSync(full)!==file.link:fileDigest(full,options)!==file.sha || file.mode!==undefined && (fs.statSync(full).mode&0o777)!==file.mode)throw operationError("RESTORATION_FAILED",`restored identity differs: ${file.path}`);
  }
  running();
  return { ok: true, restored, removed };
}

// ---------------------------------------------------------------------------
// Pre-seal baseline. Agent tools are not classified. Until the current phase
// seals, any candidate change is detected at supervisor boundaries, saved for
// recovery, and restored. External side effects are out of scope.
// ---------------------------------------------------------------------------

function baselinePaths(cwd) {
  const dir = storePaths(cwd).baselineDir;
  return { dir, record: path.join(dir, "baseline.json"), manifest: path.join(dir, "manifest.json"), tree: path.join(dir, "tree") };
}

/**
 * Key of the current unsealed phase, or null while a sealed ACTIVE leaf
 * permits candidate changes. Discovery and a terminal pause use the next
 * root slot, which a new root draft continues; each child draft is its own
 * phase. Missing or unexpected state never grants execution.
 */
export function baselineScope(io) {
  const index = loadIndex(io.cwd);
  if (!index.activeRootId) return `G${index.rootCounter + 1}`;
  const root = loadRoot(io, index.activeRootId);
  if (![NodeState.ACTIVE,NodeState.PAUSED].includes(root?.status)) return index.activeRootId;
  const leafId = leafOf(root) ?? root.id;
  return root.status===NodeState.ACTIVE && loadNodeState(io, leafId)?.status === NodeState.ACTIVE ? null : leafId;
}

/** Record the candidate that must stay unchanged until the phase seals. */
export function captureBaseline(io, scope = baselineScope(io)) {
  return workspaceOperation(io,"baseline",locked => recordBaseline(locked,scope));
}

function recordBaseline(io,scope) {
  const p = baselinePaths(io.cwd);
  fs.rmSync(p.dir, { recursive: true, force: true });
  // The manifest describes exactly what a restore reproduces.
  const snap = snapshotTree(io.cwd, p.tree, { writeManifest: false });
  if (snap.ok) writeJsonAtomic(p.manifest, snap.manifest);
  // Without a restorable copy, the identity still detects changes. Unreadable trees also fail preparation.
  let digest = null;
  try { digest = digestTree(io.cwd); } catch {}
  const record = { scope, digest, ...(snap.ok ? {} : { unrestorable: snap.reason }) };
  writeJsonAtomic(p.record, { at: new Date().toISOString(), ...record });
  return record;
}

export function releaseBaseline(cwd) {
  fs.rmSync(storePaths(cwd).baselineDir, { recursive: true, force: true });
}

/** Start the current unsealed phase's baseline once; sealed execution keeps none. */
export function ensureBaseline(io) {
  return workspaceOperation(io,"baseline",locked => startBaseline(locked));
}

function startBaseline(io) {
  const scope = baselineScope(io);
  if (scope === null) {
    releaseBaseline(io.cwd);
    return null;
  }
  const record = readJson(baselinePaths(io.cwd).record);
  return record?.scope === scope ? record : captureBaseline(io, scope);
}

function candidateChanges(cwd, manifest,options) {
  const wanted = new Map(manifest.files.map((f) => [f.path, f]));
  const changes = { modified: [], added: [], removed: [] };
  for (const entry of inventory(cwd,{...options,dependencies:true})) {
    const file = wanted.get(entry.rel);
    wanted.delete(entry.rel);
    if (!file) changes.added.push(entry);
    else if (!sameEntry(file, entry)) changes.modified.push(entry);
  }
  changes.removed = [...wanted.keys()];
  return changes;
}

const unchanged = (changes) => changes.modified.length + changes.added.length + changes.removed.length === 0;

function describeChanges(changes) {
  const list = (label, rels) => rels.length === 0 ? [] :
    [`${label} ${rels.slice(0, 8).join(", ")}${rels.length > 8 ? ` and ${rels.length - 8} more` : ""}`];
  return [...list("modified", changes.modified.map((f) => f.rel)), ...list("added", changes.added.map((f) => f.rel)),
    ...list("removed", changes.removed)].join("; ") || "unlisted changes";
}

/** Keep the changed and added files of a discarded change set; only the latest few remain. */
function saveDiscarded(cwd, changes) {
  const root = storePaths(cwd).discardedDir;
  fs.mkdirSync(root, { recursive: true });
  const sets = fs.readdirSync(root).sort();
  const dir = path.join(root, `d-${String((parseInt(sets.at(-1)?.slice(2), 10) || 0) + 1).padStart(6, "0")}`);
  try {
    for (const entry of [...changes.modified, ...changes.added]) {
      const dest = path.join(dir, "files", entry.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (entry.link !== undefined) fs.symlinkSync(entry.link, dest);
      else fs.copyFileSync(entry.full, dest, fs.constants.COPYFILE_FICLONE);
    }
    writeJsonAtomic(path.join(dir, "changes.json"), { at: new Date().toISOString(),
      modified: changes.modified.map((f) => f.rel), added: changes.added.map((f) => f.rel), removed: changes.removed });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  for (const old of [...sets, path.basename(dir)].slice(0, -MAX_DISCARDED_CHANGES)) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }
  return path.relative(cwd, dir);
}

/**
 * Before sealing, the candidate is immutable regardless of which tools ran.
 * Restore any change since the phase baseline after saving it for recovery.
 * Returns { ok: true } when unchanged, otherwise { ok: false, restored, message }.
 */
export function enforceBaseline(io) {
  return workspaceOperation(io,"baseline",locked => restoreBaseline(locked));
}

function restoreBaseline(io) {
  const scope = baselineScope(io);
  if (scope === null) return { ok: true };
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  const options={signal:io.signal,deadlineAt:root?.deadlineAt,nowMs:io.nowMs};
  const p = baselinePaths(io.cwd);
  const record = readJson(p.record);
  if (record?.scope !== scope) {
    captureBaseline(io, scope);
    return { ok: true };
  }
  const manifest = record.unrestorable ? null : readJson(p.manifest);
  if (!manifest) {
    if (record.digest == null || digestTree(io.cwd) === record.digest) return { ok: true };
    // Digest-bound preparation evidence for the previous candidate is already stale.
    captureBaseline(io, scope);
    return { ok: false, restored: false, message: `Candidate changed before sealing and cannot be restored (${record.unrestorable ?? "baseline snapshot missing"}). The change is kept as the new pre-seal baseline; prepare the evaluator again.` };
  }
  const changes = candidateChanges(io.cwd, manifest,options);
  if (unchanged(changes)) return { ok: true };
  const summary = describeChanges(changes);
  let saved;
  try {
    saved = saveDiscarded(io.cwd, changes);
  } catch (error) {
    return { ok: false, restored: false, message: `Candidate changed before sealing (${summary}), but the changed files could not be saved for recovery (${error.message}), so they were left in place. Revert them, or the user can cancel with /exitcode exit.` };
  }
  let failure = null;
  try {
    restoreTree(io.cwd, p.tree, manifest,options);
    const left = candidateChanges(io.cwd, manifest,options);
    if (!unchanged(left)) failure = `still ${describeChanges(left)}`;
  } catch (error) {
    failure = error.message;
  }
  if (failure) {
    return { ok: false, restored: false, discarded: saved, message: `Candidate changed before sealing (${summary}) and restoration failed (${failure}). The changed files are saved in ${saved}. Revert the remaining changes, or the user can cancel with /exitcode exit.` };
  }
  return { ok: false, restored: true, discarded: saved, message: `Candidate changes are not permitted before the contract is sealed (${summary}). The working tree was restored to the pre-seal baseline; the discarded files are saved in ${saved} for the user. Continue inspection without modifying the candidate.` };
}

/** Pre-seal operations run on the baseline candidate and report any discarded change. */
function onBaseline(io, operation) {
  const guard = enforceBaseline(io);
  if (!guard.ok && !guard.restored) return { ok: false, errors: [guard.message] };
  const report = (result) => guard.ok ? result : { ...result, warnings: [guard.message, ...(result.warnings ?? [])] };
  const result = operation();
  return typeof result?.then === "function" ? result.then(report) : report(result);
}

// ---------------------------------------------------------------------------
// Budgets and decomposition policy
// ---------------------------------------------------------------------------

/** Explicit policy values are hard; omitted defaults are soft thresholds. */
function isHardLimit(root, key) {
  return (root.explicitLimits ?? []).includes(key);
}

/** The value that actually stops work: the explicit limit, or the safety ceiling above a soft default. */
function ceilingOf(root, key) {
  const value = root.policy?.[key] ?? DEFAULT_POLICY[key];
  return isHardLimit(root, key) ? value : value * SAFETY_CEILING_FACTOR;
}

function deadlineAtMs(startedAtMs, root) {
  return startedAtMs + ceilingOf(root, "deadlineMinutes") * 60 * 1000;
}

/** Budget keys the draft set explicitly; review shows them and approval binds them. */
function explicitLimitsOf(overrides, previous = []) {
  return [...new Set([...previous, ...Object.keys(isRecord(overrides) ? overrides : {}).filter((k) => SOFT_LIMIT_KEYS.includes(k))])].sort();
}

function attemptLimitOf(root) {
  return root.attemptLimit ?? ceilingOf(root, "maxTotalAttempts");
}

function evaluatorLimitOf(root, node) {
  return node?.evaluatorAttemptLimit ?? ceilingOf(root, "evaluatorAttempts");
}

/** "3/12" for a hard limit; "3/12 soft, ceiling 48" for a default threshold. */
function attemptBudgetText(root) {
  const limit = attemptLimitOf(root);
  if (isHardLimit(root, "maxTotalAttempts") || root.attemptLimit !== undefined && root.attemptLimit !== ceilingOf(root, "maxTotalAttempts"))
    return `${root.consumedAttempts ?? 0}/${limit}`;
  return `${root.consumedAttempts ?? 0}/${root.policy.maxTotalAttempts} soft, ceiling ${limit}`;
}

/** Strategy warnings once a soft default is crossed; work continues. */
function softBudgetWarnings(root, nowMs, node = null) {
  const warnings = [];
  const attempts = root.policy?.maxTotalAttempts ?? DEFAULT_POLICY.maxTotalAttempts;
  if (!isHardLimit(root, "maxTotalAttempts") && (root.consumedAttempts ?? 0) >= attempts)
    warnings.push(`this approach has consumed ${root.consumedAttempts} changed candidates (soft threshold ${attempts}); reconsider decomposition or strategy before continuing`);
  if (Number.isFinite(root.softDeadlineAt) && nowMs >= root.softDeadlineAt && !isExpired(root, nowMs))
    warnings.push(`execution has run past its ${root.policy.deadlineMinutes}-minute soft threshold; reconsider strategy before continuing`);
  const proposals = root.policy?.evaluatorAttempts ?? DEFAULT_POLICY.evaluatorAttempts;
  if (node?.status === NodeState.DRAFT && !isHardLimit(root, "evaluatorAttempts") && (node.evaluatorMetrics?.e0Attempts ?? 0) >= proposals)
    warnings.push(`evaluator preparation has used ${node.evaluatorMetrics.e0Attempts} proposals (soft threshold ${proposals}); simplify the evaluator before retrying`);
  return warnings;
}

function isExpired(root, nowMs) {
  return Number.isFinite(root.deadlineAt) && nowMs >= root.deadlineAt;
}

/** Shared-budget check before consuming work (attempt, child, seal). */
function budgetsOk(root, nowMs) {
  if (isExpired(root, nowMs)) return { ok: false, reason: "shared deadline exceeded" };
  if ((root.consumedAttempts ?? 0) >= attemptLimitOf(root)) {
    return { ok: false, reason: `total attempt budget exhausted (${attemptLimitOf(root)})` };
  }
  return { ok: true };
}

/**
 * Deterministic child gates. Semantic fit ("will this help?") stays with the
 * model; being wrong surfaces as no parent progress.
 */
export function childGates({ root, parentState, parentResult, target, goal, siblings, nowMs, environmentIdentity }) {
  const errors = [];
  if (root?.execution) errors.push("recursive children are unavailable during root DAG execution; workers repair within their own sessions");
  if (!parentState || parentState.status !== NodeState.ACTIVE) {
    errors.push("parent must be sealed and ACTIVE before it can have a child");
  }
  if (parentState && depthOf(parentState.id) + 1 > (root.policy.maxDepth ?? DEFAULT_POLICY.maxDepth)) {
    errors.push(`depth ${depthOf(parentState.id) + 1} exceeds maxDepth ${root.policy.maxDepth}`);
  }
  const budget = budgetsOk(root, nowMs);
  if (!budget.ok) errors.push(budget.reason);
  const activeSibling = (siblings ?? []).find((s) => [NodeState.ACTIVE,NodeState.DRAFT,NodeState.PAUSED].includes(s.status));
  if (activeSibling) {
    const hint = activeSibling.status === NodeState.DRAFT ? `; pass revise:"${activeSibling.id}" to revise it` : "";
    errors.push(`only one active child at a time (${activeSibling.id} is ${activeSibling.status}${hint})`);
  }
  if (parentResult) {
    const outcome = parentResult.outcomes.find((o) => o.criterionId === target);
    if (!outcome) errors.push(`target ${target} is not a parent criterion`);
    else if (outcome.status === "PASS") errors.push(`target ${target} currently passes; a child must target a failing criterion`);
    else if (outcome.status !== "FAIL") errors.push(`target ${target} needs a current FAIL, not ${outcome.status}; evaluate the active slice first`);
  }
  const goalDigest = fingerprintGoal(goal);
  const repeat = (siblings ?? []).find(
    (s) => s.status === NodeState.BLOCKED && s.target === target && s.goalDigest === goalDigest && s.candidateDigest === parentState?.lastCandidateDigest &&
      s.environmentIdentity === environmentIdentity,
  );
  if (repeat) errors.push(`identical child already blocked on unchanged evidence (${repeat.id}); try a different path`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Tool-call guards (the extension maps these onto Pi tool events)
// ---------------------------------------------------------------------------

function resolveWithin(cwd, filePath) {
  return path.resolve(cwd, filePath);
}

function isPathUnder(filePath, dir) {
  const rel = path.relative(dir, filePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Built-in tools whose path argument ExitCode can interpret. */
const PATH_TOOL_NAMES = Object.freeze(["read", "write", "edit", "grep", "find", "ls"]);

/**
 * Decide whether a tool call is permitted. Tools are not classified: before
 * sealing, candidate immutability is verified by enforceBaseline. In every
 * phase, direct access to supervisor-owned .exitcode/ state is denied.
 * Returns null to allow, or { block: true, reason } to deny.
 */
export function guardToolCall({ modeOn, cwd, toolName, input }) {
  if (!modeOn) return null;
  if (EXITCODE_TOOL_NAMES.includes(toolName)) return null;
  const storeRoot = path.join(cwd, EXITCODE_DIR);

  if (PATH_TOOL_NAMES.includes(toolName) && typeof input?.path === "string") {
    if (isPathUnder(resolveWithin(cwd, input.path), storeRoot) || /(^|[\\/])\.exitcode([\\/]|$)/.test(input.path)) {
      return { block: true, reason: "exitcode: supervisor-owned state under .exitcode/ is private to ExitCode tools. Use exitcode_status to inspect contract state." };
    }
    return null;
  }
  if (toolName === "bash" || toolName === "powershell") {
    const command = String(input?.command ?? "");
    if (command.includes(EXITCODE_DIR)) {
      return { block: true, reason: "exitcode: shell commands mentioning .exitcode are blocked to protect supervisor-owned artifacts. Use exitcode_status to inspect contract state." };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mode persistence (session entries carry the flag; disk carries contracts)
// ---------------------------------------------------------------------------

export function resolveModeFromBranch(branch) {
  let mode = { on: false, rootId: undefined, pendingGoal: undefined, handoff: undefined };
  for (const entry of branch ?? []) {
    if (entry?.type === "custom" && entry?.customType === MODE_ENTRY_TYPE) {
      mode = { on: Boolean(entry?.data?.on), rootId: entry?.data?.rootId,
        pendingGoal: typeof entry?.data?.pendingGoal === "string" ? entry.data.pendingGoal : undefined,
        handoff: typeof entry?.data?.handoff === "string" ? entry.data.handoff : undefined };
    }
  }
  return mode;
}

// ---------------------------------------------------------------------------
// Supervisor flows. io = { cwd, exec?, nowMs? }.
// exec defaults to execCommand; nowMs defaults to Date.now.
// ---------------------------------------------------------------------------

/** This process's live operation tokens. A lock outside them never blocks this process. */
const PROCESS_NONCE = randomUUID();
const liveTokens = new Set();

/** A lock younger than this may still be mid-write by another process. */
const LOCK_WRITE_GRACE_MS = 5000;

function readLock(file) {
  try { return { owner: readJson(file), mtimeMs: fs.statSync(file).mtimeMs }; }
  catch (e) {
    if (e.code === "ENOENT") return { owner: null, mtimeMs: 0 };
    try { return { owner: undefined, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return { owner: null, mtimeMs: 0 }; }
  }
}

/**
 * The mutex protects supervisor state; it is not itself authoritative. A lock
 * that cannot belong to a live operation is removed instead of blocking the user.
 */
function staleLock({ owner, mtimeMs }) {
  if (!isRecord(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0) return Date.now() - mtimeMs > LOCK_WRITE_GRACE_MS;
  if (owner.pid === process.pid) return !(owner.processNonce === PROCESS_NONCE && liveTokens.has(owner.token));
  try { process.kill(owner.pid, 0); return false; }
  catch (e) {
    if (e.code === "ESRCH") return true;
    if (e.code === "EPERM") return false;
    throw e;
  }
}

function acquireLock(file) {
  try { return fs.openSync(file, "wx"); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  const lock = readLock(file);
  if (!staleLock(lock)) return { busy: lock.owner?.kind ?? "operation" };
  fs.rmSync(file, { force: true });
  try { return fs.openSync(file, "wx"); }
  catch (e) { if (e.code === "EEXIST") return { busy: "operation" }; throw e; }
}

/** Kinds whose success shows a recorded fault has been overcome. */
const FAULT_CLEARING = new Set(["draft", "prepare", "seal", "evaluate", "block"]);

/** One state-changing operation per workspace, including across Pi sessions. */
function workspaceOperation(io,kind,work) {
  let fd,token;
  const file=storePaths(io.cwd).operation;
  try {
    ensureStoreDirs(io.cwd);
    if(io.operationToken && liveTokens.has(io.operationToken) && readLock(file).owner?.token===io.operationToken)return work(io);
    ensureRunning(io.signal);
    const activeRootId=loadIndex(io.cwd).activeRootId;
    if(Object.hasOwn(io,"expectedRootId") && activeRootId!==(io.expectedRootId??null) && !(kind==="baseline" && !activeRootId) && !(kind==="recover" && !activeRootId && io.expectedRootId && loadRoot(io,io.expectedRootId)?.closingStack))return {ok:false,code:"ROOT_MISMATCH",errors:["session root differs from active workspace root; resume the current root explicitly"]};
    const acquired=acquireLock(file);
    if(!Number.isInteger(acquired))return {ok:false,code:"OPERATION_BUSY",errors:[`workspace operation ${acquired.busy} is already in progress; retry shortly`]};
    fd=acquired;token=randomUUID();liveTokens.add(token);
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,processNonce:PROCESS_NONCE,token,kind,at:io.nowMs()}));
    const locked={...io,operationToken:token};
    const finish=()=>{fs.closeSync(fd);fd=undefined;liveTokens.delete(token);fs.rmSync(file,{force:true});};
    const settle=result=>{if(result?.ok && FAULT_CLEARING.has(kind))clearFault(locked);return result;};
    const failed=e=>{
      const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
      const reason=`${kind} failed (${e.code??"IO_ERROR"}): ${e.message}`;
      const node=root?loadNodeState(locked,leafOf(root)):null;
      if(root?.status===NodeState.ACTIVE && isUnsealedRootDraft(locked,root,node) && ["draft","prepare"].includes(kind)) {
        if(node.preparationReservation?.operationToken===locked.operationToken) {
          node.evaluatorMetrics.e0Attempts--;
          delete node.preparationReservation;delete node.preparing;
        }
        node.phase="EVALUATOR_PREPARATION";
        node.diagnostics??=[];
        node.diagnostics.push(diagnostic(e.code??"IO_ERROR",kind,node.id,reason,"Repair the draft or environment, or retry preparation","supervisor"));
        delete node.prepared;delete node.preparedDigest;
        delete root.approval;delete root.validatedBundleDigest;
        saveNodeState(locked,node);saveRoot(locked,root);
        return {ok:false,id:node.id,status:root.status,phase:node.phase,diagnostics:node.diagnostics,errors:[reason],next:nextAction(root,node)};
      }
      return root && root.status!==NodeState.PASS ? failRoot(locked,root,{code:e.code??"IO_ERROR",reason,nodeId:leafOf(root),operation:kind}) : {ok:false,errors:[reason]};
    };
    try {
      const result=work(locked);
      if(result?.then)return result.then(settle).catch(failed).finally(finish);
      settle(result);finish();return result;
    } catch(e) {try{return failed(e);}finally{if(fd!==undefined)finish();}}
  } catch(e) {
    if(fd!==undefined){fs.closeSync(fd);liveTokens.delete(token);fs.rmSync(file,{force:true});}
    return {ok:false,code:e.code??"IO_ERROR",errors:[`${kind} boundary failed (${e.code??"IO_ERROR"}): ${e.message}`]};
  }
}

function operationIo(io, root) {
  const operation=operationSignal(io.signal,{deadlineAt:root.deadlineAt,nowMs:io.nowMs});
  return {io:{...io,signal:operation.signal,deadlineAt:root.deadlineAt},dispose:operation.dispose};
}

function ensureBudget(io,root) {ensureRunning(io.signal,root.deadlineAt,io.nowMs);}

function isUnsealedRootDraft(io,root,node) {
  return root && node?.id===root.id && node.status===NodeState.DRAFT && !node.parentId &&
    root.executionStartedAt==null && !fs.existsSync(sealedFile(io.cwd,node.id));
}

function pauseRecovery(io,root,pause) {
  if (["BUDGET_EXHAUSTED","DEADLINE_EXCEEDED","EVALUATOR_UNBUILDABLE"].includes(pause.code)) return "grant";
  if (["CREDENTIAL_MISSING","AUTHORIZATION_MISSING","REQUIREMENT_MISSING","EXTERNAL_BLOCKED","REVIEW_CONFIGURATION"].includes(pause.code)) return "external";
  const node=loadNodeState(io,pause.nodeId);
  if(node?.status===NodeState.DRAFT) return "repair";
  return pause.operation==="evaluate" || pause.operation==="block" && pause.args ? "retry" : "external";
}

/** Legacy preparation pauses cannot lock an unsealed root's editing boundaries. */
function recoverEditableDraft(io,root,node) {
  if(root?.status!==NodeState.PAUSED || !isUnsealedRootDraft(io,root,node) || leafOf(root)!==node.id) return false;
  const pause=root.pause;
  if(!pause || pause.nodeId!==node.id || !(["draft","prepare"].includes(pause.operation) ||
    pause.recovery==="repair" || ["EVALUATOR_PREPARATION","READY_FOR_APPROVAL","TEST_STAGING"].includes(pause.phase))) return false;
  // Unlocking editing grants no execution or evaluator budget. Preparation still
  // checks the counters, credentials, and other prerequisites on the next call.
  root.pauseHistory??=[];
  if(!root.pauseHistory.some(p=>stableStringify(p)===stableStringify(pause)))root.pauseHistory.push(structuredClone(pause));
  delete root.pause;root.status=NodeState.ACTIVE;
  node.phase="EVALUATOR_PREPARATION";
  // The workspace lock excludes a live preparation owner. Its interrupted
  // reservation stays charged, but a stale flag cannot prevent the next retry.
  delete node.preparing;
  saveRoot(io,root);saveNodeState(io,node);
  return true;
}

/** Only user or external intervention pauses. Every other failure leaves the root ACTIVE with a recorded fault. */
function failRoot(io,root,fault) {
  const code=fault.code??"IO_ERROR";
  return faultDisposition(code)===Disposition.INTERVENTION ? pauseRoot(io,root,{...fault,code}) : recordFault(io,root,{...fault,code});
}

/** Recent faults kept for diagnosis. */
const MAX_FAULT_HISTORY = 8;

function faultNext(fault) {
  const operation = { evaluate: "exitcode_evaluate", prepare: "exitcode_draft revision or preparation", seal: "exitcode_seal", draft: "exitcode_draft", block: "exitcode_block" }[fault.operation] ?? fault.operation;
  return fault.disposition === Disposition.RETRY
    ? `transient ${fault.code}; run ${operation} again (the root stays ACTIVE)`
    : `${fault.code}: repair the cause, then continue with ${operation} (the root stays ACTIVE)`;
}

/** A fault is the next action, never a transfer of control to the user. */
function recordFault(io,root,{code,reason,nodeId=leafOf(root),operation="evaluate",args,details}) {
  // An interrupted verdict commit never stands; the stack returns to its pre-commit shape.
  if(root.closingStack)recoverClosing(io,loadIndex(io.cwd),root);
  root.fault={code,reason,disposition:faultDisposition(code),nodeId,operation,at:io.nowMs(),...(args?{args}:{}),...(details?{details}:{})};
  root.faultHistory=[...(root.faultHistory??[]),root.fault].slice(-MAX_FAULT_HISTORY);
  saveRoot(io,root);
  return {ok:false,fault:root.fault,root:root.id,status:root.status,errors:[reason],
    events:[`${root.id} ${root.status} (${root.fault.disposition} ${code}): ${reason}`],next:faultNext(root.fault)};
}

function clearFault(io) {
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  if(root?.fault){delete root.fault;saveRoot(io,root);}
}

/** A pause is not terminal and never drops approval, candidates, counters, or the stack. */
function pauseRoot(io,root,{code,reason,nodeId=leafOf(root),operation="evaluate",args,details,recovery}) {
  if(root.closingStack)root.stack=[...root.closingStack];
  root.status=NodeState.PAUSED;
  delete root.fault;
  root.pause={code,reason,nodeId,operation,phase:loadNodeState(io,nodeId)?.phase??"EXECUTION",at:io.nowMs(),
    ...(args?{args}:{}),...(details?{details}:{})};
  root.pause.recovery=recovery??pauseRecovery(io,root,root.pause);
  root.pauseHistory??=[];root.pauseHistory.push(root.pause);
  saveRoot(io,root);
  const leaf=loadNodeState(io,leafOf(root));
  if(leaf?.status===NodeState.ACTIVE){
    // A sealed pause freezes its useful work, never an old preparation candidate.
    try{captureBaseline(io,leaf.id);}catch(e){root.pause.baselineError=`${e.code??"IO_ERROR"}: ${e.message}`;saveRoot(io,root);}
  }
  const grant=root.pause.recovery==="grant";
  return {ok:false,paused:true,root:root.id,status:NodeState.PAUSED,pause:root.pause,errors:[reason],
    events:[`${root.id} PAUSED (${code}): ${reason}`],next:grant?"the user grants more budget with /exitcode resume minutes=N, attempts=N, or evaluators=N":"the user restores the prerequisite, then /exitcode resume"};
}

/** Report a supervisor-observed failure; it pauses only when user or external intervention is required. */
export function failNode(io,{reason,code="NO_PROGRESS",operation="evaluate"}) {
  return workspaceOperation(io,"fail",io=>{
    const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
    return root?failRoot(io,root,{reason,code,operation}):{ok:false,errors:["no root to report"]};
  });
}

// ---------------------------------------------------------------------------
// Workspace ownership. At most one root owns the canonical workspace; other
// unfinished roots stay fully persisted, detached, and resumable.
// ---------------------------------------------------------------------------

function rootGoal(io,rootId) {
  return loadBundle(io,rootId)?.contract.goal ?? readJson(draftFile(io.cwd,rootId))?.draft?.goal ?? "";
}

/** Compact description of an unfinished root for status and new-goal handoff. */
export function rootSummary(io,rootOrId) {
  const root=typeof rootOrId==="string"?loadRoot(io,rootOrId):rootOrId;
  if(!root)return null;
  const node=loadNodeState(io,root.id),sealed=fs.existsSync(sealedFile(io.cwd,root.id));
  const lines=[`${root.id} — ${JSON.stringify(clip(rootGoal(io,root.id),160))}`,`state: ${root.status} / ${sealed?"sealed":"unsealed"}`];
  if(node?.lastResult)lines.push(`last proof: ${formatVector(node.lastResult.outcomes)}`);
  if(root.pause)lines.push(`pause: ${root.pause.code}`);
  return lines.join("\n");
}

/** Context for a new goal's discovery: prior work may overlap, but the workspace is authoritative. */
export function handoffText(summary) {
  return ["Previous unfinished ExitCode root:",summary,"Detached when this new goal started.",
    "The current workspace is authoritative and may contain useful work from it. Consider overlap with the new request; ask the user only if the relationship materially changes what should be preserved or considered complete."].join("\n");
}

/** Unfinished roots that do not own the workspace, most recently detached first. */
export function resumableRoots(io) {
  const index=loadIndex(io.cwd);
  return index.roots.filter(id=>id!==index.activeRootId).map(id=>loadRoot(io,id))
    .filter(root=>root && ([NodeState.ACTIVE,NodeState.PAUSED].includes(root.status) || root.closingStack))
    .sort((a,b)=>(b.detachedAt??0)-(a.detachedAt??0))
    .map(root=>({id:root.id,status:root.status,goal:rootGoal(io,root.id),sealed:fs.existsSync(sealedFile(io.cwd,root.id)),detachedAt:root.detachedAt??null}));
}

function detachActive(io,reason) {
  const index=loadIndex(io.cwd),id=index.activeRootId;
  if(!id)return {ok:true,detached:null};
  const root=loadRoot(io,id);
  if(root?.closingStack)recoverClosing(io,index,root);
  if(root && [NodeState.ACTIVE,NodeState.PAUSED].includes(root.status)){root.detachedAt=io.nowMs();root.detachedReason=reason;saveRoot(io,root);}
  index.activeRootId=null;saveIndex(io.cwd,index);
  // The detached root keeps its contracts and checkpoints; its pre-seal baseline belongs to no phase now.
  releaseBaseline(io.cwd);
  return {ok:true,detached:id,summary:root?rootSummary(io,root):null};
}

/**
 * Release workspace ownership without deleting any root state. Refused only
 * while a live operation holds the workspace.
 */
export function detachRoot(io,{reason="detached by the user"}={}) {
  return workspaceOperation(io,"detach",io=>detachActive(io,reason));
}

/**
 * Make root the workspace owner. A reattached root treats the current
 * workspace as truth: stale preparation and approval are dropped, and sealed
 * verdicts recorded for another tree never act as a regression baseline.
 */
function attachRoot(io,index,root) {
  index.activeRootId=root.id;saveIndex(io.cwd,index);
  if(root.detachedAt==null)return [];
  root.detachHistory=[...(root.detachHistory??[]),{at:root.detachedAt,reason:root.detachedReason,reattachedAt:io.nowMs()}];
  delete root.detachedAt;delete root.detachedReason;
  releaseBaseline(io.cwd);
  const current=digestTree(io.cwd),reconciled=[];
  for(const id of root.closingStack??root.stack) {
    const node=loadNodeState(io,id);
    if(node?.status===NodeState.DRAFT && node.prepared && !preparationMatches(io,node)) {
      node.phase="EVALUATOR_PREPARATION";delete node.prepared;delete node.preparedDigest;
      if(!node.parentId){
        delete root.approval;delete root.validatedBundleDigest;
        const draft=readJson(draftFile(io.cwd,id))?.draft;if(draft)root.reviewDigest=rootReviewDigest(root,draft);
      }
      saveNodeState(io,node);reconciled.push(`${id}: prepare the evaluator again against the current workspace`);
    } else if(node?.status===NodeState.ACTIVE && node.lastResult && node.lastCandidateDigest!==current) {
      node.lastResult={...node.lastResult,stale:true};
      saveNodeState(io,node);reconciled.push(`${id}: evaluate the current workspace fresh`);
    }
  }
  saveRoot(io,root);
  return reconciled;
}

/**
 * Re-enter a root, switching workspace ownership when another root owns it.
 * Only the user-facing adapter may grant more execution time or attempts.
 * Without an id: the owner, else the most recently detached unfinished root.
 */
export function resumeRoot(io,{deadlineMinutes,maxTotalAttempts,evaluatorAttempts,rootId}={}) {
  return workspaceOperation(io,"resume",io=>{
    let index=loadIndex(io.cwd);
    const id=rootId??index.activeRootId??resumableRoots(io)[0]?.id;
    const root=id?loadRoot(io,id):null;
    if(!root)return {ok:false,errors:["no unfinished root to resume"]};
    if(![NodeState.ACTIVE,NodeState.PAUSED].includes(root.status) && !root.closingStack)return {ok:false,errors:[`root ${root.id} is ${root.status}`]};
    for(const [key,value] of Object.entries({deadlineMinutes,maxTotalAttempts,evaluatorAttempts}))if(value!==undefined &&
      (!Number.isFinite(value)||value<=0||key!=="deadlineMinutes"&&!Number.isSafeInteger(value)))return {ok:false,errors:[`${key} grant must be finite and positive`]};
    const node=loadNodeState(io,root.id),draft=readJson(draftFile(io.cwd,root.id))?.draft;
    if(!node || !draft)return {ok:false,errors:["root draft or node is missing; restore supervisor evidence before resuming"]};
    // The execution clock starts exactly when the root seals.
    if((deadlineMinutes!==undefined || maxTotalAttempts!==undefined) && !Number.isFinite(root.deadlineAt))
      return {ok:false,errors:["execution grants require a sealed execution clock"]};
    const deadline=deadlineMinutes!==undefined?Math.max(root.deadlineAt,io.nowMs())+deadlineMinutes*60000:root.deadlineAt;
    if(deadlineMinutes!==undefined && !Number.isFinite(new Date(deadline).getTime()))return {ok:false,errors:["execution grant exceeds supported deadline range"]};
    const attemptLimit=attemptLimitOf(root)+(maxTotalAttempts??0);
    if(!Number.isSafeInteger(attemptLimit))return {ok:false,errors:["attempt grant exceeds supported accounting range"]};
    if(isExpired({deadlineAt:deadline},io.nowMs()))return {ok:false,errors:["execution budget exhausted; /exitcode resume minutes=N records an explicit user grant"]};
    if(root.pause?.code==="BUDGET_EXHAUSTED" && root.consumedAttempts>=attemptLimit)return {ok:false,errors:["attempt budget exhausted; /exitcode resume attempts=N records an explicit user grant"]};
    const leafAtResume=loadNodeState(io,leafOf(root)??root.id);
    if(evaluatorAttempts!==undefined && leafAtResume?.status!==NodeState.DRAFT)return {ok:false,errors:["evaluator grants require an unsealed leaf"]};
    const evaluatorLimit=evaluatorLimitOf(root,leafAtResume)+(evaluatorAttempts??0);
    if(!Number.isSafeInteger(evaluatorLimit))return {ok:false,errors:["evaluator grant exceeds supported accounting range"]};
    if(root.pause?.code==="EVALUATOR_UNBUILDABLE" && (leafAtResume?.evaluatorMetrics?.e0Attempts??0)>=evaluatorLimit)return {ok:false,errors:["evaluator construction budget exhausted; /exitcode resume evaluators=N records an explicit user grant"]};
    // Explicit user intent is authority to switch owners; the lock excludes a live operation.
    const switched=index.activeRootId && index.activeRootId!==root.id ? detachActive(io,`switched to ${root.id}`).detached : null;
    index=loadIndex(io.cwd);
    const reconciled=attachRoot(io,index,root);
    recoverClosing(io,index,root);
    const leaf=loadNodeState(io,leafOf(root)??root.id);
    if(deadlineMinutes!==undefined || maxTotalAttempts!==undefined || evaluatorAttempts!==undefined) {
      root.executionGrants??=[];
      root.executionGrants.push({approvedBy:"user",at:io.nowMs(),deadlineMinutes,maxTotalAttempts,evaluatorAttempts,nodeId:leaf?.id??root.id,
        previousDeadline:root.deadlineAt,previousAttemptLimit:attemptLimitOf(root),previousEvaluatorLimit:evaluatorLimit-(evaluatorAttempts??0)});
      // Duration and count grants are separate from the immutable approved policy.
      if(deadlineMinutes!==undefined)root.deadlineAt=deadline;
      if(maxTotalAttempts!==undefined)root.attemptLimit=attemptLimit;
      saveRoot(io,root);
      if(evaluatorAttempts!==undefined){const current=loadNodeState(io,leaf?.id??root.id);current.evaluatorAttemptLimit=evaluatorLimit;saveNodeState(io,current);}
    }
    const baseline=enforceBaseline(io);
    if(!baseline.ok && !baseline.restored)return {ok:false,errors:[baseline.message]};
    const restored=[];
    for(const id of root.stack) {
      const state=loadNodeState(io,id);
      if(state?.status!==NodeState.ACTIVE)continue;
      const bundle=loadBundle(io,id),verified=verifyBundle(bundle,state);
      if(!verified.ok)return {ok:false,errors:[verified.reason]};
      const overlay=overlayEvaluator(io,bundle);
      if(overlay)restored.push({nodeId:id,...overlay});
    }
    ensureBudget(io,root);
    if(restored.length){root.acceptanceRestorations??=[];root.acceptanceRestorations.push({at:io.nowMs(),restored});}
    const pending=root.pause;
    let recovery=pending?.recovery??(pending?pauseRecovery(io,root,pending):"repair");
    if(leaf?.status===NodeState.DRAFT && recovery==="retry")recovery="repair";
    if(pending) {
      root.pauseHistory??=[];
      if(!root.pauseHistory.some(p=>stableStringify(p)===stableStringify(pending)))root.pauseHistory.push(structuredClone(pending));
    }
    delete root.pause;root.status=NodeState.ACTIVE;
    for(const id of root.stack)clearInterruptedPreparation(io,id);
    saveRoot(io,root);
    // Repair and prerequisite/grant recovery return control to the agent. Even
    // old retry classifications must never replay an unsealed leaf's prepare.
    const granted=deadlineMinutes!==undefined || maxTotalAttempts!==undefined || evaluatorAttempts!==undefined;
    const retry=(recovery==="retry" || recovery==="grant" && granted) && leaf?.status!==NodeState.DRAFT && ["evaluate","block"].includes(pending?.operation);
    return {ok:true,id:root.id,switchedFrom:switched,reconciled,acceptanceRestored:restored,warnings:baseline.ok?[]:[baseline.message],recovery, retry,operation:retry?pending.operation:"continue",nodeId:pending?.nodeId??leafOf(root),args:retry?pending.args:undefined,
      next:nextAction(root,loadNodeState(io,leafOf(root)),draft,io.nowMs())};
  });
}

/**
 * Command execution is injectable. The default prefers bubblewrap and degrades
 * to disposable host processes with a warning; strictIsolation fails closed.
 */
export function makeIo(cwd, { strictIsolation = process.env.EXITCODE_STRICT_ISOLATION === "1", ...overrides } = {}) {
  return { cwd, exec: strictIsolation ? sandboxCommand : evaluatorCommand, nowMs: () => Date.now(), ...overrides };
}

function newRunId() {
  return `R${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function loadRoot(io, rootId) {
  return readJson(rootFile(io.cwd, rootId));
}

export function saveRoot(io, root) {
  writeJsonAtomic(rootFile(io.cwd, root.id), root);
}

export function loadNodeState(io, nodeId) {
  return readJson(nodeFile(io.cwd, nodeId));
}

export function saveNodeState(io, node) {
  writeJsonAtomic(nodeFile(io.cwd, node.id), node);
}

export function loadBundle(io, nodeId) {
  return readJson(sealedFile(io.cwd, nodeId));
}

function verifyBundle(bundle,node) {
  if (!bundle) return { ok: false, reason: "missing sealed bundle" };
  if(!node?.sealedBundleDigest || node.sealedBundleDigest!==sha256Hex(stableStringify(bundle)))return {ok:false,reason:"sealed evaluator differs from its supervisor identity"};
  const contractDigest = sha256Hex(stableStringify(bundle.contract));
  if (contractDigest !== bundle.digest) return { ok: false, reason: "sealed bundle digest mismatch (tampering or disk corruption)" };
  if(bundle.integrityDigest!==sha256Hex(stableStringify({contractDigest:bundle.digest,assets:bundle.assets,env:bundle.env,candidateDigest:bundle.candidateDigest})))
    return {ok:false,reason:"sealed evaluator identity mismatch"};
  return { ok: true };
}

function leafOf(root) {
  return root.stack.length > 0 ? root.stack[root.stack.length - 1] : null;
}

function defaultTimeoutMs(root) {
  return (root.policy.evalTimeoutSeconds ?? DEFAULT_POLICY.evalTimeoutSeconds) * 1000;
}

function takeCheckpoint(io, node, note) {
  const id = `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  const dir = path.join(storePaths(io.cwd).checkpointsDir, node.id, id);
  const snap = snapshotTree(io.cwd, dir, {signal:io.signal,deadlineAt:io.deadlineAt,nowMs:io.nowMs});
  if (!snap.ok) return { ok: false, warning: `checkpoint skipped: ${snap.reason}` };
  const checkpoint = { id, dir, note, at: new Date().toISOString(), candidateDigest: digestTree(path.join(dir,"tree")),manifestDigest:sha256Hex(stableStringify(snap.manifest)) };
  if(checkpoint.candidateDigest!==digestTree(io.cwd)){fs.rmSync(dir,{recursive:true,force:true});return {ok:false,warning:"candidate changed while checkpointing"};}
  node.checkpoints.push(checkpoint);
  pruneCheckpoints(io, node);
  return { ok: true, checkpoint };
}

function pruneCheckpoints(io, node) {
  // Pre-child checkpoints of terminal children are no longer needed.
  node.checkpoints = node.checkpoints.filter((c) => {
    if (!c.note?.startsWith("pre-child:")) return true;
    const child = loadNodeState(io, c.note.slice("pre-child:".length));
    if (child && (child.status === NodeState.PASS || child.status === NodeState.BLOCKED)) {
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
      } catch {}
      return false;
    }
    return true;
  });
  // Cap rolling checkpoints; always keep pre-child checkpoints of live children.
  const rolling = node.checkpoints.filter((c) => !c.note?.startsWith("pre-child:"));
  while (rolling.length > MAX_CHECKPOINTS_PER_NODE) {
    const dropped = rolling.shift();
    node.checkpoints = node.checkpoints.filter((c) => c.id !== dropped.id);
    try {
      fs.rmSync(dropped.dir, { recursive: true, force: true });
    } catch {}
  }
}

function restoreCheckpoint(io, node, predicate) {
  const candidates = node.checkpoints.filter(predicate ?? (() => true));
  if (candidates.length === 0) return { ok: false, reason: "no restorable checkpoint" };
  const checkpoint = candidates[candidates.length - 1];
  const manifest = readJson(path.join(checkpoint.dir, "manifest.json"));
  if (!manifest) return { ok: false, reason: `checkpoint ${checkpoint.id} manifest missing` };
  if(checkpoint.manifestDigest!==sha256Hex(stableStringify(manifest)))throw operationError("CHECKPOINT_INVALID","checkpoint manifest differs from its supervisor identity");
  const source=checkpointPayload(checkpoint.dir,manifest,io);
  const identity=digest(manifest.files.map(f=>({rel:f.path,sha:f.sha,size:f.link===undefined?f.bytes:undefined,mode:f.mode,link:f.link})));
  if(identity!==checkpoint.candidateDigest || manifest.payload && digestTree(source)!==checkpoint.candidateDigest)
    throw operationError("CHECKPOINT_INVALID","checkpoint cannot reproduce its recorded candidate identity");
  const restored = restoreTree(io.cwd, checkpoint.dir, manifest,io);
  if(digestTree(io.cwd)!==checkpoint.candidateDigest)throw operationError("RESTORATION_FAILED","restored checkpoint identity differs");
  // A supervisor restore moves the candidate; any unsealed phase restarts from it.
  releaseBaseline(io.cwd);
  return { ok: true, checkpoint, ...restored };
}

/** Rolling checkpoints (seal/eval) are verified-clean trees; pre-child ones are not. */
const ROLLING_CP = (c) => !c.note?.startsWith("pre-child:");

/**
 * Sealed evaluator copies are supervisor-owned. Live drift of pinned evaluator
 * runtime files is re-overlaid from them; only a damaged sealed copy stops work.
 * Returns null when nothing needed restoring.
 */
function overlayEvaluator(io,bundle) {
  try {verifyEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);return null;}
  catch(e){if(e.code!=="EVALUATOR_DRIFT")throw e;}
  try {verifyEvaluatorAssets(bundle.assetsDirectory,bundle.assetsDirectory,bundle.assets);}
  catch(e){throw operationError("EVIDENCE_CORRUPT",`sealed evaluator copy is damaged: ${e.message}`);}
  return restoreEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);
}

/** Re-overlay every ACTIVE stack evaluator before a candidate identity is taken. */
function overlayStack(io,root) {
  const restored=[];
  for(const id of root.stack) {
    const state=loadNodeState(io,id);
    if(state?.status!==NodeState.ACTIVE)continue;
    const bundle=loadBundle(io,id),verified=verifyBundle(bundle,state);
    if(!verified.ok)throw operationError("EVIDENCE_CORRUPT",verified.reason);
    const overlay=overlayEvaluator(io,bundle);
    if(overlay)restored.push({nodeId:id,...overlay});
  }
  if(restored.length){root.acceptanceRestorations??=[];root.acceptanceRestorations.push({at:io.nowMs(),restored});saveRoot(io,root);}
  return restored;
}

/** Fresh-evaluate every ACTIVE stack node with a valid bundle; returns id -> result. */
async function refreshStack(io, root, candidateDigest) {
  const fresh = {};
  for (const id of root.stack) {
    const state = loadNodeState(io, id);
    const bundle = loadBundle(io, id);
    if (!state || state.status !== NodeState.ACTIVE)continue;
    const verified=verifyBundle(bundle,state);if(!verified.ok)throw operationError("EVIDENCE_CORRUPT",verified.reason);
    ensureBudget(io,root);
    const horizon = isOrdered(bundle.contract)&&!state.parentId ? horizonIds(bundle.contract, state.sequenceIndex ?? 0) : null;
    const result = await freshEvaluate(io, bundle, candidateDigest, root.deadlineAt-io.nowMs(), horizon);
    requireIdentity(io,root,result);
    state.lastResult = result;
    state.lastCandidateDigest = candidateDigest;
    state.lastEnvironmentIdentity=result.environmentIdentity;delete state.reservedCandidateDigest;
    saveNodeState(io, state);
    fresh[id] = result;
  }
  return fresh;
}

/**
 * Restore a checkpoint, re-evaluate the stack on the restored tree so no
 * vector stays stale, and snapshot the restored tree for future restores.
 */
async function restoreAndRefresh(io, root, restoreNodeId, predicate) {
  const restoreNode = loadNodeState(io, restoreNodeId);
  if (!restoreNode) return { ok: false, reason: `unknown node ${restoreNodeId}` };
  ensureBudget(io,root);
  const restored = restoreCheckpoint(io, restoreNode, predicate);
  if (!restored.ok) return restored;
  const digest = digestTree(io.cwd);
  const fresh = await refreshStack(io, root, digest);
  const reloaded = loadNodeState(io, restoreNodeId);
  const snap = takeCheckpoint(io, reloaded, "eval");
  ensureBudget(io,root);
  saveNodeState(io, reloaded);
  return { ok: true, checkpoint: restored.checkpoint, digest, fresh, warning: snap.ok ? null : snap.warning };
}

function mergePolicy(overrides, base = DEFAULT_POLICY) {
  if (overrides === undefined) return { ok: true, policy: { ...base } };
  if (!isRecord(overrides)) return { ok: false, error: "policy must be an object" };
  const policy = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_POLICY, key)) return { ok: false, error: `unknown policy key ${key}` };
    if (!Number.isFinite(value) || !(value > 0)) return { ok: false, error: `policy.${key} must be a positive finite number` };
    if(key==="evalTimeoutSeconds"&&!Number.isFinite(value*1000))return {ok:false,error:"policy.evalTimeoutSeconds exceeds supported timeout range"};
    if (["evaluatorAttempts", "maxTotalAttempts", "maxDepth", "localRepairs", "maxParallelWorkers"].includes(key) && !Number.isInteger(value)) return {ok:false,error:`policy.${key} must be an integer`};
    if (key === "maxParallelWorkers" && value > 12) return {ok:false,error:"policy.maxParallelWorkers must be at most 12"};
    policy[key] = value;
  }
  return { ok: true, policy };
}

/** New roots permit operational corrections before approval, not during execution. */
function policyEditable(root, node) {
  return root.policyLocked === false && root.status === NodeState.ACTIVE &&
    node?.status === NodeState.DRAFT && !node.parentId && !root.approval &&
    root.executionStartedAt == null && root.consumedAttempts === 0 && (node.attempts??0)===0 && node.sealAttempts === 0 &&
    !node.lastResult && !node.lastCandidateDigest && (node.children?.length??0)===0 && (node.checkpoints?.length??0)===0;
}

/** Approval binds duration, not an already-running countdown. */
export function rootReviewDigest(root, draft) {
  return sha256Hex(stableStringify({ draft, policy: root.policy, explicitLimits: root.explicitLimits ?? [], createdAt: root.createdAt,
    preSealDeadline: root.executionStartedAt == null ? root.deadlineAt : null, validatedBundleDigest: root.validatedBundleDigest }));
}

function policyStatus(root, node, nowMs) {
  return {
    policy: { ...root.policy },
    policyEditable: policyEditable(root, node),
    createdAt: root.createdAt,
    executionStartedAt: root.executionStartedAt ?? null,
    deadlineAt: Number.isFinite(root.deadlineAt) ? new Date(root.deadlineAt).toISOString() : null,
    remainingMs: Number.isFinite(root.deadlineAt) ? Math.max(0, root.deadlineAt - nowMs) : root.policy.deadlineMinutes * 60000,
    softRemainingMs: Number.isFinite(root.softDeadlineAt) ? Math.max(0, root.softDeadlineAt - nowMs) : null,
    clockStarted: Number.isFinite(root.deadlineAt),
    expired: isExpired(root, nowMs),
  };
}

function expiredDraftResult(root, node, draft, nowMs) {
  return { ok: false, errors: ["shared deadline exceeded during drafting; approval and E0 are unavailable"],
    ...policyStatus(root, node, nowMs), next: nextAction(root, node, draft, nowMs) };
}

function markTerminal(io, index, root, status, outcome) {
  root.status = status;
  root.outcome = outcome;
  root.stack = [];
  delete root.fault;
  saveRoot(io, root);
  index.activeRootId = null;
  saveIndex(io.cwd, index);
}

/** Pop a node from the active stack (it must be the leaf). */
function popStack(root, nodeId) {
  root.stack = root.stack.filter((id) => id !== nodeId);
}

// --- draft ---------------------------------------------------------------

/**
 * Create a root or child draft. Children: { parentId, target, reason,
 * prerequisite?, prerequisiteArtifact? }. Roots: { policy? }.
 */
export function draftNode(io, args) {
  return workspaceOperation(io,"draft",locked => onBaseline(locked,() => {
    const result=createDraft(locked,args);
    if(result?.paused){const root=loadRoot(locked,result.root);root.pause.args=args;root.pause.operation="draft";saveRoot(locked,root);}
    return result;
  }));
}

function createDraft(io, args) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const nowMs = io.nowMs();
  const { goal, originalRequest, criteria } = args;

  if (!nonEmptyString(goal)) return { ok: false, errors: ["goal must be a nonempty string"] };
  if (!Array.isArray(criteria) || criteria.length === 0) return { ok: false, errors: ["criteria must be a nonempty array"] };
  if (args.revise) return reviseDraft(io, index, args);
  const withIds = normalizeEvaluator({criteria:assignCriterionIds(criteria)}).draft.criteria;
  const withOutcomes = args.outcomes !== undefined ? assignOutcomeIds(args.outcomes) : undefined;

  if (args.parentId) {
    if (args.policy !== undefined) return { ok: false, errors: ["children inherit the root policy and cannot override it"] };
    const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
    if (!root || root.status !== NodeState.ACTIVE) return { ok: false, errors: ["no active root; start one with /exitcode <goal>"] };
    ensureBudget(io,root);
    if(leafOf(root)!==args.parentId)return {ok:false,errors:["only the active leaf may create a child"]};
    const parentState = loadNodeState(io, args.parentId);
    const parentBundle = loadBundle(io, args.parentId);
    if (!parentState || !parentBundle) return { ok: false, errors: [`parent ${args.parentId} is unknown`] };
    const verified = verifyBundle(parentBundle,parentState);
    if (!verified.ok) return { ok: false, errors: [verified.reason] };
    if(args.mutableDependencies!==undefined && args.mutableDependencies!==(parentBundle.contract.mutableDependencies===true))return {ok:false,errors:["children inherit the approved product dependency boundary"]};
    const parentResult = parentState.lastResult ?? resultFromBaseline(parentBundle);
    const siblings = (parentState.children ?? []).map((id) => {
      const s = loadNodeState(io, id);
      return s ? { id: s.id, status: s.status, target: s.target, goalDigest: s.goalDigest, candidateDigest: s.blockedCandidateDigest, environmentIdentity:s.blockedEnvironmentIdentity } : null;
    }).filter(Boolean);
    const gates = childGates({ root, parentState, parentResult, target: args.target, goal, siblings, nowMs, environmentIdentity:digest(evaluatorEnvironment(io.cwd)) });
    if (!gates.ok) return { ok: false, errors: gates.errors };
    if (!nonEmptyString(args.reason)) return { ok: false, errors: ["reason must explain how the child advances its parent"] };
    const repairs = root.policy.localRepairs ?? DEFAULT_POLICY.localRepairs;
    if ((parentState.attempts ?? 0) < repairs && !args.prerequisite) {
      return {
        ok: false,
        errors: [`parent has used ${parentState.attempts ?? 0}/${repairs} local repairs; repair locally first, or declare prerequisite:true with a prerequisiteArtifact for early decomposition`],
      };
    }
    if (args.prerequisite && !nonEmptyString(args.prerequisiteArtifact)) {
      return { ok: false, errors: ["prerequisite:true requires a prerequisiteArtifact describing the observable artifact it produces"] };
    }

    const id = `${args.parentId}.${(parentState.children ?? []).length + 1}`;
    const draft = {
      id,
      goal: goal.trim(),
      originalRequest: nonEmptyString(originalRequest) ? originalRequest.trim() : parentBundle.contract.originalRequest,
      parent: { id: args.parentId, targets: [args.target] },
      ...(withOutcomes !== undefined ? { outcomes: withOutcomes } : {}),
      criteria: withIds,
      ...(args.assets !== undefined ? {assets:args.assets} : {}),
      ...(args.sequence !== undefined ? { sequence: args.sequence } : {}),
      ...(args.execution !== undefined ? { execution: args.execution } : {}),
      ...(args.specificationPaths !== undefined ? {specificationPaths:args.specificationPaths} : {}),
      mutableDependencies:parentBundle.contract.mutableDependencies===true,
    };
    const validation = validateStructure(draft, {
      parent: parentBundle,
      parentDepth: depthOf(args.parentId),
      parentLastResult: parentResult,
      policy: root.policy,
    });
    if (!validation.ok) return validation;

    const node = {
      id,
      rootId: root.id,
      parentId: args.parentId,
      target: args.target,
      goalDigest: fingerprintGoal(goal),
      reason: args.reason.trim(),
      prerequisite: Boolean(args.prerequisite),
      prerequisiteArtifact: args.prerequisiteArtifact?.trim(),
      depth: depthOf(id),
      status: NodeState.DRAFT,
      phase: "EVALUATOR_PREPARATION",
      evaluatorMetrics: {...emptyMetrics(), evaluatorProposals:1},
      attempts: 0,
      sealAttempts: 0,
      lastResult: null,
      lastCandidateDigest: null,
      checkpoints: [],
      children: [],
    };
    // Checkpoint the parent candidate before child work begins.
    const snap = takeCheckpoint(io, parentState, `pre-child:${id}`);
    if(!snap.ok)return failRoot(io,root,{code:"CHECKPOINT_UNAVAILABLE",reason:snap.warning,nodeId:parentState.id,operation:"draft"});
    writeJsonAtomic(draftFile(io.cwd,id),{draft});
    const warnings = [];
    node.preChildCheckpointId = snap.ok ? snap.checkpoint.id : null;
    parentState.children.push(id);
    saveNodeState(io, parentState);
    saveNodeState(io, node);
    root.stack.push(id);
    saveRoot(io, root);
    // The parent's work so far is the child's immutable pre-seal candidate.
    ensureBaseline(io);
    return { ok: true, id, rootId: root.id, draft, warnings, next: `seal ${id} with exitcode_seal` };
  }

  if (index.activeRootId) {
    const active = loadRoot(io, index.activeRootId);
    if (active && [NodeState.ACTIVE,NodeState.PAUSED].includes(active.status)) {
      const activeNode = loadNodeState(io, active.id);
      if (activeNode && activeNode.status === NodeState.DRAFT) {
        return { ok: false, errors: [`root ${active.id} already has a draft; pass revise:"${active.id}" to revise it`] };
      }
      return { ok: false, errors: [`root ${active.id} is still ${active.status}; resume it or the user must cancel before starting another goal`] };
    }
  }
  const merged = mergePolicy(args.policy);
  if (!merged.ok) return { ok: false, errors: [merged.error] };
  if (!Number.isFinite(new Date(deadlineAtMs(nowMs, { policy: merged.policy, explicitLimits: explicitLimitsOf(args.policy) })).getTime())) {
    return { ok: false, errors: ["policy.deadlineMinutes exceeds the supported deadline range"] };
  }
  const id = `G${index.rootCounter + 1}`;
  const draft = {
    id,
    goal: goal.trim(),
    originalRequest: nonEmptyString(originalRequest) ? originalRequest.trim() : goal.trim(),
    parent: null,
    ...(withOutcomes !== undefined ? { outcomes: withOutcomes } : {}),
    criteria: withIds,
    ...(args.assets !== undefined ? {assets:args.assets} : {}),
    ...(args.sequence !== undefined ? { sequence: args.sequence } : {}),
    ...(args.execution !== undefined ? { execution: args.execution } : {}),
    ...(args.specificationPaths !== undefined ? {specificationPaths:args.specificationPaths} : {}),
    ...(args.mutableDependencies !== undefined ? {mutableDependencies:args.mutableDependencies} : {}),
    ...(args.assumptions !== undefined ? { assumptions: args.assumptions } : {}),
    ...(args.exclusions !== undefined ? { exclusions: args.exclusions } : {}),
  };
  const validation = validateStructure(draft, { policy: merged.policy });
  if (!validation.ok) return validation;

  index.rootCounter += 1;
  index.activeRootId = id;
  index.roots.push(id);
  saveIndex(io.cwd, index);
  const createdAt = nowMs;
  const root = {
    id,
    policy: merged.policy,
    explicitLimits: explicitLimitsOf(args.policy),
    policyLocked: false,
    createdAt,
    executionStartedAt: null,
    deadlineAt: null,
    consumedAttempts: 0,
    stack: [id],
    status: NodeState.ACTIVE,
  };
  root.reviewDigest = rootReviewDigest(root, draft);
  saveRoot(io, root);
  writeJsonAtomic(draftFile(io.cwd, id), { draft });
  saveNodeState(io, {
    id,
    rootId: id,
    parentId: null,
    target: null,
    goalDigest: fingerprintGoal(goal),
    depth: 0,
    status: NodeState.DRAFT,
      phase: "EVALUATOR_PREPARATION",
      evaluatorMetrics: {...emptyMetrics(), evaluatorProposals:1},
    attempts: 0,
    sealAttempts: 0,
    lastResult: null,
    lastCandidateDigest: null,
    checkpoints: [],
    children: [],
  });
  // Normally captured when discovery began; the root draft continues that phase.
  ensureBaseline(io);
  const node = loadNodeState(io, id);
  return { ok: true, id, rootId: id, draft, warnings: [], ...policyStatus(root, node, nowMs),
    next: nextAction(root, node, draft, nowMs) };
}

/** Overwrite an existing DRAFT (revision does not consume a seal proposal). */
function reviseDraft(io, index, args) {
  const node = loadNodeState(io, args.revise);
  if (!node) return { ok: false, errors: [`unknown node ${args.revise}`] };
  if (node.status !== NodeState.DRAFT) return { ok: false, errors: [`${node.id} is ${node.status}; only DRAFT nodes can be revised`] };
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  recoverEditableDraft(io,root,node);
  if (!root || node.rootId !== root.id || root.status !== NodeState.ACTIVE) {
    return { ok: false, errors: [`${node.id} does not belong to the active root`] };
  }
  const previous = readJson(draftFile(io.cwd, node.id))?.draft;
  const withIds = normalizeEvaluator({criteria:assignCriterionIds(args.criteria)}).draft.criteria;
  const resolvedOutcomes = args.outcomes !== undefined ? assignOutcomeIds(args.outcomes) : previous?.outcomes;
  const warnings = [];
  const nowMs = io.nowMs();
  const editable = policyEditable(root, node);
  let effectivePolicy = root.policy, explicitLimits = root.explicitLimits ?? [];
  if (args.policy !== undefined) {
    if (node.parentId) return { ok: false, errors: ["children inherit the root policy and cannot override it"] };
    const merged = mergePolicy(args.policy, root.policy);
    if (!merged.ok) return { ok: false, errors: [merged.error] };
    if (editable) explicitLimits = explicitLimitsOf(args.policy, explicitLimits);
    if (stableStringify(merged.policy) !== stableStringify(root.policy)) {
      if (!editable) {
        return { ok: false, errors: ["root policy is locked after approval; sealed roots keep their fixed policies"],
          ...policyStatus(root, node, nowMs),
          next: "keep the effective policy, or the user must cancel with /exitcode exit and start a fresh root with fresh review" };
      }
      effectivePolicy = merged.policy;
      if (!Number.isFinite(new Date(deadlineAtMs(nowMs,{policy:effectivePolicy,explicitLimits})).getTime())) {
        return { ok: false, errors: ["policy.deadlineMinutes exceeds the supported deadline range"] };
      }
    }
  }
  // Only sealed execution has a running clock; an editable root policy has none.
  if (isExpired(root, nowMs)) return expiredDraftResult(root, node, previous, nowMs);
  let draft;
  let validation;
  if (node.parentId) {
    if (args.parentId && args.parentId !== node.parentId) {
      return { ok: false, errors: [`${node.id} belongs to parent ${node.parentId}`] };
    }
    const parentBundle = loadBundle(io, node.parentId);
    const parentState = loadNodeState(io, node.parentId);
    if(args.mutableDependencies!==undefined && args.mutableDependencies!==(parentBundle?.contract.mutableDependencies===true))return {ok:false,errors:["children inherit the approved product dependency boundary"]};
    const parentResult = parentState?.lastResult ?? (parentBundle ? resultFromBaseline(parentBundle) : null);
    draft = {
      id: node.id,
      goal: args.goal.trim(),
      originalRequest: nonEmptyString(args.originalRequest)
        ? args.originalRequest.trim()
        : (previous?.originalRequest ?? parentBundle?.contract.originalRequest ?? args.goal.trim()),
      parent: { id: node.parentId, targets: [node.target] },
      ...(resolvedOutcomes !== undefined ? { outcomes: resolvedOutcomes } : {}),
      criteria: withIds,
      ...((args.assets !== undefined ? args.assets : previous?.assets) !== undefined ? {assets:args.assets !== undefined ? args.assets : previous.assets} : {}),
      ...(args.sequence !== undefined ? { sequence: args.sequence } : {}),
      ...(args.execution !== undefined ? { execution: args.execution } : {}),
      ...(args.specificationPaths !== undefined ? {specificationPaths:args.specificationPaths} : {}),
      mutableDependencies:parentBundle?.contract.mutableDependencies===true,
    };
    validation = validateStructure(draft, {
      parent: parentBundle,
      parentDepth: depthOf(node.parentId),
      parentLastResult: parentResult,
      policy: root.policy,
    });
    if(validation.ok){if(nonEmptyString(args.reason))node.reason=args.reason.trim();node.goalDigest=fingerprintGoal(args.goal);}
  } else {
    draft = {
      id: node.id,
      goal: args.goal.trim(),
      originalRequest: previous?.originalRequest ?? (nonEmptyString(args.originalRequest) ? args.originalRequest.trim() : args.goal.trim()),
      parent: null,
      ...(resolvedOutcomes !== undefined ? { outcomes: resolvedOutcomes } : {}),
      criteria: withIds,
    ...((args.assets !== undefined ? args.assets : previous?.assets) !== undefined ? {assets:args.assets !== undefined ? args.assets : previous.assets} : {}),
    };
    for (const key of ["assumptions", "exclusions", "specificationPaths", "mutableDependencies", "sequence", "execution"]) {
      const value = args[key] !== undefined ? args[key] : previous?.[key];
      if (value !== undefined) draft[key] = value;
    }
    validation = validateStructure(draft, { policy: effectivePolicy });
  }
  if (!validation.ok) return validation;
  node.phase = "EVALUATOR_PREPARATION";
  delete node.prepared;
  node.evaluatorMetrics ??= emptyMetrics();
  node.evaluatorMetrics.evaluatorProposals++;
  saveNodeState(io,node);
  writeJsonAtomic(draftFile(io.cwd, node.id), { draft });
  if (!node.parentId) {
    root.policy = effectivePolicy;
    root.explicitLimits = explicitLimits;
    root.policyLocked = !editable;
    delete root.approval;
    delete root.validatedBundleDigest;
    root.reviewDigest = rootReviewDigest(root, draft);
    saveRoot(io, root);
  }
  return { ok: true, id: node.id, rootId: root.id, revised: true, draft, warnings,
    ...policyStatus(root, node, nowMs),
    next: nextAction(root, node, draft, nowMs) };
}

function resultFromBaseline(bundle) {
  return {
    runId: "baseline",
    bundleDigest: bundle.digest,
    candidateDigest: bundle.baseline.candidateDigest,
    outcomes: bundle.baseline.outcomes,
    allPass: bundle.baseline.allPass,
    at: bundle.baseline.at,
  };
}

// --- root user approval --------------------------------------------------

function approvalMatches(root, draft) {
  return Boolean(draft && root?.policyLocked === true && root.approval?.approvedBy === "user" &&
    root.reviewDigest === rootReviewDigest(root, draft) && root.approval.digest === root.reviewDigest);
}

/** Record user approval, directly or from a reply interpreted by the agent. */
export function approveRoot(io, options = {}) {
  return workspaceOperation(io,"approve",locked => onBaseline(locked, () => approveDraft(locked, options)));
}

function approveDraft(io, { userReply } = {}) {
  if (userReply !== undefined && !nonEmptyString(userReply)) {
    return { ok: false, errors: ["user approval reply must be a nonempty string"] };
  }
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  const node = root ? loadNodeState(io, root.id) : null;
  if (!root || root.status !== NodeState.ACTIVE || node?.status !== NodeState.DRAFT) {
    return { ok: false, errors: ["no DRAFT root to approve"] };
  }
  if (isExpired(root,io.nowMs())) return expiredDraftResult(root,node,readJson(draftFile(io.cwd,root.id))?.draft,io.nowMs());
  if (node.phase !== "READY_FOR_APPROVAL" || !preparationMatches(io, node)) return {ok:false, errors:["root evaluator must be prepared and validated before approval; candidate or environment may have changed"]};
  const draft = readJson(draftFile(io.cwd, root.id))?.draft;
  if (!draft) return { ok: false, errors: [`draft for ${root.id} is missing`] };
  if (root.reviewDigest !== rootReviewDigest(root, draft)) {
    return { ok: false, errors: ["root draft or effective policy changed since review; revise with exitcode_draft and present the entire contract again"] };
  }
  const validation = validateStructure(draft, { policy: root.policy });
  if (!validation.ok) return validation;
  const nowMs = io.nowMs();
  if (isExpired(root, nowMs)) return expiredDraftResult(root, node, draft, nowMs);
  root.policyLocked = true;
  root.approval = { digest: root.reviewDigest, at: new Date(nowMs).toISOString(), approvedBy: "user",
    ...(userReply !== undefined ? { userReply: userReply.trim() } : {}) };
  saveRoot(io, root);
  return { ok: true, id: root.id, approval: root.approval };
}

const RECIPE_EVIDENCE = { test_suite: "the project test suite", build_succeeds: "the project build", typecheck_succeeds: "the project typecheck" };

/** Generated from validated evidence, never authored by the drafting agent. */
function verificationSummary(draft, prepared) {
  const probesOf = (stages, id) => (prepared?.stages ?? []).filter(s => stages.includes(s.stage))
    .flatMap(s => s.probes ?? []).filter(p => p.criterionId === id);
  return draft.criteria.map(c => {
    const r = c.check.recipe;
    const how = r?.kind === "test_asset" ? `acceptance asset ${r.asset} via ${r.command}` : r?.kind === "existing_test" ? `existing test "${r.selector}" in ${r.path}` : RECIPE_EVIDENCE[r?.kind] ??
      (r?.path ? `${r.kind.replace(/_/g, " ")} ${r.path}` : r?.kind === "command_exit" ? `isolated command ${r.command}` : "an isolated custom command");
    const evidence = [];
    const baseline = probesOf(["baseline"], c.id).find(p => p.label === "candidate");
    if (baseline?.outcome) evidence.push(`baseline ${baseline.outcome.status}`);
    const accept = probesOf(["discrimination"], c.id).find(p => p.label === "accept");
    if (accept?.outcome?.status === "PASS") evidence.push("witness PASS");
    else if ((c.type ?? "behavior") === "behavior" && baseline?.outcome?.status === "FAIL" && !accept)
      evidence.push("implementation will establish success post-seal");
    const negatives = probesOf(["discrimination", "adversarial"], c.id).filter(p => p.expected === "FAIL" && p.outcome?.status === "FAIL").length;
    if (negatives) evidence.push(`rejected ${negatives} negative${negatives === 1 ? "" : "s"}`);
    return `- ${c.id}: ${how}${evidence.length ? `; ${evidence.join(", ")}` : ""}.`;
  });
}

/** Human acceptance layer; executable checks stay in the same draft. */
export function rootReviewText(draft, root, nowMs = Date.now(), prepared = null) {
  if (isExpired(root, nowMs)) return "Validated plan unavailable: shared deadline expired.";
  const lines = ["Validated plan", "", "Goal", draft.goal];
  if (draft.outcomes?.length) {
    lines.push("", "Outcomes");
    for (const o of draft.outcomes) lines.push(`${o.id}: ${o.requirement}`);
  }
  lines.push("", "Success means");
  for (const criterion of draft.criteria) lines.push(`${criterion.id}: ${criterionRequirement(draft,criterion)}`);
  if (draft.sequence?.length) {
    lines.push("", "Implementation order");
    draft.sequence.forEach((slice, i) => {
      lines.push(`${i + 1}. ${slice.objective}`);
      lines.push(`   Proves: ${slice.verify.join(", ")}`);
    });
  }
  if (draft.execution?.length) {
    lines.push("", `Execution graph (up to ${root.policy.maxParallelWorkers ?? DEFAULT_POLICY.maxParallelWorkers} workers)`);
    for (const slice of draft.execution) lines.push(`${slice.id}: ${slice.objective}; proves ${slice.verify.join(", ")}; after ${(slice.after ?? []).join(", ") || "none"}`);
  }
  for (const key of ["assumptions", "exclusions"]) {
    lines.push("", key === "assumptions" ? "Assumptions" : "Exclusions");
    lines.push(...(draft[key]?.length ? draft[key].map(x=>`- ${x}`) : ["- None stated."]));
  }
  if (root.explicitLimits?.length) {
    lines.push("", "Hard limits (work pauses for your grant when reached)");
    for (const key of root.explicitLimits) lines.push(`- ${key}: ${root.policy[key]}`);
  }
  const critic = (prepared?.stages ?? []).find(s => s.stage === "critic");
  if (prepared?.warnings?.length) lines.push("", "Warnings",...prepared.warnings.map(w=>`- ${w}`));
  lines.push("", "Verification", ...verificationSummary(draft, prepared),
    `Semantic critic: ${critic ? critic.status : "unavailable"}`,
    "Mechanical evaluator validation: PASS",
    "Every check ran isolated, rejected an empty project, and was recorded against the current candidate. Finite challenges do not prove semantic equivalence.",
    "", "Approve this plan, or tell me what to change. /exitcode status shows policy and evaluator evidence. /exitcode exit cancels.");
  return lines.join("\n");
}

export function intentDigestOf(draft) {
  return sha256Hex(stableStringify({goal:draft.goal,originalRequest:draft.originalRequest,
    outcomes:(draft.outcomes ?? []).map(o=>({id:o.id,requirement:o.requirement})),
    criteria:draft.criteria.map(c=>({id:c.id,outcome:c.outcome,...(c.type==='regression'?{requirement:c.requirement}:{}),type:c.type??'behavior'})),
    sequence:draft.sequence,execution:draft.execution,assumptions:draft.assumptions,exclusions:draft.exclusions}));
}
export function evaluatorDigestOf(draft) { return sha256Hex(stableStringify({criteria:draft.criteria.map(c=>({id:c.id,check:c.check,controls:c.controls})),assets:draft.assets ?? {}})); }
function preparationMatches(io,node) {
  try {
    const draft=readJson(draftFile(io.cwd,node.id))?.draft,p=node.prepared,root=loadRoot(io,node.rootId);
    if(!p || !draft || (node.parentId?node.preparedDigest:root.validatedBundleDigest)!==sha256Hex(stableStringify(p)) ||
      p.draftDigest!==sha256Hex(stableStringify(draft)) || p.candidateDigest!==digestTree(io.cwd) || stableStringify(p.environment)!==stableStringify(evaluatorEnvironment(io.cwd)))return false;
    verifyEvaluatorAssets(io.cwd,p.assetsDirectory,p.assets);return true;
  } catch{return false;}
}

/** Safe evaluator preparation is separate from human approval and execution. */
export async function prepareNode(io, nodeId = null) {
  return workspaceOperation(io,"prepare",locked => onBaseline(locked, () => prepareDraft(locked, nodeId)));
}

async function prepareDraft(io, nodeId) {
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  const node=root?loadNodeState(io,nodeId??leafOf(root)):null;
  recoverEditableDraft(io,root,node);
  if(node && leafOf(root)!==node.id)return {ok:false,errors:["prepare the active leaf before its ancestors"]};
  if(!root||root.status!==NodeState.ACTIVE||!node||node.rootId!==root.id||node.status!==NodeState.DRAFT)return {ok:false,errors:["no editable DRAFT evaluator; resume any infrastructure pause first"]};
  const stored=readJson(draftFile(io.cwd,node.id));if(!stored?.draft)return {ok:false,errors:["missing draft"]};
  if(isExpired(root,io.nowMs()))return pauseRoot(io,root,{code:"BUDGET_EXHAUSTED",reason:"shared execution deadline exceeded",operation:"prepare",nodeId:node.id});
  if(node.preparing)return {ok:false,errors:["evaluator preparation already in progress; resume interrupted work first"]};
  node.evaluatorMetrics??=emptyMetrics();
  if(node.evaluatorMetrics.e0Attempts >= evaluatorLimitOf(root,node))return pauseRoot(io,root,{reason:"evaluator preparation budget exhausted; diagnose or revise the proposal before retrying",code:"EVALUATOR_UNBUILDABLE",nodeId:node.id,operation:"prepare"});
  const {draft,repairs}=normalizeEvaluator(stored.draft);
  writeJsonAtomic(draftFile(io.cwd,node.id),{draft});
  if(!node.parentId){delete root.approval;delete root.validatedBundleDigest;root.reviewDigest=rootReviewDigest(root,draft);}saveRoot(io,root);
  const draftDigest=sha256Hex(stableStringify(draft)),reviewDigest=root.reviewDigest;
  node.phase="EVALUATOR_PREPARATION";node.preparing=true;node.evaluatorMetrics.e0Attempts++;node.preparationReservation={at:io.nowMs(),attempt:node.evaluatorMetrics.e0Attempts,operationToken:io.operationToken};delete node.prepared;saveNodeState(io,node);
  const owned=operationIo(io,root),operation=owned.io;
  let environment,candidateDigest,assets,result;
  const directory=path.join(storePaths(io.cwd).assetsDir,`${node.id}.prepared`);
  try {
    ensureBudget(operation,root);
    environment=evaluatorEnvironment(io.cwd);candidateDigest=digestTree(io.cwd);
    const parentBundle=node.parentId?loadBundle(io,node.parentId):null;
    const validation=validateStructure(draft,{policy:root.policy,parent:parentBundle,parentDepth:node.parentId?depthOf(node.parentId):-1,parentLastResult:node.parentId?loadNodeState(io,node.parentId)?.lastResult:null});
    if(!validation.ok)result={ok:false,errors:validation.errors,diagnostics:validation.errors.map(e=>diagnostic("INVALID_STRUCTURE","lint",null,e,"Correct evaluator structure")),stages:[],metrics:emptyMetrics()};
    else {
      fs.rmSync(directory,{recursive:true,force:true});
      assets=captureEvaluatorAssets(io.cwd,draft,directory);
      result=await prepareGate({...draft,...(parentBundle?{parentRequirement:criterionRequirement(parentBundle.contract,parentBundle.contract.criteria.find(c=>c.id===node.target))}:{})},
        {cwd:io.cwd,exec:io.exec,runCheck:(c,exec,cwd,timeout,opts)=>runCheck(c,exec,cwd,timeout,{...opts,deadlineAt:root.deadlineAt,nowMs:io.nowMs}),
          defaultTimeoutMs:defaultTimeoutMs(root),environment,maxBytes:SNAPSHOT_MAX_BYTES,candidateDigest,review:io.review,signal:operation.signal,
          reviewTimeoutMs:io.reviewTimeoutMs,executionPreflight:io.executionPreflight ?? (()=>preflightExecution(operation)),assets,assetsDirectory:directory,onProgress:io.onProgress,deadlineAt:root.deadlineAt,nowMs:io.nowMs});
      ensureBudget(operation,root);
      if(stableStringify(environment)!==stableStringify(evaluatorEnvironment(io.cwd)))throw operationError("ENVIRONMENT_CHANGED","Environment changed during preparation");
      verifyEvaluatorAssets(io.cwd,directory,assets);
      if(digestTree(io.cwd)!==candidateDigest)throw operationError("CANDIDATE_MUTATED","Candidate changed during preparation");
    }
  } catch(e) {
    result??={ok:false,errors:[],diagnostics:[],stages:[],metrics:emptyMetrics()};result.ok=false;
    result.errors.push(e.message);result.diagnostics.push(diagnostic(e.code??"PREPARATION_FAILED","preparation",null,e.message,"Repair the draft or authorized environment and retry preparation","supervisor"));
  } finally {
    owned.dispose();
    const current=loadNodeState(io,node.id);if(current){delete current.preparing;saveNodeState(io,current);}
  }
  const after=enforceBaseline(io);
  if(!after.ok) {
    result.ok=false;
    if(after.code) {
      const reason=(after.errors??[]).join("; ") || "Baseline verification failed";
      result.diagnostics.push(diagnostic(after.code,"baseline",node.id,reason,"Restore supervisor storage and retry preparation","supervisor"));
      result.errors.push(reason);
    } else {
      result.warnings=[after.message,...(result.warnings??[])];
      if(!result.diagnostics.some(d=>d.code==="CANDIDATE_MUTATED")) {
        result.diagnostics.push(diagnostic("CANDIDATE_MUTATED","baseline",null,"Candidate changed during preparation","Reprepare stable candidate"));
        result.errors.push("Candidate changed during preparation");
      }
    }
  }
  const current=loadNodeState(io,node.id),currentRoot=loadRoot(io,root.id),currentDraft=readJson(draftFile(io.cwd,node.id))?.draft;
  if(currentRoot.status!==NodeState.ACTIVE||currentRoot.reviewDigest!==reviewDigest||(!node.parentId && rootReviewDigest(currentRoot,currentDraft)!==reviewDigest)||current.status!==NodeState.DRAFT||sha256Hex(stableStringify(currentDraft))!==draftDigest) {
    fs.rmSync(directory,{recursive:true,force:true});
    return {ok:false,errors:["contract changed during preparation"],diagnostics:[diagnostic("CONTRACT_CHANGED","baseline",node.id,"Concurrent revision","Reprepare current draft")]};
  }
  try{ensureBudget(io,currentRoot);}catch(e){result.ok=false;result.errors.push(e.message);result.diagnostics.push(diagnostic(e.code,"preparation",node.id,e.message,"Resume with remaining authorized budget","supervisor"));}
  // Transport, storage, cancellation, or runner faults do not spend quality proposals.
  const infrastructure=result.diagnostics.some(d=>d.repairability==="supervisor" || ["CANDIDATE_MUTATED","ENVIRONMENT_CHANGED"].includes(d.code));
  result.metrics.e0Attempts=infrastructure?0:1;
  if(infrastructure && current.preparationReservation)current.evaluatorMetrics.e0Attempts--;
  delete current.preparationReservation;
  addMetrics(current.evaluatorMetrics,{...result.metrics,e0Attempts:0,...(io.reviewUsage?.available?{tokenUsage:io.reviewUsage}:{})});
  current.diagnostics=result.diagnostics;current.repairs=repairs;
  if(result.ok) {
    current.phase="READY_FOR_APPROVAL";
    current.prepared={draftDigest,candidateDigest,environment,assets,assetsDirectory:directory,intentDigest:intentDigestOf(draft),evaluatorDigest:evaluatorDigestOf(draft),stages:result.stages,warnings:result.warnings??[],baseline:result.baseline,capabilities:result.capabilities};
    current.preparedDigest=sha256Hex(stableStringify(current.prepared));
    if(!node.parentId){currentRoot.validatedBundleDigest=current.preparedDigest;currentRoot.reviewDigest=rootReviewDigest(currentRoot,draft);saveRoot(io,currentRoot);current.evaluatorMetrics.reviewTurns++;result.review=rootReviewText(draft,currentRoot,io.nowMs(),current.prepared);}
  } else {current.phase="EVALUATOR_PREPARATION";fs.rmSync(directory,{recursive:true,force:true});}
  saveNodeState(io,current);
  if(infrastructure && !isUnsealedRootDraft(io,currentRoot,current)) {
    const d=result.diagnostics.find(d=>d.repairability==="supervisor")??result.diagnostics[0];
    return {...result,...failRoot(io,currentRoot,{code:d.code,reason:result.errors.join("; "),nodeId:node.id,operation:"prepare"}),diagnostics:result.diagnostics,metrics:result.metrics};
  }
  return {...result,id:node.id,status:currentRoot.status,phase:current.phase,repairs,next:nextAction(currentRoot,current,draft,io.nowMs())};
}

// --- seal ----------------------------------------------------------------

export async function sealNode(io, nodeId, options = {}) {
  return workspaceOperation(io,"seal",locked => onBaseline(locked, () => sealDraft(locked, nodeId, options)));
}

async function sealDraft(io,nodeId,options) {
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  if(!root)return {ok:false,errors:["no active root"]};
  const owned=operationIo(io,root);
  try {return await sealPrepared(owned.io,nodeId,options);}
  finally {owned.dispose();}
}

async function sealPrepared(io, nodeId, { userApproval } = {}) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  const node = loadNodeState(io, nodeId);
  ensureBudget(io,root);
  if (!root || !node || node.rootId !== root.id) return { ok: false, errors: [`unknown node ${nodeId}`] };
  if(leafOf(root)!==nodeId)return {ok:false,errors:["only the active leaf may be sealed"]};
  if(root.status!==NodeState.ACTIVE)return {ok:false,errors:[`root ${root.id} is ${root.status}; resume its pause first`]};
  if(node.status===NodeState.ACTIVE && verifyBundle(loadBundle(io,nodeId),node).ok){releasePreparation(io.cwd);releaseBaseline(io.cwd);return {ok:true,sealed:nodeId,alreadySealed:true,baseline:formatVector(node.lastResult?.outcomes??[]),next:nextAction(root,node,null,io.nowMs())};}
  if (node.status !== NodeState.DRAFT) return { ok: false, errors: [`${nodeId} is ${node.status}; only DRAFT nodes can be sealed`] };
  if (root.status !== NodeState.ACTIVE) return { ok: false, errors: [`root ${root.id} is ${root.status}`] };

  const stored = readJson(draftFile(io.cwd, nodeId));
  if (!stored?.draft) return { ok: false, errors: [`draft for ${nodeId} is missing`] };
  const draft = JSON.parse(stableStringify(stored.draft)); // immutable gate copy
  if (userApproval !== undefined) {
    if (node.parentId) return { ok: false, errors: ["children do not require user approval"] };
    const approval = approveDraft(io, { userReply: userApproval });
    if (!approval.ok) return approval;
    root.approval = approval.approval;
    root.policyLocked = true;
  }
  if (!node.parentId && !approvalMatches(root, draft)) {
    if (isExpired(root, io.nowMs())) return expiredDraftResult(root, node, draft, io.nowMs());
    return {
      ok: false,
      errors: [root.approval ? "root contract changed since user approval" : "root contract requires explicit user approval"],
      next: "present the root contract and wait for the user to accept or request revisions",
    };
  }

  if(isExpired(root,io.nowMs()))return pauseRoot(io,root,{code:"BUDGET_EXHAUSTED",reason:"shared execution deadline exceeded",nodeId,operation:"seal"});
  if(node.parentId && !preparationMatches(io,node)) {
    const prepared=await prepareDraft(io,nodeId);if(!prepared.ok)return prepared;
    Object.assign(node,loadNodeState(io,nodeId));
  }
  if(!preparationMatches(io,node))return {ok:false,errors:["validated bundle is stale; prepare again before approval"]};
  const prepared=node.prepared,validatedDraft=readJson(draftFile(io.cwd,nodeId)).draft;
  ensureBudget(io,root);
  const directory=path.join(storePaths(io.cwd).assetsDir,`${nodeId}.sealed`);
  verifyEvaluatorAssets(io.cwd,prepared.assetsDirectory,prepared.assets);
  // Do not unlock implementation without a verified restoration point.
  const snap=takeCheckpoint(io,node,"seal");
  if(!snap.ok)return failRoot(io,root,{code:"CHECKPOINT_UNAVAILABLE",reason:snap.warning,nodeId,operation:"seal"});
  fs.rmSync(directory,{recursive:true,force:true});
  fs.cpSync(prepared.assetsDirectory,directory,{recursive:true,verbatimSymlinks:true});
  verifyEvaluatorAssets(io.cwd,directory,prepared.assets);
  ensureBudget(io,root);
  const bundle={contract:validatedDraft,digest:sha256Hex(stableStringify(validatedDraft)),env:prepared.environment,candidateDigest:prepared.candidateDigest,
    sealedAt:new Date(io.nowMs()).toISOString(),baseline:prepared.baseline,intentDigest:prepared.intentDigest,evaluatorDigest:prepared.evaluatorDigest,
    validation:prepared.stages,warnings:prepared.warnings??[],assets:prepared.assets,assetsDirectory:directory};
  bundle.integrityDigest=sha256Hex(stableStringify({contractDigest:bundle.digest,assets:bundle.assets,env:bundle.env,candidateDigest:bundle.candidateDigest}));
  if (bundle.contract.execution && !node.parentId) root.execution = await createExecution(io, root, bundle);
  ensureBudget(io,root);
  root.policyLocked=true;
  writeJsonAtomic(sealedFile(io.cwd,nodeId),bundle);
  node.sealedBundleDigest=sha256Hex(stableStringify(bundle));
  node.status=NodeState.ACTIVE;node.phase="EXECUTION";node.sealAttempts++;
  node.lastResult=resultFromBaseline(bundle);node.lastCandidateDigest=bundle.candidateDigest;
  if(isOrdered(bundle.contract)&&!node.parentId){
    node.sequenceIndex=0;
    node.sequence=structuredClone(bundle.contract.sequence);
    const ids=new Set(horizonIds(bundle.contract,0));
    const outcomes=node.lastResult.outcomes.filter(o=>ids.has(o.criterionId));
    node.lastResult={...node.lastResult,outcomes,allPass:allPass(outcomes)};
  }
  node.lastEnvironmentIdentity=digest(bundle.env);
  if(digestTree(io.cwd)!==bundle.candidateDigest || stableStringify(evaluatorEnvironment(io.cwd))!==stableStringify(bundle.env))throw operationError("CANDIDATE_MUTATED","candidate or environment changed while sealing");
  ensureBudget(io,root);
  if(!node.parentId && root.executionStartedAt===null) {
    root.executionStartedAt=io.nowMs();root.deadlineAt=deadlineAtMs(root.executionStartedAt,root);
    if(!isHardLimit(root,"deadlineMinutes"))root.softDeadlineAt=root.executionStartedAt+root.policy.deadlineMinutes*60000;
    root.attemptLimit??=attemptLimitOf(root);
  }
  // Commit the clock before unlocking the leaf. An interrupted seal cannot gain time on retry.
  saveRoot(io,root);saveNodeState(io,node);ensureBudget(io,root);releasePreparation(io.cwd);releaseBaseline(io.cwd);
  return {ok:true,sealed:nodeId,baseline:formatVector(bundle.baseline.outcomes),warnings:[],next:nextAction(root,node,null,io.nowMs())};
}

// --- evaluate ------------------------------------------------------------

async function freshEvaluate(io, bundle, candidateDigest, timeoutMs, criterionIds = null) {
  const outcomes=[],metrics=emptyMetrics();
  let base;
  ensureRunning(io.signal,io.deadlineAt,io.nowMs);
  const environment=evaluatorEnvironment(io.cwd,io);
  if(!compatibleEnvironment(bundle.env,environment,bundle.contract.mutableDependencies===true,bundle.assets))
    throw operationError("ENVIRONMENT_CHANGED","sealed evaluator environment changed; restore its trusted runtime or frozen dependencies");
  verifyEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);
  const wanted = criterionIds ? new Set(criterionIds) : null;
  try {
    base=fixtureDirectory(io.cwd,"exitcode-fresh-base-");
    metrics.fixtureBytes+=copyCandidate(io.cwd,base,SNAPSHOT_MAX_BYTES,io.signal,io);metrics.fixtureCopies++;
    if(digestTree(base,io)!==candidateDigest || digestTree(io.cwd,io)!==candidateDigest)throw operationError("CANDIDATE_MUTATED","candidate changed while taking evaluation snapshot");
    for(const criterion of bundle.contract.criteria.filter(c=>!wanted||wanted.has(c.id))) {
      ensureRunning(io.signal,io.deadlineAt,io.nowMs);
      const fixture=fixtureDirectory(io.cwd,"exitcode-fresh-");
      try {
        metrics.fixtureBytes+=copyCandidate(base,fixture,SNAPSHOT_MAX_BYTES,io.signal,io);metrics.fixtureCopies++;
        installEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets);
        metrics.probeExecutions++;
        outcomes.push(await runCheck(criterion,io.exec,fixture,timeoutMs,
          {signal:io.signal,deadlineAt:io.deadlineAt,nowMs:io.nowMs,readOnlyPaths:bundle.assets.readOnlyPaths,onExecution:()=>metrics.shellExecutions++}));
        ensureRunning(io.signal,io.deadlineAt,io.nowMs);
        verifyEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets,{installed:true});
      } finally {fs.rmSync(fixture,{recursive:true,force:true});}
    }
    if(digestTree(io.cwd,io)!==candidateDigest)throw operationError("CANDIDATE_MUTATED","candidate changed during evaluation; checked evidence is stale");
    if(stableStringify(evaluatorEnvironment(io.cwd,io))!==stableStringify(environment))throw operationError("ENVIRONMENT_CHANGED","environment changed during evaluation");
    verifyEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);
    return {metrics,runId:newRunId(),nodeId:bundle.contract.id,bundleDigest:bundle.digest,candidateDigest,environment,environmentIdentity:digest(environment),outcomes,
      allPass:allPass(outcomes),at:new Date(io.nowMs()).toISOString()};
  } finally {if(base)fs.rmSync(base,{recursive:true,force:true});}
}

function requireConclusive(result) {
  const errors=result.outcomes.filter(o=>o.status==="ERROR");
  if(errors.length)throw operationError(errors[0].errorCode??"RUNNER_ERROR",errors.map(o=>`${o.criterionId}: ${o.reasons.join("; ")}`).join("; "));
}

function requireIdentity(io,root,result) {
  ensureBudget(io,root);
  requireConclusive(result);
  if(result.nodeId){const bundle=loadBundle(io,result.nodeId),verified=verifyBundle(bundle,loadNodeState(io,result.nodeId));if(!verified.ok || bundle.digest!==result.bundleDigest)throw operationError("EVIDENCE_CORRUPT",verified.reason??"evaluated bundle identity changed");}
  if(digestTree(io.cwd,io)!==result.candidateDigest)throw operationError("CANDIDATE_MUTATED","candidate changed after evaluation");
  if(result.environment && stableStringify(result.environment)!==stableStringify(evaluatorEnvironment(io.cwd,io)))throw operationError("ENVIRONMENT_CHANGED","environment changed after evaluation");
  ensureBudget(io,root);
}

function evaluationDiagnostics(result) {
  const lines = [];
  for (const outcome of result.outcomes) {
    if (outcome.status === "PASS") continue;
    lines.push(`- ${outcome.criterionId} ${outcome.status}: ${outcome.reasons.join("; ") || "no reason"}`);
    if (outcome.stdoutTail) lines.push(`  stdout: ${outcome.stdoutTail.split("\n").slice(-4).join(" | ").slice(0, 300)}`);
    if (outcome.stderrTail) lines.push(`  stderr: ${outcome.stderrTail.split("\n").slice(-4).join(" | ").slice(0, 300)}`);
  }
  return lines;
}

export async function evaluateNode(io, nodeId = null) {
  return workspaceOperation(io,"evaluate",async io => {
    const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
    if(!root || root.status!==NodeState.ACTIVE)return {ok:false,errors:["no ACTIVE root; resume any infrastructure pause first"]};
    const owned=operationIo(io,root);
    const run=()=>{
      const current=loadRoot(io,root.id);
      overlayStack(owned.io,current);
      if (current.execution) {
        if (nodeId && nodeId !== current.id) return {ok:false,errors:["execution DAG workers are supervised at the root"]};
        return evaluateExecution(owned.io,current,loadIndex(io.cwd));
      }
      return evaluateActive(owned.io,nodeId);
    };
    try {return await run();}
    catch(e) {
      if(AUTO_RETRY_CODES.has(e.code)) {
        try {
          const result=await run();
          return {...result,warnings:[`retried once after ${e.code}: ${e.message}`,...(result.warnings??[])]};
        } catch(retryError) {e=retryError;}
      }
      const current=loadRoot(io,root.id);
      return failRoot(io,current,{code:e.code??"IO_ERROR",reason:e.message,nodeId:nodeId??leafOf(current),operation:"evaluate"});
    } finally {owned.dispose();}
  });
}

async function evaluateExecution(io, root, index) {
  const bundle = loadBundle(io, root.id), node = loadNodeState(io, root.id);
  const verified = verifyBundle(bundle, node);
  if (!verified.ok) throw operationError("EVIDENCE_CORRUPT", verified.reason);
  return runExecution(io, root, bundle, {
    persist: () => saveRoot(io, root),
    evaluate: async (cwd, ids) => {
      const candidateIo = {...io, cwd};
      const result = await freshEvaluate(candidateIo, bundle, digestTree(cwd, candidateIo), root.deadlineAt - io.nowMs(), ids);
      requireConclusive(result); ensureBudget(io, root);
      return result;
    },
    apply: async (cwd, expected) => {
      const snapshot = path.join(storePaths(io.cwd).tmpDir, `integration-${randomUUID()}`);
      try {
        const snap = snapshotTree(cwd, snapshot, io);
        if (!snap.ok) throw operationError(snap.errorCode, snap.reason);
        if (digestTree(io.cwd) !== expected) throw operationError("CANDIDATE_MUTATED", "canonical workspace changed before integration");
        restoreTree(io.cwd, snapshot, snap.manifest, io);
        if (digestTree(io.cwd) !== digestTree(cwd)) throw operationError("CANDIDATE_MUTATED", "canonical tree differs after integration");
      } finally {fs.rmSync(snapshot, {recursive:true, force:true});}
    },
    complete: async () => {
      if (root.execution.reconciliation || root.execution.slices.some(s => s.status !== "INTEGRATED")) throw operationError("INTEGRATION_INVALID", "outstanding candidates prevent root completion");
      const result = await freshEvaluate(io, bundle, digestTree(io.cwd), root.deadlineAt - io.nowMs());
      requireIdentity(io, root, result);
      node.lastResult = result; node.lastCandidateDigest = result.candidateDigest;
      node.lastEnvironmentIdentity = result.environmentIdentity;
      const snap = takeCheckpoint(io, node, "eval");
      if (!snap.ok) throw operationError("CHECKPOINT_UNAVAILABLE", snap.warning);
      requireIdentity(io, root, result);
      saveNodeState(io, node); saveRoot(io, root);
      if (!result.allPass) throw operationError("INTEGRATION_INVALID", "canonical workspace failed fresh root evaluation");
      const cascade = await closePassCascade(io, index, root, root.id, {[root.id]:result});
      return {ok:true,node:root.id,status:loadNodeState(io,root.id).status,vector:formatVector(result.outcomes),cascade};
    },
  });
}

async function evaluateActive(io, nodeId) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  if (!root) return { ok: false, errors: ["no active root"] };
  if (root.status !== NodeState.ACTIVE) return { ok: false, errors: [`root ${root.id} is ${root.status}`] };
  const targetId = nodeId ?? leafOf(root);
  const node = targetId ? loadNodeState(io, targetId) : null;
  if (!node || node.rootId !== root.id) return { ok: false, errors: [`unknown node ${targetId}`] };
  if (node.id!==leafOf(root) && node.status===NodeState.ACTIVE)return {ok:false,errors:["evaluate the active leaf before its ancestors"]};
  if (node.status === NodeState.DRAFT) return { ok: false, errors: [`${node.id} is DRAFT; seal it with exitcode_seal first`] };
  if (node.status !== NodeState.ACTIVE) {
    const current = digestTree(io.cwd);
    const stale = node.lastCandidateDigest && current !== node.lastCandidateDigest;
    return { ok: true, node: node.id, status: node.status, stale: Boolean(stale), vector: node.lastResult ? formatVector(node.lastResult.outcomes) : "none" };
  }
  const bundle = loadBundle(io, node.id);
  const verified = verifyBundle(bundle,node);
  if (!verified.ok) throw operationError("EVIDENCE_CORRUPT",verified.reason);

  ensureBudget(io,root);
  const candidateDigest = digestTree(io.cwd);
  const reservation=root.candidateReservation?.nodeId===node.id?root.candidateReservation:null;
  if(reservation)node.attempts=Math.max(node.attempts,reservation.nodeAttempts);
  const changed = candidateDigest !== (reservation?.candidateDigest??node.reservedCandidateDigest??node.lastCandidateDigest);
  const nowMs = io.nowMs();
  if (changed) {
    if (isExpired(root, nowMs)) {
      throw operationError("DEADLINE_EXCEEDED","shared execution deadline exceeded");
    }
    if ((root.consumedAttempts ?? 0) >= attemptLimitOf(root)) {
      throw operationError("BUDGET_EXHAUSTED",`total attempt budget exhausted (${attemptLimitOf(root)})`);
    }
    root.consumedAttempts += 1;
    node.attempts += 1;
    node.reservedCandidateDigest=candidateDigest;
    root.candidateReservation={nodeId:node.id,candidateDigest,nodeAttempts:node.attempts,at:io.nowMs()};
    // Persist reservations before snapshots, IO, or executable work.
    saveRoot(io,root);saveNodeState(io,node);
  }

  const timeoutMs = Math.max(0,root.deadlineAt-io.nowMs());
  const ordered = isOrdered(bundle.contract)&&!node.parentId;
  const horizon = ordered ? horizonIds(bundle.contract, node.sequenceIndex ?? 0) : null;
  let result = await freshEvaluate(io, bundle, candidateDigest, timeoutMs, horizon);
  requireIdentity(io,root,result);
  const verifiedStack={[node.id]:result};

  // Own-vector regression: restore the last verified-clean candidate,
  // re-evaluate the stack, and keep the consumed attempt.
  if (node.lastResult && !node.lastResult.stale) {
    const regressed = detectRegression(node.lastResult.outcomes, result.outcomes);
    if (regressed.length > 0) {
      const fixed = await restoreAndRefresh(io, root, node.id, ROLLING_CP);
      if(fixed.ok)delete root.candidateReservation;
      saveRoot(io, root);
      if (!fixed.ok) {
        saveNodeState(io, node);
        throw operationError("RESTORATION_FAILED",`regressed ${regressed.join(", ")} with ${fixed.reason}`);
      }
      const current = loadNodeState(io, node.id);
      const fresh = fixed.fresh[node.id] ?? current.lastResult;
      return {
        ok: true,
        node: node.id,
        status: node.status,
        vector: formatVector(fresh.outcomes),
        regressedRestored: regressed,
        diagnostics: evaluationDiagnostics(fresh),
        warnings: fixed.warning ? [fixed.warning] : [],
        next: nextAction(root, current, null, io.nowMs()),
      };
    }
  }
  node.lastResult = result;
  node.lastCandidateDigest = candidateDigest;
  node.lastEnvironmentIdentity=result.environmentIdentity;delete node.reservedCandidateDigest;

  // Ancestor regression: run the relevant ancestor evaluators, not just this
  // node's checks. Restore this node's last accepted candidate on regression.
  const ancestors = stackAncestors(root, node.id);
  for (const ancestorId of ancestors) {
    const ancestorState = loadNodeState(io, ancestorId);
    const ancestorBundle = loadBundle(io, ancestorId);
    if(!ancestorState?.lastResult || !ancestorBundle)throw operationError("EVIDENCE_CORRUPT",`ancestor ${ancestorId} lost trusted evidence`);
    const verified=verifyBundle(ancestorBundle,ancestorState);if(!verified.ok)throw operationError("EVIDENCE_CORRUPT",verified.reason);
    const ancestorHorizon = isOrdered(ancestorBundle.contract)&&!ancestorState.parentId ? horizonIds(ancestorBundle.contract, ancestorState.sequenceIndex ?? 0) : null;
    const ancestorResult = await freshEvaluate(io, ancestorBundle, candidateDigest, timeoutMs, ancestorHorizon);
    requireIdentity(io,root,ancestorResult);
    verifiedStack[ancestorId]=ancestorResult;
    const regressed = ancestorState.lastResult.stale ? [] : detectRegression(ancestorState.lastResult.outcomes, ancestorResult.outcomes);
    if (regressed.length > 0) {
      const fixed = await restoreAndRefresh(io, root, ancestorId, ROLLING_CP);
      if(fixed.ok)delete root.candidateReservation;
      saveRoot(io, root);
      if (!fixed.ok) {
        saveNodeState(io, node);
        throw operationError("RESTORATION_FAILED",`regressed ancestor ${ancestorId} (${regressed.join(", ")}) with ${fixed.reason}`);
      }
      const current = loadNodeState(io, node.id);
      const fresh = fixed.fresh[node.id] ?? current.lastResult;
      return {
        ok: true,
        node: node.id,
        status: node.status,
        vector: formatVector(fresh.outcomes),
        ancestorRegression: { ancestor: ancestorId, criteria: regressed, restored: true },
        diagnostics: evaluationDiagnostics(fresh),
        warnings: fixed.warning ? [fixed.warning] : [],
        next: nextAction(root, current, null, io.nowMs()),
      };
    }
    ancestorState.lastResult = ancestorResult;
    ancestorState.lastCandidateDigest = candidateDigest;
    ancestorState.lastEnvironmentIdentity=ancestorResult.environmentIdentity;
    // An ordered ancestor advances only on its own fresh horizon PASS, never
    // inferred from a child result. Advance here when the rerun proves it.
    if(isOrdered(ancestorBundle.contract)&&!ancestorState.parentId&&ancestorResult.allPass&&!isLastSlice(ancestorBundle.contract,ancestorState.sequenceIndex ?? 0)){
      const prevIndex=ancestorState.sequenceIndex ?? 0;
      const nextIds=horizonIds(ancestorBundle.contract,prevIndex+1);
      const seen=new Set(ancestorResult.outcomes.map(o=>o.criterionId));
      const pending=nextIds.filter(id=>!seen.has(id)).map(criterionId=>({criterionId,status:"PENDING",reasons:["slice not yet evaluated"]}));
      ancestorState.sequenceIndex=prevIndex+1;
      ancestorState.lastResult={...ancestorResult,outcomes:[...ancestorResult.outcomes,...pending],allPass:false};
      verifiedStack[ancestorId]=ancestorState.lastResult;
    }
    saveNodeState(io, ancestorState);
  }

  requireIdentity(io,root,result);
  const snap = takeCheckpoint(io, node, "eval");
  requireIdentity(io,root,result);
  const warnings = snap.ok ? [] : [snap.warning];
  delete root.candidateReservation;
  // Ordered proof advances one slice per fresh horizon PASS; only the final
  // slice can close the root. An inconclusive commit never advances.
  if(ordered&&result.allPass&&!isLastSlice(bundle.contract,node.sequenceIndex ?? 0)){
    const prevIndex=node.sequenceIndex ?? 0;
    const prevResult=result;
    try{
      const nextIds=horizonIds(bundle.contract,prevIndex+1);
      const seen=new Set(result.outcomes.map(o=>o.criterionId));
      const pending=nextIds.filter(id=>!seen.has(id)).map(criterionId=>({criterionId,status:"PENDING",reasons:["slice not yet evaluated"]}));
      node.sequenceIndex=prevIndex+1;
      node.lastResult={...result,outcomes:[...result.outcomes,...pending],allPass:false};
      result=node.lastResult;
      saveNodeState(io,node);
      saveRoot(io,root);
      requireIdentity(io,root,prevResult);
      ensureBudget(io,root);
    }catch(e){
      node.sequenceIndex=prevIndex;
      node.lastResult=prevResult;
      saveNodeState(io,node);
      throw e;
    }
    saveNodeState(io,node);
    saveRoot(io,root);
    ensureBudget(io,root);
    return {ok:true,node:node.id,status:node.status,vector:formatVector(prevResult.outcomes),warnings,next:nextAction(root,node,null,io.nowMs())};
  }
  saveNodeState(io,node);
  saveRoot(io, root);

  ensureBudget(io,root);
  if (result.allPass) {
    const cascade = await closePassCascade(io, index, root, node.id, verifiedStack);
    return { ok: true, node: node.id, status: loadNodeState(io,node.id).status, vector: formatVector(result.outcomes), warnings, cascade };
  }
  return {
    ok: true,
    node: node.id,
    status: node.status,
    vector: formatVector(result.outcomes),
    diagnostics: evaluationDiagnostics(result),
    consumedAttempt: changed,
    warnings,
    next: nextAction(root, node, null, io.nowMs()),
  };
}

/** Ancestor ids from the active stack below the node (root first). */
function stackAncestors(root, nodeId) {
  const position = root.stack.indexOf(nodeId);
  if (position <= 0) return [];
  return root.stack.slice(0, position);
}

/**
 * Close a passing node, then rerun the parent on the integrated candidate.
 * Child success never closes the parent: only the parent's own fresh
 * evaluation can. Boundary parent reruns are free (no attempt consumed).
 */
async function closePassCascade(io,index,root,nodeId,verifiedStack) {
  const events=[],passing=[],stack=[...root.stack],nextStack=[...stack];
  // Stage all verdicts. No node is provisionally accepted while an ancestor
  // evaluator, candidate/environment identity, or deadline is inconclusive.
  for(const result of Object.values(verifiedStack))requireIdentity(io,root,result);
  while(nextStack.length) {
    const id=nextStack.at(-1),result=verifiedStack[id];
    if(!result?.allPass)break;
    const state=loadNodeState(io,id),verified=verifyBundle(loadBundle(io,id),state);
    if(!verified.ok)throw operationError("EVIDENCE_CORRUPT",verified.reason);
    passing.push(state);nextStack.pop();
    if(id!==nodeId)events.push(`${id} rerun: ${formatVector(result.outcomes)}`);
    events.push(`${id} PASS`);
  }
  const result=verifiedStack[root.id]??verifiedStack[nodeId];
  requireIdentity(io,root,result);
  // Persist the original stack so reload can recover an interrupted multi-file
  // commit. A closing record is not a completed terminal verdict.
  root.closingStack=stack;saveRoot(io,root);
  try {
    for(const state of passing){state.status=NodeState.PASS;saveNodeState(io,state);}
    ensureBudget(io,root);
    root.stack=nextStack;
    let terminal=null;
    if(!nextStack.length) {
      const outcome={candidateDigest:result.candidateDigest,environment:result.environment,environmentIdentity:result.environmentIdentity,runId:result.runId,at:result.at};
      markTerminal(io,index,root,NodeState.PASS,outcome);
      terminal={root:root.id,status:NodeState.PASS,outcome};events.push(`root ${root.id} PASS`);
    } else {
      const parent=nextStack.at(-1),parentResult=verifiedStack[parent];
      if(parentResult)events.push(`${parent} rerun: ${formatVector(parentResult.outcomes)}`);
      saveRoot(io,root);
    }
    requireIdentity(io,root,result);
    delete root.closingStack;saveRoot(io,root);ensureBudget(io,root);
    return {events,terminal};
  } catch(e) {
    root.closingStack=stack;
    recoverClosing(io,index,root);
    throw e;
  }
}

/** Recover only an incomplete verdict commit, never replace fresh evaluation. */
function recoverClosing(io,index,root) {
  if(!root?.closingStack)return false;
  root.stack=[...root.closingStack];root.status=NodeState.ACTIVE;delete root.outcome;
  for(const id of root.stack){const state=loadNodeState(io,id);if(state?.status===NodeState.PASS){state.status=NodeState.ACTIVE;saveNodeState(io,state);}}
  delete root.closingStack;saveRoot(io,root);index.activeRootId=root.id;saveIndex(io.cwd,index);
  return true;
}

// --- block ---------------------------------------------------------------

export async function blockNode(io,nodeId,args) {
  return workspaceOperation(io,"block",async io=>{
    const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
    if(!root)return {ok:false,errors:["no active root"]};
    const owned=operationIo(io,root);
    try {return await blockActive(owned.io,nodeId,args);}
    catch(e){return failRoot(io,loadRoot(io,root.id),{code:e.code??"IO_ERROR",reason:e.message,nodeId,operation:"block",args});}
    finally {owned.dispose();}
  });
}

async function blockActive(io,nodeId,{reason,code="NO_PATH"}) {
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  const node=nodeId?loadNodeState(io,nodeId):null;
  if(!root||!node||node.rootId!==root.id)return {ok:false,errors:[`unknown node ${nodeId}`]};
  if(!nonEmptyString(reason))return {ok:false,errors:["reason must name the specific missing requirement or cause"]};
  if(!BLOCK_CODES.includes(code))return {ok:false,errors:[`code must be one of ${BLOCK_CODES.join(", ")}`]};
  // Mechanical evaluator findings are the agent's to repair, never a reason to pause.
  const diagnostics=node.status===NodeState.DRAFT?node.diagnostics??[]:[];
  if(diagnostics.length && diagnostics.every(d=>d.repairability==="agent"))
    return {ok:false,errors:[`${node.id} has only agent-repairable evaluator diagnostics (${[...new Set(diagnostics.map(d=>d.code))].join(", ")}); repair the evaluator instead of pausing`],
      next:nextAction(root,node,readJson(draftFile(io.cwd,node.id))?.draft??null,io.nowMs())};
  if([NodeState.PASS,NodeState.BLOCKED].includes(node.status))return {ok:true,node:node.id,status:node.status};
  if(root.status===NodeState.PAUSED)return {ok:false,errors:["resume the saved pause before replacing its operation"]};
  if(code==="NO_PATH" && !node.parentId)
    return {ok:false,errors:["NO_PATH only withdraws a focused child; at the root, repair toward the failing criteria, or request the specific missing requirement, credential, authorization, or external action"],
      next:nextAction(root,node,readJson(draftFile(io.cwd,node.id))?.draft??null,io.nowMs())};
  if(code!=="NO_PATH")
    return pauseRoot(io,root,{code,reason:reason.trim(),nodeId:leafOf(root),operation:loadNodeState(io,leafOf(root))?.status===NodeState.DRAFT?"prepare":"evaluate",details:{blockedNodeId:node.id}});
  if(leafOf(root)!==node.id)return {ok:false,errors:["only the active leaf may be withdrawn"]};
  ensureBudget(io,root);
  // A declined child path can be withdrawn. Infrastructure faults do not use this path.
  const parent=loadNodeState(io,node.parentId);
  const fix=parent?restoreCheckpoint(io,parent,c=>c.id===node.preChildCheckpointId && c.note===`pre-child:${node.id}`):{ok:false,reason:"missing parent"};
  if(!fix.ok)throw operationError("RESTORATION_FAILED",`cannot withdraw child safely: ${fix.reason}`);
  const digestAfter=digestTree(io.cwd),events=[`${node.id} BLOCKED (${code}): ${reason.trim()}`,`restored ${parent.id} to pre-child checkpoint`];
  // Exclude the withdrawn leaf during refresh, but do not pop or terminally mark it until every parent result is conclusive.
  const refreshed=await refreshStack(io,{...root,stack:root.stack.filter(id=>id!==node.id)},digestAfter);
  if(refreshed[parent.id])events.push(`${parent.id} rerun: ${formatVector(refreshed[parent.id].outcomes)}`);
  for(const result of Object.values(refreshed))requireIdentity(io,root,result);
  node.status=NodeState.BLOCKED;node.blockedReason=reason.trim();node.blockedCode=code;node.blockedCandidateDigest=digestAfter;node.blockedEnvironmentIdentity=digest(evaluatorEnvironment(io.cwd));
  saveNodeState(io,node);popStack(root,node.id);saveRoot(io,root);
  const reloaded=loadNodeState(io,parent.id),snap=takeCheckpoint(io,reloaded,"eval");saveNodeState(io,reloaded);
  if(!snap.ok)events.push(`warning: ${snap.warning}`);
  return {ok:true,node:node.id,status:NodeState.BLOCKED,events,terminal:null};
}

// --- status --------------------------------------------------------------

/** The next action, led by any recorded fault and soft-budget strategy warnings. */
export function nextAction(root, node, draft = null, nowMs = Date.now()) {
  const base = plannedAction(root, node, draft, nowMs);
  if (root?.status === NodeState.PAUSED || !root) return base;
  const notes = [...(root.fault ? [`last issue ${root.fault.code} (${root.fault.disposition}): ${clip(root.fault.reason, 200)}`] : []),
    ...softBudgetWarnings(root, nowMs, node).map((w) => `strategy check: ${w}`)];
  return notes.length ? `${notes.join("; ")}; then ${base}` : base;
}

function plannedAction(root, node, draft, nowMs) {
  if(root?.status===NodeState.PAUSED)return `PAUSED (${root.pause?.code}): ${root.pause?.reason}. ${root.pause?.recovery==="grant"?"The user grants more budget with /exitcode resume":"The user restores the prerequisite, then /exitcode resume"}. Execution budget never resets.`;
  if (!node) return "no active node";
  if (node.status === NodeState.DRAFT) {
    if (isExpired(root, nowMs)) {
      return policyEditable(root, node)
        ? `shared deadline exceeded; revise ${node.id} with a larger finite policy and present the entire contract again, or the user can cancel with /exitcode exit`
        : "shared deadline exceeded; the user must cancel with /exitcode exit and start a fresh root with fresh review";
    }
    if (node.parentId) return `seal ${node.id} with exitcode_seal (prepares the child evaluator first)`;
    if (node.phase !== "READY_FOR_APPROVAL") return `revise ${node.id} evaluator with exitcode_draft (including acceptance assets), or retry preparation before user review`;
    if (!node.parentId && !approvalMatches(root,draft)) return "present the validated plan and wait for explicit approval";
    return `seal ${node.id} with exitcode_seal`;
  }
  if (node.status !== NodeState.ACTIVE) return `${node.id} is ${node.status}`;
  if (root.execution) return `exitcode_evaluate ${root.id}: run ready DAG workers, integrate fresh proofs, and reverify the canonical workspace (attempts ${attemptBudgetText(root)})`;
  const failing = (node.lastResult?.outcomes ?? []).filter((o) => o.status === "FAIL").map((o) => o.criterionId);
  const pending = (node.lastResult?.outcomes ?? []).filter((o) => o.status === "PENDING").map((o) => o.criterionId);
  const repairs = root.policy.localRepairs ?? DEFAULT_POLICY.localRepairs;
  const attempts = `attempts ${attemptBudgetText(root)}`;
  const slice = Array.isArray(node.sequence) && node.sequence.length ? node.sequence[Math.min(node.sequenceIndex ?? 0, node.sequence.length - 1)] : null;
  const prefix = slice ? `slice ${(node.sequenceIndex ?? 0) + 1}/${node.sequence.length}: ${slice.objective}; ` : "";
  if (pending.length) return `${prefix}evaluate ${node.id} to prove ${pending.join(", ")} fresh (${attempts})`;
  if ((node.attempts ?? 0) < repairs) {
    return `${prefix}repair ${node.id} to achieve its goal; use failures [${failing.join(", ") || "none"}] as feedback, then exitcode_evaluate (${attempts})`;
  }
  return `${prefix}exitcode_evaluate ${node.id}; if a smaller goal offers a clearer path, propose exitcode_child targeting one of [${failing.join(", ") || "none"}], subject to supervisor gates (${attempts})`;
}

export function statusSnapshot(io) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  if (!root) return { active: false, roots: index.roots, resumable: resumableRoots(io) };
  const nodes = {};
  for (const id of root.stack) {
    const node = loadNodeState(io, id);
    if (node) {
      nodes[id] = {
        status: node.status,
        attempts: node.attempts,
        vector: node.lastResult ? formatVector(node.lastResult.outcomes) : "unevaluated",
        goal: loadBundle(io, id)?.contract.goal ?? readJson(draftFile(io.cwd, id))?.draft.goal ?? "",
      };
    }
  }
  const leafId = leafOf(root);
  const leaf = leafId ? loadNodeState(io, leafId) : null;
  const rootNode = loadNodeState(io, root.id);
  const rootDraft = rootNode?.status === NodeState.DRAFT ? readJson(draftFile(io.cwd, root.id))?.draft : null;
  const awaitingApproval = rootNode?.status === NodeState.DRAFT && rootNode.phase === "READY_FOR_APPROVAL" && !approvalMatches(root, rootDraft);
  return {
    active: true,
    root: root.id,
    status: root.status,
    stack: root.stack,
    execution: root.execution ? { phase: root.execution.phase, slices: root.execution.slices.map(s => ({id:s.id,status:s.status})), reconciliation: root.execution.reconciliation?.id ?? null } : null,
    nodes,
    consumedAttempts: root.consumedAttempts,
    maxTotalAttempts: attemptLimitOf(root),
    attemptBudget: attemptBudgetText(root),
    explicitLimits: root.explicitLimits ?? [],
    ...policyStatus(root, rootNode, io.nowMs()),
    approval: root.approval ?? null,
    pause: root.pause??null,
    fault: root.fault??null,
    executionGrants: root.executionGrants??[],
    acceptanceRestorations:root.acceptanceRestorations??[],
    awaitingApproval,
    phase: root.status===NodeState.PAUSED?"PAUSED":leaf?.phase ?? (leaf?.status === NodeState.DRAFT ? "EVALUATOR_PREPARATION" : "EXECUTION"),
    intentDigest: rootDraft ? intentDigestOf(rootDraft) : loadBundle(io,root.id)?.intentDigest,
    evaluatorDigest: rootDraft ? evaluatorDigestOf(rootDraft) : loadBundle(io,root.id)?.evaluatorDigest,
    evaluatorMetrics: rootNode?.evaluatorMetrics ?? emptyMetrics(),
    diagnostics: leaf?.diagnostics ?? [],
    warnings: leaf?.prepared?.warnings ?? loadBundle(io,leafId)?.warnings ?? [],
    evaluatorEvidence: rootNode?.prepared ?? null,
    originalRequest: rootDraft?.originalRequest ?? loadBundle(io,root.id)?.contract.originalRequest,
    contract: rootDraft ?? loadBundle(io,root.id)?.contract,
    review: awaitingApproval ? rootReviewText(rootDraft, root, io.nowMs(), rootNode.prepared) : null,
    next: leaf ? nextAction(root, leaf, leaf.id === root.id ? rootDraft : null, io.nowMs()) : "none",
  };
}

const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const diagnosticLine = (d, max) => `${d.criterionId ?? "contract"} ${d.code}: ${clip(d.evidence, max)}`;

function leafContract(io, snap) {
  const leafId = snap.stack.at(-1);
  return leafId ? loadBundle(io, leafId)?.contract ?? readJson(draftFile(io.cwd, leafId))?.draft : null;
}

function sliceLines(io, snap) {
  if (snap.execution) return [`execution: ${snap.execution.phase}`, `slices: ${snap.execution.slices.map(s => `${s.id}=${s.status}`).join(" ")}`,
    ...(snap.execution.reconciliation ? ["reconciliation: outstanding"] : [])];
  const leafId = snap.stack.at(-1);
  if (!leafId) return [];
  const node = loadNodeState(io, leafId);
  const contract = leafContract(io, snap);
  if (!node || node.parentId || node.status !== NodeState.ACTIVE || !isOrdered(contract)) return [];
  const index = node.sequenceIndex ?? 0;
  const slice = contract.sequence[Math.min(index, contract.sequence.length - 1)];
  const vector = node.lastResult ? formatVector(node.lastResult.outcomes) : "unevaluated";
  return [`slice ${index + 1}/${contract.sequence.length}: ${slice.objective}`, `proof: ${vector}`];
}

/**
 * Bounded control-plane state injected into every agent turn. Never contains
 * checks, controls, evaluator evidence, or metrics; those are explicit-only.
 */
export function promptStatusText(io) {
  const snap = statusSnapshot(io);
  if (!snap.active) return "exitcode: no active root";
  const lines = [`exitcode root ${snap.root} [${snap.status}] phase ${snap.phase}; stack ${snap.stack.join(" > ") || "(empty)"}`];
  for (const [id, node] of Object.entries(snap.nodes)) lines.push(`${id} ${node.status} :: ${node.vector} :: ${clip(node.goal, 160)}`);
  for (const line of sliceLines(io, snap)) lines.push(line);
  const contract = leafContract(io, snap);
  for (const c of contract?.criteria ?? []) lines.push(`  ${c.id}${c.type === "regression" ? " (regression)" : ""}: ${clip(criterionRequirement(contract,c), 120)}`);
  lines.push(`approval: ${snap.awaitingApproval ? "awaiting the user's reply to the validated plan" : snap.approval ? "approved" : "none"}`);
  lines.push(`budget: ${snap.attemptBudget} attempts; ${snap.clockStarted ? `${snap.softRemainingMs !== null ? `${(snap.softRemainingMs / 60000).toFixed(1)} min soft, ` : ""}${(snap.remainingMs / 60000).toFixed(1)} min left` : "clock starts at root seal"}${snap.expired ? " (EXPIRED)" : ""}`);
  if (snap.pause) lines.push(`pause: ${snap.pause.code}: ${clip(snap.pause.reason, 200)}`);
  if (snap.fault) lines.push(`last issue: ${snap.fault.code} (${snap.fault.disposition}): ${clip(snap.fault.reason, 200)}`);
  for (const warning of snap.warnings.slice(0,3)) lines.push(`warning: ${clip(warning,200)}`);
  const shown = snap.diagnostics.slice(0, 6);
  for (const d of shown) lines.push(`diagnostic: ${diagnosticLine(d, 160)}`);
  if (snap.diagnostics.length > shown.length) lines.push(`diagnostic: +${snap.diagnostics.length - shown.length} more (exitcode_status)`);
  lines.push(`next: ${clip(snap.next, 400)}`);
  const text = lines.join("\n");
  return Buffer.byteLength(text) <= PROMPT_STATUS_MAX_BYTES ? text
    : `${Buffer.from(text).subarray(0, PROMPT_STATUS_MAX_BYTES - 64).toString("utf8")}\n…\nnext: ${clip(snap.next, 40)}`;
}

function inactiveStatusText(snap) {
  if (!snap.resumable.length) return `exitcode: no root currently owns this workspace (previous roots: ${snap.roots.join(", ") || "none"})`;
  return ["exitcode: no root currently owns this workspace.", "", "Resumable:",
    ...snap.resumable.map((r) => `  ${r.id} ${r.status}${r.sealed ? " sealed" : ""}  ${JSON.stringify(clip(r.goal, 120))}`),
    "", "Use /exitcode resume [Gid], or /exitcode <goal> to start fresh."].join("\n");
}

/** Operational status. detail "evidence" adds the full contract, E0 evidence, and metrics. */
export function statusText(io, { detail = "normal" } = {}) {
  const snap = statusSnapshot(io);
  if (!snap.active) return inactiveStatusText(snap);
  const lines = [`exitcode root ${snap.root} [${snap.status}] stack: ${snap.stack.join(" > ") || "(empty)"}`];
  for (const [id, node] of Object.entries(snap.nodes)) {
    lines.push(`  ${id} ${node.status} attempts=${node.attempts} :: ${node.vector}`);
    if (node.goal) lines.push(`    goal: ${node.goal.slice(0, 160)}`);
  }
  for (const line of sliceLines(io, snap)) lines.push(`  ${line}`);
  const contract = leafContract(io,snap);
  for (const c of contract?.criteria ?? []) lines.push(`  ${c.id}${c.type === "regression" ? " (regression)" : ""}: ${clip(criterionRequirement(contract,c), 200)}`);
  lines.push(`  budget: ${snap.attemptBudget} attempts, deadline ${snap.clockStarted?snap.deadlineAt:"starts at root seal"}${snap.expired ? " (EXPIRED)" : ""}`);
  lines.push(`  effective policy: ${JSON.stringify(snap.policy)}`);
  lines.push(`  remaining: ${snap.softRemainingMs !== null ? `${(snap.softRemainingMs / 60000).toFixed(2)} minutes to the soft threshold, ` : ""}${(snap.remainingMs / 60000).toFixed(2)} minutes; policy ${snap.policyEditable ? "editable before approval" : "locked"}${snap.clockStarted?"":"; execution clock not started"}`);
  if (snap.executionGrants.length) lines.push(`  execution grants: ${JSON.stringify(snap.executionGrants)}`);
  if (snap.acceptanceRestorations.length) lines.push(`  acceptance restorations: ${JSON.stringify(snap.acceptanceRestorations)}`);
  for (const warning of snap.warnings) lines.push(`  warning: ${warning}`);
  lines.push(`  phase: ${snap.phase}`, ...(snap.pause?[`  pause: ${snap.pause.code}: ${snap.pause.reason}`]:[]),
    ...(snap.fault?[`  last issue: ${snap.fault.code} (${snap.fault.disposition}): ${snap.fault.reason}`]:[]));
  if (detail === "evidence") {
    const contract = leafContract(io, snap), nodeId = snap.stack.at(-1);
    const evidence = loadBundle(io,nodeId) ?? loadNodeState(io,nodeId)?.prepared;
    for (const c of contract?.criteria ?? []) if (c.check.recipe.kind === 'test_asset') {
      const r = c.check.recipe;
      lines.push(`  ${c.id} acceptance asset: ${path.relative(io.cwd,evidence?.assetsDirectory ?? path.join(storePaths(io.cwd).assetsDir,`${nodeId}.prepared`))}/.exitcode-evaluator/${r.asset}`,
        `    command: ${r.command} ${(r.args ?? []).join(' ')} .exitcode-evaluator/${r.asset}`);
    }
    lines.push(`  evaluator metrics: ${JSON.stringify(snap.evaluatorMetrics)}`, `  intent digest: ${snap.intentDigest}`, `  evaluator digest: ${snap.evaluatorDigest}`,
      `  diagnostics: ${JSON.stringify(snap.diagnostics)}`, `  evaluator evidence: ${JSON.stringify(snap.evaluatorEvidence)}`, `  contract: ${JSON.stringify(snap.contract)}`);
  } else {
    for (const d of snap.diagnostics) lines.push(`  - ${diagnosticLine(d, 400)}${d?.recommendedRepair ? ` (${d.recommendedRepair})` : ""}`);
  }
  lines.push(`  next: ${snap.next}`);
  if (snap.review) lines.push("", snap.review);
  return lines.join("\n");
}

/** A recorded PASS is only valid for its candidate; later edits stale it. */
export function terminalStale(io, rootId) {
  const root = loadRoot(io, rootId);
  if (!root || root.status !== NodeState.PASS) return { stale: false };
  if(root.closingStack)return {stale:true,reason:"interrupted verdict commit requires fresh evaluation"};
  const current = digestTree(io.cwd);
  return { stale: current !== root.outcome?.candidateDigest || stableStringify(evaluatorEnvironment(io.cwd))!==stableStringify(root.outcome?.environment), recorded: root.outcome?.candidateDigest, current };
}

/** Interrupted preparation never restores approval or unlocks coding. */
function clearInterruptedPreparation(io,id) {
  const node=loadNodeState(io,id);
  if(node?.preparing){delete node.preparing;node.phase="EVALUATOR_PREPARATION";delete node.prepared;saveNodeState(io,node);}
  if(node?.status===NodeState.PASS){node.status=NodeState.ACTIVE;saveNodeState(io,node);}
}

export function resumePreparation(io) {
  return workspaceOperation(io,"recover",io=>{
    const index=loadIndex(io.cwd),id=index.activeRootId??io.expectedRootId,root=id?loadRoot(io,id):null;
    if(recoverClosing(io,index,root))return failRoot(io,root,{reason:"Interrupted verdict commit; fresh evaluation is required",code:"INTERRUPTED",operation:"evaluate"});
    for(const id of root?.stack??[])clearInterruptedPreparation(io,id);
    return {ok:true};
  });
}

export { reviewPrompt, REVIEW_TIMEOUT_MS, REVIEW_MAX_TOKENS, REVIEW_TOOL_NAME, CRITIC_CODES, parseReviewText, parseReviewResponse, validateCritic, criticInput, callReview } from './exitcode-quality.mjs';
