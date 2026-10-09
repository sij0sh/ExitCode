/** Independent Pi SDK sessions. Workers have no ExitCode tools or supervisor authority. */
import { ensureRunning, operationError } from './exitcode-operation.mjs';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SYSTEM = 'You are an ExitCode implementation worker in a private Git workspace. Implement the assigned objective, preserve the stated prerequisites and regression behavior, and stop when your candidate is ready for supervisor evaluation. Repair evaluator failures in this same session. Do not edit acceptance tests or evaluator assets, access supervisor storage, create recursive workers, or claim the root is complete. Git commits are unnecessary; the supervisor captures your working tree.';

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
  return {
    async start(spec) {
      ensureRunning(spec.signal);
      if (!ctx.model) throw operationError('WORKER_UNAVAILABLE', 'select a model before starting execution workers');
      const sdk = await loadSdk(), settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
      const modelRuntime = await sdk.ModelRuntime.create({ signal: spec.signal });
      const nativeProvider = ctx.modelRegistry?.getRegisteredNativeProvider?.(ctx.model.provider);
      const providerConfig = ctx.modelRegistry?.getRegisteredProviderConfig?.(ctx.model.provider);
      if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
      if (providerConfig) modelRuntime.registerProvider(ctx.model.provider, providerConfig);
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
