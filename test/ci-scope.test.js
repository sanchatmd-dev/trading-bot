import test from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../scripts/ci-scope.mjs';
test('CI routes Quant, docs, app and shared changes without dropping shared checks',()=>{
  for(const [paths,expected]of [
    [['quant_lab/uv.lock'],{node:false,quant:true}],
    [['docs/ROADMAP.md'],{node:false,quant:false}],
    [['public/app.js'],{node:true,quant:false}],
    [['src/postgres/schema.sql'],{node:true,quant:true}],
    [['src/postgres/risk.js'],{node:true,quant:true}],
    [['.github/workflows/test.yml'],{node:true,quant:true}],
    [['quant_lab/tests/test_contracts.py','src/postgres/analytics.js'],{node:true,quant:true}],
  ])assert.deepEqual(classify(paths),expected);
});
