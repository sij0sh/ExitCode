// Project-level SDK integration. ExitCode itself never owns another coding session.
// This example targets the replacement's single state format, not the old extension.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const request = JSON.parse(stdin);
const reply = value => process.stdout.write(JSON.stringify({ protocol: 1, ...value }) + '\n');
const join = (root, name) => {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe fixture path');
  return path.join(root, name);
};

async function run() {
  if (request.operation === 'dispose') return { status: 'OK' };
  const installation = path.join(request.runtimeDirectory, 'pi');
  if (request.operation === 'prepare') {
    const source = process.env.EXITCODE_PI_INSTALLATION;
    if (!source || !path.isAbsolute(source) || !fs.existsSync(path.join(source, 'package-lock.json'))) throw new Error('EXITCODE_PI_INSTALLATION must identify a self-contained npm installation with a committed package-lock.json');
    const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
    const version = lock.packages?.['node_modules/@earendil-works/pi-coding-agent']?.version;
    const installed = JSON.parse(fs.readFileSync(path.join(source, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
    if (!version || installed.version !== version) throw new Error('The installed Pi SDK must match the pinned package-lock.json');
    // Dereference installation symlinks so the frozen environment has no host aliases.
    fs.cpSync(source, installation, { recursive: true, dereference: true });
    return { status: 'OK' };
  }
  const input = request.scenario.input, extension = join(request.candidateDirectory, input.extension);
  if (!fs.existsSync(extension)) return { status: 'UNAVAILABLE', reason: 'Candidate extension is absent' };
  const sdkFile = path.join(installation, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
  const sdk = await import(pathToFileURL(sdkFile).href);
  const cwd = path.join(request.runDirectory, 'fixture');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [name, content] of Object.entries(input.fixtureFiles)) { const file = join(cwd, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, defaultTools: ['read', 'bash', 'edit', 'write'] });
  const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const model = (await modelRuntime.getAvailable(input.model.provider)).find(m => m.provider === input.model.provider && m.id === input.model.id);
  if (!model) throw new Error('The explicitly selected model is unavailable');
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: path.join(request.runDirectory, 'pi-config'), settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: false, additionalExtensionPaths: [extension] });
  await loader.reload();
  const { session, extensionsResult } = await sdk.createAgentSession({ cwd, model, modelRuntime, settingsManager, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cwd) });
  const events = [], started = performance.now();
  let failure, approvalCount = 0, completed = false, timedOut = false;
  const unsubscribe = session.subscribe(event => {
    events.push({ type: event.type, elapsedMs: performance.now() - started });
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason === 'error') failure = event.message.errorMessage;
  });
  const deadline = setTimeout(() => { timedOut = true; void session.abort(); }, input.taskDeadlineMs);
  try {
    if (extensionsResult.errors?.length) throw new Error('Candidate extension failed to load');
    await session.bindExtensions({ onError: error => { failure = String(error); } });
    await session.prompt('/exitcode ' + input.goal);
    while (!timedOut) {
      if (failure) throw new Error(failure);
      const indexFile = path.join(cwd, '.exitcode', 'state', 'index.json');
      let task;
      if (fs.existsSync(indexFile)) {
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        const id = index.active ?? index.latest;
        if (typeof id === 'string' && /^T[A-Za-z0-9_-]+$/.test(id)) {
          const file = path.join(cwd, '.exitcode', 'state', 'tasks', id, 'task.json');
          if (fs.existsSync(file)) task = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
      }
      if (task?.phase === 'PASS' && !session.isStreaming) { completed = true; break; }
      if (task?.phase === 'READY' && !session.isStreaming && approvalCount === 0) { approvalCount++; await session.prompt('/exitcode approve'); }
      else if (task?.waitingFor && !session.isStreaming) throw new Error('Fixture task requested external input beyond its declared conditions');
      else await delay(50);
    }
    if (timedOut) await session.abort();
    const correct = Object.entries(input.expectedFiles).every(([name, content]) => {
      const file = join(cwd, name); return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content;
    });
    fs.mkdirSync(path.join(request.runDirectory, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(request.runDirectory, 'artifacts', 'events.json'), JSON.stringify(events));
    return { status: 'OK', observations: { completed, correct, approvalCount, timedOut, elapsedMs: performance.now() - started }, artifacts: ['artifacts/events.json'] };
  } finally { clearTimeout(deadline); unsubscribe(); await session.abort(); session.dispose(); }
}
try { reply(await run()); }
catch (error) { reply({ status: 'ERROR', reason: error.message }); }
