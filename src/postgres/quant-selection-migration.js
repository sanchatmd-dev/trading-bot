import fs from 'node:fs/promises';
import {inspectRuntimeRole} from './runtime-role-inspection.js';
import {classifyQuantExposureRegister} from './quant-exposure-register-migration.js';
import {classifyBestInputsPackage} from './best-inputs-package-migration.js';

/**
 * QR-4 slices S2-1 and S2-2: insert-only qualified-selection tables (marker, registrations, universe, participants, status events, window freezes, evaluation starts, outcomes, replay events).
 * Offline only: the maintenance lock excludes every participating API and worker. The selection tables are their own extension (marker
 * table quant_selection_schema, version 1); the base schema_version stays 14. The install needs the version-1 research extension
 * (quant_job_schema version 1), the base users table, the exposure register extension (INSTALLED) and the Best Inputs package extension
 * (INSTALLED, the participant foreign key and guard read its tables). Nothing calls this module from db.migrate. Slice S2-2 added the freeze, start,
 * outcome and replay tables to the same uninstalled SQL file and to this module; slice S3 extends them again.
 *
 * Both directions CLASSIFY the live catalog before they write anything, because the SQL is plain CREATE statements and an unclassified
 * install could collide with, or silently accept, a foreign object that carries a selection name. The states are:
 *   ABSENT     no selection relation, function, standalone type or trigger exists;
 *   INSTALLED  every object is exactly the selection SQL (table shapes, constraints, indexes, function bodies, triggers);
 *   OTHER      anything else (partial, tampered body, SECURITY DEFINER, disabled or reshaped trigger, extra trigger, foreign
 *              constraint or index, overload or orphan with a selection name, an object owned by another role than the marker table,
 *              a column whose collation is not the database default: TABLE_DEFINITION:<table>:COLLATION).
 * Run the tool as the schema owner with the default search_path: the deparsed foreign key text names users and quant_jobs unqualified only
 * when public is on the search_path, otherwise the install classifies OTHER and is refused (loud, no write).
 * OTHER is refused with no write. Install on INSTALLED is a no-op. Rollback on ABSENT is a no-op. Rollback is refused while any selection
 * row or any QR4_SELECTION exposure register row exists (insert-only evidence is never dropped by this tool; RC-S26). Table, constraint and index definitions
 * below are the PostgreSQL 16 deparsed text of a fresh install of quant-selection.sql (generated from a scratch install, then reviewed);
 * function bodies are read from that file itself.
 */
export const SELECTION_MARKER='quant-selection-v1';
export const INSERT_ONLY_SQLSTATE='QR002';
export const INSERT_GUARD_SQLSTATE='QR004';
export const SERIALIZABLE_SQLSTATE='QR003';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const MARKER_TABLE='quant_selection_schema';
/** The insert-only record tables, in the order the grant script and the inspection use (S2-1 first, then the four tables of S2-2). */
export const SELECTION_TABLES=Object.freeze(['quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events',
  'quant_selection_window_freezes','quant_selection_evaluation_starts','quant_selection_outcomes','quant_selection_replay_events']);
/** Every table name the grant script lists as insert-only for QR-4. */
export const SELECTION_GRANT_TABLES=Object.freeze([...SELECTION_TABLES]);
const TABLES=[MARKER_TABLE,...SELECTION_TABLES];
/** The QR004 guard names (USING CONSTRAINT) that the application maps by name, never by message text. */
export const SELECTION_GUARD_NAMES=Object.freeze(['quant_selection_registration_clock','quant_selection_universe_member','quant_selection_participant_ready','quant_selection_participant_member',
  'quant_selection_status_transition','quant_selection_exposure_bind','quant_selection_registration_complete','quant_selection_freeze_order','quant_selection_start_order','quant_selection_start_deadline',
  'quant_selection_start_ready','quant_selection_outcome_order','quant_selection_outcome_complete','quant_selection_first_start_complete','quant_selection_replay_order']);
const FUNCTIONS=Object.freeze(['quant_selection_version','quant_selection_now_ms','quant_selection_in_this_transaction','quant_selection_transitions','quant_selection_insert_only','quant_selection_require_serializable',
  'quant_selection_stamp_registration','quant_selection_stamp_event','quant_selection_guard_registration','quant_selection_guard_universe','quant_selection_guard_participant',
  'quant_selection_guard_status_event','quant_selection_check_registration_complete','quant_selection_stamp_freeze','quant_selection_stamp_start','quant_selection_stamp_outcome',
  'quant_selection_guard_freeze','quant_selection_guard_start','quant_selection_guard_outcome','quant_selection_guard_replay','quant_selection_check_first_start_complete','quant_selection_check_outcome_complete']);
const col=(name,type,notNull,def=null)=>({name,type,notNull,def});
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. A constraint trigger is AFTER ROW INSERT, deferrable and initially deferred.
const COLUMNS=Object.freeze({
 quant_selection_evaluation_starts:[col("selection_id","uuid",true),col("export_id","uuid",true),col("evaluation_run_id","text",true),col("parent_run_id","text",true),col("dataset_hash","text",true),col("engine_hash","text",true),col("started_at_ms","bigint",true)],
 quant_selection_outcomes:[col("selection_id","uuid",true),col("outcome","text",true),col("outcome_hash","text",true),col("body_canonical","text",true),col("created_at_ms","bigint",true)],
 quant_selection_participants:[col("selection_id","uuid",true),col("export_id","uuid",true),col("position","smallint",true),col("run_id","text",true),col("package_hash","text",true),col("source_hash","text",true),col("rules_hash","text",true),col("validation_package_hash","text",true),col("validated_at_utc","text",true)],
 quant_selection_registrations:[col("selection_id","uuid",true),col("owner_id","text",true),col("fixture","boolean",true),col("broker","text",true),col("symbol","text",true),col("timeframe","text",true),col("window_kind","text",true),col("start_ms","bigint",true),col("end_ms","bigint",true),col("warmup_bars","integer",true),col("evaluation_bars","integer",true),col("total_bars","integer",true),col("participant_count","smallint",true),col("admission_deadline_ms","bigint",true),col("registered_at_ms","bigint",true),col("frozen_at_ms","bigint",true),col("registration_key","text",true),col("registration_hash","text",true),col("body_canonical","text",true)],
 quant_selection_replay_events:[col("replay_event_id","uuid",true,"gen_random_uuid()"),col("selection_id","uuid",true),col("kind","text",true),col("stored_outcome_hash","text",true),col("recomputed_outcome_hash","text",false),col("at_ms","bigint",true)],
 quant_selection_schema:[col("version","integer",true)],
 quant_selection_status_events:[col("selection_id","uuid",true),col("seq","integer",true),col("event","text",true),col("status","text",true),col("code","text",false),col("detail","text",false),col("outcome","text",false),col("completed_evaluation_run_ids","text[]",true,"'{}'::text[]"),col("at_ms","bigint",true)],
 quant_selection_universe:[col("selection_id","uuid",true),col("position","smallint",true),col("run_id","text",true),col("member_kind","text",true),col("universe_status","text",true),col("first_code","text",false),col("export_id","uuid",false)],
 quant_selection_window_freezes:[col("selection_id","uuid",true),col("dataset_hash","text",true),col("start_ms","bigint",true),col("end_ms","bigint",true),col("bars_total","integer",true),col("frozen_at_ms","bigint",true)]});
const CONSTRAINTS=Object.freeze({
 quant_selection_evaluation_starts:{
  quant_selection_evaluation_starts_dataset_check:["c","CHECK ((dataset_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_evaluation_starts_engine_check:["c","CHECK ((engine_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_evaluation_starts_parent_check:["c","CHECK ((length(parent_run_id) > 0))"],
  quant_selection_evaluation_starts_participant_fkey:["f","FOREIGN KEY (selection_id, export_id) REFERENCES quant_selection_participants(selection_id, export_id)"],
  quant_selection_evaluation_starts_pkey:["p","PRIMARY KEY (selection_id, export_id)"],
  quant_selection_evaluation_starts_run_id_check:["c","CHECK (((length(evaluation_run_id) > 0) AND (length(evaluation_run_id) <= 200)))"],
  quant_selection_evaluation_starts_run_key:["u","UNIQUE (evaluation_run_id)"],
  quant_selection_evaluation_starts_started_at_check:["c","CHECK (((started_at_ms >= 0) AND (started_at_ms <= '253402300799999'::bigint)))"]},
 quant_selection_outcomes:{
  quant_selection_outcomes_body_evaluations_check:["c","CHECK (COALESCE((jsonb_typeof(((body_canonical)::jsonb -> 'evaluations'::text)) = 'array'::text), false))"],
  quant_selection_outcomes_body_hash_check:["c","CHECK ((encode(sha256(convert_to(body_canonical, 'UTF8'::name)), 'hex'::text) = outcome_hash))"],
  quant_selection_outcomes_body_json_check:["c","CHECK ((jsonb_typeof((body_canonical)::jsonb) = 'object'::text))"],
  quant_selection_outcomes_body_no_hash_check:["c","CHECK ((NOT ((body_canonical)::jsonb ? 'outcome_hash'::text)))"],
  quant_selection_outcomes_body_outcome_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'outcome'::text) = outcome), false))"],
  quant_selection_outcomes_body_selection_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'selection_id'::text) = (selection_id)::text), false))"],
  quant_selection_outcomes_body_size_check:["c","CHECK ((octet_length(body_canonical) <= 262144))"],
  quant_selection_outcomes_body_status_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'status'::text) = 'SELECTION_COMPLETED'::text), false))"],
  quant_selection_outcomes_body_version_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'version'::text) = 'qr4-outcome-v1'::text), false))"],
  quant_selection_outcomes_created_at_check:["c","CHECK (((created_at_ms >= 0) AND (created_at_ms <= '253402300799999'::bigint)))"],
  quant_selection_outcomes_hash_check:["c","CHECK ((outcome_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_outcomes_outcome_check:["c","CHECK ((outcome = ANY (ARRAY['BEST_IN_SCOPE'::text, 'TIED_IN_SCOPE'::text, 'NO_QUALIFYING_STRATEGY'::text, 'INADEQUATE_EVIDENCE'::text])))"],
  quant_selection_outcomes_pkey:["p","PRIMARY KEY (selection_id)"],
  quant_selection_outcomes_selection_id_fkey:["f","FOREIGN KEY (selection_id) REFERENCES quant_selection_registrations(selection_id)"]},
 quant_selection_participants:{
  quant_selection_participants_export_fkey:["f","FOREIGN KEY (export_id, package_hash) REFERENCES bi_exports(export_id, package_hash)"],
  quant_selection_participants_package_hash_check:["c","CHECK ((package_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_participants_pkey:["p","PRIMARY KEY (selection_id, export_id)"],
  quant_selection_participants_position_check:["c","CHECK (((\"position\" >= 1) AND (\"position\" <= 4)))"],
  quant_selection_participants_position_key:["u","UNIQUE (selection_id, \"position\")"],
  quant_selection_participants_rules_hash_check:["c","CHECK ((rules_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_participants_run_id_fkey:["f","FOREIGN KEY (run_id) REFERENCES quant_jobs(run_id)"],
  quant_selection_participants_run_key:["u","UNIQUE (selection_id, run_id)"],
  quant_selection_participants_selection_id_fkey:["f","FOREIGN KEY (selection_id) REFERENCES quant_selection_registrations(selection_id)"],
  quant_selection_participants_source_hash_check:["c","CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_participants_validated_at_check:["c","CHECK ((validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$'::text))"],
  quant_selection_participants_validation_hash_check:["c","CHECK (((validation_package_hash ~ '^[0-9a-f]{64}$'::text) AND (validation_package_hash = package_hash)))"]},
 quant_selection_registrations:{
  quant_selection_registrations_bars_check:["c","CHECK (((warmup_bars >= 0) AND (evaluation_bars >= 1) AND (evaluation_bars = ((end_ms - start_ms) / 60000)) AND (total_bars = (evaluation_bars + warmup_bars))))"],
  quant_selection_registrations_body_deadline_check:["c","CHECK (COALESCE(((((body_canonical)::jsonb ->> 'admission_deadline_ms'::text))::bigint = admission_deadline_ms), false))"],
  quant_selection_registrations_body_fixture_check:["c","CHECK (COALESCE((((body_canonical)::jsonb -> 'fixture'::text) = to_jsonb(fixture)), false))"],
  quant_selection_registrations_body_hash_check:["c","CHECK ((encode(sha256(convert_to(body_canonical, 'UTF8'::name)), 'hex'::text) = registration_hash))"],
  quant_selection_registrations_body_json_check:["c","CHECK ((jsonb_typeof((body_canonical)::jsonb) = 'object'::text))"],
  quant_selection_registrations_body_key_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'registration_key'::text) = registration_key), false))"],
  quant_selection_registrations_body_market_check:["c","CHECK (COALESCE((((body_canonical)::jsonb -> 'market'::text) = jsonb_build_object('broker', broker, 'symbol', symbol, 'timeframe', timeframe)), false))"],
  quant_selection_registrations_body_no_hash_check:["c","CHECK ((NOT ((body_canonical)::jsonb ? 'registration_hash'::text)))"],
  quant_selection_registrations_body_owner_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'owner_id'::text) = owner_id), false))"],
  quant_selection_registrations_body_participants_check:["c","CHECK (COALESCE(\nCASE\n    WHEN (jsonb_typeof(((body_canonical)::jsonb -> 'participants'::text)) = 'array'::text) THEN ((jsonb_array_length(((body_canonical)::jsonb -> 'participants'::text)) = participant_count) AND ((((body_canonical)::jsonb ->> 'participant_count'::text))::integer = participant_count))\n    ELSE NULL::boolean\nEND, false))"],
  quant_selection_registrations_body_prior_check:["c","CHECK (COALESCE(\nCASE\n    WHEN (jsonb_typeof(((body_canonical)::jsonb -> 'prior_selection_ids'::text)) = 'array'::text) THEN (jsonb_array_length(((body_canonical)::jsonb -> 'prior_selection_ids'::text)) = (((body_canonical)::jsonb ->> 'prior_selection_count'::text))::integer)\n    ELSE NULL::boolean\nEND, false))"],
  quant_selection_registrations_body_registered_check:["c","CHECK (COALESCE(((((body_canonical)::jsonb ->> 'registered_at_ms'::text))::bigint = registered_at_ms), false))"],
  quant_selection_registrations_body_selection_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'selection_id'::text) = (selection_id)::text), false))"],
  quant_selection_registrations_body_size_check:["c","CHECK ((octet_length(body_canonical) <= 262144))"],
  quant_selection_registrations_body_tolerance_drawdown_check:["c","CHECK (COALESCE(((jsonb_typeof((((body_canonical)::jsonb -> 'objective'::text) -> 'tie_tolerance_drawdown_pp'::text)) = 'string'::text) AND ((((body_canonical)::jsonb -> 'objective'::text) ->> 'tie_tolerance_drawdown_pp'::text) ~ '^[0-9]+(\\.[0-9]+)?$'::text)), false))"],
  quant_selection_registrations_body_tolerance_return_check:["c","CHECK (COALESCE(((jsonb_typeof((((body_canonical)::jsonb -> 'objective'::text) -> 'tie_tolerance_return_pp'::text)) = 'string'::text) AND ((((body_canonical)::jsonb -> 'objective'::text) ->> 'tie_tolerance_return_pp'::text) ~ '^[0-9]+(\\.[0-9]+)?$'::text)), false))"],
  quant_selection_registrations_body_universe_check:["c","CHECK (COALESCE(\nCASE\n    WHEN (jsonb_typeof(((body_canonical)::jsonb -> 'universe'::text)) = 'array'::text) THEN (jsonb_array_length(((body_canonical)::jsonb -> 'universe'::text)) >= participant_count)\n    ELSE NULL::boolean\nEND, false))"],
  quant_selection_registrations_body_version_check:["c","CHECK (COALESCE((((body_canonical)::jsonb ->> 'version'::text) = 'qr4-registration-v1'::text), false))"],
  quant_selection_registrations_body_window_check:["c","CHECK (COALESCE((((body_canonical)::jsonb -> 'window'::text) = jsonb_build_object('kind', window_kind, 'start_ms', start_ms, 'end_ms', end_ms, 'warmup_bars', warmup_bars, 'evaluation_bars', evaluation_bars, 'total_bars', total_bars)), false))"],
  quant_selection_registrations_deadline_check:["c","CHECK (((admission_deadline_ms >= end_ms) AND (admission_deadline_ms <= '253402300799999'::bigint)))"],
  quant_selection_registrations_frozen_at_check:["c","CHECK (((frozen_at_ms >= 0) AND (frozen_at_ms <= '253402300799999'::bigint)))"],
  quant_selection_registrations_hash_check:["c","CHECK ((registration_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_registrations_key_check:["c","CHECK ((registration_key ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_registrations_market_check:["c","CHECK (((broker = 'binance-global'::text) AND (symbol = 'BTCUSDT'::text) AND (timeframe = '1'::text)))"],
  quant_selection_registrations_owner_id_fkey:["f","FOREIGN KEY (owner_id) REFERENCES users(id)"],
  quant_selection_registrations_owner_key_key:["u","UNIQUE (owner_id, registration_key)"],
  quant_selection_registrations_participant_count_check:["c","CHECK (((participant_count >= 2) AND (participant_count <= 4)))"],
  quant_selection_registrations_pkey:["p","PRIMARY KEY (selection_id)"],
  quant_selection_registrations_registered_at_check:["c","CHECK (((registered_at_ms >= 0) AND (registered_at_ms <= '253402300799999'::bigint)))"],
  quant_selection_registrations_window_check:["c","CHECK (((start_ms >= 0) AND ((start_ms % (60000)::bigint) = 0) AND (end_ms > start_ms) AND ((end_ms % (60000)::bigint) = 0) AND (end_ms <= '253402300800000'::bigint)))"],
  quant_selection_registrations_window_kind_check:["c","CHECK ((window_kind = ANY (ARRAY['PROSPECTIVE'::text, 'FORWARD_PAST'::text])))"]},
 quant_selection_replay_events:{
  quant_selection_replay_events_at_ms_check:["c","CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  quant_selection_replay_events_kind_check:["c","CHECK ((kind = 'SELECTION_REPLAY_MISMATCH'::text))"],
  quant_selection_replay_events_pkey:["p","PRIMARY KEY (replay_event_id)"],
  quant_selection_replay_events_recomputed_check:["c","CHECK (((recomputed_outcome_hash IS NULL) OR ((recomputed_outcome_hash ~ '^[0-9a-f]{64}$'::text) AND (recomputed_outcome_hash <> stored_outcome_hash))))"],
  quant_selection_replay_events_selection_id_fkey:["f","FOREIGN KEY (selection_id) REFERENCES quant_selection_outcomes(selection_id)"],
  quant_selection_replay_events_stored_check:["c","CHECK ((stored_outcome_hash ~ '^[0-9a-f]{64}$'::text))"]},
 quant_selection_schema:{
  quant_selection_schema_pkey:["p","PRIMARY KEY (version)"],
  quant_selection_schema_version_check:["c","CHECK ((version = 1))"]},
 quant_selection_status_events:{
  quant_selection_status_events_at_ms_check:["c","CHECK (((at_ms >= 0) AND (at_ms <= '253402300799999'::bigint)))"],
  quant_selection_status_events_code_check:["c","CHECK (((code IS NULL) OR (code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text)))"],
  quant_selection_status_events_code_status_check:["c","CHECK (((status = 'SELECTION_INCOMPLETE'::text) = (code IS NOT NULL)))"],
  quant_selection_status_events_completed_runs_check:["c","CHECK (((cardinality(completed_evaluation_run_ids) = 0) OR ((array_ndims(completed_evaluation_run_ids) = 1) AND (cardinality(completed_evaluation_run_ids) <= 4) AND (array_position(completed_evaluation_run_ids, NULL::text) IS NULL))))"],
  quant_selection_status_events_detail_check:["c","CHECK (((detail IS NULL) OR (length(detail) <= 200)))"],
  quant_selection_status_events_event_check:["c","CHECK ((event = ANY (ARRAY['REGISTER'::text, 'FIRST_EVALUATION_START'::text, 'OWNER_CANCEL'::text, 'PARTICIPANT_INELIGIBLE'::text, 'WINDOW_RECHECK_FAILED'::text, 'DEADLINE_PASSED'::text, 'WINDOW_DATA_UNAVAILABLE'::text, 'ALL_EVALUATIONS_DONE'::text])))"],
  quant_selection_status_events_first_check:["c","CHECK (((seq = 1) = (event = 'REGISTER'::text)))"],
  quant_selection_status_events_outcome_check:["c","CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['BEST_IN_SCOPE'::text, 'TIED_IN_SCOPE'::text, 'NO_QUALIFYING_STRATEGY'::text, 'INADEQUATE_EVIDENCE'::text]))))"],
  quant_selection_status_events_outcome_status_check:["c","CHECK (((status = 'SELECTION_COMPLETED'::text) = (outcome IS NOT NULL)))"],
  quant_selection_status_events_pkey:["p","PRIMARY KEY (selection_id, seq)"],
  quant_selection_status_events_selection_id_fkey:["f","FOREIGN KEY (selection_id) REFERENCES quant_selection_registrations(selection_id)"],
  quant_selection_status_events_seq_check:["c","CHECK ((seq >= 1))"],
  quant_selection_status_events_status_check:["c","CHECK ((status = ANY (ARRAY['SELECTION_REGISTERED'::text, 'SELECTION_EVALUATING'::text, 'SELECTION_COMPLETED'::text, 'SELECTION_INCOMPLETE'::text, 'SELECTION_CANCELLED'::text])))"]},
 quant_selection_universe:{
  quant_selection_universe_code_check:["c","CHECK (((first_code IS NULL) OR (first_code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text)))"],
  quant_selection_universe_export_key:["u","UNIQUE (selection_id, export_id)"],
  quant_selection_universe_kind_check:["c","CHECK ((member_kind = ANY (ARRAY['RESEARCH_RUN'::text, 'IMPORTED_BUNDLE'::text, 'EVALUATION_RUN'::text])))"],
  quant_selection_universe_pkey:["p","PRIMARY KEY (selection_id, \"position\")"],
  quant_selection_universe_position_check:["c","CHECK ((\"position\" >= 1))"],
  quant_selection_universe_run_id_check:["c","CHECK ((length(run_id) > 0))"],
  quant_selection_universe_run_key:["u","UNIQUE (selection_id, run_id)"],
  quant_selection_universe_selection_id_fkey:["f","FOREIGN KEY (selection_id) REFERENCES quant_selection_registrations(selection_id)"],
  quant_selection_universe_status_check:["c","CHECK ((universe_status = ANY (ARRAY['PARTICIPANT'::text, 'QUALIFIED_STALE'::text, 'EXCLUDED'::text])))"],
  quant_selection_universe_status_code_check:["c","CHECK (((universe_status = 'PARTICIPANT'::text) = (first_code IS NULL)))"]},
 quant_selection_window_freezes:{
  quant_selection_window_freezes_bars_check:["c","CHECK ((bars_total >= 1))"],
  quant_selection_window_freezes_frozen_at_check:["c","CHECK (((frozen_at_ms >= 0) AND (frozen_at_ms <= '253402300799999'::bigint)))"],
  quant_selection_window_freezes_hash_check:["c","CHECK ((dataset_hash ~ '^[0-9a-f]{64}$'::text))"],
  quant_selection_window_freezes_pkey:["p","PRIMARY KEY (selection_id)"],
  quant_selection_window_freezes_selection_id_fkey:["f","FOREIGN KEY (selection_id) REFERENCES quant_selection_registrations(selection_id)"],
  quant_selection_window_freezes_window_check:["c","CHECK (((start_ms >= 0) AND ((start_ms % (60000)::bigint) = 0) AND (end_ms > start_ms) AND ((end_ms % (60000)::bigint) = 0) AND (end_ms <= '253402300800000'::bigint)))"]}});
const INDEXES=Object.freeze({
 quant_selection_evaluation_starts_pkey:"CREATE UNIQUE INDEX quant_selection_evaluation_starts_pkey ON public.quant_selection_evaluation_starts USING btree (selection_id, export_id)",
 quant_selection_evaluation_starts_run_key:"CREATE UNIQUE INDEX quant_selection_evaluation_starts_run_key ON public.quant_selection_evaluation_starts USING btree (evaluation_run_id)",
 quant_selection_outcomes_pkey:"CREATE UNIQUE INDEX quant_selection_outcomes_pkey ON public.quant_selection_outcomes USING btree (selection_id)",
 quant_selection_participants_pkey:"CREATE UNIQUE INDEX quant_selection_participants_pkey ON public.quant_selection_participants USING btree (selection_id, export_id)",
 quant_selection_participants_position_key:"CREATE UNIQUE INDEX quant_selection_participants_position_key ON public.quant_selection_participants USING btree (selection_id, \"position\")",
 quant_selection_participants_run_key:"CREATE UNIQUE INDEX quant_selection_participants_run_key ON public.quant_selection_participants USING btree (selection_id, run_id)",
 quant_selection_registrations_owner_frozen:"CREATE INDEX quant_selection_registrations_owner_frozen ON public.quant_selection_registrations USING btree (owner_id, frozen_at_ms)",
 quant_selection_registrations_owner_key_key:"CREATE UNIQUE INDEX quant_selection_registrations_owner_key_key ON public.quant_selection_registrations USING btree (owner_id, registration_key)",
 quant_selection_registrations_pkey:"CREATE UNIQUE INDEX quant_selection_registrations_pkey ON public.quant_selection_registrations USING btree (selection_id)",
 quant_selection_replay_events_pkey:"CREATE UNIQUE INDEX quant_selection_replay_events_pkey ON public.quant_selection_replay_events USING btree (replay_event_id)",
 quant_selection_schema_pkey:"CREATE UNIQUE INDEX quant_selection_schema_pkey ON public.quant_selection_schema USING btree (version)",
 quant_selection_status_events_pkey:"CREATE UNIQUE INDEX quant_selection_status_events_pkey ON public.quant_selection_status_events USING btree (selection_id, seq)",
 quant_selection_universe_export_key:"CREATE UNIQUE INDEX quant_selection_universe_export_key ON public.quant_selection_universe USING btree (selection_id, export_id)",
 quant_selection_universe_pkey:"CREATE UNIQUE INDEX quant_selection_universe_pkey ON public.quant_selection_universe USING btree (selection_id, \"position\")",
 quant_selection_universe_run_key:"CREATE UNIQUE INDEX quant_selection_universe_run_key ON public.quant_selection_universe USING btree (selection_id, run_id)",
 quant_selection_window_freezes_pkey:"CREATE UNIQUE INDEX quant_selection_window_freezes_pkey ON public.quant_selection_window_freezes USING btree (selection_id)"});
export const SELECTION_GUARDS=Object.freeze([
 ["quant_selection_evaluation_starts_00_serializable","quant_selection_evaluation_starts","quant_selection_require_serializable",7,false],
 ["quant_selection_evaluation_starts_01_stamp","quant_selection_evaluation_starts","quant_selection_stamp_start",7,false],
 ["quant_selection_evaluation_starts_guard","quant_selection_evaluation_starts","quant_selection_guard_start",7,false],
 ["quant_selection_evaluation_starts_no_change","quant_selection_evaluation_starts","quant_selection_insert_only",27,false],
 ["quant_selection_evaluation_starts_no_truncate","quant_selection_evaluation_starts","quant_selection_insert_only",34,false],
 ["quant_selection_outcomes_00_serializable","quant_selection_outcomes","quant_selection_require_serializable",7,false],
 ["quant_selection_outcomes_01_stamp","quant_selection_outcomes","quant_selection_stamp_outcome",7,false],
 ["quant_selection_outcomes_complete","quant_selection_outcomes","quant_selection_check_outcome_complete",5,true],
 ["quant_selection_outcomes_guard","quant_selection_outcomes","quant_selection_guard_outcome",7,false],
 ["quant_selection_outcomes_no_change","quant_selection_outcomes","quant_selection_insert_only",27,false],
 ["quant_selection_outcomes_no_truncate","quant_selection_outcomes","quant_selection_insert_only",34,false],
 ["quant_selection_participants_00_serializable","quant_selection_participants","quant_selection_require_serializable",7,false],
 ["quant_selection_participants_guard","quant_selection_participants","quant_selection_guard_participant",7,false],
 ["quant_selection_participants_no_change","quant_selection_participants","quant_selection_insert_only",27,false],
 ["quant_selection_participants_no_truncate","quant_selection_participants","quant_selection_insert_only",34,false],
 ["quant_selection_registrations_00_serializable","quant_selection_registrations","quant_selection_require_serializable",7,false],
 ["quant_selection_registrations_01_stamp","quant_selection_registrations","quant_selection_stamp_registration",7,false],
 ["quant_selection_registrations_complete","quant_selection_registrations","quant_selection_check_registration_complete",5,true],
 ["quant_selection_registrations_guard","quant_selection_registrations","quant_selection_guard_registration",7,false],
 ["quant_selection_registrations_no_change","quant_selection_registrations","quant_selection_insert_only",27,false],
 ["quant_selection_registrations_no_truncate","quant_selection_registrations","quant_selection_insert_only",34,false],
 ["quant_selection_replay_events_00_serializable","quant_selection_replay_events","quant_selection_require_serializable",7,false],
 ["quant_selection_replay_events_01_stamp","quant_selection_replay_events","quant_selection_stamp_event",7,false],
 ["quant_selection_replay_events_guard","quant_selection_replay_events","quant_selection_guard_replay",7,false],
 ["quant_selection_replay_events_no_change","quant_selection_replay_events","quant_selection_insert_only",27,false],
 ["quant_selection_replay_events_no_truncate","quant_selection_replay_events","quant_selection_insert_only",34,false],
 ["quant_selection_schema_00_serializable","quant_selection_schema","quant_selection_require_serializable",7,false],
 ["quant_selection_schema_no_change","quant_selection_schema","quant_selection_insert_only",27,false],
 ["quant_selection_schema_no_truncate","quant_selection_schema","quant_selection_insert_only",34,false],
 ["quant_selection_status_events_00_serializable","quant_selection_status_events","quant_selection_require_serializable",7,false],
 ["quant_selection_status_events_01_stamp","quant_selection_status_events","quant_selection_stamp_event",7,false],
 ["quant_selection_status_events_first_start_complete","quant_selection_status_events","quant_selection_check_first_start_complete",5,true],
 ["quant_selection_status_events_guard","quant_selection_status_events","quant_selection_guard_status_event",7,false],
 ["quant_selection_status_events_no_change","quant_selection_status_events","quant_selection_insert_only",27,false],
 ["quant_selection_status_events_no_truncate","quant_selection_status_events","quant_selection_insert_only",34,false],
 ["quant_selection_universe_00_serializable","quant_selection_universe","quant_selection_require_serializable",7,false],
 ["quant_selection_universe_guard","quant_selection_universe","quant_selection_guard_universe",7,false],
 ["quant_selection_universe_no_change","quant_selection_universe","quant_selection_insert_only",27,false],
 ["quant_selection_universe_no_truncate","quant_selection_universe","quant_selection_insert_only",34,false],
 ["quant_selection_window_freezes_00_serializable","quant_selection_window_freezes","quant_selection_require_serializable",7,false],
 ["quant_selection_window_freezes_01_stamp","quant_selection_window_freezes","quant_selection_stamp_freeze",7,false],
 ["quant_selection_window_freezes_guard","quant_selection_window_freezes","quant_selection_guard_freeze",7,false],
 ["quant_selection_window_freezes_no_change","quant_selection_window_freezes","quant_selection_insert_only",27,false],
 ["quant_selection_window_freezes_no_truncate","quant_selection_window_freezes","quant_selection_insert_only",34,false]
]);

export const FREEZE_TRIGGERS=Object.freeze(SELECTION_GUARDS.filter(item=>item[2]==='quant_selection_insert_only'));
const RELATION_NAMES=Object.freeze([...TABLES,...Object.keys(INDEXES)]);
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireExtension(db){
  if(!await exists(db,'quant_job_schema'))throw Error('Quant research extension 1 required');
  const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported quant_job_schema version');
  // RC-S23 and the register guard of the registration check: both extensions must be exactly installed before this one.
  const register=await classifyQuantExposureRegister(db);
  if(register.state!=='INSTALLED')throw Error('Exposure register extension required (state '+register.state+')');
  const builder=await classifyBestInputsPackage(db);
  if(builder.state!=='INSTALLED')throw Error('Best Inputs package extension required (state '+builder.state+')');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the selection SQL file itself. */
async function expectedFunctions(){
  const text=await sql('quant-selection.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS ([\\w\\[\\]]+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Selection definition not found: '+name);
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
// Triggers that carry a selection name on any table, triggers bound to a selection function under any name, and every other
// non-internal trigger on a selection table.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,
  (SELECT k.contype FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint) AS constraint_type
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND (t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) OR (n.nspname='public' AND c.relname=ANY($3))) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the selection SQL; an empty list means exact. */
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
 * Read-only exact classification of every selection object. state is ABSENT, INSTALLED or OTHER. problems lists present objects
 * that are not exactly the selection SQL, missing lists expected objects that do not exist. Never calls a selection function.
 */
export async function classifyQuantSelection(db){
  const bodies=await expectedFunctions();
  const relations=(await db.query(RELATION_ROWS,[RELATION_NAMES])).rows;
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const types=(await db.query(`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typrelid=0 AND typname=ANY($1)`,[RELATION_NAMES])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[SELECTION_GUARDS.map(guard=>guard[0]),FUNCTIONS,TABLES])).rows;
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
  // Cross-lane rule: every relation and every function is owned by the owner of the marker table, so a re-owned object (whose owner could
  // disable its triggers or replace it) is never classified as the release text.
  const marker=relations.find(row=>row.relname===MARKER_TABLE);
  if(marker){
    for(const row of relations)if(String(row.relowner)!==String(marker.relowner))problems.push('OWNER_MISMATCH:'+row.relname);
    for(const row of functions)if(String(row.proowner)!==String(marker.relowner))problems.push('OWNER_MISMATCH:'+row.proname);
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
    const guard=SELECTION_GUARDS.find(item=>item[0]===row.tgname&&item[1]===row.relname&&row.nspname==='public');
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const deferred=guard[4];
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===guard[3]&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''&&row.tgoldtable===null&&row.tgnewtable===null
      &&(deferred?row.tgconstraint!==0&&row.constraint_type==='t'&&row.tgdeferrable&&row.tginitdeferred:row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred);
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [name,table] of SELECTION_GUARDS)
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
 * With runtimeRole the privilege boundary the selection relies on is checked too: the
 * role is not a superuser or BYPASSRLS and is a member of no superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns no selection
 * table or function (ownership includes membership of the owning role through pg_has_role MEMBER, which SET ROLE reaches even without
 * inheritance), holds no TRIGGER or TRUNCATE privilege, no UPDATE and no DELETE on any table, cannot write the marker table and
 * (PostgreSQL 15 and later) may not SET session_replication_role. A forbidden privilege counts when any role the runtime role can reach by
 * membership holds it (INHERIT FALSE included); the role must not own schema public (also as database owner) nor hold CREATE on it. With requireGrants the role must also hold SELECT and INSERT on every
 * record table and SELECT on the marker table. The database TEMP privilege is recorded, not judged, because every function pins
 * search_path and the reader qualifies each relation.
 */
export async function inspectQuantSelection(db,{runtimeRole,requireGrants=true}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[]};
  const classification=await classifyQuantSelection(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...classification.tables);
  if(classification.state!=='INSTALLED')failures.push(...classification.missing);
  // The marker function runs only when it is exactly the selection SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('quant_selection_version'))
    facts.marker=(await db.query('SELECT public.quant_selection_version() v')).rows[0].v;
  if(facts.marker!==SELECTION_MARKER)failures.push('MARKER_MISSING');
  for(const [name,table,fn] of SELECTION_GUARDS){
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

/** Refuses before any write unless the selection objects are exactly absent or exactly the selection SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','INSTALLED'].includes(classification.state))
    throw Error('Quant selection '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs the selection tables in one transaction, after the prerequisite extensions are exactly installed. Classifies first: writes only over ABSENT and nothing over INSTALLED. The catalog
 * assertions run in the same transaction. Grants are not changed: reapply scripts/grant-postgres-runtime.sql afterwards.
 */
export async function migrateQuantSelection(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Quant selection migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await classifyQuantSelection(db);
    requireKnownState(before,'install');
    if(before.state==='ABSENT')await db.query(await sql('quant-selection.sql'));
    const report=await inspectQuantSelection(db,{runtimeRole,requireGrants:false});
    if(!report.ok||report.facts.state!=='INSTALLED')throw Error('Quant selection verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/**
 * Drops exactly the objects the install created, after classifying first, and only while no record table holds a row and the exposure register
 * holds no QR4_SELECTION row (RC-S26). The register is locked SHARE ROW EXCLUSIVE and every record table ACCESS EXCLUSIVE before the counts, so no
 * writer can add evidence between the counts and the drop. The marker row is not evidence. The register itself is never changed.
 */
export async function rollbackQuantSelection(db){
  if(db.isTransaction)throw Error('Quant selection rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyQuantSelection(db);
    requireKnownState(before,'rollback');
    if(before.state==='INSTALLED'){
      const register=await exists(db,'quant_exposure_register');
      if(register)await db.query('LOCK TABLE public.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE');
      await db.query('LOCK TABLE '+SELECTION_TABLES.map(table=>'public.'+table).join(', ')+' IN ACCESS EXCLUSIVE MODE');
      const counts=(await db.query(SELECTION_TABLES.map(table=>"SELECT '"+table+"' AS table_name,count(*)::int AS n FROM public."+table).join(' UNION ALL '))).rows.filter(row=>row.n>0);
      if(counts.length)throw Error('Quant selection rollback refused; '+counts.reduce((sum,row)=>sum+row.n,0)+' evidence row(s) exist in '+counts.map(row=>row.table_name).join(', ')+' (no change made)');
      if(register){
        const exposed=(await db.query("SELECT count(*)::int n FROM public.quant_exposure_register WHERE kind='QR4_SELECTION'")).rows[0].n;
        if(exposed>0)throw Error('Quant selection rollback refused; '+exposed+' QR4_SELECTION exposure register row(s) exist (no change made)');
      }
      await db.query(await sql('quant-selection-rollback.sql'));
    }
    const left=await classifyQuantSelection(db);
    if(left.state!=='ABSENT')throw Error('Quant selection rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
