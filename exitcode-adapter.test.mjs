import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as hostCore from "./exitcode-core.mjs";
import { fixedTestRuntime } from "./test/runtime.mjs";
import { structuralRegistry, structuralReview } from "./test/structural-review.mjs";

const core = { ...hostCore, makeIo: (cwd, overrides = {}) => hostCore.makeIo(cwd, { fingerprintRuntime: fixedTestRuntime, ...overrides }) };

// Exercise the actual adapter without requiring Pi's host-provided packages.
// Schema constructors are inert here; the supervisor validates draft behavior.
const source = stripTypeScriptTypes(fs.readFileSync(new URL("./exitcode.ts", import.meta.url), "utf8"))
  .replace('import { Type } from "typebox";', "")
  .replace('import * as core from "./exitcode-core.mjs";', "")
  .replace("export default function", "return function");
const Type = new Proxy({}, { get: () => () => ({}) });
const install = new Function("Type", "core", source)(Type, core);

const criteria = [
  {
    id: "C1", requirement: "The feature is done",
    check: { command: "grep -qx done feature.txt" },
    controls: {
      accept: { setup: "printf 'done\n' > feature.txt" },
      reject: [{ setup: "printf 'todo\n' > feature.txt" }],
    },
  },
  { id: "C2", requirement: "Existing behavior is preserved", type: "regression", check: { command: "test -f feature.txt" } },
];

function harness(t, content = "todo\n", initialTools = ["read", "write", "bash"], unavailableTools = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exitcode-adapter-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "feature.txt"), content);
  const tools = new Map();
  const events = new Map();
  const commands = new Map();
  const entries = [];
  const messages = [];
  const notifications = [];
  let active = [...initialTools];
  let idle = true;
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names) => { active = [...new Set(names)].filter((name) => !unavailableTools.includes(name)); },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (content) => messages.push({ content, triggerTurn: true }),
    sendMessage: (message, options) => messages.push({ ...message, ...options }),
  };
  const ctx = {
    cwd, hasUI: false, mode: "print", model:{id:"test-model",provider:"test"},thinkingLevel:"high",modelRegistry:structuralRegistry(), isIdle: () => idle,
    ui: { notify: (content, type) => notifications.push({ content, type }) },
    sessionManager: { getBranch: () => entries },
  };
  install(pi);
  return {
    cwd, ctx, tools, events, messages, notifications, entries, loadout: [...initialTools],
    setIdle: (value) => { idle = value; },
    getActiveTools: pi.getActiveTools,
    setActiveTools: pi.setActiveTools,
    reload: () => {
      return Promise.resolve(events.get("session_shutdown")?.({reason:"reload"},ctx)).then(()=>{install(pi);return events.get("session_start")({reason:"reload"},ctx);});
    },
    restart: () => {
      install(pi);
      return events.get("session_start")({ reason: "startup" }, ctx);
    },
    reply: (text) => {
      messages.push({ role: "user", content: text });
      return events.get("input")({ text, source: "interactive" }, ctx);
    },
    command: (args) => commands.get("exitcode").handler(args, ctx),
    tool: (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx),
  };
}

async function draft(h) {
  await h.command("Add the feature");
  return h.tool("exitcode_draft", {
    goal: "Finish the feature", criteria, assumptions: ["Use the existing interface"],
    exclusions: ["No redesign"], verification: "Exercise the feature and existing regression checks.",
  });
}

test("adapter: root review pauses until user approval is recorded", async (t) => {
  const h = harness(t);
  const result = await draft(h);
  assert.match(result.content[0].text, /C1: The feature is done/);
  assert.match(result.content[0].text, /C2: Existing behavior is preserved/);
  assert.doesNotMatch(result.content[0].text, /grep -qx/);
  assert.equal(h.tools.size, 6);
  assert.match(h.tools.get("exitcode_seal").description, /interpret the user's reply/);
  const io = core.makeIo(h.cwd);
  assert.equal(core.loadRoot(io, "G1").approval, undefined);
  assert.equal(core.statusSnapshot(io).awaitingApproval, true);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  const sealed = await h.tool("exitcode_seal", { node: "G1" });
  assert.equal(sealed.isError, true);
  assert.match(sealed.content[0].text, /requires explicit user approval/);
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 0);
  // Review does not lock tools; it discards any candidate change they make.
  for (const [toolName, input] of [["write", { path: "feature.txt" }], ["bash", { command: "true" }], ["read", { path: "feature.txt" }]]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx), undefined);
  }
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  const settled = await h.events.get("agent_before_settle")({}, h.ctx);
  assert.equal(settled.continue, true);
  assert.match(settled.entries[0].content, /modified feature\.txt/);
  assert.equal(fs.readFileSync(path.join(h.cwd, "feature.txt"), "utf8"), "todo\n");
  assert.equal(core.statusSnapshot(io).awaitingApproval, true);
});

test("adapter: approve runs E0 and starts autonomous implementation", async (t) => {
  const h = harness(t);
  await draft(h);
  await h.command("approve");
  const io = core.makeIo(h.cwd);
  assert.equal(core.loadNodeState(io, "G1").status, "ACTIVE");
  assert.equal(core.loadRoot(io, "G1").approval.digest, core.loadRoot(io, "G1").reviewDigest);
  assert.equal(core.loadBundle(io, "G1").contract.originalRequest, "Add the feature");
  assert.equal(core.statusSnapshot(io).awaitingApproval, false);
  assert.equal(h.messages.at(-1).triggerTurn, true);
  assert.match(h.messages.at(-1).content, /User approved root G1/);
  assert.equal((await h.events.get("agent_before_settle")({}, h.ctx)).continue, true);
  assert.equal(h.events.get("tool_call")({ toolName: "write", input: { path: "feature.txt" } }, h.ctx), undefined);
});

test("adapter: satisfied baseline still needs fresh evaluation to exit", async t=>{
 const h=harness(t,"done\n");await draft(h);await h.command('approve');assert.equal(core.loadRoot(core.makeIo(h.cwd),'G1').status,'ACTIVE');assert.equal(h.messages.at(-1).triggerTurn,true);await h.tool('exitcode_evaluate',{});assert.equal(core.loadRoot(core.makeIo(h.cwd),'G1').status,'PASS');assert.equal(h.tools.get('exitcode_draft').exposure,'hidden');
});

test("adapter: busy, extra arguments, mode off, and absent drafts cannot approve", async (t) => {
  const h = harness(t);
  await h.command("approve");
  assert.match(h.notifications.at(-1).content, /resume/);
  await h.command("Add the feature");
  await h.command("approve");
  assert.match(h.notifications.at(-1).content, /no DRAFT root/);
  await h.tool("exitcode_draft", { goal: "g", criteria });
  await h.command("approve extra");
  assert.match(h.notifications.at(-1).content, /Usage/);
  h.setIdle(false);
  await h.command("approve");
  assert.match(h.notifications.at(-1).content, /Wait for the agent/);
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").approval, undefined);
});

test("adapter: cancel and resume preserve the pending human review", async (t) => {
  const h = harness(t);
  await draft(h);
  const count = h.messages.length;
  await h.command("exit");
  assert.equal(h.tools.get("exitcode_draft").exposure, "hidden");
  assert.equal(h.messages.length, count);
  await h.command("resume");
  assert.equal(h.tools.get("exitcode_draft").exposure, "direct");
  assert.match(h.notifications.at(-1).content, /C1: The feature is done/);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  await h.events.get("session_start")({}, h.ctx);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
});

test("adapter: human review can wait without spending the execution deadline", async (t) => {
  const h=harness(t);await draft(h);const io=core.makeIo(h.cwd),root=core.loadRoot(io,"G1");
  t.mock.method(Date,"now",()=>root.createdAt+14*86400000);
  assert.equal(root.deadlineAt,null);
  assert.equal(await settle(h),undefined);
  await h.command("approve");
  const sealed=core.loadRoot(io,"G1");
  assert.equal(sealed.status,"ACTIVE");
  assert.equal(sealed.approval.approvedBy,"user");
  assert.equal(core.loadNodeState(io,"G1").sealAttempts,1);
  assert.equal(sealed.executionStartedAt,Date.now());
  assert.equal(sealed.deadlineAt,Date.now()+60*60000);
  assertEnforced(h);
});

test("adapter: initial limits can change before approval and lock at sealing across reload", async (t) => {
  const h=harness(t);await h.command("Complete the implementation");
  await h.tool("exitcode_draft",{goal:"Complete implementation",criteria,policy:{deadlineMinutes:480,maxTotalAttempts:24,maxDepth:1,evalTimeoutSeconds:900}});
  const io=core.makeIo(h.cwd),before=core.loadRoot(io,"G1");
  assert.equal(core.statusSnapshot(io).policyEditable,true);
  const revision=await h.tool("exitcode_draft",{revise:"G1",goal:"Complete implementation",criteria,policy:{deadlineMinutes:900}});
  assert.equal(revision.isError,undefined);
  assert.equal(core.loadRoot(io,"G1").createdAt,before.createdAt);
  assert.equal(core.loadRoot(io,"G1").deadlineAt,null);
  await h.reload();assertEnforced(h);
  await h.command("status");assert.match(h.notifications.at(-1).content,/"deadlineMinutes":900/);
  await h.command("exit");await h.command("resume");await h.command("approve");
  const sealed=core.loadRoot(io,"G1");
  assert.equal(core.loadNodeState(io,"G1").status,"ACTIVE");
  assert.equal(sealed.deadlineAt,sealed.executionStartedAt+900*60000);
  assert.equal((await h.tool("exitcode_draft",{revise:"G1",goal:"Changed limits",criteria,policy:{deadlineMinutes:1200}})).isError,true);
});

test("adapter: failed E0 permits operational revision but invalid limits remain atomic", async (t) => {
  const h=harness(t);await h.command("Complete the feature");const broken=structuredClone(criteria);
  broken[0].controls.reject[0].setup="printf 'done\n' > feature.txt";
  await h.tool("exitcode_draft",{goal:"Feature",criteria:broken});await h.command("approve");
  const io=core.makeIo(h.cwd),before=core.loadRoot(io,"G1");
  const invalid=await h.tool("exitcode_draft",{revise:"G1",goal:"Changed scope",criteria,policy:{deadlineMinutes:-1}});
  assert.equal(invalid.isError,true);assert.deepEqual(core.loadRoot(io,"G1"),before);
  const revised=await h.tool("exitcode_draft",{revise:"G1",goal:"Feature",criteria,policy:{deadlineMinutes:480,maxTotalAttempts:24}});
  assert.equal(revised.isError,undefined);await h.reload();
  assert.equal(core.loadRoot(io,"G1").approval,undefined);
  assert.equal(core.statusSnapshot(io).policyEditable,true);
  assert.equal(core.loadNodeState(io,"G1").sealAttempts,0);assertEnforced(h);
  await h.command("approve");assert.equal(core.loadNodeState(io,"G1").status,"ACTIVE");
  assert.equal(core.loadNodeState(io,"G1").sealAttempts,1);
});

test("adapter: extension housekeeping cannot overwrite the retained user objective", async (t) => {
  const h = harness(t);
  await h.command("Complete Phases 1 and 2");
  await h.reload();
  const proposal = await h.tool("exitcode_draft", { goal: "Commit-only detour", criteria,
    originalRequest: "Commit ladder: clean the working tree" });
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).originalRequest, "Complete Phases 1 and 2");
  assert.match((await h.tool("exitcode_status",{})).content[0].text, /Complete Phases 1 and 2/);
  const revised = await h.tool("exitcode_draft", { revise: "G1", goal: "Complete the implementation", criteria,
    originalRequest: "Another extension reminder" });
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).originalRequest, "Complete Phases 1 and 2");
  const event = { systemPromptOptions: { sections: {} } };
  h.events.get("before_agent_start")(event, h.ctx);
  assert.match(event.systemPromptOptions.sections.exitcode, /original objective above extension housekeeping and commit reminders/);
  assert.equal(h.events.get("tool_call")({ toolName: "git_plan_context", input: {} }, h.ctx), undefined);
  assertEnforced(h);
});

test("adapter: failed preparation repairs before first user review", async t=>{
 const h=harness(t);await h.command('Add the feature');const broken=structuredClone(criteria);broken[0].controls.reject[0].setup="printf 'done\n' > feature.txt";
 const result=await h.tool('exitcode_draft',{goal:'g',criteria:broken});assert.equal(result.isError,true);assert.equal(result.details.review,undefined);assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).awaitingApproval,false);
 assert.equal((await h.events.get('agent_before_settle')({},h.ctx)).continue,true);
 const repaired=await h.tool('exitcode_draft',{goal:'g',criteria,revise:'G1'});assert.match(repaired.content[0].text,/Validated plan/);assert.equal(await h.events.get('agent_before_settle')({},h.ctx),undefined);await h.command('approve');assert.equal(core.loadNodeState(core.makeIo(h.cwd),'G1').sealAttempts,1);
});

test("adapter: plain-English acceptance seals and continues without a command", async (t) => {
  const h = harness(t);
  await draft(h);
  const reply = "Looks good, go ahead.";
  await h.reply(reply);
  // The model interprets the reply; this exercises the operation it selects.
  const result = await h.tool("exitcode_seal", { node: "G1", userApproval: reply });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /sealed G1/);
  const io = core.makeIo(h.cwd);
  assert.equal(core.loadNodeState(io, "G1").status, "ACTIVE");
  assert.equal(core.loadRoot(io, "G1").approval.userReply, reply);
  assert.equal(core.loadRoot(io, "G1").approval.digest, core.loadRoot(io, "G1").reviewDigest);
  assert.equal(h.messages.at(-1).content, reply); // No synthetic command-triggered turn.
  assert.equal((await h.events.get("agent_before_settle")({}, h.ctx)).continue, true);
  assert.equal(h.events.get("tool_call")({ toolName: "write", input: { path: "feature.txt" } }, h.ctx), undefined);
});

test("adapter: change requests revise and pause for a fresh conversational acceptance", async (t) => {
  const h = harness(t);
  await draft(h);
  const reply = "Looks good, but also require the existing interface.";
  await h.reply(reply);
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").approval, undefined);
  const revisedCriteria = structuredClone(criteria);
  revisedCriteria[0].requirement += " through the existing interface";
  const revision = await h.tool("exitcode_draft", { goal: "Finish the feature", criteria: revisedCriteria, revise: "G1" });
  assert.match(revision.content[0].text, /through the existing interface/);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assert.equal((await h.tool("exitcode_seal", { node: "G1" })).isError, true);
  const accepted = "Yes, that version works. Please proceed.";
  await h.reply(accepted);
  assert.equal((await h.tool("exitcode_seal", { node: "G1", userApproval: accepted })).isError, undefined);
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").approval.userReply, accepted);
});

test("adapter: conversational E0 failure requires fresh approval after revision", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  const broken = structuredClone(criteria);
  broken[0].controls.reject[0].setup = "printf 'done\\n' > feature.txt";
  await h.tool("exitcode_draft", { goal: "g", criteria: broken });
  const firstReply = "Proceed.";
  await h.reply(firstReply);
  assert.equal((await h.tool("exitcode_seal", { node: "G1", userApproval: firstReply })).isError, true);
  const io = core.makeIo(h.cwd);
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 0);
  await h.tool("exitcode_draft", { goal: "g", criteria, revise: "G1" });
  assert.equal(core.loadRoot(io, "G1").approval, undefined);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assert.equal((await h.tool("exitcode_seal", { node: "G1" })).isError, true);
  const newReply = "The revised version looks good.";
  await h.reply(newReply);
  assert.equal((await h.tool("exitcode_seal", { node: "G1", userApproval: newReply })).isError, undefined);
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 1);
  assert.equal(core.loadRoot(io, "G1").approval.userReply, newReply);
});

test("adapter: conversational acceptance needs fresh completion even with passing baseline", async t=>{
 const h=harness(t,'done\n');await draft(h);await h.reply('Go ahead.');await h.tool('exitcode_seal',{node:'G1',userApproval:'Go ahead.'});assert.equal(core.loadRoot(core.makeIo(h.cwd),'G1').status,'ACTIVE');await h.tool('exitcode_evaluate',{});assert.equal(core.loadRoot(core.makeIo(h.cwd),'G1').status,'PASS');assert.equal(h.tools.get('exitcode_seal').exposure,'hidden');assert.equal(await h.events.get('agent_before_settle')({},h.ctx),undefined);
});

test("adapter: review instructions distinguish acceptance, changes, and unclear intent", async (t) => {
  const h = harness(t);
  await draft(h);
  const event = { systemPromptOptions: { sections: {} } };
  h.events.get("before_agent_start")(event, h.ctx);
  const prompt = event.systemPromptOptions.sections.exitcode;
  assert.match(prompt, /wait for explicit user approval/);
  assert.match(h.tools.get("exitcode_draft").description, /STOP for user review/);
  const seal = h.tools.get("exitcode_seal").description;
  for (const text of ["acceptance, requested changes, or a question", "userApproval quoting the reply",
    "reply requesting changes is not approval, even with assent", "Ask when unclear", "Never infer approval",
    "revision after review requires validation and fresh approval", "Children need no userApproval"]) {
    assert.ok(seal.includes(text), text);
  }
  assert.doesNotMatch(core.PROTOCOL_PROMPT, /userApproval/);
  await h.reply("What does the second criterion mean?");
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").approval, undefined);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
});

test("adapter: tool descriptions carry evaluator and decomposition requirements", (t) => {
  const h = harness(t);
  const draft = h.tools.get("exitcode_draft").description;
  for (const text of ["known-valid and known-invalid fixtures", "temporary candidate copies",
    "same check must PASS", "FAIL every invalid fixture, not ERROR", "Do not change the real candidate"]) {
    assert.ok(draft.includes(text), text);
  }
  const child = h.tools.get("exitcode_child").description;
  for (const text of ["exactly one failed parent criterion", "configured local repair attempts",
    "early prerequisite", "observable prerequisiteArtifact", "child's own checks", "without user approval"]) {
    assert.ok(child.includes(text), text);
  }
  assert.match(h.tools.get("exitcode_evaluate").description, /reruns the parent when a child passes/);
  assert.match(h.tools.get("exitcode_evaluate").description, /Follow the returned parent result and next action/);
  assert.doesNotMatch(h.tools.get("exitcode_status").namespace.instructions, /userApproval|ALL PASS/);
});

test("adapter: continuation reports unresolved state and the supervisor's next action", async (t) => {
  const h = harness(t);
  await draft(h);
  await h.command("approve");
  const snap = core.statusSnapshot(core.makeIo(h.cwd));
  for (let i = 0; i < core.MAX_SETTLE_NUDGES; i++) {
    const nudge = await h.events.get("agent_before_settle")({}, h.ctx);
    assert.equal(nudge.continue, true);
    const content = nudge.entries[0].content;
    assert.match(content, /G1 remains ACTIVE :: C1=FAIL C2=PASS/);
    assert.ok(content.endsWith(`next: ${snap.next}`));
    assert.doesNotMatch(content, /Only a fresh|ALL PASS|stalled/);
  }
  const paused=await settle(h);assert.equal(paused.continue,undefined);assert.match(paused.entries[0].content,/No observable progress/);
  assert.equal(core.loadRoot(core.makeIo(h.cwd),"G1").pause.code,"NO_PROGRESS");
});

const feature = (h) => fs.readFileSync(path.join(h.cwd, "feature.txt"), "utf8");
const settle = (h) => h.events.get("agent_before_settle")({}, h.ctx);

function assertEnforced(h) {
  assert.equal(core.resolveModeFromBranch(h.entries).on, true);
  assert.equal(h.tools.get("exitcode_draft").exposure, "direct");
  for (const name of h.loadout) assert.ok(h.getActiveTools().includes(name), `${name} stays enabled`);
  // Tools are not classified; only direct supervisor-state access is denied.
  for (const [toolName, input] of [
    ["write", { path: "feature.txt" }], ["bash", { command: "npm test" }],
    ["codemode", { code: 'await tools.bash({command: "pi ..."})' }],
    ["find", {}], ["context", {}], ["git_commit_plan", {}], ["exitcode_exit", {}],
  ]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx), undefined, toolName);
  }
  for (const [toolName, input] of [
    ["write", { path: ".exitcode/drafts/manual.json" }], ["read", { path: ".exitcode/index.json" }],
    ["bash", { command: "cat .exitcode/index.json" }],
  ]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx).block, true, toolName);
    // Nested calls receive the same event policy, regardless of their parent.
    assert.equal(h.events.get("tool_call")({ toolName, input, parentToolCallId: "outer" }, h.ctx).block, true, toolName);
  }
}

/** A pre-seal change from any tool is discarded at the next settle. */
async function assertFrozen(h, expected = "todo\n") {
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "changed by a tool\n");
  await settle(h);
  assert.equal(feature(h), expected);
}

test("adapter: the user's tool loadout is never changed", async (t) => {
  const original = ["bash", "read", "write", "codemode"];
  const h = harness(t, "todo\n", original);
  const loadout = () => h.getActiveTools().filter((name) => !core.EXITCODE_TOOL_NAMES.includes(name));
  await h.command("Add the feature");
  assert.deepEqual(loadout(), original);
  for (const [toolName, input] of [["bash", { command: "true" }], ["write", { path: "feature.txt" }], ["codemode", {}]]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx), undefined);
  }
  await h.tool("exitcode_draft", { goal: "g", criteria });
  assert.deepEqual(loadout(), original);
  h.setActiveTools([...h.getActiveTools().filter((name) => name !== "read"), "custom_tool"]);
  await h.command("approve");
  assert.deepEqual(loadout(), ["bash", "write", "codemode", "custom_tool"]);
  await h.command("exit");
  assert.deepEqual(h.getActiveTools(), ["bash", "write", "codemode", "custom_tool"]);
  assert.ok(h.entries.every((entry) => !("discoveryToolsAdded" in entry.data) && !("toolsSuspended" in entry.data)));
});

test("adapter: pre-seal changes from any tool are restored at settle and reported", async (t) => {
  const h = harness(t, "todo\n", ["read", "write", "bash", "semantic_repo_search"]);
  h.ctx.hasUI = true;
  await h.command("Add the feature");
  // An unrecognized analysis tool may run, but its candidate side effects are discarded.
  assert.equal(h.events.get("tool_call")({ toolName: "semantic_repo_search", input: { query: "feature" } }, h.ctx), undefined);
  fs.mkdirSync(path.join(h.cwd, ".cache"));
  fs.writeFileSync(path.join(h.cwd, ".cache/generated-index.json"), "{}");
  const first = await settle(h);
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /added \.cache\/generated-index\.json/);
  assert.match(first.entries[0].content, /Continue inspection without modifying the candidate/);
  assert.match(h.notifications.at(-1).content, /\.exitcode\/discarded\/d-000001/);
  assert.equal(fs.existsSync(path.join(h.cwd, ".cache")), false);
  assert.equal(fs.readFileSync(path.join(h.cwd, ".exitcode/discarded/d-000001/files/.cache/generated-index.json"), "utf8"), "{}");
  for (let i = 1; i < core.MAX_SETTLE_NUDGES; i++) {
    fs.writeFileSync(path.join(h.cwd, "feature.txt"), `attempt ${i}\n`);
    assert.equal((await settle(h)).continue, true);
  }
  // Continuations are bounded; restoration is not.
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "again\n");
  const paused=await settle(h);assert.equal(paused.continue,undefined);assert.match(paused.entries[0].content,/Discovery is paused/);
  assert.equal(feature(h), "todo\n");
  assert.equal(await settle(h), undefined);
});

test("adapter: drafting and conversational approval discard earlier candidate changes", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  const drafted = await h.tool("exitcode_draft", { goal: "Finish the feature", criteria });
  assert.equal(drafted.isError, undefined);
  assert.match(drafted.content[0].text, /C1: The feature is done/);
  assert.match(drafted.content[0].text, /warnings:\n- Candidate changes are not permitted[^\n]*modified feature\.txt/);
  assert.equal(feature(h), "todo\n");
  fs.writeFileSync(path.join(h.cwd, "scratch.txt"), "notes\n");
  await h.reply("Go ahead.");
  const sealed = await h.tool("exitcode_seal", { node: "G1", userApproval: "Go ahead." });
  assert.equal(sealed.isError, undefined);
  assert.match(sealed.content[0].text, /sealed G1/);
  assert.match(sealed.content[0].text, /added scratch\.txt/);
  assert.equal(fs.existsSync(path.join(h.cwd, "scratch.txt")), false);
  assert.equal(fs.existsSync(path.join(h.cwd, ".exitcode/baseline")), false);
  // Sealed execution keeps candidate changes.
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  assert.equal((await settle(h)).continue, true);
  assert.equal(feature(h), "done\n");
});

test("adapter: command approval reports and discards review-time changes", async (t) => {
  const h = harness(t);
  await draft(h);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "edited during review\n");
  await h.command("approve");
  assert.equal(core.loadNodeState(core.makeIo(h.cwd), "G1").status, "ACTIVE");
  assert.match(h.messages.at(-1).content, /User approved root G1/);
  assert.match(h.messages.at(-1).content, /modified feature\.txt/);
  assert.equal(feature(h), "todo\n");
});

test("adapter: failed E0 and root revisions keep the candidate frozen until sealing", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  const broken = structuredClone(criteria);
  broken[0].controls.reject[0].setup = "printf 'done\\n' > feature.txt";
  await h.tool("exitcode_draft", { goal: "g", criteria: broken });
  await h.command("approve");
  assertEnforced(h);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  const revised = await h.tool("exitcode_draft", { goal: "g", criteria, revise: "G1" });
  assert.match(revised.content[0].text, /modified feature\.txt/);
  assert.equal(feature(h), "todo\n");
  await h.command("approve");
  assert.equal(core.loadNodeState(core.makeIo(h.cwd), "G1").status, "ACTIVE");
});

test("adapter: cancellation and resume start from the current tree", async (t) => {
  const h = harness(t);
  await draft(h);
  await h.command("exit");
  assert.equal(fs.existsSync(path.join(h.cwd, ".exitcode/baseline")), false);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "edited while cancelled\n");
  await h.command("resume");
  assert.equal(await settle(h), undefined);
  assert.equal(feature(h), "edited while cancelled\n");
  // Evidence for the previous candidate is stale and never sealed.
  await h.command("approve");
  assert.match(h.notifications.at(-1).content, /must be prepared and validated before approval/);
  assert.equal(feature(h), "edited while cancelled\n");
});

test("adapter: reload and transcript resume keep the pre-seal baseline", async (t) => {
  const h = harness(t);
  await draft(h);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "changed before reload\n");
  await h.reload();
  assert.match((await settle(h)).entries[0].content, /modified feature\.txt/);
  assert.equal(feature(h), "todo\n");
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "changed before restart\n");
  await h.restart();
  await h.command("approve");
  assert.equal(core.loadNodeState(core.makeIo(h.cwd), "G1").status, "ACTIVE");
  assert.match(h.messages.at(-1).content, /modified feature\.txt/);
  assert.equal(feature(h), "todo\n");
});

test("adapter: root PASS exits mode without touching the loadout", async (t) => {
  const h = harness(t, "done\n");
  const original = [...h.getActiveTools()];
  await draft(h);
  await h.command("approve");
  await h.tool("exitcode_evaluate", {});
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  assert.deepEqual(h.getActiveTools(), original);
  assert.equal(fs.existsSync(path.join(h.cwd, ".exitcode/baseline")), false);
});

function promptText(h) {
  const event = { systemPromptOptions: { sections: {} } };
  h.events.get("before_agent_start")(event, h.ctx);
  return event.systemPromptOptions.sections.exitcode;
}

test("adapter: discovery clarification and ordinary replies never switch enforcement off", async (t) => {
  const h = harness(t, "todo\n", ["read", "write", "bash", "codemode", "find", "context", "git_commit_plan"]);
  await h.command("Complete all five phases");
  assertEnforced(h);
  assert.match(promptText(h), /Root goal: Complete all five phases/);
  assert.match(promptText(h), /Inspect with any available tools without changing the candidate/);
  assert.match(promptText(h), /Pre-seal changes are discarded/);
  assert.equal(await settle(h), undefined);
  await h.reply("Option 1: use the shared engine.");
  assert.equal(await settle(h), undefined);
  assertEnforced(h);
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).active, false);
  const status = await h.tool("exitcode_status", {});
  assert.match(status.content[0].text, /DISCOVERY/);
  assert.equal(status.details.pendingGoal, "Complete all five phases");
  assert.equal(status.details.modeOn, true);
  // An extension-injected reminder or new tool cannot turn discovery into coding.
  h.setActiveTools([...h.getActiveTools(), "git_commit_plan"]);
  await h.events.get("input")({ text: "Record a commit", source: "extension" }, h.ctx);
  assert.match(promptText(h), /Complete all five phases/);
  assertEnforced(h);
  await assertFrozen(h);
  const proposal = await h.tool("exitcode_draft", { goal: "Finish the feature", criteria });
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).originalRequest, "Complete all five phases");
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").approval, undefined);
  assert.equal(await settle(h), undefined);
  assertEnforced(h);
});

test("adapter: pre-draft reload and transcript resume retain the goal and enforcement", async (t) => {
  const h = harness(t);
  const original = [...h.getActiveTools()];
  await h.command("Keep the original goal");
  for (const restart of [h.reload, h.restart, h.reload]) {
    await restart();
    assertEnforced(h);
    assert.match(promptText(h), /Root goal: Keep the original goal/);
    assert.equal(await settle(h), undefined);
  }
  await h.command("exit extra");
  assert.match(h.notifications.at(-1).content, /Usage/);
  assertEnforced(h);
  await h.reply("/exitcode exit"); // Text alone is not command dispatch.
  assertEnforced(h);
  await h.command("exit"); // Only the actual user-command path cancels.
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  assert.equal(fs.existsSync(path.join(h.cwd, ".exitcode/baseline")), false);
  assert.equal(h.events.get("tool_call")({ toolName: "write", input: { path: ".exitcode/index.json" } }, h.ctx), undefined);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  assert.equal(await settle(h), undefined);
  assert.equal(feature(h), "done\n");
});

test("adapter: root PAUSED preserves work and enforcement before or after sealing", async (t) => {
  for (const sealed of [false, true]) {
    await t.test(sealed ? "sealed" : "draft", async (t) => {
      const h = harness(t);
      const original = [...h.getActiveTools()];
      await draft(h);
      if (sealed) {
        await h.command("approve");
        fs.writeFileSync(path.join(h.cwd, "feature.txt"), "partial\n");
      }
      const result = await h.tool("exitcode_block", { node: "G1", reason: "Missing authorization", code: "AUTHORIZATION_MISSING" });
      assert.equal(result.details.status,"PAUSED");assert.equal(result.details.pause.code,"AUTHORIZATION_MISSING");
      assertEnforced(h);
      assert.equal(await settle(h), undefined);
      assert.match(promptText(h), /G1 \[PAUSED\]/);
      assert.match(promptText(h), /Missing authorization/);
      await h.reload();
      assertEnforced(h);
      assert.equal(await settle(h), undefined);
      // The terminal pause freezes the tree it stopped on, including sealed work.
      await assertFrozen(h, sealed ? "partial\n" : "todo\n");
      await h.reply("Continue");
      assertEnforced(h);
      const redraft = await h.tool("exitcode_draft", { goal: "Reset the budget", criteria });
      assert.equal(redraft.isError, true);
      assert.match(redraft.content[0].text,/revise|resume|user must cancel/);
      await h.command("exit");
      assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").status, "PAUSED");
      assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
    });
  }
});

test("adapter: missing roots and unexpected leaf states never release the pre-seal invariant", async (t) => {
  for (const missing of ["root", "leaf"]) {
    await t.test(missing, async (t) => {
      const h = harness(t);
      await draft(h);
      if (missing === "root") fs.rmSync(path.join(h.cwd, ".exitcode/roots/G1.json"));
      else {
        const io = core.makeIo(h.cwd);
        const node = core.loadNodeState(io, "G1");
        node.status = "UNKNOWN";
        core.saveNodeState(io, node);
      }
      assert.equal(await settle(h), undefined);
      assertEnforced(h);
      await assertFrozen(h);
    });
  }
});

test("adapter: legacy narrowed loadouts are returned once", async (t) => {
  for (const owned of [false, true]) {
    const original = ["read", "write", "bash", ...(owned ? ["find"] : [])];
    const h = harness(t, "todo\n", original);
    // Older versions suspended execution tools and borrowed discovery tools before sealing.
    h.setActiveTools(["read", "grep", "ls", "find"]);
    h.entries.push({ type: "custom", customType: core.MODE_ENTRY_TYPE, data: { on: true, pendingGoal: "Old goal",
      discoveryToolsAdded: ["grep", "ls", ...(!owned ? ["find"] : [])], toolsSuspended: ["write", "bash"] } });
    await h.restart();
    assert.deepEqual(h.getActiveTools().filter((name) => !core.EXITCODE_TOOL_NAMES.includes(name)).sort(), [...original].sort());
    assert.deepEqual(h.entries.at(-1).data, { on: true, rootId: undefined, pendingGoal: "Old goal" });
    const count = h.entries.length;
    await h.restart();
    assert.equal(h.entries.length, count);
    assertEnforced(h);
    await h.command("exit");
    assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  }
});

test("adapter: child drafts freeze the parent's work until seal or block", async (t) => {
  for (const outcome of ["seal", "block", "failed E0"]) {
    await t.test(outcome, async (t) => {
      const h = harness(t);
      await draft(h);
      await h.command("approve");
      const progress = path.join(h.cwd, "progress.txt");
      fs.writeFileSync(progress, "parent work\n");
      const childCriteria = [{
        id: "D1", requirement: "The prerequisite is done",
        check: { command: "grep -qx ready helper.txt" },
        controls: {
          accept: { setup: "printf 'ready\\n' > helper.txt" },
          reject: [{ setup: "printf 'todo\\n' > helper.txt" }],
        },
      }];
      if (outcome === "failed E0") childCriteria[0].controls.reject[0].setup = "printf 'ready\\n' > helper.txt";
      const result = await h.tool("exitcode_child", {
        parent: "G1", target: "C1", goal: "Build the prerequisite", criteria: childCriteria,
        reason: "C1 needs the helper", prerequisite: true, prerequisiteArtifact: "helper.txt",
      });
      assert.equal(result.isError, undefined);
      assertEnforced(h);
      fs.writeFileSync(progress, "rewritten while drafting the child\n");
      if (outcome === "block") {
        // Blocking restores the pre-child candidate, which is the same parent work.
        await h.tool("exitcode_block", { node: "G1.1", reason: "Missing prerequisite" });
      } else {
        const sealed = await h.tool("exitcode_seal", { node: "G1.1" });
        assert.match(sealed.content[0].text, /modified progress\.txt/);
        assert.equal(sealed.isError, outcome === "failed E0" ? true : undefined);
        if (outcome === "failed E0") {
          await h.tool("exitcode_child", {
            parent: "G1", target: "C1", goal: "Build the prerequisite", criteria: [{ ...childCriteria[0],
              controls: { ...childCriteria[0].controls, reject: [{ setup: "printf 'todo\\n' > helper.txt" }] } }],
            reason: "C1 needs the helper", prerequisite: true, prerequisiteArtifact: "helper.txt", revise: "G1.1",
          });
          assert.equal((await h.tool("exitcode_seal", { node: "G1.1" })).isError, undefined);
        }
      }
      assert.equal(fs.readFileSync(progress, "utf8"), "parent work\n");
      assert.equal(fs.existsSync(path.join(h.cwd, ".exitcode/baseline")), false);
      // Sealed execution resumes with ordinary candidate changes.
      fs.writeFileSync(progress, "execution work\n");
      await settle(h);
      assert.equal(fs.readFileSync(progress, "utf8"), "execution work\n");
    });
  }
});

test("adapter: stale terminal PASS never switches mode off", async (t) => {
  const h = harness(t);
  await draft(h);
  const io = core.makeIo(h.cwd);
  // Simulate restoring a mode-on transcript whose on-disk PASS is no longer current.
  const root = core.loadRoot(io, "G1");
  root.status = "PASS";
  root.stack = [];
  root.outcome = { candidateDigest: core.digestTree(h.cwd) };
  core.saveRoot(io, root);
  const index = core.loadIndex(h.cwd);
  index.activeRootId = null;
  core.saveIndex(h.cwd, index);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "changed\n");
  await h.reload();
  assert.equal(await settle(h), undefined);
  assertEnforced(h);
  await assertFrozen(h, "changed\n");
});

test("adapter: fresh evaluation PASS exits, but a child PASS does not release enforcement", async (t) => {
  const h = harness(t);
  await draft(h);
  await h.command("approve");
  const childCriteria = [{
    id: "D1", requirement: "Helper ready", check: { command: "grep -qx ready helper.txt" },
    controls: { accept: { setup: "printf 'ready\n' > helper.txt" }, reject: [{ setup: "printf 'todo\n' > helper.txt" }] },
  }];
  await h.tool("exitcode_child", { parent: "G1", target: "C1", goal: "Prepare helper", criteria: childCriteria,
    reason: "Helper is a prerequisite", prerequisite: true, prerequisiteArtifact: "helper.txt" });
  await h.tool("exitcode_seal", { node: "G1.1" });
  fs.writeFileSync(path.join(h.cwd, "helper.txt"), "ready\n");
  const child = await h.tool("exitcode_evaluate", { node: "G1.1" });
  assert.equal(child.details.status, "PASS");
  assert.equal(child.details.cascade.terminal, null);
  assert.equal(core.resolveModeFromBranch(h.entries).on, true);
  assert.equal(h.tools.get("exitcode_evaluate").exposure, "direct");
  assert.equal(core.loadNodeState(core.makeIo(h.cwd), "G1").lastResult.allPass, false);
  fs.writeFileSync(path.join(h.cwd, "feature.txt"), "done\n");
  const root = await h.tool("exitcode_evaluate", { node: "G1" });
  assert.equal(root.details.cascade.terminal.status, "PASS");
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  assert.equal(h.tools.get("exitcode_evaluate").exposure, "hidden");
});

test("adapter: exhausted evaluator construction remains enforced", async t=>{
 const h=harness(t);await h.command('Add feature');const broken=structuredClone(criteria);broken[0].controls.reject[0].setup="printf 'done\n' > feature.txt";
 await h.tool('exitcode_draft',{goal:'g',criteria:broken,policy:{evaluatorAttempts:2}});
 await h.tool('exitcode_draft',{goal:'g',criteria:broken,revise:'G1'});
 await h.tool('exitcode_draft',{goal:'g',criteria:broken,revise:'G1'});
 assert.equal(core.loadRoot(core.makeIo(h.cwd),'G1').status,'PAUSED');assertEnforced(h);assert.equal(await h.events.get('agent_before_settle')({},h.ctx),undefined);assert.equal(core.resolveModeFromBranch(h.entries).on,true);
});


// Real selected-model boundary, including billable failures and operation cancellation.
import { reviewRegistry } from './test/adapter-review-cases.mjs';
for(const mode of ['success','error','invalid-json','malformed','length','missing-model','cancel'])test(`adapter: independent review ${mode}`,async t=>{
  const h=harness(t),registry=reviewRegistry(mode);h.ctx.modelRegistry=registry;
  if(mode==='missing-model')h.ctx.model=undefined;
  await h.command('Write literal done into feature.txt and preserve the artifact');
  const controller=new AbortController();
  if(mode==='cancel')setTimeout(()=>controller.abort(),20);
  const result=await h.tools.get('exitcode_draft').execute('review-call',{
    goal:'Literal artifact',criteria,intentAtoms:criteria.map(c=>({id:c.id,outcome:c.requirement,criteria:[c.id]})),
  },controller.signal,()=>{},h.ctx);
  for(const c of registry.calls){
    assert.equal(c.model,h.ctx.model);assert.equal(c.options.reasoning,h.ctx.thinkingLevel);assert.ok(c.options.signal instanceof AbortSignal);
    assert.equal(c.options.maxTokens,core.REVIEW_MAX_TOKENS);
    assert.equal(c.context.tools?.length,1);assert.equal(c.context.tools[0].name,"submit_review");
    assert.deepEqual(c.context.tools[0].constrainedSampling,{type:"json_schema",strict:"prefer"});
  }
  if(registry.calls.length){
    const first=registry.calls[0];assert.equal(first.input.phase,'derive');
    assert.equal(first.input.originalRequest,'Write literal done into feature.txt and preserve the artifact');
    assert.ok(!JSON.stringify(first.input).includes('controls'));assert.ok(!JSON.stringify(first.input).includes('grep -qx'));
  }
  if(mode==='success'){
    assert.equal(registry.calls.length,2);assert.equal(result.isError,undefined);
    assert.equal(result.usage.input,22);assert.equal(result.usage.output,14);
    assert.equal(core.loadNodeState(core.makeIo(h.cwd),'G1').evaluatorMetrics.tokenUsage.input,22);
    assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).awaitingApproval,true);
    assert.equal(await h.events.get('agent_before_settle')({},h.ctx),undefined);
    // Repeated preparation follows session selection changes, even if probes are cached.
    h.ctx.model={id:'changed-model',provider:'changed-provider'};h.ctx.thinkingLevel='max';
    const revised=await h.tool('exitcode_draft',{goal:'Literal artifact',criteria,revise:'G1'});
    assert.equal(revised.usage.input,22);assert.equal(registry.calls.length,4);
    for(const c of registry.calls.slice(2)){
      assert.equal(c.model,h.ctx.model);assert.equal(c.options.reasoning,h.ctx.thinkingLevel);
    }
    assert.equal(core.loadNodeState(core.makeIo(h.cwd),'G1').evaluatorMetrics.tokenUsage.input,44);
  }else{
    assert.equal(result.isError,true);assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).awaitingApproval,false);
    assert.equal(core.approveRoot(core.makeIo(h.cwd)).ok,false);assertEnforced(h);
    if(['error','invalid-json','malformed','length'].includes(mode))assert.equal(result.usage.input,11);
    if(mode==='cancel'){assert.equal(controller.signal.aborted,true);for(const call of registry.calls)assert.equal(call.options.signal.aborted,true);}
  }
});

for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  test(`adapter: review inherits session thinking ${thinkingLevel} in fresh schema-tool contexts`, async (t) => {
    const h = harness(t);
    const registry = reviewRegistry();
    h.ctx.modelRegistry = registry;
    h.ctx.thinkingLevel = thinkingLevel;
    h.ctx.tools = [{ name: "write", description: "Mutate the session candidate" }];
    h.entries.push({ type: "message", message: {
      role: "user", content: "Session-only history must not reach the reviewer", timestamp: Date.now(),
    } });

    const result = await draft(h);
    assert.equal(result.isError, undefined);
    assert.deepEqual(registry.calls.map(c => c.input.phase), ["derive", "assess"]);
    for (const call of registry.calls) {
      assert.equal(call.model, h.ctx.model);
      assert.equal(call.options.reasoning, thinkingLevel);
      assert.equal(call.context.systemPrompt, core.reviewPrompt(call.input.phase));
      assert.equal(call.context.messages.length, 1);
      assert.equal(call.context.messages[0].role, "user");
      assert.equal(call.context.messages[0].content, JSON.stringify(call.input));
      assert.doesNotMatch(JSON.stringify(call.context), /Session-only history/);
      assert.equal(call.context.tools?.length,1);assert.equal(call.context.tools[0].name,"submit_review");
      assert.deepEqual(call.context.tools[0].constrainedSampling,{type:"json_schema",strict:"prefer"});
    }
  });
}

test("adapter: review accepts schema tool submissions", async (t) => {
  const h = harness(t);
  const seen = [];
  h.ctx.modelRegistry = { streamSimple(model, context) {
    seen.push(context);
    return { async result() {
      return {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call_1", name: "submit_review",
          arguments: await structuralReview(JSON.parse(context.messages[0].content)) }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    } };
  } };
  const result = await draft(h);
  assert.equal(result.isError, undefined);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].tools?.length, 1);
  assert.equal(result.usage.input, 10);
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).awaitingApproval, true);
});


// Recovery commands operate on the same root and never grant acceptance.
const waitFor=async predicate=>{
  for(let i=0;i<400;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw Error("test operation did not start");
};

test("adapter: /exitcode resume works while mode is on and retries the saved evaluator operation", async (t) => {
  const h=harness(t);await draft(h);await h.command("approve");
  const io=core.makeIo(h.cwd),before=core.loadRoot(io,"G1");
  const bytes=fs.readFileSync(core.sealedFile(h.cwd,"G1"),"utf8");
  fs.writeFileSync(path.join(h.cwd,"feature.txt"),"done\n");
  const broken=core.makeIo(h.cwd,{exec:async()=>({exit:null,error:"temporary runner failure"})});
  assert.equal((await core.evaluateNode(broken)).status,"PAUSED");
  assertEnforced(h);
  await h.command("resume");
  assert.match(h.notifications.at(-1).content,/Resumed root G1/);
  const root=core.loadRoot(io,"G1");
  assert.equal(root.status,"PASS");
  assert.equal(root.consumedAttempts,1);
  assert.equal(root.deadlineAt,before.deadlineAt);
  assert.deepEqual(root.approval,before.approval);
  assert.equal(fs.readFileSync(core.sealedFile(h.cwd,"G1"),"utf8"),bytes);
  assert.equal(core.resolveModeFromBranch(h.entries).on,false);
});

test("adapter: deadline recovery requires positive user grants and never edits sealed policy", async (t) => {
  const h=harness(t);await draft(h);await h.command("approve");
  const io=core.makeIo(h.cwd),before=core.loadRoot(io,"G1");
  const bytes=fs.readFileSync(core.sealedFile(h.cwd,"G1"),"utf8");
  t.mock.method(Date,"now",()=>before.deadlineAt+1000);
  await settle(h);
  assert.equal(core.loadRoot(io,"G1").status,"PAUSED");
  await h.command("resume");assert.match(h.notifications.at(-1).content,/execution budget exhausted/);
  for(const args of ["resume minutes=0","resume minutes=-1","resume attempts=0.5","resume minutes=1 minutes=2"]){
    const root=core.loadRoot(io,"G1");await h.command(args);assert.deepEqual(core.loadRoot(io,"G1"),root);
  }
  fs.writeFileSync(path.join(h.cwd,"feature.txt"),"done\n");
  // Paused edits are preserved by cancellation, not by relaxing pre-seal mutation checks.
  await h.command("exit");fs.writeFileSync(path.join(h.cwd,"feature.txt"),"done\n");
  await h.command("resume minutes=2 attempts=3");
  const root=core.loadRoot(io,"G1");
  assert.equal(root.status,"PASS");
  assert.equal(root.executionStartedAt,before.executionStartedAt);
  assert.equal(root.deadlineAt,before.deadlineAt+121000);
  assert.equal(root.attemptLimit,before.policy.maxTotalAttempts+3);
  assert.deepEqual(root.policy,before.policy);
  assert.deepEqual(root.approval,before.approval);
  assert.equal(root.executionGrants[0].approvedBy,"user");
  assert.equal(fs.readFileSync(core.sealedFile(h.cwd,"G1"),"utf8"),bytes);
});

test("adapter: provider recovery pauses then resumes preparation without another root or quality charge", async (t) => {
  const h=harness(t);h.ctx.modelRegistry=reviewRegistry("error");
  const failed=await draft(h);assert.equal(failed.details.status,"PAUSED");
  const io=core.makeIo(h.cwd),root=core.loadRoot(io,"G1");
  assert.equal(core.loadNodeState(io,"G1").evaluatorMetrics.e0Attempts,0);
  assert.equal(await settle(h),undefined);
  h.ctx.modelRegistry=reviewRegistry();
  await h.command("resume");
  assert.equal(core.loadRoot(io,"G1").status,"ACTIVE");
  assert.deepEqual(core.loadRoot(io,"G1").stack,root.stack);
  assert.equal(core.loadRoot(io,"G1").createdAt,root.createdAt);
  assert.equal(core.loadRoot(io,"G1").deadlineAt,null);
  assert.equal(core.statusSnapshot(io).awaitingApproval,true);
  assert.equal(core.loadNodeState(io,"G1").evaluatorMetrics.e0Attempts,1);
  assert.match(h.messages.at(-1).content,/Validated plan/);
  assert.equal(h.messages.at(-1).triggerTurn,false);
  assertEnforced(h);
});

test("adapter: evaluator budget recovery grants construction attempts without bypassing a failed negative", async (t) => {
  const h=harness(t);await h.command("Complete feature");const broken=structuredClone(criteria);
  broken[0].controls.reject[0].setup="printf 'done\n' > feature.txt";
  await h.tool("exitcode_draft",{goal:"Feature",criteria:broken,policy:{evaluatorAttempts:1}});
  await h.tool("exitcode_draft",{goal:"Feature",criteria:broken,revise:"G1"});
  const io=core.makeIo(h.cwd);assert.equal(core.loadRoot(io,"G1").pause.code,"EVALUATOR_UNBUILDABLE");
  await h.command("resume");assert.match(h.notifications.at(-1).content,/evaluators=N/);
  await h.command("resume evaluators=2");
  const node=core.loadNodeState(io,"G1");
  assert.equal(node.evaluatorAttemptLimit,3);
  assert.equal(node.evaluatorMetrics.e0Attempts,2);
  assert.equal(core.statusSnapshot(io).awaitingApproval,false);
  assert.equal(core.loadRoot(io,"G1").policy.evaluatorAttempts,1);
  await h.tool("exitcode_draft",{goal:"Feature",criteria,revise:"G1"});
  assert.equal(core.statusSnapshot(io).awaitingApproval,true);
});

test("adapter: status calls and equivalent tool calls cannot reset no-progress pauses", async (t) => {
  const h=harness(t);await draft(h);await h.command("approve");
  for(let i=0;i<core.MAX_SETTLE_NUDGES;i++){
    assert.equal((await settle(h)).continue,true);
    await h.tool("exitcode_status",{});
    h.events.get("tool_call")({toolName:"exitcode_status",input:{}},h.ctx);
    h.events.get("input")({text:"Record a commit",source:"extension"},h.ctx);
  }
  const paused=await settle(h);assert.match(paused.entries[0].content,/No observable progress/);
  assert.equal(core.loadRoot(core.makeIo(h.cwd),"G1").pause.code,"NO_PROGRESS");
  assert.equal(await settle(h),undefined);
  await h.command("resume");
  assert.equal(core.loadRoot(core.makeIo(h.cwd),"G1").status,"ACTIVE");
  assert.equal((await settle(h)).continue,true);
});

test("adapter: cancellation and reload abort owned reviewer calls before clearing preparation locks", async (t) => {
  for(const operation of ["exit","reload"]){
    const h=harness(t),registry=reviewRegistry("cancel");h.ctx.modelRegistry=registry;
    await h.command("Complete feature");
    const pending=h.tool("exitcode_draft",{goal:"Feature",criteria});
    await waitFor(()=>registry.calls.length===1);
    if(operation==="exit")await h.command("exit");else await h.reload();
    const result=await pending;
    assert.equal(result.isError,true);
    assert.equal(registry.calls[0].options.signal.aborted,true);
    const io=core.makeIo(h.cwd);
    assert.equal(core.loadNodeState(io,"G1").preparing,undefined);
    assert.equal(core.loadNodeState(io,"G1").evaluatorMetrics.e0Attempts,0);
    assert.equal(fs.existsSync(core.storePaths(h.cwd).operation),false);
    assert.equal(core.loadRoot(io,"G1").status,"PAUSED");
    assert.equal(core.resolveModeFromBranch(h.entries).on,operation!=="exit");
  }
});

test("adapter: a transcript must explicitly adopt the current workspace root before modifying it", async (t) => {
  const h=harness(t);await draft(h);const io=core.makeIo(h.cwd);
  h.entries.push({type:"custom",customType:core.MODE_ENTRY_TYPE,data:{on:true,rootId:"G2"}});
  await h.restart();
  const before=core.loadRoot(io,"G1");
  assert.equal((await h.tool("exitcode_draft",{goal:"Changed",criteria,revise:"G1"})).details.code,"ROOT_MISMATCH");
  await h.command("approve");assert.match(h.notifications.at(-1).content,/session root differs/);
  assert.deepEqual(core.loadRoot(io,"G1"),before);
  await h.command("resume");
  assert.equal(core.resolveModeFromBranch(h.entries).rootId,"G1");
  assert.equal(core.statusSnapshot(io).awaitingApproval,true);
});

test("adapter: review progress updates and explicit hidden specification paths reach the independent reviewer", async (t) => {
  const h=harness(t),registry=reviewRegistry();h.ctx.modelRegistry=registry;const updates=[];
  fs.mkdirSync(path.join(h.cwd,".agents/artifacts"),{recursive:true});
  fs.writeFileSync(path.join(h.cwd,".agents/artifacts/plan.md"),"The feature artifact must contain done.");
  await h.command("Complete feature");
  const result=await h.tools.get("exitcode_draft").execute("progress",{goal:"Feature",criteria,
    specificationPaths:[".agents/artifacts/plan.md"]},undefined,update=>updates.push(update),h.ctx);
  assert.equal(result.isError,undefined);
  assert.ok(updates.some(u=>u.details.progress.stage==="quality-derive"));
  assert.ok(updates.some(u=>u.details.progress.stage==="quality-assess"));
  assert.ok(registry.calls[0].input.repository.files.some(f=>f.path===".agents/artifacts/plan.md"));
  assert.deepEqual(core.statusSnapshot(core.makeIo(h.cwd)).contract.specificationPaths,[".agents/artifacts/plan.md"]);
});
