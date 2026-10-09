/** Thin Pi adapter. Pi owns tools, project instructions, compaction, and delegation. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as core from "./exitcode-core.mjs";

const Namespace = { name: "exitcode", description: "Reusable project validation and sealed scenario acceptance" };
const Assertion = Type.Object({ path: Type.String(), op: Type.Union(["eq", "lte", "gte", "contains", "present"].map(value => Type.Literal(value))), value: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
const Scenario = Type.Object({
  id: Type.String(), description: Type.String(), instructions: Type.String(), input: Type.Unknown(),
  baseline: Type.Union([Type.Literal("FAIL"), Type.Literal("PASS")]), trials: Type.Integer({ minimum: 1, maximum: 20 }),
  timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), assertions: Type.Array(Assertion, { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });
const Manifest = Type.Object({
  protocol: Type.Literal(1), name: Type.String(), command: Type.Object({ program: Type.String(), args: Type.Array(Type.String()) }, { additionalProperties: false }),
  timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), environment: Type.Array(Type.String()),
  isolation: Type.Union([Type.Literal("workspace"), Type.Literal("bubblewrap")]),
}, { additionalProperties: false });

function result(value: any) {
  const failures = value.run?.results?.flatMap((trial: any) => trial.assertions?.filter((assertion: any) => assertion.status === "FAIL")
    .map((assertion: any) => `${trial.scenario} trial ${trial.trial}: ${assertion.path} ${assertion.op} ${JSON.stringify(assertion.value)?.slice(0, 300) ?? ""}; observed ${JSON.stringify(assertion.actual)?.slice(0, 500)}`) ?? []) ?? [];
  const text = value.inspection ? `Read-only ${value.inspection.kind} evidence. This does not run acceptance or complete the task.\n${value.inspection.text}\n${value.inspection.nextOffset === null ? "End of evidence." : `Continue inspection at offset ${value.inspection.nextOffset}.`}`
    : value.review ?? (value.ok ? [value.status ?? value.phase ?? "OK", value.run && `Evidence ${value.run.id}`, ...failures.slice(0, 16),
    failures.length > 16 && `${failures.length - 16} more failed assertions are retained in the run record.`, value.next].filter(Boolean).join("\n") : `${value.code}: ${value.message}${value.runId ? `\nEvidence ${value.runId}` : ""}`);
  return { content: [{ type: "text" as const, text }], details: value, ...(value.ok ? {} : { isError: true }) };
}

export default function (pi: ExtensionAPI) {
  let enabled = false, taskId: string | undefined, nudges = 0, previousProgress = "";
  const operations = new Map<AbortController, Promise<void>>();
  const controller = (ctx: ExtensionContext, signal?: AbortSignal, update?: any) => {
    const cancellation = new AbortController(), parent = signal ?? ctx.signal;
    const abort = () => cancellation.abort(parent?.reason);
    if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    operations.set(cancellation, done);
    return {
      supervisor: new core.ExitCode(ctx.cwd, { expectedTask: taskId ?? null, signal: cancellation.signal, progress: (value: any) => {
        if (typeof update === "function") update(result({ ok: true, next: `${value.operation}${value.scenario ? ` ${value.scenario}` : ""}` }));
      } }),
      dispose() { parent?.removeEventListener("abort", abort); operations.delete(cancellation); finish(); },
    };
  };
  const persist = () => pi.appendEntry(core.MODE_ENTRY, { enabled, taskId });
  const exposure = () => {
    for (const definition of definitions) pi.registerTool({ ...definition, exposure: enabled ? "direct" : "hidden", namespace: Namespace } as any);
    const active = pi.getActiveTools().filter(name => !core.TOOL_NAMES.includes(name));
    pi.setActiveTools(enabled ? [...active, ...core.TOOL_NAMES] : active);
  };
  const enable = (id: string) => { enabled = true; taskId = id; nudges = 0; previousProgress = ""; persist(); exposure(); };
  const disable = () => { enabled = false; taskId = undefined; nudges = 0; previousProgress = ""; persist(); exposure(); };
  const notify = (ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, kind);
  const execute = async (ctx: ExtensionContext, signal: AbortSignal | undefined, update: any, work: (supervisor: any) => Promise<any>) => {
    if (!enabled) return result({ ok: false, code: "MODE_OFF", message: "Enter with /exitcode <problem>." });
    const operation = controller(ctx, signal, update);
    try {
      const value = await work(operation.supervisor);
      if (value.status === "PASS" && value.phase === "PASS") {
        if (operation.supervisor.freshPass(taskId)) { disable(); notify(ctx, `ExitCode PASS for ${value.task}.`); }
        else return result({ ok: false, code: "STALE_PASS", message: "Product changed after evaluation; that result cannot complete this workspace." });
      }
      return result(value);
    } catch (error: any) { return result({ ok: false, code: error.code ?? "IO_ERROR", message: error.message }); }
    finally { operation.dispose(); }
  };

  const definitions = [
    {
      name: "exitcode_project", label: "ExitCode project",
      description: "Bootstrap or refresh reusable project validation. Investigate with normal tools first. Supply infrastructure and driver files, never an implementation of the requested fix. Reuse existing definitions when sufficient. Protocol operations: prepare, run, dispose; run returns observations and artifacts. Workspace mode is a trusted host process; bubblewrap is offline and fails closed. This tool is available only before approval.",
      parameters: Type.Object({ manifest: Manifest, files: Type.Record(Type.String(), Type.String()), refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      execute: async (_id: string, params: any, signal: AbortSignal, update: any, ctx: ExtensionContext) => execute(ctx, signal, update,
        supervisor => supervisor.configure({ manifest: params.manifest, files: params.files }, { refresh: params.refresh === true })),
    },
    {
      name: "exitcode_contract", label: "ExitCode contract",
      description: "Define the current problem, happy path, constraints, and scenario observations. Do not prescribe implementation or construct a passing solution witness. Baseline FAIL reproduces the issue; baseline PASS protects existing behavior. Every requested trial must pass after sealing. This prepares actual baseline and empty-target evidence and presents the exact acceptance for user approval.",
      parameters: Type.Object({ version: Type.Literal(1), problem: Type.String(), happyPath: Type.String(), constraints: Type.Array(Type.String()),
        scenarios: Type.Array(Scenario, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false }),
      execute: async (_id: string, params: any, signal: AbortSignal, update: any, ctx: ExtensionContext) => execute(ctx, signal, update, supervisor => supervisor.draft(params)),
    },
    {
      name: "exitcode_evaluate", label: "ExitCode evaluate",
      description: "With no arguments, run sealed acceptance fresh against the current product in disposable copies. Use when a candidate is plausibly ready. Only fresh PASS completes the task. Supply inspect to read the fixed contract, full run observations, or work notes without rerunning anything; runId selects an older run and offset paginates long evidence. Historical evidence never completes the task.",
      parameters: Type.Object({ inspect: Type.Optional(Type.Union(["contract", "run", "notes"].map(value => Type.Literal(value)))), runId: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
      execute: async (_id: string, params: any, signal: AbortSignal, update: any, ctx: ExtensionContext) => execute(ctx, signal, update, async supervisor => params.inspect
        ? supervisor.inspect(params.inspect, { runId: params.runId, offset: params.offset }) : params.runId !== undefined || params.offset !== undefined
          ? { ok: false, code: "INVALID_SPEC", message: "runId and offset require inspect." } : supervisor.evaluate()),
    },
    {
      name: "exitcode_note", label: "ExitCode note",
      description: "Save a short hypothesis, attempted change, result, and next experiment at meaningful strategy changes. Reference known run IDs as evidence; your interpretation is not a runner observation. Disposition records your decision and never rolls files back. Set waitingFor only when the user or external world must supply something; their next input releases the wait.",
      parameters: Type.Object({ hypothesis: Type.String(), change: Type.String(), result: Type.String(),
        disposition: Type.Union([Type.Literal("keep"), Type.Literal("revert"), Type.Literal("unresolved")]), next: Type.String(), evidence: Type.Array(Type.String(), { maxItems: 16 }),
        waitingFor: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id: string, params: any, signal: AbortSignal, update: any, ctx: ExtensionContext) => execute(ctx, signal, update, supervisor => supervisor.note(params)),
    },
  ];
  // Only registration is legal during factory loading; session APIs are used after session_start.
  for (const definition of definitions) pi.registerTool({ ...definition, exposure: "hidden", namespace: Namespace } as any);

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const last = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === core.MODE_ENTRY) as any;
    enabled = last?.data.enabled === true; taskId = last?.data.taskId; nudges = 0; previousProgress = ""; exposure();
    if (enabled) {
      const supervisor = new core.ExitCode(ctx.cwd);
      const status = supervisor.status(taskId);
      if (status.phase === "PASS" && supervisor.freshPass(taskId)) disable();
    }
  });
  pi.on("session_shutdown", async () => {
    for (const operation of operations.keys()) operation.abort();
    await Promise.all(operations.values());
  });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      nudges = 0; previousProgress = "";
      if (enabled && new core.ExitCode(ctx.cwd).status(taskId).waitingFor) await new core.ExitCode(ctx.cwd, { expectedTask: taskId }).wake();
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled) { delete event.systemPromptOptions.sections["exitcode"]; return; }
    const status = new core.ExitCode(ctx.cwd).status(taskId);
    event.systemPromptOptions.sections["exitcode"] = `${core.PROTOCOL}\n\n${core.promptStatus(status)}${status.active ? "" : "\nThis session does not own an active task. Resume explicitly before acting."}`;
  });
  pi.on("tool_call", (event, ctx) => {
    if (!enabled || core.TOOL_NAMES.includes(event.toolName)) return;
    const input = (event as any).input ?? {}, file = typeof input.path === "string" ? path.resolve(ctx.cwd, input.path) : null;
    const store = path.join(ctx.cwd, ".exitcode", "state"), project = path.join(ctx.cwd, ".exitcode", "project");
    if (file && (file === store || file.startsWith(store + path.sep))) return { block: true, reason: "Supervisor state and sealed evidence are private. Use ExitCode tools or /exitcode status." };
    if (event.toolName === "bash" && String(input.command ?? "").replaceAll(".exitcode/project", "project").includes(".exitcode"))
      return { block: true, reason: "Do not access supervisor state through shell commands." };
    const status = new core.ExitCode(ctx.cwd).status(taskId);
    if (!status.active) return { block: true, reason: "This session does not own the active task. Use /exitcode resume." };
    if (["write", "edit"].includes(event.toolName) && file && ["DISCOVERY", "READY"].includes(status.phase)
      && file.startsWith(ctx.cwd + path.sep) && !(file === project || file.startsWith(project + path.sep)))
      return { block: true, reason: "Product files stay unchanged before approval. Build validation through exitcode_project." };
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!enabled) return;
    const supervisor = new core.ExitCode(ctx.cwd, { expectedTask: taskId, signal: ctx.signal }), status = supervisor.status(taskId);
    if (!status.active || status.waitingFor) return;
    const audit = await supervisor.audit();
    const current = supervisor.status(taskId);
    if (current.phase === "READY" && audit.ok) return;
    const progress = JSON.stringify({ phase: current.phase, candidate: audit.candidateDigest, run: current.lastRun?.id, note: current.lastNote?.at, issue: current.lastIssue?.code });
    if (progress !== previousProgress) { previousProgress = progress; nudges = 0; }
    if (nudges++ >= 2) return; // Native session remains authoritative; no decomposition or forced strategy loop.
    return { entries: [{ type: "custom_message" as const, customType: "exitcode-continuation", content: audit.ok
      ? `${core.promptStatus(current)}\nContinue toward the goal, or record the external input you need.` : `${audit.code}: ${audit.message}`, display: true }], continue: true };
  });

  const usage = "/exitcode <problem> | approve | status [evidence] | resume [taskId] | exit";
  pi.registerCommand("exitcode", {
    description: "Start a problem-first task with reusable validation and fixed acceptance",
    handler: async (args, ctx) => {
      const text = args.trim(), [command, argument, extra] = text.split(/\s+/);
      if (!text || text === "help") { notify(ctx, usage); return; }
      if (command === "status") {
        if (argument && argument !== "evidence" || extra) { notify(ctx, usage, "warning"); return; }
        const status = new core.ExitCode(ctx.cwd).status(taskId, argument === "evidence");
        notify(ctx, argument === "evidence" ? JSON.stringify(status, null, 2) : core.promptStatus(status)); return;
      }
      if (command === "exit" && !argument) {
        for (const operation of operations.keys()) operation.abort();
        await Promise.all(operations.values());
        const value = await new core.ExitCode(ctx.cwd, { expectedTask: taskId ?? null }).detach();
        disable(); notify(ctx, value.next ?? value.message); return;
      }
      if (!ctx.isIdle()) { notify(ctx, "Finish or cancel the active agent run before changing task ownership or approving.", "warning"); return; }
      if (command === "approve") {
        if (argument || !enabled) { notify(ctx, enabled ? usage : "Resume the task before approving.", "warning"); return; }
        const value = (await execute(ctx, undefined, undefined, supervisor => supervisor.approve())).details;
        if (!value.ok) { notify(ctx, `${value.code}: ${value.message}`, "warning"); return; }
        nudges = 0; previousProgress = "";
        pi.sendMessage({ customType: "exitcode-approval", content: `User approved task ${value.task}. ${value.next}`, display: true, details: value }, { triggerTurn: true }); return;
      }
      if (command === "resume") {
        if (extra) { notify(ctx, usage, "warning"); return; }
        const value = await new core.ExitCode(ctx.cwd).resume(argument);
        if (!value.ok) { notify(ctx, `${value.code}: ${value.message}`, "warning"); return; }
        enable(value.task);
        pi.sendMessage({ customType: "exitcode-resume", content: value.next, display: true, details: value }, { triggerTurn: true }); return;
      }
      if (["exit", "help"].includes(command)) { notify(ctx, usage, "warning"); return; }
      const value = await new core.ExitCode(ctx.cwd).start(text);
      if (!value.ok) { notify(ctx, `${value.code}: ${value.message}`, "warning"); return; }
      enable(value.task); pi.sendUserMessage(text);
    },
  });
}
