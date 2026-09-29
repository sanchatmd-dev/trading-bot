import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyQuantDenied} from '../src/quant-research/legacy-admission.js';

test('managed flag rejects legacy calculations and full-history reports before heavy work',async()=>{
  for(const pathname of ['/api/quant/backtest','/api/quant/optimize',
    '/api/analytics/summary','/api/analytics/equity-curve','/api/analytics/breakdown'])
    assert.equal(await legacyQuantDenied(pathname,{foundationEnabled:true}),true);
});
test('authoritative FOUNDATION database mode denies a stale API configuration',async()=>{
  const sql=[];
  const db={query:async query=>{sql.push(query);return {rows:query.includes('to_regclass')?
    [{present:'quant_research_executor_mode'}]:[{mode:'FOUNDATION'}]};}};
  assert.equal(await legacyQuantDenied('/api/quant/optimize',{db}),true);assert.equal(sql.length,2);
});
test('legacy deployments retain existing behavior while health, sizing and status remain reachable',async()=>{
  for(const mode of [null,'LEGACY']){
    const db={query:async query=>({rows:query.includes('to_regclass')?[{present:mode?'table':null}]:[{mode}]})};
    assert.equal(await legacyQuantDenied('/api/quant/backtest',{db}),false);
  }
  for(const path of ['/api/quant/health','/api/quant/risk-preview','/api/quant/runs','/api/quant/research/jobs','/api/analytics/settings'])
    assert.equal(await legacyQuantDenied(path,{foundationEnabled:true}),false);
});
test('missing or unknown installed mode and database errors do not allow legacy compute',async()=>{
  for(const rows of [[],[{}],[{present:false}]])
    await assert.rejects(legacyQuantDenied('/api/quant/backtest',{db:{query:async()=>({rows})}}),
      {code:'QUANT_EXECUTOR_MODE_UNAVAILABLE'});
  for(const rows of [[],[{mode:'UNKNOWN'}],[{mode:'LEGACY'},{mode:'FOUNDATION'}]]){
    const db={query:async query=>({rows:query.includes('to_regclass')?[{present:'table'}]:rows})};
    await assert.rejects(legacyQuantDenied('/api/quant/backtest',{db}),{code:'QUANT_EXECUTOR_MODE_UNAVAILABLE'});
  }
  for(const pathname of ['/api/quant/backtest','/api/analytics/summary'])
    await assert.rejects(legacyQuantDenied(pathname,{db:{query:async()=>{throw Error('offline');}}}),
      {code:'QUANT_EXECUTOR_MODE_UNAVAILABLE',status:503});
});
