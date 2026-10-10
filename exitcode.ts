/** Thin Pi adapter. Pi owns tools, project instructions, compaction, and delegation. */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "./exitcode-core.mjs";
import { DEFAULT_CONFIG, loadConfig } from "./exitcode-config.mjs";
import { resolveStoreDir } from "./exitcode-files.mjs";
import { MAX_HAPPY_PATH_CLAIMS, ASSERTION_PATH_PATTERN, MAX_ASSERTION_PATH_LENGTH } from "./exitcode-spec.mjs";

const Namespace = { name: "exitcode", description: "Reusable project validation and sealed scenario acceptance" };
const Assertion = Type.Object({ path: Type.String({ pattern: ASSERTION_PATH_PATTERN, maxLength: MAX_ASSERTION_PATH_LENGTH, description: "JSON pointer relative to the contents of observations, e.g. /retrieval/found. Do not use dotted paths or prepend /observations." }), op: Type.Union(["eq", "lte", "gte", "contains", "present"].map(value => Type.Literal(value))), value: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
const HappyPathClaim = Type.Object({ id: Type.String(), claim: Type.String() }, { additionalProperties: false });
const Scenario = Type.Object({
  id: Type.String(), covers: Type.Array(Type.String(), { maxItems: MAX_HAPPY_PATH_CLAIMS }),
  description: Type.String(), instructions: Type.String(), input: Type.Unknown(),
  baseline: Type.Union([Type.Literal("FAIL"), Type.Literal("PASS")]), trials: Type.Integer({ minimum: 1, maximum: 20 }),
  timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), assertions: Type.Array(Assertion, { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });
const Manifest = Type.Object({
  protocol: Type.Literal(1), name: Type.String(), command: Type.Object({ program: Type.String(), args: Type.Array(Type.String(), { description: "Relative command arguments resolve under projectDirectory (the stored driver files), not the product root." }) }, { additionalProperties: false }),
  timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), environment: Type.Array(Type.String(), { maxItems: 32, description: "Additional safe environment variable names. Start with []. PATH, HOME and TMPDIR are runner-owned; process-control variables are forbidden." }),
  isolation: Type.Union([Type.Literal("workspace"), Type.Literal("bubblewrap")]),
}, { additionalProperties: false });

const recoveryErrors = new Set(["INVALID_SPEC", "INVALID_REPORT", "INVALID_OBSERVATION", "TREE_TOO_LARGE", "CANDIDATE_CHANGED",
  "TARGET_UNAVAILABLE", "RUNNER_ERROR", "DRIVER_TIMEOUT", "ENVIRONMENT_UNAVAILABLE", "ENVIRONMENT_CHANGED", "EVALUATOR_CHANGED", "CLEANUP_FAILED", "ISOLATION_UNAVAILABLE"]);
function result(value: any) {
  const failures = value.run?.results?.flatMap((trial: any) => trial.assertions?.filter((assertion: any) => assertion.status === "FAIL")
    .map((assertion: any) => `${trial.scenario} trial ${trial.trial}: ${assertion.path} ${assertion.op} ${JSON.stringify(assertion.value)?.slice(0, 300) ?? ""}; observed ${JSON.stringify(assertion.actual)?.slice(0, 500)}`) ?? []) ?? [];
  const text = value.inspection ? `Read-only ${value.inspection.kind} evidence${value.inspection.runId ? ` (${value.inspection.runId})` : ""}. This does not run acceptance or complete the task.\n${value.inspection.text}\n${value.inspection.nextOffset === null ? "End of evidence." : `Continue inspection at offset ${value.inspection.nextOffset}.`}`
    : value.review ?? (value.ok ? [value.status ?? value.phase ?? "OK", value.run && `Evidence ${value.run.id}`, ...failures.slice(0, 16),
    failures.length > 16 && `${failures.length - 16} more failed assertions are retained in the run record.`,
    value.projectDirectory && `Project files: ${value.projectDirectory}`,
    value.references && `Format examples: ${value.references.driver} and ${value.references.contract}\nRecovery reference: ${value.references.recovery}`, value.next].filter(Boolean).join("\n")
    : [`${value.code}: ${value.message}`, value.stage && `Stage: ${value.stage}${value.scenario ? `; scenario ${value.scenario}, trial ${value.trial}` : ""}`,
      value.runId && `Evidence ${value.runId}; read with exitcode_evaluate({inspect:"run",runId:"${value.runId}"}).`,
      recoveryErrors.has(value.code) && `Read the recovery reference: ${core.AGENT_REFERENCES.recovery}`].filter(Boolean).join("\n"));
  return { content: [{ type: "text" as const, text }], details: value, ...(value.ok ? {} : { isError: true }) };
}

const contains = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
// Resolve aliases to existing ancestors, including targets that do not yet exist.
function resolvedFile(file: string): string {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat) return fs.realpathSync(file);
  const parent = path.dirname(file);
  return parent === file ? file : path.join(resolvedFile(parent), path.basename(file));
}

export default function (pi: ExtensionAPI) {
  let enabled = false, taskId: string | undefined, taskStoreDir: string | undefined, nudges = 0, previousProgress = "";
  let config = { ...DEFAULT_CONFIG }, configSources: any, configIssue: { code: string; message: string } | undefined;
  const operations = new Map<AbortController, Promise<void>>();
  const storeDir = () => taskStoreDir ?? config.storeDir;
  const supervisor = (ctx: ExtensionContext, options: any = {}) => new core.ExitCode(ctx.cwd, { storeDir: storeDir(), ...options });
  const notify = (ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, kind);
  const resetNudges = () => { nudges = 0; previousProgress = ""; };
  const updateStatus = (ctx: ExtensionContext, status?: any, progress?: any) => {
    if (ctx.mode !== "tui") return;
    if (!enabled || !config.showStatus) { ctx.ui.setStatus("exitcode", undefined); return; }
    const current = status ?? supervisor(ctx).status(taskId);
    const phase = current.ok ? current.phase ?? "OFF" : current.code;
    const detail = progress ? [progress.operation, progress.scenario].filter(Boolean).join(" ")
      : current.waitingFor ? "waiting" : current.phase === "READY" ? "approve" : current.lastIssue?.code ?? current.lastRun?.status;
    ctx.ui.setStatus("exitcode", `ExitCode ${[phase, detail].filter(Boolean).join(" | ")}`);
  };
  const controller = (ctx: ExtensionContext, signal?: AbortSignal, update?: any) => {
    const cancellation = new AbortController(), parent = signal ?? ctx.signal;
    const abort = () => cancellation.abort(parent?.reason);
    if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    operations.set(cancellation, done);
    return {
      supervisor: supervisor(ctx, { expectedTask: taskId ?? null, signal: cancellation.signal, progress: (value: any) => {
        updateStatus(ctx, undefined, value);
        if (typeof update === "function") update(result({ ok: true, next: `${value.operation}${value.scenario ? ` ${value.scenario}` : ""}` }));
      } }),
      dispose() { parent?.removeEventListener("abort", abort); operations.delete(cancellation); finish(); },
    };
  };
  // Custom-message wakeups bypass before_agent_start in Pi. Keep the acknowledgement,
  // then use the native prompt entry so per-run sections survive subsequent tool rounds.
  const continueTask = (customType: string, content: string, value: any) => {
    pi.sendMessage({ customType, content, display: true, details: value }, { triggerTurn: false });
    pi.sendUserMessage(value.next);
  };
  const persist = () => pi.appendEntry(core.MODE_ENTRY, { enabled, taskId, storeDir: taskStoreDir });
  const exposure = () => {
    for (const definition of definitions) pi.registerTool({ ...definition, exposure: enabled ? "direct" : "hidden", namespace: Namespace } as any);
    const active = pi.getActiveTools().filter(name => !core.TOOL_NAMES.includes(name));
    pi.setActiveTools(enabled ? [...active, ...core.TOOL_NAMES] : active);
  };
  const enable = (id: string, directory: string, ctx: ExtensionContext) => { enabled = true; taskId = id; taskStoreDir = directory; resetNudges(); persist(); exposure(); updateStatus(ctx); };
  const disable = (ctx: ExtensionContext) => { enabled = false; taskId = undefined; taskStoreDir = undefined; resetNudges(); persist(); exposure(); updateStatus(ctx); };
  const execute = async (ctx: ExtensionContext, signal: AbortSignal | undefined, update: any, work: (supervisor: any) => Promise<any>) => {
    if (!enabled) return result({ ok: false, code: "MODE_OFF", message: "Enter with /exitcode <problem>." });
    const operation = controller(ctx, signal, update);
    try {
      const value = await work(operation.supervisor);
      if (value.status === "PASS" && value.phase === "PASS") {
        if (operation.supervisor.freshPass(taskId)) { disable(ctx); notify(ctx, `ExitCode PASS for ${value.task}.`); }
        else return result({ ok: false, code: "STALE_PASS", message: "Product changed after evaluation; that result cannot complete this workspace." });
      }
      return result(value);
    } catch (error: any) { return result({ ok: false, code: error.code ?? "IO_ERROR", message: error.message }); }
    finally { operation.dispose(); updateStatus(ctx); }
  };

  const definitions = [
    {
      name: "exitcode_project", label: "ExitCode project",
      description: "Bootstrap or refresh reusable project validation. Investigate with normal tools first. Supply infrastructure and driver files, never an implementation of the requested fix. Reuse existing definitions when sufficient. Protocol operations: prepare, run, dispose. Stdout must be one protocol: 1 JSON response with status OK, UNAVAILABLE or ERROR; run returns observations and artifacts, not PASS/FAIL. Registration returns public driver and format-reference paths. Workspace mode is a trusted host process; bubblewrap is offline and fails closed. This tool is available only before approval.",
      parameters: Type.Object({ manifest: Manifest, files: Type.Record(Type.String(), Type.String(), { description: "UTF-8 driver files keyed relative to the stored project/files directory, not the product root. Use driver.mjs (or driver.py) and the matching command argument." }), refresh: Type.Optional(Type.Boolean({ description: "Refresh environment preparation only. This does not adopt changed product bytes; explicit user resume is required for that." })) }, { additionalProperties: false }),
      execute: async (_id: string, params: any, signal: AbortSignal, update: any, ctx: ExtensionContext) => execute(ctx, signal, update,
        supervisor => supervisor.configure({ manifest: params.manifest, files: params.files }, { refresh: params.refresh === true })),
    },
    {
      name: "exitcode_contract", label: "ExitCode contract",
      description: `Define the current problem, 1 to ${MAX_HAPPY_PATH_CLAIMS} happy-path claims, constraints, and scenario observations. Split only independently observable user outcomes, not implementation steps. Give each claim a unique id and map it to at least one scenario using covers; reference only declared claim IDs. One scenario may cover several claims. Guardrail-only scenarios may use covers: []. Do not prescribe implementation or construct a passing solution witness. Baseline FAIL reproduces the issue; baseline PASS protects existing behavior. Every requested trial must pass after sealing. This prepares actual baseline and empty-target evidence and presents the exact acceptance for user approval.`,
      parameters: Type.Object({ version: Type.Literal(1), problem: Type.String(), happyPath: Type.Array(HappyPathClaim, { minItems: 1, maxItems: MAX_HAPPY_PATH_CLAIMS }), constraints: Type.Array(Type.String()),
        scenarios: Type.Array(Scenario, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false }),
      execute: async (_id: string, params: any, signal: AbortSignal, update: any, ctx: ExtensionContext) => execute(ctx, signal, update, supervisor => supervisor.draft(params)),
    },
    {
      name: "exitcode_evaluate", label: "ExitCode evaluate",
      description: "With no arguments, run sealed acceptance fresh against the current product in disposable copies. Use when a candidate is plausibly ready. Only fresh PASS completes the task. Supply inspect to read the fixed contract, full run observations, or work notes without rerunning anything; runId selects any returned setup/run ID and offset paginates long evidence. Without an ID, inspect reads the latest retained evidence, including errors. Historical evidence never completes the task.",
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
    configIssue = undefined;
    try {
      const loaded = loadConfig(ctx.cwd, { agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
      config = { ...loaded.settings }; configSources = loaded.sources;
    } catch (error: any) {
      configIssue = { code: error.code ?? "INVALID_CONFIG", message: error.message };
      notify(ctx, `${configIssue.code}: ${configIssue.message}`, "error");
    }
    const entries = ctx.sessionManager.getBranch();
    const last = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === core.MODE_ENTRY) as any;
    enabled = last?.data.enabled === true; taskId = last?.data.taskId;
    taskStoreDir = enabled ? last?.data.storeDir ?? ".exitcode" : undefined;
    resetNudges(); exposure();
    if (enabled) {
      const owner = supervisor(ctx), status = owner.status(taskId);
      if (status.phase === "PASS" && owner.freshPass(taskId)) disable(ctx);
    }
    updateStatus(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    for (const operation of operations.keys()) operation.abort();
    await Promise.all(operations.values());
    if (ctx.mode === "tui") ctx.ui.setStatus("exitcode", undefined);
  });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      resetNudges();
      if (enabled && supervisor(ctx).status(taskId).waitingFor) await supervisor(ctx, { expectedTask: taskId }).wake();
      updateStatus(ctx);
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled) { delete event.systemPromptOptions.sections["exitcode"]; return; }
    const status = supervisor(ctx).status(taskId);
    event.systemPromptOptions.sections["exitcode"] = `${core.PROTOCOL}\n\n${core.promptStatus(status)}${status.active ? "" : "\nThis session does not own an active task. Resume explicitly before acting."}`;
    updateStatus(ctx, status);
  });
  pi.on("tool_call", (event, ctx) => {
    if (!enabled || core.TOOL_NAMES.includes(event.toolName)) return;
    try {
      const cwd = fs.realpathSync(ctx.cwd), base = resolveStoreDir(cwd, storeDir());
      const input = (event as any).input ?? {}, lexical = typeof input.path === "string" ? path.resolve(cwd, input.path) : null;
      const file = lexical ? resolvedFile(lexical) : null, state = path.join(base, "state"), project = path.join(base, "project");
      if (file && (contains(state, file) || contains(state, lexical!) || file === base
        || (["write", "edit"].includes(event.toolName) && contains(file, state))))
        return { block: true, reason: "Supervisor state and sealed evidence are private. Use ExitCode tools or /exitcode status." };
      // A best-effort shell guard, not an adversarial sandbox. Only explicit project paths are public.
      if (event.toolName === "bash") {
        let command = String(input.command ?? "");
        const roots = [base, storeDir()].sort((a, b) => b.length - a.length);
        const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const mentionsStore = (value: string) => roots.some(root => new RegExp(`${escape(root)}(?=$|[\\s/'\";()<>])`).test(value));
        if (command.includes("..") && mentionsStore(command))
          return { block: true, reason: "Use explicit project paths without traversal; supervisor state is private." };
        for (const root of roots) command = command.replace(new RegExp(`${escape(root)}/project(?=$|[\\s/'\"])`, "g"), "project");
        if (mentionsStore(command)) return { block: true, reason: "Do not access supervisor state through shell commands. Use ExitCode tools or /exitcode status." };
      }
      const status = supervisor(ctx).status(taskId);
      if (!status.active) return { block: true, reason: "This session does not own the active task. Use /exitcode resume." };
      if (["write", "edit"].includes(event.toolName) && file && ["DISCOVERY", "READY"].includes(status.phase)
        && (contains(cwd, file) || contains(cwd, lexical!)) && !contains(project, file))
        return { block: true, reason: "Product files stay unchanged before approval. Build validation through exitcode_project." };
    } catch (error: any) { return { block: true, reason: `${error.code ?? "UNSAFE_PATH"}: ${error.message}` }; }
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!enabled) return;
    const owner = supervisor(ctx, { expectedTask: taskId, signal: ctx.signal }), status = owner.status(taskId);
    if (!status.active || status.waitingFor) return;
    const audit = await owner.audit(), current = owner.status(taskId);
    updateStatus(ctx, current);
    if ((current.phase === "READY" && audit.ok) || configIssue) return;
    const progress = JSON.stringify({ phase: current.phase, candidate: audit.candidateDigest, run: current.lastRun?.id, note: current.lastNote?.at, issue: current.lastIssue?.code });
    if (progress !== previousProgress) { previousProgress = progress; nudges = 0; }
    if (nudges >= config.maxNudges) return; // Native session remains authoritative; no forced strategy loop.
    nudges++;
    return { entries: [{ type: "custom_message" as const, customType: "exitcode-continuation", content: audit.ok
      ? `${core.promptStatus(current)}\nContinue toward the goal, or record the external input you need.` : `${audit.code}: ${audit.message}`, display: true }], continue: true };
  });

  const usage = "/exitcode <problem> | approve | status [evidence] | config | resume [taskId] | exit | help";
  pi.registerCommand("exitcode", {
    description: "Start a problem-first task; use /exitcode help for commands and settings",
    getArgumentCompletions: prefix => {
      const commands = ["approve", "status", "status evidence", "config", "resume", "exit", "help"];
      const matches = commands.filter(value => value.startsWith(prefix));
      return matches.length ? matches.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const text = args.trim(), [command, argument, extra] = text.split(/\s+/);
        if (!text || text === "help") {
          notify(ctx, `${usage}\nConfiguration: <Pi agent directory>/exitcode.json, then trusted .pi/exitcode.json.\nDefaults: ${JSON.stringify(DEFAULT_CONFIG)}\nUse /exitcode config to inspect settings. Run /reload after editing. Existing stores are never moved automatically.`); return;
        }
        if (command === "config") {
          if (argument) { notify(ctx, usage, "warning"); return; }
          if (configIssue) { notify(ctx, `${configIssue.code}: ${configIssue.message}`, "error"); return; }
          notify(ctx, JSON.stringify({ ...config, sources: configSources, storePath: resolveStoreDir(fs.realpathSync(ctx.cwd), config.storeDir),
            ...(enabled ? { activeStoreDir: taskStoreDir, activeStorePath: resolveStoreDir(fs.realpathSync(ctx.cwd), storeDir()) } : {}) }, null, 2)); return;
        }
        if (command === "status") {
          if (argument && argument !== "evidence" || extra) { notify(ctx, usage, "warning"); return; }
          if (configIssue && !enabled) { notify(ctx, `${configIssue.code}: ${configIssue.message}`, "error"); return; }
          const status = supervisor(ctx).status(taskId, argument === "evidence");
          notify(ctx, argument === "evidence" ? JSON.stringify(status, null, 2) : core.promptStatus(status)); updateStatus(ctx, status); return;
        }
        if (command === "exit" && !argument) {
          for (const operation of operations.keys()) operation.abort();
          await Promise.all(operations.values());
          if (!enabled) { notify(ctx, "Mode off; work is preserved and no success is claimed."); return; }
          const value = await supervisor(ctx, { expectedTask: taskId ?? null }).detach();
          disable(ctx); notify(ctx, value.next ?? value.message); return;
        }
        if (!ctx.isIdle()) { notify(ctx, "Finish or cancel the active agent run before changing task ownership or approving.", "warning"); return; }
        if (configIssue) { notify(ctx, `${configIssue.code}: ${configIssue.message}`, "error"); return; }
        if (command === "approve") {
          if (argument || !enabled) { notify(ctx, enabled ? usage : "Resume the task before approving.", "warning"); return; }
          const value = (await execute(ctx, undefined, undefined, supervisor => supervisor.approve())).details;
          if (!value.ok) { notify(ctx, `${value.code}: ${value.message}`, "warning"); return; }
          resetNudges();
          continueTask("exitcode-approval", `User approved task ${value.task}.`, value); return;
        }
        if (command === "resume") {
          if (extra) { notify(ctx, usage, "warning"); return; }
          const directory = storeDir(), value = await supervisor(ctx).resume(argument);
          if (!value.ok) { notify(ctx, `${value.code}: ${value.message}`, "warning"); return; }
          enable(value.task, directory, ctx);
          continueTask("exitcode-resume", `User resumed task ${value.task}.`, value); return;
        }
        if (["exit", "help"].includes(command)) { notify(ctx, usage, "warning"); return; }
        const directory = storeDir(), value = await supervisor(ctx).start(text);
        if (!value.ok) { notify(ctx, `${value.code}: ${value.message}`, "warning"); return; }
        enable(value.task, directory, ctx); pi.sendUserMessage(text);
      } catch (error: any) { notify(ctx, `${error.code ?? "IO_ERROR"}: ${error.message}`, "error"); }
    },
  });
}
