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
 * injection, lifecycle guards, and the /exitcode command. The user's tool
 * loadout is never changed; before sealing, candidate immutability is
 * verified at supervisor boundaries instead.
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
  command: Type.Optional(Type.String({ description: "Isolated custom shell escape hatch" })),
  recipe: Type.Optional(Type.Object({
    kind: Type.Union(core.RECIPE_KINDS.map((x: string) => Type.Literal(x))),
    path: Type.Optional(Type.String()), value: Type.Optional(Type.Unknown()),
    pointer: Type.Optional(Type.String()), selector: Type.Optional(Type.String()),
    runner: Type.Optional(Type.String()), command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
  })),
  assets: Type.Optional(Type.Array(Type.String({minLength:1}), {description:"Acceptance helpers outside conventional test paths; frozen at seal, not product source"})),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Immutable explicit check watchdog; otherwise use remaining execution time" })),
  expect: Type.Optional(ExpectSchema),
});

const MutationSchema = Type.Object({
  kind: Type.Union(core.MUTATION_KINDS.map((x: string) => Type.Literal(x))),
  path: Type.String(), content: Type.Optional(Type.String()), from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()), pointer: Type.Optional(Type.String()), value: Type.Optional(Type.Unknown()),
});
const FixtureSchema = Type.Object({
  setup: Type.Optional(Type.String({ minLength:1, description:"Isolated legacy/custom shell setup" })),
  mutations: Type.Optional(Type.Array(MutationSchema, {minItems:1,maxItems:32})),
  reason: Type.Optional(Type.String()),
});
const ControlsSchema = Type.Object({accept:FixtureSchema,reject:Type.Array(FixtureSchema,{minItems:1})});
const IntentSchema = Type.Array(Type.Object({id:Type.String(),outcome:Type.String(),criteria:Type.Array(Type.String())}));
const AmbiguitySchema = Type.Array(Type.Object({question:Type.String(),plausibleAnswers:Type.Array(Type.String()),recommendedDefault:Type.Optional(Type.String()),whyMaterial:Type.String(),affectedCriteria:Type.Array(Type.String()),confidence:Type.Optional(Type.Number()),unresolved:Type.Boolean()}));

const CriterionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Suggested id (supervisor assigns C1..Cn when omitted)" })),
  requirement: Type.String({ description: "Observable requirement in plain language" }),
  type: Type.Optional(Type.Union([Type.Literal("behavior"), Type.Literal("regression")], { description: "behavior (default) or regression" })),
  check: CheckSchema,
  controls: Type.Optional(ControlsSchema),
});

const PolicySchema = Type.Object({
  evaluatorAttempts: Type.Optional(Type.Number({description:"Separate evaluator construction budget (default 6)"})),
  localRepairs: Type.Optional(Type.Number({ description: "Local repair attempts before ordinary child decomposition is permitted (default 2)" })),
  maxDepth: Type.Optional(Type.Number({ description: "Recursion depth below the root (default 3)" })),
  maxTotalAttempts: Type.Optional(Type.Number({ description: "Implementation attempts across the tree (default 12)" })),
  deadlineMinutes: Type.Optional(Type.Number({ description: "Shared execution minutes from successful root seal (default 60); preparation and human review do not start it" })),
  evalTimeoutSeconds: Type.Optional(Type.Number({ description: "Initial executable preparation watchdog (default 900); execution otherwise uses remaining global time" })),
  evaluatorAttempts: Type.Optional(Type.Number({description:"Substantive construction proposals per node (default 6); infrastructure errors do not spend them"})),
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
  progress: string | undefined;
  operations: Map<AbortController, Promise<void>>;
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
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionToolContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }>;
};

function textResult(text: string, details: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function errLines(result: { errors?: string[]; policy?: unknown; deadlineAt?: string | null; next?: string }): string {
  const lines = (result.errors ?? ["unknown error"]).map((e) => `- ${e}`);
  if (result.policy) {
    lines.push(`Effective policy: ${JSON.stringify(result.policy)}`, `Shared deadline: ${result.deadlineAt ?? "starts at root seal"}`);
  }
  if (result.next) lines.push(`next: ${result.next}`);
  return lines.join("\n");
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

// Review retries are bounded in the core. Usage includes each completed provider attempt.
function reviewIo(ctx: ExtensionContext, signal?: AbortSignal, onProgress?: (progress: any) => void, expectedRootId?: string | null) {
  const usage = { available:false,input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
  const io = core.makeIo(ctx.cwd, { signal: signal ?? ctx.signal, reviewUsage:usage,onProgress,expectedRootId,
    review: async (input: any, options: {signal:AbortSignal}) => {
      if (!ctx.model || !ctx.modelRegistry?.streamSimple) throw new Error("selected review model unavailable");
      const encoded=JSON.stringify(input);
      if(encoded.length>2*1024*1024)throw new Error("review input exceeds bounded context; reduce evaluator scope");
      const result=await ctx.modelRegistry.streamSimple(ctx.model, {
        systemPrompt:core.reviewPrompt(input.phase),
        messages:[{role:"user",content:encoded,timestamp:Date.now()}],
      }, {reasoning:ctx.thinkingLevel,maxTokens:core.REVIEW_MAX_TOKENS,signal:options.signal}).result();
      // Provider errors can still carry billable usage.
      if(result.usage)usage.available=true;
      for(const k of ["input","output","cacheRead","cacheWrite","totalTokens"] as const)
        usage[k]+=result.usage?.[k] ?? 0;
      for(const k of ["input","output","cacheRead","cacheWrite","total"] as const)
        usage.cost[k]+=result.usage?.cost?.[k] ?? 0;
      if(result.stopReason!=="stop")throw Object.assign(new Error(result.errorMessage ?? `review stopped: ${result.stopReason}`),result.stopReason==="aborted"?{code:"CANCELLED"}:result.stopReason==="length"?{code:"REVIEW_RESPONSE_INVALID"}:{});
      const text=result.content.filter(b=>b.type==="text").map(b=>b.text).join("");
      if(text.length>512*1024)throw Object.assign(new Error("review output exceeds bounded response"),{code:"REVIEW_RESPONSE_INVALID"});
      return JSON.parse(text);
    },
  });
  return io;
}

export default function (pi: ExtensionAPI) {
  const rt: Runtime = { pi, modeOn: false, rootId: undefined, pendingGoal: undefined, nudges: 0, progress:undefined, operations:new Map() };
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
    pi.appendEntry(core.MODE_ENTRY_TYPE, { on: rt.modeOn, rootId: rt.rootId, pendingGoal: rt.pendingGoal });
  };

  // Each unsealed phase keeps its own pre-seal baseline; sealed execution keeps none.
  const syncBaseline = (ctx: ExtensionContext) => {
    if (rt.modeOn) core.ensureBaseline(core.makeIo(ctx.cwd,{expectedRootId:rt.rootId}));
  };

  const modeStatusText = (io: ReturnType<typeof core.makeIo>) => {
    const snap = core.statusSnapshot(io);
    if(snap.active)return `${rt.rootId!==snap.root?"Session does not own this workspace root. Use /exitcode resume to adopt it explicitly.\n":""}${core.statusText(io)}`;
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
      "Inspect with any available tools without changing the candidate. Clarify the goal, then propose its acceptance contract with exitcode_draft.",
    ].join("\n");
  };

  const enterMode = (ctx: ExtensionContext, pendingGoal?: string) => {
    rt.modeOn = true;
    rt.nudges = 0;rt.progress=undefined;
    if (pendingGoal !== undefined) rt.pendingGoal = pendingGoal;
    persistMode();
    applyExposure();
    // Entry fixes the current tree as the candidate, including edits made while mode was off.
    if(!rt.operations.size)core.releaseBaseline(ctx.cwd);
    syncBaseline(ctx);
  };

  const exitMode = (ctx: ExtensionContext) => {
    for(const operation of rt.operations.keys())operation.abort();
    rt.modeOn = false;
    rt.rootId = undefined;
    rt.pendingGoal = undefined;
    rt.nudges = 0;rt.progress=undefined;
    if(!rt.operations.size)core.releaseBaseline(ctx.cwd);
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
      exitMode(ctx);
    }
    if (ctx.hasUI) {
      const summary =
        terminal.status === "PASS"
          ? `exitcode: root ${terminal.root} PASS (candidate ${String(terminal.outcome?.candidateDigest ?? "?").slice(0, 12)}). Mode off.`
          : `exitcode: root ${terminal.root} BLOCKED (${terminal.outcome?.code ?? "?"}): ${terminal.outcome?.reason ?? "no reason"}. Enforcement remains on; /exitcode exit cancels.`;
      ctx.ui.notify(summary, terminal.status === "PASS" ? "success" : "warning");
    }
  };

  const withOperation = async <T>(ctx: ExtensionContext, signal: AbortSignal | undefined, onUpdate: unknown,
    work: (io: ReturnType<typeof core.makeIo>) => T | Promise<T>): Promise<T> => {
    const controller=new AbortController(),parent=signal??ctx.signal;
    const abort=()=>controller.abort(parent?.reason);
    if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
    let complete!: () => void;
    const done=new Promise<void>(resolve=>{complete=resolve;});
    rt.operations.set(controller,done);
    const io=reviewIo(ctx,controller.signal,progress=>{
      const content=`exitcode: ${progress.phase} / ${progress.stage}${progress.elapsedMs===undefined?'':` (${(progress.elapsedMs/1000).toFixed(1)}s)`}`;
      if(typeof onUpdate==='function')onUpdate(textResult(content,{progress}));
      if(ctx.hasUI)ctx.ui.setStatus?.('exitcode',content);
    },rt.rootId??null);
    try {return await work(io);}
    finally {rt.operations.delete(controller);complete();parent?.removeEventListener('abort',abort);if(ctx.hasUI)ctx.ui.setStatus?.('exitcode',undefined);if(!rt.modeOn && !rt.operations.size)core.releaseBaseline(ctx.cwd);}
  };

  const sealContract = async (nodeId: string, ctx: ExtensionContext, userApproval?: string, signal?: AbortSignal, onUpdate?: unknown) => withOperation(ctx,signal,onUpdate,async io => {
    const result = await core.sealNode(io, nodeId, { userApproval });
    maybeAutoExit(result.cascade ?? result, ctx);
    syncBaseline(ctx);
    if (!result.ok && !result.events) {
      const lines = withWarnings([`seal rejected:`, errLines(result)], result.warnings);
      if (typeof result.sealAttemptsLeft === "number") lines.push(`seal proposals left: ${result.sealAttemptsLeft}`);
      return {...textResult(lines.join("\n"), result, true),usage:io.reviewUsage};
    }
    const lines = result.sealed
      ? [`sealed ${result.sealed}. baseline: ${result.baseline}`]
      : [...(result.events ?? [])];
    if (result.alreadySatisfied) lines.push("baseline already satisfies every criterion: goal already met under this contract.");
    lines.push(...cascadeLines(result.cascade));
    if (result.next) lines.push(`next: ${result.next}`);
    if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`);
    return {...textResult(withWarnings(lines, result.warnings).join("\n"), result,!result.ok),usage:io.reviewUsage};
  });

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
        "Policy corrections are allowed before first approval; omitted fields retain their effective values. " +
        "Never replace the user's objective with extension housekeeping or a commit reminder. " +
        "Safely prepares and validates before returning review. Repair typed failures internally. Present a validated plan and STOP for user review before sealing or implementation.",
      promptSnippet: "exitcode_draft: propose the root contract (goal + criteria + checks + controls)",
      parameters: Type.Object({
        goal: Type.String({ description: "Goal statement" }),
        originalRequest: Type.Optional(Type.String({ description: "Fallback request only; the /exitcode goal and existing root request take priority" })),
        criteria: Type.Array(CriterionSchema),
        intentAtoms: Type.Optional(IntentSchema),
        ambiguities: Type.Optional(AmbiguitySchema),
        specificationPaths: Type.Optional(Type.Array(Type.String({minLength:1}), {description:"Referenced Markdown plans to include in independent review, including explicit hidden paths"})),
        mutableDependencies: Type.Optional(Type.Boolean({description:"The reviewed task may change product dependencies; devDependencies and evaluator runtimes stay frozen"})),
        policy: Type.Optional(PolicySchema),
        assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Resolved product assumptions to show in user review" })),
        exclusions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Out-of-scope work to show in user review" })),
        verification: Type.Optional(Type.String({ minLength: 1, description: "Plain-language verification approach; do not dump shell mechanics" })),
        revise: Type.Optional(Type.String({ description: "Existing DRAFT root id to revise (e.g. G1)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => withOperation(ctx,_signal,_onUpdate,async io => {
        assertMode();
        if (rt.rootId && !core.statusSnapshot(io).active) {
          return textResult("draft rejected:\n- the previous root is terminal or missing; the user must cancel with /exitcode exit before starting a new goal", { ok: false }, true);
        }
        const result = core.draftNode(io, {
          goal: params.goal,
          originalRequest: rt.pendingGoal ?? params.originalRequest,
          criteria: params.criteria,
          intentAtoms: params.intentAtoms,
          ambiguities: params.ambiguities,
          specificationPaths: params.specificationPaths,
          mutableDependencies: params.mutableDependencies,
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
        syncBaseline(ctx);
        io.expectedRootId=result.rootId;
        const prepared = await core.prepareNode(io,result.id);
        prepared.warnings=[...(result.warnings??[]),...(prepared.warnings??[])];
        syncBaseline(ctx);
        if (!prepared.ok) return {...textResult(withWarnings([`Evaluator preparation needs repair:\n${errLines(prepared)}${prepared.questions?.length ? '\nClarification: '+JSON.stringify(prepared.questions) : ''}`],prepared.warnings).join("\n"),prepared,true),usage:io.reviewUsage};
        return {...textResult(withWarnings([prepared.review],prepared.warnings).join("\n"),prepared),usage:io.reviewUsage};
      }),
    },
    {
      name: "exitcode_seal",
      label: "Exitcode Seal",
      description:
        "Seal the exact safely prepared evaluator bundle. Stale candidate or environment requires preparation and review again. " +
        "For an unapproved root, interpret the user's reply to the current review: acceptance, requested changes, or a question. " +
        "On acceptance (for example 'looks good, go ahead'), supply userApproval quoting the reply. /exitcode approve is an optional shortcut. " +
        "A reply requesting changes is not approval, even with assent. Revise and present the complete contract again. Ask when unclear. Never infer approval. " +
        "Evaluator failures are repaired before review. A revision after review requires validation and fresh approval. Children need no userApproval. The candidate becomes writable after sealing.",
      promptSnippet: "exitcode_seal: validate the evaluator, seal the contract, record the baseline",
      parameters: Type.Object({
        node: Type.String({ description: "Draft node id (e.g. G1, G1.1)" }),
        userApproval: Type.Optional(Type.String({ minLength: 1, description: "Quote the user's reply accepting the current root contract after review. Omit for children or an already-approved root. Never use the initial goal, silence, a change request, or an assistant message." })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        return sealContract(params.node, ctx, params.userApproval,_signal,_onUpdate);
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
      execute: async (_id, params, _signal, _onUpdate, ctx) => withOperation(ctx,_signal,_onUpdate,async io => {
        assertMode();
        const result = await core.evaluateNode(io, params.node ?? null);
        if (!result.ok) {syncBaseline(ctx);return textResult(`${result.paused?"evaluation paused":"evaluate rejected"}:\n${errLines(result)}`, result, true);}
        maybeAutoExit(result.cascade ?? result, ctx);
        syncBaseline(ctx);
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
      }),
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
        intentAtoms: Type.Optional(IntentSchema),
        ambiguities: Type.Optional(AmbiguitySchema),
        specificationPaths: Type.Optional(Type.Array(Type.String({minLength:1}))),
        reason: Type.String({ description: "How this child advances the parent target" }),
        prerequisite: Type.Optional(Type.Boolean({ description: "True to request decomposition before the local repair threshold; requires prerequisiteArtifact" })),
        prerequisiteArtifact: Type.Optional(Type.String({ description: "Observable artifact the prerequisite produces" })),
        revise: Type.Optional(Type.String({ description: "Existing DRAFT child id to revise (e.g. G1.1)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => withOperation(ctx,_signal,_onUpdate,async io => {
        assertMode();
        const result = core.draftNode(io, {
          parentId: params.parent,
          target: params.target,
          goal: params.goal,
          originalRequest: params.originalRequest,
          criteria: params.criteria,
          intentAtoms: params.intentAtoms,
          ambiguities: params.ambiguities,
          specificationPaths: params.specificationPaths,
          reason: params.reason,
          prerequisite: params.prerequisite,
          prerequisiteArtifact: params.prerequisiteArtifact,
          revise: params.revise,
        });
        if (!result.ok) return textResult(`child rejected:\n${errLines(result)}`, result, true);
        syncBaseline(ctx);
        return textResult(
          withWarnings([`child draft ${result.id} accepted (targets ${params.parent}.${params.target}).`, `next: ${result.next}`], result.warnings).join("\n"),
          result,
        );
      }),
    },
    {
      name: "exitcode_block",
      label: "Exitcode Block",
      description:
        "Pause a root for a concrete missing requirement, authority, budget, or infrastructure cause without dropping work or accounting. " +
        "A declined child path is withdrawn and its parent rerun. Infrastructure ERROR keeps the stack and useful edits. /exitcode resume retries a paused operation. A pause or BLOCKED child is not success.",
      promptSnippet: "exitcode_block: pause with the exact missing requirement; withdraw only a genuinely failed child path",
      parameters: Type.Object({
        node: Type.Optional(Type.String({ description: "Node id (defaults to the active leaf)" })),
        reason: Type.String({ description: "Specific missing requirement, credential, authorization, or cause" }),
        code: Type.Optional(Type.String({ description: `One of ${core.BLOCK_CODES.join(", ")} (default NO_PATH)` })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => withOperation(ctx,_signal,_onUpdate,async io => {
        assertMode();
        const leaf = params.node ?? null;
        const target = leaf ?? (() => {
          const snap = core.statusSnapshot(io);
          const stack = snap.stack ?? [];
          return stack.length > 0 ? stack[stack.length - 1] : null;
        })();
        if (!target) return textResult("block rejected:\n- no active node", { ok: false }, true);
        const result = await core.blockNode(io, target, { reason: params.reason, code: params.code ?? "NO_PATH" });
        if (!result.ok) {syncBaseline(ctx);return textResult(`${result.paused?"paused":"block rejected"}:\n${errLines(result)}`, result, true);}
        maybeAutoExit(result, ctx);
        syncBaseline(ctx);
        const lines = [...(result.events ?? [])];
        if (result.terminal) lines.push(`terminal: root ${result.terminal.root} ${result.terminal.status}`, "Enforcement remains on. Only the user can cancel with /exitcode exit.");
        return textResult(lines.join("\n"), result);
      }),
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
    rt.nudges = 0;rt.progress=undefined;
    rt.pendingGoal = mode.pendingGoal;
    // Older versions narrowed the loadout before sealing. Return it once, claiming only borrowed discovery tools.
    const entry = branch.findLast((entry) => entry.type === "custom" && entry.customType === core.MODE_ENTRY_TYPE);
    const legacy = (entry as { data?: { discoveryToolsAdded?: unknown; toolsSuspended?: unknown } } | undefined)?.data ?? {};
    const borrowed = Array.isArray(legacy.discoveryToolsAdded) ? legacy.discoveryToolsAdded.filter((name) => ["read", "grep", "ls", "find"].includes(name)) : [];
    const suspended = Array.isArray(legacy.toolsSuspended) ? legacy.toolsSuspended.filter((name) => typeof name === "string") : [];
    if (borrowed.length > 0 || suspended.length > 0) {
      pi.setActiveTools([...new Set([...pi.getActiveTools().filter((name) => !borrowed.includes(name)), ...suspended])]);
      persistMode();
    }
    if(rt.modeOn)core.resumePreparation(core.makeIo(ctx.cwd,{expectedRootId:rt.rootId}));
    applyExposure();
    syncBaseline(ctx);
  });

  pi.on("input", event => {if(event.source!=="extension"){rt.nudges=0;rt.progress=undefined;}});

  pi.on("session_shutdown", async () => {
    for(const operation of rt.operations.keys())operation.abort();
    await Promise.all(rt.operations.values());
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!rt.modeOn) {
      delete event.systemPromptOptions.sections["exitcode"];
      return;
    }
    syncBaseline(ctx);
    const io = core.makeIo(ctx.cwd);
    const lines = [core.PROTOCOL_PROMPT, "", modeStatusText(io)];
    event.systemPromptOptions.sections["exitcode"] = lines.join("\n");
  });

  pi.on("tool_call", (event, ctx) => {
    if (!rt.modeOn) return undefined;
    if (TOOL_NAMES.includes(event.toolName)) return undefined;
    // Tools are not classified. Only direct access to supervisor state is denied.
    const verdict = core.guardToolCall({
      modeOn: true,
      cwd: ctx.cwd,
      toolName: event.toolName,
      input: (event as { input?: unknown }).input as Record<string, unknown>,
    });
    if (verdict?.block) return { block: true, reason: verdict.reason };
    return undefined;
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    if(!rt.modeOn)return undefined;
    const io=core.makeIo(ctx.cwd,{expectedRootId:rt.rootId,signal:ctx.signal});
    const baseline=core.enforceBaseline(io);
    if(['OPERATION_BUSY','CANCELLED'].includes(baseline.code))return undefined;
    const snap=core.statusSnapshot(io);
    if(snap.active && snap.root!==rt.rootId) {
      return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:'exitcode: session root differs from workspace root. Use /exitcode resume to adopt it explicitly.',display:true}]};
    }
    if(!baseline.ok) {
      if(ctx.hasUI)ctx.ui.notify(`exitcode: ${baseline.message??errLines(baseline)}`,'warning');
      if(rt.nudges>=core.MAX_SETTLE_NUDGES) {
        const paused=snap.active?core.pauseNode(io,{reason:'Repeated pre-seal changes made no progress. Inspect the discarded files and resume without modifying the candidate.',code:'NO_PROGRESS',operation:snap.phase==='EXECUTION'?'evaluate':'prepare'}):null;
        syncBaseline(ctx);
        return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:paused?errLines(paused):'exitcode: repeated pre-seal changes were restored. Discovery is paused; continue inspection without modifying the candidate.',display:true}]};
      }
      rt.nudges++;
      return {entries:[{type:'custom_message' as const,customType:'exitcode-nudge',content:baseline.message??errLines(baseline),display:true}],continue:true};
    }
    if(!snap.active) {
      const root=rt.rootId?core.loadRoot(io,rt.rootId):null;
      if(root?.status==='PASS')maybeAutoExit({terminal:{root:root.id,status:root.status,outcome:root.outcome}},ctx);
      return undefined;
    }
    if(snap.status==='PAUSED' || snap.phase==='CLARIFICATION' || snap.awaitingApproval)return undefined;
    const leafId=snap.stack?.at(-1),leaf=leafId?(snap.nodes as any)?.[leafId]:null;
    if(!leaf || !['ACTIVE','DRAFT'].includes(leaf.status))return undefined;
    if(snap.expired) {
      const paused=core.pauseNode(io,{reason:'shared execution deadline exceeded',code:'BUDGET_EXHAUSTED',operation:leaf.status==='DRAFT'?'prepare':'evaluate'});
      syncBaseline(ctx);
      return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:errLines(paused),display:true}]};
    }
    let candidate;
    try{candidate=core.digestTree(ctx.cwd);}catch(e){core.pauseNode(io,{reason:e.message,code:e.code??"IO_ERROR",operation:leaf.status==='DRAFT'?'prepare':'evaluate'});return undefined;}
    const progress=JSON.stringify({candidate,phase:snap.phase,stack:snap.stack,attempts:snap.consumedAttempts,vector:leaf.vector,
      intent:snap.intentDigest,evaluator:snap.evaluatorDigest,diagnostics:snap.diagnostics,restored:baseline.restored===true});
    if(progress!==rt.progress){rt.progress=progress;rt.nudges=0;}
    if(rt.nudges>=core.MAX_SETTLE_NUDGES) {
      const paused=core.pauseNode(io,{reason:'No observable progress after repeated continuation requests. Inspect the saved diagnostics, then resume the same root.',code:'NO_PROGRESS',operation:leaf.status==='DRAFT'?'prepare':'evaluate'});
      syncBaseline(ctx);
      return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:errLines(paused),display:true}]};
    }
    rt.nudges++;
    const content=baseline.ok ? `exitcode: ${leafId} remains ${leaf.status} :: ${leaf.vector}. next: ${snap.next}` : baseline.message??errLines(baseline);
    return {entries:[{type:'custom_message' as const,customType:'exitcode-nudge',content,display:true}],continue:true};
  });

  // --- /exitcode command: the only user entry to the loop -------------------

  const usage = () =>
    [
      "exitcode: contract-first recursive execution.",
      "/exitcode <goal>  enter exitcode mode rooted at your goal (root only; children come from exitcode_child)",
      "/exitcode approve optional shortcut to approve the root draft and start autonomous work",
      "/exitcode status  show the active contract, vectors, and budgets",
      "/exitcode resume [Gid] [minutes=N] [attempts=N] [evaluators=N]  retry the same paused operation; optional positive grants require this user command",
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
        const approval = core.approveRoot(core.makeIo(ctx.cwd,{expectedRootId:rt.rootId}));
        if (!approval.ok) {
          ctx.ui.notify(withWarnings([`approval rejected:\n${errLines(approval)}`], approval.warnings).join("\n"), "warning");
          return;
        }
        rt.nudges=0;rt.progress=undefined;
        const sealed = await sealContract(approval.id, ctx);
        const result = sealed.details as any;
        pi.sendMessage({
          customType: "exitcode-approval",
          content: withWarnings([`User approved root ${approval.id} (digest ${approval.approval.digest}).`, sealed.content[0].text], approval.warnings).join("\n"),
          display: true,
          details: result,
        }, { triggerTurn: rt.modeOn && core.statusSnapshot(io).status==="ACTIVE" });
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
        exitMode(ctx);
        await Promise.all(rt.operations.values());
        ctx.ui.notify("Cancelled exitcode mode without completing the goal. Contracts on disk are preserved; /exitcode resume re-enters an active root.", "info");
        return;
      }
      if (sub === "resume") {
        if(!ctx.isIdle()){ctx.ui.notify('Wait for the active operation to finish or cancel before resuming.','warning');return;}
        const options: {rootId?:string;deadlineMinutes?:number;maxTotalAttempts?:number;evaluatorAttempts?:number}={};
        for(const arg of text.split(/\s+/).slice(1)) {
          if(/^G\d+$/.test(arg) && !options.rootId){options.rootId=arg;continue;}
          const match=arg.match(/^(minutes|attempts|evaluators)=(\d+(?:\.\d+)?)$/);
          const key=match && ({minutes:'deadlineMinutes',attempts:'maxTotalAttempts',evaluators:'evaluatorAttempts'} as const)[match[1]];
          if(!key || options[key]!==undefined){ctx.ui.notify('Usage: /exitcode resume [Gid] [minutes=N] [attempts=N] [evaluators=N]','warning');return;}
          options[key]=Number(match[2]);
        }
        if(!options.rootId)options.rootId=core.loadIndex(ctx.cwd).activeRootId??rt.rootId;
        const resumed=core.resumeRoot(io,options);
        if(!resumed.ok){ctx.ui.notify(`resume rejected:\n${errLines(resumed)}`,'warning');return;}
        rt.rootId=resumed.id;
        if(!rt.modeOn)enterMode(ctx);else {rt.nudges=0;rt.progress=undefined;persistMode();syncBaseline(ctx);}
        const snap=core.statusSnapshot(io);
        ctx.ui.notify(`${resumed.warnings?.length?resumed.warnings.join("\n")+"\n":""}Resumed root ${resumed.id}. ${snap.next}${snap.review?`\n\n${snap.review}`:''}`,'info');
        if(resumed.operation==='prepare' || resumed.operation==='seal' || resumed.operation==='evaluate' || resumed.operation==='block' || resumed.operation==='draft') {
          await withOperation(ctx,undefined,undefined,async operation=>{
            let result;
            if(resumed.operation==='prepare')result=await core.prepareNode(operation,resumed.nodeId);
            else if(resumed.operation==='seal')result=await core.sealNode(operation,resumed.nodeId);
            else if(resumed.operation==='evaluate')result=await core.evaluateNode(operation,resumed.nodeId);
            else if(resumed.operation==='block')result=await core.blockNode(operation,resumed.nodeId,resumed.args);
            else if(resumed.args)result=core.draftNode(operation,resumed.args);
            else return;
            maybeAutoExit(result.cascade??result,ctx);syncBaseline(ctx);
            pi.sendMessage({customType:'exitcode-resume',content:result.review??withWarnings(result.events??[result.ok?result.next??result.vector??'operation completed':errLines(result)],result.warnings).join('\n'),display:true,details:result},
              {triggerTurn:rt.modeOn && core.statusSnapshot(operation).status==='ACTIVE' && !core.statusSnapshot(operation).awaitingApproval});
          });
        }
        return;
      }
      if (rt.modeOn) {
        ctx.ui.notify(`Already in exitcode mode for root ${rt.rootId ?? "unknown"}. /exitcode exit first.`, "warning");
        return;
      }
      const snap = core.statusSnapshot(io);
      if (snap.active) {
        ctx.ui.notify(`Root ${snap.root} is still ${snap.status} on disk. /exitcode resume to re-enter it.`, "warning");
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
