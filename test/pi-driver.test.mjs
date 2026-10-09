// The observer's SDK boundary is tested with a fixture, not a live provider or real Pi installation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invoke } from '../exitcode-runner.mjs';
import { compare } from '../exitcode-spec.mjs';
import { workspace } from './helpers.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../examples/pi-extension/manifest.json', import.meta.url), 'utf8'));
const contract = JSON.parse(fs.readFileSync(new URL('../examples/pi-extension/contract.json', import.meta.url), 'utf8'));
const driver = fs.readFileSync(new URL('../examples/pi-extension/driver.mjs', import.meta.url), 'utf8');

test('Pi scenario observer reads the outcome independently of an SDK session claiming PASS', async t => {
  for (const correct of [true, false]) {
    const root = workspace(t), source = path.join(root, 'installation');
    const packageRoot = path.join(source, 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@earendil-works/pi-coding-agent': { version: '0.0.0-fixture' } } }));
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0-fixture' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), `
      import * as fs from 'node:fs'; import * as path from 'node:path';
      export const SettingsManager={inMemory:settings=>{if(JSON.stringify(settings.defaultTools)!==JSON.stringify(['read','bash','edit','write']))throw Error('Native tool defaults missing');return {};}};
      export const SessionManager={inMemory:()=>({})};
      export const ModelRuntime={create:async()=>({getAvailable:async()=>[{provider:'fixture',id:'fixture'}]})};
      export class DefaultResourceLoader { constructor(options){if(options.noContextFiles!==false)throw Error('Project instructions disabled');this.options=options;} async reload(){} }
      export async function createAgentSession({cwd,resourceLoader,tools}) {
        if(tools!==undefined)throw Error('Explicit tool allowlists block dynamic ExitCode tools');
        if(!fs.existsSync(resourceLoader.options.additionalExtensionPaths[0]))throw Error('Candidate not selected');
        if(!fs.existsSync(path.join(cwd,'AGENTS.md')))throw Error('Project context missing');
        const taskDir=path.join(cwd,'.exitcode','state','tasks','Tfixture');
        const session={isStreaming:false,subscribe:()=>()=>{},bindExtensions:async()=>{},abort:async()=>{},dispose(){},async prompt(text){
          fs.mkdirSync(taskDir,{recursive:true});
          if(text==='/exitcode approve'){
            ${correct ? "fs.writeFileSync(path.join(cwd,'result.txt'),'done\\n');" : ''}
            fs.writeFileSync(path.join(taskDir,'task.json'),JSON.stringify({phase:'PASS'}));
            fs.writeFileSync(path.join(cwd,'.exitcode','state','index.json'),JSON.stringify({active:null,latest:'Tfixture'}));
          }else{
            fs.writeFileSync(path.join(taskDir,'task.json'),JSON.stringify({phase:'READY'}));
            fs.writeFileSync(path.join(cwd,'.exitcode','state','index.json'),JSON.stringify({active:'Tfixture',latest:'Tfixture'}));
          }
        }};
        return {session,extensionsResult:{errors:[]}};
      }
    `);
    process.env.EXITCODE_PI_INSTALLATION = source;
    t.after(() => delete process.env.EXITCODE_PI_INSTALLATION);
    for (const name of ['project', 'runtime', 'candidate', 'run']) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'project', 'driver.mjs'), driver);
    fs.writeFileSync(path.join(root, 'candidate', 'exitcode.ts'), '// selected candidate');
    const scenario = structuredClone(contract.scenarios[0]); scenario.input.model = { provider: 'fixture', id: 'fixture' }; scenario.input.taskDeadlineMs = 1000;
    const request = { protocol: 1, operation: 'prepare', projectDirectory: path.join(root, 'project'), runtimeDirectory: path.join(root, 'runtime'),
      candidateDirectory: path.join(root, 'candidate'), runDirectory: path.join(root, 'run'), scenario };
    assert.equal((await invoke(manifest, request)).report.status, 'OK');
    const result = await invoke(manifest, { ...request, operation: 'run' });
    assert.equal(result.report.status, 'OK');
    assert.equal(result.report.observations.completed, true);
    assert.equal(result.report.observations.correct, correct);
    assert.equal(result.report.observations.approvalCount, 1);
    assert.equal(compare(result.report.observations, scenario.assertions).every(assertion => assertion.status === 'PASS'), correct);
  }
});
