/** Pi wiring only. Core owns budgets, recursion, and approval digests. See INVARIANTS.md. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as core from "./exitcode-core.mjs";
import { reviewRegistry } from "./test/adapter-review-cases.mjs";
import { structuralRegistry } from "./test/structural-review.mjs";

// Exercise the actual adapter without requiring Pi's host-provided packages.
// Schema constructors are inert here; the supervisor validates draft behavior.
const source = stripTypeScriptTypes(fs.readFileSync(new URL("./exitcode.ts", import.meta.url), "utf8"))
  .replace('import { Type } from "typebox";', "")
  .replace('import * as core from "./exitcode-core.mjs";', "")
  .replace("export default function", "return function");
const Type = new Proxy({}, { get: () => () => ({}) });
const install = new Function("Type", "core", source)(Type, core);

const criteria = [
  { id: "C1", requirement: "The feature is done", check: { command: "grep -qx done feature.txt" },
    controls: { accept: { setup: "printf 'done\n' > feature.txt" }, reject: [{ setup: "printf 'todo\n' > feature.txt" }] } },
  { id: "C2", requirement: "Existing behavior is preserved", type: "regression", check: { command: "test -f feature.txt" } },
];
const broken = () => { const c = structuredClone(criteria); c[0].controls.reject[0].setup = "printf 'done\n' > feature.txt"; return c; };

function harness(t, content = "todo\n", initialTools = ["read", "write", "bash"]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exitcode-adapter-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "feature.txt"), content);
  const tools = new Map(), events = new Map(), commands = new Map(), entries = [], messages = [], notifications = [];
  let active = [...initialTools], idle = true;
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names) => { active = [...new Set(names)]; },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (content) => messages.push({ content, triggerTurn: true }),
    sendMessage: (message, options) => messages.push({ ...message, ...options }),
  };
  const ctx = {
    cwd, hasUI: false, mode: "print", model: { id: "test-model", provider: "test" }, thinkingLevel: "high", modelRegistry: structuralRegistry(), isIdle: () => idle,
    ui: { notify: (content, type) => notifications.push({ content, type }) },
    sessionManager: { getBranch: () => entries },
  };
  install(pi);
  return {
    cwd, ctx, tools, events, messages, notifications, entries, loadout: [...initialTools],
    setIdle: (value) => { idle = value; },
    getActiveTools: pi.getActiveTools, setActiveTools: pi.setActiveTools,
    reload: () => Promise.resolve(events.get("session_shutdown")?.({ reason: "reload" }, ctx)).then(() => { install(pi); return events.get("session_start")({ reason: "reload" }, ctx); }),
    restart: () => { install(pi); return events.get("session_start")({ reason: "startup" }, ctx); },
    reply: (text) => { messages.push({ role: "user", content: text }); return events.get("input")({ text, source: "interactive" }, ctx); },
    command: (args) => commands.get("exitcode").handler(args, ctx),
    tool: (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx),
  };
}

async function draft(h, params = {}) {
  await h.command("Add the feature");
  return h.tool("exitcode_draft", { goal: "Finish the feature", criteria, assumptions: ["Use the existing interface"], exclusions: ["No redesign"], ...params });
}
const io = (h) => core.makeIo(h.cwd);
const feature = (h) => fs.readFileSync(path.join(h.cwd, "feature.txt"), "utf8");
const settle = (h) => h.events.get("agent_before_settle")({}, h.ctx);
function promptText(h) {
  const event = { systemPromptOptions: { sections: {} } };
  h.events.get("before_agent_start")(event, h.ctx);
  return event.systemPromptOptions.sections.exitcode;
}

function assertEnforced(h) {
  assert.equal(core.resolveModeFromBranch(h.entries).on, true);
  assert.equal(h.tools.get("exitcode_draft").exposure, "direct");
  for (const name of h.loadout) assert.ok(h.getActiveTools().includes(name), `${name} stays enabled`);
  // Tools are not classified; only direct supervisor-state access is denied, including nested calls.
  for (const [toolName, input] of [["write", { path: "feature.txt" }], ["bash", { command: "npm test" }], ["codemode", { code: "await tools.bash({})" }], ["git_commit_plan", {}]])
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx), undefined, toolName);
  for (const [toolName, input] of [["write", { path: ".exitcode/drafts/manual.json" }], ["bash", { command: "cat .exitcode/index.json" }]]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx).block, true, toolName);
    assert.equal(h.events.get("tool_call")({ toolName, input, parentToolCallId: "outer" }, h.ctx).block, true, toolName);
  }
}

/** A pre-seal change from any tool is discarded at the next settle. */
async function assertFrozen(h, expected = "todo\n") {
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "changed by a tool\n");
  await settle(h);
  assert.equal(feature(h), expected);
}

test("adapter: mode exposes ExitCode tools without ever changing the user's loadout", async (t) => {
  const original = ["bash", "read", "write", "codemode"];
  const h = harness(t, "todo\n", original);
  const loadout = () => h.getActiveTools().filter((name) => !core.EXITCODE_TOOL_NAMES.includes(name));
  assert.equal(h.tools.size, 6);
  assert.equal(h.tools.get("exitcode_draft").exposure, "hidden");
  assert.equal(h.events.get("tool_call")({ toolName: "write", input: { path: ".exitcode/index.json" } }, h.ctx), undefined, "inert when off");
  await h.command("Add the feature");
  assertEnforced(h);
  assert.deepEqual(loadout(), original);
  await h.tool("exitcode_draft", { goal: "g", criteria });
  h.setActiveTools([...h.getActiveTools().filter((name) => name !== "read"), "custom_tool"]);
  await h.command("approve");
  assert.deepEqual(loadout(), ["bash", "write", "codemode", "custom_tool"]);
  await h.command("exit");
  assert.deepEqual(h.getActiveTools(), ["bash", "write", "codemode", "custom_tool"]);
  assert.equal(h.tools.get("exitcode_draft").exposure, "hidden");
  // Older versions narrowed the loadout before sealing; it is returned exactly once.
  for (const owned of [false, true]) {
    const legacyTools = ["read", "write", "bash", ...(owned ? ["find"] : [])];
    const legacy = harness(t, "todo\n", legacyTools);
    legacy.setActiveTools(["read", "grep", "ls", "find"]);
    legacy.entries.push({ type: "custom", customType: core.MODE_ENTRY_TYPE, data: { on: true, pendingGoal: "Old goal",
      discoveryToolsAdded: ["grep", "ls", ...(!owned ? ["find"] : [])], toolsSuspended: ["write", "bash"] } });
    await legacy.restart();
    assert.deepEqual(legacy.getActiveTools().filter((name) => !core.EXITCODE_TOOL_NAMES.includes(name)).sort(), [...legacyTools].sort());
    const count = legacy.entries.length;
    await legacy.restart();
    assert.equal(legacy.entries.length, count);
  }
});

test("adapter: each turn receives the short protocol and bounded status, never evaluator evidence", async (t) => {
  const h = harness(t, "todo\n", ["read", "write", "bash", "git_commit_plan"]);
  await h.command("Complete all five phases");
  assert.match(promptText(h), /EXITCODE MODE/);
  assert.match(promptText(h), /Root goal: Complete all five phases/);
  // Extension housekeeping can neither replace the retained objective nor switch enforcement off.
  await h.events.get("input")({ text: "Record a commit", source: "extension" }, h.ctx);
  await h.tool("exitcode_draft", { goal: "Commit-only detour", criteria, originalRequest: "Commit ladder: clean the working tree" });
  assert.equal(core.statusSnapshot(io(h)).originalRequest, "Complete all five phases");
  const prompt = promptText(h);
  assert.ok(Buffer.byteLength(prompt) < core.PROMPT_STATUS_MAX_BYTES + 1200, `${Buffer.byteLength(prompt)} bytes`);
  assert.match(prompt, /C1: The feature is done/);
  assert.match(prompt, /approval: awaiting the user's reply/);
  assert.doesNotMatch(prompt, /grep -qx|printf|evaluator evidence:|evaluator metrics:/);
  const status = await h.tool("exitcode_status", {});
  assert.match(status.content[0].text, /Complete all five phases|C1: The feature is done/);
  assert.doesNotMatch(status.content[0].text, /evaluator evidence:/);
  assert.equal(status.details.evaluatorEvidence, undefined);
  const evidence = await h.tool("exitcode_status", { detail: "evidence" });
  assert.match(evidence.content[0].text, /evaluator evidence:/);
  assert.ok(evidence.details.contract);
  await h.command("status evidence");
  assert.match(h.notifications.at(-1).content, /evaluator evidence:/);
  assertEnforced(h);
});

test("adapter: a draft returns a compact validated plan only after E0, and repairs come first", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  const failed = await h.tool("exitcode_draft", { goal: "g", criteria: broken() });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /Evaluator preparation needs repair/);
  assert.equal(core.statusSnapshot(io(h)).awaitingApproval, false);
  assert.equal((await settle(h)).continue, true, "the agent keeps repairing");
  const result = await h.tool("exitcode_draft", { goal: "Finish the feature", criteria, revise: "G1", assumptions: ["Use the existing interface"] });
  const text = result.content[0].text;
  for (const fragment of [/Validated plan/, /C1: The feature is done/, /C2: Existing behavior is preserved/, /Use the existing interface/, /Verification\n- C1: an isolated custom command; rejected 1 independent near-miss\./, /Approve this plan/])
    assert.match(text, fragment);
  assert.doesNotMatch(text, /grep -qx|printf/);
  assert.ok(Buffer.byteLength(text) < 2048);
  assert.equal(await settle(h), undefined, "review pauses autonomous continuation");
  const sealed = await h.tool("exitcode_seal", { node: "G1" });
  assert.match(sealed.content[0].text, /requires explicit user approval/);
});

test("adapter: approval comes from a plain-English reply or /exitcode approve, and change requests need fresh acceptance", async (t) => {
  const h = harness(t);
  await draft(h);
  await h.reply("Looks good, but also require the existing interface.");
  const revised = structuredClone(criteria);
  revised[0].requirement += " through the existing interface";
  assert.match((await h.tool("exitcode_draft", { goal: "Finish the feature", criteria: revised, revise: "G1" })).content[0].text, /through the existing interface/);
  assert.equal((await h.tool("exitcode_seal", { node: "G1" })).isError, true);
  const accepted = "Yes, that version works. Please proceed.";
  await h.reply(accepted);
  const sealed = await h.tool("exitcode_seal", { node: "G1", userApproval: accepted });
  assert.match(sealed.content[0].text, /sealed G1/);
  assert.equal(core.loadRoot(io(h), "G1").approval.userReply, accepted);
  assert.equal(h.messages.at(-1).content, accepted, "no synthetic command-triggered turn");
  assert.equal((await settle(h)).continue, true);
  // The command shortcut refuses when off, busy, malformed, or absent, then seals and starts work.
  const c = harness(t);
  await c.command("approve");
  assert.match(c.notifications.at(-1).content, /resume/);
  await c.command("Add the feature");
  await c.command("approve");
  assert.match(c.notifications.at(-1).content, /no DRAFT root/);
  await c.tool("exitcode_draft", { goal: "g", criteria });
  await c.command("approve extra");
  assert.match(c.notifications.at(-1).content, /Usage/);
  c.setIdle(false);
  await c.command("approve");
  assert.match(c.notifications.at(-1).content, /Wait for the agent/);
  c.setIdle(true);
  fs.writeFileSync(path.join(c.cwd, "feature.txt"), "edited during review\n");
  await c.command("approve");
  assert.equal(core.loadNodeState(io(c), "G1").status, "ACTIVE");
  assert.match(c.messages.at(-1).content, /User approved root G1/);
  assert.match(c.messages.at(-1).content, /modified feature\.txt/);
  assert.equal(c.messages.at(-1).triggerTurn, true);
  assert.equal(feature(c), "todo\n");
});

test("adapter: settle restores pre-seal changes, bounds continuations, and cannot be reset by status calls", async (t) => {
  const h = harness(t, "todo\n", ["read", "write", "bash", "semantic_repo_search"]);
  h.ctx.hasUI = true;
  await h.command("Add the feature");
  fs.mkdirSync(path.join(h.cwd, ".cache"));
  fs.writeFileSync(path.join(h.cwd, ".cache/generated-index.json"), "{}");
  const first = await settle(h);
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /added \.cache\/generated-index\.json/);
  assert.match(h.notifications.at(-1).content, /\.exitcode\/discarded\/d-000001/);
  assert.equal(fs.existsSync(path.join(h.cwd, ".cache")), false);
  for (let i = 1; i < core.MAX_SETTLE_NUDGES; i++) { fs.writeFileSync(path.join(h.cwd, "feature.txt"), `attempt ${i}\n`); assert.equal((await settle(h)).continue, true); }
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "again\n");
  assert.match((await settle(h)).entries[0].content, /Discovery is paused/);
  assert.equal(feature(h), "todo\n");
  // Sealed execution: continuations report the next action and stop after bounded no-progress turns.
  const s = harness(t);
  await draft(s);
  await s.command("approve");
  const next = core.statusSnapshot(io(s)).next;
  for (let i = 0; i < core.MAX_SETTLE_NUDGES; i++) {
    const nudge = await settle(s);
    assert.equal(nudge.continue, true);
    assert.ok(nudge.entries[0].content.endsWith(`G1 remains ACTIVE :: C1=FAIL C2=PASS. next: ${next}`));
    await s.tool("exitcode_status", {});
    s.events.get("input")({ text: "Record a commit", source: "extension" }, s.ctx);
  }
  assert.match((await settle(s)).entries[0].content, /No observable progress/);
  assert.equal(core.loadRoot(io(s), "G1").pause.code, "NO_PROGRESS");
  assert.equal(await settle(s), undefined);
  await s.command("resume");
  assert.equal((await settle(s)).continue, true);
  fs.writeFileSync(path.join(s.cwd, "feature.txt"), "sealed work\n");
  await settle(s);
  assert.equal(feature(s), "sealed work\n", "sealed execution keeps candidate changes");
});

test("adapter: only a fresh root PASS exits mode; child PASS, stale PASS, and pauses keep enforcement", async (t) => {
  const h = harness(t);
  await draft(h);
  await h.command("approve");
  const childCriteria = [{ id: "D1", requirement: "Helper ready", check: { command: "grep -qx ready helper.txt" },
    controls: { accept: { setup: "printf 'ready\n' > helper.txt" }, reject: [{ setup: "printf 'todo\n' > helper.txt" }] } }];
  await h.tool("exitcode_child", { parent: "G1", target: "C1", goal: "Prepare helper", criteria: childCriteria, reason: "Helper is a prerequisite", prerequisite: true, prerequisiteArtifact: "helper.txt" });
  fs.writeFileSync(path.join(h.cwd, "progress.txt"), "parent work\n");
  assert.match((await h.tool("exitcode_seal", { node: "G1.1" })).content[0].text, /added progress\.txt/, "child drafts freeze the parent's work");
  fs.writeFileSync(path.join(h.cwd, "helper.txt"), "ready\n");
  const child = await h.tool("exitcode_evaluate", { node: "G1.1" });
  assert.equal(child.details.status, "PASS");
  assert.equal(child.details.cascade.terminal, null);
  assertEnforced(h);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  const root = await h.tool("exitcode_evaluate", { node: "G1" });
  assert.equal(root.details.cascade.terminal.status, "PASS");
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  assert.equal(h.tools.get("exitcode_evaluate").exposure, "hidden");
  assert.equal(fs.existsSync(path.join(h.cwd, ".exitcode/baseline")), false);
  // A stale on-disk PASS never switches mode off.
  const stale = harness(t);
  await draft(stale);
  const staleRoot = core.loadRoot(io(stale), "G1");
  Object.assign(staleRoot, { status: "PASS", stack: [], outcome: { candidateDigest: core.digestTree(stale.cwd) } });
  core.saveRoot(io(stale), staleRoot);
  const index = core.loadIndex(stale.cwd); index.activeRootId = null; core.saveIndex(stale.cwd, index);
  fs.writeFileSync(path.join(stale.cwd, "feature.txt"), "changed\n");
  await stale.reload();
  assert.equal(await settle(stale), undefined);
  assertEnforced(stale);
  await assertFrozen(stale, "changed\n");
  // Pauses keep enforcement before and after sealing; only /exitcode exit cancels.
  for (const sealed of [false, true]) {
    const p = harness(t);
    const original = [...p.getActiveTools()];
    await draft(p);
    if (sealed) { await p.command("approve"); fs.writeFileSync(path.join(p.cwd, "feature.txt"), "partial\n"); }
    const result = await p.tool("exitcode_block", { node: "G1", reason: "Missing authorization", code: "AUTHORIZATION_MISSING" });
    assert.equal(result.details.pause.code, "AUTHORIZATION_MISSING");
    assert.match(promptText(p), /G1 \[PAUSED\]/);
    assert.match(promptText(p), /Missing authorization/);
    await p.reload();
    assertEnforced(p);
    assert.equal(await settle(p), undefined);
    await assertFrozen(p, sealed ? "partial\n" : "todo\n");
    assert.equal((await p.tool("exitcode_draft", { goal: "Reset the budget", criteria })).isError, true);
    await p.reply("/exitcode exit");
    assertEnforced(p);
    await p.command("exit");
    assert.equal(core.loadRoot(io(p), "G1").status, "PAUSED");
    assert.deepEqual([...p.getActiveTools()].sort(), [...original].sort());
  }
});

test("adapter: reload, restart, and resume reconnect to the right root with its goal and baseline", async (t) => {
  const h = harness(t);
  await h.command("Keep the original goal");
  for (const restart of [h.reload, h.restart]) {
    await restart();
    assertEnforced(h);
    assert.match(promptText(h), /Root goal: Keep the original goal/);
  }
  await h.tool("exitcode_draft", { goal: "Finish the feature", criteria });
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "changed before reload\n");
  await h.reload();
  assert.match((await settle(h)).entries[0].content, /modified feature\.txt/);
  assert.equal(feature(h), "todo\n");
  // Cancellation releases the baseline; resume starts from the current tree and requires fresh preparation.
  await h.command("exit");
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "edited while cancelled\n");
  await h.command("resume");
  assert.match(h.notifications.at(-1).content, /C1: The feature is done/);
  assert.equal(await settle(h), undefined);
  await h.command("approve");
  assert.match(h.notifications.at(-1).content, /must be prepared and validated before approval/);
  assert.equal(feature(h), "edited while cancelled\n");
  // A transcript must explicitly adopt the current workspace root before modifying it.
  const other = harness(t);
  await draft(other);
  other.entries.push({ type: "custom", customType: core.MODE_ENTRY_TYPE, data: { on: true, rootId: "G2" } });
  await other.restart();
  const before = core.loadRoot(io(other), "G1");
  assert.equal((await other.tool("exitcode_draft", { goal: "Changed", criteria, revise: "G1" })).details.code, "ROOT_MISMATCH");
  await other.command("approve");
  assert.match(other.notifications.at(-1).content, /session root differs/);
  assert.deepEqual(core.loadRoot(io(other), "G1"), before);
  await other.command("resume");
  assert.equal(core.resolveModeFromBranch(other.entries).rootId, "G1");
  assert.equal(core.statusSnapshot(io(other)).awaitingApproval, true);
});

test("adapter: independent review uses the selected model and session thinking in fresh, bounded, tool-free contexts", async (t) => {
  for (const mode of ["success", "error", "invalid-json", "malformed", "length", "missing-model", "cancel"]) await t.test(mode, async (t) => {
    const h = harness(t), registry = reviewRegistry(mode);
    h.ctx.modelRegistry = registry;
    h.ctx.tools = [{ name: "write", description: "Mutate the session candidate" }];
    h.entries.push({ type: "message", message: { role: "user", content: "Session-only history must not reach the reviewer", timestamp: Date.now() } });
    if (mode === "missing-model") h.ctx.model = undefined;
    await h.command("Write literal done into feature.txt and preserve the artifact");
    const controller = new AbortController();
    if (mode === "cancel") setTimeout(() => controller.abort(), 20);
    const result = await h.tools.get("exitcode_draft").execute("review-call", { goal: "Literal artifact", criteria }, controller.signal, () => {}, h.ctx);
    for (const call of registry.calls) {
      assert.equal(call.model, h.ctx.model);
      assert.equal(call.options.reasoning, h.ctx.thinkingLevel);
      assert.equal(call.options.maxTokens, core.REVIEW_MAX_TOKENS);
      assert.equal(call.context.systemPrompt, core.reviewPrompt(call.input.phase));
      assert.deepEqual(call.context.messages.map((m) => [m.role, m.content]), [["user", JSON.stringify(call.input)]]);
      assert.doesNotMatch(JSON.stringify(call.context), /Session-only history/);
      // Checks are hidden from the deriving reviewer to avoid check-author bias.
      if (call.input.phase === "derive") assert.doesNotMatch(JSON.stringify(call.input), /grep -qx|controls/);
      assert.ok(!call.context.tools?.length);
    }
    if (mode === "success") {
      assert.deepEqual(registry.calls.map((c) => c.input.phase), ["derive", "assess"]);
      assert.equal(registry.calls[0].input.originalRequest, "Write literal done into feature.txt and preserve the artifact");
      assert.equal(result.usage.input, 22);
      assert.equal(core.loadNodeState(io(h), "G1").evaluatorMetrics.tokenUsage.input, 22);
      // Repeated preparation follows session selection changes.
      h.ctx.model = { id: "changed-model", provider: "changed-provider" }; h.ctx.thinkingLevel = "max";
      await h.tool("exitcode_draft", { goal: "Literal artifact", criteria, revise: "G1" });
      assert.equal(registry.calls.length, 4);
      for (const c of registry.calls.slice(2)) { assert.equal(c.model, h.ctx.model); assert.equal(c.options.reasoning, "max"); }
    } else {
      assert.equal(result.isError, true);
      assert.equal(core.statusSnapshot(io(h)).awaitingApproval, false);
      assert.equal(core.approveRoot(io(h)).ok, false);
      assertEnforced(h);
      if (["error", "invalid-json", "malformed", "length"].includes(mode)) assert.equal(result.usage.input, 11, "billable failures still report usage");
      if (mode === "cancel") for (const call of registry.calls) assert.equal(call.options.signal.aborted, true);
    }
  });
});

test("adapter: /exitcode resume retries the saved operation and accepts only explicit positive grants", async (t) => {
  // Infrastructure pause during evaluation: resume retries without new acceptance.
  const h = harness(t);
  await draft(h);
  await h.command("approve");
  const before = core.loadRoot(io(h), "G1"), bytes = fs.readFileSync(core.sealedFile(h.cwd, "G1"), "utf8");
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  assert.equal((await core.evaluateNode(core.makeIo(h.cwd, { exec: async () => ({ exit: null, error: "temporary runner failure" }) }))).status, "PAUSED");
  await h.command("resume");
  const root = core.loadRoot(io(h), "G1");
  assert.equal(root.status, "PASS");
  assert.deepEqual([root.consumedAttempts, root.deadlineAt, root.approval], [1, before.deadlineAt, before.approval]);
  assert.equal(fs.readFileSync(core.sealedFile(h.cwd, "G1"), "utf8"), bytes);
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  // Deadline exhaustion: malformed or non-positive grants change nothing.
  const d = harness(t);
  await draft(d);
  await d.command("approve");
  const sealed = core.loadRoot(io(d), "G1");
  t.mock.method(Date, "now", () => sealed.deadlineAt + 1000);
  await settle(d);
  await d.command("resume");
  assert.match(d.notifications.at(-1).content, /execution budget exhausted/);
  for (const args of ["resume minutes=0", "resume minutes=-1", "resume attempts=0.5", "resume minutes=1 minutes=2"]) {
    const snapshot = core.loadRoot(io(d), "G1");
    await d.command(args);
    assert.deepEqual(core.loadRoot(io(d), "G1"), snapshot);
  }
  await d.command("exit");
  fs.writeFileSync(path.join(d.cwd, "feature.txt"), "done\n");
  await d.command("resume minutes=2 attempts=3");
  const granted = core.loadRoot(io(d), "G1");
  assert.equal(granted.status, "PASS");
  assert.equal(granted.deadlineAt, sealed.deadlineAt + 121000);
  assert.equal(granted.attemptLimit, sealed.policy.maxTotalAttempts + 3);
  assert.deepEqual(granted.policy, sealed.policy);
  t.mock.restoreAll();
  // Provider failure during preparation: resume completes review without another root or quality charge.
  const p = harness(t);
  p.ctx.modelRegistry = reviewRegistry("error");
  assert.equal((await draft(p)).details.status, "PAUSED");
  assert.equal(await settle(p), undefined);
  p.ctx.modelRegistry = reviewRegistry();
  await p.command("resume");
  assert.equal(core.statusSnapshot(io(p)).awaitingApproval, true);
  assert.equal(core.loadNodeState(io(p), "G1").evaluatorMetrics.e0Attempts, 1);
  assert.match(p.messages.at(-1).content, /Validated plan/);
  assert.equal(p.messages.at(-1).triggerTurn, false);
  // Evaluator budget exhaustion: grants add construction attempts without bypassing a failed negative.
  const e = harness(t);
  await e.command("Complete feature");
  await e.tool("exitcode_draft", { goal: "Feature", criteria: broken(), policy: { evaluatorAttempts: 1 } });
  await e.tool("exitcode_draft", { goal: "Feature", criteria: broken(), revise: "G1" });
  assert.equal(core.loadRoot(io(e), "G1").pause.code, "EVALUATOR_UNBUILDABLE");
  assertEnforced(e);
  await e.command("resume");
  assert.match(e.notifications.at(-1).content, /evaluators=N/);
  await e.command("resume evaluators=2");
  assert.equal(core.loadNodeState(io(e), "G1").evaluatorAttemptLimit, 3);
  assert.equal(core.statusSnapshot(io(e)).awaitingApproval, false);
  await e.tool("exitcode_draft", { goal: "Feature", criteria, revise: "G1" });
  assert.equal(core.statusSnapshot(io(e)).awaitingApproval, true);
});

test("adapter: cancellation and reload abort owned reviewer calls before clearing preparation locks", async (t) => {
  for (const operation of ["exit", "reload"]) {
    const h = harness(t), registry = reviewRegistry("cancel");
    h.ctx.modelRegistry = registry;
    await h.command("Complete feature");
    const updates = [];
    const pending = h.tools.get("exitcode_draft").execute("progress", { goal: "Feature", criteria }, undefined, (update) => updates.push(update), h.ctx);
    for (let i = 0; i < 400 && registry.calls.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(updates.some((u) => u.details.progress.stage === "quality-derive"), "progress updates reach the tool caller");
    if (operation === "exit") await h.command("exit"); else await h.reload();
    assert.equal((await pending).isError, true);
    assert.equal(registry.calls[0].options.signal.aborted, true);
    const node = core.loadNodeState(io(h), "G1");
    assert.deepEqual([node.preparing, node.evaluatorMetrics.e0Attempts], [undefined, 0]);
    assert.equal(fs.existsSync(core.storePaths(h.cwd).operation), false);
    assert.equal(core.loadRoot(io(h), "G1").status, "PAUSED");
    assert.equal(core.resolveModeFromBranch(h.entries).on, operation !== "exit");
  }
});
