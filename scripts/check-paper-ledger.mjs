import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {D} from '../src/money.js';

/**
 * Read-only Paper ledger detection (design FD1 Q1-Q3, FD1-r2 section 9 Q4-Q7). Connects with DATABASE_URL, runs every query in one
 * REPEATABLE READ READ ONLY transaction (one snapshot for the whole report, never part of SSI even when the server default is
 * serializable; default_transaction_read_only on; read-only state and isolation asserted before the first query; fixed statement and
 * lock timeouts; no parallel workers; no maintenance lock), then rolls back. Output is JSON on stdout: per-query counts, capped lists
 * of opaque Bot, signal, snapshot or lot ids, and worker heartbeat ages; never emails, names, amounts, secrets or the connection string.
 *
 * Each query runs under its own savepoint: one that passes the statement or lock timeout reports status TIMEOUT or LOCK_TIMEOUT with
 * no counts, the others still report, and the report says incomplete. A finding is data, not an error: exit 0 whenever the read-only
 * checks ran. Exit 1 when they could not run, exit 2 on a usage error or a refused session. Repair policy (D6): nobody edits SQL or
 * writes compensating rows because of a finding; the owner decides.
 *
 * Kinds: "finding" is a state the current ledger rules never produce; "exposure" predicts a failure of ledger code older than the O3
 * fix; "info" is a state the committed G1 rule handles as legitimate; "review" needs a person (Q3 timestamps are approximate).
 */
export const ID_CAP=50;
export const STATEMENT_TIMEOUT_MS=15000;
export const LOCK_TIMEOUT='5s';
// Test only: CHECK_PAPER_LEDGER_TEST_STATEMENT_TIMEOUT_MS may lower (never raise) the per-statement cap, so a test can force a timeout.
export const TEST_TIMEOUT_ENV='CHECK_PAPER_LEDGER_TEST_STATEMENT_TIMEOUT_MS';
// A QUEUED signal older than this is stuck (Q4); an execution heartbeat older than STALE_HEARTBEAT_MS no longer ticks.
export const STUCK_QUEUED_MS=300000;
export const STALE_HEARTBEAT_MS=60000;
const now='(EXTRACT(EPOCH FROM pg_catalog.now())*1000)::bigint';
const refuse=(code,message)=>Object.assign(new Error(message),{code});
const TIMEOUTS={'57014':'TIMEOUT','55P03':'LOCK_TIMEOUT'};

// Each query returns one row per occurrence with bot_id plus at most one more opaque id column.
export const QUERIES=Object.freeze([
  {name:'Q1_negative_cash',kind:'finding',detects:'Paper cash (funding plus fill journal) below zero for a Bot and broker',
    sql:`WITH k AS (SELECT user_id,broker FROM public.paper_funding UNION SELECT user_id,broker FROM public.paper_cash_journal),
      f AS (SELECT user_id,broker,SUM(cash_delta) cash FROM public.paper_funding GROUP BY 1,2),
      j AS (SELECT user_id,broker,SUM(cash_delta) moved FROM public.paper_cash_journal GROUP BY 1,2)
      SELECT k.user_id AS bot_id FROM k LEFT JOIN f USING(user_id,broker) LEFT JOIN j USING(user_id,broker)
      WHERE COALESCE(f.cash,0)+COALESCE(j.moved,0)<0`},
  {name:'Q2_funding_missed_fill',kind:'finding',idName:'snapshot_ids',
    detects:'F4 signature: a FUNDING snapshot whose position cost differs from the snapshot just before it (funding never changes position cost)',
    sql:`SELECT bot_id,snapshot_id AS id FROM (SELECT user_id AS bot_id,id AS snapshot_id,reason,position_cost,
      pg_catalog.lag(position_cost) OVER (PARTITION BY user_id,broker ORDER BY id) AS previous_cost FROM public.paper_snapshots) s
      WHERE reason='FUNDING' AND previous_cost IS NOT NULL AND previous_cost<>position_cost`},
  {name:'Q4_stuck_queued',kind:'finding',idName:'signal_ids',
    detects:'Signals of any execution mode still QUEUED more than five minutes after they arrived. stall_signature (QUEUED rows with a '+
      'missing or stale execution heartbeat) is the pre-W1 stall signature and needs a check of the worker process: a stopped worker '+
      'deletes its heartbeat row, and W1 holds keep the heartbeat fresh',
    sql:`SELECT s.user_id AS bot_id,s.id AS id,${now}-s.received_at AS age_ms FROM public.signals s
      WHERE s.status='QUEUED' AND s.received_at<${now}-${STUCK_QUEUED_MS}`},
  {name:'Q5_o3_exposed_lots',kind:'exposure',idName:'lot_ids',
    detects:'Open Paper lots whose full take needs more than 18 decimal places (exits of these failed before the O3 fix)',
    sql:`SELECT a.user_id AS bot_id,a.position_id AS id FROM public.ledger_position_allocations a
      WHERE a.execution_mode='PAPER' AND a.status='OPEN' AND a.remaining_quantity>0 AND pg_catalog.scale(pg_catalog.trim_scale(a.remaining_quantity*a.entry_price))>18`},
  {name:'Q6_lots_exceed_position',kind:'finding',
    detects:'Open Paper lots holding more than the position quantity, including lots left open on a flat or missing position',
    sql:`WITH l AS (SELECT user_id,account_id,symbol,SUM(remaining_quantity) quantity FROM public.ledger_position_allocations
        WHERE execution_mode='PAPER' AND status='OPEN' AND remaining_quantity>0 GROUP BY 1,2,3),
      p AS (SELECT user_id,account_id,symbol,quantity FROM public.ledger_positions WHERE execution_mode='PAPER')
      SELECT l.user_id AS bot_id FROM l LEFT JOIN p USING(user_id,account_id,symbol) WHERE l.quantity>COALESCE(p.quantity,0)`},
  {name:'Q6b_unlotted_quantity',kind:'info',
    detects:'Paper positions holding more than their open lots (unlotted legacy quantity; the G1 rule prices it at its average cost)',
    sql:`WITH l AS (SELECT user_id,account_id,symbol,SUM(remaining_quantity) quantity FROM public.ledger_position_allocations
        WHERE execution_mode='PAPER' AND status='OPEN' AND remaining_quantity>0 GROUP BY 1,2,3),
      p AS (SELECT user_id,account_id,symbol,quantity FROM public.ledger_positions WHERE execution_mode='PAPER')
      SELECT p.user_id AS bot_id FROM p LEFT JOIN l USING(user_id,account_id,symbol) WHERE p.quantity>COALESCE(l.quantity,0)`},
  {name:'Q7_cost_at_flat',kind:'finding',detects:'Flat Paper positions that still carry cost (full closes now remove the whole cost)',
    sql:`SELECT user_id AS bot_id FROM public.ledger_positions WHERE execution_mode='PAPER' AND quantity=0 AND cost_basis<>0`}
]);
const capped=values=>{const unique=[...new Set(values.map(String))];return {list:unique.slice(0,ID_CAP),truncated:unique.length>ID_CAP};};

/** The per-statement cap: 15 s, or a lower test-only value. Throws on an invalid value instead of ignoring it. */
export function statementTimeoutMs(env=process.env){
  const raw=env[TEST_TIMEOUT_ENV];
  if(raw===undefined||raw==='')return STATEMENT_TIMEOUT_MS;
  const value=Number(raw);
  if(!Number.isInteger(value)||value<1||value>STATEMENT_TIMEOUT_MS)throw refuse('USAGE',TEST_TIMEOUT_ENV+' must be an integer from 1 to '+STATEMENT_TIMEOUT_MS);
  return value;
}

/** Throws CHECK_PAPER_LEDGER_NOT_READ_ONLY unless the client's current transaction is read only and REPEATABLE READ. */
export async function assertReadOnly(client){
  const state=(await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only;
  if(state!=='on')throw refuse('CHECK_PAPER_LEDGER_NOT_READ_ONLY','The session is not read only; nothing was checked');
  const isolation=(await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
  if(isolation!=='repeatable read')throw refuse('CHECK_PAPER_LEDGER_NOT_READ_ONLY','The session is not one REPEATABLE READ snapshot; nothing was checked');
}

/**
 * Runs fn(client) inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY with the fixed timeouts and no parallel workers, after
 * asserting the read-only state and the isolation; always rolls back.
 */
export async function readOnlySession(client,fn,{statementTimeout=STATEMENT_TIMEOUT_MS}={}){
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query('SET LOCAL default_transaction_read_only=on');
    await client.query(`SELECT pg_catalog.set_config('statement_timeout',$1,true),pg_catalog.set_config('lock_timeout',$2,true),
      pg_catalog.set_config('max_parallel_workers_per_gather','0',true)`,[statementTimeout+'ms',LOCK_TIMEOUT]);
    await assertReadOnly(client);
    return await fn(client);
  }finally{await client.query('ROLLBACK').catch(()=>{});}
}

// One savepoint per check: a statement or lock timeout ends only that check, which then reports its status and no counts.
async function guarded(client,fn){
  await client.query('SAVEPOINT check_paper_ledger');
  try{
    const value=await fn();
    await client.query('RELEASE SAVEPOINT check_paper_ledger');
    return {status:'OK',value};
  }catch(error){
    if(!TIMEOUTS[error.code])throw error;
    await client.query('ROLLBACK TO SAVEPOINT check_paper_ledger');
    return {status:TIMEOUTS[error.code]};
  }
}

// Q3: run baselines (initial_capital, {broker: cash}) compared with funding plus journal cash at started_at. Timestamps come from
// different processes, so a difference is a lead for review, not proof.
async function runBaselines(client){
  const sessions=(await client.query('SELECT user_id,started_at,initial_capital FROM public.bot_sessions WHERE initial_capital IS NOT NULL ORDER BY user_id')).rows;
  const differs=[];
  for(const session of sessions){
    let baseline;
    try{baseline=JSON.parse(session.initial_capital);}catch{baseline=null;}
    if(!baseline||typeof baseline!=='object'||Array.isArray(baseline)){differs.push(session.user_id);continue;}
    const rows=(await client.query(`SELECT broker,SUM(cash_delta)::text AS cash FROM (
      SELECT broker,cash_delta FROM public.paper_funding WHERE user_id=$1 AND at<=$2
      UNION ALL SELECT broker,cash_delta FROM public.paper_cash_journal WHERE user_id=$1 AND at<=$2) x GROUP BY broker`,[session.user_id,session.started_at])).rows;
    const cash=Object.fromEntries(rows.map(row=>[row.broker,row.cash]));
    let same=true;
    for(const broker of new Set([...Object.keys(baseline),...Object.keys(cash)])){
      try{if(!D(baseline[broker]??0).eq(D(cash[broker]??0)))same=false;}catch{same=false;}
    }
    if(!same)differs.push(session.user_id);
  }
  const ids=capped(sessions.map(row=>row.user_id)),diff=capped(differs);
  return {count:sessions.length,bot_ids:ids.list,truncated:ids.truncated,differs_count:differs.length,differs_bot_ids:diff.list,differs_truncated:diff.truncated};
}

/** Every check, inside the caller's read-only transaction. */
export async function inspectPaperLedger(client){
  await assertReadOnly(client);
  const queries={};
  for(const query of QUERIES){
    const head={kind:query.kind,detects:query.detects};
    const result=await guarded(client,async()=>(await client.query(query.sql)).rows);
    if(result.status!=='OK'){queries[query.name]={...head,status:result.status};continue;}
    const rows=result.value,bots=capped(rows.map(row=>row.bot_id)),entry={...head,status:'OK',count:rows.length,bot_ids:bots.list,truncated:bots.truncated};
    if(query.idName){const ids=capped(rows.map(row=>row.id));entry[query.idName]=ids.list;entry.truncated=bots.truncated||ids.truncated;}
    if(query.name==='Q4_stuck_queued')entry.oldest_age_ms=rows.reduce((oldest,row)=>Math.max(oldest,Number(row.age_ms)),0)||null;
    queries[query.name]=entry;
  }
  const baselines=await guarded(client,()=>runBaselines(client));
  queries.Q3_run_baselines={kind:'review',detects:'Run baselines (initial_capital) and the ones that differ from funding plus fill cash at the run start (approximate)',
    status:baselines.status,...(baselines.value??{})};
  const beats=await guarded(client,async()=>(await client.query(`SELECT role,${now}-last_tick AS age_ms FROM public.worker_heartbeats ORDER BY role,last_tick DESC`)).rows);
  let heartbeats={status:beats.status},stall=null;
  if(beats.status==='OK'){
    heartbeats={};
    for(const beat of beats.value)(heartbeats[beat.role]??=[]).push(Number(beat.age_ms));
    const newestExecution=heartbeats.execution?.[0]??null;
    if(queries.Q4_stuck_queued.status==='OK')stall=queries.Q4_stuck_queued.count>0&&(newestExecution===null||newestExecution>STALE_HEARTBEAT_MS);
  }
  const version=(await client.query("SELECT pg_catalog.current_setting('server_version_num')::int AS version")).rows[0].version;
  const counted=Object.values(queries).filter(item=>item.status==='OK');
  const total=kind=>counted.filter(item=>item.kind===kind).reduce((sum,item)=>sum+item.count,0);
  const incomplete=Object.values(queries).some(item=>item.status!=='OK')||beats.status!=='OK';
  return {tool:'check-paper-ledger',version:2,read_only:true,isolation:'repeatable read',checked_at:new Date().toISOString(),server_version_num:version,
    id_cap:ID_CAP,incomplete,queries,heartbeats,stall_signature:stall,
    summary:{findings:total('finding'),exposure:total('exposure'),info:total('info'),review_differs:queries.Q3_run_baselines.differs_count??null}};
}

/** --self-check: proves the session refuses a write (25006) without running any check. */
export async function selfCheck(client,options){
  return readOnlySession(client,async()=>{
    try{await client.query('CREATE TEMP TABLE check_paper_ledger_probe(x int)');}
    catch(error){if(error.code==='25006')return {tool:'check-paper-ledger',self_check:'ok',read_only:true};throw error;}
    throw refuse('CHECK_PAPER_LEDGER_NOT_READ_ONLY','A write succeeded inside the read-only session; nothing was checked');
  },options);
}

async function main(args){
  const usage=message=>{console.error(JSON.stringify({error:'USAGE',message}));return 2;};
  if(args.length>1||(args.length===1&&args[0]!=='--self-check'))return usage('node scripts/check-paper-ledger.mjs [--self-check]');
  if(!process.env.DATABASE_URL)return usage('DATABASE_URL is required');
  let statementTimeout;
  try{statementTimeout=statementTimeoutMs();}catch(error){return usage(error.message);}
  // Everything from parsing DATABASE_URL on is inside the try, so a malformed value, like any failure, prints only a code.
  let client;
  try{
    client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,application_name:'check-paper-ledger'});
    client.on('error',()=>{});
    await client.connect();
    const report=args[0]==='--self-check'?await selfCheck(client,{statementTimeout}):await readOnlySession(client,inspectPaperLedger,{statementTimeout});
    console.log(JSON.stringify(report,null,2));
    return 0;
  }catch(error){
    const refused=error?.code==='CHECK_PAPER_LEDGER_NOT_READ_ONLY';
    console.error(JSON.stringify({error:refused?error.code:'CHECK_PAPER_LEDGER_FAILED',code:typeof error?.code==='string'?error.code:null,
      message:refused?error.message:'The checks could not run'}));
    return refused?2:1;
  }finally{await client?.end().catch(()=>{});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2));
