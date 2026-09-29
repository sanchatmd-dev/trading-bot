import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectIoRuntimeUnit,inspectIoRuntimeDevice,inspectIoRuntimeProc,
  inspectIoRuntimeMembership,
  inspectIoRuntimeReceipt,inspectIoRuntimeScratch,
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

test('receipt requires release and exact fixed child output',()=>{
  const marker='QUANT_IO_DIAGNOSTIC_ACCEPTED_V1 292f32a95cc6db3ea98a386e65ee162d977317c73530f9947f8e0628c80d472c\n';
  assert.equal(inspectIoRuntimeReceipt(marker.slice(0,30),true),false);
  assert.equal(inspectIoRuntimeReceipt(marker,true),true);
  for(const [output,released] of [[marker,false],[marker+'extra',true],
    [marker.replace('ACCEPTED','WRONG'),true]])
    assert.throws(()=>inspectIoRuntimeReceipt(output,released),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
});

test('scratch cleanup accepts only same regular 4 KiB inode',()=>{
  const file={isFile:()=>true,isSymbolicLink:()=>false,size:4096,dev:3,ino:17};
  const original=inspectIoRuntimeScratch(file);
  assert.deepEqual(original,{dev:3,ino:17});
  for(const changed of [{...file,ino:18},{...file,size:4095},
    {...file,isSymbolicLink:()=>true},{...file,isFile:()=>false}])
    assert.throws(()=>inspectIoRuntimeScratch(changed,original),
      {code:'QUANT_IO_READINESS_CLEANUP_FAILED'});
  assert.throws(()=>inspectIoRuntimeScratch(null,original),
    {code:'QUANT_IO_READINESS_CLEANUP_FAILED'});
});
