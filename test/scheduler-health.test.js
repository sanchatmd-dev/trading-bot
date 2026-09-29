import test from 'node:test';
import assert from 'node:assert/strict';
import {createSchedulerHealth} from '../src/quant-research/scheduler-health.js';

const policy={version:'quant-health-recovery-v1',minimumHealthyMs:5000,minimumHealthySamples:3,
  minimumSampleSpacingMs:1000,maximumSampleGapMs:6000,maximumProbeMs:2000,maximumObservationAgeMs:2000};
function fixture(){
  let now=10000,value={ok:true};
  const probe=async()=>{if(value instanceof Error)throw value;return value===null?null:{observed_at:now,...value};};
  return {health:createSchedulerHealth({probe,policy,clock:()=>now,wallClock:()=>now}),
    time:x=>{now=x;},set:x=>{value=x;}};
}
test('claim requires recovery but an active healthy job is not paused by its timer',async()=>{
  const x=fixture();assert.equal((await x.health({action:'CLAIM'})).ok,false);
  assert.equal((await x.health({action:'HEARTBEAT'})).ok,true);
  x.time(12500);assert.equal((await x.health()).ok,false);
  x.time(15000);assert.equal((await x.health()).ok,true);
  x.time(60000);assert.equal((await x.health({action:'HEARTBEAT'})).ok,true);
  assert.equal((await x.health()).ok,false);
});
test('unhealthy, unknown or throwing heartbeat immediately resets the next claim',async()=>{
  for(const bad of [{ok:false,reason:'MEMORY_PRESSURE'},null,{},new Error('private')]){
    const x=fixture();await x.health();x.time(12500);await x.health();x.time(15000);
    assert.equal((await x.health()).ok,true);
    x.set(bad);assert.equal((await x.health({action:'HEARTBEAT'})).ok,false);
    x.set({ok:true});assert.equal((await x.health()).recovery.healthySamples,1);
  }
});
test('hung admission and heartbeat share one bounded probe and reject late success',async()=>{
  let calls=0,resolve;
  const health=createSchedulerHealth({policy:{...policy,maximumProbeMs:20},clock:()=>10000,wallClock:()=>10000,
    probe:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const pending=health();assert.equal((await health({action:'HEARTBEAT'})).ok,false);
  assert.equal((await pending).ok,false);assert.equal(calls,1);
  assert.equal((await health()).ok,false);assert.equal(calls,1);
  resolve({ok:true,observed_at:10000});await new Promise(r=>setImmediate(r));
  const fresh=health();await new Promise(r=>setImmediate(r));
  assert.equal(calls,2);resolve({ok:true,observed_at:10000});
  assert.equal((await fresh).recovery.healthySamples,1);
});
test('only exact reviewed policy schema and known scheduler actions are accepted',async()=>{
  for(const bad of [{}, {...policy,version:'unknown'}, {...policy,extra:true}, {...policy,minimumHealthySamples:1}])
    assert.throws(()=>createSchedulerHealth({policy:bad,probe:async()=>({ok:true})}),
      {code:'QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED'});
  assert.equal((await fixture().health({action:'RESUME_UNCHECKED'})).ok,false);
});
