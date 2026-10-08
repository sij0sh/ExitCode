import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';
import * as core from './exitcode-core.mjs';
import {releasePreparation} from './exitcode-preparation.mjs';
import {reviewRepository, callReview, reviewPrompt} from './exitcode-quality.mjs';
import {scanCapabilities, sandboxCommand} from './exitcode-evaluator.mjs';

const good="const p={};export function save(v){if(v==='invalid')throw Error('invalid');p.zone=v;}export function get(){return p.zone;}";
const noop="export function save(v){if(v==='invalid')throw Error('invalid');}export function get(){return undefined;}";
const hardcoded="export function save(v){if(v==='invalid')throw Error('invalid');}export function get(){return 'Europe/London';}";
const observe="import assert from 'node:assert/strict';import {save,get} from './store.mjs';assert.equal(get(),undefined);save('Europe/London');assert.equal(get(),'Europe/London');assert.throws(()=>save('invalid'));save('America/New_York');assert.equal(get(),'America/New_York');";

function scenario(t,mode='strong') {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-e0-'));
  t.after(()=>{releasePreparation(cwd);fs.rmSync(cwd,{recursive:true,force:true});});
  fs.writeFileSync(path.join(cwd,'store.mjs'),good);
  fs.writeFileSync(path.join(cwd,'profile.txt'),'existing');
  fs.writeFileSync(path.join(cwd,'profile.test.mjs'),"import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';test('profile artifact remains',()=>assert.equal(readFileSync('profile.txt','utf8'),'existing'));");
  const criteria=[{id:'C1',requirement:'Saving a timezone persists the selected value and rejects invalid input',
    check:{recipe:{kind:'command_exit',command:'node',args:['--input-type=module','-e',observe]}},
    controls:{accept:{mutations:[{kind:'write_file',path:'store.mjs',content:good}]},reject:[{mutations:[{kind:'write_file',path:'store.mjs',content:noop}]}]}},
    {id:'C2',requirement:'Existing profile artifact remains',type:'regression',check:{recipe:{kind:'existing_test',path:'profile.test.mjs',selector:'profile artifact remains'}}}];
  if(mode==='weak-file'){
    criteria[0].check={recipe:{kind:'file_exists',path:'store.mjs'}};
    criteria[0].controls.reject=[{mutations:[{kind:'delete_file',path:'store.mjs'}]}];
  }
  if(mode==='structural'){
    fs.writeFileSync(path.join(cwd,'LICENSE'),'MIT');
    Object.assign(criteria[0],{requirement:'Package includes LICENSE',check:{recipe:{kind:'file_exists',path:'LICENSE'}},
      controls:{accept:{mutations:[{kind:'write_file',path:'LICENSE',content:'MIT'}]},reject:[{mutations:[{kind:'delete_file',path:'LICENSE'}]}]}});
  }
  // Post-setup content is needed to construct shams for code absent from the candidate.
  if(mode==='new-feature')fs.unlinkSync(path.join(cwd,'store.mjs'));
  const derived={outcomes:criteria.map(c=>({id:'I'+c.id,outcome:c.requirement,criteria:[c.id]})),
    criteria:[{criterionId:'C1',artifactOnly:mode==='structural',observation:mode==='structural'?'LICENSE is present':'Read the saved timezone back after each update',
      nearMisses:mode==='structural'?[]:[{id:'S1',reason:'Keep exports but omit persistence'},{id:'S2',reason:'Return the first requested timezone for every update'}],
      negative:{required:mode!=='structural',reason:'Invalid input rejection is explicit'},
      regression:{required:mode!=='structural',reason:'Profile updates use the same path'},
      reuse:{reason:'Reuse the profile test; focused state assertions cover the new behavior'}}]};
  const assessed={criteria:[{criterionId:'C1',outcomeObserved:true,structuralJustification:mode==='structural'?'The requirement is file presence':'',
    negativeCovered:true,regressionCriteria:['C2'],reuseReason:'Run the existing profile test and focused state assertions',
    shams:mode==='structural'?[]:[{id:'S1',mutations:[{kind:'write_file',path:'store.mjs',content:noop}]},{id:'S2',mutations:[{kind:'write_file',path:'store.mjs',content:hardcoded}]}]}],issues:[]};
  switch(mode){
    case 'uncovered': derived.outcomes.push({id:'I3',outcome:'Explicit unauthorized actor rejection',criteria:[]});break;
    case 'overlap': assessed.issues.push({code:'DUPLICATE_CRITERION',criterionId:'C1',evidence:'Criteria restate the same outcome'});break;
    case 'duplicate-outcome': derived.outcomes.push({...derived.outcomes[0],id:'I3'});break;
    case 'no-observation':assessed.criteria[0].outcomeObserved=false;break;
    case 'no-negative':assessed.criteria[0].negativeCovered=false;break;
    case 'no-regression':assessed.criteria[0].regressionCriteria=[];break;
    case 'irrelevant-regression':assessed.issues.push({code:'REGRESSION_UNRELATED',criterionId:'C1',evidence:'The mapped suite does not exercise affected profile behavior'});break;
    case 'duplicated-test':assessed.issues.push({code:'TEST_REUSE_MISSING',criterionId:'C1',evidence:'Custom shell duplicates discovered state tests'});break;
    case 'no-sham':assessed.criteria[0].shams=[];break;
    case 'unchanged':assessed.criteria[0].shams[0].mutations[0].content=good;break;
    case 'setup-error':assessed.criteria[0].shams[0].mutations=[{kind:'replace_text',path:'store.mjs',from:'missing substring',to:'bad'}];break;
    case 'empty-file':criteria[0].check={recipe:{kind:'file_exists',path:'store.mjs'}};criteria[0].controls.reject=[{mutations:[{kind:'delete_file',path:'store.mjs'}]}];assessed.criteria[0].shams[0].mutations[0].content='';break;
    case 'unsafe':assessed.criteria[0].shams[0].mutations[0].path='../escape';break;
    case 'test-mutation':assessed.criteria[0].shams[0].mutations[0].path='profile.test.mjs';break;
    case 'malformed':assessed.criteria=[];break;
    case 'duplicate-assessment':assessed.criteria.push(assessed.criteria[0]);break;
    case 'too-many-shams':derived.criteria[0].nearMisses.push({id:'S3',reason:'excess'});break;
  }
  const calls=[];
  const review=async(input,{signal})=>{
    assert.ok(signal instanceof AbortSignal);calls.push(input);
    if(mode==='review-error')throw Error('provider failure');
    if(mode==='review-timeout')return new Promise(()=>{});
    if(input.phase==='derive'){
      assert.deepEqual(input.criteria,criteria.map(c=>({id:c.id,requirement:c.requirement,type:c.type??'behavior'})));
      assert.ok(!JSON.stringify(input).includes('command_exit')&&!JSON.stringify(input).includes('controls'));
      assert.ok(input.repository.capabilities.existingTests.includes('profile.test.mjs'));
      return derived;
    }
    assert.deepEqual(input.derived,derived);
    const valid=input.validFixtures[0].repository.files.find(f=>f.path==='store.mjs');
    if(mode!=='structural')assert.equal(valid.content,good,'Reviewer needs post-setup valid code');
    return assessed;
  };
  const io=core.makeIo(cwd,{...(mode==='missing-review'?{}:{review}),reviewTimeoutMs:mode==='review-timeout'?10:30000,
    ...(mode==='runner-error'?{exec:async(cmd,o)=>{const r=await sandboxCommand(cmd,o);if(r.exit===1)return {...r,error:'runner error'};return r;}}:{})});
  assert.equal(core.draftNode(io,{goal:'Timezone behavior',originalRequest:mode==='structural'?'Include LICENSE':'Save timezone, reject invalid input and preserve profile updates',
    criteria,intentAtoms:criteria.map(c=>({id:c.id,outcome:c.requirement,criteria:[c.id]}))}).ok,true);
  return {cwd,io,calls};
}

for(const mode of ['strong','structural','new-feature'])test(`semantic: ${mode} reaches normal approval with unchanged candidate`,async t=>{
  const {cwd,io,calls}=scenario(t,mode),before=core.digestTree(cwd),r=await core.prepareNode(io);
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(core.digestTree(cwd),before);assert.equal(calls.length,2);
  assert.equal(core.statusSnapshot(io).awaitingApproval,true);
  const probes=r.stages.find(s=>s.stage==='sham').probes;
  assert.equal(probes.length,mode==='structural'?0:2);
  for(const p of probes){assert.equal(p.outcome.status,'FAIL');assert.notEqual(p.fixtureDigest,before);}
  assert.equal(core.loadRoot(io,'G1').approval,undefined);assert.equal(core.loadRoot(io,'G1').consumedAttempts,0);
});
for(const mode of ['weak-file','uncovered','overlap','duplicate-outcome','no-observation','no-negative','no-regression','irrelevant-regression','duplicated-test','no-sham','unchanged','setup-error','empty-file','unsafe','test-mutation','malformed','duplicate-assessment','too-many-shams','missing-review','review-error','review-timeout','runner-error'])test(`semantic: ${mode} prevents approval`,async t=>{
  const {cwd,io}=scenario(t,mode),before=core.digestTree(cwd),r=await core.prepareNode(io);
  assert.equal(r.ok,false,JSON.stringify(r));assert.ok(r.diagnostics.length);assert.equal(core.digestTree(cwd),before);
  assert.equal(r.review,undefined);assert.equal(core.statusSnapshot(io).awaitingApproval,false);assert.equal(core.approveRoot(io).ok,false);
  if(mode==='weak-file')assert.ok(r.diagnostics.some(d=>d.code==='SHAM_SURVIVED'));
  if(mode==='runner-error')assert.ok(r.stages.find(s=>s.stage==='sham').probes.some(p=>p.outcome.status==='ERROR'));
});

test('semantic: cancellation aborts reviewer and bounds ignored cancellation',async()=>{
  const parent=new AbortController();let nested;
  const call=callReview(async(_input,{signal})=>{nested=signal;parent.abort();return new Promise(()=>{});},{phase:'derive'},{signal:parent.signal,timeoutMs:100});
  await assert.rejects(call,/cancelled/);assert.equal(nested.aborted,true);
  const already=new AbortController();already.abort();let calls=0;
  await assert.rejects(callReview(()=>{calls++;},{},{signal:already.signal}),/cancelled/);assert.equal(calls,0);
  await assert.rejects(callReview(()=>({large:'x'.repeat(600000)}),{}),/too large/);
  for(const timeoutMs of [0,-1,Infinity,NaN])await assert.rejects(callReview(()=>({}),{},{timeoutMs}),/finite and positive/);
  assert.deepEqual(await callReview(()=>({ok:true}),{},{timeoutMs:30001}),{ok:true});
  await assert.rejects(callReview(()=>new Promise(()=>{}),{},{timeoutMs:5}),e=>e.code==='REVIEW_TIMEOUT');
});

test('semantic: repository context is bounded and does not follow secret or symlink paths',t=>{
  const {cwd}=scenario(t);
  fs.mkdirSync(path.join(cwd,'.private'));fs.writeFileSync(path.join(cwd,'.private/secret.mjs'),'private');
  fs.writeFileSync(path.join(cwd,'credentials.json'),'secret');fs.symlinkSync('/etc/passwd',path.join(cwd,'link.mjs'));
  fs.writeFileSync(path.join(cwd,'huge.mjs'),'x'.repeat(200000));
  const repo=reviewRepository(cwd,scanCapabilities(cwd),[{requirement:'profile store'}]);
  assert.ok(!repo.files.some(f=>/private|credentials|link/.test(f.path)));
  assert.ok(repo.files.every(f=>Buffer.byteLength(f.content)<=repo.limits.fileBytes));
  assert.ok(repo.files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)<=repo.limits.maxBytes);
  assert.ok(repo.files.find(f=>f.path==='huge.mjs').truncated);
  assert.match(reviewPrompt('derive'),/originalRequest first/);assert.match(reviewPrompt('assess'),/validFixtures/);
});

test('semantic: warm preparation still performs independent review and caches only executable evidence',async t=>{
  const {io,calls}=scenario(t,'structural');assert.equal((await core.prepareNode(io)).ok,true);
  const warm=await core.prepareNode(io);assert.equal(warm.ok,true);assert.equal(calls.length,4);assert.ok(warm.metrics.cacheHits>0);
});
