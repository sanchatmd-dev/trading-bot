import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectIoRuntimeUnit,inspectIoRuntimeDevice,inspectIoRuntimeProc,
  inspectIoRuntimeMembership,
} from '../src/quant-research/io-runtime-launcher.js';

const unitName='robot-quant-'+'a'.repeat(64)+'.service';
const group='/user.slice/'+unitName;
const invocationId='1'.repeat(32);
const unit=`LoadState=loaded\nActiveState=active\nMainPID=4242\nControlGroup=${group}\nInvocationID=${invocationId}\n`;

test('registered active unit has one expected cgroup and live PID',()=>{
  assert.deepEqual(inspectIoRuntimeUnit(unit,unitName),{group,pid:4242,invocationId});
  for(const invalid of [unit.replace('active','inactive'),unit.replace('MainPID=4242','MainPID=0'),
    unit.replace(group,'/user.slice/unrelated.service'),unit.replace(invocationId,'not-an-invocation'),
    unit.replace(group,'/user.slice/robot-quant-'+'f'.repeat(64)+'.service/'+unitName)])
    assert.throws(()=>inspectIoRuntimeUnit(invalid,unitName),{code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
});

test('block device identity uses kernel rdev major/minor and inode',()=>{
  const block={isBlockDevice:()=>true,ino:17,rdev:2048,dev:9};
  assert.deepEqual(inspectIoRuntimeDevice(block,'8:0'),
    {deviceId:'8:0',deviceInode:17,rdev:2048,dev:9});
  for(const invalid of [{...block,rdev:2049},{...block,ino:0},
    {...block,isBlockDevice:()=>false}])
    assert.throws(()=>inspectIoRuntimeDevice(invalid,'8:0'),
      {code:'QUANT_IO_DEVICE_IDENTITY_MISMATCH'});
});

test('process start tick and exact unified cgroup membership are required',()=>{
  const fields=Array(20).fill('1');fields[19]='98765';
  const proc=`4242 (probe worker) ${fields.join(' ')}`;
  assert.equal(inspectIoRuntimeProc(proc,4242),'98765');
  assert.equal(inspectIoRuntimeMembership(`0::${group}\n`,group),group);
  assert.throws(()=>inspectIoRuntimeProc(proc,4243),{code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
  assert.throws(()=>inspectIoRuntimeProc(proc.replace('98765','x'),4242),
    {code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
  assert.throws(()=>inspectIoRuntimeMembership('0::/user.slice/other.service',group),
    {code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
});
