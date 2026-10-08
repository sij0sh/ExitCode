/** Deterministic reviewer for existing supervisor tests' literal artifact fixtures.
 * Not a production fallback. Semantic tests supply independent scenario responses.
 */
export async function structuralReview(input) {
  const behavior=input.criteria.filter(c=>(c.type??'behavior')==='behavior');
  if(input.phase==='derive')return {uncovered:[],
    criteria:behavior.map(c=>({criterionId:c.id,structural:true,observation:'Observe literal content in this supervisor test fixture',nearMisses:[]}))};
  return {criteria:behavior.map(c=>({criterionId:c.id,outcomeObserved:true,shams:[]})),issues:[]};
}
export function structuralRegistry() {
  return {streamSimple(_model,context){return {async result(){return {
    stopReason:'stop',content:[{type:'text',text:JSON.stringify(await structuralReview(JSON.parse(context.messages[0].content)))}],
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  };}};}};
}
