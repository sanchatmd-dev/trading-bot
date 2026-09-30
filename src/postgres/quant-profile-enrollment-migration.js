import fs from 'node:fs/promises';
import {canonical,fail} from '../pine-bridge/source.js';

const schemaTable='quant_profile_enrollment_schema',receiptTable='quant_profile_enrollment_receipts';
const guard='quant_profile_enrollment_receipt_guard';
const refused=()=>fail('QUANT_PROFILE_ENROLLMENT_SCHEMA_UNSUPPORTED',503);
const normalize=value=>value.replaceAll('\r\n','\n').trim();
const definition=value=>value.replaceAll('public.','');
const reasons=extra=>"CHECK ((stop_reason = ANY (ARRAY['LEASE_EXPIRED'::text, 'CANCELLED'::text, 'RUNTIME_EXCEEDED'::text, 'HEALTH_UNAVAILABLE'::text"+
 (extra?", 'PROFILE_COMPLETING'::text":"")+"])))";
const columns={
 [schemaTable]:[['singleton','boolean'],['version','integer']],
 [receiptTable]:[['version','text'],['job_id','uuid'],['operation_id','text'],['lease_token','uuid'],
  ['contract_hash','text'],['payload_hash','text'],['result_hash','text'],['policy_hash','text'],['policy','jsonb'],
  ['stop_proof_sha256','text'],['readback_proof_sha256','text'],['completed_at','bigint'],['receipt_hash','text']]
};
const hashes=['contract_hash','payload_hash','result_hash','policy_hash','stop_proof_sha256','readback_proof_sha256','receipt_hash'];
const expectedConstraints={
 [schemaTable]:['CHECK (singleton)','CHECK ((version = 1))','PRIMARY KEY (singleton)'].sort(),
 [receiptTable]:[
  "CHECK ((version = 'profile-enrollment-receipt-v1'::text))",
  "CHECK ((operation_id ~ '^[A-Za-z0-9._:-]{8,128}$'::text))",
  ...hashes.map(name=>`CHECK ((${name} ~ '^[a-f0-9]{64}$'::text))`),
  "CHECK ((jsonb_typeof(policy) = 'object'::text))",
  "CHECK (((completed_at >= 0) AND (completed_at <= '9007199254740991'::bigint)))",
  'FOREIGN KEY (job_id) REFERENCES quant_foundation_jobs(job_id)',
  'FOREIGN KEY (job_id, operation_id) REFERENCES quant_io_launches(job_id, operation_id)',
  'PRIMARY KEY (job_id)'
 ].sort()
};

async function inventory(db){
 const tables=(await db.query(`SELECT relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity,relispartition
  FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])`,
 [Object.keys(columns)])).rows;
 const procedures=(await db.query(`SELECT p.oid,p.pronargs,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,
  p.proconfig,p.prorettype,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND p.proname=$1`,[guard])).rows;
 const triggers=(await db.query(`SELECT t.tgname,t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual,t.tgnargs,
  pg_catalog.octet_length(t.tgargs) args_length,t.tgattr::text columns,t.tgconstraint
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relname=$1 AND NOT t.tgisinternal`,[receiptTable])).rows;
 const reason=(await db.query(`SELECT pg_catalog.pg_get_constraintdef(oid,false) definition,convalidated,condeferrable,condeferred
  FROM pg_catalog.pg_constraint WHERE conrelid='public.quant_foundation_jobs'::regclass
  AND conname='quant_foundation_jobs_stop_reason_check'`)).rows;
 return {tables,procedures,triggers,reason};
}

/** Read-only exact extension check; active jobs do not prevent readiness inspection. */
async function assertSchema(db,body){
 try{
  const {tables,procedures,triggers,reason}=await inventory(db);
  if(tables.length!==2||tables.some(row=>row.relkind!=='r'||row.relpersistence!=='p'||row.relrowsecurity||
     row.relforcerowsecurity||row.relispartition)||procedures.length!==1||triggers.length!==1||reason.length!==1)
   throw refused();
  const rows=(await db.query('SELECT singleton,version FROM public.quant_profile_enrollment_schema')).rows;
  if(rows.length!==1||rows[0].singleton!==true||rows[0].version!==1)throw refused();
  const procedure=procedures[0],trigger=triggers[0];
  if(body===undefined||procedure.pronargs!==0||procedure.prorettype!==2279||procedure.lanname!=='plpgsql'||
     procedure.prosecdef||procedure.provolatile!=='v'||procedure.proleakproof||procedure.proconfig!==null||
     normalize(procedure.prosrc)!==normalize(body)||trigger.tgname!==guard||trigger.tgfoid!==procedure.oid||
     trigger.tgtype!==27||!['O','A'].includes(trigger.tgenabled)||trigger.tgisinternal||trigger.tgqual!==null||
     trigger.tgnargs!==0||trigger.args_length!==0||trigger.columns!==''||trigger.tgconstraint!==0)throw refused();
  if(reason[0].definition!==reasons(true)||!reason[0].convalidated||reason[0].condeferrable||reason[0].condeferred)
   throw refused();
  for(const [table,expected] of Object.entries(columns)){
   const actual=(await db.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) type,a.attnotnull,
    a.attidentity,a.attgenerated,d.oid default_oid FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0
    AND NOT a.attisdropped ORDER BY a.attnum`,['public.'+table])).rows;
   if(canonical(actual.map(row=>[row.attname,row.type]))!==canonical(expected)||actual.some(row=>!row.attnotnull||
      row.attidentity!==''||row.attgenerated!==''||row.default_oid!==null))throw refused();
   const constraints=(await db.query(`SELECT pg_catalog.pg_get_constraintdef(oid,false) definition,convalidated,condeferrable,condeferred,
    (confrelid=0 OR confrelid IN ('public.quant_foundation_jobs'::regclass,
     'public.quant_io_launches'::regclass)) trusted_target
    FROM pg_catalog.pg_constraint WHERE conrelid=$1::regclass`,['public.'+table])).rows;
   if(canonical(constraints.map(row=>definition(row.definition)).sort())!==canonical(expectedConstraints[table])||
      constraints.some(row=>!row.convalidated||row.condeferrable||row.condeferred||!row.trusted_target))throw refused();
   const indexes=(await db.query(`SELECT i.indisvalid,i.indisready,i.indpred IS NULL plain_predicate,
    i.indexprs IS NULL plain_expressions,EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid=i.indrelid AND c.conindid=i.indexrelid AND c.contype='p') constrained
    FROM pg_catalog.pg_index i WHERE i.indrelid=$1::regclass AND i.indisunique`,['public.'+table])).rows;
   if(indexes.length!==1||indexes.some(row=>!row.indisvalid||!row.indisready||!row.plain_predicate||
      !row.plain_expressions||!row.constrained))throw refused();
  }
  return true;
 }catch{throw refused();}
}

async function loadBody(){
 const sql=await fs.readFile(new URL('./quant-profile-enrollment-schema.sql',import.meta.url),'utf8');
 const body=sql.split('CREATE FUNCTION '+guard+'() RETURNS TRIGGER LANGUAGE plpgsql AS $$')[1]?.split('$$;')[0];
 if(body===undefined)throw refused();
 return body;
}

/** Read-only readiness checks retain exact schema semantics without requiring an idle database. */
export async function assertQuantProfileEnrollmentSchema(db){
 try{return await assertSchema(db,await loadBody());}catch{throw refused();}
}

/** Load trusted expectations before runtime locks. The returned assertion performs SQL only. */
export async function loadQuantProfileEnrollmentSchemaAssertion(){
 const body=await loadBody();
 return async function assertLocked(db){
  if(!db.isTransaction)throw fail('PROFILE_ENROLLMENT_TRANSACTION_REQUIRED');
  // Guard both marker edits and trigger/table DDL until the atomic publication finishes.
  await db.query('LOCK TABLE public.quant_profile_enrollment_schema IN SHARE MODE');
  await db.query('LOCK TABLE public.quant_profile_enrollment_receipts IN SHARE ROW EXCLUSIVE MODE');
  return assertSchema(db,body);
 };
}

/** Offline installer. Absent and exactly supported states are the only accepted states. */
export async function ensureQuantProfileEnrollmentSchema(db){
 if(!db.isTransaction)throw fail('QUANT_PROFILE_ENROLLMENT_OFFLINE_TRANSACTION_REQUIRED');
 await db.maintenanceLock();
 await db.query('SET LOCAL search_path=public');
 try{
  const idle=(await db.query(`SELECT EXISTS(SELECT 1 FROM public.quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')) active,
   EXISTS(SELECT 1 FROM public.quant_io_launches WHERE state<>'STOP_PROVEN') launches,
   EXISTS(SELECT 1 FROM public.quant_io_ledgers WHERE pg_catalog.jsonb_typeof(state->'operations') IS DISTINCT FROM 'array') invalid,
   EXISTS(SELECT 1 FROM public.quant_io_ledgers l,LATERAL pg_catalog.jsonb_array_elements(l.state->'operations') op
    WHERE COALESCE(op->>'status','') NOT IN ('SETTLED','CRASHED')) operations`)).rows[0];
  if(!idle||idle.active!==false)throw fail('QUANT_FOUNDATION_NOT_IDLE');
  if(idle.launches!==false||idle.invalid!==false||idle.operations!==false)throw fail('QUANT_IO_NOT_IDLE');
  const {tables,procedures,triggers,reason}=await inventory(db);
  if(tables.length===0&&procedures.length===0&&triggers.length===0){
   if(reason.length!==1||reason[0].definition!==reasons(false)||!reason[0].convalidated||
      reason[0].condeferrable||reason[0].condeferred)throw refused();
   await db.query(await fs.readFile(new URL('./quant-profile-enrollment-schema.sql',import.meta.url),'utf8'));
  }
  return await assertQuantProfileEnrollmentSchema(db);
 }catch(error){
  if(['QUANT_FOUNDATION_NOT_IDLE','QUANT_IO_NOT_IDLE'].includes(error.code))throw error;
  throw refused();
 }
}
