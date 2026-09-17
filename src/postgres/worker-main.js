import {PostgresDatabase} from './db.js';
import {Store} from './store.js';
import {ExecutionWorker,MailWorker} from './worker.js';
import {config,assertProductionConfig} from '../config.js';
import {EmailNotifier} from '../notifier.js';
assertProductionConfig();
const db=new PostgresDatabase();await db.runtimeLock();await db.verifySchema();
const store=new Store(db),worker=new ExecutionWorker({store,config}),mail=new MailWorker({store,config,notifier:new EmailNotifier(config.smtp)});
worker.start();mail.start();
console.log('Robot trade PostgreSQL Paper worker started');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await Promise.all([worker.stop(),mail.stop()]);await db.close();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
