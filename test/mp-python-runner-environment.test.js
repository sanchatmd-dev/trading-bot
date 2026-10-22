import test from 'node:test';
import assert from 'node:assert/strict';
import {createPythonRunner} from '../src/multi-pine/python-runner.js';

test('Python runner rejects mixed-case secret extras before any process starts',()=>{
  for(const name of ['dAtAbAsE_uRl','mP_sEcReT','gItHuB_tOkEn','aWs_AcCeSs_KeY','pGpAsSwOrD','pYtHoNsTaRtUp'])
    assert.throws(()=>createPythonRunner({env:{[name]:'fixture'}}),TypeError,name);
});

test('Python runner treats Windows extra names case-insensitively and rejects ambiguous duplicates',()=>{
  const env={Mp_Test_Extra:'first',MP_TEST_EXTRA:'second'};
  if(process.platform==='win32')assert.throws(()=>createPythonRunner({env}),TypeError);
  else assert.doesNotThrow(()=>createPythonRunner({env}));
  assert.doesNotThrow(()=>createPythonRunner({env:{Mp_Test_Extra:'explicit'}}));
});
