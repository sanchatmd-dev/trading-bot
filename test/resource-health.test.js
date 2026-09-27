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
