/** Integration evidence, private Git isolation, shared budgets, and fail-closed recovery. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, baseline } from './test/suite.mjs';
import * as core from './exitcode-core.mjs';
import { workerBehaviorHorizon, integrationHorizon, captureCandidate, materialize, preflightExecution, createExecution, runExecution } from './exitcode-parallel.mjs';
import { evaluatorEnvironment, digest } from './exitcode-evaluator.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { structuralReview } from './test/structural-review.mjs';

const graph = [
  { id: 'S3', objective: 'Finish the dependent artifact', verify: ['C3'], after: ['C1', 'C2'] },
  { id: 'S1', objective: 'Finish the first artifact', verify: ['C1'] },
  { id: 'S2', objective: 'Finish the second artifact', verify: ['C2'] },
];
const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
const write = (cwd, file, value) => fs.writeFileSync(path.join(cwd, file), value);
const criterion = (id, file) => ({ id, outcome: `O${id.slice(1)}`,
  check: { recipe: { kind: 'custom_command', command: `observe:${file}` } },
  controls: { accept: { mutations: [{ kind: 'write_file', path: file, content: 'done' }] } } });

function fixture(t, { execution = graph, policy, semantic = false, files = {}, fileModes = {}, links = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-parallel-test-'));
  for (const file of ['first', 'second', 'last']) write(cwd, file, 'pending');
  write(cwd, 'stable', 'steady');
  for (const [file, value] of Object.entries(files)) write(cwd,file,value);
  for (const [file, mode] of Object.entries(fileModes)) fs.chmodSync(path.join(cwd,file),mode);
  for (const [file, target] of Object.entries(links)) fs.symlinkSync(target,path.join(cwd,file));
  const calls = [], lifecycle = [], fault = { run: false };
  const exec = async (command, options) => {
    if (fault.run) return {exit:null,error:'runtime missing',errorCode:'RUNNER_ERROR'};
    calls.push({ command, cwd: options.cwd, first: read(options.cwd, 'first'), second: read(options.cwd, 'second') });
    let pass = command === 'preserve' ? read(options.cwd, 'stable') === 'steady' : read(options.cwd, command.slice(8)) === 'done';
    if (semantic && command === 'preserve' && read(options.cwd, 'first') === 'done' && read(options.cwd, 'second') === 'done') pass &&= read(options.cwd, 'compatible') === 'yes';
    return { exit: pass ? 0 : 1, stdout: '', stderr: '', timedOut: false };
  };
  const io = core.makeIo(cwd, { exec, review: structuralReview });
  const criteria = [criterion('C1', 'first'), criterion('C2', 'second'), criterion('C3', 'last'),
    { id: 'R1', requirement: 'Existing artifacts remain compatible', type: 'regression', check: { recipe: { kind: 'custom_command', command: 'preserve' } } }];
  const args = { goal: 'Complete the three artifacts', outcomes: criteria.slice(0,3).map(c => ({ id:c.outcome,requirement:`${c.id} contains the requested done artifact` })), criteria, execution, policy };
  const drafted = core.draftNode(io, args);
  t.after(() => { releasePreparation(cwd); fs.rmSync(cwd, { recursive: true, force: true }); });
  const f = { cwd, io, calls, lifecycle, fault, drafted, args };
  backend(f,implement);
  return f;
}
async function seal(f) {
  assert.equal(f.drafted.ok, true, JSON.stringify(f.drafted));
  const prepared = await core.prepareNode(f.io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.match(prepared.review, /Execution graph/);
  assert.equal((await core.sealNode(f.io, 'G1', { userApproval: 'Approve the graph' })).ok, true);
  f.calls.length = 0;
}
function backend(f, run) {
  let active = 0, peak = 0;
  const api = {
    async preflight(){ f.lifecycle.push(["preflight"]); },
    async start(spec) { f.lifecycle.push(['start',spec.id,spec.cwd]); active++; peak = Math.max(peak,active); return { ...spec, turns:0 }; },
    async send(handle, feedback) { handle.turns++; await run(handle, feedback); },
    async cancel(handle) { f.lifecycle.push(['cancel',handle.id]); },
    async dispose(handle) { f.lifecycle.push(['dispose',handle.id]); active--; },
    peak: () => peak,
  };
  f.io.workerBackend = api; return api;
}
const implement = async handle => {
  if (handle.kind === 'reconciliation') { write(handle.cwd, 'compatible', 'yes'); return; }
  const file = { S1:'first',S2:'second',S3:'last' }[handle.id];
  if (handle.id === 'S3') {
    assert.equal(read(handle.cwd,'first'),'done'); assert.equal(read(handle.cwd,'second'),'done');
  }
  write(handle.cwd,file,'done');
};

function assertUnavailableDraft(f, failed, code) {
  assert.equal(failed.ok,false,JSON.stringify(failed));
  const d=failed.diagnostics.find(d=>d.code===code);
  assert.equal(d?.repairability,'supervisor');
  assert.match(d.recommendedRepair,/without `execution`.*ordered `sequence`.*serially/);
  const snapshot=core.statusSnapshot(f.io);
  assert.deepEqual([failed.metrics.e0Attempts,snapshot.evaluatorMetrics.e0Attempts],[0,0]);
  assert.deepEqual([snapshot.status,snapshot.nodes.G1.status,snapshot.phase,snapshot.approval,snapshot.awaitingApproval],
    ['ACTIVE','DRAFT','EVALUATOR_PREPARATION',null,false]);
  assert.deepEqual(snapshot.contract.execution,f.drafted.draft.execution,'diagnostics never rewrite the graph');
  assert.equal(snapshot.contract.sequence,undefined);
  assert.equal(core.approveRoot(f.io).ok,false);
  assert.equal(fs.existsSync(core.sealedFile(f.cwd,'G1')),false);
  assert.equal(core.draftNode(f.io,{...f.args,revise:'G1'}).ok,true,'preflight failure keeps the draft editable');
}

baseline('parallel: execution capability failures prevent approval and preflight starts no workers or Git candidates', async t=>{
  const f=fixture(t),before=core.digestTree(f.cwd);
  delete f.io.workerBackend;
  assertUnavailableDraft(f,await core.prepareNode(f.io),'WORKER_UNAVAILABLE');
  backend(f,implement);
  f.io.workerBackend.preflight=async()=>{throw Object.assign(Error('selected model unavailable'),{code:'WORKER_UNAVAILABLE'});};
  assertUnavailableDraft(f,await core.prepareNode(f.io),'WORKER_UNAVAILABLE');
  backend(f,implement);
  const passed=await core.prepareNode(f.io);
  assert.equal(passed.ok,true,JSON.stringify(passed));
  assert.ok(passed.stages.some(s=>s.stage==='execution-capability'&&s.ok));
  assert.equal(f.lifecycle.filter(x=>x[0]==='start').length,0);
  assert.equal(fs.existsSync(path.join(f.cwd,'.exitcode/parallel')),false);
  assert.equal(core.digestTree(f.cwd),before);
  assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,0);
  assert.equal(core.loadRoot(f.io,'G1').deadlineAt,null);
});

baseline('parallel: injected execution preflight faults are deterministic without Git initialization', async t=>{
  for(const code of ['WORKER_UNAVAILABLE','GIT_UNAVAILABLE'])await t.test(code,async t=>{
    const f=fixture(t);let calls=0;
    f.io.executionPreflight=async()=>{calls++;throw Object.assign(Error('injected unavailable capability'),{code});};
    assertUnavailableDraft(f,await core.prepareNode(f.io),code);
    assert.equal(calls,1);
    assert.equal(f.lifecycle.length,0,'real worker preflight is bypassed');
    assert.equal(f.calls.length,0,'no evaluator probes execute');
    assert.equal(fs.existsSync(path.join(f.cwd,'.git')),false);
    assert.equal(fs.existsSync(path.join(f.cwd,'.exitcode/parallel')),false);
  });
});

baseline('parallel: Git preflight accepts supported option forms and rejects missing or outdated Git', async t=>{
  let workers=0;
  const backend={preflight:async()=>{workers++;},start(){},send(){},cancel(){},dispose(){}};
  for(const help of ['--write-tree --merge-base','--write-tree --[no-]merge-base']) {
    await preflightExecution({workerBackend:backend},async(command,args)=>{
      assert.equal(command,'git');assert.ok(args.includes('--merge-base=HEAD'));assert.equal(args.at(-1),'-h');
      throw Object.assign(Error('usage'),{code:129,stderr:help});
    });
  }
  assert.equal(workers,2);
  for(const failure of [Object.assign(Error('not installed'),{code:'ENOENT'}),Object.assign(Error('usage'),{code:129,stderr:'--write-tree'})]) {
    await assert.rejects(()=>preflightExecution({workerBackend:backend},async()=>{throw failure;}),e=>e.code==='GIT_UNAVAILABLE');
    const outdated=failure.code===129;
    const f=fixture(t,{files:outdated?{git:'#!/bin/sh\nprintf "%s\\n" "--write-tree"\nexit 129\n'}:{},fileModes:outdated?{git:0o755}:{}});
    const originalPath=process.env.PATH;
    try {
      process.env.PATH=f.cwd; // Only a missing or unsupported Git in this disposable candidate.
      assertUnavailableDraft(f,await core.prepareNode(f.io),'GIT_UNAVAILABLE');
      assert.equal(f.lifecycle.length,0,'Git failure prevents even worker capability preflight');
      assert.equal(fs.existsSync(path.join(f.cwd,'.exitcode/parallel')),false);
    } finally {
      if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
    }
  }
  assert.equal(workers,2,'Git failure prevents worker runtime construction');
  t.mock.timers.enable({apis:['setTimeout']});
  let elapsed=0,entered;
  t.mock.method(performance,'now',()=>elapsed);
  const ready=new Promise(resolve=>{entered=resolve;});
  const waiting=preflightExecution({workerBackend:{...backend,preflight:()=>{entered();return new Promise(()=>{});}}},
    async()=>({stdout:'--write-tree --merge-base'}));
  const rejected=assert.rejects(waiting,e=>e.code==='WORKER_UNAVAILABLE' && /timed out/.test(e.message));
  await ready;elapsed=10_000;t.mock.timers.tick(10_000);await rejected;
});

baseline('parallel: DAG ownership and cycles are structural; worker horizons include transitive behavior prerequisites without regressions', t => {
  for (const [name, execution, error] of [
    ['forward references',graph,null],
    ['cycle',graph.map(s => s.id === 'S1' ? {...s,after:['C3']} : s),/cycle/],
    ['self dependency',graph.map(s => s.id === 'S1' ? {...s,after:['C1']} : s),/cycle/],
    ['missing criterion',graph.slice(1),/missing/],
    ['duplicate owner',[...graph,{id:'S4',objective:'duplicate',verify:['C1']}],/more than one/],
    ['unknown dependency',graph.map(s => s.id === 'S1' ? {...s,after:['bogus']} : s),/valid behavior/],
    ['duplicate slice',graph.map(s => s.id === 'S1' ? {...s,id:'S2'} : s),/unique/],
  ]) {
    const f=fixture(t,{execution}); assert.equal(f.drafted.ok,!error,name);
    if (error) assert.match(f.drafted.errors.join(' '),error);
    else {
      assert.deepEqual(workerBehaviorHorizon(f.drafted.draft,'S1'),['C1']);
      assert.deepEqual(workerBehaviorHorizon(f.drafted.draft,'S3'),['C1','C2','C3']);
      assert.deepEqual(integrationHorizon(f.drafted.draft,['C1']),['C1','R1']);
    }
  }
  const f=fixture(t,{policy:{maxParallelWorkers:1.5}}); assert.equal(f.drafted.ok,false);
});

baseline('parallel: independent workers overlap; only integrated fresh evidence unlocks dependents and canonical PASS', async t => {
  const f=fixture(t); await seal(f);
  const approved=core.loadRoot(f.io,'G1'), sealed=fs.readFileSync(core.sealedFile(f.cwd,'G1'),'utf8');
  let release, entered=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const workers=backend(f,async h=>{
    if(h.id==='S1'||h.id==='S2'){if(++entered===2)release();await gate;}
    if(h.id==='S3')assert.deepEqual(h.criteria.map(c=>c.id),['C1','C2','C3']);
    await implement(h);
  });
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result)); assert.equal(workers.peak(),2);
  const root=core.loadRoot(f.io,'G1');
  assert.equal(root.consumedAttempts,3); assert.ok(root.execution.slices.every(s=>s.status==='INTEGRATED'));
  assert.equal(root.outcome.candidateDigest,core.digestTree(f.cwd));
  assert.equal(fs.readFileSync(core.sealedFile(f.cwd,'G1'),'utf8'),sealed);
  for(const key of ['approval','policy','executionStartedAt','deadlineAt'])assert.deepEqual(root[key],approved[key]);
  assert.equal(f.lifecycle.filter(x=>x[0]==='start').length,3,'clean merges need no agent');
  const dep=f.lifecycle.find(x=>x[0]==='start'&&x[1]==='S3');
  assert.ok(dep); assert.equal(read(dep[2],'last'),'done');
  assert.ok(f.calls.some(c=>c.command==='observe:first'&&c.first==='done'&&c.second==='done'));
  const metadata=f.lifecycle.filter(x=>x[0]==='start').map(x=>path.join(x[2],'.git'));
  for(const dir of metadata){assert.ok(fs.lstatSync(dir).isDirectory());assert.equal(fs.existsSync(path.join(dir,'objects','info','alternates')),false);}
});

baseline('parallel: semantic reconciliation is evaluated and charged; canonical edits and the user index survive', async t => {
  const f=fixture(t,{semantic:true});
  execFileSync('git',['init','--quiet',f.cwd]);
  execFileSync('git',['-C',f.cwd,'add','first']);
  const index=fs.readFileSync(path.join(f.cwd,'.git','index'));
  await seal(f);
  let edited=false;
  backend(f,async h=>{
    if(!edited){edited=true;write(f.cwd,'user-note','keep this uncommitted change');}
    await implement(h);
  });
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,4);
  assert.equal(read(f.cwd,'user-note'),'keep this uncommitted change');
  assert.equal(read(f.cwd,'compatible'),'yes');
  assert.deepEqual(fs.readFileSync(path.join(f.cwd,'.git','index')),index);
  assert.ok(f.lifecycle.some(x=>x[0]==='start'&&x[1].startsWith('reconcile-')));
});

test('parallel: textual conflicts use an isolated reconciler and reject unresolved markers even with passing checks', async t => {
  for(const leaveMarkers of [false,true]) await t.test(leaveMarkers?'unresolved markers':'resolved conflict',async t=>{
  const f=fixture(t,{files:{shared:'initial'}}); await seal(f);
  backend(f,async h=>{
    if(h.kind==='reconciliation'){
      assert.ok(h.context.conflicts); assert.ok(read(h.cwd,'shared').includes('<<<<<<<'));
      if(leaveMarkers){write(h.cwd,'unrelated','does not resolve the conflict');return;}
      write(h.cwd,'shared','combined'); return;
    }
    await implement(h);
    if(h.id!=='S3')write(h.cwd,'shared',h.id);
  });
  const result=await core.evaluateNode(f.io);
  if(leaveMarkers){assert.deepEqual([result.status,result.fault?.code],['ACTIVE','NO_PROGRESS'],JSON.stringify(result));assert.equal(core.loadRoot(f.io,'G1').outcome,undefined);assert.equal(read(f.cwd,'shared'),'initial');return;}
  assert.equal(result.status,'PASS',JSON.stringify(result));
  assert.equal(read(f.cwd,'shared'),'combined'); assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,4);
  });
});

baseline('parallel: interruption, budget exhaustion, and worker failure preserve fresh proof, charged work, and the deadline', async t => {
  for(const mode of ['runner-error','worker-error','budget'])await t.test(mode,async t=>{
    const f=fixture(t,{policy:mode==='budget'?{maxTotalAttempts:1}:undefined}); await seal(f);
    const approved=core.loadRoot(f.io,'G1');
    let fail=true;
    const ordinary=f.io.exec;
    f.io.exec=async(command,options)=>{
      if(mode==='runner-error'&&fail){fail=false;return {exit:null,error:'runtime missing',errorCode:'RUNNER_ERROR'};}
      return ordinary(command,options);
    };
    backend(f,async h=>{
      await implement(h);
      if(mode==='worker-error'&&fail){fail=false;throw Object.assign(new Error('worker unavailable'),{code:'WORKER_FAILED'});}
    });
    let result=await core.evaluateNode(f.io);
    // Only an explicit budget needs the user; transient runner and worker faults retry once in place.
    if(mode==='budget') {
      assert.equal(result.status,'PAUSED',JSON.stringify(result));
      assert.equal(core.loadRoot(f.io,'G1').outcome,undefined);
      assert.equal(read(f.cwd,'first'),'pending','canonical candidate remains unchanged during speculative work');
      assert.equal(core.resumeRoot(f.io,{maxTotalAttempts:3}).ok,true);
      result=await core.evaluateNode(f.io);
    } else assert.match(result.warnings?.[0]??'',new RegExp(`^retried once after ${mode==='runner-error'?'RUNNER_ERROR':'WORKER_FAILED'}:`));
    assert.equal(result.status,'PASS',JSON.stringify(result));
    const root=core.loadRoot(f.io,'G1'); assert.equal(root.consumedAttempts,3);
    assert.equal(root.outcome.candidateDigest,core.digestTree(f.cwd));
    assert.equal(root.executionStartedAt,approved.executionStartedAt); assert.equal(root.deadlineAt,approved.deadlineAt);
  });
});

test('parallel: interrupted canonical reconciliation merges subsequent edits against the saved publication base', async t => {
  const f=fixture(t); await seal(f);
  let race=true;
  backend(f,async h=>{
    if(h.kind==='reconciliation') {
      write(h.cwd,'first','done');
      if(race){race=false;write(f.cwd,'later-note','preserve the edit made during reconciliation');}
      return;
    }
    await implement(h);
    if(h.id==='S3') {write(f.cwd,'first','user-first');write(f.cwd,'earlier-note','preserve this too');}
  });
  const result=await core.evaluateNode(f.io);
  assert.deepEqual([result.status,result.fault?.code],['ACTIVE','CANDIDATE_MUTATED'],JSON.stringify(result));
  assert.equal(core.loadRoot(f.io,'G1').outcome,undefined);
  const final=await core.evaluateNode(f.io);
  assert.equal(final.status,'PASS',JSON.stringify(final));
  assert.equal(read(f.cwd,'earlier-note'),'preserve this too');
  assert.equal(read(f.cwd,'later-note'),'preserve the edit made during reconciliation');
  assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,4);
});

test('parallel: synthetic Git candidates preserve ignored files, symlinks, modes, and literal unusual paths', async t => {
  const f=fixture(t,{files:{'.gitignore':'ignored\n',ignored:'present','quoted "name\nü':'literal bytes'},fileModes:{ignored:0o600},links:{link:'ignored'}});
  await seal(f);
  const root=core.loadRoot(f.io,'G1'), copy=path.join(root.execution.directory,'literal-copy');
  await materialize(root.execution.repo,root.execution.base,copy,f.io);
  assert.equal(core.digestTree(copy),core.digestTree(f.cwd));
  assert.equal(fs.statSync(path.join(copy,'ignored')).mode&0o777,0o600);
  assert.equal(fs.readlinkSync(path.join(copy,'link')),'ignored');
  write(copy,'new','artifact');
  const candidate=await captureCandidate(root.execution.repo,copy,[root.execution.base.tip],f.io);
  assert.equal(candidate.digest,core.digestTree(copy));
});

test('parallel: the last charged candidate can retry inconclusive proof without an additional attempt grant', async t => {
  const execution=[{id:'S1',objective:'Finish all three artifacts',verify:['C1','C2','C3']}];
  const f=fixture(t,{execution,policy:{maxTotalAttempts:1}}); await seal(f);
  backend(f,async h=>{for(const file of ['first','second','last'])write(h.cwd,file,'done');f.fault.run=true;});
  assert.equal((await core.evaluateNode(f.io)).fault?.code,'RUNNER_ERROR');
  assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,1);
  f.fault.run=false;
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,1);
});

const twoSlices = [
  {id:'S1',objective:'Finish the first artifact',verify:['C1']},
  {id:'S2',objective:'Finish the remaining artifacts',verify:['C2','C3']},
];
const finishTwo = async h => {
  if (h.kind === 'reconciliation') return implement(h);
  write(h.cwd,h.id === 'S1' ? 'first' : 'second','done');
  if (h.id === 'S2') write(h.cwd,'last','done');
};

baseline('parallel: focused workers, exact integration reuse, and unchanged publication need only three regression runs', async t => {
  const f=fixture(t,{execution:twoSlices}); await seal(f);
  const specs=[];
  backend(f,async h=>{specs.push(h);await finishTwo(h);});
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  for (const h of specs) {
    assert.equal(h.kind,'slice');
    assert.deepEqual(h.criteria.map(c=>c.id),h.id==='S1'?['C1']:['C2','C3']);
    assert.deepEqual(h.regressions,[{id:'R1',requirement:'Existing artifacts remain compatible'}]);
    assert.equal(JSON.stringify(h.regressions).includes('preserve'),false,'no regression recipe reaches workers');
  }
  const counts=Object.fromEntries(['observe:first','observe:second','observe:last','preserve'].map(command=>[command,f.calls.filter(c=>c.command===command).length]));
  assert.deepEqual(counts,{'observe:first':4,'observe:second':3,'observe:last':3,preserve:3});
  const root=core.loadRoot(f.io,'G1'), metrics=root.execution.metrics;
  assert.equal(metrics.evaluationRuns,5,'two worker, two integration, one canonical evaluation');
  assert.equal(metrics.proofReuseHits,2,'loop readiness and full integration reuse exact evidence');
  assert.equal(metrics.criteria.R1.runs,3);
  assert.equal(metrics.workerStarts,2); assert.equal(metrics.workerTurns,2);
  assert.equal(metrics.mergeCount,2); assert.equal(metrics.reconciliationTurns,0);
  assert.ok(metrics.totalMs>0); assert.ok(metrics.evaluationMs>0);
  assert.equal(root.outcome.runId,core.loadNodeState(f.io,'G1').lastResult.runId,'completion uses canonical evidence');
  assert.doesNotMatch(core.statusText(f.io),/execution metrics/);
  assert.match(core.statusText(f.io,{detail:'evidence'}),/G1 execution metrics/);
});

baseline('parallel: resumed invocations earn fresh integration proof instead of trusting persisted evidence', async t => {
  const f=fixture(t,{execution:twoSlices,policy:{maxParallelWorkers:1}}); await seal(f);
  let interrupt=true;
  backend(f,async h=>{
    await finishTwo(h);
    if(h.id==='S2'&&interrupt)throw Object.assign(Error('stop after first integration'),{code:'CANCELLED'});
  });
  const interrupted=await core.evaluateNode(f.io);
  assert.equal(interrupted.status,'ACTIVE',JSON.stringify(interrupted));
  const before=core.loadRoot(f.io,'G1');
  assert.equal(before.execution.slices.find(s=>s.id==='S1').status,'INTEGRATED');
  const runs=before.execution.metrics.criteria.R1.runs;
  // Retain the exact digest and its persisted passing evidence across recovery.
  interrupt=false; f.calls.length=0;
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  assert.equal(f.calls.filter(c=>c.command==='preserve'&&c.first==='done'&&c.second==='pending').length,1,'unchanged accepted integration receives fresh proof on resume');
  assert.equal(core.loadRoot(f.io,'G1').execution.metrics.criteria.R1.runs,runs+3);
});

baseline('parallel: a worker regression passes focused proof but must be repaired before integration or canonical PASS', async t => {
  const f=fixture(t,{execution:twoSlices}); await seal(f);
  let repairs=0;
  backend(f,async h=>{
    if(h.kind==='reconciliation') {
      repairs++; assert.ok(h.criteria.some(c=>c.id==='R1'));
      assert.equal(read(f.cwd,'stable'),'steady','unproved regression never reaches canonical');
      write(h.cwd,'stable','steady'); return;
    }
    await finishTwo(h); if(h.id==='S1')write(h.cwd,'stable','broken');
  });
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result)); assert.equal(repairs,1);
  assert.equal(read(f.cwd,'stable'),'steady');
  assert.equal(core.loadRoot(f.io,'G1').execution.metrics.reconciliationTurns,1);
});

baseline('parallel: concurrent canonical edits require an additional merged full proof before the one canonical evaluation', async t => {
  const f=fixture(t,{execution:twoSlices}); await seal(f);
  backend(f,async h=>{await finishTwo(h);if(h.id==='S1')write(f.cwd,'user-note','concurrent');});
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  const metrics=core.loadRoot(f.io,'G1').execution.metrics;
  assert.equal(metrics.mergeCount,3); assert.equal(metrics.evaluationRuns,6);
  assert.equal(metrics.criteria.R1.runs,4); assert.equal(read(f.cwd,'user-note'),'concurrent');
});

baseline('parallel: mutable dependencies retain fresh evaluations and execution metrics stay out of normal status', async t => {
  const f=fixture(t,{execution:twoSlices,files:{'package.json':'{"name":"fixture"}'}});
  f.args.mutableDependencies=true;
  assert.equal(core.draftNode(f.io,{...f.args,revise:'G1'}).ok,true);await seal(f);
  assert.doesNotMatch(core.statusText(f.io),/execution metrics/);
  assert.match(core.statusText(f.io,{detail:'evidence'}),/execution metrics/);
  backend(f,finishTwo);
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PASS',JSON.stringify(result));
  const metrics=core.loadRoot(f.io,'G1').execution.metrics;
  assert.equal(metrics.proofReuseHits,0); assert.equal(metrics.evaluationRuns,7);
  assert.equal(metrics.criteria.R1.runs,5,'loop and full integration prove fresh when reuse is disabled');
});


baseline('parallel: reuse requires exact bundle and environment identity plus all requested passing criteria', async t => {
  for (const identity of ['exact','different-bundle','different-environment']) await t.test(identity,async t=>{
    const f=fixture(t,{execution:twoSlices}), contract=f.drafted.draft;
    const environment=evaluatorEnvironment(f.cwd,f.io);
    const bundle={contract,env:environment,digest:'sealed-bundle',candidateDigest:core.digestTree(f.cwd)};
    const root={id:'G1',policy:core.DEFAULT_POLICY,consumedAttempts:0,deadlineAt:Date.now()+60000};
    root.execution=await createExecution(f.io,root,bundle);
    backend(f,finishTwo);
    const evaluations=[];let publications=0,completions=0;
    const result=await runExecution(f.io,root,bundle,{
      persist(){},
      async evaluate(cwd,ids){
        const wanted=ids??contract.criteria.map(c=>c.id);evaluations.push([...wanted]);
        return {candidateDigest:core.digestTree(cwd),bundleDigest:identity==='different-bundle'?'other-bundle':bundle.digest,
          environmentIdentity:identity==='different-environment'?'other-environment':digest(environment),
          outcomes:wanted.map(criterionId=>({criterionId,status:'PASS',durationMs:1})),allPass:true};
      },
      async apply(cwd,expected){publications++;assert.equal(expected,core.digestTree(f.cwd));assert.equal(read(cwd,'first'),'done');assert.equal(read(cwd,'second'),'done');},
      async complete(){completions++;return 'canonical completion';},
    });
    assert.equal(result,'canonical completion');assert.equal(publications,1);assert.equal(completions,1);
    assert.equal(root.execution.metrics.evaluationRuns,identity==='exact'?4:6);
    assert.equal(root.execution.metrics.proofReuseHits,identity==='exact'?2:0);
    assert.ok(evaluations.some(ids=>ids.includes('C1')&&ids.includes('R1')),'worker behavior coverage cannot replace integration regression proof');
    assert.ok(evaluations.some(ids=>['C1','C2','C3','R1'].every(id=>ids.includes(id))),'final integrated proof covers the full root');
  });
});
