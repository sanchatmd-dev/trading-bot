// Operator-only helper. The adapter is reviewed executable code, never user input.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {runCalibrationDriver,calibrationWorkDeadline} from '../src/quant-research/calibration-window.js';

const [ready,done,adapterPath,runId,...extra]=process.argv.slice(2);
if(extra.length||![ready,done,adapterPath].every(value=>value&&path.isAbsolute(value))||!runId)
  throw Error('Usage: quant-calibration-driver.mjs ABS_READY ABS_DONE ABS_REVIEWED_ADAPTER RUN_ID');
const marker=JSON.parse(await fs.readFile(ready,'utf8'));
if(marker.run_id!==runId)throw Error('CALIBRATION_RUN_MISMATCH');
calibrationWorkDeadline(marker,Date.now());
try{await fs.lstat(done);throw Error('CALIBRATION_COMPLETION_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
// Retain this claim even on failure. Retry requires a fresh operator-approved run.
const claim=path.join(path.dirname(ready),`.calibration-${runId}.started`);
const handle=await fs.open(claim,'wx',0o600);
try{await handle.writeFile(JSON.stringify({run_id:runId,issued_at_ms:marker.issued_at_ms}));await handle.sync();}
finally{await handle.close();}
const adapter=await import(pathToFileURL(adapterPath));
const result=await runCalibrationDriver({marker,work:adapter.work,cleanup:adapter.cleanup,
  publish:async completion=>{
    const temporary=done+'.'+randomUUID()+'.tmp';
    let owned=false;
    try{
      const handle=await fs.open(temporary,'wx',0o600);owned=true;
      try{await handle.writeFile(JSON.stringify(completion)+'\n');await handle.sync();}finally{await handle.close();}
      // A same-filesystem hard link publishes a complete record without replacing old evidence.
      await fs.link(temporary,done);
    }finally{if(owned)await fs.unlink(temporary);}
  }});
if(result.status!=='SUCCEEDED')process.exitCode=2;
