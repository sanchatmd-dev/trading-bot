import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs/promises';

// int8 is used for timestamps and identifiers only. NUMERIC keeps pg's string parser.
const parseInteger=value=>{const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('Integer exceeds JavaScript safe range');return number;};
const types={getTypeParser:(oid,format)=>oid===20?parseInteger:pg.types.getTypeParser(oid,format)};

export class PostgresDatabase {
  constructor({connectionString=process.env.DATABASE_URL,max=Number(process.env.PG_POOL_SIZE||5)}={}){
    if(!connectionString)throw new Error('DATABASE_URL is required');
    if(!Number.isInteger(max)||max<1||max>50)throw new Error('Invalid PG_POOL_SIZE');
    this.pool=new pg.Pool({connectionString,max,types,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
      statement_timeout:15000,idle_in_transaction_session_timeout:20000,application_name:'robot-trade-phase2'});
    this.pool.on('error',()=>console.error('PostgreSQL idle connection failed'));
    // Independent, bounded pool keeps rate attempts durable when the main request rolls back.
    this.limitPool=new pg.Pool({connectionString,max:2,types,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:5000,application_name:'robot-trade-limits'});
    this.limitPool.on('error',()=>console.error('PostgreSQL rate-limit connection failed'));
    this.context=new AsyncLocalStorage();
  }
  get isTransaction(){return !!this.context.getStore();}
  async query(sql,params=[]){
    const state=this.context.getStore();
    if(!state)return this.pool.query(sql,params);
    const result=state.tail.then(()=>state.client.query(sql,params));state.tail=result.catch(()=>{});return result;
  }
  async consumeLimit(key,limit,window,now=Date.now()){
    const result=await this.limitPool.query(`INSERT INTO security_limits(key_hash,attempts,expires_at)
      SELECT $1,1,$2 WHERE EXISTS(SELECT 1 FROM security_limits WHERE key_hash=$1) OR (SELECT count(*) FROM security_limits)<10000
      ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN security_limits.expires_at<=$3 THEN 1 ELSE security_limits.attempts+1 END,
      expires_at=CASE WHEN security_limits.expires_at<=$3 THEN $2 ELSE security_limits.expires_at END RETURNING attempts`,[key,now+window,now]);
    return !!result.rows[0]&&result.rows[0].attempts<=limit;
  }
  async touchSession(tokenHash,now,idle){
    const result=await this.limitPool.query('UPDATE sessions SET last_seen=$1 WHERE token_hash=$2 AND expires_at>$1 AND last_seen>$3',[now,tokenHash,now-idle]);
    return result.rowCount===1;
  }
  prepare(sql){
    // This compatibility surface is restricted to application-owned SQL, never user SQL.
    let index=0;
    const translated=sql.replace(/'(?:''|[^'])*'|\?/g,token=>token==='?'?'$'+(++index):token);
    return {
      get:async(...params)=>(await this.query(translated,params)).rows[0],
      all:async(...params)=>(await this.query(translated,params)).rows,
      run:async(...params)=>{const result=await this.query(translated,params);return {changes:result.rowCount};}
    };
  }
  async exec(sql){
    if(/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim()))throw new Error('Use db.transaction with a pinned connection');
    return this.query(sql);
  }
  async transaction(fn,{isolation='READ COMMITTED'}={}){
    if(this.isTransaction)return fn();
    if(!['READ COMMITTED','SERIALIZABLE','REPEATABLE READ'].includes(isolation))throw new Error('Invalid transaction isolation');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL '+isolation);
      const result=await this.context.run({client,tail:Promise.resolve()},fn);
      await client.query('COMMIT');
      return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }
  async lock(key){
    if(!this.isTransaction)throw new Error('Transaction required for account lock');
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  }
  async runtimeLock(){
    if(this.runtimeClient)return;
    if(this.pool.options.max<2)throw new Error('Runtime PG_POOL_SIZE must be at least 2 (one connection holds the maintenance lock)');
    const client=await this.pool.connect();
    const {rows}=await client.query("SELECT pg_try_advisory_lock_shared(hashtextextended('robot:maintenance',0)) ok");
    if(!rows[0].ok){client.release();throw new Error('Database maintenance in progress');}
    this.runtimeClient=client;
    // A lost runtime lock must stop this process; it must not continue against a
    // database that an offline migration/rotation could now exclusively own.
    client.on('error',()=>{console.error('Runtime database lock lost');process.exit(1);});
  }
  async maintenanceLock(){
    if(!this.isTransaction)throw new Error('Maintenance requires a transaction');
    const {rows}=await this.query("SELECT pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0)) ok");
    if(!rows[0].ok)throw new Error('Stop every PostgreSQL API and worker before maintenance');
  }
  async migrate(){
    await this.transaction(async()=>{
      await this.lock('robot:schema');
      const exists=(await this.query("SELECT to_regclass('public.schema_version') present")).rows[0].present;
      if(exists){const row=(await this.query('SELECT version FROM schema_version')).rows[0];if(row?.version!==11)throw new Error('Unsupported PostgreSQL schema');return;}
      const tables=(await this.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
      if(tables)throw new Error('Refusing to initialize a nonempty database without a schema version');
      await this.query(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
    });
  }
  async verifySchema(){
    const exists=(await this.query("SELECT to_regclass('public.schema_version') present")).rows[0].present;
    if(!exists||(await this.query('SELECT version FROM schema_version')).rows[0]?.version!==11)throw new Error('Initialize/import schema 11 offline before starting PostgreSQL services');
  }
  async close(){
    if(this.runtimeClient){await this.runtimeClient.query("SELECT pg_advisory_unlock_shared(hashtextextended('robot:maintenance',0))");this.runtimeClient.release();this.runtimeClient=null;}
    await Promise.all([this.pool.end(),this.limitPool.end()]);
  }
}
export const transaction=(store,fn)=>store.db.transaction(fn);
