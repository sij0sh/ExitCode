import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as core from './exitcode-core.mjs';
import { structuralReview } from './test/structural-review.mjs';
import { fixedTestRuntime } from './test/runtime.mjs';
import { applyMutations, auditIntent, candidateIdentity, compileRecipe, evaluatorEnvironment, fileDigest, fingerprintRuntime, runRecipe, sandboxCommand, scanCapabilities } from './exitcode-evaluator.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';

const makeIo=(cwd,overrides={})=>core.makeIo(cwd,{review:structuralReview,fingerprintRuntime:fixedTestRuntime,...overrides});

function project(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'exitcode-quality-'));
  fs.writeFileSync(path.join(cwd,'feature'),'pending');
  t.after(()=>{releasePreparation(cwd);fs.rmSync(cwd,{recursive:true,force:true});});
  return cwd;
}
function criteria(){return [{id:'C1',requirement:'Feature is done',check:{recipe:{kind:'file_contains',path:'feature',value:'done'}},controls:{accept:{mutations:[{kind:'write_file',path:'feature',content:'done'}]},reject:[{mutations:[{kind:'write_file',path:'feature',content:'pending'}]}]}},{id:'C2',requirement:'Artifact persists',type:'regression',check:{recipe:{kind:'file_exists',path:'feature'}}}];}
function args(cs=criteria()){return {goal:'Complete feature',criteria:cs,intentAtoms:cs.map(c=>({id:'I'+c.id,outcome:c.requirement,criteria:[c.id]}))};}

test('evaluator-quality: overfitted reject fixture never reaches review',async t=>{
  const cwd=project(t),io=makeIo(cwd),cs=criteria();cs[0].controls.reject[0].mutations[0].content='done';
  const d=core.draftNode(io,args(cs));assert.ok(d.ok);const p=await core.prepareNode(io,d.id);
  assert.equal(p.ok,false);assert.ok(p.diagnostics.some(d=>d.code==='REJECT_NOT_DISCRIMINATED'));assert.equal(p.review,undefined);assert.equal(core.statusSnapshot(io).awaitingApproval,false);assert.equal(core.approveRoot(io).ok,false);
  assert.equal(core.draftNode(io,{...args(),revise:d.id}).ok,true);assert.equal((await core.prepareNode(io,d.id)).ok,true);assert.equal(core.statusSnapshot(io).consumedAttempts,0);
});

test('evaluator-quality: false-positive evaluator fails independent adversarial deletion',async t=>{
  const cwd=project(t),io=makeIo(cwd),cs=criteria();cs[0].check.recipe={kind:'file_not_contains',path:'feature',value:'bad'};cs[0].controls.reject[0].mutations[0].content='bad';
  core.draftNode(io,args(cs));const p=await core.prepareNode(io,'G1');assert.equal(p.ok,true);
  const empty=fs.mkdtempSync(path.join(os.tmpdir(),'quality-empty-'));try{assert.equal((await runRecipe(cs[0].check.recipe,{cwd:empty})).exit,1);}finally{fs.rmSync(empty,{recursive:true,force:true});}
  assert.ok(p.stages.find(s=>s.stage==='adversarial').probes.length>=2);
});

test('evaluator-quality: uncovered intent and duplicate criteria rejected',()=>{
  const cs=criteria();assert.equal(auditIntent({...args(cs),intentAtoms:[{id:'I',outcome:'Additional outcome',criteria:[]}]}).ok,false);
  assert.equal(auditIntent({...args(cs),intentAtoms:[{id:'I',outcome:'Additional outcome',criteria:['C99']}]}).ok,false);
  cs[1].requirement=cs[0].requirement;assert.ok(auditIntent(args(cs)).diagnostics.some(d=>d.code==='DUPLICATE_CRITERION'));
});

test('evaluator-quality: material ambiguity pauses once and minor choices do not',async t=>{
  const cwd=project(t),io=makeIo(cwd);
  const ambiguity={question:'Compatibility?',plausibleAnswers:['Keep','Break'],recommendedDefault:'Keep',whyMaterial:'Changes compatibility',affectedCriteria:['C1'],unresolved:true};
  core.draftNode(io,{...args(),ambiguities:[ambiguity]});const p=await core.prepareNode(io,'G1');assert.equal(p.phase,'CLARIFICATION');assert.equal(p.questions.length,1);assert.equal(p.review,undefined);
  for(const patch of [{unresolved:false},{plausibleAnswers:['Keep']},{whyMaterial:''},{affectedCriteria:[]}])assert.equal(auditIntent({...args(),ambiguities:[{...ambiguity,...patch}]}).questions.length,0);
});

test('evaluator-quality: nonexistent selectors and dynamic names cannot falsely pass',async t=>{
  const cwd=project(t);fs.mkdirSync(path.join(cwd,'test'));fs.writeFileSync(path.join(cwd,'test/a.test.mjs'),"import {test} from 'node:test';test('works',()=>{});");
  const cap=scanCapabilities(cwd);assert.throws(()=>compileRecipe({kind:'existing_test',path:'test/a.test.mjs',selector:'absent'},cap),/TEST_SELECTOR_NOT_FOUND/);
  assert.equal((await runRecipe({kind:'existing_test',path:'test/a.test.mjs',selector:'works'},{cwd})).exit,0);
  fs.writeFileSync(path.join(cwd,'test/a.test.mjs'),"import {test} from 'node:test';test('other',()=>{});");
  assert.equal((await runRecipe({kind:'existing_test',path:'test/a.test.mjs',selector:'works'},{cwd,capabilities:cap})).exit,1);
});

test('evaluator-quality: discovery never executes scripts or imports tests',t=>{
  const cwd=project(t);fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts:{test:'touch leaked',build:'touch leaked'}}));
  fs.writeFileSync(path.join(cwd,'a.test.mjs'),"import {test} from 'node:test';throw Error('never import');test('works',()=>{});");
  const first=scanCapabilities(cwd);assert.equal(first.availableScripts.test,'touch leaked');assert.equal(fs.existsSync(path.join(cwd,'leaked')),false);
  fs.writeFileSync(path.join(cwd,'a.test.mjs'),"import {test} from 'node:test';test('changed',()=>{});");assert.notEqual(scanCapabilities(cwd).digest,first.digest);
});

test('evaluator-quality: unsafe paths symlinks and JSON prototype keys rejected',async t=>{
  const cwd=project(t),outside=project(t);fs.symlinkSync(outside,path.join(cwd,'link'));
  for(const p of ['../escape','/tmp/escape','.exitcode/escape','link/escape'])await assert.rejects(()=>applyMutations(cwd,[{kind:'write_file',path:p,content:'bad'}]));
  fs.writeFileSync(path.join(cwd,'value.json'),'{}');await assert.rejects(()=>applyMutations(cwd,[{kind:'set_json_value',path:'value.json',pointer:'/__proto__/polluted',value:true}]));assert.equal({}.polluted,undefined);
});

test('evaluator-quality: external dependencies are typed pre-review failures',async t=>{
  const cwd=project(t),cs=criteria();cs[0].check={command:'curl https://example.com'};
  const io=makeIo(cwd);core.draftNode(io,args(cs));const p=await core.prepareNode(io,'G1');assert.equal(p.ok,false);assert.ok(p.diagnostics.some(d=>d.code==='EXTERNAL_DEPENDENCY'));assert.equal(p.review,undefined);
});

test('evaluator-quality: inconsistent probe results fail determinism',async t=>{
  const cwd=project(t);let n=0;const io=makeIo(cwd,{exec:async(_cmd,{cwd:fixture})=>{
    const feature=fs.existsSync(path.join(fixture,'feature'))?fs.readFileSync(path.join(fixture,'feature'),'utf8'):'';
    return {exit:feature.includes('done')&&++n%2===1?0:1,stdout:'',stderr:'',timedOut:false};
  }});const cs=criteria();cs[0].check={command:'check feature'};cs[0].controls.accept={mutations:[{kind:'write_file',path:'feature',content:'done'}]};core.draftNode(io,args(cs));const p=await core.prepareNode(io,'G1');assert.equal(p.ok,false);assert.ok(p.diagnostics.some(d=>d.code==='NONDETERMINISTIC'));
});

test('evaluator-quality: evaluator budget is separate and shared clock never resets',async t=>{
  const cwd=project(t),io=makeIo(cwd),cs=criteria();cs[0].controls.reject[0].mutations[0].content='done';core.draftNode(io,{...args(cs),policy:{evaluatorAttempts:2}});
  const root=core.loadRoot(io,'G1');await core.prepareNode(io,'G1');await core.prepareNode(io,'G1');const b=await core.prepareNode(io,'G1');assert.equal(b.status,'PAUSED');assert.equal(b.pause.code,'EVALUATOR_UNBUILDABLE');assert.equal(core.loadRoot(io,'G1').consumedAttempts,0);assert.equal(core.loadRoot(io,'G1').deadlineAt,root.deadlineAt);
});

test('evaluator-quality: file digests cover empty small and chunk-boundary content',t=>{
  const cwd=project(t),file=path.join(cwd,'content');
  for(const size of [0,1,13,1024*1024-1,1024*1024,1024*1024+1,2*1024*1024+17]){
    const content=Buffer.alloc(size,0x61);
    if(size){content[0]=0;content[size-1]=0xff;}
    fs.writeFileSync(file,content);
    assert.equal(fileDigest(file),createHash('sha256').update(content).digest('hex'),`${size} bytes`);
  }
});

test('evaluator-quality: full-content hashing still checks cancellation and deadlines between chunks',t=>{
  const cwd=project(t),file=path.join(cwd,'content');
  fs.writeFileSync(file,Buffer.alloc(2*1024*1024+1));
  const controller=new AbortController();let checks=0;
  assert.throws(()=>fileDigest(file,{signal:controller.signal,deadlineAt:10,nowMs:()=>{
    if(++checks===2)controller.abort();return 0;
  }}),{code:'CANCELLED'});
  checks=0;
  assert.throws(()=>fileDigest(file,{deadlineAt:10,nowMs:()=>++checks===3?10:0}),{code:'DEADLINE_EXCEEDED'});
});

test('evaluator-quality: full-content identity catches middle bytes modes and symlink targets',t=>{
  const cwd=project(t),file=path.join(cwd,'large');fs.writeFileSync(file,Buffer.alloc(9*1024*1024));const first=candidateIdentity(cwd);
  const fd=fs.openSync(file,'r+');fs.writeSync(fd,Buffer.from('x'),0,1,5*1024*1024);fs.closeSync(fd);assert.notEqual(candidateIdentity(cwd),first);
  const middle=candidateIdentity(cwd);fs.chmodSync(file,0o700);assert.notEqual(candidateIdentity(cwd),middle);
  fs.symlinkSync('feature',path.join(cwd,'link'));const linked=candidateIdentity(cwd);fs.unlinkSync(path.join(cwd,'link'));fs.symlinkSync('large',path.join(cwd,'link'));assert.notEqual(candidateIdentity(cwd),linked);
});

test('evaluator-quality: stale candidate environment and bundle evidence invalidate approval',async t=>{
  const cwd=project(t),io=makeIo(cwd);core.draftNode(io,args());assert.equal((await core.prepareNode(io,'G1')).ok,true);
  fs.mkdirSync(path.join(cwd,'node_modules'));fs.writeFileSync(path.join(cwd,'node_modules','dependency'),'changed');const approval=core.approveRoot(io);assert.equal(approval.ok,true);assert.match(approval.warnings[0],/node_modules/);assert.equal(fs.existsSync(path.join(cwd,'node_modules')),false);
  assert.equal((await core.prepareNode(io,'G1')).ok,true);const node=core.loadNodeState(io,'G1');node.prepared.baseline.allPass=true;core.saveNodeState(io,node);assert.equal(core.approveRoot(io).ok,false);
});

test('evaluator-quality: fixed test runtime leaves candidate and dependency identities live',t=>{
  const cwd=project(t),io=makeIo(cwd),environment=()=>evaluatorEnvironment(cwd,io);
  const first=environment(),originalCandidate=core.digestTree(cwd);assert.equal(first.dependencies,null);
  fs.writeFileSync(path.join(cwd,'feature'),'done');
  assert.notEqual(core.digestTree(cwd),originalCandidate);
  assert.deepEqual(environment(),first,'product content is tracked by candidate identity, not runtime identity');
  fs.mkdirSync(path.join(cwd,'node_modules'));
  const file=path.join(cwd,'node_modules','dependency');fs.writeFileSync(file,'one');
  const installed=environment();assert.notEqual(installed.dependencies,first.dependencies);
  const candidate=core.digestTree(cwd);
  fs.writeFileSync(file,'two');const changed=environment();
  assert.notEqual(changed.dependencies,installed.dependencies);assert.notEqual(core.digestTree(cwd),candidate);
  fs.chmodSync(file,0o700);const mode=environment();assert.notEqual(mode.dependencies,changed.dependencies);
  const link=path.join(cwd,'node_modules','link');fs.symlinkSync('dependency',link);const linked=environment();
  fs.unlinkSync(link);fs.symlinkSync('missing',link);assert.notEqual(environment().dependencies,linked.dependencies);
  const {dependencies,...runtime}=environment(),{dependencies:originalDependencies,...originalRuntime}=first;
  assert.deepEqual(runtime,originalRuntime);
  const copy=fixedTestRuntime();copy.runtime[0].digest='modified';
  assert.deepEqual(fixedTestRuntime(),originalRuntime,'test fingerprints are not shared mutable state');
  fs.rmSync(path.join(cwd,'node_modules'),{recursive:true});assert.deepEqual(environment(),first);
});

test('evaluator-quality: runtime providers honor operation stops and propagate failures',t=>{
  const cwd=project(t),controller=new AbortController();controller.abort();
  const unreachable=()=>assert.fail('runtime provider must not run after an operation stops');
  assert.throws(()=>evaluatorEnvironment(cwd,{fingerprintRuntime:unreachable,signal:controller.signal}),{code:'CANCELLED'});
  assert.throws(()=>evaluatorEnvironment(cwd,{fingerprintRuntime:unreachable,deadlineAt:10,nowMs:()=>10}),{code:'DEADLINE_EXCEEDED'});
  const late=new AbortController();
  assert.throws(()=>evaluatorEnvironment(cwd,{signal:late.signal,fingerprintRuntime:()=>{late.abort();return fixedTestRuntime();}}),{code:'CANCELLED'});
  let now=0;
  assert.throws(()=>evaluatorEnvironment(cwd,{deadlineAt:10,nowMs:()=>now,fingerprintRuntime:()=>{now=10;return fixedTestRuntime();}}),{code:'DEADLINE_EXCEEDED'});
  const error=Object.assign(new Error('runtime provider failed'),{code:'EIO'});
  assert.throws(()=>evaluatorEnvironment(cwd,{fingerprintRuntime:()=>{throw error;}}),e=>e===error);
});

test('evaluator-quality: injected runtime drift invalidates preparation approval sealing evaluation and PASS',async t=>{
  const cwd=project(t),cs=criteria(),recipe=cs[0].check.recipe;
  cs[0].check={command:'observe feature'};
  let generation=1,driftDuringPreparation=true,driftDuringEvaluation=false,driftOnPass=false;
  const io=makeIo(cwd,{
    fingerprintRuntime:options=>{
      assert.equal(options.nowMs,io.nowMs);
      if(driftOnPass && core.loadNodeState(io,'G1').status==='PASS'){driftOnPass=false;generation++;}
      return {...fixedTestRuntime(options),node:`test-runtime-${generation}`};
    },
    review:async input=>{if(driftDuringPreparation && input.phase==='assess')generation++;return structuralReview(input);},
    exec:async(_command,options)=>{
      const result=await runRecipe(recipe,options);
      if(driftDuringEvaluation)generation++;
      return result;
    },
  });
  const prepare=()=>core.prepareNode(io,'G1');core.draftNode(io,args(cs));
  const unstable=await prepare();assert.equal(unstable.status,'PAUSED');assert.equal(unstable.pause.code,'ENVIRONMENT_CHANGED');
  assert.equal(core.loadNodeState(io,'G1').preparing,undefined);assert.equal(fs.existsSync(core.storePaths(cwd).operation),false);
  driftDuringPreparation=false;assert.equal(core.resumeRoot(io).ok,true);assert.equal((await prepare()).ok,true);
  generation++;assert.equal(core.approveRoot(io).ok,false);
  assert.equal((await prepare()).ok,true);assert.equal(core.approveRoot(io).ok,true);
  generation++;assert.equal((await core.sealNode(io,'G1')).ok,false);assert.equal(core.loadNodeState(io,'G1').status,'DRAFT');
  assert.equal((await prepare()).ok,true);assert.equal(core.approveRoot(io).ok,true);assert.equal((await core.sealNode(io,'G1')).ok,true);
  generation++;let result=await core.evaluateNode(io);assert.equal(result.status,'PAUSED');assert.equal(result.pause.code,'ENVIRONMENT_CHANGED');
  generation--;assert.equal(core.resumeRoot(io).ok,true);fs.writeFileSync(path.join(cwd,'feature'),'done');
  // Reject drift during a check and again while committing its provisional PASS.
  for(const stage of ['check','commit']){
    driftDuringEvaluation=stage==='check';driftOnPass=stage==='commit';result=await core.evaluateNode(io);
    assert.equal(result.status,'PAUSED');assert.equal(result.pause.code,'ENVIRONMENT_CHANGED');
    assert.equal(core.loadNodeState(io,'G1').status,'ACTIVE');assert.equal(core.loadRoot(io,'G1').outcome,undefined);
    generation--;driftDuringEvaluation=false;driftOnPass=false;assert.equal(core.resumeRoot(io).ok,true);
  }
  result=await core.evaluateNode(io);assert.equal(result.status,'PASS');assert.equal(core.terminalStale(io,'G1').stale,false);
  generation++;assert.equal(core.terminalStale(io,'G1').stale,true);
});

test('evaluator-quality: default runtime fingerprinting detects live executable drift without caching',async t=>{
  const cwd=project(t),io=core.makeIo(cwd,{review:structuralReview});
  assert.equal(io.fingerprintRuntime,fingerprintRuntime);
  const first=evaluatorEnvironment(cwd,io);
  assert.equal(first.runtime[0].path,process.execPath);
  assert.equal(first.runtime[0].digest,fileDigest(fs.realpathSync(process.execPath)));
  assert.ok(first.runtime.every(r=>typeof r.digest==='string'),JSON.stringify(first.runtime));assert.ok(first.npm);
  // Keep one full supervisor path on the real host runtime, without the unit-test provider.
  fs.writeFileSync(path.join(cwd,'feature'),'done');core.draftNode(io,args());
  assert.equal((await core.prepareNode(io)).ok,true);assert.equal(core.approveRoot(io).ok,true);
  assert.equal((await core.sealNode(io,'G1')).ok,true);assert.equal((await core.evaluateNode(io)).status,'PASS');
  assert.equal(core.terminalStale(io,'G1').stale,false);
  // Substitute a disposable executable path, never mutate the installed Node binary.
  const original=process.execPath,runtimeRoot=project(t),bin=path.join(runtimeRoot,'bin');fs.mkdirSync(bin);
  const executable=path.join(bin,'node');fs.writeFileSync(executable,'version one');fs.chmodSync(executable,0o700);
  try{
    process.execPath=executable;
    const replaced=evaluatorEnvironment(cwd,io);assert.notDeepEqual(replaced.runtime,first.runtime);
    assert.equal(core.terminalStale(io,'G1').stale,true);
    const npm=path.join(runtimeRoot,'lib','node_modules','npm');fs.mkdirSync(npm,{recursive:true});
    const npmFile=path.join(npm,'runtime.mjs');fs.writeFileSync(npmFile,'npm one');
    const installed=evaluatorEnvironment(cwd,io);
    fs.writeFileSync(npmFile,'npm two');
    if(!fs.existsSync('/runtime/npm/bin/npm-cli.js'))assert.notEqual(evaluatorEnvironment(cwd,io).npm,installed.npm);
    fs.writeFileSync(executable,'version two');assert.notEqual(evaluatorEnvironment(cwd,io).runtime[0].digest,replaced.runtime[0].digest);
  }finally{process.execPath=original;}
  assert.deepEqual(evaluatorEnvironment(cwd,io),first);assert.equal(core.terminalStale(io,'G1').stale,false);
});

test('evaluator-quality: isolation hides host paths env network and host processes',async t=>{
  const cwd=project(t);const hostPid=process.pid;process.env.EXITCODE_TEST_SECRET='hidden';
  try{const js=`const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(cwd)})||process.env.EXITCODE_TEST_SECRET||fs.existsSync('/proc/${hostPid}/root'))process.exit(9);console.log('isolated');`;
    const result=await sandboxCommand('node -e '+JSON.stringify(js),{cwd,timeoutMs:5000});assert.equal(result.exit,0,JSON.stringify(result));assert.match(result.stdout,/isolated/);
    assert.equal((await sandboxCommand('echo unsafe',{cwd,timeoutMs:1000,bwrapPath:'/nonexistent/bwrap'})).exit,null);
    const no=await sandboxCommand('echo mutation > feature',{cwd,timeoutMs:1000});assert.notEqual(no.exit,0);assert.equal(fs.readFileSync(path.join(cwd,'feature'),'utf8'),'pending');
    const huge=await sandboxCommand("node -e \"process.stdout.write('x'.repeat(1000000))\"",{cwd,timeoutMs:5000});assert.ok(huge.truncated);assert.ok(Buffer.byteLength(huge.stdout)<=65536);
    const slow=await sandboxCommand('sleep 10 & wait',{cwd,timeoutMs:100});assert.equal(slow.timedOut,true);
  }finally{delete process.env.EXITCODE_TEST_SECRET;}
});

test('evaluator-quality: fresh evaluation bypasses preparation cache and seal never completes',async t=>{
  const cwd=project(t),io=makeIo(cwd);fs.writeFileSync(path.join(cwd,'feature'),'done');core.draftNode(io,args());await core.prepareNode(io,'G1');await core.prepareNode(io,'G1');assert.equal(core.approveRoot(io).ok,true);await core.sealNode(io,'G1');assert.equal(core.loadRoot(io,'G1').status,'ACTIVE');
  await core.evaluateNode(io);assert.equal(core.loadRoot(io,'G1').status,'PASS');assert.ok(core.loadNodeState(io,'G1').lastResult.metrics.probeExecutions>0);
});


test('evaluator-quality: build and Node test recipes may write only their copied fixture',async t=>{
  const cwd=project(t);fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts:{build:'node -e "require(\'fs\').writeFileSync(\'built\',\'yes\')"'}}));
  fs.writeFileSync(path.join(cwd,'writes.test.mjs'),"import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('writes output',()=>writeFileSync('test-output','ok')); ");
  const built=await runRecipe({kind:'build_succeeds'},{cwd});assert.equal(built.exit,0,JSON.stringify(built));
  assert.equal((await runRecipe({kind:'existing_test',path:'writes.test.mjs',selector:'writes output'},{cwd})).exit,0);
});

test('evaluator-quality: checkpoints restore modes and symlinks without writing outside',t=>{
  const cwd=project(t),outside=project(t),snapshot=fs.mkdtempSync(path.join(os.tmpdir(),'quality-checkpoint-'));t.after(()=>fs.rmSync(snapshot,{recursive:true,force:true}));
  fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src','file'),'original');fs.chmodSync(path.join(cwd,'src','file'),0o700);fs.symlinkSync('feature',path.join(cwd,'link'));
  const before=candidateIdentity(cwd),snap=core.snapshotTree(cwd,snapshot);assert.equal(snap.ok,true);
  fs.rmSync(path.join(cwd,'src'),{recursive:true});fs.symlinkSync(outside,path.join(cwd,'src'));fs.writeFileSync(path.join(outside,'file'),'host-secret');fs.unlinkSync(path.join(cwd,'link'));fs.symlinkSync('missing',path.join(cwd,'link'));
  core.restoreTree(cwd,snapshot,snap.manifest);assert.equal(candidateIdentity(cwd),before);assert.equal(fs.readFileSync(path.join(outside,'file'),'utf8'),'host-secret');
});

test('evaluator-quality: numeric timeout normalization and interrupted budgets are persistent',async t=>{
  const cwd=project(t),io=makeIo(cwd),cs=criteria();cs[0].check.timeoutSeconds='3';assert.equal(core.draftNode(io,args(cs)).ok,true);assert.equal((await core.prepareNode(io)).ok,true);
  const node=core.loadNodeState(io,'G1'),attempts=node.evaluatorMetrics.e0Attempts;node.preparing=true;core.saveNodeState(io,node);core.resumePreparation(io);assert.equal(core.loadNodeState(io,'G1').phase,'EVALUATOR_PREPARATION');assert.equal(core.loadNodeState(io,'G1').evaluatorMetrics.e0Attempts,attempts);assert.equal(core.approveRoot(io).ok,false);
});
