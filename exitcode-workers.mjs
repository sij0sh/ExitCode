/** Independent Pi SDK sessions. Workers have no ExitCode tools or supervisor authority. */
import { ensureRunning, operationError } from './exitcode-operation.mjs';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SYSTEM = 'You are an ExitCode implementation worker in a private Git workspace. Implement the assigned objective, preserve the stated prerequisites and regression behavior, and stop when your candidate is ready for supervisor evaluation. Repair evaluator failures in this same session. Repository tests are product files and may change; the supervisor evaluates sealed acceptance copies. Do not access supervisor storage or evaluator assets, create recursive workers, or claim the root is complete. Git commits are unnecessary; the supervisor captures your working tree.';

function workerBoundary(cwd) {
  return pi => pi.on('tool_call', event => {
    if (['read','write','edit'].includes(event.toolName) && typeof event.input?.path === 'string') {
      const full = path.resolve(cwd,event.input.path), rel = path.relative(cwd,full);
      if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || /(^|[\/])\.exitcode(?:-evaluator)?([\/]|$)/.test(rel))
        return {block:true,reason:'ExitCode workers can access only their own candidate; supervisor and evaluator storage are private.'};
      try {
        if (fs.lstatSync(full).isSymbolicLink()) {
          const target = path.relative(cwd,fs.realpathSync(full));
          if (target === '..' || target.startsWith('../') || path.isAbsolute(target)) return {block:true,reason:'Worker symlinks cannot access files outside their candidate.'};
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let parent = path.dirname(full);
      while (parent !== cwd && parent.startsWith(cwd + path.sep)) {
        try { if (fs.lstatSync(parent).isSymbolicLink()) return {block:true,reason:'Worker paths cannot traverse a symlink outside their candidate.'}; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        parent = path.dirname(parent);
      }
    }
    if (event.toolName === 'bash' && String(event.input?.command ?? '').replaceAll(cwd,'').includes('.exitcode'))
      return {block:true,reason:'Supervisor and evaluator storage are private to ExitCode.'};
    return undefined;
  });
}

export function createPiWorkerBackend(ctx, loadSdk = () => import('@earendil-works/pi-coding-agent')) {
  const runtimeFor = async (signal) => {
    ensureRunning(signal);
    if (!ctx.model) throw operationError('WORKER_UNAVAILABLE', 'select a model before approving execution workers');
    const sdk = await loadSdk();
    if (typeof sdk.createAgentSession !== 'function' || typeof sdk.DefaultResourceLoader !== 'function' ||
        typeof sdk.getAgentDir !== 'function' || typeof sdk.ModelRuntime?.create !== 'function' ||
        typeof sdk.SettingsManager?.inMemory !== 'function' || typeof sdk.SessionManager?.inMemory !== 'function')
      throw operationError('WORKER_UNAVAILABLE', 'Pi SDK worker session capabilities unavailable');
    const modelRuntime = await sdk.ModelRuntime.create({ signal, allowModelNetwork:false, refreshOnCreate:false });
    const nativeProvider = ctx.modelRegistry?.getRegisteredNativeProvider?.(ctx.model.provider);
    const providerConfig = ctx.modelRegistry?.getRegisteredProviderConfig?.(ctx.model.provider);
    if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
    if (providerConfig) modelRuntime.registerProvider(ctx.model.provider, providerConfig);
    if (typeof modelRuntime.getAvailable !== 'function') throw operationError('WORKER_UNAVAILABLE', 'worker model availability cannot be checked');
    const available = await modelRuntime.getAvailable(ctx.model.provider, {signal});
    ensureRunning(signal);
    if (!available.some(m=>m.provider===ctx.model.provider && m.id===ctx.model.id))
      throw operationError('WORKER_UNAVAILABLE', `selected model unavailable to workers: ${ctx.model.provider}/${ctx.model.id}`);
    return {sdk,modelRuntime};
  };
  return {
    async preflight({signal} = {}) {
      try { await runtimeFor(signal); }
      catch (error) { ensureRunning(signal); throw operationError('WORKER_UNAVAILABLE', error.message); }
    },
    async start(spec) {
      ensureRunning(spec.signal);
      const {sdk,modelRuntime} = await runtimeFor(spec.signal);
      const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
      const loader = new sdk.DefaultResourceLoader({ cwd: spec.cwd, agentDir: sdk.getAgentDir(), settingsManager,
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        systemPrompt: SYSTEM, disabledBuiltinExtensions: ['mcp'], extensionFactories: [workerBoundary(spec.cwd)] });
      await loader.reload();
      const { session, extensionsResult } = await sdk.createAgentSession({ cwd: spec.cwd, model: ctx.model, modelRuntime,
        thinkingLevel: ctx.thinkingLevel, settingsManager, resourceLoader: loader,
        sessionManager: sdk.SessionManager.inMemory(spec.cwd), tools: ['read', 'bash', 'edit', 'write'] });
      if (extensionsResult.errors?.length) { session.dispose(); throw operationError('WORKER_UNAVAILABLE', 'worker session resources failed to load'); }
      const abort = () => { void session.abort(); };
      spec.signal?.addEventListener('abort', abort, { once: true });
      const handle = { session, spec, abort, started: false, failure: null };
      handle.unsubscribe = session.subscribe(event => {
        if (event.type === 'message_end' && event.message?.role === 'assistant' && ['error', 'aborted'].includes(event.message.stopReason))
          handle.failure = operationError(event.message.stopReason === 'aborted' ? 'CANCELLED' : 'WORKER_FAILED', event.message.errorMessage ?? 'worker model failed');
      });
      try { await session.bindExtensions({ onError: () => { handle.failure = operationError('WORKER_FAILED', 'worker extension failed'); } }); ensureRunning(spec.signal); }
      catch (error) { spec.signal?.removeEventListener('abort', abort); handle.unsubscribe(); session.dispose(); throw error; }
      return handle;
    },
    async send(handle, feedback) {
      ensureRunning(handle.spec.signal); handle.failure = null;
      const content = handle.started ? { feedback } : { assignment: { ...handle.spec, signal: undefined }, feedback };
      handle.started = true;
      await handle.session.prompt(JSON.stringify(content));
      ensureRunning(handle.spec.signal);
      if (handle.failure) throw handle.failure;
    },
    async cancel(handle) { await handle.session.abort(); },
    async dispose(handle) {
      handle.spec.signal?.removeEventListener('abort', handle.abort);
      handle.unsubscribe(); handle.session.dispose();
    },
  };
}
