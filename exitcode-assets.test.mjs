/** Durable supervisor boundaries for contract-owned acceptance evidence. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, baseline } from './test/suite.mjs';
import {stripTypeScriptTypes} from 'node:module';
import * as core from './exitcode-core.mjs';
import {captureEvaluatorAssets, compileRecipe, installEvaluatorAssets, restoreEvaluatorAssets,
  runRecipe, sandboxCommand, validateEvaluatorAssetDefinitions, verifyEvaluatorAssets} from './exitcode-evaluator.mjs';
import {releasePreparation} from './exitcode-preparation.mjs';

function workspace(t, files = {feature:'pending'}) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'exitcode-owned-assets-'));
  for(const [name,content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd,name)),{recursive:true});fs.writeFileSync(path.join(cwd,name),content);
  }
  t.after(()=>{releasePreparation(cwd);fs.rmSync(cwd,{recursive:true,force:true});});
  return cwd;
}
const recipe={kind:'test_asset',asset:'C1.test.mjs',command:'node',args:['--test']};
const outcomes=[{id:'O1',requirement:'The feature reports done'}];
const literal={id:'C1',outcome:'O1',check:{recipe:{kind:'file_contains',path:'feature',value:'done'}}};

test('assets: inline limits count UTF-8 bytes and report overbuilt proofs before drafting', t=>{
  const atLimit=Object.fromEntries(Array.from({length:16},(_,i)=>[`f${i}`,'']));
  validateEvaluatorAssetDefinitions({assets:atLimit,criteria:[]});
  validateEvaluatorAssetDefinitions({assets:{proof:'é'.repeat(64*1024)},criteria:[]});
  for(const assets of [{...atLimit,extra:''},{proof:'é'.repeat(64*1024)+'x'}]) {
    assert.throws(()=>validateEvaluatorAssetDefinitions({assets,criteria:[]}),e=>e.code==='EVALUATOR_ASSETS_OVERBUILT');
    const cwd=workspace(t),io=core.makeIo(cwd);
    const result=core.draftNode(io,{goal:'Complete feature',outcomes,criteria:[literal],assets});
    assert.equal(result.ok,false);assert.equal(result.code,'EVALUATOR_ASSETS_OVERBUILT');
    assert.equal(core.statusSnapshot(io).active,false,'oversized proofs create no partial contract');
  }
});

test('assets: existing_test and test_suite evaluate sealed tests while product tests change', async t=>{
  for(const kind of ['existing_test','test_suite'])await t.test(kind,async t=>{
    const proof="import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';test('approved behavior',()=>assert.equal(readFileSync('feature','utf8'),'done'));";
    const stable="import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';test('stable behavior',()=>assert.equal(readFileSync('stable','utf8'),'steady'));";
    const cwd=workspace(t,{stable:'steady','proof.test.mjs':proof,'tests/stable.test.mjs':stable,
      'package.json':JSON.stringify({scripts:{test:'sh scripts/verify'}}),'scripts/verify':'node --test ./*.test.mjs tests/*.test.mjs\n'});
    const check=kind==='existing_test'?{kind,path:'proof.test.mjs',selector:'approved behavior'}:{kind};
    const criteria=kind==='existing_test'?[{id:'C1',outcome:'O1',check:{recipe:check},controls:{accept:{mutations:[{kind:'write_file',path:'feature',content:'done'}]}}}]:
      [literal,{id:'R1',type:'regression',requirement:'Approved product suite passes',check:{recipe:check}}];
    // A regression suite starts from a passing baseline.
    if(kind==='test_suite')fs.writeFileSync(path.join(cwd,'feature'),'done');
    const io=core.makeIo(cwd);
    assert.equal(core.draftNode(io,{goal:'Complete feature',outcomes,criteria}).ok,true);
    const prepared=await core.prepareNode(io);assert.equal(prepared.ok,true,JSON.stringify(prepared));
    assert.equal(core.approveRoot(io).ok,true);assert.equal((await core.sealNode(io,'G1')).ok,true);
    const bundle=core.loadBundle(io,'G1');
    assert.equal(bundle.assets.files.some(f=>f.path==='tests/stable.test.mjs'),kind==='test_suite');
    fs.writeFileSync(path.join(cwd,'proof.test.mjs'),"import{test}from'node:test';test('weakened live assertion',()=>{});");
    fs.writeFileSync(path.join(cwd,'tests/new-feature.test.mjs'),"throw Error('new product test is outside approved suite');");
    fs.writeFileSync(path.join(cwd,'scripts/verify'),'exit 0\n');
    fs.rmSync(path.join(cwd,'tests/stable.test.mjs'));
    if(kind==='existing_test') {
      const fail=await core.evaluateNode(io);
      assert.equal(fail.ok,true,JSON.stringify(fail));
      assert.equal(core.loadNodeState(io,'G1').lastResult.allPass,false,'live tests cannot weaken approved evidence');
    } else {
      // Evaluate a bad product against the sealed suite directly; root regression
      // restoration otherwise replaces the intentionally broken candidate.
      const fixture=workspace(t,{feature:'pending',stable:'steady','tests/new-feature.test.mjs':'throw Error(\"new test\");'});
      installEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets);
      verifyEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets,{installed:true});
      assert.equal((await runRecipe(check,{cwd:fixture,readOnlyPaths:bundle.assets.readOnlyPaths})).exit,1);
      assert.equal(fs.existsSync(path.join(fixture,'tests/new-feature.test.mjs')),false);
      fs.writeFileSync(path.join(fixture,'generated.test.mjs'),'// unexpected runtime test');
      assert.throws(()=>verifyEvaluatorAssets(fixture,bundle.assetsDirectory,bundle.assets,{installed:true}),e=>e.code==='EVALUATOR_DRIFT');
    }
    fs.writeFileSync(path.join(cwd,'feature'),'done');
    assert.equal((await core.evaluateNode(io)).status,'PASS');
    assert.equal(fs.existsSync(path.join(cwd,'tests/stable.test.mjs')),false,'evaluation never restores product tests');
    assert.equal(fs.readFileSync(path.join(cwd,'scripts/verify'),'utf8'),'exit 0\n');
    assert.ok(fs.existsSync(path.join(cwd,'tests/new-feature.test.mjs')));
  });
});

baseline('assets: authored files are confined, bounded, and restored only into disposable copies', async t=>{
  const cwd=workspace(t), directory=path.join(cwd,'.exitcode/assets/bundle');
  for(const [assets,check] of [
    [null,recipe], [['bad'],recipe], [{'../escape':'bad'},recipe], [{'/escape':'bad'},recipe],
    [{'x/../../escape':'bad'},recipe], [{'x\\escape':'bad'},recipe], [{'./C1.test.mjs':'bad'},recipe],
    [{'.exitcode/index.json':'bad'},recipe], [{'x/.git/config':'bad'},recipe],
    [{'node_modules/runner.js':'bad'},recipe], [{'x':'bad','x/y':'bad'},recipe],
    [{'C1.test.mjs':1},recipe], [{'C1.test.mjs':'x'.repeat(128*1024+1)},recipe],
    [Object.fromEntries(Array.from({length:17},(_,i)=>[`f${i}`,''])),recipe], [{},recipe],
  ]) assert.throws(()=>validateEvaluatorAssetDefinitions({assets,criteria:[{check:{recipe:check}}]}));
  for(const invalid of [{...recipe,command:'/bin/sh'}, {...recipe,args:[1]}, {...recipe,asset:'../escape'}])
    assert.throws(()=>compileRecipe(invalid));
  const draft={assets:{'C1.test.mjs':'// test','fixtures/input.json':'{}'},criteria:[{check:{recipe}}]};
  const assets=captureEvaluatorAssets(cwd,draft,directory), before=core.digestTree(cwd);
  assert.equal(fs.existsSync(path.join(cwd,'.exitcode-evaluator')),false);
  verifyEvaluatorAssets(cwd,directory,assets);
  restoreEvaluatorAssets(cwd,directory,assets);
  assert.equal(core.digestTree(cwd),before);
  assert.equal(fs.existsSync(path.join(cwd,'.exitcode-evaluator')),false);
  const fixture=workspace(t,{feature:'pending'});
  installEvaluatorAssets(fixture,directory,assets);
  verifyEvaluatorAssets(fixture,directory,assets,{installed:true});
  fs.writeFileSync(path.join(fixture,'.exitcode-evaluator/C1.test.mjs'),'tampered');
  assert.throws(()=>verifyEvaluatorAssets(fixture,directory,assets,{installed:true}),/acceptance asset changed/);
  fs.symlinkSync('/missing',path.join(cwd,'.exitcode-evaluator'));
  assert.throws(()=>captureEvaluatorAssets(cwd,draft,path.join(cwd,'.exitcode/assets/other')),/reserved/);
  const cached=workspace(t), io=core.makeIo(cached);
  const criteria=[{...literal,controls:{accept:{mutations:[{kind:'copy_fixture',asset:'fixtures/positive.txt',path:'feature'}]}}}];
  assert.equal(core.draftNode(io,{goal:'Complete feature',outcomes,criteria,assets:{'fixtures/positive.txt':'done'}}).ok,true);
  assert.equal((await core.prepareNode(io)).ok,true);
  assert.equal(core.draftNode(io,{revise:'G1',goal:'Complete feature',criteria,assets:{'fixtures/positive.txt':'broken'}}).ok,true);
  const reprepared=await core.prepareNode(io);
  assert.equal(reprepared.ok,false,'changed witness assets cannot reuse cached discrimination');
  assert.ok(reprepared.diagnostics.some(d=>d.code==='ACCEPT_NOT_DISCRIMINATED'));
});

baseline('assets: the exact approved tests run fresh with the host runtime while the live repository stays clean', async t=>{
  const source="export const value='pending';", witness="export const value='done';";
  const cwd=workspace(t,{'src/value.mjs':source,profile:'existing',
    'profile.test.mjs':"import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';test('profile remains',()=>assert.equal(readFileSync('profile','utf8'),'existing'));"});
  const content="import{test}from'node:test';import assert from'node:assert/strict';import{value}from'../src/value.mjs';import{readFileSync,writeFileSync}from'node:fs';test('done',()=>{assert.equal(value,JSON.parse(readFileSync(new URL('./fixtures/expected.json',import.meta.url))).value);writeFileSync('probe-output.txt','disposable');});";
  const authored={'C1.test.mjs':content,'fixtures/expected.json':'{"value":"done"}','fixtures/positive.mjs':witness};
  const criteria=[{id:'C1',outcome:'O1',check:{recipe},
    controls:{accept:{mutations:[{kind:'copy_fixture',path:'src/value.mjs',asset:'fixtures/positive.mjs'}]}}},
    {id:'C2',type:'regression',requirement:'The existing profile remains',check:{recipe:{kind:'existing_test',path:'profile.test.mjs',selector:'profile remains'}}}];
  const calls=[];
  const io=core.makeIo(cwd,{exec:async(command,opts)=>{calls.push({command,cwd:opts.cwd,readOnlyPaths:opts.readOnlyPaths});return sandboxCommand(command,opts);}});
  const before=core.digestTree(cwd);
  assert.equal(core.draftNode(io,{goal:'Complete the feature',outcomes,criteria,assets:authored}).ok,true);
  let prepared=await core.prepareNode(io);
  assert.equal(prepared.ok,true,JSON.stringify(prepared.diagnostics));
  assert.equal(core.digestTree(cwd),before);
  assert.equal(core.approveRoot(io,{userReply:'Approved'}).ok,true);
  const firstDigest=core.statusSnapshot(io).evaluatorDigest;
  assert.equal(core.draftNode(io,{revise:'G1',goal:'Complete the feature',criteria,assets:{...authored,'C1.test.mjs':content+'\n// revised'}}).ok,true);
  assert.notEqual(core.statusSnapshot(io).evaluatorDigest,firstDigest);
  assert.equal(core.approveRoot(io).ok,false,'asset changes invalidate the validated approval');
  assert.equal(core.draftNode(io,{revise:'G1',goal:'Complete the feature',criteria}).ok,true,'omitted assets survive revision');
  prepared=await core.prepareNode(io);
  assert.equal(prepared.ok,true,JSON.stringify(prepared.diagnostics));
  assert.equal(core.approveRoot(io,{userReply:'Approved revised tests'}).ok,true);
  assert.equal((await core.sealNode(io,'G1')).ok,true);
  const bundle=core.loadBundle(io,'G1');
  assert.ok(bundle.assets.files.some(f=>f.owner==='supervisor'));
  assert.match(core.statusText(io,{detail:'evidence'}),/C1 acceptance asset: .exitcode\/assets\/G1.sealed\/\.exitcode-evaluator\/C1.test.mjs/);
  const failing=await core.evaluateNode(io);
  assert.equal(failing.status,'ACTIVE');
  assert.match(failing.vector,/C1=FAIL/);
  const sealedTest=path.join(bundle.assetsDirectory,'.exitcode-evaluator/C1.test.mjs'), sealedBytes=fs.readFileSync(sealedTest,'utf8');
  fs.writeFileSync(sealedTest,'process.exit(0)');
  // A damaged sealed copy is supervisor evidence corruption: only the user can restore it.
  assert.equal((await core.evaluateNode(io)).pause.code,'EVIDENCE_CORRUPT');
  fs.writeFileSync(sealedTest,sealedBytes);
  assert.equal(core.resumeRoot(io).ok,true);
  fs.writeFileSync(path.join(cwd,'src/value.mjs'),witness);
  const result=await core.evaluateNode(io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  assert.ok(calls.some(c=>c.readOnlyPaths.includes('.exitcode-evaluator')));
  assert.ok(calls.every(c=>c.cwd!==cwd),'checks only run in disposable copies');
  assert.equal(fs.existsSync(path.join(cwd,'.exitcode-evaluator')),false);
  assert.equal(fs.existsSync(path.join(cwd,'probe-output.txt')),false);
  assert.deepEqual(fs.readdirSync(cwd).sort(),['.exitcode','profile','profile.test.mjs','src']);
});

test('assets: empty-project probes execute owned tests and Node test assets must execute a test', async t=>{
  for (const check of [recipe,{kind:'custom_command',command:'node --test .exitcode-evaluator/C1.test.mjs'}]) {
    const cwd=workspace(t), io=core.makeIo(cwd);
    assert.equal(core.draftNode(io,{goal:'Complete feature',outcomes,criteria:[literal,
      {id:'C2',type:'regression',requirement:'An always-passing test is rejected',check:{recipe:check}}],
      assets:{'C1.test.mjs':"import{test}from'node:test';test('always passes',()=>{});"}}).ok,true);
    const prepared=await core.prepareNode(io);
    assert.equal(prepared.ok,false);
    assert.ok(prepared.diagnostics.some(d=>d.code==='EMPTY_TARGET_PASS'&&d.criterionId==='C2'),JSON.stringify(prepared.diagnostics));
  }
  const cwd=workspace(t);
  const fixture=workspace(t), directory=path.join(cwd,'.exitcode/assets/skipped');
  const assets=captureEvaluatorAssets(cwd,{criteria:[{check:{recipe}}],assets:{'C1.test.mjs':"import{test}from'node:test';test.skip('skipped',()=>{});"}},directory);
  installEvaluatorAssets(fixture,directory,assets);
  const run=await runRecipe(recipe,{cwd:fixture,readOnlyPaths:assets.readOnlyPaths});
  assert.equal(run.exit,1);
  assert.match(run.stdout,/No selected test executed/);
});

test('assets: the adapter authors acceptance files without changing product tests', async t=>{
  const cwd=workspace(t), tools=new Map(), commands=new Map(), entries=[];
  const before=core.digestTree(cwd), authored={'C1.test.mjs':'// contract acceptance evidence'};
  const exec=async(command,{cwd:fixture,readOnlyPaths})=>{
    assert.notEqual(fixture,cwd);
    assert.ok(readOnlyPaths.includes('.exitcode-evaluator'));
    assert.equal(fs.readFileSync(path.join(fixture,'.exitcode-evaluator/C1.test.mjs'),'utf8'),authored['C1.test.mjs']);
    const pass=fs.existsSync(path.join(fixture,'feature')) && fs.readFileSync(path.join(fixture,'feature'),'utf8')==='done';
    return {exit:pass?0:1,stdout:pass?'# pass 1\n':'',stderr:'',timedOut:false};
  };
  const source=stripTypeScriptTypes(fs.readFileSync(new URL('./exitcode.ts',import.meta.url),'utf8'))
    .replace('import { Type } from "typebox";','').replace('import * as core from "./exitcode-core.mjs";','')
    .replace('export default function','return function');
  const Type=new Proxy({},{get:()=>()=>({})});
  new Function('Type','core',source)(Type,{...core,makeIo:(dir,overrides)=>core.makeIo(dir,{exec,...overrides})})({
    registerTool:tool=>tools.set(tool.name,tool),registerCommand:(name,command)=>commands.set(name,command),
    on:()=>{},getActiveTools:()=>['read','write','bash'],setActiveTools:()=>{},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),
    sendMessage:()=>{},sendUserMessage:()=>{},
  });
  const ctx={cwd,hasUI:false,mode:'print',isIdle:()=>true,ui:{notify:()=>{}},sessionManager:{getBranch:()=>entries}};
  await commands.get('exitcode').handler('Complete feature',ctx);
  const drafted=await tools.get('exitcode_draft').execute('call',{goal:'Complete feature',outcomes,
    assets:authored,criteria:[{...literal,check:{recipe},controls:{accept:{mutations:[{kind:'write_file',path:'feature',content:'done'}]}}}]},undefined,undefined,ctx);
  assert.equal(drafted.isError,undefined,JSON.stringify(drafted.details));
  assert.deepEqual(core.statusSnapshot(core.makeIo(cwd)).contract.assets,authored);
  assert.equal(core.statusSnapshot(core.makeIo(cwd)).awaitingApproval,true);
  assert.equal(tools.has("exitcode_stage_tests"),false);
  assert.equal(core.digestTree(cwd),before);
});
