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
import { sandboxCommand, candidateIdentity, evaluatorEnvironment, normalizeEvaluator, runRecipe, diagnostic, fileDigest, inventory } from "./exitcode-evaluator.mjs";
import { prepareGate, emptyMetrics, addMetrics, copyCandidate, releasePreparation } from "./exitcode-preparation.mjs";
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
  PASS: "PASS",
  BLOCKED: "BLOCKED",
});

/** Root policy locks at first approval; children inherit. */
export const DEFAULT_POLICY = Object.freeze({
  localRepairs: 2,
  maxDepth: 3,
  maxTotalAttempts: 12,
  deadlineMinutes: 60,
  evalTimeoutSeconds: 120,
  evaluatorAttempts: 6,
});

/** Evaluator-draft proposals (seal attempts) allowed per node. */
export const MAX_DRAFT_PROPOSALS = 2;

/** Consecutive settle-nudges before the extension lets the run settle. */
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

/** Exact agent tool allowlists. Unknown names never inherit supervisor access. */
export const DISCOVERY_TOOL_NAMES = Object.freeze(["read", "grep", "ls"]);
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
  "Policy can change only before the first approval or evaluator work; revisions never reset elapsed time or counters.",
  "Keep the user's original objective above extension housekeeping and commit reminders. Never replace it with a commit-only goal.",
  `Before sealing, inspect only with ${DISCOVERY_TOOL_NAMES.join(", ")}. Submit contracts through ExitCode tools; all other agent tools are blocked.`,
  "The supervisor validates the evaluator before user review. Approval seals that exact validated bundle; stale preparation must be repeated.",
  "The sealed contract is fixed and cannot be weakened.",
  "PURSUE SUCCESS: Implement the approved goal. Use the sealed criteria to measure whether it has been achieved.",
  "Use evaluator failures as repair feedback and preserve previously passing behavior.",
  "Prefer direct repair. Decompose only when the supervisor permits it and a smaller goal offers a clearer path to a failed parent criterion.",
  "A child is a temporary reduction of its parent problem, not a new objective.",
  "It targets one failed parent criterion, needs no user approval, and cannot change ancestor contracts.",
  "PROVE SUCCESS: Evaluate after meaningful changes.",
  "Only a fresh supervisor evaluation with all criteria passing completes a goal.",
  "A passing child does not complete its parent; follow the supervisor's returned parent result and next action.",
  "If no viable autonomous path remains, report the concrete blocker.",
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
  };
}

export function ensureStoreDirs(cwd) {
  const p = storePaths(cwd);
  for (const dir of [p.root, p.rootsDir, p.draftsDir, p.contractsDir, p.nodesDir, p.checkpointsDir, p.tmpDir]) {
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
  const tmp = `${file}.${process.pid}.tmp`;
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
  if (check.timeoutSeconds !== undefined && !(Number.isFinite(check.timeoutSeconds) && check.timeoutSeconds > 0)) {
    errors.push(`${where}: check.timeoutSeconds must be a positive number`);
  }
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
  if (typeof seconds === "number" && seconds > 0) return Math.round(seconds * 1000);
  return defaultTimeoutMs;
}

export async function runCheck(criterion, exec, cwd, defaultTimeoutMs) {
  const started = Date.now();
  const timeoutMs = checkTimeoutMs(criterion, defaultTimeoutMs);
  let run;
  try {
    run = criterion.check.recipe
      ? await runRecipe(criterion.check.recipe, {cwd, timeoutMs, exec})
      : await exec(criterion.check.command, { cwd, timeoutMs });
  } catch (error) {
    return {
      criterionId: criterion.id,
      status: "ERROR",
      exit: null,
      timedOut: false,
      reasons: [`runner threw: ${error?.message ?? String(error)}`],
      stdoutTail: "",
      stderrTail: "",
      durationMs: Date.now() - started,
    };
  }
  const { pass, reasons } = matchesExpect(
    { exit: run.exit, stdout: run.stdout ?? "", timedOut: Boolean(run.timedOut), error: run.error },
    criterion.check.expect,
  );
  const status = run.timedOut || run.error ? "ERROR" : pass ? "PASS" : "FAIL";
  return {
    criterionId: criterion.id,
    status,
    exit: run.exit,
    timedOut: Boolean(run.timedOut),
    reasons,
    stdoutTail: tailText(run.stdout ?? "").text,
    stderrTail: tailText(run.stderr ?? "").text,
    durationMs: Date.now() - started,
  };
}

export function outcomesById(resultOrBaseline) {
  const map = new Map();
  for (const outcome of resultOrBaseline?.outcomes ?? []) map.set(outcome.criterionId, outcome.status);
  return map;
}

export function allPass(outcomes) {
  return outcomes.length > 0 && outcomes.every((o) => o.status === "PASS");
}

/** PASS -> non-PASS transitions between two outcome vectors. */
export function detectRegression(prevOutcomes, nextOutcomes) {
  const prev = new Map(prevOutcomes.map((o) => [o.criterionId, o.status]));
  const regressed = [];
  for (const outcome of nextOutcomes) {
    if (prev.get(outcome.criterionId) === "PASS" && outcome.status !== "PASS") regressed.push(outcome.criterionId);
  }
  return regressed;
}

export function formatVector(outcomes) {
  return outcomes.map((o) => `${o.criterionId}=${o.status}`).join(" ");
}

// ---------------------------------------------------------------------------
// Candidate identity and environment
// ---------------------------------------------------------------------------

export const SNAPSHOT_IGNORE = Object.freeze([".git", "node_modules", EXITCODE_DIR]);

function* walkFiles(dir, base = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const top = rel.split("/")[0];
    if (SNAPSHOT_IGNORE.includes(top)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, rel);
    else if (entry.isFile()) yield { rel, full };
  }
}

function hashFile(full) { return fileDigest(full); }

/** Full relevant candidate content identity, including modes and symlink targets. */
export function digestTree(cwd) { return candidateIdentity(cwd); }

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

export function snapshotTree(cwd, destDir, { maxBytes = SNAPSHOT_MAX_BYTES, writeManifest = true } = {}) {
  try {
    // Check logical size before copying any content, including on non-reflink filesystems.
    const entries = [];
    let totalBytes = 0;
    for (const { rel, full, link } of inventory(cwd)) {
      const size = link !== undefined ? 0 : fs.statSync(full).size;
      totalBytes += size;
      entries.push({ rel, full, size, link });
    }
    if (totalBytes > maxBytes) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return { ok: false, reason: `working tree exceeds snapshot cap (${maxBytes} bytes): ${totalBytes} bytes across ${entries.length} files; fixture setup cannot reduce the pre-copy size` };
    }
    fs.mkdirSync(destDir, { recursive: true });
    const files = [];
    for (const { rel, full, size, link } of entries) {
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (link !== undefined) {fs.symlinkSync(link,dest);files.push({path:rel,link,bytes:0});continue;}
      // Reflinks are independent files; Node falls back to a normal copy when unsupported.
      fs.copyFileSync(full, dest, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(dest,fs.statSync(full).mode & 0o777);
      if (fs.statSync(dest).size !== size) throw new Error(`file size changed while snapshotting ${rel}`);
      files.push({ path: rel, bytes: size, sha: hashFile(dest, size), mode: fs.statSync(full).mode & 0o777 });
    }
    const manifest = { version: 1, at: new Date().toISOString(), totalBytes, files };
    if (writeManifest) fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { ok: true, manifest };
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    return { ok: false, reason: `snapshot failed (${error?.code ?? "IO_ERROR"}): ${error?.message ?? String(error)}` };
  }
}

/** Restore cwd to a snapshot: rewrite manifest files, delete files added later. */
export function restoreTree(cwd, snapDir, manifest) {
  const wanted = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const restored = [];
  const removed = [];
  for (const { rel, full } of inventory(cwd)) {
    if (!wanted.has(rel)) {
      fs.rmSync(full, { force: true });
      removed.push(rel);
    }
  }
  for (const file of wanted.values()) {
    const dest = path.join(cwd, file.path);
    // Never follow an added symlink when restoring trusted checkpoint bytes.
    let parent = path.dirname(dest);
    const parents=[];
    while(parent!==cwd&&parent.startsWith(cwd+path.sep)){parents.unshift(parent);parent=path.dirname(parent);}
    for(const dir of parents){try{if(fs.lstatSync(dir).isSymbolicLink())fs.unlinkSync(dir);}catch(e){if(e.code!=="ENOENT")throw e;}fs.mkdirSync(dir,{recursive:true});}
    try{if(fs.lstatSync(dest).isSymbolicLink())fs.unlinkSync(dest);}catch(e){if(e.code!=="ENOENT")throw e;}
    if(file.link!==undefined){fs.rmSync(dest,{force:true,recursive:true});fs.symlinkSync(file.link,dest);restored.push(file.path);continue;}
    fs.copyFileSync(path.join(snapDir, file.path), dest, fs.constants.COPYFILE_FICLONE);
    if(file.mode!==undefined)fs.chmodSync(dest,file.mode);
    restored.push(file.path);
  }
  pruneEmptyDirs(cwd);
  return { ok: true, restored, removed };
}

function pruneEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SNAPSHOT_IGNORE.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    pruneEmptyDirs(full);
    try {
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } catch {}
  }
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
    const copy = snapshotTree(deps.cwd, fixture, { writeManifest: false });
    if (!copy.ok) return { error: copy.reason };
    const prepared = await runCheck(
      { ...criterion, check: { ...criterion.check, command: setup, expect: { exit: 0 } } },
      (command, opts) => deps.exec(command,{...opts,writable:true}), fixture, deps.defaultTimeoutMs,
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
 * deps: { exec, cwd, wiringDir, candidateDigest, env, defaultTimeoutMs }
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
  return nowMs >= root.deadlineAt;
}

/** Shared-budget check before consuming work (attempt, child, seal). */
export function budgetsOk(root, nowMs) {
  if (isExpired(root, nowMs)) return { ok: false, reason: "shared deadline exceeded" };
  if ((root.consumedAttempts ?? 0) >= (root.policy.maxTotalAttempts ?? DEFAULT_POLICY.maxTotalAttempts)) {
    return { ok: false, reason: `total attempt budget exhausted (${root.policy.maxTotalAttempts})` };
  }
  return { ok: true };
}

/**
 * Deterministic child gates. Semantic fit ("will this help?") stays with the
 * model; being wrong surfaces as no parent progress.
 */
export function childGates({ root, parentState, parentResult, target, goal, siblings, nowMs }) {
  const errors = [];
  if (!parentState || parentState.status !== NodeState.ACTIVE) {
    errors.push("parent must be sealed and ACTIVE before it can have a child");
  }
  if (parentState && depthOf(parentState.id) + 1 > (root.policy.maxDepth ?? DEFAULT_POLICY.maxDepth)) {
    errors.push(`depth ${depthOf(parentState.id) + 1} exceeds maxDepth ${root.policy.maxDepth}`);
  }
  const budget = budgetsOk(root, nowMs);
  if (!budget.ok) errors.push(budget.reason);
  const activeSibling = (siblings ?? []).find((s) => s.status === NodeState.ACTIVE || s.status === NodeState.DRAFT);
  if (activeSibling) {
    const hint = activeSibling.status === NodeState.DRAFT ? `; pass revise:"${activeSibling.id}" to revise it` : "";
    errors.push(`only one active child at a time (${activeSibling.id} is ${activeSibling.status}${hint})`);
  }
  if (parentResult) {
    const outcome = parentResult.outcomes.find((o) => o.criterionId === target);
    if (!outcome) errors.push(`target ${target} is not a parent criterion`);
    else if (outcome.status === "PASS") errors.push(`target ${target} currently passes; a child must target a failing criterion`);
  }
  const digest = fingerprintGoal(goal);
  const repeat = (siblings ?? []).find(
    (s) => s.status === NodeState.BLOCKED && s.target === target && s.goalDigest === digest && s.candidateDigest === parentState?.lastCandidateDigest,
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

/**
 * Decide whether a tool call is permitted.
 * Returns null to allow, or { block: true, reason } to deny.
 */
export function guardToolCall({ modeOn, leafStatus, cwd, toolName, input }) {
  if (!modeOn) return null;
  if (EXITCODE_TOOL_NAMES.includes(toolName)) return null;
  const storeRoot = path.join(cwd, EXITCODE_DIR);

  if (leafStatus !== NodeState.ACTIVE) {
    if (DISCOVERY_TOOL_NAMES.includes(toolName)) return null;
    return {
      block: true,
      reason: `exitcode: ${toolName} is blocked until the contract is sealed and ACTIVE (state ${leafStatus ?? "NO_CONTRACT"}). Inspect with ${DISCOVERY_TOOL_NAMES.join(", ")}. Use exitcode_draft or exitcode_child to submit contracts and exitcode_status for the required next action. The supervisor runs isolated evaluator probes during preparation.`,
    };
  }

  if (toolName === "write" || toolName === "edit") {
    const target = resolveWithin(cwd, String(input?.path ?? ""));
    if (isPathUnder(target, storeRoot)) {
      return { block: true, reason: "exitcode: supervisor-owned artifacts under .exitcode/ are read-only to coding tools. Use exitcode_* tools to update supervisor state." };
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
// Supervisor flows. io = { cwd, exec?, nowMs? }.
// exec defaults to execCommand; nowMs defaults to Date.now.
// ---------------------------------------------------------------------------

export function makeIo(cwd, overrides = {}) {
  return { cwd, exec: execCommand, nowMs: () => Date.now(), ...overrides };
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

function verifyBundle(bundle) {
  if (!bundle) return { ok: false, reason: "missing sealed bundle" };
  const digest = sha256Hex(stableStringify(bundle.contract));
  if (digest !== bundle.digest) return { ok: false, reason: "sealed bundle digest mismatch (tampering or disk corruption)" };
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
  const snap = snapshotTree(io.cwd, dir);
  if (!snap.ok) return { ok: false, warning: `checkpoint skipped: ${snap.reason}` };
  const checkpoint = { id, dir, note, at: new Date().toISOString(), candidateDigest: digestTree(io.cwd) };
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
  const restored = restoreTree(io.cwd, checkpoint.dir, manifest);
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
    if (!state || state.status !== NodeState.ACTIVE || !bundle || !verifyBundle(bundle).ok) continue;
    const result = await freshEvaluate(io, bundle, candidateDigest, timeoutMs);
    state.lastResult = result;
    state.lastCandidateDigest = candidateDigest;
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
  const restored = restoreCheckpoint(io, restoreNode, predicate);
  if (!restored.ok) return restored;
  const digest = digestTree(io.cwd);
  const fresh = await refreshStack(io, root, digest, defaultTimeoutMs(root));
  const reloaded = loadNodeState(io, restoreNodeId);
  const snap = takeCheckpoint(io, reloaded, "eval");
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
    if (["evaluatorAttempts", "maxTotalAttempts", "maxDepth", "localRepairs"].includes(key) && !Number.isInteger(value)) return {ok:false,error:`policy.${key} must be an integer`};
    policy[key] = value;
  }
  return { ok: true, policy };
}

/** Legacy roots without an explicit unlocked marker keep their fixed policy. */
function policyEditable(root, node) {
  return root.policyLocked === false && root.status === NodeState.ACTIVE &&
    node?.status === NodeState.DRAFT && !node.parentId && !root.approval &&
    root.consumedAttempts === 0 && node.attempts === 0 && node.sealAttempts === 0 &&
    !node.lastResult && !node.lastCandidateDigest &&
    node.checkpoints?.length === 0 && node.children?.length === 0 &&
    root.stack?.length === 1 && root.stack[0] === node.id;
}

/** Bind separately stored effective limits and the original clock to review. */
function rootReviewDigest(root, draft) {
  return sha256Hex(stableStringify({ draft, policy: root.policy,
    createdAt: root.createdAt, deadlineAt: root.deadlineAt, validatedBundleDigest: root.validatedBundleDigest }));
}

function policyStatus(root, node, nowMs) {
  return {
    policy: { ...root.policy },
    policyEditable: policyEditable(root, node),
    createdAt: root.createdAt,
    deadlineAt: new Date(root.deadlineAt).toISOString(),
    remainingMs: Math.max(0, root.deadlineAt - nowMs),
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
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const nowMs = io.nowMs();
  const { goal, originalRequest, criteria } = args;

  if (!nonEmptyString(goal)) return { ok: false, errors: ["goal must be a nonempty string"] };
  if (!Array.isArray(criteria) || criteria.length === 0) return { ok: false, errors: ["criteria must be a nonempty array"] };
  if (args.revise) return reviseDraft(io, index, args);
  const withIds = normalizeEvaluator({criteria:assignCriterionIds(criteria)},args.policy?.evalTimeoutSeconds??DEFAULT_POLICY.evalTimeoutSeconds).draft.criteria;

  if (args.parentId) {
    if (args.policy !== undefined) return { ok: false, errors: ["children inherit the root policy and cannot override it"] };
    const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
    if (!root || root.status !== NodeState.ACTIVE) return { ok: false, errors: ["no active root; start one with /exitcode <goal>"] };
    const parentState = loadNodeState(io, args.parentId);
    const parentBundle = loadBundle(io, args.parentId);
    if (!parentState || !parentBundle) return { ok: false, errors: [`parent ${args.parentId} is unknown`] };
    const verified = verifyBundle(parentBundle);
    if (!verified.ok) return { ok: false, errors: [verified.reason] };
    const parentResult = parentState.lastResult ?? resultFromBaseline(parentBundle);
    const siblings = (parentState.children ?? []).map((id) => {
      const s = loadNodeState(io, id);
      return s ? { id: s.id, status: s.status, target: s.target, goalDigest: s.goalDigest, candidateDigest: s.blockedCandidateDigest } : null;
    }).filter(Boolean);
    const gates = childGates({ root, parentState, parentResult, target: args.target, goal, siblings, nowMs });
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
    };
    const validation = validateStructure(draft, {
      parent: parentBundle,
      parentDepth: depthOf(args.parentId),
      parentLastResult: parentResult,
      policy: root.policy,
    });
    if (!validation.ok) return { ok: false, errors: validation.errors };

    writeJsonAtomic(draftFile(io.cwd, id), { draft });
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
    const warnings = snap.ok ? [] : [snap.warning];
    node.preChildCheckpointId = snap.ok ? snap.checkpoint.id : null;
    parentState.children.push(id);
    saveNodeState(io, parentState);
    saveNodeState(io, node);
    root.stack.push(id);
    saveRoot(io, root);
    return { ok: true, id, rootId: root.id, draft, warnings, next: `seal ${id} with exitcode_seal` };
  }

  if (index.activeRootId) {
    const active = loadRoot(io, index.activeRootId);
    if (active && active.status === NodeState.ACTIVE) {
      const activeNode = loadNodeState(io, active.id);
      if (activeNode && activeNode.status === NodeState.DRAFT) {
        return { ok: false, errors: [`root ${active.id} already has a draft; pass revise:"${active.id}" to revise it`] };
      }
      return { ok: false, errors: [`root ${active.id} is still ACTIVE; finish, block, or exit it first`] };
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
    deadlineAt: deadlineAtMs(createdAt, merged.policy),
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
  const withIds = normalizeEvaluator({criteria:assignCriterionIds(args.criteria)},root.policy.evalTimeoutSeconds??DEFAULT_POLICY.evalTimeoutSeconds).draft.criteria;
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
        return { ok: false, errors: ["root policy is locked after first approval or evaluator work; legacy roots also keep fixed policies"],
          ...policyStatus(root, node, nowMs),
          next: "keep the effective policy, or the user must cancel with /exitcode exit and start a fresh root with fresh review" };
      }
      effectivePolicy = merged.policy;
      effectiveDeadline = deadlineAtMs(root.createdAt, effectivePolicy);
      if (!Number.isFinite(new Date(effectiveDeadline).getTime())) {
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
    };
    validation = validateStructure(draft, {
      parent: parentBundle,
      parentDepth: depthOf(node.parentId),
      parentLastResult: parentResult,
      policy: root.policy,
    });
    if (nonEmptyString(args.reason)) node.reason = args.reason.trim();
    node.goalDigest = fingerprintGoal(args.goal);
    saveNodeState(io, node);
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
    };
    for (const key of ["assumptions", "exclusions", "verification", "intentAtoms", "ambiguities"]) {
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
export function approveRoot(io, { userReply } = {}) {
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
  const draft=readJson(draftFile(io.cwd,node.id))?.draft,p=node.prepared;
  const root=loadRoot(io,node.rootId);
  return Boolean(p && draft && (node.parentId ? node.preparedDigest : root.validatedBundleDigest)===sha256Hex(stableStringify(p)) && p.draftDigest===sha256Hex(stableStringify(draft)) && p.candidateDigest===digestTree(io.cwd) && stableStringify(p.environment)===stableStringify(evaluatorEnvironment(io.cwd)));
}

/** Safe evaluator preparation is separate from human approval and execution. */
export async function prepareNode(io, nodeId = null) {
  const index=loadIndex(io.cwd),root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  const node=root?loadNodeState(io,nodeId??leafOf(root)):null;
  if(!root||!node||node.rootId!==root.id||node.status!==NodeState.DRAFT)return {ok:false,errors:["no editable DRAFT evaluator"]};
  const stored=readJson(draftFile(io.cwd,node.id));if(!stored?.draft)return {ok:false,errors:["missing draft"]};
  if(isExpired(root,io.nowMs()))return expiredDraftResult(root,node,stored.draft,io.nowMs());
  if(node.preparing)return {ok:false,errors:["evaluator preparation already in progress"]};
  node.evaluatorMetrics??=emptyMetrics();
  if(node.evaluatorMetrics.e0Attempts >= (root.policy.evaluatorAttempts??DEFAULT_POLICY.evaluatorAttempts))return blockNode(io,node.id,{reason:"evaluator preparation budget exhausted",code:"EVALUATOR_UNBUILDABLE"});
  const normalized=normalizeEvaluator(stored.draft,root.policy.evalTimeoutSeconds??DEFAULT_POLICY.evalTimeoutSeconds);
  let draft=normalized.draft;
  const repairs=normalized.repairs;
  // Legacy shell drafts have no coverage map. Make migration explicit in evidence.
  if(!draft.intentAtoms && (node.parentId || draft.criteria.every(c=>c.check.command))){
    draft.intentAtoms=draft.criteria.map(c=>({id:`legacy-${c.id}`,outcome:c.requirement,criteria:[c.id]}));
    repairs.push({repair:"Migrated legacy declared coverage; semantic audit remains the agent's responsibility"});
  }
  writeJsonAtomic(draftFile(io.cwd,node.id),{draft});
  root.policyLocked=true;if(!node.parentId){delete root.approval;delete root.validatedBundleDigest;root.reviewDigest=rootReviewDigest(root,draft);}saveRoot(io,root);
  node.phase="EVALUATOR_PREPARATION";node.preparing=true;node.evaluatorMetrics.e0Attempts++;delete node.prepared;saveNodeState(io,node);
  const draftDigest=sha256Hex(stableStringify(draft)), reviewDigest=root.reviewDigest, environment=evaluatorEnvironment(io.cwd);let result;
  try{
    const parentBundle=node.parentId?loadBundle(io,node.parentId):null;
    const validation=validateStructure(draft,{policy:root.policy,parent:parentBundle,parentDepth:node.parentId?depthOf(node.parentId):-1,parentLastResult:node.parentId?loadNodeState(io,node.parentId)?.lastResult:null});
    if(!validation.ok)result={ok:false,errors:validation.errors,diagnostics:validation.errors.map(e=>diagnostic('INVALID_STRUCTURE','lint',null,e,'Correct evaluator structure')),stages:[],metrics:{...emptyMetrics(),e0Attempts:1}};
    else result=await prepareGate(draft,{cwd:io.cwd,exec:io.exec,runCheck,defaultTimeoutMs:defaultTimeoutMs(root),environment,maxBytes:SNAPSHOT_MAX_BYTES,candidateDigest:digestTree(io.cwd)});
  }catch(e){result={ok:false,errors:[e.message],diagnostics:[diagnostic('PREPARATION_FAILED','baseline',null,e.message,'Correct evaluator inputs')],stages:[],metrics:{...emptyMetrics(),e0Attempts:1}};}
  if(result.ok && stableStringify(environment)!==stableStringify(evaluatorEnvironment(io.cwd))){result.ok=false;result.diagnostics.push(diagnostic('ENVIRONMENT_CHANGED','baseline',node.id,'Environment changed during preparation','Reprepare against a stable environment'));result.errors.push('Environment changed during preparation');}
  if(result.ok && isExpired(root,io.nowMs())){result.ok=false;result.diagnostics.push(diagnostic('DEADLINE_EXCEEDED','baseline',node.id,'Deadline elapsed during preparation','Cancel and start a new run'));result.errors.push('shared deadline exceeded');}
  const current=loadNodeState(io,node.id),currentRoot=loadRoot(io,root.id),currentDraft=readJson(draftFile(io.cwd,node.id))?.draft;
  if(currentRoot.status!==NodeState.ACTIVE||currentRoot.reviewDigest!==reviewDigest||(!node.parentId && rootReviewDigest(currentRoot,currentDraft)!==reviewDigest)||current.status!==NodeState.DRAFT||sha256Hex(stableStringify(currentDraft))!==draftDigest){
    delete current.preparing;saveNodeState(io,current);
    return {ok:false,errors:["contract changed during preparation"],diagnostics:[diagnostic('CONTRACT_CHANGED','baseline',node.id,'Concurrent revision','Reprepare current draft')]};
  }
  delete current.preparing;addMetrics(current.evaluatorMetrics,{...result.metrics,e0Attempts:0});current.diagnostics=result.diagnostics;current.repairs=repairs;
  if(result.ok && !isExpired(currentRoot,io.nowMs())){
    current.phase="READY_FOR_APPROVAL";
    current.prepared={draftDigest,candidateDigest:digestTree(io.cwd),environment:evaluatorEnvironment(io.cwd),intentDigest:intentDigestOf(draft),evaluatorDigest:evaluatorDigestOf(draft),stages:result.stages,baseline:result.baseline,capabilities:result.capabilities};
    if(!node.parentId){currentRoot.validatedBundleDigest=sha256Hex(stableStringify(current.prepared));currentRoot.reviewDigest=rootReviewDigest(currentRoot,draft);saveRoot(io,currentRoot);}
    current.preparedDigest=sha256Hex(stableStringify(current.prepared));
    if(!node.parentId){current.evaluatorMetrics.reviewTurns++;result.review=rootReviewText(draft,currentRoot,io.nowMs());}
  }else current.phase=result.questions?.length?"CLARIFICATION":"EVALUATOR_PREPARATION";
  saveNodeState(io,current);
  return {...result,id:node.id,phase:current.phase,repairs,next:nextAction(currentRoot,current,draft,io.nowMs())};
}

// --- seal ----------------------------------------------------------------

export async function sealNode(io, nodeId, { userApproval } = {}) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  const node = loadNodeState(io, nodeId);
  if (!root || !node || node.rootId !== root.id) return { ok: false, errors: [`unknown node ${nodeId}`] };
  if (node.status !== NodeState.DRAFT) return { ok: false, errors: [`${nodeId} is ${node.status}; only DRAFT nodes can be sealed`] };
  if (root.status !== NodeState.ACTIVE) return { ok: false, errors: [`root ${root.id} is ${root.status}`] };

  const stored = readJson(draftFile(io.cwd, nodeId));
  if (!stored?.draft) return { ok: false, errors: [`draft for ${nodeId} is missing`] };
  const draft = JSON.parse(stableStringify(stored.draft)); // immutable gate copy
  if (userApproval !== undefined) {
    if (node.parentId) return { ok: false, errors: ["children do not require user approval"] };
    const approval = approveRoot(io, { userReply: userApproval });
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

  if (isExpired(root,io.nowMs())) return blockNode(io,nodeId,{reason:"shared deadline exceeded during drafting",code:"BUDGET_EXHAUSTED"});
  if (node.parentId && !preparationMatches(io,node)) {
    const prepared=await prepareNode(io,nodeId);
    if(!prepared.ok)return prepared;
    Object.assign(node,loadNodeState(io,nodeId));
  }
  if(!preparationMatches(io,node))return {ok:false,errors:["validated bundle is stale; prepare again before approval"]};
  const prepared=node.prepared;
  const validatedDraft=readJson(draftFile(io.cwd,nodeId)).draft;
  const bundle={version:1,contract:validatedDraft,digest:sha256Hex(stableStringify(validatedDraft)),env:prepared.environment,candidateDigest:prepared.candidateDigest,sealedAt:new Date().toISOString(),baseline:prepared.baseline,intentDigest:prepared.intentDigest,evaluatorDigest:prepared.evaluatorDigest,validation:prepared.stages};
  writeJsonAtomic(sealedFile(io.cwd,nodeId),bundle);
  node.status=NodeState.ACTIVE;node.phase="EXECUTION";node.sealAttempts++;
  node.lastResult=resultFromBaseline(bundle);node.lastCandidateDigest=bundle.candidateDigest;
  const snap=takeCheckpoint(io,node,"seal");saveNodeState(io,node);releasePreparation(io.cwd);
  return {ok:true,sealed:nodeId,baseline:formatVector(bundle.baseline.outcomes),warnings:snap.ok?[]:[snap.warning],next:nextAction(root,node,null,io.nowMs())};
}

// --- evaluate ------------------------------------------------------------

async function freshEvaluate(io, bundle, candidateDigest, timeoutMs) {
  const outcomes = [];
  const metrics=emptyMetrics();
  for (const criterion of bundle.contract.criteria) {
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),"exitcode-fresh-"));
    try {
      metrics.fixtureBytes+=copyCandidate(io.cwd,fixture,SNAPSHOT_MAX_BYTES);metrics.fixtureCopies++;
      if(fs.existsSync(path.join(io.cwd,"node_modules")))fs.cpSync(path.join(io.cwd,"node_modules"),path.join(fixture,"node_modules"),{recursive:true});
      metrics.probeExecutions++;
      outcomes.push(await runCheck(criterion,async(command,opts)=>{metrics.shellExecutions++;return io.exec(command,opts);},fixture,timeoutMs));
    } finally {fs.rmSync(fixture,{recursive:true,force:true});}
  }
  return {
    metrics,
    runId: newRunId(),
    bundleDigest: bundle.digest,
    candidateDigest,
    outcomes,
    allPass: allPass(outcomes),
    at: new Date().toISOString(),
  };
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
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  if (!root) return { ok: false, errors: ["no active root"] };
  if (root.status !== NodeState.ACTIVE) return { ok: false, errors: [`root ${root.id} is ${root.status}`] };
  const targetId = nodeId ?? leafOf(root);
  const node = targetId ? loadNodeState(io, targetId) : null;
  if (!node || node.rootId !== root.id) return { ok: false, errors: [`unknown node ${targetId}`] };
  if (node.status === NodeState.DRAFT) return { ok: false, errors: [`${node.id} is DRAFT; seal it with exitcode_seal first`] };
  if (node.status !== NodeState.ACTIVE) {
    const current = digestTree(io.cwd);
    const stale = node.lastCandidateDigest && current !== node.lastCandidateDigest;
    return { ok: true, node: node.id, status: node.status, stale: Boolean(stale), vector: node.lastResult ? formatVector(node.lastResult.outcomes) : "none" };
  }
  const bundle = loadBundle(io, node.id);
  const verified = verifyBundle(bundle);
  if (!verified.ok) return blockNode(io, node.id, { reason: verified.reason, code: "NO_PATH" });

  const candidateDigest = digestTree(io.cwd);
  const changed = candidateDigest !== node.lastCandidateDigest;
  const nowMs = io.nowMs();
  if (changed) {
    if (isExpired(root, nowMs)) {
      return blockNode(io, node.id, { reason: "shared deadline exceeded", code: "BUDGET_EXHAUSTED" });
    }
    if ((root.consumedAttempts ?? 0) >= (root.policy.maxTotalAttempts ?? DEFAULT_POLICY.maxTotalAttempts)) {
      return blockNode(io, node.id, { reason: `total attempt budget exhausted (${root.policy.maxTotalAttempts})`, code: "BUDGET_EXHAUSTED" });
    }
    root.consumedAttempts += 1;
    node.attempts += 1;
  }

  const timeoutMs = defaultTimeoutMs(root);
  let result = await freshEvaluate(io, bundle, candidateDigest, timeoutMs);

  // Own-vector regression: restore the last verified-clean candidate,
  // re-evaluate the stack, and keep the consumed attempt.
  if (node.lastResult) {
    const regressed = detectRegression(node.lastResult.outcomes, result.outcomes);
    if (regressed.length > 0) {
      const fixed = await restoreAndRefresh(io, root, node.id, ROLLING_CP);
      saveRoot(io, root);
      if (!fixed.ok) {
        saveNodeState(io, node);
        return blockNode(io, node.id, { reason: `regressed ${regressed.join(", ")} with ${fixed.reason}`, code: "NO_PATH" });
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

  // Ancestor regression: run the relevant ancestor evaluators, not just this
  // node's checks. Restore this node's last accepted candidate on regression.
  const ancestors = stackAncestors(root, node.id);
  for (const ancestorId of ancestors) {
    const ancestorState = loadNodeState(io, ancestorId);
    const ancestorBundle = loadBundle(io, ancestorId);
    if (!ancestorState?.lastResult || !ancestorBundle) continue;
    const ancestorResult = await freshEvaluate(io, ancestorBundle, candidateDigest, timeoutMs);
    const regressed = detectRegression(ancestorState.lastResult.outcomes, ancestorResult.outcomes);
    if (regressed.length > 0) {
      const fixed = await restoreAndRefresh(io, root, ancestorId, ROLLING_CP);
      saveRoot(io, root);
      if (!fixed.ok) {
        saveNodeState(io, node);
        return blockNode(io, node.id, { reason: `regressed ancestor ${ancestorId} (${regressed.join(", ")}) with ${fixed.reason}`, code: "NO_PATH" });
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
    saveNodeState(io, ancestorState);
  }

  const snap = takeCheckpoint(io, node, "eval");
  const warnings = snap.ok ? [] : [snap.warning];
  saveRoot(io, root);
  saveNodeState(io, node);

  if (result.allPass) {
    const cascade = await closePassCascade(io, index, root, node.id);
    return { ok: true, node: node.id, status: NodeState.PASS, vector: formatVector(result.outcomes), warnings, cascade };
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
async function closePassCascade(io, index, root, nodeId) {
  const events = [];
  let current = loadNodeState(io, nodeId);
  current.status = NodeState.PASS;
  saveNodeState(io, current);
  popStack(root, nodeId);
  events.push(`${nodeId} PASS`);
  saveRoot(io, root);

  for (;;) {
    const parentId = leafOf(root);
    if (!parentId) {
      const outcome = { candidateDigest: digestTree(io.cwd), at: new Date().toISOString() };
      markTerminal(io, index, root, NodeState.PASS, outcome);
      events.push(`root ${root.id} PASS`);
      return { events, terminal: { root: root.id, status: NodeState.PASS, outcome } };
    }
    const parent = loadNodeState(io, parentId);
    const bundle = loadBundle(io, parentId);
    const verified = verifyBundle(bundle);
    if (!verified.ok) {
      const blocked = await blockNode(io, parentId, { reason: verified.reason, code: "NO_PATH" });
      events.push(`${parentId} BLOCKED (${verified.reason})`);
      return { events, terminal: blocked.terminal ?? null };
    }
    const candidateDigest = digestTree(io.cwd);
    const result = await freshEvaluate(io, bundle, candidateDigest, defaultTimeoutMs(root));
    parent.lastResult = result;
    parent.lastCandidateDigest = candidateDigest;
    saveNodeState(io, parent);
    events.push(`${parentId} rerun: ${formatVector(result.outcomes)}`);

    // Ancestor chain above the parent must still hold after integration.
    let restored = false;
    for (const ancestorId of stackAncestors(root, parentId)) {
      const ancestorState = loadNodeState(io, ancestorId);
      const ancestorBundle = loadBundle(io, ancestorId);
      if (!ancestorState?.lastResult || !ancestorBundle) continue;
      const ancestorResult = await freshEvaluate(io, ancestorBundle, candidateDigest, defaultTimeoutMs(root));
      const regressed = detectRegression(ancestorState.lastResult.outcomes, ancestorResult.outcomes);
      if (regressed.length > 0) {
        const fixed = await restoreAndRefresh(io, root, ancestorId, ROLLING_CP);
        if (!fixed.ok) {
          await blockNode(io, parentId, { reason: `regressed ancestor ${ancestorId} (${regressed.join(", ")}) with ${fixed.reason}`, code: "NO_PATH" });
          events.push(`${parentId} BLOCKED (ancestor regression, unrestorable)`);
          return { events, terminal: parentId === root.id ? { root: root.id, status: NodeState.BLOCKED } : null };
        }
        // The integrated work is withdrawn: the path failed at the parent level.
        current.status = NodeState.BLOCKED;
        current.blockedReason = `reverted: regressed ancestor ${ancestorId} (${regressed.join(", ")})`;
        current.blockedCode = "NO_PATH";
        current.blockedCandidateDigest = fixed.digest;
        saveNodeState(io, current);
        events.push(`${current.id} reverted and BLOCKED (ancestor regression)`);
        restored = true;
        break;
      }
      ancestorState.lastResult = ancestorResult;
      ancestorState.lastCandidateDigest = candidateDigest;
      saveNodeState(io, ancestorState);
    }
    if (restored) return { events, terminal: null };

    if (result.allPass) {
      current = parent;
      current.status = NodeState.PASS;
      saveNodeState(io, current);
      popStack(root, parentId);
      events.push(`${parentId} PASS`);
      saveRoot(io, root);
      continue;
    }
    saveRoot(io, root);
    return { events, terminal: null };
  }
}

// --- block ---------------------------------------------------------------

export async function blockNode(io, nodeId, { reason, code = "NO_PATH" }) {
  ensureStoreDirs(io.cwd);
  const index = loadIndex(io.cwd);
  const root = index.activeRootId ? loadRoot(io, index.activeRootId) : null;
  const node = nodeId ? loadNodeState(io, nodeId) : null;
  if (!root || !node || node.rootId !== root.id) return { ok: false, errors: [`unknown node ${nodeId}`] };
  if (!nonEmptyString(reason)) return { ok: false, errors: ["reason must name the specific missing requirement or cause"] };
  if (!BLOCK_CODES.includes(code)) return { ok: false, errors: [`code must be one of ${BLOCK_CODES.join(", ")}`] };
  if (node.status === NodeState.PASS || node.status === NodeState.BLOCKED) {
    return { ok: true, node: node.id, status: node.status, terminal: root.status !== NodeState.ACTIVE ? { root: root.id, status: root.status } : null };
  }

  node.status = NodeState.BLOCKED;
  node.blockedReason = reason.trim();
  node.blockedCode = code;
  const events = [`${node.id} BLOCKED (${code}): ${reason.trim()}`];

  if (!node.parentId) {
    node.blockedCandidateDigest = node.lastCandidateDigest;
    saveNodeState(io, node);
    const outcome = { reason: node.blockedReason, code, at: new Date().toISOString() };
    markTerminal(io, index, root, NodeState.BLOCKED, outcome);
    return { ok: true, node: node.id, status: NodeState.BLOCKED, events, terminal: { root: root.id, status: NodeState.BLOCKED, outcome } };
  }

  // Persist the terminal state first so the refresh below skips this node.
  saveNodeState(io, node);
  // Restore the parent candidate from before this child's work, then
  // re-evaluate the stack so no vector stays stale on the restored tree.
  const parent = loadNodeState(io, node.parentId);
  const fix = parent ? restoreCheckpoint(io, parent, (c) => c.note === `pre-child:${node.id}`) : { ok: false, reason: "missing parent" };
  const fallback = fix.ok ? fix : parent ? restoreCheckpoint(io, parent) : fix;
  if (fallback.ok) {
    events.push(`restored ${parent.id} to ${fix.ok ? "pre-child" : "latest"} checkpoint`);
    const afterDigest = digestTree(io.cwd);
    node.blockedCandidateDigest = afterDigest;
    const fresh = await refreshStack(io, root, afterDigest, defaultTimeoutMs(root));
    if (fresh[parent.id]) events.push(`${parent.id} rerun: ${formatVector(fresh[parent.id].outcomes)}`);
    const reloaded = loadNodeState(io, parent.id);
    const snap = takeCheckpoint(io, reloaded, "eval");
    saveNodeState(io, reloaded);
    if (!snap.ok) events.push(`warning: ${snap.warning}`);
  } else {
    node.blockedCandidateDigest = node.lastCandidateDigest ?? parent?.lastCandidateDigest ?? digestTree(io.cwd);
    events.push(`warning: kept working tree (${fallback.reason})`);
  }
  saveNodeState(io, node);
  popStack(root, node.id);
  saveRoot(io, root);
  return { ok: true, node: node.id, status: NodeState.BLOCKED, events, terminal: null };
}

// --- status ----------------------------------------------------------------

export function nextAction(root, node, draft = null, nowMs = Date.now()) {
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
  const attempts = `attempts ${root.consumedAttempts ?? 0}/${root.policy.maxTotalAttempts}`;
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
    maxTotalAttempts: root.policy.maxTotalAttempts,
    ...policyStatus(root, rootNode, io.nowMs()),
    approval: root.approval ?? null,
    awaitingApproval,
    phase: leaf?.phase ?? (leaf?.status === NodeState.DRAFT ? "EVALUATOR_PREPARATION" : "EXECUTION"),
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
  lines.push(`  budget: ${snap.consumedAttempts}/${snap.maxTotalAttempts} attempts, deadline ${snap.deadlineAt}${snap.expired ? " (EXPIRED)" : ""}`);
  lines.push(`  effective policy: ${JSON.stringify(snap.policy)}`);
  lines.push(`  remaining: ${(snap.remainingMs / 60000).toFixed(2)} minutes; policy ${snap.policyEditable ? "editable before first approval" : "locked"}`);
  lines.push(`  phase: ${snap.phase}`, `  evaluator metrics: ${JSON.stringify(snap.evaluatorMetrics)}`, `  intent digest: ${snap.intentDigest}`, `  evaluator digest: ${snap.evaluatorDigest}`, `  diagnostics: ${JSON.stringify(snap.diagnostics)}`, `  evaluator evidence: ${JSON.stringify(snap.evaluatorEvidence)}`, `  contract: ${JSON.stringify(snap.contract)}`);
  lines.push(`  next: ${snap.next}`);
  if (snap.review) lines.push("", snap.review);
  return lines.join("\n");
}

/** A recorded PASS is only valid for its candidate; later edits stale it. */
export function terminalStale(io, rootId) {
  const root = loadRoot(io, rootId);
  if (!root || root.status !== NodeState.PASS) return { stale: false };
  const current = digestTree(io.cwd);
  return { stale: current !== root.outcome?.candidateDigest, recorded: root.outcome?.candidateDigest, current };
}

/** Interrupted preparation never restores approval or unlocks coding. */
export function resumePreparation(io) {
  const index=loadIndex(io.cwd), root=index.activeRootId?loadRoot(io,index.activeRootId):null;
  for(const id of root?.stack??[]){const node=loadNodeState(io,id);if(node?.preparing){delete node.preparing;node.phase="EVALUATOR_PREPARATION";delete node.prepared;saveNodeState(io,node);}}
}
