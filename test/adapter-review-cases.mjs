import {structuralReview} from './structural-review.mjs';
export function reviewRegistry(mode='success') {
  const calls=[];
  const usage={input:11,output:7,cacheRead:0,cacheWrite:0,totalTokens:18,cost:{input:0.1,output:0.1,cacheRead:0,cacheWrite:0,total:0.2}};
  return {calls,streamSimple(model,context,options){
    const input=JSON.parse(context.messages[0].content);calls.push({model,context,options,input});
    return {async result(){
      if(mode==='cancel'){options.signal.addEventListener('abort',()=>{}, {once:true});return new Promise(()=>{});}
      if(mode==='error')return {stopReason:'error',errorMessage:'provider unavailable',content:[],usage};
      const data=await structuralReview(input);
      if(mode==='malformed')data.criteria=[];
      return {stopReason:mode==='length'?'length':'stop',usage,
        content:[{type:'text',text:mode==='invalid-json'?'not JSON':JSON.stringify(data)}]};
    }};
  }};
}
