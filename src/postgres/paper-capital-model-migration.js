import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectRuntimeRole} from './runtime-role-inspection.js';

/**
 * QR-2 S4-1 paper capital model declaration extension. Offline only: the maintenance lock excludes every participating API and worker.
 * The extension is its own (marker table paper_capital_model_schema, version 1); the base schema_version stays 14. The install needs the base
 * schema 14 and the users table only (no research or Pine extension). Nothing calls this module from db.migrate, and no route, store writer or
 * server line uses it yet.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified
 * install could collide with, or silently accept, a foreign object that carries a capital-model name. The states are:
 *   ABSENT     no capital-model relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the capital-model SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (partial, which the contract calls PARTIAL, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra
 *              trigger, a disabled or missing internal foreign key trigger (TABLE_DEFINITION:paper_capital_models:FOREIGN_KEY_TRIGGERS), foreign constraint or index, overload or orphan with a capital-model name, a relation or function owned by a role other
 *              than the owner of the marker table: OWNER_MISMATCH:<name>, a column whose collation is not the database default:
 *              TABLE_DEFINITION:<table>:COLLATION).
 * Run the tool as the schema owner with the default search_path: the deparsed foreign key text names users unqualified only when public is on
 * the search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any declaration row
 * exists unless the caller confirms the live rows by count and by the canonical digest of an earlier export (O12, S4-3; see exportPaperCapitalModel
 * and rollbackPaperCapitalModel). The export file is owner data: keep it outside the repository and outside tracked evidence; evidence records the count and the digest only. Table, constraint and
 * index definitions below are the PostgreSQL 16 deparsed text of a fresh install of paper-capital-model.sql; function bodies are read from that file.
 */
export const PAPER_CAPITAL_MARKER='paper-capital-model-v1';
export const INSERT_ONLY_SQLSTATE='QR002';
export const SERIALIZABLE_SQLSTATE='QR003';
export const INSERT_GUARD_SQLSTATE='QR004';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const MARKER_TABLE='paper_capital_model_schema';
export const DECLARATION_TABLE='paper_capital_models';
const TABLES=[MARKER_TABLE,DECLARATION_TABLE];
/** The QR004 rule families: each raise carries CONSTRAINT = one of these names, so a writer maps the error by name and never by message text. */
export const QR004_GUARDS=Object.freeze(['paper_capital_models_owner','paper_capital_models_version','paper_capital_models_clock','paper_capital_models_bot_set']);
const FUNCTIONS=Object.freeze(['paper_capital_model_version','paper_capital_model_now_ms','paper_capital_model_freeze','paper_capital_model_require_serializable',
  'paper_capital_model_stamp','paper_capital_model_guard']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
const FREEZE_ROW=27,FREEZE_STATEMENT=34,INSERT_ROW=7;
/** [trigger, table, function, tgtype] */
export const PAPER_CAPITAL_GUARDS=Object.freeze([
 ['paper_capital_model_schema_no_change',MARKER_TABLE,'paper_capital_model_freeze',FREEZE_ROW],
 ['paper_capital_model_schema_no_truncate',MARKER_TABLE,'paper_capital_model_freeze',FREEZE_STATEMENT],
 ['paper_capital_models_no_change',DECLARATION_TABLE,'paper_capital_model_freeze',FREEZE_ROW],
 ['paper_capital_models_no_truncate',DECLARATION_TABLE,'paper_capital_model_freeze',FREEZE_STATEMENT],
 ['paper_capital_models_00_serializable',DECLARATION_TABLE,'paper_capital_model_require_serializable',INSERT_ROW],
 ['paper_capital_models_10_stamp',DECLARATION_TABLE,'paper_capital_model_stamp',INSERT_ROW],
 ['paper_capital_models_20_guard',DECLARATION_TABLE,'paper_capital_model_guard',INSERT_ROW]]);
const INDEXES=Object.freeze({
 paper_capital_model_schema_pkey:'CREATE UNIQUE INDEX paper_capital_model_schema_pkey ON public.paper_capital_model_schema USING btree (version)',
 paper_capital_models_pkey:'CREATE UNIQUE INDEX paper_capital_models_pkey ON public.paper_capital_models USING btree (owner_id, currency, version)'});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const COLUMNS=Object.freeze({
 [MARKER_TABLE]:[col('version','integer',true)],
 [DECLARATION_TABLE]:[col('owner_id','text',true),col('currency','text',true),col('version','bigint',true),col('capital_model','text',true),col('bot_set','jsonb',true),
  col('effective_from','bigint',true),col('declared_at','bigint',true),col('declared_by','text',true)]});
const CONSTRAINTS=Object.freeze({
 [MARKER_TABLE]:{
  paper_capital_model_schema_pkey:['p','PRIMARY KEY (version)'],
  paper_capital_model_schema_version_check:['c','CHECK ((version = 1))']},
 [DECLARATION_TABLE]:{
  paper_capital_models_pkey:['p','PRIMARY KEY (owner_id, currency, version)'],
  paper_capital_models_owner_id_fkey:['f','FOREIGN KEY (owner_id) REFERENCES users(id)'],
  paper_capital_models_declared_by_fkey:['f','FOREIGN KEY (declared_by) REFERENCES users(id)'],
  paper_capital_models_currency_check:['c',"CHECK ((currency = ANY (ARRAY['USDT'::text, 'THB'::text])))"],
  paper_capital_models_version_check:['c','CHECK (((version >= 1) AND (version <= 1000)))'],
  paper_capital_models_capital_model_check:['c',"CHECK ((capital_model = ANY (ARRAY['INDEPENDENT_ACCOUNTS'::text, 'SHARED_HYPOTHETICAL'::text])))"],
  paper_capital_models_bot_set_check:['c',"CHECK (\nCASE\n    WHEN (jsonb_typeof(bot_set) = 'array'::text) THEN ((jsonb_array_length(bot_set) >= 1) AND (jsonb_array_length(bot_set) <= 5))\n    ELSE false\nEND)"],
  paper_capital_models_effective_from_check:['c',"CHECK (((effective_from >= 0) AND (effective_from <= '253402300799999'::bigint) AND ((effective_from % (86400000)::bigint) = 0)))"],
  paper_capital_models_declared_at_check:['c',"CHECK (((declared_at >= 0) AND (declared_at <= '253402300799999'::bigint)))"]}});
// The internal referential-integrity triggers of the two foreign keys of the declaration table, as a fresh PostgreSQL 16 install creates them:
// per key two triggers on the declaration table (insert and update check) and two on users (delete and update no-action), all enabled (tgenabled O).
// Each item is table|key|RI function|tgtype; tgtype bits: ROW 1, INSERT 4, DELETE 8, UPDATE 16, all AFTER.
const RI_TRIGGERS=Object.freeze(['paper_capital_models_declared_by_fkey','paper_capital_models_owner_id_fkey'].flatMap(key=>[
 ['paper_capital_models',key,'RI_FKey_check_ins',5],['paper_capital_models',key,'RI_FKey_check_upd',17],
 ['users',key,'RI_FKey_noaction_del',9],['users',key,'RI_FKey_noaction_upd',17]].map(item=>item.join('|'))).sort());
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireBase(db){
  if(!await exists(db,'users'))throw Error('Base schema required: table users is missing');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the capital-model SQL file itself. */
async function expectedFunctions(){
  const text=await sql('paper-capital-model.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS (\\w+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Paper capital model definition not found: '+name);
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
// Triggers that carry a capital-model name on any table, triggers bound to a capital-model function under any name, and every other
// non-internal trigger on a capital-model table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the capital-model SQL; an empty list means exact. */
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
  if(table===DECLARATION_TABLE){
    // A disabled or missing internal foreign key trigger (DISABLE TRIGGER ALL by a superuser) leaves the constraint text intact but unenforced.
    const ri=(await db.query(`SELECT c.relname,k.conname,p.proname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,t.tgnargs,t.tgattr::text AS columns
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgisinternal AND k.contype='f' AND k.conrelid=$1 AND c.relnamespace='public'::regnamespace AND p.pronamespace='pg_catalog'::regnamespace`,[relation.oid])).rows;
    const found=ri.map(row=>[row.relname,row.conname,row.proname,row.tgtype].join('|')).sort();
    if(found.length!==RI_TRIGGERS.length||found.some((item,index)=>item!==RI_TRIGGERS[index])
      ||ri.some(row=>row.tgenabled!=='O'||row.tgdeferrable||row.tginitdeferred||row.tgnargs!==0||row.columns!==''))reasons.push('FOREIGN_KEY_TRIGGERS');
  }
  return reasons;
}

/**
 * Read-only exact classification of every capital-model object. state is ABSENT, INSTALLED or OTHER. problems lists present objects
 * that are not exactly the capital-model SQL, missing lists expected objects that do not exist. Never calls a capital-model function.
 */
export async function classifyPaperCapitalModel(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[PAPER_CAPITAL_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
  const problems=[],missing=[],exact={};
  // Every relation and function is owned by the owner of the marker table, so a re-owned object cannot hide a change the owner would not make.
  // Judged only when the marker table exists.
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
    const guard=PAPER_CAPITAL_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''
      &&row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred&&row.tgoldtable===null&&row.tgnewtable===null;
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of PAPER_CAPITAL_GUARDS)
    if(!triggers.some(row=>row.tgname===name&&row.relname===table&&row.nspname==='public'))missing.push('TRIGGER_MISSING:'+name);
  for(const name of Object.keys(INDEXES))
    if(!relations.some(row=>row.relname===name))missing.push('INDEX_MISSING:'+name);
  if(tables.some(row=>row.relname===MARKER_TABLE)&&!problems.some(item=>item.startsWith('TABLE_DEFINITION:'+MARKER_TABLE))){
    const markerRows=(await db.query('SELECT version FROM public.'+MARKER_TABLE)).rows;
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
 * With runtimeRole the privilege boundary the extension relies on is checked too: the role is not a superuser or BYPASSRLS and is a member of
 * no superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns no capital-model table or function (ownership includes membership of the
 * owning role through pg_has_role MEMBER, which SET ROLE reaches even without inheritance), holds no TRIGGER or TRUNCATE privilege, no UPDATE and
 * no DELETE on the declaration table, cannot write the marker table and (PostgreSQL 15 and later) may not SET session_replication_role. A
 * forbidden privilege counts when any role the runtime role can reach by membership holds it (INHERIT FALSE and a column-level grant included);
 * the role must not own schema public (also as database owner) nor hold CREATE on it. With requireGrants the role must also hold SELECT and
 * INSERT on the declaration table and SELECT on the marker table.
 */
export async function inspectPaperCapitalModel(db,{runtimeRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[]};
  const classification=await classifyPaperCapitalModel(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  // The marker function runs only when it is exactly the capital-model SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('paper_capital_model_version'))
    facts.marker=(await db.query('SELECT public.paper_capital_model_version() v')).rows[0].v;
  if(facts.marker!==PAPER_CAPITAL_MARKER)failures.push('MARKER_MISSING');
  for(const [name,table,fn] of PAPER_CAPITAL_GUARDS){
    if(!classification.tables.includes(table))continue;
    const row=(await db.query(`SELECT t.tgenabled,p.proname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2 AND NOT t.tgisinternal`,['public.'+table,name])).rows[0];
    facts.guards.push({table,name,enabled:row?.tgenabled??null});
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
    const tables=classification.tables.map(name=>name===MARKER_TABLE
      ?{name,forbidden:['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT']:[]}
      :{name,forbidden:['UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT','INSERT']:[]});
    const inspected=await inspectRuntimeRole(db,{runtimeRole,schema:'public',tables,functions:FUNCTIONS});
    failures.push(...inspected.failures);
    if(inspected.found){facts.runtime_role=inspected.facts;facts.server_version_num=inspected.facts.server_version_num;}
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the capital-model objects are exactly absent or exactly the capital-model SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Paper capital model '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the extension in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The catalog
 * assertions run in the same transaction. Grants are not changed: reapply scripts/grant-postgres-runtime.sql afterwards.
 */
export async function migratePaperCapitalModel(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Paper capital model migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireBase(db);
    const before=await classifyPaperCapitalModel(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('paper-capital-model.sql'));
    const report=await inspectPaperCapitalModel(db,{runtimeRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Paper capital model verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * The canonical export of the declarations (O12), shared by the export file and the rollback confirmation so both compute one digest.
 * Recipe: every row of public.paper_capital_models ordered by owner_id, currency (both COLLATE "C", so the order never depends on the cluster
 * locale) and version; one line per row, a JSON object with exactly these keys in this order: owner_id, currency, version, capital_model, bot_set
 * (the stored JSONB array, element order kept), effective_from, declared_at, declared_by; version, effective_from and declared_at are JSON numbers
 * (the table CHECKs keep them below 2^53, a larger value throws); each line ends with LF; the text is UTF-8. sha256 is the SHA-256 of those exact
 * bytes, so it equals the SHA-256 of an export file. No rows give an empty file and the digest of the empty byte string.
 */
export const CANONICAL_EXPORT_KEYS=Object.freeze(['owner_id','currency','version','capital_model','bot_set','effective_from','declared_at','declared_by']);
const exactInteger=(text,name)=>{
  const value=Number(text);
  if(!Number.isSafeInteger(value)||String(value)!==text)throw Error('Paper capital model export refused; '+name+' is not an exact integer');
  return value;
};
export function canonicalDeclarationLine(row){
  return JSON.stringify({owner_id:row.owner_id,currency:row.currency,version:exactInteger(row.version,'version'),capital_model:row.capital_model,bot_set:row.bot_set,
    effective_from:exactInteger(row.effective_from,'effective_from'),declared_at:exactInteger(row.declared_at,'declared_at'),declared_by:row.declared_by})+'\n';
}
/** Reads every declaration through db.query (a READ ONLY snapshot for the export, the ACCESS EXCLUSIVE lock for the rollback) and digests it. */
export async function readCanonicalDeclarations(db){
  const result=await db.query(`SELECT owner_id,currency,version::text AS version,capital_model,bot_set,effective_from::text AS effective_from,declared_at::text AS declared_at,declared_by
    FROM public.${DECLARATION_TABLE} ORDER BY owner_id COLLATE "C",currency COLLATE "C",version`);
  const bytes=Buffer.from(result.rows.map(canonicalDeclarationLine).join(''),'utf8');
  return {rows:result.rows.length,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};
}

const repositoryRoot=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const outsideOf=relative=>relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);
/**
 * Where an export path falls: INSIDE (under the repository, refused), QA_LOCAL (under the ignored .qa-local, allowed) or OUTSIDE (allowed).
 * "Outside" means the relative path is exactly '..', starts with '..' plus a separator, or is absolute, so a repository directory named '..x' is inside.
 */
export function exportPathPlacement(output,root=repositoryRoot){
  const inside=path.relative(root,output);
  if(outsideOf(inside))return 'OUTSIDE';
  return inside!==''&&inside.split(path.sep)[0]==='.qa-local'?'QA_LOCAL':'INSIDE';
}
/**
 * O12 step 1: writes the canonical export of every declaration to a NEW file and returns {rows,sha256}. One READ ONLY REPEATABLE READ transaction on
 * a pool connection (so the classification and the rows come from one snapshot); no maintenance lock and no write, so it is safe beside running
 * services. The file is created exclusively with mode 0600 BEFORE the database is read, so an existing path is refused untouched; a failure
 * after that removes only the file this call created. The export holds owner and Bot ids: a path inside the repository is refused unless it is
 * under .qa-local (ignored), and the custody of a real export stays an owner item (OW9). Needs state INSTALLED.
 */
export async function exportPaperCapitalModel(db,target){
  if(db.isTransaction)throw Error('Paper capital model export requires its own connection');
  if(typeof target!=='string'||target.trim()==='')throw Error('Paper capital model export needs a new file path');
  const output=path.resolve(target);
  const refusal=Error('Paper capital model export refused; the path is inside the repository (use a protected path outside it)');
  if(exportPathPlacement(output)==='INSIDE')throw refusal;
  // The same rule on real paths: a link, a short (8.3) name or an extended-length prefix cannot hide a repository path. The directory must exist.
  const realOutput=path.join(realpathSync.native(path.dirname(output)),path.basename(output));
  if(exportPathPlacement(realOutput,realpathSync.native(repositoryRoot))==='INSIDE')throw refusal;
  const handle=await fs.open(output,'wx',0o600);
  try{
    const client=await db.pool.connect();
    let exported;
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const reader={query:(text,params)=>client.query(text,params)};
      const classification=await classifyPaperCapitalModel(reader);
      if(classification.state!=='INSTALLED')
        throw Error('Paper capital model export refused; state '+classification.state+' (nothing exported): '+[...classification.problems,...classification.missing].join(', '));
      exported=await readCanonicalDeclarations(reader);
    }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
    await handle.writeFile(exported.bytes);await handle.sync();await handle.close();
    const written=createHash('sha256').update(await fs.readFile(output)).digest('hex');
    if(written!==exported.sha256)throw Error('Paper capital model export failed; the written file does not match the digest');
    return {rows:exported.rows,sha256:exported.sha256};
  }catch(error){
    await handle.close().catch(()=>{});await fs.unlink(output).catch(()=>{});
    throw error;
  }
}

/**
 * Drops exactly the objects the install created, after classifying first. The table is locked ACCESS EXCLUSIVE before the count, so no writer can
 * add a declaration between the count and the drop. The marker row is not a declaration.
 * Without confirm the rollback works only while the declaration table holds no row. With confirm={rows,sha256} (O12 step 2, from an earlier export)
 * the live rows are counted and digested under the lock with the same canonical recipe as the export, and the objects are dropped only when both
 * equal the confirmation; any difference refuses with no change and without printing the live digest. The rollback SQL repeats the count under
 * the same lock through the transaction-local setting paper_capital_model.rollback_confirm_rows, which only this function sets as '<rows>:<current transaction id>';
 * the SQL refuses unless both parts match, so a database-level or session setting cannot confirm a drop.
 */
export async function rollbackPaperCapitalModel(db,{confirm}={}){
  if(db.isTransaction)throw Error('Paper capital model rollback requires its own transaction');
  if(confirm!==undefined){
    if(!confirm||!Number.isSafeInteger(confirm.rows)||confirm.rows<0||!/^[0-9a-f]{64}$/.test(String(confirm.sha256)))
      throw Error('Paper capital model rollback refused; the confirmation needs a row count and a sha256 (no change made)');
  }
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyPaperCapitalModel(db);
    requireKnownState(before,'rollback');
    let confirmedRows=null;
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE public.'+DECLARATION_TABLE+' IN ACCESS EXCLUSIVE MODE');
      if(confirm===undefined){
        const rows=(await db.query('SELECT count(*)::int n FROM public.'+DECLARATION_TABLE)).rows[0].n;
        if(rows>0)throw Error('Paper capital model rollback refused; '+rows+' declaration row(s) exist (no change made)');
      }else{
        const live=await readCanonicalDeclarations(db);
        const differs=[live.rows!==confirm.rows?'row count':null,live.sha256!==confirm.sha256?'digest':null].filter(Boolean);
        if(differs.length)throw Error('Paper capital model rollback refused; the confirmation does not match the live declaration rows: '+differs.join(' and ')+' (no change made)');
        confirmedRows=live.rows;
        if(live.rows>0)await db.query("SELECT pg_catalog.set_config('paper_capital_model.rollback_confirm_rows',$1::text||':'||pg_catalog.pg_current_xact_id()::text,true)",[String(live.rows)]);
      }
      await db.query(await sql('paper-capital-model-rollback.sql'));
    }
    const left=await classifyPaperCapitalModel(db);
    if(left.state!=='ABSENT')throw Error('Paper capital model rollback left objects behind');
    return {rolled_back:true,previous_state:before.state,...(confirm!==undefined&&before.state==='INSTALLED'?{confirmed_rows:confirmedRows}:{})};
  });
}
