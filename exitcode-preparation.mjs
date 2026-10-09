import * as fs from 'node:fs';
import * as path from 'node:path';
import { callReview, validateCritic, criticInput } from './exitcode-quality.mjs';
import { BUILTIN_RECIPES, candidateIdentity, digest, diagnostic, inventory, applyMutations, auditCriteria, positiveWitness, lintEvaluators, scanCapabilities, fixtureDirectory, sandboxCommand, installEvaluatorAssets, verifyEvaluatorAssets } from './exitcode-evaluator.mjs';
import { ensureRunning, operationError } from './exitcode-operation.mjs';

export function emptyMetrics() {
  return { evaluatorProposals:0,e0Attempts:0,shellExecutions:0,probeExecutions:0,cacheHits:0,fixtureCopies:0,fixtureBytes:0,wallTimeMs:0,reviewCalls:0,reviewCompleted:0,transportRetries:0,diagnosticCounts:{},reviewTurns:0,tokenUsage:{available:false},peakConcurrency:0 };
}
export function addMetrics(total, step) {
  for(const k of ['evaluatorProposals','e0Attempts','shellExecutions','probeExecutions','cacheHits','fixtureCopies','fixtureBytes','wallTimeMs','reviewTurns','reviewCalls','reviewCompleted','transportRetries'])total[k]=(total[k]??0)+(step[k]??0);
  if(step.tokenUsage?.available){
    total.tokenUsage ??= {available:false};
    if(!total.tokenUsage.available)total.tokenUsage={available:true,input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])total.tokenUsage[k]+=step.tokenUsage[k]??0;
    for(const k of ['input','output','cacheRead','cacheWrite','total'])total.tokenUsage.cost[k]+=step.tokenUsage.cost?.[k]??0;
  }
  total.peakConcurrency=Math.max(total.peakConcurrency??0,step.peakConcurrency??0);
  total.diagnosticCounts??={};for(const [k,n] of Object.entries(step.diagnosticCounts??{}))total.diagnosticCounts[k]=(total.diagnosticCounts[k]??0)+n;
  return total;
}

// Each probe gets an independent reflink copy. Never hard-link writable fixtures.
export function copyCandidate(source, dest, maxBytes, signal, {deadlineAt,nowMs=Date.now,runtimeOnly=false}={}) {
  ensureRunning(signal,deadlineAt,nowMs);
  const files=inventory(source, {dependencies:true,signal,deadlineAt,nowMs}).filter(f=>!runtimeOnly || f.rel==='package.json' || f.rel.startsWith('node_modules/'));const bytes=files.reduce((n,f)=>n+(f.size??0),0);
  if(bytes>maxBytes)throw operationError('CAPACITY_UNAVAILABLE', `working tree exceeds snapshot cap (${maxBytes} bytes): ${bytes} bytes`);
  fs.mkdirSync(dest,{recursive:true});
  for(const f of files){ensureRunning(signal,deadlineAt,nowMs);const target=path.join(dest,f.rel);fs.mkdirSync(path.dirname(target),{recursive:true});if(f.link!==undefined){fs.symlinkSync(f.link,target);continue;}fs.copyFileSync(f.full,target,fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,f.mode);}
  return bytes;
}

const sessions=new Map();
function sessionFor(cwd, key, maxBytes, metrics, signal, options) {
  let session=sessions.get(cwd);
  if(session?.key===key&&fs.existsSync(session.base))return session;
  if(session)fs.rmSync(session.dir,{recursive:true,force:true});
  const dir=fixtureDirectory(cwd,'exitcode-base-'),base=path.join(dir,'candidate');
  try{metrics.fixtureBytes+=copyCandidate(cwd,base,maxBytes,signal,options);metrics.fixtureCopies++;}
  catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
  session={key,dir,base,probes:new Map()};sessions.set(cwd,session);
  if(sessions.size>8){const oldest=sessions.keys().next().value;const old=sessions.get(oldest);fs.rmSync(old.dir,{recursive:true,force:true});sessions.delete(oldest);}
  return session;
}
export function releasePreparation(cwd) {const s=sessions.get(cwd);if(s)fs.rmSync(s.dir,{recursive:true,force:true});sessions.delete(cwd);}
process.once('exit',()=>{for(const s of sessions.values())try{fs.rmSync(s.dir,{recursive:true,force:true});}catch{/* process is exiting */}});

/** Staged E0: deterministic mechanical validation, then a best-effort semantic critic. */
export async function prepareGate(draft, {cwd,exec,runCheck,defaultTimeoutMs,environment,maxBytes,candidateDigest,useCache=true,review,signal,reviewTimeoutMs,assets,assetsDirectory,onProgress,deadlineAt,nowMs=Date.now}) {
  ensureRunning(signal,deadlineAt,nowMs);
  const options={signal,deadlineAt,nowMs};
  const metrics=emptyMetrics(),stages=[],diagnostics=[],start=Date.now();metrics.e0Attempts=1;
  const finish=extra=>{
    metrics.wallTimeMs=Date.now()-start;
    for(const d of diagnostics)metrics.diagnosticCounts[d.code]=(metrics.diagnosticCounts[d.code]??0)+1;
    return {ok:!diagnostics.length,diagnostics,errors:diagnostics.map(d=>`${d.criterionId??'contract'}: ${d.code}: ${d.evidence}`),stages,metrics,...extra};
  };
  const report = (stage) => {ensureRunning(signal);onProgress?.({phase:'EVALUATOR_PREPARATION',stage,elapsedMs:Date.now()-start});};
  const boundaryDiagnostic = (e,stage) => {
    const code=e.code ?? 'IO_ERROR';
    return diagnostic(code,stage,null,e.message,'Repair the draft assets or authorized environment, or retry preparation',code==='CONTROL_SETUP_FAILED'?'agent':'supervisor');
  };
  const execute = async (command,runOptions) => {
    ensureRunning(signal,deadlineAt,nowMs);
    metrics.shellExecutions++;
    const timeoutMs=Number.isFinite(deadlineAt)?Math.min(runOptions.timeoutMs,deadlineAt-nowMs()):runOptions.timeoutMs;
    const run=await exec(command,{...runOptions,timeoutMs,signal,deadlineAt,nowMs});
    ensureRunning(signal,deadlineAt,nowMs);
    return run;
  };
  report('intent');
  diagnostics.push(...auditCriteria(draft.criteria, draft.outcomes));stages.push({stage:'intent',ok:!diagnostics.length});
  if(diagnostics.length)return finish();
  let capabilities;
  try{capabilities=scanCapabilities(cwd);diagnostics.push(...lintEvaluators(draft,cwd,capabilities));}
  catch(e){diagnostics.push(boundaryDiagnostic(e,'lint'));}
  stages.push({stage:'lint',ok:!diagnostics.length});if(diagnostics.length)return finish();
  let session;
  const identity=digest({candidateDigest,environment});
  try {
    report('preflight');
    session=sessionFor(cwd,identity,maxBytes,metrics,signal,options);
    if(candidateIdentity(session.base,options)!==candidateDigest)throw operationError('CANDIDATE_MUTATED','Candidate changed while copying preparation base');
    if(exec===sandboxCommand && draft.criteria.some(c=>!BUILTIN_RECIPES.includes(c.check.recipe.kind))) {
      const runtime=await execute('true',{cwd:session.base,timeoutMs:defaultTimeoutMs,signal});
      if(runtime.error || runtime.timedOut || runtime.exit!==0)throw operationError(runtime.errorCode ?? 'ISOLATION_UNAVAILABLE',runtime.error ?? runtime.stderr ?? 'isolated runtime unavailable');
    }
  } catch(e) {releasePreparation(cwd);diagnostics.push(boundaryDiagnostic(e,'preflight'));return finish();}
  const behaviors=draft.criteria.filter(c=>(c.type??'behavior')==='behavior');
  const regressions=draft.criteria.filter(c=>c.type==='regression');
  const witnesses=new Map(behaviors.map(c=>[c.id,positiveWitness(c)]));
  let active=0;
  const jobs=[];
  const queue=(criterion,stage,control,expected,label)=>{
    jobs.push(async()=>{
      ensureRunning(signal);
      const key=digest({criterion,stage,control,expected,label,assets:assets?.digest});
      const cacheable=BUILTIN_RECIPES.includes(criterion.check.recipe.kind);
      if(useCache&&cacheable&&session.probes.has(key)){metrics.cacheHits++;return session.probes.get(key);}
      active++;metrics.peakConcurrency=Math.max(metrics.peakConcurrency,active);
      let fixture;
      const result={criterionId:criterion.id,stage,label,expected};
      try{
        fixture=fixtureDirectory(cwd,'exitcode-probe-');
        if(stage!=='wiring'){metrics.fixtureBytes+=copyCandidate(session.base,fixture,maxBytes,signal,options);metrics.fixtureCopies++;}
        if(control?.mutations)await applyMutations(fixture,control.mutations,{assetsDirectory,assets});
        const authoredCommand = criterion.check.recipe.kind==='test_asset' ||
          ['command_exit','custom_command'].includes(criterion.check.recipe.kind) && assets?.files.some(f=>f.owner==='supervisor');
        if (stage==='wiring' && authoredCommand && assets) {
          metrics.fixtureBytes+=copyCandidate(session.base,fixture,maxBytes,signal,{...options,runtimeOnly:true});metrics.fixtureCopies++;
          installEvaluatorAssets(fixture,assetsDirectory,assets,{ownedOnly:true});
        } else if(assets && stage!=='wiring')installEvaluatorAssets(fixture,assetsDirectory,assets);
        result.fixtureDigest=candidateIdentity(fixture,options);
        metrics.probeExecutions++;
        result.outcome=await runCheck(criterion,exec,fixture,defaultTimeoutMs,{signal,capabilities,readOnlyPaths:assets?.readOnlyPaths,onExecution:()=>metrics.shellExecutions++});
        if(stage!=='wiring' && assets)verifyEvaluatorAssets(fixture,assetsDirectory,assets,{installed:true});
      }catch(e){result.error=e.message;result.errorCode=e.code;}
      finally{if(fixture)fs.rmSync(fixture,{recursive:true,force:true});active--;}
      // Cache only completed discriminating evidence. Errors and flakes are retried.
      if(cacheable&&!result.error&&result.outcome?.status!=='ERROR'&&(expected==='ANY'||expected==='NOT_PASS'&&result.outcome.status!=='PASS'||result.outcome.status===expected)&&session.probes.size<2048)session.probes.set(key,result);
      return result;
    });
  };
  for(const c of draft.criteria){
    if((c.type??'behavior')==='behavior'){
      const accept=witnesses.get(c.id).control;
      queue(c,'discrimination',accept,'PASS','accept');
      for(const [i,control]of (c.controls?.reject??[]).entries())queue(c,'discrimination',control,'FAIL',`reject:${i}`);
      // Repeat the valid fixture independently. This includes custom commands.
      queue(c,'determinism',accept,'PASS','accept-repeat');
      // Supervisor-generated negatives for built-in recipes.
      const r=c.check.recipe;
      if(r.path&&BUILTIN_RECIPES.includes(r.kind)){
        queue(c,'adversarial',{mutations:[{kind:'delete_file',path:r.path}]},'FAIL','delete-target');
        if(r.kind==='file_contains')queue(c,'adversarial',{mutations:[{kind:'write_file',path:r.path,content:`unrelated-${digest(r.value).slice(0,8)}`}]},'FAIL','unrelated-content');
        if(r.kind==='file_not_contains')queue(c,'adversarial',{mutations:[{kind:'write_file',path:r.path,content:r.value}]},'FAIL','forbidden-content');
        if(r.kind==='json_value')queue(c,'adversarial',{mutations:[{kind:'write_file',path:r.path,content:'{invalid'}]},'FAIL','invalid-json');
      }
      // Regression-on-witness: the behavior witness must not inherently violate protected behavior.
      if(accept?.mutations)for(const reg of regressions)queue(reg,'regression-witness',accept,'PASS',`witness:${c.id}`);
    }
    queue(c,'wiring',null,'NOT_PASS','empty-target');
    queue(c,'baseline',null,'ANY','candidate');
  }
  const results=new Array(jobs.length);let next=0;
  await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(next<jobs.length){if(signal?.aborted)break;const i=next++;results[i]=await jobs[i]();}}));
  if(signal?.aborted)diagnostics.push(diagnostic(signal.reason?.code??'CANCELLED','preparation',null,'Operation stopped during preparation','Resume with authorized remaining budget','supervisor'));
  else report('probes-complete');
  const completed=results.filter(Boolean);
  // Without a passing positive witness, repeat failures are consequences, not separate defects.
  const unwitnessed=new Set(completed.filter(r=>r.label==='accept'&&r.outcome?.status!=='PASS').map(r=>r.criterionId));
  for(const stage of ['discrimination','adversarial','determinism','wiring','regression-witness','baseline']){
    const probes=completed.filter(r=>r.stage===stage);
    for(const r of probes){
      if(stage==='determinism'&&unwitnessed.has(r.criterionId))continue;
      if(r.error)diagnostics.push(diagnostic(r.errorCode ?? 'CONTROL_SETUP_FAILED',stage,r.criterionId,r.error,'Restore the fixture runtime or correct the confined control setup',r.errorCode && !['CONTROL_SETUP_FAILED','EVALUATOR_DRIFT'].includes(r.errorCode)?'supervisor':'agent'));
      else if(r.outcome.status==='ERROR')diagnostics.push(diagnostic(r.outcome.errorCode ?? 'RUNNER_ERROR',stage,r.criterionId,r.outcome.reasons.join('; '),'Restore isolated execution and resume', 'supervisor'));
      else if(stage==='baseline'){}
      else if((r.expected==='NOT_PASS'&&r.outcome.status==='PASS')||(r.expected!=='NOT_PASS'&&r.outcome.status!==r.expected)){
        const baselineWitness=r.label==='accept'&&witnesses.get(r.criterionId)?.source==='baseline';
        const code=stage==='wiring'?'EMPTY_TARGET_PASS':stage==='determinism'?'NONDETERMINISTIC':stage==='regression-witness'?'REGRESSION_ON_WITNESS':baselineWitness?'POSITIVE_WITNESS_REQUIRED':r.label==='accept'?'ACCEPT_NOT_DISCRIMINATED':'REJECT_NOT_DISCRIMINATED';
        diagnostics.push(diagnostic(code,stage,r.criterionId,`${r.label}: ${r.outcome.status}, expected ${r.expected}; ${r.outcome.reasons.join('; ')}`,
          baselineWitness?'The check does not pass on the current candidate; supply controls.accept as a minimal positive witness'
          :code==='REGRESSION_ON_WITNESS'?'The behavior witness inherently violates protected existing behavior; narrow the witness or the regression scope'
          :'Repair the evaluator or fixture, not the real candidate'));
      }
    }
    stages.push({stage,ok:!diagnostics.some(d=>d.stage===stage),probes});
  }
  for(const c of draft.criteria){
    const accept=completed.find(r=>r.criterionId===c.id&&r.stage==='discrimination'&&r.label==='accept');
    for(const reject of completed.filter(r=>r.criterionId===c.id&&r.stage==='discrimination'&&r.label.startsWith('reject:')))
      if(accept?.fixtureDigest&&accept.fixtureDigest===reject.fixtureDigest&&!diagnostics.some(d=>d.criterionId===c.id&&d.code==='REJECT_NOT_DISCRIMINATED'))diagnostics.push(diagnostic('REJECT_NOT_DISCRIMINATED','discrimination',c.id,'Accept and reject fixtures have identical content','Make fixture mutations meaningful'));
    const repeat=completed.find(r=>r.criterionId===c.id&&r.stage==='determinism');
    if(accept?.outcome&&repeat?.outcome&&digest({status:accept.outcome.status,exit:accept.outcome.exit})!==digest({status:repeat.outcome.status,exit:repeat.outcome.exit}))diagnostics.push(diagnostic('NONDETERMINISTIC','determinism',c.id,'Repeated fixture produced inconsistent outcomes','Remove time, random, or external state from evidence'));
  }
  // Negative discrimination hierarchy: baseline failure, deterministic built-in
  // negative, or agent-authored explicit reject. One suffices.
  if(!diagnostics.length)for(const c of behaviors){
    const baseline=completed.find(r=>r.criterionId===c.id&&r.stage==='baseline');
    const builtin=BUILTIN_RECIPES.includes(c.check.recipe.kind);
    const rejected=(c.controls?.reject??[]).length>0;
    if(!(baseline?.outcome?.status==='FAIL'||builtin||rejected))
      diagnostics.push(diagnostic('NEGATIVE_EVIDENCE_MISSING','discrimination',c.id,'No baseline failure, built-in negative, or explicit reject challenges this check','Supply one minimal controls.reject witness for behavior the baseline already satisfies'));
  }
  // Existing behavior must pass its real baseline.
  if(!diagnostics.length)for(const c of regressions){
    const baseline=completed.find(r=>r.criterionId===c.id&&r.stage==='baseline');
    if(baseline?.outcome?.status==='FAIL')
      diagnostics.push(diagnostic('REGRESSION_BASELINE_FAIL','baseline',c.id,'Regression check fails on the real baseline','Protect behavior the baseline already satisfies, or repair the baseline first'));
  }
  if(!signal?.aborted && assets){try{verifyEvaluatorAssets(cwd,assetsDirectory,assets);}catch(e){diagnostics.push(boundaryDiagnostic(e,'baseline'));}}
  if(!signal?.aborted && candidateIdentity(cwd,options)!==candidateDigest)diagnostics.push(diagnostic('CANDIDATE_MUTATED','baseline',null,'Candidate changed during preparation','Reprepare against stable candidate','supervisor'));
  // Best-effort semantic critic, off the mechanical critical path. Transport,
  // validation, or availability failures never block deterministic evidence.
  // Cancellation still aborts preparation.
  let criticStatus='unavailable';
  if(!signal?.aborted && typeof review === 'function'){
    try{
      report('critic');metrics.reviewCalls++;
      const response=await callReview(review,criticInput({...draft,parentRequirement:draft.parentRequirement},cwd),{signal,timeoutMs:reviewTimeoutMs});
      metrics.reviewCompleted++;
      const concerns=validateCritic(response);
      if(concerns.length){diagnostics.push(...concerns);criticStatus='concerns';}
      else criticStatus='pass';
    }catch(e){
      if(signal?.aborted||['CANCELLED','DEADLINE_EXCEEDED'].includes(e.code??signal?.reason?.code)){
        diagnostics.push(diagnostic(signal?.reason?.code??e.code??'CANCELLED','preparation',null,e.message,'Resume with authorized remaining budget','supervisor'));
      }else stages.push({stage:'critic-transport',code:e.code??'REVIEW_UNAVAILABLE',evidence:e.message});
      criticStatus='unavailable';
    }
  }
  stages.push({stage:'critic',status:criticStatus,ok:!diagnostics.some(d=>d.stage==='critic')});
  const outcomes=completed.filter(r=>r.stage==='baseline').map(r=>r.outcome).filter(Boolean);
  return finish({capabilities,baseline:{outcomes,allPass:outcomes.length>0&&outcomes.every(o=>o.status==='PASS'),at:new Date().toISOString(),candidateDigest}});
}
