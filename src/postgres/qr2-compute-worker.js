import {projectPublicCoverageOutcome} from '../portfolio/qr2-coverage-public.js';
import {coverageReadBudgets,QR2_COVERAGE_LIMITS} from '../portfolio/qr2-coverage-limits.js';
import {resolveRange} from '../portfolio/qr2-periods.js';
import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import {computeQr2View} from './qr2-reader.js';
import {composeOwnerResponse} from '../portfolio/qr2-owner-response.js';
import {composePerformanceResponse} from '../portfolio/qr2-response.js';

// QR-2 S3b compute worker (RC-Q35, design option A). It computes one reader view from a plain snapshot and builds the response body, off
// the main thread's event loop. This module imports only node:worker_threads, the pure compute half of qr2-reader.js, the pure response
// composers, the pure range resolver (qr2-periods.js) and the pure coverage modules (the public coverage projection and the coverage
// limits): it imports no pg, no db.js, no store and no server module (a test walks the import graph), so a worker has no database
// handle and a message cannot carry one. Nothing is kept between jobs. Every result is JSON-safe plain data; no message text, stack or ledger row
// crosses back (the composer already drops view.rows).

export const QR2_WORKER_ROLE='qr2-compute';

const jsonSafe=value=>{try{JSON.stringify(value);return true;}catch{return false;}};

const requireFact=value=>{if(!value)throw new Error('invalid coverage association');};
const text=value=>typeof value==='string'&&value.length>0;
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const sameRange=(a,b)=>a===null?b===null:b!==null&&typeof b==='object'&&a.from===b.from&&a.to===b.to;
const brokers={USDT:['binance-global'],THB:['binance-th','innovestx','settrade']};
function createdAt(value){
  if(typeof value==='string'){requireFact(value.length<=16&&/^(0|[1-9][0-9]*)$/.test(value));value=Number(value);}
  requireFact(safe(value));return value;
}
function accountAssociation(snapshot,input,idLimit){
  requireFact(text(input?.ownerId)&&input.ownerId.length<=idLimit&&text(input?.botId)&&input.botId.length<=idLimit);
  requireFact(input?.kind===undefined||input.kind==='account');
  requireFact(snapshot?.kind!== 'owner'&&text(input.ownerId)&&text(input.botId)&&[...brokers.USDT,...brokers.THB].includes(input.broker));
  requireFact(snapshot.owner?.id===input.botId&&(snapshot.owner.id===input.ownerId||snapshot.owner.parent_user_id===input.ownerId));
  requireFact(safe(snapshot.coverageStart)&&snapshot.coverageStart===createdAt(snapshot.owner.created_at));
  const range=resolveRange({from:input.from,to:input.to,requestTime:input.requestTime,coverageStart:snapshot.coverageStart});
  requireFact(sameRange(range.resolved,snapshot.range?.resolved));
  return {bot_id:input.botId,broker:input.broker,market:input.broker==='binance-global'?{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'}:null,resolved_range:range.resolved};
}
function qualifyCoverage(snapshot,input,coverageOutputLimit){
  const context=input?.coverage_context;
  requireFact(context&&Reflect.ownKeys(context).length===2&&Object.hasOwn(context,'accounts')&&Object.hasOwn(context,'budgets'));
  requireFact(context.budgets&&Reflect.ownKeys(context.budgets).length===Object.keys(QR2_COVERAGE_LIMITS).length&&Object.keys(QR2_COVERAGE_LIMITS).every(k=>Object.hasOwn(context.budgets,k)));
  const budgets=coverageReadBudgets(context.budgets);
  const idLimit=Math.floor(Math.min(budgets.coverage_input_bytes,budgets.coverage_output_bytes)/6);
  const identifier=value=>text(value)&&value.length<=idLimit;
  requireFact(identifier(input.ownerId));
  requireFact(Array.isArray(context.accounts)&&context.accounts.length<=20);
  for(const account of context.accounts)requireFact(identifier(account?.bot_id)&&identifier(account?.broker));
  let expected,refs;
  if(input.kind==='owner'){
    requireFact(snapshot?.kind==='owner'&&text(input.ownerId)&&Object.hasOwn(brokers,input.currency)&&snapshot.currency===input.currency);
    requireFact(Array.isArray(snapshot.ownerBots)&&snapshot.ownerBots.length<=5&&Array.isArray(snapshot.accounts)&&snapshot.accounts.length<=20);
    const bots=new Map();
    for(const bot of snapshot.ownerBots){requireFact(identifier(bot.bot_id)&&!bots.has(bot.bot_id)&&safe(bot.created_at));bots.set(bot.bot_id,bot.created_at);}
    requireFact(bots.has(input.ownerId));
    requireFact(sameRange(resolveRange({from:input.from,to:input.to,requestTime:input.requestTime,coverageStart:bots.get(input.ownerId)}).resolved,snapshot.range?.resolved));
    expected=[];refs=[];
    for(const member of snapshot.accounts){
      const m=member.input;
      requireFact(m&&identifier(m.ownerId)&&identifier(m.botId)&&identifier(m.broker)&&m.ownerId===input.ownerId&&m.from===input.from&&m.to===input.to&&m.requestTime===input.requestTime&&brokers[input.currency].includes(m.broker)&&bots.has(m.botId));
      requireFact(!Object.hasOwn(member.snapshot,'coverage')&&!Object.hasOwn(m,'coverage_context')&&member.snapshot.coverageStart===bots.get(m.botId));
      expected.push(accountAssociation(member.snapshot,m,idLimit));refs.push(member.snapshot.coverage_window_id);
    }
  }else{expected=[accountAssociation(snapshot,input,idLimit)];refs=[snapshot.coverage_window_id];}
  requireFact(context.accounts.length===expected.length);
  const identities=new Set();
  for(const account of expected){
    const key=JSON.stringify([account.bot_id,account.broker]);requireFact(!identities.has(key));identities.add(key);
    const matches=context.accounts.filter(a=>a?.bot_id===account.bot_id&&a?.broker===account.broker);
    requireFact(matches.length===1&&sameRange(account.resolved_range,matches[0].resolved_range));
    const market=matches[0].market;
    requireFact(account.market===null?market===null:market?.broker==='binance-global'&&market.symbol==='BTCUSDT'&&market.timeframe==='1');
  }
  // Exactly one full registry validation (inside the projection) and one build of each coverage entry, before either financial compute branch.
  const outcome=projectPublicCoverageOutcome(snapshot.coverage,context,coverageOutputLimit);
  for(let i=0;i<expected.length;i++){
    const account=expected[i],binding=snapshot.coverage.bindings.find(b=>b.bot_id===account.bot_id&&b.broker===account.broker);
    requireFact(safe(refs[i])&&binding&&refs[i]===binding.window_id);
  }
  return outcome;
}

/**
 * One job: {snapshot,input} to a result. Exported for the in-thread tests and for the worker listener below; seams are for tests only.
 * ok:true  {id?,ok,body,auditFindings,compute_ms}
 * ok:false {kind:'qr2',code,detail?} a Qr2Error of the compute; {kind:'response'} a composer failure; {kind:'other'} anything else.
 * kind:'qr2' also carries the post-build coverage refusal QR2_RANGE_ADMISSION_REFUSED, with code only and no detail.
 */
export function executeQr2Job({snapshot,input},{compute=computeQr2View,compose=composePerformanceResponse,coverageOutputLimit}={}){
  if(input?.kind!==undefined&&input.kind!=='account'&&input.kind!=='owner')return {ok:false,kind:'other'};
  let projection;
  try{
    const outcome=qualifyCoverage(snapshot,input,coverageOutputLimit);
    // Only the post-build byte admission refusal is a request-level refusal: code only, no detail.
    if(outcome.refused)return {ok:false,kind:'qr2',code:'QR2_RANGE_ADMISSION_REFUSED'};
    projection=outcome.projection;
  }catch{return {ok:false,kind:'other'};}
  if(input?.kind==='owner'){
    if(snapshot?.kind!=='owner')return {ok:false,kind:'other'};
    const coverage=projection.owner.market_coverage;
    let result;
    try{result=composeOwnerResponse(snapshot,input,{coverage});}
    catch(error){return {ok:false,kind:error?.code==='QR2_RESPONSE_INVALID'?'response':'other'};}
    // The envelope is the same object as the option in a non-REFUSED body with a resolved range, and absent from every other body.
    try{
      const body=result.body,carries=body.status.status!=='REFUSED'&&body.resolved_range!==null;
      if(carries?body.market_coverage!==coverage:Object.hasOwn(body,'market_coverage'))return {ok:false,kind:'response'};
    }catch{return {ok:false,kind:'response'};}
    return {ok:true,...result};
  }
  if(snapshot?.kind==='owner')return {ok:false,kind:'other'};
  const accounts=projection.accounts.filter(a=>a.bot_id===input.botId&&a.broker===input.broker);
  if(accounts.length!==1||projection.accounts.length!==1)return {ok:false,kind:'other'};
  const coverage=accounts[0].market_data.coverage;
  let view;
  try{view=compute(snapshot,input);}
  catch(error){
    if(error&&error.name==='Qr2Error'&&typeof error.code==='string'){
      const answer={ok:false,kind:'qr2',code:error.code};
      if(error.detail!==undefined&&jsonSafe(error.detail))answer.detail=error.detail;
      return answer;
    }
    return {ok:false,kind:'other'};
  }
  let body;
  try{body=compose(view,{requestTime:input.requestTime,coverage});}
  catch{return {ok:false,kind:'response'};}
  // A non-REFUSED body carries the projected coverage object itself; a REFUSED body carries no market_data. The compose seam is checked too.
  try{
    if(body.status.status!=='REFUSED'?(typeof coverage!=='object'||coverage===null||body.market_data.coverage!==coverage):Object.hasOwn(body,'market_data'))return {ok:false,kind:'response'};
  }catch{return {ok:false,kind:'response'};}
  const auditFindings=view&&Array.isArray(view.audit_findings)?view.audit_findings:[];
  return {ok:true,body,auditFindings,compute_ms:view&&view.reader?view.reader.compute_ms:null};
}

// The listener exists only inside a worker started by the pool (workerData.role), never when this module is imported in the main thread.
if(!isMainThread&&parentPort&&workerData&&workerData.role===QR2_WORKER_ROLE){
  parentPort.on('message',message=>{
    const id=message&&message.id;
    let answer;
    try{answer=executeQr2Job(message);}catch{answer={ok:false,kind:'other'};}
    try{parentPort.postMessage({id,...answer});}
    catch{parentPort.postMessage({id,ok:false,kind:'other'});}
  });
  parentPort.postMessage({type:'ready'});
}
