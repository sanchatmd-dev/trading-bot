import fs from 'node:fs/promises';
import {inspectRuntimeRole} from './runtime-role-inspection.js';
import {classifyQuantExposureRegister} from './quant-exposure-register-migration.js';

/**
 * QR-3 S2c: comparison specs, participants, status events, evaluation records, benchmarks, outcomes and replay events. Offline only: the maintenance lock excludes every participating API and worker.
 * The comparison tables are their own extension (marker table quant_comparison_schema, version 1); the base schema_version stays 14. The install
 * needs the base users table, the version-1 research extension (quant_job_schema version 1) and the exposure register extension INSTALLED, because
 * the create commit check reads the register. Nothing calls this module from db.migrate. Both sub-slices (S2c-1: specs, participants,
 * status events; S2c-2: evaluation records, benchmarks, outcomes, replay events) are in the one version-1 SQL file and in the lists below.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified
 * install could collide with, or silently accept, a foreign object that carries a comparison name. The states are:
 *   ABSENT     no comparison relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the comparison SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (partial, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra trigger, foreign
 *              constraint or index, overload or orphan with a comparison name, or a relation or function whose owner is not the
 *              owner of the marker table: OWNER_MISMATCH:<name>, or a column whose collation is not the database default:
 *              TABLE_DEFINITION:<table>:COLLATION).
 * Run the tool as the schema owner with the default search_path: the deparsed foreign key text names users unqualified only when public is on the
 * search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any comparison row
 * exists (insert-only evidence is never dropped by this tool) and never touches the exposure register. Table, constraint and index definitions
 * below are the PostgreSQL 16 deparsed text of a fresh install of quant-comparison.sql; function bodies are read from that file itself.
 */
export const COMPARISON_MARKER='quant-comparison-v1';
export const INSERT_ONLY_SQLSTATE='QR002';
export const INSERT_GUARD_SQLSTATE='QR004';
export const SERIALIZABLE_SQLSTATE='QR003';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const MARKER_TABLE='quant_comparison_schema';
/** The insert-only record tables, in the order the grant script and the inspection use. */
export const COMPARISON_TABLES=Object.freeze(['quant_comparison_specs','quant_comparison_participants','quant_comparison_status_events','quant_comparison_evaluations','quant_comparison_benchmarks',
  'quant_comparison_outcomes','quant_comparison_replay_events']);
const TABLES=[MARKER_TABLE,...COMPARISON_TABLES];
const FUNCTIONS=Object.freeze(['quant_comparison_version','quant_comparison_insert_only','quant_comparison_in_this_transaction','quant_comparison_require_serializable','quant_comparison_guard_spec',
  'quant_comparison_guard_participant','quant_comparison_guard_status_event','quant_comparison_check_create','quant_comparison_guard_evaluation','quant_comparison_guard_benchmark',
  'quant_comparison_guard_outcome','quant_comparison_guard_replay_event','quant_comparison_check_outcome']);
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. A constraint trigger is AFTER ROW INSERT, deferrable and initially deferred.
const FREEZE_ROW=27,FREEZE_STATEMENT=34,INSERT_GUARD=7,DEFERRED_AFTER_INSERT=5;
export const COMPARISON_GUARDS=Object.freeze([
 ['quant_comparison_benchmarks_00_serializable','quant_comparison_benchmarks','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_benchmarks_guard','quant_comparison_benchmarks','quant_comparison_guard_benchmark',INSERT_GUARD,false],
 ['quant_comparison_benchmarks_no_change','quant_comparison_benchmarks','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_benchmarks_no_truncate','quant_comparison_benchmarks','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_evaluations_00_serializable','quant_comparison_evaluations','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_evaluations_guard','quant_comparison_evaluations','quant_comparison_guard_evaluation',INSERT_GUARD,false],
 ['quant_comparison_evaluations_no_change','quant_comparison_evaluations','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_evaluations_no_truncate','quant_comparison_evaluations','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_outcomes_00_serializable','quant_comparison_outcomes','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_outcomes_complete','quant_comparison_outcomes','quant_comparison_check_outcome',DEFERRED_AFTER_INSERT,true],
 ['quant_comparison_outcomes_guard','quant_comparison_outcomes','quant_comparison_guard_outcome',INSERT_GUARD,false],
 ['quant_comparison_outcomes_no_change','quant_comparison_outcomes','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_outcomes_no_truncate','quant_comparison_outcomes','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_participants_00_serializable','quant_comparison_participants','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_participants_guard','quant_comparison_participants','quant_comparison_guard_participant',INSERT_GUARD,false],
 ['quant_comparison_participants_no_change','quant_comparison_participants','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_participants_no_truncate','quant_comparison_participants','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_replay_events_00_serializable','quant_comparison_replay_events','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_replay_events_guard','quant_comparison_replay_events','quant_comparison_guard_replay_event',INSERT_GUARD,false],
 ['quant_comparison_replay_events_no_change','quant_comparison_replay_events','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_replay_events_no_truncate','quant_comparison_replay_events','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_schema_00_serializable','quant_comparison_schema','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_schema_no_change','quant_comparison_schema','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_schema_no_truncate','quant_comparison_schema','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_specs_00_serializable','quant_comparison_specs','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_specs_complete','quant_comparison_specs','quant_comparison_check_create',DEFERRED_AFTER_INSERT,true],
 ['quant_comparison_specs_guard','quant_comparison_specs','quant_comparison_guard_spec',INSERT_GUARD,false],
 ['quant_comparison_specs_no_change','quant_comparison_specs','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_specs_no_truncate','quant_comparison_specs','quant_comparison_insert_only',FREEZE_STATEMENT,false],
 ['quant_comparison_status_events_00_serializable','quant_comparison_status_events','quant_comparison_require_serializable',INSERT_GUARD,false],
 ['quant_comparison_status_events_guard','quant_comparison_status_events','quant_comparison_guard_status_event',INSERT_GUARD,false],
 ['quant_comparison_status_events_no_change','quant_comparison_status_events','quant_comparison_insert_only',FREEZE_ROW,false],
 ['quant_comparison_status_events_no_truncate','quant_comparison_status_events','quant_comparison_insert_only',FREEZE_STATEMENT,false]]);
export const FREEZE_TRIGGERS=Object.freeze(COMPARISON_GUARDS.filter(item=>item[2]==='quant_comparison_insert_only'));
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
const INDEXES=Object.freeze({
 quant_comparison_benchmarks_pkey:"CREATE UNIQUE INDEX quant_comparison_benchmarks_pkey ON public.quant_comparison_benchmarks USING btree (comparison_id)",
 quant_comparison_evaluations_pkey:"CREATE UNIQUE INDEX quant_comparison_evaluations_pkey ON public.quant_comparison_evaluations USING btree (comparison_id, participant_id)",
 quant_comparison_outcomes_pkey:"CREATE UNIQUE INDEX quant_comparison_outcomes_pkey ON public.quant_comparison_outcomes USING btree (comparison_id)",
 quant_comparison_participants_pkey:"CREATE UNIQUE INDEX quant_comparison_participants_pkey ON public.quant_comparison_participants USING btree (comparison_id, participant_id)",
 quant_comparison_participants_position_key:"CREATE UNIQUE INDEX quant_comparison_participants_position_key ON public.quant_comparison_participants USING btree (comparison_id, \"position\")",
 quant_comparison_replay_events_comparison:"CREATE INDEX quant_comparison_replay_events_comparison ON public.quant_comparison_replay_events USING btree (comparison_id, at_ms)",
 quant_comparison_replay_events_pkey:"CREATE UNIQUE INDEX quant_comparison_replay_events_pkey ON public.quant_comparison_replay_events USING btree (replay_event_id)",
 quant_comparison_schema_pkey:"CREATE UNIQUE INDEX quant_comparison_schema_pkey ON public.quant_comparison_schema USING btree (version)",
 quant_comparison_specs_owner:"CREATE INDEX quant_comparison_specs_owner ON public.quant_comparison_specs USING btree (owner_id, frozen_at_ms)",
 quant_comparison_specs_pkey:"CREATE UNIQUE INDEX quant_comparison_specs_pkey ON public.quant_comparison_specs USING btree (comparison_id)",
 quant_comparison_specs_request_key:"CREATE UNIQUE INDEX quant_comparison_specs_request_key ON public.quant_comparison_specs USING btree (owner_id, request_key_hash) WHERE (request_key_hash IS NOT NULL)",
 quant_comparison_status_events_pkey:"CREATE UNIQUE INDEX quant_comparison_status_events_pkey ON public.quant_comparison_status_events USING btree (comparison_id, seq)"});
const COLUMNS=Object.freeze({
 quant_comparison_schema:[col("version","integer",true)],
 quant_comparison_specs:[col("comparison_id","text",true),col("owner_id","text",true),col("parent_comparison_id","text",false),col("mode","text",true),col("fixture","boolean",true),col("broker","text",true),col("symbol","text",true),col("timeframe","text",true),col("start_ms","bigint",true),col("end_ms","bigint",true),col("participant_count","smallint",true),col("context_key","text",true),col("spec_hash","text",true),col("spec_canonical","text",true),col("spec_body_hash","text",true),col("request_key_hash","text",false),col("frozen_at_ms","bigint",true)],
 quant_comparison_participants:[col("comparison_id","text",true),col("participant_id","text",true),col("position","smallint",true),col("source_hash","text",true),col("origin","text",true),col("fixture","boolean",true),col("context_key","text",true),col("freeze_canonical","text",true),col("freeze_hash","text",true)],
 quant_comparison_status_events:[col("comparison_id","text",true),col("seq","integer",true),col("status","text",true),col("reason_code","text",false),col("at_ms","bigint",true)],
 quant_comparison_evaluations:[col("comparison_id","text",true),col("participant_id","text",true),col("spec_hash","text",true),col("evaluation_run_id","text",false),col("body_canonical","text",true),col("body_hash","text",true),col("created_at_ms","bigint",true)],
 quant_comparison_benchmarks:[col("comparison_id","text",true),col("benchmark_id","text",true),col("spec_hash","text",true),col("body_canonical","text",true),col("body_hash","text",true),col("created_at_ms","bigint",true)],
 quant_comparison_outcomes:[col("comparison_id","text",true),col("outcome","text",true),col("spec_hash","text",true),col("context_key","text",true),col("body_canonical","text",true),col("outcome_hash","text",true),col("only_qualified_participant_id","text",false),col("created_at_ms","bigint",true)],
 quant_comparison_replay_events:[col("replay_event_id","uuid",true,"gen_random_uuid()"),col("comparison_id","text",true),col("kind","text",true),col("replay_run_id","text",false),col("prior_outcome_hash","text",true),col("replay_outcome_hash","text",false),col("first_differing_code","text",false),col("at_ms","bigint",true)]});
const CONSTRAINTS=Object.freeze({
 quant_comparison_schema:{
  quant_comparison_schema_pkey:["p","PRIMARY KEY (version)"],
  quant_comparison_schema_version_check:["c","CHECK ((version = 1))"]},
 quant_comparison_specs:{
  quant_comparison_specs_comparison_id_check:["c","CHECK ((comparison_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'::text))"],
  quant_comparison_specs_context_key_check:["c","CHECK ((context_key ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_specs_count_check:["c","CHECK (((participant_count >= 2) AND (participant_count <= 4)))"],
  quant_comparison_specs_frozen_at_check:["c","CHECK (((frozen_at_ms >= 0) AND (frozen_at_ms <= '253402300799999'::bigint)))"],
  quant_comparison_specs_market_check:["c","CHECK (((broker = 'binance-global'::text) AND (symbol = 'BTCUSDT'::text) AND (timeframe = '1'::text)))"],
  quant_comparison_specs_mode_check:["c","CHECK ((mode = 'STANDARDIZED'::text))"],
  quant_comparison_specs_owner_id_fkey:["f","FOREIGN KEY (owner_id) REFERENCES users(id)"],
  quant_comparison_specs_parent_check:["c","CHECK (((parent_comparison_id IS NULL) OR (parent_comparison_id <> comparison_id)))"],
  quant_comparison_specs_parent_fkey:["f","FOREIGN KEY (parent_comparison_id) REFERENCES quant_comparison_specs(comparison_id)"],
  quant_comparison_specs_pkey:["p","PRIMARY KEY (comparison_id)"],
  quant_comparison_specs_request_key_check:["c","CHECK (((request_key_hash IS NULL) OR (request_key_hash ~ '^[0-9a-f]{64}$'::text)))"],
  quant_comparison_specs_spec_body_check:["c","CHECK (COALESCE(((jsonb_typeof((spec_canonical)::jsonb) = 'object'::text) AND (((spec_canonical)::jsonb ->> 'version'::text) = 'qr3-spec-v1'::text) AND (((spec_canonical)::jsonb ->> 'mode'::text) = mode) AND (((spec_canonical)::jsonb ->> 'benchmark'::text) = 'qr3-bh-close-same-cost-v1'::text) AND\nCASE\n    WHEN (jsonb_typeof(((spec_canonical)::jsonb -> 'participants'::text)) = 'array'::text) THEN (jsonb_array_length(((spec_canonical)::jsonb -> 'participants'::text)) = participant_count)\n    ELSE false\nEND AND (jsonb_typeof(((spec_canonical)::jsonb #> '{period,start_ms}'::text[])) = 'number'::text) AND (((spec_canonical)::jsonb #>> '{period,start_ms}'::text[]) = (start_ms)::text) AND (jsonb_typeof(((spec_canonical)::jsonb #> '{period,end_ms}'::text[])) = 'number'::text) AND (((spec_canonical)::jsonb #>> '{period,end_ms}'::text[]) = (end_ms)::text)), false))"],
  quant_comparison_specs_spec_body_hash_check:["c","CHECK ((spec_body_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_specs_spec_digest_check:["c","CHECK ((encode(sha256(convert_to(spec_canonical, 'UTF8'::name)), 'hex'::text) = spec_body_hash))"],
  quant_comparison_specs_spec_hash_check:["c","CHECK ((spec_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_specs_spec_size_check:["c","CHECK ((octet_length(spec_canonical) <= 65536))"],
  quant_comparison_specs_window_check:["c","CHECK (((start_ms >= 0) AND ((start_ms % (60000)::bigint) = 0) AND (end_ms > start_ms) AND ((end_ms % (60000)::bigint) = 0) AND (end_ms <= '253402300800000'::bigint)))"]},
 quant_comparison_participants:{
  quant_comparison_participants_comparison_id_fkey:["f","FOREIGN KEY (comparison_id) REFERENCES quant_comparison_specs(comparison_id)"],
  quant_comparison_participants_context_key_check:["c","CHECK ((context_key ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_participants_fixture_check:["c","CHECK (((origin = 'FIXTURE'::text) = fixture))"],
  quant_comparison_participants_freeze_body_check:["c","CHECK (COALESCE(((jsonb_typeof((freeze_canonical)::jsonb) = 'object'::text) AND (((freeze_canonical)::jsonb ->> 'participant_id'::text) = participant_id) AND (((freeze_canonical)::jsonb ->> 'source_hash'::text) = source_hash) AND (jsonb_typeof(((freeze_canonical)::jsonb -> 'prior_exposed_by'::text)) = 'array'::text)), false))"],
  quant_comparison_participants_freeze_digest_check:["c","CHECK ((encode(sha256(convert_to(freeze_canonical, 'UTF8'::name)), 'hex'::text) = freeze_hash))"],
  quant_comparison_participants_freeze_hash_check:["c","CHECK ((freeze_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_participants_freeze_size_check:["c","CHECK ((octet_length(freeze_canonical) <= 262144))"],
  quant_comparison_participants_origin_check:["c","CHECK ((origin = ANY (ARRAY['LIBRARY_RUN'::text, 'IMPORTED'::text, 'FIXTURE'::text])))"],
  quant_comparison_participants_participant_id_check:["c","CHECK ((participant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'::text))"],
  quant_comparison_participants_pkey:["p","PRIMARY KEY (comparison_id, participant_id)"],
  quant_comparison_participants_position_check:["c","CHECK (((\"position\" >= 1) AND (\"position\" <= 4)))"],
  quant_comparison_participants_position_key:["u","UNIQUE (comparison_id, \"position\")"],
  quant_comparison_participants_source_hash_check:["c","CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text))"]},
 quant_comparison_status_events:{
  quant_comparison_status_events_at_ms_check:["c","CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  quant_comparison_status_events_comparison_id_fkey:["f","FOREIGN KEY (comparison_id) REFERENCES quant_comparison_specs(comparison_id)"],
  quant_comparison_status_events_first_check:["c","CHECK (((seq = 1) = (status = 'SPEC_FROZEN'::text)))"],
  quant_comparison_status_events_pkey:["p","PRIMARY KEY (comparison_id, seq)"],
  quant_comparison_status_events_reason_check:["c","CHECK (((reason_code IS NULL) OR (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text)))"],
  quant_comparison_status_events_reason_status_check:["c","CHECK ((((status = 'FAILED'::text) AND (reason_code IS NOT NULL)) OR (status = 'CANCELLED'::text) OR ((status <> ALL (ARRAY['FAILED'::text, 'CANCELLED'::text])) AND (reason_code IS NULL))))"],
  quant_comparison_status_events_seq_check:["c","CHECK ((seq >= 1))"],
  quant_comparison_status_events_status_check:["c","CHECK ((status = ANY (ARRAY['SPEC_FROZEN'::text, 'EVALUATING'::text, 'COMPLETE'::text, 'FAILED'::text, 'CANCELLED'::text])))"]},
 quant_comparison_evaluations:{
  quant_comparison_evaluations_body_check:["c","CHECK (COALESCE(((jsonb_typeof((body_canonical)::jsonb) = 'object'::text) AND (jsonb_typeof(((body_canonical)::jsonb -> 'record_comparison_id'::text)) = 'string'::text) AND (((body_canonical)::jsonb ->> 'record_comparison_id'::text) = comparison_id) AND (jsonb_typeof(((body_canonical)::jsonb -> 'record_spec_hash'::text)) = 'string'::text) AND (((body_canonical)::jsonb ->> 'record_spec_hash'::text) = spec_hash) AND (jsonb_typeof(((body_canonical)::jsonb #> '{window,start_ms}'::text[])) = 'number'::text) AND (jsonb_typeof(((body_canonical)::jsonb #> '{window,end_ms}'::text[])) = 'number'::text)), false))"],
  quant_comparison_evaluations_body_digest_check:["c","CHECK ((encode(sha256(convert_to(body_canonical, 'UTF8'::name)), 'hex'::text) = body_hash))"],
  quant_comparison_evaluations_body_hash_check:["c","CHECK ((body_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_evaluations_body_size_check:["c","CHECK ((octet_length(body_canonical) <= 4194304))"],
  quant_comparison_evaluations_created_at_check:["c","CHECK (((created_at_ms >= 0) AND (created_at_ms <= '253402300799999'::bigint)))"],
  quant_comparison_evaluations_participant_fkey:["f","FOREIGN KEY (comparison_id, participant_id) REFERENCES quant_comparison_participants(comparison_id, participant_id)"],
  quant_comparison_evaluations_pkey:["p","PRIMARY KEY (comparison_id, participant_id)"],
  quant_comparison_evaluations_run_id_check:["c","CHECK (((evaluation_run_id IS NULL) OR (evaluation_run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'::text)))"],
  quant_comparison_evaluations_spec_hash_check:["c","CHECK ((spec_hash ~ '^[0-9a-f]{64}$'::text))"]},
 quant_comparison_benchmarks:{
  quant_comparison_benchmarks_benchmark_id_check:["c","CHECK ((benchmark_id = 'qr3-bh-close-same-cost-v1'::text))"],
  quant_comparison_benchmarks_body_check:["c","CHECK (COALESCE(((jsonb_typeof((body_canonical)::jsonb) = 'object'::text) AND (((body_canonical)::jsonb ->> 'benchmark_id'::text) = benchmark_id)), false))"],
  quant_comparison_benchmarks_body_digest_check:["c","CHECK ((encode(sha256(convert_to(body_canonical, 'UTF8'::name)), 'hex'::text) = body_hash))"],
  quant_comparison_benchmarks_body_hash_check:["c","CHECK ((body_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_benchmarks_body_size_check:["c","CHECK ((octet_length(body_canonical) <= 262144))"],
  quant_comparison_benchmarks_comparison_id_fkey:["f","FOREIGN KEY (comparison_id) REFERENCES quant_comparison_specs(comparison_id)"],
  quant_comparison_benchmarks_created_at_check:["c","CHECK (((created_at_ms >= 0) AND (created_at_ms <= '253402300799999'::bigint)))"],
  quant_comparison_benchmarks_pkey:["p","PRIMARY KEY (comparison_id)"],
  quant_comparison_benchmarks_spec_hash_check:["c","CHECK ((spec_hash ~ '^[0-9a-f]{64}$'::text))"]},
 quant_comparison_outcomes:{
  quant_comparison_outcomes_body_check:["c","CHECK (COALESCE(((jsonb_typeof((body_canonical)::jsonb) = 'object'::text) AND (((body_canonical)::jsonb ->> 'version'::text) = 'qr3-outcome-v1'::text) AND (((body_canonical)::jsonb ->> 'mode'::text) = 'STANDARDIZED'::text) AND (((body_canonical)::jsonb ->> 'outcome'::text) = outcome) AND (((body_canonical)::jsonb ->> 'spec_hash'::text) = spec_hash) AND (((body_canonical)::jsonb ->> 'context_key'::text) = context_key) AND (jsonb_typeof(((body_canonical)::jsonb -> 'participants'::text)) = 'array'::text) AND (NOT (((body_canonical)::jsonb ->> 'only_qualified_participant_id'::text) IS DISTINCT FROM only_qualified_participant_id))), false))"],
  quant_comparison_outcomes_body_digest_check:["c","CHECK ((encode(sha256(convert_to(body_canonical, 'UTF8'::name)), 'hex'::text) = outcome_hash))"],
  quant_comparison_outcomes_body_size_check:["c","CHECK ((octet_length(body_canonical) <= 262144))"],
  quant_comparison_outcomes_comparison_id_fkey:["f","FOREIGN KEY (comparison_id) REFERENCES quant_comparison_specs(comparison_id)"],
  quant_comparison_outcomes_context_key_check:["c","CHECK ((context_key ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_outcomes_created_at_check:["c","CHECK (((created_at_ms >= 0) AND (created_at_ms <= '253402300799999'::bigint)))"],
  quant_comparison_outcomes_only_qualified_check:["c","CHECK (((only_qualified_participant_id IS NULL) OR (outcome = 'NO_QUALIFIED_RESULT'::text)))"],
  quant_comparison_outcomes_only_qualified_fkey:["f","FOREIGN KEY (comparison_id, only_qualified_participant_id) REFERENCES quant_comparison_participants(comparison_id, participant_id)"],
  quant_comparison_outcomes_outcome_check:["c","CHECK ((outcome = ANY (ARRAY['QUALIFIED_RANKING'::text, 'QUALIFIED_TIE'::text, 'NO_QUALIFIED_RESULT'::text, 'INADEQUATE_EVIDENCE'::text])))"],
  quant_comparison_outcomes_outcome_hash_check:["c","CHECK ((outcome_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_outcomes_pkey:["p","PRIMARY KEY (comparison_id)"],
  quant_comparison_outcomes_spec_hash_check:["c","CHECK ((spec_hash ~ '^[0-9a-f]{64}$'::text))"]},
 quant_comparison_replay_events:{
  quant_comparison_replay_events_at_ms_check:["c","CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  quant_comparison_replay_events_code_check:["c","CHECK (((first_differing_code IS NULL) OR (first_differing_code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text)))"],
  quant_comparison_replay_events_comparison_id_fkey:["f","FOREIGN KEY (comparison_id) REFERENCES quant_comparison_specs(comparison_id)"],
  quant_comparison_replay_events_kind_check:["c","CHECK ((kind = ANY (ARRAY['REPLAY_MATCH'::text, 'REPLAY_MISMATCH'::text, 'REPRODUCTION_DISABLED'::text])))"],
  quant_comparison_replay_events_pkey:["p","PRIMARY KEY (replay_event_id)"],
  quant_comparison_replay_events_prior_hash_check:["c","CHECK ((prior_outcome_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_comparison_replay_events_replay_hash_check:["c","CHECK (((replay_outcome_hash IS NULL) OR (replay_outcome_hash ~ '^[0-9a-f]{64}$'::text)))"],
  quant_comparison_replay_events_run_id_check:["c","CHECK (((replay_run_id IS NULL) OR (replay_run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'::text)))"],
  quant_comparison_replay_events_shape_check:["c","CHECK (COALESCE((((kind = 'REPLAY_MATCH'::text) AND (replay_outcome_hash IS NOT NULL) AND (replay_outcome_hash = prior_outcome_hash) AND (first_differing_code IS NULL)) OR ((kind = 'REPLAY_MISMATCH'::text) AND (replay_outcome_hash IS NOT NULL) AND (replay_outcome_hash <> prior_outcome_hash) AND (first_differing_code IS NOT NULL)) OR ((kind = 'REPRODUCTION_DISABLED'::text) AND (replay_outcome_hash IS NULL) AND (first_differing_code IS NULL))), false))"]}});
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireExtension(db){
  if(!await exists(db,'quant_job_schema'))throw Error('Quant research extension 1 required');
  const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported quant_job_schema version');
}
/** The create commit check reads the register, so an install over an absent or foreign register is refused before any write. */
async function requireRegister(db){
  const register=await classifyQuantExposureRegister(db);
  if(register.state!=='INSTALLED')throw Error('Exposure register extension required before the comparison tables; its state is '+register.state+' (no change made)');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the comparison SQL file itself. */
async function expectedFunctions(){
  const text=await sql('quant-comparison.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS ([\\w\\[\\]]+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Comparison definition not found: '+name);
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
// Triggers that carry a comparison name on any table, triggers bound to a comparison function under any name, and every other
// non-internal trigger on a comparison table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,
  (SELECT k.contype FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint) AS constraint_type
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the comparison SQL; an empty list means exact. */
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
  return reasons;
}

/**
 * Read-only exact classification of every comparison object. state is ABSENT, INSTALLED or OTHER. problems lists present objects
 * that are not exactly the comparison SQL, missing lists expected objects that do not exist. Never calls a comparison function.
 */
export async function classifyQuantComparison(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[COMPARISON_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
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
    const guard=COMPARISON_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const deferred=guard[4];
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''&&row.tgoldtable===null&&row.tgnewtable===null
      &&(deferred?row.tgconstraint!==0&&row.constraint_type==='t'&&row.tgdeferrable&&row.tginitdeferred:row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred);
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of COMPARISON_GUARDS)
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
 * With runtimeRole the privilege boundary the comparison tables rely on is checked too: the role is not a superuser or BYPASSRLS and is a member
 * of no superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns no comparison table or function (ownership includes membership of the
 * owning role through pg_has_role MEMBER, which SET ROLE reaches even without inheritance), holds no TRIGGER or TRUNCATE privilege, no UPDATE and no
 * DELETE on any table, cannot write the marker table and (PostgreSQL 15 and later) may not SET session_replication_role. A forbidden privilege counts
 * when any role the runtime role can reach by membership holds it (INHERIT FALSE included); the role must not own schema public (also as database
 * owner) nor hold CREATE on it. With requireGrants the role must also hold SELECT and INSERT on every record table and SELECT on the marker table.
 * The database TEMP privilege is recorded, not judged, because every function pins search_path and the reader qualifies each relation.
 * An installed extension over an absent or foreign exposure register is a failure too (EXPOSURE_REGISTER_NOT_INSTALLED), because every create would fail.
 */
export async function inspectQuantComparison(db,{runtimeRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[],register_state:null};
  const classification=await classifyQuantComparison(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  // The marker function runs only when it is exactly the comparison SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('quant_comparison_version'))
    facts.marker=(await db.query('SELECT public.quant_comparison_version() v')).rows[0].v;
  if(facts.marker!==COMPARISON_MARKER)failures.push('MARKER_MISSING');
  if(classification.state==='INSTALLED'){
    facts.register_state=(await classifyQuantExposureRegister(db)).state;
    if(facts.register_state!=='INSTALLED')failures.push('EXPOSURE_REGISTER_NOT_INSTALLED:'+facts.register_state);
  }
  for(const [name,table,fn] of COMPARISON_GUARDS){
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

/** Refuses before any write unless the comparison objects are exactly absent or exactly the comparison SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Quant comparison '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the comparison tables in one transaction. Classifies first: writes only over ABSENT and nothing over INSTALLED. The catalog
 * assertions run in the same transaction. Grants are not changed: reapply scripts/grant-postgres-runtime.sql afterwards.
 */
export async function migrateQuantComparison(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Quant comparison migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);await requireRegister(db);
    const before=await classifyQuantComparison(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('quant-comparison.sql'));
    const report=await inspectQuantComparison(db,{runtimeRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Quant comparison verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while no record table holds a row. Every record
 * table is locked ACCESS EXCLUSIVE before the count, so no writer can add evidence between the count and the drop. The marker row is not evidence.
 * The exposure register is never touched: its rows stay, and its own rollback refuses while any row exists.
 */
export async function rollbackQuantComparison(db){
  if(db.isTransaction)throw Error('Quant comparison rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyQuantComparison(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      await db.query('LOCK TABLE '+COMPARISON_TABLES.map(table=>'public.'+table).join(', ')+' IN ACCESS EXCLUSIVE MODE');
      const counts=(await db.query(COMPARISON_TABLES.map(table=>"SELECT '"+table+"' AS table_name,count(*)::int AS n FROM public."+table).join(' UNION ALL '))).rows.filter(row=>row.n>0);
      if(counts.length)throw Error('Quant comparison rollback refused; '+counts.reduce((sum,row)=>sum+row.n,0)+' evidence row(s) exist in '+counts.map(row=>row.table_name).join(', ')+' (no change made)');
      await db.query(await sql('quant-comparison-rollback.sql'));
    }
    const left=await classifyQuantComparison(db);
    if(left.state!=='ABSENT')throw Error('Quant comparison rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
