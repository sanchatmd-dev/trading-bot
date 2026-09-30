import fs from 'node:fs/promises';
import {fail,canonical} from '../pine-bridge/source.js';

const constraintDefinitions={
 quant_io_launches:["CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text))","CHECK ((state = ANY (ARRAY['INTENT_RECORDED'::text, 'STARTING'::text, 'SPAWNED'::text, 'RELEASED'::text, 'STOP_PROVEN'::text])))","FOREIGN KEY (job_id) REFERENCES public.quant_io_ledgers(job_id)","PRIMARY KEY (job_id, operation_id)","UNIQUE (unit_name)"],
 quant_io_ledgers:["CHECK ((((state ->> 'revision'::text))::bigint = revision))","CHECK (((state ->> 'job_id'::text) = (job_id)::text))","CHECK (((state ->> 'lease_token'::text) = (lease_token)::text))","CHECK (((state ->> 'policy_hash'::text) = policy_hash))","CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text))","CHECK ((revision >= 0))","CHECK ((state_hash ~ '^[0-9a-f]{64}$'::text))","FOREIGN KEY (job_id) REFERENCES public.quant_foundation_jobs(job_id)","PRIMARY KEY (job_id)"]
};
const columns={quant_io_ledgers:[['job_id','uuid'],['policy_hash','text'],['lease_token','uuid'],['revision','bigint'],['state','jsonb'],['state_hash','text']],
 quant_io_launches:[['job_id','uuid'],['operation_id','text'],['lease_token','uuid'],['unit_name','text'],['payload_hash','text'],['state','text'],['created_at','bigint']]};
const functions=['quant_io_ledger_guard','quant_io_launch_guard','quant_io_foundation_release_guard'];
const refused=()=>fail('QUANT_IO_SCHEMA_UNSUPPORTED');
const normalize=value=>value.replaceAll('\r\n','\n').trim();

/** Offline compatibility check. Existing guard semantics are never silently repaired. */
export async function ensureQuantIoSchema(db){
 if(!db.isTransaction)throw fail('QUANT_IO_OFFLINE_TRANSACTION_REQUIRED');
 await db.maintenanceLock();
 const resources=await Promise.all(['quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'].map(name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8')));
 try{
  await db.query('SET LOCAL search_path=public');
  const tables=(await db.query("SELECT relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity,relispartition FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('quant_io_ledgers','quant_io_launches')")).rows;
  const procedures=(await db.query("SELECT p.oid,p.proname,p.pronargs,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.prorettype,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[])",[functions])).rows;
  const triggers=(await db.query(`SELECT t.tgname,c.relname,t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual,
   t.tgnargs,octet_length(t.tgargs) args_length,t.tgattr::text columns,t.tgconstraint
   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
   AND ((c.relname IN ('quant_io_ledgers','quant_io_launches') AND NOT t.tgisinternal)
     OR (c.relname='quant_foundation_jobs' AND t.tgname='quant_io_foundation_release_guard'))`)).rows;
  const active=(await db.query("SELECT EXISTS(SELECT 1 FROM public.quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')) active")).rows[0]?.active;
  if(active!==false)throw fail('QUANT_FOUNDATION_NOT_IDLE');
  if(tables.length===0&&procedures.length===0&&triggers.length===0){
   for(const sql of resources)await db.query(sql);
   return await ensureQuantIoSchema(db);
  }
  if(tables.length!==2||tables.some(row=>row.relkind!=='r'||row.relpersistence!=='p'||row.relrowsecurity||row.relforcerowsecurity||row.relispartition)||procedures.length!==3||triggers.length!==3)throw refused();
  for(const name of functions){
   const procedure=procedures.find(row=>row.proname===name);
   const sql=resources.find(value=>value.includes('CREATE FUNCTION '+name+'()'));
   const body=sql?.split('CREATE FUNCTION '+name+'() RETURNS TRIGGER LANGUAGE plpgsql AS $$')[1]?.split('$$;')[0];
   if(!procedure||body===undefined||procedure.pronargs!==0||procedure.prorettype!==2279||procedure.lanname!=='plpgsql'||
      procedure.prosecdef||procedure.provolatile!=='v'||procedure.proleakproof||procedure.proconfig!==null||normalize(procedure.prosrc)!==normalize(body))throw refused();
   const trigger=triggers.find(row=>row.tgname===name);
   const release=name==='quant_io_foundation_release_guard';
   const table=release?'quant_foundation_jobs':name==='quant_io_ledger_guard'?'quant_io_ledgers':'quant_io_launches';
   if(!trigger||trigger.relname!==table||trigger.tgfoid!==procedure.oid||trigger.tgtype!==(release?19:27)||
     !['O','A'].includes(trigger.tgenabled)||trigger.tgisinternal||trigger.tgqual!==null||trigger.tgnargs!==0||
     trigger.args_length!==0||trigger.columns!==''||trigger.tgconstraint!==0)throw refused();
  }
  await db.query('SET LOCAL search_path=pg_catalog');
  for(const [table,expected] of Object.entries(columns)){
   const qualified='public.'+table;
   const actual=(await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,
    a.attidentity,a.attgenerated,d.oid default_oid FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[qualified])).rows;
   if(canonical(actual.map(row=>[row.attname,row.type]))!==canonical(expected)||actual.some(row=>!row.attnotnull||row.attidentity!==''||row.attgenerated!==''||row.default_oid!==null))throw refused();
   const constraints=(await db.query(`SELECT pg_get_constraintdef(oid,false) definition,convalidated,condeferrable,condeferred
    FROM pg_catalog.pg_constraint WHERE conrelid=$1::regclass ORDER BY definition`,[qualified])).rows;
   if(canonical(constraints.map(row=>row.definition))!==canonical(constraintDefinitions[table])||
    constraints.some(row=>!row.convalidated||row.condeferrable||row.condeferred))throw refused();
   const indexes=(await db.query(`SELECT i.indisvalid,i.indisready,i.indpred IS NULL plain_predicate,i.indexprs IS NULL plain_expressions,
    EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=i.indrelid AND c.conindid=i.indexrelid AND c.contype IN ('p','u')) constrained
    FROM pg_catalog.pg_index i WHERE i.indrelid=$1::regclass AND i.indisunique`,[qualified])).rows;
   if(indexes.length!==(table==='quant_io_ledgers'?1:2)||indexes.some(row=>!row.indisvalid||!row.indisready||!row.plain_predicate||!row.plain_expressions||!row.constrained))throw refused();
  }
  const unresolved=(await db.query(`SELECT EXISTS(SELECT 1 FROM public.quant_io_launches WHERE state<>'STOP_PROVEN') launches,
   EXISTS(SELECT 1 FROM public.quant_io_ledgers WHERE jsonb_typeof(state->'operations') IS DISTINCT FROM 'array') invalid,
   EXISTS(SELECT 1 FROM public.quant_io_ledgers l,LATERAL jsonb_array_elements(l.state->'operations') op
     WHERE COALESCE(op->>'status','') NOT IN ('SETTLED','CRASHED')) operations`)).rows[0];
  if(!unresolved||unresolved.launches!==false||unresolved.invalid!==false||unresolved.operations!==false)throw fail('QUANT_IO_NOT_IDLE');
  await db.query('SET LOCAL search_path=public');
 }catch(error){
  if(['QUANT_FOUNDATION_NOT_IDLE','QUANT_IO_NOT_IDLE'].includes(error.code))throw error;
  throw refused();
 }
}
