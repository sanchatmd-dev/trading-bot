import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDatasetMetadata, validateDatasetReference, validateFoundationRequest, foundationRequestHash} from '../src/quant-research/foundation-contract.js';

const metadata = (total = 3000) => ({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:60000,end_time:(total+1)*60000,warmup_bars:1000,total_bars:total,cutoff:(total+1)*60000,source:'binance-spot-klines-v1'});
const request = () => ({version:'quant-foundation-v1',owner_id:'owner-1',bot_id:'bot-1',kind:'OPTIMIZE',dataset:{dataset_id:'a'.repeat(64),sha256:'a'.repeat(64),metadata:metadata()},engine_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64),budget:{candidates:10,max_evaluations:30,chunk_bars:1000,max_runtime_ms:60000,max_output_bytes:8192,max_state_bytes:4096}});

test('foundation freezes detached request and deterministic identity without embedding bars', () => {
  const input=request(), frozen=validateFoundationRequest(input), digest=foundationRequestHash(input);
  input.budget.candidates=20;
  assert.equal(frozen.budget.candidates,10);
  assert.equal(digest,foundationRequestHash({...frozen,budget:{...frozen.budget}}));
  assert.notEqual(digest,foundationRequestHash(input));
  assert.throws(()=>validateDatasetReference({...frozen.dataset,path:'../private'}),{code:'INVALID_FIELDS'});
  assert.throws(()=>validateDatasetReference({...frozen.dataset,sha256:'d'.repeat(64)}),{code:'INVALID_DATASET_REFERENCE'});
});

test('storage ceiling does not grant expanded evaluator admission', () => {
  assert.equal(validateDatasetMetadata(metadata(1_000_000)).total_bars,1_000_000);
  const input=request(); input.dataset.metadata=metadata(10_001);
  assert.throws(()=>validateFoundationRequest(input),{code:'FOUNDATION_CAPABILITY_LIMIT'});
  assert.throws(()=>validateDatasetMetadata(metadata(1_000_001)),{code:'INVALID_DATASET_BAR_COUNT'});
});

test('half-open completed-bar contract rejects unclosed, misaligned and inconsistent intervals', () => {
  for (const patch of [{end_time:180000001},{cutoff:179999999},{start_time:1},{total_bars:2999}]) {
    assert.throws(()=>validateDatasetMetadata({...metadata(),...patch}),{code:'INVALID_DATASET_INTERVAL'});
  }
  assert.throws(()=>validateDatasetMetadata({...metadata(),warmup_bars:3000}),{code:'INVALID_DATASET_WARMUP'});
  for (const patch of [{market:'FUTURES'},{symbol:'BTCUSD'},{timeframe:'5'},{source:'user-price-guess'}]) {
    assert.throws(()=>validateDatasetMetadata({...metadata(),...patch}),{code:'UNSUPPORTED_DATASET_PROFILE'});
  }
});

test('strict budgets reject oversized, nonfinite, fractional and omitted work estimates', () => {
  for (const patch of [{candidates:101},{max_evaluations:126},{max_evaluations:2},{chunk_bars:3001},
    {max_runtime_ms:900001},{max_output_bytes:8388609},{max_state_bytes:1048577},
    {candidates:Infinity},{candidates:1.5},{chunk_bars:0}]) {
    const input=request(); Object.assign(input.budget,patch);
    assert.throws(()=>validateFoundationRequest(input),{code:'INVALID_FOUNDATION_BUDGET'});
  }
  const input=request(); delete input.budget.max_state_bytes;
  assert.throws(()=>validateFoundationRequest(input),{code:'INVALID_FIELDS'});
});
