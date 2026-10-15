import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {COMMIT,PINS,readPinnedInputs,validateBundle,inventoryTree,sha} from './artifact-core.mjs';

const own=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
assert.ok(args.length===3&&['--qualify','--validate-only'].includes(args[0]),'Usage: verify.mjs --qualify|--validate-only INPUT_DIRECTORY RECEIPT');
const [mode,inputDirectory,receiptFile]=args;
const receipt={schema:'dp1p-linux-artifact-receipt-v1',commit:COMMIT,mode,platform:process.platform,
  arch:process.arch,node:process.version,status:'FAIL',linuxQualified:false,validated:false,extracted:false,
  probeCount:0,syntaxCount:0,cleanup:true,postPins:false};
const started=performance.now();let temporary;
function subprocess(argv,cwd){
  const remaining=60000-(performance.now()-started);assert.ok(remaining>0,'overall execution budget');
  const env={PATH:path.dirname(process.execPath),HOME:temporary,TMPDIR:temporary,LANG:'C.UTF-8',TZ:'UTC'};
  const result=cp.spawnSync(process.execPath,argv,{cwd,env,encoding:'utf8',timeout:Math.min(10000,Math.ceil(remaining)),
    killSignal:'SIGKILL',maxBuffer:16384,windowsHide:true});
  assert.ok(!result.error&&!result.signal&&result.status===0,'bounded subprocess failed');
  assert.equal(result.stderr,'','unexpected subprocess stderr');return result.stdout;
}
try{
  if(mode==='--qualify'&&process.platform!=='linux')throw Object.assign(new Error('Actual Linux required'),{code:'NON_LINUX'});
  assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node >=24 required');
  const buffers=readPinnedInputs(inputDirectory),verified=validateBundle(buffers);
  const version=process.versions.node.split('.').map(Number);
  for(const pkg of verified.packages){
    if(pkg.nodeEngine===null)continue;
    const minimum=/^>=\s*(\d+)(?:\.(\d+|x)(?:\.(\d+))?)?$/.exec(pkg.nodeEngine);
    assert.ok(minimum,'unsupported engine range');
    const required=[Number(minimum[1]),Number(minimum[2]==='x'?0:minimum[2]||0),Number(minimum[3]||0)];
    const difference=version.map((part,index)=>part-required[index]).find(value=>value!==0)||0;
    assert.ok(difference>=0,'dependency Node engine');
  }
  receipt.packageEngines=verified.packages.map(({name,nodeEngine})=>({name,nodeEngine}));
  receipt.validated=true;receipt.counts=verified.counts;receipt.inputPins=PINS;
  if(mode==='--validate-only')receipt.status='LOCAL_VALIDATION_ONLY';
  else{
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dp1p-linux-artifact-'));receipt.cleanup=false;
    for(const entry of verified.entries){
      const destination=path.resolve(temporary,entry.name);assert.ok(destination.startsWith(temporary+path.sep));
      fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,entry.bytes,{flag:'wx',mode:0o644});
    }
    receipt.extracted=true;
    const expected=verified.entries.map(entry=>({name:entry.name,sha256:sha(entry.bytes)})).sort((a,b)=>a.name.localeCompare(b.name));
    assert.deepEqual(inventoryTree(temporary),expected);
    for(const file of verified.closure){subprocess(['--check',path.join(temporary,file)],temporary);receipt.syntaxCount++;}
    receipt.probes=[];
    for(const file of ['probe.cjs','probe.mjs']){
      const destination=path.join(temporary,'.dp1p-'+file);
      fs.copyFileSync(path.join(own,file),destination,fs.constants.COPYFILE_EXCL);
      try{
        const result=JSON.parse(subprocess([destination],temporary));
        assert.equal(result.connectCalled,false);assert.equal(result.decimal,'0.3');assert.equal(result.pool,true);
        assert.ok(Object.values(result.resolved).every(name=>name.startsWith('node_modules/')));
        receipt.probes.push(result);receipt.probeCount++;
      }finally{fs.unlinkSync(destination);}
    }
    assert.deepEqual(inventoryTree(temporary),expected);receipt.inventoryAfterExact=true;
    receipt.status='LINUX_EXACT_ARTIFACT_PASS';receipt.linuxQualified=true;
  }
}catch(error){receipt.error={code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'VERIFICATION_REFUSED',message:'Verification refused; inspect the bounded verifier stage'};}
finally{
  if(receipt.validated){try{readPinnedInputs(inputDirectory);receipt.postPins=true;}catch{receipt.error={code:'POST_PIN_MISMATCH',message:'Input identity changed after validation'};}}
  if(temporary){
    try{assert.ok(path.basename(temporary).startsWith('dp1p-linux-artifact-')&&path.dirname(temporary)===os.tmpdir());fs.rmSync(temporary,{recursive:true,force:true});receipt.cleanup=!fs.existsSync(temporary);}
    catch{receipt.cleanup=false;receipt.error={code:'CLEANUP_FAILED',message:'Owned extraction cleanup failed'};}
  }
  if(!receipt.cleanup||receipt.error){receipt.status='FAIL';receipt.linuxQualified=false;}
  receipt.elapsedMs=Math.round(performance.now()-started);
  fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}
if(receipt.status==='FAIL')process.exitCode=1;
