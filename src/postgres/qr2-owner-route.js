import {getQuota} from './quotas.js';
import {readQr2OwnerSnapshot} from './qr2-owner-reader.js';
import {writeQr2Audit} from './qr2-audit.js';
import {parseQr2OwnerParameters,assertQr2History,answerOfError} from './qr2-routes.js';
import {periodWindow,allTimeWindow} from '../portfolio/qr2-periods.js';
import {Qr2Error} from '../portfolio/qr2-constants.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED} from '../portfolio/qr2-boundaries.js';
import {refusalAnswer} from '../portfolio/qr2-response.js';
import {validateOwnerResponse} from '../portfolio/qr2-owner-response.js';

export const QR2_OWNER_PERFORMANCE_PATH='/api/paper-performance/owner';
// Caller performs session and own:read checks. Same disabled-by-default flag, process slot and compute pool as account GET.
export async function qr2OwnerPerformanceRoute(req,res,url,actor,deps){
  if(url.pathname!==QR2_OWNER_PERFORMANCE_PATH||deps.enabled!==true)return false;
  const {store,json,slot,compute,clock=Date.now,boundaries=QR2_BOUNDARY_RECORD_UNRECORDED,limits,readSnapshot=readQr2OwnerSnapshot,writeAudit=writeQr2Audit}=deps;
  if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return true;}
  const requestTime=clock();let plan;
  try{
    const parsed=parseQr2OwnerParameters(url,requestTime);
    const owner=actor&&await store.userById(actor.id);
    if(!owner||owner.parent_user_id)throw new Qr2Error('QR2_NOT_OWNER');
    let {from,to}=parsed;
    if(parsed.period==='ALL_TIME')({from,to}=allTimeWindow({coverageStart:Number(owner.created_at),requestTime}));
    else if(parsed.period!=='CUSTOM')({from,to}=periodWindow(parsed.period,requestTime));
    const quota=getQuota(await store.activePlan(actor.id));
    assertQr2History(from,requestTime,quota.historyDays);
    plan={ownerId:actor.id,currency:parsed.currency,from,to,requestTime,boundaries,limits};
  }catch(error){if(!(error instanceof Qr2Error))throw error;const answer=answerOfError(error);json(res,answer.status,answer.body);return true;}
  res.phase2Deferred=async()=>{
    let release;
    try{
      release=slot.tryAcquire();
      if(!release){res.setHeader?.('Retry-After','2');return refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'concurrency',max:1});}
      let read;
      try{read=await readSnapshot(store,plan);}catch(error){return answerOfError(error,2);}
      let result;
      try{result=await compute.run(read.snapshot,read.input);}
      catch(error){if(['timeout','crash','heap','spawn'].includes(error?.kind))res.setHeader?.('Retry-After','2');return refusalAnswer('QR2_REPORT_FAILED');}
      if(!result?.ok){
        if(result?.kind==='response')return refusalAnswer('QR2_RESPONSE_INVALID');
        return refusalAnswer('QR2_REPORT_FAILED');
      }
      if(!validateOwnerResponse(result.body))return refusalAnswer('QR2_RESPONSE_INVALID');
      if(Array.isArray(result.auditFindings)&&result.auditFindings.length){
        const groups=new Map();
        for(const {botId,broker,...finding} of result.auditFindings.slice(0,20)){
          // Scope is server-derived worker metadata, never an HTTP selector or a foreign ledger identity.
          const key=JSON.stringify([botId,broker]);
          if(!groups.has(key))groups.set(key,{botId,broker,findings:[]});
          groups.get(key).findings.push(finding);
        }
        res.phase2AfterCommit=async()=>{for(const group of groups.values())await writeAudit(store,group);};
      }
      return {status:200,body:result.body};
    }catch{return refusalAnswer('QR2_REPORT_FAILED');}
    finally{release?.();}
  };
  return true;
}
