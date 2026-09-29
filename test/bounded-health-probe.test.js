import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedHealthProbe} from '../src/quant-research/bounded-health-probe.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('bounded probe shares work and passes cooperative signal',async()=>{
  let calls=0,finish,signal;
  const probe=createBoundedHealthProbe({maximumProbeMs:1000,probe:options=>{
    calls++;signal=options.signal;return new Promise(resolve=>{finish=resolve;});
  }});
  const a=probe(),b=probe();assert.equal(a,b);await turn();assert.equal(calls,1);
  assert.equal(signal.aborted,false);finish({ok:true});assert.deepEqual(await a,{ok:true});
});
test('timeout fails closed and prevents replacement work until late settlement',async()=>{
  let calls=0,finish,signal;
  const probe=createBoundedHealthProbe({maximumProbeMs:20,probe:options=>{
    calls++;signal=options.signal;
    return calls===1?new Promise(resolve=>{finish=resolve;}):{ok:true};
  }});
  assert.deepEqual(await probe(),{ok:false,reason:'UNKNOWN_HEALTH'});
  assert.equal(signal.aborted,true);
  for(let i=0;i<10;i++)assert.equal((await probe()).ok,false);
  assert.equal(calls,1);finish({ok:true});await turn();
  assert.deepEqual(await probe(),{ok:true});assert.equal(calls,2);
});
test('late rejection is handled and cooperative abort releases the latch',async()=>{
  let calls=0;
  const probe=createBoundedHealthProbe({maximumProbeMs:20,probe:({signal})=>{
    calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private')),{once:true}));
  }});
  assert.equal((await probe()).ok,false);await turn();
  assert.equal((await probe()).ok,false);assert.equal(calls,2);
});
test('synchronous errors fail closed and invalid limits reject',async()=>{
  assert.equal((await createBoundedHealthProbe({probe:()=>{throw Error('private');},maximumProbeMs:20})()).ok,false);
  for(const maximumProbeMs of [0,-1,10001,NaN,1.5])assert.throws(()=>createBoundedHealthProbe({probe:()=>{},maximumProbeMs}),{code:'QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED'});
});
test('delayed timer cannot admit an overdue success after event-loop blocking',async()=>{
  let signal;
  const probe=createBoundedHealthProbe({maximumProbeMs:10,probe:options=>{
    signal=options.signal;
    const started=performance.now();while(performance.now()-started<20){}
    return {ok:true};
  }});
  assert.deepEqual(await probe(),{ok:false,reason:'UNKNOWN_HEALTH'});
  assert.equal(signal.aborted,true);
});
