import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalibrationWindow,calibrationWorkDeadline,inspectCalibrationCompletion,runCalibrationDriver} from '../src/quant-research/calibration-window.js';

const marker=()=>({baseline_ok:true,run_id:'calibration-test-1234',...createCalibrationWindow(100000,300000),cleanup_reserve_ms:30000});
async function run({work,cleanup,at=110000}={}){
  let now=at;const events=[],published=[];
  const result=await runCalibrationDriver({marker:marker(),clock:()=>now,
    work:async budget=>{events.push('work');return work?work(budget,value=>{now=value;}):true;},
    cleanup:async()=>{events.push('cleanup');return cleanup?cleanup(value=>{now=value;}):true;},
    publish:async value=>{events.push('publish');published.push(value);}});
  assert.equal(published.length,1);
  return {result,events,now};
}
test('driver reserves cleanup time and automatically publishes only after stop proof',async()=>{
  assert.equal(calibrationWorkDeadline(marker(),110000),370000);
  const {result,events}=await run();
  assert.deepEqual(events,['work','cleanup','publish']);
  assert.equal(inspectCalibrationCompletion(marker(),result,110001),'DRIVER_DONE');
});
test('work failure automatically publishes failure after cleanup',async()=>{
  const {result}=await run({work:()=>{throw Error('fixture');}});
  assert.equal(result.reason,'WORK_FAILED');
  assert.equal(inspectCalibrationCompletion(marker(),result,110001),'DRIVER_FAILED');
});
test('unverified work cannot pass',async()=>{
  assert.equal((await run({work:()=>false})).result.reason,'WORK_UNVERIFIED');
});
test('cleanup failure cannot pass even after verified work',async()=>{
  for(const cleanup of [()=>false,()=>{throw Error('fixture');}]){
    const {result}=await run({cleanup});
    assert.equal(inspectCalibrationCompletion(marker(),result,110001),'STOP_UNCONFIRMED');
  }
});
test('expired work budget skips work but retains cleanup and publication',async()=>{
  const {result,events}=await run({at:370000});
  assert.deepEqual(events,['cleanup','publish']);
  assert.equal(result.reason,'WORK_DEADLINE');
});
test('work consuming the cleanup reserve fails without extending the deadline',async()=>{
  const {result}=await run({work:(_,advance)=>{advance(370000);return true;}});
  assert.equal(result.reason,'WORK_DEADLINE');assert.equal(result.deadline_ms,400000);
});
test('late cleanup publishes failed evidence and monitor rejects the expired session',async()=>{
  const {result}=await run({cleanup:advance=>{advance(411000);return true;}});
  assert.equal(result.reason,'COMPLETION_DEADLINE');
  assert.equal(inspectCalibrationCompletion(marker(),result,411001),'INVALID_OR_EXPIRED_SESSION');
});
test('wrong run, wrong window, future timestamps and delayed receipt never pass',async()=>{
  const {result}=await run();
  for(const change of [{run_id:'other-run-12345678'},{issued_at_ms:99999},{deadline_ms:400001},{completed_at_ms:120000},{completed_at_ms:99999}])
    assert.equal(inspectCalibrationCompletion(marker(),{...result,...change},110001),'INVALID_COMPLETION');
  assert.equal(inspectCalibrationCompletion(marker(),result,400000),'INVALID_OR_EXPIRED_SESSION');
});
test('invalid session or reserve fails before work or publication',async()=>{
  for(const change of [{run_id:'bad'},{cleanup_reserve_ms:0},{cleanup_reserve_ms:300000}]){
    await assert.rejects(runCalibrationDriver({marker:{...marker(),...change},clock:()=>110000,
      work:()=>assert.fail(),cleanup:()=>assert.fail(),publish:()=>assert.fail()}),{code:'INVALID_CALIBRATION_SESSION'});
  }
});
test('publication failure remains visible to the caller',async()=>{
  await assert.rejects(runCalibrationDriver({marker:marker(),clock:()=>110000,work:async()=>true,
    cleanup:async()=>true,publish:async()=>{throw Error('publish failed');}}),/publish failed/);
});
