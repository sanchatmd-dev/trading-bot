import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPinnedInputs,validateBundle,parseTar,sha} from './artifact-core.mjs';
const own=path.dirname(fileURLToPath(import.meta.url));
const inputs=readPinnedInputs(process.env.DP1P_TEST_INPUTS||path.join(own,'inputs'));
const replace=(name,bytes)=>({...inputs,[name]:bytes});
function checksum(header){
  header.fill(32,148,156);const value=header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0');
  header.write(value+'\0 ',148,8,'ascii');return header;
}
function mutantHeader(change){const bytes=Buffer.from(inputs['deps.tar']);change(bytes.subarray(0,512));checksum(bytes.subarray(0,512));return bytes;}
function removeEntry(buffer,match){
  let at=0;
  while(at<buffer.length){const header=buffer.subarray(at,at+512);if(header.every(byte=>byte===0))break;
    const name=header.subarray(0,100).toString().split('\0')[0],prefix=header.subarray(345,500).toString().split('\0')[0];
    const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8),end=at+512+Math.ceil(size/512)*512;
    if((prefix?prefix+'/':'')+name===match)return Buffer.concat([buffer.subarray(0,at),buffer.subarray(end)]);at=end;
  }throw Error('Fixture entry missing');
}
test('trusted exact archive inventory validates without extraction or probes',()=>{
  assert.deepEqual(validateBundle(inputs).counts,{source:182,deps:145,total:327,packages:15,closure:12});
});
test('altered dependency byte with valid unchanged tar header refuses manifest before extraction',()=>{
  const changed=Buffer.from(inputs['deps.tar']);changed[512]^=1;
  assert.notEqual(sha(changed),sha(inputs['deps.tar']));assert.equal(parseTar(changed).length,145);
  assert.throws(()=>validateBundle(replace('deps.tar',changed)),/manifest content mismatch/);
});
test('missing closure entry in well-formed archive refuses before extraction',()=>{
  const changed=removeEntry(inputs['source.tar'],'release/src/postgres/worker-main.js');
  assert.equal(parseTar(changed).length,181);assert.throws(()=>validateBundle(replace('source.tar',changed)));
});
for(const name of ['../escape','/absolute','release/../../escape','node_modules/evil\\path','C:/escape','node_modules/CON'])
test(`checksummed unsafe path ${name} refuses`,()=>{
  const changed=mutantHeader(header=>{header.fill(0,0,100);header.fill(0,345,500);header.write(name);});
  assert.throws(()=>parseTar(changed),/unsafe/);
});
for(const type of ['1','2','3','5','x','g'])test(`checksummed nonregular tar type ${type} refuses`,()=>{
  assert.throws(()=>parseTar(mutantHeader(header=>{header[156]=type.charCodeAt(0);})),/nonregular/);
});
test('duplicate path refuses even with correct headers and contents',()=>{
  const source=inputs['deps.tar'],size=parseInt(source.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
  const end=512+Math.ceil(size/512)*512,changed=Buffer.concat([source.subarray(0,end),source]);
  assert.throws(()=>parseTar(changed),/duplicate/);
});
test('extra archive file refuses exact inventory before extraction',()=>{
  const changed=mutantHeader(header=>{header.fill(0,0,100);header.write('node_modules/unexpected');});
  assert.throws(()=>validateBundle(replace('deps.tar',changed)),/unexpected archive file/);
});
test('missing dependency refuses exact inventory before extraction',()=>{
  const changed=removeEntry(inputs['deps.tar'],'node_modules/.package-lock.json');
  assert.equal(parseTar(changed).length,144);assert.throws(()=>validateBundle(replace('deps.tar',changed)));
});
test('truncated archive and nonzero padding refuse',()=>{
  assert.throws(()=>parseTar(inputs['deps.tar'].subarray(0,-512)));
  const changed=Buffer.from(inputs['deps.tar']);changed[changed.length-1]=1;assert.throws(()=>parseTar(changed),/terminator/);
});
test('manifest byte change refuses before extraction',()=>{
  const changed=Buffer.from(inputs['manifest.txt']);changed[0]=changed[0]===97?98:97;
  assert.throws(()=>validateBundle(replace('manifest.txt',changed)),/manifest content mismatch/);
});
for(const name of ['node_modules/.bin/unsafe','node_modules/unsafe.node','node_modules/pg-native/index.js'])
test(`checksummed forbidden dependency path ${name} refuses before import`,()=>{
  const changed=mutantHeader(header=>{header.fill(0,0,100);header.fill(0,345,500);header.write(name);});
  assert.throws(()=>validateBundle(replace('deps.tar',changed)),/native or bin entry forbidden|pg-native forbidden/);
});
