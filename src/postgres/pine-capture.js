import {randomBytes,randomUUID} from 'node:crypto';
import {hash,canonical,fail,keys,number} from '../pine-bridge/source.js';
import {validateEvent} from '../pine-bridge/contract.js';

// Capture is deliberately independent of receiveBridge: it cannot enqueue,
// create allocations, record readiness or change deployment state.
export async function createCapture(service,owner,deploymentId,body,now=Date.now()) {
  keys(body,['ttl_seconds'],[]);const ttl=body.ttl_seconds??86400;
  number(ttl,{min:60,max:604800,integer:true});
  let d=await service.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=?').get(deploymentId,owner);
  if(!d)throw fail('NOT_FOUND',404);await service.authorize(owner,d.bot_id);
  await service.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner);
  d=await service.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=? FOR UPDATE').get(deploymentId,owner);
  if(!d)throw fail('NOT_FOUND',404);
  if(d.state!=='DRAFT')throw fail('CAPTURE_REQUIRES_DRAFT',409);
  await service.db.prepare('UPDATE pine_capture_sessions SET closed=TRUE WHERE deployment_id=?').run(deploymentId);
  const active=await service.db.prepare('SELECT count(*) n FROM pine_capture_sessions WHERE owner_id=? AND closed=FALSE AND expires_at>?').get(owner,now);
  if(active.n>=5)throw fail('CAPTURE_LIMIT',429);
  const id=randomUUID(),token=randomBytes(32).toString('hex');
  await service.db.prepare('INSERT INTO pine_capture_sessions(capture_id,deployment_id,owner_id,bot_id,snapshot_hash,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,deploymentId,owner,d.bot_id,d.snapshot_hash,hash(token),now,now+ttl*1000);
  await service.store.audit(owner,'pine_bridge.capture.created',id,{deployment_id:deploymentId,expires_at:now+ttl*1000});
  return {capture_id:id,capture_path:'/webhooks/pine-capture/v1/'+token,expires_at:now+ttl*1000,mode:'CAPTURE_ONLY',execution_enabled:false};
}
export async function captureStatus(service,owner,id,close=false) {
  const row=await service.db.prepare('SELECT * FROM pine_capture_sessions WHERE capture_id=? AND owner_id=? FOR UPDATE').get(id,owner);
  if(!row)throw fail('NOT_FOUND',404);await service.authorize(owner,row.bot_id);
  if(close){await service.db.prepare('UPDATE pine_capture_sessions SET closed=TRUE WHERE capture_id=?').run(id);row.closed=true;}
  const events=await service.db.prepare('SELECT event_id,event_hash,payload,received_at FROM pine_capture_events WHERE capture_id=? ORDER BY received_at DESC,event_id LIMIT 100').all(id);
  const {token_hash,...result}=row;
  return {...result,mode:'CAPTURE_ONLY',execution_enabled:false,events,events_limit:100};
}
export async function receiveCapture(service,token,body,now=Date.now()) {
  if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token))throw fail('NOT_FOUND',404);
  return service.db.transaction(async()=>{
    const row=await service.db.prepare('SELECT * FROM pine_capture_sessions WHERE token_hash=? FOR UPDATE').get(hash(token));
    if(!row||row.closed||row.expires_at<=now)throw fail('CAPTURE_EXPIRED',404);
    await service.authorize(row.owner_id,row.bot_id);
    const d=await service.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=? AND bot_id=?').get(row.deployment_id,row.owner_id,row.bot_id);
    if(!d||d.state!=='DRAFT'||d.snapshot_hash!==row.snapshot_hash)throw fail('STALE_CAPTURE',409);
    if(row.received+row.duplicates+row.rejected>=1000)throw fail('CAPTURE_LIMIT',429);
    const digest=hash(canonical(body));
    let diagnostic;
    try{validateEvent(body,d.snapshot.market,now,300000);}catch(error){if(!error.code)throw error;diagnostic=error.code;}
    if(!diagnostic){
      const old=await service.db.prepare('SELECT event_hash FROM pine_capture_events WHERE capture_id=? AND event_id=?').get(row.capture_id,body.event_id);
      if(old){
        if(old.event_hash!==digest)diagnostic='EVENT_CONFLICT';
        else{
          await service.db.prepare('UPDATE pine_capture_sessions SET duplicates=duplicates+1 WHERE capture_id=?').run(row.capture_id);
          return {captured:true,duplicate:true,mode:'CAPTURE_ONLY',execution_enabled:false};
        }
      }
    }
    if(diagnostic){
      await service.db.prepare('UPDATE pine_capture_sessions SET rejected=rejected+1,last_error=? WHERE capture_id=?').run(diagnostic,row.capture_id);
      // Return a rejection so the diagnostic commits; never store unexpected
      // native payloads which may contain user-supplied sensitive strings.
      return {captured:false,code:diagnostic,mode:'CAPTURE_ONLY',execution_enabled:false};
    }
    await service.db.prepare('INSERT INTO pine_capture_events VALUES(?,?,?,?,?)').run(row.capture_id,body.event_id,digest,JSON.stringify(body),now);
    await service.db.prepare('UPDATE pine_capture_sessions SET received=received+1 WHERE capture_id=?').run(row.capture_id);
    return {captured:true,duplicate:false,mode:'CAPTURE_ONLY',execution_enabled:false};
  });
}
