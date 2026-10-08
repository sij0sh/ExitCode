/** Deterministic reviewer for existing supervisor tests' literal artifact fixtures.
 * Not a production fallback. Semantic tests supply independent scenario responses.
 */
export async function structuralReview(input) {
  const behavior=input.criteria.filter(c=>(c.type??'behavior')==='behavior');
  if(input.phase==='derive')return {
    outcomes:input.criteria.map(c=>({id:`I-${c.id}`,outcome:c.requirement,criteria:[c.id]})),
    criteria:behavior.map(c=>({criterionId:c.id,artifactOnly:true,
      observation:'Observe literal content in this supervisor test fixture',nearMisses:[],
      negative:{required:false,reason:'This fixture has no behavioral inputs'},
      regression:{required:false,reason:'Recursion fixtures can be independently structural'},
      reuse:{reason:'These tests exercise supervisor mechanics with literal artifacts'}})),
  };
  return {criteria:behavior.map(c=>({criterionId:c.id,outcomeObserved:true,
    structuralJustification:'The test fixture models literal artifact content, not application behavior',
    negativeCovered:true,regressionCriteria:input.criteria.filter(c=>c.type==='regression').map(c=>c.id),
    reuseReason:'Reuse the existing supervisor test fixtures',shams:[]})),issues:[]};
}
export function structuralRegistry() {
  return {streamSimple(_model,context){return {async result(){return {
    stopReason:'stop',content:[{type:'text',text:JSON.stringify(await structuralReview(JSON.parse(context.messages[0].content)))}],
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  };}};}};
}
