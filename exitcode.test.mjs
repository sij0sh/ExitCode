import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  BLOCK_CODES,
  DEFAULT_POLICY,
  MAX_DRAFT_PROPOSALS,
  MODE_ENTRY_TYPE,
  NodeState,
  PROTOCOL_PROMPT,
  SNAPSHOT_MAX_BYTES,
  allPass,
  assignCriterionIds,
  approveRoot,
  draftFile,
  rootReviewText,
  blockNode,
  budgetsOk,
  childGates,
  depthOf,
  detectRegression,
  digestTree,
  draftNode,
  evaluateNode,
  execCommand,
  fingerprintGoal,
  formatVector,
  guardToolCall,
  isValidNodeId,
  loadBundle,
  loadNodeState,
  loadRoot,
  makeIo,
  matchesExpect,
  nextAction,
  resolveModeFromBranch,
  restoreTree,
  runGate,
  sealNode,
  sha256Hex,
  snapshotTree,
  stableStringify,
  statusSnapshot,
  statusText,
  terminalStale,
  validateStructure,
} from "./exitcode-core.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const behavior = (id, cmd) => ({
  id,
  requirement: `requirement ${id}`,
  check: { command: cmd },
  controls: { accept: { setup: `accept:${id}` }, reject: [{ setup: `reject:${id}`, reason: `broken ${id}` }] },
});

const regression = (id, cmd) => ({
  id,
  requirement: `requirement ${id}`,
  type: "regression",
  check: { command: cmd },
});

function rootDraft(overrides = {}) {
  return {
    version: 1,
    id: "G1",
    goal: "Add the thing",
    originalRequest: "user: add the thing",
    parent: null,
    criteria: [behavior("C1", "check:c1"), regression("C2", "check:reg")],
    ...overrides,
  };
}

/** Fake exec: setups mutate fixtures; checks always read the supplied cwd. */
function fileExec(dir, { checks = {}, accepts = {}, rejects = {} } = {}) {
  const fixtures = {
    C1: { file: "feature.txt", valid: "done\n", invalid: "todo\n" },
    D1: { file: "child1.txt", valid: "ok", invalid: "bad" },
    E1: { file: "gc.txt", valid: "ok", invalid: "bad" },
  };
  const fn = async (command, { cwd, timeoutMs }) => {
    fn.calls.push({ command, cwd, timeoutMs });
    const read = (rel) => {
      try {
        return fs.readFileSync(path.join(cwd, rel), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    };
    if (command.startsWith("accept:") || command.startsWith("reject:")) {
      assert.notEqual(cwd, dir, "control setup must not run on the real candidate");
      const accept = command.startsWith("accept:");
      const fixture = fixtures[command.split(":")[1]];
      const { content = accept ? fixture.valid : fixture.invalid, ...result } = (accept ? accepts : rejects)[command] ?? {};
      fs.writeFileSync(path.join(cwd, fixture.file), content);
      return { exit: 0, stdout: "setup", stderr: "", timedOut: false, ...result };
    }
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

function tempProject(files = { "feature.txt": "todo\n" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exitcode-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function testIo(dir, exec, nowRef = { now: Date.now() }) {
  return { io: makeIo(dir, { exec, nowMs: () => nowRef.now }), nowRef };
}

const ROOT_CRITERIA = [behavior("C1", "check:c1"), regression("C2", "check:reg")];

async function sealedRoot(dir, exec, nowRef, criteria = ROOT_CRITERIA) {
  const { io } = testIo(dir, exec, nowRef);
  const draft = draftNode(io, { goal: "Add the thing", criteria });
  assert.equal(draft.ok, true);
  assert.equal(approveRoot(io).ok, true);
  const seal = await sealNode(io, draft.id);
  assert.equal(seal.ok, true);
  return { io, rootId: draft.id };
}

// ---------------------------------------------------------------------------
// Structure validation
// ---------------------------------------------------------------------------

test("validateStructure: accepts a valid root draft", () => {
  const result = validateStructure(rootDraft(), { policy: DEFAULT_POLICY });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateStructure: rejects duplicate criterion ids", () => {
  const result = validateStructure(rootDraft({ criteria: [behavior("C1", "a"), behavior("C1", "b")] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("duplicate criterion id C1")));
});

test("validateStructure: rejects behavior criteria without controls", () => {
  const bare = { id: "C1", requirement: "r", check: { command: "c" } };
  const result = validateStructure(rootDraft({ criteria: [bare, regression("C2", "r")] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("require controls")));
});

test("validateStructure: rejects roots without a regression criterion", () => {
  const result = validateStructure(rootDraft({ criteria: [behavior("C1", "c")] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("regression")));
});

test("validateStructure: rejects empty goal and missing original request", () => {
  const noGoal = validateStructure(rootDraft({ goal: "  " }));
  assert.equal(noGoal.ok, false);
  const noRequest = validateStructure(rootDraft({ originalRequest: "" }));
  assert.equal(noRequest.ok, false);
  assert.ok(noRequest.errors.some((e) => e.includes("originalRequest")));
});

test("validateStructure: child must target an existing failing parent criterion", () => {
  const parent = { contract: rootDraft() };
  const unknown = validateStructure(
    { version: 1, id: "G1.1", goal: "g", originalRequest: "r", parent: { id: "G1", targets: ["C9"] }, criteria: [behavior("C1", "c")] },
    { parent, parentDepth: 0, parentLastResult: null, policy: DEFAULT_POLICY },
  );
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.includes("C9")));

  const passing = validateStructure(
    { version: 1, id: "G1.1", goal: "g", originalRequest: "r", parent: { id: "G1", targets: ["C1"] }, criteria: [behavior("C1", "c")] },
    {
      parent,
      parentDepth: 0,
      parentLastResult: { outcomes: [{ criterionId: "C1", status: "PASS" }] },
      policy: DEFAULT_POLICY,
    },
  );
  assert.equal(passing.ok, false);
  assert.ok(passing.errors.some((e) => e.includes("currently passes")));
});

test("validateStructure: rejects children beyond maxDepth", () => {
  const parent = { contract: rootDraft() };
  const result = validateStructure(
    { version: 1, id: "G1.1", goal: "g", originalRequest: "r", parent: { id: "G1", targets: ["C1"] }, criteria: [behavior("C1", "c")] },
    { parent, parentDepth: 3, parentLastResult: null, policy: DEFAULT_POLICY },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("maxDepth")));
});

test("assignCriterionIds: fills C1..Cn while keeping suggested ids", () => {
  const out = assignCriterionIds([{ requirement: "a" }, { id: "C9", requirement: "b" }, { requirement: "c" }]);
  assert.deepEqual(out.map((c) => c.id), ["C1", "C9", "C2"]);
});

test("stableStringify: roundtrips nested objects with sorted keys", () => {
  const value = { b: 1, a: [{ y: 2, x: 1 }, "s", null, 3], c: { n: { m: [] } } };
  const text = stableStringify(value);
  assert.deepEqual(JSON.parse(text), value);
  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'));
  assert.equal(sha256Hex(stableStringify({ a: 1, b: 2 })), sha256Hex(stableStringify({ b: 2, a: 1 })));
});

test("node id helpers behave", () => {
  assert.equal(isValidNodeId("G1"), true);
  assert.equal(isValidNodeId("G1.2.3"), true);
  assert.equal(isValidNodeId("G"), false);
  assert.equal(isValidNodeId("C1"), false);
  assert.equal(depthOf("G1"), 0);
  assert.equal(depthOf("G1.1"), 1);
  assert.equal(fingerprintGoal("  x  "), fingerprintGoal("x"));
});

// ---------------------------------------------------------------------------
// Expectation predicate
// ---------------------------------------------------------------------------

test("matchesExpect: exit, substrings, timeouts, and runner errors", () => {
  assert.equal(matchesExpect({ exit: 0, stdout: "hello", timedOut: false }, { exit: 0 }).pass, true);
  assert.equal(matchesExpect({ exit: 0, stdout: "", timedOut: false }, undefined).pass, true);
  const mismatch = matchesExpect({ exit: 1, stdout: "", timedOut: false }, { exit: 0 });
  assert.equal(mismatch.pass, false);
  assert.ok(mismatch.reasons[0].includes("exit 1"));
  assert.equal(matchesExpect({ exit: 0, stdout: "abc", timedOut: false }, { stdoutContains: ["b"] }).pass, true);
  assert.equal(matchesExpect({ exit: 0, stdout: "abc", timedOut: false }, { stdoutContains: ["z"] }).pass, false);
  assert.equal(matchesExpect({ exit: 0, stdout: "abc", timedOut: false }, { stdoutNotContains: ["z"] }).pass, true);
  assert.equal(matchesExpect({ exit: 0, stdout: "abc", timedOut: false }, { stdoutNotContains: ["b"] }).pass, false);
  assert.equal(matchesExpect({ exit: null, stdout: "", timedOut: true }, {}).pass, false);
  assert.equal(matchesExpect({ exit: null, stdout: "", timedOut: false, error: "boom" }, {}).pass, false);
});

test("detectRegression and formatVector", () => {
  const prev = [{ criterionId: "C1", status: "PASS" }, { criterionId: "C2", status: "FAIL" }];
  const next = [{ criterionId: "C1", status: "FAIL" }, { criterionId: "C2", status: "PASS" }];
  assert.deepEqual(detectRegression(prev, next), ["C1"]);
  assert.deepEqual(detectRegression(prev, prev), []);
  assert.equal(formatVector(next), "C1=FAIL C2=PASS");
  assert.equal(allPass(next), false);
  assert.equal(allPass([{ status: "PASS" }]), true);
});

// ---------------------------------------------------------------------------
// Evaluator gate (E0)
// ---------------------------------------------------------------------------

test("runGate: rejects when the accept control fails the check", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks, accepts: { "accept:C1": { content: "todo\n" } } });
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), {
    exec,
    cwd: dir,
    wiringDir: path.join(dir, ".exitcode", "tmp", "w1"),
    candidateDigest: digestTree(dir),
    env: {},
    defaultTimeoutMs: 5000,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("C1") && e.includes("accept control")));
});

test("runGate: rejects when a reject control passes the check", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks, rejects: { "reject:C1": { content: "done\n" } } });
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), {
    exec,
    cwd: dir,
    wiringDir: path.join(dir, ".exitcode", "tmp", "w1"),
    candidateDigest: digestTree(dir),
    env: {},
    defaultTimeoutMs: 5000,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("C1") && e.includes("reject control")));
});

test("runGate: rejects checks that pass against an empty target", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: { ...standardChecks, "check:reg": () => true } });
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), {
    exec,
    cwd: dir,
    wiringDir: path.join(dir, ".exitcode", "tmp", "w1"),
    candidateDigest: digestTree(dir),
    env: {},
    defaultTimeoutMs: 5000,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("empty target")));
});

test("runGate: seals the exact bundle with digest, env, and baseline", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), {
    exec,
    cwd: dir,
    wiringDir: path.join(dir, ".exitcode", "tmp", "w1"),
    candidateDigest: digestTree(dir),
    env: { platform: "test" },
    defaultTimeoutMs: 5000,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.bundle.digest.length, 64);
  assert.equal(gate.bundle.candidateDigest, digestTree(dir));
  assert.deepEqual(gate.bundle.env, { platform: "test" });
  assert.equal(formatVector(gate.baseline.outcomes), "C1=FAIL C2=PASS");
  assert.equal(gate.baseline.allPass, false);
});

test("runGate: never executes probes for structurally invalid drafts", async () => {
  const dir = tempProject();
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return { exit: 0, stdout: "", stderr: "", timedOut: false };
  };
  const draft = rootDraft({ criteria: [] });
  const gate = await runGate(draft, validateStructure(draft), {
    exec,
    cwd: dir,
    wiringDir: path.join(dir, ".exitcode", "tmp", "w1"),
    candidateDigest: digestTree(dir),
    env: {},
    defaultTimeoutMs: 5000,
  });
  assert.equal(gate.ok, false);
  assert.equal(calls, 0);
});

function gateDeps(dir, exec) {
  return {
    exec,
    cwd: dir,
    wiringDir: path.join(dir, ".exitcode", "tmp", "wiring"),
    candidateDigest: digestTree(dir),
    env: {},
    defaultTimeoutMs: 5000,
  };
}

test("validateStructure: requires setup strings, not legacy verdict commands", () => {
  for (const controls of [
    { accept: { command: "true" }, reject: [{ command: "false" }] },
    { accept: { setup: " " }, reject: [{ setup: "" }] },
  ]) {
    const draft = rootDraft();
    draft.criteria[0].controls = controls;
    const result = validateStructure(draft);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("controls.accept.setup")));
    assert.ok(result.errors.some((e) => e.includes("controls.reject[0].setup")));
  }
});

test("runGate: refuses a stale candidate digest before executing commands", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const deps = gateDeps(dir, exec);
  fs.writeFileSync(path.join(dir, "feature.txt"), "changed\n");
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), deps);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.errors, ["candidate mutated during evaluator validation"]);
  assert.equal(exec.calls.length, 0);
});

test("runGate: snapshot cap failures stop probes without touching the candidate", async (t) => {
  const dir = tempProject();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large.bin");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, SNAPSHOT_MAX_BYTES + 1);
  const exec = fileExec(dir, { checks: standardChecks });
  const deps = gateDeps(dir, exec);
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), deps);
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("snapshot cap")));
  assert.equal(exec.calls.length, 0);
  assert.equal(digestTree(dir), deps.candidateDigest);
});

test("seal: fixtures and checkpoints accept trees above the old 64 MiB cap", async (t) => {
  const dir = tempProject({ "feature.txt": "todo\n", "Cargo.toml": "[package]\n", "Cargo.lock": "locked\n",
    "target/build.bin": "", ".agents/artifacts/evidence.bin": "evidence", "fixtures/valid.txt": "valid\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const large = path.join(dir, "target/build.bin");
  const bytes = 65 * 1024 * 1024;
  fs.truncateSync(large, bytes);
  const before = digestTree(dir);
  const exec = fileExec(dir, { checks: standardChecks });
  const fixtures = [];
  const { io } = testIo(dir, async (command, opts) => {
    if (command.startsWith("accept:") || command.startsWith("reject:")) {
      fixtures.push(opts.cwd);
      assert.equal(fs.statSync(path.join(opts.cwd, "target/build.bin")).size, bytes);
      assert.notEqual(fs.statSync(path.join(opts.cwd, "target/build.bin")).ino, fs.statSync(large).ino);
      assert.equal(fs.readFileSync(path.join(opts.cwd, "Cargo.lock"), "utf8"), "locked\n");
      assert.equal(fs.readFileSync(path.join(opts.cwd, ".agents/artifacts/evidence.bin"), "utf8"), "evidence");
      assert.equal(fs.readFileSync(path.join(opts.cwd, "fixtures/valid.txt"), "utf8"), "valid\n");
      assert.equal(fs.existsSync(path.join(opts.cwd, ".exitcode")), false);
      fs.truncateSync(path.join(opts.cwd, "target/build.bin"), 1);
      assert.equal(fs.statSync(large).size, bytes, "fixture writes must not affect the candidate");
    }
    return exec(command, opts);
  });
  const drafted = draftNode(io, { goal: "Large candidate", criteria: ROOT_CRITERIA });
  assert.equal(drafted.ok, true);
  assert.equal(approveRoot(io).ok, true);
  const sealed = await sealNode(io, drafted.id);
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  assert.deepEqual(sealed.warnings, []);
  assert.equal(digestTree(dir), before);
  assert.equal(new Set(fixtures).size, 2);
  assert.equal(fixtures.every((fixture) => !fs.existsSync(fixture)), true);
  const node = loadNodeState(io, drafted.id);
  assert.equal(node.checkpoints.length, 1);
  const checkpoint = node.checkpoints[0].dir;
  const manifest = JSON.parse(fs.readFileSync(path.join(checkpoint, "manifest.json"), "utf8"));
  assert.ok(manifest.totalBytes > 64 * 1024 * 1024);
  assert.ok(manifest.totalBytes <= SNAPSHOT_MAX_BYTES);
  fs.truncateSync(large, 7);
  fs.writeFileSync(path.join(dir, "feature.txt"), "changed\n");
  const restored = restoreTree(dir, checkpoint, manifest);
  assert.equal(restored.ok, true);
  assert.equal(digestTree(dir), before);
  fs.truncateSync(large, 9);
  assert.equal(fs.statSync(path.join(checkpoint, "target/build.bin")).size, bytes,
    "restored writes must not affect the checkpoint");
});

test("runGate: fixture copies cannot discover an enclosing candidate Git repository", async (t) => {
  const outer = tempProject({ ".git/HEAD": "ref: refs/heads/main\n",
    "nested/.git": "gitdir: ../.git\n", "nested/project/feature.txt": "todo\n" });
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const dir = path.join(outer, "nested/project");
  const exec = fileExec(dir, { checks: standardChecks });
  const fixtures = [];
  const draft = rootDraft();
  const gate = await runGate(draft, validateStructure(draft), gateDeps(dir, async (command, opts) => {
    if (command.startsWith("accept:") || command.startsWith("reject:")) {
      fixtures.push(opts.cwd);
      assert.ok(path.relative(outer, opts.cwd).startsWith(`..${path.sep}`));
      assert.equal(fs.statSync(opts.cwd).dev, fs.statSync(dir).dev);
    }
    return exec(command, opts);
  }));
  assert.equal(gate.ok, true, gate.errors.join("; "));
  assert.equal(fixtures.every((fixture) => !fs.existsSync(fixture)), true);
});

test("runGate: setup success is independent of the check's expectation", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const draft = rootDraft();
  draft.criteria[0].check.expect = { stdoutContains: ["pass"], stdoutNotContains: ["setup"] };
  const gate = await runGate(draft, validateStructure(draft), gateDeps(dir, exec));
  assert.equal(gate.ok, true, gate.errors.join("; "));
  const setups = exec.calls.filter((c) => c.command.startsWith("accept:") || c.command.startsWith("reject:"));
  assert.equal(new Set(setups.map((c) => c.cwd)).size, 2);
  for (const setup of setups) {
    const index = exec.calls.indexOf(setup);
    assert.equal(exec.calls[index + 1].command, draft.criteria[0].check.command);
    assert.equal(exec.calls[index + 1].cwd, setup.cwd);
    assert.equal(fs.existsSync(setup.cwd), false, "fixture must be cleaned up");
  }
});

test("runGate: failed, timed-out, and throwing setups are never rejection evidence", async () => {
  for (const failure of [{ exit: 1 }, { timedOut: true }, { error: "unavailable" }, "throw"]) {
    const dir = tempProject();
    const exec = fileExec(dir, { checks: standardChecks });
    let fixture;
    const wrapped = async (command, opts) => {
      if (command === "reject:C1") {
        fixture = opts.cwd;
        if (failure === "throw") throw new Error("setup broke");
        return { exit: 0, stdout: "", stderr: "", ...failure };
      }
      return exec(command, opts);
    };
    const draft = rootDraft();
    const gate = await runGate(draft, validateStructure(draft), gateDeps(dir, wrapped));
    assert.equal(gate.ok, false);
    assert.ok(gate.errors.some((e) => e.includes("reject control setup")));
    assert.equal(exec.calls.some((c) => c.cwd === fixture), false, "do not check an unprepared fixture");
    assert.equal(fs.existsSync(fixture), false);
  }
});

test("runGate: evaluator ERROR on an invalid fixture cannot count as FAIL", async () => {
  for (const failure of [{ timedOut: true }, { error: "runner unavailable" }, "throw"]) {
    const dir = tempProject();
    const exec = fileExec(dir, { checks: standardChecks });
    let fixture;
    const wrapped = async (command, opts) => {
      if (command === "reject:C1") fixture = opts.cwd;
      if (command === "check:c1" && opts.cwd === fixture) {
        if (failure === "throw") throw new Error("runner broke");
        return { exit: 1, stdout: "", stderr: "", ...failure };
      }
      return exec(command, opts);
    };
    const draft = rootDraft();
    const gate = await runGate(draft, validateStructure(draft), gateDeps(dir, wrapped));
    assert.equal(gate.ok, false);
    assert.ok(gate.errors.some((e) => e.includes("reject control check is ERROR, wanted FAIL")));
    assert.equal(fs.existsSync(fixture), false);
  }
});

test("runGate: real shell checks discriminate independent candidate copies", async (t) => {
  const dir = tempProject({
    "feature.txt": "todo\n",
    "manifest.json": '{"candidate":true}\n',
    "fixtures/accept.sh": '#!/bin/sh\ntest "$(cat feature.txt)" = todo || exit 1\nprintf "done\\n" > feature.txt\nprintf accept > accept-only.txt\n',
    "fixtures/reject.sh": '#!/bin/sh\ntest "$(cat feature.txt)" = todo || exit 1\ntest ! -e accept-only.txt || exit 1\nprintf "invalid\\n" > feature.txt\n',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(path.join(dir, "fixtures/accept.sh"), 0o755);
  fs.chmodSync(path.join(dir, "fixtures/reject.sh"), 0o755);
  const draft = rootDraft({ criteria: [
    {
      id: "C1", requirement: "feature is done",
      check: { command: 'test "$(cat feature.txt)" = done && cat manifest.json', expect: { stdoutContains: ['"candidate":true'] }, timeoutSeconds: 2 },
      controls: {
        accept: { setup: "./fixtures/accept.sh" },
        reject: [
          { setup: "./fixtures/reject.sh", reason: "wrong feature content" },
          { setup: "rm feature.txt", reason: "missing feature" },
        ],
      },
    },
    regression("C2", "test -f feature.txt"),
  ] });
  const calls = [];
  const exec = async (command, opts) => {
    calls.push({ command, ...opts });
    return execCommand(command, opts);
  };
  const deps = gateDeps(dir, exec);
  const gate = await runGate(draft, validateStructure(draft), deps);
  assert.equal(gate.ok, true, gate.errors.join("; "));
  assert.equal(gate.baseline.allPass, false);
  assert.equal(gate.bundle.candidateDigest, deps.candidateDigest);
  assert.equal(gate.baseline.candidateDigest, deps.candidateDigest);
  assert.equal(digestTree(dir), deps.candidateDigest);
  assert.equal(fs.readFileSync(path.join(dir, "feature.txt"), "utf8"), "todo\n");
  const setups = calls.filter((c) => draft.criteria[0].controls.accept.setup === c.command || draft.criteria[0].controls.reject.some((r) => r.setup === c.command));
  assert.equal(new Set(setups.map((c) => c.cwd)).size, 3);
  for (const setup of setups) {
    assert.notEqual(setup.cwd, dir);
    assert.equal(setup.timeoutMs, 2000);
    assert.equal(fs.existsSync(setup.cwd), false);
    const check = calls[calls.indexOf(setup) + 1];
    assert.equal(check.command, draft.criteria[0].check.command);
    assert.equal(check.cwd, setup.cwd);
  }
});

test("runGate: a file-existence evaluator cannot detect an invalid file", async (t) => {
  const dir = tempProject();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const draft = rootDraft();
  draft.criteria[0].check.command = "test -f feature.txt";
  draft.criteria[0].controls = {
    accept: { setup: "printf done > feature.txt" },
    reject: [{ setup: "printf invalid > feature.txt", reason: "feature is incorrect" }],
  };
  const gate = await runGate(draft, validateStructure(draft), gateDeps(dir, execCommand));
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("reject control check is PASS, wanted FAIL")));
});

test("runGate: true/false verdict commands do not establish discrimination", async (t) => {
  const dir = tempProject();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const draft = rootDraft();
  draft.criteria[0].check.command = "test -f feature.txt";
  draft.criteria[0].controls = { accept: { setup: "true" }, reject: [{ setup: "false" }] };
  const gate = await runGate(draft, validateStructure(draft), gateDeps(dir, execCommand));
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("reject control setup FAIL")));
});

test("seal: real candidate mutations during controls, wiring, or baseline prevent sealing", async () => {
  for (const phase of ["controls", "wiring", "baseline"]) {
    const dir = tempProject();
    const exec = fileExec(dir, { checks: standardChecks });
    const wrapped = async (command, opts) => {
      const result = await exec(command, opts);
      if ((phase === "controls" && command === "reject:C1") ||
          (phase === "wiring" && command === "check:c1" && fs.readdirSync(opts.cwd).length === 0) ||
          (phase === "baseline" && opts.cwd === dir)) {
        fs.writeFileSync(path.join(dir, "feature.txt"), "candidate changed\n");
      }
      return result;
    };
    const { io } = testIo(dir, wrapped);
    assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
    assert.equal(approveRoot(io).ok, true);
    const seal = await sealNode(io, "G1");
    assert.equal(seal.ok, false, phase);
    assert.ok(seal.errors.includes("candidate mutated during evaluator validation"));
    assert.equal(loadBundle(io, "G1"), null);
    const node = loadNodeState(io, "G1");
    assert.equal(node.status, NodeState.DRAFT);
    assert.equal(node.checkpoints.length, 0);
    assert.equal(exec.calls.some((c) => c.cwd === dir), phase === "baseline");
    for (const call of exec.calls.filter((c) => c.cwd !== dir)) {
      assert.equal(fs.existsSync(call.cwd), false);
    }
  }
});

// ---------------------------------------------------------------------------
// Draft / seal flows
// ---------------------------------------------------------------------------

test("draft + seal: root becomes ACTIVE with a recorded baseline", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }), nowRef);
  const draft = draftNode(io, { goal: "Add the thing", criteria: ROOT_CRITERIA });
  assert.equal(draft.ok, true);
  assert.equal(draft.id, "G1");
  assert.equal(approveRoot(io).ok, true);
  const seal = await sealNode(io, "G1");
  assert.equal(seal.ok, true);
  assert.equal(seal.baseline, "C1=FAIL C2=PASS");
  assert.equal(loadNodeState(io, "G1").status, NodeState.ACTIVE);
  assert.ok(loadBundle(io, "G1").digest);
});

test("draft: second root draft suggests revise instead of proliferating nodes", async () => {
  const dir = tempProject();
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  const again = draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  assert.equal(again.ok, false);
  assert.ok(again.errors.some((e) => e.includes('revise:"G1"')));
});

test("draft: sealed root blocks a new root until terminal", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  await sealedRoot(dir, exec, nowRef);
  const { io } = testIo(dir, exec, nowRef);
  const again = draftNode(io, { goal: "other", criteria: ROOT_CRITERIA });
  assert.equal(again.ok, false);
  assert.ok(again.errors.some((e) => e.includes("still ACTIVE")));
});

test("seal: gate failure consumes a proposal; revise + seal succeeds", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  // The reject setup makes a valid fixture at first, then behaves after revise.
  let rejectPasses = true;
  const exec = fileExec(dir, {
    checks: standardChecks,
    rejects: {},
  });
  const wrapped = async (command, opts) => {
    if (command === "reject:C1" && rejectPasses) {
      fs.writeFileSync(path.join(opts.cwd, "feature.txt"), "done\n");
      return { exit: 0, stdout: "", stderr: "", timedOut: false };
    }
    return exec(command, opts);
  };
  const { io } = testIo(dir, wrapped, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  const first = await sealNode(io, "G1");
  assert.equal(first.ok, false);
  assert.equal(first.sealAttemptsLeft, MAX_DRAFT_PROPOSALS - 1);
  assert.ok(first.next.includes('revise:"G1"'));
  rejectPasses = false;
  const revised = draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, revise: "G1" });
  assert.equal(revised.ok, true);
  assert.equal(revised.revised, true);
  assert.equal(approveRoot(io).ok, true);
  const second = await sealNode(io, "G1");
  assert.equal(second.ok, true);
  assert.equal(loadNodeState(io, "G1").sealAttempts, 2);
});

test("seal: exhausting proposals BLOCKEDs the node as EVALUATOR_UNBUILDABLE", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  const exec = fileExec(dir, { checks: standardChecks, accepts: { "accept:C1": { content: "todo\n" } } });
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  const first = await sealNode(io, "G1");
  assert.equal(first.ok, false);
  const second = await sealNode(io, "G1");
  assert.equal(second.ok, true);
  assert.equal(second.status, NodeState.BLOCKED);
  assert.equal(loadNodeState(io, "G1").blockedCode, "EVALUATOR_UNBUILDABLE");
  assert.deepEqual(second.terminal, { root: "G1", status: NodeState.BLOCKED, outcome: second.terminal.outcome });
  assert.equal(loadRoot(io, "G1").status, NodeState.BLOCKED);
});

test("approval: unapproved roots never run E0 or consume seal proposals", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec);
  const draft = draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  assert.match(draft.next, /user to accept or request revisions/);
  for (let n = 0; n < MAX_DRAFT_PROPOSALS + 1; n++) {
    const result = await sealNode(io, "G1");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /requires explicit user approval/);
  }
  assert.equal(exec.calls.length, 0);
  assert.equal(loadNodeState(io, "G1").sealAttempts, 0);
  assert.equal(loadNodeState(io, "G1").status, "DRAFT");
  assert.equal(loadBundle(io, "G1"), null);
});

test("approval: exact draft hash and user metadata survive a fresh IO instance", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec, nowRef);
  const draft = draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  const approved = approveRoot(io);
  assert.deepEqual(approved.approval, {
    digest: sha256Hex(stableStringify(draft.draft)),
    at: new Date(nowRef.now).toISOString(), approvedBy: "user",
  });
  const fresh = makeIo(dir, { exec });
  assert.equal(statusSnapshot(fresh).awaitingApproval, false);
  assert.match(statusSnapshot(fresh).next, /seal G1/);
  assert.equal((await sealNode(fresh, "G1")).ok, true);
  assert.equal(loadBundle(fresh, "G1").digest, approved.approval.digest);
  assert.equal(approveRoot(fresh).ok, false);
});

test("approval: sealing records a conversational reply against the exact root draft", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec);
  const draft = draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  const reply = "Looks good, go ahead.";
  assert.equal((await sealNode(io, "G1", { userApproval: reply })).ok, true);
  const approval = loadRoot(io, "G1").approval;
  assert.equal(approval.userReply, reply);
  assert.equal(approval.approvedBy, "user");
  assert.equal(approval.digest, sha256Hex(stableStringify(draft.draft)));
  assert.equal(approval.digest, loadBundle(io, "G1").digest);
  assert.deepEqual(loadRoot(makeIo(dir), "G1").approval, approval);
});

test("approval: empty or invalid conversational replies never run E0", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec);
  draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  for (const userApproval of ["", "  ", null, true, 123]) {
    const result = await sealNode(io, "G1", { userApproval });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /nonempty string/);
  }
  assert.equal(loadRoot(io, "G1").approval, undefined);
  assert.equal(loadNodeState(io, "G1").sealAttempts, 0);
  assert.equal(exec.calls.length, 0);
});

test("approval: every accepted root revision invalidates approval and retains review context", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = testIo(dir, exec);
  draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, assumptions: ["Existing policy"],
    exclusions: ["No redesign"], verification: "Run behavior and regression tests." });
  assert.equal(approveRoot(io).ok, true);
  const invalid = draftNode(io, { goal: "g", criteria: [], revise: "G1" });
  assert.equal(invalid.ok, false);
  assert.ok(loadRoot(io, "G1").approval);
  // Even an identical resubmission is a revision and requires new approval.
  const revised = draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, revise: "G1" });
  assert.equal(revised.ok, true);
  assert.equal(loadRoot(io, "G1").approval, undefined);
  assert.match(revised.next, /user to accept or request revisions/);
  assert.deepEqual(revised.draft.assumptions, ["Existing policy"]);
  assert.match(rootReviewText(revised.draft), /No redesign/);
  assert.equal((await sealNode(io, "G1")).ok, false);
  assert.equal(exec.calls.length, 0);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
});

test("approval: semantic or evaluator edits on disk cannot reuse approval", async () => {
  for (const mutate of [
    (draft) => { draft.criteria.pop(); },
    (draft) => { draft.criteria[0].requirement = "Weakened requirement"; },
    (draft) => { draft.criteria[0].check.command = "true"; },
    (draft) => { draft.criteria[0].controls.reject[0].setup = "true"; },
    (draft) => { draft.assumptions = ["Changed policy"]; },
  ]) {
    const dir = tempProject();
    const exec = fileExec(dir, { checks: standardChecks });
    const { io } = testIo(dir, exec);
    draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
    assert.equal(approveRoot(io).ok, true);
    const file = draftFile(dir, "G1");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(stored.draft);
    fs.writeFileSync(file, JSON.stringify(stored));
    const result = await sealNode(io, "G1");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /changed since user approval/);
    assert.equal(statusSnapshot(io).awaitingApproval, true);
    assert.equal(approveRoot(io).ok, false);
    assert.equal((await sealNode(io, "G1", { userApproval: "Go ahead." })).ok, false);
    assert.equal(exec.calls.length, 0);
    assert.equal(loadNodeState(io, "G1").sealAttempts, 0);
  }
});

test("approval: root revision during asynchronous E0 cannot seal stale intent", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  let revised = false;
  const io = makeIo(dir, { exec: async (command, opts) => {
    if (!revised) {
      revised = true;
      assert.equal(draftNode(io, { goal: "new goal", criteria: ROOT_CRITERIA, revise: "G1" }).ok, true);
    }
    return exec(command, opts);
  } });
  draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  const result = await sealNode(io, "G1", { userApproval: "Proceed." });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /changed during E0/);
  assert.equal(loadBundle(io, "G1"), null);
  assert.equal(loadRoot(io, "G1").approval, undefined);
  assert.equal(loadNodeState(io, "G1").status, "DRAFT");
  assert.equal(loadNodeState(io, "G1").sealAttempts, 1);
  assert.equal(JSON.parse(fs.readFileSync(draftFile(dir, "G1"), "utf8")).draft.goal, "new goal");
});

test("approval: child revisions and sealing need no separate user approval", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const { io } = await sealedRoot(dir, exec);
  const approval = loadRoot(io, "G1").approval;
  const parentDigest = loadBundle(io, "G1").digest;
  const child = draftNode(io, {
    parentId: "G1", target: "C1", goal: "prerequisite", criteria: childCriteria(),
    reason: "advance C1", prerequisite: true, prerequisiteArtifact: "child1.txt",
  });
  assert.equal(child.ok, true);
  assert.match(child.next, /seal G1.1/);
  assert.equal(approveRoot(io).ok, false);
  const revised = draftNode(io, {
    parentId: "G1", target: "C1", goal: "smaller prerequisite", criteria: childCriteria(), revise: child.id,
  });
  assert.equal(revised.ok, true);
  assert.equal(statusSnapshot(io).awaitingApproval, false);
  assert.match(revised.next, /seal G1.1/);
  assert.equal((await sealNode(io, child.id, { userApproval: "Proceed." })).ok, false);
  assert.equal(loadNodeState(io, child.id).sealAttempts, 0);
  assert.equal((await sealNode(io, child.id)).ok, true);
  assert.deepEqual(loadRoot(io, "G1").approval, approval);
  assert.equal(loadBundle(io, "G1").digest, parentDigest);
});

test("approval: legacy drafts fail closed and must be revised before approval", async () => {
  const dir = tempProject();
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }));
  draftNode(io, { goal: "g", criteria: ROOT_CRITERIA });
  const file = path.join(dir, ".exitcode", "roots", "G1.json");
  const root = JSON.parse(fs.readFileSync(file, "utf8"));
  delete root.reviewDigest;
  fs.writeFileSync(file, JSON.stringify(root));
  assert.equal(approveRoot(io).ok, false);
  assert.equal((await sealNode(io, "G1")).ok, false);
  assert.equal((await sealNode(io, "G1", { userApproval: "Proceed." })).ok, false);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, revise: "G1" }).ok, true);
  assert.equal(approveRoot(io).ok, true);
});

test("review: acceptance layer omits shell mechanics and validates optional fields", () => {
  const draft = rootDraft({ assumptions: ["Use existing expiry"], exclusions: ["No template redesign"],
    verification: "Test positive, negative, and regression cases." });
  const review = rootReviewText(draft);
  for (const text of [draft.goal, ...draft.criteria.map((c) => c.requirement), ...draft.assumptions,
    ...draft.exclusions, draft.verification, "Reply in plain English", "optional shortcut", "Children need no separate approval"]) {
    assert.ok(review.includes(text), text);
  }
  assert.ok(!review.includes("check:c1"));
  for (const values of [{ assumptions: "bad" }, { exclusions: [""] }, { verification: "" }]) {
    assert.equal(validateStructure(rootDraft(values)).ok, false);
  }
});

// ---------------------------------------------------------------------------
// Evaluate: attempts, budgets, PASS
// ---------------------------------------------------------------------------

test("evaluate: unchanged tree is a free re-run; changed tree consumes", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = await sealedRoot(dir, exec, nowRef).then(({ io }) => ({ io }));
  const free = await evaluateNode(io, null);
  assert.equal(free.ok, true);
  assert.equal(free.consumedAttempt, false);
  assert.equal(loadRoot(io, "G1").consumedAttempts, 0);
  fs.writeFileSync(path.join(dir, "feature.txt"), "still todo\n");
  const paid = await evaluateNode(io, null);
  assert.equal(paid.ok, true);
  assert.equal(paid.consumedAttempt, true);
  assert.equal(loadRoot(io, "G1").consumedAttempts, 1);
  assert.equal(loadNodeState(io, "G1").attempts, 1);
});

test("evaluate: attempt budget exhaustion BLOCKEDs the node", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }), nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, policy: { maxTotalAttempts: 1 } }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  fs.writeFileSync(path.join(dir, "feature.txt"), "v2\n");
  assert.equal((await evaluateNode(io, null)).status, NodeState.ACTIVE);
  fs.writeFileSync(path.join(dir, "feature.txt"), "v3\n");
  const exhausted = await evaluateNode(io, null);
  assert.equal(exhausted.status, NodeState.BLOCKED);
  assert.equal(loadNodeState(io, "G1").blockedCode, "BUDGET_EXHAUSTED");
});

test("evaluate: ALL PASS closes the root with the candidate identity", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  fs.writeFileSync(path.join(dir, "feature.txt"), "done\n");
  const result = await evaluateNode(io, null);
  assert.equal(result.ok, true);
  assert.equal(result.status, NodeState.PASS);
  assert.equal(result.vector, "C1=PASS C2=PASS");
  assert.equal(result.cascade.terminal.status, NodeState.PASS);
  const root = loadRoot(io, "G1");
  assert.equal(root.status, NodeState.PASS);
  assert.equal(root.outcome.candidateDigest, digestTree(dir));
});

test("evaluate: deadline expiry BLOCKEDs changed-tree work", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }), nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, policy: { deadlineMinutes: 30 } }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  nowRef.now += 31 * 60 * 1000;
  fs.writeFileSync(path.join(dir, "feature.txt"), "late edit\n");
  const result = await evaluateNode(io, null);
  assert.equal(result.status, NodeState.BLOCKED);
  assert.equal(loadNodeState(io, "G1").blockedCode, "BUDGET_EXHAUSTED");
});

test("evaluate: sealed-bundle tampering BLOCKEDs instead of trusting edits", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  const sealedFile = path.join(dir, ".exitcode", "contracts", "G1.sealed.json");
  const bundle = JSON.parse(fs.readFileSync(sealedFile, "utf8"));
  bundle.contract.goal = "tampered";
  fs.writeFileSync(sealedFile, JSON.stringify(bundle));
  const result = await evaluateNode(io, null);
  assert.equal(result.status, NodeState.BLOCKED);
  assert.ok(loadNodeState(io, "G1").blockedReason.includes("digest mismatch"));
});

// ---------------------------------------------------------------------------
// Children and boundaries
// ---------------------------------------------------------------------------

function childCriteria() {
  return [behavior("D1", "check:d1")];
}

test("child: early decomposition needs a prerequisite; targets must fail", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  const early = draftNode(io, { parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "helps" });
  assert.equal(early.ok, false);
  assert.ok(early.errors.some((e) => e.includes("prerequisite:true")));
  const passingTarget = draftNode(io, {
    parentId: "G1", target: "C2", goal: "sub", criteria: childCriteria(), reason: "helps",
    prerequisite: true, prerequisiteArtifact: "artifact",
  });
  assert.equal(passingTarget.ok, false);
  assert.ok(passingTarget.errors.some((e) => e.includes("currently passes")));
  const ok = draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "builds the helper C1 needs",
    prerequisite: true, prerequisiteArtifact: "helper module",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.id, "G1.1");
});

test("child: PASS reruns the parent but cannot close a failing parent", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  const child = draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  });
  assert.equal(child.ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  fs.writeFileSync(path.join(dir, "child1.txt"), "ok");
  const result = await evaluateNode(io, null);
  assert.equal(result.status, NodeState.PASS);
  assert.ok(result.cascade.events.some((e) => e.includes("G1.1 PASS")));
  assert.ok(result.cascade.events.some((e) => e.includes("G1 rerun: C1=FAIL C2=PASS")));
  assert.equal(result.cascade.terminal, null);
  assert.equal(loadRoot(io, "G1").status, NodeState.ACTIVE);
  assert.deepEqual(loadRoot(io, "G1").stack, ["G1"]);
});

test("child: PASS that fixes the parent cascades to root PASS", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  assert.equal(draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  fs.writeFileSync(path.join(dir, "child1.txt"), "ok");
  fs.writeFileSync(path.join(dir, "feature.txt"), "done\n");
  const result = await evaluateNode(io, null);
  assert.equal(result.cascade.terminal.status, NodeState.PASS);
  assert.equal(loadRoot(io, "G1").status, NodeState.PASS);
});

test("child: one active child; identical repeats rejected on unchanged evidence", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  const first = draftNode(io, {
    parentId: "G1", target: "C1", goal: "same subgoal", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  });
  assert.equal(first.ok, true);
  const second = draftNode(io, {
    parentId: "G1", target: "C1", goal: "other subgoal", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  });
  assert.equal(second.ok, false);
  assert.ok(second.errors.some((e) => e.includes("one active child")));
  assert.equal((await blockNode(io, "G1.1", { reason: "missing credential", code: "CREDENTIAL_MISSING" })).status, NodeState.BLOCKED);
  const repeat = draftNode(io, {
    parentId: "G1", target: "C1", goal: "same subgoal", criteria: childCriteria(), reason: "r2",
    prerequisite: true, prerequisiteArtifact: "a",
  });
  assert.equal(repeat.ok, false);
  assert.ok(repeat.errors.some((e) => e.includes("already blocked on unchanged evidence")));
  // Changed evidence reopens the path.
  fs.writeFileSync(path.join(dir, "feature.txt"), "todo v2\n");
  await evaluateNode(io, "G1");
  const fresh = draftNode(io, {
    parentId: "G1", target: "C1", goal: "same subgoal", criteria: childCriteria(), reason: "r3",
    prerequisite: true, prerequisiteArtifact: "a",
  });
  assert.equal(fresh.ok, true);
});

test("child: depth limit enforced (maxDepth 1 allows G1.1, rejects G1.1.1)", async () => {
  const dir = tempProject();
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, fileExec(dir, { checks: standardChecks }), nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA, policy: { maxDepth: 1 } }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  assert.equal(draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  const grandchild = draftNode(io, {
    parentId: "G1.1", target: "D1", goal: "subsub", criteria: [behavior("E1", "check:e1")], reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  });
  assert.equal(grandchild.ok, false);
  assert.ok(grandchild.errors.some((e) => e.includes("maxDepth")));
});

// ---------------------------------------------------------------------------
// Regression and restore
// ---------------------------------------------------------------------------

test("evaluate: own-vector regression restores the last accepted candidate", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  fs.writeFileSync(path.join(dir, "feature.txt"), "done BROKE\n");
  const result = await evaluateNode(io, null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.regressedRestored, ["C2"]);
  assert.equal(fs.readFileSync(path.join(dir, "feature.txt"), "utf8"), "todo\n");
  assert.equal(loadRoot(io, "G1").consumedAttempts, 1); // the attempt is kept
  assert.equal(loadNodeState(io, "G1").status, NodeState.ACTIVE);
});

test("block: child BLOCKED restores the pre-child candidate and reruns parent", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  assert.equal(draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  fs.writeFileSync(path.join(dir, "child1.txt"), "half-baked");
  fs.writeFileSync(path.join(dir, "feature.txt"), "todo edited\n");
  const blocked = await blockNode(io, "G1.1", { reason: "needs human API key", code: "CREDENTIAL_MISSING" });
  assert.equal(blocked.status, NodeState.BLOCKED);
  assert.ok(blocked.events.some((e) => e.includes("restored G1 to pre-child checkpoint")));
  assert.ok(blocked.events.some((e) => e.includes("G1 rerun: C1=FAIL C2=PASS")));
  assert.equal(fs.existsSync(path.join(dir, "child1.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "feature.txt"), "utf8"), "todo\n");
  assert.deepEqual(loadRoot(io, "G1").stack, ["G1"]);
});

test("cascade: child work that regresses an ancestor is reverted and BLOCKED", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true); // C1=FAIL C2=PASS
  assert.equal(draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true); // D1=FAIL
  // Grandchild tree: its own check already passes, but G1.C2 is regressed.
  fs.writeFileSync(path.join(dir, "gc.txt"), "ok");
  fs.writeFileSync(path.join(dir, "feature.txt"), "todo BROKE\n");
  assert.equal(draftNode(io, {
    parentId: "G1.1", target: "D1", goal: "subsub", criteria: [behavior("E1", "check:e1")], reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  const seal = await sealNode(io, "G1.1.1");
  assert.equal(seal.ok, true);
  assert.equal(seal.alreadySatisfied, true);
  assert.ok(seal.cascade.events.some((e) => e.includes("reverted and BLOCKED")));
  assert.equal(loadNodeState(io, "G1.1.1").status, NodeState.BLOCKED);
  assert.equal(fs.existsSync(path.join(dir, "gc.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "feature.txt"), "utf8"), "todo\n");
  assert.equal(formatVector(loadNodeState(io, "G1").lastResult.outcomes), "C1=FAIL C2=PASS");
  assert.deepEqual(loadRoot(io, "G1").stack, ["G1", "G1.1"]);
});

// ---------------------------------------------------------------------------
// Staleness, snapshots, digests
// ---------------------------------------------------------------------------

test("terminalStale: source changes after PASS invalidate the result", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  fs.writeFileSync(path.join(dir, "feature.txt"), "done\n");
  await evaluateNode(io, null);
  assert.equal(terminalStale(io, "G1").stale, false);
  fs.writeFileSync(path.join(dir, "feature.txt"), "done plus more\n");
  assert.equal(terminalStale(io, "G1").stale, true);
});

test("evaluate: terminal child reports stale when the tree moved on", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  assert.equal(draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  fs.writeFileSync(path.join(dir, "child1.txt"), "ok");
  await evaluateNode(io, null); // G1.1 PASS, G1 still FAIL
  fs.writeFileSync(path.join(dir, "child1.txt"), "ok v2");
  const reread = await evaluateNode(io, "G1.1");
  assert.equal(reread.status, NodeState.PASS);
  assert.equal(reread.stale, true);
});

test("snapshot/restore roundtrips the tree and deletes later files", () => {
  const dir = tempProject({ "a.txt": "a", "sub/b.txt": "b" });
  const snapDir = path.join(dir, ".exitcode", "tmp", "snap");
  const snap = snapshotTree(dir, snapDir);
  assert.equal(snap.ok, true);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed");
  fs.writeFileSync(path.join(dir, "new.txt"), "new");
  fs.rmSync(path.join(dir, "sub", "b.txt"));
  const restored = restoreTree(dir, snapDir, snap.manifest);
  assert.equal(restored.ok, true);
  assert.ok(restored.removed.includes("new.txt"));
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(dir, "sub", "b.txt"), "utf8"), "b");
  assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
});

test("snapshot: explicit caps count all content, accept the boundary, and clean up rejection", (t) => {
  const dir = tempProject({ "a.txt": "abc", "sub/b.txt": "def" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapDir = path.join(dir, ".exitcode/tmp/snapshot");
  const snap = snapshotTree(dir, snapDir, { maxBytes: 6 });
  assert.equal(snap.ok, true);
  assert.equal(snap.manifest.totalBytes, 6);
  const before = digestTree(dir);
  const rejected = snapshotTree(dir, snapDir, { maxBytes: 5 });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /snapshot cap \(5 bytes\): 6 bytes across 2 files/);
  assert.match(rejected.reason, /fixture setup cannot reduce the pre-copy size/);
  assert.equal(fs.existsSync(snapDir), false);
  assert.equal(digestTree(dir), before);
});

test("snapshot: copy failures return diagnostics and remove partial content", (t) => {
  const dir = tempProject({ "a.txt": "a", "sub/b.txt": "b" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = digestTree(dir);
  const snapDir = path.join(dir, ".exitcode/tmp/snapshot");
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, "sub"), "blocks directory creation");
  const result = snapshotTree(dir, snapDir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /snapshot failed \(EEXIST\)/);
  assert.equal(fs.existsSync(snapDir), false);
  assert.equal(digestTree(dir), before);
});

test("digestTree: ignores supervisor and dependency dirs, tracks content", () => {
  const dir = tempProject({ "a.txt": "a" });
  const before = digestTree(dir);
  fs.mkdirSync(path.join(dir, ".exitcode", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".exitcode", "x", "y.json"), "{}");
  fs.mkdirSync(path.join(dir, "node_modules", "z"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "z", "y.js"), "1");
  assert.equal(digestTree(dir), before);
  fs.writeFileSync(path.join(dir, "a.txt"), "b");
  assert.notEqual(digestTree(dir), before);
});

test("checkpoints: rolling cap keeps pre-child checkpoints of live children", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  assert.equal(draftNode(io, {
    parentId: "G1", target: "C1", goal: "sub", criteria: childCriteria(), reason: "r",
    prerequisite: true, prerequisiteArtifact: "a",
  }).ok, true);
  assert.equal((await sealNode(io, "G1.1")).ok, true);
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(dir, "feature.txt"), `todo v${i}\n`);
    await evaluateNode(io, "G1");
  }
  const parent = loadNodeState(io, "G1");
  const rolling = parent.checkpoints.filter((c) => !c.note.startsWith("pre-child:"));
  assert.ok(rolling.length <= 3);
  assert.ok(parent.checkpoints.some((c) => c.note === "pre-child:G1.1"));
  assert.equal((await blockNode(io, "G1.1", { reason: "done probing", code: "NO_PATH" })).status, NodeState.BLOCKED);
  fs.writeFileSync(path.join(dir, "feature.txt"), "todo final\n");
  await evaluateNode(io, "G1");
  assert.ok(!loadNodeState(io, "G1").checkpoints.some((c) => c.note === "pre-child:G1.1"));
});

// ---------------------------------------------------------------------------
// Guards, mode, status
// ---------------------------------------------------------------------------

test("protocol: separates the approved goal, recursive repair, and proof of success", () => {
  for (const text of ["FIX SUCCESS", "PURSUE SUCCESS", "PROVE SUCCESS", "wait for explicit user approval",
    "Any root draft revision requires fresh approval", "sealed contract is fixed and cannot be weakened",
    "Implement the approved goal", "Use the sealed criteria to measure", "preserve previously passing behavior",
    "Decompose only when the supervisor permits it", "temporary reduction of its parent problem",
    "needs no user approval", "cannot change ancestor contracts", "Evaluate after meaningful changes",
    "fresh supervisor evaluation with all criteria passing", "follow the supervisor's returned parent result and next action",
    "report the concrete blocker"]) {
    assert.ok(PROTOCOL_PROMPT.includes(text), text);
  }
  assert.doesNotMatch(PROTOCOL_PROMPT, /stalled|toward the sealed criteria|controls\.accept|userApproval/);
});

test("guardToolCall: invisible when mode is off", () => {
  const dir = tempProject();
  assert.equal(guardToolCall({ modeOn: false, leafStatus: null, cwd: dir, toolName: "write", input: { path: "a" } }), null);
  assert.equal(guardToolCall({ modeOn: false, leafStatus: null, cwd: dir, toolName: "bash", input: { command: "rm -rf /" } }), null);
});

test("guardToolCall: unsealed states allow only discovery and exact supervisor tools", () => {
  const dir = tempProject();
  for (const leafStatus of [null, "NO_CONTRACT", "DRAFT", "BLOCKED", "PASS", "UNKNOWN"]) {
    for (const toolName of ["read", "grep", "ls", "exitcode_status", "exitcode_draft",
      "exitcode_seal", "exitcode_evaluate", "exitcode_child", "exitcode_block"]) {
      assert.equal(guardToolCall({ modeOn: true, leafStatus, cwd: dir, toolName, input: {} }), null, `${leafStatus}: ${toolName}`);
    }
    for (const [toolName, input] of [
      ["write", { path: "src/a.ts" }], ["edit", { path: ".exitcode/drafts/x.json" }],
      ["write", { path: ".agents/artifacts/acceptance.md" }], ["bash", { command: "/exitcode exit" }],
      ["powershell", { command: "ls" }], ["find", {}], ["context", {}],
      ["codemode", { code: 'await tools.read({path: "src/a.ts"})' }],
      ["git_commit_plan", {}], ["git_plan_context", {}], ["custom_read_only", {}],
      ["exitcode_exit", {}], ["exitcode_fake", {}],
    ]) {
      const verdict = guardToolCall({ modeOn: true, leafStatus, cwd: dir, toolName, input });
      assert.equal(verdict.block, true, `${leafStatus}: ${toolName}`);
      assert.match(verdict.reason, /until the contract is sealed and ACTIVE/);
      assert.match(verdict.reason, /Inspect with read, grep, ls/);
      assert.match(verdict.reason, /exitcode_status/);
      assert.match(verdict.reason, new RegExp(`state ${leafStatus ?? "NO_CONTRACT"}`));
    }
  }
});

test("guardToolCall: active contracts protect sealed artifacts only", () => {
  const dir = tempProject();
  const sealed = guardToolCall({ modeOn: true, leafStatus: "ACTIVE", cwd: dir, toolName: "edit", input: { path: ".exitcode/contracts/G1.sealed.json" } });
  assert.equal(sealed.block, true);
  assert.match(sealed.reason, /supervisor-owned artifacts/);
  assert.match(sealed.reason, /read-only/);
  const traversal = guardToolCall({ modeOn: true, leafStatus: "ACTIVE", cwd: dir, toolName: "write", input: { path: "proj/../.exitcode/evil" } });
  assert.equal(traversal.block, true);
  const project = guardToolCall({ modeOn: true, leafStatus: "ACTIVE", cwd: dir, toolName: "edit", input: { path: "src/a.ts" } });
  assert.equal(project, null);
  const shell = guardToolCall({ modeOn: true, leafStatus: "ACTIVE", cwd: dir, toolName: "bash", input: { command: "npm test" } });
  assert.equal(shell, null);
  const sealedShell = guardToolCall({ modeOn: true, leafStatus: "ACTIVE", cwd: dir, toolName: "bash", input: { command: "cat .exitcode/index.json" } });
  assert.equal(sealedShell.block, true);
  assert.match(sealedShell.reason, /mentioning \.exitcode are blocked/);
  assert.match(sealedShell.reason, /exitcode_status/);
});

test("resolveModeFromBranch: last mode entry wins; other entries ignored", () => {
  assert.deepEqual(resolveModeFromBranch([]), { on: false, rootId: undefined, pendingGoal: undefined });
  const branch = [
    { type: "message" },
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { on: true, rootId: "G1" } },
    { type: "custom", customType: "other", data: { on: true } },
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { on: false } },
  ];
  assert.deepEqual(resolveModeFromBranch(branch), { on: false, rootId: undefined, pendingGoal: undefined });
  assert.deepEqual(resolveModeFromBranch([
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { on: true, pendingGoal: "Original goal" } },
  ]), { on: true, rootId: undefined, pendingGoal: "Original goal" });
  assert.deepEqual(resolveModeFromBranch([
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { on: true, rootId: "G1", pendingGoal: 42 } },
  ]), { on: true, rootId: "G1", pendingGoal: undefined });
});

test("status and nextAction track the loop position", async () => {
  const dir = tempProject();
  const exec = fileExec(dir, { checks: standardChecks });
  const nowRef = { now: Date.now() };
  const { io } = testIo(dir, exec, nowRef);
  assert.ok(statusText(io).includes("no active root"));
  assert.equal(draftNode(io, { goal: "g", criteria: ROOT_CRITERIA }).ok, true);
  let snap = statusSnapshot(io);
  assert.equal(snap.active, true);
  assert.equal(snap.awaitingApproval, true);
  assert.ok(snap.next.includes("user to accept or request revisions"));
  assert.equal(approveRoot(io).ok, true);
  assert.equal((await sealNode(io, "G1")).ok, true);
  snap = statusSnapshot(io);
  assert.ok(snap.next.includes("repair G1"));
  assert.ok(statusText(io).includes("C1=FAIL C2=PASS"));
  assert.ok(statusText(io).includes("0/12 attempts"));
  fs.writeFileSync(path.join(dir, "feature.txt"), "v2\n");
  await evaluateNode(io, null);
  fs.writeFileSync(path.join(dir, "feature.txt"), "v3\n");
  await evaluateNode(io, null);
  snap = statusSnapshot(io);
  assert.ok(snap.next.includes("exitcode_child"));
});

test("nextAction: gives state-specific transitions without subjective decomposition triggers", () => {
  const root = { policy: DEFAULT_POLICY, consumedAttempts: 2 };
  const child = { id: "G1.1", parentId: "G1", status: NodeState.DRAFT };
  assert.match(nextAction(root, child), /seal G1\.1 with exitcode_seal/);
  assert.doesNotMatch(nextAction(root, child), /approval|review/);
  assert.equal(nextAction(root, null), "no active node");
  for (const status of [NodeState.PASS, NodeState.BLOCKED]) {
    assert.equal(nextAction(root, { ...child, status }), `G1.1 is ${status}`);
  }
  const active = { ...child, status: NodeState.ACTIVE, attempts: 0,
    lastResult: { outcomes: [{ criterionId: "C1", status: "FAIL" }, { criterionId: "C2", status: "PASS" }] } };
  const repair = nextAction(root, active);
  assert.match(repair, /repair G1\.1 to achieve its goal/);
  assert.match(repair, /use failures \[C1\] as feedback, then exitcode_evaluate/);
  assert.doesNotMatch(repair, /exitcode_child|C2/);
  const reduce = nextAction(root, { ...active, attempts: DEFAULT_POLICY.localRepairs });
  assert.match(reduce, /exitcode_evaluate G1\.1/);
  assert.match(reduce, /smaller goal offers a clearer path/);
  assert.match(reduce, /exitcode_child targeting one of \[C1\]/);
  assert.match(reduce, /subject to supervisor gates/);
  assert.doesNotMatch(reduce, /stalled|C2/);
});

test("budgetsOk and BLOCK_CODES cover the policy surface", () => {
  const root = { deadlineAt: 100, consumedAttempts: 0, policy: DEFAULT_POLICY };
  assert.equal(budgetsOk(root, 50).ok, true);
  assert.equal(budgetsOk(root, 100).ok, false);
  assert.equal(budgetsOk({ ...root, consumedAttempts: 12 }, 50).ok, false);
  assert.ok(BLOCK_CODES.includes("BUDGET_EXHAUSTED"));
  assert.ok(BLOCK_CODES.includes("EVALUATOR_UNBUILDABLE"));
});

test("childGates: rejects without an ACTIVE parent", () => {
  const root = { policy: DEFAULT_POLICY, consumedAttempts: 0, deadlineAt: Date.now() + 1000 };
  const gates = childGates({ root, parentState: null, parentResult: null, target: "C1", goal: "g", siblings: [], nowMs: Date.now() });
  assert.equal(gates.ok, false);
  assert.ok(gates.errors.some((e) => e.includes("ACTIVE")));
});
