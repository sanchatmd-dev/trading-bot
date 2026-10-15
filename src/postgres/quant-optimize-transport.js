import http from 'node:http';

export const QUANT_OPTIMIZE_DEADLINE_MS=10000;
const MAX_RESPONSE_BYTES=1024*1024;

export class QuantOptimizeDisconnected extends Error {
  constructor(){super('Quant request disconnected before attempt');}
}
export const quantOptimizeDisconnected=(req,res)=>req.aborted===true||res.destroyed===true||req.socket?.destroyed===true;
export function requireQuantOptimizeConnection(req,res){
  if(quantOptimizeDisconnected(req,res))throw new QuantOptimizeDisconnected();
}

// This state belongs to the incoming request and survives route errors and COMMIT.
export function quantOptimizeOutcome(state){
  if(!state)return null;
  if(!state.completeResponse)return {code:'QUANT_SUBMISSION_OUTCOME_UNKNOWN',error:'Quant request was attempted; its outcome is unknown.'};
  if(state.rowBearing)return {code:'QUANT_RESULT_NOT_RECORDED',error:'Quant response was received, but saving the result was not confirmed.'};
  return {code:'QUANT_REQUEST_NOT_COMPLETED',error:'Quant response was received, but the request could not be completed.'};
}

// Dependencies are injectable for isolated tests. Production uses the fixed deadline above.
export function createQuantOptimizeTransport({request=http.request,clock=()=>performance.now(),
  setTimer=setTimeout,clearTimer=clearTimeout,deadlineMs=QUANT_OPTIMIZE_DEADLINE_MS}={}){
  return (options,body='')=>new Promise((resolve,reject)=>{
    const deadline=clock()+deadlineMs;
    let upstream,response,timer,settled=false,ended=false,raw='',bytes=0;
    const expired=()=>clock()>=deadline;
    const destroy=stream=>{try{stream?.destroy();}catch{ /* Settlement must survive teardown failures. */ }};
    const settle=(error,result)=>{
      if(settled)return;
      settled=true;
      clearTimer(timer);
      if(error){reject(error);destroy(response);destroy(upstream);}
      else resolve(result);
    };
    const timeout=()=>settle(new Error('Quant request timed out'));
    timer=setTimer(timeout,deadlineMs);
    try{
      upstream=request(options,incoming=>{
        response=incoming;
        // Keep error listeners after settlement: destroying either stream may emit a late error.
        response.on('error',error=>settle(error));
        response.on('aborted',()=>settle(new Error('Quant response aborted')));
        response.on('close',()=>{if(!ended)settle(new Error('Quant response closed before end'));});
        if(settled){destroy(response);return;}
        if(expired()){timeout();return;}
        response.setEncoding('utf8');
        response.on('data',chunk=>{
          if(settled)return;
          if(expired()){timeout();return;}
          bytes+=Buffer.byteLength(chunk);
          if(bytes>MAX_RESPONSE_BYTES){settle(new Error('Quant response too large'));return;}
          raw+=chunk;
        });
        response.on('end',()=>{
          ended=true;
          if(settled)return;
          if(expired()){timeout();return;}
          let parsed;
          try{parsed=JSON.parse(raw);}catch{settle(new Error('Invalid Quant response'));return;}
          if(expired()){timeout();return;}
          settle(null,{status:response.statusCode||502,body:parsed});
        });
      });
      upstream.on('error',error=>settle(error));
      upstream.on('timeout',timeout);
      if(settled){destroy(upstream);return;}
      if(expired()){timeout();return;}
      upstream.end(body);
    }catch(error){settle(error);}
  });
}

export const requestQuantOptimize=createQuantOptimizeTransport();
