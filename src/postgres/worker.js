import {randomUUID} from 'node:crypto';
import {evaluateRisk} from './risk.js';
import {D,amount} from '../money.js';
import {decryptJson} from '../security.js';
import {prepareBridgeExecution,completeBridgeExecution} from './pine-bridge-execution.js';
import {finalizeBridgeOrder,COST_MODEL_VERSION} from './paper-cost-model.js';
import {checkPaperVenue} from './risk-venue.js';

// SQLSTATE classes that describe the connection or the server, not the signal: connection exception (08),
// transaction rollback such as serialization failure or deadlock (40), insufficient resources (53), object not in
// prerequisite state such as lock timeout (55), operator intervention such as statement timeout or shutdown (57)
// and system error (58). A failure in one of these classes never counts toward the retry bound.
const TRANSIENT_SQLSTATE_CLASSES=new Set(['08','40','53','55','57','58']);
// SQLSTATE classes that describe the code, the schema, privileges or the server, not the signal: syntax or access rule
// violation such as a missing table or column (42), invalid authorization (28), invalid catalog or schema name (3D, 3F),
// feature not supported (0A), invalid transaction state (25) and internal error (XX). Worker code deployed before its
// migration fails like this on every tick for every owner, so these are never counted and never reject a signal.
const ENVIRONMENT_SQLSTATE_CLASSES=new Set(['42','28','3D','3F','0A','25','XX']);
// Node network and closed-socket error codes are listed by name because Bridge rejection codes are also non-SQLSTATE
// strings and several of them start with E; those are deterministic.
const NETWORK_ERROR_CODES=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','EPIPE','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EAI_AGAIN',
  'ENETDOWN','EHOSTDOWN','EADDRNOTAVAIL','EPROTO','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED','ERR_STREAM_PREMATURE_CLOSE']);
// node-postgres raises these without a code when the pool or the socket is gone.
const CONNECTION_MESSAGE=/connection terminated|timeout exceeded when trying to connect|not queryable|client was closed|pool is draining/i;
// systemicOwners distinct owners failing with the same fault key inside systemicWindowMs suspend terminal writes of that key.
export const DEFAULT_FAULT_POLICY=Object.freeze({maxAttempts:3,backoffMs:Object.freeze([1000,5000]),terminalRetryMs:30000,systemicOwners:2,systemicWindowMs:60000});

export function classifyExecutionFault(error){
  const code=typeof error?.code==='string'?error.code:'',message=String(error?.message??'');
  const network=NETWORK_ERROR_CODES.has(code),sqlstate=!network&&/^[0-9A-Z]{5}$/.test(code)?code:null;
  const transient=network||(sqlstate!==null&&TRANSIENT_SQLSTATE_CLASSES.has(sqlstate.slice(0,2)))||(!code&&CONNECTION_MESSAGE.test(message));
  let faultClass='OTHER';
  if(sqlstate!==null&&ENVIRONMENT_SQLSTATE_CLASSES.has(sqlstate.slice(0,2)))faultClass='ENVIRONMENT';
  else if(/Maximum decimal scale/.test(message))faultClass='DECIMAL_SCALE';
  else if(/Fill exceeds|Target allocation|Insufficient Paper cash/.test(message))faultClass='LEDGER';
  else if(code&&!sqlstate&&!network)faultClass='BRIDGE';
  return {transient,sqlstate,faultClass};
}
// Log text only: a JSON parse error can quote the payload and an error can name an email, so neither is repeated.
function describeError(error){
  if(error instanceof SyntaxError)return 'SyntaxError';
  return String(error?.message??'').replace(/\S+@\S+/g,'[redacted]').replace(/\s+/g,' ').slice(0,200);
}
// Systemic breaker key. Uncoded JavaScript errors all fall in class OTHER without a SQLSTATE, so the constructor name
// keeps a SyntaxError on one owner and a TypeError on another apart. A name that is not a plain identifier reads NONE.
function faultKey(info,error){
  if(info.sqlstate!==null||info.faultClass!=='OTHER')return info.faultClass+':'+(info.sqlstate??'NONE');
  const name=error?.constructor?.name;
  return 'OTHER:'+(typeof name==='string'&&/^[A-Za-z_$][\w$]{0,63}$/.test(name)?name:'NONE');
}

export class ExecutionWorker {
  constructor({store,config,id=randomUUID(),beforeCommit,faultPolicy,now=Date.now}){
    Object.assign(this,{store,config,id,beforeCommit,now,faultPolicy:{...DEFAULT_FAULT_POLICY,...faultPolicy},
      // In-memory only: counters restart with the process (design D8), so the bound is per process.
      claim:null,processed:null,faults:new Map(),quarantine:new Map(),
      // Systemic breaker: fault key -> owner -> {at: time of its latest counted fault, signalId, userId}. suspendedKeys
      // holds the keys whose evidence has systemicOwners owners; only faults of those keys are held without a terminal write.
      systemic:new Map(),suspendedKeys:new Set()});
  }
  async tick({excludeOwners=[]}={}){
    const db=this.store.db;
    this.claim=null;this.processed=null;
    const result=await db.transaction(async()=>{
      // Lock an owner with ready work. Other owners can execute on other workers.
      // All five bots retain independent ledgers; owner locking also orders suspension against execution.
      // excludeOwners lists owners the guarded loop has isolated after a deterministic failure.
      const owner=await db.prepare(`SELECT u.id FROM users u WHERE u.parent_user_id IS NULL AND NOT (u.id=ANY(?::text[])) AND EXISTS(
        SELECT 1 FROM signals s JOIN users b ON b.id=s.user_id WHERE s.status='QUEUED' AND COALESCE(b.parent_user_id,b.id)=u.id)
        ORDER BY u.created_at,u.id LIMIT 1 FOR UPDATE OF u SKIP LOCKED`).get(excludeOwners);
      if(!owner)return false;
      const job=await db.prepare(`SELECT s.* FROM signals s JOIN users b ON b.id=s.user_id WHERE s.status='QUEUED'
        AND COALESCE(b.parent_user_id,b.id)=? ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`).get(owner.id);
      if(!job)return false;
      this.claim={ownerId:owner.id,signalId:job.id,userId:job.user_id};
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(job.user_id);
      await db.prepare("UPDATE signals SET status='PROCESSING' WHERE id=?").run(job.id);
      const signal=JSON.parse(job.payload),user=await this.store.userById(job.user_id),main=await this.store.userById(owner.id);
      let reason,bridgeModel;
      if(job.execution_mode!=='PAPER')reason='Live execution is locked';
      else if(user?.status!=='ACTIVE'||main?.status!=='ACTIVE')reason='User or main account is suspended';
      else{
        if(signal.bridge){
          try{bridgeModel=await prepareBridgeExecution(this.store,job,signal,this.config.defaultRisk);}
          // A network or closed-socket code says nothing about the signal: rethrown like a SQLSTATE, it is a transient fault.
          catch(error){if(!error.code||/^[0-9A-Z]{5}$/.test(error.code)||NETWORK_ERROR_CODES.has(error.code))throw error;reason=error.code;}
        }
        const session=await this.store.getBotSession(job.user_id);
        if(reason){} // Preserve the scoped Bridge rejection before legacy risk work.
        else if(session.state==='STOPPED')reason='Bot is stopped: no signals accepted';
        else if(session.state==='PAUSED'&&signal.side!=='SELL')reason='Bot is paused: only reduce-only exits are accepted';
        else if(session.state==='PAUSED'&&!signal.reduceOnly)reason='Bot is paused: only reduce-only exits are accepted';
        else{
          // Use frozen policy when RUNNING; fall back to live policy for SETUP/PAUSED
          const rawPolicy=(session.state==='RUNNING'||signal.bridge)&&session.locked_policy?JSON.parse(session.locked_policy):null;
          const policy=rawPolicy||await this.store.risk(user.id,this.config.defaultRisk),exposure=await this.store.exposure(job),account=await this.store.paperAccount(user.id,job.broker);
          if(exposure.uncertain)reason='Unresolved order outcome: operator reconciliation required';
          else{
            const targetAllocation = signal.targetTradeId ? await this.store.ledgerTargetAllocation(job, signal.targetTradeId) : null;
            const cashBudget=D(account.cash).minus(exposure.reservedNotional).minus(exposure.reservedFees??0).div(bridgeModel&&signal.side==='BUY'?D(1).plus(D(bridgeModel.fee_bps).div(10000)):1);
            const result=evaluateRisk(signal,{policy,daily:await this.store.ledgerDaily(job),position:await this.store.ledgerPosition(job),targetAllocation,equity:account.bookEquity,balance:account.cash,
              cashAvailable:amount(cashBudget),licensed:main.role==='ADMIN'||await this.store.hasActiveLicense(main.id),globalKill:await this.store.getSetting('globalKill',false),...exposure});
            if(!result.ok)reason=result.reason;
            else{
              let order={...result.order,clientOrderId:job.client_order_id},fee='0';
              if(bridgeModel){
                try{({order,fee}=finalizeBridgeOrder(order,bridgeModel,{policy,account,signal,exposure}));}
                catch(error){if(!error.code)throw error;reason=error.code;}
                if(!reason&&bridgeModel.version===COST_MODEL_VERSION){
                  const venue=await checkPaperVenue(this.store,job,order,bridgeModel);
                  if(venue.status!=='PASSED')reason=venue.reasons?.[0]??'VENUE_FILTERS_UNVERIFIED';
                  else order={...order,venue_report:venue};
                }
              }
              if(!reason){
                await this.store.persistIntent(job,order);
                await this.store.recordExecution(job,{status:'FILLED',orderId:'PAPER-'+job.client_order_id,executedQty:order.quantity,quoteQty:order.notional,deltaFeeQuote:fee,raw:{paper:true,status:'FILLED',feesSimulated:!!bridgeModel,...(bridgeModel?{executionModel:bridgeModel,signalReference:signal.bridge}:{} ),...(order.venue_report?{venueReport:order.venue_report}:{})}},order);
                if(signal.bridge)await completeBridgeExecution(this.store,job,signal,'FILLED');
              }
            }
          }
        }
      }
      if(reason){
        await this.store.complete(job.id,'REJECTED',{error:reason});
        await this.store.audit(job.user_id,'risk.rejected',job.trade_id,{reason});
        await db.prepare('INSERT INTO notification_outbox(user_id,subject,body) VALUES(?,?,?)').run(job.user_id,'Robot trade rejected '+job.trade_id,reason);
        if(signal.bridge)await completeBridgeExecution(this.store,job,signal,'REJECTED');
      }
      // A crash anywhere before commit rolls back claim, risk checks, fills and ledger together.
      await this.beforeCommit?.(job);
      return true;
    });
    // Committed: a later failure (the heartbeat write) is no longer a fault of this signal.
    this.processed=this.claim;this.claim=null;
    await db.prepare("INSERT INTO worker_heartbeats(id,last_tick,role) VALUES(?,?,'execution') ON CONFLICT(id) DO UPDATE SET last_tick=excluded.last_tick").run(this.id,Date.now());
    return result;
  }
  start(){this.timer=setInterval(()=>this.run(),this.config.workerIntervalMs);this.run();}
  run(){if(this.active||this.stopping)return;this.active=this.cycle().catch(()=>console.error('Execution worker transaction failed')).finally(()=>{this.active=null;});}
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;await this.store.db.prepare('DELETE FROM worker_heartbeats WHERE id=?').run(this.id);}

  // One guarded pass of the loop. tick() still throws on failure; this method decides what a failure means.
  async cycle(){
    const now=this.now();
    this.processed=null;
    try{
      this.refreshSuspension(now);
      await this.retryTerminals(now);
      await this.tick({excludeOwners:this.isolatedOwners(now)});
    }catch(error){await this.handleFailure(error);}
    // The claimed signal committed, so earlier failures of it no longer matter. This runs even when a step after the
    // commit (the heartbeat write) threw, because tick() records the claim as processed before that step.
    if(this.processed)this.clearAfterCommit(this.processed);
  }
  clearAfterCommit({signalId,ownerId}){
    this.faults.delete(signalId);this.quarantine.delete(ownerId);
    this.leaveSystemic(ownerId);
  }
  // Owners that skip this tick: inside a backoff window, or waiting for a terminal write to succeed.
  isolatedOwners(now){
    const owners=new Set();
    for(const [owner,until] of this.quarantine){if(until>now)owners.add(owner);else this.quarantine.delete(owner);}
    for(const fault of this.faults.values())if(fault.terminalDue!==null)owners.add(fault.ownerId);
    return [...owners];
  }
  async poolResponds(){
    try{await this.store.db.prepare('SELECT 1 ok').get();return true;}catch{return false;}
  }
  isolate(ownerId,until){this.quarantine.set(ownerId,Math.max(this.quarantine.get(ownerId)??0,until));}
  async handleFailure(error){
    const claim=this.claim,info=classifyExecutionFault(error),{maxAttempts,backoffMs}=this.faultPolicy;
    // A failure before the signal was selected, or while the database is unreachable, says nothing about a signal.
    const transient=info.transient||!claim||!(await this.poolResponds());
    // Read after the checks above: backoff deadlines and lastAt count from the failure, not from the cycle start.
    const now=this.now(),environment=!transient&&info.faultClass==='ENVIRONMENT',counted=!transient&&!environment;
    const count=counted?Math.min((this.faults.get(claim.signalId)?.count??0)+1,maxAttempts):0;
    console.error('Execution worker transaction failed signal='+(claim?.signalId??'NONE')+' owner='+(claim?.ownerId??'NONE')
      +' sqlstate='+(info.sqlstate??'NONE')+' class='+info.faultClass+' transient='+transient
      +(counted?' attempt='+count+'/'+maxAttempts:'')+' message='+describeError(error));
    if(!claim)return;
    // Not counted: the signal is no worse off, but the owner still steps aside so the next owner is served.
    if(info.transient)return this.isolate(claim.ownerId,now+backoffMs[0]);
    if(environment)return this.isolate(claim.ownerId,now+backoffMs[backoffMs.length-1]);
    if(transient)return;
    const key=faultKey(info,error);
    const fault={count,ownerId:claim.ownerId,userId:claim.userId,sqlstate:info.sqlstate,faultClass:info.faultClass,key,lastAt:now,terminalDue:null};
    this.faults.set(claim.signalId,fault);
    for(const [id,old] of this.faults)if(old.terminalDue===null&&now-old.lastAt>600000)this.faults.delete(id);
    const started=this.noteSystemic(key,claim,now);
    if(this.suspendedKeys.has(key)){
      // Counted from each owner's own latest fault, so a later fault of another owner never stretches this one's wait.
      for(const [owner,seen] of this.systemic.get(key))this.isolate(owner,seen.at+backoffMs[backoffMs.length-1]);
    }
    else if(count<maxAttempts)this.isolate(claim.ownerId,now+backoffMs[Math.min(count,backoffMs.length)-1]);
    else await this.reject(claim.signalId,fault);
    for(const startedKey of started)await this.auditSuspension(startedKey);
  }
  // Several distinct owners with the same fault key inside the window point at the code or the data layout, not at one
  // signal, so terminal writes of that key stop and its owners are held. Other keys are not affected. Returns the keys
  // that this fault moved into suspension.
  noteSystemic(key,claim,now){
    if(!this.systemic.has(key))this.systemic.set(key,new Map());
    this.systemic.get(key).set(claim.ownerId,{at:now,signalId:claim.signalId,userId:claim.userId});
    return this.refreshSuspension(now);
  }
  // Drops evidence older than the window and moves keys in or out of suspension. A key stays suspended while at least
  // systemicOwners owners remain in its evidence; evidence leaves by ageing out, by a commit or by a terminal write.
  refreshSuspension(now){
    const {systemicOwners,systemicWindowMs}=this.faultPolicy,started=[];
    for(const [key,owners] of this.systemic){
      for(const [owner,seen] of owners)if(now-seen.at>systemicWindowMs)owners.delete(owner);
      if(!owners.size)this.systemic.delete(key);
    }
    for(const [key,owners] of this.systemic){
      if(owners.size<systemicOwners||this.suspendedKeys.has(key))continue;
      this.suspendedKeys.add(key);started.push(key);
      console.error('Execution worker systemic fault suspected key='+key+' owners='+owners.size+': terminal writes of this key suspended, owners held');
    }
    for(const key of [...this.suspendedKeys]){
      if((this.systemic.get(key)?.size??0)>=systemicOwners)continue;
      this.suspendedKeys.delete(key);
      console.error('Execution worker terminal writes resumed key='+key+': fewer than '+systemicOwners+' owners share the fault');
    }
    return started;
  }
  // The owner has no pending fault any more (its signal committed or was rejected), so it is evidence for no key.
  leaveSystemic(ownerId){
    for(const [key,owners] of this.systemic){owners.delete(ownerId);if(!owners.size)this.systemic.delete(key);}
    this.refreshSuspension(this.now());
  }
  // Makes a suspension visible outside the log: one audit row per owner in the evidence, naming only that owner's own
  // held signal, so tenants never see each other. A separate statement outside the failed tick; a failure is only logged.
  async auditSuspension(key){
    const owners=this.systemic.get(key);
    if(!owners)return;
    for(const [owner,seen] of [...owners]){
      try{await this.store.audit(seen.userId,'worker.systemic_suspected',null,{key,ownerCount:owners.size,signalId:seen.signalId});}
      catch(error){console.error('Execution worker systemic audit write failed key='+key+' owner='+owner+' message='+describeError(error));}
    }
  }
  async retryTerminals(now){
    for(const [signalId,fault] of [...this.faults])if(fault.terminalDue!==null&&fault.terminalDue<=now&&!this.suspendedKeys.has(fault.key))await this.reject(signalId,fault);
  }
  // Terminal step after the last allowed attempt. If it fails the owner stays isolated and the step is retried later.
  async reject(signalId,fault){
    try{
      await this.writeFault(signalId,fault);
      this.faults.delete(signalId);this.quarantine.delete(fault.ownerId);
      this.leaveSystemic(fault.ownerId);
    }catch(error){
      const info=classifyExecutionFault(error);
      fault.terminalDue=this.now()+this.faultPolicy.terminalRetryMs;
      console.error('Execution worker terminal write failed signal='+signalId+' owner='+fault.ownerId+' sqlstate='+(info.sqlstate??'NONE')
        +' class='+info.faultClass+' message='+describeError(error));
    }
  }
  // Separate READ COMMITTED transaction in the tick's lock order: owner, signal, Bot row. It writes no cash, fill,
  // lot or fence row; the signal leaves QUEUED only if it is still QUEUED once the locks are held.
  async writeFault(signalId,fault){
    const db=this.store.db;
    return db.transaction(async()=>{
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(fault.ownerId);
      const job=await db.prepare(`SELECT s.* FROM signals s JOIN users b ON b.id=s.user_id
        WHERE s.id=? AND COALESCE(b.parent_user_id,b.id)=? FOR UPDATE OF s`).get(signalId,fault.ownerId);
      if(!job||job.status!=='QUEUED')return false;
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(job.user_id);
      let signal;
      try{signal=JSON.parse(job.payload);}catch{signal=null;} // a malformed payload is one of the faults handled here
      const reason='EXECUTION_FAULT: '+fault.faultClass;
      await this.store.complete(job.id,'REJECTED',{error:reason});
      await this.store.audit(job.user_id,'order.execution_fault',job.trade_id,{signalId:job.id,attempts:fault.count,faultClass:fault.faultClass,sqlstate:fault.sqlstate});
      await db.prepare('INSERT INTO notification_outbox(user_id,subject,body) VALUES(?,?,?)').run(job.user_id,'Robot trade rejected '+job.trade_id,reason);
      if(signal?.bridge)await completeBridgeExecution(this.store,job,signal,'REJECTED');
      // Without a parsable payload the event is found through its signal id; it is closed only while still QUEUED. The
      // Bridge tables come from a separate migration, so a database without them has no event to close.
      else if(!signal&&(await db.prepare("SELECT to_regclass('pine_bridge_events')::text AS name").get()).name!==null)await db.prepare("UPDATE pine_bridge_events SET outcome='REJECTED' WHERE signal_id=? AND outcome='QUEUED'").run(job.id);
      return true;
    });
  }
}

export class MailWorker {
  constructor({store,config,notifier}){Object.assign(this,{store,config,notifier});}
  async deliver(table){
    if(!['security_mail','notification_outbox'].includes(table))throw new Error('Invalid mail queue');
    const db=this.store.db,token=randomUUID(),now=Date.now();
    const row=await db.transaction(async()=>{
      const result=await db.prepare(`SELECT * FROM ${table} WHERE status='PENDING' AND next_attempt<=? AND lease_until<=? ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).get(now,now);
      if(!result)return null;
      await db.prepare(`UPDATE ${table} SET lease_token=?,lease_until=? WHERE id=?`).run(token,now+60000,result.id);return result;
    });
    if(!row)return;
    if(table==='security_mail'&&row.expires_at<=now){await db.prepare('DELETE FROM security_mail WHERE id=? AND lease_token=?').run(row.id,token);return;}
    const user=await this.store.botOwner(row.user_id);
    const message=table==='security_mail'?decryptJson(row.encrypted_body,this.config.keyring,'security-mail:'+row.user_id):row;
    const sent=!!(user?.status==='ACTIVE'&&this.config.smtp.host&&await this.notifier.send(user.email,message.subject,message.body));
    const done=sent||row.attempts>=4||!this.config.smtp.host||user?.status!=='ACTIVE';
    if(table==='security_mail'&&done){
      await db.prepare('DELETE FROM security_mail WHERE id=? AND lease_token=?').run(row.id,token);
      await this.store.audit(row.user_id,sent?'auth.recovery.sent':'auth.recovery.delivery_failed',null,{});
    }else await db.prepare(`UPDATE ${table} SET status=?,attempts=attempts+1,next_attempt=?,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?`)
      .run(done?(sent?'SENT':!this.config.smtp.host?'DISABLED':'FAILED'):'PENDING',now+1000*2**(row.attempts+1),row.id,token);
  }
  async tick(){
    const db=this.store.db,now=Date.now();
    await db.prepare('DELETE FROM security_limits WHERE expires_at<=?').run(now);
    await db.prepare('DELETE FROM password_resets WHERE expires_at<=?').run(now);
    await db.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').run(now);
    await db.prepare('DELETE FROM sessions WHERE expires_at<=? OR last_seen<=?').run(now,now-this.config.sessionIdleMinutes*60000);
    await this.deliver('security_mail');await this.deliver('notification_outbox');
  }
  start(){this.timer=setInterval(()=>this.run(),1000);this.run();}
  run(){if(this.active||this.stopping)return;this.active=this.tick().catch(()=>console.error('Mail worker attempt failed')).finally(()=>{this.active=null;});}
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;}
}
