import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {capturePreflightRunChunkForTest} from '../src/postgres/quant-research-foundation.js';

test('R5-21 capture is scoped to one worker and never installs a prototype accessor',()=>{
 const worker={},other={},before=Object.getOwnPropertyDescriptor(Object.prototype,'readFile');
 const capture=capturePreflightRunChunkForTest(worker),second=capturePreflightRunChunkForTest(other);
 try{
  assert.equal(capture.runChunk,null);assert.equal(second.runChunk,null);
  assert.throws(()=>capturePreflightRunChunkForTest(worker),/already installed/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype,'readFile'),before);
 }finally{capture.release();second.release();}
 const replacement=capturePreflightRunChunkForTest(worker);replacement.release();
});

test('R5-21 capture cannot be enabled by production configuration',()=>{
 const module=new URL('../src/postgres/quant-research-foundation.js',import.meta.url).href;
 const script=`import {capturePreflightRunChunkForTest} from ${JSON.stringify(module)};
  import assert from 'node:assert/strict';
  assert.throws(()=>capturePreflightRunChunkForTest({}),/requires node --test/);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
  env:{...process.env,NODE_ENV:'test',NODE_TEST_CONTEXT:'child-v8'},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.error,undefined);
});
