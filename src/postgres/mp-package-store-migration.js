import fs from 'node:fs/promises';
import {inspectRuntimeRole,TABLE_PRIVILEGES} from './runtime-role-inspection.js';
import {foreignKeyTriggerFailures} from './fk-trigger-inspection.js';
import {classifyMpMemberSet,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,PINNED_SEARCH_PATH} from './mp-member-set-migration.js';
import {classifyMpRunStore,RUN_STORE_TABLES} from './mp-run-store-migration.js';

/**
 * F11-01 internal multi-Pine package store, slice R6-3: insert-only export, file, status, attempt, validation, compile, evidence, clearance and trace tables
 * (RD-MP-36, RD-MP-37, RD-MP-41, RD-MP-39). Offline only: the maintenance lock excludes every participating API and worker. The package store is its own extension
 * (marker table mp_package_store_schema, version 1); the base schema_version stays 14. It installs only over an INSTALLED run store (and so an INSTALLED member-set
 * extension), because the export guard reads the run store by SELECT. Nothing calls this module from db.migrate.
 *
 * No foreign key of this extension names a run-store table, a member-set table, a bi_ table or a quant_ table (judgement J1): the run-store classifier reads a foreign
 * key from a table outside the run store as OTHER (REFERENCED_BY) and has no allowlist. Foreign keys go only to users and between package-store tables. The install
 * therefore re-classifies the run store and the member-set extension after the write and refuses (rolls back) unless both are still INSTALLED.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified install could collide
 * with, or silently accept, a foreign object that carries a package-store name. The states are:
 *   ABSENT     no package-store relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the package-store SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (a derived object that could expose package-store rows: inheritance on either side, a foreign key from a table outside the package store,
 *              a publication membership, a view, rule or materialized view outside the extension that depends on a package-store table: TABLE_DEFINITION:<table>:
 *              INHERITANCE, REFERENCED_BY, PUBLICATION, DEPENDENT_VIEW; a role without SELECT on the marker table: MARKER_UNREADABLE; partial, tampered body, SECURITY
 *              DEFINER, disabled or reshaped trigger, extra trigger, foreign constraint or index, overload or orphan with a package-store name, a relation or function
 *              owned by a role other than the owner of the marker table: OWNER_MISMATCH:<name>, a column whose collation is not the database default:
 *              TABLE_DEFINITION:<table>:COLLATION).
 * Foreign keys are judged by their internal referential-integrity triggers too (fk-trigger-inspection.js). Run the tool as the schema owner with the default search_path:
 * the deparsed foreign key text names users unqualified only when public is on the search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any record row exists (insert-only
 * records are never dropped by this tool). Table, constraint and index definitions below are the PostgreSQL 16 deparsed text of a fresh install of
 * mp-package-store.sql; function bodies are read from that file itself.
 *
 * Privilege boundary (RD-MP-36, RD-MP-42): the runtime role holds no privilege at all on the package-store tables (scripts/grant-postgres-runtime.sql category
 * internal_only). A separate fixture role (scripts/grant-postgres-mp-package-fixture.sql, isolated clusters only) holds SELECT and INSERT on the ten record tables and
 * SELECT on the marker. The inspection checks both roles and fails with RUNTIME_ROLE_REACHES_FIXTURE_ROLE when the runtime role can reach the fixture role by membership.
 */
export const PACKAGE_STORE_MARKER='mp-package-store-v1-schema';
export {INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,PINNED_SEARCH_PATH};
export const MARKER_TABLE='mp_package_store_schema';
/** The ten insert-only record tables (the order the grant scripts and the inspection use). */
export const PACKAGE_STORE_TABLES=Object.freeze(['mp_package_blobs','mp_package_exports','mp_package_files','mp_package_status_events','mp_package_attempts','mp_package_validations',
  'mp_package_compile_records','mp_package_evidence_records','mp_package_clearances','mp_package_trace_records']);
/** The guard triggers that raise QR004 with CONSTRAINT = their own name; a writer maps the error by this name. */
export const QR004_GUARDS=Object.freeze(['mp_package_exports_guard','mp_package_exports_complete','mp_package_files_guard','mp_package_status_events_guard','mp_package_attempts_guard',
  'mp_package_validations_guard','mp_package_compile_records_guard','mp_package_evidence_records_guard','mp_package_clearances_guard','mp_package_trace_records_guard']);
const TABLES=[MARKER_TABLE,...PACKAGE_STORE_TABLES];
const FUNCTIONS=Object.freeze(['mp_package_store_version','mp_package_store_retryable_codes','mp_package_store_freeze','mp_package_store_require_serializable','mp_package_store_lock_export',
  'mp_package_store_latest_status','mp_package_store_require_candidate','mp_package_store_guard_export','mp_package_store_guard_export_complete','mp_package_store_guard_file',
  'mp_package_store_guard_status','mp_package_store_guard_attempt','mp_package_store_guard_validation','mp_package_store_guard_compile','mp_package_store_guard_evidence',
  'mp_package_store_guard_clearance','mp_package_store_guard_trace']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. A constraint trigger is AFTER ROW INSERT, deferrable and initially deferred.
const FREEZE_ROW=27,FREEZE_STATEMENT=34,INSERT_GUARD=7,DEFERRED_AFTER_INSERT=5;
export const PACKAGE_STORE_GUARDS=Object.freeze([
 ["mp_package_attempts_00_serializable","mp_package_attempts","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_attempts_guard","mp_package_attempts","mp_package_store_guard_attempt",INSERT_GUARD,false],
 ["mp_package_attempts_no_change","mp_package_attempts","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_attempts_no_truncate","mp_package_attempts","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_blobs_00_serializable","mp_package_blobs","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_blobs_no_change","mp_package_blobs","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_blobs_no_truncate","mp_package_blobs","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_clearances_00_serializable","mp_package_clearances","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_clearances_guard","mp_package_clearances","mp_package_store_guard_clearance",INSERT_GUARD,false],
 ["mp_package_clearances_no_change","mp_package_clearances","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_clearances_no_truncate","mp_package_clearances","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_compile_records_00_serializable","mp_package_compile_records","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_compile_records_guard","mp_package_compile_records","mp_package_store_guard_compile",INSERT_GUARD,false],
 ["mp_package_compile_records_no_change","mp_package_compile_records","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_compile_records_no_truncate","mp_package_compile_records","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_evidence_records_00_serializable","mp_package_evidence_records","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_evidence_records_guard","mp_package_evidence_records","mp_package_store_guard_evidence",INSERT_GUARD,false],
 ["mp_package_evidence_records_no_change","mp_package_evidence_records","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_evidence_records_no_truncate","mp_package_evidence_records","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_exports_00_serializable","mp_package_exports","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_exports_complete","mp_package_exports","mp_package_store_guard_export_complete",DEFERRED_AFTER_INSERT,true],
 ["mp_package_exports_guard","mp_package_exports","mp_package_store_guard_export",INSERT_GUARD,false],
 ["mp_package_exports_no_change","mp_package_exports","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_exports_no_truncate","mp_package_exports","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_files_00_serializable","mp_package_files","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_files_guard","mp_package_files","mp_package_store_guard_file",INSERT_GUARD,false],
 ["mp_package_files_no_change","mp_package_files","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_files_no_truncate","mp_package_files","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_status_events_00_serializable","mp_package_status_events","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_status_events_guard","mp_package_status_events","mp_package_store_guard_status",INSERT_GUARD,false],
 ["mp_package_status_events_no_change","mp_package_status_events","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_status_events_no_truncate","mp_package_status_events","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_store_schema_00_serializable","mp_package_store_schema","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_store_schema_no_change","mp_package_store_schema","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_store_schema_no_truncate","mp_package_store_schema","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_trace_records_00_serializable","mp_package_trace_records","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_trace_records_guard","mp_package_trace_records","mp_package_store_guard_trace",INSERT_GUARD,false],
 ["mp_package_trace_records_no_change","mp_package_trace_records","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_trace_records_no_truncate","mp_package_trace_records","mp_package_store_freeze",FREEZE_STATEMENT,false],
 ["mp_package_validations_00_serializable","mp_package_validations","mp_package_store_require_serializable",INSERT_GUARD,false],
 ["mp_package_validations_guard","mp_package_validations","mp_package_store_guard_validation",INSERT_GUARD,false],
 ["mp_package_validations_no_change","mp_package_validations","mp_package_store_freeze",FREEZE_ROW,false],
 ["mp_package_validations_no_truncate","mp_package_validations","mp_package_store_freeze",FREEZE_STATEMENT,false]
]);
export const FREEZE_TRIGGERS=Object.freeze(PACKAGE_STORE_GUARDS.filter(item=>item[2]==='mp_package_store_freeze'));
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const COLUMNS=Object.freeze({
 mp_package_attempts:[col("export_id","uuid",true),col("attempt_no","integer",true),col("attempt_id","text",true),col("package_hash","text",true),col("pass","boolean",true),col("codes","text[]",true),col("gate_results","jsonb",true),col("evidence_refs","jsonb",true),col("validator_engine_hash","text",true),col("validated_at_ms","bigint",true),col("validated_at_utc","text",true)],
 mp_package_blobs:[col("sha256","text",true),col("size","bigint",true),col("content","bytea",true)],
 mp_package_clearances:[col("export_id","uuid",true),col("blocker","text",true),col("ordinal","smallint",true),col("run_id","uuid",true),col("parameter_hash","text",true),col("evidence_hash","text",true),col("recorded_at_ms","bigint",true)],
 mp_package_compile_records:[col("compile_id","uuid",true,"gen_random_uuid()"),col("export_id","uuid",true),col("ordinal","smallint",true),col("indicator_sha256","text",true),col("pine_version","text",true),col("errors","jsonb",true),col("warnings","jsonb",true),col("unresolved_references","integer",true),col("collisions","integer",true),col("duplicate_bindings","integer",true),col("mapping_check","jsonb",true),col("compiled_at_ms","bigint",true),col("compiled_at_utc","text",true),col("operator_role","text",true),col("method","text",true)],
 mp_package_evidence_records:[col("evidence_id","uuid",true,"gen_random_uuid()"),col("export_id","uuid",true),col("ordinal","smallint",true),col("kind","text",true),col("record","jsonb",true),col("evidence_hash","text",true),col("recorded_at_ms","bigint",true)],
 mp_package_exports:[col("export_id","uuid",true),col("owner_id","text",true),col("bot_id","text",true),col("run_id","uuid",true),col("mode","text",true),col("pine_count","smallint",true),col("fixture","boolean",true),col("gate_version","text",true),col("library_versions","jsonb",true),col("binding","jsonb",true),col("binding_hash","text",true),col("package_hash","text",true),col("b0","jsonb",true),col("created_at","bigint",true),col("created_at_utc","text",true)],
 mp_package_files:[col("export_id","uuid",true),col("path","text",true),col("sha256","text",true),col("bytes","bigint",true)],
 mp_package_status_events:[col("export_id","uuid",true),col("seq","integer",true),col("status","text",true),col("codes","text[]",true),col("attempt_no","integer",false),col("at_ms","bigint",true),col("at_utc","text",true)],
 mp_package_store_schema:[col("version","integer",true)],
 mp_package_trace_records:[col("export_id","uuid",true),col("path","text",true),col("sha256","text",true),col("decisions_hash","text",true),col("steps_digest","text",true),col("holdout_digest","text",true),col("run_engine_hash","text",true),col("producer_closure_hash","text",true),col("method","text",true),col("recorded_at_ms","bigint",true)],
 mp_package_validations:[col("export_id","uuid",true),col("package_hash","text",true),col("binding_hash","text",true),col("attempt_id","text",true),col("gate_results","jsonb",true),col("validator_engine_hash","text",true),col("fixture","boolean",true),col("mode","text",true),col("validated_at_ms","bigint",true),col("validated_at_utc","text",true)],
});
const CONSTRAINTS=Object.freeze({
 mp_package_attempts:{
  mp_package_attempts_attempt_id_check:["c","CHECK ((length(attempt_id) > 0))"],
  mp_package_attempts_attempt_id_key:["u","UNIQUE (attempt_id)"],
  mp_package_attempts_attempt_no_check:["c","CHECK (((attempt_no >= 1) AND (attempt_no <= 5)))"],
  mp_package_attempts_codes_check:["c","CHECK (((cardinality(codes) = 0) OR ((array_ndims(codes) = 1) AND (array_position(codes, NULL::text) IS NULL) AND (array_to_string(codes, ','::text) ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$'::text))))"],
  mp_package_attempts_evidence_refs_check:["c","CHECK ((jsonb_typeof(evidence_refs) = 'object'::text))"],
  mp_package_attempts_export_package_fkey:["f","FOREIGN KEY (export_id, package_hash) REFERENCES mp_package_exports(export_id, package_hash)"],
  mp_package_attempts_gate_results_check:["c","CHECK ((jsonb_typeof(gate_results) = 'array'::text))"],
  mp_package_attempts_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_attempts_pass_check:["c","CHECK ((pass = (cardinality(codes) = 0)))"],
  mp_package_attempts_pkey:["p","PRIMARY KEY (export_id, attempt_no)"],
  mp_package_attempts_validated_at_ms_check:["c","CHECK (((validated_at_ms >= 0) AND (validated_at_ms <= '253402300799999'::bigint)))"],
  mp_package_attempts_validated_at_utc_check:["c","CHECK ((validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  mp_package_attempts_validator_hash_check:["c","CHECK ((validator_engine_hash ~ '^[0-9a-f]{64}$'::text))"]},
 mp_package_blobs:{
  mp_package_blobs_hash_content_check:["c","CHECK ((encode(sha256(content), 'hex'::text) = sha256))"],
  mp_package_blobs_pkey:["p","PRIMARY KEY (sha256)"],
  mp_package_blobs_sha256_check:["c","CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_blobs_sha256_size_key:["u","UNIQUE (sha256, size)"],
  mp_package_blobs_size_check:["c","CHECK (((size >= 0) AND (size <= 16777216)))"],
  mp_package_blobs_size_content_check:["c","CHECK ((octet_length(content) = size))"]},
 mp_package_clearances:{
  mp_package_clearances_blocker_check:["c","CHECK ((blocker = ANY (ARRAY['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED'::text, 'CUSTOM_REPAINT_EVIDENCE_REQUIRED'::text])))"],
  mp_package_clearances_evidence_hash_check:["c","CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_clearances_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES mp_package_exports(export_id)"],
  mp_package_clearances_ordinal_check:["c","CHECK (((ordinal >= 1) AND (ordinal <= 3)))"],
  mp_package_clearances_parameter_hash_check:["c","CHECK ((parameter_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_clearances_pkey:["p","PRIMARY KEY (export_id, blocker, ordinal, evidence_hash)"],
  mp_package_clearances_recorded_at_check:["c","CHECK (((recorded_at_ms >= 0) AND (recorded_at_ms <= '253402300799999'::bigint)))"]},
 mp_package_compile_records:{
  mp_package_compile_records_compiled_at_ms_check:["c","CHECK (((compiled_at_ms >= 0) AND (compiled_at_ms <= '253402300799999'::bigint)))"],
  mp_package_compile_records_compiled_at_utc_check:["c","CHECK ((compiled_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  mp_package_compile_records_counts_check:["c","CHECK (((unresolved_references >= 0) AND (collisions >= 0) AND (duplicate_bindings >= 0)))"],
  mp_package_compile_records_errors_check:["c","CHECK ((jsonb_typeof(errors) = 'array'::text))"],
  mp_package_compile_records_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES mp_package_exports(export_id)"],
  mp_package_compile_records_indicator_check:["c","CHECK ((indicator_sha256 ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_compile_records_mapping_check:["c","CHECK ((jsonb_typeof(mapping_check) = 'array'::text))"],
  mp_package_compile_records_method_check:["c","CHECK ((length(method) > 0))"],
  mp_package_compile_records_operator_role_check:["c","CHECK ((length(operator_role) > 0))"],
  mp_package_compile_records_ordinal_check:["c","CHECK (((ordinal >= 1) AND (ordinal <= 3)))"],
  mp_package_compile_records_pine_version_check:["c","CHECK ((length(pine_version) > 0))"],
  mp_package_compile_records_pkey:["p","PRIMARY KEY (compile_id)"],
  mp_package_compile_records_warnings_check:["c","CHECK ((jsonb_typeof(warnings) = 'array'::text))"]},
 mp_package_evidence_records:{
  mp_package_evidence_records_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES mp_package_exports(export_id)"],
  mp_package_evidence_records_hash_check:["c","CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_evidence_records_kind_check:["c","CHECK ((kind = ANY (ARRAY['dataset_alignment'::text, 'native_parity'::text, 'bridge_parity'::text, 'repaint'::text])))"],
  mp_package_evidence_records_ordinal_check:["c","CHECK (((ordinal >= 1) AND (ordinal <= 3)))"],
  mp_package_evidence_records_pkey:["p","PRIMARY KEY (evidence_id)"],
  mp_package_evidence_records_record_check:["c","CHECK ((jsonb_typeof(record) = 'object'::text))"],
  mp_package_evidence_records_recorded_at_check:["c","CHECK (((recorded_at_ms >= 0) AND (recorded_at_ms <= '253402300799999'::bigint)))"],
  mp_package_evidence_records_unique_key:["u","UNIQUE (export_id, ordinal, kind, evidence_hash)"]},
 mp_package_exports:{
  mp_package_exports_b0_check:["c","CHECK ((jsonb_typeof(b0) = 'object'::text))"],
  mp_package_exports_binding_check:["c","CHECK ((jsonb_typeof(binding) = 'object'::text))"],
  mp_package_exports_binding_hash_check:["c","CHECK ((binding_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_exports_binding_ties_check:["c","CHECK (COALESCE((((binding ->> 'owner_id'::text) = owner_id) AND ((binding ->> 'bot_id'::text) = bot_id) AND ((binding ->> 'run_id'::text) = (run_id)::text) AND ((binding ->> 'mode'::text) = mode) AND ((binding -> 'pine_count'::text) = to_jsonb(pine_count)) AND ((binding -> 'fixture'::text) = to_jsonb(fixture)) AND ((binding ->> 'created_at'::text) = created_at_utc)), false))"],
  mp_package_exports_bot_id_fkey:["f","FOREIGN KEY (bot_id) REFERENCES users(id)"],
  mp_package_exports_created_at_check:["c","CHECK (((created_at >= 0) AND (created_at <= '253402300799999'::bigint)))"],
  mp_package_exports_created_at_utc_check:["c","CHECK ((created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  mp_package_exports_export_package_key:["u","UNIQUE (export_id, package_hash)"],
  mp_package_exports_fixture_check:["c","CHECK (fixture)"],
  mp_package_exports_gate_version_check:["c","CHECK ((length(gate_version) > 0))"],
  mp_package_exports_library_versions_check:["c","CHECK ((jsonb_typeof(library_versions) = 'object'::text))"],
  mp_package_exports_mode_check:["c","CHECK ((mode = 'MULTI_PINE'::text))"],
  mp_package_exports_owner_id_fkey:["f","FOREIGN KEY (owner_id) REFERENCES users(id)"],
  mp_package_exports_owner_run_key:["u","UNIQUE (owner_id, run_id)"],
  mp_package_exports_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_exports_pine_count_check:["c","CHECK (((pine_count >= 2) AND (pine_count <= 3)))"],
  mp_package_exports_pkey:["p","PRIMARY KEY (export_id)"]},
 mp_package_files:{
  mp_package_files_blob_fkey:["f","FOREIGN KEY (sha256, bytes) REFERENCES mp_package_blobs(sha256, size)"],
  mp_package_files_bytes_check:["c","CHECK (((bytes >= 0) AND (bytes <= 16777216)))"],
  mp_package_files_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES mp_package_exports(export_id)"],
  mp_package_files_path_check:["c","CHECK ((path ~ '^(inputs\\.json|risk-profile\\.json|setup-guide\\.md|validation\\.html|quant-data/(manifest|metrics|validation)\\.json|quant-data/(equity|trades|decisions)\\.csv|members/[1-3]/indicator\\.(pine|json)|quant-data/members/[1-3]/parity\\.json)$'::text))"],
  mp_package_files_pkey:["p","PRIMARY KEY (export_id, path)"],
  mp_package_files_sha256_check:["c","CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"]},
 mp_package_status_events:{
  mp_package_status_events_at_ms_check:["c","CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  mp_package_status_events_at_utc_check:["c","CHECK ((at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  mp_package_status_events_attempt_fkey:["f","FOREIGN KEY (export_id, attempt_no) REFERENCES mp_package_attempts(export_id, attempt_no)"],
  mp_package_status_events_attempt_key:["u","UNIQUE (export_id, attempt_no)"],
  mp_package_status_events_codes_check:["c","CHECK (((cardinality(codes) = 0) OR ((array_ndims(codes) = 1) AND (array_position(codes, NULL::text) IS NULL) AND (array_to_string(codes, ','::text) ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$'::text))))"],
  mp_package_status_events_codes_status_check:["c","CHECK ((((status = 'EXPORT_INTERNAL'::text) AND (cardinality(codes) = 0)) OR ((status = 'EXPORT_REFUSED'::text) AND (cardinality(codes) > 0)) OR (status = 'EXPORT_CANDIDATE'::text)))"],
  mp_package_status_events_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES mp_package_exports(export_id)"],
  mp_package_status_events_first_check:["c","CHECK ((((seq = 1) AND (status = 'EXPORT_CANDIDATE'::text) AND (attempt_no IS NULL)) OR ((seq > 1) AND (attempt_no IS NOT NULL))))"],
  mp_package_status_events_pkey:["p","PRIMARY KEY (export_id, seq)"],
  mp_package_status_events_seq_check:["c","CHECK ((seq >= 1))"],
  mp_package_status_events_status_check:["c","CHECK ((status = ANY (ARRAY['EXPORT_CANDIDATE'::text, 'EXPORT_INTERNAL'::text, 'EXPORT_REFUSED'::text])))"]},
 mp_package_store_schema:{
  mp_package_store_schema_pkey:["p","PRIMARY KEY (version)"],
  mp_package_store_schema_version_check:["c","CHECK ((version = 1))"]},
 mp_package_trace_records:{
  mp_package_trace_records_closure_check:["c","CHECK ((producer_closure_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_trace_records_decisions_check:["c","CHECK ((decisions_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_trace_records_export_id_fkey:["f","FOREIGN KEY (export_id) REFERENCES mp_package_exports(export_id)"],
  mp_package_trace_records_holdout_check:["c","CHECK ((holdout_digest ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_trace_records_method_check:["c","CHECK ((method = 'stored-holdout-decisions-v1'::text))"],
  mp_package_trace_records_path_check:["c","CHECK ((path = ANY (ARRAY['quant-data/equity.csv'::text, 'quant-data/trades.csv'::text, 'quant-data/decisions.csv'::text])))"],
  mp_package_trace_records_pkey:["p","PRIMARY KEY (export_id, path)"],
  mp_package_trace_records_recorded_at_check:["c","CHECK (((recorded_at_ms >= 0) AND (recorded_at_ms <= '253402300799999'::bigint)))"],
  mp_package_trace_records_run_engine_check:["c","CHECK ((run_engine_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_trace_records_sha256_check:["c","CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_trace_records_steps_check:["c","CHECK ((steps_digest ~ '^[0-9a-f]{64}$'::text))"]},
 mp_package_validations:{
  mp_package_validations_attempt_id_fkey:["f","FOREIGN KEY (attempt_id) REFERENCES mp_package_attempts(attempt_id)"],
  mp_package_validations_binding_hash_check:["c","CHECK ((binding_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_validations_export_package_fkey:["f","FOREIGN KEY (export_id, package_hash) REFERENCES mp_package_exports(export_id, package_hash)"],
  mp_package_validations_export_package_key:["u","UNIQUE (export_id, package_hash)"],
  mp_package_validations_fixture_check:["c","CHECK (fixture)"],
  mp_package_validations_gate_results_check:["c","CHECK ((jsonb_typeof(gate_results) = 'array'::text))"],
  mp_package_validations_mode_check:["c","CHECK ((mode = 'MULTI_PINE'::text))"],
  mp_package_validations_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  mp_package_validations_pkey:["p","PRIMARY KEY (export_id)"],
  mp_package_validations_validated_at_ms_check:["c","CHECK (((validated_at_ms >= 0) AND (validated_at_ms <= '253402300799999'::bigint)))"],
  mp_package_validations_validated_at_utc_check:["c","CHECK ((validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  mp_package_validations_validator_hash_check:["c","CHECK ((validator_engine_hash ~ '^[0-9a-f]{64}$'::text))"]},
});
const INDEXES=Object.freeze({
 mp_package_attempts_attempt_id_key:"CREATE UNIQUE INDEX mp_package_attempts_attempt_id_key ON public.mp_package_attempts USING btree (attempt_id)",
 mp_package_attempts_pkey:"CREATE UNIQUE INDEX mp_package_attempts_pkey ON public.mp_package_attempts USING btree (export_id, attempt_no)",
 mp_package_blobs_pkey:"CREATE UNIQUE INDEX mp_package_blobs_pkey ON public.mp_package_blobs USING btree (sha256)",
 mp_package_blobs_sha256_size_key:"CREATE UNIQUE INDEX mp_package_blobs_sha256_size_key ON public.mp_package_blobs USING btree (sha256, size)",
 mp_package_clearances_pkey:"CREATE UNIQUE INDEX mp_package_clearances_pkey ON public.mp_package_clearances USING btree (export_id, blocker, ordinal, evidence_hash)",
 mp_package_compile_records_export:"CREATE INDEX mp_package_compile_records_export ON public.mp_package_compile_records USING btree (export_id)",
 mp_package_compile_records_pkey:"CREATE UNIQUE INDEX mp_package_compile_records_pkey ON public.mp_package_compile_records USING btree (compile_id)",
 mp_package_evidence_records_pkey:"CREATE UNIQUE INDEX mp_package_evidence_records_pkey ON public.mp_package_evidence_records USING btree (evidence_id)",
 mp_package_evidence_records_unique_key:"CREATE UNIQUE INDEX mp_package_evidence_records_unique_key ON public.mp_package_evidence_records USING btree (export_id, ordinal, kind, evidence_hash)",
 mp_package_exports_export_package_key:"CREATE UNIQUE INDEX mp_package_exports_export_package_key ON public.mp_package_exports USING btree (export_id, package_hash)",
 mp_package_exports_owner_run_key:"CREATE UNIQUE INDEX mp_package_exports_owner_run_key ON public.mp_package_exports USING btree (owner_id, run_id)",
 mp_package_exports_pkey:"CREATE UNIQUE INDEX mp_package_exports_pkey ON public.mp_package_exports USING btree (export_id)",
 mp_package_files_pkey:"CREATE UNIQUE INDEX mp_package_files_pkey ON public.mp_package_files USING btree (export_id, path)",
 mp_package_status_events_attempt_key:"CREATE UNIQUE INDEX mp_package_status_events_attempt_key ON public.mp_package_status_events USING btree (export_id, attempt_no)",
 mp_package_status_events_pkey:"CREATE UNIQUE INDEX mp_package_status_events_pkey ON public.mp_package_status_events USING btree (export_id, seq)",
 mp_package_store_schema_pkey:"CREATE UNIQUE INDEX mp_package_store_schema_pkey ON public.mp_package_store_schema USING btree (version)",
 mp_package_trace_records_pkey:"CREATE UNIQUE INDEX mp_package_trace_records_pkey ON public.mp_package_trace_records USING btree (export_id, path)",
 mp_package_validations_export_package_key:"CREATE UNIQUE INDEX mp_package_validations_export_package_key ON public.mp_package_validations USING btree (export_id, package_hash)",
 mp_package_validations_pkey:"CREATE UNIQUE INDEX mp_package_validations_pkey ON public.mp_package_validations USING btree (export_id)"});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireBase(db){
  if(!await exists(db,'users'))throw Error('Multi-Pine package store requires the base users table');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the package-store SQL file itself. */
async function expectedFunctions(){
  const text=await sql('mp-package-store.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS ([\\w\\[\\]]+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Package-store definition not found: '+name);
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
// Triggers that carry a package-store name on any table, triggers bound to a package-store function under any name, and every other non-internal trigger on a package-store table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,
  (SELECT k.contype FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint) AS constraint_type
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the package-store SQL; an empty list means exact. */
function functionDifferences(row,expected){
  const reasons=[];
  if(row.prosecdef!==false)reasons.push('SECURITY_DEFINER');
  if(!(Array.isArray(row.proconfig)&&row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))reasons.push('SEARCH_PATH');
  if(normalize(row.prosrc)!==normalize(expected.body))reasons.push('BODY');
  if(row.lanname!==expected.language||row.returns.toLowerCase()!==expected.returns||row.provolatile!==expected.volatility||row.proleakproof!==false
    ||row.proisstrict!==false||row.proretset!==false||row.prokind!=='f'||row.proparallel!=='u')reasons.push('ATTRIBUTES');
  return reasons;
}

// Derived objects that can expose package-store rows to a role that holds no privilege on the package-store tables: a privilege check on a parent, a view, a publication or a
// referencing table is not a privilege on the package-store table. $1 is the table oid, $2 the oids of all package-store tables (their own keys and rules are not derived objects).
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
 * Read-only exact classification of every package-store object. state is ABSENT, INSTALLED or OTHER. problems lists present objects that are not exactly
 * the package-store SQL, missing lists expected objects that do not exist. Never calls a package-store function.
 */
export async function classifyMpPackageStore(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[PACKAGE_STORE_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
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
    const guard=PACKAGE_STORE_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const deferred=guard[4];
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''&&row.tgoldtable===null&&row.tgnewtable===null
      &&(deferred?row.tgconstraint!==0&&row.constraint_type==='t'&&row.tgdeferrable&&row.tginitdeferred:row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred);
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of PACKAGE_STORE_GUARDS)
    if(!triggers.some(row=>row.tgname===name&&row.relname===table&&row.nspname==='public'))missing.push('TRIGGER_MISSING:'+name);
  for(const name of Object.keys(INDEXES))
    if(!relations.some(row=>row.relname===name))missing.push('INDEX_MISSING:'+name);
  if(tables.some(row=>row.relname===MARKER_TABLE)&&!problems.some(item=>item.startsWith('TABLE_DEFINITION:'+MARKER_TABLE))){
    // The runtime role holds no privilege on the marker: report that instead of throwing 42501. --inspect runs as the schema owner.
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

// REFERENCES is no privilege the shared inspection knows; it is the one table privilege that would let a role add a foreign key onto a package-store table.
const referencesHeld=async(db,role,table)=>(await db.query(`SELECT pg_catalog.has_table_privilege($1,c.oid,'REFERENCES') OR pg_catalog.has_any_column_privilege($1,c.oid,'REFERENCES')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role($1,r.oid,'MEMBER') AND (pg_catalog.has_table_privilege(r.oid,c.oid,'REFERENCES')
  OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'REFERENCES'))) AS held FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($2)`,[role,'public.'+table])).rows[0]?.held===true;

/**
 * Catalog facts and the failures they imply, read only. The role checks are the shared inspection of runtime-role-inspection.js.
 * With runtimeRole: the role is not a superuser or BYPASSRLS and is a member of no such role, owns no package-store table or function, and holds no privilege at all
 * (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES) on any package-store table, itself or through any role it can reach by membership (INHERIT FALSE
 * included); it may not SET session_replication_role and holds no CREATE on schema public. With fixtureRole: the same boundary with the privileges of the fixture
 * role: SELECT and INSERT on the ten record tables and SELECT on the marker table (required unless requireGrants is false), nothing that edits, removes or truncates
 * a row, no ownership, no superuser or BYPASSRLS (failures carry the prefix FIXTURE_ROLE_ instead of RUNTIME_ROLE_), and, because the export guard reads the run store
 * as the invoker, SELECT on both run-store record tables (FIXTURE_ROLE_RUN_STORE_UNREADABLE:<table>, required unless requireGrants is false). With both roles,
 * RUNTIME_ROLE_REACHES_FIXTURE_ROLE when the runtime role is the fixture role or a member of it (directly or through other roles).
 * Any state other than ABSENT also needs the run store INSTALLED (RUN_STORE_REQUIRED:<state>).
 */
export async function inspectMpPackageStore(db,{runtimeRole,fixtureRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',run_store_state:null,member_set_state:null,guards:[],functions:[],tables:[]};
  const classification=await classifyMpPackageStore(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  facts.run_store_state=(await classifyMpRunStore(db)).state;
  facts.member_set_state=(await classifyMpMemberSet(db)).state;
  if(classification.state!=='ABSENT'&&facts.run_store_state!=='INSTALLED')failures.push('RUN_STORE_REQUIRED:'+facts.run_store_state);
  // The marker function runs only when it is exactly the package-store SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('mp_package_store_version'))
    facts.marker=(await db.query('SELECT public.mp_package_store_version() v')).rows[0].v;
  if(facts.marker!==PACKAGE_STORE_MARKER)failures.push('MARKER_MISSING');
  for(const [name,table,fn] of PACKAGE_STORE_GUARDS){
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
      if(requireGrants&&classification.state==='INSTALLED'&&facts.run_store_state==='INSTALLED'){
        for(const name of RUN_STORE_TABLES){
          const readable=(await db.query(`SELECT pg_catalog.has_table_privilege($1,$2,'SELECT') AS readable`,[fixtureRole,'public.'+name])).rows[0].readable;
          if(!readable)failures.push('FIXTURE_ROLE_RUN_STORE_UNREADABLE:'+name);
        }
      }
    }
    // The runtime role must not be able to become the fixture role, whatever the grants on the package-store tables say today.
    if(runtimeRole&&inspected.found){
      const reaches=(await db.query(`SELECT r.oid IS NOT NULL AND f.oid IS NOT NULL AND pg_catalog.pg_has_role(r.oid,f.oid,'MEMBER') AS reaches
        FROM (SELECT 1) one LEFT JOIN pg_catalog.pg_roles r ON r.rolname=$1 LEFT JOIN pg_catalog.pg_roles f ON f.rolname=$2`,[runtimeRole,fixtureRole])).rows[0].reaches;
      facts.runtime_reaches_fixture=reaches===true;
      if(reaches===true)failures.push('RUNTIME_ROLE_REACHES_FIXTURE_ROLE');
    }
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the package-store objects are exactly absent or exactly the package-store SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Multi-Pine package store '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the package-store tables in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The run store (and with it the
 * member-set extension) must be INSTALLED before and after; the install holds no foreign key onto either. The catalog assertions run in the same transaction. Grants
 * are not changed: reapply scripts/grant-postgres-runtime.sql (the runtime role then holds no privilege on these tables) and, in an isolated cluster,
 * scripts/grant-postgres-mp-package-fixture.sql afterwards.
 */
export async function migrateMpPackageStore(db,{runtimeRole,fixtureRole}={}){
  if(db.isTransaction)throw Error('Multi-Pine package store migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireBase(db);
    const runStore=await classifyMpRunStore(db);
    if(runStore.state!=='INSTALLED')
      throw Error('Multi-Pine package store install refused; the run store must be INSTALLED, found '+runStore.state+' (no change made): '+[...runStore.problems,...runStore.missing].join(', '));
    const before=await classifyMpPackageStore(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('mp-package-store.sql'));
    const report=await inspectMpPackageStore(db,{runtimeRole,fixtureRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Multi-Pine package store verification failed: '+report.failures.join(', '));
    const afterRuns=await classifyMpRunStore(db),afterSets=await classifyMpMemberSet(db);
    if(afterRuns.state!=='INSTALLED')throw Error('Multi-Pine package store install changed the run store to '+afterRuns.state+': '+[...afterRuns.problems,...afterRuns.missing].join(', '));
    if(afterSets.state!=='INSTALLED')throw Error('Multi-Pine package store install changed the member-set extension to '+afterSets.state+': '+[...afterSets.problems,...afterSets.missing].join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while no record table holds a row. Every record table is locked ACCESS
 * EXCLUSIVE before the count, so no writer can add a row between the count and the drop. The marker row is not a record. Run this before the run-store rollback.
 */
export async function rollbackMpPackageStore(db){
  if(db.isTransaction)throw Error('Multi-Pine package store rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyMpPackageStore(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE '+PACKAGE_STORE_TABLES.map(table=>'public.'+table).join(', ')+' IN ACCESS EXCLUSIVE MODE');
      const counts=(await db.query(PACKAGE_STORE_TABLES.map(table=>"SELECT '"+table+"' AS table_name,count(*)::int AS n FROM public."+table).join(' UNION ALL '))).rows.filter(row=>row.n>0);
      if(counts.length)throw Error('Multi-Pine package store rollback refused; '+counts.reduce((sum,row)=>sum+row.n,0)+' record row(s) exist in '+counts.map(row=>row.table_name).join(', ')+' (no change made)');
      await db.query(await sql('mp-package-store-rollback.sql'));
    }
    const left=await classifyMpPackageStore(db);
    if(left.state!=='ABSENT')throw Error('Multi-Pine package store rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
