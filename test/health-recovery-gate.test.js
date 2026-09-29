import test from 'node:test';
import assert from 'node:assert/strict';
import {createHealthRecoveryGate} from '../src/quant-research/health-recovery-gate.js';

function fixture(){
  let now=10000,health={ok:true,queueDepth:0};
  const probe=async()=>{if(health instanceof Error)throw health;return health?.ok?{observed_at:now,...health}:health;};
  return {check:createHealthRecoveryGate({probe,clock:()=>now,wallClock:()=>now}),time:value=>{now=value;},health:value=>{health=value;}};
}
test('startup needs both the healthy time window and distinct samples',async()=>{
  const x=fixture();
  assert.equal((await x.check()).reason,'HEALTH_RECOVERY_PENDING');
  assert.equal((await x.check()).recovery.healthySamples,1);
  x.time(12500);assert.equal((await x.check()).ok,false);
  x.time(14999);assert.equal((await x.check()).ok,false);
  x.time(15000);const ready=await x.check();
  assert.equal(ready.ok,true);assert.equal(ready.queueDepth,0);assert.equal(ready.recovery.healthySamples,3);
});
test('elapsed time alone cannot satisfy the observation count',async()=>{
  const x=fixture();await x.check();x.time(15000);
  assert.equal((await x.check()).ok,false);
  x.time(15001);assert.equal((await x.check()).ok,false);
  x.time(16000);assert.equal((await x.check()).ok,true);
});
test('every unhealthy or unknown observation resets recovery immediately',async()=>{
  for(const failure of [{ok:false,reason:'DATABASE_PRESSURE'},null,{},new Error('private detail')]){
    const x=fixture();await x.check();x.time(12500);await x.check();x.time(15000);
    assert.equal((await x.check()).ok,true);
    x.health(failure);assert.equal((await x.check()).ok,false);
    x.health({ok:true});assert.equal((await x.check()).recovery.healthySamples,1);
    x.time(17500);assert.equal((await x.check()).ok,false);
    x.time(20000);assert.equal((await x.check()).ok,true);
  }
});
test('clock rollback and malformed clock values fail closed and discard prior recovery',async()=>{
  const x=fixture();await x.check();x.time(12500);await x.check();x.time(12000);
  assert.equal((await x.check()).reason,'UNKNOWN_HEALTH');
  x.time(15000);assert.equal((await x.check()).recovery.healthySamples,1);
  x.time(NaN);assert.equal((await x.check()).reason,'UNKNOWN_HEALTH');
});
test('concurrent callers share a probe and cannot multiply successful samples',async()=>{
  let resolveProbe,calls=0,now=10000;
  const check=createHealthRecoveryGate({clock:()=>now,wallClock:()=>now,probe:()=>{calls++;return new Promise(resolve=>{resolveProbe=resolve;});}});
  const a=check(),b=check();assert.equal(a,b);assert.equal(calls,1);
  now=11000;resolveProbe({ok:true,observed_at:now});
  assert.equal((await a).recovery.healthySamples,1);assert.equal((await b).ok,false);
});
test('restarting the wrapper restarts recovery and invalid policies are rejected',async()=>{
  assert.equal((await createHealthRecoveryGate({probe:async()=>({ok:true,observed_at:Date.now()})})()).ok,false);
  for(const options of [{},{probe:1},{probe:async()=>({ok:true}),minimumHealthyMs:999},
    {probe:async()=>({ok:true}),minimumHealthySamples:11},{probe:async()=>({ok:true}),clock:null}])
    assert.throws(()=>createHealthRecoveryGate(options),{code:'QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED'});
});

test('a long gap restarts the healthy window and rapid samples cannot replace spacing',async()=>{
  const x=fixture();await x.check();x.time(12500);await x.check();x.time(3600000);
  const fresh=await x.check();assert.equal(fresh.ok,false);assert.equal(fresh.recovery.healthySamples,1);
  x.time(3600001);assert.equal((await x.check()).recovery.healthySamples,1);
  x.time(3602500);assert.equal((await x.check()).ok,false);
  x.time(3605000);assert.equal((await x.check()).ok,true);
});

test('cached, future, missing or stale observations fail closed',async()=>{
  for(const observed_at of [9999,10001,undefined,NaN]){
    const x=fixture();x.health({ok:true,observed_at});
    assert.equal((await x.check()).reason,'UNKNOWN_HEALTH');
  }
});

test('probe duration and wall clock rollback are independent of monotonic time',async()=>{
  for(const scenario of ['slow','wall-backwards','stale']){
    let mono=10000,wall=100000;
    const check=createHealthRecoveryGate({clock:()=>mono,wallClock:()=>wall,probe:async()=>{
      const observed_at=wall;
      if(scenario==='slow'){mono+=2001;wall+=2001;}
      else if(scenario==='wall-backwards'){mono++;wall--;}
      else {mono++;wall+=2001;}
      return {ok:true,observed_at};
    }});
    assert.equal((await check()).reason,'UNKNOWN_HEALTH');
  }
});
