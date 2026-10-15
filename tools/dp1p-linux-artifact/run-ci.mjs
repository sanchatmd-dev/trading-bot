import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {rebuildSource} from './rebuild-source.mjs';
import {PINS,sha} from './artifact-core.mjs';
const own=path.dirname(fileURLToPath(import.meta.url)),[mode,repository,receiptPath]=process.argv.slice(2);
assert.ok(['--qualify','--validate-only'].includes(mode)&&repository&&receiptPath,'Usage: run-ci.mjs MODE REPOSITORY RECEIPT');
const started=performance.now();let inputs;
let receipt={schema:'dp1p-linux-carrier-receipt-v1',mode,status:'FAIL',linuxQualified:false,platform:process.platform,
  arch:process.arch,node:process.version,sourceTransport:'read-only existing Git commit; no source payload',inputCleanup:true,phase:'platform'};
function node(argv,extra={}){
  const remaining=120000-(performance.now()-started);assert.ok(remaining>0,'carrier budget');
  const env={PATH:path.dirname(process.execPath),HOME:inputs,TMPDIR:inputs,TEMP:inputs,TMP:inputs,LANG:'C.UTF-8',TZ:'UTC',...extra};
  if(process.platform==='win32')env.SystemRoot=process.env.SystemRoot;
  const result=cp.spawnSync(process.execPath,argv,{cwd:own,env,encoding:'utf8',timeout:Math.min(90000,Math.ceil(remaining)),
    killSignal:'SIGKILL',maxBuffer:32768,windowsHide:true});
  assert.ok(!result.error&&!result.signal&&result.status===0,'bounded carrier child failed');return result.stdout;
}
try{
  if(mode==='--qualify'&&process.platform!=='linux')throw Object.assign(new Error('Linux required'),{code:'NON_LINUX'});
  assert.ok(Number(process.versions.node.split('.')[0])>=24);
  inputs=fs.mkdtempSync(path.join(os.tmpdir(),'dp1p-ci-inputs-'));receipt.inputCleanup=false;receipt.phase='reconstruct';
  fs.writeFileSync(path.join(inputs,'source.tar'),rebuildSource(repository),{flag:'wx'});receipt.rebuiltSourceSha256=PINS['source.tar'];
  receipt.phase='payload';const transport=JSON.parse(fs.readFileSync(path.join(own,'payload-pins.json')));
  for(const name of ['deps.tar.gz','manifest.txt','bundle.json']){
    const bytes=fs.readFileSync(path.join(own,'payload',name));assert.equal(sha(bytes),transport[name].sha256);assert.equal(bytes.length,transport[name].bytes);
    const output=name.endsWith('.gz')?zlib.gunzipSync(bytes,{maxOutputLength:20*1024*1024}):bytes;
    const destination=name==='deps.tar.gz'?'deps.tar':name;assert.equal(sha(output),PINS[destination]);
    fs.writeFileSync(path.join(inputs,destination),output,{flag:'wx'});
  }
  receipt.phase='negative-controls';
  const negative=node(['--test','negative.test.mjs'],{DP1P_TEST_INPUTS:inputs});
  const count=/\btests (\d+)/.exec(negative),failed=/\bfail (\d+)/.exec(negative),skipped=/\bskipped (\d+)/.exec(negative);
  assert.ok(count&&failed&&skipped);assert.equal(Number(failed[1]),0);assert.equal(Number(skipped[1]),0);
  receipt.negativeTests={tests:Number(count[1]),failed:0,skipped:0};
  receipt.phase='verify';const childReceipt=path.join(inputs,'receipt.json');
  node(['verify.mjs',mode,inputs,childReceipt]);const verified=JSON.parse(fs.readFileSync(childReceipt));
  assert.equal(verified.mode,mode);assert.equal(verified.cleanup,true);assert.equal(verified.postPins,true);
  assert.equal(verified.status,mode==='--qualify'?'LINUX_EXACT_ARTIFACT_PASS':'LOCAL_VALIDATION_ONLY');
  assert.equal(verified.linuxQualified,mode==='--qualify');
  receipt={...receipt,verification:verified,status:verified.status,linuxQualified:verified.linuxQualified,phase:'complete'};
}catch(error){receipt.error={code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'CARRIER_REFUSED',phase:receipt.phase};}
finally{
  if(inputs){try{assert.ok(path.basename(inputs).startsWith('dp1p-ci-inputs-')&&path.dirname(inputs)===os.tmpdir());fs.rmSync(inputs,{recursive:true,force:true});receipt.inputCleanup=!fs.existsSync(inputs);}catch{receipt.inputCleanup=false;}}
  if(receipt.error||!receipt.inputCleanup){receipt.status='FAIL';receipt.linuxQualified=false;}
  receipt.elapsedMs=Math.round(performance.now()-started);fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
}
if(receipt.status==='FAIL')process.exitCode=1;
