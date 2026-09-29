import {capacityPolicyHash} from '../../src/quant-research/capacity-contract.js';

// Engineering fixture identities are synthetic, never runtime enrollment proof.
export function profileV2Fixture(count=50000){
  const sha=letter=>letter.repeat(64),start=Date.UTC(2024,0,1);
  const policy={version:'quant-capacity-v2',environment:'local',
    scope:{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
      execution_model:'paper-close-v1',source_hash:sha('a'),settings_hash:sha('b'),evaluator_hash:sha('c')},
    evidence:{calibration_sha256:sha('d'),parity_sha256:sha('e')},max_raw_bars:50000,max_chunk_bars:1000,
    budget:{candidates:1,max_evaluations:1,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
    io:{read_bytes:100000000,write_bytes:100000000,overshoot_read_bytes:1000000,overshoot_write_bytes:1000000,
      cleanup_read_bytes:2000000,cleanup_write_bytes:2000000}};
  const dataset={dataset_id:sha('1'),sha256:sha('1'),metadata:{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
    symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:start+count*60000,warmup_bars:500,total_bars:count,
    cutoff:start+count*60000,source:'binance-spot-klines-v1'}};
  const model={version:'paper-close-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'5',risk_percent:'1',data_profile:'closed-ohlcv-atr14-v1'};
  const capacity={version:'quant-capacity-v2',environment:'local',policy_hash:capacityPolicyHash(policy),stage:'HISTORICAL_PREFLIGHT',
    scope:structuredClone(policy.scope),dataset:{raw_bars:count,seed_bars:500,warmup_bars:500,evaluation_bars:count-500,processed_bars:count-500},
    chunk_bars:Math.min(1000,count-500),budget:structuredClone(policy.budget),io:structuredClone(policy.io)};
  const contract={version:'quant-foundation-v2',owner_id:'owner-a',bot_id:'fixture-bot',kind:'PROFILE',dataset,engine_hash:sha('f'),snapshot_hash:sha('4'),
    budget:{...capacity.budget,chunk_bars:capacity.chunk_bars},capacity,
    profile:{raw_job_id:'11111111-1111-4111-8111-111111111111',deployment_id:'deployment-123',source_hash:sha('a'),effective_inputs_hash:sha('b'),
      execution_model:model,metadata_hash:sha('2'),raw_provenance_sha256:sha('3'),seed_bars:500,snapshot_hash:sha('4')}};
  return {policy,contract};
}
