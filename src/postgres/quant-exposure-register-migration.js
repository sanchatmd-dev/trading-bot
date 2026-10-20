import fs from 'node:fs/promises';
import {inspectRuntimeRole} from './runtime-role-inspection.js';

/**
 * QR-3 S2a exposure register. Offline only: the maintenance lock excludes every participating API and worker.
 * The register is its own extension (marker table quant_exposure_register_schema, version 1); the base schema_version stays 14.
 * The install needs the version-1 research extension (quant_job_schema version 1) and the base users table.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an
 * unclassified install could collide with, or silently accept, a foreign object that carries a register name. The states are:
 *   ABSENT     no register relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the register SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (partial, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra trigger, foreign
 *              constraint or index, overload or orphan with a register name, a relation or function owned by a role other than the
 *              owner of the marker table: OWNER_MISMATCH:<name>, a column whose collation is not the database default:
 *              TABLE_DEFINITION:<table>:COLLATION).
 * Run the tool as the schema owner with the default search_path: the deparsed foreign key text names users unqualified only when public is
 * on the search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any
 * register row exists (insert-only evidence is never dropped by this tool). Definitions below are the PostgreSQL 16 deparsed text.
 */
export const REGISTER_MARKER='quant-exposure-register-v1';
export const INSERT_ONLY_SQLSTATE='QR002';
export const SERIALIZABLE_SQLSTATE='QR003';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const REGISTER_TABLE='quant_exposure_register';
export const MARKER_TABLE='quant_exposure_register_schema';
const TABLES=[MARKER_TABLE,REGISTER_TABLE];
const FUNCTIONS=Object.freeze(['quant_exposure_register_version','quant_exposure_register_insert_only','quant_exposure_register_serializable_insert']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
export const EXPOSURE_GUARDS=Object.freeze([
 ['quant_exposure_register_no_change','quant_exposure_register_insert_only',27],
 ['quant_exposure_register_no_truncate','quant_exposure_register_insert_only',34],
 ['quant_exposure_register_serializable','quant_exposure_register_serializable_insert',7]]);
const INDEXES=Object.freeze({
 quant_exposure_register_schema_pkey:'CREATE UNIQUE INDEX quant_exposure_register_schema_pkey ON public.quant_exposure_register_schema USING btree (version)',
 quant_exposure_register_pkey:'CREATE UNIQUE INDEX quant_exposure_register_pkey ON public.quant_exposure_register USING btree (exposure_id)',
 quant_exposure_register_qr3_unique:'CREATE UNIQUE INDEX quant_exposure_register_qr3_unique ON public.quant_exposure_register USING btree (comparison_id, participant_run_id, start_ms, end_ms)',
 quant_exposure_register_qr4_unique:"CREATE UNIQUE INDEX quant_exposure_register_qr4_unique ON public.quant_exposure_register USING btree (selection_id) WHERE (kind = 'QR4_SELECTION'::text)",
 quant_exposure_register_lookup:'CREATE INDEX quant_exposure_register_lookup ON public.quant_exposure_register USING btree (owner_id, broker, symbol, timeframe, start_ms)'});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const COLUMNS=Object.freeze({
 [MARKER_TABLE]:[col('version','integer',true)],
 [REGISTER_TABLE]:[col('exposure_id','uuid',true,'gen_random_uuid()'),col('kind','text',true),col('owner_id','text',true),col('broker','text',true),
  col('symbol','text',true),col('timeframe','text',true),col('start_ms','bigint',true),col('end_ms','bigint',true),col('comparison_id','text',false),
  col('participant_run_id','text',false),col('source_hash','text',false),col('selection_id','text',false),col('at_ms','bigint',true)]});
const CONSTRAINTS=Object.freeze({
 [MARKER_TABLE]:{
  quant_exposure_register_schema_pkey:['p','PRIMARY KEY (version)'],
  quant_exposure_register_schema_version_check:['c','CHECK ((version = 1))']},
 [REGISTER_TABLE]:{
  quant_exposure_register_pkey:['p','PRIMARY KEY (exposure_id)'],
  quant_exposure_register_owner_id_fkey:['f','FOREIGN KEY (owner_id) REFERENCES users(id)'],
  quant_exposure_register_kind_check:['c',"CHECK ((kind = ANY (ARRAY['QR3_COMPARISON'::text, 'QR4_SELECTION'::text])))"],
  quant_exposure_register_broker_check:['c','CHECK ((length(broker) > 0))'],
  quant_exposure_register_symbol_check:['c','CHECK ((length(symbol) > 0))'],
  quant_exposure_register_timeframe_check:['c','CHECK ((length(timeframe) > 0))'],
  quant_exposure_register_start_ms_check:['c','CHECK (((start_ms >= 0) AND ((start_ms % (60000)::bigint) = 0)))'],
  quant_exposure_register_end_ms_check:['c',"CHECK (((end_ms > start_ms) AND ((end_ms % (60000)::bigint) = 0) AND (end_ms <= '253402300800000'::bigint)))"],
  quant_exposure_register_at_ms_check:['c',"CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  quant_exposure_register_kind_fields_check:['c',"CHECK (COALESCE((((kind = 'QR3_COMPARISON'::text) AND (comparison_id IS NOT NULL) AND (length(comparison_id) > 0) AND (participant_run_id IS NOT NULL) AND (length(participant_run_id) > 0) AND (source_hash IS NOT NULL) AND (source_hash ~ '^[0-9a-f]{64}$'::text) AND (selection_id IS NULL)) OR ((kind = 'QR4_SELECTION'::text) AND (selection_id IS NOT NULL) AND (length(selection_id) > 0) AND (comparison_id IS NULL) AND (participant_run_id IS NULL) AND (source_hash IS NULL))), false))"],
  quant_exposure_register_qr3_unique:['u','UNIQUE (comparison_id, participant_run_id, start_ms, end_ms)']}});
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireExtension(db){
  if(!await exists(db,'quant_job_schema'))throw Error('Quant research extension 1 required');
  const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported quant_job_schema version');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the register SQL file itself. */
async function expectedFunctions(){
  const text=await sql('quant-exposure-register.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS (\\w+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Register definition not found: '+name);
    out[name]={args:match[1].trim().toLowerCase(),returns:match[2].toLowerCase(),language:match[3].toLowerCase(),volatility:match[4]?'i':'v',body:match[5]};
  }
  return out;
}

const RELATION_ROWS=`SELECT c.oid,c.relowner,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relhasrules,c.relispartition,c.relhassubclass,c.reloptions
  FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) ORDER BY c.relname`;
const FUNCTION_ROWS=`SELECT p.oid,p.proowner,p.proname,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.proisstrict,p.proretset,p.prokind,p.proparallel,
  l.lanname,p.prorettype::regtype::text AS returns,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) ORDER BY p.proname,p.oid`;
// Triggers that carry a register name on any table, triggers bound to a register function under any name, and every other
// non-internal trigger on the register table or the marker table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the register SQL; an empty list means exact. */
function functionDifferences(row,expected){
  const reasons=[];
  if(row.prosecdef!==false)reasons.push('SECURITY_DEFINER');
  if(!(Array.isArray(row.proconfig)&&row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))reasons.push('SEARCH_PATH');
  if(normalize(row.prosrc)!==normalize(expected.body))reasons.push('BODY');
  if(row.lanname!==expected.language||row.returns.toLowerCase()!==expected.returns||row.provolatile!==expected.volatility||row.proleakproof!==false
    ||row.proisstrict!==false||row.proretset!==false||row.prokind!=='f'||row.proparallel!=='u')reasons.push('ATTRIBUTES');
  return reasons;
}

async function tableDifferences(db,relation,table){
  const reasons=[];
  if(relation.relkind!=='r'||relation.relpersistence!=='p'||relation.relrowsecurity||relation.relforcerowsecurity||relation.relhasrules||relation.relispartition||relation.relhassubclass||relation.reloptions!==null)
    reasons.push('SHAPE');
  // Column collation: a text column must carry the database default, which is the collation of the type itself (pg_type.typcollation); any other type has none.
  const columns=(await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS def,a.attidentity,a.attgenerated,a.attnum,
    a.attcollation=ty.typcollation AS default_collation
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid=a.atttypid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[relation.oid])).rows;
  const expected=COLUMNS[table];
  if(columns.length!==expected.length||columns.some((row,index)=>row.attname!==expected[index].name||row.type!==expected[index].type||row.attnotnull!==expected[index].notNull
    ||row.def!==expected[index].def||row.attidentity!==''||row.attgenerated!==''||row.attnum!==index+1))reasons.push('COLUMNS');
  if(columns.some(row=>!row.default_collation))reasons.push('COLLATION');
  const constraints=(await db.query(`SELECT c.conname,c.contype,pg_catalog.pg_get_constraintdef(c.oid) AS def,c.condeferrable,c.condeferred,c.convalidated
    FROM pg_catalog.pg_constraint c WHERE c.conrelid=$1 ORDER BY c.conname`,[relation.oid])).rows;
  const wanted=CONSTRAINTS[table];
  if(constraints.length!==Object.keys(wanted).length||constraints.some(row=>!wanted[row.conname]||row.contype!==wanted[row.conname][0]||row.def!==wanted[row.conname][1]
    ||row.condeferrable||row.condeferred||!row.convalidated))reasons.push('CONSTRAINTS');
  const indexes=(await db.query(`SELECT ic.relname,pg_catalog.pg_get_indexdef(i.indexrelid) AS def,i.indisvalid,i.indisready
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=$1 ORDER BY ic.relname`,[relation.oid])).rows;
  const wantedIndexes=Object.entries(INDEXES).filter(([,def])=>def.includes(' ON public.'+table+' '));
  if(indexes.length!==wantedIndexes.length||indexes.some(row=>INDEXES[row.relname]!==row.def||!row.indisvalid||!row.indisready))reasons.push('INDEXES');
  return reasons;
}

/**
 * Read-only exact classification of every register object. state is ABSENT, INSTALLED or OTHER. problems lists present objects
 * that are not exactly the register SQL, missing lists expected objects that do not exist. Never calls a register function.
 */
export async function classifyQuantExposureRegister(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[EXPOSURE_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
  const problems=[],missing=[],exact={};
  // Cross-lane rule: every relation and function is owned by the owner of the marker table. Judged only when the marker table exists.
  const markerOwner=relations.find(row=>row.relname===MARKER_TABLE)?.relowner??null;
  if(markerOwner!==null){
    for(const row of relations)if(row.relowner!==markerOwner)problems.push('OWNER_MISMATCH:'+row.relname);
    for(const row of functions)if(row.proowner!==markerOwner)problems.push('OWNER_MISMATCH:'+row.proname);
  }
  for(const row of types)problems.push('TYPE_UNEXPECTED:'+row.typname);
  const tables=relations.filter(row=>TABLES.includes(row.relname));
  for(const row of relations){
    if(TABLES.includes(row.relname)){
      const reasons=await tableDifferences(db,row,row.relname);
      if(reasons.length)problems.push('TABLE_DEFINITION:'+row.relname+':'+reasons.join('+'));
    }else if(row.relkind!=='i')problems.push('RELATION_UNEXPECTED:'+row.relname);
  }
  for(const name of TABLES)if(!relations.some(row=>row.relname===name))missing.push('TABLE_MISSING:'+name);
  for(const row of functions){
    const expected=bodies[row.proname];
    if(row.args.toLowerCase()!==expected.args){problems.push('FUNCTION_UNEXPECTED:'+row.proname+'('+row.args+')');continue;}
    const reasons=functionDifferences(row,expected);
    if(reasons.length)problems.push('FUNCTION_DEFINITION:'+row.proname+':'+reasons.join('+'));
    else exact[row.proname]=row.oid;
  }
  for(const name of FUNCTIONS)
    if(!functions.some(row=>row.proname===name&&row.args.toLowerCase()===bodies[name].args))missing.push('FUNCTION_MISSING:'+name);
  for(const row of triggers){
    const guard=EXPOSURE_GUARDS.find(item=>item[0]===row.tgname&&row.relname===REGISTER_TABLE&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const bound=row.function_schema==='public'&&row.proname===guard[1]&&exact[guard[1]]===row.tgfoid;
    const shaped=row.tgtype===guard[2]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''
      &&row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred&&row.tgoldtable===null&&row.tgnewtable===null;
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name] of EXPOSURE_GUARDS)
    if(!triggers.some(row=>row.tgname===name&&row.relname===REGISTER_TABLE&&row.nspname==='public'))missing.push('TRIGGER_MISSING:'+name);
  for(const name of Object.keys(INDEXES))
    if(!relations.some(row=>row.relname===name))missing.push('INDEX_MISSING:'+name);
  let markerRows=null;
  if(tables.some(row=>row.relname===MARKER_TABLE)&&!problems.some(item=>item.startsWith('TABLE_DEFINITION:'+MARKER_TABLE))){
    markerRows=(await db.query('SELECT version FROM public.'+MARKER_TABLE)).rows;
    if(markerRows.length!==1||markerRows[0].version!==1)problems.push('MARKER_ROW');
  }
  let state;
  if(!relations.length&&!functions.length&&!triggers.length&&!types.length)state='ABSENT';
  else if(problems.length||missing.length)state='OTHER';
  else state='INSTALLED';
  return {state,problems,missing,tables:tables.map(row=>row.relname),exact:Object.keys(exact)};
}

/**
 * Catalog facts and the failures they imply, read only. The runtime-role checks are the shared inspection of runtime-role-inspection.js.
 * With runtimeRole the privilege boundary the register relies on is
 * checked too: the role is not a superuser or BYPASSRLS and is a member of no superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns
 * neither table nor any register function (ownership includes membership of the owning role through pg_has_role MEMBER, which SET ROLE reaches
 * even without inheritance), holds no TRIGGER or TRUNCATE privilege, cannot DELETE from the register (RUNTIME_ROLE_DELETE_PRIVILEGE), cannot write
 * the marker table and (PostgreSQL 15 and later) may not SET session_replication_role. A forbidden privilege counts when any role the runtime
 * role can reach by membership holds it (INHERIT FALSE and a column-level SELECT, INSERT or UPDATE grant included); the role must not own schema
 * public (also as database owner) nor hold CREATE on it. With
 * requireGrants the role must also hold SELECT, INSERT and UPDATE on the register (UPDATE only carries the writer's LOCK TABLE: the
 * trigger refuses every row update) and SELECT on the marker table. The database TEMP privilege is recorded, not judged, because
 * every function pins search_path and the reader qualifies each relation.
 */
export async function inspectQuantExposureRegister(db,{runtimeRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[]};
  const classification=await classifyQuantExposureRegister(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  // The marker function runs only when it is exactly the register SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('quant_exposure_register_version'))
    facts.marker=(await db.query('SELECT public.quant_exposure_register_version() v')).rows[0].v;
  if(facts.marker!==REGISTER_MARKER)failures.push('MARKER_MISSING');
  for(const [name,fn] of EXPOSURE_GUARDS){
    if(!classification.tables.includes(REGISTER_TABLE))continue;
    const row=(await db.query(`SELECT t.tgenabled,p.proname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2 AND NOT t.tgisinternal`,['public.'+REGISTER_TABLE,name])).rows[0];
    facts.guards.push({table:REGISTER_TABLE,name,enabled:row?.tgenabled??null});
    if(row&&row.proname!==fn)failures.push('GUARD_FUNCTION:'+name);
  }
  for(const name of FUNCTIONS){
    const [fn]=(await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=$1 ORDER BY p.oid`,[name])).rows;
    if(!fn)continue;
    facts.functions.push({name,security_definer:fn.prosecdef,search_path:fn.proconfig});
  }
  if(runtimeRole){
    // One shared read-only inspection (src/postgres/runtime-role-inspection.js): ownership by membership, every forbidden privilege through
    // any reachable role (also with INHERIT FALSE and on a single column), privileged membership, CREATE on schema public and session_replication_role.
    const tables=classification.tables.map(name=>name===REGISTER_TABLE
      ?{name,forbidden:['DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT','INSERT','UPDATE']:[]}
      :{name,forbidden:['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT']:[]});
    const inspected=await inspectRuntimeRole(db,{runtimeRole,schema:'public',tables,functions:FUNCTIONS});
    // The register keeps its own failure name for a DELETE privilege.
    failures.push(...inspected.failures.map(item=>item==='RUNTIME_ROLE_WRITE_PRIVILEGE:'+REGISTER_TABLE+':DELETE'?'RUNTIME_ROLE_DELETE_PRIVILEGE:'+REGISTER_TABLE:item));
    if(inspected.found){facts.runtime_role=inspected.facts;facts.server_version_num=inspected.facts.server_version_num;}
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the register objects are exactly absent or exactly the register SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Exposure register '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the register in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The catalog
 * assertions run in the same transaction. Grants are not changed: reapply scripts/grant-postgres-runtime.sql afterwards.
 */
export async function migrateQuantExposureRegister(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Exposure register migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await classifyQuantExposureRegister(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('quant-exposure-register.sql'));
    const report=await inspectQuantExposureRegister(db,{runtimeRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Exposure register verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while the register holds no row. The table is
 * locked ACCESS EXCLUSIVE before the count, so no writer can add evidence between the count and the drop.
 */
export async function rollbackQuantExposureRegister(db){
  if(db.isTransaction)throw Error('Exposure register rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyQuantExposureRegister(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE public.'+REGISTER_TABLE+' IN ACCESS EXCLUSIVE MODE');
      const rows=(await db.query('SELECT count(*)::int n FROM public.'+REGISTER_TABLE)).rows[0].n;
      if(rows>0)throw Error('Exposure register rollback refused; '+rows+' evidence row(s) exist (no change made)');
      await db.query(await sql('quant-exposure-register-rollback.sql'));
    }
    const left=await classifyQuantExposureRegister(db);
    if(left.state!=='ABSENT')throw Error('Exposure register rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
