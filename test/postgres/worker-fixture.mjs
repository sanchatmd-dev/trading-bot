import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {config} from '../../src/config.js';
import {setTimeout as delay} from 'node:timers/promises';
const db=new PostgresDatabase();await db.runtimeLock();
const worker=new ExecutionWorker({store:new Store(db),config,beforeCommit:process.env.TEST_CRASH==='true'?async()=>{process.send('before-commit');await new Promise(()=>{});}:undefined});
try{for(let i=0;i<60;i++){await worker.tick();await delay(5);}}
finally{await worker.stop();await db.close();}
