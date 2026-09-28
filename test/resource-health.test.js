import test from 'node:test';
import assert from 'node:assert/strict';
import {createResourceHealth,validateHealthLimits,loopbackHealthProbe} from '../src/quant-research/resource-health.js';
import path from 'node:path';
const limits={maxDbMs:100,maxApiMs:100,maxQueueAgeMs:2000,maxQueueDepth:10,minMemoryBytes:1024,minDiskBytes:1024,maxLoad1:1,maxDiskUsedFraction:.75};
function fixture(){let now=10000;const queue={depth:0,oldest:null};const host={availableMemory:2048,freeDisk:5000,totalDisk:10000,load1:.2};const state={queue,host,api:{ok:true},dbDelay:0,apiDelay:0};return {state,check:createResourceHealth({limits,storageRoot:path.resolve('.'),clock:()=>now,db:{query:async()=>{now+=state.dbDelay;return {rows:[state.queue]};}},probe:async()=>{now+=state.apiDelay;return state.api;},sample:async()=>state.host})};}
test('resource health requires fresh complete known telemetry and reviewed limits',async()=>{
  const {state,check}=fixture();assert.equal((await check()).ok,true);
  state.api={};assert.equal((await check()).ok,false);
  state.api={ok:true};state.host.load1=NaN;assert.equal((await check()).ok,false);
  state.host={};assert.equal((await check()).ok,false);
  assert.throws(()=>validateHealthLimits({}),{code:'QUANT_HEALTH_LIMITS_REQUIRED'});
  assert.throws(()=>loopbackHealthProbe('https://example.com/healthz'),{code:'INVALID_QUANT_HEALTH_ENDPOINT'});
});
test('resource health rejects DB/API lag and trading pressure before Quant starts',async()=>{
  for(const change of [s=>s.dbDelay=101,s=>s.apiDelay=101,s=>s.queue={depth:1,oldest:7000},s=>s.queue={depth:11,oldest:9999}]){
    const {state,check}=fixture();change(state);assert.equal((await check()).ok,false);
  }
});
test('resource health blocks memory/disk/load boundaries and malformed queue data',async()=>{
  for(const change of [s=>s.host.availableMemory=1023,s=>s.host.freeDisk=1023,s=>s.host.freeDisk=2500,s=>s.host.load1=1.1,s=>s.queue={depth:1,oldest:null},s=>s.queue={depth:1,oldest:10001}]){
    const {state,check}=fixture();change(state);assert.equal((await check()).ok,false);
  }
});
test('isolated research health also checks the actual trading database queue',async()=>{
  const calls=[];
  const check=createResourceHealth({limits,storageRoot:path.resolve('.'),clock:()=>10000,
    db:{query:async sql=>{calls.push(['research',sql]);return {rows:[{}]};}},
    tradingDb:{query:async sql=>{calls.push(['trading',sql]);return {rows:[{depth:11,oldest:9999}]};}},
    probe:async()=>({ok:true}),sample:async()=>({availableMemory:2048,freeDisk:5000,totalDisk:10000,load1:0})});
  assert.equal((await check()).ok,false);assert.equal(calls[0][1],'SELECT 1');assert.equal(calls[1][0],'trading');
});
test('I/O opt-in health fails closed on unknown or changed cgroup generation',async()=>{
  const ioControls={version:'quant-io-v1',device:'8:0',devicePath:'/dev/test-block',main:{readBytesPerSecond:1048576,writeBytesPerSecond:524288},evaluator:{readBytesPerSecond:524288,writeBytesPerSecond:262144}};
  let io={group:'/user.slice/worker.service',inode:7,readBytes:1,writeBytes:2};
  const check=createResourceHealth({limits,storageRoot:path.resolve('.'),clock:()=>10000,
    db:{query:async()=>({rows:[{depth:0,oldest:null}]})},probe:async()=>({ok:true}),
    sample:async()=>({availableMemory:2048,freeDisk:5000,totalDisk:10000,load1:0}),
    ioControls,ioIdentity:{group:io.group,inode:7},ioSample:async()=>io});
  assert.equal((await check()).ok,true);
  io={...io,readBytes:0};assert.equal((await check()).reason,'UNKNOWN_IO');
  io={...io,readBytes:2,inode:8};assert.equal((await check()).reason,'UNKNOWN_IO');
});
