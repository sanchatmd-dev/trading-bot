import {canonical,fail,hash} from '../pine-bridge/source.js';
import {validateFoundationRequestV2,PROFILE_ENROLLMENT_MODE,frozenV2,strictJsonV2} from '../quant-research/foundation-contract-v2.js';
import {validateQuantCapacityPolicy} from './quant-capacity-policy.js';
import {capacityPolicyHash} from '../quant-research/capacity-contract.js';

const refused=()=>fail('PROFILE_ENROLLMENT_TICKET_INVALID');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{8,128}$/.test(value);

/** Root wiring owns one factory per live worker. Only that factory recognizes its tickets.
 * The reader and maintenance-lock guard are trusted process dependencies, never request values.
 */
export function createProfileEnrollmentTicketAuthority({readExecutableHash,releaseGuard,isTransaction}={}){
 if(typeof readExecutableHash!=='function'||typeof releaseGuard!=='function'||typeof isTransaction!=='function')
  throw refused();
 const identities=new WeakMap();
 const guarded=epoch=>{const current=releaseGuard();
  if(!current||typeof current.then==='function'||epoch!==undefined&&current!==epoch)throw refused();
  return current;
 };
 const mint=(identity,phase,epoch)=>{
  const ticket=Object.freeze({});identities.set(ticket,{identity,phase,epoch});return ticket;
 };
 const known=ticket=>{const record=identities.get(ticket);if(!record)throw refused();guarded(record.epoch);return record;};
 const observe=async (expected,epoch)=>{
  guarded(epoch);if(isTransaction()!==false)throw refused();
  const observed=await readExecutableHash();
  guarded(epoch);if(isTransaction()!==false||!sha(observed)||observed!==expected)throw refused();
  return observed;
 };
 async function prepare({job,leaseToken,operationId,payloadHash,policy}){
  const epoch=guarded();if(isTransaction()!==false)throw refused();
  strictJsonV2(job);
  const approvedPolicy=validateQuantCapacityPolicy(policy);
  const contract=validateFoundationRequestV2(job.contract,{policy:approvedPolicy});
  if(contract.completion_mode!==PROFILE_ENROLLMENT_MODE||job.status!=='RUNNING'||
     job.owner_id!==contract.owner_id||job.lease_token!==leaseToken||!identifier(job.job_id)||
     !identifier(leaseToken)||!identifier(operationId)||!sha(payloadHash)||
     job.contract_hash!==hash(canonical(contract)))throw refused();
  const identity=frozenV2({jobId:job.job_id,leaseToken,operationId,payloadHash,
   contractHash:job.contract_hash,policyHash:capacityPolicyHash(approvedPolicy),
   engineHash:await observe(contract.engine_hash,epoch)});
  return mint(identity,'BEGIN',epoch);
 }
 async function refresh(ticket){
  const record=known(ticket);if(record.phase!=='BEGIN')throw refused();
  await observe(record.identity.engineHash,record.epoch);
  if(known(ticket)!==record)throw refused();
  // A failed refresh never supplies final authority. A successful refresh retires the old identity.
  identities.delete(ticket);
  return mint(record.identity,'FINALIZE',record.epoch);
 }
 function assert(ticket,{phase,jobId,leaseToken,operationId,contractHash,policyHash,engineHash}){
  const {identity,phase:approvedPhase}=known(ticket);
  if(!['BEGIN','FINALIZE'].includes(phase)||phase!==approvedPhase||
     identity.jobId!==jobId||identity.leaseToken!==leaseToken||
     operationId!==undefined&&identity.operationId!==operationId||identity.contractHash!==contractHash||
     identity.policyHash!==policyHash||identity.engineHash!==engineHash)throw refused();
  return identity;
 }
 return Object.freeze({prepare,refresh,assert});
}
