import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs/promises';
import {ensurePaperLedgerFence,PAPER_LEDGER_FENCE_REPLICATION_ROLE} from './paper-ledger-fence.js';

// int8 is used for timestamps and identifiers only. NUMERIC keeps pg's string parser.
const parseInteger=value=>{const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('Integer exceeds JavaScript safe range');return number;};
const types={getTypeParser:(oid,format)=>oid===20?parseInteger:pg.types.getTypeParser(oid,format)};

export class PostgresDatabase {
  #runtimeOrigin=false;
  // Checkout-only enforcement does not prevent privileged changes within an existing lease.
  async #checkout(pool){
    const client=await pool.connect();let released=false,failure=null,rejectFailure;
    const failed=new Promise((resolve,reject)=>{rejectFailure=reject;});failed.catch(()=>{});
    const release=error=>{if(released)return;if(error&&!failure)failure=error;released=true;client.removeListener('error',onError);client.release(error);};
    const onError=error=>{if(!failure)failure=error;rejectFailure(failure);release(failure);};
    client.once('error',onError);
    const query=(...args)=>Promise.race([Promise.resolve().then(()=>{if(failure)throw failure;return client.query(...args);}),failed]).catch(error=>{
      // A backend FATAL/PANIC can reject its query before the later socket error event.
      if(error?.severity==='FATAL'||error?.severity==='PANIC'){
        if(!failure)failure=error;rejectFailure(failure);release(failure);
      }
      throw failure||error;
    });
    const lease={client,query,release,transfer:handler=>{if(failure||released)throw failure||new Error('Database lease is already released');client.on('error',handler);client.removeListener('error',onError);released=true;}};
    try{
      if(this.#runtimeOrigin){
        const result=await query("SELECT pg_catalog.current_setting('session_replication_role') AS role");
        if(result?.rows?.length!==1||result.rows[0]?.role!=='origin')
          throw Object.assign(new Error('session_replication_role must be origin for the Paper ledger fence'),{code:PAPER_LEDGER_FENCE_REPLICATION_ROLE});
      }
      return lease;
    }catch(error){release(error);throw error;}
  }
  async #poolQuery(pool,sql,params){
    if(!this.#runtimeOrigin)return pool.query(sql,params);
    const lease=await this.#checkout(pool);
    try{return await lease.query(sql,params);}catch(error){lease.release(error);throw error;}finally{lease.release();}
  }
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
    if(!state)return this.#poolQuery(this.pool,sql,params);
    if(state.closed)throw Object.assign(new Error('Transaction is closed'),{code:'25000'});
    const result=state.tail.then(()=>{
      // A queued branch can outlive the transaction that owns its client.
      if(state.closed)throw Object.assign(new Error('Transaction is closed'),{code:'25000'});
      return state.query(sql,params);
    });state.tail=result.catch(()=>{});return result;
  }
  async consumeLimit(key,limit,window,now=Date.now()){
    const result=await this.#poolQuery(this.limitPool,`INSERT INTO security_limits(key_hash,attempts,expires_at)
      SELECT $1,1,$2 WHERE EXISTS(SELECT 1 FROM security_limits WHERE key_hash=$1) OR (SELECT count(*) FROM security_limits)<10000
      ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN security_limits.expires_at<=$3 THEN 1 ELSE security_limits.attempts+1 END,
      expires_at=CASE WHEN security_limits.expires_at<=$3 THEN $2 ELSE security_limits.expires_at END RETURNING attempts`,[key,now+window,now]);
    return !!result.rows[0]&&result.rows[0].attempts<=limit;
  }
  async touchSession(tokenHash,now,idle){
    const result=await this.#poolQuery(this.limitPool,'UPDATE sessions SET last_seen=$1 WHERE token_hash=$2 AND expires_at>$1 AND last_seen>$3',[now,tokenHash,now-idle]);
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
    const parent=this.context.getStore();
    if(parent){if(parent.closed)throw Object.assign(new Error('Transaction is closed'),{code:'25000'});return fn();}
    if(!['READ COMMITTED','SERIALIZABLE','REPEATABLE READ'].includes(isolation))throw new Error('Invalid transaction isolation');
    const lease=this.#runtimeOrigin?await this.#checkout(this.pool):null;
    const client=lease?lease.client:await this.pool.connect();
    const query=(...args)=>lease?lease.query(...args):client.query(...args);
    const state={client,query,tail:Promise.resolve(),closed:false};
    try{
      await query('BEGIN ISOLATION LEVEL '+isolation);
      let result;
      // Close before COMMIT/ROLLBACK so queued branches cannot run in autocommit.
      try{result=await this.context.run(state,fn);}finally{state.closed=true;}
      await query('COMMIT');
      return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{state.closed=true;if(lease)lease.release();else client.release();}
  }
  async lock(key){
    if(!this.isTransaction)throw new Error('Transaction required for account lock');
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  }
  async runtimeLock(){
    this.#runtimeOrigin=true;
    if(this.runtimeClient)return;
    if(this.pool.options.max<2)throw new Error('Runtime PG_POOL_SIZE must be at least 2 (one connection holds the maintenance lock)');
    const lease=await this.#checkout(this.pool),client=lease.client;
    try{
      const {rows}=await lease.query("SELECT pg_try_advisory_lock_shared(hashtextextended('robot:maintenance',0)) ok");
      if(!rows[0].ok)throw new Error('Database maintenance in progress');
      // Hold this exact client until close(); losing the runtime lock remains fail-stop.
      lease.transfer(()=>{console.error('Runtime database lock lost');process.exit(1);});
      this.runtimeClient=client;
    }catch(error){lease.release(error);throw error;}
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
      if(exists){
        let row=(await this.query('SELECT version FROM schema_version')).rows[0];
        if(row?.version===11){
          await this.query(`
            CREATE TABLE IF NOT EXISTS ledger_position_allocations(
              position_id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              account_id TEXT NOT NULL,
              execution_mode TEXT NOT NULL,
              broker TEXT NOT NULL,
              symbol TEXT NOT NULL,
              entry_signal_id BIGINT NOT NULL REFERENCES signals(id),
              entry_trade_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'OPEN',
              filled_quantity NUMERIC(38,18) NOT NULL,
              remaining_quantity NUMERIC(38,18) NOT NULL,
              reserved_quantity NUMERIC(38,18) NOT NULL DEFAULT 0,
              entry_price NUMERIC(38,18) NOT NULL,
              stop_loss NUMERIC(38,18),
              take_profit NUMERIC(38,18),
              opened_at BIGINT NOT NULL,
              closed_at BIGINT,
              updated_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_allocations_open ON ledger_position_allocations(user_id,account_id,execution_mode,symbol,status);
            UPDATE schema_version SET version=12;
          `);
          row = { version: 12 };
        }
        if(row?.version===12){
          await this.query(`
            CREATE TABLE bot_sessions(
              user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
              state         TEXT NOT NULL DEFAULT 'SETUP'
                            CHECK(state IN ('SETUP','RUNNING','PAUSED','STOPPED')),
              run_id        TEXT,
              locked_policy TEXT,
              initial_capital TEXT,
              started_at    BIGINT,
              stopped_at    BIGINT,
              updated_at    BIGINT NOT NULL
            );
            CREATE TABLE bot_session_archive(
              run_id          TEXT PRIMARY KEY,
              user_id         TEXT NOT NULL REFERENCES users(id),
              locked_policy   TEXT NOT NULL,
              initial_capital TEXT NOT NULL,
              started_at      BIGINT NOT NULL,
              stopped_at      BIGINT NOT NULL,
              archived_at     BIGINT NOT NULL
            );
            CREATE INDEX idx_session_archive_user ON bot_session_archive(user_id, archived_at DESC);
            UPDATE schema_version SET version=14;
          `);
          row = { version: 14 };
        }
        if(row.version===14){
          await this.query(`
            CREATE TABLE IF NOT EXISTS quant_research_runs(
              run_id          TEXT PRIMARY KEY,
              user_id         TEXT NOT NULL REFERENCES users(id),
              bot_id          TEXT NOT NULL REFERENCES users(id),
              indicators_config TEXT NOT NULL,
              optimal_results TEXT,
              metrics         TEXT,
              status          TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
              created_at      BIGINT NOT NULL,
              updated_at      BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_quant_runs_bot ON quant_research_runs(user_id, bot_id, created_at DESC);
          `);
        }
        if(row?.version!==14)throw new Error('Unsupported PostgreSQL schema');
        // The F4 fence table has no schema version of its own: every successful path ends by ensuring it in this transaction.
        await ensurePaperLedgerFence(this);
        return;
      }
      const tables=(await this.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
      if(tables)throw new Error('Refusing to initialize a nonempty database without a schema version');
      await this.query(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
      await ensurePaperLedgerFence(this);
    });
  }
  async verifySchema(){
    const exists=(await this.query("SELECT to_regclass('public.schema_version') present")).rows[0].present;
    if(!exists||(await this.query('SELECT version FROM schema_version')).rows[0]?.version!==14)throw new Error('Initialize/import schema 14 offline before starting PostgreSQL services');
  }
  async close(){
    if(this.runtimeClient){await this.runtimeClient.query("SELECT pg_advisory_unlock_shared(hashtextextended('robot:maintenance',0))");this.runtimeClient.release();this.runtimeClient=null;}
    await Promise.all([this.pool.end(),this.limitPool.end()]);
  }
}
export const transaction=(store,fn)=>store.db.transaction(fn);
