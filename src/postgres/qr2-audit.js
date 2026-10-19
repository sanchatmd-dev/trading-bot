import {Qr2Error} from '../portfolio/qr2-constants.js';
import {selectAuditKeys} from '../portfolio/qr2-labels.js';
import {QR2_READER_METHOD} from './qr2-reader.js';

// QR-2 after-commit audit writer (contract 6.7, R-A, R-B). The reader returns findings and writes nothing; the caller (S3 adds the bounded
// after-commit hook) passes them here once the read transaction has committed. The writer opens its own short READ COMMITTED transaction,
// takes one advisory lock per dedup key, checks that the key is absent and writes one audit row per distinct defect through store.audit.
// At most 20 distinct keys per call. It touches no ledger table, no fence row and no table other than audit. No migration: the key sits in
// audit.trade_id and the existence check is a filtered scan of audit (no index on audit.trade_id today; an index would be a migration with
// its own GO and is recorded as an S4 item, K5 in the design).

export const QR2_AUDIT_EVENT='qr2.finding';
export const QR2_AUDIT_MAX_KEYS=20;

/**
 * Writes one audit row per distinct defect key (sha256(canonical([method_id, bot_id, broker, check_id, first_row_key]))).
 * findings: [{check, code?, event_key?, position_id?, symbol?, ...}] as returned by readQr2Account().audit_findings.
 * Refused QR2_AUDIT_OUTSIDE_TRANSACTION_REQUIRED when called inside a transaction: the audit row must appear only after the read commits, and
 * db.transaction would silently join the caller. Returns {considered, capped, written, skipped_existing, keys}.
 */
export async function writeQr2Audit(store,{findings=[],botId,broker,methodId=QR2_READER_METHOD,max=QR2_AUDIT_MAX_KEYS}){
  if(typeof botId!=='string'||botId===''||typeof broker!=='string'||broker==='')throw new Qr2Error('QR2_INPUT_INVALID','botId and broker are required');
  if(!Number.isSafeInteger(max)||max<1||max>QR2_AUDIT_MAX_KEYS)throw new Qr2Error('QR2_INPUT_INVALID','max must be between 1 and '+QR2_AUDIT_MAX_KEYS);
  const {db}=store;
  if(db.isTransaction)throw new Qr2Error('QR2_AUDIT_OUTSIDE_TRANSACTION_REQUIRED','the QR-2 audit writer runs after the read transaction has committed');
  const all=selectAuditKeys({findings,method_id:methodId,bot_id:botId,broker,max:Infinity});
  const keys=all.slice(0,max);
  const codeOf=new Map();
  for(const f of findings)if(f.check&&!codeOf.has(f.check+'|'+(f.event_key??f.position_id??f.symbol??'')))codeOf.set(f.check+'|'+(f.event_key??f.position_id??f.symbol??''),f.code||f.effect||null);
  if(!keys.length)return {considered:0,capped:false,written:0,skipped_existing:0,keys:[]};
  const result=await db.transaction(async()=>{
    // Sorted order: two writers that share keys then take their locks in the same order.
    const ordered=keys.map(k=>k.key).sort();
    for(const key of ordered)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['qr2:audit:'+key]);
    const existing=new Set((await db.query('SELECT trade_id FROM public.audit WHERE event=$1 AND user_id=$2 AND trade_id=ANY($3::text[])',[QR2_AUDIT_EVENT,botId,ordered])).rows.map(r=>r.trade_id));
    let written=0;
    for(const item of keys){
      if(existing.has(item.key))continue;
      await store.audit(botId,QR2_AUDIT_EVENT,item.key,{method_id:methodId,bot_id:botId,broker,check_id:item.check_id,first_row_key:item.first_row_key,code:codeOf.get(item.check_id+'|'+item.first_row_key)??null});
      written++;
    }
    return {written,skipped_existing:keys.length-written};
  },{isolation:'READ COMMITTED'});
  return {considered:all.length,capped:all.length>keys.length,...result,keys:keys.map(k=>k.key)};
}
