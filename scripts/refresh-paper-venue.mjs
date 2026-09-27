import {PostgresDatabase} from '../src/postgres/db.js';
import {Store} from '../src/postgres/store.js';
import {runVenueRefreshJob} from '../src/postgres/venue-refresh-job.js';

const options={durationSeconds:0,intervalSeconds:20};
for(const item of process.argv.slice(2)){
  const match=item.match(/^--(duration|interval)-seconds=(\d+)$/);
  if(!match)throw new Error('Use --duration-seconds=0..600 and --interval-seconds=15..30');
  options[match[1]+'Seconds']=Number(match[2]);
}
if(process.env.PAPER_TRADING!=='true'||process.env.PINE_BRIDGE_ENV!=='staging')throw new Error('Venue producer requires explicit Paper staging');
const abort=new AbortController();
process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
const db=new PostgresDatabase();
try{
  await db.runtimeLock();await db.verifySchema();
  const result=await runVenueRefreshJob({store:new Store(db),...options,signal:abort.signal,log:record=>console.log(JSON.stringify(record))});
  if(result.failures)process.exitCode=1;
}finally{await db.close();}
