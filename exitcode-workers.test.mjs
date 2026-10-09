/** SDK session ownership, feedback, resource isolation, and cancellation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPiWorkerBackend } from './exitcode-workers.mjs';

test('workers: sessions isolate cwd and context, retain selected model settings, repair in place, and dispose on cancellation', async () => {
  const created = [], loaded = [], prompts = [], listeners = new Map(), aborted = [], disposed = [], providerCalls = [];
  const sdk = {
    getAgentDir: () => '/agent-config',
    SettingsManager: { inMemory: settings => ({settings}) },
    ModelRuntime: { create: async () => ({ getAvailable:async()=>[{id:"selected",provider:"custom"}], registerNativeProvider: p => providerCalls.push(p), registerProvider: (id,cfg) => providerCalls.push([id,cfg]) }) },
    SessionManager: { inMemory: cwd => ({cwd,messages:[]}) },
    DefaultResourceLoader: class { constructor(options){this.options=options;loaded.push(options);} async reload(){} },
    createAgentSession: async options => {
      created.push(options);
      const session = {
        async bindExtensions(){},
        subscribe(listener){listeners.set(options.cwd,listener);return()=>listeners.delete(options.cwd);},
        async prompt(content){prompts.push([options.cwd,JSON.parse(content)]);},
        async abort(){aborted.push(options.cwd);},
        dispose(){disposed.push(options.cwd);},
      };
      return {session,extensionsResult:{errors:[]}};
    },
  };
  const model={id:'selected',provider:'custom'}, native={id:'custom'}, config={baseUrl:'configured'};
  const backend=createPiWorkerBackend({model,thinkingLevel:'high',modelRegistry:{getRegisteredNativeProvider:()=>native,getRegisteredProviderConfig:()=>config}},async()=>sdk);
  await backend.preflight();
  assert.equal(created.length,0,"preflight constructs no worker sessions");
  assert.equal(loaded.length,0,"preflight loads no project resources");
  const controller=new AbortController();
  const a=await backend.start({id:'S1',cwd:'/private/one',objective:'first',signal:controller.signal});
  const b=await backend.start({id:'S2',cwd:'/private/two',objective:'second',signal:controller.signal});
  await Promise.all([backend.send(a,{objective:'first'}),backend.send(b,{objective:'second'})]);
  await backend.send(a,{failures:[{criterionId:'C1',status:'FAIL'}]});
  assert.deepEqual(created.map(c=>c.cwd),['/private/one','/private/two']);
  assert.notEqual(created[0].sessionManager,created[1].sessionManager);
  for(const c of created){assert.equal(c.model,model);assert.equal(c.thinkingLevel,'high');assert.deepEqual(c.tools,['read','bash','edit','write']);}
  for(const l of loaded){assert.equal(l.noExtensions,true);assert.equal(l.noContextFiles,true);assert.deepEqual(l.disabledBuiltinExtensions,['mcp']);}
  let boundary;
  loaded[0].extensionFactories[0]({on:(name,fn)=>{assert.equal(name,'tool_call');boundary=fn;}});
  assert.equal(boundary({toolName:'write',input:{path:'result'}}),undefined);
  assert.equal(boundary({toolName:'read',input:{path:'../objects.git/config'}}).block,true);
  assert.equal(boundary({toolName:'read',input:{path:'.exitcode/roots/G1.json'}}).block,true);
  assert.equal(boundary({toolName:'bash',input:{command:'cat .exitcode/contracts/G1.sealed.json'}}).block,true);
  assert.equal(prompts[2][1].assignment,undefined,'repair feedback uses the existing session');
  assert.equal(providerCalls.length,6);
  controller.abort(); await assert.rejects(()=>backend.send(a,{}),e=>e.code==='CANCELLED');
  await Promise.all([backend.cancel(a),backend.cancel(b)]);
  await Promise.all([backend.dispose(a),backend.dispose(b)]);
  assert.deepEqual(disposed.sort(),['/private/one','/private/two']);assert.equal(listeners.size,0);assert.equal(aborted.length,4);
});

test('workers: model errors never become a settled successful candidate', async () => {
  let listener;
  const sdk={getAgentDir:()=>'/config',SettingsManager:{inMemory:()=>({})},ModelRuntime:{create:async()=>({getAvailable:async()=>[{id:"m",provider:"p"}]})},SessionManager:{inMemory:()=>({})},
    DefaultResourceLoader:class{async reload(){}},createAgentSession:async()=>({extensionsResult:{errors:[]},session:{
      async bindExtensions(){},subscribe(fn){listener=fn;return()=>{};},async prompt(){listener({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}});},
      async abort(){},dispose(){},
    }})};
  const backend=createPiWorkerBackend({model:{id:'m',provider:'p'}},async()=>sdk);
  const handle=await backend.start({id:'S1',cwd:'/private'});
  await assert.rejects(()=>backend.send(handle,{}),e=>e.code==='WORKER_FAILED');
  await backend.dispose(handle);
});

test('workers: preflight rejects missing SDK capabilities or an unavailable selected model without launching sessions', async t => {
  for (const mode of ['no-model','missing-sdk','missing-api','unavailable-model']) await t.test(mode,async()=>{
    let sessions=0,loads=0;
    const sdk={getAgentDir:()=>'/config',SettingsManager:{inMemory:()=>({})},SessionManager:{inMemory:()=>({})},
      DefaultResourceLoader:class{},createAgentSession:async()=>{sessions++;},ModelRuntime:{create:async options=>{
        assert.equal(options.allowModelNetwork,false);assert.equal(options.refreshOnCreate,false);
        return {getAvailable:async()=>[]};
      }}};
    if(mode==='missing-api')delete sdk.SessionManager;
    const backend=createPiWorkerBackend({model:mode==='no-model'?null:{id:'selected',provider:'p'}},async()=>{
      loads++;if(mode==='missing-sdk')throw Error('SDK not installed');return sdk;
    });
    await assert.rejects(()=>backend.preflight(),e=>e.code==='WORKER_UNAVAILABLE');
    assert.equal(sessions,0);if(mode==='no-model')assert.equal(loads,0);
  });
  const stopped=new AbortController();stopped.abort();
  await assert.rejects(()=>createPiWorkerBackend({}).preflight({signal:stopped.signal}),e=>e.code==='CANCELLED');
});
