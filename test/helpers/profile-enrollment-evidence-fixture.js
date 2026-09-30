import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {createIoBudgetLedger,reserveIoOperation,bindIoOperation,settleIoOperation} from '../../src/quant-research/io-budget-ledger.js';

/** Synthetic evidence only. Never a measured PROFILE producer or host proof.
 * Hashes are assembled directly so negative scenarios can deliberately carry invalid contracts/results.
 */
export function profileEnrollmentEvidenceFixture({contract,result,policy,jobId=randomUUID(),now=Date.now()}){
  const lease=randomUUID(),operationId='fixture-operation',unit='robot-quant-'+hash(canonical({jobId,operationId}))+'.service';
  const devices=[{device_id:'8:0',device_inode:100}],sample={devices:[{...devices[0],read_bytes:0,write_bytes:0}]};
  let state=createIoBudgetLedger({request:contract.capacity,policy,job_id:jobId,lease_token:lease,devices});
  state=reserveIoOperation(state,{operation_id:operationId,lease_token:lease,domain_id:'fixture-domain',cgroup_id:unit,
    allowance:{read_bytes:1024,write_bytes:1024}});
  state=bindIoOperation(state,{operation_id:operationId,lease_token:lease,domain_id:'fixture-domain',cgroup_id:unit,cgroup_inode:200,
    domain_relation:'DISJOINT',domain_proof_sha256:hash('fixture-domain'),identity_proof_sha256:hash('fixture-identity'),
    counter_origin:'CGROUP_BIRTH',sample});
  const stop=hash('fixture-stop'),readback=hash('fixture-readback');
  state=settleIoOperation(state,{operation_id:operationId,lease_token:lease,cgroup_id:unit,cgroup_inode:200,
    stopped:true,stop_proof_sha256:stop,final_readback:true,readback_proof_sha256:readback,sample});
  const job={job_id:jobId,owner_id:contract.owner_id,contract:structuredClone(contract),contract_hash:hash(canonical(contract)),
    result:structuredClone(result),status:'SUCCEEDED',checkpoint:null,next_bar:0,lease_token:null,lease_until:null,
    run_started_at:null,stop_reason:null,worker_id:null};
  const launch={job_id:jobId,operation_id:operationId,lease_token:lease,unit_name:unit,
    payload_hash:hash('synthetic-fixture-payload'),state:'STOP_PROVEN',created_at:now};
  const ledger={job_id:jobId,policy_hash:state.policy_hash,lease_token:lease,revision:state.revision,state,state_hash:hash(canonical(state))};
  const payload={version:'profile-enrollment-receipt-v1',job_id:jobId,operation_id:operationId,lease_token:lease,
    contract_hash:job.contract_hash,payload_hash:launch.payload_hash,result_hash:hash(canonical(result)),
    policy_hash:state.policy_hash,policy:structuredClone(policy),stop_proof_sha256:stop,readback_proof_sha256:readback,completed_at:now};
  return {job,receipt:{...payload,receipt_hash:hash(canonical(payload))},launch,ledger};
}

/** Direct inserts belong only to disposable test databases, never runtime enrollment. */
export async function insertProfileEnrollmentEvidenceFixture(db,evidence){
  const {receipt,launch,ledger}=evidence;
  await db.query('INSERT INTO quant_io_ledgers(job_id,policy_hash,lease_token,revision,state,state_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [ledger.job_id,ledger.policy_hash,ledger.lease_token,ledger.revision,JSON.stringify(ledger.state),ledger.state_hash]);
  await db.query('INSERT INTO quant_io_launches(job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [launch.job_id,launch.operation_id,launch.lease_token,launch.unit_name,launch.payload_hash,launch.state,launch.created_at]);
  const fields=Object.keys(receipt);
  await db.query('INSERT INTO quant_profile_enrollment_receipts('+fields.join(',')+') VALUES('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',
    fields.map(field=>field==='policy'?JSON.stringify(receipt[field]):receipt[field]));
}
