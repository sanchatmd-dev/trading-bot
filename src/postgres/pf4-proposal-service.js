import {fail,keys} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {buildRiskReadiness} from './risk-readiness.js';
import {readinessCapacity,reviewRiskPolicy} from './risk-policy-review.js';
import {validateRisk} from './risk-policy-validation.js';
import {classifyReason} from './pf3-rejection-classes.js';
import {PF4_CONFIRM,assertMonotoneSafe,buildProposal,changedFields,normalizeDeclared,policyHash} from './pf4-risk-proposals.js';

/**
 * PF-4 service: reads the facts of one owner and bot inside the request transaction, builds a proposal with the pure
 * rules and either shows it (preview: read only, SET TRANSACTION READ ONLY first) or saves it (apply: the one write is
 * store.setRisk, the same call PUT /api/risk makes). The PF-3 readiness report is reused for the PF-2 evidence summary,
 * the READY deployment and the advisories; nothing here calls an AI or starts a job.
 */
const BROKER='binance-global',SYMBOL='BTCUSDT';
const SHA=/^[a-f0-9]{64}$/;
const SQLSTATE=/^[0-9A-Z]{5}$/;
// A fixed code of ours or of the existing services (an Error with a status and a code that is not a database or OS code).
const appError=error=>error instanceof Error&&typeof error.code==='string'&&Number.isInteger(error.status)&&!SQLSTATE.test(error.code);
// A PostgreSQL SQLSTATE or Node errno error poisons the transaction or the host: never swallow it.
const platformError=error=>error instanceof Error&&typeof error.code==='string'&&SQLSTATE.test(error.code);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const conflict=code=>fail(code,409);

export class ProposalService{
  constructor({store,defaultRisk,readinessService,pineBridgeEnabled=false}={}){
    if(!store||!store.db||typeof store.risk!=='function'||!defaultRisk||typeof defaultRisk!=='object'||
       !readinessService||typeof readinessService.collect!=='function')throw fail('PF4_CONFIGURATION_INVALID',500);
    this.store=store;this.defaultRisk=defaultRisk;this.readiness=readinessService;this.pineBridgeEnabled=pineBridgeEnabled===true;
  }

  /** Read-only preview: proposal, static before/after, optional sizing before/after and what a save would do. Saves nothing. */
  async preview(ownerId,botId,body){
    const db=this.store.db;
    try{
      return await db.transaction(async()=>{
        await db.query('SET TRANSACTION READ ONLY');
        return this.previewInside(ownerId,botId,body);
      },{isolation:'REPEATABLE READ'});
    }catch(error){
      if(appError(error)||platformError(error))throw error;
      throw fail('PF4_PREVIEW_UNAVAILABLE',503);
    }
  }

  /**
   * Confirmed save. One SERIALIZABLE transaction; any refusal or invariant failure rolls everything back. Errors are mapped like
   * the preview: a fixed code of ours and a database error pass through (the server turns 40001 into a 409), and nothing else
   * leaks its message. A plain validator error (a saved value that is not a readable decimal) is PF4_SAVED_POLICY_INVALID; any
   * other unexpected failure is PF4_APPLY_UNAVAILABLE.
   */
  async apply(ownerId,botId,body){
    try{
      return await this.store.db.transaction(()=>this.applyInside(ownerId,botId,body),{isolation:'SERIALIZABLE'});
    }catch(error){
      if(appError(error)||platformError(error))throw error;
      const plain=error instanceof Error&&error.constructor===Error&&typeof error.code!=='string'&&!Number.isInteger(error.status);
      throw plain?fail('PF4_SAVED_POLICY_INVALID',400):fail('PF4_APPLY_UNAVAILABLE',503);
    }
  }

  /** Everything both operations need, read from one transaction. The proposal is built here, never trusted from a client. */
  async facts(ownerId,botId,declared){
    const {store}=this;
    if(typeof ownerId!=='string'||typeof botId!=='string')throw fail('INVALID_FIELDS');
    if(!await store.ownsBot(ownerId,botId))throw fail('BOT_ACCESS_DENIED',403);
    const session=await store.getBotSession(botId),base=await store.risk(botId,this.defaultRisk);
    const report=await this.readiness.collect(ownerId,botId);
    const history=report.historical,rejections=history?.rejections;
    const evidence=history?.status==='AVAILABLE'&&history.evidence&&rejections?{job_id:history.evidence.job_id,plan_hash:history.evidence.plan_hash,
      policy_current:history.evidence.policy_current===true,capital_current:history.evidence.capital_current===true,
      cappable_buy_rejections:rejections.cappable_buy_rejections,
      reasons:rejections.items.filter(item=>classifyReason(item.reason)?.cappable===true).map(item=>({code:item.code,count:item.count}))}:null;
    const deployment=report.current?.deployment??null;
    let bridgeRisk=null;
    if(deployment&&typeof deployment.bridge_risk_percent==='number'){
      const stored=(await store.db.query('SELECT evidence_hash FROM pine_bridge_evidence WHERE deployment_id=$1 AND snapshot_hash=$2',
        [deployment.deployment_id,deployment.snapshot_hash])).rows[0];
      if(stored)bridgeRisk={deployment_id:deployment.deployment_id,evidence_hash:stored.evidence_hash,risk_percent:deployment.bridge_risk_percent};
    }
    const has=code=>report.blockers.some(item=>item.code===code);
    const context={readyDeploymentId:deployment?.deployment_id??null,currentLossStreakPause:has('CURRENT_LOSS_STREAK_PAUSE')};
    const built=buildProposal({botId,base,defaultRisk:this.defaultRisk,declared,evidence:evidence,bridgeRisk,context});
    return {session,base,report,evidence,deployment,built,drift:await this.capitalDrift(botId,base)};
  }

  /** True when the saved equities or balances differ from the funding ledger: a save would then add funding rows. */
  async capitalDrift(botId,base){
    for(const account of await this.store.paperAccounts(botId)){
      const equity=D(base.equities?.[account.broker]??0),balance=D(base.balances?.[account.broker]??equity);
      if(!equity.eq(account.configuredEquity)||!balance.eq(account.configuredBalance))return true;
    }
    return false;
  }

  /** Why a save would be refused right now, in the order the apply checks run; null when it is allowed. */
  refusal(facts){
    if(facts.session.state==='RUNNING'||facts.session.state==='PAUSED')return 'RISK_POLICY_FROZEN';
    if(facts.built.proposal.refusal)return facts.built.proposal.refusal.code;
    if(facts.built.proposal.changes.length===0)return 'PROPOSAL_EMPTY';
    if(facts.drift)return 'CAPITAL_DRIFT';
    return null;
  }

  /** What a save changes beyond the policy itself: the READY deployment and the PF-2 evidence both bind the old hash. */
  consequences(facts){
    if(facts.built.proposal.changes.length===0)return [];
    return [...(facts.deployment?[{code:'DEPLOYMENT_SNAPSHOT_STALE',deployment_id:facts.deployment.deployment_id}]:[]),
      ...(facts.evidence?[{code:'PF2_EVIDENCE_STALE',job_id:facts.evidence.job_id}]:[])];
  }

  /** The intent of a sizing preview: exactly a {signal} or a {bridge} request, as for POST /api/risk/readiness. */
  intentOf(value){
    if(!isObject(value)||Object.keys(value).length!==1||!(Object.hasOwn(value,'signal')||Object.hasOwn(value,'bridge')))throw fail('INVALID_FIELDS');
    if(Object.hasOwn(value,'bridge')&&!this.pineBridgeEnabled)throw fail('PF4_INTENT_UNSUPPORTED');
    const broker=value.signal?.broker;
    if(typeof broker==='string'&&!/^binance[-_ ]?global$/i.test(broker.trim()))throw fail('PF4_INTENT_UNSUPPORTED');
    return value;
  }

  async previewInside(ownerId,botId,body){
    keys(body,['declared','intent'],[]);
    const declared=normalizeDeclared(body.declared);
    const intent=Object.hasOwn(body,'intent')?this.intentOf(body.intent):null;
    const facts=await this.facts(ownerId,botId,declared);
    const {base,built,report}=facts,{proposal,after}=built;
    const row={id:0,user_id:botId,account_id:BROKER+':primary',execution_mode:'PAPER',symbol:SYMBOL,broker:BROKER};
    const exposure=await this.store.exposure(row),daily=await this.store.ledgerDaily(row);
    const consistency={before:reviewRiskPolicy(base),after:after===null?null:reviewRiskPolicy(after)};
    const capacity=(policy,review)=>policy!==null&&review?.status==='CONSISTENT'?readinessCapacity(policy,daily,exposure):null;
    const refusalCode=this.refusal(facts);
    return {version:'pf4-preview-v1',report_verdict:report.verdict,proposal,
      static:{consistency,capacity:{before:capacity(base,consistency.before),after:capacity(after,consistency.after)}},
      sizing:await this.sizing(ownerId,botId,intent,proposal),
      save:{allowed:refusalCode===null,refusal_code:refusalCode,confirm:PF4_CONFIRM,consequences:this.consequences(facts)},
      flags:{saves_nothing:true,deterministic:true,ai_used:false}};
  }

  /**
   * Sizing before and after: the existing Risk readiness calculation for the same intent, with the actual capital, once on
   * the effective policy and once on the proposed one. A refusal of the existing builder (a status error) is reported as
   * REFUSED with its code; anything else is a real failure and propagates.
   */
  async sizing(ownerId,botId,intent,proposal){
    if(intent===null)return {status:'NOT_REQUESTED',code:null,detail:null,before:null,after:null,capital:null};
    const account=await this.store.paperAccount(botId,BROKER);
    const capital={source:'ACTUAL_UNCHANGED',cash:account.cash,book_equity:account.bookEquity};
    const refused=(code,detail=null)=>({status:'REFUSED',code,detail,before:null,after:null,capital});
    let result;
    try{
      result=await buildRiskReadiness({store:this.store,botId,ownerId,defaultRisk:this.defaultRisk,
        body:{...intent,scenario:{policy:proposal.policy_input,capital:{cash:account.cash,bookEquity:account.bookEquity}}}});
    }catch(error){
      if(platformError(error)||!Number.isInteger(error?.status))throw error;
      return refused(typeof error.code==='string'?error.code.slice(0,64):'SIZING_PREVIEW_REFUSED',String(error.message).slice(0,200));
    }
    if(result.account?.broker!==BROKER||(result.deployment&&result.deployment.state!=='READY'))throw fail('PF4_INTENT_UNSUPPORTED');
    // The proposed policy must be the saved one plus the changes. A locked session policy (or any other source) would make
    // the two sizes describe a policy nobody saves, so that case is refused rather than shown.
    const proposed=proposal.after_policy_hash!==null;
    if((proposed?result.policy.hash:result.actual.policyHash)!==(proposed?proposal.after_policy_hash:proposal.base_policy_hash))
      return refused('PF4_SIZING_POLICY_SOURCE','The effective policy is not the saved policy');
    const side=(readiness,calculation,hashValue,source)=>({readiness,calculation,policy_hash:hashValue,policy_source:source});
    return {status:'COMPUTED',code:null,detail:null,capital,limitations:result.limitations,
      before:side(result.actual.readiness,result.actual.calculation,result.actual.policyHash,result.actual.policySource),
      after:{...side(result.readiness,result.calculation,result.policy.hash,result.policy.source),costs:result.costs??null}};
  }

  /** Counts of the funding records and the stored Paper accounts of the bot: a save must leave both exactly as they were. */
  async fundingState(botId){
    const row=(await this.store.db.query(`SELECT (SELECT count(*) FROM paper_funding WHERE user_id=$1)::int AS funding,
      (SELECT count(*) FROM paper_snapshots WHERE user_id=$1)::int AS snapshots`,[botId])).rows[0];
    return JSON.stringify([row.funding,row.snapshots,await this.store.paperAccounts(botId)]);
  }

  /**
   * The save, in this order: exact body and confirmation (400); frozen session, stale policy, stale proposal, empty or
   * conflicting proposal and capital drift (409); then one setRisk, the same call as PUT /api/risk, with proof that no
   * funding record or Paper account moved, and two audit rows. Nothing is retried; a concurrent change is a 409.
   */
  async applyInside(ownerId,botId,body){
    const {store}=this;
    keys(body,['base_policy_hash','proposal_hash','declared','confirm'],['base_policy_hash','proposal_hash','declared']);
    // Strings only: an array that stringifies to a hash must not pass.
    if(typeof body.base_policy_hash!=='string'||typeof body.proposal_hash!=='string'||!SHA.test(body.base_policy_hash)||!SHA.test(body.proposal_hash)||!isObject(body.declared))
      throw fail('INVALID_FIELDS');
    if(body.confirm!==PF4_CONFIRM)throw fail('CONFIRMATION_REQUIRED');
    const declared=normalizeDeclared(body.declared);
    if(typeof ownerId!=='string'||typeof botId!=='string')throw fail('INVALID_FIELDS');
    if(!await store.ownsBot(ownerId,botId))throw fail('BOT_ACCESS_DENIED',403);
    const session=await store.getBotSession(botId);
    if(session.state==='RUNNING'||session.state==='PAUSED')throw conflict('RISK_POLICY_FROZEN');
    const facts=await this.facts(ownerId,botId,declared),{base,built}=facts,{proposal}=built;
    if(policyHash(base)!==body.base_policy_hash)throw conflict('STALE_POLICY_STATE');
    if(proposal.proposal_hash!==body.proposal_hash)throw conflict('PROPOSAL_STALE');
    if(proposal.refusal)throw conflict(proposal.refusal.code);
    if(proposal.changes.length===0||built.after===null)throw conflict('PROPOSAL_EMPTY');
    if(facts.drift)throw conflict('CAPITAL_DRIFT');
    const next=validateRisk(proposal.policy_input,base,this.defaultRisk);
    assertMonotoneSafe(base,next,declared,this.defaultRisk);
    if(reviewRiskPolicy(next).status!=='CONSISTENT'||policyHash(next)!==proposal.after_policy_hash)throw conflict('BASE_POLICY_CONFLICT');
    const before=await this.fundingState(botId);
    await store.setRisk(botId,next);
    if(await this.fundingState(botId)!==before)throw fail('PF4_FUNDING_INVARIANT',500);
    const saved=await store.risk(botId,this.defaultRisk),after=policyHash(saved);
    if(after!==proposal.after_policy_hash)throw fail('PF4_SAVE_MISMATCH',500);
    const changed=changedFields(proposal);
    await store.audit(botId,'risk.updated',null,{policy:next});
    await store.audit(botId,'risk.proposal.applied',null,{owner_id:ownerId,base_policy_hash:proposal.base_policy_hash,policy_hash:after,
      proposal_hash:proposal.proposal_hash,changed_fields:changed,evidence_job_id:facts.evidence?.job_id??null,declared});
    return {version:'pf4-apply-v1',saved:true,policy_hash_before:proposal.base_policy_hash,policy_hash_after:after,changed_fields:changed,
      consequences:this.consequences(facts),policy:next};
  }
}
