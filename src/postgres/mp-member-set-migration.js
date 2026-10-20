import fs from 'node:fs/promises';
import {inspectRuntimeRole} from './runtime-role-inspection.js';

/**
 * F11-01 member-set extension T1: insert-only multi-Pine member-set tables. Offline only: the maintenance lock excludes every participating API and worker.
 * The member-set tables are their own extension (marker table mp_member_set_schema, version 1; RD-MP-13); the base schema_version stays 14. The install
 * needs the Pine Bridge extension (pine_bridge_schema version 1) and the base users table. Nothing calls this module from db.migrate. The foreign keys name
 * pine_source_revisions and pine_deployments, so those Pine Bridge tables cannot be dropped while this extension is installed (at any row count); roll
 * back the member-set extension first, which itself refuses while any record row exists. The later run store of RD-MP-2 is a separate extension that
 * depends on this one.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified
 * install could collide with, or silently accept, a foreign object that carries a member-set name. The states are:
 *   ABSENT     no member-set relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the member-set SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (partial, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra trigger, foreign
 *              constraint or index, overload or orphan with a member-set name, a relation or function owned by a role other than the owner of
 *              the marker table: OWNER_MISMATCH:<name>).
 * Run the tool as the schema owner with the default search_path: the deparsed foreign key text names users, pine_source_revisions and pine_deployments
 * unqualified only when public is on the search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any member-set
 * row exists (insert-only records are never dropped by this tool). Table, constraint and index definitions below are the PostgreSQL 16
 * deparsed text of a fresh install of mp-member-set.sql; function bodies are read from that file itself.
 */
export const MEMBER_SET_MARKER='mp-member-set-v1-schema';
export const INSERT_ONLY_SQLSTATE='QR002';
export const SERIALIZABLE_SQLSTATE='QR003';
export const INSERT_GUARD_SQLSTATE='QR004';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const MARKER_TABLE='mp_member_set_schema';
/** The two insert-only record tables, parent first (the order the grant script and the inspection use). */
export const MEMBER_SET_TABLES=Object.freeze(['mp_member_sets','mp_member_set_members']);
/** The guard triggers that raise QR004 with CONSTRAINT = their own name; a writer maps the error by this name (RD-MP-14: both give MP_MEMBER_SET_STALE). */
export const QR004_GUARDS=Object.freeze(['mp_member_set_members_guard','mp_member_sets_complete']);
const TABLES=[MARKER_TABLE,...MEMBER_SET_TABLES];
const FUNCTIONS=Object.freeze(['mp_member_set_version','mp_require_serializable','mp_freeze','mp_guard_member','mp_guard_set_complete']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. A constraint trigger is AFTER ROW INSERT, deferrable and initially deferred.
const FREEZE_ROW=27,FREEZE_STATEMENT=34,INSERT_GUARD=7,DEFERRED_AFTER_INSERT=5;
export const MEMBER_SET_GUARDS=Object.freeze([
 ["mp_member_set_members_00_serializable","mp_member_set_members","mp_require_serializable",INSERT_GUARD,false],
 ["mp_member_set_members_guard","mp_member_set_members","mp_guard_member",INSERT_GUARD,false],
 ["mp_member_set_members_no_change","mp_member_set_members","mp_freeze",FREEZE_ROW,false],
 ["mp_member_set_members_no_truncate","mp_member_set_members","mp_freeze",FREEZE_STATEMENT,false],
 ["mp_member_set_schema_00_serializable","mp_member_set_schema","mp_require_serializable",INSERT_GUARD,false],
 ["mp_member_set_schema_no_change","mp_member_set_schema","mp_freeze",FREEZE_ROW,false],
 ["mp_member_set_schema_no_truncate","mp_member_set_schema","mp_freeze",FREEZE_STATEMENT,false],
 ["mp_member_sets_00_serializable","mp_member_sets","mp_require_serializable",INSERT_GUARD,false],
 ["mp_member_sets_complete","mp_member_sets","mp_guard_set_complete",DEFERRED_AFTER_INSERT,true],
 ["mp_member_sets_no_change","mp_member_sets","mp_freeze",FREEZE_ROW,false],
 ["mp_member_sets_no_truncate","mp_member_sets","mp_freeze",FREEZE_STATEMENT,false]
]);
export const FREEZE_TRIGGERS=Object.freeze(MEMBER_SET_GUARDS.filter(item=>item[2]==='mp_freeze'));
const INDEXES=Object.freeze({
 mp_member_set_members_deployment:"CREATE INDEX mp_member_set_members_deployment ON public.mp_member_set_members USING btree (deployment_id)",
 mp_member_set_members_deployment_key:"CREATE UNIQUE INDEX mp_member_set_members_deployment_key ON public.mp_member_set_members USING btree (member_set_id, deployment_id)",
 mp_member_set_members_import_key:"CREATE UNIQUE INDEX mp_member_set_members_import_key ON public.mp_member_set_members USING btree (member_set_id, pine_import_id)",
 mp_member_set_members_pkey:"CREATE UNIQUE INDEX mp_member_set_members_pkey ON public.mp_member_set_members USING btree (member_set_id, ordinal)",
 mp_member_set_schema_pkey:"CREATE UNIQUE INDEX mp_member_set_schema_pkey ON public.mp_member_set_schema USING btree (version)",
 mp_member_sets_content_key:"CREATE UNIQUE INDEX mp_member_sets_content_key ON public.mp_member_sets USING btree (owner_id, bot_id, content_digest)",
 mp_member_sets_identity_key:"CREATE UNIQUE INDEX mp_member_sets_identity_key ON public.mp_member_sets USING btree (member_set_id, owner_id, bot_id)",
 mp_member_sets_pkey:"CREATE UNIQUE INDEX mp_member_sets_pkey ON public.mp_member_sets USING btree (member_set_id)",
 mp_member_sets_set_hash_key:"CREATE UNIQUE INDEX mp_member_sets_set_hash_key ON public.mp_member_sets USING btree (member_set_id, set_hash)"});
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const COLUMNS=Object.freeze({
 mp_member_set_schema:[col("version","integer",true)],
 mp_member_sets:[col("member_set_id","uuid",true),col("owner_id","text",true),col("bot_id","text",true),col("version","text",true),col("pine_count","smallint",true),col("membership_hash","text",true),col("content_digest","text",true),col("set_hash","text",true),col("execution_model_hash","text",true),col("policy_hash","text",true),col("capital_basis_hash","text",true),col("funding_cutoff","bigint",true),col("bridge_atr_multiplier","text",true),col("bridge_rr","text",true),col("exit_version","text",true),col("same_bar_order","text",true),col("fixture","boolean",true),col("record","jsonb",true),col("created_at_utc","text",true)],
 mp_member_set_members:[col("member_set_id","uuid",true),col("ordinal","smallint",true),col("owner_id","text",true),col("bot_id","text",true),col("pine_import_id","text",true),col("source_version","integer",true),col("source_hash","text",true),col("effective_inputs_hash","text",true),col("deployment_id","text",true),col("deployment_snapshot_hash","text",true),col("exit_version","text",true),col("evidence_hash","text",true)]});
const CONSTRAINTS=Object.freeze({
 mp_member_set_schema:{
  mp_member_set_schema_pkey:["p","PRIMARY KEY (version)"],
  mp_member_set_schema_version_check:["c","CHECK ((version = 1))"]},
 mp_member_sets:{
  mp_member_sets_bot_id_fkey:["f","FOREIGN KEY (bot_id) REFERENCES users(id)"],
  mp_member_sets_bridge_atr_multiplier_check:["c","CHECK (\nCASE\n    WHEN (bridge_atr_multiplier ~ '^(0|[1-9][0-9]{0,39})(\\.[0-9]{0,39}[1-9])?$'::text) THEN (((bridge_atr_multiplier)::numeric > (0)::numeric) AND ((bridge_atr_multiplier)::numeric <= (1000)::numeric))\n    ELSE false\nEND)"],
  mp_member_sets_bridge_rr_check:["c","CHECK (\nCASE\n    WHEN (bridge_rr ~ '^(0|[1-9][0-9]{0,39})(\\.[0-9]{0,39}[1-9])?$'::text) THEN (((bridge_rr)::numeric > (0)::numeric) AND ((bridge_rr)::numeric <= (1000)::numeric))\n    ELSE false\nEND)"],
  mp_member_sets_capital_basis_hash_check:["c","CHECK ((capital_basis_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_sets_content_digest_check:["c","CHECK ((content_digest ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_sets_content_key:["u","UNIQUE (owner_id, bot_id, content_digest)"],
  mp_member_sets_created_at_utc_check:["c","CHECK ((created_at_utc ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?Z$'::text))"],
  mp_member_sets_execution_model_hash_check:["c","CHECK ((execution_model_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_sets_exit_version_check:["c","CHECK ((exit_version = ANY (ARRAY['bridge-exit-v1'::text, 'bridge-exit-v2'::text])))"],
  mp_member_sets_fixture_check:["c","CHECK (fixture)"],
  mp_member_sets_funding_cutoff_check:["c","CHECK (((funding_cutoff >= 0) AND (funding_cutoff <= '9007199254740991'::bigint)))"],
  mp_member_sets_identity_key:["u","UNIQUE (member_set_id, owner_id, bot_id)"],
  mp_member_sets_membership_hash_check:["c","CHECK ((membership_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_sets_owner_id_fkey:["f","FOREIGN KEY (owner_id) REFERENCES users(id)"],
  mp_member_sets_pine_count_check:["c","CHECK (((pine_count >= 2) AND (pine_count <= 3)))"],
  mp_member_sets_pkey:["p","PRIMARY KEY (member_set_id)"],
  mp_member_sets_policy_hash_check:["c","CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_sets_record_check:["c","CHECK ((jsonb_typeof(record) = 'object'::text))"],
  mp_member_sets_record_ties_check:["c","CHECK (COALESCE((((record -> 'member_set_id'::text) = to_jsonb((member_set_id)::text)) AND ((record -> 'owner_id'::text) = to_jsonb(owner_id)) AND ((record -> 'bot_id'::text) = to_jsonb(bot_id)) AND ((record -> 'version'::text) = to_jsonb(version)) AND ((record -> 'mode'::text) = '\"MULTI_PINE\"'::jsonb) AND ((record -> 'pine_count'::text) = to_jsonb(pine_count)) AND ((record -> 'membership_hash'::text) = to_jsonb(membership_hash)) AND ((record -> 'content_digest'::text) = to_jsonb(content_digest)) AND ((record -> 'set_hash'::text) = to_jsonb(set_hash)) AND ((record -> 'execution_model_hash'::text) = to_jsonb(execution_model_hash)) AND ((record -> 'policy_hash'::text) = to_jsonb(policy_hash)) AND ((record -> 'capital_basis_hash'::text) = to_jsonb(capital_basis_hash)) AND ((record -> 'funding_cutoff'::text) = to_jsonb(funding_cutoff)) AND ((record -> 'bridge_pair'::text) = jsonb_build_object('atr_multiplier', bridge_atr_multiplier, 'rr', bridge_rr)) AND ((record -> 'bridge_atr_period'::text) = '14'::jsonb) AND ((record -> 'market'::text) = '{\"broker\": \"binance-global\", \"symbol\": \"BTCUSDT\", \"timeframe\": \"1\"}'::jsonb) AND ((record -> 'exit_version'::text) = to_jsonb(exit_version)) AND ((record -> 'same_bar_order'::text) = to_jsonb(same_bar_order)) AND ((record -> 'fixture'::text) = to_jsonb(fixture)) AND ((record -> 'created_at'::text) = to_jsonb(created_at_utc)) AND\nCASE\n    WHEN (jsonb_typeof((record -> 'members'::text)) = 'array'::text) THEN (jsonb_array_length((record -> 'members'::text)) = pine_count)\n    ELSE false\nEND AND ((record - ARRAY['version'::text, 'owner_id'::text, 'bot_id'::text, 'mode'::text, 'pine_count'::text, 'members'::text, 'membership_hash'::text, 'bridge_pair'::text, 'bridge_atr_period'::text, 'market'::text, 'exit_version'::text, 'execution_model_hash'::text, 'policy_hash'::text, 'funding_cutoff'::text, 'capital_basis_hash'::text, 'same_bar_order'::text, 'fixture'::text, 'member_set_id'::text, 'content_digest'::text, 'set_hash'::text, 'created_at'::text]) = '{}'::jsonb)), false))"],
  mp_member_sets_same_bar_order_check:["c","CHECK ((same_bar_order = 'exit-first-ordinal-v1'::text))"],
  mp_member_sets_set_hash_check:["c","CHECK ((set_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_sets_set_hash_key:["u","UNIQUE (member_set_id, set_hash)"],
  mp_member_sets_version_check:["c","CHECK ((version = 'mp-member-set-v1'::text))"]},
 mp_member_set_members:{
  mp_member_set_members_deployment_fkey:["f","FOREIGN KEY (deployment_id) REFERENCES pine_deployments(deployment_id)"],
  mp_member_set_members_deployment_id_check:["c","CHECK (((length(deployment_id) >= 1) AND (length(deployment_id) <= 200)))"],
  mp_member_set_members_deployment_key:["u","UNIQUE (member_set_id, deployment_id)"],
  mp_member_set_members_effective_inputs_hash_check:["c","CHECK ((effective_inputs_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_set_members_evidence_hash_check:["c","CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_set_members_exit_version_check:["c","CHECK ((exit_version = ANY (ARRAY['bridge-exit-v1'::text, 'bridge-exit-v2'::text])))"],
  mp_member_set_members_import_key:["u","UNIQUE (member_set_id, pine_import_id)"],
  mp_member_set_members_ordinal_check:["c","CHECK (((ordinal >= 1) AND (ordinal <= 3)))"],
  mp_member_set_members_pine_import_id_check:["c","CHECK (((length(pine_import_id) >= 1) AND (length(pine_import_id) <= 200)))"],
  mp_member_set_members_pkey:["p","PRIMARY KEY (member_set_id, ordinal)"],
  mp_member_set_members_revision_fkey:["f","FOREIGN KEY (pine_import_id, source_version) REFERENCES pine_source_revisions(pine_import_id, source_version)"],
  mp_member_set_members_set_fkey:["f","FOREIGN KEY (member_set_id, owner_id, bot_id) REFERENCES mp_member_sets(member_set_id, owner_id, bot_id)"],
  mp_member_set_members_snapshot_hash_check:["c","CHECK ((deployment_snapshot_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_set_members_source_hash_check:["c","CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_member_set_members_source_version_check:["c","CHECK ((source_version > 0))"]}});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireExtension(db){
  if(!await exists(db,'pine_bridge_schema'))throw Error('Pine Bridge extension 1 required');
  const rows=(await db.query('SELECT version FROM public.pine_bridge_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported pine_bridge_schema version');
  for(const table of ['users','pine_source_revisions','pine_deployments','pine_memberships','pine_bridge_evidence'])
    if(!await exists(db,table))throw Error('Pine Bridge extension 1 required: table '+table+' is missing');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the member-set SQL file itself. */
async function expectedFunctions(){
  const text=await sql('mp-member-set.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS ([\\w\\[\\]]+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Member-set definition not found: '+name);
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
// Triggers that carry a member-set name on any table, triggers bound to a member-set function under any name, and every other
// non-internal trigger on a member-set table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,
  (SELECT k.contype FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint) AS constraint_type
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the member-set SQL; an empty list means exact. */
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
  const columns=(await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS def,a.attidentity,a.attgenerated,a.attnum
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[relation.oid])).rows;
  const expected=COLUMNS[table];
  if(columns.length!==expected.length||columns.some((row,index)=>row.attname!==expected[index].name||row.type!==expected[index].type||row.attnotnull!==expected[index].notNull
    ||row.def!==expected[index].def||row.attidentity!==''||row.attgenerated!==''||row.attnum!==index+1))reasons.push('COLUMNS');
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
  return reasons;
}

/**
 * Read-only exact classification of every member-set object. state is ABSENT, INSTALLED or OTHER. problems lists present objects
 * that are not exactly the member-set SQL, missing lists expected objects that do not exist. Never calls a member-set function.
 */
export async function classifyMpMemberSet(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[MEMBER_SET_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
  const problems=[],missing=[],exact={};
  for(const row of types)problems.push('TYPE_UNEXPECTED:'+row.typname);
  const tables=relations.filter(row=>TABLES.includes(row.relname));
  for(const row of relations){
    if(TABLES.includes(row.relname)){
      const reasons=await tableDifferences(db,row,row.relname);
      if(reasons.length)problems.push('TABLE_DEFINITION:'+row.relname+':'+reasons.join('+'));
    }else if(row.relkind!=='i')problems.push('RELATION_UNEXPECTED:'+row.relname);
  }
  for(const name of TABLES)if(!relations.some(row=>row.relname===name))missing.push('TABLE_MISSING:'+name);
  // Cross-lane rule: every relation and function is owned by the owner of the marker table, so a re-owned object cannot hide a change the owner would not make.
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
    const guard=MEMBER_SET_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const deferred=guard[4];
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''&&row.tgoldtable===null&&row.tgnewtable===null
      &&(deferred?row.tgconstraint!==0&&row.constraint_type==='t'&&row.tgdeferrable&&row.tginitdeferred:row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred);
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of MEMBER_SET_GUARDS)
    if(!triggers.some(row=>row.tgname===name&&row.relname===table&&row.nspname==='public'))missing.push('TRIGGER_MISSING:'+name);
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
 * With runtimeRole the privilege boundary the extension relies on is checked too: the role is not a superuser or BYPASSRLS and is a member of no
 * superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns no member-set table or function (ownership includes membership of the owning
 * role through pg_has_role MEMBER, which SET ROLE reaches even without inheritance), holds no TRIGGER or TRUNCATE privilege, no UPDATE and no DELETE
 * on any table, cannot write the marker table and (PostgreSQL 15 and later) may not SET session_replication_role. A forbidden privilege counts when
 * any role the runtime role can reach by membership holds it (INHERIT FALSE included); the role must not own schema public (also as database owner)
 * nor hold CREATE on it. With requireGrants the role must also hold SELECT and INSERT on both record tables and SELECT on the marker table.
 */
export async function inspectMpMemberSet(db,{runtimeRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[]};
  const classification=await classifyMpMemberSet(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  // The marker function runs only when it is exactly the member-set SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('mp_member_set_version'))
    facts.marker=(await db.query('SELECT public.mp_member_set_version() v')).rows[0].v;
  if(facts.marker!==MEMBER_SET_MARKER)failures.push('MARKER_MISSING');
  for(const [name,table,fn] of MEMBER_SET_GUARDS){
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
    // any reachable role (also with INHERIT FALSE), privileged membership, CREATE on schema public and session_replication_role.
    const tables=classification.tables.map(name=>name===MARKER_TABLE
      ?{name,forbidden:['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT']:[]}
      :{name,forbidden:['UPDATE','DELETE','TRUNCATE','TRIGGER'],required:requireGrants?['SELECT','INSERT']:[]});
    const inspected=await inspectRuntimeRole(db,{runtimeRole,schema:'public',tables,functions:FUNCTIONS});
    failures.push(...inspected.failures);
    if(inspected.found){facts.runtime_role=inspected.facts;facts.server_version_num=inspected.facts.server_version_num;}
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the member-set objects are exactly absent or exactly the member-set SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Multi-Pine member-set '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the member-set tables in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The catalog
 * assertions run in the same transaction. Grants are not changed: reapply scripts/grant-postgres-runtime.sql afterwards.
 */
export async function migrateMpMemberSet(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Multi-Pine member-set migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await classifyMpMemberSet(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('mp-member-set.sql'));
    const report=await inspectMpMemberSet(db,{runtimeRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Multi-Pine member-set verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while no record table holds a row. Both record
 * tables are locked ACCESS EXCLUSIVE before the count, so no writer can add a set between the count and the drop. The marker row is not a record.
 */
export async function rollbackMpMemberSet(db){
  if(db.isTransaction)throw Error('Multi-Pine member-set rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyMpMemberSet(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE '+MEMBER_SET_TABLES.map(table=>'public.'+table).join(', ')+' IN ACCESS EXCLUSIVE MODE');
      const counts=(await db.query(MEMBER_SET_TABLES.map(table=>"SELECT '"+table+"' AS table_name,count(*)::int AS n FROM public."+table).join(' UNION ALL '))).rows.filter(row=>row.n>0);
      if(counts.length)throw Error('Multi-Pine member-set rollback refused; '+counts.reduce((sum,row)=>sum+row.n,0)+' record row(s) exist in '+counts.map(row=>row.table_name).join(', ')+' (no change made)');
      await db.query(await sql('mp-member-set-rollback.sql'));
    }
    const left=await classifyMpMemberSet(db);
    if(left.state!=='ABSENT')throw Error('Multi-Pine member-set rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
