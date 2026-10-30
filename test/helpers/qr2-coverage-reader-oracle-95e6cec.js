import {planCoverage,buildCoverageSnapshot,buildDegradedCoverageSnapshot,admitCoverageRows,coverageRowCapacity,coverageError,COVERAGE_DEGRADABLE_LIMITS} from '../../src/portfolio/qr2-coverage-snapshot.js';
import {Qr2Error} from '../../src/portfolio/qr2-constants.js';

export const COVERAGE_SQL=Object.freeze({
  ISOLATION:'SHOW transaction_isolation',
  READ_ONLY:'SHOW transaction_read_only',
  PROBE:"SELECT to_regclass('public.pine_market_bars')::text AS name",
  ROWS:'SELECT bar_time::text AS bar_time FROM public.pine_market_bars WHERE broker=$1 AND symbol=$2 AND timeframe=$3 AND bar_time>$4::bigint AND bar_time<=$5::bigint ORDER BY public.pine_market_bars.bar_time LIMIT $6'
});
const failed=()=>{throw coverageError('QR2_REPORT_FAILED');};
export function decodeCoverageTimestamp(text){
  if(typeof text!=='string'||text.length>16||!/^(0|[1-9][0-9]*)$/.test(text))failed();
  const value=BigInt(text);if(value>BigInt(Number.MAX_SAFE_INTEGER))failed();
  return Number(value);
}
function rowsOf(result,limit){
  if(!result||!Array.isArray(result.rows))failed();
  // A driver result over its own LIMIT is a corrupt result, not a request range: 503. Only the timestamp sentinel below is a range refusal.
  if(result.rows.length>limit)failed();
  return result.rows;
}
/** Requires a verified caller-owned transaction; never starts a transaction, retries or publishes partial success.
 * Pass schedule: one strict union decode here; one union validation and per-window derivation in construction.
 * A caller may perform at most one independent final registry validation for this invocation.
 */
export async function readCoverageSnapshot(args){
  try{return await readCoverageSnapshotUnchecked(args);}
  catch(error){
    // Reader path only: a range over a read limit is a request refusal (contract 10, 422 QR2_RANGE_ADMISSION_REFUSED with the limit). Every other
    // error keeps its plain-Error form and answers 503. The worker path never calls this function and keeps its own mapping (Stage 3B).
    if(error?.code==='QR2_RANGE_ADMISSION_REFUSED'&&!(error instanceof Qr2Error))throw Object.assign(new Qr2Error('QR2_RANGE_ADMISSION_REFUSED'),error.detail!==undefined?{detail:error.detail}:{});
    throw error;
  }
}
// Both transaction checks. A degraded registry is returned only after they pass, so a broken transaction never yields a 200 with degraded coverage.
async function verifyTransaction(transaction){
  const isolation=rowsOf(await transaction.query(COVERAGE_SQL.ISOLATION),1);
  if(isolation.length!==1||!['repeatable read','serializable'].includes(isolation[0]?.transaction_isolation))failed();
  const readOnly=rowsOf(await transaction.query(COVERAGE_SQL.READ_ONLY),1);
  if(readOnly.length!==1||readOnly[0]?.transaction_read_only!=='on')failed();
}
const transactionOk=transaction=>transaction?.isTransaction===true&&typeof transaction.query==='function';
// A range or data stop over a degradable budget (OD-S5-D). A refusal that is already a Qr2Error, one without a detail and every other limit are not degradable.
const degradableLimit=error=>error?.code==='QR2_RANGE_ADMISSION_REFUSED'&&!(error instanceof Qr2Error)&&COVERAGE_DEGRADABLE_LIMITS.includes(error.detail?.limit)?error.detail.limit:null;
async function readCoverageSnapshotUnchecked({transaction,accounts,budgets}){
  let plan;
  try{plan=planCoverage({accounts,budgets});}
  catch(error){
    if(degradableLimit(error)!=='union_minutes')throw error;
    // Span over the budget. Plan-time byte refusals of the zero-row envelope and every earlier refusal keep their precedence and issue no query:
    // the degraded registry is built first (it raises them), the transaction checks run next, then the registry is returned.
    const degraded=buildDegradedCoverageSnapshot({accounts,budgets,limit:'union_minutes'});
    if(!transactionOk(transaction))failed();
    try{await verifyTransaction(transaction);}
    catch(checkError){
      if(['QR2_RANGE_ADMISSION_REFUSED','QR2_INPUT_INVALID','QR2_REPORT_FAILED'].includes(checkError?.code))throw checkError;
      throw coverageError('QR2_REPORT_FAILED');
    }
    return degraded;
  }
  if(!transactionOk(transaction))failed();
  try{
    await verifyTransaction(transaction);
    if(plan.unions.length===0)return buildCoverageSnapshot({accounts,budgets,facts:[]});
    const probe=rowsOf(await transaction.query(COVERAGE_SQL.PROBE),1);
    if(probe.length!==1||!Object.hasOwn(probe[0]??{},'name'))failed();
    if(probe[0].name===null)return buildCoverageSnapshot({accounts,budgets,facts:plan.unions.map(()=>({state:'TABLE_ABSENT'}))});
    if(typeof probe[0].name!=='string'||!['pine_market_bars','public.pine_market_bars'].includes(probe[0].name))failed();
    const retainedCapacity=coverageRowCapacity({accounts,budgets});
    const facts=[];let total=0;
    for(const union of plan.unions){
      const remaining=retainedCapacity-total;
      if(remaining===Number.MAX_SAFE_INTEGER)failed();
      const limit=remaining+1;
      const rows=rowsOf(await transaction.query(COVERAGE_SQL.ROWS,[union.market.broker,union.market.symbol,union.market.timeframe,union.window.from,union.window.to,limit]),limit);
      if(rows.length>remaining)throw coverageError('QR2_RANGE_ADMISSION_REFUSED',{limit:'timestamp_rows',max:retainedCapacity});
      admitCoverageRows({accounts,budgets,rowCount:total+rows.length});
      const timestamps=[];let previous=union.window.from;
      for(let i=0;i<rows.length;i++){
        const row=rows[i];
        if(row===null||typeof row!=='object'||Array.isArray(row)||Reflect.ownKeys(row).length!==1||!Object.hasOwn(row,'bar_time'))failed();
        const time=decodeCoverageTimestamp(row.bar_time);
        if(time%60000!==0||time<=previous||time>union.window.to)failed();
        timestamps.push(time);previous=time;
        // Release driver row objects as soon as strict decoding succeeds. They are owned by this query result.
        rows[i]=null;
      }
      total+=timestamps.length;facts.push({state:'COMPLETE',timestamps});
    }
    return buildCoverageSnapshot({accounts,budgets,facts});
  }catch(error){
    // Data-time stop (timestamp_rows sentinel, visits, intervals, output bytes): the transaction checks already passed. Decoded timestamps are dropped.
    const limit=degradableLimit(error);
    if(limit!==null&&limit!=='union_minutes')return buildDegradedCoverageSnapshot({accounts,budgets,limit});
    if(['QR2_RANGE_ADMISSION_REFUSED','QR2_INPUT_INVALID','QR2_REPORT_FAILED'].includes(error?.code))throw error;
    throw coverageError('QR2_REPORT_FAILED');
  }
}
