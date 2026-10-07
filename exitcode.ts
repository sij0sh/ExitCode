/**
 * exitcode — contract-first recursive execution for Pi.
 *
 * The root goal is user-invoked via /exitcode. Children are proposed by the
 * agent through exitcode_child without separate user approval. All exitcode
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
  localRepairs: Type.Optional(Type.Number({ description: "Local repair attempts before ordinary child decomposition is permitted (default 2)" })),
  maxDepth: Type.Optional(Type.Number({ description: "Recursion depth below the root (default 3)" })),
  maxTotalAttempts: Type.Optional(Type.Number({ description: "Implementation attempts across the tree (default 12)" })),
  deadlineMinutes: Type.Optional(Type.Number({ description: "Shared deadline in minutes (default 60)" })),
  evalTimeoutSeconds: Type.Optional(Type.Number({ description: "Default per-check timeout (default 120)" })),
});

const EXITCODE_NAMESPACE = {
  name: "exitcode",
  description: "Tools for contract review, implementation feedback, and recursive verification.",
  instructions:
    "Use exitcode_status for the active contract, results, budgets, and next action. " +
    "Use exitcode_draft for root review, exitcode_seal for evaluator validation, exitcode_evaluate for fresh results, " +
    "exitcode_child for a narrower subproblem, and exitcode_block for a concrete blocker.",
};

type Runtime = {
  pi: ExtensionAPI;
  modeOn: boolean;
  rootId: string | undefined;
  pendingGoal: string | undefined;
  nudges: number;
  discoveryToolsAdded: string[];
  toolsSuspended: string[];
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
  const rt: Runtime = { pi, modeOn: false, rootId: undefined, pendingGoal: undefined, nudges: 0, discoveryToolsAdded: [], toolsSuspended: [] };
  const DISCOVERY_TOOL_NAMES = core.DISCOVERY_TOOL_NAMES;
  const TOOL_NAMES = core.EXITCODE_TOOL_NAMES;

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

  const persistMode = () => {
    pi.appendEntry(core.MODE_ENTRY_TYPE, {
      on: rt.modeOn, rootId: rt.rootId, pendingGoal: rt.pendingGoal,
      discoveryToolsAdded: rt.discoveryToolsAdded, toolsSuspended: rt.toolsSuspended,
    });
  };

  const restoreDiscoveryTools = () => {
    if (rt.discoveryToolsAdded.length === 0) return;
    pi.setActiveTools(pi.getActiveTools().filter((name) => !rt.discoveryToolsAdded.includes(name)));
    rt.discoveryToolsAdded = [];
  };

  const restoreExecutionTools = () => {
    if (rt.toolsSuspended.length === 0) return;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...rt.toolsSuspended])]);
    rt.toolsSuspended = [];
  };

  const syncDiscoveryTools = (ctx: ExtensionContext) => {
    if (!rt.modeOn) return;
    const snap = core.statusSnapshot(core.makeIo(ctx.cwd));
    const leafId = snap.stack?.at(-1);
    const leafStatus = leafId ? (snap.nodes as any)?.[leafId]?.status : undefined;
    // Only a sealed ACTIVE leaf unlocks execution, including after child drafts.
    if (snap.status === "ACTIVE" && leafStatus === "ACTIVE") {
      if (rt.discoveryToolsAdded.length === 0 && rt.toolsSuspended.length === 0) return;
      restoreDiscoveryTools();
      restoreExecutionTools();
      persistMode();
      return;
    }
    const active = pi.getActiveTools();
    const allowed = [...DISCOVERY_TOOL_NAMES, ...TOOL_NAMES];
    const suspended = active.filter((name) => !allowed.includes(name));
    const missing = DISCOVERY_TOOL_NAMES.filter((name) => !active.includes(name));
    if (missing.length === 0 && suspended.length === 0) return;
    pi.setActiveTools([...active.filter((name) => allowed.includes(name)), ...missing]);
    // Pi ignores unavailable/excluded tools. Own only names actually enabled.
    const enabled = pi.getActiveTools();
    const added = missing.filter((name) => enabled.includes(name) && !rt.discoveryToolsAdded.includes(name));
    rt.discoveryToolsAdded = [...rt.discoveryToolsAdded, ...added];
    rt.toolsSuspended = [...new Set([...rt.toolsSuspended, ...suspended])];
    if (added.length > 0 || suspended.length > 0) persistMode();
  };

  const modeStatusText = (io: ReturnType<typeof core.makeIo>) => {
    const snap = core.statusSnapshot(io);
    if (snap.active) return core.statusText(io);
    if (rt.rootId) {
      const root = core.loadRoot(io, rt.rootId);
      return [
        `exitcode root ${rt.rootId} [${root?.status ?? "MISSING"}]`,
        ...(root?.outcome?.reason ? [`${root.outcome.code}: ${root.outcome.reason}`] : []),
        "Enforcement remains on. Only a fresh root PASS exits automatically.",
        "Use /exitcode exit to cancel without completing the goal.",
      ].join("\n");
    }
    return [
      "exitcode: DISCOVERY (enforcement on)",
      ...(rt.pendingGoal ? [`Root goal: ${rt.pendingGoal}`] : []),
      `Inspect with ${DISCOVERY_TOOL_NAMES.join(", ")}. Clarify the goal, then propose its acceptance contract with exitcode_draft.`,
    ].join("\n");
  };

  const enterMode = (ctx: ExtensionContext, pendingGoal?: string) => {
    rt.modeOn = true;
    rt.nudges = 0;
    if (pendingGoal !== undefined) rt.pendingGoal = pendingGoal;
    persistMode();
    applyExposure();
    syncDiscoveryTools(ctx);
  };

  const exitMode = () => {
    rt.modeOn = false;
    rt.rootId = undefined;
    rt.pendingGoal = undefined;
    rt.nudges = 0;
    restoreDiscoveryTools();
    restoreExecutionTools();
    persistMode();
    applyExposure();
  };

  const maybeAutoExit = (result: any, ctx: ExtensionContext) => {
    const terminal = result?.terminal;
    if (!terminal || (terminal.status !== "PASS" && terminal.status !== "BLOCKED")) return;
    const io = core.makeIo(ctx.cwd);
    if (terminal.status === "PASS") {
      const root = core.loadRoot(io, terminal.root);
      if (root?.status !== "PASS" || core.terminalStale(io, terminal.root).stale) return;
      exitMode();
    }
    if (ctx.hasUI) {
      const summary =
        terminal.status === "PASS"
          ? `exitcode: root ${terminal.root} PASS (candidate ${String(terminal.outcome?.candidateDigest ?? "?").slice(0, 12)}). Mode off.`
          : `exitcode: root ${terminal.root} BLOCKED (${terminal.outcome?.code ?? "?"}): ${terminal.outcome?.reason ?? "no reason"}. Enforcement remains on; /exitcode exit cancels.`;
      ctx.ui.notify(summary, terminal.status === "PASS" ? "success" : "warning");
    }
  };

  const sealContract = async (nodeId: string, ctx: ExtensionContext, userApproval?: string) => {
    const io = core.makeIo(ctx.cwd);
    const result = await core.sealNode(io, nodeId, { userApproval });
    maybeAutoExit(result.cascade ?? result, ctx);
    syncDiscoveryTools(ctx);
    if (!result.ok && !result.events) {
      const lines = [`seal rejected:`, errLines(result)];
      if (typeof result.sealAttemptsLeft === "number") lines.push(`seal proposals left: ${result.sealAttemptsLeft}`);
      if (result.next) lines.push(`next: ${result.next}`);
      return textResult(lines.join("\n"), result, true);
    }
    const lines = result.sealed
      ? [`sealed ${result.sealed}. baseline: ${result.baseline}`]
      : [...(result.events ?? [])];
    if (result.alreadySatisfied) lines.push("baseline already satisfies every criterion: goal already met under this contract.");
    lines.push(...cascadeLines(result.cascade));
    if (result.next) lines.push(`next: ${result.next}`);
    if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`);
    return textResult(withWarnings(lines, result.warnings).join("\n"), result);
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
        return textResult(modeStatusText(io), { ...core.statusSnapshot(io), modeOn: rt.modeOn, rootId: rt.rootId, pendingGoal: rt.pendingGoal });
      },
    },
    {
      name: "exitcode_draft",
      label: "Exitcode Draft",
      description:
        "Propose or revise a root contract with goal, observable criteria, executable checks, assumptions, exclusions, and verification approach. " +
        "Each behavioral criterion needs setup commands for known-valid and known-invalid fixtures in temporary candidate copies. " +
        "The same check must PASS the valid fixture and FAIL every invalid fixture, not ERROR. Do not change the real candidate while validating the evaluator. " +
        "Validates structure only. Present the returned root review and STOP for user review before sealing or implementation.",
      promptSnippet: "exitcode_draft: propose the root contract (goal + criteria + checks + controls)",
      parameters: Type.Object({
        goal: Type.String({ description: "Goal statement" }),
        originalRequest: Type.Optional(Type.String({ description: "Retained user request (defaults to goal)" })),
        criteria: Type.Array(CriterionSchema),
        policy: Type.Optional(PolicySchema),
        assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Resolved product assumptions to show in user review" })),
        exclusions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Out-of-scope work to show in user review" })),
        verification: Type.Optional(Type.String({ minLength: 1, description: "Plain-language verification approach; do not dump shell mechanics" })),
        revise: Type.Optional(Type.String({ description: "Existing DRAFT root id to revise (e.g. G1)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        const io = core.makeIo(ctx.cwd);
        if (rt.rootId && !core.statusSnapshot(io).active) {
          return textResult("draft rejected:\n- the previous root is terminal or missing; the user must cancel with /exitcode exit before starting a new goal", { ok: false }, true);
        }
        const result = core.draftNode(io, {
          goal: params.goal,
          originalRequest: params.originalRequest ?? rt.pendingGoal,
          criteria: params.criteria,
          policy: params.policy,
          assumptions: params.assumptions,
          exclusions: params.exclusions,
          verification: params.verification,
          revise: params.revise,
        });
        if (!result.ok) return textResult(`draft rejected:\n${errLines(result)}`, result, true);
        rt.rootId = result.rootId;
        rt.pendingGoal = undefined;
        persistMode();
        syncDiscoveryTools(ctx);
        return textResult(
          withWarnings([`draft ${result.id} accepted.`, core.rootReviewText(result.draft), `next: ${result.next}`], result.warnings).join("\n"),
          result,
        );
      },
    },
    {
      name: "exitcode_seal",
      label: "Exitcode Seal",
      description:
        "Run E0: validate structure, test discrimination and empty-target rejection, record the baseline, then seal. " +
        "For an unapproved root, interpret the user's reply to the current review: acceptance, requested changes, or a question. " +
        "On acceptance (for example 'looks good, go ahead'), supply userApproval quoting the reply. /exitcode approve is an optional shortcut. " +
        "A reply requesting changes is not approval, even with assent. Revise and present the complete contract again. Ask when unclear. Never infer approval. " +
        "Any root revision after E0 failure needs fresh approval. Children need no userApproval. Coding tools unlock after sealing.",
      promptSnippet: "exitcode_seal: validate the evaluator, seal the contract, record the baseline",
      parameters: Type.Object({
        node: Type.String({ description: "Draft node id (e.g. G1, G1.1)" }),
        userApproval: Type.Optional(Type.String({ minLength: 1, description: "Quote the user's reply accepting the current root contract after review. Omit for children or an already-approved root. Never use the initial goal, silence, a change request, or an assistant message." })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        rt.nudges = 0;
        return sealContract(params.node, ctx, params.userApproval);
      },
    },
    {
      name: "exitcode_evaluate",
      label: "Exitcode Evaluate",
      description:
        "Fresh supervisor evaluation of the current candidate. Consumes one shared attempt when the tree changed. " +
        "Checks ancestor regressions (restoring on regress), and reruns the parent when a child passes. " +
        "Follow the returned parent result and next action. Only ALL PASS here closes a goal.",
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
        syncDiscoveryTools(ctx);
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
        "Propose or revise a narrower child targeting exactly one failed parent criterion. Explain how it advances that requirement. " +
        "Use after the configured local repair attempts, or for an early prerequisite with an observable prerequisiteArtifact. " +
        "Supply the child's own checks and valid/invalid fixture setups as for a root. Seal and evaluate it without user approval. " +
        "The supervisor enforces child gates and reevaluates the parent after child PASS.",
      promptSnippet: "exitcode_child: propose one narrower child tied to a failing parent criterion",
      parameters: Type.Object({
        parent: Type.String({ description: "Parent node id (e.g. G1)" }),
        target: Type.String({ description: "Failing parent criterion id (e.g. C2)" }),
        goal: Type.String({ description: "Narrower child goal" }),
        originalRequest: Type.Optional(Type.String({ description: "Retained request (defaults to the parent's)" })),
        criteria: Type.Array(CriterionSchema),
        reason: Type.String({ description: "How this child advances the parent target" }),
        prerequisite: Type.Optional(Type.Boolean({ description: "True to request decomposition before the local repair threshold; requires prerequisiteArtifact" })),
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
        syncDiscoveryTools(ctx);
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
        "retains diagnostics, and reruns the parent. Terminal for roots, but enforcement stays on until the user cancels. BLOCKED is not success.",
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
        syncDiscoveryTools(ctx);
        const lines = [...(result.events ?? [])];
        if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`, "Enforcement remains on. Only the user can cancel with /exitcode exit.");
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
    rt.pendingGoal = mode.pendingGoal;
    const entry = branch.findLast((entry) => entry.type === "custom" && entry.customType === core.MODE_ENTRY_TYPE);
    const data = (entry as { data?: { discoveryToolsAdded?: unknown; toolsSuspended?: unknown } } | undefined)?.data;
    const added = data?.discoveryToolsAdded;
    // Clean up borrowed find from older transcripts without claiming user tools.
    rt.discoveryToolsAdded = Array.isArray(added) ? added.filter((name) => DISCOVERY_TOOL_NAMES.includes(name) || name === "find") : [];
    const suspended = data?.toolsSuspended;
    rt.toolsSuspended = Array.isArray(suspended) ? suspended.filter((name) => typeof name === "string" && ![...DISCOVERY_TOOL_NAMES, ...TOOL_NAMES].includes(name)) : [];
    const obsolete = rt.discoveryToolsAdded.filter((name) => !DISCOVERY_TOOL_NAMES.includes(name));
    if (obsolete.length > 0) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !obsolete.includes(name)));
      rt.discoveryToolsAdded = rt.discoveryToolsAdded.filter((name) => !obsolete.includes(name));
      persistMode();
    }
    if (!rt.modeOn) {
      restoreDiscoveryTools();
      restoreExecutionTools();
    }
    applyExposure();
    syncDiscoveryTools(ctx);
  });

  // Keep ownership in the branch entry, but restore the retiring loadout so
  // reload does not mistake borrowed tools for user-selected tools.
  pi.on("session_shutdown", () => {
    restoreDiscoveryTools();
    restoreExecutionTools();
  });

  pi.on("input", () => {
    rt.nudges = 0;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!rt.modeOn) {
      delete event.systemPromptOptions.sections["exitcode"];
      return;
    }
    syncDiscoveryTools(ctx);
    const io = core.makeIo(ctx.cwd);
    const lines = [core.PROTOCOL_PROMPT, "", modeStatusText(io)];
    event.systemPromptOptions.sections["exitcode"] = lines.join("\n");
  });

  pi.on("tool_call", (event, ctx) => {
    if (!rt.modeOn) return undefined;
    if (TOOL_NAMES.includes(event.toolName)) {
      rt.nudges = 0;
      return undefined;
    }
    const io = core.makeIo(ctx.cwd);
    const snap = core.statusSnapshot(io);
    const stack = snap.stack ?? [];
    const leafId = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const leafStatus = snap.status === "ACTIVE" ? (leafId && (snap.nodes as any)?.[leafId]?.status) || "NO_CONTRACT" : "NO_CONTRACT";
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
      // Discovery, blockers, and missing state are pauses, not permission to code.
      const root = rt.rootId ? core.loadRoot(io, rt.rootId) : null;
      if (root?.status === "PASS") maybeAutoExit({ terminal: { root: root.id, status: root.status, outcome: root.outcome } }, ctx);
      return undefined;
    }
    const stack = snap.stack ?? [];
    const leafId = stack[stack.length - 1];
    const leafStatus = (snap.nodes as any)?.[leafId]?.status;
    if (leafStatus !== "ACTIVE" && leafStatus !== "DRAFT") return undefined;
    // The human checkpoint is a review pause, not autonomous work.
    if (snap.awaitingApproval) return undefined;
    if (snap.expired) {
      const result = await core.blockNode(io, leafId, { reason: "shared deadline exceeded", code: "BUDGET_EXHAUSTED" });
      maybeAutoExit(result, ctx);
      syncDiscoveryTools(ctx);
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
          content: `exitcode: ${leafId} remains ${leafStatus} :: ${leaf?.vector ?? "unevaluated"}. next: ${snap.next}`,
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
      "/exitcode approve optional shortcut to approve the root draft and start autonomous work",
      "/exitcode status  show the active contract, vectors, and budgets",
      "/exitcode resume  re-enter mode for the on-disk root, including pending review",
      "/exitcode exit    user cancellation only; not successful completion (work on disk is preserved)",
    ].join("\n");

  pi.registerCommand("exitcode", {
    description: "Enter exitcode mode: contract-first recursive execution rooted at your goal",
    handler: async (args, ctx) => {
      const text = args.trim();
      const [sub] = text.split(/\s+/, 1);
      const io = core.makeIo(ctx.cwd);

      if (!text || sub === "help") {
        ctx.ui.notify(rt.modeOn ? `${modeStatusText(io)}\n\n${usage()}` : usage(), "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(rt.modeOn ? modeStatusText(io) : `exitcode mode is off.\n${core.statusText(io)}`, "info");
        return;
      }
      if (sub === "approve") {
        if (text !== "approve") {
          ctx.ui.notify("Usage: /exitcode approve", "warning");
          return;
        }
        if (!rt.modeOn) {
          ctx.ui.notify("Enter exitcode mode with /exitcode resume before approving an on-disk draft.", "warning");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait for the agent to finish presenting the root contract before approving.", "warning");
          return;
        }
        const approval = core.approveRoot(io);
        if (!approval.ok) {
          ctx.ui.notify(`approval rejected:\n${errLines(approval)}`, "warning");
          return;
        }
        rt.nudges = 0;
        const sealed = await sealContract(approval.id, ctx);
        const result = sealed.details as any;
        pi.sendMessage({
          customType: "exitcode-approval",
          content: `User approved root ${approval.id} (digest ${approval.approval.digest}).\n${sealed.content[0].text}`,
          display: true,
          details: result,
        }, { triggerTurn: rt.modeOn && core.statusSnapshot(io).active });
        return;
      }
      if (sub === "exit") {
        if (text !== "exit") {
          ctx.ui.notify("Usage: /exitcode exit", "warning");
          return;
        }
        if (!rt.modeOn) {
          ctx.ui.notify("exitcode mode is already off.", "info");
          return;
        }
        exitMode();
        ctx.ui.notify("Cancelled exitcode mode without completing the goal. Contracts on disk are preserved; /exitcode resume re-enters an active root.", "info");
        return;
      }
      if (sub === "resume") {
        if (rt.modeOn) {
          ctx.ui.notify("Already in exitcode mode.", "info");
          return;
        }
        const snap = core.statusSnapshot(io);
        if (!snap.active) {
          ctx.ui.notify("Nothing to resume: no active or pending-review root on disk. Start one with /exitcode <goal>.", "warning");
          return;
        }
        rt.rootId = snap.root;
        enterMode(ctx);
        ctx.ui.notify(`Re-entered exitcode mode for root ${snap.root}. ${snap.next}${snap.review ? `\n\n${snap.review}` : ""}`, "info");
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
      enterMode(ctx, text);
      ctx.ui.notify(`Entered exitcode mode. Read-only discovery and contract review for: ${text}`, "info");
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
      } else {
        ctx.ui.notify("Agent is busy; the goal is queued in the exitcode prompt section.", "warning");
      }
    },
  });
}
