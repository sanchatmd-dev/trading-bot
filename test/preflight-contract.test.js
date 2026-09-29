import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {validateHistoricalPreflightRequest,historicalPreflightHash} from '../src/quant-research/preflight-contract.js';

const start=1800000000000;
function fixture(){
  const snapshot={version:'pf2-snapshot-v1',source_hash:'a'.repeat(64),effective_inputs_hash:'b'.repeat(64),
    bridge_hash:'c'.repeat(64),policy_hash:'d'.repeat(64),capital_hash:'e'.repeat(64),
    initial_state_hash:'f'.repeat(64),execution_model_hash:'1'.repeat(64),venue_metadata_hash:'2'.repeat(64),
    execution_model_version:'paper-close-v1',signal:{mode:'EVALUATOR',evaluator_hash:'3'.repeat(64),artifact_sha256:null},
    development:{start_time:start,end_time:start+10000*60000,holdout_start_time:start+10000*60000}};
  return {version:'historical-preflight-v1',snapshot,foundation:{version:'quant-foundation-v1',owner_id:'owner',bot_id:'bot',
    kind:'PREFLIGHT',engine_hash:'4'.repeat(64),snapshot_hash:hash(canonical(snapshot)),
    dataset:{dataset_id:'5'.repeat(64),sha256:'5'.repeat(64),metadata:{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
      symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:start+10000*60000,cutoff:start+10000*60000,
      total_bars:10000,warmup_bars:500,source:'binance-spot-klines-v1'}},
    budget:{candidates:1,max_evaluations:1,chunk_bars:1000,max_runtime_ms:60000,max_output_bytes:1048576,max_state_bytes:1048576}}};
}
const seal=value=>{value.foundation.snapshot_hash=hash(canonical(value.snapshot));return value;};

test('preflight plan binds every immutable snapshot input and returns frozen detached data',()=>{
  const value=fixture(),result=validateHistoricalPreflightRequest(value);
  const digest=historicalPreflightHash(value);
  assert.equal(digest,historicalPreflightHash({...value,foundation:{...value.foundation}}));
  value.snapshot.policy_hash='9'.repeat(64);
  assert.equal(result.snapshot.policy_hash,'d'.repeat(64));
  assert.ok(Object.isFrozen(result.snapshot.development));
  assert.throws(()=>validateHistoricalPreflightRequest(value));
  assert.notEqual(historicalPreflightHash(seal(value)),digest);
});

test('bound CSV retains fixed input identity and requires its own signal artifact',()=>{
  const value=fixture();value.snapshot.signal.mode='BOUND_SIGNAL_CSV';
  assert.throws(()=>validateHistoricalPreflightRequest(seal(value)));
  value.snapshot.signal.artifact_sha256='6'.repeat(64);
  assert.equal(validateHistoricalPreflightRequest(seal(value)).snapshot.signal.mode,'BOUND_SIGNAL_CSV');
  value.snapshot.signal.optimize_source_inputs=true;
  assert.throws(()=>validateHistoricalPreflightRequest(seal(value)));
});

test('warm-up counts toward existing 10K admission and unsupported model/market reject',()=>{
  const value=fixture();value.foundation.dataset.metadata.total_bars++;
  value.foundation.dataset.metadata.end_time+=60000;value.foundation.dataset.metadata.cutoff+=60000;
  assert.throws(()=>validateHistoricalPreflightRequest(value),{code:'FOUNDATION_CAPABILITY_LIMIT'});
  const v2=fixture();v2.snapshot.execution_model_version='paper-close-cost-v2';
  assert.throws(()=>validateHistoricalPreflightRequest(seal(v2)),{code:'PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED'});
  const futures=fixture();futures.foundation.dataset.metadata.market='FUTURES';
  assert.throws(()=>validateHistoricalPreflightRequest(futures));
});

test('entire artifact must be development-only, including warm-up and half-open end',()=>{
  for(const change of [v=>v.snapshot.development.start_time+=60000,
    v=>v.snapshot.development.end_time-=60000]){
    const value=fixture();change(value);
    assert.throws(()=>validateHistoricalPreflightRequest(seal(value)),{code:'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED'});
  }
  const value=fixture();value.snapshot.development.holdout_start_time-=60000;
  assert.throws(()=>validateHistoricalPreflightRequest(seal(value)));
  assert.equal(validateHistoricalPreflightRequest(fixture()).foundation.dataset.metadata.end_time,
    fixture().snapshot.development.holdout_start_time);
});

test('single replay cannot become an optimization, range loop or malformed JSON plan',()=>{
  for(const edit of [v=>v.foundation.kind='OPTIMIZE',v=>v.foundation.budget.candidates=2,
    v=>v.foundation.budget.max_evaluations=2,v=>v.auto_retry=true,
    v=>v.snapshot.development.end_time+=1]){
    const value=fixture();edit(value);assert.throws(()=>validateHistoricalPreflightRequest(seal(value)));
  }
  let invoked=false;const value=fixture();
  Object.defineProperty(value.snapshot,'policy_hash',{enumerable:true,get(){invoked=true;return 'a'.repeat(64);}});
  assert.throws(()=>validateHistoricalPreflightRequest(value));assert.equal(invoked,false);
});
