import {coverageReadBudgets} from '../portfolio/qr2-coverage-limits.js';
import {readCoverageSnapshot} from './qr2-coverage-reader.js';
import {Qr2Error,QR2_DAY_MS} from '../portfolio/qr2-constants.js';
import {validateBoundaryRecord} from '../portfolio/qr2-boundaries.js';
import {resolveRange,utcMidnight} from '../portfolio/qr2-periods.js';
import {readQr2SnapshotForOwner,coverageAccount,QR2_READ_LIMITS,QR2_AUDIT_EVENTS,PENDING_STATUSES,QR2_LEDGER_COUNT_SQL,assertGridMidnights} from './qr2-reader.js';

export const QR2_OWNER_LIMITS=Object.freeze({...QR2_READ_LIMITS,accounts:20,bots:5,declarations:1000});
export const QR2_OWNER_BROKERS=Object.freeze({USDT:['binance-global'],THB:['binance-th','innovestx','settrade']});
const fail=(code,detail)=>{throw Object.assign(new Qr2Error(code),detail?{detail}:{});};
export function ownerReadLimits(given={}){
  if(!given||typeof given!=='object'||Array.isArray(given))fail('QR2_INPUT_INVALID');
  for(const [key,value] of Object.entries(given))if(!Object.hasOwn(QR2_OWNER_LIMITS,key)||!Number.isSafeInteger(value)||value<1||value>QR2_OWNER_LIMITS[key])fail('QR2_INPUT_INVALID');
  return {...QR2_OWNER_LIMITS,...given};
}
const check=(counts,limits)=>{for(const key of Object.keys(limits))if((counts[key]??0)>limits[key])fail('QR2_RANGE_ADMISSION_REFUSED',{limit:key,value:counts[key],max:limits[key]});};
const number=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('QR2_REPORT_FAILED');return n;};

// Every declaration, membership row, discovery and pre-count belongs to this one read-only snapshot.
// Owner ledger_rows additionally counts current positions and the positions materialized by exposure().
export async function readQr2OwnerSnapshot(store,args){
  const {ownerId,currency,from,to,requestTime,boundaries}=args;
  const limits=ownerReadLimits(args.limits);
  const budgets=coverageReadBudgets(args.coverageBudgets);
  const checkedBoundaries=validateBoundaryRecord(boundaries);
  if(typeof ownerId!=='string'||!ownerId||!Object.hasOwn(QR2_OWNER_BROKERS,currency))fail('QR2_INPUT_INVALID');
  if(store.db.isTransaction)fail('QR2_READER_SNAPSHOT_REQUIRED');
  return store.db.transaction(async()=>{
    const q=async(sql,values=[])=>(await store.db.query(sql,values)).rows;
    if((await q('SHOW transaction_isolation'))[0].transaction_isolation!=='repeatable read')fail('QR2_READER_SNAPSHOT_REQUIRED');
    await store.db.query('SET TRANSACTION READ ONLY');
    if((await q('SHOW transaction_read_only'))[0].transaction_read_only!=='on')fail('QR2_READER_SNAPSHOT_REQUIRED');
    const owner=(await q('SELECT id,parent_user_id,created_at FROM public.users WHERE id=$1',[ownerId]))[0];
    if(!owner||owner.parent_user_id)fail('QR2_NOT_OWNER');
    const ownerBots=await q('SELECT id,created_at FROM public.users WHERE id=$1 OR parent_user_id=$1 ORDER BY id LIMIT $2',[ownerId,limits.bots+1]);
    const counts={ledger_rows:0,grid_instants:0,audit_rows:0,pending_orders:0,accounts:0,bots:ownerBots.length,declarations:0};
    check(counts,limits);
    counts.declarations=number((await q('SELECT count(*) AS n FROM public.paper_capital_models WHERE owner_id=$1 AND currency=$2',[ownerId,currency]))[0].n);
    check(counts,limits);
    const declarations=(await q('SELECT version,capital_model,bot_set,effective_from,currency FROM public.paper_capital_models WHERE owner_id=$1 AND currency=$2 ORDER BY version',[ownerId,currency]))
      .map(d=>({...d,version:number(d.version),effective_from:number(d.effective_from)}));
    const range=resolveRange({from,to,requestTime,coverageStart:Number(owner.created_at)});
    const admitted=[];
    for(const bot of ownerBots){
      if(Number(bot.created_at)>=Math.min(to,requestTime))continue;
      for(const broker of QR2_OWNER_BROKERS[currency]){
        const values=[bot.id,broker];
        const ledger=(await q(QR2_LEDGER_COUNT_SQL,values))[0];
        const positions=number((await q('SELECT count(*) AS n FROM public.ledger_positions WHERE user_id=$1 AND broker=$2',values))[0].n);
        const total=Object.values(ledger).reduce((n,v)=>n+number(v),0);
        if(total+positions===0)continue; // Pending-only rows do not create ledger history.
        counts.accounts++;counts.ledger_rows+=total+positions;
        // exposure() selects by account_id, not broker: count its exact separate materialization, even corrupt broker metadata.
        const exposurePositions=number((await q("SELECT count(*) AS n FROM public.ledger_positions WHERE user_id=$1 AND account_id=$2 AND execution_mode='PAPER' AND quantity>0",[bot.id,broker+':primary']))[0].n);
        counts.ledger_rows+=exposurePositions;
        const audit=number((await q('SELECT count(*) AS n FROM public.audit WHERE user_id=$1 AND event IN ($2,$3)',[bot.id,...QR2_AUDIT_EVENTS]))[0].n);
        const pending=number((await q(`SELECT count(*) AS n FROM public.signals WHERE user_id=$1 AND account_id=$2 AND execution_mode='PAPER' AND status IN (${PENDING_STATUSES.map((_,i)=>'$'+(i+3)).join(',')})`,[bot.id,broker+':primary',...PENDING_STATUSES]))[0].n);
        counts.audit_rows+=audit;counts.pending_orders+=pending;
        const memberRange=resolveRange({from,to,requestTime,coverageStart:Number(bot.created_at)});
        let grid=0;
        if(memberRange.resolved){
          const {from:start,to:end}=memberRange.resolved;
          assertGridMidnights({from:start,to:end,limit:limits.grid_instants});
          grid=number((await q(`SELECT count(*) AS n FROM (
            SELECT $3::bigint AS instant UNION SELECT $4::bigint
            UNION SELECT generate_series($5::bigint,$4::bigint-1,$6::bigint)
            UNION SELECT f.received_at FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 AND s.broker=$2 AND f.received_at >= $3 AND f.received_at < $4
            UNION SELECT at FROM public.paper_funding WHERE user_id=$1 AND broker=$2 AND kind='CONFIGURATION' AND at >= $3 AND at < $4
          ) grid`,[bot.id,broker,start,end,utcMidnight(start)+QR2_DAY_MS,QR2_DAY_MS]))[0].n);
        }
        counts.grid_instants+=grid;check(counts,limits);
        admitted.push({botId:bot.id,broker,total,positions,audit,pending,grid,range:memberRange});
      }
    }
    // No history, audit details, pending details, exposure or price probe occurs before ALL members pass admission.
    const coverage_context={accounts:admitted.map(m=>coverageAccount(m.botId,m.broker,m.range)),budgets};
    const coverage=await readCoverageSnapshot({transaction:store.db,...coverage_context});
    const accounts=[];
    const accountLimits=Object.fromEntries(Object.keys(QR2_READ_LIMITS).map(k=>[k,limits[k]]));
    for(const member of admitted){
      const read=await readQr2SnapshotForOwner(store,{ownerId,botId:member.botId,broker:member.broker,from,to,requestTime,boundaries:checkedBoundaries,limits:accountLimits});
      const s=read.snapshot;
      if(s.counts.total!==member.total||s.positions.length!==member.positions||s.auditRows.length!==member.audit||s.pending.length!==member.pending||s.market.instants!==member.grid)fail('QR2_REPORT_FAILED');
      if(JSON.stringify(s.range)!==JSON.stringify(member.range))fail('QR2_REPORT_FAILED');
      const binding=coverage.bindings.find(b=>b.bot_id===member.botId&&b.broker===member.broker);
      if(!binding)fail('QR2_REPORT_FAILED');
      s.coverage_window_id=binding.window_id;
      accounts.push(read);
    }
    return {snapshot:{kind:'owner',coverage,currency,ownerBots:ownerBots.map(b=>({bot_id:b.id,created_at:Number(b.created_at)})),declarations,accounts,counts,range},
      input:{kind:'owner',ownerId,currency,from,to,requestTime,limits,coverage_context}};
  },{isolation:'REPEATABLE READ'});
}
