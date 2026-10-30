import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The lowering-only chunk seam readCoverageSnapshotWithChunkRows exists for tests. No product source or script may import or call it.
const SEAM='readCoverageSnapshotWithChunkRows';
const repo=fileURLToPath(new URL('..',import.meta.url));
const DEFINER=['src','postgres','qr2-coverage-reader.js'].join('/');
function files(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...files(full));
    else if(/\.(m?js|cjs|ts)$/.test(entry.name))out.push(full);
  }
  return out;
}

test('no file under src/ or scripts/ uses the chunk-rows test seam, except the reader module that defines it',()=>{
  const users=[];
  for(const top of ['src','scripts']){
    const dir=path.join(repo,top);
    if(!fs.existsSync(dir))continue;
    for(const file of files(dir)){
      if(fs.readFileSync(file,'utf8').includes(SEAM))users.push(path.relative(repo,file).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(users.filter(f=>f!==DEFINER),[]);
});
