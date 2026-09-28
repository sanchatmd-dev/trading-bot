import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectCalibrationCompletion} from '../src/quant-research/calibration-window.js';
const cli=fileURLToPath(new URL('../scripts/quant-calibration-driver.mjs',import.meta.url));

for(const scenario of ['success','work-failure','preserve-evidence','duplicate-run'])test(`completion CLI ${scenario}`,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quant-completion-'));
  try{
    const ready=path.join(directory,'ready.json'),done=path.join(directory,'done.json'),adapter=path.join(directory,'adapter.mjs');
    const now=Date.now(),marker={baseline_ok:true,run_id:'cli-test-123456789',issued_at_ms:now,deadline_ms:now+10000,cleanup_reserve_ms:2000};
    await fs.writeFile(ready,JSON.stringify(marker));
    const workLog=path.join(directory,'work.log');
    await fs.writeFile(adapter,`import fs from 'node:fs/promises';\nexport async function work(){await fs.appendFile(${JSON.stringify(workLog)},'work\\n');${scenario==='work-failure'?'throw Error("fixture");':'return true;'}} export async function cleanup(){return true;}`);
    if(scenario==='preserve-evidence')await fs.writeFile(done,'prior evidence');
    const result=spawnSync(process.execPath,[cli,ready,done,adapter,marker.run_id],{encoding:'utf8',timeout:5000,windowsHide:true});
    if(scenario==='preserve-evidence'){
      assert.notEqual(result.status,0);assert.equal(await fs.readFile(done,'utf8'),'prior evidence');
      await assert.rejects(fs.access(workLog),{code:'ENOENT'});
    }else{
      assert.equal(result.status,scenario==='work-failure'?2:0,result.stderr);
      const completion=JSON.parse(await fs.readFile(done,'utf8'));
      assert.equal(inspectCalibrationCompletion(marker,completion,Date.now()),scenario==='work-failure'?'DRIVER_FAILED':'DRIVER_DONE');
      if(scenario==='duplicate-run'){
        await fs.unlink(done); // Even missing completion must not reopen a claimed run.
        const duplicate=spawnSync(process.execPath,[cli,ready,done,adapter,marker.run_id],{encoding:'utf8',timeout:5000,windowsHide:true});
        assert.notEqual(duplicate.status,0);assert.equal(await fs.readFile(workLog,'utf8'),'work\n');
      }
    }
    assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.tmp')),false);
  }finally{
    const target=path.resolve(directory),temporaryRoot=path.resolve(os.tmpdir())+path.sep;
    assert.ok(target.startsWith(temporaryRoot)&&path.basename(target).startsWith('quant-completion-'));
    await fs.rm(target,{recursive:true,force:true});
  }
});
