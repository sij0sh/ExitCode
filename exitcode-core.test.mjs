/** Supervisor lifecycle invariants. See INVARIANTS.md for the mapping. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as core from "./exitcode-core.mjs";
import {
  DEFAULT_POLICY, MAX_DISCARDED_CHANGES, MODE_ENTRY_TYPE, NodeState, PROTOCOL_PROMPT,
  PROMPT_STATUS_MAX_BYTES, SNAPSHOT_MAX_BYTES, approveRoot, assignCriterionIds, baselineScope, blockNode, captureBaseline,
  detectRegression, digestTree, draftFile, draftNode, enforceBaseline, ensureBaseline, evaluateNode, formatVector,
  guardToolCall, loadBundle, loadNodeState, loadRoot, makeIo as hostMakeIo, matchesExpect, nextAction, prepareNode,
  promptStatusText, resolveModeFromBranch, restoreTree, rootReviewText, sealNode, sha256Hex, snapshotTree,
  stableStringify, statusSnapshot, statusText, terminalStale, validateStructure,
} from "./exitcode-core.mjs";
import { candidateIdentity, scanCapabilities } from "./exitcode-evaluator.mjs";
import { structuralReview } from "./test/structural-review.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeIo = (cwd, overrides = {}) => hostMakeIo(cwd, { review: structuralReview, ...overrides });

/** Each behavior's confined witnesses write its fixture file. */
const FIXTURES = {
  C1: { file: "feature.txt", valid: "done\n", invalid: "todo\n" },
  D1: { file: "child1.txt", valid: "ok", invalid: "bad" },
  E1: { file: "gc.txt", valid: "ok", invalid: "bad" },
};
const witness = (id, content) => ({ mutations: [{ kind: "write_file", path: FIXTURES[id].file, content }] });
const custom = (command) => ({ recipe: { kind: "custom_command", command } });
const behavior = (id, cmd, outcome) => ({
  id, ...(outcome === null ? {} : { outcome: outcome ?? `O${id.replace(/\D/g, "") || "1"}` }), check: custom(cmd),
  controls: { accept: witness(id, FIXTURES[id].valid), reject: [{ ...witness(id, FIXTURES[id].invalid), reason: `broken ${id}` }] },
});
const regression = (id, cmd) => ({ id, requirement: `requirement ${id}`, type: "regression", check: custom(cmd) });

function rootDraft(overrides = {}) {
  return { id: "G1", goal: "Add the thing", originalRequest: "user: add the thing", parent: null,
    outcomes: [{ id: "O1", requirement: "The thing is added" }],
    criteria: [behavior("C1", "check:c1", "O1"), regression("C2", "check:reg")], ...overrides };
}

/** Fake exec: checks always read the supplied cwd. */
function fileExec(dir, { checks = {} } = {}) {
  const fn = async (command, { cwd, timeoutMs }) => {
    fn.calls.push({ command, cwd, timeoutMs });
    const read = (rel) => {
      try { return fs.readFileSync(path.join(cwd, rel), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    };
    if (command in checks) {
      const pass = checks[command](read);
      return { exit: pass ? 0 : 1, stdout: pass ? "pass" : "fail", stderr: "", timedOut: false };
    }
    throw new Error(`unexpected command ${command}`);
  };
  fn.calls = [];
  return fn;
}

const standardChecks = {
  "check:c1": (read) => (read("feature.txt") ?? "").includes("done"),
  "check:reg": (read) => read("feature.txt") !== null && !read("feature.txt").includes("BROKE"),
  "check:d1": (read) => (read("child1.txt") ?? "") === "ok",
  "check:e1": (read) => (read("gc.txt") ?? "") === "ok",
};

function tempProject(t, files = { "feature.txt": "todo\n" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exitcode-test-"));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function testIo(dir, exec, nowRef = { now: Date.now() }) {
  return { io: makeIo(dir, { exec, nowMs: () => nowRef.now }), nowRef };
}

const ROOT_OUTCOMES = [{ id: "O1", requirement: "The thing is added" }];
const ROOT_CRITERIA = [behavior("C1", "check:c1", "O1"), regression("C2", "check:reg")];
const ROOT_SEQUENCE = [{ objective: "Establish the first proof", verify: ["C1"] }, { objective: "Finish the last proof", verify: ["C3"] }];
const ORDERED_OUTCOMES = [...ROOT_OUTCOMES, { id: "O3", requirement: "The last artifact is done" }];
const ORDERED_CRITERIA = [...ROOT_CRITERIA, { id: "C3", outcome: "O3",
  check: { recipe: { kind: "file_contains", path: "last.txt", value: "done" } } }];
const childCriteria = () => [behavior("D1", "check:d1", "O1")];
const CHILD_OUTCOMES = [{ id: "O1", requirement: "The child outcome is done" }];
const childArgs = (extra = {}) => ({ parentId: "G1", target: "C1", goal: "sub", outcomes: CHILD_OUTCOMES, criteria: childCriteria(), reason: "r",
  prerequisite: true, prerequisiteArtifact: "a", ...extra });

async function sealedRoot(t, { files, policy, sequence, nowRef = { now: Date.now() } } = {}) {
  const dir = tempProject(t, files);
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec, nowRef);
  const draft = draftNode(io, { goal: "Add the thing", outcomes: sequence ? ORDERED_OUTCOMES : ROOT_OUTCOMES, criteria: sequence ? ORDERED_CRITERIA : ROOT_CRITERIA, ...(sequence ? { sequence } : {}), ...(policy ? { policy } : {}) });
  assert.equal(draft.ok, true, JSON.stringify(draft.errors));
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, draft.id)).ok, true);
  return { dir, io, exec, nowRef };
}

const readText = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const write = (dir, rel, content) => fs.writeFileSync(path.join(dir, rel), content);

// ---------------------------------------------------------------------------
// Contract structure
// ---------------------------------------------------------------------------

test("structure: drafts are validated before any probe, and controls are optional witnesses", async (t) => {
  assert.deepEqual(validateStructure(rootDraft(), { policy: DEFAULT_POLICY }), { ok: true, errors: [] });
  // Thin contracts: a behavior criterion may omit controls, and a root needs no regression criterion.
  assert.equal(validateStructure(rootDraft({ criteria: [{ id: "C1", check: custom("c") }] })).ok, true);
  const parent = { contract: rootDraft() };
  const child = (targets, extra = {}) => ({ id: "G1.1", goal: "g", originalRequest: "r", parent: { id: "G1", targets }, criteria: [behavior("C1", "c")], ...extra });
  for (const [label, draft, opts, fragment] of [
    ["duplicate ids", rootDraft({ criteria: [behavior("C1", "a"), behavior("C1", "b"), regression("C2", "r")] }), {}, "duplicate criterion id C1"],
    ["duplicated behavior text", rootDraft({criteria:[{...behavior("C1","c"),requirement:"A conflicting second description"}]}), {}, "remove criterion.requirement"],
    ["missing regression text", rootDraft({criteria:[{id:"R1",type:"regression",check:custom("c")}]}), {}, "regression requirement"],
    ["empty goal", rootDraft({ goal: "  " }), {}, "goal"],
    ["no request", rootDraft({ originalRequest: "" }), {}, "originalRequest"],
    ["blank accept", rootDraft({ criteria: [{ ...behavior("C1", "c"), controls: { accept: { mutations: [] } } }, regression("C2", "r")] }), {}, "controls.accept"],
    ["empty reject", rootDraft({ criteria: [{ ...behavior("C1", "c"), controls: { reject: [] } }, regression("C2", "r")] }), {}, "controls.reject"],
    ["shell setup", rootDraft({ criteria: [{ ...behavior("C1", "c"), controls: { accept: { setup: "true" }, reject: [{ setup: "false" }] } }, regression("C2", "r")] }), {}, "controls.reject[0] needs nonempty mutations"],
    ["bare command", rootDraft({ criteria: [{ id: "C1", check: { command: "true" } }] }), {}, "check must be an object with a recipe"],
    ["assumptions", rootDraft({ assumptions: "bad" }), {}, "assumptions"],
    ["exclusions", rootDraft({ exclusions: [""] }), {}, "exclusions"],
    ["unknown target", child(["C9"]), { parent, parentDepth: 0 }, "C9"],
    ["passing target", child(["C1"]), { parent, parentDepth: 0, parentLastResult: { outcomes: [{ criterionId: "C1", status: "PASS" }] } }, "currently passes"],
    ["depth", child(["C1"]), { parent, parentDepth: 3 }, "maxDepth"],
  ]) {
    const result = validateStructure(draft, { policy: DEFAULT_POLICY, ...opts });
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((e) => e.includes(fragment)), `${label}: ${result.errors.join("; ")}`);
  }
  assert.deepEqual(assignCriterionIds([{ requirement: "a" }, { id: "C9", requirement: "b" }, { requirement: "c" }]).map((c) => c.id), ["C1", "C9", "C2"]);
  const ordered = rootDraft({ outcomes: ORDERED_OUTCOMES, criteria: ORDERED_CRITERIA, sequence: ROOT_SEQUENCE });
  assert.equal(validateStructure(ordered).ok, true);
  assert.equal(validateStructure({ ...ordered, sequence: [{ objective: "x".repeat(200), verify: ["C1", "C3"] }] }).ok, true);
  for (const [label, sequence] of [
    ["empty", []], ["null", null], ["object", {}], ["slice object", [null]], ["objective type", [{ objective: 1, verify: ["C1", "C3"] }]],
    ["blank objective", [{ objective: "   ", verify: ["C1", "C3"] }]], ["long objective", [{ objective: "x".repeat(201), verify: ["C1", "C3"] }]],
    ["empty proof", [{ objective: "First", verify: [] }]], ["proof type", [{ objective: "First", verify: "C1" }]],
    ["unknown", [{ objective: "First", verify: ["C1", "C3", "unknown"] }]],
    ["regression", [{ objective: "First", verify: ["C1", "C2", "C3"] }]],
    ["missing", [{ objective: "First", verify: ["C1"] }]],
    ["repeated within", [{ objective: "First", verify: ["C1", "C1", "C3"] }]],
    ["repeated across", [...ROOT_SEQUENCE, { objective: "Again", verify: ["C1"] }]],
    ["nonstring ID", [{ objective: "First", verify: ["C1", "C3", 1] }]],
    ["too many", Array.from({ length: 13 }, (_, i) => ({ objective: `Slice ${i}`, verify: ["C1"] }))],
  ]) {
    assert.equal(validateStructure({ ...ordered, sequence }).ok, false, label);
    const dir = tempProject(t), exec = fileExec(dir), io = makeIo(dir, { exec });
    const rejected = draftNode(io, { goal: "g", outcomes: ORDERED_OUTCOMES, criteria: ORDERED_CRITERIA, sequence });
    assert.equal(rejected.ok, false, `${label} rejected at the draft boundary`);
    assert.equal(exec.calls.length, 0);
    assert.equal(core.loadIndex(dir).activeRootId, null, "invalid order creates no root");
  }
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `B${i}`, check: custom("observe") }));
  assert.equal(validateStructure(rootDraft({ criteria: twelve, sequence: twelve.map(c => ({ objective: `Prove ${c.id}`, verify: [c.id] })) })).ok, true);
  assert.equal(validateStructure(child(["C1"], { sequence: [{ objective: "Child", verify: ["C1"] }] }), { parent, parentDepth: 0 }).ok, false, "sequences are root-only");
  const dir = tempProject(t), io = makeIo(dir);
  const assigned = draftNode(io, { goal: "g", outcomes: ORDERED_OUTCOMES, criteria: ORDERED_CRITERIA.map(({ id, ...c }) => c), sequence: ROOT_SEQUENCE });
  assert.equal(assigned.ok, true, "sequence references supervisor-assigned criterion IDs");
  assert.deepEqual(assigned.draft.sequence, ROOT_SEQUENCE);
  const before = [fs.readFileSync(core.draftFile(dir, "G1"), "utf8"), loadRoot(io, "G1"), loadNodeState(io, "G1")];
  assert.equal(draftNode(io, { revise: "G1", goal: "bad", outcomes: ORDERED_OUTCOMES, criteria: ORDERED_CRITERIA, sequence: [] }).ok, false);
  assert.deepEqual([fs.readFileSync(core.draftFile(dir, "G1"), "utf8"), loadRoot(io, "G1"), loadNodeState(io, "G1")], before, "invalid revision is atomic");
  assert.deepEqual(draftNode(io, { revise: "G1", goal: "g", criteria: ORDERED_CRITERIA }).draft.sequence, ROOT_SEQUENCE, "omitted order is retained on revision");
});

test("verdict: runner errors, timeouts, and truncated output never PASS; only PASS -> FAIL regresses", async () => {
  const pass = (run, expect) => matchesExpect({ timedOut: false, stdout: "", ...run }, expect).pass;
  assert.equal(pass({ exit: 0, stdout: "hello" }, { exit: 0 }), true);
  assert.equal(pass({ exit: 1 }, { exit: 0 }), false);
  assert.equal(pass({ exit: 0, stdout: "abc" }, { stdoutContains: ["b"] }), true);
  assert.equal(pass({ exit: 0, stdout: "abc" }, { stdoutContains: ["z"] }), false);
  assert.equal(pass({ exit: 0, stdout: "abc" }, { stdoutNotContains: ["b"] }), false);
  assert.equal(pass({ exit: null, timedOut: true }, {}), false);
  assert.equal(pass({ exit: null, error: "boom" }, {}), false);
  const prev = [{ criterionId: "C1", status: "PASS" }, { criterionId: "C2", status: "FAIL" }];
  const next = [{ criterionId: "C1", status: "FAIL" }, { criterionId: "C2", status: "PASS" }];
  assert.deepEqual(detectRegression(prev, next), ["C1"]);
  assert.deepEqual(detectRegression(prev, [{ criterionId: "C1", status: "ERROR" }]), []);
  assert.equal(formatVector(next), "C1=FAIL C2=PASS");
  const truncated = await core.runCheck({ id: "C1", check: { ...custom("observe"), expect: { stdoutNotContains: ["unsafe"] } } },
    async () => ({ exit: 0, stdout: "only the retained tail", stderr: "", timedOut: false, truncated: true }), os.tmpdir(), 1000);
  assert.equal(truncated.status, "ERROR");
  assert.equal(truncated.errorCode, "OUTPUT_INCOMPLETE");
});

// ---------------------------------------------------------------------------
// Draft -> prepare -> approve -> seal -> fresh PASS
// ---------------------------------------------------------------------------

test("lifecycle: an approved, validated draft seals exactly and only a fresh evaluation can PASS", async (t) => {
  const dir = tempProject(t);
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }), nowRef);
  const draft = draftNode(io, { goal: "Add the thing", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  assert.equal(draft.id, "G1");
  assert.match(draft.next, /revise G1 evaluator with exitcode_draft/);
  const prepared = await prepareNode(io);
  assert.equal(prepared.ok, true);
  assert.match(prepared.review, /Validated plan/);
  const preparedDraft = JSON.parse(fs.readFileSync(draftFile(dir, "G1"), "utf8")).draft;
  const approved = approveRoot(io);
  assert.deepEqual(approved.approval, { digest: loadRoot(io, "G1").reviewDigest, at: new Date(nowRef.now).toISOString(), approvedBy: "user" });
  // Approval survives a fresh IO instance and binds the exact prepared bundle.
  const fresh = makeIo(dir, { exec: fileExec(dir, { checks: standardChecks }) });
  assert.equal(statusSnapshot(fresh).awaitingApproval, false);
  assert.match(statusSnapshot(fresh).next, /seal G1/);
  const sealed = await sealNode(fresh, "G1");
  assert.equal(sealed.baseline, "C1=FAIL C2=PASS");
  assert.equal(loadNodeState(fresh, "G1").status, NodeState.ACTIVE);
  assert.equal(loadBundle(fresh, "G1").digest, sha256Hex(stableStringify(preparedDraft)));
  assert.equal(approveRoot(fresh).ok, false);
  assert.equal(loadRoot(fresh, "G1").status, NodeState.ACTIVE, "seal never completes a goal");
  write(dir, "feature.txt", "done\n");
  const result = await evaluateNode(fresh, null);
  assert.equal(result.status, NodeState.PASS);
  assert.equal(result.vector, "C1=PASS C2=PASS");
  assert.equal(result.cascade.terminal.status, NodeState.PASS);
  assert.equal(loadRoot(fresh, "G1").outcome.candidateDigest, digestTree(dir));
  assert.equal(terminalStale(fresh, "G1").stale, false);
  write(dir, "feature.txt", "done plus more\n");
  assert.equal(terminalStale(fresh, "G1").stale, true);
});

test("lifecycle: one root at a time; a second draft must revise", async (t) => {
  const dir = tempProject(t);
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  assert.equal(draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA }).ok, true);
  assert.ok(draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA }).errors.some((e) => e.includes('revise:"G1"')));
  const { io: sealed } = await sealedRoot(t);
  assert.ok(draftNode(sealed, { goal: "other", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA }).errors.some((e) => e.includes("still ACTIVE")));
});

// ---------------------------------------------------------------------------
// Approval binds the exact validated bundle
// ---------------------------------------------------------------------------

test("approval: unapproved roots and invalid replies never seal or spend proposals", async (t) => {
  const dir = tempProject(t);
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec);
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  for (let n = 0; n < 3; n++) assert.match((await sealNode(io, "G1")).errors[0], /requires explicit user approval/);
  for (const userApproval of ["", "  ", null, true, 123]) assert.match((await sealNode(io, "G1", { userApproval })).errors[0], /nonempty string/);
  assert.equal(exec.calls.length, 0);
  assert.equal(loadRoot(io, "G1").approval, undefined);
  assert.equal(loadNodeState(io, "G1").sealAttempts, 0);
  assert.equal(loadBundle(io, "G1"), null);
});

test("approval: a conversational reply is recorded against the exact root draft", async (t) => {
  const dir = tempProject(t);
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  await prepareNode(io);
  const reply = "Looks good, go ahead.";
  assert.equal((await sealNode(io, "G1", { userApproval: reply })).ok, true);
  const approval = loadRoot(io, "G1").approval;
  assert.equal(approval.userReply, reply);
  assert.equal(approval.digest, loadRoot(io, "G1").reviewDigest);
  assert.deepEqual(loadRoot(makeIo(dir), "G1").approval, approval);
});

test("approval: every revision or on-disk edit invalidates approval", async (t) => {
  const dir = tempProject(t);
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec);
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, sequence: [{ objective: "Prove the feature", verify: ["C1"] }], assumptions: ["Existing policy"], exclusions: ["No redesign"], policy: { evaluatorAttempts: 12 } });
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal(approveRoot(io).ok, true);
  exec.calls.length = 0;
  assert.equal(draftNode(io, { goal: "g", criteria: [], revise: "G1" }).ok, false);
  assert.ok(loadRoot(io, "G1").approval, "a rejected revision keeps approval");
  // Even an identical resubmission is a revision and requires new approval; review context is retained.
  const revised = draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, revise: "G1" });
  assert.equal(loadRoot(io, "G1").approval, undefined);
  assert.deepEqual(revised.draft.assumptions, ["Existing policy"]);
  assert.match(rootReviewText(revised.draft, loadRoot(io, "G1")), /No redesign/);
  assert.equal((await sealNode(io, "G1")).ok, false);
  assert.equal(exec.calls.length, 0);
  for (const mutate of [
    (draft) => { draft.criteria.pop(); },
    (draft) => { draft.outcomes[0].requirement = "Weakened requirement"; },
    (draft) => { draft.criteria[0].check.recipe.command = "true"; },
    (draft) => { draft.criteria[0].controls.reject[0].mutations[0].content = "done\n"; },
    (draft) => { draft.assumptions = ["Changed policy"]; },
    (draft) => { draft.sequence[0].objective = "Weakened implementation objective"; },
    (draft) => { draft.sequence[0].verify = []; },
  ]) {
    assert.equal((await prepareNode(io)).ok, true);
    assert.equal(approveRoot(io).ok, true);
    exec.calls.length = 0;
    const stored = JSON.parse(fs.readFileSync(draftFile(dir, "G1"), "utf8"));
    const original = structuredClone(stored);
    mutate(stored.draft);
    fs.writeFileSync(draftFile(dir, "G1"), JSON.stringify(stored));
    assert.match((await sealNode(io, "G1")).errors[0], /changed since user approval/);
    assert.equal(statusSnapshot(io).awaitingApproval, true);
    assert.equal(approveRoot(io).ok, false);
    assert.equal((await sealNode(io, "G1", { userApproval: "Go ahead." })).ok, false);
    assert.equal(exec.calls.length, 0);
    fs.writeFileSync(draftFile(dir, "G1"), JSON.stringify(original));
    draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, revise: "G1" });
  }
  // A root whose review digest is missing fails closed until revised.
  const root = loadRoot(io, "G1");
  delete root.reviewDigest;
  core.saveRoot(io, root);
  assert.equal(approveRoot(io).ok, false);
  assert.equal((await sealNode(io, "G1", { userApproval: "Proceed." })).ok, false);
  assert.equal(draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, revise: "G1" }).ok, true);
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal((await sealNode(io, "G1", { userApproval: "Proceed." })).ok, true);
  assert.equal(loadNodeState(io, "G1").sealAttempts, 1);
});

test("approval: review and approval bind every limit and the shared clock", async (t) => {
  for (const [key, value] of [...Object.entries({ localRepairs: 4, maxDepth: 1, maxTotalAttempts: 24,
    deadlineMinutes: 480, evalTimeoutSeconds: 1200 }), ["createdAt", Date.now() - 1000], ["deadlineAt", Date.now() + 480 * 60000]]) {
    const dir = tempProject(t);
    const exec = fileExec(dir, { checks: standardChecks });
    const io = makeIo(dir, { exec });
    draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
    const file = path.join(dir, ".exitcode/roots/G1.json");
    const before = loadRoot(io, "G1");
    const mutated = structuredClone(before);
    if (key in DEFAULT_POLICY) mutated.policy[key] = value; else mutated[key] = value;
    fs.writeFileSync(file, JSON.stringify(mutated));
    assert.equal(approveRoot(io).ok, false, `${key} before approval`);
    fs.writeFileSync(file, JSON.stringify(before));
    assert.equal((await prepareNode(io)).ok, true);
    assert.equal(approveRoot(io).ok, true);
    exec.calls.length = 0;
    const approved = loadRoot(io, "G1");
    if (key in DEFAULT_POLICY) approved.policy[key] = value; else approved[key] = value;
    fs.writeFileSync(file, JSON.stringify(approved));
    assert.equal(statusSnapshot(io).awaitingApproval, true);
    assert.equal((await sealNode(io, "G1")).ok, false, `${key} after approval`);
    assert.equal((await sealNode(io, "G1", { userApproval: "Reuse approval" })).ok, false);
    assert.equal(exec.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Policy and clock
// ---------------------------------------------------------------------------

test("policy: limits are editable before first approval, atomic when invalid, and locked afterwards", async (t) => {
  const dir = tempProject(t);
  const nowRef = { now: Date.parse("2026-10-07T22:02:15.029Z") }, exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec, nowRef);
  for (const policy of [null, { deadlineMinutes: Infinity }, { deadlineMinutes: Number.MAX_VALUE }, { evalTimeoutSeconds: NaN }, { maxTotalAttempts: -1 }, { constructor: 1 }]) {
    assert.equal(draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy }).ok, false);
    assert.deepEqual(statusSnapshot(io).roots, [], "invalid root creation consumes no identity");
  }
  draftNode(io, { goal: "Initial scope", originalRequest: "Complete the implementation", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { maxDepth: 1, evalTimeoutSeconds: 900 } });
  const createdAt = loadRoot(io, "G1").createdAt;
  const files = [draftFile(dir, "G1"), path.join(dir, ".exitcode/roots/G1.json"), path.join(dir, ".exitcode/nodes/G1.json")];
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  for (const policy of [null, [], { bogus: 1 }, { toString: 1 }, { deadlineMinutes: Infinity }, { deadlineMinutes: NaN },
    { deadlineMinutes: 0 }, { deadlineMinutes: -1 }, { deadlineMinutes: "480" }, { deadlineMinutes: Number.MAX_VALUE }]) {
    assert.equal(draftNode(io, { revise: "G1", goal: "Should not persist", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy }).ok, false);
    assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
  }
  assert.equal(draftNode(io, { revise: "G1", goal: "Invalid", criteria: [behavior("C1", "check:c1"), behavior("C1", "check:c1")], policy: { deadlineMinutes: 900 } }).ok, false);
  assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
  // Partial corrections retain effective values; the retained request outranks a later one.
  nowRef.now += 14 * 86400000;
  const policy = { localRepairs: 4, maxTotalAttempts: 24, deadlineMinutes: 480, evalTimeoutSeconds: 1200 };
  const revised = draftNode(io, { revise: "G1", goal: "Implementation", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, originalRequest: "Housekeeping", policy });
  assert.equal(revised.draft.originalRequest, "Complete the implementation");
  assert.deepEqual(revised.policy, { ...DEFAULT_POLICY, maxDepth: 1, ...policy });
  assert.equal(revised.createdAt, createdAt);
  assert.equal(revised.deadlineAt, null);
  assert.equal(revised.remainingMs, 480 * 60000);
  assert.equal(revised.policyEditable, true);
  assert.equal(exec.calls.length, 0);
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal(approveRoot(io).ok, true);
  const approved = loadRoot(io, "G1");
  const rejected = draftNode(io, { revise: "G1", goal: "Rejected scope", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { deadlineMinutes: 960 } });
  assert.match(rejected.errors[0], /locked/);
  assert.match(rejected.next, /user must cancel/);
  assert.deepEqual(loadRoot(io, "G1"), approved);
  // An identical policy is not an amendment, but it is still a fresh revision.
  const same = draftNode(io, { revise: "G1", goal: "Implementation", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { ...approved.policy } });
  assert.equal(same.ok, true);
  assert.equal(same.policyEditable, false);
  assert.equal(draftNode(makeIo(dir), { revise: "G1", goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { maxTotalAttempts: 99 } }).ok, false);
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal((await sealNode(io, "G1", { userApproval: "Approve scope and limits" })).sealed, "G1");
  assert.ok(exec.calls.every((call) => call.timeoutMs === 1200 * 1000));
  // Any evidence of work closes initial editing even without a current approval.
  for (const mutate of [(root) => { root.consumedAttempts = 1; }, (_r, node) => { node.attempts = 1; }, (_r, node) => { node.sealAttempts = 1; },
    (_r, node) => { node.lastResult = { outcomes: [] }; }, (_r, node) => { node.lastCandidateDigest = "evaluated"; },
    (_r, node) => { node.checkpoints.push({ id: "work" }); }, (_r, node) => { node.children.push("G1.1"); }]) {
    const other = tempProject(t), otherIo = makeIo(other);
    draftNode(otherIo, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
    const root = loadRoot(otherIo, "G1"), node = loadNodeState(otherIo, "G1");
    mutate(root, node);
    core.saveRoot(otherIo, root);
    core.saveNodeState(otherIo, node);
    assert.equal(statusSnapshot(otherIo).policyEditable, false);
    assert.equal(draftNode(otherIo, { revise: "G1", goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { maxTotalAttempts: 99 } }).ok, false);
  }
});

test("policy: discovery, preparation, review and approval spend no execution time; the clock starts once at seal", async (t) => {
  const dir = tempProject(t);
  const { io, nowRef } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  const created = loadRoot(io, "G1").createdAt;
  nowRef.now += 30 * 60000;
  // A shorter duration does not expire an unsealed preparation.
  const shorter = draftNode(io, { revise: "G1", goal: "New scope", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { deadlineMinutes: 20 } });
  assert.equal(shorter.expired, false);
  assert.equal(shorter.deadlineAt, null);
  io.review = async (input) => { nowRef.now += 7 * 86400000; return structuralReview(input); };
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal(loadRoot(io, "G1").deadlineAt, null);
  assert.equal(statusSnapshot(io).expired, false);
  nowRef.now += 30 * 86400000;
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  const root = loadRoot(io, "G1");
  assert.equal(root.createdAt, created);
  assert.equal(root.executionStartedAt, nowRef.now);
  assert.equal(root.deadlineAt, nowRef.now + 20 * 60000);
});

test("policy: children inherit the root's limits and approval and cannot amend or reset them", async (t) => {
  const dir = tempProject(t);
  const io = makeIo(dir, { exec: fileExec(dir, { checks: standardChecks }) });
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { maxDepth: 1, deadlineMinutes: 480 } });
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal((await sealNode(io, "G1", { userApproval: "Proceed" })).sealed, "G1");
  const before = loadRoot(io, "G1"), parentDigest = loadBundle(io, "G1").digest;
  assert.equal(draftNode(io, { ...childArgs(), policy: { maxDepth: 4 } }).ok, false);
  assert.deepEqual(loadRoot(io, "G1"), before);
  const child = draftNode(io, childArgs());
  assert.match(child.next, /seal G1.1/);
  assert.equal(approveRoot(io).ok, false);
  assert.equal(draftNode(io, { ...childArgs(), revise: child.id, policy: before.policy }).ok, false);
  assert.equal(draftNode(io, { ...childArgs({ goal: "smaller prerequisite" }), revise: child.id }).ok, true);
  assert.equal(statusSnapshot(io).awaitingApproval, false);
  assert.equal((await sealNode(io, child.id, { userApproval: "Proceed." })).ok, false);
  assert.equal((await sealNode(io, child.id)).sealed, child.id);
  const root = loadRoot(io, "G1");
  for (const key of ["policy", "approval", "createdAt", "deadlineAt", "consumedAttempts"]) assert.deepEqual(root[key], before[key], key);
  assert.equal(loadBundle(io, "G1").digest, parentDigest);
});

// ---------------------------------------------------------------------------
// Evaluator preparation (E0) lifecycle
// ---------------------------------------------------------------------------

test("prepare: failures spend only the evaluator budget, repair precedes first approval, and exhaustion pauses", async (t) => {
  const dir = tempProject(t);
  const exec = fileExec(dir, { checks: standardChecks });
  let bad = true;
  // While bad, C1 passes on any fixture that has the artifact, so the reject witness survives.
  const wrapped = async (command, opts) => {
    if (bad && command === "check:c1" && fs.existsSync(path.join(opts.cwd, "feature.txt"))) return { exit: 0, stdout: "", stderr: "", timedOut: false };
    return exec(command, opts);
  };
  const { io } = testIo(dir, wrapped);
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { evaluatorAttempts: 3 } });
  const failed = await prepareNode(io);
  assert.ok(failed.diagnostics.some((d) => d.code === "REJECT_NOT_DISCRIMINATED"));
  assert.equal(failed.review, undefined);
  assert.equal((await sealNode(io, "G1", { userApproval: "Proceed" })).ok, false);
  assert.equal(loadNodeState(io, "G1").evaluatorMetrics.e0Attempts, 1);
  // Agent-repairable evaluator findings are never a reason to pause.
  const misuse = await blockNode(io, "G1", { code: "AUTHORIZATION_MISSING", reason: "Evaluator needs changes" });
  assert.match(misuse.errors[0], /only agent-repairable evaluator diagnostics \(REJECT_NOT_DISCRIMINATED\)/);
  assert.match(misuse.next, /revise G1 evaluator with exitcode_draft/);
  assert.equal(loadRoot(io, "G1").status, NodeState.ACTIVE);
  // Operational corrections remain possible after a failed E0.
  assert.equal(draftNode(makeIo(dir, { exec: wrapped }), { revise: "G1", goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, policy: { deadlineMinutes: 480, evaluatorAttempts: 3 } }).ok, true);
  assert.equal((await prepareNode(io)).ok, false);
  assert.equal((await prepareNode(io)).ok, false);
  const exhausted = await prepareNode(io);
  assert.equal(exhausted.status, "PAUSED");
  assert.equal(exhausted.pause.code, "EVALUATOR_UNBUILDABLE");
  assert.equal(loadNodeState(io, "G1").status, "DRAFT");
  assert.equal(loadRoot(io, "G1").consumedAttempts, 0);
  assert.equal(loadRoot(io, "G1").deadlineAt, null);
  bad = false;
  assert.equal(core.resumeRoot(io, { evaluatorAttempts: 1 }).ok, true);
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal((await sealNode(io, "G1", { userApproval: "Approve the recovered evaluator" })).sealed, "G1");
  assert.equal(loadNodeState(io, "G1").sealAttempts, 1);
});

test("prepare: candidate, policy, or concurrent changes during E0 invalidate the preparation", async (t) => {
  for (const phase of ["controls", "wiring", "baseline"]) {
    const dir = tempProject(t);
    const exec = fileExec(dir, { checks: standardChecks });
    let changed = false;
    const wrapped = async (command, opts) => {
      const result = await exec(command, opts);
      if (!changed && (phase === "controls" && command === "check:c1" || phase === "wiring" && fs.readdirSync(opts.cwd).length === 0 ||
        phase === "baseline" && command === "check:reg" && fs.existsSync(path.join(opts.cwd, "feature.txt")))) { changed = true; write(dir, "feature.txt", "changed"); }
      return result;
    };
    const io = makeIo(dir, { exec: wrapped });
    draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
    const p = await prepareNode(io);
    assert.ok(p.diagnostics.some((d) => d.code === "CANDIDATE_MUTATED"), phase);
    assert.equal(p.review, undefined);
    assert.equal(approveRoot(io).ok, false);
    assert.equal(exec.calls.some((c) => c.cwd === dir), false);
    // The mutated tree never survives as the next preparation's candidate.
    assert.match(p.warnings[0], /modified feature\.txt/);
    assert.equal(readText(dir, "feature.txt"), "todo\n");
  }
  const dir = tempProject(t);
  const exec = fileExec(dir, { checks: standardChecks });
  let once = false;
  const io = makeIo(dir, { exec: async (command, opts) => {
    if (!once) {
      once = true;
      assert.equal(draftNode(io, { goal: "new goal", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, revise: "G1" }).code, "OPERATION_BUSY");
      const root = loadRoot(io, "G1");
      root.policy.evalTimeoutSeconds = 1200;
      core.saveRoot(io, root);
    }
    return exec(command, opts);
  } });
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  const result = await prepareNode(io);
  assert.match(result.errors[0], /changed during preparation/);
  assert.equal(loadBundle(io, "G1"), null);
  assert.equal(JSON.parse(fs.readFileSync(draftFile(dir, "G1"), "utf8")).draft.goal, "g");
});

// ---------------------------------------------------------------------------
// Pre-seal candidate immutability
// ---------------------------------------------------------------------------

const baselineDir = (dir) => path.join(dir, ".exitcode/baseline");
const discardedSets = (dir) => fs.existsSync(path.join(dir, ".exitcode/discarded")) ? fs.readdirSync(path.join(dir, ".exitcode/discarded")).sort() : [];

test("baseline: pre-seal changes from any source are saved, restored, reported, and capped", async (t) => {
  const dir = tempProject(t, { "feature.txt": "todo\n", "docs/guide.md": "guide\n", "keep/.gitkeep": "" });
  fs.mkdirSync(path.join(dir, "empty"));
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  assert.equal(baselineScope(io), "G1");
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  const before = digestTree(dir);
  const untouched = fs.statSync(path.join(dir, "docs/guide.md")).mtimeMs;
  write(dir, "feature.txt", "done\n");
  fs.mkdirSync(path.join(dir, ".cache"));
  write(dir, ".cache/generated-index.json", "{}");
  fs.rmSync(path.join(dir, "keep/.gitkeep"));
  const prepared = await prepareNode(io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.match(prepared.warnings[0], /not permitted before the contract is sealed/);
  assert.match(prepared.warnings[0], /modified feature\.txt; added \.cache\/generated-index\.json; removed keep\/\.gitkeep/);
  assert.equal(digestTree(dir), before);
  assert.equal(loadNodeState(io, "G1").prepared.candidateDigest, before);
  assert.ok(fs.existsSync(path.join(dir, "empty")));
  assert.equal(fs.statSync(path.join(dir, "docs/guide.md")).mtimeMs, untouched, "unchanged files are not rewritten");
  const [saved] = discardedSets(dir);
  assert.ok(prepared.warnings[0].includes(`.exitcode/discarded/${saved}`));
  assert.equal(readText(dir, `.exitcode/discarded/${saved}/files/feature.txt`), "done\n");
  assert.deepEqual(JSON.parse(readText(dir, `.exitcode/discarded/${saved}/changes.json`)).removed, ["keep/.gitkeep"]);
  assert.deepEqual(enforceBaseline(io), { ok: true });
  for (let i = 0; i < MAX_DISCARDED_CHANGES + 2; i++) {
    write(dir, `stray-${i}.txt`, String(i));
    assert.equal(enforceBaseline(io).restored, true);
  }
  assert.equal(discardedSets(dir).length, MAX_DISCARDED_CHANGES);
});


test("baseline: review-time changes are discarded, sealing releases, and children and pauses freeze their own work", async (t) => {
  const dir = tempProject(t);
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  assert.equal((await prepareNode(io)).ok, true);
  write(dir, "feature.txt", "edited during review\n");
  assert.match(approveRoot(io).warnings[0], /restored to the pre-seal baseline/);
  assert.equal(readText(dir, "feature.txt"), "todo\n");
  write(dir, "late.txt", "late\n");
  assert.match((await sealNode(io, "G1")).warnings[0], /added late\.txt/);
  assert.equal(fs.existsSync(path.join(dir, "late.txt")), false);
  assert.equal(fs.existsSync(baselineDir(dir)), false);
  assert.equal(baselineScope(io), null);
  write(dir, "feature.txt", "partial\n");
  assert.deepEqual(enforceBaseline(io), { ok: true });
  assert.equal(ensureBaseline(io), null);
  // A child draft freezes the parent's work, not the root baseline.
  assert.equal(draftNode(io, childArgs()).ok, true);
  assert.equal(baselineScope(io), "G1.1");
  write(dir, "feature.txt", "rewritten before the child seals\n");
  assert.match((await sealNode(io, "G1.1")).warnings[0], /modified feature\.txt/);
  assert.equal(readText(dir, "feature.txt"), "partial\n");
  // A resumable pause freezes the work it stopped on.
  captureBaseline(io, "G1");
  write(dir, "feature.txt", "work\n");
  assert.equal((await blockNode(io, "G1.1", { reason: "Missing authorization", code: "AUTHORIZATION_MISSING" })).status, NodeState.PAUSED);
  assert.deepEqual(enforceBaseline(io), { ok: true });
  write(dir, "feature.txt", "after the block\n");
  assert.equal(enforceBaseline(io).restored, true);
  assert.equal(readText(dir, "feature.txt"), "work\n");
});

test("baseline: changes that cannot be saved or restored are never silently destroyed", async (t) => {
  const dir = tempProject(t);
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  fs.writeFileSync(path.join(dir, ".exitcode/discarded"), "not a directory");
  write(dir, "feature.txt", "unsaved\n");
  const unsaved = await prepareNode(io);
  assert.match(unsaved.errors[0], /could not be saved for recovery/);
  assert.equal(readText(dir, "feature.txt"), "unsaved\n");
  assert.equal(loadNodeState(io, "G1").evaluatorMetrics.e0Attempts, 0);
  fs.rmSync(path.join(dir, ".exitcode/discarded"));
  fs.rmSync(path.join(baselineDir(dir), "manifest.json"));
  assert.match((await prepareNode(io)).errors[0], /cannot be restored \(baseline snapshot missing\)/);
  assert.equal(readText(dir, "feature.txt"), "unsaved\n");
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal(loadNodeState(io, "G1").prepared.candidateDigest, digestTree(dir));
});

// ---------------------------------------------------------------------------
// Execution budgets and integrity
// ---------------------------------------------------------------------------

test("evaluate: only changed trees spend attempts; exhausted attempts and deadlines pause the same root", async (t) => {
  const { dir, io } = await sealedRoot(t, { policy: { maxTotalAttempts: 1 } });
  const free = await evaluateNode(io, null);
  assert.equal(free.consumedAttempt, false);
  write(dir, "feature.txt", "v2\n");
  const paid = await evaluateNode(io, null);
  assert.equal(paid.consumedAttempt, true);
  assert.equal(loadNodeState(io, "G1").attempts, 1);
  write(dir, "feature.txt", "v3\n");
  const exhausted = await evaluateNode(io, null);
  assert.equal(exhausted.status, NodeState.PAUSED);
  assert.equal(exhausted.pause.code, "BUDGET_EXHAUSTED");
  const timed = await sealedRoot(t, { policy: { deadlineMinutes: 30 } });
  timed.nowRef.now += 31 * 60 * 1000;
  write(timed.dir, "feature.txt", "late edit\n");
  assert.equal((await evaluateNode(timed.io, null)).status, NodeState.PAUSED);
  assert.equal(loadRoot(timed.io, "G1").pause.code, "DEADLINE_EXCEEDED");
  // Expiry can neither revise acceptance nor revive the budget without a user grant.
  const before = loadRoot(timed.io, "G1");
  assert.equal(draftNode(timed.io, { revise: "G1", goal: "New scope", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA }).ok, false);
  assert.equal(core.resumeRoot(timed.io).ok, false);
  assert.equal(loadRoot(timed.io, "G1").deadlineAt, before.deadlineAt);
});

test("evaluate: an own-vector regression restores the last accepted candidate; tampered bundles pause", async (t) => {
  const { dir, io } = await sealedRoot(t);
  write(dir, "feature.txt", "done BROKE\n");
  const result = await evaluateNode(io, null);
  assert.deepEqual(result.regressedRestored, ["C2"]);
  assert.equal(readText(dir, "feature.txt"), "todo\n");
  assert.equal(loadRoot(io, "G1").consumedAttempts, 1, "the attempt is kept");
  const sealedFile = path.join(dir, ".exitcode/contracts/G1.sealed.json");
  const bundle = JSON.parse(fs.readFileSync(sealedFile, "utf8"));
  bundle.contract.goal = "tampered";
  fs.writeFileSync(sealedFile, JSON.stringify(bundle));
  assert.equal((await evaluateNode(io, null)).status, NodeState.PAUSED);
  assert.equal(loadRoot(io, "G1").pause.code, "EVALUATOR_DRIFT");
  assert.match(loadRoot(io, "G1").pause.reason, /supervisor identity/);
});

// ---------------------------------------------------------------------------
// Focused recursion
// ---------------------------------------------------------------------------

test("child: gates require a failing target, a prerequisite before local repairs, one active child, novelty, and depth", async (t) => {
  const { dir, io } = await sealedRoot(t, { policy: { maxDepth: 1 } });
  assert.ok(draftNode(io, { ...childArgs(), prerequisite: undefined }).errors.some((e) => e.includes("prerequisite:true")));
  assert.ok(draftNode(io, childArgs({ target: "C2" })).errors.some((e) => e.includes("currently passes")));
  assert.equal(draftNode(io, childArgs({ goal: "same subgoal" })).id, "G1.1");
  assert.ok(draftNode(io, childArgs({ goal: "other" })).errors.some((e) => /one active child|active leaf/.test(e)));
  assert.equal((await blockNode(io, "G1.1", { reason: "No viable child path", code: "NO_PATH" })).status, NodeState.BLOCKED);
  assert.ok(draftNode(io, childArgs({ goal: "same subgoal" })).errors.some((e) => e.includes("already blocked on unchanged evidence")));
  write(dir, "feature.txt", "todo v2\n");
  await evaluateNode(io, "G1");
  assert.equal(draftNode(io, childArgs({ goal: "same subgoal" })).ok, true, "changed evidence reopens the path");
  assert.equal((await sealNode(io, "G1.2")).ok, true);
  assert.ok(draftNode(io, { ...childArgs({ parentId: "G1.2", target: "D1", criteria: [behavior("E1", "check:e1")] }) }).errors.some((e) => e.includes("maxDepth")));
});

test("child: PASS reruns the parent and only a passing parent cascades to root PASS", async (t) => {
  for (const ordered of [false, true]) await t.test(ordered ? "ordered parent" : "unordered parent", async (t) => {
    const options = ordered ? { sequence: ROOT_SEQUENCE } : {};
    const { dir, io } = await sealedRoot(t, options);
    if (ordered) {
      assert.equal(draftNode(io, childArgs({ target: "C3" })).ok, false, "future proof is not a child target despite E0 failure evidence");
      assert.equal(draftNode(io, { ...childArgs(), sequence: [{ objective: "Child", verify: ["D1"] }] }).ok, false, "children cannot submit a sequence");
    }
    assert.equal(draftNode(io, childArgs()).ok, true);
    if (ordered) assert.equal(draftNode(io, { ...childArgs(), revise: "G1.1", sequence: [{ objective: "Child", verify: ["D1"] }] }).ok, false, "child revision cannot add order");
    assert.equal((await sealNode(io, "G1.1")).ok, true);
    write(dir, "child1.txt", "ok");
    const result = await evaluateNode(io, null);
    assert.ok(result.cascade.events.some((e) => e.includes("G1.1 PASS")));
    assert.ok(result.cascade.events.some((e) => e.includes("G1 rerun: C1=FAIL C2=PASS")));
    assert.equal(result.cascade.terminal, null);
    assert.deepEqual(loadRoot(io, "G1").stack, ["G1"]);
    if (ordered) assert.equal(loadNodeState(io, "G1").sequenceIndex, 0, "child PASS does not infer parent proof");
    write(dir, "child1.txt", "ok v2");
    const reread = await evaluateNode(io, "G1.1");
    assert.equal(reread.status, NodeState.PASS);
    assert.equal(reread.stale, true, "a terminal child reports stale when the tree moved on");
    const second = await sealedRoot(t, options);
    assert.equal(draftNode(second.io, childArgs()).ok, true);
    assert.equal((await sealNode(second.io, "G1.1")).ok, true);
    write(second.dir, "child1.txt", "ok");
    write(second.dir, "feature.txt", "done\n");
    const passed = await evaluateNode(second.io, null);
    if (ordered) {
      assert.equal(passed.cascade.terminal, null, "fresh parent prefix proof is not root PASS");
      assert.equal(loadNodeState(second.io, "G1").status, "ACTIVE");
      assert.equal(loadNodeState(second.io, "G1").sequenceIndex, 1);
      assert.equal(draftNode(second.io, childArgs({ target: "C3", goal: "Unproven future" })).ok, false, "newly active proof needs a current FAIL, not missing evidence");
      assert.equal((await evaluateNode(second.io, "G1")).vector, "C1=PASS C2=PASS C3=FAIL");
      assert.equal(draftNode(second.io, childArgs({ target: "C3", goal: "Reduce the final proof" })).ok, true, "current failing proof can be reduced");
      assert.equal((await blockNode(second.io, "G1.2", { code: "NO_PATH", reason: "Withdraw this reduction" })).status, "BLOCKED");
      write(second.dir, "last.txt", "done");
      assert.equal((await evaluateNode(second.io, "G1")).cascade.terminal.status, "PASS");
    } else assert.equal(passed.cascade.terminal.status, NodeState.PASS);
  });
});

test("child: BLOCKED restores the pre-child candidate and ancestor regressions are reverted", async (t) => {
  const { dir, io } = await sealedRoot(t);
  assert.equal(draftNode(io, childArgs()).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  for (let i = 0; i < 5; i += 1) { write(dir, "feature.txt", `todo v${i}\n`); await evaluateNode(io, "G1"); }
  const parent = loadNodeState(io, "G1");
  assert.ok(parent.checkpoints.filter((c) => !c.note.startsWith("pre-child:")).length <= 3);
  assert.ok(parent.checkpoints.some((c) => c.note === "pre-child:G1.1"), "rolling cap keeps live pre-child checkpoints");
  write(dir, "child1.txt", "half-baked");
  write(dir, "feature.txt", "todo edited\n");
  const blocked = await blockNode(io, "G1.1", { reason: "This child cannot solve the targeted requirement", code: "NO_PATH" });
  assert.equal(blocked.status, NodeState.BLOCKED);
  assert.ok(blocked.events.some((e) => e.includes("restored G1 to pre-child checkpoint")));
  assert.equal(fs.existsSync(path.join(dir, "child1.txt")), false);
  assert.equal(readText(dir, "feature.txt"), "todo\n");
  assert.deepEqual(loadRoot(io, "G1").stack, ["G1"]);
  const cascade = await sealedRoot(t);
  assert.equal(draftNode(cascade.io, childArgs()).ok, true);
  assert.equal((await sealNode(cascade.io, "G1.1")).ok, true);
  write(cascade.dir, "gc.txt", "ok");
  write(cascade.dir, "feature.txt", "todo BROKE\n");
  assert.equal(draftNode(cascade.io, childArgs({ parentId: "G1.1", target: "D1", goal: "subsub", criteria: [behavior("E1", "check:e1")] })).ok, true);
  assert.equal((await sealNode(cascade.io, "G1.1.1")).ok, true);
  const completed = await evaluateNode(cascade.io, "G1.1.1");
  assert.deepEqual(completed.ancestorRegression, { ancestor: "G1", criteria: ["C2"], restored: true });
  assert.equal(fs.existsSync(path.join(cascade.dir, "gc.txt")), false);
  assert.equal(readText(cascade.dir, "feature.txt"), "todo\n");
  assert.deepEqual(loadRoot(cascade.io, "G1").stack, ["G1", "G1.1", "G1.1.1"]);
});

// ---------------------------------------------------------------------------
// Snapshots, checkpoints, identity
// ---------------------------------------------------------------------------

test("snapshots: restore changed paths only, honor caps, clean up failures, and never write outside", (t) => {
  const dir = tempProject(t, { "a.txt": "a", "b.txt": "b", "sub/c.txt": "c" });
  const outside = tempProject(t, { "c.txt": "outside" });
  fs.mkdirSync(path.join(dir, "empty"));
  const snapDir = path.join(dir, ".exitcode/tmp/snap");
  const snap = snapshotTree(dir, snapDir);
  const kept = fs.statSync(path.join(dir, "a.txt")).ino;
  fs.rmSync(path.join(dir, "b.txt"));
  fs.mkdirSync(path.join(dir, "b.txt/nested"), { recursive: true });
  write(dir, "b.txt/nested/x", "x");
  fs.rmSync(path.join(dir, "sub"), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, "sub"));
  write(dir, "new.txt", "new");
  const restored = restoreTree(dir, snapDir, snap.manifest);
  assert.deepEqual(restored.restored.sort(), ["b.txt", "sub/c.txt"]);
  assert.deepEqual(restored.removed.sort(), ["b.txt/nested/x", "new.txt", "sub"]);
  assert.equal(fs.statSync(path.join(dir, "a.txt")).ino, kept, "unchanged files are not rewritten");
  assert.equal(readText(dir, "sub/c.txt"), "c");
  assert.equal(readText(outside, "c.txt"), "outside");
  assert.ok(fs.existsSync(path.join(dir, "empty")));
  // A changed hard link is replaced, never written through.
  const external = path.join(outside, "linked");
  write(outside, "linked", "external");
  fs.unlinkSync(path.join(dir, "a.txt"));
  fs.linkSync(external, path.join(dir, "a.txt"));
  restoreTree(dir, snapDir, snap.manifest);
  assert.equal(readText(outside, "linked"), "external");
  assert.notEqual(fs.statSync(path.join(dir, "a.txt")).ino, fs.statSync(external).ino);
  // Modes and symlink targets are restored exactly.
  fs.chmodSync(path.join(dir, "b.txt"), 0o700);
  fs.symlinkSync("a.txt", path.join(dir, "link"));
  const modeSnap = snapshotTree(dir, path.join(dir, ".exitcode/tmp/modes"));
  const identity = candidateIdentity(dir);
  fs.chmodSync(path.join(dir, "b.txt"), 0o644);
  fs.unlinkSync(path.join(dir, "link"));
  fs.symlinkSync("missing", path.join(dir, "link"));
  restoreTree(dir, path.join(dir, ".exitcode/tmp/modes"), modeSnap.manifest);
  assert.equal(candidateIdentity(dir), identity);
  // Caps count all content, accept the boundary, and leave no partial copy.
  const small = tempProject(t, { "a.txt": "abc", "sub/b.txt": "def" });
  const capped = path.join(small, ".exitcode/tmp/snapshot");
  assert.equal(snapshotTree(small, capped, { maxBytes: 6 }).manifest.totalBytes, 6);
  const rejected = snapshotTree(small, capped, { maxBytes: 5 });
  assert.match(rejected.reason, /snapshot cap \(5 bytes\): 6 bytes across 2 files/);
  assert.equal(fs.existsSync(capped), false);
  fs.mkdirSync(path.join(capped, "tree"), { recursive: true });
  write(capped, "tree/sub", "blocks directory creation");
  assert.match(snapshotTree(small, capped).reason, /snapshot failed \(EEXIST\)/);
  assert.equal(fs.existsSync(capped), false);
});

test("snapshots: fixtures and checkpoints copy large trees independently and outside Git ancestry", async (t) => {
  const outer = tempProject(t, { ".git/HEAD": "ref: refs/heads/main\n" });
  const dir = path.join(outer, "project");
  for (const [rel, content] of Object.entries({ "feature.txt": "todo\n", "target/build.bin": "", ".agents/artifacts/evidence.bin": "evidence" })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    write(dir, rel, content);
  }
  const large = path.join(dir, "target/build.bin"), bytes = 65 * 1024 * 1024;
  fs.truncateSync(large, bytes);
  const before = digestTree(dir);
  const exec = fileExec(dir, { checks: standardChecks });
  const fixtures = [];
  const { io } = testIo(dir, async (command, opts) => {
    if (command === "check:c1" && fs.existsSync(path.join(opts.cwd, "target/build.bin"))) {
      fixtures.push(opts.cwd);
      assert.ok(path.relative(outer, opts.cwd).startsWith(`..${path.sep}`), "fixtures cannot discover the candidate repository");
      assert.equal(fs.statSync(path.join(opts.cwd, "target/build.bin")).size, bytes);
      assert.equal(readText(opts.cwd, ".agents/artifacts/evidence.bin"), "evidence");
      assert.equal(fs.existsSync(path.join(opts.cwd, ".exitcode")), false);
      fs.truncateSync(path.join(opts.cwd, "target/build.bin"), 1);
      assert.equal(fs.statSync(large).size, bytes, "fixture writes must not affect the candidate");
    }
    return exec(command, opts);
  });
  draftNode(io, { goal: "Large candidate", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA });
  assert.equal((await prepareNode(io)).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.deepEqual((await sealNode(io, "G1")).warnings, []);
  assert.equal(digestTree(dir), before);
  assert.ok(fixtures.length >= 2 && fixtures.every((fixture) => !fs.existsSync(fixture)));
  const checkpoint = loadNodeState(io, "G1").checkpoints[0].dir;
  const manifest = JSON.parse(fs.readFileSync(path.join(checkpoint, "manifest.json"), "utf8"));
  assert.ok(manifest.totalBytes > 64 * 1024 * 1024 && manifest.totalBytes <= SNAPSHOT_MAX_BYTES);
  fs.truncateSync(large, 7);
  assert.equal(restoreTree(dir, checkpoint, manifest).ok, true);
  assert.equal(digestTree(dir), before);
  fs.truncateSync(large, 9);
  assert.equal(fs.statSync(path.join(checkpoint, "tree/target/build.bin")).size, bytes, "restored writes must not affect the checkpoint");
});

test("identity: candidate digests cover full content, modes, symlinks, and dependencies but not supervisor state", (t) => {
  const dir = tempProject(t, { "a.txt": "a" });
  const before = digestTree(dir);
  fs.mkdirSync(path.join(dir, ".exitcode/x"), { recursive: true });
  write(dir, ".exitcode/x/y.json", "{}");
  assert.equal(digestTree(dir), before);
  fs.mkdirSync(path.join(dir, "node_modules/z"), { recursive: true });
  write(dir, "node_modules/z/y.js", "1");
  assert.notEqual(digestTree(dir), before);
  const file = path.join(dir, "large");
  fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024));
  const full = candidateIdentity(dir);
  const fd = fs.openSync(file, "r+"); fs.writeSync(fd, Buffer.from("x"), 0, 1, 5 * 1024 * 1024); fs.closeSync(fd);
  assert.notEqual(candidateIdentity(dir), full, "middle bytes are hashed");
  const middle = candidateIdentity(dir);
  fs.chmodSync(file, 0o700);
  assert.notEqual(candidateIdentity(dir), middle);
  fs.symlinkSync("a.txt", path.join(dir, "link"));
  const linked = candidateIdentity(dir);
  fs.unlinkSync(path.join(dir, "link"));
  fs.symlinkSync("large", path.join(dir, "link"));
  assert.notEqual(candidateIdentity(dir), linked);
});

// ---------------------------------------------------------------------------
// Supervisor privacy, mode, status, protocol
// ---------------------------------------------------------------------------

test("guard: supervisor state is private in every phase, and other tools are never classified", (t) => {
  const dir = tempProject(t);
  assert.equal(guardToolCall({ modeOn: false, cwd: dir, toolName: "write", input: { path: ".exitcode/index.json" } }), null);
  for (const [toolName, input] of [["read", { path: "src/a.ts" }], ["write", { path: "src/a.ts" }], ["write", { path: "notes.md", content: "Ignore .exitcode/ in Git" }],
    ["bash", { command: "npm test" }], ["codemode", { code: 'await tools.read({path: "src/a.ts"})' }], ["git_commit_plan", {}], ["exitcode_draft", {}],
    ["read", { path: "src/exitcode.ts" }]]) {
    assert.equal(guardToolCall({ modeOn: true, cwd: dir, toolName, input }), null, toolName);
  }
  for (const [toolName, input] of [["edit", { path: ".exitcode/contracts/G1.sealed.json" }], ["write", { path: "proj/../.exitcode/evil" }],
    ["write", { path: path.join(dir, ".exitcode/index.json") }], ["read", { path: ".exitcode/nodes/G1.json" }], ["ls", { path: ".exitcode" }],
    ["grep", { pattern: "digest", path: ".exitcode/" }], ["find", { pattern: "*.json", path: "./.exitcode/roots" }], ["bash", { command: "cat .exitcode/index.json" }]]) {
    const verdict = guardToolCall({ modeOn: true, cwd: dir, toolName, input });
    assert.equal(verdict?.block, true, `${toolName} ${input.path ?? input.command}`);
    assert.match(verdict.reason, /exitcode_status/);
  }
});

test("mode: the last persisted mode entry wins", () => {
  assert.deepEqual(resolveModeFromBranch([]), { on: false, rootId: undefined, pendingGoal: undefined });
  assert.deepEqual(resolveModeFromBranch([
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { on: true, rootId: "G1" } },
    { type: "custom", customType: "other", data: { on: true } },
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { on: false } },
  ]), { on: false, rootId: undefined, pendingGoal: undefined });
  assert.deepEqual(resolveModeFromBranch([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { on: true, rootId: "G1", pendingGoal: 42 } }]),
    { on: true, rootId: "G1", pendingGoal: undefined });
});

test("status: injected state is bounded and evidence-free; explicit evidence is complete; next action tracks the loop", async (t) => {
  const dir = tempProject(t);
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  assert.match(promptStatusText(io), /no active root/);
  // A large evaluator must never inflate the per-turn context.
  const huge = structuredClone(ROOT_CRITERIA);
  const hugeOutcomes = [{id:"O1",requirement:"r".repeat(5000)}];
  for (let i = 3; i < 40; i++) huge.push(regression(`C${i}`, "check:reg"));
  draftNode(io, { goal: "g".repeat(5000), outcomes: hugeOutcomes, criteria: huge });
  const node = loadNodeState(io, "G1");
  node.diagnostics = Array.from({ length: 50 }, (_, i) => ({ code: "REJECT_NOT_DISCRIMINATED", criterionId: "C1", evidence: "x".repeat(10000), recommendedRepair: "fix" }));
  core.saveNodeState(io, node);
  const prompt = promptStatusText(io);
  assert.ok(Buffer.byteLength(prompt) <= PROMPT_STATUS_MAX_BYTES, `${Buffer.byteLength(prompt)} bytes`);
  assert.match(prompt, /next: /);
  assert.doesNotMatch(prompt, /check:c1|write_file|evaluator evidence|"contract"/);
  assert.doesNotMatch(statusText(io), /evaluator evidence|check:c1/);
  assert.match(statusText(io, { detail: "evidence" }), /check:c1/);
  // The loop position drives the next action.
  draftNode(io, { goal: "g", outcomes: ROOT_OUTCOMES, criteria: ROOT_CRITERIA, revise: "G1" });
  assert.match(statusSnapshot(io).next, /revise G1 evaluator with exitcode_draft/);
  assert.equal((await prepareNode(io)).ok, true);
  assert.match(promptStatusText(io), /awaiting the user's reply/);
  assert.match(statusSnapshot(io).review, /Verification\n- C1: an isolated custom command; baseline FAIL, witness PASS, rejected 1 negative\./);
  assert.match(statusSnapshot(io).review, /Semantic critic: pass/);
  assert.match(statusSnapshot(io).review, /Mechanical evaluator validation: PASS/);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  assert.match(promptStatusText(io), /G1 ACTIVE :: C1=FAIL C2=PASS/);
  assert.match(statusText(io), /0\/12 attempts/);
  assert.match(statusSnapshot(io).next, /repair G1 to achieve its goal; use failures \[C1\] as feedback/);
  write(dir, "feature.txt", "v2\n"); await evaluateNode(io, null);
  write(dir, "feature.txt", "v3\n"); await evaluateNode(io, null);
  assert.match(statusSnapshot(io).next, /exitcode_child targeting one of \[C1\], subject to supervisor gates/);
  assert.match(nextAction({ policy: DEFAULT_POLICY }, { id: "G1.1", parentId: "G1", status: NodeState.DRAFT }), /seal G1\.1 with exitcode_seal/);
  const ordered = await sealedRoot(t, { sequence: ROOT_SEQUENCE });
  for (const text of [promptStatusText(ordered.io), statusText(ordered.io)]) {
    assert.match(text, /slice 1\/2: Establish the first proof/);
    assert.match(text, /proof: C1=FAIL C2=PASS/);
    assert.doesNotMatch(text, /C3=FAIL|check:c1|write_file/);
  }
  assert.match(statusSnapshot(ordered.io).next, /Establish the first proof/);
  assert.doesNotMatch(statusSnapshot(ordered.io).next, /C3/);
  write(ordered.dir, "feature.txt", "done\n");
  await evaluateNode(ordered.io, "G1");
  for (const text of [promptStatusText(ordered.io), statusText(ordered.io)]) {
    assert.match(text, /slice 2\/2: Finish the last proof/);
    assert.match(text, /proof: C1=PASS C2=PASS C3=(?:PENDING|NOT_RUN)/, "newly active proof is explicitly unproven");
  }
  assert.match(statusSnapshot(ordered.io).next, /Finish the last proof/);
  assert.match(statusSnapshot(ordered.io).next, /evaluate/, "a new slice requires fresh evidence before child reduction");
  await evaluateNode(ordered.io, "G1");
  assert.match(promptStatusText(ordered.io), /proof: C1=PASS C2=PASS C3=FAIL/);
  assert.match(statusSnapshot(ordered.io).next, /\[C3\]/);
  assert.ok(Buffer.byteLength(promptStatusText(ordered.io)) <= PROMPT_STATUS_MAX_BYTES);
});

test("protocol: the injected protocol explains only the loop", () => {
  assert.ok(Buffer.byteLength(PROTOCOL_PROMPT) < 1200, `${Buffer.byteLength(PROTOCOL_PROMPT)} bytes`);
  assert.match(PROTOCOL_PROMPT, /Before implementation/);
  assert.match(PROTOCOL_PROMPT, /user approves the plan/);
  assert.match(PROTOCOL_PROMPT, /fresh root PASS/);
});
