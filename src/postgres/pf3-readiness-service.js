import {fail,hash,canonical} from '../pine-bridge/source.js';
import {exact} from '../money.js';
import {freshSnapshot,deploymentEvidence} from './pine-bridge-readiness.js';
import {buildReadinessReport} from './pf3-readiness-report.js';

/**
 * PF-3 readiness service: reads the current Paper facts (PF-1) and the newest successful PF-2 evidence of one owner
 * and bot, then hands them to the pure report builder. Everything runs inside the caller's request transaction (or
 * its own REPEATABLE READ one) and starts with SET TRANSACTION READ ONLY, so any write or row lock would fail loudly:
 * the report saves nothing, starts nothing and calls no AI. The PF-2 reads reuse the existing owner-scoped service
 * methods; a PF-2 service that is disabled is never queried (its tables may not exist).
 */
const BROKER='binance-global',SYMBOL='BTCUSDT';
const SHA=/^[a-f0-9]{64}$/;
const SQLSTATE=/^[0-9A-Z]{5}$/;
// A fixed code of ours or of the existing services: an Error with a status and a code that is not a database or OS code.
const appError=error=>error instanceof Error&&typeof error.code==='string'&&Number.isInteger(error.status)&&!SQLSTATE.test(error.code);
// A PostgreSQL SQLSTATE or Node errno error poisons the transaction or the host: never swallow it.
const platformError=error=>error instanceof Error&&typeof error.code==='string'&&SQLSTATE.test(error.code);
const code=error=>appError(error)?error.code.slice(0,64):'READ_FAILED';
const attempt=(operation,fallback=null)=>{try{return operation();}catch{return fallback;}};

export class ReadinessService{
  constructor({store,defaultRisk,preflightService=null,preflightEnabled=false,pineBridgeEnabled=false,clock=Date.now}={}){
    if(!store||!store.db||typeof store.risk!=='function'||!defaultRisk||typeof defaultRisk!=='object'||typeof clock!=='function'||
       (preflightEnabled&&(!preflightService||typeof preflightService.list!=='function'||typeof preflightService.get!=='function')))
      throw fail('PF3_CONFIGURATION_INVALID',500);
    this.store=store;this.defaultRisk=defaultRisk;this.preflight=preflightService;
    this.preflightEnabled=preflightEnabled===true;this.pineBridgeEnabled=pineBridgeEnabled===true;this.clock=clock;
  }

  /** The report for one of the owner's bots. Throws a fixed code; database errors pass through unchanged. */
  async report(ownerId,botId){
    const db=this.store.db;
    try{
      return await db.transaction(async()=>{
        await db.query('SET TRANSACTION READ ONLY');
        return this.collect(ownerId,botId);
      },{isolation:'REPEATABLE READ'});
    }catch(error){
      if(appError(error)||platformError(error))throw error;
      throw fail('PF3_READINESS_UNAVAILABLE',503);
    }
  }

  async collect(ownerId,botId){
    const {store}=this;
    if(typeof ownerId!=='string'||typeof botId!=='string')throw fail('INVALID_FIELDS');
    if(!await store.ownsBot(ownerId,botId))throw fail('BOT_ACCESS_DENIED',403);
    const owner=await store.userById(ownerId),bot=await store.userById(botId);
    const licensed=owner?.role==='ADMIN'||await store.hasActiveLicense(ownerId);
    const globalKill=(await store.getSetting('globalKill',false))===true;
    const session=await store.getBotSession(botId),saved=await store.risk(botId,this.defaultRisk);
    // Same effective policy as freshSnapshot and the Bridge: the locked session policy when one exists.
    let effective=saved,error=null;
    if(session.locked_policy){
      try{effective=JSON.parse(session.locked_policy);}catch{effective=null;error='LOCKED_POLICY_UNREADABLE';}
    }
    const policy={effective,error,source:session.locked_policy?'LOCKED_SESSION':session.state==='RUNNING'?'SAVED_POLICY_FALLBACK':'SAVED_POLICY',
      hash:effective===null?null:hash(canonical(effective)),savedHash:hash(canonical(saved))};
    const account=await store.paperAccount(botId,BROKER);
    const row={id:0,user_id:botId,account_id:BROKER+':primary',execution_mode:'PAPER',symbol:SYMBOL,broker:BROKER};
    const exposure=await store.exposure(row),daily=await store.ledgerDaily(row);
    const deployment=this.pineBridgeEnabled?await this.readDeployment(ownerId,botId):null;
    const active=owner?.status==='ACTIVE'&&bot?.status==='ACTIVE';
    const historical=await this.readHistory(ownerId,botId,active);
    return buildReadinessReport({now:this.clock(),botId,bridgeEnabled:this.pineBridgeEnabled,preflightEnabled:this.preflightEnabled,
      owner:{status:owner?.status??null},bot:{status:bot?.status??null},licensed,globalKill,
      session:{state:session.state,run_id:session.run_id??null},policy,account,exposure,daily,deployment,historical});
  }

  /** Facts of the READY Bridge deployment of this bot (at most one by construction), or null. Reads only. */
  async readDeployment(ownerId,botId){
    const {store}=this,db=store.db;
    const rows=(await db.query(`SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash
      FROM pine_deployments WHERE owner_id=$1 AND bot_id=$2 AND state='READY'
      ORDER BY created_at DESC,deployment_id DESC LIMIT 2`,[ownerId,botId])).rows;
    if(rows.length===0)return null;
    const row=rows[0];
    const facts={id:row.deployment_id,state:'READY',snapshotHash:row.snapshot_hash,ambiguous:rows.length>1,snapshotIntact:true,
      staleCode:null,members:null,model:null,modelCode:null,initialCapital:null};
    if(hash(canonical(row.snapshot))!==row.snapshot_hash){facts.snapshotIntact=false;return facts;}
    const capital=Array.isArray(row.snapshot?.capital)?row.snapshot.capital.find(item=>item?.broker===BROKER):null;
    facts.initialCapital=capital?attempt(()=>({cash:exact(capital.configuredBalance),equity:exact(capital.configuredEquity)})):null;
    try{
      facts.members=(await freshSnapshot({db,store,defaultRisk:this.defaultRisk},row)).members.length;
    }catch(error){
      if(platformError(error))throw error;
      facts.staleCode=code(error);
    }
    try{
      const model=(await deploymentEvidence(db,row)).execution_model;
      facts.model={version:model.version,risk_percent:model.risk_percent};
    }catch(error){
      if(platformError(error))throw error;
      facts.modelCode=code(error);
    }
    return facts;
  }

  /**
   * The newest successful PF-2 job of this bot with its stored envelope, plan provenance and engine currency.
   * The service re-validates the envelope; this method reads the stored plan row to learn which policy and capital
   * the evidence was computed for. Every PF-2 refusal becomes a coded status, never a thrown error.
   */
  async readHistory(ownerId,botId,active){
    if(!this.preflightEnabled)return {status:'DISABLED'};
    if(!active)return {status:'SKIPPED',code:'ACCOUNT_SUSPENDED'};
    let latestJob=null;
    try{
      const list=await this.preflight.list(ownerId,botId);
      latestJob=list[0]??null;
      const job=list.find(item=>item.status==='SUCCEEDED');
      if(!job)return {status:'NO_SUCCEEDED',latestJob};
      const detail=await this.preflight.get(ownerId,job.job_id,false,botId);
      if(detail.status!=='SUCCEEDED'||detail.envelope===null||typeof detail.envelope!=='object')
        return {status:'UNAVAILABLE',code:'PREFLIGHT_ENVELOPE_INVALID',latestJob};
      const stored=(await this.store.db.query(`SELECT plan_json,plan_hash,deployment_id FROM quant_preflight_jobs
        WHERE job_id=$1 AND owner_id=$2 AND bot_id=$3`,[job.job_id,ownerId,botId])).rows[0];
      const plan=stored&&hash(stored.plan_json)===stored.plan_hash&&stored.plan_hash===detail.plan_hash&&
        stored.deployment_id===detail.deployment_id?attempt(()=>JSON.parse(stored.plan_json)):null;
      const policyHash=plan?.snapshot?.policy_hash,capitalHash=plan?.snapshot?.capital_hash;
      if(typeof policyHash!=='string'||!SHA.test(policyHash)||typeof capitalHash!=='string'||!SHA.test(capitalHash))
        return {status:'UNAVAILABLE',code:'PLAN_PROVENANCE_INVALID',latestJob};
      return {status:'EVIDENCE',latestJob,evidence:{summary:{job_id:detail.job_id,plan_hash:detail.plan_hash,
        deployment_id:detail.deployment_id,status:detail.status},envelope:detail.envelope,engineCurrent:detail.engine_current===true,
        planPolicyHash:policyHash,planCapitalHash:capitalHash}};
    }catch(error){
      if(platformError(error))throw error;
      return {status:'UNAVAILABLE',code:appError(error)?error.code.slice(0,64):'PREFLIGHT_UNAVAILABLE',latestJob};
    }
  }
}
