import {planCoverage,buildCoverageSnapshot,admitCoverageRows,coverageRowCapacity,coverageError} from '../portfolio/qr2-coverage-snapshot.js';

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
  if(result.rows.length>limit)throw coverageError('QR2_RANGE_ADMISSION_REFUSED');
  return result.rows;
}
/** Requires a verified caller-owned transaction; never starts a transaction, retries or publishes partial success.
 * Pass schedule: one strict union decode here; one union validation and per-window derivation in construction.
 * A caller may perform at most one independent final registry validation for this invocation.
 */
export async function readCoverageSnapshot({transaction,accounts,budgets}){
  const plan=planCoverage({accounts,budgets});
  if(transaction?.isTransaction!==true||typeof transaction.query!=='function')failed();
  try{
    const isolation=rowsOf(await transaction.query(COVERAGE_SQL.ISOLATION),1);
    if(isolation.length!==1||!['repeatable read','serializable'].includes(isolation[0]?.transaction_isolation))failed();
    const readOnly=rowsOf(await transaction.query(COVERAGE_SQL.READ_ONLY),1);
    if(readOnly.length!==1||readOnly[0]?.transaction_read_only!=='on')failed();
    if(plan.unions.length===0)return buildCoverageSnapshot({accounts,budgets,facts:[]});
    const probe=rowsOf(await transaction.query(COVERAGE_SQL.PROBE),1);
    if(probe.length!==1||!Object.hasOwn(probe[0]??{},'name'))failed();
    if(probe[0].name===null)return buildCoverageSnapshot({accounts,budgets,facts:plan.unions.map(()=>({state:'TABLE_ABSENT'}))});
    if(typeof probe[0].name!=='string'||!['pine_market_bars','public.pine_market_bars'].includes(probe[0].name))failed();
    const retainedCapacity=coverageRowCapacity({accounts,budgets});
    const facts=[];let total=0;
    for(const union of plan.unions){
      const remaining=retainedCapacity-total;
      if(remaining===Number.MAX_SAFE_INTEGER)throw coverageError('QR2_RANGE_ADMISSION_REFUSED');
      const limit=remaining+1;
      const rows=rowsOf(await transaction.query(COVERAGE_SQL.ROWS,[union.market.broker,union.market.symbol,union.market.timeframe,union.window.from,union.window.to,limit]),limit);
      if(rows.length>remaining)throw coverageError('QR2_RANGE_ADMISSION_REFUSED');
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
    if(['QR2_RANGE_ADMISSION_REFUSED','QR2_INPUT_INVALID','QR2_REPORT_FAILED'].includes(error?.code))throw error;
    throw coverageError('QR2_REPORT_FAILED');
  }
}
