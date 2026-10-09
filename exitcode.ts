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
  recipe: Type.Object({
    kind: Type.Union(core.RECIPE_KINDS.map((x: string) => Type.Literal(x))),
    path: Type.Optional(Type.String()), value: Type.Optional(Type.Unknown()),
    asset: Type.Optional(Type.String({minLength:1,description:"test_asset: file name supplied in the draft assets map; mounted under .exitcode-evaluator/ only in disposable copies"})),
    pointer: Type.Optional(Type.String()), selector: Type.Optional(Type.String({ description: "existing_test: exact discovered literal name already present in the file; never invent a future test name" })),
    command: Type.Optional(Type.String({ description: "command_exit: executable basename (e.g. sh), with args separately; custom_command: isolated shell string (e.g. sh scripts/verify)" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "command_exit arguments; test_asset runner arguments before its appended asset path, e.g. [--test] with command node" })),
  }),
  assets: Type.Optional(Type.Array(Type.String({minLength:1}), {description:"Additional assertion helpers, fixtures, and runner configuration to seal as copies, including helpers for existing_test. Repository versions remain mutable"})),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Immutable explicit check watchdog; otherwise use remaining execution time" })),
  expect: Type.Optional(ExpectSchema),
});

const AssetsSchema = Type.Record(Type.String(), Type.String(), {description:"Contract-owned test/fixture files as bundle-relative name -> UTF-8 content (up to 16 files, 128 KiB total). ExitCode stores and seals them privately; never write .exitcode directly. Use ../src imports from .exitcode-evaluator/; keep durable regression tests in the repository."});

const MutationSchema = Type.Object({
  kind: Type.Union(core.MUTATION_KINDS.map((x: string) => Type.Literal(x))),
  path: Type.String(), content: Type.Optional(Type.String()), from: Type.Optional(Type.String()),
  asset: Type.Optional(Type.String({description:"copy_fixture: authored fixture asset to copy into path; use instead of a candidate-relative from"})),
  to: Type.Optional(Type.String()), pointer: Type.Optional(Type.String()), value: Type.Optional(Type.Unknown()),
});
const FixtureSchema = Type.Object({
  mutations: Type.Array(MutationSchema, {minItems:1,maxItems:32}),
  reason: Type.Optional(Type.String()),
});
const ControlsSchema = Type.Object({
  accept: Type.Optional(FixtureSchema),
  reject: Type.Optional(Type.Array(FixtureSchema, {minItems:1})),
}, {description:"Usually omit. A control is a minimal witness that the check can discriminate, not a reference implementation. " +
  "Built-in file recipes and checks that already pass need none; supply accept only when the check cannot pass on the current candidate. " +
  "Supply reject for behavior the baseline already satisfies; a baseline failure already counts as negative evidence."});

const ReviewCriticSchema = Type.Object({
  concerns: Type.Array(Type.Object({
    code: Type.Union([
      Type.Literal("MISSING_OUTCOME"),
      Type.Literal("OVERREACH"),
      Type.Literal("CONTRADICTION"),
      Type.Literal("BUNDLED_OUTCOME"),
    ]),
    evidence: Type.String(),
  }), {maxItems:3}),
});

// The isolated semantic-critic call gets at most this one response tool.
function reviewTool() {
  return {
    name: core.REVIEW_TOOL_NAME,
    description: "Submit semantic concerns about the intent contract",
    parameters: ReviewCriticSchema,
  };
}

const OutcomeSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Suggested id (supervisor assigns O1..On when omitted)" })),
  requirement: Type.String({ description: "One requested behavior outcome in plain language" }),
});

const SequenceSchema = Type.Array(Type.Object({
  objective: Type.String({ description: "Short plain-language slice objective (max 200 characters)" }),
  verify: Type.Array(Type.String({minLength:1}), {minItems:1, description:"Behavior criterion ids proven by this slice; every behavior appears in exactly one slice"}),
  after: Type.Optional(Type.Array(Type.String({minLength:1}), {description:"Optional prerequisite behavior criterion ids that must appear in earlier slices"})),
}), {minItems:1, maxItems:12, description:"Optional ordered proof slices; array order is the dependency"});

const ExecutionSchema = Type.Array(Type.Object({
  id: Type.String({minLength:1,maxLength:64,description:"Unique slice id, e.g. S1"}),
  objective: Type.String({minLength:1,maxLength:200}),
  verify: Type.Array(Type.String({minLength:1}), {minItems:1,description:"Every behavior criterion belongs to exactly one slice"}),
  after: Type.Optional(Type.Array(Type.String({minLength:1}), {description:"Prerequisite behavior criteria; fresh integrated PASS unlocks this slice regardless of array order"})),
}), {minItems:1,maxItems:12,description:"Root proof DAG. Independent ready slices run concurrently in private Git repositories; cannot combine with legacy sequence"});

const CriterionFields = {
  id: Type.Optional(Type.String({ description: "Suggested id (supervisor assigns C1..Cn when omitted)" })),
  check: CheckSchema,
  controls: Type.Optional(ControlsSchema),
};
const CriterionSchema = Type.Union([
  Type.Object({...CriterionFields,
    type: Type.Optional(Type.Literal("behavior")),
    outcome: Type.String({description:"Declared outcome id this criterion proves; display text comes from that outcome"}),
  }, {additionalProperties:false}),
  Type.Object({...CriterionFields,
    type: Type.Literal("regression"),
    requirement: Type.String({minLength:1,description:"Existing behavior this regression protects"}),
  }, {additionalProperties:false}),
]);

const PolicySchema = Type.Object({
  localRepairs: Type.Optional(Type.Number({ description: "Local repair attempts before ordinary child decomposition is permitted (default 2)" })),
  maxDepth: Type.Optional(Type.Number({ description: "Recursion depth below the root (default 3)" })),
  maxTotalAttempts: Type.Optional(Type.Number({ description: "Implementation attempts across the tree (default 12)" })),
  deadlineMinutes: Type.Optional(Type.Number({ description: "Shared execution minutes from successful root seal (default 60); preparation and human review do not start it" })),
  evalTimeoutSeconds: Type.Optional(Type.Number({ description: "Initial executable preparation watchdog (default 900); execution otherwise uses remaining global time" })),
  evaluatorAttempts: Type.Optional(Type.Number({description:"Substantive construction proposals per node (default 6); infrastructure errors do not spend them"})),
  maxParallelWorkers: Type.Optional(Type.Integer({minimum:1,maximum:12,description:"Root-wide independent worker limit (default 2); time and implementation attempts stay shared"})),
});

const EXITCODE_NAMESPACE = {
  name: "exitcode",
  description: "Tools for contract review, implementation feedback, and recursive verification.",
  instructions: "Follow each tool result's next action.",
};

type Runtime = {
  pi: ExtensionAPI;
  modeOn: boolean;
  rootId: string | undefined;
  pendingGoal: string | undefined;
  handoff: string | undefined;
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

// Best-effort semantic critic. Any failure marks the critic unavailable;
// deterministic E0 continues and the user can still approve.
function reviewIo(ctx: ExtensionContext, signal?: AbortSignal, onProgress?: (progress: any) => void, expectedRootId?: string | null) {
  const usage = { available:false,input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
  return core.makeIo(ctx.cwd, { signal: signal ?? ctx.signal, reviewUsage:usage,onProgress,expectedRootId,workerBackend:core.createPiWorkerBackend(ctx),
    review: async (input: any, options: {signal:AbortSignal}) => {
      if (!ctx.model || !ctx.modelRegistry?.streamSimple) throw new Error("selected review model unavailable");
      const encoded=JSON.stringify(input);
      if(encoded.length>64*1024)throw new Error("review input exceeds bounded critic context");
      const tool=reviewTool();
      const result=await ctx.modelRegistry.streamSimple(ctx.model, {
        systemPrompt:core.reviewPrompt(input.phase),
        messages:[{role:"user",content:encoded,timestamp:Date.now()}],
        tools:[tool],
      }, {maxTokens:core.REVIEW_MAX_TOKENS,signal:options.signal}).result();
      if(result.usage)usage.available=true;
      for(const k of ["input","output","cacheRead","cacheWrite","totalTokens"] as const)
        usage[k]+=result.usage?.[k] ?? 0;
      for(const k of ["input","output","cacheRead","cacheWrite","total"] as const)
        usage.cost[k]+=result.usage?.cost?.[k] ?? 0;
      return core.parseReviewResponse(result);
    },
  });
}

export default function (pi: ExtensionAPI) {
  const rt: Runtime = { pi, modeOn: false, rootId: undefined, pendingGoal: undefined, handoff: undefined, nudges: 0, progress:undefined, operations:new Map() };
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
    pi.appendEntry(core.MODE_ENTRY_TYPE, { on: rt.modeOn, rootId: rt.rootId, pendingGoal: rt.pendingGoal, handoff: rt.handoff });
  };

  // Each unsealed phase keeps its own pre-seal baseline; sealed execution keeps none.
  const syncBaseline = (ctx: ExtensionContext) => {
    if (rt.modeOn) core.ensureBaseline(core.makeIo(ctx.cwd,{expectedRootId:rt.rootId}));
  };

  // "prompt" is the bounded per-turn injection; full evidence is explicit-only.
  const modeStatusText = (io: ReturnType<typeof core.makeIo>, detail: "prompt" | "normal" | "evidence" = "normal") => {
    const snap = core.statusSnapshot(io);
    if(snap.active)return `${rt.rootId!==snap.root?"Session does not own this workspace root. Use /exitcode resume to adopt it explicitly.\n":""}${detail==="prompt"?core.promptStatusText(io):core.statusText(io,{detail})}`;
    if (rt.rootId) {
      const root = core.loadRoot(io, rt.rootId);
      return [
        `exitcode root ${rt.rootId} [${root?.status ?? "MISSING"}]${root?.detachedAt != null ? " (detached; /exitcode resume re-attaches it)" : ""}`,
        "Enforcement remains on. Only a fresh root PASS exits automatically.",
        "Use /exitcode exit to stop without completing the goal; /exitcode <goal> starts fresh.",
      ].join("\n");
    }
    return [
      "exitcode: DISCOVERY (enforcement on)",
      ...(rt.pendingGoal ? [`Root goal: ${rt.pendingGoal}`] : []),
      ...(rt.handoff ? ["", rt.handoff, ""] : []),
      "Inspect with any available tools without changing the candidate. Clarify the goal, then propose its acceptance contract with exitcode_draft.",
    ].join("\n");
  };

  const enterMode = (ctx: ExtensionContext, pendingGoal?: string, handoff?: string) => {
    rt.modeOn = true;
    rt.nudges = 0;rt.progress=undefined;
    if (pendingGoal !== undefined) rt.pendingGoal = pendingGoal;
    rt.handoff = handoff;
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
    rt.handoff = undefined;
    rt.nudges = 0;rt.progress=undefined;
    if(!rt.operations.size)core.releaseBaseline(ctx.cwd);
    persistMode();
    applyExposure();
  };

  // A fresh root PASS is the only terminal state, and the only automatic exit.
  const maybeAutoExit = (result: any, ctx: ExtensionContext) => {
    const terminal = result?.terminal;
    if (terminal?.status !== "PASS") return;
    const io = core.makeIo(ctx.cwd);
    const root = core.loadRoot(io, terminal.root);
    if (root?.status !== "PASS" || core.terminalStale(io, terminal.root).stale) return;
    exitMode(ctx);
    if (ctx.hasUI) ctx.ui.notify(`exitcode: root ${terminal.root} PASS (candidate ${String(terminal.outcome?.candidateDigest ?? "?").slice(0, 12)}). Mode off.`, "success");
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
    // Sealing never completes a goal; it either unlocks execution or pauses.
    const result = await core.sealNode(io, nodeId, { userApproval });
    syncBaseline(ctx);
    if (!result.ok && !result.events) {
      return {...textResult(withWarnings([`seal rejected:`, errLines(result)], result.warnings).join("\n"), result, true),usage:io.reviewUsage};
    }
    const lines = result.sealed
      ? [`sealed ${result.sealed}. baseline: ${result.baseline}`]
      : [...(result.events ?? [])];
    if (result.next) lines.push(`next: ${result.next}`);
    return {...textResult(withWarnings(lines, result.warnings).join("\n"), result,!result.ok),usage:io.reviewUsage};
  });

  const defs: ToolDef[] = [
    {
      name: "exitcode_status",
      label: "Exitcode Status",
      description: "Show the current phase, results, diagnostics, budgets, and next action.",
      promptSnippet: "exitcode_status: phase, results, diagnostics, budgets, next action",
      parameters: Type.Object({
        detail: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("evidence")], { description: "evidence adds the full contract, E0 evidence and metrics; use only for debugging" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        const io = core.makeIo(ctx.cwd);
        const detail = params.detail === "evidence" ? "evidence" : "normal";
        const { evaluatorEvidence, contract, ...snap } = core.statusSnapshot(io) as any;
        return textResult(modeStatusText(io, detail), { ...snap, ...(detail === "evidence" ? { evaluatorEvidence, contract } : {}), modeOn: rt.modeOn, rootId: rt.rootId, pendingGoal: rt.pendingGoal });
      },
    },
    {
      name: "exitcode_draft",
      label: "Exitcode Draft",
      description:
        "Submit the smallest observable acceptance contract: explicit outcomes plus one criterion per outcome. Prefer discovered existing tests; never invent an existing_test selector. " +
        "For new behavior supply contract-owned assets with a test_asset recipe and a minimal positive witness; use the project's runtime and test_suite for regression. " +
        "For independent root slices, supply execution as a complete acyclic proof graph; dependencies name behavior criteria. " +
        "ExitCode validates it before user review; repair returned diagnostics, then present the returned plan and wait for the user's reply.",
      promptSnippet: "exitcode_draft: submit the root contract (goal + outcomes + observable criteria + checks)",
      parameters: Type.Object({
        goal: Type.String({ description: "Goal statement" }),
        originalRequest: Type.Optional(Type.String({ description: "Fallback request only; the /exitcode goal and existing root request take priority" })),
        outcomes: Type.Optional(Type.Array(OutcomeSchema, {description:"Explicit behavior outcomes the user requested; every behavior criterion maps to exactly one"})),
        criteria: Type.Array(CriterionSchema),
        assets: Type.Optional(AssetsSchema),
        sequence: Type.Optional(SequenceSchema),
        execution: Type.Optional(ExecutionSchema),
        assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Resolved product assumptions to show in user review" })),
        exclusions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Out-of-scope work to show in user review" })),
        revise: Type.Optional(Type.String({ description: "Existing DRAFT root id to revise (e.g. G1)" })),
        policy: Type.Optional(PolicySchema),
        specificationPaths: Type.Optional(Type.Array(Type.String({minLength:1}), {description:"Advanced: referenced Markdown plans to include as small critic context"})),
        mutableDependencies: Type.Optional(Type.Boolean({description:"Advanced: the task must change product dependencies; devDependencies and evaluator runtimes stay frozen"})),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => withOperation(ctx,_signal,_onUpdate,async io => {
        assertMode();
        if (rt.rootId && core.statusSnapshot(io).root !== rt.rootId) {
          return textResult(`draft rejected:\n- this session's root ${rt.rootId} no longer owns the workspace; the user re-attaches it with /exitcode resume ${rt.rootId} or starts fresh with /exitcode <goal>`, { ok: false, code: "ROOT_MISMATCH" }, true);
        }
        const result = core.draftNode(io, {
          goal: params.goal,
          originalRequest: rt.pendingGoal ?? params.originalRequest,
          outcomes: params.outcomes,
          criteria: params.criteria,
          assets: params.assets,
          sequence: params.sequence,
          execution: params.execution,
          specificationPaths: params.specificationPaths,
          mutableDependencies: params.mutableDependencies,
          policy: params.policy,
          assumptions: params.assumptions,
          exclusions: params.exclusions,
          revise: params.revise,
        });
        if (!result.ok) return textResult(`draft rejected:\n${errLines(result)}`, result, true);
        rt.rootId = result.rootId;
        rt.pendingGoal = undefined;
        rt.handoff = undefined;
        persistMode();
        syncBaseline(ctx);
        io.expectedRootId=result.rootId;
        const prepared = await core.prepareNode(io,result.id);
        prepared.warnings=[...(result.warnings??[]),...(prepared.warnings??[])];
        syncBaseline(ctx);
        if (!prepared.ok) return {...textResult(withWarnings([`Evaluator preparation needs repair:\n${errLines(prepared)}`],prepared.warnings).join("\n"),prepared,true),usage:io.reviewUsage};
        return {...textResult(withWarnings([prepared.review],result.warnings).join("\n"),prepared),usage:io.reviewUsage};
      }),
    },
    {
      name: "exitcode_seal",
      label: "Exitcode Seal",
      description: "After explicit root approval, seal the exact validated contract. Children seal without separate approval.",
      promptSnippet: "exitcode_seal: seal the approved, validated contract",
      parameters: Type.Object({
        node: Type.String({ description: "Draft node id (e.g. G1, G1.1)" }),
        userApproval: Type.Optional(Type.String({ minLength: 1, description: "Quote the user's reply accepting the current root plan (e.g. 'looks good, go ahead'). A reply requesting changes is not approval: revise and present again; ask when unclear. Omit for children or an already-approved root. Never use the initial goal, silence, or an assistant message." })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        assertMode();
        return sealContract(params.node, ctx, params.userApproval,_signal,_onUpdate);
      },
    },
    {
      name: "exitcode_evaluate",
      label: "Exitcode Evaluate",
      description: "Run the sealed criteria fresh. For an execution DAG, run ready private workers, reconcile their verified candidates, and evaluate the canonical root. Follow failures and the returned next action; only fresh canonical root ALL PASS completes the goal.",
      promptSnippet: "exitcode_evaluate: run the sealed checks fresh",
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
      description: "Create one smaller goal for one failing parent criterion when direct repair is no longer the clearest path.",
      promptSnippet: "exitcode_child: one smaller goal for one failing parent criterion",
      parameters: Type.Object({
        parent: Type.String({ description: "Parent node id (e.g. G1)" }),
        target: Type.String({ description: "Failing parent criterion id (e.g. C2)" }),
        goal: Type.String({ description: "Narrower child goal" }),
        originalRequest: Type.Optional(Type.String({ description: "Retained request (defaults to the parent's)" })),
        outcomes: Type.Optional(Type.Array(OutcomeSchema)),
        criteria: Type.Array(CriterionSchema),
        assets: Type.Optional(AssetsSchema),
        specificationPaths: Type.Optional(Type.Array(Type.String({minLength:1}))),
        reason: Type.String({ description: "How this child advances the parent target" }),
        prerequisite: Type.Optional(Type.Boolean({ description: "Decompose before the local repair threshold; requires prerequisiteArtifact" })),
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
          outcomes: params.outcomes,
          criteria: params.criteria,
          assets: params.assets,
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
      description: "Request input only the user or the external world can provide: a missing requirement decision, credential, authorization, or external action. ExitCode itself handles runner, Git, worker, configuration, and budget problems; repair or retry those instead. Ask the user directly about ambiguity. NO_PATH only withdraws a focused child and reruns its parent.",
      promptSnippet: "exitcode_block: request a user/external prerequisite, or withdraw a child (NO_PATH)",
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
        syncBaseline(ctx);
        return textResult((result.events ?? []).join("\n"), result);
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
    const mode = core.resolveModeFromBranch(ctx.sessionManager.getBranch());
    rt.modeOn = mode.on;
    rt.rootId = mode.rootId;
    rt.nudges = 0;rt.progress=undefined;
    rt.pendingGoal = mode.pendingGoal;
    rt.handoff = mode.handoff;
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
    const lines = [core.PROTOCOL_PROMPT, "", modeStatusText(io, "prompt")];
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
      const hint=rt.rootId?`/exitcode resume ${rt.rootId} switches back`:`/exitcode resume ${snap.root} adopts it`;
      return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:`exitcode: ${snap.root} owns the workspace, not this session. ${hint}, or /exitcode <goal> starts fresh.`,display:true}]};
    }
    if(!baseline.ok) {
      if(ctx.hasUI)ctx.ui.notify(`exitcode: ${baseline.message??errLines(baseline)}`,'warning');
      if(rt.nudges>=core.MAX_SETTLE_NUDGES) {
        // No progress is reported once as a fault, never a user pause; the next user message continues.
        if(rt.nudges++>core.MAX_SETTLE_NUDGES)return undefined;
        const fault=snap.active?core.failNode(io,{reason:'Repeated pre-seal changes made no progress. Inspect the discarded files and continue without modifying the candidate.',code:'NO_PROGRESS',operation:snap.phase==='EXECUTION'?'evaluate':'prepare'}):null;
        syncBaseline(ctx);
        return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:fault?errLines(fault):'exitcode: repeated pre-seal changes were restored. Continue inspection without modifying the candidate.',display:true}]};
      }
      rt.nudges++;
      return {entries:[{type:'custom_message' as const,customType:'exitcode-nudge',content:baseline.message??errLines(baseline),display:true}],continue:true};
    }
    if(!snap.active) {
      const root=rt.rootId?core.loadRoot(io,rt.rootId):null;
      if(root?.status==='PASS')maybeAutoExit({terminal:{root:root.id,status:root.status,outcome:root.outcome}},ctx);
      return undefined;
    }
    if(snap.status==='PAUSED' || snap.awaitingApproval)return undefined;
    const leafId=snap.stack?.at(-1),leaf=leafId?(snap.nodes as any)?.[leafId]:null;
    if(!leaf || !['ACTIVE','DRAFT'].includes(leaf.status))return undefined;
    if(snap.expired) {
      const paused=core.failNode(io,{reason:'shared execution deadline exceeded',code:'BUDGET_EXHAUSTED',operation:leaf.status==='DRAFT'?'prepare':'evaluate'});
      syncBaseline(ctx);
      return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:errLines(paused),display:true}]};
    }
    let candidate;
    try{candidate=core.digestTree(ctx.cwd);}catch(e){core.failNode(io,{reason:e.message,code:e.code??"IO_ERROR",operation:leaf.status==='DRAFT'?'prepare':'evaluate'});return undefined;}
    const progress=JSON.stringify({candidate,phase:snap.phase,stack:snap.stack,attempts:snap.consumedAttempts,vector:leaf.vector,
      intent:snap.intentDigest,evaluator:snap.evaluatorDigest,diagnostics:snap.diagnostics,restored:baseline.restored===true});
    if(progress!==rt.progress){rt.progress=progress;rt.nudges=0;}
    if(rt.nudges>=core.MAX_SETTLE_NUDGES) {
      // Stop nudging and let the turn end; the root stays ACTIVE and the next user message continues it.
      if(rt.nudges++>core.MAX_SETTLE_NUDGES)return undefined;
      const fault=core.failNode(io,{reason:'No observable progress after repeated continuation requests. Inspect the saved diagnostics and change strategy.',code:'NO_PROGRESS',operation:leaf.status==='DRAFT'?'prepare':'evaluate'});
      syncBaseline(ctx);
      return {entries:[{type:'custom_message' as const,customType:'exitcode-pause',content:errLines(fault),display:true}]};
    }
    rt.nudges++;
    const content=baseline.ok ? `exitcode: ${leafId} remains ${leaf.status} :: ${leaf.vector}. next: ${snap.next}` : baseline.message??errLines(baseline);
    return {entries:[{type:'custom_message' as const,customType:'exitcode-nudge',content,display:true}],continue:true};
  });

  // --- /exitcode command: the only user entry to the loop -------------------

  const usage = () =>
    [
      "exitcode: contract-first recursive execution.",
      "/exitcode <goal>  start a fresh root for this goal; an unfinished root is detached, not deleted",
      "/exitcode approve optional shortcut to approve the root draft and start autonomous work",
      "/exitcode status [evidence]  show the active contract, vectors, and budgets, or resumable roots (evidence adds full E0 evidence)",
      "/exitcode resume [Gid] [minutes=N] [attempts=N] [evaluators=N]  continue a detached or paused root (default: the owner, else the latest detached); grants require this user command",
      "/exitcode exit    stop and detach the current root; not successful completion (all work and contracts are preserved)",
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
        const detail = text.split(/\s+/)[1] === "evidence" ? "evidence" : "normal";
        ctx.ui.notify(rt.modeOn ? modeStatusText(io, detail) : `exitcode mode is off.\n${core.statusText(io, { detail })}`, "info");
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
        const rootId=rt.rootId;
        exitMode(ctx);
        await Promise.all(rt.operations.values());
        // Only this session's own root is detached; another session's root keeps its ownership.
        const detached=core.detachRoot(core.makeIo(ctx.cwd,{expectedRootId:rootId??null}),{reason:"user exit"});
        ctx.ui.notify(`Exited exitcode mode without completing the goal.${detached.detached?` Root ${detached.detached} is detached with all its work preserved; /exitcode resume ${detached.detached} continues it.`:""}`, "info");
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
        // Owner first, then this session's own unfinished root, then the core's latest detached root.
        if(!options.rootId)options.rootId=core.loadIndex(ctx.cwd).activeRootId??(core.resumableRoots(io).some((r:any)=>r.id===rt.rootId)?rt.rootId:undefined);
        const resumed=core.resumeRoot(io,options);
        if(!resumed.ok){ctx.ui.notify(`resume rejected:\n${errLines(resumed)}`,'warning');return;}
        rt.rootId=resumed.id;rt.pendingGoal=undefined;rt.handoff=undefined;
        if(!rt.modeOn)enterMode(ctx);else {rt.nudges=0;rt.progress=undefined;persistMode();syncBaseline(ctx);}
        const snap=core.statusSnapshot(io);
        const notes=[...(resumed.warnings??[]),...(resumed.switchedFrom?[`Detached ${resumed.switchedFrom}; its work is preserved.`]:[]),...(resumed.reconciled??[]).map((r:string)=>`Reconciled with the current workspace: ${r}`)];
        ctx.ui.notify(`${notes.length?notes.join("\n")+"\n":""}Resumed root ${resumed.id}. ${snap.next}${snap.review?`\n\n${snap.review}`:''}`,'info');
        if(resumed.retry) {
          await withOperation(ctx,undefined,undefined,async operation=>{
            let result;
            if(resumed.operation==='evaluate')result=await core.evaluateNode(operation,resumed.nodeId);
            else if(resumed.operation==='block')result=await core.blockNode(operation,resumed.nodeId,resumed.args);
            else return;
            maybeAutoExit(result.cascade??result,ctx);syncBaseline(ctx);
            pi.sendMessage({customType:'exitcode-resume',content:result.review??withWarnings(result.events??[result.ok?result.next??result.vector??'operation completed':errLines(result)],result.warnings).join('\n'),display:true,details:result},
              {triggerTurn:rt.modeOn && core.statusSnapshot(operation).status==='ACTIVE' && !core.statusSnapshot(operation).awaitingApproval});
          });
        } else if(!snap.awaitingApproval) {
          pi.sendMessage({customType:'exitcode-resume',content:`Resumed root ${resumed.id}. ${snap.next}`,display:true,details:resumed},{triggerTurn:true});
        }
        return;
      }
      // /exitcode <goal> always starts a fresh root. The explicit request is the
      // authority to detach an unfinished owner; only a live operation prevents it.
      if (rt.modeOn) {
        for(const operation of rt.operations.keys())operation.abort();
        await Promise.all(rt.operations.values());
      }
      const detached = core.detachRoot(io, { reason: `new goal: ${text.slice(0, 200)}` });
      if (!detached.ok) {
        ctx.ui.notify(`Cannot start a new goal yet:\n${errLines(detached)}`, "warning");
        return;
      }
      if (rt.modeOn) exitMode(ctx);
      enterMode(ctx, text, detached.summary ? core.handoffText(detached.summary) : undefined);
      if (detached.detached) ctx.ui.notify(`Detached unfinished root ${detached.detached}; /exitcode resume ${detached.detached} continues it later.`, "info");
      ctx.ui.notify(`Entered exitcode mode. Read-only discovery and contract review for: ${text}`, "info");
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
      } else {
        ctx.ui.notify("Agent is busy; the goal is queued in the exitcode prompt section.", "warning");
      }
    },
  });
}
