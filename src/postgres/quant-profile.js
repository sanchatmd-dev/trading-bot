import {randomUUID} from 'node:crypto';
import {canonical,fail,hash,keys} from '../pine-bridge/source.js';
import {D,amount,Money} from '../money.js';
import {SOURCE_HASH} from '../quant-research/contract.js';
import {validateBackfillResult,validateFoundationRequest} from '../quant-research/foundation-contract.js';
import {validateProfileResult} from '../quant-research/profile-contract.js';
import {validateProfileEnrollmentReceipt} from '../quant-research/profile-contract-v2.js';
import {readProfileEnrollmentEvidence} from './quant-profile-enrollment-evidence.js';
import {validateFoundationRequestV2,PROFILE_ENROLLMENT_MODE} from '../quant-research/foundation-contract-v2.js';
import {validateCapacityPolicy,capacityPolicyHash} from '../quant-research/capacity-contract.js';
import {verifyEnrollmentBinding} from '../quant-research/data-profile.js';
import {freshSnapshot,deploymentEvidence} from './pine-bridge-readiness.js';
import {ingestionEngineHash} from './quant-data.js';
import {readJson} from './http.js';
import {canReleaseQuantIo} from './quant-io-runtime.js';
import {validateQuantCapacityPolicy} from './quant-capacity-policy.js';
import {assertQuantProfileEnrollmentSchema} from './quant-profile-enrollment-migration.js';

const active=['QUEUED','PAUSED','RUNNING','STOPPING'];
const minute=60000;
const settings={preset:'Custom',tradeDirectionectionection:'Long + Exit',useSlowFilter:true,
  useMTF:false,useRSIFilter:false,requireBOS:false,requireSweep:false,slMode:'Zone + ATR',
  useSession:false,confirmMode:'Any',notifyEnabled:false};

/** Transaction-local service. Caller owns the SERIALIZABLE transaction. */
export class QuantProfileService{
  constructor({pineService,dataService,researchStore,clock=Date.now,enabled=false,
    supportedSourceHash=SOURCE_HASH,capacityPolicy,profileV2Enabled=false,enrollmentEnabled=false,
    enrollmentTicketVerifier}={}){
    this.pine=pineService;this.db=pineService?.db;this.data=dataService;
    this.researchStore=researchStore;this.clock=clock;this.enabled=enabled;
    this.supportedSourceHash=supportedSourceHash;
    this.capacityPolicy=capacityPolicy===undefined?null:validateCapacityPolicy(capacityPolicy);
    this.profileV2Enabled=profileV2Enabled===true;this.enrollmentEnabled=enrollmentEnabled===true;
    this.enrollmentTicketVerifier=enrollmentTicketVerifier;
  }
  async ready(){
    if(!this.enabled)throw fail('QUANT_PROFILE_DISABLED',503);
    await this.data.ready();
    if(!this.researchStore?.storageBudget||
       this.researchStore.root!==this.data.datasetStore.root)throw fail('PROFILE_STORAGE_BUDGET_REQUIRED',503);
  }
  async scope(owner,bot){await this.data.scope(owner,bot);}
  async deployment(owner,bot,id){
    const deployment=await this.db.prepare(
      'SELECT * FROM pine_deployments WHERE owner_id=? AND bot_id=? AND deployment_id=?').get(owner,bot,id);
    if(!deployment)throw fail('NOT_FOUND',404);
    if(deployment.state!=='READY')throw fail('RESEARCH_DEPLOYMENT_NOT_READY',409);
    if(hash(canonical(deployment.snapshot))!==deployment.snapshot_hash)throw fail('SNAPSHOT_HASH_MISMATCH',409);
    await freshSnapshot(this.pine,deployment);
    const evidence=await deploymentEvidence(this.db,deployment);
    const snapshot=deployment.snapshot;
    if(snapshot.membership?.length!==1||snapshot.policy?.paperTrading!==true||
       snapshot.policy?.requireReduceOnlySell!==true||snapshot.market?.broker!=='binance-global'||
       snapshot.market?.symbol!=='BTCUSDT'||snapshot.market?.timeframe!=='1'||
       canonical(snapshot.selection?.signals)!==canonical({buy:'buySignal',exit:'sellSignal',timing:'bar_close'}))
      throw fail('PROFILE_DEPLOYMENT_UNSUPPORTED',409);
    const source=await this.pine.source(owner,bot,deployment.pine_import_id,deployment.source_version);
    if(source.source_hash!==this.supportedSourceHash||hash(source.source)!==source.source_hash||
       snapshot.source_hash!==source.source_hash)throw fail('UNSUPPORTED_SOURCE_HASH',409);
    const review=source.analysis?.effective_input_review;
    if(source.analysis?.inputs?.length!==58||!review||review.source_hash!==source.source_hash||
       review.effective_inputs_hash!==source.analysis.effective_inputs_hash||review.input_count!==58||
       !review.reviewed_by||!Number.isSafeInteger(review.reviewed_at))
      throw fail('CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',409);
    const effective=Object.fromEntries(source.analysis.inputs.map(input=>[input.pine_variable,input.effective_value]));
    if(Object.entries(settings).some(([name,value])=>effective[name]!==value))
      throw fail('UNSUPPORTED_CUSTOM_SETTING',409);
    return {deployment,evidence,source};
  }
  async rawRow(owner,bot,id){
    const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
    if(!row||row.owner_id!==owner||row.contract?.bot_id!==bot||row.contract.kind!=='BACKFILL')
      throw fail('NOT_FOUND',404);
    if(row.status!=='SUCCEEDED'||hash(canonical(row.contract))!==row.contract_hash)
      throw fail('BACKFILL_RESULT_UNAVAILABLE',409);
    validateBackfillResult(row.contract,row.checkpoint,row.result);
    return row;
  }
  async raw(owner,bot,id){
    const row=await this.rawRow(owner,bot,id);
    await this.data.datasetStore.inspect(row.result.dataset);
    return row;
  }
  async expose(row){
    if(hash(canonical(row.contract))!==row.contract_hash||row.contract.kind!=='PROFILE')
      throw fail('FOUNDATION_INTEGRITY_FAILED');
    if(row.checkpoint||row.next_bar!==0)throw fail('PROFILE_CHECKPOINT_INVALID');
    if(row.status==='SUCCEEDED'){
      if(row.contract.version==='quant-foundation-v2'){
        const evidence=await readProfileEnrollmentEvidence(this.db,row.job_id);
        validateProfileEnrollmentReceipt(evidence??{});
        if(evidence.job.contract_hash!==row.contract_hash||canonical(evidence.job.contract)!==canonical(row.contract)||
          canonical(evidence.job.result)!==canonical(row.result))throw fail('PROFILE_ENROLLMENT_RECEIPT_INVALID');
      }else validateProfileResult(row.contract,row.result);
    }
    return {job_id:row.job_id,status:row.status,next_bar:row.next_bar,
      total_bars:row.contract.dataset.metadata.total_bars-500,
      diagnostic:row.diagnostic??null,result:row.status==='SUCCEEDED'?row.result:null,
      data_profile_verified:row.status==='SUCCEEDED',evaluator_admission:false};
  }
  async enqueue(owner,body,key){
    await this.ready();
    keys(body,['bot_id','raw_job_id','deployment_id']);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    await this.scope(owner,body.bot_id);
    const previous=(await this.db.query(
      'SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,key])).rows[0];
    if(previous){
      if(previous.contract?.version!=='quant-foundation-v1'||previous.contract.kind!=='PROFILE'||previous.contract.bot_id!==body.bot_id||
         previous.contract.profile.raw_job_id!==body.raw_job_id||
         previous.contract.profile.deployment_id!==body.deployment_id)
        throw fail('IDEMPOTENCY_CONFLICT',409);
      return this.expose(previous);
    }
    const raw=await this.raw(owner,body.bot_id,body.raw_job_id);
    const {deployment,evidence,source}=await this.deployment(owner,body.bot_id,body.deployment_id);
    const model=evidence.execution_model;
    const profile={raw_job_id:body.raw_job_id,deployment_id:deployment.deployment_id,
      source_hash:source.source_hash,effective_inputs_hash:source.analysis.effective_inputs_hash,
      execution_model:model,metadata_hash:hash(canonical({market:deployment.snapshot.market,
        price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),
      data_profile:model.data_profile})),raw_provenance_sha256:hash(canonical(raw.result.provenance)),
      seed_bars:500,snapshot_hash:deployment.snapshot_hash};
    const count=(await this.db.query("SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned FROM quant_foundation_jobs WHERE status=ANY($2::text[])",[owner,active])).rows[0];
    if(count.total>=100||count.owned>=20)throw fail('FOUNDATION_QUEUE_FULL',429);
    const contract=validateFoundationRequest({version:'quant-foundation-v1',owner_id:owner,
      bot_id:body.bot_id,kind:'PROFILE',dataset:raw.result.dataset,
      engine_hash:await ingestionEngineHash(),snapshot_hash:deployment.snapshot_hash,profile,
      budget:{candidates:1,max_evaluations:1,chunk_bars:Math.min(1000,raw.result.dataset.metadata.total_bars),
        max_runtime_ms:900000,max_output_bytes:1024*1024,max_state_bytes:1024*1024}});
    await this.db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
    const now=this.clock(),id=randomUUID();
    const row=(await this.db.query(`INSERT INTO quant_foundation_jobs
      (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
      VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,
      [id,owner,key,JSON.stringify(contract),hash(canonical(contract)),now,now+contract.budget.max_runtime_ms])).rows[0];
    return this.expose(row);
  }
  async authorize(owner,contract,action,context={}){
    if(contract?.version==='quant-foundation-v2')return this.authorizeV2(owner,contract,action,context);
    if(contract.kind!=='PROFILE'||contract.owner_id!==owner)return {ok:false};
    if(action==='ACKNOWLEDGE_STOPPED')return {ok:context.stopped===true};
    return this.authorizeBindings(owner,contract);
  }
  /** Explicit owner enrollment admission. The server chooses every execution field. */
  async enqueueEnrollment(owner,body,key){
    if(!this.profileV2Enabled||!this.enrollmentEnabled)throw fail('PROFILE_ENROLLMENT_DISABLED',503);
    if(!this.db?.isTransaction)throw fail('PROFILE_ENROLLMENT_TRANSACTION_REQUIRED');
    if((await this.db.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation!=='serializable')
      throw fail('PROFILE_ENROLLMENT_TRANSACTION_REQUIRED');
    await this.ready();
    await assertQuantProfileEnrollmentSchema(this.db);
    keys(body,['bot_id','raw_job_id','deployment_id']);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    await this.scope(owner,body.bot_id);
    const previous=(await this.db.query(
      'SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,key])).rows[0];
    if(previous){
      if(previous.owner_id!==owner||previous.contract?.version!=='quant-foundation-v2'||
         previous.contract.kind!=='PROFILE'||previous.contract.completion_mode!==PROFILE_ENROLLMENT_MODE||
         previous.contract.owner_id!==owner||previous.contract.bot_id!==body.bot_id||
         previous.contract.profile.raw_job_id!==body.raw_job_id||
         previous.contract.profile.deployment_id!==body.deployment_id)throw fail('IDEMPOTENCY_CONFLICT',409);
      return this.expose(previous);
    }
    const policy=validateQuantCapacityPolicy(this.capacityPolicy);
    const raw=await this.raw(owner,body.bot_id,body.raw_job_id);
    const {deployment,evidence,source}=await this.deployment(owner,body.bot_id,body.deployment_id);
    const model=evidence.execution_model,metadata=raw.result.dataset.metadata,total=metadata.total_bars;
    if(total>10000)throw fail('PROFILE_ENROLLMENT_CAPACITY_UNSUPPORTED',409);
    const profile={raw_job_id:body.raw_job_id,deployment_id:deployment.deployment_id,
      source_hash:source.source_hash,effective_inputs_hash:source.analysis.effective_inputs_hash,
      execution_model:model,metadata_hash:hash(canonical({market:deployment.snapshot.market,
        price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),data_profile:model.data_profile})),
      raw_provenance_sha256:hash(canonical(raw.result.provenance)),seed_bars:500,snapshot_hash:deployment.snapshot_hash};
    const budget={candidates:1,max_evaluations:1,max_runtime_ms:Math.min(900000,policy.budget.max_runtime_ms),
      max_output_bytes:Math.min(1048576,policy.budget.max_output_bytes),
      max_state_bytes:Math.min(1048576,policy.budget.max_state_bytes)};
    if(budget.max_runtime_ms<policy.terminal.runtime_max_ms+5000)
      throw fail('PROFILE_ENROLLMENT_CAPACITY_UNSUPPORTED',409);
    const chunkBars=Math.min(1000,policy.max_chunk_bars,total-500);
    const capacity={version:'quant-capacity-v2',environment:'staging',policy_hash:capacityPolicyHash(policy),
      stage:'HISTORICAL_PREFLIGHT',scope:policy.scope,dataset:{raw_bars:total,seed_bars:500,
        warmup_bars:metadata.warmup_bars,evaluation_bars:total-metadata.warmup_bars,processed_bars:total-500},
      chunk_bars:chunkBars,budget,io:policy.io};
    const contract=validateFoundationRequestV2({version:'quant-foundation-v2',completion_mode:PROFILE_ENROLLMENT_MODE,
      owner_id:owner,bot_id:body.bot_id,kind:'PROFILE',dataset:raw.result.dataset,
      engine_hash:await ingestionEngineHash(),snapshot_hash:deployment.snapshot_hash,profile,capacity,
      budget:{...budget,chunk_bars:chunkBars}},{policy});
    if((await this.authorizeV2(owner,contract,'ENQUEUE'))?.ok!==true)throw fail('FOUNDATION_FORBIDDEN',403);
    const count=(await this.db.query("SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned FROM quant_foundation_jobs WHERE status=ANY($2::text[])",
      [owner,active])).rows[0];
    if(count.total>=100||count.owned>=20)throw fail('FOUNDATION_QUEUE_FULL',429);
    const now=this.clock();
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+budget.max_runtime_ms))
      throw fail('FOUNDATION_INVALID_CLOCK');
    await this.db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
    const row=(await this.db.query(`INSERT INTO quant_foundation_jobs
      (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
      VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,
      [randomUUID(),owner,key,JSON.stringify(contract),hash(canonical(contract)),now,now+budget.max_runtime_ms])).rows[0];
    return this.expose(row);
  }
  /** Authorizes execution only; provisional V2 results are not enrolled here.
   * Runtime release calls the same authority inside its fenced transaction.
   */
  async authorizeV2(owner,contract,action,context={}){
    if(contract?.version!=='quant-foundation-v2'||contract.kind!=='PROFILE'||
       contract.owner_id!==owner)return {ok:false};
    // Revoked execution permission must never prevent the owner from stopping work.
    if(action==='CANCEL')return {ok:true};
    try{
      if(action==='ACKNOWLEDGE_STOPPED'){
        if(!this.db?.isTransaction||typeof context.job_id!=='string'||
           typeof context.lease_token!=='string')return {ok:false};
        const row=(await this.db.query(
          'SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[context.job_id])).rows[0];
        if(!row||row.owner_id!==owner||row.status!=='STOPPING'||
           row.lease_token!==context.lease_token||
           hash(canonical(row.contract))!==row.contract_hash||
           canonical(row.contract)!==canonical(contract))return {ok:false};
        return await canReleaseQuantIo(this.db,row);
      }
      if(contract.completion_mode===PROFILE_ENROLLMENT_MODE&&(!this.profileV2Enabled||!this.enrollmentEnabled))
        return {ok:false};
      const approved=validateFoundationRequestV2(contract,{policy:this.capacityPolicy});
      return await this.authorizeBindings(owner,approved);
    }catch{return {ok:false};}
  }
  async authorizeBindings(owner,contract){
    try{
      await this.scope(owner,contract.bot_id);
      if(await ingestionEngineHash()!==contract.engine_hash)return {ok:false};
      const raw=await this.raw(owner,contract.bot_id,contract.profile.raw_job_id);
      if(canonical(raw.result.dataset)!==canonical(contract.dataset)||
         hash(canonical(raw.result.provenance))!==contract.profile.raw_provenance_sha256)return {ok:false};
      const {deployment,source,evidence}=await this.deployment(owner,contract.bot_id,contract.profile.deployment_id);
      const model=evidence.execution_model;
      const metadataHash=hash(canonical({market:deployment.snapshot.market,
        price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),
        data_profile:model.data_profile}));
      if(source.source_hash!==contract.profile.source_hash||
         source.analysis.effective_inputs_hash!==contract.profile.effective_inputs_hash||
         canonical(model)!==canonical(contract.profile.execution_model)||
         metadataHash!==contract.profile.metadata_hash||deployment.snapshot_hash!==contract.snapshot_hash)
        return {ok:false};
      return {ok:true};
    }catch{return {ok:false};}
  }
  /** Completion authority uses persisted evidence only. The caller owns schema and runtime locks.
   * Ordinary execution authority above still inspects artifacts and hashes the executable closure.
   */
  async authorizeEnrollmentLocked(owner,contract,{jobId,leaseToken,executionTicket,phase}={}){
    if(!this.db?.isTransaction||!this.profileV2Enabled||!this.enrollmentEnabled||
       typeof this.enrollmentTicketVerifier!=='function'||!['BEGIN','FINALIZE'].includes(phase))return {ok:false};
    if((await this.db.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation!=='serializable')
      return {ok:false};
    try{
      const policy=validateQuantCapacityPolicy(this.capacityPolicy);
      const approved=validateFoundationRequestV2(contract,{policy});
      if(approved.owner_id!==owner||approved.completion_mode!==PROFILE_ENROLLMENT_MODE)return {ok:false};
      const contractHash=hash(canonical(approved));
      this.enrollmentTicketVerifier(executionTicket,{phase,jobId,leaseToken,contractHash,
        policyHash:capacityPolicyHash(policy),engineHash:approved.engine_hash});
      const job=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
      if(!job||job.owner_id!==owner||job.lease_token!==leaseToken||job.contract_hash!==contractHash||
         canonical(job.contract)!==canonical(approved)||job.checkpoint!==null||job.next_bar!==0||job.result!==null||
         (phase==='BEGIN'?(job.status!=='RUNNING'||job.stop_reason!==null):
          (job.status!=='STOPPING'||job.stop_reason!=='PROFILE_COMPLETING')))return {ok:false};
      await this.scope(owner,approved.bot_id);
      const raw=await this.rawRow(owner,approved.bot_id,approved.profile.raw_job_id);
      if(canonical(raw.result.dataset)!==canonical(approved.dataset)||
         hash(canonical(raw.result.provenance))!==approved.profile.raw_provenance_sha256)return {ok:false};
      const locked=(await this.db.query(`SELECT deployment_id FROM pine_deployments
        WHERE owner_id=$1 AND bot_id=$2 AND deployment_id=$3 FOR SHARE`,
        [owner,approved.bot_id,approved.profile.deployment_id])).rows[0];
      if(!locked)return {ok:false};
      const {deployment,source,evidence}=await this.deployment(owner,approved.bot_id,approved.profile.deployment_id);
      const model=evidence.execution_model;
      const member=deployment.snapshot.membership[0];
      const metadataHash=hash(canonical({market:deployment.snapshot.market,price_tick:String(model.price_tick),
        quantity_step:String(model.quantity_step),data_profile:model.data_profile}));
      if(member.pine_import_id!==deployment.pine_import_id||member.source_version!==deployment.source_version||
         member.source_hash!==source.source_hash||canonical(member.analysis)!==canonical(source.analysis)||
         source.source_hash!==approved.profile.source_hash||
         source.analysis.effective_inputs_hash!==approved.profile.effective_inputs_hash||
         canonical(model)!==canonical(approved.profile.execution_model)||metadataHash!==approved.profile.metadata_hash||
         deployment.snapshot_hash!==approved.snapshot_hash)return {ok:false};
      // Recheck the private lifetime guard after asynchronous SQL authority work.
      this.enrollmentTicketVerifier(executionTicket,{phase,jobId,leaseToken,contractHash,
        policyHash:capacityPolicyHash(this.capacityPolicy),engineHash:approved.engine_hash});
      return {ok:true};
    }catch(error){
      // Domain revocation is controlled denial. Database/integrity failures must roll back publication.
      if(typeof error.code==='string'&&Number.isInteger(error.status)&&error.status<500)return {ok:false};
      throw error;
    }
  }
  async get(owner,id,cancel=false,queryBotId=null){
    await this.ready();
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||row.owner_id!==owner||row.contract.kind!=='PROFILE'||
       (queryBotId!==null&&queryBotId!==row.contract.bot_id))throw fail('NOT_FOUND',404);
    await this.scope(owner,row.contract.bot_id);
    if(!cancel||!active.includes(row.status))return this.expose(row);
    const stopping=['RUNNING','STOPPING'].includes(row.status),now=this.clock();
    const updated=(await this.db.query(`UPDATE quant_foundation_jobs SET status=$2,stop_reason=$3,lease_until=NULL,
      runtime_used_ms=runtime_used_ms+CASE WHEN run_started_at IS NULL THEN 0 ELSE GREATEST(0,$4-run_started_at) END,
      run_started_at=NULL WHERE job_id=$1 RETURNING *`,
      [id,stopping?'STOPPING':'CANCELLED',stopping?'CANCELLED':null,now])).rows[0];
    return this.expose(updated);
  }
}

/** Runs only under the foundation worker's global lease and fenced finish. */
export async function buildProfile({rawStore,researchStore,contract,signal,now=Date.now}){
  if(contract?.kind!=='PROFILE')throw fail('PROFILE_REQUEST_INVALID');
  const raw=contract.dataset,meta=raw.metadata,model=contract.profile.execution_model;
  const current=typeof now==='function'?now():now;
  // Raw end_time is the last bar's close; the derived end is only an index bound.
  if(!Number.isSafeInteger(current)||current<meta.end_time)throw fail('PROFILE_OPEN_BAR');
  let priorClose=null,atr=null,seed=D(0),count=0;
  const rows=[];
  for await(const bar of rawStore.read(raw,{signal})){
    const high=D(bar.high),low=D(bar.low),close=D(bar.close);
    const tr=priorClose===null?high.minus(low):Money.max(high.minus(low),
      high.minus(priorClose).abs(),low.minus(priorClose).abs());
    if(count<14){seed=seed.plus(tr);if(count===13)atr=seed.div(14);}
    else atr=atr.mul(13).plus(tr).div(14);
    if(count>=500)rows.push({...bar,time:bar.time+minute,atr14:amount(atr),
      price_tick:String(model.price_tick),quantity_step:String(model.quantity_step)});
    priorClose=close;count++;
  }
  if(count!==meta.total_bars||rows.length!==meta.total_bars-500)throw fail('PROFILE_CONTENT_MISMATCH');
  const derived={...meta,start_time:meta.start_time+501*minute,
    end_time:meta.end_time+minute,cutoff:meta.cutoff+minute,
    warmup_bars:meta.warmup_bars-500,total_bars:meta.total_bars-500};
  const references=await researchStore.publish(derived,rows,{model,signal});
  const evidence={source_hash:contract.profile.source_hash,
    effective_inputs_hash:contract.profile.effective_inputs_hash,
    evaluator_hash:contract.engine_hash,execution_model_hash:hash(canonical(model)),
    metadata_hash:contract.profile.metadata_hash,
    raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500};
  const binding=await verifyEnrollmentBinding({rawReference:raw,researchReference:references,
    evidence,rawStore,researchStore,signal});
  return validateProfileResult(contract,{version:'research-profile-enrollment-v1',raw,
    references,binding,data_profile_verified:true,evaluator_admission:false,
    acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']});
}

export async function quantProfileRoutes(req,res,url,actor,service,json,{enabled=false}={}){
  const prefix='/api/quant/data/profiles';
  if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
  const query=[...url.searchParams.entries()];
  if(query.length>1||query.some(([name,value])=>name!=='bot_id'||!value))
    throw fail('INVALID_FIELDS');
  const queryBotId=query[0]?.[1]??null;
  if(!enabled)throw fail('QUANT_PROFILE_DISABLED',503);
  if(url.pathname===prefix&&req.method==='POST'){
    const body=await readJson(req);
    if(queryBotId!==null&&queryBotId!==body.bot_id)throw fail('INVALID_FIELDS');
    json(res,202,await service.enqueue(actor.id,body,req.headers['idempotency-key']));
    return true;
  }
  const match=url.pathname.slice(prefix.length).match(/^\/([a-f0-9-]{36})(\/cancel)?$/);
  if(match&&((req.method==='GET'&&!match[2])||(req.method==='POST'&&match[2]))){
    if(match[2])keys(await readJson(req),[]);
    json(res,200,await service.get(actor.id,match[1],!!match[2],queryBotId));
    return true;
  }
  throw fail('NOT_FOUND',404);
}
