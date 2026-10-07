/**
 * exitcode — contract-first recursive execution for Pi.
 *
 * The root goal is user-invoked via /exitcode. Children are proposed by the
 * agent through exitcode_child and follow the same protocol. All exitcode
 * tools are registered hidden and are only visible to the model while
 * exitcode mode is on; otherwise the extension is inert.
 *
 * Supervisor logic lives in exitcode-core.mjs (Pi-agnostic and tested).
 * This file is a thin adapter: mode state, tool visibility, prompt
 * injection, lifecycle guards, and the /exitcode command.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as core from "./exitcode-core.mjs";

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const ExpectSchema = Type.Object({
  exit: Type.Optional(Type.Integer({ minimum: 0, maximum: 255, description: "Wanted exit code (default 0)" })),
  stdoutContains: Type.Optional(Type.Array(Type.String({ description: "Substring that must appear on stdout" }))),
  stdoutNotContains: Type.Optional(Type.Array(Type.String({ description: "Substring that must not appear on stdout" }))),
});

const CheckSchema = Type.Object({
  command: Type.String({ description: "Shell command that observes the candidate" }),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Per-check timeout (defaults to policy)" })),
  expect: Type.Optional(ExpectSchema),
});

const ControlsSchema = Type.Object({
  accept: Type.Object({
    setup: Type.String({ minLength: 1, description: "Shell setup in a temporary candidate copy; must exit 0, then check.command must PASS" }),
  }),
  reject: Type.Array(
    Type.Object({
      setup: Type.String({ minLength: 1, description: "Shell setup in a fresh temporary candidate copy; must exit 0, then check.command must FAIL (not ERROR)" }),
      reason: Type.Optional(Type.String({ description: "What defect this control represents" })),
    }),
    { minItems: 1, description: "At least one known-invalid candidate fixture" },
  ),
});

const CriterionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Suggested id (supervisor assigns C1..Cn when omitted)" })),
  requirement: Type.String({ description: "Observable requirement in plain language" }),
  type: Type.Optional(Type.Union([Type.Literal("behavior"), Type.Literal("regression")], { description: "behavior (default) or regression" })),
  check: CheckSchema,
  controls: Type.Optional(ControlsSchema),
});

const PolicySchema = Type.Object({
  localRepairs: Type.Optional(Type.Number({ description: "Attempts before a child is expected (default 2)" })),
  maxDepth: Type.Optional(Type.Number({ description: "Recursion depth below the root (default 3)" })),
  maxTotalAttempts: Type.Optional(Type.Number({ description: "Implementation attempts across the tree (default 12)" })),
  deadlineMinutes: Type.Optional(Type.Number({ description: "Shared deadline in minutes (default 60)" })),
  evalTimeoutSeconds: Type.Optional(Type.Number({ description: "Default per-check timeout (default 120)" })),
});

const EXITCODE_NAMESPACE = {
  name: "exitcode",
  description: "Contract-first recursive execution: sealed acceptance contracts, bounded repair, one smaller child at a time.",
  instructions:
    "Call exitcode_status to see the active contract, result vectors, and budgets. " +
    "Propose contracts with exitcode_draft, activate them with exitcode_seal, verify work with exitcode_evaluate, " +
    "decompose with exitcode_child, and report dead ends with exitcode_block. " +
    "Only exitcode_evaluate reporting ALL PASS closes a goal.",
};

type Runtime = {
  pi: ExtensionAPI;
  modeOn: boolean;
  rootId: string | undefined;
  pendingGoal: string | undefined;
  nudges: number;
};

type ToolDef = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: typeof ExpectSchema;
  execute: (
    toolCallId: string,
    params: any,
    signal: unknown,
    onUpdate: unknown,
    ctx: ExtensionToolContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }>;
};

function textResult(text: string, details: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function errLines(result: { errors?: string[] }): string {
  return (result.errors ?? ["unknown error"]).map((e) => `- ${e}`).join("\n");
}

function withWarnings(lines: string[], warnings?: string[]): string[] {
  if (warnings && warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return lines;
}

function cascadeLines(cascade: { events?: string[]; terminal?: { root: string; status: string } } | undefined): string[] {
  if (!cascade) return [];
  const lines = [...(cascade.events ?? [])];
  if (cascade.terminal) lines.push(`terminal: root ${cascade.terminal.root} ${cascade.terminal.status}`);
  return lines;
}

export default function (pi: ExtensionAPI) {
  const rt: Runtime = { pi, modeOn: false, rootId: undefined, pendingGoal: undefined, nudges: 0 };
  const TOOL_NAMES = [
    "exitcode_status",
    "exitcode_draft",
    "exitcode_seal",
    "exitcode_evaluate",
    "exitcode_child",
    "exitcode_block",
  ];

  const assertMode = () => {
    if (!rt.modeOn) throw new Error("exitcode mode is not active. The user enters it with /exitcode <goal>.");
  };

  const applyExposure = () => {
    for (const def of defs) {
      pi.registerTool({ ...(def as any), exposure: rt.modeOn ? "direct" : "hidden", namespace: EXITCODE_NAMESPACE });
    }
    const active = pi.getActiveTools();
    if (rt.modeOn) {
      pi.setActiveTools([...new Set([...active, ...TOOL_NAMES])]);
    } else {
      pi.setActiveTools(active.filter((name) => !TOOL_NAMES.includes(name)));
    }
  };

  const enterMode = (pendingGoal?: string) => {
    rt.modeOn = true;
    rt.nudges = 0;
    if (pendingGoal !== undefined) rt.pendingGoal = pendingGoal;
    pi.appendEntry(core.MODE_ENTRY_TYPE, { on: true, rootId: rt.rootId });
    applyExposure();
  };

  const exitMode = (reason: string) => {
    rt.modeOn = false;
    rt.rootId = undefined;
    rt.pendingGoal = undefined;
    rt.nudges = 0;
    pi.appendEntry(core.MODE_ENTRY_TYPE, { on: false });
    applyExposure();
    return reason;
  };

  const maybeAutoExit = (result: any, ctx: { hasUI: boolean; ui: ExtensionContext["ui"] }) => {
    const terminal = result?.terminal;
    if (!terminal || (terminal.status !== "PASS" && terminal.status !== "BLOCKED")) return;
    exitMode(`root ${terminal.status}`);
    if (ctx.hasUI) {
      const summary =
        terminal.status === "PASS"
          ? `exitcode: root ${terminal.root} PASS (candidate ${String(terminal.outcome?.candidateDigest ?? "?").slice(0, 12)}). Mode off.`
          : `exitcode: root ${terminal.root} BLOCKED (${terminal.outcome?.code ?? "?"}): ${terminal.outcome?.reason ?? "no reason"}. Mode off.`;
      ctx.ui.notify(summary, terminal.status === "PASS" ? "success" : "warning");
    }
  };

  const defs: ToolDef[] = [
    {
      name: "exitcode_status",
      label: "Exitcode Status",
      description: "Show the active exitcode contract, result vectors, budgets, and required next action.",
      promptSnippet: "exitcode_status: show the active contract, result vectors, budgets, next action",
      parameters: Type.Object({
        node: Type.Optional(Type.String({ description: "Node id (defaults to the active leaf)" })),
      }),
      execute: async (_id, _params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        return textResult(core.statusText(io), core.statusSnapshot(io));
      },
    },
    {
      name: "exitcode_draft",
      label: "Exitcode Draft",
      description:
        "Propose a root acceptance contract: goal plus observable criteria with executable checks and setup commands for valid/invalid candidate fixtures. " +
        "Validates structure only; call exitcode_seal to run the evaluator gate and activate.",
      promptSnippet: "exitcode_draft: propose the root contract (goal + criteria + checks + controls)",
      parameters: Type.Object({
        goal: Type.String({ description: "Goal statement" }),
        originalRequest: Type.Optional(Type.String({ description: "Retained user request (defaults to goal)" })),
        criteria: Type.Array(CriterionSchema),
        policy: Type.Optional(PolicySchema),
        revise: Type.Optional(Type.String({ description: "Existing DRAFT root id to revise (e.g. G1)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        const result = core.draftNode(io, {
          goal: params.goal,
          originalRequest: params.originalRequest,
          criteria: params.criteria,
          policy: params.policy,
          revise: params.revise,
        });
        if (!result.ok) return textResult(`draft rejected:\n${errLines(result)}`, result, true);
        rt.rootId = result.rootId;
        rt.pendingGoal = undefined;
        pi.appendEntry(core.MODE_ENTRY_TYPE, { on: true, rootId: rt.rootId });
        return textResult(
          withWarnings([`draft ${result.id} accepted.`, `next: ${result.next}`], result.warnings).join("\n"),
          result,
        );
      },
    },
    {
      name: "exitcode_seal",
      label: "Exitcode Seal",
      description:
        "Run the fixed evaluator gate (structure, discrimination, wiring, baseline) and seal the contract. " +
        "Coding tools unlock only after sealing. At most two proposals per node.",
      promptSnippet: "exitcode_seal: validate the evaluator, seal the contract, record the baseline",
      parameters: Type.Object({
        node: Type.String({ description: "Draft node id (e.g. G1, G1.1)" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        const result = await core.sealNode(io, params.node);
        if (!result.ok && !result.events) {
          const lines = [`seal rejected:`, errLines(result)];
          if (typeof result.sealAttemptsLeft === "number") lines.push(`seal proposals left: ${result.sealAttemptsLeft}`);
          if (result.next) lines.push(`next: ${result.next}`);
          return textResult(lines.join("\n"), result, true);
        }
        maybeAutoExit(result, ctx);
        const lines = result.sealed
          ? [`sealed ${result.sealed}. baseline: ${result.baseline}`]
          : [...(result.events ?? [])];
        if (result.alreadySatisfied) lines.push("baseline already satisfies every criterion: goal already met under this contract.");
        lines.push(...cascadeLines(result.cascade));
        if (result.next) lines.push(`next: ${result.next}`);
        if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`);
        return textResult(withWarnings(lines, result.warnings).join("\n"), result);
      },
    },
    {
      name: "exitcode_evaluate",
      label: "Exitcode Evaluate",
      description:
        "Fresh supervisor evaluation of the current candidate. Consumes one shared attempt when the tree changed. " +
        "Checks ancestor regressions (restoring on regress), and reruns the parent when a child passes. " +
        "Only ALL PASS here closes a goal.",
      promptSnippet: "exitcode_evaluate: run the sealed checks fresh; ALL PASS closes the goal",
      parameters: Type.Object({
        node: Type.Optional(Type.String({ description: "Node id (defaults to the active leaf)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        const result = await core.evaluateNode(io, params.node ?? null);
        if (!result.ok) return textResult(`evaluate rejected:\n${errLines(result)}`, result, true);
        maybeAutoExit(result.cascade ?? result, ctx);
        const lines = [`${result.node} ${result.status}: ${result.vector}`];
        if (result.stale) lines.push("warning: the tree changed since this terminal result was recorded; the PASS is stale.");
        if (result.regressedRestored) lines.push(`regressed [${result.regressedRestored.join(", ")}]; restored last accepted candidate (attempt consumed).`);
        if (result.ancestorRegression) {
          lines.push(`regressed ancestor ${result.ancestorRegression.ancestor} (${result.ancestorRegression.criteria.join(", ")}); restored (attempt consumed).`);
        }
        if (result.diagnostics) lines.push(...result.diagnostics);
        lines.push(...cascadeLines(result.cascade));
        if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`);
        else if (result.next) lines.push(`next: ${result.next}`);
        return textResult(withWarnings(lines, result.warnings).join("\n"), result);
      },
    },
    {
      name: "exitcode_child",
      label: "Exitcode Child",
      description:
        "Propose one smaller child tied to exactly one failing parent criterion. The child follows the same protocol " +
        "(draft, seal, evaluate) and cannot modify its parent. One active child at a time.",
      promptSnippet: "exitcode_child: propose one narrower child tied to a failing parent criterion",
      parameters: Type.Object({
        parent: Type.String({ description: "Parent node id (e.g. G1)" }),
        target: Type.String({ description: "Failing parent criterion id (e.g. C2)" }),
        goal: Type.String({ description: "Narrower child goal" }),
        originalRequest: Type.Optional(Type.String({ description: "Retained request (defaults to the parent's)" })),
        criteria: Type.Array(CriterionSchema),
        reason: Type.String({ description: "How this child advances the parent target" }),
        prerequisite: Type.Optional(Type.Boolean({ description: "True when this is early prerequisite work" })),
        prerequisiteArtifact: Type.Optional(Type.String({ description: "Observable artifact the prerequisite produces" })),
        revise: Type.Optional(Type.String({ description: "Existing DRAFT child id to revise (e.g. G1.1)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        const result = core.draftNode(io, {
          parentId: params.parent,
          target: params.target,
          goal: params.goal,
          originalRequest: params.originalRequest,
          criteria: params.criteria,
          reason: params.reason,
          prerequisite: params.prerequisite,
          prerequisiteArtifact: params.prerequisiteArtifact,
          revise: params.revise,
        });
        if (!result.ok) return textResult(`child rejected:\n${errLines(result)}`, result, true);
        return textResult(
          withWarnings([`child draft ${result.id} accepted (targets ${params.parent}.${params.target}).`, `next: ${result.next}`], result.warnings).join("\n"),
          result,
        );
      },
    },
    {
      name: "exitcode_block",
      label: "Exitcode Block",
      description:
        "Report a node as BLOCKED with the specific missing requirement or cause. Restores the parent candidate, " +
        "retains diagnostics, and reruns the parent. Terminal for roots.",
      promptSnippet: "exitcode_block: report BLOCKED with the exact missing requirement",
      parameters: Type.Object({
        node: Type.Optional(Type.String({ description: "Node id (defaults to the active leaf)" })),
        reason: Type.String({ description: "Specific missing requirement, credential, authorization, or cause" }),
        code: Type.Optional(Type.String({ description: `One of ${core.BLOCK_CODES.join(", ")} (default NO_PATH)` })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        const leaf = params.node ?? null;
        const target = leaf ?? (() => {
          const snap = core.statusSnapshot(io);
          const stack = snap.stack ?? [];
          return stack.length > 0 ? stack[stack.length - 1] : null;
        })();
        if (!target) return textResult("block rejected:\n- no active node", { ok: false }, true);
        const result = await core.blockNode(io, target, { reason: params.reason, code: params.code ?? "NO_PATH" });
        if (!result.ok) return textResult(`block rejected:\n${errLines(result)}`, result, true);
        maybeAutoExit(result, ctx);
        const lines = [...(result.events ?? [])];
        if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`);
        return textResult(lines.join("\n"), result);
      },
    },
  ];

  // Register hidden: outside exitcode mode the tools are unreachable and the
  // extension adds no prompt sections and blocks no tool calls.
  for (const def of defs) {
    pi.registerTool({ ...(def as any), exposure: "hidden", namespace: EXITCODE_NAMESPACE });
  }

  // --- session lifecycle ---------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const mode = core.resolveModeFromBranch(branch);
    rt.modeOn = mode.on;
    rt.rootId = mode.rootId;
    rt.nudges = 0;
    rt.pendingGoal = undefined;
    applyExposure();
  });

  pi.on("input", () => {
    rt.nudges = 0;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!rt.modeOn) {
      delete event.systemPromptOptions.sections["exitcode"];
      return;
    }
    const io = core.makeIo(ctx.cwd);
    const lines = [core.PROTOCOL_PROMPT, ""];
    if (rt.pendingGoal) {
      const snap = core.statusSnapshot(io);
      if (!snap.active) lines.push(`Root goal: ${rt.pendingGoal}`, "Propose its acceptance contract with exitcode_draft.", "");
      else rt.pendingGoal = undefined;
    }
    lines.push(core.statusText(io));
    event.systemPromptOptions.sections["exitcode"] = lines.join("\n");
  });

  pi.on("tool_call", (event, ctx) => {
    if (!rt.modeOn) return undefined;
    if (event.toolName.startsWith("exitcode_")) {
      rt.nudges = 0;
      return undefined;
    }
    const io = core.makeIo(ctx.cwd);
    const snap = core.statusSnapshot(io);
    const stack = snap.stack ?? [];
    const leafId = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const leafStatus = (leafId && (snap.nodes as any)?.[leafId]?.status) || "NO_CONTRACT";
    const verdict = core.guardToolCall({
      modeOn: true,
      leafStatus,
      cwd: ctx.cwd,
      toolName: event.toolName,
      input: (event as { input?: unknown }).input as Record<string, unknown>,
    });
    if (verdict?.block) return { block: true, reason: verdict.reason };
    return undefined;
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!rt.modeOn) return undefined;
    const io = core.makeIo(ctx.cwd);
    const snap = core.statusSnapshot(io);
    if (!snap.active) {
      exitMode("no active root");
      return undefined;
    }
    const stack = snap.stack ?? [];
    const leafId = stack[stack.length - 1];
    const leafStatus = (snap.nodes as any)?.[leafId]?.status;
    if (leafStatus !== "ACTIVE" && leafStatus !== "DRAFT") {
      exitMode(`leaf ${leafStatus}`);
      return undefined;
    }
    if (snap.expired) {
      const result = await core.blockNode(io, leafId, { reason: "shared deadline exceeded", code: "BUDGET_EXHAUSTED" });
      maybeAutoExit(result, ctx);
      return {
        entries: [{ type: "custom_message" as const, customType: "exitcode-nudge", content: (result.events ?? []).join("\n"), display: true }],
        continue: !result.terminal,
      };
    }
    if (rt.nudges >= core.MAX_SETTLE_NUDGES) return undefined;
    rt.nudges += 1;
    const leaf = (snap.nodes as any)?.[leafId];
    return {
      entries: [
        {
          type: "custom_message" as const,
          customType: "exitcode-nudge",
          content: `exitcode: ${leafId} ${leafStatus} :: ${leaf?.vector ?? "unevaluated"}. Only a fresh exitcode_evaluate ALL PASS can close a goal. ${snap.next}`,
          display: true,
        },
      ],
      continue: true,
    };
  });

  // --- /exitcode command: the only user entry to the loop -------------------

  const usage = () =>
    [
      "exitcode: contract-first recursive execution.",
      "/exitcode <goal>  enter exitcode mode rooted at your goal (root only; children come from exitcode_child)",
      "/exitcode status  show the active contract, vectors, and budgets",
      "/exitcode resume  re-enter mode for the on-disk ACTIVE root",
      "/exitcode exit    leave exitcode mode (work on disk is preserved)",
    ].join("\n");

  pi.registerCommand("exitcode", {
    description: "Enter exitcode mode: contract-first recursive execution rooted at your goal",
    handler: async (args, ctx) => {
      const text = args.trim();
      const [sub] = text.split(/\s+/, 1);
      const io = core.makeIo(ctx.cwd);

      if (!text || sub === "help") {
        ctx.ui.notify(rt.modeOn ? `${core.statusText(io)}\n\n${usage()}` : usage(), "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(rt.modeOn ? core.statusText(io) : `exitcode mode is off.\n${core.statusText(io)}`, "info");
        return;
      }
      if (sub === "exit") {
        if (!rt.modeOn) {
          ctx.ui.notify("exitcode mode is already off.", "info");
          return;
        }
        exitMode("user exit");
        ctx.ui.notify("Left exitcode mode. Contracts on disk are preserved; /exitcode resume re-enters.", "info");
        return;
      }
      if (sub === "resume") {
        if (rt.modeOn) {
          ctx.ui.notify("Already in exitcode mode.", "info");
          return;
        }
        const snap = core.statusSnapshot(io);
        if (!snap.active) {
          ctx.ui.notify("Nothing to resume: no ACTIVE root on disk. Start one with /exitcode <goal>.", "warning");
          return;
        }
        enterMode();
        rt.rootId = snap.root;
        ctx.ui.notify(`Re-entered exitcode mode for root ${snap.root}. ${snap.next}`, "info");
        return;
      }
      if (rt.modeOn) {
        ctx.ui.notify(`Already in exitcode mode for root ${rt.rootId ?? "unknown"}. /exitcode exit first.`, "warning");
        return;
      }
      const snap = core.statusSnapshot(io);
      if (snap.active) {
        ctx.ui.notify(`Root ${snap.root} is still ACTIVE on disk. /exitcode resume to re-enter it.`, "warning");
        return;
      }
      enterMode(text);
      ctx.ui.notify(`Entered exitcode mode. Drafting contract for: ${text}`, "info");
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
      } else {
        ctx.ui.notify("Agent is busy; the goal is queued in the exitcode prompt section.", "warning");
      }
    },
  });
}
