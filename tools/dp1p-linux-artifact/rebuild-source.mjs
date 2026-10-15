import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {COMMIT,PINS,safePath,sha} from './artifact-core.mjs';

function git(repository,args,input){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dp1p-git-config-'));
  const emptyConfig=path.join(temporary,'empty.config');
  const env={PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig,
    GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'};
  if(process.platform==='win32')env.SystemRoot=process.env.SystemRoot;
  try{
    fs.writeFileSync(emptyConfig,'',{flag:'wx',mode:0o600});
    const result=cp.spawnSync('git',args,{cwd:repository,env,input,maxBuffer:16*1024*1024,
      timeout:10000,killSignal:'SIGKILL',windowsHide:true});
    assert.ok(!result.error&&!result.signal&&result.status===0,'bounded read-only Git failed');return result.stdout;
  }finally{
    assert.ok(path.dirname(temporary)===os.tmpdir()&&path.basename(temporary).startsWith('dp1p-git-config-'));
    fs.rmSync(temporary,{recursive:true,force:true});assert.ok(!fs.existsSync(temporary),'owned Git config cleanup');
  }
}
function header(name,size){
  const h=Buffer.alloc(512);let n=name,prefix='';
  if(Buffer.byteLength(n)>100){
    const at=n.lastIndexOf('/',Math.min(n.length-1,155));assert.ok(at>=1);prefix=n.slice(0,at);n=n.slice(at+1);
    assert.ok(Buffer.byteLength(n)<=100&&Buffer.byteLength(prefix)<=155);
  }
  const put=(value,at,length)=>h.write(value,at,length,'utf8');
  put(n,0,100);put('0000644\0',100,8);put('0000000\0',108,8);put('0000000\0',116,8);
  put(size.toString(8).padStart(11,'0')+'\0',124,12);put('00000000000\0',136,12);
  h.fill(32,148,156);h[156]=48;put('ustar\0',257,6);put('00',263,2);put(prefix,345,155);
  put(h.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148,8);return h;
}
export function rebuildSource(repository){
  const rows=git(repository,['ls-tree','-r','-z','--full-tree',COMMIT]).toString('utf8').split('\0').filter(Boolean).map(line=>{
    const match=/^100644 blob ([a-f0-9]{40})\t([^\r\n]+)$/.exec(line);assert.ok(match,'nonregular Git tree entry');
    return {oid:match[1],name:safePath(match[2])};
  });
  assert.equal(rows.length,182);
  const batch=git(repository,['cat-file','--batch'],rows.map(row=>row.oid).join('\n')+'\n');
  let cursor=0;
  for(const row of rows){
    const end=batch.indexOf(10,cursor),match=/^([a-f0-9]{40}) blob (\d+)$/.exec(batch.subarray(cursor,end).toString('ascii'));
    assert.ok(match);assert.equal(match[1],row.oid);const size=Number(match[2]);assert.ok(Number.isSafeInteger(size)&&size<=8*1024*1024);
    const bytes=batch.subarray(end+1,end+1+size);assert.equal(bytes.length,size);cursor=end+size+2;assert.equal(batch[cursor-1],10);
    assert.equal(crypto.createHash('sha1').update('blob '+size+'\0').update(bytes).digest('hex'),row.oid);row.bytes=bytes;
  }
  assert.equal(cursor,batch.length);
  const parts=[];
  for(const row of rows.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    parts.push(header('release/'+row.name,row.bytes.length),row.bytes);
    const padding=(512-row.bytes.length%512)%512;if(padding)parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));const archive=Buffer.concat(parts);
  assert.equal(sha(archive),PINS['source.tar'],'rebuilt source archive identity');return archive;
}
