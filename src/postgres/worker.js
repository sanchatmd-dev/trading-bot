import {randomUUID} from 'node:crypto';
import {evaluateRisk} from './risk.js';
import {D,amount} from '../money.js';
import {decryptJson} from '../security.js';

export class ExecutionWorker {
  constructor({store,config,id=randomUUID(),beforeCommit}){Object.assign(this,{store,config,id,beforeCommit});}
  async tick(){
    const db=this.store.db;
    const result=await db.transaction(async()=>{
      // Lock an owner with ready work. Other owners can execute on other workers.
      // All five bots retain independent ledgers; owner locking also orders suspension against execution.
      const owner=await db.prepare(`SELECT u.id FROM users u WHERE u.parent_user_id IS NULL AND EXISTS(
        SELECT 1 FROM signals s JOIN users b ON b.id=s.user_id WHERE s.status='QUEUED' AND COALESCE(b.parent_user_id,b.id)=u.id)
        ORDER BY u.created_at,u.id LIMIT 1 FOR UPDATE OF u SKIP LOCKED`).get();
      if(!owner)return false;
      const job=await db.prepare(`SELECT s.* FROM signals s JOIN users b ON b.id=s.user_id WHERE s.status='QUEUED'
        AND COALESCE(b.parent_user_id,b.id)=? ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`).get(owner.id);
      if(!job)return false;
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(job.user_id);
      await db.prepare("UPDATE signals SET status='PROCESSING' WHERE id=?").run(job.id);
      const signal=JSON.parse(job.payload),user=await this.store.userById(job.user_id),main=await this.store.userById(owner.id);
      let reason;
      if(job.execution_mode!=='PAPER')reason='Live execution is locked';
      else if(user?.status!=='ACTIVE'||main?.status!=='ACTIVE')reason='User or main account is suspended';
      else{
        const session=await this.store.getBotSession(job.user_id);
        if(session.state==='STOPPED')reason='Bot is stopped: no signals accepted';
        else if(session.state==='PAUSED'&&signal.side!=='SELL')reason='Bot is paused: only reduce-only exits are accepted';
        else if(session.state==='PAUSED'&&!signal.reduceOnly)reason='Bot is paused: only reduce-only exits are accepted';
        else{
          // Use frozen policy when RUNNING; fall back to live policy for SETUP/PAUSED
          const rawPolicy=session.state==='RUNNING'&&session.locked_policy?JSON.parse(session.locked_policy):null;
          const policy=rawPolicy||await this.store.risk(user.id,this.config.defaultRisk),exposure=await this.store.exposure(job),account=await this.store.paperAccount(user.id,job.broker);
          if(exposure.uncertain)reason='Unresolved order outcome: operator reconciliation required';
          else{
            const targetAllocation = signal.targetTradeId ? await this.store.ledgerTargetAllocation(job, signal.targetTradeId) : null;
            const result=evaluateRisk(signal,{policy,daily:await this.store.ledgerDaily(job),position:await this.store.ledgerPosition(job),targetAllocation,equity:account.bookEquity,balance:account.cash,
              cashAvailable:amount(D(account.cash).minus(exposure.reservedNotional)),licensed:main.role==='ADMIN'||await this.store.hasActiveLicense(main.id),globalKill:await this.store.getSetting('globalKill',false),...exposure});
            if(!result.ok)reason=result.reason;
            else{
              const order={...result.order,clientOrderId:job.client_order_id};
              await this.store.persistIntent(job,order);
              await this.store.recordExecution(job,{status:'FILLED',orderId:'PAPER-'+job.client_order_id,executedQty:order.quantity,quoteQty:order.notional,deltaFeeQuote:'0',raw:{paper:true,status:'FILLED',feesSimulated:false}},order);
            }
          }
        }
      }
      if(reason){
        await this.store.complete(job.id,'REJECTED',{error:reason});
        await this.store.audit(job.user_id,'risk.rejected',job.trade_id,{reason});
        await db.prepare('INSERT INTO notification_outbox(user_id,subject,body) VALUES(?,?,?)').run(job.user_id,'Robot trade rejected '+job.trade_id,reason);
      }
      // A crash anywhere before commit rolls back claim, risk checks, fills and ledger together.
      await this.beforeCommit?.(job);
      return true;
    });
    await db.prepare("INSERT INTO worker_heartbeats(id,last_tick,role) VALUES(?,?,'execution') ON CONFLICT(id) DO UPDATE SET last_tick=excluded.last_tick").run(this.id,Date.now());
    return result;
  }
  start(){this.timer=setInterval(()=>this.run(),this.config.workerIntervalMs);this.run();}
  run(){if(this.active||this.stopping)return;this.active=this.tick().catch(()=>console.error('Execution worker transaction failed')).finally(()=>{this.active=null;});}
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;await this.store.db.prepare('DELETE FROM worker_heartbeats WHERE id=?').run(this.id);}
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
