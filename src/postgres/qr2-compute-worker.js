import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import {computeQr2View} from './qr2-reader.js';
import {composeOwnerResponse} from '../portfolio/qr2-owner-response.js';
import {composePerformanceResponse} from '../portfolio/qr2-response.js';

// QR-2 S3b compute worker (RC-Q35, design option A). It computes one reader view from a plain snapshot and builds the response body, off
// the main thread's event loop. This module imports only node:worker_threads, the pure compute half of qr2-reader.js and the pure response
// composer: it imports no pg, no db.js, no store and no server module (a test walks the import graph), so a worker has no database handle
// and a message cannot carry one. Nothing is kept between jobs. Every result is JSON-safe plain data; no message text, stack or ledger row
// crosses back (the composer already drops view.rows).

export const QR2_WORKER_ROLE='qr2-compute';

const jsonSafe=value=>{try{JSON.stringify(value);return true;}catch{return false;}};

/**
 * One job: {snapshot,input} to a result. Exported for the in-thread tests and for the worker listener below; seams are for tests only.
 * ok:true  {id?,ok,body,auditFindings,compute_ms}
 * ok:false {kind:'qr2',code,detail?} a Qr2Error of the compute; {kind:'response'} a composer failure; {kind:'other'} anything else.
 */
export function executeQr2Job({snapshot,input},{compute=computeQr2View,compose=composePerformanceResponse}={}){
  if(input?.kind!==undefined&&input.kind!=='account'&&input.kind!=='owner')return {ok:false,kind:'other'};
  if(input?.kind==='owner'){
    if(snapshot?.kind!=='owner')return {ok:false,kind:'other'};
    try{return {ok:true,...composeOwnerResponse(snapshot,input)};}
    catch(error){return {ok:false,kind:error?.code==='QR2_RESPONSE_INVALID'?'response':'other'};}
  }
  if(snapshot?.kind==='owner')return {ok:false,kind:'other'};
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
  try{body=compose(view,{requestTime:input.requestTime});}
  catch{return {ok:false,kind:'response'};}
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
