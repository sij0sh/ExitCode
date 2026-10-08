import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as core from "./exitcode-core.mjs";
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
    cwd, hasUI: false, mode: "print", model:{id:"test-model",provider:"test"},modelRegistry:structuralRegistry(), isIdle: () => idle,
    ui: { notify: (content, type) => notifications.push({ content, type }) },
    sessionManager: { getBranch: () => entries },
  };
  install(pi);
  return {
    cwd, ctx, tools, events, messages, notifications, entries,
    setIdle: (value) => { idle = value; },
    getActiveTools: pi.getActiveTools,
    setActiveTools: pi.setActiveTools,
    reload: () => {
      events.get("session_shutdown")({ reason: "reload" }, ctx);
      install(pi);
      return events.get("session_start")({ reason: "reload" }, ctx);
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
  for (const [toolName, input] of [["write", { path: "feature.txt" }], ["bash", { command: "true" }]]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx).block, true);
  }
  assert.equal(h.events.get("tool_call")({ toolName: "read", input: { path: "feature.txt" } }, h.ctx), undefined);
  assert.equal(fs.readFileSync(path.join(h.cwd, "feature.txt"), "utf8"), "todo\n");
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

test("adapter: expired review refuses approval without consuming work or leaving enforcement", async (t) => {
  const h = harness(t);
  await draft(h);
  const io = core.makeIo(h.cwd);
  const root = core.loadRoot(io, "G1");
  // Keep the reviewed clock intact while simulating a late approval.
  t.mock.method(Date, "now", () => root.deadlineAt + 1);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  await h.command("approve");
  assert.equal(core.loadRoot(io, "G1").status, "ACTIVE");
  assert.equal(core.loadRoot(io, "G1").approval, undefined);
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 0);
  assert.match(h.notifications.at(-1).content, /deadline exceeded/);
  assert.match(h.notifications.at(-1).content, /user must cancel/);
  assert.match(core.statusSnapshot(io).review, /shared deadline expired/);
  const denied = await h.tool("exitcode_seal", { node: "G1", userApproval: "Go ahead" });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /approval and E0 are unavailable/);
  assert.equal(core.resolveModeFromBranch(h.entries).on, true);
});

test("adapter: initial limits are locked by preparation and survive reload", async t=>{
 const h=harness(t);await h.command('Complete the implementation');await h.tool('exitcode_draft',{goal:'Complete implementation',criteria,policy:{deadlineMinutes:480,maxTotalAttempts:24,maxDepth:1,evalTimeoutSeconds:900}});
 const io=core.makeIo(h.cwd),before=core.loadRoot(io,'G1');assert.equal(core.statusSnapshot(io).policyEditable,false);
 assert.equal((await h.tool('exitcode_draft',{revise:'G1',goal:'Complete implementation',criteria,policy:{deadlineMinutes:900}})).isError,true);assert.deepEqual(core.loadRoot(io,'G1'),before);
 await h.reload();assertRestricted(h);await h.command('status');assert.match(h.notifications.at(-1).content, /"deadlineMinutes":480/);await h.command('exit');await h.command('resume');await h.command('approve');assert.equal(core.loadNodeState(io,'G1').status,'ACTIVE');assert.equal(core.loadRoot(io,'G1').deadlineAt,before.deadlineAt);
});

test("adapter: failed E0 policy revision is explicit, atomic, and locked across reload", async (t) => {
  const h = harness(t);
  await h.command("Complete the feature");
  const broken = structuredClone(criteria);
  broken[0].controls.reject[0].setup = "printf 'done\n' > feature.txt";
  await h.tool("exitcode_draft", { goal: "Feature", criteria: broken });
  await h.command("approve");
  const io = core.makeIo(h.cwd);
  const before = core.loadRoot(io, "G1");
  const rejected = await h.tool("exitcode_draft", { revise: "G1", goal: "Changed scope", criteria,
    policy: { deadlineMinutes: 480 } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /policy is locked/);
  assert.match(rejected.content[0].text, /Effective policy:.*"deadlineMinutes":60/);
  assert.match(rejected.content[0].text, /user must cancel/);
  assert.deepEqual(core.loadRoot(io, "G1"), before);
  await h.tool("exitcode_draft", { revise: "G1", goal: "Feature", criteria });
  await h.reload();
  assert.equal(core.loadRoot(io, "G1").approval, undefined);
  assert.equal(core.statusSnapshot(io).policyEditable, false);
  assert.equal((await h.tool("exitcode_draft", { revise: "G1", goal: "Feature", criteria,
    policy: { maxTotalAttempts: 24 } })).isError, true);
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 0);
  assertRestricted(h);
  await h.command("approve");
  assert.equal(core.loadNodeState(io, "G1").status, "ACTIVE");
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 1);
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
  assert.equal(h.events.get("tool_call")({ toolName: "git_plan_context", input: {} }, h.ctx).block, true);
  assertRestricted(h);
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
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
});

const discoveryTools = ["read", "grep", "ls"];

function assertDiscoveryTools(h, expected) {
  for (const name of discoveryTools.filter((name) => name !== "read")) assert.equal(h.getActiveTools().includes(name), expected, name);
}

test("adapter: discovery tools are temporary and do not weaken the unsealed guards", async (t) => {
  const original = ["bash", "read", "write", "codemode"];
  const h = harness(t, "todo\n", original);
  await h.command("help");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  await h.command("Add the feature");
  assertDiscoveryTools(h, true);
  const entryCount = h.entries.length;
  h.events.get("before_agent_start")({ systemPromptOptions: { sections: {} } }, h.ctx);
  assert.equal(h.entries.length, entryCount); // An unchanged phase needs no new ownership entry.
  assertDiscoveryTools(h, true);
  assert.deepEqual(h.getActiveTools().filter((name) => !core.EXITCODE_TOOL_NAMES.includes(name)), discoveryTools);
  for (const toolName of discoveryTools) {
    assert.equal(h.events.get("tool_call")({ toolName, input: {} }, h.ctx), undefined);
  }
  for (const [toolName, input] of [["bash", { command: "true" }], ["write", { path: "feature.txt" }]]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx).block, true);
  }
  await h.tool("exitcode_draft", { goal: "g", criteria });
  assertDiscoveryTools(h, true);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  await h.command("approve");
  assertDiscoveryTools(h, false);
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")).sort(), [...original].sort());
  assert.equal(h.events.get("tool_call")({ toolName: "bash", input: { command: "true" } }, h.ctx), undefined);
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
});

test("adapter: discovery cleanup preserves pre-enabled tools and unrelated loadout changes", async (t) => {
  const original = ["read", "bash", "write", "grep"];
  const h = harness(t, "todo\n", original);
  await draft(h);
  h.setActiveTools([...h.getActiveTools().filter((name) => name !== "read"), "custom_tool"]);
  await h.command("approve");
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")).sort(),
    ["bash", "custom_tool", "grep", "write"]);
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), ["bash", "custom_tool", "grep", "write"]);
});

test("adapter: conversational sealing also restores the execution loadout", async (t) => {
  const h = harness(t);
  const original = h.getActiveTools();
  await draft(h);
  assertDiscoveryTools(h, true);
  await h.reply("Go ahead.");
  await h.tool("exitcode_seal", { node: "G1", userApproval: "Go ahead." });
  assertDiscoveryTools(h, false);
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
});

test("adapter: failed E0 and root revisions retain discovery tools until sealing", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  const broken = structuredClone(criteria);
  broken[0].controls.reject[0].setup = "printf 'done\\n' > feature.txt";
  await h.tool("exitcode_draft", { goal: "g", criteria: broken });
  await h.command("approve");
  assertRestricted(h);
  await h.tool("exitcode_draft", { goal: "g", criteria, revise: "G1" });
  assertDiscoveryTools(h, true);
  assert.equal(h.getActiveTools().length, new Set(h.getActiveTools()).size);
  await h.command("approve");
  assertDiscoveryTools(h, false);
});

test("adapter: cancellation and resume restore discovery from the current leaf state", async (t) => {
  const h = harness(t);
  const original = h.getActiveTools();
  await draft(h);
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  await h.command("resume");
  assertDiscoveryTools(h, true);
  await h.command("approve");
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  await h.command("resume");
  assertDiscoveryTools(h, false);
});

test("adapter: reload and transcript resume preserve temporary-tool ownership", async (t) => {
  const original = ["read", "write", "bash", "grep"];
  const h = harness(t, "todo\n", original);
  await draft(h);
  await h.reload();
  assertDiscoveryTools(h, true);
  await h.restart(); // Active tools restored from a transcript must not become user-owned.
  assertDiscoveryTools(h, true);
  await h.command("approve");
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")).sort(), [...original].sort());
  await h.reload();
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")).sort(), [...original].sort());
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
});

test("adapter: unavailable or explicitly excluded discovery tools are not claimed", async (t) => {
  const original = ["read", "write", "bash"];
  const h = harness(t, "todo\n", original, ["find", "ls"]);
  await draft(h);
  assert.equal(h.getActiveTools().includes("grep"), true);
  assert.equal(h.getActiveTools().includes("find"), false);
  assert.equal(h.getActiveTools().includes("ls"), false);
  assert.deepEqual(h.entries.at(-1).data.discoveryToolsAdded, ["grep"]);
  await h.command("approve");
  await h.command("exit");
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
});

test("adapter: only root PASS automatically restores the execution loadout", async (t) => {
  const h = harness(t, "done\n");
  const original = h.getActiveTools();
  await draft(h);
  assertDiscoveryTools(h, true);
  await h.command("approve");
  await h.tool("exitcode_evaluate",{});
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
});

function assertRestricted(h) {
  assert.equal(core.resolveModeFromBranch(h.entries).on, true);
  assert.equal(h.tools.get("exitcode_draft").exposure, "direct");
  assert.deepEqual(h.getActiveTools().filter((name) => !core.EXITCODE_TOOL_NAMES.includes(name)).sort(), [...discoveryTools].sort());
  for (const [toolName, input] of [
    ["write", { path: "feature.txt" }], ["write", { path: ".exitcode/drafts/manual.json" }],
    ["write", { path: ".agents/artifacts/acceptance.md" }], ["bash", { command: "/exitcode exit" }],
    ["codemode", { code: 'await tools.bash({command: "pi ..."})' }],
    ["find", {}], ["context", {}], ["git_commit_plan", {}], ["exitcode_exit", {}],
  ]) {
    assert.equal(h.events.get("tool_call")({ toolName, input }, h.ctx).block, true, toolName);
    // Nested calls receive the same event policy, regardless of their parent.
    assert.equal(h.events.get("tool_call")({ toolName, input, parentToolCallId: "outer" }, h.ctx).block, true, toolName);
  }
}

function promptText(h) {
  const event = { systemPromptOptions: { sections: {} } };
  h.events.get("before_agent_start")(event, h.ctx);
  return event.systemPromptOptions.sections.exitcode;
}

test("adapter: discovery clarification and ordinary replies never switch enforcement off", async (t) => {
  const h = harness(t, "todo\n", ["read", "write", "bash", "codemode", "find", "context", "git_commit_plan"]);
  await h.command("Complete all five phases");
  assertRestricted(h);
  assert.match(promptText(h), /Root goal: Complete all five phases/);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  await h.reply("Option 1: use the shared engine.");
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assertRestricted(h);
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).active, false);
  const status = await h.tool("exitcode_status", {});
  assert.match(status.content[0].text, /DISCOVERY/);
  assert.equal(status.details.pendingGoal, "Complete all five phases");
  assert.equal(status.details.modeOn, true);
  // An extension-injected reminder or new tool cannot turn discovery into coding.
  h.setActiveTools([...h.getActiveTools(), "git_commit_plan"]);
  await h.events.get("input")({ text: "Record a commit", source: "extension" }, h.ctx);
  assert.match(promptText(h), /Complete all five phases/);
  assertRestricted(h);
  const proposal = await h.tool("exitcode_draft", { goal: "Finish the feature", criteria });
  assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).originalRequest, "Complete all five phases");
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").approval, undefined);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assertRestricted(h);
});

test("adapter: pre-draft reload and transcript resume retain the goal and strict allowlist", async (t) => {
  const h = harness(t);
  const original = [...h.getActiveTools()];
  await h.command("Keep the original goal");
  for (const restart of [h.reload, h.restart, h.reload]) {
    await restart();
    assertRestricted(h);
    assert.match(promptText(h), /Root goal: Keep the original goal/);
    assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  }
  await h.command("exit extra");
  assert.match(h.notifications.at(-1).content, /Usage/);
  assertRestricted(h);
  await h.reply("/exitcode exit"); // Text alone is not command dispatch.
  assertRestricted(h);
  await h.command("exit"); // Only the actual user-command path cancels.
  assert.equal(core.resolveModeFromBranch(h.entries).on, false);
  assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  assert.equal(h.events.get("tool_call")({ toolName: "write", input: { path: "feature.txt" } }, h.ctx), undefined);
});

test("adapter: root BLOCKED stops work without releasing guards before or after sealing", async (t) => {
  for (const sealed of [false, true]) {
    await t.test(sealed ? "sealed" : "draft", async (t) => {
      const h = harness(t);
      const original = [...h.getActiveTools()];
      await draft(h);
      if (sealed) await h.command("approve");
      const result = await h.tool("exitcode_block", { node: "G1", reason: "Missing authorization", code: "AUTHORIZATION_MISSING" });
      assert.equal(result.details.terminal.status, "BLOCKED");
      assertRestricted(h);
      assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
      assert.match(promptText(h), /G1 \[BLOCKED\]/);
      assert.match(promptText(h), /Missing authorization/);
      await h.reload();
      assertRestricted(h);
      assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
      await h.reply("Continue");
      assertRestricted(h);
      const redraft = await h.tool("exitcode_draft", { goal: "Reset the budget", criteria });
      assert.equal(redraft.isError, true);
      assert.match(redraft.content[0].text, /user must cancel/);
      await h.command("exit");
      assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").status, "BLOCKED");
      assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
    });
  }
});

test("adapter: missing roots and unexpected leaf states never grant execution", async (t) => {
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
      assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
      assertRestricted(h);
    });
  }
});

test("adapter: an old transcript's borrowed find is removed, but a user-owned find is restored", async (t) => {
  for (const owned of [false, true]) {
    const original = ["read", "write", "bash", ...(owned ? ["find"] : [])];
    const h = harness(t, "todo\n", original);
    h.setActiveTools([...original, "grep", "find", "ls"]);
    h.entries.push({ type: "custom", customType: core.MODE_ENTRY_TYPE,
      data: { on: true, pendingGoal: "Old goal", discoveryToolsAdded: ["grep", "ls", ...(!owned ? ["find"] : [])] } });
    await h.restart();
    assertRestricted(h);
    await h.command("exit");
    assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  }
});

test("adapter: child drafts borrow discovery tools and return them on seal or block", async (t) => {
  for (const outcome of ["seal", "block", "failed E0"]) {
    await t.test(outcome, async (t) => {
      const h = harness(t);
      await draft(h);
      await h.command("approve");
      const executionTools = h.getActiveTools();
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
      assertDiscoveryTools(h, true);
      assert.equal(h.events.get("tool_call")({ toolName: "bash", input: { command: "true" } }, h.ctx).block, true);
      if (outcome === "block") {
        await h.tool("exitcode_block", { node: "G1.1", reason: "Missing prerequisite" });
      } else {
        const sealed = await h.tool("exitcode_seal", { node: "G1.1" });
        assert.equal(sealed.isError, outcome === "failed E0" ? true : undefined);
        if (outcome === "failed E0") {
          assert.equal(sealed.isError, true);
          assertDiscoveryTools(h, true);
          await h.tool("exitcode_child", {
            parent: "G1", target: "C1", goal: "Build the prerequisite", criteria: [{ ...childCriteria[0],
              controls: { ...childCriteria[0].controls, reject: [{ setup: "printf 'todo\\n' > helper.txt" }] } }],
            reason: "C1 needs the helper", prerequisite: true, prerequisiteArtifact: "helper.txt", revise: "G1.1",
          });
          assertDiscoveryTools(h, true);
          await h.tool("exitcode_seal", { node: "G1.1" });
        }
      }
      assert.deepEqual([...h.getActiveTools()].sort(), [...executionTools].sort());
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
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assertRestricted(h);
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

test("adapter: borrowed read is restored and explicit read exclusion wins", async (t) => {
  for (const excluded of [false, true]) {
    const original = ["bash", "write"];
    const h = harness(t, "todo\n", original, excluded ? ["read"] : []);
    await h.command("Read-only discovery");
    assert.equal(h.getActiveTools().includes("read"), !excluded);
    assert.equal(h.entries.at(-1).data.discoveryToolsAdded.includes("read"), !excluded);
    await h.reload();
    assert.equal(h.getActiveTools().includes("read"), !excluded);
    await h.command("exit");
    assert.deepEqual([...h.getActiveTools()].sort(), [...original].sort());
  }
});

test("adapter: exhausted evaluator construction remains restricted", async t=>{
 const h=harness(t);await h.command('Add feature');const broken=structuredClone(criteria);broken[0].controls.reject[0].setup="printf 'done\n' > feature.txt";
 await h.tool('exitcode_draft',{goal:'g',criteria:broken,policy:{evaluatorAttempts:2}});
 await h.tool('exitcode_draft',{goal:'g',criteria:broken,revise:'G1'});
 await h.tool('exitcode_draft',{goal:'g',criteria:broken,revise:'G1'});
 assert.equal(core.loadRoot(core.makeIo(h.cwd),'G1').status,'BLOCKED');assertRestricted(h);assert.equal(await h.events.get('agent_before_settle')({},h.ctx),undefined);assert.equal(core.resolveModeFromBranch(h.entries).on,true);
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
    assert.equal(c.model,h.ctx.model);assert.ok(c.options.signal instanceof AbortSignal);
    assert.ok(c.options.maxTokens>0&&c.options.maxTokens<=8192);assert.ok(!c.context.tools?.length);
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
    // Repeated preparation uses new review calls even if artifact probes are cached.
    const revised=await h.tool('exitcode_draft',{goal:'Literal artifact',criteria,revise:'G1'});
    assert.equal(revised.usage.input,22);assert.equal(registry.calls.length,4);
    assert.equal(core.loadNodeState(core.makeIo(h.cwd),'G1').evaluatorMetrics.tokenUsage.input,44);
  }else{
    assert.equal(result.isError,true);assert.equal(core.statusSnapshot(core.makeIo(h.cwd)).awaitingApproval,false);
    assert.equal(core.approveRoot(core.makeIo(h.cwd)).ok,false);assertRestricted(h);
    if(['error','invalid-json','malformed','length'].includes(mode))assert.equal(result.usage.input,11);
    if(mode==='cancel')assert.equal(registry.calls[0].options.signal.aborted,true);
  }
});
