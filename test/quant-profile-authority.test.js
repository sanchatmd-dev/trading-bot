import test from 'node:test';
import assert from 'node:assert/strict';
import {QuantProfileService} from '../src/postgres/quant-profile.js';
import {ingestionEngineHash} from '../src/postgres/quant-data.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';

async function fixture(){
  const {policy,contract}=profileV2Fixture(600);
  contract.engine_hash=await ingestionEngineHash();
  const provenance={fixture:'raw-backfill'};
  contract.profile.raw_provenance_sha256=hash(canonical(provenance));
  const market={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
  const model=structuredClone(contract.profile.execution_model);
  contract.profile.metadata_hash=hash(canonical({market,price_tick:String(model.price_tick),
    quantity_step:String(model.quantity_step),data_profile:model.data_profile}));
  const db={isTransaction:true,query:async(sql)=>{
    if(sql.includes('quant_foundation_jobs'))return {rows:[state.row]};
    if(sql.includes('quant_io_launches'))return {rowCount:state.launches};
    if(sql.includes('quant_io_ledgers'))return {rows:[{state:{operations:state.operations}}]};
    throw new Error('Unexpected SQL');
  }};
  const service=new QuantProfileService({pineService:{db},capacityPolicy:policy});
  const state={launches:0,operations:[],revoked:false,
    row:{owner_id:contract.owner_id,job_id:'job-1',status:'STOPPING',lease_token:'lease-1',
      contract:structuredClone(contract),contract_hash:hash(canonical(contract))}};
  service.scope=async(owner,bot)=>{
    if(state.revoked||owner!==contract.owner_id||bot!==contract.bot_id)throw new Error('Scope refused');
  };
  service.raw=async(owner,bot,id)=>{
    if(id!==contract.profile.raw_job_id)throw new Error('Raw job refused');
    return {result:{dataset:structuredClone(contract.dataset),provenance}};
  };
  service.deployment=async(owner,bot,id)=>{
    if(state.stale||id!==contract.profile.deployment_id)throw new Error('Deployment refused');
    return {deployment:{snapshot_hash:contract.snapshot_hash,snapshot:{market}},
      source:{source_hash:contract.profile.source_hash,
        analysis:{effective_inputs_hash:contract.profile.effective_inputs_hash}},
      evidence:{execution_model:model}};
  };
  return {service,contract,state,db};
}

test('V2 authority and runtime release recheck current trusted bindings',async()=>{
  const {service,contract,state}=await fixture();
  for(const action of ['ENQUEUE','CLAIM','HEARTBEAT','CHECKPOINT','FINISH'])
    assert.deepEqual(await service.authorize(contract.owner_id,contract,action),{ok:true},action);
  state.revoked=true;
  assert.deepEqual(await service.authorize(contract.owner_id,contract,'CHECKPOINT'),{ok:false});
});

test('V2 refuses each binding mutation, wrong owner/bot, stale deployment and absent policy',async()=>{
  const {service,contract,state}=await fixture();
  const mutations=[
    c=>{c.owner_id='foreign';},c=>{c.bot_id='foreign';},c=>{c.engine_hash='9'.repeat(64);},
    c=>{c.dataset.sha256=c.dataset.dataset_id='9'.repeat(64);},
    c=>{c.profile.raw_job_id='99999999-9999-4999-8999-999999999999';},
    c=>{c.profile.deployment_id='deployment-other';},
    c=>{c.profile.raw_provenance_sha256='9'.repeat(64);},
    c=>{c.profile.source_hash='9'.repeat(64);},c=>{c.profile.effective_inputs_hash='9'.repeat(64);},
    c=>{c.profile.execution_model.fee_bps='11';},c=>{c.profile.metadata_hash='9'.repeat(64);},
    c=>{c.snapshot_hash=c.profile.snapshot_hash='9'.repeat(64);},
    c=>{c.profile.snapshot_hash='9'.repeat(64);},c=>{c.capacity.policy_hash='9'.repeat(64);},
    c=>{c.capacity.environment='production';},c=>{c.capacity.io.cleanup_read_bytes=1;},
    c=>{c.budget.chunk_bars++;},c=>{c.capacity.scope.evaluator_hash='9'.repeat(64);},
    c=>{c.unexpected=true;}
  ];
  for(const [index,mutate] of mutations.entries()){
    const changed=structuredClone(contract);mutate(changed);
    assert.deepEqual(await service.authorize(contract.owner_id,changed,'CLAIM'),{ok:false},String(index));
  }
  assert.deepEqual(await service.authorize('foreign',contract,'CLAIM'),{ok:false});
  state.stale=true;
  assert.deepEqual(await service.authorize(contract.owner_id,contract,'CLAIM'),{ok:false});
  state.stale=false;service.capacityPolicy=null;
  assert.deepEqual(await service.authorize(contract.owner_id,contract,'CLAIM'),{ok:false});
});

test('V2 cancellation survives revocation and policy rotation, without authorizing foreign owner',async()=>{
  const {service,contract,state}=await fixture();
  state.revoked=true;service.capacityPolicy=null;
  assert.deepEqual(await service.authorize(contract.owner_id,contract,'CANCEL'),{ok:true});
  assert.deepEqual(await service.authorize('foreign',contract,'CANCEL'),{ok:false});
});

test('V2 stop acknowledgement requires transaction, matching durable row and resolved I/O',async()=>{
  const {service,contract,state,db}=await fixture();
  const ack=context=>service.authorize(contract.owner_id,contract,'ACKNOWLEDGE_STOPPED',context);
  const context={job_id:'job-1',lease_token:'lease-1',stopped:true};
  assert.deepEqual(await ack({stopped:true}),{ok:false});
  db.isTransaction=false;assert.deepEqual(await ack(context),{ok:false});db.isTransaction=true;
  assert.deepEqual(await ack({...context,lease_token:'foreign'}),{ok:false});
  state.launches=1;assert.deepEqual(await ack(context),{ok:false});state.launches=0;
  for(const status of ['RESERVED','ACTIVE','STOP_REQUIRED','CRASHED_UNCONFIRMED']){
    state.operations=[{status}];assert.deepEqual(await ack(context),{ok:false},status);
  }
  state.operations=[{status:'SETTLED'}];state.revoked=true;
  assert.deepEqual(await ack({...context,stopped:false}),{ok:true});
  state.row.contract_hash='9'.repeat(64);assert.deepEqual(await ack(context),{ok:false});
  state.row.contract_hash=hash(canonical(state.row.contract));
  state.row.contract.bot_id='foreign';state.row.contract_hash=hash(canonical(state.row.contract));
  assert.deepEqual(await ack(context),{ok:false});
});

test('V1 authority preserves existing trusted checks and stopped-context behavior',async()=>{
  const {service,contract,state}=await fixture();
  const v1=structuredClone(contract);v1.version='quant-foundation-v1';delete v1.capacity;
  assert.deepEqual(await service.authorize(v1.owner_id,v1,'CLAIM'),{ok:true});
  state.revoked=true;
  assert.deepEqual(await service.authorize(v1.owner_id,v1,'CLAIM'),{ok:false});
  assert.deepEqual(await service.authorize(v1.owner_id,v1,'ACKNOWLEDGE_STOPPED',{stopped:true}),{ok:true});
  assert.deepEqual(await service.authorize(v1.owner_id,v1,'ACKNOWLEDGE_STOPPED',{stopped:false}),{ok:false});
});
