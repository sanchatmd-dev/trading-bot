import {PostgresDatabase} from './db.js';
import {Store} from './store.js';
import {ExecutionWorker,MailWorker} from './worker.js';
import {config,assertProductionConfig} from '../config.js';
import {EmailNotifier} from '../notifier.js';
import {PineBridgeService} from './pine-bridge.js';
import {PineBridgeWorker} from './pine-bridge-worker.js';
assertProductionConfig();
const db=new PostgresDatabase();await db.runtimeLock();await db.verifySchema();
const store=new Store(db),worker=new ExecutionWorker({store,config}),mail=new MailWorker({store,config,notifier:new EmailNotifier(config.smtp)});
let pineBridge;
if(process.env.PINE_BRIDGE_ENABLED==='1') {
  const rows=(await db.query('SELECT version FROM pine_bridge_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw new Error('Initialize Pine Bridge extension 1 offline');
  pineBridge=new PineBridgeWorker({service:new PineBridgeService(store,{defaultRisk:config.defaultRisk})});
  pineBridge.start();
}
worker.start();mail.start();
console.log('Robot trade PostgreSQL Paper worker started');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await Promise.all([worker.stop(),mail.stop(),pineBridge?.stop()]);await db.close();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
