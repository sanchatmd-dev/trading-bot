import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {createProfileEnrollmentTicketAuthority} from '../src/postgres/quant-profile-enrollment-ticket.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
function fixture(){
 const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const job={job_id:'11111111-1111-4111-8111-111111111112',owner_id:contract.owner_id,status:'RUNNING',lease_token:'22222222-2222-4222-8222-222222222222',contract,contract_hash:hash(canonical(contract))};
 const state={epoch:{},transaction:false,reads:0,engine:contract.engine_hash};
 const dependencies={readExecutableHash:async()=>{state.reads++;return state.engine;},releaseGuard:()=>state.epoch,isTransaction:()=>state.transaction};
 const tickets=createProfileEnrollmentTicketAuthority(dependencies);
 const input={job,leaseToken:job.lease_token,operationId:'operation-001',payloadHash:hash('payload'),policy};
 const expected={phase:'BEGIN',jobId:job.job_id,leaseToken:job.lease_token,operationId:input.operationId,contractHash:job.contract_hash,policyHash:capacityPolicyHash(policy),engineHash:contract.engine_hash};
 return {tickets,dependencies,input,expected,state};
}
const denied=fn=>assert.throws(fn,{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
test('private tickets prepare/refresh fresh executable identity and permit SQL-only assertions',async()=>{
 const {tickets,input,expected,state}=fixture(),ticket=await tickets.prepare(input);
 assert.equal(state.reads,1);assert.deepEqual(Object.keys(ticket),[]);assert.equal(Object.isFrozen(ticket),true);
 state.transaction=true;const identity=tickets.assert(ticket,expected);assert.equal(identity.payloadHash,input.payloadHash);
 assert.equal(Object.isFrozen(identity),true);assert.equal(state.reads,1);
 state.transaction=false;const final=await tickets.refresh(ticket);assert.equal(state.reads,2);
 denied(()=>tickets.assert(ticket,{...expected,phase:'FINALIZE'}));denied(()=>tickets.assert(final,expected));
 assert.equal(tickets.assert(final,{...expected,phase:'FINALIZE'}).engineHash,expected.engineHash);
 await assert.rejects(tickets.refresh(final),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
});
test('tickets reject forged/clone/cross-factory and each bound identity mutation',async()=>{
 const {tickets,dependencies,input,expected,state}=fixture(),ticket=await tickets.prepare(input);
 for(const fake of [{},structuredClone(ticket),Object.freeze({}),null])denied(()=>tickets.assert(fake,expected));
 denied(()=>createProfileEnrollmentTicketAuthority(dependencies).assert(ticket,expected));
 for(const [name,value] of Object.entries({phase:'OTHER',jobId:'other-job',leaseToken:'other-token',operationId:'other-operation',contractHash:hash('other-contract'),policyHash:hash('other-policy'),engineHash:hash('other-engine')}))
  denied(()=>tickets.assert(ticket,{...expected,[name]:value}));
 state.epoch={};denied(()=>tickets.assert(ticket,expected));
 state.epoch=null;await assert.rejects(tickets.prepare(input),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
});
test('prepare and refresh reject transactional hashing, hash drift and guard rotation during read',async()=>{
 const {tickets,input,expected,state,dependencies}=fixture();
 state.transaction=true;await assert.rejects(tickets.prepare(input),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});assert.equal(state.reads,0);
 state.transaction=false;const ticket=await tickets.prepare(input);
 state.transaction=true;await assert.rejects(tickets.refresh(ticket),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});assert.equal(state.reads,1);
 state.transaction=false;state.engine=hash('changed-release');await assert.rejects(tickets.refresh(ticket),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
 state.engine=expected.engineHash;
 const rotating=createProfileEnrollmentTicketAuthority({...dependencies,readExecutableHash:async()=>{state.epoch={};return state.engine;}});
 await assert.rejects(rotating.prepare(input),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
});
test('prepare validates authoritative job, exact mode, policy and payload identities before hashing',async()=>{
 for(const mutate of [i=>i.job.status='SUCCEEDED',i=>i.job.owner_id='other',i=>i.job.contract_hash=hash('bad'),i=>i.leaseToken='other-token',i=>i.operationId='bad',i=>i.payloadHash='bad',i=>delete i.job.contract.completion_mode,i=>i.policy.environment='local']){
  const {tickets,input,state}=fixture();mutate(input);await assert.rejects(tickets.prepare(input));assert.equal(state.reads,0);
 }
 denied(()=>createProfileEnrollmentTicketAuthority({}));
});

test('release lifetime observation must be synchronous, never a stable thenable epoch',async()=>{
 const {tickets,input,state}=fixture();
 state.epoch=Promise.resolve({});
 await assert.rejects(tickets.prepare(input),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
 assert.equal(state.reads,0);
 state.epoch={then(){}};
 await assert.rejects(tickets.prepare(input),{code:'PROFILE_ENROLLMENT_TICKET_INVALID'});
 assert.equal(state.reads,0);
});
