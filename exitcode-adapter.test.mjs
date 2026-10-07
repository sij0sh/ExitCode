import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as core from "./exitcode-core.mjs";

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
    cwd, hasUI: false, mode: "print", isIdle: () => idle,
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
  assert.equal(core.loadRoot(io, "G1").approval.digest, core.loadBundle(io, "G1").digest);
  assert.equal(core.loadBundle(io, "G1").contract.originalRequest, "Add the feature");
  assert.equal(core.statusSnapshot(io).awaitingApproval, false);
  assert.equal(h.messages.at(-1).triggerTurn, true);
  assert.match(h.messages.at(-1).content, /User approved root G1/);
  assert.equal((await h.events.get("agent_before_settle")({}, h.ctx)).continue, true);
  assert.equal(h.events.get("tool_call")({ toolName: "write", input: { path: "feature.txt" } }, h.ctx), undefined);
});

test("adapter: root already satisfied at approval exits without another turn", async (t) => {
  const h = harness(t, "done\n");
  await draft(h);
  await h.command("approve");
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").status, "PASS");
  assert.equal(h.messages.at(-1).triggerTurn, false);
  assert.equal(h.tools.get("exitcode_draft").exposure, "hidden");
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

test("adapter: expired review stays paused until approval reports exhaustion", async (t) => {
  const h = harness(t);
  await draft(h);
  const io = core.makeIo(h.cwd);
  const root = core.loadRoot(io, "G1");
  root.deadlineAt = Date.now() - 1;
  core.saveRoot(io, root);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  await h.command("approve");
  assert.equal(core.loadRoot(io, "G1").status, "BLOCKED");
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 0);
  assert.equal(h.messages.at(-1).triggerTurn, false);
});

test("adapter: failed E0 continues to revision and pauses for fresh approval", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  const broken = structuredClone(criteria);
  broken[0].controls.reject[0].setup = "printf 'done\\n' > feature.txt";
  await h.tool("exitcode_draft", { goal: "g", criteria: broken });
  await h.command("approve");
  const io = core.makeIo(h.cwd);
  assert.equal(core.loadNodeState(io, "G1").status, "DRAFT");
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 1);
  assert.equal(h.messages.at(-1).triggerTurn, true);
  assert.match(h.messages.at(-1).content, /seal rejected/);
  const revised = await h.tool("exitcode_draft", { goal: "g", criteria, revise: "G1" });
  assert.match(revised.content[0].text, /C1: The feature is done/);
  assert.match(revised.content[0].text, /C2: Existing behavior is preserved/);
  assert.equal(core.loadRoot(io, "G1").approval, undefined);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assert.equal((await h.tool("exitcode_seal", { node: "G1" })).isError, true);
  await h.command("approve");
  assert.equal(core.loadNodeState(io, "G1").status, "ACTIVE");
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 2);
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
  assert.equal(core.loadRoot(io, "G1").approval.digest, core.loadBundle(io, "G1").digest);
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
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 1);
  await h.tool("exitcode_draft", { goal: "g", criteria, revise: "G1" });
  assert.equal(core.loadRoot(io, "G1").approval, undefined);
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
  assert.equal((await h.tool("exitcode_seal", { node: "G1" })).isError, true);
  const newReply = "The revised version looks good.";
  await h.reply(newReply);
  assert.equal((await h.tool("exitcode_seal", { node: "G1", userApproval: newReply })).isError, undefined);
  assert.equal(core.loadNodeState(io, "G1").sealAttempts, 2);
  assert.equal(core.loadRoot(io, "G1").approval.userReply, newReply);
});

test("adapter: conversational acceptance of an already-satisfied root exits mode", async (t) => {
  const h = harness(t, "done\n");
  await draft(h);
  await h.reply("Go ahead.");
  const result = await h.tool("exitcode_seal", { node: "G1", userApproval: "Go ahead." });
  assert.equal(result.details.alreadySatisfied, true);
  assert.equal(core.loadRoot(core.makeIo(h.cwd), "G1").status, "PASS");
  assert.equal(h.tools.get("exitcode_seal").exposure, "hidden");
  assert.equal(await h.events.get("agent_before_settle")({}, h.ctx), undefined);
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
    "root revision after E0 failure needs fresh approval", "Children need no userApproval"]) {
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

const discoveryTools = ["grep", "find", "ls"];

function assertDiscoveryTools(h, expected) {
  for (const name of discoveryTools) assert.equal(h.getActiveTools().includes(name), expected, name);
}

test("adapter: discovery tools are temporary and do not weaken the unsealed guards", async (t) => {
  const original = ["bash", "read", "write", "codemode"];
  const h = harness(t, "todo\n", original);
  await h.command("help");
  assert.deepEqual(h.getActiveTools(), original);
  await h.command("Add the feature");
  assertDiscoveryTools(h, true);
  const entryCount = h.entries.length;
  h.events.get("before_agent_start")({ systemPromptOptions: { sections: {} } }, h.ctx);
  assert.equal(h.entries.length, entryCount); // An unchanged phase needs no new ownership entry.
  assertDiscoveryTools(h, true);
  for (const name of original) assert.ok(h.getActiveTools().includes(name));
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
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")), original);
  assert.equal(h.events.get("tool_call")({ toolName: "bash", input: { command: "true" } }, h.ctx), undefined);
  await h.command("exit");
  assert.deepEqual(h.getActiveTools(), original);
});

test("adapter: discovery cleanup preserves pre-enabled tools and unrelated loadout changes", async (t) => {
  const original = ["read", "bash", "write", "grep"];
  const h = harness(t, "todo\n", original);
  await draft(h);
  h.setActiveTools([...h.getActiveTools().filter((name) => name !== "write"), "custom_tool"]);
  await h.command("approve");
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")),
    ["read", "bash", "grep", "custom_tool"]);
  await h.command("exit");
  assert.deepEqual(h.getActiveTools(), ["read", "bash", "grep", "custom_tool"]);
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
  assert.deepEqual(h.getActiveTools(), original);
});

test("adapter: failed E0 and root revisions retain discovery tools until sealing", async (t) => {
  const h = harness(t);
  await h.command("Add the feature");
  const broken = structuredClone(criteria);
  broken[0].controls.reject[0].setup = "printf 'done\\n' > feature.txt";
  await h.tool("exitcode_draft", { goal: "g", criteria: broken });
  await h.command("approve");
  assertDiscoveryTools(h, true);
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
  assert.deepEqual(h.getActiveTools(), original);
  await h.command("resume");
  assertDiscoveryTools(h, true);
  await h.command("approve");
  await h.command("exit");
  assert.deepEqual(h.getActiveTools(), original);
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
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")), original);
  await h.reload();
  assert.deepEqual(h.getActiveTools().filter((name) => !name.startsWith("exitcode_")), original);
  await h.command("exit");
  assert.deepEqual(h.getActiveTools(), original);
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
  assert.deepEqual(h.getActiveTools(), original);
});

test("adapter: PASS, BLOCKED, and no-contract exit all clean up discovery tools", async (t) => {
  for (const outcome of ["PASS", "BLOCKED", "NO_CONTRACT"]) {
    await t.test(outcome, async (t) => {
      const h = harness(t, outcome === "PASS" ? "done\n" : "todo\n");
      const original = h.getActiveTools();
      if (outcome === "NO_CONTRACT") {
        await h.command("Add the feature");
        assertDiscoveryTools(h, true);
        await h.events.get("agent_before_settle")({}, h.ctx);
      } else {
        await draft(h);
        assertDiscoveryTools(h, true);
        if (outcome === "PASS") await h.command("approve");
        else await h.tool("exitcode_block", { node: "G1", reason: "Missing requirement" });
      }
      assert.deepEqual(h.getActiveTools(), original);
    });
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
      assert.deepEqual(h.getActiveTools(), executionTools);
    });
  }
});
