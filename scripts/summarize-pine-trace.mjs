import {PostgresDatabase} from '../src/postgres/db.js';

const [captureId]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(captureId||''))throw new Error('Usage: summarize-pine-trace.mjs CAPTURE_ID');
const db=new PostgresDatabase();
try {
  const session=await db.prepare('SELECT c.capture_id,c.deployment_id,c.received,c.duplicates,c.rejected,c.last_error,d.snapshot FROM pine_capture_sessions c JOIN pine_deployments d USING(deployment_id) WHERE c.capture_id=?').get(captureId);
  if(!session)throw new Error('Capture not found');
  const market=session.snapshot.market;
  const traces=await db.prepare("SELECT e.payload,e.received_at,e.market_present_at_intake,e.market_checked_at,e.market_hash_at_intake,b.bar,b.content_hash,b.provenance FROM pine_capture_events e LEFT JOIN pine_market_bars b ON b.broker=? AND b.symbol=? AND b.timeframe=? AND b.bar_time=(e.payload->>'bar_time')::bigint WHERE e.capture_id=? AND e.payload->>'schema_version'='bridge-native-trace-v1' ORDER BY (e.payload->>'bar_time')::bigint").all(market.broker,market.symbol,market.timeframe,captureId);
  const execution=await db.prepare('SELECT count(*) AS n FROM pine_bridge_events WHERE deployment_id=?').get(session.deployment_id);
  let missingMarket=0,pendingMarket=0,closeMismatch=0,gaps=0,buy=0,exit=0,audited=0,readyAtIntake=0,missingAtIntake=0,retrievedBeforeReceipt=0;
  const interval=Number(market.timeframe)*60000;
  for(let i=0;i<traces.length;i++){
    const row=traces[i],trace=row.payload;
    if(trace.native_buy)buy++;
    if(trace.native_exit)exit++;
    if(row.market_present_at_intake!==null){audited++;if(row.market_present_at_intake)readyAtIntake++;else missingAtIntake++;}
    if(row.market_present_at_intake&&row.content_hash===row.market_hash_at_intake&&Number(row.provenance?.retrieved_at)<row.received_at)retrievedBeforeReceipt++;
    if(!row.bar){if(Date.now()-trace.bar_time<=6*60000)pendingMarket++;else missingMarket++;}
    else if(Number(row.bar.close)!==trace.close)closeMismatch++;
    if(i&&Number.isSafeInteger(interval)&&interval>0&&trace.bar_time-traces[i-1].payload.bar_time!==interval)gaps++;
  }
  console.log(JSON.stringify({capture_id:captureId,deployment_id:session.deployment_id,market:{broker:market.broker,symbol:market.symbol,timeframe:market.timeframe},trace_bars:traces.length,first_bar:traces[0]?.payload.bar_time??null,last_bar:traces.at(-1)?.payload.bar_time??null,native_buy_bars:buy,native_exit_bars:exit,trace_gaps:gaps,market_arrival:{audited,ready_at_intake:readyAtIntake,missing_at_intake:missingAtIntake,retrieved_before_receipt:retrievedBeforeReceipt},pending_market_ingest:pendingMarket,missing_frozen_market_bars:missingMarket,close_mismatches:closeMismatch,execution_events:Number(execution.n),capture:{received:session.received,duplicates:session.duplicates,rejected:session.rejected,last_error:session.last_error},quant_gate:'PENDING_SAMPLE_AND_REPAINT_EVIDENCE'}));
} finally {await db.close();}
