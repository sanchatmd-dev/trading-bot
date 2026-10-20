import {hasPermission} from '../permissions.js';
import {getQuota} from './quotas.js';
import {readQr2Account} from './qr2-reader.js';
import {writeQr2Audit} from './qr2-audit.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED} from '../portfolio/qr2-boundaries.js';
import {QR2_DAY_MS,Qr2Error} from '../portfolio/qr2-constants.js';
import {periodWindow,customWindow,allTimeWindow,utcMidnight} from '../portfolio/qr2-periods.js';
import {composePerformanceResponse,refusalAnswer} from '../portfolio/qr2-response.js';

// QR-2 S3a: GET /api/paper-performance (contract 8.1; root rulings RC-Q28 to RC-Q33, 2026-10-20).
// Phase 1 runs inside the SERIALIZABLE request transaction and only reads: session and own:read passed before this route, then the
// parameters, the Bot scope, the bounds, the admin step-up and the admin audit row. Phase 2 runs after COMMIT through res.phase2Deferred:
// the standalone reader opens its own REPEATABLE READ, READ ONLY transaction, the computation runs outside any transaction, and one
// function res.phase2AfterCommit (the audit writer) is registered for the dispatcher to run after the answer is sent. This module
// imports no quant-research code and never calls legacyQuantDenied (O8: the legacy Quant gate is not applied to QR-2). It writes
// no Paper row, no fence row and no exposure event; its only write is the admin audit row.

export const QR2_PERFORMANCE_PATH='/api/paper-performance';
export const QR2_MAX_CUSTOM_DAYS=3660;
export const QR2_ADMIN_READ_EVENT='qr2.admin_read';
const PARAMETERS=new Set(['bot_id','broker','period','from','to']);
const BROKERS=['binance-global','binance-th','innovestx','settrade'];
const PERIODS=['DAY','WEEK','MONTH','YEAR','ALL_TIME','CUSTOM'];
const BOT_ID=/^[A-Za-z0-9._-]{1,128}$/;
const DAY=/^(\d{4})-(\d{2})-(\d{2})$/;

/** One computation slot per process (RC-Q30). A holder takes it for the whole read and compute; a second caller is refused, never queued. */
export function createQr2Slot(max=1){
  let held=0;
  return {
    tryAcquire(){
      if(held>=max)return null;
      held++;
      let released=false;
      return ()=>{if(!released){released=true;held--;}};
    },
    get busy(){return held;}
  };
}

class Refusal extends Error{
  constructor(code,detail){super(code);this.code=code;this.detail=detail;}
}
const refuse=(code,detail)=>{throw new Refusal(code,detail);};

// A calendar day YYYY-MM-DD as the UTC midnight epoch ms; anything else (month 13, day 31 of April, a time part) is invalid.
function dayStart(text){
  const m=DAY.exec(text);
  if(!m)return null;
  const [year,month,day]=[Number(m[1]),Number(m[2]),Number(m[3])];
  const at=Date.UTC(year,month-1,day);
  const back=new Date(at);
  return back.getUTCFullYear()===year&&back.getUTCMonth()===month-1&&back.getUTCDate()===day?at:null;
}

// All parameter rules that need no database. Returns {botId,broker,period,from,to} or throws a Refusal.
export function parseParameters(url,requestTime){
  const keys=[...url.searchParams.keys()];
  // 8.1: user_id is never a selector. It is refused before any lookup, with the same answer as an absent or foreign Bot.
  if(keys.some(key=>['user_id','userid'].includes(key.toLowerCase())))refuse('QR2_NOT_OWNER');
  if(keys.some(key=>['fee_bps','feebps'].includes(key.toLowerCase())))refuse('QR2_FEE_OVERLAY_REFUSED');
  for(const key of keys){
    if(!PARAMETERS.has(key))refuse('QR2_INPUT_INVALID');
    if(url.searchParams.getAll(key).length>1)refuse('QR2_INPUT_INVALID');
  }
  const botId=url.searchParams.get('bot_id');
  if(botId===null||botId===''||botId==='all')refuse('QR2_INPUT_INVALID');
  const broker=url.searchParams.has('broker')?url.searchParams.get('broker'):'binance-global';
  if(!BROKERS.includes(broker))refuse('QR2_INPUT_INVALID');
  const period=url.searchParams.has('period')?url.searchParams.get('period'):'MONTH';
  if(!PERIODS.includes(period))refuse('QR2_INPUT_INVALID');
  const hasFrom=url.searchParams.has('from'),hasTo=url.searchParams.has('to');
  if(period!=='CUSTOM'){
    if(hasFrom||hasTo)refuse('QR2_INPUT_INVALID');
    return {botId,broker,period,from:null,to:null};
  }
  if(!hasFrom||!hasTo)refuse('QR2_INPUT_INVALID');
  const fromDay=dayStart(url.searchParams.get('from')),toDay=dayStart(url.searchParams.get('to'));
  if(fromDay===null||toDay===null)refuse('QR2_INPUT_INVALID');
  if(toDay<fromDay)refuse('QR2_RANGE_INVALID');
  if((toDay-fromDay)/QR2_DAY_MS+1>QR2_MAX_CUSTOM_DAYS)refuse('QR2_RANGE_INVALID');
  const window=customWindow(fromDay,toDay);
  if(window.from>requestTime)refuse('QR2_RANGE_INVALID');
  return {botId,broker,period,from:window.from,to:window.to};
}

// The reader's refusals become request answers; anything else is a fixed 503 with no internal text. In phase 2 the parameters were already
// checked, so a reader QR2_INPUT_INVALID is a caller bug or a data case, not client input: it answers 503 QR2_REPORT_FAILED (phase 1 keeps 400).
function answerOfError(error,phase=1){
  if(error instanceof Qr2Error){
    if(phase===2&&error.code==='QR2_INPUT_INVALID')return refusalAnswer('QR2_REPORT_FAILED');
    if(['QR2_NOT_OWNER','QR2_RANGE_INVALID','QR2_INPUT_INVALID','QR2_FEE_OVERLAY_REFUSED','QR2_CURRENCY_MIX'].includes(error.code))return refusalAnswer(error.code);
    if(error.code==='QR2_RANGE_ADMISSION_REFUSED')return refusalAnswer(error.code,error.detail);
  }
  return refusalAnswer('QR2_REPORT_FAILED');
}

/**
 * deps: {store, auth, json, enabled, slot, boundaries?, limits?, clock?, readAccount?, writeAudit?}. readAccount and writeAudit exist for
 * tests; the product uses the defaults. Returns false when the route is off or the path is not this one (the router then answers 404).
 */
export async function qr2PerformanceRoute(req,res,url,actor,deps){
  const {store,auth,json,enabled,slot,boundaries=QR2_BOUNDARY_RECORD_UNRECORDED,limits,clock=Date.now,
    readAccount=readQr2Account,writeAudit=writeQr2Audit}=deps;
  if(url.pathname!==QR2_PERFORMANCE_PATH||enabled!==true)return false;
  if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return true;}
  const answer=({status,body})=>{json(res,status,body);return true;};
  const requestTime=clock();
  let plan;
  try{
    const parsed=parseParameters(url,requestTime);
    const {botId,broker,period}=parsed;
    if(!BOT_ID.test(botId))refuse('QR2_NOT_OWNER');
    // Scope. An owner reads own Bots. Anyone else needs analytics:any, a recent step-up and an audit row; a Bot that is absent, foreign or
    // unreachable returns one and the same 404 (no existence oracle).
    let ownerId=actor.id,adminRead=false;
    if(!await store.ownsBot(actor.id,botId)){
      if(!hasPermission(actor,'analytics:any'))refuse('QR2_NOT_OWNER');
      await auth.sensitive(req);
      adminRead=true;
    }
    const bot=await store.userById(botId);
    if(!bot)refuse('QR2_NOT_OWNER');
    if(adminRead)ownerId=bot.parent_user_id||bot.id;
    const coverageStart=Number(bot.created_at);
    let {from,to}=parsed;
    if(period==='ALL_TIME'){({from,to}=allTimeWindow({coverageStart,requestTime}));}
    else if(period!=='CUSTOM'){({from,to}=periodWindow(period,requestTime));}
    // Interim O-1: the plan history limit applies to the start of every period, counted from UTC midnight of the request day, so a
    // 30-day plan still reads the current month on the 31st.
    const quota=getQuota(await store.activePlan(actor.id));
    if(quota.historyDays>0&&from<utcMidnight(requestTime)-quota.historyDays*QR2_DAY_MS)refuse('QR2_RANGE_ADMISSION_REFUSED',{limit:'history_days',max:quota.historyDays});
    // The admin audit row is written in the request transaction, so it is committed before phase 2 reads any ledger data.
    if(adminRead)await store.audit(actor.id,QR2_ADMIN_READ_EVENT,null,{botId,ownerId,broker,period,from,to});
    plan={botId,broker,ownerId,from,to};
  }catch(error){
    if(error instanceof Refusal){const {status,body}=refusalAnswer(error.code,error.detail);json(res,status,body);return true;}
    if(error instanceof Qr2Error)return answer(answerOfError(error));
    throw error;
  }
  const {botId,broker,ownerId,from,to}=plan;
  res.phase2Deferred=async()=>{
    // Phase 2: after COMMIT, outside any transaction context. It never throws; every failure is a fixed answer.
    let release=null;
    try{
      release=slot.tryAcquire();
      if(!release){
        if(typeof res.setHeader==='function')res.setHeader('Retry-After','2');
        return refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'concurrency',max:1});
      }
      let view;
      try{view=await readAccount(store,{ownerId,botId,broker,from,to,requestTime,boundaries,limits});}
      catch(error){return answerOfError(error,2);}
      let body;
      try{body=composePerformanceResponse(view,{requestTime});}
      catch{return refusalAnswer('QR2_RESPONSE_INVALID');}
      // Registered only now: the reader transaction has committed and the answer is built. The dispatcher runs it after the answer is sent.
      if(Array.isArray(view.audit_findings)&&view.audit_findings.length)res.phase2AfterCommit=()=>writeAudit(store,{findings:view.audit_findings,botId,broker});
      return {status:200,body};
    }catch{return refusalAnswer('QR2_REPORT_FAILED');}
    finally{if(release)release();}
  };
  return true;
}
