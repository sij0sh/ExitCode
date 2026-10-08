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
 * node builtins against <cwd>/.exitcode/; execution and runtime fingerprinting
 * are injected so tests can substitute fakes.
 */

import { createHash, randomUUID } from "node:crypto";
export { RECIPE_KINDS, MUTATION_KINDS } from "./exitcode-evaluator.mjs";
import { sandboxCommand, candidateIdentity, evaluatorEnvironment, fingerprintRuntime, normalizeEvaluator, runRecipe, diagnostic, fileDigest, inventory, fixtureDirectory, captureEvaluatorAssets, verifyEvaluatorAssets, installEvaluatorAssets, restoreEvaluatorAssets, compatibleEnvironment, digest, safePath } from "./exitcode-evaluator.mjs";
import { prepareGate, emptyMetrics, addMetrics, copyCandidate, releasePreparation } from "./exitcode-preparation.mjs";
import { ensureRunning, operationSignal, operationError } from "./exitcode-operation.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXITCODE_DIR = ".exitcode";
export const MODE_ENTRY_TYPE = "exitcode-mode";

/** Persisted node states. FAIL is a check result, not a node state. */
export const NodeState = Object.freeze({
  DRAFT: "DRAFT",
  EVALUATOR_PREPARATION: "EVALUATOR_PREPARATION",
  READY_FOR_APPROVAL: "READY_FOR_APPROVAL",
  CLARIFICATION: "CLARIFICATION",
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
});

/** Evaluator-draft proposals (seal attempts) allowed per node. */
export const MAX_DRAFT_PROPOSALS = 2;

/** Consecutive no-progress nudges before an explicit resumable pause. */
export const MAX_SETTLE_NUDGES = 3;

/** Rolling checkpoints kept per node. */
export const MAX_CHECKPOINTS_PER_NODE = 3;

/** Snapshot size cap (logical bytes of file content, including build artifacts). */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** Legacy exported threshold; content hashing no longer samples files. */
export const LARGE_FILE_BYTES = 8 * 1024 * 1024;

/** Per-stream capture cap for executed checks. */
export const EXEC_OUTPUT_MAX_BYTES = 64 * 1024;

export const BLOCK_CODES = Object.freeze([
  "REQUIREMENT_MISSING",
  "CREDENTIAL_MISSING",
  "AUTHORIZATION_MISSING",
  "EVALUATOR_UNBUILDABLE",
  "BUDGET_EXHAUSTED",
  "EXTERNAL_BLOCKED",
  "NO_PATH",
]);

/** Discarded pre-seal change sets kept for recovery. */
export const MAX_DISCARDED_CHANGES = 3;

/** Supervisor tools. Other agent tools are not classified; candidate state is verified instead. */
export const EXITCODE_TOOL_NAMES = Object.freeze([
  "exitcode_status", "exitcode_draft", "exitcode_seal",
  "exitcode_evaluate", "exitcode_child", "exitcode_block",
]);

/** Short protocol instructions supplied to Pi while exitcode mode is on. */
export const PROTOCOL_PROMPT = [
  "EXITCODE MODE - FIX SUCCESS / PURSUE SUCCESS / PROVE SUCCESS.",
  "FIX SUCCESS: Inspect the goal, architecture, tests, and likely regressions before implementation.",
  "Resolve known product ambiguity with the user and propose observable acceptance criteria with executable checks.",
  "Submit recipes, confined fixtures, declared intent outcomes and ambiguity candidates to exitcode_draft. The supervisor safely prepares E0 before returning a validated plan. Repair typed evaluator failures before review; do not ask approval for invalid proposals.",
  "Present the validated plan and wait for explicit user approval. READY_FOR_APPROVAL pauses autonomous continuation.",
  "Repair evaluator proposals before review. Revisions after review require fresh validated-plan approval. Policy and remaining time are in status.",
  "Operational policy can change before approval. Initial discovery, evaluator preparation, E0 and human review spend no execution time. The root execution clock starts once at seal; retries and children never reset it.",
  "Keep the user's original objective above extension housekeeping and commit reminders. Never replace it with a commit-only goal.",
  "Before sealing, inspect with any available tools but never change the candidate. Pre-seal changes are discarded and the working tree is restored.",
  "Supervisor state under .exitcode/ is private. Submit contracts through ExitCode tools only.",
  "The supervisor validates the evaluator before user review. Approval seals that exact validated bundle; stale preparation must be repeated.",
  "The sealed acceptance program, tests, required cases and expectations are fixed and cannot be weakened. Declare custom acceptance helpers in check.assets and referenced plans in specificationPaths. Declare mutableDependencies only when the approved task must change product dependencies.",
  "PURSUE SUCCESS: Implement the approved goal. Use the sealed criteria to measure whether it has been achieved.",
  "Use evaluator failures as repair feedback and preserve previously passing behavior.",
  "Prefer direct repair. Decompose only when the supervisor permits it and a smaller goal offers a clearer path to a failed parent criterion.",
  "A child is a temporary reduction of its parent problem, not a new objective.",
  "It targets one failed parent criterion, needs no user approval, and cannot change ancestor contracts.",
  "PROVE SUCCESS: Evaluate after meaningful changes.",
  "Only a fresh supervisor evaluation with all criteria passing completes a goal.",
  "A passing child does not complete its parent; follow the supervisor's returned parent result and next action.",
  "Infrastructure ERROR is inconclusive, not FAIL. Preserve useful edits and retry the same authorized operation or resume its pause. Never retry assertions until green. Report concrete authority, ambiguity, integrity or exhausted-budget blockers.",
  "Only a fresh root PASS exits mode automatically. A blocker or clarification pause keeps enforcement on. Only the user can cancel with /exitcode exit.",
].join(" ");

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
export function depthOf(id) {
  return String(id).split(".").length - 1;
}

export function isValidNodeId(id) {
  return typeof id === "string" && /^G\d+(\.\d+)*$/.test(id);
}

export function parentIdOf(id) {
  const parts = String(id).split(".");
  if (parts.length < 2) return null;
  parts.pop();
  return parts.join(".");
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
    operation: path.join(root, "operation.lock"),
  };
}

export function ensureStoreDirs(cwd) {
  const p = storePaths(cwd);
  for (const dir of [p.root, p.rootsDir, p.draftsDir, p.contractsDir, p.nodesDir, p.checkpointsDir, p.tmpDir, p.assetsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

export function readJson(file) {
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
  return readJson(storePaths(cwd).index) ?? { version: 1, rootCounter: 0, activeRootId: null, roots: [] };
}

export function saveIndex(cwd, index) {
  writeJsonAtomic(storePaths(cwd).index, index);
}

export function rootFile(cwd, rootId) {
  return path.join(storePaths(cwd).rootsDir, `${rootId}.json`);
}

export function draftFile(cwd, nodeId) {
  return path.join(storePaths(cwd).draftsDir, `${nodeId}.json`);
}

export function sealedFile(cwd, nodeId) {
  return path.join(storePaths(cwd).contractsDir, `${nodeId}.sealed.json`);
}

export function nodeFile(cwd, nodeId) {
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
  if (!isRecord(check)) {
    errors.push(`${where}: check must be an object with a command`);
    return;
  }
  if (!nonEmptyString(check.command) && !isRecord(check.recipe)) errors.push(`${where}: check.command or recipe must be supplied`);
  if (check.command && check.recipe) errors.push(`${where}: choose command or recipe, not both`);
  if (check.timeoutSeconds !== undefined && !(Number.isFinite(check.timeoutSeconds) && check.timeoutSeconds > 0 && Number.isFinite(check.timeoutSeconds*1000))) {
    errors.push(`${where}: check.timeoutSeconds must be a positive number`);
  }
  if(check.assets !== undefined && (!Array.isArray(check.assets) || !check.assets.every(nonEmptyString)))errors.push(`${where}: check.assets must contain candidate-relative paths`);
  validateExpect(check.expect, `${where}.check`, errors);
}

function validateControls(controls, where, errors, { required }) {
  if (controls === undefined) {
    if (required) errors.push(`${where}: behavioral criteria require controls.accept and at least one controls.reject`);
    return;
  }
  if (!isRecord(controls)) {
    errors.push(`${where}: controls must be an object`);
    return;
  }
  if (!isRecord(controls.accept) || !(nonEmptyString(controls.accept.setup) || Array.isArray(controls.accept.mutations) && controls.accept.mutations.length > 0)) {
    errors.push(`${where}: controls.accept.setup must be a nonempty string`);
  }
  if (!Array.isArray(controls.reject) || controls.reject.length === 0) {
    errors.push(`${where}: controls.reject must be a nonempty array`);
  } else {
    controls.reject.forEach((entry, i) => {
      if (!isRecord(entry) || !(nonEmptyString(entry.setup) || Array.isArray(entry.mutations) && entry.mutations.length > 0)) {
        errors.push(`${where}: controls.reject[${i}].setup must be a nonempty string`);
      }
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
  if (draft.version !== 1) errors.push("version must be 1");
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
  if (draft.verification !== undefined && !nonEmptyString(draft.verification)) {
    errors.push("verification must be a nonempty description of the verification approach");
  }

  if(draft.specificationPaths !== undefined && (!Array.isArray(draft.specificationPaths) || !draft.specificationPaths.every(nonEmptyString)))errors.push("specificationPaths must be an array of paths");
  if(draft.mutableDependencies !== undefined && typeof draft.mutableDependencies !== "boolean")errors.push("mutableDependencies must be boolean");

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
      if (!nonEmptyString(criterion.requirement)) errors.push(`${criterion.id || where}: requirement must be a nonempty string`);
      const type = criterion.type ?? "behavior";
      if (type !== "behavior" && type !== "regression") {
        errors.push(`${criterion.id || where}: type must be "behavior" or "regression"`);
      }
      validateCheck(criterion.check, `${criterion.id || where}`, errors);
      validateControls(criterion.controls, `${criterion.id || where}`, errors, { required: type === "behavior" });
    });
    if (!isChild && !draft.criteria.some((c) => (c.type ?? "behavior") === "regression")) {
      errors.push("root contracts must include at least one regression criterion");
    }
  }

  return { ok: errors.length === 0, errors };
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

export function tailText(text, maxBytes = 4000) {
  const value = String(text ?? "");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, truncated: false };
  const buf = Buffer.from(value, "utf8");
  return { text: buf.subarray(bytes - maxBytes).toString("utf8"), truncated: true };
}

// ---------------------------------------------------------------------------
// Command execution (injectable; default is fail-closed bubblewrap isolation)
// ---------------------------------------------------------------------------

/**
 * Run one shell command. Resolves (never rejects on nonzero exit) to
 * { exit, stdout, stderr, timedOut, error?, durationMs, truncated }.
 */
export const execCommand = sandboxCommand;

// ---------------------------------------------------------------------------
// Checks and evaluation
// ---------------------------------------------------------------------------

export function checkTimeoutMs(criterion, defaultTimeoutMs) {
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
    const execute=()=>criterion.check.recipe ? runRecipe(criterion.check.recipe,{...options,exec,capabilities,onExecution}) : (onExecution?.(),exec(criterion.check.command,options));
    const run=await execute();
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

export function outcomesById(resultOrBaseline) {
  const map = new Map();
  for (const outcome of resultOrBaseline?.outcomes ?? []) map.set(outcome.criterionId, outcome.status);
  return map;
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

// ---------------------------------------------------------------------------
// Candidate identity and environment
// ---------------------------------------------------------------------------

export const SNAPSHOT_IGNORE = Object.freeze([".git", EXITCODE_DIR]);

/** Legacy attempt accounting excluded installed dependencies. Keep that rule on sealed legacy roots. */
function legacyCandidateIdentity(cwd){return digest(inventory(cwd).map(({rel,sha,size,mode,link})=>({rel,sha,size,mode,link})));}

/** Full relevant candidate content identity, including modes and symlink targets. */
export function digestTree(cwd,options) { return candidateIdentity(cwd,options); }

export function envIdentity(cwd) {
  const env = { platform: os.platform(), node: process.version };
  for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]) {
    const file = path.join(cwd, lock);
    if (fs.existsSync(file)) {
      env.lockfile = lock;
      env.lockDigest = sha256Hex(fs.readFileSync(file)).slice(0, 16);
      break;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Checkpoints (file-tree snapshots; restore on regression)
// ---------------------------------------------------------------------------

export function snapshotTree(cwd, destDir, { maxBytes = SNAPSHOT_MAX_BYTES, writeManifest = true, signal, deadlineAt, nowMs=Date.now } = {}) {
  try {
    ensureRunning(signal,deadlineAt,nowMs);
    const entries = inventory(cwd,{dependencies:true,signal,deadlineAt,nowMs});
    const totalBytes=entries.reduce((n,f)=>n+(f.size??0),0);
    if(totalBytes>maxBytes)throw operationError("CAPACITY_UNAVAILABLE",`working tree exceeds snapshot cap (${maxBytes} bytes): ${totalBytes} bytes across ${entries.length} files; fixture setup cannot reduce the pre-copy size`);
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
    const manifest={version:2,at:new Date().toISOString(),totalBytes,files,...(writeManifest?{payload:"tree"}:{})};
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
  writeJsonAtomic(p.record, { version: 1, at: new Date().toISOString(), ...record });
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
// Evaluator gate (E0): structure, traceability, discrimination, wiring,
// execution, baseline, sealing
// ---------------------------------------------------------------------------

async function runControlProbe(criterion, setup, deps) {
  let fixture;
  try {
    // Prefer the candidate filesystem for reflinks, but stay outside Git ancestry
    // so fixture commands cannot discover the real candidate's repository.
    let parent = path.dirname(path.resolve(deps.cwd));
    for (let dir = path.resolve(deps.cwd); ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) parent = path.dirname(dir);
      if (dir === path.dirname(dir)) break;
    }
    try {
      fixture = fs.mkdtempSync(path.join(parent, "exitcode-control-"));
    } catch (error) {
      if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;
      fixture = fs.mkdtempSync(path.join(os.tmpdir(), "exitcode-control-"));
    }
    // Reuse candidate snapshot rules, but keep metadata out of the fixture.
    const copy = snapshotTree(deps.cwd, fixture, { writeManifest: false, maxBytes: deps.maxBytes ?? SNAPSHOT_MAX_BYTES });
    if (!copy.ok) return { error: copy.reason };
    const prepared = await runCheck(
      { ...criterion, check: { command: setup, timeoutSeconds:criterion.check.timeoutSeconds, expect: { exit: 0 } } },
      deps.exec, fixture, deps.defaultTimeoutMs,
    );
    if (prepared.status !== "PASS") {
      return { error: `setup ${prepared.status}: ${prepared.reasons.join("; ")}` };
    }
    const outcome = await runCheck(criterion, deps.exec, fixture, deps.defaultTimeoutMs);
    return { outcome };
  } catch (error) {
    return { error: `fixture error: ${error?.message ?? String(error)}` };
  } finally {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * Run the fixed gate over an immutable draft copy.
 * deps: { exec, cwd, wiringDir, candidateDigest, env, defaultTimeoutMs, maxBytes? }
 */
export async function runGate(draft, validation, deps) {
  const errors = [];
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const candidateDigest = deps.candidateDigest ?? digestTree(deps.cwd);
  const verifyCandidate = () => {
    try {
      if (digestTree(deps.cwd) !== candidateDigest) {
        errors.push("candidate mutated during evaluator validation");
      }
    } catch (error) {
      errors.push(`candidate identity unavailable during evaluator validation: ${error?.message ?? String(error)}`);
    }
  };
  verifyCandidate();
  if (errors.length > 0) return { ok: false, errors };

  // Discrimination: setup only prepares a fresh copy. The actual check must
  // PASS on the valid fixture and FAIL (not ERROR) on every invalid fixture.
  for (const criterion of draft.criteria) {
    if ((criterion.type ?? "behavior") !== "behavior") continue;
    const controls = [
      { entry: criterion.controls.accept, kind: "accept", expected: "PASS" },
      ...criterion.controls.reject.map((entry) => ({ entry, kind: "reject", expected: "FAIL" })),
    ];
    for (const { entry, kind, expected } of controls) {
      const probe = await runControlProbe(criterion, entry.setup, deps);
      if (probe.error) {
        errors.push(`${criterion.id}: ${kind} control ${probe.error}`);
      } else if (probe.outcome.status !== expected) {
        errors.push(`${criterion.id}: ${kind} control check is ${probe.outcome.status}, wanted ${expected} (${entry.reason ?? entry.setup}; ${probe.outcome.reasons.join("; ")}); check cannot discriminate`);
      }
    }
  }
  verifyCandidate();
  if (errors.length > 0) return { ok: false, errors };

  // Wiring: the complete runner must reject a missing target. A check that
  // passes in an empty directory is fixture-only and proves nothing.
  fs.mkdirSync(deps.wiringDir, { recursive: true });
  for (const criterion of draft.criteria) {
    const outcome = await runCheck(criterion, deps.exec, deps.wiringDir, deps.defaultTimeoutMs);
    if (outcome.status === "PASS") {
      errors.push(`${criterion.id}: check passes against an empty target; it is not wired to the candidate`);
    }
  }
  verifyCandidate();
  if (errors.length > 0) return { ok: false, errors };

  // Execution: fixed inventory (every criterion is mandatory), fixed inputs.
  // Baseline: record all criterion outcomes on the current candidate.
  const outcomes = [];
  for (const criterion of draft.criteria) {
    outcomes.push(await runCheck(criterion, deps.exec, deps.cwd, deps.defaultTimeoutMs));
  }
  verifyCandidate();
  if (errors.length > 0) return { ok: false, errors };
  const baseline = { outcomes, allPass: allPass(outcomes), at: new Date().toISOString(), candidateDigest };

  // Sealing: freeze the exact validated bundle with its digest, environment,
  // and baseline candidate identity.
  const contract = JSON.parse(stableStringify(draft));
  const bundle = {
    version: 1,
    contract,
    digest: sha256Hex(stableStringify(contract)),
    env: deps.env,
    candidateDigest,
    sealedAt: new Date().toISOString(),
    baseline,
  };
  return { ok: true, errors: [], baseline, bundle };
}

// ---------------------------------------------------------------------------
// Budgets and decomposition policy
// ---------------------------------------------------------------------------

export function deadlineAtMs(createdAtMs, policy) {
  return createdAtMs + (policy.deadlineMinutes ?? DEFAULT_POLICY.deadlineMinutes) * 60 * 1000;
}

export function isExpired(root, nowMs) {
  return Number.isFinite(root.deadlineAt) && nowMs >= root.deadlineAt;
}

/** Shared-budget check before consuming work (attempt, child, seal). */
export function budgetsOk(root, nowMs) {
  if (isExpired(root, nowMs)) return { ok: false, reason: "shared deadline exceeded" };
  if ((root.consumedAttempts ?? 0) >= (root.attemptLimit ?? root.policy.maxTotalAttempts ?? DEFAULT_POLICY.maxTotalAttempts)) {
    return { ok: false, reason: `total attempt budget exhausted (${root.attemptLimit??root.policy.maxTotalAttempts})` };
  }
  return { ok: true };
}

/**
 * Deterministic child gates. Semantic fit ("will this help?") stays with the
 * model; being wrong surfaces as no parent progress.
 */
export function childGates({ root, parentState, parentResult, target, goal, siblings, nowMs, environmentIdentity }) {
  const errors = [];
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
  }
  const goalDigest = fingerprintGoal(goal);
  const repeat = (siblings ?? []).find(
    (s) => s.status === NodeState.BLOCKED && s.target === target && s.goalDigest === goalDigest && s.candidateDigest === parentState?.lastCandidateDigest &&
      (environmentIdentity === undefined || s.environmentIdentity === environmentIdentity),
  );
  if (repeat) errors.push(`identical child already blocked on unchanged evidence (${repeat.id}); try a different path`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Tool-call guards (the extension maps these onto Pi tool events)
// ---------------------------------------------------------------------------

export function resolveWithin(cwd, filePath) {
  return path.resolve(cwd, filePath);
}

export function isPathUnder(filePath, dir) {
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
  let mode = { on: false, rootId: undefined, pendingGoal: undefined };
  for (const entry of branch ?? []) {
    if (entry?.type === "custom" && entry?.customType === MODE_ENTRY_TYPE) {
      mode = { on: Boolean(entry?.data?.on), rootId: entry?.data?.rootId,
        pendingGoal: typeof entry?.data?.pendingGoal === "string" ? entry.data.pendingGoal : undefined };
    }
  }
  return mode;
}

// ---------------------------------------------------------------------------
// Supervisor flows. IO injects execution, time, and runtime fingerprinting.
// Defaults use execCommand, Date.now, and fresh host runtime fingerprints.
// ---------------------------------------------------------------------------

/** One state-changing operation per workspace, including across Pi sessions. */
function workspaceOperation(io,kind,work) {
  let fd,token;
  const file=storePaths(io.cwd).operation;
  try {
    ensureStoreDirs(io.cwd);
    const owner=readJson(file);
    if(io.operationToken && owner?.token===io.operationToken && owner.pid===process.pid)return work(io);
    ensureRunning(io.signal);
    const activeRootId=loadIndex(io.cwd).activeRootId;
    if(Object.hasOwn(io,"expectedRootId") && activeRootId!==(io.expectedRootId??null) && !(kind==="baseline" && !activeRootId) && !(kind==="recover" && !activeRootId && io.expectedRootId && loadRoot(io,io.expectedRootId)?.closingStack))return {ok:false,code:"ROOT_MISMATCH",errors:["session root differs from active workspace root; resume the current root explicitly"]};
    try {fd=fs.openSync(file,"wx");}
    catch(e) {
      if(e.code!=="EEXIST")throw e;
      if(!Number.isInteger(owner?.pid))return {ok:false,code:"OPERATION_BUSY",errors:["workspace operation lock has no trustworthy owner; restore supervisor storage before retrying"]};
      try {process.kill(owner.pid,0);}
      catch(e) {
        if(e.code!=="ESRCH" && e.code!=="EPERM")throw e;
        if(e.code==="ESRCH"){fs.rmSync(file);fd=fs.openSync(file,"wx");}
      }
      if(fd===undefined)return {ok:false,code:"OPERATION_BUSY",errors:[`workspace operation ${owner.kind} is already in progress`]};
    }
    token=randomUUID();
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,kind,at:io.nowMs()}));
    const locked={...io,operationToken:token};
    const finish=()=>{fs.closeSync(fd);fd=undefined;fs.rmSync(file,{force:true});};
    const failed=e=>{
      const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
      const reason=`${kind} failed (${e.code??"IO_ERROR"}): ${e.message}`;
      return root && root.status!==NodeState.PASS ? pauseRoot(locked,root,{code:e.code??"IO_ERROR",reason,nodeId:leafOf(root),operation:kind}) : {ok:false,errors:[reason]};
    };
    try {
      const result=work(locked);
      if(result?.then)return result.catch(failed).finally(finish);
      finish();return result;
    } catch(e) {try{return failed(e);}finally{if(fd!==undefined)finish();}}
  } catch(e) {
    if(fd!==undefined){fs.closeSync(fd);if(token)fs.rmSync(file,{force:true});}
    return {ok:false,code:e.code??"IO_ERROR",errors:[`${kind} boundary failed (${e.code??"IO_ERROR"}): ${e.message}`]};
  }
}

function operationIo(io, root) {
  const operation=operationSignal(io.signal,{deadlineAt:root.deadlineAt,nowMs:io.nowMs});
  return {io:{...io,signal:operation.signal,deadlineAt:root.deadlineAt},dispose:operation.dispose};
}

function ensureBudget(io,root) {ensureRunning(io.signal,root.deadlineAt,io.nowMs);}

/** A pause is not terminal and never drops approval, candidates, counters, or the stack. */
function pauseRoot(io,root,{code,reason,nodeId=leafOf(root),operation="evaluate",args,details}) {
  if(root.closingStack)root.stack=[...root.closingStack];
  root.status=NodeState.PAUSED;
  root.pause={code,reason,nodeId,operation,phase:loadNodeState(io,nodeId)?.phase??"EXECUTION",at:io.nowMs(),
    ...(args?{args}:{}),...(details?{details}:{})};
  root.pauseHistory??=[];root.pauseHistory.push(root.pause);
  saveRoot(io,root);
  const leaf=loadNodeState(io,leafOf(root));
  if(leaf?.status===NodeState.ACTIVE){
    // A sealed pause freezes its useful work, never an old preparation candidate.
    try{captureBaseline(io,leaf.id);}catch(e){root.pause.baselineError=`${e.code??"IO_ERROR"}: ${e.message}`;saveRoot(io,root);}
  }
  return {ok:false,paused:true,root:root.id,status:NodeState.PAUSED,pause:root.pause,errors:[reason],
    events:[`${root.id} PAUSED (${code}): ${reason}`],next:"restore the prerequisite, then /exitcode resume"};
}

export function pauseNode(io,{reason,code="NO_PROGRESS",operation="evaluate"}) {
  return workspaceOperation(io,"pause",io=>{
    const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
    return root?pauseRoot(io,root,{reason,code,operation}):{ok:false,errors:["no root to pause"]};
  });
}

/** Only the user-facing adapter may grant more execution time or attempts. */
export function resumeRoot(io,{deadlineMinutes,maxTotalAttempts,evaluatorAttempts,rootId}={}) {
  return workspaceOperation(io,"resume",io=>{
    const index=loadIndex(io.cwd),id=rootId??index.activeRootId;
    const root=id?loadRoot(io,id):null;
    if(!root)return {ok:false,errors:["no active or paused root to resume"]};
    if(index.activeRootId && index.activeRootId!==root.id)return {ok:false,errors:["another root is active"]};
    recoverClosing(io,index,root);
    if(![NodeState.ACTIVE,NodeState.PAUSED,NodeState.BLOCKED].includes(root.status))return {ok:false,errors:[`root ${root.id} is ${root.status}`]};
    for(const [key,value] of Object.entries({deadlineMinutes,maxTotalAttempts,evaluatorAttempts}))if(value!==undefined &&
      (!Number.isFinite(value)||value<=0||key!=="deadlineMinutes"&&!Number.isSafeInteger(value)))return {ok:false,errors:[`${key} grant must be finite and positive`]};
    const node=loadNodeState(io,root.id),draft=readJson(draftFile(io.cwd,root.id))?.draft;
    if(!node || !draft)return {ok:false,errors:["root draft or node is missing; restore supervisor evidence before resuming"]};
    const sealed=fs.readdirSync(storePaths(io.cwd).contractsDir).some(name=>name===`${root.id}.sealed.json` || name.startsWith(root.id+'.') && name.endsWith('.sealed.json'));
    const migrate=root.clockVersion!==2 && !sealed && (root.consumedAttempts??0)===0 &&
      (node.attempts??0)===0 && (node.sealAttempts??0)===0 && !node.lastResult && !node.lastCandidateDigest && (node.children?.length??0)===0 &&
      (root.stack??[]).every(id=>id===root.id) && (node.status===NodeState.DRAFT || root.status===NodeState.BLOCKED && ["EXTERNAL_BLOCKED","EVALUATOR_UNBUILDABLE","BUDGET_EXHAUSTED"].includes(root.outcome?.code));
    if(root.status===NodeState.BLOCKED && !migrate)return {ok:false,errors:["legacy terminal execution cannot be resumed safely; preserve its contract and evidence"]};
    if((deadlineMinutes!==undefined || maxTotalAttempts!==undefined) && (!sealed || !Number.isFinite(root.deadlineAt)))
      return {ok:false,errors:["execution grants require a sealed execution clock"]};
    const deadline=deadlineMinutes!==undefined?Math.max(root.deadlineAt,io.nowMs())+deadlineMinutes*60000:root.deadlineAt;
    if(deadlineMinutes!==undefined && !Number.isFinite(new Date(deadline).getTime()))return {ok:false,errors:["execution grant exceeds supported deadline range"]};
    const attemptLimit=(root.attemptLimit??root.policy.maxTotalAttempts)+(maxTotalAttempts??0);
    if(!Number.isSafeInteger(attemptLimit))return {ok:false,errors:["attempt grant exceeds supported accounting range"]};
    if(!migrate && isExpired({deadlineAt:deadline},io.nowMs()))return {ok:false,errors:["execution budget exhausted; /exitcode resume minutes=N records an explicit user grant"]};
    if(root.pause?.code==="BUDGET_EXHAUSTED" && root.consumedAttempts>=attemptLimit)return {ok:false,errors:["attempt budget exhausted; /exitcode resume attempts=N records an explicit user grant"]};
    const leaf=loadNodeState(io,leafOf(root)??root.id);
    if(evaluatorAttempts!==undefined && (!leaf || leaf.status!==NodeState.DRAFT && !migrate))return {ok:false,errors:["evaluator grants require an unsealed leaf"]};
    const evaluatorLimit=(leaf?.evaluatorAttemptLimit??root.policy.evaluatorAttempts??DEFAULT_POLICY.evaluatorAttempts)+(evaluatorAttempts??0);
    if(!Number.isSafeInteger(evaluatorLimit))return {ok:false,errors:["evaluator grant exceeds supported accounting range"]};
    if(root.pause?.code==="EVALUATOR_UNBUILDABLE" && (leaf?.evaluatorMetrics?.e0Attempts??0)>=evaluatorLimit)return {ok:false,errors:["evaluator construction budget exhausted; /exitcode resume evaluators=N records an explicit user grant"]};
    if(migrate) {
      root.legacyTiming={deadlineAt:root.deadlineAt,policyLocked:root.policyLocked,approval:root.approval??null,outcome:root.outcome??null,migratedAt:io.nowMs()};
      delete root.outcome;delete root.approval;delete root.validatedBundleDigest;
      root.clockVersion=2;root.deadlineAt=null;root.executionStartedAt=null;root.policyLocked=false;root.stack=[root.id];
      node.status=NodeState.DRAFT;node.phase="EVALUATOR_PREPARATION";delete node.prepared;delete node.preparing;
      saveNodeState(io,node);root.reviewDigest=rootReviewDigest(root,draft);
    }
    if(deadlineMinutes!==undefined || maxTotalAttempts!==undefined || evaluatorAttempts!==undefined) {
      root.executionGrants??=[];
      root.executionGrants.push({approvedBy:"user",at:io.nowMs(),deadlineMinutes,maxTotalAttempts,evaluatorAttempts,nodeId:leaf?.id??root.id,
        previousDeadline:root.deadlineAt,previousAttemptLimit:root.attemptLimit??root.policy.maxTotalAttempts,previousEvaluatorLimit:evaluatorLimit-(evaluatorAttempts??0)});
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
      if(bundle.assets){
        try{verifyEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);}
        catch(e){if(e.code!=='EVALUATOR_DRIFT')throw e;restored.push({nodeId:id,...restoreEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets)});}
      }
    }
    ensureBudget(io,root);
    if(restored.length){root.acceptanceRestorations??=[];root.acceptanceRestorations.push({at:io.nowMs(),restored});}
    const pending=root.pause;
    delete root.pause;root.status=NodeState.ACTIVE;
    for(const id of root.stack)clearInterruptedPreparation(io,id);
    index.activeRootId=root.id;saveRoot(io,root);saveIndex(io.cwd,index);
    return {ok:true,id:root.id,migrated:migrate,acceptanceRestored:restored,warnings:baseline.ok?[]:[baseline.message],operation:pending?.operation??"continue",nodeId:pending?.nodeId??leafOf(root),args:pending?.args,
      next:nextAction(root,loadNodeState(io,leafOf(root)),draft,io.nowMs())};
  });
}

export function makeIo(cwd, overrides = {}) {
  return { cwd, exec: execCommand, nowMs: () => Date.now(), fingerprintRuntime, ...overrides };
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
  if(node?.sealedBundleDigest && node.sealedBundleDigest!==sha256Hex(stableStringify(bundle)) || bundle.version===2 && !node?.sealedBundleDigest)return {ok:false,reason:"sealed evaluator differs from its supervisor identity"};
  const contractDigest = sha256Hex(stableStringify(bundle.contract));
  if (contractDigest !== bundle.digest) return { ok: false, reason: "sealed bundle digest mismatch (tampering or disk corruption)" };
  if(bundle.integrityDigest && bundle.integrityDigest!==sha256Hex(stableStringify({contractDigest:bundle.digest,assets:bundle.assets,env:bundle.env,candidateDigest:bundle.candidateDigest})))
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
  if(checkpoint.manifestDigest && checkpoint.manifestDigest!==sha256Hex(stableStringify(manifest)))throw operationError("CHECKPOINT_INVALID","checkpoint manifest differs from its supervisor identity");
  const source=checkpointPayload(checkpoint.dir,manifest,io);
  const identity=digest(manifest.files.map(f=>({rel:f.path,sha:f.sha,size:f.link===undefined?f.bytes:undefined,mode:f.mode,link:f.link})));
  if(identity!==checkpoint.candidateDigest || manifest.payload && digestTree(source)!==checkpoint.candidateDigest)
    throw operationError("CHECKPOINT_INVALID","checkpoint cannot reproduce its recorded candidate identity");
  const restored = restoreTree(io.cwd, checkpoint.dir, manifest,io);
  if((manifest.version===2?digestTree(io.cwd):legacyCandidateIdentity(io.cwd))!==checkpoint.candidateDigest)throw operationError("RESTORATION_FAILED","restored checkpoint identity differs");
  // A supervisor restore moves the candidate; any unsealed phase restarts from it.
  releaseBaseline(io.cwd);
  return { ok: true, checkpoint, ...restored };
}

/** Rolling checkpoints (seal/eval) are verified-clean trees; pre-child ones are not. */
const ROLLING_CP = (c) => !c.note?.startsWith("pre-child:");

/** Fresh-evaluate every ACTIVE stack node with a valid bundle; returns id -> result. */
async function refreshStack(io, root, candidateDigest, timeoutMs) {
  const fresh = {};
  for (const id of root.stack) {
    const state = loadNodeState(io, id);
    const bundle = loadBundle(io, id);
    if (!state || state.status !== NodeState.ACTIVE)continue;
    const verified=verifyBundle(bundle,state);if(!verified.ok)throw operationError("EVALUATOR_DRIFT",verified.reason);
    ensureBudget(io,root);
    const result = await freshEvaluate(io, bundle, candidateDigest, root.clockVersion===2?root.deadlineAt-io.nowMs():timeoutMs);
    requireIdentity(io,root,result);
    state.lastResult = result;
    state.lastCandidateDigest = candidateDigest;
    state.lastEnvironmentIdentity=result.environmentIdentity;state.lastAccountingDigest=root.clockVersion===2?candidateDigest:legacyCandidateIdentity(io.cwd);delete state.reservedCandidateDigest;delete state.reservedAccountingDigest;
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
  const fresh = await refreshStack(io, root, digest, defaultTimeoutMs(root));
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
    if (["evaluatorAttempts", "maxTotalAttempts", "maxDepth", "localRepairs"].includes(key) && !Number.isInteger(value)) return {ok:false,error:`policy.${key} must be an integer`};
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

/** Approval binds duration, not an already-running countdown, for new roots. */
function rootReviewDigest(root, draft) {
  return sha256Hex(stableStringify({ draft, policy: root.policy, createdAt: root.createdAt,
    ...(root.clockVersion === 2 ? {clockVersion:2,preSealDeadline:root.executionStartedAt==null?root.deadlineAt:null} : {deadlineAt:root.deadlineAt}),
    validatedBundleDigest: root.validatedBundleDigest }));
}

function policyStatus(root, node, nowMs) {
  return {
    policy: { ...root.policy },
    policyEditable: policyEditable(root, node),
    createdAt: root.createdAt,
    executionStartedAt: root.executionStartedAt ?? null,
    deadlineAt: Number.isFinite(root.deadlineAt) ? new Date(root.deadlineAt).toISOString() : null,
    remainingMs: Number.isFinite(root.deadlineAt) ? Math.max(0, root.deadlineAt - nowMs) : root.policy.deadlineMinutes * 60000,
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
  return workspaceOperation(io,"draft",locked => onBaseline(locked,() => {const result=createDraft(locked,args);if(result?.paused){const root=loadRoot(locked,result.root);root.pause.args=args;root.pause.operation="draft";saveRoot(locked,root);}return result;}));
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
    const gates = childGates({ root, parentState, parentResult, target: args.target, goal, siblings, nowMs, environmentIdentity:digest(evaluatorEnvironment(io.cwd,io)) });
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
      version: 1,
      id,
      goal: goal.trim(),
      originalRequest: nonEmptyString(originalRequest) ? originalRequest.trim() : parentBundle.contract.originalRequest,
      parent: { id: args.parentId, targets: [args.target] },
      criteria: withIds,
    ...(args.intentAtoms !== undefined ? {intentAtoms: args.intentAtoms} : {}),
    ...(args.ambiguities !== undefined ? {ambiguities: args.ambiguities} : {}),
    ...(args.specificationPaths !== undefined ? {specificationPaths:args.specificationPaths} : {}),
    mutableDependencies:parentBundle.contract.mutableDependencies===true,
    };
    const validation = validateStructure(draft, {
      parent: parentBundle,
      parentDepth: depthOf(args.parentId),
      parentLastResult: parentResult,
      policy: root.policy,
    });
    if (!validation.ok) return { ok: false, errors: validation.errors };

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
    if(!snap.ok)return pauseRoot(io,root,{code:"CHECKPOINT_UNAVAILABLE",reason:snap.warning,nodeId:parentState.id,operation:"draft",args});
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
  if (!Number.isFinite(new Date(deadlineAtMs(nowMs, merged.policy)).getTime())) {
    return { ok: false, errors: ["policy.deadlineMinutes exceeds the supported deadline range"] };
  }
  const id = `G${index.rootCounter + 1}`;
  const draft = {
    version: 1,
    id,
    goal: goal.trim(),
    originalRequest: nonEmptyString(originalRequest) ? originalRequest.trim() : goal.trim(),
    parent: null,
    criteria: withIds,
    ...(args.intentAtoms !== undefined ? {intentAtoms: args.intentAtoms} : {}),
    ...(args.ambiguities !== undefined ? {ambiguities: args.ambiguities} : {}),
    ...(args.specificationPaths !== undefined ? {specificationPaths:args.specificationPaths} : {}),
    ...(args.mutableDependencies !== undefined ? {mutableDependencies:args.mutableDependencies} : {}),
    ...(args.assumptions !== undefined ? { assumptions: args.assumptions } : {}),
    ...(args.exclusions !== undefined ? { exclusions: args.exclusions } : {}),
    ...(args.verification !== undefined ? { verification: args.verification } : {}),
  };
  const validation = validateStructure(draft, { policy: merged.policy });
  if (!validation.ok) return { ok: false, errors: validation.errors };

  index.rootCounter += 1;
  index.activeRootId = id;
  index.roots.push(id);
  saveIndex(io.cwd, index);
  const createdAt = nowMs;
  const root = {
    version: 1,
    id,
    policy: merged.policy,
    policyLocked: false,
    createdAt,
    clockVersion: 2,
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
  if (!root || node.rootId !== root.id || root.status !== NodeState.ACTIVE) {
    return { ok: false, errors: [`${node.id} does not belong to the active root`] };
  }
  const withIds = normalizeEvaluator({criteria:assignCriterionIds(args.criteria)}).draft.criteria;
  const previous = readJson(draftFile(io.cwd, node.id))?.draft;
  const warnings = [];
  const nowMs = io.nowMs();
  const editable = policyEditable(root, node);
  let effectivePolicy = root.policy;
  let effectiveDeadline = root.deadlineAt;
  if (args.policy !== undefined) {
    if (node.parentId) return { ok: false, errors: ["children inherit the root policy and cannot override it"] };
    const merged = mergePolicy(args.policy, root.policy);
    if (!merged.ok) return { ok: false, errors: [merged.error] };
    if (stableStringify(merged.policy) !== stableStringify(root.policy)) {
      if (!editable) {
        return { ok: false, errors: ["root policy is locked after approval; sealed and legacy roots keep their fixed policies"],
          ...policyStatus(root, node, nowMs),
          next: "keep the effective policy, or the user must cancel with /exitcode exit and start a fresh root with fresh review" };
      }
      effectivePolicy = merged.policy;
      effectiveDeadline = root.clockVersion === 2 ? null : deadlineAtMs(root.createdAt, effectivePolicy);
      if (!Number.isFinite(new Date(deadlineAtMs(nowMs,effectivePolicy)).getTime())) {
        return { ok: false, errors: ["policy.deadlineMinutes exceeds the supported deadline range"] };
      }
    }
  }
  if (isExpired({ deadlineAt: effectiveDeadline }, nowMs)) {
    const result = expiredDraftResult(root, node, previous, nowMs);
    if (effectiveDeadline !== root.deadlineAt) {
      result.errors = ["proposed policy deadline has already elapsed from original root creation; revision was not stored"];
    }
    return result;
  }
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
      version: 1,
      id: node.id,
      goal: args.goal.trim(),
      originalRequest: nonEmptyString(args.originalRequest)
        ? args.originalRequest.trim()
        : (previous?.originalRequest ?? parentBundle?.contract.originalRequest ?? args.goal.trim()),
      parent: { id: node.parentId, targets: [node.target] },
      criteria: withIds,
    ...(args.intentAtoms !== undefined ? {intentAtoms: args.intentAtoms} : {}),
    ...(args.ambiguities !== undefined ? {ambiguities: args.ambiguities} : {}),
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
      version: 1,
      id: node.id,
      goal: args.goal.trim(),
      originalRequest: previous?.originalRequest ?? (nonEmptyString(args.originalRequest) ? args.originalRequest.trim() : args.goal.trim()),
      parent: null,
      criteria: withIds,
    ...(args.intentAtoms !== undefined ? {intentAtoms: args.intentAtoms} : {}),
    ...(args.ambiguities !== undefined ? {ambiguities: args.ambiguities} : {}),
    ...(args.specificationPaths !== undefined ? {specificationPaths:args.specificationPaths} : {}),
    ...(args.mutableDependencies !== undefined ? {mutableDependencies:args.mutableDependencies} : {}),
    };
    for (const key of ["assumptions", "exclusions", "verification", "intentAtoms", "ambiguities", "specificationPaths", "mutableDependencies"]) {
      const value = args[key] !== undefined ? args[key] : previous?.[key];
      if (value !== undefined) draft[key] = value;
    }
    validation = validateStructure(draft, { policy: effectivePolicy });
  }
  if (!validation.ok) return { ok: false, errors: validation.errors };
  node.phase = "EVALUATOR_PREPARATION";
  delete node.prepared;
  node.evaluatorMetrics ??= emptyMetrics();
  node.evaluatorMetrics.evaluatorProposals++;
  saveNodeState(io,node);
  writeJsonAtomic(draftFile(io.cwd, node.id), { draft });
  if (!node.parentId) {
    root.policy = effectivePolicy;
    root.deadlineAt = effectiveDeadline;
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

/** Human acceptance layer; executable checks stay in the same draft. */
export function rootReviewText(draft, root, nowMs = Date.now()) {
  if (isExpired(root, nowMs)) return "Validated plan unavailable: shared deadline expired.";
  const lines = ["Validated plan", "", "Goal", draft.goal, "", "Success means"];
  for (const criterion of draft.criteria) lines.push(`${criterion.id}: ${criterion.requirement}`);
  for (const key of ["assumptions", "exclusions"]) {
    lines.push("", key === "assumptions" ? "Assumptions" : "Exclusions");
    lines.push(...(draft[key]?.length ? draft[key].map(x=>`- ${x}`) : ["- None stated."]));
  }
  lines.push("", "Verification", draft.verification ?? "Validated positive, negative, empty-target, repeatability and baseline checks. Finite fixtures do not prove semantic equivalence.",
    "", "Approve this plan, or tell me what to change. /exitcode status shows policy and evaluator evidence. /exitcode exit cancels.");
  return lines.join("\n");
}

function intentDigestOf(draft) {
  return sha256Hex(stableStringify({goal:draft.goal,originalRequest:draft.originalRequest,criteria:draft.criteria.map(c=>({id:c.id,requirement:c.requirement,type:c.type??'behavior'})),assumptions:draft.assumptions,exclusions:draft.exclusions,intentAtoms:draft.intentAtoms,ambiguities:draft.ambiguities}));
}
function evaluatorDigestOf(draft) { return sha256Hex(stableStringify(draft.criteria.map(c=>({id:c.id,check:c.check,controls:c.controls})))); }
function preparationMatches(io,node) {
  try {
    const draft=readJson(draftFile(io.cwd,node.id))?.draft,p=node.prepared,root=loadRoot(io,node.rootId);
    if(!p || !draft || (node.parentId?node.preparedDigest:root.validatedBundleDigest)!==sha256Hex(stableStringify(p)) ||
      p.draftDigest!==sha256Hex(stableStringify(draft)) || p.candidateDigest!==digestTree(io.cwd) || stableStringify(p.environment)!==stableStringify(evaluatorEnvironment(io.cwd,io)))return false;
    if(!p.assets)return false;
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
  if(node && leafOf(root)!==node.id)return {ok:false,errors:["prepare the active leaf before its ancestors"]};
  if(!root||root.status!==NodeState.ACTIVE||!node||node.rootId!==root.id||node.status!==NodeState.DRAFT)return {ok:false,errors:["no editable DRAFT evaluator; resume any infrastructure pause first"]};
  const stored=readJson(draftFile(io.cwd,node.id));if(!stored?.draft)return {ok:false,errors:["missing draft"]};
  if(isExpired(root,io.nowMs()))return pauseRoot(io,root,{code:"BUDGET_EXHAUSTED",reason:"shared execution deadline exceeded",operation:"prepare",nodeId:node.id});
  if(node.preparing)return {ok:false,errors:["evaluator preparation already in progress; resume interrupted work first"]};
  node.evaluatorMetrics??=emptyMetrics();
  if(node.evaluatorMetrics.e0Attempts >= (node.evaluatorAttemptLimit??root.policy.evaluatorAttempts??DEFAULT_POLICY.evaluatorAttempts))return pauseRoot(io,root,{reason:"evaluator preparation budget exhausted; diagnose or revise the proposal before retrying",code:"EVALUATOR_UNBUILDABLE",nodeId:node.id,operation:"prepare"});
  const {draft,repairs}=normalizeEvaluator(stored.draft);
  if(!draft.intentAtoms && (node.parentId || draft.criteria.every(c=>c.check.command))) {
    draft.intentAtoms=draft.criteria.map(c=>({id:`legacy-${c.id}`,outcome:c.requirement,criteria:[c.id]}));
    repairs.push({repair:"Migrated declared coverage; independent semantic review remains required"});
  }
  writeJsonAtomic(draftFile(io.cwd,node.id),{draft});
  if(!node.parentId){delete root.approval;delete root.validatedBundleDigest;root.reviewDigest=rootReviewDigest(root,draft);}saveRoot(io,root);
  const draftDigest=sha256Hex(stableStringify(draft)),reviewDigest=root.reviewDigest;
  node.phase="EVALUATOR_PREPARATION";node.preparing=true;node.evaluatorMetrics.e0Attempts++;node.preparationReservation={at:io.nowMs(),attempt:node.evaluatorMetrics.e0Attempts};delete node.prepared;saveNodeState(io,node);
  const owned=operationIo(io,root),operation=owned.io;
  let environment,candidateDigest,assets,result;
  const directory=path.join(storePaths(io.cwd).assetsDir,`${node.id}.prepared`);
  try {
    ensureBudget(operation,root);
    environment=evaluatorEnvironment(io.cwd,operation);candidateDigest=digestTree(io.cwd);
    const parentBundle=node.parentId?loadBundle(io,node.parentId):null;
    const validation=validateStructure(draft,{policy:root.policy,parent:parentBundle,parentDepth:node.parentId?depthOf(node.parentId):-1,parentLastResult:node.parentId?loadNodeState(io,node.parentId)?.lastResult:null});
    if(!validation.ok)result={ok:false,errors:validation.errors,diagnostics:validation.errors.map(e=>diagnostic("INVALID_STRUCTURE","lint",null,e,"Correct evaluator structure")),stages:[],metrics:emptyMetrics()};
    else {
      fs.rmSync(directory,{recursive:true,force:true});
      assets=captureEvaluatorAssets(io.cwd,draft,directory);
      result=await prepareGate({...draft,...(parentBundle?{parentRequirement:parentBundle.contract.criteria.find(c=>c.id===node.target)?.requirement}:{})},
        {cwd:io.cwd,exec:io.exec,runCheck:(c,exec,cwd,timeout,opts)=>runCheck(c,exec,cwd,timeout,{...opts,deadlineAt:root.deadlineAt,nowMs:io.nowMs}),
          defaultTimeoutMs:defaultTimeoutMs(root),environment,maxBytes:SNAPSHOT_MAX_BYTES,candidateDigest,review:io.review,signal:operation.signal,
          reviewTimeoutMs:io.reviewTimeoutMs,assets,assetsDirectory:directory,onProgress:io.onProgress,deadlineAt:root.deadlineAt,nowMs:io.nowMs});
      ensureBudget(operation,root);
      if(stableStringify(environment)!==stableStringify(evaluatorEnvironment(io.cwd,operation)))throw operationError("ENVIRONMENT_CHANGED","Environment changed during preparation");
      verifyEvaluatorAssets(io.cwd,directory,assets);
      if(digestTree(io.cwd)!==candidateDigest)throw operationError("CANDIDATE_MUTATED","Candidate changed during preparation");
    }
  } catch(e) {
    result??={ok:false,errors:[],diagnostics:[],stages:[],metrics:emptyMetrics()};result.ok=false;
    result.errors.push(e.message);result.diagnostics.push(diagnostic(e.code??"PREPARATION_FAILED","preparation",null,e.message,"Restore the authorized environment and resume","supervisor"));
  } finally {
    owned.dispose();
    const current=loadNodeState(io,node.id);if(current){delete current.preparing;saveNodeState(io,current);}
  }
  const after=enforceBaseline(io);
  if(!after.ok){result.ok=false;result.warnings=[after.message];if(!result.diagnostics.some(d=>d.code==="CANDIDATE_MUTATED")){result.diagnostics.push(diagnostic("CANDIDATE_MUTATED","baseline",null,"Candidate changed during preparation","Reprepare stable candidate"));result.errors.push("Candidate changed during preparation");}}
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
    current.prepared={draftDigest,candidateDigest,environment,assets,assetsDirectory:directory,intentDigest:intentDigestOf(draft),evaluatorDigest:evaluatorDigestOf(draft),stages:result.stages,baseline:result.baseline,capabilities:result.capabilities};
    current.preparedDigest=sha256Hex(stableStringify(current.prepared));
    if(!node.parentId){currentRoot.validatedBundleDigest=current.preparedDigest;currentRoot.reviewDigest=rootReviewDigest(currentRoot,draft);saveRoot(io,currentRoot);current.evaluatorMetrics.reviewTurns++;result.review=rootReviewText(draft,currentRoot,io.nowMs());}
  } else {current.phase=result.questions?.length?"CLARIFICATION":"EVALUATOR_PREPARATION";fs.rmSync(directory,{recursive:true,force:true});}
  saveNodeState(io,current);
  if(infrastructure) {
    const d=result.diagnostics.find(d=>d.repairability==="supervisor")??result.diagnostics[0];
    return {...result,...pauseRoot(io,currentRoot,{code:d.code,reason:result.errors.join("; "),nodeId:node.id,operation:"prepare"}),diagnostics:result.diagnostics,metrics:result.metrics};
  }
  return {...result,id:node.id,phase:current.phase,repairs,next:nextAction(currentRoot,current,draft,io.nowMs())};
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
  if(!snap.ok)return pauseRoot(io,root,{code:"CHECKPOINT_UNAVAILABLE",reason:snap.warning,nodeId,operation:"seal"});
  fs.rmSync(directory,{recursive:true,force:true});
  fs.cpSync(prepared.assetsDirectory,directory,{recursive:true,verbatimSymlinks:true});
  verifyEvaluatorAssets(io.cwd,directory,prepared.assets);
  ensureBudget(io,root);
  const bundle={version:2,contract:validatedDraft,digest:sha256Hex(stableStringify(validatedDraft)),env:prepared.environment,candidateDigest:prepared.candidateDigest,
    sealedAt:new Date(io.nowMs()).toISOString(),baseline:prepared.baseline,intentDigest:prepared.intentDigest,evaluatorDigest:prepared.evaluatorDigest,
    validation:prepared.stages,assets:prepared.assets,assetsDirectory:directory};
  bundle.integrityDigest=sha256Hex(stableStringify({contractDigest:bundle.digest,assets:bundle.assets,env:bundle.env,candidateDigest:bundle.candidateDigest}));
  ensureBudget(io,root);
  root.policyLocked=true;
  writeJsonAtomic(sealedFile(io.cwd,nodeId),bundle);
  node.sealedBundleDigest=sha256Hex(stableStringify(bundle));
  node.status=NodeState.ACTIVE;node.phase="EXECUTION";node.sealAttempts++;
  node.lastResult=resultFromBaseline(bundle);node.lastCandidateDigest=bundle.candidateDigest;
  node.lastEnvironmentIdentity=digest(bundle.env);
  if(digestTree(io.cwd)!==bundle.candidateDigest || stableStringify(evaluatorEnvironment(io.cwd,io))!==stableStringify(bundle.env))throw operationError("CANDIDATE_MUTATED","candidate or environment changed while sealing");
  ensureBudget(io,root);
  if(!node.parentId && root.clockVersion===2 && root.executionStartedAt===null) {
    root.executionStartedAt=io.nowMs();root.deadlineAt=deadlineAtMs(root.executionStartedAt,root.policy);
  }
  // Commit the clock before unlocking the leaf. An interrupted seal cannot gain time on retry.
  saveRoot(io,root);saveNodeState(io,node);ensureBudget(io,root);releasePreparation(io.cwd);releaseBaseline(io.cwd);
  return {ok:true,sealed:nodeId,baseline:formatVector(bundle.baseline.outcomes),warnings:[],next:nextAction(root,node,null,io.nowMs())};
}

// --- evaluate ------------------------------------------------------------

async function freshEvaluate(io, bundle, candidateDigest, timeoutMs) {
  const outcomes=[],metrics=emptyMetrics();
  let base;
  ensureRunning(io.signal,io.deadlineAt,io.nowMs);
  const environment=evaluatorEnvironment(io.cwd,io);
  if(!compatibleEnvironment(bundle.env,environment,bundle.contract.mutableDependencies===true,bundle.assets))
    throw operationError("ENVIRONMENT_CHANGED","sealed evaluator environment changed; restore its trusted runtime or frozen dependencies");
  if(!bundle.assets) {
    // Legacy contracts remain byte-for-byte intact, but cannot acquire missing seal-time evidence from mutable current tests.
    const conventional=inventory(io.cwd).some(f=>/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/.test(f.rel));
    if(conventional || bundle.contract.criteria.some(c=>c.check.assets?.length || c.check.command || !["file_exists","file_contains","file_not_contains","json_value"].includes(c.check.recipe?.kind)))
      throw operationError("LEGACY_EVIDENCE_MISSING","legacy sealed evaluator has no trustworthy frozen acceptance assets; a superseding approved contract is required");
  } else verifyEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);
  try {
    base=fixtureDirectory(io.cwd,"exitcode-fresh-base-");
    metrics.fixtureBytes+=copyCandidate(io.cwd,base,SNAPSHOT_MAX_BYTES,io.signal,io);metrics.fixtureCopies++;
    if(digestTree(base,io)!==candidateDigest || digestTree(io.cwd,io)!==candidateDigest)throw operationError("CANDIDATE_MUTATED","candidate changed while taking evaluation snapshot");
    for(const criterion of bundle.contract.criteria) {
      ensureRunning(io.signal,io.deadlineAt,io.nowMs);
      const fixture=fixtureDirectory(io.cwd,"exitcode-fresh-");
      try {
        metrics.fixtureBytes+=copyCandidate(base,fixture,SNAPSHOT_MAX_BYTES,io.signal,io);metrics.fixtureCopies++;
        if(bundle.assets)installEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets);
        metrics.probeExecutions++;
        outcomes.push(await runCheck(criterion,io.exec,fixture,timeoutMs,
          {signal:io.signal,deadlineAt:io.deadlineAt,nowMs:io.nowMs,readOnlyPaths:bundle.assets?.readOnlyPaths,onExecution:()=>metrics.shellExecutions++}));
        ensureRunning(io.signal,io.deadlineAt,io.nowMs);
        if(bundle.assets)verifyEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets);
      } finally {fs.rmSync(fixture,{recursive:true,force:true});}
    }
    if(digestTree(io.cwd,io)!==candidateDigest)throw operationError("CANDIDATE_MUTATED","candidate changed during evaluation; checked evidence is stale");
    if(stableStringify(evaluatorEnvironment(io.cwd,io))!==stableStringify(environment))throw operationError("ENVIRONMENT_CHANGED","environment changed during evaluation");
    if(bundle.assets)verifyEvaluatorAssets(io.cwd,bundle.assetsDirectory,bundle.assets);
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
  if(result.nodeId){const bundle=loadBundle(io,result.nodeId),verified=verifyBundle(bundle,loadNodeState(io,result.nodeId));if(!verified.ok || bundle.digest!==result.bundleDigest)throw operationError("EVALUATOR_DRIFT",verified.reason??"evaluated bundle identity changed");}
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
    try {return await evaluateActive(owned.io,nodeId);}
    catch(e) {
      const current=loadRoot(io,root.id);
      return pauseRoot(io,current,{code:e.code??"IO_ERROR",reason:e.message,nodeId:nodeId??leafOf(current),operation:"evaluate"});
    } finally {owned.dispose();}
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
  if (!verified.ok) throw operationError("EVALUATOR_DRIFT",verified.reason);

  ensureBudget(io,root);
  const candidateDigest = digestTree(io.cwd);
  const accountingDigest=root.clockVersion===2?candidateDigest:legacyCandidateIdentity(io.cwd);
  const reservation=root.candidateReservation?.nodeId===node.id?root.candidateReservation:null;
  if(reservation)node.attempts=Math.max(node.attempts,reservation.nodeAttempts);
  const changed = accountingDigest !== (reservation?.accountingDigest??node.reservedAccountingDigest??node.lastAccountingDigest??node.reservedCandidateDigest??node.lastCandidateDigest);
  const nowMs = io.nowMs();
  if (changed) {
    if (isExpired(root, nowMs)) {
      throw operationError("DEADLINE_EXCEEDED","shared execution deadline exceeded");
    }
    if ((root.consumedAttempts ?? 0) >= (root.attemptLimit ?? root.policy.maxTotalAttempts ?? DEFAULT_POLICY.maxTotalAttempts)) {
      throw operationError("BUDGET_EXHAUSTED",`total attempt budget exhausted (${root.attemptLimit??root.policy.maxTotalAttempts})`);
    }
    root.consumedAttempts += 1;
    node.attempts += 1;
    node.reservedCandidateDigest=candidateDigest;node.reservedAccountingDigest=accountingDigest;
    root.candidateReservation={nodeId:node.id,candidateDigest,accountingDigest,nodeAttempts:node.attempts,at:io.nowMs()};
    // Persist reservations before snapshots, IO, or executable work.
    saveRoot(io,root);saveNodeState(io,node);
  }

  const timeoutMs = root.clockVersion===2?Math.max(0,root.deadlineAt-io.nowMs()):defaultTimeoutMs(root);
  let result = await freshEvaluate(io, bundle, candidateDigest, timeoutMs);
  requireIdentity(io,root,result);
  const verifiedStack={[node.id]:result};

  // Own-vector regression: restore the last verified-clean candidate,
  // re-evaluate the stack, and keep the consumed attempt.
  if (node.lastResult) {
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
  node.lastEnvironmentIdentity=result.environmentIdentity;node.lastAccountingDigest=accountingDigest;delete node.reservedCandidateDigest;delete node.reservedAccountingDigest;

  // Ancestor regression: run the relevant ancestor evaluators, not just this
  // node's checks. Restore this node's last accepted candidate on regression.
  const ancestors = stackAncestors(root, node.id);
  for (const ancestorId of ancestors) {
    const ancestorState = loadNodeState(io, ancestorId);
    const ancestorBundle = loadBundle(io, ancestorId);
    if(!ancestorState?.lastResult || !ancestorBundle)throw operationError("EVALUATOR_DRIFT",`ancestor ${ancestorId} lost trusted evidence`);
    const verified=verifyBundle(ancestorBundle,ancestorState);if(!verified.ok)throw operationError("EVALUATOR_DRIFT",verified.reason);
    const ancestorResult = await freshEvaluate(io, ancestorBundle, candidateDigest, timeoutMs);
    requireIdentity(io,root,ancestorResult);
    verifiedStack[ancestorId]=ancestorResult;
    const regressed = detectRegression(ancestorState.lastResult.outcomes, ancestorResult.outcomes);
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
    ancestorState.lastAccountingDigest=root.clockVersion===2?candidateDigest:legacyCandidateIdentity(io.cwd);
    ancestorState.lastEnvironmentIdentity=ancestorResult.environmentIdentity;
    saveNodeState(io, ancestorState);
  }

  requireIdentity(io,root,result);
  const snap = takeCheckpoint(io, node, "eval");
  requireIdentity(io,root,result);
  const warnings = snap.ok ? [] : [snap.warning];
  delete root.candidateReservation;
  saveNodeState(io,node);
  saveRoot(io, root);

  ensureBudget(io,root);
  if (result.allPass) {
    const cascade = await closePassCascade(io, index, root, node.id, verifiedStack);
    return { ok: true, node: node.id, status: cascade.paused?NodeState.PAUSED:loadNodeState(io,node.id).status, vector: formatVector(result.outcomes), warnings, cascade };
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
    if(!verified.ok)throw operationError("EVALUATOR_DRIFT",verified.reason);
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
    catch(e){return pauseRoot(io,loadRoot(io,root.id),{code:e.code??"IO_ERROR",reason:e.message,nodeId,operation:"block",args});}
    finally {owned.dispose();}
  });
}

async function blockActive(io,nodeId,{reason,code="NO_PATH"}) {
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  const node=nodeId?loadNodeState(io,nodeId):null;
  if(!root||!node||node.rootId!==root.id)return {ok:false,errors:[`unknown node ${nodeId}`]};
  if(!nonEmptyString(reason))return {ok:false,errors:["reason must name the specific missing requirement or cause"]};
  if(!BLOCK_CODES.includes(code))return {ok:false,errors:[`code must be one of ${BLOCK_CODES.join(", ")}`]};
  if([NodeState.PASS,NodeState.BLOCKED].includes(node.status))return {ok:true,node:node.id,status:node.status};
  if(root.status===NodeState.PAUSED)return {ok:false,errors:["resume the saved pause before replacing its operation"]};
  if(!node.parentId || code!=="NO_PATH")
    return pauseRoot(io,root,{code,reason:reason.trim(),nodeId:leafOf(root),operation:loadNodeState(io,leafOf(root))?.status===NodeState.DRAFT?"prepare":"evaluate",details:{blockedNodeId:node.id}});
  if(leafOf(root)!==node.id)return {ok:false,errors:["only the active leaf may be withdrawn"]};
  ensureBudget(io,root);
  // A declined child path can be withdrawn. Infrastructure faults do not use this path.
  const parent=loadNodeState(io,node.parentId);
  const fix=parent?restoreCheckpoint(io,parent,c=>c.id===node.preChildCheckpointId && c.note===`pre-child:${node.id}`):{ok:false,reason:"missing parent"};
  if(!fix.ok)throw operationError("RESTORATION_FAILED",`cannot withdraw child safely: ${fix.reason}`);
  const digestAfter=digestTree(io.cwd),events=[`${node.id} BLOCKED (${code}): ${reason.trim()}`,`restored ${parent.id} to pre-child checkpoint`];
  // Exclude the withdrawn leaf during refresh, but do not pop or terminally mark it until every parent result is conclusive.
  const refreshed=await refreshStack(io,{...root,stack:root.stack.filter(id=>id!==node.id)},digestAfter,defaultTimeoutMs(root));
  if(refreshed[parent.id])events.push(`${parent.id} rerun: ${formatVector(refreshed[parent.id].outcomes)}`);
  for(const result of Object.values(refreshed))requireIdentity(io,root,result);
  node.status=NodeState.BLOCKED;node.blockedReason=reason.trim();node.blockedCode=code;node.blockedCandidateDigest=digestAfter;node.blockedEnvironmentIdentity=digest(evaluatorEnvironment(io.cwd,io));
  saveNodeState(io,node);popStack(root,node.id);saveRoot(io,root);
  const reloaded=loadNodeState(io,parent.id),snap=takeCheckpoint(io,reloaded,"eval");saveNodeState(io,reloaded);
  if(!snap.ok)events.push(`warning: ${snap.warning}`);
  return {ok:true,node:node.id,status:NodeState.BLOCKED,events,terminal:null};
}

// --- status --------------------------------------------------------------

export function nextAction(root, node, draft = null, nowMs = Date.now()) {
  if(root?.status===NodeState.PAUSED)return `PAUSED (${root.pause?.code}): ${root.pause?.reason}. Restore the prerequisite, then /exitcode resume. Execution budget never resets.`;
  if (!node) return "no active node";
  if (node.status === NodeState.DRAFT) {
    if (isExpired(root, nowMs)) {
      return policyEditable(root, node)
        ? `shared deadline exceeded; revise ${node.id} with a larger finite policy and present the entire contract again, or the user can cancel with /exitcode exit`
        : "shared deadline exceeded; the user must cancel with /exitcode exit and start a fresh root with fresh review";
    }
    if (node.parentId) return `seal ${node.id} with exitcode_seal (prepares the child evaluator first)`;
    if (node.phase !== "READY_FOR_APPROVAL") return `prepare or repair ${node.id} evaluator before user review`;
    if (!node.parentId && !approvalMatches(root,draft)) return "present the validated plan and wait for explicit approval";
    return `seal ${node.id} with exitcode_seal`;
  }
  if (node.status !== NodeState.ACTIVE) return `${node.id} is ${node.status}`;
  const failing = (node.lastResult?.outcomes ?? []).filter((o) => o.status !== "PASS").map((o) => o.criterionId);
  const repairs = root.policy.localRepairs ?? DEFAULT_POLICY.localRepairs;
  const attempts = `attempts ${root.consumedAttempts ?? 0}/${root.attemptLimit??root.policy.maxTotalAttempts}`;
  if ((node.attempts ?? 0) < repairs) {
    return `repair ${node.id} to achieve its goal; use failures [${failing.join(", ") || "none"}] as feedback, then exitcode_evaluate (${attempts})`;
  }
  return `exitcode_evaluate ${node.id}; if a smaller goal offers a clearer path, propose exitcode_child targeting one of [${failing.join(", ") || "none"}], subject to supervisor gates (${attempts})`;
}

export function statusSnapshot(io) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  if (!root) return { active: false, roots: index.roots };
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
    nodes,
    consumedAttempts: root.consumedAttempts,
    maxTotalAttempts: root.attemptLimit??root.policy.maxTotalAttempts,
    ...policyStatus(root, rootNode, io.nowMs()),
    approval: root.approval ?? null,
    pause: root.pause??null,
    executionGrants: root.executionGrants??[],
    acceptanceRestorations:root.acceptanceRestorations??[],
    awaitingApproval,
    phase: root.status===NodeState.PAUSED?"PAUSED":leaf?.phase ?? (leaf?.status === NodeState.DRAFT ? "EVALUATOR_PREPARATION" : "EXECUTION"),
    intentDigest: rootDraft ? intentDigestOf(rootDraft) : loadBundle(io,root.id)?.intentDigest,
    evaluatorDigest: rootDraft ? evaluatorDigestOf(rootDraft) : loadBundle(io,root.id)?.evaluatorDigest,
    evaluatorMetrics: rootNode?.evaluatorMetrics ?? emptyMetrics(),
    diagnostics: leaf?.diagnostics ?? [],
    evaluatorEvidence: rootNode?.prepared ?? null,
    originalRequest: rootDraft?.originalRequest ?? loadBundle(io,root.id)?.contract.originalRequest,
    contract: rootDraft ?? loadBundle(io,root.id)?.contract,
    review: awaitingApproval ? rootReviewText(rootDraft, root, io.nowMs()) : null,
    next: leaf ? nextAction(root, leaf, leaf.id === root.id ? rootDraft : null, io.nowMs()) : "none",
  };
}

export function statusText(io) {
  const snap = statusSnapshot(io);
  if (!snap.active) return `exitcode: no active root (previous roots: ${snap.roots.join(", ") || "none"})`;
  const lines = [`exitcode root ${snap.root} [${snap.status}] stack: ${snap.stack.join(" > ") || "(empty)"}`];
  for (const [id, node] of Object.entries(snap.nodes)) {
    lines.push(`  ${id} ${node.status} attempts=${node.attempts} :: ${node.vector}`);
    if (node.goal) lines.push(`    goal: ${node.goal.slice(0, 160)}`);
  }
  lines.push(`  budget: ${snap.consumedAttempts}/${snap.maxTotalAttempts} attempts, deadline ${snap.clockStarted?snap.deadlineAt:"starts at root seal"}${snap.expired ? " (EXPIRED)" : ""}`);
  lines.push(`  effective policy: ${JSON.stringify(snap.policy)}`);
  lines.push(`  remaining: ${(snap.remainingMs / 60000).toFixed(2)} minutes; policy ${snap.policyEditable ? "editable before approval" : "locked"}${snap.clockStarted?"":"; execution clock not started"}`);
  lines.push(`  execution grants: ${JSON.stringify(snap.executionGrants)}`,`  acceptance restorations: ${JSON.stringify(snap.acceptanceRestorations)}`);
  lines.push(`  phase: ${snap.phase}`, ...(snap.pause?[`  pause: ${JSON.stringify(snap.pause)}`]:[]), `  evaluator metrics: ${JSON.stringify(snap.evaluatorMetrics)}`, `  intent digest: ${snap.intentDigest}`, `  evaluator digest: ${snap.evaluatorDigest}`, `  diagnostics: ${JSON.stringify(snap.diagnostics)}`, `  evaluator evidence: ${JSON.stringify(snap.evaluatorEvidence)}`, `  contract: ${JSON.stringify(snap.contract)}`);
  lines.push(`  next: ${snap.next}`);
  if (snap.review) lines.push("", snap.review);
  return lines.join("\n");
}

/** A recorded PASS is only valid for its candidate; later edits stale it. */
export function terminalStale(io, rootId) {
  const root = loadRoot(io, rootId);
  if (!root || root.status !== NodeState.PASS) return { stale: false };
  if(root.closingStack)return {stale:true,reason:"interrupted verdict commit requires fresh evaluation"};
  const current = root.clockVersion===2 || root.outcome?.environment ? digestTree(io.cwd) : legacyCandidateIdentity(io.cwd);
  return { stale: Boolean(current !== root.outcome?.candidateDigest || root.outcome?.environment && stableStringify(evaluatorEnvironment(io.cwd,io))!==stableStringify(root.outcome.environment)), recorded: root.outcome?.candidateDigest, current };
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
    if(recoverClosing(io,index,root))return pauseRoot(io,root,{reason:"Interrupted verdict commit; fresh evaluation is required",code:"INTERRUPTED",operation:"evaluate"});
    for(const id of root?.stack??[])clearInterruptedPreparation(io,id);
    return {ok:true};
  });
}

export { reviewPrompt, REVIEW_TIMEOUT_MS, REVIEW_MAX_TOKENS, REVIEW_RESPONSE_BYTES, REVIEW_INPUT_BYTES, REVIEW_SCHEMAS, reviewSchema, validateReviewSchema } from './exitcode-quality.mjs';
