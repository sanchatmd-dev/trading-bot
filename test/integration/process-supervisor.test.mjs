import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {runQuantProcess} from '../../src/quant-research/process-supervisor.js';
const python=process.env.QUANT_RESEARCH_PYTHON||path.resolve('quant_lab/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const options={python,module:'quant_lab.tests.quant_process_probe',allowUnsupportedPlatformForTests:true};
test('process supervisor returns only after exit and limits native library threads',async()=>{
  const result=await runQuantProcess({...options,payload:{mode:'ok'}});
  assert.equal(result.ok,true);assert.equal(result.thread_limit,'1');
});
test('process supervisor times out and confirms stop before rejecting',async()=>{
  await assert.rejects(runQuantProcess({...options,payload:{mode:'sleep'},timeoutMs:500}),error=>error.code==='EVALUATION_TIMED_OUT'&&error.stopped===true);
});
test('process supervisor bounds output and pre-aborted jobs never start',async()=>{
  await assert.rejects(runQuantProcess({...options,payload:{mode:'output'}}),error=>error.code==='EVALUATION_OUTPUT_TOO_LARGE'&&error.stopped===true);
  const controller=new AbortController();controller.abort();
  await assert.rejects(runQuantProcess({...options,payload:{mode:'sleep'},signal:controller.signal}),error=>error.code==='RESEARCH_INTERRUPTED'&&error.stopped===true);
});
