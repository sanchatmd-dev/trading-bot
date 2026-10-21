import fs from 'node:fs/promises';
import {inspectRuntimeRole,TABLE_PRIVILEGES} from './runtime-role-inspection.js';
import {foreignKeyTriggerFailures} from './fk-trigger-inspection.js';
import {classifyMpMemberSet,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,PINNED_SEARCH_PATH} from './mp-member-set-migration.js';

/**
 * F11-01 internal multi-Pine run store, slice RS-1: insert-only run and run-event tables (RD-MP-2 option B). Offline only: the maintenance lock excludes every
 * participating API and worker. The run store is its own extension (marker table mp_run_store_schema, version 1); the base schema_version stays 14. It
 * depends on the member-set extension (mp_member_set_schema version 1), which must be INSTALLED, and on the base users table; it has no dependency on the
 * quant job schema. Nothing calls this module from db.migrate. The foreign keys name mp_member_sets and users, so the member-set rollback fails loudly
 * while this extension is installed; roll back the run store first (uninstall order: run store before member set). The foreign keys add PostgreSQL-internal
 * referential-integrity triggers to mp_member_sets and users; the member-set classifier judges only the keys of its own tables and stays INSTALLED.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified install could collide
 * with, or silently accept, a foreign object that carries a run-store name. The states are:
 *   ABSENT     no run-store relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the run-store SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (a derived object that could expose run-store rows: inheritance on either side, a foreign key from a table outside the run
 *              store, a publication membership, a view, rule or materialized view outside the extension that depends on a run-store table: TABLE_DEFINITION:<table>:
 *              INHERITANCE, REFERENCED_BY, PUBLICATION, DEPENDENT_VIEW; a role without SELECT on the marker table cannot read the marker row: MARKER_UNREADABLE; partial, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra trigger, foreign constraint or index, overload or
 *              orphan with a run-store name, a relation or function owned by a role other than the owner of the marker table: OWNER_MISMATCH:<name>, a column
 *              whose collation is not the database default: TABLE_DEFINITION:<table>:COLLATION).
 * Foreign keys are judged by their internal referential-integrity triggers too (fk-trigger-inspection.js): a disabled, dropped or reshaped one, on a run-store
 * table or on a referenced table, classifies OTHER (TABLE_DEFINITION:<table>:FOREIGN_KEY_TRIGGERS). Run the tool as the schema owner with the default
 * search_path: the deparsed foreign key text names users and mp_member_sets unqualified only when public is on the search_path, otherwise the install
 * classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any run or event row exists
 * (insert-only records are never dropped by this tool). Table, constraint and index definitions below are the PostgreSQL 16 deparsed text of a fresh install of
 * mp-run-store.sql; function bodies are read from that file itself.
 *
 * Privilege boundary (root decision S4, grant model B2): the runtime role holds no privilege at all on the run-store tables (scripts/grant-postgres-runtime.sql
 * category internal_only). A separate fixture role (scripts/grant-postgres-mp-fixture.sql, isolated clusters only) holds SELECT and INSERT on the two record
 * tables and SELECT on the marker. The inspection checks both roles and fails with RUNTIME_ROLE_REACHES_FIXTURE_ROLE when the runtime role can reach the
 * fixture role by membership.
 */
export const RUN_STORE_MARKER='mp-run-store-v1-schema';
export {INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,PINNED_SEARCH_PATH};
export const MARKER_TABLE='mp_run_store_schema';
/** The two insert-only record tables, run first (the order the grant scripts and the inspection use). */
export const RUN_STORE_TABLES=Object.freeze(['mp_research_runs','mp_research_run_events']);
/** The guard triggers that raise QR004 with CONSTRAINT = their own name; a writer maps the error by this name. */
export const QR004_GUARDS=Object.freeze(['mp_research_runs_guard','mp_research_runs_set_stale','mp_research_runs_complete','mp_research_run_events_order',
  'mp_research_run_events_result','mp_research_run_events_transition']);
const TABLES=[MARKER_TABLE,...RUN_STORE_TABLES];
const FUNCTIONS=Object.freeze(['mp_run_store_version','mp_run_store_freeze','mp_run_store_require_serializable','mp_run_store_guard_run','mp_run_store_guard_stale',
  'mp_run_store_guard_complete','mp_run_store_guard_order','mp_run_store_guard_result','mp_run_store_guard_transition']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. A constraint trigger is AFTER ROW INSERT, deferrable and initially deferred.
const FREEZE_ROW=27,FREEZE_STATEMENT=34,INSERT_GUARD=7,DEFERRED_AFTER_INSERT=5;
export const RUN_STORE_GUARDS=Object.freeze([
 ["mp_research_run_events_00_serializable","mp_research_run_events","mp_run_store_require_serializable",INSERT_GUARD,false],
 ["mp_research_run_events_no_change","mp_research_run_events","mp_run_store_freeze",FREEZE_ROW,false],
 ["mp_research_run_events_no_truncate","mp_research_run_events","mp_run_store_freeze",FREEZE_STATEMENT,false],
 ["mp_research_run_events_order","mp_research_run_events","mp_run_store_guard_order",INSERT_GUARD,false],
 ["mp_research_run_events_result","mp_research_run_events","mp_run_store_guard_result",INSERT_GUARD,false],
 ["mp_research_run_events_transition","mp_research_run_events","mp_run_store_guard_transition",INSERT_GUARD,false],
 ["mp_research_runs_00_serializable","mp_research_runs","mp_run_store_require_serializable",INSERT_GUARD,false],
 ["mp_research_runs_complete","mp_research_runs","mp_run_store_guard_complete",DEFERRED_AFTER_INSERT,true],
 ["mp_research_runs_guard","mp_research_runs","mp_run_store_guard_run",INSERT_GUARD,false],
 ["mp_research_runs_no_change","mp_research_runs","mp_run_store_freeze",FREEZE_ROW,false],
 ["mp_research_runs_no_truncate","mp_research_runs","mp_run_store_freeze",FREEZE_STATEMENT,false],
 ["mp_research_runs_set_stale","mp_research_runs","mp_run_store_guard_stale",INSERT_GUARD,false],
 ["mp_run_store_schema_00_serializable","mp_run_store_schema","mp_run_store_require_serializable",INSERT_GUARD,false],
 ["mp_run_store_schema_no_change","mp_run_store_schema","mp_run_store_freeze",FREEZE_ROW,false],
 ["mp_run_store_schema_no_truncate","mp_run_store_schema","mp_run_store_freeze",FREEZE_STATEMENT,false]
]);
export const FREEZE_TRIGGERS=Object.freeze(RUN_STORE_GUARDS.filter(item=>item[2]==='mp_run_store_freeze'));
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const COLUMNS=Object.freeze({
 mp_run_store_schema:[col("version","integer",true)],
 mp_research_runs:[col("run_id","uuid",true),col("owner_id","text",true),col("bot_id","text",true),col("member_set_id","uuid",true),col("set_hash","text",true),col("membership_hash","text",true),col("pine_count","smallint",true),col("contract_version","text",true),col("contract","jsonb",true),col("contract_hash","text",true),col("idempotency_key","text",true),col("submission_hash","text",true),col("engine_hash","text",true),col("dataset_content_digest","text",true),col("created_at_ms","bigint",true),col("deadline_ms","bigint",true),col("fixture","boolean",true)],
 mp_research_run_events:[col("run_id","uuid",true),col("seq","integer",true),col("status","text",true),col("at_ms","bigint",true),col("reason_code","text",false),col("result","jsonb",false),col("result_hash","text",false)],
});
const CONSTRAINTS=Object.freeze({
 mp_run_store_schema:{
  mp_run_store_schema_pkey:["p","PRIMARY KEY (version)"],
  mp_run_store_schema_version_check:["c","CHECK ((version = 1))"]},
 mp_research_runs:{
  mp_research_runs_bot_id_fkey:["f","FOREIGN KEY (bot_id) REFERENCES users(id)"],
  mp_research_runs_contract_check:["c","CHECK ((jsonb_typeof(contract) = 'object'::text))"],
  mp_research_runs_contract_hash_check:["c","CHECK ((contract_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_research_runs_contract_size_check:["c","CHECK ((pg_column_size(contract) <= 262144))"],
  mp_research_runs_contract_ties_check:["c","CHECK (COALESCE((((contract -> 'version'::text) = to_jsonb(contract_version)) AND ((contract -> 'mode'::text) = '\"MULTI_PINE\"'::jsonb) AND ((contract -> 'owner_id'::text) = to_jsonb(owner_id)) AND ((contract -> 'bot_id'::text) = to_jsonb(bot_id)) AND ((contract -> 'member_set_id'::text) = to_jsonb((member_set_id)::text)) AND ((contract -> 'set_hash'::text) = to_jsonb(set_hash)) AND ((contract -> 'membership_hash'::text) = to_jsonb(membership_hash)) AND ((contract -> 'pine_count'::text) = to_jsonb(pine_count)) AND ((contract -> 'engine_hash'::text) = to_jsonb(engine_hash)) AND (((contract -> 'dataset'::text) -> 'content_digest'::text) = to_jsonb(dataset_content_digest)) AND ((contract -> 'fixture'::text) = 'true'::jsonb) AND ((contract -> 'same_bar_order'::text) = '\"exit-first-ordinal-v1\"'::jsonb) AND\nCASE\n    WHEN (jsonb_typeof((contract -> 'acceptance_blockers'::text)) = 'array'::text) THEN ((contract -> 'acceptance_blockers'::text) ? 'MULTI_PINE_REQUIRES_APP_3B'::text)\n    ELSE false\nEND AND\nCASE\n    WHEN (jsonb_typeof((contract -> 'members'::text)) = 'array'::text) THEN (jsonb_array_length((contract -> 'members'::text)) = pine_count)\n    ELSE false\nEND AND (contract ?& ARRAY['version'::text, 'mode'::text, 'pine_count'::text, 'member_set_id'::text, 'set_hash'::text, 'membership_hash'::text, 'members'::text, 'owner_id'::text, 'bot_id'::text, 'policy_hash'::text, 'funding_cutoff'::text, 'capital'::text, 'model'::text, 'rules'::text, 'engine_hash'::text, 'dataset'::text, 'split'::text, 'budget'::text, 'seed'::text, 'bridge_domains'::text, 'same_bar_order'::text, 'fixture'::text, 'acceptance_blockers'::text]) AND ((contract - ARRAY['version'::text, 'mode'::text, 'pine_count'::text, 'member_set_id'::text, 'set_hash'::text, 'membership_hash'::text, 'members'::text, 'owner_id'::text, 'bot_id'::text, 'policy_hash'::text, 'funding_cutoff'::text, 'capital'::text, 'model'::text, 'rules'::text, 'engine_hash'::text, 'dataset'::text, 'split'::text, 'budget'::text, 'seed'::text, 'bridge_domains'::text, 'same_bar_order'::text, 'fixture'::text, 'acceptance_blockers'::text]) = '{}'::jsonb) AND (NOT (contract ?| ARRAY['deployment_id'::text, 'pine_import_id'::text, 'source_version'::text]))), false))"],
  mp_research_runs_contract_version_check:["c","CHECK ((contract_version = 'ql3a-research-job-multi-v1'::text))"],
  mp_research_runs_created_at_ms_check:["c","CHECK (((created_at_ms >= 1) AND (created_at_ms <= '8640000000000000'::bigint)))"],
  mp_research_runs_dataset_content_digest_check:["c","CHECK ((dataset_content_digest ~ '^[0-9a-f]{64}$'::text))"],
  mp_research_runs_deadline_ms_check:["c","CHECK (((deadline_ms >= (created_at_ms + 60000)) AND (deadline_ms <= (created_at_ms + 900000))))"],
  mp_research_runs_engine_hash_check:["c","CHECK ((engine_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_research_runs_fixture_check:["c","CHECK (fixture)"],
  mp_research_runs_idempotency_key:["u","UNIQUE (owner_id, bot_id, idempotency_key)"],
  mp_research_runs_idempotency_key_check:["c","CHECK ((idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'::text))"],
  mp_research_runs_membership_hash_check:["c","CHECK ((membership_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_research_runs_owner_id_fkey:["f","FOREIGN KEY (owner_id) REFERENCES users(id)"],
  mp_research_runs_pine_count_check:["c","CHECK (((pine_count >= 2) AND (pine_count <= 3)))"],
  mp_research_runs_pkey:["p","PRIMARY KEY (run_id)"],
  mp_research_runs_set_fkey:["f","FOREIGN KEY (member_set_id, owner_id, bot_id) REFERENCES mp_member_sets(member_set_id, owner_id, bot_id)"],
  mp_research_runs_set_hash_check:["c","CHECK ((set_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_research_runs_set_hash_fkey:["f","FOREIGN KEY (member_set_id, set_hash) REFERENCES mp_member_sets(member_set_id, set_hash)"],
  mp_research_runs_submission_hash_check:["c","CHECK ((submission_hash ~ '^[0-9a-f]{64}$'::text))"]},
 mp_research_run_events:{
  mp_research_run_events_at_ms_check:["c","CHECK (((at_ms >= 1) AND (at_ms <= '8640000000000000'::bigint)))"],
  mp_research_run_events_pkey:["p","PRIMARY KEY (run_id, seq)"],
  mp_research_run_events_reason_code_check:["c","CHECK (((reason_code IS NULL) OR (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text)))"],
  mp_research_run_events_result_check:["c","CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text)))"],
  mp_research_run_events_result_hash_check:["c","CHECK (((result_hash IS NULL) OR (result_hash ~ '^[0-9a-f]{64}$'::text)))"],
  mp_research_run_events_result_size_check:["c","CHECK (((result IS NULL) OR (pg_column_size(result) <= 1048576)))"],
  mp_research_run_events_run_fkey:["f","FOREIGN KEY (run_id) REFERENCES mp_research_runs(run_id)"],
  mp_research_run_events_seq_check:["c","CHECK (((seq >= 1) AND (seq <= 64)))"],
  mp_research_run_events_status_check:["c","CHECK ((status = ANY (ARRAY['ADMITTED'::text, 'RUNNING'::text, 'SUCCEEDED'::text, 'NO_VALID_CANDIDATE'::text, 'FAILED'::text, 'CANCELLED'::text, 'TIMED_OUT'::text])))"]},
});
const INDEXES=Object.freeze({
 mp_research_run_events_pkey:"CREATE UNIQUE INDEX mp_research_run_events_pkey ON public.mp_research_run_events USING btree (run_id, seq)",
 mp_research_runs_idempotency_key:"CREATE UNIQUE INDEX mp_research_runs_idempotency_key ON public.mp_research_runs USING btree (owner_id, bot_id, idempotency_key)",
 mp_research_runs_pkey:"CREATE UNIQUE INDEX mp_research_runs_pkey ON public.mp_research_runs USING btree (run_id)",
 mp_run_store_schema_pkey:"CREATE UNIQUE INDEX mp_run_store_schema_pkey ON public.mp_run_store_schema USING btree (version)"});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireBase(db){
  for(const table of ['users','mp_member_set_schema','mp_member_sets','mp_member_set_members'])
    if(!await exists(db,table))throw Error('Multi-Pine member-set extension 1 required: table '+table+' is missing');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the run-store SQL file itself. */
async function expectedFunctions(){
  const text=await sql('mp-run-store.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS ([\\w\\[\\]]+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Run-store definition not found: '+name);
    out[name]={args:match[1].trim().toLowerCase(),returns:match[2].toLowerCase(),language:match[3].toLowerCase(),volatility:match[4]?'i':'v',body:match[5]};
  }
  return out;
}

const RELATION_ROWS=`SELECT c.oid,c.relname,c.relkind,c.relowner,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relhasrules,c.relispartition,c.relhassubclass,c.reloptions
  FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) ORDER BY c.relname`;
const FUNCTION_ROWS=`SELECT p.oid,p.proname,p.proowner,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.proisstrict,p.proretset,p.prokind,p.proparallel,
  l.lanname,p.prorettype::regtype::text AS returns,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) ORDER BY p.proname,p.oid`;
// Triggers that carry a run-store name on any table, triggers bound to a run-store function under any name, and every other non-internal trigger on a run-store table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,
  (SELECT k.contype FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint) AS constraint_type
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the run-store SQL; an empty list means exact. */
function functionDifferences(row,expected){
  const reasons=[];
  if(row.prosecdef!==false)reasons.push('SECURITY_DEFINER');
  if(!(Array.isArray(row.proconfig)&&row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))reasons.push('SEARCH_PATH');
  if(normalize(row.prosrc)!==normalize(expected.body))reasons.push('BODY');
  if(row.lanname!==expected.language||row.returns.toLowerCase()!==expected.returns||row.provolatile!==expected.volatility||row.proleakproof!==false
    ||row.proisstrict!==false||row.proretset!==false||row.prokind!=='f'||row.proparallel!=='u')reasons.push('ATTRIBUTES');
  return reasons;
}

// Derived objects that can expose run-store rows to a role that holds no privilege on the run-store tables: a privilege check on a parent, a view, a publication or a
// referencing table is not a privilege on the run-store table. $1 is the table oid, $2 the oids of all run-store tables (their own keys and rules are not derived objects).
const DERIVED_ROWS=`SELECT
  EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=$1 OR i.inhparent=$1) AS inheritance,
  EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.contype='f' AND k.confrelid=$1 AND k.conrelid<>ALL($2::oid[])) AS referenced_by,
  (EXISTS(SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables) OR EXISTS(SELECT 1 FROM pg_catalog.pg_publication_rel p WHERE p.prrelid=$1)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_publication_namespace pn WHERE pn.pnnspid='public'::regnamespace)) AS publication,
  EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_rewrite w ON d.classid='pg_catalog.pg_rewrite'::regclass AND d.objid=w.oid
    WHERE d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=$1 AND w.ev_class<>ALL($2::oid[])) AS dependent_view`;

async function tableDifferences(db,relation,table,tableOids){
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
  // Constraint triggers own a pg_constraint row of type t; the trigger classification judges them.
  const constraints=(await db.query(`SELECT c.conname,c.contype,pg_catalog.pg_get_constraintdef(c.oid) AS def,c.condeferrable,c.condeferred,c.convalidated
    FROM pg_catalog.pg_constraint c WHERE c.conrelid=$1 AND c.contype<>'t' ORDER BY c.conname`,[relation.oid])).rows;
  const wanted=CONSTRAINTS[table];
  if(constraints.length!==Object.keys(wanted).length||constraints.some(row=>!wanted[row.conname]||row.contype!==wanted[row.conname][0]||row.def!==wanted[row.conname][1]
    ||row.condeferrable||row.condeferred||!row.convalidated))reasons.push('CONSTRAINTS');
  const indexes=(await db.query(`SELECT ic.relname,pg_catalog.pg_get_indexdef(i.indexrelid) AS def,i.indisvalid,i.indisready
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=$1 ORDER BY ic.relname`,[relation.oid])).rows;
  const wantedIndexes=Object.entries(INDEXES).filter(([,def])=>def.includes(' ON public.'+table+' '));
  if(indexes.length!==wantedIndexes.length||indexes.some(row=>INDEXES[row.relname]!==row.def||!row.indisvalid||!row.indisready))reasons.push('INDEXES');
  // A disabled or missing internal foreign key trigger (DISABLE TRIGGER ALL by a superuser) leaves the constraint text intact but unenforced. Both sides of each key are checked.
  if((await foreignKeyTriggerFailures(db,relation.oid,Object.entries(wanted).filter(([,item])=>item[0]==='f').map(([name])=>name))).length)reasons.push('FOREIGN_KEY_TRIGGERS');
  const derived=(await db.query(DERIVED_ROWS,[relation.oid,tableOids])).rows[0];
  if(derived.inheritance)reasons.push('INHERITANCE');
  if(derived.referenced_by)reasons.push('REFERENCED_BY');
  if(derived.publication)reasons.push('PUBLICATION');
  if(derived.dependent_view)reasons.push('DEPENDENT_VIEW');
  return reasons;
}

/**
 * Read-only exact classification of every run-store object. state is ABSENT, INSTALLED or OTHER. problems lists present objects that are not exactly
 * the run-store SQL, missing lists expected objects that do not exist. Never calls a run-store function.
 */
export async function classifyMpRunStore(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[RUN_STORE_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
  const problems=[],missing=[],exact={};
  for(const row of types)problems.push('TYPE_UNEXPECTED:'+row.typname);
  const tables=relations.filter(row=>TABLES.includes(row.relname));
  const tableOids=tables.map(row=>row.oid);
  for(const row of relations){
    if(TABLES.includes(row.relname)){
      const reasons=await tableDifferences(db,row,row.relname,tableOids);
      if(reasons.length)problems.push('TABLE_DEFINITION:'+row.relname+':'+reasons.join('+'));
    }else if(row.relkind!=='i')problems.push('RELATION_UNEXPECTED:'+row.relname);
  }
  for(const name of TABLES)if(!relations.some(row=>row.relname===name))missing.push('TABLE_MISSING:'+name);
  // Every relation and function is owned by the owner of the marker table, so a re-owned object cannot hide a change the owner would not make.
  const markerOwner=relations.find(row=>row.relname===MARKER_TABLE)?.relowner;
  if(markerOwner!==undefined){
    for(const row of relations)if(row.relowner!==markerOwner)problems.push('OWNER_MISMATCH:'+row.relname);
    for(const row of functions)if(row.proowner!==markerOwner)problems.push('OWNER_MISMATCH:'+row.proname);
  }
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
    const guard=RUN_STORE_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const deferred=guard[4];
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''&&row.tgoldtable===null&&row.tgnewtable===null
      &&(deferred?row.tgconstraint!==0&&row.constraint_type==='t'&&row.tgdeferrable&&row.tginitdeferred:row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred);
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of RUN_STORE_GUARDS)
    if(!triggers.some(row=>row.tgname===name&&row.relname===table&&row.nspname==='public'))missing.push('TRIGGER_MISSING:'+name);
  for(const name of Object.keys(INDEXES))
    if(!relations.some(row=>row.relname===name))missing.push('INDEX_MISSING:'+name);
  if(tables.some(row=>row.relname===MARKER_TABLE)&&!problems.some(item=>item.startsWith('TABLE_DEFINITION:'+MARKER_TABLE))){
    // The runtime role holds no privilege on the marker (grant model B2): report that instead of throwing 42501. --inspect runs as the schema owner.
    const readable=(await db.query(`SELECT pg_catalog.has_table_privilege(current_user,$1,'SELECT') OR pg_catalog.has_column_privilege(current_user,$1,'version','SELECT') AS readable`,
      ['public.'+MARKER_TABLE])).rows[0].readable;
    if(!readable)problems.push('MARKER_UNREADABLE');
    else{
      const markerRows=(await db.query('SELECT version FROM public.'+MARKER_TABLE)).rows;
      if(markerRows.length!==1||markerRows[0].version!==1)problems.push('MARKER_ROW');
    }
  }
  let state;
  if(!relations.length&&!functions.length&&!triggers.length&&!types.length)state='ABSENT';
  else if(problems.length||missing.length)state='OTHER';
  else state='INSTALLED';
  return {state,problems,missing,tables:tables.map(row=>row.relname),exact:Object.keys(exact)};
}

// REFERENCES is no privilege the shared inspection knows; it is the one table privilege that would let a role add a foreign key onto a run-store table.
const referencesHeld=async(db,role,table)=>(await db.query(`SELECT pg_catalog.has_table_privilege($1,c.oid,'REFERENCES') OR pg_catalog.has_any_column_privilege($1,c.oid,'REFERENCES')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role($1,r.oid,'MEMBER') AND (pg_catalog.has_table_privilege(r.oid,c.oid,'REFERENCES')
  OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'REFERENCES'))) AS held FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($2)`,[role,'public.'+table])).rows[0]?.held===true;

/**
 * Catalog facts and the failures they imply, read only. The role checks are the shared inspection of runtime-role-inspection.js.
 * With runtimeRole: the role is not a superuser or BYPASSRLS and is a member of no such role, owns no run-store table or function, and holds no privilege at all
 * (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES) on any run-store table, itself or through any role it can reach by membership (INHERIT FALSE
 * included); it may not SET session_replication_role and holds no CREATE on schema public. With fixtureRole: the same boundary with the privileges of
 * the fixture role: SELECT and INSERT on the two record tables and SELECT on the marker table (required unless requireGrants is false), nothing that edits,
 * removes or truncates a row, no ownership, no superuser or BYPASSRLS (failures carry the prefix FIXTURE_ROLE_ instead of RUNTIME_ROLE_). With both roles,
 * RUNTIME_ROLE_REACHES_FIXTURE_ROLE when the runtime role is the fixture role or a member of it (directly or through other roles).
 */
export async function inspectMpRunStore(db,{runtimeRole,fixtureRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',member_set_state:null,guards:[],functions:[],tables:[]};
  const classification=await classifyMpRunStore(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  facts.member_set_state=(await classifyMpMemberSet(db)).state;
  if(classification.state!=='ABSENT'&&facts.member_set_state!=='INSTALLED')failures.push('MEMBER_SET_REQUIRED:'+facts.member_set_state);
  // The marker function runs only when it is exactly the run-store SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('mp_run_store_version'))
    facts.marker=(await db.query('SELECT public.mp_run_store_version() v')).rows[0].v;
  if(facts.marker!==RUN_STORE_MARKER)failures.push('MARKER_MISSING');
  for(const [name,table,fn] of RUN_STORE_GUARDS){
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
    const tables=classification.tables.map(name=>({name,forbidden:[...TABLE_PRIVILEGES],required:[]}));
    const inspected=await inspectRuntimeRole(db,{runtimeRole,schema:'public',tables,functions:FUNCTIONS});
    failures.push(...inspected.failures);
    if(inspected.found){
      facts.runtime_role=inspected.facts;facts.server_version_num=inspected.facts.server_version_num;
      for(const name of classification.tables)if(await referencesHeld(db,runtimeRole,name))failures.push('RUNTIME_ROLE_REFERENCES_PRIVILEGE:'+name);
    }
  }
  if(fixtureRole){
    const tables=classification.tables.map(name=>name===MARKER_TABLE
      ?{name,forbidden:['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT']:[]}
      :{name,forbidden:['UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT','INSERT']:[]});
    const inspected=await inspectRuntimeRole(db,{runtimeRole:fixtureRole,schema:'public',tables,functions:FUNCTIONS});
    failures.push(...inspected.failures.map(failure=>failure.replace(/^RUNTIME_ROLE_/,'FIXTURE_ROLE_')));
    if(inspected.found){
      facts.fixture_role=inspected.facts;
      for(const name of classification.tables)if(await referencesHeld(db,fixtureRole,name))failures.push('FIXTURE_ROLE_REFERENCES_PRIVILEGE:'+name);
    }
    // The runtime role must not be able to become the fixture role, whatever the grants on the run-store tables say today.
    if(runtimeRole&&inspected.found){
      const reaches=(await db.query(`SELECT r.oid IS NOT NULL AND f.oid IS NOT NULL AND pg_catalog.pg_has_role(r.oid,f.oid,'MEMBER') AS reaches
        FROM (SELECT 1) one LEFT JOIN pg_catalog.pg_roles r ON r.rolname=$1 LEFT JOIN pg_catalog.pg_roles f ON f.rolname=$2`,[runtimeRole,fixtureRole])).rows[0].reaches;
      facts.runtime_reaches_fixture=reaches===true;
      if(reaches===true)failures.push('RUNTIME_ROLE_REACHES_FIXTURE_ROLE');
    }
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the run-store objects are exactly absent or exactly the run-store SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Multi-Pine run store '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the run-store tables in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The member-set extension must be
 * INSTALLED before and after (the foreign keys add internal triggers to its tables). The catalog assertions run in the same transaction. Grants are not
 * changed: reapply scripts/grant-postgres-runtime.sql (the runtime role then holds no privilege on these tables) and, in an isolated cluster,
 * scripts/grant-postgres-mp-fixture.sql afterwards.
 */
export async function migrateMpRunStore(db,{runtimeRole,fixtureRole}={}){
  if(db.isTransaction)throw Error('Multi-Pine run store migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireBase(db);
    const memberSet=await classifyMpMemberSet(db);
    if(memberSet.state!=='INSTALLED')
      throw Error('Multi-Pine run store install refused; the member-set extension must be INSTALLED, found '+memberSet.state+' (no change made): '+[...memberSet.problems,...memberSet.missing].join(', '));
    const before=await classifyMpRunStore(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('mp-run-store.sql'));
    const report=await inspectMpRunStore(db,{runtimeRole,fixtureRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Multi-Pine run store verification failed: '+report.failures.join(', '));
    const after=await classifyMpMemberSet(db);
    if(after.state!=='INSTALLED')throw Error('Multi-Pine run store install changed the member-set extension to '+after.state+': '+[...after.problems,...after.missing].join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while no record table holds a row. Both record tables are locked ACCESS
 * EXCLUSIVE before the count, so no writer can add a run between the count and the drop. The marker row is not a record. Run this before the member-set rollback.
 */
export async function rollbackMpRunStore(db){
  if(db.isTransaction)throw Error('Multi-Pine run store rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyMpRunStore(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE '+RUN_STORE_TABLES.map(table=>'public.'+table).join(', ')+' IN ACCESS EXCLUSIVE MODE');
      const counts=(await db.query(RUN_STORE_TABLES.map(table=>"SELECT '"+table+"' AS table_name,count(*)::int AS n FROM public."+table).join(' UNION ALL '))).rows.filter(row=>row.n>0);
      if(counts.length)throw Error('Multi-Pine run store rollback refused; '+counts.reduce((sum,row)=>sum+row.n,0)+' record row(s) exist in '+counts.map(row=>row.table_name).join(', ')+' (no change made)');
      await db.query(await sql('mp-run-store-rollback.sql'));
    }
    const left=await classifyMpRunStore(db);
    if(left.state!=='ABSENT')throw Error('Multi-Pine run store rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
