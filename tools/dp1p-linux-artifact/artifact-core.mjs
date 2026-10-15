import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export const COMMIT='70ea7f92a4547845291d32d836d3c740a0e7f1b7';
export const PINS=Object.freeze({
  'source.tar':'d414e8b5d4885a147fa038184d5edadfda3c5484fc5e3c7b42b7f1b55efa248a',
  'deps.tar':'72c3e846a524ecb57abf31564dcd2df4887ef71adb4c308c515adbdcce0aacfd',
  'manifest.txt':'4afdbc1b013e02e3f7c663d44e81d9706824fb83482865f5ddde5056a3bc4876',
  'bundle.json':'34c826a2e93cd63c832dd7a4bdb2f7b07c2ccd85f4514bf310a3fd366d3b2845'
});
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function safePath(name){
  assert.ok(name&&!name.startsWith('/')&&!/[\\:\x00-\x1f\x7f]/.test(name),'unsafe archive path');
  assert.ok(name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)),'unsafe archive segment');
  return name;
}
export function parseTar(buffer){
  assert.ok(Buffer.isBuffer(buffer)&&buffer.length<=20*1024*1024&&buffer.length%512===0,'archive size');
  const entries=new Map();let cursor=0,ended=false;
  while(cursor<buffer.length){
    const header=buffer.subarray(cursor,cursor+512);
    if(header.every(byte=>byte===0)){
      assert.ok(cursor+1024<=buffer.length&&buffer.subarray(cursor).every(byte=>byte===0),'archive terminator');ended=true;break;
    }
    const text=(start,length)=>{
      const bytes=header.subarray(start,start+length),end=bytes.indexOf(0);
      if(end!==-1)assert.ok(bytes.subarray(end).every(byte=>byte===0),'nonzero string padding');
      const value=bytes.subarray(0,end===-1?bytes.length:end).toString('utf8');
      assert.ok(!value.includes('\ufffd'),'invalid UTF-8 header');return value;
    };
    const octal=(start,length)=>{const value=text(start,length).trim();assert.match(value,/^[0-7]+$/);const n=parseInt(value,8);assert.ok(Number.isSafeInteger(n));return n;};
    let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];
    // The checksum field convention is NUL followed by space, unlike path string padding.
    const checksumText=header.subarray(148,156).toString('ascii').replace(/[\0 ]+$/,'').trim();
    assert.match(checksumText,/^[0-7]+$/);assert.equal(checksum,parseInt(checksumText,8),'archive checksum');
    assert.equal(text(257,6),'ustar');assert.ok([0,48].includes(header[156]),'nonregular archive entry');
    assert.equal(text(157,100),'','archive links forbidden');
    const prefix=text(345,155),name=safePath((prefix?prefix+'/':'')+text(0,100));
    assert.ok(!entries.has(name.toLowerCase()),'duplicate archive path');
    const size=octal(124,12);assert.ok(size<=20*1024*1024,'entry too large');
    assert.equal(octal(100,8),420);assert.equal(octal(108,8),0);assert.equal(octal(116,8),0);assert.equal(octal(136,12),0);
    const end=cursor+512+size,next=cursor+512+Math.ceil(size/512)*512;
    assert.ok(next<=buffer.length&&buffer.subarray(end,next).every(byte=>byte===0),'archive bounds or padding');
    entries.set(name.toLowerCase(),{name,bytes:Buffer.from(buffer.subarray(cursor+512,end))});
    assert.ok(entries.size<=512,'entry count bound');cursor=next;
  }
  assert.ok(ended,'missing archive terminator');return [...entries.values()];
}
export function readPinnedInputs(directory){
  const buffers={};
  for(const [name,pin]of Object.entries(PINS)){
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=20*1024*1024,'invalid input file');
    buffers[name]=fs.readFileSync(file);assert.equal(sha(buffers[name]),pin,`input pin: ${name}`);
  }return buffers;
}
export function validateBundle(buffers){
  // This parser has no extraction/import side effects. Production CLI separately requires all four immutable pins.
  const bundle=JSON.parse(buffers['bundle.json']);assert.equal(bundle.schema,'dp1p-bundle-v2');
  assert.equal(bundle.commit,COMMIT);assert.equal(bundle.lockRef,COMMIT);assert.equal(bundle.lockEqual,true);
  const source=parseTar(buffers['source.tar']).map(entry=>{
    assert.ok(entry.name.startsWith('release/'),'source prefix must be exactly release/');
    return {...entry,name:safePath(entry.name.slice(8))};
  });
  const deps=parseTar(buffers['deps.tar']);assert.equal(source.length,182);assert.equal(deps.length,145);
  for(const entry of deps){
    assert.ok(entry.name.startsWith('node_modules/'),'dependency prefix');
    assert.ok(!/(^|\/)\.bin(\/|$)|\.(node|dll|exe|so|dylib|a|lib|pyd)$/i.test(entry.name),'native or bin entry forbidden');
    assert.ok(!/^node_modules\/pg-native(?:\/|$)/i.test(entry.name),'pg-native forbidden');
  }
  const entries=[...source,...deps],manifest=new Map();
  for(const line of buffers['manifest.txt'].toString('utf8').trimEnd().split('\n')){
    const match=/^([a-f0-9]{64}) (\d+) (.+)$/.exec(line);assert.ok(match,'manifest row');
    const [,hash,size,name]=match;safePath(name);assert.ok(!manifest.has(name.toLowerCase()),'duplicate manifest path');
    manifest.set(name.toLowerCase(),{name,hash,size:Number(size)});
  }
  assert.equal(manifest.size,327);assert.equal(entries.length,327);const names=new Set();
  for(const entry of entries){
    assert.ok(!names.has(entry.name.toLowerCase()),'cross-archive duplicate');names.add(entry.name.toLowerCase());
    const expected=manifest.get(entry.name.toLowerCase());assert.ok(expected,'unexpected archive file');
    assert.equal(entry.name,expected.name);assert.equal(entry.bytes.length,expected.size);assert.equal(sha(entry.bytes),expected.hash,'manifest content mismatch');
  }
  const byName=new Map(entries.map(entry=>[entry.name,entry]));
  const json=name=>JSON.parse(byName.get(name)?.bytes||'null');
  assert.equal(sha(byName.get('package.json').bytes),'5a778581a93471a03855be123e7fb06a9c67e87c04320cb3dd81549784d8caef');
  assert.equal(sha(byName.get('package-lock.json').bytes),'5df4eda59d12f9a3a6c8fa4d58de0ff82a6a425e56b7cfa3d1d17bea46ee637e');
  const pkg=json('package.json'),lock=json('package-lock.json'),installed=json('node_modules/.package-lock.json');
  assert.equal(pkg.engines.node,'>=24');assert.equal(pkg.dependencies.pg,'8.23.0');assert.equal(pkg.dependencies['decimal.js'],'10.6.0');
  const production=Object.entries(lock.packages).filter(([name,row])=>name&&!row.dev);
  assert.equal(production.length,15);assert.equal(Object.keys(installed.packages).length,15);
  assert.equal(deps.filter(entry=>entry.name.endsWith('/package.json')).length,15);
  const packages=[];
  for(const [name,row]of production){
    safePath(name);const metadata=json(name+'/package.json');assert.ok(metadata);assert.equal(metadata.version,row.version);
    assert.ok(!metadata.os&&!metadata.cpu&&!metadata.libc&&!row.hasInstallScript,'platform/install restriction');
    assert.equal(installed.packages[name]?.version,row.version);assert.equal(installed.packages[name]?.integrity,row.integrity);
    assert.deepEqual(installed.packages[name]?.dependencies,row.dependencies);
    packages.push({path:name,name:metadata.name,version:metadata.version,nodeEngine:metadata.engines?.node||null});
  }
  assert.equal(Object.keys(bundle.closure).length,12);assert.equal(bundle.check.length,12);
  assert.deepEqual([...bundle.check].sort(),Object.keys(bundle.closure).sort());
  for(const [name,hash]of Object.entries(bundle.closure))assert.equal(sha(byName.get(name)?.bytes||Buffer.alloc(0)),hash,'missing or altered closure');
  assert.deepEqual(bundle.counts,{source:182,deps:145,total:327});
  return {entries,packages,closure:bundle.check,counts:{source:182,deps:145,total:327,packages:15,closure:12}};
}

export function inventoryTree(root){
  const rows=[];
  function walk(relative=''){
    for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
      const name=relative?relative+'/'+entry.name:entry.name;safePath(name);
      assert.ok(!entry.isSymbolicLink(),'extracted link');
      if(entry.isDirectory())walk(name);else{assert.ok(entry.isFile(),'nonregular extracted entry');rows.push({name,sha256:sha(fs.readFileSync(path.join(root,name)))});}
    }
  }walk();return rows.sort((a,b)=>a.name.localeCompare(b.name));
}
