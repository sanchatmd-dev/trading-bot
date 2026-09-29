import test from 'node:test';
import assert from 'node:assert/strict';
import {assertIoStorageDevice,inspectCgroupIo,readCgroupIo,readCgroupIoLimits} from '../src/quant-research/io-controls.js';

const controls={version:'quant-io-v1',device:'8:0',devicePath:'/dev/approved',
  main:{readBytesPerSecond:1024,writeBytesPerSecond:2048},
  evaluator:{readBytesPerSecond:1024,writeBytesPerSecond:2048}};
const max='8:0 rbps=1024 wbps=2048';
const statter=()=>({ino:123});

test('synchronous filesystem failure keeps public code and only an allowed private marker',async()=>{
  const error=await readCgroupIoLimits('/unit.service',controls,'evaluator',{
    reader:()=>{throw Object.assign(new Error('SECRET_PAYLOAD_VALUE'),{code:'EACCES',path:'SECRET_PATH_VALUE'});},
    statter
  }).then(()=>null,error=>error);
  assert.equal(error.code,'QUANT_IO_TELEMETRY_UNAVAILABLE');
  assert.deepEqual(error.ioDiagnostic,{phase:'limits',cause:'filesystem_read',filesystem_marker:'EACCES'});
  assert.equal(JSON.stringify(error).includes('SECRET'),false);
  const unknown=await readCgroupIoLimits('/unit.service',controls,'evaluator',{
    reader:()=>{throw Object.assign(new Error('SECRET_PAYLOAD_VALUE'),{code:'SECRET_CODE'});},statter
  }).then(()=>null,error=>error);
  assert.deepEqual(unknown.ioDiagnostic,{phase:'limits',cause:'filesystem_read'});
});

test('synchronous callbacks still work and malformed counters keep their distinct cause',async()=>{
  assert.deepEqual(await readCgroupIoLimits('/unit.service',controls,'evaluator',{reader:()=>max,statter}),{inode:123});
  const missing=await readCgroupIo('/unit.service',controls,'evaluator',{
    reader:file=>file.endsWith('io.max')?max:'8:1 rbytes=1 wbytes=1',statter
  }).then(()=>null,error=>error);
  assert.equal(missing.code,'QUANT_IO_TELEMETRY_UNAVAILABLE');
  assert.deepEqual(missing.ioDiagnostic,{phase:'counters',cause:'counter_row_missing'});
  const unreadable=await readCgroupIo('/unit.service',controls,'evaluator',{
    reader:file=>{if(file.endsWith('io.max'))return max;
      throw Object.assign(new Error('SECRET_PAYLOAD_VALUE'),{code:'EIO'});},statter
  }).then(()=>null,error=>error);
  assert.deepEqual(unreadable.ioDiagnostic,{phase:'counters',cause:'filesystem_read',filesystem_marker:'EIO'});
  assert.equal(JSON.stringify(unreadable).includes('SECRET'),false);
  let malformed;
  try{inspectCgroupIo({max,stat:'8:0 rbytes=secret wbytes=1',device:'8:0',limits:controls.evaluator});}
  catch(error){malformed=error;}
  assert.equal(malformed.code,'QUANT_IO_TELEMETRY_UNAVAILABLE');
  assert.deepEqual(malformed.ioDiagnostic,{phase:'counters',cause:'counter_parse'});
});

test('wrong limits and storage stat failure retain distinct sanitized causes',async()=>{
  const limits=await readCgroupIoLimits('/unit.service',controls,'evaluator',{
    reader:()=> '8:0 rbps=1024 wbps=4096',statter
  }).then(()=>null,error=>error);
  assert.equal(limits.code,'QUANT_IO_TELEMETRY_UNAVAILABLE');
  assert.deepEqual(limits.ioDiagnostic,{phase:'limits',cause:'limits_mismatch'});
  const storage=await assertIoStorageDevice('/owned',controls.device,{
    statter:()=>{throw Object.assign(new Error('SECRET_PATH_VALUE'),{code:'ENOENT'});}
  }).then(()=>null,error=>error);
  assert.equal(storage.code,'QUANT_IO_STORAGE_DEVICE_MISMATCH');
  assert.deepEqual(storage.ioDiagnostic,{phase:'storage',cause:'filesystem_stat',filesystem_marker:'ENOENT'});
  assert.equal(JSON.stringify(storage).includes('SECRET'),false);
});
