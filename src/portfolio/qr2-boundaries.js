import {QR2_EPOCHS,Qr2Error} from './qr2-constants.js';

// QR-2 epoch boundary records (contract 6.2; OD-Q6, RC-Q13, RC-Q14). Pure: a record is plain data that root reviews and freezes, one
// per environment, with values copied from deployment evidence (instants and revision ids only). Nothing here reads a database, the
// clock, the network or an environment variable. The reader takes the record as a required argument.

const RANK=Object.freeze({E0:0,E1:1,E2:2});
const isInstant=value=>Number.isSafeInteger(value);
// Allow-list (root ruling QR-2 S2 round 3, Z2): evidence is a repository-relative path under docs/evidence/ with a .json name, or a 64-hex digest.
// Anything else (file:, ~, %VAR%, $VAR, a drive letter, an absolute path, a URL, a backslash, a parent segment) is refused.
const EVIDENCE_PATH=/^docs\/evidence\/[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.json$/;
const EVIDENCE_DIGEST=/^[0-9a-fA-F]{64}$/;

/**
 * Product default (fail closed). No recorded boundary: every fill has an unknown epoch, so the replay halts at the first fill with
 * LEDGER_RULE_UNREPLAYABLE (RECONCILIATION_FAILED from that fill); a funding-only account still has NAV and returns. A lot-fee
 * boundary of null gives LOT_EPOCH_UNKNOWN when a lot fails the current formula; a lot-table boundary of null keeps the E0 target
 * halt. Root replaces this with a reviewed record per environment only from deployment evidence (S9, its own GO).
 */
export const QR2_BOUNDARY_RECORD_UNRECORDED=Object.freeze({record_id:'UNRECORDED',epochs:Object.freeze([]),lot_fee_boundary:null,lot_table_boundary:null,evidence:null});

const refuse=message=>{throw new Qr2Error('QR2_BOUNDARY_RECORD_INVALID',message);};

/**
 * Validates one boundary record and returns a frozen copy. Rules: record_id is a non-empty string; epochs are listed in order
 * E0 < E1 < E2 with each name at most once, half-open [from, to), integers or null, from < to, no overlap (a gap is allowed and is
 * LEDGER_RULE_UNREPLAYABLE for a fill inside it); only the first entry may have from null and only the last may have to null; the lot
 * boundaries are integers or null; evidence (a repository path of sanitized evidence) is required unless the record is UNRECORDED,
 * and UNRECORDED holds no epoch and no boundary.
 */
export function validateBoundaryRecord(record){
  if(!record||typeof record!=='object'||Array.isArray(record))refuse('boundary record must be an object');
  if(typeof record.record_id!=='string'||record.record_id==='')refuse('record_id is required');
  if(!Array.isArray(record.epochs))refuse('epochs must be an array');
  for(const key of ['lot_fee_boundary','lot_table_boundary'])
    if(record[key]!==null&&record[key]!==undefined&&!isInstant(record[key]))refuse(key+' must be an integer or null');
  const epochs=record.epochs.map((row,index)=>{
    if(!row||typeof row!=='object'||!QR2_EPOCHS.includes(row.epoch))refuse('unknown epoch at '+index);
    const from=row.from===undefined?null:row.from,to=row.to===undefined?null:row.to;
    for(const bound of [from,to])if(bound!==null&&!isInstant(bound))refuse('epoch bound at '+index+' must be an integer or null');
    if(from!==null&&to!==null&&from>=to)refuse('epoch '+row.epoch+' must have from < to');
    return Object.freeze({epoch:row.epoch,from,to});
  });
  epochs.forEach((row,index)=>{
    if(index===0)return;
    const prior=epochs[index-1];
    if(RANK[row.epoch]<=RANK[prior.epoch])refuse('epochs must be ordered E0 < E1 < E2 without repeats');
    if(prior.to===null||row.from===null)refuse('only the first epoch may start open and only the last may end open');
    if(prior.to>row.from)refuse('epochs overlap');
  });
  const unrecorded=record.record_id==='UNRECORDED';
  if(unrecorded){
    if(epochs.length||record.lot_fee_boundary!=null||record.lot_table_boundary!=null)refuse('UNRECORDED holds no epoch and no boundary');
  }else{
    if(typeof record.evidence!=='string'||record.evidence==='')refuse('evidence is required unless the record is UNRECORDED');
    // A machine location never enters the response: only the two allowed forms pass.
    if(!EVIDENCE_PATH.test(record.evidence)&&!EVIDENCE_DIGEST.test(record.evidence))refuse('evidence must be a repository-relative path under docs/evidence/ ending in .json, or a 64-hex digest');
  }
  return Object.freeze({record_id:record.record_id,epochs:Object.freeze(epochs),lot_fee_boundary:record.lot_fee_boundary??null,lot_table_boundary:record.lot_table_boundary??null,evidence:record.evidence??null});
}
