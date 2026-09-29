import {canonical,hash,fail} from '../pine-bridge/source.js';
import {createIoBudgetLedger,reserveIoOperation,bindIoOperation,observeIoOperation,
  settleIoOperation,crashIoOperation,acknowledgeIoCrashStop,fenceIoLedgerLease,
  getIoStopDecision} from '../quant-research/io-budget-ledger.js';
import {validateCapacityPolicy} from '../quant-research/capacity-contract.js';
import {validateFoundationRequestV2} from '../quant-research/foundation-contract-v2.js';

const accountingUnavailable=()=>fail('QUANT_IO_ACCOUNTING_UNAVAILABLE');
const leaseLost=()=>fail('QUANT_IO_LEASE_LOST');
const conflict=()=>fail('QUANT_IO_LEDGER_REVISION_CONFLICT');
const transitions=Object.freeze({reserve:reserveIoOperation,bind:bindIoOperation,
  observe:observeIoOperation,settle:settleIoOperation,crash:crashIoOperation,
  acknowledgeCrashStop:acknowledgeIoCrashStop});

/** Optional durable adapter. Scheduler job must have validated V2 capacity.
 * Policy and device identities come from trusted enrollment, not transition input.
 * Installation of quant-io-ledger-schema.sql is separate and offline.
 */
export class QuantIoLedger {
  constructor({db,policy,devices,authorizeTerminal,clock=Date.now}){
    if(!db||typeof db.transaction!=='function'||typeof clock!=='function'||
      devices!==undefined&&!Array.isArray(devices))throw accountingUnavailable();
    this.db=db;this.clock=clock;this.policy=policy===undefined?null:validateCapacityPolicy(policy);
    this.devices=devices===undefined?null:structuredClone(devices);
    this.authorizeTerminal=authorizeTerminal;
  }

  async locked(jobId,leaseToken,mode,callback){
    // PostgresDatabase nests transactions without a savepoint. A surrounding
    // rollback could otherwise erase a reservation after the process launched.
    if(this.db.isTransaction)throw accountingUnavailable();
    try{return await this.db.transaction(async()=>{
      const singleton=await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
      if(singleton.rowCount!==1)throw accountingUnavailable();
      const job=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
      const now=this.clock();
      if(!job||job.lease_token!==leaseToken||!Number.isSafeInteger(now))throw leaseLost();
      if(mode==='compute'&&(job.status!=='RUNNING'||job.lease_until<=now||job.deadline_at<=now))throw leaseLost();
      if(mode==='terminal'&&!['RUNNING','STOPPING'].includes(job.status))throw leaseLost();
      if(hash(canonical(job.contract))!==job.contract_hash)throw accountingUnavailable();
      if(job.contract.version!=='quant-foundation-v2')throw accountingUnavailable();
      if(mode==='compute'){
        if(!this.policy||!this.devices)throw accountingUnavailable();
        validateFoundationRequestV2(job.contract,{policy:this.policy});
      }
      const row=(await this.db.query('SELECT * FROM quant_io_ledgers WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
      if(mode==='terminal'){
        const io=job.contract.capacity?.io,limits=row?.state?.limits;
        if(!io||!limits||row.policy_hash!==job.contract.capacity.policy_hash||
          ['read','write'].some(direction=>
            limits[direction+'_bytes']!==io[direction+'_bytes']||
            limits['overshoot_'+direction+'_bytes']!==io['overshoot_'+direction+'_bytes']||
            limits['cleanup_'+direction+'_bytes']!==io['cleanup_'+direction+'_bytes']||
            limits['compute_'+direction+'_bytes']!==io[direction+'_bytes']-
              io['overshoot_'+direction+'_bytes']-io['cleanup_'+direction+'_bytes']))
          throw accountingUnavailable();
      }
      return callback(job,row);
    });}
    catch(error){
      if(['QUANT_IO_LEASE_LOST','QUANT_IO_LEDGER_REVISION_CONFLICT',
        'INVALID_IO_BUDGET_LEDGER','INVALID_CAPACITY_CONTRACT','QUANT_IO_ACCOUNTING_UNAVAILABLE'].includes(error?.code))throw error;
      throw accountingUnavailable();
    }
  }

  check(row,jobId){
    if(!row||row.state.job_id!==jobId||row.state.policy_hash!==row.policy_hash||
      row.state.lease_token!==row.lease_token||row.state.revision!==row.revision||
      hash(canonical(row.state))!==row.state_hash)throw accountingUnavailable();
    return row.state;
  }

  async write(jobId,previous,state){
    const params=[jobId,state.policy_hash,state.lease_token,state.revision,
      JSON.stringify(state),hash(canonical(state))];
    const result=previous===null?
      await this.db.query(`INSERT INTO quant_io_ledgers
        (job_id,policy_hash,lease_token,revision,state,state_hash)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,params):
      await this.db.query(`UPDATE quant_io_ledgers SET lease_token=$3,revision=$4,state=$5,state_hash=$6
        WHERE job_id=$1 AND policy_hash=$2 AND revision=$7`,[...params,previous]);
    if(result.rowCount!==1)throw conflict();
    return state;
  }

  async open({jobId,leaseToken}){
    return this.locked(jobId,leaseToken,'compute',async(job,row)=>{
      const expected=createIoBudgetLedger({request:job.contract.capacity,policy:this.policy,
        devices:this.devices,job_id:jobId,lease_token:leaseToken});
      if(!row)return this.write(jobId,null,expected);
      const state=this.check(row,jobId);
      if(state.policy_hash!==expected.policy_hash||canonical(state.limits)!==canonical(expected.limits)||
        canonical(state.devices)!==canonical(expected.devices))throw accountingUnavailable();
      if(state.lease_token===leaseToken)return state;
      const fenced=fenceIoLedgerLease(state,{previous_lease_token:state.lease_token,
        new_lease_token:leaseToken});
      return this.write(jobId,state.revision,fenced);
    });
  }

  async read({jobId,leaseToken}){
    return this.locked(jobId,leaseToken,'terminal',async(_job,row)=>{
      const state=this.check(row,jobId);
      if(state.lease_token!==leaseToken)throw leaseLost();
      return state;
    });
  }

  async transition({jobId,leaseToken,expectedRevision,action,input}){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Object.hasOwn(transitions,action))
      throw accountingUnavailable();
    const compute=action==='reserve'||action==='bind';
    return this.locked(jobId,leaseToken,compute?'compute':'terminal',async(job,row)=>{
      if(!compute&&(typeof this.authorizeTerminal!=='function'||
        (await this.authorizeTerminal({job,action,input}))?.ok!==true))throw accountingUnavailable();
      const state=this.check(row,jobId);
      if(state.lease_token!==leaseToken)throw leaseLost();
      if(state.revision!==expectedRevision)throw conflict();
      const next=transitions[action](state,input);
      if(next===state)return state;
      return this.write(jobId,state.revision,next);
    });
  }

  async reserveBeforeLaunch({jobId,leaseToken,expectedRevision,input}){
    // Returns only after reservation commits. The external supervisor must
    // serialize physical launch with cancellation/lease expiry and enforce stop.
    return this.transition({jobId,leaseToken,expectedRevision,action:'reserve',input});
  }

  async stopDecision({jobId,leaseToken,input}){
    const state=await this.read({jobId,leaseToken});
    return getIoStopDecision(state,input);
  }
}
