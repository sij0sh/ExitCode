#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeIo, draftNode, prepareNode, approveRoot, sealNode, evaluateNode, loadNodeState } from '../exitcode-core.mjs';

import { structuralReview } from '../test/structural-review.mjs';

const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'exitcode-benchmark-'));
const behavior=(id,file)=>({id,requirement:`Complete ${file}`,check:{recipe:{kind:'file_contains',path:file,value:'done'}},controls:{accept:{mutations:[{kind:'write_file',path:file,content:'done'}]},reject:[{mutations:[{kind:'write_file',path:file,content:'pending'}]}]}});
try {
  for(const file of ['a','b'])fs.writeFileSync(path.join(cwd,file),'pending');
  const io=makeIo(cwd,{review:structuralReview}),criteria=[behavior('C1','a'),behavior('C2','b'),{id:'C3',requirement:'Keep a',type:'regression',check:{recipe:{kind:'file_exists',path:'a'}}}];
  const args={goal:'Complete both artifacts',criteria,intentAtoms:criteria.map(c=>({id:`I-${c.id}`,outcome:c.requirement,criteria:[c.id]})),policy:{evaluatorAttempts:6}};
  const draft=draftNode(io,args);if(!draft.ok)throw new Error(JSON.stringify(draft));
  const cold=await prepareNode(io,draft.id),warm=await prepareNode(io,draft.id);
  const changed=structuredClone(criteria);changed[0].check.recipe.value='complete';changed[0].controls.accept.mutations[0].content='complete';
  if(!draftNode(io,{...args,criteria:changed,revise:draft.id}).ok)throw new Error('revision failed');
  const selective=await prepareNode(io,draft.id);
  for(const result of [cold,warm,selective])if(!result.ok)throw new Error(JSON.stringify(result));
  if(!approveRoot(io,{userReply:'Benchmark fixture approval'}).ok||!(await sealNode(io,draft.id)).ok)throw new Error('seal failed');
  const start=Date.now();await evaluateNode(io);const fresh=loadNodeState(io,draft.id).lastResult.metrics;
  console.log(JSON.stringify({cold:cold.metrics,warm:warm.metrics,selective:selective.metrics,fresh:{...fresh,wallTimeMs:Date.now()-start}},null,2));
}finally{fs.rmSync(cwd,{recursive:true,force:true});}
