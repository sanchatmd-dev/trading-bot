import {admitBridgeEvent} from './pine-bridge-receiver.js';

// Keeps the HTTP response short. Missing market data is never treated as an
// executable signal; admission happens only after a verified closed bar exists.
export class PineMarketWaitWorker {
  constructor({store,defaultRisk={}}){this.store=store;this.db=store.db;this.defaultRisk=defaultRisk;}
  async tick(){
    return this.db.transaction(async()=>{
      const pending=await this.db.prepare("SELECT * FROM pine_bridge_pending WHERE status='WAITING_MARKET' ORDER BY deadline_at,received_at LIMIT 1 FOR UPDATE SKIP LOCKED").get();
      if(!pending)return false;
      const now=Date.now();
      const reject=async code=>this.db.prepare("UPDATE pine_bridge_pending SET status='REJECTED',diagnostic=?,checked_at=? WHERE deployment_id=? AND event_id=?").run(code,now,pending.deployment_id,pending.event_id);
      if(now>=pending.deadline_at){await reject('MARKET_WAIT_EXPIRED');return true;}
      const body=pending.payload;
      const frozen=await this.db.prepare('SELECT 1 FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? AND bar_time=?').get(body.broker,body.symbol,body.timeframe,body.bar_time);
      if(!frozen){await this.db.prepare('UPDATE pine_bridge_pending SET checked_at=? WHERE deployment_id=? AND event_id=?').run(now,pending.deployment_id,pending.event_id);return false;}
      const row=await this.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(pending.deployment_id);
      if(!row){await reject('BRIDGE_NOT_READY');return true;}
      await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(row.owner_id);
      if(row.bot_id!==row.owner_id)await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(row.bot_id);
      const bot=await this.store.userById(row.bot_id),owner=await this.store.botOwner(row.bot_id);
      if(!bot||bot.status!=='ACTIVE'||owner?.id!==row.owner_id||owner.status!=='ACTIVE'){await reject('OWNER_UNAVAILABLE');return true;}
      const session=await this.store.getBotSession(row.bot_id);
      if(session.state==='STOPPED'){await reject('BOT_STOPPED');return true;}
      if(session.state==='PAUSED'&&body.event_type==='BUY'){await reject('BOT_PAUSED');return true;}
      try{
        const result=await admitBridgeEvent(this.store,row,bot,pending.payload,pending.event_hash,{defaultRisk:this.defaultRisk,allowWait:'pending',deadlineAt:pending.deadline_at});
        if(result.waiting_market){await this.db.prepare('UPDATE pine_bridge_pending SET checked_at=? WHERE deployment_id=? AND event_id=?').run(now,pending.deployment_id,pending.event_id);return false;}
        await this.db.prepare("UPDATE pine_bridge_pending SET status='QUEUED',signal_id=?,checked_at=? WHERE deployment_id=? AND event_id=?").run(result.signal_id,now,pending.deployment_id,pending.event_id);
      }catch(error){
        if(!error.code||/^[0-9A-Z]{5}$/.test(error.code))throw error;
        await reject(error.code);
      }
      return true;
    });
  }
  start(){this.timer=setInterval(()=>this.run(),250);this.run();}
  run(){if(this.active||this.stopping)return;this.active=this.tick().catch(()=>console.error('Pine market wait worker failed')).finally(()=>{this.active=null;});}
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;}
}
