import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {config} from '../../src/config.js';
import {setTimeout as delay} from 'node:timers/promises';
const db=new PostgresDatabase();await db.runtimeLock();
const worker=new ExecutionWorker({store:new Store(db),config,beforeCommit:process.env.TEST_CRASH==='true'?async()=>{process.send('before-commit');await new Promise(()=>{});}:undefined});
// Run until TEST_OWNER has no queued signal, not for a fixed tick count: peers take the owner row FOR UPDATE SKIP LOCKED, so on a
// loaded host many ticks find it held and do nothing. The deadline bounds a stuck run; work left at the deadline exits with code 2.
const owner=process.env.TEST_OWNER,deadline=Date.now()+Number(process.env.TEST_DEADLINE_MS||60000);
const queued=async()=>Number((await db.prepare("SELECT count(*) n FROM signals WHERE status='QUEUED' AND user_id=?").get(owner)).n);
try{
  while(Date.now()<deadline){if(!await worker.tick()&&await queued()===0)break;await delay(5);}
  if(await queued()>0)process.exitCode=2;
}
finally{await worker.stop();await db.close();}
