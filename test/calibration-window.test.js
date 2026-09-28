import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalibrationWindow,validateCalibrationWindow} from '../src/quant-research/calibration-window.js';

test('driver uses monitor-issued absolute deadline without extending it',()=>{
  const marker={baseline_ok:true,...createCalibrationWindow(100000,300000)};
  assert.equal(validateCalibrationWindow(marker,114000),400000);
  assert.throws(()=>validateCalibrationWindow(marker,400000),{code:'INVALID_CALIBRATION_WINDOW'});
  assert.throws(()=>validateCalibrationWindow({...marker,deadline_ms:400001},114000),{code:'INVALID_CALIBRATION_WINDOW'});
});
