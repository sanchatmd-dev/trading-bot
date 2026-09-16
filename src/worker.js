import {evaluateRisk} from './risk.js';
import {decryptJson} from './security.js';
import {fetchOrderStatus, assertLiveEnabled} from './adapters/registry.js';

export class Worker {
  constructor({store,config,notifier}) {
    Object.assign(this,{store,config,notifier});
    this.busy=false;
    this.stopping=false;
    this.lastTick=Date.now();
    this.lastReconcile=0;
  }
  start() {
    this.timer=setInterval(()=>this.run(),this.config.workerIntervalMs);
    this.timer.unref();
    this.run();
  }
  run() {
    if(this.active||this.stopping)return;
    this.active=this.tick().catch(error=>{
      this.lastError=error.message;
      console.error('Worker failure:',error.message);
    }).finally(()=>{this.active=null;});
  }
  async stop() {
    this.stopping=true;
    clearInterval(this.timer);
    await this.active;
  }
  async tick() {
    if(this.busy||this.stopping)return;
    this.busy=true;
    try {
      // Reconcile on a schedule even when intake never becomes idle.
      if(Date.now()-this.lastReconcile>=5000)await this.reconcile();
      const job=this.store.claimNext();
      if(job)await this.process(job);
      this.lastTick=Date.now();
      this.lastError=null;
    } finally { this.busy=false; }
  }
  async process(job) {
    const signal=job.payload;
    try {
      if(job.execution_mode!=='PAPER')assertLiveEnabled(signal.broker);
      const user=this.store.userById(job.user_id);
      if(!user||user.status!=='ACTIVE')throw new Error('User is suspended or unavailable');
      const policy=this.store.risk(job.user_id,this.config.defaultRisk);
      const exposure=this.store.exposure(job);
      if(exposure.uncertain)throw new Error('Unresolved order outcome: operator reconciliation required');
      const result=evaluateRisk(signal,{
        policy,daily:this.store.ledgerDaily(job),position:this.store.ledgerPosition(job),
        equity:policy.equities?.[signal.broker]||0,
        licensed:user.role==='ADMIN'||this.store.hasActiveLicense(job.user_id),
        globalKill:this.store.getSetting('globalKill',false),...exposure
      });
      if(!result.ok)throw new Error(result.reason);
      const order={...result.order,clientOrderId:job.client_order_id};
      this.store.persistIntent(job,order);
      // All live entry points are closed in this release, including direct adapter calls.
      this.store.recordExecution(job,{
        status:'FILLED',orderId:`PAPER-${job.client_order_id}`,executedQty:order.quantity,
        quoteQty:order.notional,deltaFeeQuote:0,raw:{paper:true,status:'FILLED',feesSimulated:false,...(order.sizingAdjustment?{sizingAdjustment:order.sizingAdjustment}:{})}
      },order);
    } catch(error) {
      // No external submission exists on this path in the staging release.
      this.store.complete(job.id,'REJECTED',{error:error.message});
      this.store.audit(job.user_id,'risk.rejected',signal.tradeId,{reason:error.message});
      this.store.db.prepare('INSERT INTO notification_outbox(user_id,subject,body) VALUES(?,?,?)')
        .run(job.user_id,`Robot trade rejected ${signal.tradeId}`,error.message);
    }
  }
  async reconcile() {
    this.lastReconcile=Date.now();
    const row=this.store.pendingForReview();
    if(!row)return;
    // Rotate even missing-credential/unsupported orders to avoid starvation.
    this.store.touchPending(row.id);
    try {
      if(row.execution_mode==='LEGACY')throw new Error('Legacy outcome requires manual broker review; ledger not imported');
      const credential=this.store.credential(row.user_id,row.broker);
      if(!credential)throw new Error('Credentials unavailable for reconciliation');
      const execution=await fetchOrderStatus(row.broker,
        decryptJson(credential.encrypted_data,this.config.masterKey,`${row.user_id}:${row.broker}`),row);
      if(!execution)throw new Error('Broker reconciliation is not supported');
      if(!row.order_intent)throw new Error('Missing order intent; manual review required');
      this.store.recordExecution(row,execution,JSON.parse(row.order_intent));
    } catch(error) {
      this.store.markUnknown(row,error.message);
    }
  }
}

// SMTP has its own bounded retry loop and cannot hold up execution.
export class NotificationWorker {
  constructor({store,notifier}) { Object.assign(this,{store,notifier}); }
  start() { this.timer=setInterval(()=>this.run(),1000);this.timer.unref(); }
  run() {
    if(this.active||this.stopping)return;
    this.active=this.tick().catch(error=>console.error('Outbox failure:',error.message))
      .finally(()=>{this.active=null;});
  }
  async tick() {
    const row=this.store.db.prepare("SELECT * FROM notification_outbox WHERE status='PENDING' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now());
    if(!row)return;
    if(!this.notifier.config?.host) {
      this.store.db.prepare("UPDATE notification_outbox SET status='DISABLED' WHERE id=?").run(row.id);
      return;
    }
    const user=this.store.userById(row.user_id);
    const sent=await this.notifier.send(user?.email,row.subject,row.body);
    const attempts=row.attempts+1;
    this.store.db.prepare('UPDATE notification_outbox SET status=?,attempts=?,next_attempt=? WHERE id=?')
      .run(sent?'SENT':attempts>=5?'FAILED':'PENDING',attempts,Date.now()+Math.min(3600000,1000*2**attempts),row.id);
  }
  async stop() { this.stopping=true;clearInterval(this.timer);await this.active; }
}
