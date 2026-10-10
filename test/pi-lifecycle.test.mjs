// Offline regression through Pi's real prompt lifecycle, not the adapter fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ExitCode, TOOL_NAMES } from '../exitcode-core.mjs';
import { manifest, driver, contract } from './helpers.mjs';

function packageEntry(name, from = import.meta.url) {
  for (const directory of createRequire(from).resolve.paths(name) ?? []) {
    const entry = path.join(directory, name, 'dist/index.js');
    if (fs.existsSync(entry)) return entry;
  }
}
function installedPi() {
  if (process.env.EXITCODE_PI_SDK) return path.join(path.resolve(process.env.EXITCODE_PI_SDK), 'dist/index.js');
  const local = packageEntry('@earendil-works/pi-coding-agent');
  if (local) return local;
  // Pi supplies the peer dependency to extensions even when it is installed globally.
  const entry = path.resolve(path.dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  return fs.existsSync(entry) ? entry : undefined;
}
const sdkEntry = installedPi();

async function fixture(t, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-pi-lifecycle-'));
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'pending\n');
  const instruction = 'Native project instructions: preserve unrelated files.';
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), instruction + '\n');
  fs.writeFileSync(path.join(agentDir, 'exitcode.json'), JSON.stringify({ maxNudges: 0 }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session;
  t.after(async () => {
    try { await session?.abort(); session?.dispose(); }
    finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const ai = await import(pathToFileURL(packageEntry('@earendil-works/pi-ai', sdkEntry)).href);
  const requests = [], errors = [], records = [];
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('exitcode-lifecycle', {
    name: 'Offline lifecycle fixture', api: 'exitcode-lifecycle-api', baseUrl: 'http://fixture.invalid', apiKey: 'fixture',
    models: [{ id: 'offline', name: 'Offline fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const step = steps[requests.length];
      assert.ok(step, 'Unexpected model request');
      const current = ai.getCurrentSystemMessage(context.messages);
      const section = current?.sections?.exitcode;
      const tools = ai.getCurrentTools(context.messages).map(tool => tool.name);
      requests.push({ section, tools });
      assert.ok(ai.getCurrentSystemPrompt(context.messages).includes(instruction), 'Native AGENTS.md must survive every request');
      if (step.enabled !== undefined) {
        assert.equal(typeof section === 'string' && section.includes('EXITCODE.'), step.enabled, `ExitCode section on request ${requests.length}`);
        assert.equal(TOOL_NAMES.every(name => tools.includes(name)), step.enabled, `ExitCode tools on request ${requests.length}`);
      }
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'pending',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message });
        if (step.name) {
          const call = { type: 'toolCall', id: `lifecycle-${requests.length}`, name: step.name, arguments: {} };
          message.content.push(call); stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          call.arguments = step.arguments;
          stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message }); message.stopReason = 'toolUse';
        } else {
          message.content.push({ type: 'text', text: '' }); stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content[0].text = step.text;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: step.text, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: step.text, partial: message }); message.stopReason = 'stop';
        }
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    defaultTools: ['read', 'bash', 'edit', 'write'] });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: false, additionalExtensionPaths: [path.resolve('exitcode.ts')] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const created = await sdk.createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime, model: modelRuntime.getModel('exitcode-lifecycle', 'offline'),
    settingsManager, sessionManager: sdk.SessionManager.inMemory(cwd) });
  session = created.session;
  session.subscribe(event => {
    if (event.type === 'tool_execution_end') records.push(event);
    if (event.type === 'message_end' && event.message?.stopReason === 'error') errors.push(event.message.errorMessage);
  });
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  async function prompt(text, runs = true) {
    if (!runs) return session.prompt(text);
    let unsubscribe, timer;
    const settled = new Promise((resolve, reject) => {
      unsubscribe = session.subscribe(event => { if (event.type === 'agent_settled') resolve(); });
      timer = setTimeout(() => reject(new Error(`No settlement after ${text}`)), 10000);
    });
    try { await Promise.all([session.prompt(text), settled]); await session.waitForIdle(); assert.deepEqual(errors, []); }
    finally { clearTimeout(timer); unsubscribe(); }
  }
  return { cwd, session, prompt, requests, records, errors, supervisor: new ExitCode(cwd) };
}

const read = file => ({ enabled: true, name: 'read', arguments: { path: file } });
const stop = { enabled: true, text: 'Waiting for the user.' };
const options = { skip: !sdkEntry && 'Install the Pi peer dependency or set EXITCODE_PI_SDK to its package directory.' };

test('start and resume retain the ExitCode section across multiple tool rounds; explicit exit removes it', options, async t => {
  const h = await fixture(t, [read('feature.txt'), read('AGENTS.md'), stop, read('feature.txt'), read('AGENTS.md'), stop,
    { enabled: false, name: 'read', arguments: { path: 'AGENTS.md' } }, { enabled: false, text: 'Ordinary Pi session.' }]);
  await h.prompt('/exitcode The feature is pending');
  assert.equal(h.requests.length, 3);
  assert.equal(h.supervisor.status().phase, 'DISCOVERY');
  await h.prompt('/exitcode exit', false);
  await h.prompt('/exitcode resume');
  assert.equal(h.requests.length, 6);
  assert.match(h.requests[3].section, /Task .*: DISCOVERY/);
  await h.prompt('/exitcode exit', false);
  await h.prompt('Read the project instructions.');
  assert.equal(h.requests.length, 8);
  assert.ok(h.records.every(record => !record.isError));
  assert.equal(fs.readFileSync(path.join(h.cwd, 'feature.txt'), 'utf8'), 'pending\n');
});

test('approval independently retains the protocol across tool rounds and only fresh acceptance exits', options, async t => {
  const h = await fixture(t, [
    { enabled: true, name: 'exitcode_project', arguments: { manifest, files: { 'driver.mjs': driver } } },
    { enabled: true, name: 'exitcode_contract', arguments: contract() }, stop,
    { enabled: true, name: 'exitcode_evaluate', arguments: { inspect: 'contract' } }, read('AGENTS.md'),
    { enabled: true, name: 'write', arguments: { path: 'feature.txt', content: 'done\n' } },
    { enabled: true, name: 'exitcode_evaluate', arguments: {} }, { text: 'Fresh acceptance completed.' },
    { enabled: false, name: 'read', arguments: { path: 'AGENTS.md' } }, { enabled: false, text: 'Ordinary Pi session.' },
  ]);
  await h.prompt('/exitcode The feature is pending');
  assert.equal(h.supervisor.status().phase, 'READY');
  assert.equal(fs.readFileSync(path.join(h.cwd, 'feature.txt'), 'utf8'), 'pending\n');
  await h.prompt('/exitcode approve');
  assert.match(h.requests[3].section, /Task .*: SEALED/);
  assert.equal(h.supervisor.status().phase, 'PASS');
  assert.equal(h.supervisor.status().active, false);
  assert.ok(h.records.every(record => !record.isError));
  assert.equal(h.records.filter(record => record.toolName === 'exitcode_evaluate').at(-1).result.details.status, 'PASS');
  await h.prompt('Read the project instructions.');
  assert.equal(h.requests.length, 10);
  assert.ok(TOOL_NAMES.every(name => !h.session.getActiveToolNames().includes(name)));
});
