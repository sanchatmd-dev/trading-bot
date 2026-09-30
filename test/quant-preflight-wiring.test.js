import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuantPreflightApi} from '../src/postgres/quant-preflight-wiring.js';
import {SOURCE_HASH} from '../src/quant-research/contract.js';
import {pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {canonical} from '../src/pine-bridge/source.js';

function fixture(){
  const calls=[],{policy}=profileV2Fixture(600);
  policy.environment='staging';
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
  const raw={root:'fixture-root',inspect(){},read(){}};
  const researchStore={root:raw.root,storageBudget:{},raw,inspectSidecarV2(){},readV2(){}};
  const db={query:async sql=>{
    calls.push('query');
    if(sql.includes('to_regclass'))return {rows:[{version_table:true,jobs_table:true,boundary_table:true}]};
    if(sql.includes('SELECT version'))return {rows:[{version:1}]};
    throw Error('Unexpected query');
  }};
  const options={pineService:{db,authorize(){}},dataService:{datasetStore:raw,ready:async()=>{calls.push('ready');},scope(){}},
    researchStore,dataEnabled:true,paperTrading:true,
    environment:{PINE_BRIDGE_ENV:'staging',QUANT_RESEARCH_FOUNDATION_ENABLED:'1'},
    loadPolicy:async()=>{calls.push('policy');return policy;},assertEnrollmentSchema:async actual=>{assert.equal(actual,db);calls.push('schema');}};
  return {options,calls,policy};
}
test('disabled API wiring does not load capacity or require optional schemas',async()=>{
  const f=fixture(),value=await createQuantPreflightApi(f.options);
  assert.equal(value.preflightEnabled,false);assert.equal(value.enrollmentEnabled,false);
  assert.deepEqual(f.calls,[]);assert.equal(value.capacityPolicy,undefined);
  assert.equal(value.preflightService.supportedSourceHash,undefined);
  assert.equal(value.preflightService.executableHashes,pf2ExecutableHashes);
  assert.equal(value.profileService.supportedSourceHash,SOURCE_HASH);
});
test('requested activation requires Paper staging foundation and enrollment requires PROFILE V2',async()=>{
  for(const override of [{dataEnabled:false},{paperTrading:false},{environment:{PINE_BRIDGE_ENV:'production'}},
    {environment:{QUANT_RESEARCH_FOUNDATION_ENABLED:'0'}}]){
    const f=fixture();
    const options={...f.options,...override,environment:{...f.options.environment,QUANT_PREFLIGHT_ENABLED:'1',...override.environment}};
    await assert.rejects(createQuantPreflightApi(options),{code:'QUANT_PREFLIGHT_STAGING_REQUIRED'});
    assert.deepEqual(f.calls,[]);
  }
  const f=fixture();f.options.environment.QUANT_PROFILE_V2_ENROLLMENT_ENABLED='1';
  await assert.rejects(createQuantPreflightApi(f.options),{code:'QUANT_PROFILE_V2_REQUIRED'});
  assert.deepEqual(f.calls,[]);
});
test('enabled API shares validated policy and fails before return on policy or schema refusal',async()=>{
  const f=fixture();Object.assign(f.options.environment,{QUANT_PREFLIGHT_ENABLED:'1',QUANT_PROFILE_V2_ENABLED:'1',QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'1'});
  const value=await createQuantPreflightApi(f.options);
  assert.equal(value.preflightEnabled,true);assert.equal(value.enrollmentEnabled,true);
  assert.equal(canonical(value.profileService.capacityPolicy),canonical(value.preflightService.capacityPolicy));
  assert.equal(canonical(value.capacityPolicy),canonical(f.policy));
  assert.equal(value.profileService.profileV2Enabled,true);assert.equal(value.profileService.enrollmentEnabled,true);
  assert.deepEqual(f.calls.slice(0,3),['policy','ready','schema']);
  const error=Error('refused');
  const g=fixture();g.options.environment.QUANT_PREFLIGHT_ENABLED='1';
  g.options.loadPolicy=async()=>{throw error;};
  await assert.rejects(createQuantPreflightApi(g.options),e=>e===error);assert.deepEqual(g.calls,[]);
  const h=fixture();h.options.environment.QUANT_PREFLIGHT_ENABLED='1';
  h.options.assertEnrollmentSchema=async()=>{throw error;};
  await assert.rejects(createQuantPreflightApi(h.options),e=>e===error);
});
test('API refuses a local capacity policy even if supplied by its trusted loader',async()=>{
  const f=fixture();f.options.environment.QUANT_PREFLIGHT_ENABLED='1';f.policy.environment='local';
  await assert.rejects(createQuantPreflightApi(f.options),{code:'QUANT_CAPACITY_POLICY_INVALID'});
  assert.deepEqual(f.calls,['policy']);
});
