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
import { spawn } from "node:child_process";
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
  ACTIVE: "ACTIVE",
  PASS: "PASS",
  BLOCKED: "BLOCKED",
});

/** Starting policy recorded once per root; children inherit. */
export const DEFAULT_POLICY = Object.freeze({
  localRepairs: 2,
  maxDepth: 3,
  maxTotalAttempts: 12,
  deadlineMinutes: 60,
  evalTimeoutSeconds: 120,
});

/** Evaluator-draft proposals (seal attempts) allowed per node. */
export const MAX_DRAFT_PROPOSALS = 2;

/** Consecutive settle-nudges before the extension lets the run settle. */
export const MAX_SETTLE_NUDGES = 3;

/** Rolling checkpoints kept per node. */
export const MAX_CHECKPOINTS_PER_NODE = 3;

/** Snapshot size cap (bytes of file content). */
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

/** Files larger than this are digested by size + head/tail sample. */
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

/** Short protocol instructions supplied to Pi while exitcode mode is on. */
export const PROTOCOL_PROMPT = [
  "EXITCODE MODE — contract-first execution.",
  "Inspect the goal, architecture, tests, and likely regressions in a read-only discovery phase.",
  "Resolve known product ambiguities with the user before finalizing observable acceptance criteria.",
  "Draft checks and controls.accept.setup/controls.reject[].setup commands that prepare valid/invalid candidate fixtures.",
  "The same check must PASS on the valid fixture and FAIL on each invalid fixture without changing the real candidate.",
  "For the root, present the entire acceptance specification, assumptions, exclusions, and verification approach, then STOP for user review.",
  "Interpret the user's reply to the presented root contract: acceptance, requested changes, or a question.",
  "On acceptance (for example 'looks good, go ahead'), call exitcode_seal with userApproval quoting that reply. /exitcode approve is an optional shortcut.",
  "A reply that requests changes is not approval, even if it also says 'looks good'. Revise and present the entire contract again.",
  "If intent is unclear, ask the user. Never infer approval from silence, the initial goal, or your own messages.",
  "Users may request revisions naturally or cancel with /exitcode exit. Every root revision requires fresh approval.",
  "After approval, the supervisor runs E0 and seals automatically before source writes become available.",
  "Implement toward the sealed criteria and use evaluator diagnostics for repair.",
  "After local attempts stall, or when a concrete prerequisite needs a smaller unit,",
  "propose one narrower child tied to a failing parent criterion.",
  "Children use the same evaluation protocol without user approval; they may only advance approved parent criteria. Preserve all ancestor contracts.",
  "Report a specific missing requirement when blocked.",
  "Completion belongs to the supervisor's fresh evaluation of the current candidate:",
  "never declare success yourself; only exitcode_evaluate reporting ALL PASS closes a goal.",
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
  if (!nonEmptyString(check.command)) errors.push(`${where}: check.command must be a nonempty string`);
  if (check.timeoutSeconds !== undefined && !(typeof check.timeoutSeconds === "number" && check.timeoutSeconds > 0)) {
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
  if (!isRecord(controls.accept) || !nonEmptyString(controls.accept.setup)) {
    errors.push(`${where}: controls.accept.setup must be a nonempty string`);
  }
  if (!Array.isArray(controls.reject) || controls.reject.length === 0) {
    errors.push(`${where}: controls.reject must be a nonempty array`);
  } else {
    controls.reject.forEach((entry, i) => {
      if (!isRecord(entry) || !nonEmptyString(entry.setup)) {
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
// Command execution (injectable; default runs locally with a timeout)
// ---------------------------------------------------------------------------

/**
 * Run one shell command. Resolves (never rejects on nonzero exit) to
 * { exit, stdout, stderr, timedOut, error?, durationMs, truncated }.
 */
export function execCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exit: null, stdout: "", stderr: "", timedOut: false, error: String(error?.message ?? error), durationMs: 0 });
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    const append = (buffer, chunk) => {
      const next = Buffer.concat([buffer, chunk]);
      if (next.length > EXEC_OUTPUT_MAX_BYTES) {
        truncated = true;
        return next.subarray(next.length - EXEC_OUTPUT_MAX_BYTES);
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - started, truncated });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ exit: null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      finish({ exit: null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: false, error: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      finish({ exit: code ?? 0, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: false });
    });
  });
}

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
    run = await exec(criterion.check.command, { cwd, timeoutMs });
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

function hashFile(full, size) {
  if (size > LARGE_FILE_BYTES) {
    const fd = fs.openSync(full, "r");
    try {
      const head = Buffer.alloc(64 * 1024);
      const tail = Buffer.alloc(64 * 1024);
      const headLen = fs.readSync(fd, head, 0, head.length, 0);
      const tailStart = Math.max(0, size - tail.length);
      const tailLen = fs.readSync(fd, tail, 0, tail.length, tailStart);
      return sha256Hex(Buffer.concat([Buffer.from(`large:${size}:`), head.subarray(0, headLen), tail.subarray(0, tailLen)]));
    } finally {
      fs.closeSync(fd);
    }
  }
  return sha256Hex(fs.readFileSync(full));
}

/** Content digest of the working tree (ignores .git, node_modules, .exitcode). */
export function digestTree(cwd) {
  const parts = [];
  for (const { rel, full } of walkFiles(cwd)) {
    const size = fs.statSync(full).size;
    parts.push(`${rel}:${size}:${hashFile(full, size)}`);
  }
  return sha256Hex(parts.join("\n"));
}

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
  fs.mkdirSync(destDir, { recursive: true });
  const files = [];
  let totalBytes = 0;
  for (const { rel, full } of walkFiles(cwd)) {
    const stat = fs.statSync(full);
    totalBytes += stat.size;
    if (totalBytes > maxBytes) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return { ok: false, reason: `working tree exceeds snapshot cap (${maxBytes} bytes)` };
    }
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(full, dest);
    files.push({ path: rel, bytes: stat.size, sha: hashFile(full, stat.size) });
  }
  const manifest = { version: 1, at: new Date().toISOString(), totalBytes, files };
  if (writeManifest) fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ok: true, manifest };
}

/** Restore cwd to a snapshot: rewrite manifest files, delete files added later. */
export function restoreTree(cwd, snapDir, manifest) {
  const wanted = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const restored = [];
  const removed = [];
  for (const { rel, full } of walkFiles(cwd)) {
    if (!wanted.has(rel)) {
      fs.rmSync(full, { force: true });
      removed.push(rel);
    }
  }
  for (const file of wanted.values()) {
    const dest = path.join(cwd, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(snapDir, file.path), dest);
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
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "exitcode-control-"));
    // Reuse candidate snapshot rules, but keep metadata out of the fixture.
    const copy = snapshotTree(deps.cwd, fixture, { writeManifest: false });
    if (!copy.ok) return { error: copy.reason };
    const prepared = await runCheck(
      { ...criterion, check: { ...criterion.check, command: setup, expect: { exit: 0 } } },
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
  if (toolName.startsWith("exitcode_")) return null;
  const storeRoot = path.join(cwd, EXITCODE_DIR);

  if (leafStatus !== NodeState.ACTIVE) {
    if (toolName === "write" || toolName === "edit") {
      const target = resolveWithin(cwd, String(input?.path ?? ""));
      if (isPathUnder(target, path.join(storeRoot, "drafts"))) return null;
      return {
        block: true,
        reason: `exitcode: source writes are blocked until the contract is sealed and ACTIVE (state ${leafStatus ?? "NO_CONTRACT"}). Draft criteria with exitcode_draft and wait for root user approval before sealing.`,
      };
    }
    if (toolName === "bash" || toolName === "powershell") {
      return {
        block: true,
        reason: "exitcode: shell use is blocked while drafting. Inspect with read/grep/find/ls; the supervisor runs evaluator probes during exitcode_seal.",
      };
    }
    return null;
  }

  if (toolName === "write" || toolName === "edit") {
    const target = resolveWithin(cwd, String(input?.path ?? ""));
    if (isPathUnder(target, storeRoot)) {
      return { block: true, reason: "exitcode: sealed artifacts under .exitcode/ are read-only to coding tools." };
    }
    return null;
  }
  if (toolName === "bash" || toolName === "powershell") {
    const command = String(input?.command ?? "");
    if (command.includes(EXITCODE_DIR)) {
      return { block: true, reason: "exitcode: shell commands must not touch sealed artifacts under .exitcode/." };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mode persistence (session entries carry the flag; disk carries contracts)
// ---------------------------------------------------------------------------

export function resolveModeFromBranch(branch) {
  let mode = { on: false, rootId: undefined };
  for (const entry of branch ?? []) {
    if (entry?.type === "custom" && entry?.customType === MODE_ENTRY_TYPE) {
      mode = { on: Boolean(entry?.data?.on), rootId: entry?.data?.rootId };
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

function mergePolicy(overrides) {
  if (overrides === undefined || overrides === null) return { ok: true, policy: { ...DEFAULT_POLICY } };
  if (!isRecord(overrides)) return { ok: false, error: "policy must be an object" };
  const policy = { ...DEFAULT_POLICY };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_POLICY)) return { ok: false, error: `unknown policy key ${key}` };
    if (typeof value !== "number" || !(value > 0)) return { ok: false, error: `policy.${key} must be a positive number` };
    policy[key] = value;
  }
  return { ok: true, policy };
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
  const withIds = assignCriterionIds(criteria);

  if (args.parentId) {
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
  const id = `G${index.rootCounter + 1}`;
  const draft = {
    version: 1,
    id,
    goal: goal.trim(),
    originalRequest: nonEmptyString(originalRequest) ? originalRequest.trim() : goal.trim(),
    parent: null,
    criteria: withIds,
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
    createdAt,
    deadlineAt: deadlineAtMs(createdAt, merged.policy),
    consumedAttempts: 0,
    reviewDigest: sha256Hex(stableStringify(draft)),
    stack: [id],
    status: NodeState.ACTIVE,
  };
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
    attempts: 0,
    sealAttempts: 0,
    lastResult: null,
    lastCandidateDigest: null,
    checkpoints: [],
    children: [],
  });
  return { ok: true, id, rootId: id, draft, warnings: [], next: `present the root contract and wait for the user to accept or request revisions (or /exitcode exit)` };
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
  const withIds = assignCriterionIds(args.criteria);
  const previous = readJson(draftFile(io.cwd, node.id))?.draft;
  const warnings = [];
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
    if (args.policy !== undefined) warnings.push("policy is fixed at root creation; ignoring policy on revise");
    draft = {
      version: 1,
      id: node.id,
      goal: args.goal.trim(),
      originalRequest: nonEmptyString(args.originalRequest) ? args.originalRequest.trim() : (previous?.originalRequest ?? args.goal.trim()),
      parent: null,
      criteria: withIds,
    };
    for (const key of ["assumptions", "exclusions", "verification"]) {
      const value = args[key] !== undefined ? args[key] : previous?.[key];
      if (value !== undefined) draft[key] = value;
    }
    validation = validateStructure(draft, { policy: root.policy });
  }
  if (!validation.ok) return { ok: false, errors: validation.errors };
  writeJsonAtomic(draftFile(io.cwd, node.id), { draft });
  if (!node.parentId) {
    delete root.approval;
    root.reviewDigest = sha256Hex(stableStringify(draft));
    saveRoot(io, root);
  }
  return { ok: true, id: node.id, rootId: root.id, revised: true, draft, warnings, next: nextAction(root, node, draft) };
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
  return Boolean(draft && root.approval?.approvedBy === "user" &&
    root.approval.digest === sha256Hex(stableStringify(draft)));
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
  const draft = readJson(draftFile(io.cwd, root.id))?.draft;
  if (!draft) return { ok: false, errors: [`draft for ${root.id} is missing`] };
  if (root.reviewDigest !== sha256Hex(stableStringify(draft))) {
    return { ok: false, errors: ["root draft changed since review; revise with exitcode_draft and present the entire contract again"] };
  }
  const validation = validateStructure(draft, { policy: root.policy });
  if (!validation.ok) return validation;
  root.approval = { digest: root.reviewDigest, at: new Date(io.nowMs()).toISOString(), approvedBy: "user",
    ...(userReply !== undefined ? { userReply: userReply.trim() } : {}) };
  saveRoot(io, root);
  return { ok: true, id: root.id, approval: root.approval };
}

/** Human acceptance layer; executable checks stay in the same draft. */
export function rootReviewText(draft) {
  const lines = ["Root verification contract ready.", "", "Goal", draft.goal, "", "I will consider this complete when:"];
  for (const criterion of draft.criteria) lines.push(`${criterion.id}: ${criterion.requirement}`);
  for (const key of ["assumptions", "exclusions"]) {
    lines.push("", key === "assumptions" ? "Assumptions" : "Exclusions");
    lines.push(...(draft[key]?.length ? draft[key].map((entry) => `- ${entry}`) : ["- None stated."]));
  }
  lines.push("", "Verification", draft.verification ??
    "Each criterion has an executable check. Behavioral checks must pass valid fixtures, reject invalid fixtures, and reject an empty target. Regression checks must continue to pass.",
    "", "Reply in plain English to accept (for example 'looks good, go ahead') or request changes. Cancel with /exitcode exit.",
    "The agent interprets your reply; /exitcode approve is an optional shortcut.",
    "Approval freezes this exact root draft, including its verification checks. Any revision requires fresh approval.",
    "After approval, ExitCode runs E0 and works autonomously until the root passes or reaches a blocker.",
    "Children need no separate approval and cannot weaken the approved root criteria.");
  return lines.join("\n");
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
  }
  if (!node.parentId && !approvalMatches(root, draft)) {
    return {
      ok: false,
      errors: [root.approval ? "root contract changed since user approval" : "root contract requires explicit user approval"],
      next: "present the root contract and wait for the user to accept or request revisions",
    };
  }

  const nowMs = io.nowMs();
  if (isExpired(root, nowMs)) {
    return blockNode(io, nodeId, { reason: "shared deadline exceeded during drafting", code: "BUDGET_EXHAUSTED" });
  }
  node.sealAttempts += 1;
  if (node.sealAttempts > MAX_DRAFT_PROPOSALS) {
    saveNodeState(io, node);
    return blockNode(io, nodeId, { reason: `evaluator draft budget exhausted (${MAX_DRAFT_PROPOSALS} proposals)`, code: "EVALUATOR_UNBUILDABLE" });
  }

  // Persist the E0 proposal before asynchronous probes can overlap a revision.
  saveNodeState(io, node);
  let parentBundle = null;
  let parentResult = null;
  if (node.parentId) {
    parentBundle = loadBundle(io, node.parentId);
    const parentState = loadNodeState(io, node.parentId);
    parentResult = parentState?.lastResult ?? (parentBundle ? resultFromBaseline(parentBundle) : null);
  }
  const validation = validateStructure(draft, {
    parent: parentBundle,
    parentDepth: node.parentId ? depthOf(node.parentId) : -1,
    parentLastResult: parentResult,
    policy: root.policy,
  });

  const candidateDigest = digestTree(io.cwd);
  const wiringDir = fs.mkdtempSync(path.join(os.tmpdir(), `exitcode-wiring-${nodeId.replace(/\./g, "_")}-`));
  let gate;
  try {
    gate = await runGate(draft, validation, {
      exec: io.exec,
      cwd: io.cwd,
      wiringDir,
      candidateDigest,
      env: envIdentity(io.cwd),
      defaultTimeoutMs: defaultTimeoutMs(root),
    });
  } finally {
    fs.rmSync(wiringDir, { recursive: true, force: true });
  }

  if (!node.parentId) {
    const currentRoot = loadRoot(io, root.id);
    const currentDraft = readJson(draftFile(io.cwd, nodeId))?.draft;
    if (currentRoot?.status !== NodeState.ACTIVE || loadNodeState(io, nodeId)?.status !== NodeState.DRAFT ||
        !approvalMatches(currentRoot, draft) || !approvalMatches(currentRoot, currentDraft)) {
      return { ok: false, errors: ["root contract or approval changed during E0; review and approve again"],
        next: "revise with exitcode_draft and wait for the user to accept or request revisions" };
    }
  }

  if (!gate.ok) {
    saveNodeState(io, node);
    const left = MAX_DRAFT_PROPOSALS - node.sealAttempts;
    if (left <= 0) {
      return blockNode(io, nodeId, { reason: `no valid evaluator after ${MAX_DRAFT_PROPOSALS} proposals: ${gate.errors.join("; ")}`, code: "EVALUATOR_UNBUILDABLE" });
    }
    const tool = node.parentId ? "exitcode_child" : "exitcode_draft";
    return { ok: false, errors: gate.errors, sealAttemptsLeft: left, next: `revise with ${tool} (revise:"${nodeId}") then ${node.parentId ? "exitcode_seal" : "present the entire contract and wait for the user to accept or request revisions"}` };
  }

  writeJsonAtomic(sealedFile(io.cwd, nodeId), gate.bundle);
  node.status = NodeState.ACTIVE;
  node.lastResult = resultFromBaseline(gate.bundle);
  node.lastCandidateDigest = candidateDigest;
  const snap = takeCheckpoint(io, node, "seal");
  const warnings = snap.ok ? [] : [snap.warning];
  saveNodeState(io, node);

  if (gate.bundle.baseline.allPass) {
    const cascade = await closePassCascade(io, index, root, nodeId);
    return { ok: true, sealed: nodeId, alreadySatisfied: true, baseline: formatVector(gate.bundle.baseline.outcomes), warnings, cascade };
  }
  return { ok: true, sealed: nodeId, baseline: formatVector(gate.bundle.baseline.outcomes), warnings, next: nextAction(root, node) };
}

// --- evaluate ------------------------------------------------------------

async function freshEvaluate(io, bundle, candidateDigest, timeoutMs) {
  const outcomes = [];
  for (const criterion of bundle.contract.criteria) {
    outcomes.push(await runCheck(criterion, io.exec, io.cwd, timeoutMs));
  }
  return {
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
        next: nextAction(root, current),
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
        next: nextAction(root, current),
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
    next: nextAction(root, node),
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

export function nextAction(root, node, draft = null) {
  if (!node) return "no active node";
  if (node.status === NodeState.DRAFT) {
    if (!node.parentId && !approvalMatches(root, draft)) return "present the root contract and wait for the user to accept or request revisions (or /exitcode exit)";
    return `seal ${node.id} with exitcode_seal`;
  }
  if (node.status !== NodeState.ACTIVE) return `${node.id} is ${node.status}`;
  const failing = (node.lastResult?.outcomes ?? []).filter((o) => o.status !== "PASS").map((o) => o.criterionId);
  const repairs = root.policy.localRepairs ?? DEFAULT_POLICY.localRepairs;
  const attempts = `attempts ${root.consumedAttempts ?? 0}/${root.policy.maxTotalAttempts}`;
  if ((node.attempts ?? 0) < repairs) {
    return `repair ${node.id} toward [${failing.join(", ") || "none"}], then exitcode_evaluate (${attempts})`;
  }
  return `exitcode_evaluate ${node.id}; if stalled, exitcode_child targeting one of [${failing.join(", ") || "none"}] (${attempts})`;
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
  const awaitingApproval = rootNode?.status === NodeState.DRAFT && !approvalMatches(root, rootDraft);
  return {
    active: true,
    root: root.id,
    status: root.status,
    stack: root.stack,
    nodes,
    consumedAttempts: root.consumedAttempts,
    maxTotalAttempts: root.policy.maxTotalAttempts,
    deadlineAt: new Date(root.deadlineAt).toISOString(),
    expired: isExpired(root, io.nowMs()),
    approval: root.approval ?? null,
    awaitingApproval,
    review: rootDraft ? rootReviewText(rootDraft) : null,
    next: leaf ? nextAction(root, leaf, leaf.id === root.id ? rootDraft : null) : "none",
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
