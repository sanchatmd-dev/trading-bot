import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalFrame,verifyTerminalIo} from '../src/quant-research/io-terminal.js';

test('terminal frame accepts fragmented single JSON result',()=>{
  const frame=new TerminalFrame();
  assert.equal(frame.push(Buffer.from('{"checkpoint":')),null);
  assert.deepEqual(frame.push(Buffer.from('{},"result":null}\n')),{checkpoint:{},result:null});
  assert.equal(frame.complete,true);
});

test('terminal frame rejects invalid, duplicate, extra, and oversized output',()=>{
  for(const bytes of ['{"error":"failed"}\n','{"checkpoint":{},"result":null}\nX',
    '{"checkpoint":{},"result":null}\n{"checkpoint":{},"result":null}\n','[]\n']){
    assert.throws(()=>new TerminalFrame().push(Buffer.from(bytes)),{code:'INVALID_EVALUATION_RESPONSE'});
  }
  const frame=new TerminalFrame();
  frame.push(Buffer.from('{"checkpoint":{},"result":null}\n'));
  assert.throws(()=>frame.push(Buffer.from('X')),{code:'INVALID_EVALUATION_RESPONSE'});
  assert.throws(()=>new TerminalFrame(4).push(Buffer.from('123456')),{code:'EVALUATION_OUTPUT_TOO_LARGE'});
});

test('terminal readback waits pending sample and checks limits, inode, counters, and liveness',async()=>{
  const order=[];
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const readLimits=async()=>{order.push('limits');return {inode:5};};
  const readCounters=async()=>{order.push('counters');return {inode:5,readBytes:11,writeBytes:21};};
  const check=verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),pending,
    readLimits,readCounters,live:()=>true});
  assert.deepEqual(order,[]);
  release();
  assert.deepEqual(await check,{inode:5,readBytes:11,writeBytes:21});
  assert.deepEqual(order,['limits','counters']);
  for(const bad of [
    {readLimits:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}},
    {readLimits:async()=>({inode:6})},
    {readCounters:async()=>({inode:5,readBytes:9,writeBytes:21})},
    {live:()=>false}
  ])await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),
    readLimits,readCounters,live:()=>true,...bad}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  let alive=true;
  await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),
    readLimits,readCounters:async()=>{alive=false;return {inode:5,readBytes:11,writeBytes:21};},
    live:()=>alive}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('terminal readback compares against sample completed while waiting',async()=>{
  let accepted={inode:5,readBytes:10,writeBytes:20};
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const read=verifyTerminalIo({group:'/unit',getIdentity:()=>accepted,pending,
    readLimits:async()=>({inode:5}),readCounters:async()=>({inode:5,readBytes:12,writeBytes:22}),
    live:()=>true});
  accepted={inode:5,readBytes:13,writeBytes:23};
  release();
  await assert.rejects(read,{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('extra output invalidates frame while terminal read is pending',async()=>{
  const frame=new TerminalFrame();
  frame.push(Buffer.from('{"checkpoint":{},"result":null}\n'));
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const read=verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),pending,
    readLimits:async()=>({inode:5}),readCounters:async()=>({inode:5,readBytes:11,writeBytes:21}),
    live:()=>!frame.invalid});
  assert.throws(()=>frame.push(Buffer.from('X')),{code:'INVALID_EVALUATION_RESPONSE'});
  release();
  await assert.rejects(read,{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('terminal readback rejects close before limits and abort during counters',async()=>{
  const identity=()=>({inode:5,readBytes:10,writeBytes:20});
  await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:identity,
    readLimits:async()=>({inode:5}),readCounters:async()=>({inode:5,readBytes:11,writeBytes:21}),
    live:()=>false}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  let aborted=false;
  await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:identity,
    readLimits:async()=>({inode:5}),readCounters:async()=>{aborted=true;return {inode:5,readBytes:11,writeBytes:21};},
    live:()=>!aborted}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});
