/** Offline SDK compatibility smoke. Pass the installed pi-coding-agent entry path. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createPiWorkerBackend } from '../exitcode-workers.mjs';

const entry = process.argv[2];
if (!entry) throw new Error('Usage: node scripts/smoke-workers.mjs /path/to/pi-coding-agent/dist/index.js');
const url = pathToFileURL(path.resolve(entry)), require = createRequire(url);
const sdk = await import(url.href);
const aiRoot = require.resolve.paths('@earendil-works/pi-ai').map(dir => path.join(dir,'@earendil-works/pi-ai')).find(dir => fs.existsSync(path.join(dir,'package.json')));
if (!aiRoot) throw new Error('The installed SDK must include pi-ai');
const aiPackage=JSON.parse(fs.readFileSync(path.join(aiRoot,'package.json'),'utf8'));
const ai = await import(pathToFileURL(path.join(aiRoot,aiPackage.exports['.'].import)).href);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-sdk-smoke-'));
const faux = ai.fauxProvider({provider:'exitcode-smoke',models:[{id:'worker',contextWindow:200000,maxTokens:8192}]});
faux.setResponses([
  ai.fauxAssistantMessage({type:'toolCall',id:'write-one',name:'write',arguments:{path:'result.txt',content:'done'}},{stopReason:'toolUse'}),
  ai.fauxAssistantMessage('Candidate ready for supervisor evaluation.'),
  ai.fauxAssistantMessage('Repair feedback received.'),
]);
const backend = createPiWorkerBackend({model:faux.getModel(),thinkingLevel:'off',modelRegistry:{getRegisteredNativeProvider:()=>faux.provider}},
  async () => ({...sdk,getAgentDir:()=>path.join(directory,'config'),ModelRuntime:{create:options=>sdk.ModelRuntime.create({
    credentials:new ai.InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,signal:options.signal,
  })}}));
let handle;
try {
  await backend.preflight();
  const cwd=path.join(directory,'worker');fs.mkdirSync(cwd);
  handle=await backend.start({id:'S1',cwd,kind:'slice',objective:'Create result.txt containing done'});
  await backend.send(handle,{objective:'Create result.txt containing done'});
  assert.equal(fs.readFileSync(path.join(cwd,'result.txt'),'utf8'),'done');
  await backend.send(handle,{failures:[]});
  await backend.cancel(handle);
  console.log('PASS: capability preflight, independent Pi SDK session, native write tool, feedback, cancellation, disposal');
} finally {
  if(handle)await backend.dispose(handle);
  fs.rmSync(directory,{recursive:true,force:true});
}
