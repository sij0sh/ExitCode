/** Deterministic critic for supervisor tests. Approves the intent contract.
 * Not a production fallback. Semantic tests supply scenario responses.
 */
export async function structuralReview(input) {
  if (input.phase !== 'critic') throw Object.assign(new Error(`unknown review phase: ${input.phase}`), { code: 'REVIEW_RESPONSE_INVALID' });
  return { concerns: [] };
}
export function structuralRegistry() {
  return {streamSimple(_model,context){return {async result(){return {
    stopReason:'stop',content:[{type:'text',text:JSON.stringify(await structuralReview(JSON.parse(context.messages[0].content)))}],
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  };}};}};
}
