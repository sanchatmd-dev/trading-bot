import fs from 'node:fs/promises';
import {inspectRuntimeRole} from './runtime-role-inspection.js';
import {foreignKeyTriggerFailures} from './fk-trigger-inspection.js';

/**
 * F09 builder slice S2: insert-only Best Inputs package tables. Offline only: the maintenance lock excludes every participating API and worker.
 * The package tables are their own extension (marker table bi_package_schema, version 1); the base schema_version stays 14. The install needs
 * the version-1 research extension (quant_job_schema version 1) and the base users table. Nothing calls this module from db.migrate.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified
 * install could collide with, or silently accept, a foreign object that carries a package name. The states are:
 *   ABSENT     no package relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the package SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (partial, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra trigger, foreign
 *              constraint or index, overload or orphan with a package name, a relation or function owned by a role other than the
 *              owner of the marker table: OWNER_MISMATCH:<name>, a column whose collation is not the database default:
 *              TABLE_DEFINITION:<table>:COLLATION).
 * Foreign keys are judged by their internal referential-integrity triggers too (fk-trigger-inspection.js): a disabled, dropped or reshaped one, on an extension
 * table or on a referenced table, classifies OTHER (TABLE_DEFINITION:<table>:FOREIGN_KEY_TRIGGERS). A referenced base table with a disabled RI trigger fails closed.
 * Run the tool as the schema owner with the default search_path: the deparsed foreign key text names users and quant_jobs unqualified only
 * when public is on the search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any package
 * row exists (insert-only evidence is never dropped by this tool). Table, constraint and index definitions below are the PostgreSQL 16
 * deparsed text of a fresh install of best-inputs-package-schema.sql; function bodies are read from that file itself.
 */
export const PACKAGE_MARKER='best-inputs-package-v1';
export const INSERT_ONLY_SQLSTATE='QR002';
export const INSERT_GUARD_SQLSTATE='QR004';
export const SERIALIZABLE_SQLSTATE='QR003';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const MARKER_TABLE='bi_package_schema';
/** The ten insert-only record tables, in the order the grant script and the inspection use. */
export const PACKAGE_TABLES=Object.freeze(['bi_exports','bi_package_files','bi_blobs','bi_status_events','bi_attempts','bi_compile_records','bi_evidence_records',
  'bi_clearances','bi_trace_reproductions','ql4c_validation']);
const TABLES=[MARKER_TABLE,...PACKAGE_TABLES];
const FUNCTIONS=Object.freeze(['bi_package_version','bi_retryable_codes','bi_require_serializable','bi_freeze','bi_lock_export','bi_latest_status','bi_guard_export','bi_guard_export_complete','bi_guard_package_file',
  'bi_guard_status_event','bi_guard_attempt','bi_guard_validation','bi_guard_candidate_record','bi_guard_clearance']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. A constraint trigger is AFTER ROW INSERT, deferrable and initially deferred.
const FREEZE_ROW=27,FREEZE_STATEMENT=34,INSERT_GUARD=7,DEFERRED_AFTER_INSERT=5;
export const PACKAGE_GUARDS=Object.freeze([
 ["bi_attempts_00_serializable","bi_attempts","bi_require_serializable",INSERT_GUARD,false],
 ["bi_attempts_guard","bi_attempts","bi_guard_attempt",INSERT_GUARD,false],
 ["bi_attempts_no_change","bi_attempts","bi_freeze",FREEZE_ROW,false],
 ["bi_attempts_no_truncate","bi_attempts","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_blobs_00_serializable","bi_blobs","bi_require_serializable",INSERT_GUARD,false],
 ["bi_blobs_no_change","bi_blobs","bi_freeze",FREEZE_ROW,false],
 ["bi_blobs_no_truncate","bi_blobs","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_clearances_00_serializable","bi_clearances","bi_require_serializable",INSERT_GUARD,false],
 ["bi_clearances_candidate","bi_clearances","bi_guard_candidate_record",INSERT_GUARD,false],
 ["bi_clearances_guard","bi_clearances","bi_guard_clearance",INSERT_GUARD,false],
 ["bi_clearances_no_change","bi_clearances","bi_freeze",FREEZE_ROW,false],
 ["bi_clearances_no_truncate","bi_clearances","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_compile_records_00_serializable","bi_compile_records","bi_require_serializable",INSERT_GUARD,false],
 ["bi_compile_records_guard","bi_compile_records","bi_guard_candidate_record",INSERT_GUARD,false],
 ["bi_compile_records_no_change","bi_compile_records","bi_freeze",FREEZE_ROW,false],
 ["bi_compile_records_no_truncate","bi_compile_records","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_evidence_records_00_serializable","bi_evidence_records","bi_require_serializable",INSERT_GUARD,false],
 ["bi_evidence_records_guard","bi_evidence_records","bi_guard_candidate_record",INSERT_GUARD,false],
 ["bi_evidence_records_no_change","bi_evidence_records","bi_freeze",FREEZE_ROW,false],
 ["bi_evidence_records_no_truncate","bi_evidence_records","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_exports_00_serializable","bi_exports","bi_require_serializable",INSERT_GUARD,false],
 ["bi_exports_complete","bi_exports","bi_guard_export_complete",DEFERRED_AFTER_INSERT,true],
 ["bi_exports_guard","bi_exports","bi_guard_export",INSERT_GUARD,false],
 ["bi_exports_no_change","bi_exports","bi_freeze",FREEZE_ROW,false],
 ["bi_exports_no_truncate","bi_exports","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_package_files_00_serializable","bi_package_files","bi_require_serializable",INSERT_GUARD,false],
 ["bi_package_files_guard","bi_package_files","bi_guard_package_file",INSERT_GUARD,false],
 ["bi_package_files_no_change","bi_package_files","bi_freeze",FREEZE_ROW,false],
 ["bi_package_files_no_truncate","bi_package_files","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_package_schema_00_serializable","bi_package_schema","bi_require_serializable",INSERT_GUARD,false],
 ["bi_package_schema_no_change","bi_package_schema","bi_freeze",FREEZE_ROW,false],
 ["bi_package_schema_no_truncate","bi_package_schema","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_status_events_00_serializable","bi_status_events","bi_require_serializable",INSERT_GUARD,false],
 ["bi_status_events_guard","bi_status_events","bi_guard_status_event",INSERT_GUARD,false],
 ["bi_status_events_no_change","bi_status_events","bi_freeze",FREEZE_ROW,false],
 ["bi_status_events_no_truncate","bi_status_events","bi_freeze",FREEZE_STATEMENT,false],
 ["bi_trace_reproductions_00_serializable","bi_trace_reproductions","bi_require_serializable",INSERT_GUARD,false],
 ["bi_trace_reproductions_guard","bi_trace_reproductions","bi_guard_candidate_record",INSERT_GUARD,false],
 ["bi_trace_reproductions_no_change","bi_trace_reproductions","bi_freeze",FREEZE_ROW,false],
 ["bi_trace_reproductions_no_truncate","bi_trace_reproductions","bi_freeze",FREEZE_STATEMENT,false],
 ["ql4c_validation_00_serializable","ql4c_validation","bi_require_serializable",INSERT_GUARD,false],
 ["ql4c_validation_guard","ql4c_validation","bi_guard_validation",INSERT_GUARD,false],
 ["ql4c_validation_no_change","ql4c_validation","bi_freeze",FREEZE_ROW,false],
 ["ql4c_validation_no_truncate","ql4c_validation","bi_freeze",FREEZE_STATEMENT,false]
]);
export const FREEZE_TRIGGERS=Object.freeze(PACKAGE_GUARDS.filter(item=>item[2]==='bi_freeze'));
const INDEXES=Object.freeze({
 bi_attempts_attempt_id_key:"CREATE UNIQUE INDEX bi_attempts_attempt_id_key ON public.bi_attempts USING btree (attempt_id)",
 bi_attempts_pkey:"CREATE UNIQUE INDEX bi_attempts_pkey ON public.bi_attempts USING btree (export_id, attempt_no)",
 bi_blobs_pkey:"CREATE UNIQUE INDEX bi_blobs_pkey ON public.bi_blobs USING btree (sha256)",
 bi_blobs_sha256_size_key:"CREATE UNIQUE INDEX bi_blobs_sha256_size_key ON public.bi_blobs USING btree (sha256, size)",
 bi_clearances_pkey:"CREATE UNIQUE INDEX bi_clearances_pkey ON public.bi_clearances USING btree (export_id, blocker, evidence_hash)",
 bi_compile_records_export:"CREATE INDEX bi_compile_records_export ON public.bi_compile_records USING btree (export_id)",
 bi_compile_records_pkey:"CREATE UNIQUE INDEX bi_compile_records_pkey ON public.bi_compile_records USING btree (compile_id)",
 bi_evidence_records_pkey:"CREATE UNIQUE INDEX bi_evidence_records_pkey ON public.bi_evidence_records USING btree (evidence_id)",
 bi_evidence_records_unique_key:"CREATE UNIQUE INDEX bi_evidence_records_unique_key ON public.bi_evidence_records USING btree (export_id, kind, evidence_hash)",
 bi_exports_export_package_key:"CREATE UNIQUE INDEX bi_exports_export_package_key ON public.bi_exports USING btree (export_id, package_hash)",
 bi_exports_owner_run_key:"CREATE UNIQUE INDEX bi_exports_owner_run_key ON public.bi_exports USING btree (owner_id, run_id)",
 bi_exports_pkey:"CREATE UNIQUE INDEX bi_exports_pkey ON public.bi_exports USING btree (export_id)",
 bi_package_files_pkey:"CREATE UNIQUE INDEX bi_package_files_pkey ON public.bi_package_files USING btree (export_id, path)",
 bi_package_schema_pkey:"CREATE UNIQUE INDEX bi_package_schema_pkey ON public.bi_package_schema USING btree (version)",
 bi_status_events_attempt_key:"CREATE UNIQUE INDEX bi_status_events_attempt_key ON public.bi_status_events USING btree (export_id, attempt_no)",
 bi_status_events_pkey:"CREATE UNIQUE INDEX bi_status_events_pkey ON public.bi_status_events USING btree (export_id, seq)",
 bi_trace_reproductions_pkey:"CREATE UNIQUE INDEX bi_trace_reproductions_pkey ON public.bi_trace_reproductions USING btree (export_id, path)",
 ql4c_validation_export_package_key:"CREATE UNIQUE INDEX ql4c_validation_export_package_key ON public.ql4c_validation USING btree (export_id, package_hash)",
 ql4c_validation_pkey:"CREATE UNIQUE INDEX ql4c_validation_pkey ON public.ql4c_validation USING btree (export_id)"});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const COLUMNS=Object.freeze({
 bi_attempts:[col("export_id","uuid",true),col("attempt_no","integer",true),col("attempt_id","text",true),col("package_hash","text",true),col("pass","boolean",true),col("codes","text[]",true),col("gate_results","jsonb",true),col("evidence_refs","jsonb",true),col("validator_engine_hash","text",true),col("validated_at_ms","bigint",true),col("validated_at_utc","text",true)],
 bi_blobs:[col("sha256","text",true),col("size","bigint",true),col("content","bytea",true)],
 bi_clearances:[col("export_id","uuid",true),col("blocker","text",true),col("run_id","text",true),col("parameter_hash","text",true),col("evidence_hash","text",true),col("recorded_at_ms","bigint",true)],
 bi_compile_records:[col("compile_id","uuid",true,"gen_random_uuid()"),col("export_id","uuid",true),col("indicator_sha256","text",true),col("pine_version","text",true),col("errors","jsonb",true),col("warnings","jsonb",true),col("unresolved_references","integer",true),col("collisions","integer",true),col("duplicate_bindings","integer",true),col("mapping_check","jsonb",true),col("compiled_at_ms","bigint",true),col("compiled_at_utc","text",true),col("operator_role","text",true),col("method","text",true)],
 bi_evidence_records:[col("evidence_id","uuid",true,"gen_random_uuid()"),col("export_id","uuid",true),col("kind","text",true),col("record","jsonb",true),col("evidence_hash","text",true),col("recorded_at_ms","bigint",true)],
 bi_exports:[col("export_id","uuid",true),col("owner_id","text",true),col("bot_id","text",true),col("run_id","text",true),col("parent_export_id","uuid",false),col("mode","text",true),col("internal","boolean",true),col("fixture","boolean",true),col("gate_version","text",true),col("library_versions","jsonb",true),col("binding","jsonb",true),col("binding_hash","text",true),col("package_hash","text",true),col("b0","jsonb",true),col("created_at","bigint",true),col("created_at_utc","text",true)],
 bi_package_files:[col("export_id","uuid",true),col("path","text",true),col("sha256","text",true),col("bytes","bigint",true)],
 bi_package_schema:[col("version","integer",true)],
 bi_status_events:[col("export_id","uuid",true),col("seq","integer",true),col("status","text",true),col("codes","text[]",true),col("attempt_no","integer",false),col("at_ms","bigint",true),col("at_utc","text",true)],
 bi_trace_reproductions:[col("export_id","uuid",true),col("path","text",true),col("sha256","text",true),col("steps_digest","text",true),col("holdout_digest","text",true),col("trace_engine_hash","text",true),col("run_engine_hash","text",true),col("recorded_at_ms","bigint",true)],
 ql4c_validation:[col("export_id","uuid",true),col("package_hash","text",true),col("binding_hash","text",true),col("attempt_id","text",true),col("gate_results","jsonb",true),col("validator_engine_hash","text",true),col("fixture","boolean",true),col("validated_at_ms","bigint",true),col("validated_at_utc","text",true)]});
const CONSTRAINTS=Object.freeze({
 bi_attempts:{
  bi_attempts_attempt_id_check:["c","CHECK ((length(attempt_id) > 0))"],
  bi_attempts_attempt_id_key:["u","UNIQUE (attempt_id)"],
  bi_attempts_attempt_no_check:["c","CHECK (((attempt_no >= 1) AND (attempt_no <= 5)))"],
  bi_attempts_codes_check:["c","CHECK (((cardinality(codes) = 0) OR ((array_ndims(codes) = 1) AND (array_position(codes, NULL::text) IS NULL) AND (array_to_string(codes, ','::text) ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$'::text))))"],
  bi_attempts_evidence_refs_check:["c","CHECK ((jsonb_typeof(evidence_refs) = 'object'::text))"],
  bi_attempts_export_package_fkey:["f","FOREIGN KEY (export_id, package_hash) REFERENCES bi_exports(export_id, package_hash)"],
  bi_attempts_gate_results_check:["c","CHECK ((jsonb_typeof(gate_results) = 'array'::text))"],
  bi_attempts_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_attempts_pass_check:["c","CHECK ((pass = (cardinality(codes) = 0)))"],
  bi_attempts_pkey:["p","PRIMARY KEY (export_id, attempt_no)"],
  bi_attempts_validated_at_ms_check:["c","CHECK (((validated_at_ms >= 0) AND (validated_at_ms <= '253402300799999'::bigint)))"],
  bi_attempts_validated_at_utc_check:["c","CHECK ((validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  bi_attempts_validator_hash_check:["c","CHECK ((validator_engine_hash ~ '^[0-9a-f]{64}$'::text))"]},
 bi_blobs:{
  bi_blobs_hash_content_check:["c","CHECK ((encode(sha256(content), 'hex'::text) = sha256))"],
  bi_blobs_pkey:["p","PRIMARY KEY (sha256)"],
  bi_blobs_sha256_check:["c","CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"],
  bi_blobs_sha256_size_key:["u","UNIQUE (sha256, size)"],
  bi_blobs_size_check:["c","CHECK (((size >= 0) AND (size <= 16777216)))"],
  bi_blobs_size_content_check:["c","CHECK ((octet_length(content) = size))"]},
 bi_clearances:{
  bi_clearances_blocker_check:["c","CHECK ((blocker = ANY (ARRAY['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED'::text, 'CUSTOM_REPAINT_EVIDENCE_REQUIRED'::text])))"],
  bi_clearances_evidence_hash_check:["c","CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_clearances_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES bi_exports(export_id)"],
  bi_clearances_parameter_hash_check:["c","CHECK ((parameter_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_clearances_pkey:["p","PRIMARY KEY (export_id, blocker, evidence_hash)"],
  bi_clearances_recorded_at_check:["c","CHECK (((recorded_at_ms >= 0) AND (recorded_at_ms <= '253402300799999'::bigint)))"],
  bi_clearances_run_id_fkey:["f","FOREIGN KEY (run_id) REFERENCES quant_jobs(run_id)"]},
 bi_compile_records:{
  bi_compile_records_compiled_at_ms_check:["c","CHECK (((compiled_at_ms >= 0) AND (compiled_at_ms <= '253402300799999'::bigint)))"],
  bi_compile_records_compiled_at_utc_check:["c","CHECK ((compiled_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  bi_compile_records_counts_check:["c","CHECK (((unresolved_references >= 0) AND (collisions >= 0) AND (duplicate_bindings >= 0)))"],
  bi_compile_records_errors_check:["c","CHECK ((jsonb_typeof(errors) = 'array'::text))"],
  bi_compile_records_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES bi_exports(export_id)"],
  bi_compile_records_indicator_check:["c","CHECK ((indicator_sha256 ~ '^[0-9a-f]{64}$'::text))"],
  bi_compile_records_mapping_check:["c","CHECK ((jsonb_typeof(mapping_check) = 'array'::text))"],
  bi_compile_records_method_check:["c","CHECK ((length(method) > 0))"],
  bi_compile_records_operator_role_check:["c","CHECK ((length(operator_role) > 0))"],
  bi_compile_records_pine_version_check:["c","CHECK ((length(pine_version) > 0))"],
  bi_compile_records_pkey:["p","PRIMARY KEY (compile_id)"],
  bi_compile_records_warnings_check:["c","CHECK ((jsonb_typeof(warnings) = 'array'::text))"]},
 bi_evidence_records:{
  bi_evidence_records_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES bi_exports(export_id)"],
  bi_evidence_records_hash_check:["c","CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_evidence_records_kind_check:["c","CHECK ((kind = ANY (ARRAY['dataset_alignment'::text, 'native_parity'::text, 'bridge_parity'::text, 'repaint'::text, 'quant_baseline'::text])))"],
  bi_evidence_records_pkey:["p","PRIMARY KEY (evidence_id)"],
  bi_evidence_records_record_check:["c","CHECK ((jsonb_typeof(record) = 'object'::text))"],
  bi_evidence_records_recorded_at_check:["c","CHECK (((recorded_at_ms >= 0) AND (recorded_at_ms <= '253402300799999'::bigint)))"],
  bi_evidence_records_unique_key:["u","UNIQUE (export_id, kind, evidence_hash)"]},
 bi_exports:{
  bi_exports_b0_check:["c","CHECK ((jsonb_typeof(b0) = 'object'::text))"],
  bi_exports_binding_check:["c","CHECK ((jsonb_typeof(binding) = 'object'::text))"],
  bi_exports_binding_hash_check:["c","CHECK ((binding_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_exports_binding_ties_check:["c","CHECK (COALESCE((((binding ->> 'owner_id'::text) = owner_id) AND ((binding ->> 'bot_id'::text) = bot_id) AND ((binding ->> 'run_id'::text) = run_id) AND ((binding ->> 'mode'::text) = mode) AND ((binding -> 'fixture'::text) = to_jsonb(fixture)) AND ((binding ->> 'created_at'::text) = created_at_utc)), false))"],
  bi_exports_bot_id_fkey:["f","FOREIGN KEY (bot_id) REFERENCES users(id)"],
  bi_exports_created_at_check:["c","CHECK (((created_at >= 0) AND (created_at <= '253402300799999'::bigint)))"],
  bi_exports_created_at_utc_check:["c","CHECK ((created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  bi_exports_export_package_key:["u","UNIQUE (export_id, package_hash)"],
  bi_exports_gate_version_check:["c","CHECK ((length(gate_version) > 0))"],
  bi_exports_internal_check:["c","CHECK ((internal = (mode = 'MULTI_PINE'::text)))"],
  bi_exports_library_versions_check:["c","CHECK ((jsonb_typeof(library_versions) = 'object'::text))"],
  bi_exports_mode_check:["c","CHECK ((mode = ANY (ARRAY['ONE_PINE'::text, 'MULTI_PINE'::text])))"],
  bi_exports_owner_id_fkey:["f","FOREIGN KEY (owner_id) REFERENCES users(id)"],
  bi_exports_owner_run_key:["u","UNIQUE (owner_id, run_id)"],
  bi_exports_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_exports_parent_check:["c","CHECK ((parent_export_id IS NULL))"],
  bi_exports_pkey:["p","PRIMARY KEY (export_id)"],
  bi_exports_run_id_fkey:["f","FOREIGN KEY (run_id) REFERENCES quant_jobs(run_id)"]},
 bi_package_files:{
  bi_package_files_blob_fkey:["f","FOREIGN KEY (sha256, bytes) REFERENCES bi_blobs(sha256, size)"],
  bi_package_files_bytes_check:["c","CHECK (((bytes >= 0) AND (bytes <= 16777216)))"],
  bi_package_files_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES bi_exports(export_id)"],
  bi_package_files_path_check:["c","CHECK ((path = ANY (ARRAY['inputs.json'::text, 'indicator.pine'::text, 'indicator.json'::text, 'risk-profile.json'::text, 'setup-guide.md'::text, 'validation.html'::text, 'quant-data/manifest.json'::text, 'quant-data/metrics.json'::text, 'quant-data/equity.csv'::text, 'quant-data/trades.csv'::text, 'quant-data/decisions.csv'::text, 'quant-data/validation.json'::text])))"],
  bi_package_files_pkey:["p","PRIMARY KEY (export_id, path)"],
  bi_package_files_sha256_check:["c","CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"]},
 bi_package_schema:{
  bi_package_schema_pkey:["p","PRIMARY KEY (version)"],
  bi_package_schema_version_check:["c","CHECK ((version = 1))"]},
 bi_status_events:{
  bi_status_events_at_ms_check:["c","CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  bi_status_events_at_utc_check:["c","CHECK ((at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  bi_status_events_attempt_fkey:["f","FOREIGN KEY (export_id, attempt_no) REFERENCES bi_attempts(export_id, attempt_no)"],
  bi_status_events_attempt_key:["u","UNIQUE (export_id, attempt_no)"],
  bi_status_events_codes_check:["c","CHECK (((cardinality(codes) = 0) OR ((array_ndims(codes) = 1) AND (array_position(codes, NULL::text) IS NULL) AND (array_to_string(codes, ','::text) ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$'::text))))"],
  bi_status_events_codes_status_check:["c","CHECK ((((status = ANY (ARRAY['EXPORT_INTERNAL'::text, 'EXPORT_VALIDATED'::text])) AND (cardinality(codes) = 0)) OR ((status = 'EXPORT_REFUSED'::text) AND (cardinality(codes) > 0)) OR (status = 'EXPORT_CANDIDATE'::text)))"],
  bi_status_events_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES bi_exports(export_id)"],
  bi_status_events_first_check:["c","CHECK ((((seq = 1) AND (status = 'EXPORT_CANDIDATE'::text) AND (attempt_no IS NULL)) OR ((seq > 1) AND (attempt_no IS NOT NULL))))"],
  bi_status_events_pkey:["p","PRIMARY KEY (export_id, seq)"],
  bi_status_events_seq_check:["c","CHECK ((seq >= 1))"],
  bi_status_events_status_check:["c","CHECK ((status = ANY (ARRAY['EXPORT_CANDIDATE'::text, 'EXPORT_INTERNAL'::text, 'EXPORT_VALIDATED'::text, 'EXPORT_REFUSED'::text])))"]},
 bi_trace_reproductions:{
  bi_trace_reproductions_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES bi_exports(export_id)"],
  bi_trace_reproductions_holdout_check:["c","CHECK ((holdout_digest ~ '^[0-9a-f]{64}$'::text))"],
  bi_trace_reproductions_path_check:["c","CHECK ((path = ANY (ARRAY['quant-data/equity.csv'::text, 'quant-data/trades.csv'::text, 'quant-data/decisions.csv'::text])))"],
  bi_trace_reproductions_pkey:["p","PRIMARY KEY (export_id, path)"],
  bi_trace_reproductions_recorded_at_check:["c","CHECK (((recorded_at_ms >= 0) AND (recorded_at_ms <= '253402300799999'::bigint)))"],
  bi_trace_reproductions_run_engine_check:["c","CHECK ((run_engine_hash ~ '^[0-9a-f]{64}$'::text))"],
  bi_trace_reproductions_sha256_check:["c","CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"],
  bi_trace_reproductions_steps_check:["c","CHECK ((steps_digest ~ '^[0-9a-f]{64}$'::text))"],
  bi_trace_reproductions_trace_engine_check:["c","CHECK ((trace_engine_hash ~ '^[0-9a-f]{64}$'::text))"]},
 ql4c_validation:{
  ql4c_validation_attempt_id_fkey:["f","FOREIGN KEY (attempt_id) REFERENCES bi_attempts(attempt_id)"],
  ql4c_validation_binding_hash_check:["c","CHECK ((binding_hash ~ '^[0-9a-f]{64}$'::text))"],
  ql4c_validation_export_package_fkey:["f","FOREIGN KEY (export_id, package_hash) REFERENCES bi_exports(export_id, package_hash)"],
  ql4c_validation_export_package_key:["u","UNIQUE (export_id, package_hash)"],
  ql4c_validation_gate_results_check:["c","CHECK ((jsonb_typeof(gate_results) = 'array'::text))"],
  ql4c_validation_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  ql4c_validation_pkey:["p","PRIMARY KEY (export_id)"],
  ql4c_validation_validated_at_ms_check:["c","CHECK (((validated_at_ms >= 0) AND (validated_at_ms <= '253402300799999'::bigint)))"],
  ql4c_validation_validated_at_utc_check:["c","CHECK ((validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  ql4c_validation_validator_hash_check:["c","CHECK ((validator_engine_hash ~ '^[0-9a-f]{64}$'::text))"]}});
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireExtension(db){
  if(!await exists(db,'quant_job_schema'))throw Error('Quant research extension 1 required');
  const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported quant_job_schema version');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the package SQL file itself. */
async function expectedFunctions(){
  const text=await sql('best-inputs-package-schema.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS ([\\w\\[\\]]+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Package definition not found: '+name);
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
// Triggers that carry a package name on any table, triggers bound to a package function under any name, and every other
// non-internal trigger on a package table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,
  (SELECT k.contype FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint) AS constraint_type
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the package SQL; an empty list means exact. */
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
  return reasons;
}

/**
 * Read-only exact classification of every package object. state is ABSENT, INSTALLED or OTHER. problems lists present objects
 * that are not exactly the package SQL, missing lists expected objects that do not exist. Never calls a package function.
 */
export async function classifyBestInputsPackage(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[PACKAGE_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
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
    const guard=PACKAGE_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const deferred=guard[4];
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''&&row.tgoldtable===null&&row.tgnewtable===null
      &&(deferred?row.tgconstraint!==0&&row.constraint_type==='t'&&row.tgdeferrable&&row.tginitdeferred:row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred);
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of PACKAGE_GUARDS)
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
 * With runtimeRole the privilege boundary the package relies on is checked too: the
 * role is not a superuser or BYPASSRLS and is a member of no superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns no package
 * table or function (ownership includes membership of the owning role through pg_has_role MEMBER, which SET ROLE reaches even without
 * inheritance), holds no TRIGGER or TRUNCATE privilege, no UPDATE and no DELETE on any table, cannot write the marker table and
 * (PostgreSQL 15 and later) may not SET session_replication_role. A forbidden privilege counts when any role the runtime role can reach by
 * membership holds it (INHERIT FALSE included); the role must not own schema public (also as database owner) nor hold CREATE on it. With requireGrants the role must also hold SELECT and INSERT on every
 * record table and SELECT on the marker table. The database TEMP privilege is recorded, not judged, because every function pins
 * search_path and the reader qualifies each relation.
 */
export async function inspectBestInputsPackage(db,{runtimeRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[]};
  const classification=await classifyBestInputsPackage(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  // The marker function runs only when it is exactly the package SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('bi_package_version'))
    facts.marker=(await db.query('SELECT public.bi_package_version() v')).rows[0].v;
  if(facts.marker!==PACKAGE_MARKER)failures.push('MARKER_MISSING');
  for(const [name,table,fn] of PACKAGE_GUARDS){
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

/** Refuses before any write unless the package objects are exactly absent or exactly the package SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Best Inputs package '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the package tables in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The catalog
 * assertions run in the same transaction. Grants are not changed: reapply scripts/grant-postgres-runtime.sql afterwards.
 */
export async function migrateBestInputsPackage(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Best Inputs package migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await classifyBestInputsPackage(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('best-inputs-package-schema.sql'));
    const report=await inspectBestInputsPackage(db,{runtimeRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Best Inputs package verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while no record table holds a row. Every record
 * table is locked ACCESS EXCLUSIVE before the count, so no writer can add evidence between the count and the drop. The marker row is not evidence.
 */
export async function rollbackBestInputsPackage(db){
  if(db.isTransaction)throw Error('Best Inputs package rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyBestInputsPackage(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE '+PACKAGE_TABLES.map(table=>'public.'+table).join(', ')+' IN ACCESS EXCLUSIVE MODE');
      const counts=(await db.query(PACKAGE_TABLES.map(table=>"SELECT '"+table+"' AS table_name,count(*)::int AS n FROM public."+table).join(' UNION ALL '))).rows.filter(row=>row.n>0);
      if(counts.length)throw Error('Best Inputs package rollback refused; '+counts.reduce((sum,row)=>sum+row.n,0)+' evidence row(s) exist in '+counts.map(row=>row.table_name).join(', ')+' (no change made)');
      await db.query(await sql('best-inputs-package-rollback.sql'));
    }
    const left=await classifyBestInputsPackage(db);
    if(left.state!=='ABSENT')throw Error('Best Inputs package rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
