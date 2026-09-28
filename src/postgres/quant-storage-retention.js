import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical,hash,fail} from '../pine-bridge/source.js';
import {DatasetStore} from '../quant-research/dataset-store.js';
import {withQuantOfflineGuard,loadQuantRecoveryPolicy} from './quant-foundation-recovery.js';
import {validateBackfillState,validateBackfillResult,foundationTotalBars,validateDatasetReference} from '../quant-research/foundation-contract.js';

const markerName='.database-owner.json';
const artifact=name=>typeof name==='string'&&/^[a-f0-9]{64}$/.test(name);
const rootHash=root=>hash(path.resolve(root));
async function databaseHash(db){
  const {rows:[identity]}=await db.query("SELECT oid::text oid,datname,current_setting('port') port FROM pg_database WHERE datname=current_database()");
  if(!identity)throw fail('STORAGE_DATABASE_BINDING_MISMATCH');return hash(canonical(identity));
}

export async function bindQuantStorage(db,root) {
  if(!db.isTransaction)throw fail('STORAGE_OFFLINE_TRANSACTION_REQUIRED');
  await db.maintenanceLock();
  await new DatasetStore({root}).ready();
  const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('UNSAFE_DATASET_PATH');
  const previous=(await db.query('SELECT * FROM quant_storage_namespace WHERE singleton')).rows[0];
  if(previous){await assertQuantStorageOwner(db,root);return;}
  // A new namespace may only adopt an empty root. Rebinding an existing cache
  // could otherwise permit one database to delete another database's evidence.
  if((await fs.readdir(root)).length)throw fail('STORAGE_BINDING_REQUIRES_EMPTY_ROOT');
  const owner={version:'quant-storage-owner-v1',store_id:randomUUID(),root_hash:rootHash(root),database_hash:await databaseHash(db)};
  const handle=await fs.open(path.join(root,markerName),'wx',0o600);
  try{await handle.writeFile(canonical(owner));await handle.sync();}finally{await handle.close();}
  await db.query('INSERT INTO quant_storage_namespace(singleton,store_id,root_hash,database_hash) VALUES(TRUE,$1,$2,$3)',[owner.store_id,owner.root_hash,owner.database_hash]);
}

export async function assertQuantStorageOwner(db,root) {
  const owner=(await db.query('SELECT store_id,root_hash,database_hash FROM quant_storage_namespace WHERE singleton')).rows[0];
  const filename=path.join(root,markerName),stat=await fs.lstat(filename);
  if(!owner||!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw fail('STORAGE_DATABASE_BINDING_MISMATCH');
  const recorded=JSON.parse(await fs.readFile(filename,'utf8'));
  if(recorded.version!=='quant-storage-owner-v1'||recorded.store_id!==owner.store_id||recorded.root_hash!==owner.root_hash||owner.root_hash!==rootHash(root)||recorded.database_hash!==owner.database_hash||owner.database_hash!==await databaseHash(db))throw fail('STORAGE_DATABASE_BINDING_MISMATCH');
}

/** Authoritative retention root set includes terminal jobs and immutable
 * evidence. No age-based deletion of referenced objects is permitted.
 */
export async function maintainQuantStorage({db,budget,apply=false,recoverStaleLock=false,policy,manager,inventory,settleMs}={}) {
  if(db.isTransaction)throw fail('STORAGE_OFFLINE_TRANSACTION_REQUIRED');
  policy??=await loadQuantRecoveryPolicy();
  return withQuantOfflineGuard({db,policy,manager,inventory,settleMs},async({query,assertExclusive})=>{
    const connection={query};
    const schema=(await query('SELECT version FROM schema_version')).rows;
    if(schema.length!==1||schema[0].version!==14)throw fail('STORAGE_SCHEMA_UNSUPPORTED');
    await assertQuantStorageOwner(connection,budget.root);
    const retained=new Set([markerName]);
    const raw=value=>{
      if(!value||!artifact(value.dataset_id)||value.dataset_id!==value.sha256)throw fail('STORAGE_REFERENCE_INVALID');
      retained.add(value.dataset_id);
    };
    const research=(await query("SELECT contract FROM quant_jobs WHERE contract->>'execution_backend'='quant-foundation-v1'")).rows;
    for(const {contract} of research){
      const refs=contract.dataset?.references;raw(refs?.raw);
      const sha=refs?.sidecar?.sha256;if(typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))throw fail('STORAGE_REFERENCE_INVALID');
      retained.add('atr14-'+sha+'.json');
    }
    for(const row of (await query('SELECT contract,checkpoint,next_bar,result,status FROM quant_foundation_jobs')).rows){
      if(row.contract.kind!=='BACKFILL'){raw(row.contract.dataset);continue;}
      if(row.checkpoint){
        const {sha256,...payload}=row.checkpoint;
        if(hash(canonical(payload))!==sha256||payload.next_bar!==row.next_bar||
          payload.engine_hash!==row.contract.engine_hash||payload.snapshot_hash!==row.contract.snapshot_hash)
          throw fail('STORAGE_REFERENCE_INVALID');
        try{validateBackfillState(row.contract,row.next_bar,payload.state);}catch{throw fail('STORAGE_REFERENCE_INVALID');}
        for(const page of payload.state.pages){validateDatasetReference(page.reference);raw(page.reference);}
      }else if(row.next_bar!==0)throw fail('STORAGE_REFERENCE_INVALID');
      if(row.status==='SUCCEEDED'){
        try{validateBackfillResult(row.contract,row.checkpoint,row.result);}catch{throw fail('STORAGE_REFERENCE_INVALID');}
        raw(row.result.dataset);
      }else if(row.result)throw fail('STORAGE_REFERENCE_INVALID');
      if(row.next_bar>foundationTotalBars(row.contract))throw fail('STORAGE_REFERENCE_INVALID');
    }
    return budget.maintenance({retainedNames:[...retained],apply,exclusiveOffline:true,recoverStaleLock,assertExclusive});
  });
}
