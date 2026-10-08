import {structuralReview} from './structural-review.mjs';
export function reviewRegistry(mode='success') {
  const calls=[];
  const usage={input:11,output:7,cacheRead:0,cacheWrite:0,totalTokens:18,cost:{input:0.1,output:0.1,cacheRead:0,cacheWrite:0,total:0.2}};
  return {calls,streamSimple(model,context,options){
    const input=JSON.parse(context.messages[0].content);calls.push({model,context,options,input});
    return {async result(){
      if(mode==='cancel'){options.signal.addEventListener('abort',()=>{}, {once:true});return new Promise(()=>{});}
      if(mode==='error')return {stopReason:'error',errorMessage:'provider unavailable',content:[],usage};
      // Request-shape incompatibility (400) versus real provider authority failures (401).
      if(mode==='reject-all'||mode==='reject-constrained'&&context.tools?.[0]?.constrainedSampling)
        return {stopReason:'error',errorMessage:'400 Bad Request: unsupported request option',content:[],usage};
      if(mode==='unauthorized')return {stopReason:'error',errorMessage:'401 Unauthorized',content:[],usage};
      const data=await structuralReview(input);
      if(mode==='malformed'||mode==='tool-malformed')data.criteria=[];
      if(mode==='tool-call'||mode==='tool-malformed'||mode==='reject-constrained'&&context.tools)
        return {stopReason:'toolUse',usage,content:[{type:'toolCall',id:'call-1',name:'submit_review',arguments:data}]};
      if(mode==='wrong-tool')
        return {stopReason:'toolUse',usage,content:[{type:'toolCall',id:'call-1',name:'other_tool',arguments:data}]};
      const text=mode==='invalid-json'?'not JSON'
        :mode==='markdown'?'Here is the requested review:\n\n```json\n'+JSON.stringify(data)+'\n```'
        :mode==='prose'?JSON.stringify(data)+'\n\nHope this helps.'
        :JSON.stringify(data);
      const length=mode==='length' || mode==='length-once' && calls.filter(c=>c.input.phase===input.phase).length===1;
      return {stopReason:length?'length':'stop',usage,content:[{type:'text',text}]};
    }};
  }};
}
