import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callReview, reviewRepository, validateDerivation, validateAssessment } from './exitcode-quality.mjs';
import { candidateIdentity, digest, diagnostic, inventory, applyMutations, auditIntent, lintEvaluators, scanCapabilities } from './exitcode-evaluator.mjs';

export function emptyMetrics() {
  return { evaluatorProposals:0,e0Attempts:0,shellExecutions:0,probeExecutions:0,cacheHits:0,fixtureCopies:0,fixtureBytes:0,wallTimeMs:0,diagnosticCounts:{},reviewTurns:0,tokenUsage:{available:false},peakConcurrency:0 };
}
export function addMetrics(total, step) {
  for(const k of ['evaluatorProposals','e0Attempts','shellExecutions','probeExecutions','cacheHits','fixtureCopies','fixtureBytes','wallTimeMs','reviewTurns'])total[k]=(total[k]??0)+(step[k]??0);
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
export function copyCandidate(source, dest, maxBytes) {
  const files=inventory(source);const bytes=files.reduce((n,f)=>n+(f.size??0),0);
  if(bytes>maxBytes)throw new Error(`working tree exceeds snapshot cap (${maxBytes} bytes): ${bytes} bytes`);
  fs.mkdirSync(dest,{recursive:true});
  for(const f of files){const target=path.join(dest,f.rel);fs.mkdirSync(path.dirname(target),{recursive:true});if(f.link!==undefined){fs.symlinkSync(f.link,target);continue;}fs.copyFileSync(f.full,target,fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,f.mode);}
  return bytes;
}

const sessions=new Map();
function sessionFor(cwd, key, maxBytes, metrics) {
  let session=sessions.get(cwd);
  if(session?.key===key&&fs.existsSync(session.base))return session;
  if(session)fs.rmSync(session.dir,{recursive:true,force:true});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exitcode-base-')),base=path.join(dir,'candidate');
  try{metrics.fixtureBytes+=copyCandidate(cwd,base,maxBytes);metrics.fixtureCopies++;}
  catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
  // Dependencies are copied once, then separately read-only mounted in fixtures.
  const deps=path.join(cwd,'node_modules');
  if(fs.existsSync(deps))fs.cpSync(deps,path.join(base,'node_modules'),{recursive:true,dereference:false});
  session={key,dir,base,probes:new Map()};sessions.set(cwd,session);
  if(sessions.size>8){const oldest=sessions.keys().next().value;const old=sessions.get(oldest);fs.rmSync(old.dir,{recursive:true,force:true});sessions.delete(oldest);}
  return session;
}
export function releasePreparation(cwd) {const s=sessions.get(cwd);if(s)fs.rmSync(s.dir,{recursive:true,force:true});sessions.delete(cwd);}
process.once('exit',()=>{for(const s of sessions.values())try{fs.rmSync(s.dir,{recursive:true,force:true});}catch{/* process is exiting */}});

/** Staged E0. cache is development-only; fresh evaluation never calls this. */
export async function prepareGate(draft, {cwd,exec,runCheck,defaultTimeoutMs,environment,maxBytes,candidateDigest,useCache=true,review,signal,reviewTimeoutMs}) {
  const metrics=emptyMetrics(),stages=[],diagnostics=[],start=Date.now();metrics.e0Attempts=1;
  const finish=extra=>{
    metrics.wallTimeMs=Date.now()-start;
    for(const d of diagnostics)metrics.diagnosticCounts[d.code]=(metrics.diagnosticCounts[d.code]??0)+1;
    return {ok:!diagnostics.length,diagnostics,errors:diagnostics.map(d=>`${d.criterionId??'contract'}: ${d.code}: ${d.evidence}`),stages,metrics,...extra};
  };
  const audit=auditIntent(draft);stages.push({stage:'intent',ok:audit.ok,coverage:audit.coverage});diagnostics.push(...audit.diagnostics);
  if(audit.questions.length)return finish({ok:false,questions:audit.questions,phase:'CLARIFICATION'});
  if(diagnostics.length)return finish();
  let capabilities;
  try{capabilities=scanCapabilities(cwd);diagnostics.push(...lintEvaluators(draft,cwd,capabilities));}
  catch(e){diagnostics.push(diagnostic('UNSAFE_COMMAND','lint',null,e.message,'Correct candidate paths or discovery inputs'));}
  stages.push({stage:'lint',ok:!diagnostics.length});if(diagnostics.length)return finish();
  let derived, assessed;
  try {
    const requirements=draft.criteria.map(c=>({id:c.id,requirement:c.requirement,type:c.type??'behavior'}));
    derived=await callReview(review,{phase:'derive',originalRequest:draft.originalRequest,
      criteria:requirements,assumptions:draft.assumptions,exclusions:draft.exclusions,repository:reviewRepository(cwd,capabilities,requirements),
      ...(draft.parent?{scope:draft.parent,parentRequirement:draft.parentRequirement,goal:draft.goal}:{} )},
      {signal,timeoutMs:reviewTimeoutMs});
    diagnostics.push(...validateDerivation(derived,draft.criteria));
  } catch(e) {diagnostics.push(diagnostic('REVIEW_FAILED','quality',null,e.message,'Supply a working independent reviewer and valid bounded evidence'));}
  stages.push({stage:'quality-derive',ok:!diagnostics.length,derived});
  if(diagnostics.length)return finish();
  let session;
  const identity=digest({candidateDigest,environment});
  try{session=sessionFor(cwd,identity,maxBytes,metrics);}
  catch(e){diagnostics.push(diagnostic('CONTROL_SETUP_FAILED','discrimination',null,e.message,'Reduce snapshot size or supply readable candidate files'));return finish();}
  const validFixtures=[];
  try {
    for(const c of draft.criteria.filter(c=>(c.type??'behavior')==='behavior')){
      const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'exitcode-valid-'));
      try {
        metrics.fixtureBytes+=copyCandidate(session.base,fixture,maxBytes);metrics.fixtureCopies++;
        if(fs.existsSync(path.join(session.base,'node_modules')))fs.cpSync(path.join(session.base,'node_modules'),path.join(fixture,'node_modules'),{recursive:true});
        if(c.controls.accept.mutations)await applyMutations(fixture,c.controls.accept.mutations);
        if(c.controls.accept.setup){metrics.shellExecutions++;const r=await exec(c.controls.accept.setup,{cwd:fixture,timeoutMs:defaultTimeoutMs,writable:true});if(r.exit!==0||r.error||r.timedOut)throw Error(`accept setup failed for ${c.id}`);}
        validFixtures.push({criterionId:c.id,repository:reviewRepository(fixture,scanCapabilities(fixture),[c])});
      } finally {fs.rmSync(fixture,{recursive:true,force:true});}
    }
    assessed=await callReview(review,{phase:'assess',originalRequest:draft.originalRequest,derived,
      criteria:draft.criteria,repository:reviewRepository(cwd,capabilities,draft.criteria),validFixtures,
      ...(draft.parent?{scope:draft.parent,parentRequirement:draft.parentRequirement,goal:draft.goal}:{} )},
      {signal,timeoutMs:reviewTimeoutMs});
    diagnostics.push(...validateAssessment(assessed,derived,draft.criteria,cwd));
  }catch(e){diagnostics.push(diagnostic('REVIEW_FAILED','quality',null,e.message,'Repair independent assessment or confined valid fixtures'));}
  stages.push({stage:'quality-assess',ok:!diagnostics.length,assessed});
  if(diagnostics.length)return finish();
  let active=0;
  const jobs=[];
  const queue=(criterion,stage,control,expected,label)=>{
    jobs.push(async()=>{
      const key=digest({criterion,stage,control,expected,label});
      const cacheable=Boolean(criterion.check.recipe && ['file_exists','file_contains','file_not_contains','json_value'].includes(criterion.check.recipe.kind) && !control?.setup);
      if(useCache&&cacheable&&session.probes.has(key)){metrics.cacheHits++;return session.probes.get(key);}
      active++;metrics.peakConcurrency=Math.max(metrics.peakConcurrency,active);
      const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'exitcode-probe-'));
      const trackedExec=async(command,options)=>{metrics.shellExecutions++;return exec(command,options);};
      const result={criterionId:criterion.id,stage,label,expected};
      try{
        if(stage!=='wiring'){metrics.fixtureBytes+=copyCandidate(session.base,fixture,maxBytes);metrics.fixtureCopies++;
          if(fs.existsSync(path.join(session.base,'node_modules')))fs.cpSync(path.join(session.base,'node_modules'),path.join(fixture,'node_modules'),{recursive:true});}
        if(control?.mutations)await applyMutations(fixture,control.mutations);
        if(control?.setup){const setup=await trackedExec(control.setup,{cwd:fixture,timeoutMs:defaultTimeoutMs,writable:true});if(setup.exit!==0||setup.error||setup.timedOut)throw new Error(`setup failed: ${setup.error??setup.stderr??setup.exit}`);}
        if(stage==='sham'){
          metrics.probeExecutions++;
          const valid=await runCheck(criterion,trackedExec,fixture,defaultTimeoutMs);
          if(valid.status!=='PASS')throw Error(`sham base is not valid: ${valid.status}`);
          const before=candidateIdentity(fixture);
          await applyMutations(fixture,control.sham);
          if(before===candidateIdentity(fixture))throw Error('sham makes no candidate change');
        }
        result.fixtureDigest=candidateIdentity(fixture);
        metrics.probeExecutions++;
        result.outcome=await runCheck(criterion,trackedExec,fixture,defaultTimeoutMs);
      }catch(e){result.error=e.message;}
      finally{fs.rmSync(fixture,{recursive:true,force:true});active--;}
      // Cache only completed discriminating evidence. Errors and flakes are retried.
      if(cacheable&&!result.error&&result.outcome?.status!=='ERROR'&&(expected==='ANY'||expected==='NOT_PASS'&&result.outcome.status!=='PASS'||result.outcome.status===expected)&&session.probes.size<2048)session.probes.set(key,result);
      return result;
    });
  };
  for(const c of draft.criteria){
    if((c.type??'behavior')==='behavior'){
      queue(c,'discrimination',c.controls.accept,'PASS','accept');
      for(const [i,control]of c.controls.reject.entries())queue(c,'discrimination',control,'FAIL',`reject:${i}`);
      for(const sham of assessed.criteria.find(a=>a.criterionId===c.id).shams)
        queue(c,'sham',{...c.controls.accept,sham:sham.mutations},'FAIL',sham.id);
      // Repeat the valid fixture independently. This includes custom commands.
      queue(c,'determinism',c.controls.accept,'PASS','accept-repeat');
      // Bounded independent defects beyond the author's reject fixture.
      const r=c.check.recipe;
      if(r?.path&&['file_exists','file_contains','file_not_contains','json_value'].includes(r.kind)){
        queue(c,'adversarial',{mutations:[{kind:'delete_file',path:r.path}]},'FAIL','delete-target');
        if(r.kind==='file_contains')queue(c,'adversarial',{mutations:[{kind:'write_file',path:r.path,content:`unrelated-${digest(r.value).slice(0,8)}`}]},'FAIL','unrelated-content');
        if(r.kind==='file_not_contains')queue(c,'adversarial',{mutations:[{kind:'write_file',path:r.path,content:r.value}]},'FAIL','forbidden-content');
        if(r.kind==='json_value')queue(c,'adversarial',{mutations:[{kind:'write_file',path:r.path,content:'{invalid'}]},'FAIL','invalid-json');
      }
    }
    queue(c,'wiring',null,'NOT_PASS','empty-target');
    queue(c,'baseline',null,'ANY','candidate');
  }
  const results=new Array(jobs.length);let next=0;
  await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(next<jobs.length){const i=next++;results[i]=await jobs[i]();}}));
  for(const stage of ['discrimination','sham','adversarial','determinism','wiring','baseline']){
    const probes=results.filter(r=>r.stage===stage);
    for(const r of probes){
      if(r.error)diagnostics.push(diagnostic(stage==='sham'?'SHAM_INVALID':'CONTROL_SETUP_FAILED',stage,r.criterionId,r.error,'Correct the confined control setup'));
      else if(stage==='baseline'){if(r.outcome.status==='ERROR')diagnostics.push(diagnostic('RUNNER_NOT_FOUND',stage,r.criterionId,r.outcome.reasons.join('; '),'Provide an available isolated runtime'));}
      else if((r.expected==='NOT_PASS'&&r.outcome.status==='PASS')||(r.expected!=='NOT_PASS'&&r.outcome.status!==r.expected)){
        const code=stage==='sham'?(r.outcome.status==='ERROR'?'SHAM_INVALID':'SHAM_SURVIVED'):stage==='wiring'?'EMPTY_TARGET_PASS':stage==='determinism'?'NONDETERMINISTIC':r.label==='accept'?'ACCEPT_NOT_DISCRIMINATED':'REJECT_NOT_DISCRIMINATED';
        diagnostics.push(diagnostic(code,stage,r.criterionId,`${r.label}: ${r.outcome.status}, expected ${r.expected}; ${r.outcome.reasons.join('; ')}`,'Repair the evaluator or fixture, not the real candidate'));
      }
    }
    stages.push({stage,ok:!diagnostics.some(d=>d.stage===stage),probes});
  }
  for(const c of draft.criteria){
    const accept=results.find(r=>r.criterionId===c.id&&r.stage==='discrimination'&&r.label==='accept');
    for(const reject of results.filter(r=>r.criterionId===c.id&&r.stage==='discrimination'&&r.label.startsWith('reject:')))
      if(accept?.fixtureDigest&&accept.fixtureDigest===reject.fixtureDigest&&!diagnostics.some(d=>d.criterionId===c.id&&d.code==='REJECT_NOT_DISCRIMINATED'))diagnostics.push(diagnostic('REJECT_NOT_DISCRIMINATED','discrimination',c.id,'Accept and reject fixtures have identical content','Make fixture mutations meaningful'));
    const repeat=results.find(r=>r.criterionId===c.id&&r.stage==='determinism');
    const compareOutput=!c.check.recipe || c.check.recipe.kind==='custom_command';
    if(accept?.outcome&&repeat?.outcome&&digest({status:accept.outcome.status,exit:accept.outcome.exit,stdout:compareOutput?accept.outcome.stdoutTail:undefined})!==digest({status:repeat.outcome.status,exit:repeat.outcome.exit,stdout:compareOutput?repeat.outcome.stdoutTail:undefined}))diagnostics.push(diagnostic('NONDETERMINISTIC','determinism',c.id,'Repeated fixture produced inconsistent outcomes','Remove time, random, or external state from evidence'));
  }
  if(signal?.aborted)diagnostics.push(diagnostic('REVIEW_CANCELLED','quality',null,'Operation cancelled during preparation','Reprepare after cancellation'));
  if(candidateIdentity(cwd)!==candidateDigest)diagnostics.push(diagnostic('CANDIDATE_MUTATED','baseline',null,'Candidate changed during preparation','Reprepare against stable candidate'));
  const outcomes=results.filter(r=>r.stage==='baseline').map(r=>r.outcome).filter(Boolean);
  return finish({capabilities,baseline:{outcomes,allPass:outcomes.length>0&&outcomes.every(o=>o.status==='PASS'),at:new Date().toISOString(),candidateDigest}});
}
