-- QR-4 S2 qualified-selection tables (local candidate; applied offline and separately from the version-1 extensions;
-- docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md RC-S21 to RC-S28).
-- Slice S2-1 holds the marker, the registration, the universe rows, the participants and the status event log. Slice S2-2 adds the window freeze, the
-- evaluation starts, the outcome and the replay events (the RO-12 rechecks run in src/postgres/selection-store.js, under the register lock).
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (function quant_selection_insert_only, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (quant_selection_require_serializable, the trigger
--          is named *_00_serializable so it fires first; the stamp trigger *_01_stamp and the guard trigger *_guard sort after it);
--   QR004  an INSERT that breaks the selection rules is refused. Every QR004 is raised USING CONSTRAINT = '<guard name>', so the writer maps the
--          failure by guard name and not by message text. Guard names: quant_selection_registration_clock, quant_selection_universe_member,
--          quant_selection_participant_ready, quant_selection_participant_member, quant_selection_status_transition, quant_selection_exposure_bind
--          (FIRST_EVALUATION_START needs the one register row of the selection, written by the same transaction), quant_selection_registration_complete (C1),
--          quant_selection_freeze_order, quant_selection_start_order, quant_selection_start_deadline, quant_selection_start_ready, quant_selection_outcome_order,
--          quant_selection_outcome_complete (C2), quant_selection_first_start_complete (C3) and quant_selection_replay_order.
-- The QR4_SELECTION exposure register row is written only together with FIRST_EVALUATION_START: the writer appends it under the register lock in the same
-- SERIALIZABLE transaction and then inserts the event, whose guard requires that row (written by this transaction), and C3 requires it again at commit. No
-- trigger sits on the register table (another extension's table, and it also carries QR-3 rows), so a register row written by other means is not stopped by
-- this file; the application refuses it (selection-store.js) and findOrphanSelectionExposures lists it.
-- A freeze, an evaluation start, an outcome, a replay event and the FIRST_EVALUATION_START event are refused when the registration row was written by the
-- same transaction or one of its subtransactions (quant_selection_in_this_transaction), so an early SET CONSTRAINTS IMMEDIATE then DEFERRED cannot run the
-- later steps inside the registration transaction; the exposure bind uses the same helper for the register row.
-- Guards take no advisory lock and no row lock (the runtime role has no UPDATE on these tables). Every writer is SERIALIZABLE; a second writer of
-- the same next seq or the same registration key ends with a primary or unique key violation or with 40001, never a row the committed state
-- would refuse. The application retries 40001 from the start of its transaction, at most three times.
-- Clocks: registered_at_ms is read by the writer from quant_selection_now_ms() inside its SERIALIZABLE transaction and is hashed into the body.
-- frozen_at_ms and at_ms are stamped by a BEFORE INSERT trigger from the same function (a supplied value is overwritten). The hashed value is
-- never overwritten. The register at_ms is an application clock and is never compared with these.
--
-- Insert order of one registration (one SERIALIZABLE transaction): quant_selection_registrations, quant_selection_universe,
-- quant_selection_participants, quant_selection_status_events (seq 1 REGISTER to SELECTION_REGISTERED). A DEFERRABLE INITIALLY DEFERRED constraint
-- trigger on the registration (C1) refuses a commit where the universe rows, the participant rows or the seq 1 event do not equal the hashed body,
-- or where the exposure register already holds a QR4_SELECTION row of this selection. An early SET CONSTRAINTS ALL IMMEDIATE fails closed while
-- the children are missing, and afterwards no universe or participant row can be added.
--
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into installed tables replays the clock
-- stamps and the guards and needs a superuser with --disable-triggers; logical replication of these tables is not supported.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like a selection object
-- can never be used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- This file is not idempotent by itself: src/postgres/quant-selection-migration.js classifies the live catalog first and runs it only over ABSENT.
-- Rollback: src/postgres/quant-selection-rollback.sql drops exactly the objects created here (nine tables and 22 functions; the triggers go with the tables).
-- Requires the base users table, the version-1 research extension (quant_jobs), the exposure register extension and the Best Inputs package
-- extension (bi_exports, bi_status_events, ql4c_validation).

CREATE TABLE public.quant_selection_schema(
 version INTEGER NOT NULL,
 CONSTRAINT quant_selection_schema_pkey PRIMARY KEY(version),
 CONSTRAINT quant_selection_schema_version_check CHECK(version=1)
);
INSERT INTO public.quant_selection_schema VALUES(1);

CREATE TABLE public.quant_selection_registrations(
 selection_id UUID NOT NULL,
 owner_id TEXT NOT NULL,
 fixture BOOLEAN NOT NULL,
 broker TEXT NOT NULL,
 symbol TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 window_kind TEXT NOT NULL,
 start_ms BIGINT NOT NULL,
 end_ms BIGINT NOT NULL,
 warmup_bars INTEGER NOT NULL,
 evaluation_bars INTEGER NOT NULL,
 total_bars INTEGER NOT NULL,
 participant_count SMALLINT NOT NULL,
 admission_deadline_ms BIGINT NOT NULL,
 registered_at_ms BIGINT NOT NULL,
 frozen_at_ms BIGINT NOT NULL,
 registration_key TEXT NOT NULL,
 registration_hash TEXT NOT NULL,
 body_canonical TEXT NOT NULL,
 CONSTRAINT quant_selection_registrations_pkey PRIMARY KEY(selection_id),
 CONSTRAINT quant_selection_registrations_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT quant_selection_registrations_owner_key_key UNIQUE(owner_id,registration_key),
 CONSTRAINT quant_selection_registrations_market_check CHECK(broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'),
 CONSTRAINT quant_selection_registrations_window_kind_check CHECK(window_kind IN ('PROSPECTIVE','FORWARD_PAST')),
 CONSTRAINT quant_selection_registrations_window_check CHECK(start_ms>=0 AND start_ms%60000=0 AND end_ms>start_ms AND end_ms%60000=0 AND end_ms<=253402300800000),
 CONSTRAINT quant_selection_registrations_bars_check CHECK(warmup_bars>=0 AND evaluation_bars>=1 AND evaluation_bars=(end_ms-start_ms)/60000 AND total_bars=evaluation_bars+warmup_bars),
 CONSTRAINT quant_selection_registrations_participant_count_check CHECK(participant_count>=2 AND participant_count<=4),
 CONSTRAINT quant_selection_registrations_deadline_check CHECK(admission_deadline_ms>=end_ms AND admission_deadline_ms<=253402300799999),
 CONSTRAINT quant_selection_registrations_registered_at_check CHECK(registered_at_ms>=0 AND registered_at_ms<=253402300799999),
 CONSTRAINT quant_selection_registrations_frozen_at_check CHECK(frozen_at_ms>=0 AND frozen_at_ms<=253402300799999),
 CONSTRAINT quant_selection_registrations_key_check CHECK(registration_key ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_registrations_hash_check CHECK(registration_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_registrations_body_size_check CHECK(pg_catalog.octet_length(body_canonical)<=262144),
 CONSTRAINT quant_selection_registrations_body_hash_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body_canonical,'UTF8')),'hex')=registration_hash),
 CONSTRAINT quant_selection_registrations_body_json_check CHECK(pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb)='object'),
 CONSTRAINT quant_selection_registrations_body_version_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'version'='qr4-registration-v1',false)),
 CONSTRAINT quant_selection_registrations_body_no_hash_check CHECK(NOT (body_canonical::pg_catalog.jsonb ? 'registration_hash')),
 CONSTRAINT quant_selection_registrations_body_selection_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'selection_id'=selection_id::text,false)),
 CONSTRAINT quant_selection_registrations_body_owner_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'owner_id'=owner_id,false)),
 CONSTRAINT quant_selection_registrations_body_fixture_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->'fixture'=pg_catalog.to_jsonb(fixture),false)),
 CONSTRAINT quant_selection_registrations_body_key_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'registration_key'=registration_key,false)),
 CONSTRAINT quant_selection_registrations_body_registered_check CHECK(COALESCE((body_canonical::pg_catalog.jsonb->>'registered_at_ms')::bigint=registered_at_ms,false)),
 CONSTRAINT quant_selection_registrations_body_deadline_check CHECK(COALESCE((body_canonical::pg_catalog.jsonb->>'admission_deadline_ms')::bigint=admission_deadline_ms,false)),
 CONSTRAINT quant_selection_registrations_body_market_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->'market'=pg_catalog.jsonb_build_object('broker',broker,'symbol',symbol,'timeframe',timeframe),false)),
 CONSTRAINT quant_selection_registrations_body_window_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->'window'=pg_catalog.jsonb_build_object('kind',window_kind,'start_ms',start_ms,
  'end_ms',end_ms,'warmup_bars',warmup_bars,'evaluation_bars',evaluation_bars,'total_bars',total_bars),false)),
 CONSTRAINT quant_selection_registrations_body_participants_check CHECK(COALESCE(CASE WHEN pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb->'participants')='array'
  THEN pg_catalog.jsonb_array_length(body_canonical::pg_catalog.jsonb->'participants')=participant_count AND (body_canonical::pg_catalog.jsonb->>'participant_count')::integer=participant_count END,false)),
 CONSTRAINT quant_selection_registrations_body_universe_check CHECK(COALESCE(CASE WHEN pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb->'universe')='array'
  THEN pg_catalog.jsonb_array_length(body_canonical::pg_catalog.jsonb->'universe')>=participant_count END,false)),
 CONSTRAINT quant_selection_registrations_body_prior_check CHECK(COALESCE(CASE WHEN pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb->'prior_selection_ids')='array'
  THEN pg_catalog.jsonb_array_length(body_canonical::pg_catalog.jsonb->'prior_selection_ids')=(body_canonical::pg_catalog.jsonb->>'prior_selection_count')::integer END,false)),
 CONSTRAINT quant_selection_registrations_body_tolerance_return_check CHECK(COALESCE(pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb->'objective'->'tie_tolerance_return_pp')='string'
  AND body_canonical::pg_catalog.jsonb->'objective'->>'tie_tolerance_return_pp' ~ '^[0-9]+(\.[0-9]+)?$',false)),
 CONSTRAINT quant_selection_registrations_body_tolerance_drawdown_check CHECK(COALESCE(pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb->'objective'->'tie_tolerance_drawdown_pp')='string'
  AND body_canonical::pg_catalog.jsonb->'objective'->>'tie_tolerance_drawdown_pp' ~ '^[0-9]+(\.[0-9]+)?$',false))
);
CREATE INDEX quant_selection_registrations_owner_frozen ON public.quant_selection_registrations(owner_id,frozen_at_ms);

CREATE TABLE public.quant_selection_universe(
 selection_id UUID NOT NULL,
 position SMALLINT NOT NULL,
 run_id TEXT NOT NULL,
 member_kind TEXT NOT NULL,
 universe_status TEXT NOT NULL,
 first_code TEXT,
 export_id UUID,
 CONSTRAINT quant_selection_universe_pkey PRIMARY KEY(selection_id,position),
 CONSTRAINT quant_selection_universe_run_key UNIQUE(selection_id,run_id),
 CONSTRAINT quant_selection_universe_export_key UNIQUE(selection_id,export_id),
 CONSTRAINT quant_selection_universe_selection_id_fkey FOREIGN KEY(selection_id) REFERENCES public.quant_selection_registrations(selection_id),
 CONSTRAINT quant_selection_universe_position_check CHECK(position>=1),
 CONSTRAINT quant_selection_universe_run_id_check CHECK(pg_catalog.length(run_id)>0),
 CONSTRAINT quant_selection_universe_kind_check CHECK(member_kind IN ('RESEARCH_RUN','IMPORTED_BUNDLE','EVALUATION_RUN')),
 CONSTRAINT quant_selection_universe_status_check CHECK(universe_status IN ('PARTICIPANT','QUALIFIED_STALE','EXCLUDED')),
 CONSTRAINT quant_selection_universe_code_check CHECK(first_code IS NULL OR first_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 CONSTRAINT quant_selection_universe_status_code_check CHECK((universe_status='PARTICIPANT')=(first_code IS NULL))
);

CREATE TABLE public.quant_selection_participants(
 selection_id UUID NOT NULL,
 export_id UUID NOT NULL,
 position SMALLINT NOT NULL,
 run_id TEXT NOT NULL,
 package_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 rules_hash TEXT NOT NULL,
 validation_package_hash TEXT NOT NULL,
 validated_at_utc TEXT NOT NULL,
 CONSTRAINT quant_selection_participants_pkey PRIMARY KEY(selection_id,export_id),
 CONSTRAINT quant_selection_participants_run_key UNIQUE(selection_id,run_id),
 CONSTRAINT quant_selection_participants_position_key UNIQUE(selection_id,position),
 CONSTRAINT quant_selection_participants_selection_id_fkey FOREIGN KEY(selection_id) REFERENCES public.quant_selection_registrations(selection_id),
 CONSTRAINT quant_selection_participants_run_id_fkey FOREIGN KEY(run_id) REFERENCES public.quant_jobs(run_id),
 CONSTRAINT quant_selection_participants_export_fkey FOREIGN KEY(export_id,package_hash) REFERENCES public.bi_exports(export_id,package_hash),
 CONSTRAINT quant_selection_participants_position_check CHECK(position>=1 AND position<=4),
 CONSTRAINT quant_selection_participants_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_participants_source_hash_check CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_participants_rules_hash_check CHECK(rules_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_participants_validation_hash_check CHECK(validation_package_hash ~ '^[0-9a-f]{64}$' AND validation_package_hash=package_hash),
 CONSTRAINT quant_selection_participants_validated_at_check CHECK(validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.quant_selection_status_events(
 selection_id UUID NOT NULL,
 seq INTEGER NOT NULL,
 event TEXT NOT NULL,
 status TEXT NOT NULL,
 code TEXT,
 detail TEXT,
 outcome TEXT,
 completed_evaluation_run_ids TEXT[] NOT NULL DEFAULT '{}',
 at_ms BIGINT NOT NULL,
 CONSTRAINT quant_selection_status_events_pkey PRIMARY KEY(selection_id,seq),
 CONSTRAINT quant_selection_status_events_selection_id_fkey FOREIGN KEY(selection_id) REFERENCES public.quant_selection_registrations(selection_id),
 CONSTRAINT quant_selection_status_events_seq_check CHECK(seq>=1),
 CONSTRAINT quant_selection_status_events_event_check CHECK(event IN ('REGISTER','FIRST_EVALUATION_START','OWNER_CANCEL','PARTICIPANT_INELIGIBLE','WINDOW_RECHECK_FAILED',
  'DEADLINE_PASSED','WINDOW_DATA_UNAVAILABLE','ALL_EVALUATIONS_DONE')),
 CONSTRAINT quant_selection_status_events_status_check CHECK(status IN ('SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED')),
 CONSTRAINT quant_selection_status_events_first_check CHECK((seq=1)=(event='REGISTER')),
 CONSTRAINT quant_selection_status_events_code_check CHECK(code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 CONSTRAINT quant_selection_status_events_code_status_check CHECK((status='SELECTION_INCOMPLETE')=(code IS NOT NULL)),
 CONSTRAINT quant_selection_status_events_detail_check CHECK(detail IS NULL OR pg_catalog.length(detail)<=200),
 CONSTRAINT quant_selection_status_events_outcome_check CHECK(outcome IS NULL OR outcome IN ('BEST_IN_SCOPE','TIED_IN_SCOPE','NO_QUALIFYING_STRATEGY','INADEQUATE_EVIDENCE')),
 CONSTRAINT quant_selection_status_events_outcome_status_check CHECK((status='SELECTION_COMPLETED')=(outcome IS NOT NULL)),
 CONSTRAINT quant_selection_status_events_completed_runs_check CHECK(pg_catalog.cardinality(completed_evaluation_run_ids)=0 OR (pg_catalog.array_ndims(completed_evaluation_run_ids)=1
  AND pg_catalog.cardinality(completed_evaluation_run_ids)<=4 AND pg_catalog.array_position(completed_evaluation_run_ids,NULL::text) IS NULL)),
 CONSTRAINT quant_selection_status_events_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999)
);

-- S2-2: the frozen dataset of W, one row per selection. The columns repeat the registered window; the guard requires equality.
CREATE TABLE public.quant_selection_window_freezes(
 selection_id UUID NOT NULL,
 dataset_hash TEXT NOT NULL,
 start_ms BIGINT NOT NULL,
 end_ms BIGINT NOT NULL,
 bars_total INTEGER NOT NULL,
 frozen_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_selection_window_freezes_pkey PRIMARY KEY(selection_id),
 CONSTRAINT quant_selection_window_freezes_selection_id_fkey FOREIGN KEY(selection_id) REFERENCES public.quant_selection_registrations(selection_id),
 CONSTRAINT quant_selection_window_freezes_hash_check CHECK(dataset_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_window_freezes_window_check CHECK(start_ms>=0 AND start_ms%60000=0 AND end_ms>start_ms AND end_ms%60000=0 AND end_ms<=253402300800000),
 CONSTRAINT quant_selection_window_freezes_bars_check CHECK(bars_total>=1),
 CONSTRAINT quant_selection_window_freezes_frozen_at_check CHECK(frozen_at_ms>=0 AND frozen_at_ms<=253402300799999)
);

-- S2-2: one row per started participant evaluation. evaluation_run_id has no foreign key here (slice S3 adds the quant_jobs link to this same file).
CREATE TABLE public.quant_selection_evaluation_starts(
 selection_id UUID NOT NULL,
 export_id UUID NOT NULL,
 evaluation_run_id TEXT NOT NULL,
 parent_run_id TEXT NOT NULL,
 dataset_hash TEXT NOT NULL,
 engine_hash TEXT NOT NULL,
 started_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_selection_evaluation_starts_pkey PRIMARY KEY(selection_id,export_id),
 CONSTRAINT quant_selection_evaluation_starts_run_key UNIQUE(evaluation_run_id),
 CONSTRAINT quant_selection_evaluation_starts_participant_fkey FOREIGN KEY(selection_id,export_id) REFERENCES public.quant_selection_participants(selection_id,export_id),
 CONSTRAINT quant_selection_evaluation_starts_run_id_check CHECK(pg_catalog.length(evaluation_run_id)>0 AND pg_catalog.length(evaluation_run_id)<=200),
 CONSTRAINT quant_selection_evaluation_starts_parent_check CHECK(pg_catalog.length(parent_run_id)>0),
 CONSTRAINT quant_selection_evaluation_starts_dataset_check CHECK(dataset_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_evaluation_starts_engine_check CHECK(engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_evaluation_starts_started_at_check CHECK(started_at_ms>=0 AND started_at_ms<=253402300799999)
);

-- S2-2: the stored ranking outcome, one row per selection. body_canonical is the canonical text of the outcome without outcome_hash.
CREATE TABLE public.quant_selection_outcomes(
 selection_id UUID NOT NULL,
 outcome TEXT NOT NULL,
 outcome_hash TEXT NOT NULL,
 body_canonical TEXT NOT NULL,
 created_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_selection_outcomes_pkey PRIMARY KEY(selection_id),
 CONSTRAINT quant_selection_outcomes_selection_id_fkey FOREIGN KEY(selection_id) REFERENCES public.quant_selection_registrations(selection_id),
 CONSTRAINT quant_selection_outcomes_outcome_check CHECK(outcome IN ('BEST_IN_SCOPE','TIED_IN_SCOPE','NO_QUALIFYING_STRATEGY','INADEQUATE_EVIDENCE')),
 CONSTRAINT quant_selection_outcomes_hash_check CHECK(outcome_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_outcomes_body_size_check CHECK(pg_catalog.octet_length(body_canonical)<=262144),
 CONSTRAINT quant_selection_outcomes_body_hash_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body_canonical,'UTF8')),'hex')=outcome_hash),
 CONSTRAINT quant_selection_outcomes_body_json_check CHECK(pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb)='object'),
 CONSTRAINT quant_selection_outcomes_body_no_hash_check CHECK(NOT (body_canonical::pg_catalog.jsonb ? 'outcome_hash')),
 CONSTRAINT quant_selection_outcomes_body_version_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'version'='qr4-outcome-v1',false)),
 CONSTRAINT quant_selection_outcomes_body_status_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'status'='SELECTION_COMPLETED',false)),
 CONSTRAINT quant_selection_outcomes_body_outcome_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'outcome'=outcome,false)),
 CONSTRAINT quant_selection_outcomes_body_selection_check CHECK(COALESCE(body_canonical::pg_catalog.jsonb->>'selection_id'=selection_id::text,false)),
 CONSTRAINT quant_selection_outcomes_body_evaluations_check CHECK(COALESCE(pg_catalog.jsonb_typeof(body_canonical::pg_catalog.jsonb->'evaluations')='array',false)),
 CONSTRAINT quant_selection_outcomes_created_at_check CHECK(created_at_ms>=0 AND created_at_ms<=253402300799999)
);

-- S2-2: an outcome replay that did not reproduce the stored outcome_hash (an equal replay writes no row).
CREATE TABLE public.quant_selection_replay_events(
 replay_event_id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
 selection_id UUID NOT NULL,
 kind TEXT NOT NULL,
 stored_outcome_hash TEXT NOT NULL,
 recomputed_outcome_hash TEXT,
 at_ms BIGINT NOT NULL,
 CONSTRAINT quant_selection_replay_events_pkey PRIMARY KEY(replay_event_id),
 CONSTRAINT quant_selection_replay_events_selection_id_fkey FOREIGN KEY(selection_id) REFERENCES public.quant_selection_outcomes(selection_id),
 CONSTRAINT quant_selection_replay_events_kind_check CHECK(kind='SELECTION_REPLAY_MISMATCH'),
 CONSTRAINT quant_selection_replay_events_stored_check CHECK(stored_outcome_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_selection_replay_events_recomputed_check CHECK(recomputed_outcome_hash IS NULL OR (recomputed_outcome_hash ~ '^[0-9a-f]{64}$' AND recomputed_outcome_hash<>stored_outcome_hash)),
 CONSTRAINT quant_selection_replay_events_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999)
);

CREATE FUNCTION public.quant_selection_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'quant-selection-v1'::text $fn$;

-- The database clock in epoch milliseconds. VOLATILE (clock_timestamp), so the planner never caches it.
CREATE FUNCTION public.quant_selection_now_ms() RETURNS BIGINT
 LANGUAGE sql SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) * 1000)::bigint $fn$;

-- The edges of src/selection/lifecycle.js (TRANSITIONS and INCOMPLETE_CODES), one 'from>event>to>code' string per allowed (from, event, to, code)
-- tuple; from is empty for the first event and code is empty for a target that carries no code. A test pins this list to the JavaScript module.
CREATE FUNCTION public.quant_selection_transitions() RETURNS TEXT[]
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT ARRAY[
 '>REGISTER>SELECTION_REGISTERED>',
 'SELECTION_REGISTERED>FIRST_EVALUATION_START>SELECTION_EVALUATING>',
 'SELECTION_REGISTERED>OWNER_CANCEL>SELECTION_CANCELLED>',
 'SELECTION_REGISTERED>PARTICIPANT_INELIGIBLE>SELECTION_INCOMPLETE>QR4_PARTICIPANT_STALE',
 'SELECTION_REGISTERED>WINDOW_RECHECK_FAILED>SELECTION_INCOMPLETE>QR4_WINDOW_EXPOSED',
 'SELECTION_REGISTERED>WINDOW_RECHECK_FAILED>SELECTION_INCOMPLETE>QR4_WINDOW_OVERLAPS_SEARCHED_DATA',
 'SELECTION_REGISTERED>DEADLINE_PASSED>SELECTION_INCOMPLETE>QR4_ADMISSION_REFUSED',
 'SELECTION_REGISTERED>WINDOW_DATA_UNAVAILABLE>SELECTION_INCOMPLETE>QR4_WINDOW_DATA_UNAVAILABLE',
 'SELECTION_EVALUATING>PARTICIPANT_INELIGIBLE>SELECTION_INCOMPLETE>QR4_PARTICIPANT_STALE',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_COMPLETED>',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_PARTICIPANT_STALE',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_ADMISSION_REFUSED',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_EVALUATION_FAILED',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_WINDOW_DATA_UNAVAILABLE',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_WINDOW_DATA_GAP',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>BI_DATASET_HASH_MISMATCH',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>INTEGRITY_CHECK_FAILED',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_ENGINE_MISMATCH',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_METRIC_MISSING',
 'SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>QR4_BENCHMARK_UNAVAILABLE',
 'SELECTION_EVALUATING>OWNER_CANCEL>SELECTION_CANCELLED>',
 'SELECTION_EVALUATING>DEADLINE_PASSED>SELECTION_INCOMPLETE>QR4_ADMISSION_REFUSED',
 'SELECTION_EVALUATING>DEADLINE_PASSED>SELECTION_INCOMPLETE>QR4_EVALUATION_FAILED',
 'SELECTION_EVALUATING>WINDOW_RECHECK_FAILED>SELECTION_INCOMPLETE>QR4_WINDOW_EXPOSED',
 'SELECTION_EVALUATING>WINDOW_RECHECK_FAILED>SELECTION_INCOMPLETE>QR4_WINDOW_OVERLAPS_SEARCHED_DATA'
]::text[] $fn$;

-- True when the row version with this xmin was written by the current transaction or one of its subtransactions: the writer is still in progress
-- and the row is visible to this session, so it is its own. Only the low 32 bits of the xid are stored (a freeze keeps the raw xmin), so the
-- 64-bit id is rebuilt from the current transaction id by circular distance. A frozen or system xid (below 3) is never the current transaction,
-- and a negative distance is an earlier transaction, so the answer is false. A row older than 2^31 transactions may be rebuilt to a wrong
-- 64-bit id; the status lookup then raises invalid_parameter_value or answers something other than in progress, and the helper answers false.
-- Own copy for this extension (the same logic as the QR-3 helper of quant-comparison.sql); the S2-2 guards use it to refuse a step written by the
-- transaction that wrote the registration (the registration commits first, C1).
CREATE FUNCTION public.quant_selection_in_this_transaction(row_xmin xid) RETURNS boolean
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE row_id BIGINT; current_id BIGINT; distance BIGINT;
BEGIN
 row_id := row_xmin::text::bigint;
 IF row_id < 3 THEN RETURN false; END IF;
 current_id := pg_catalog.pg_current_xact_id()::text::bigint;
 distance := ((row_id - current_id + 2147483648) % 4294967296 + 4294967296) % 4294967296 - 2147483648;
 IF distance < 0 OR current_id + distance <= 0 THEN RETURN false; END IF;
 IF distance = 0 THEN RETURN true; END IF;
 BEGIN
  RETURN pg_catalog.pg_xact_status((current_id + distance)::text::pg_catalog.xid8) IS NOT DISTINCT FROM 'in progress';
 EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
 END;
END $fn$;

CREATE FUNCTION public.quant_selection_insert_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Quant selection records are insert-only' USING ERRCODE = 'QR002';
END $fn$;

-- Every INSERT into a selection table must run in a SERIALIZABLE transaction (QR003, as for the exposure register and the package tables).
CREATE FUNCTION public.quant_selection_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Quant selection writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

-- The database stamps frozen_at_ms (a supplied value is overwritten). registered_at_ms is the writer's value, read from quant_selection_now_ms()
-- in the same transaction and hashed into the body; it is never overwritten here.
CREATE FUNCTION public.quant_selection_stamp_registration() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 NEW.frozen_at_ms := public.quant_selection_now_ms();
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.quant_selection_stamp_event() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 NEW.at_ms := public.quant_selection_now_ms();
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_registration_clock: the hashed time is not after the database stamp and at most 60 s before it; a PROSPECTIVE window starts
-- after the stamp, a FORWARD_PAST window has ended by the stamp (RC-S22).
CREATE FUNCTION public.quant_selection_guard_registration() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NEW.registered_at_ms > NEW.frozen_at_ms OR NEW.frozen_at_ms - NEW.registered_at_ms > 60000 THEN
  RAISE EXCEPTION 'The registration time must be read from the database clock in the registration transaction (at most 60 s before the stamp)'
   USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_clock';
 END IF;
 IF NEW.window_kind = 'PROSPECTIVE' AND NOT (NEW.start_ms > NEW.frozen_at_ms) THEN
  RAISE EXCEPTION 'A PROSPECTIVE window must start after the database stamp' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_clock';
 END IF;
 IF NEW.window_kind = 'FORWARD_PAST' AND NOT (NEW.end_ms <= NEW.frozen_at_ms) THEN
  RAISE EXCEPTION 'A FORWARD_PAST window must have ended by the database stamp' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_clock';
 END IF;
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_universe_member: the registration exists in this transaction, and the position lies inside the universe list of its body.
CREATE FUNCTION public.quant_selection_guard_universe() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE size INTEGER;
BEGIN
 SELECT pg_catalog.jsonb_array_length(r.body_canonical::pg_catalog.jsonb -> 'universe') INTO size FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 IF NOT FOUND OR NEW.position > size THEN
  RAISE EXCEPTION 'A universe row needs its registration and a position inside the registered universe'
   USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_universe_member';
 END IF;
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_participant_ready (defence of E2, E3 and E6; the JavaScript checks stay primary): the export belongs to the selection owner and
-- the participant run, is a one-Pine export with the fixture flag of the selection, its latest status is EXPORT_VALIDATED and a ql4c_validation row
-- names the same package_hash and the same validated_at_utc. Freshness (REPLAY_MISMATCH) is JavaScript only: no replay table exists in the package
-- extension slice.
-- QR004 quant_selection_participant_member (checked after the readiness rules): the position lies inside participant_count and the participant of the
-- hashed body at that position names the same export_id, run_id and package_hash, so no row can be appended to a committed registration.
CREATE FUNCTION public.quant_selection_guard_participant() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE reg RECORD; pkg RECORD; latest TEXT; member pg_catalog.jsonb;
BEGIN
 SELECT r.owner_id, r.fixture, r.participant_count, r.body_canonical::pg_catalog.jsonb AS body INTO reg FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A participant needs its registration in this transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_participant_ready';
 END IF;
 SELECT x.owner_id, x.run_id, x.mode, x.fixture, x.package_hash INTO pkg FROM public.bi_exports x WHERE x.export_id = NEW.export_id;
 IF NOT FOUND OR pkg.owner_id IS DISTINCT FROM reg.owner_id OR pkg.run_id IS DISTINCT FROM NEW.run_id OR pkg.mode IS DISTINCT FROM 'ONE_PINE'
    OR pkg.fixture IS DISTINCT FROM reg.fixture OR pkg.package_hash IS DISTINCT FROM NEW.package_hash THEN
  RAISE EXCEPTION 'A participant needs a one-Pine export of the selection owner and run whose fixture flag equals the selection fixture flag'
   USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_participant_ready';
 END IF;
 SELECT e.status INTO latest FROM public.bi_status_events e WHERE e.export_id = NEW.export_id ORDER BY e.seq DESC LIMIT 1;
 IF latest IS DISTINCT FROM 'EXPORT_VALIDATED' THEN
  RAISE EXCEPTION 'A participant export needs the latest status EXPORT_VALIDATED' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_participant_ready';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.ql4c_validation v WHERE v.export_id = NEW.export_id AND v.package_hash = NEW.package_hash AND v.fixture = reg.fixture
    AND v.validated_at_utc = NEW.validated_at_utc) THEN
  RAISE EXCEPTION 'A participant export needs its ql4c_validation row with the same package_hash and validated_at_utc' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_participant_ready';
 END IF;
 -- BEFORE triggers run ahead of the table CHECKs, so a position below 1 (a negative jsonb index counts from the end) is refused here too.
 IF NEW.position IS NULL OR NEW.position < 1 OR NEW.position > reg.participant_count OR pg_catalog.jsonb_typeof(reg.body -> 'participants') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'A participant position must lie inside the participant count of the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_participant_member';
 END IF;
 member := reg.body -> 'participants' -> (NEW.position - 1);
 IF member IS NULL OR member ->> 'export_id' IS DISTINCT FROM NEW.export_id::text OR member ->> 'run_id' IS DISTINCT FROM NEW.run_id
    OR member ->> 'package_hash' IS DISTINCT FROM NEW.package_hash THEN
  RAISE EXCEPTION 'A participant row must be the participant of the hashed registration body at its position' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_participant_member';
 END IF;
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_status_transition: seq = last + 1; the tuple (last status, event, status, code) is a row of quant_selection_transitions();
-- nothing follows a terminal status. Every event after seq 1 is refused while the registration row was written by the current transaction or one of its
-- subtransactions (FIRST_EVALUATION_START under quant_selection_exposure_bind, any other event under this guard); FIRST_EVALUATION_START is also bound to the register row.
CREATE FUNCTION public.quant_selection_guard_status_event() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE last_seq INTEGER; last_status TEXT; reg RECORD;
BEGIN
 SELECT r.owner_id, r.broker, r.symbol, r.timeframe, r.start_ms, r.end_ms, public.quant_selection_in_this_transaction(r.xmin) AS in_register INTO reg
   FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A status event needs its registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_status_transition';
 END IF;
 IF NEW.seq > 1 AND reg.in_register AND NEW.event IS DISTINCT FROM 'FIRST_EVALUATION_START' THEN
  RAISE EXCEPTION 'A status event after the first cannot run in the transaction that wrote the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_status_transition';
 END IF;
 SELECT e.seq, e.status INTO last_seq, last_status FROM public.quant_selection_status_events e WHERE e.selection_id = NEW.selection_id ORDER BY e.seq DESC LIMIT 1;
 IF FOUND THEN
  IF last_status IN ('SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED') THEN
   RAISE EXCEPTION 'No status event may follow a terminal status' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_status_transition';
  END IF;
  IF NEW.seq IS DISTINCT FROM last_seq + 1 THEN
   RAISE EXCEPTION 'A status event must have seq = last + 1' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_status_transition';
  END IF;
 ELSIF NEW.seq IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'The first status event must be seq 1' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_status_transition';
 END IF;
 IF NOT (COALESCE(last_status, '') || '>' || NEW.event || '>' || NEW.status || '>' || COALESCE(NEW.code, '')) = ANY (public.quant_selection_transitions()) THEN
  RAISE EXCEPTION 'The status transition is not listed' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_status_transition';
 END IF;
 IF NEW.event = 'FIRST_EVALUATION_START' THEN
  -- The exposure of the evaluation window is registered only together with the first evaluation start: exactly one QR4_SELECTION register row of this
  -- selection, owner and market, over the registered evaluation window, written by this transaction or one of its subtransactions
  -- (quant_selection_in_this_transaction on the row xmin). An older row (an orphan written before the start) or a row of another window never satisfies the bind.
  -- The registration row was read above (reg); the registration transaction itself is refused first.
  IF reg.in_register THEN
   RAISE EXCEPTION 'FIRST_EVALUATION_START cannot run in the transaction that wrote the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_exposure_bind';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.quant_exposure_register x WHERE x.kind = 'QR4_SELECTION' AND x.selection_id = NEW.selection_id::text) IS DISTINCT FROM 1
     OR NOT EXISTS (SELECT 1 FROM public.quant_exposure_register x WHERE x.kind = 'QR4_SELECTION' AND x.selection_id = NEW.selection_id::text AND x.owner_id = reg.owner_id
       AND x.broker = reg.broker AND x.symbol = reg.symbol AND x.timeframe = reg.timeframe AND x.start_ms = reg.start_ms AND x.end_ms = reg.end_ms
       AND public.quant_selection_in_this_transaction(x.xmin)) THEN
   RAISE EXCEPTION 'FIRST_EVALUATION_START needs the exposure register row of the selection, written by the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_exposure_bind';
  END IF;
 END IF;
 IF NEW.event = 'ALL_EVALUATIONS_DONE' THEN
  -- A completed selection needs its stored outcome with the same outcome value; every completed evaluation id of an incomplete one is a started evaluation.
  IF NEW.status = 'SELECTION_COMPLETED' AND NOT EXISTS (SELECT 1 FROM public.quant_selection_outcomes o WHERE o.selection_id = NEW.selection_id AND o.outcome = NEW.outcome) THEN
   RAISE EXCEPTION 'A completed selection needs its stored outcome with the same outcome value' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.completed_evaluation_run_ids) AS c(id) WHERE NOT EXISTS (SELECT 1 FROM public.quant_selection_evaluation_starts s WHERE s.selection_id = NEW.selection_id AND s.evaluation_run_id = c.id)) THEN
   RAISE EXCEPTION 'A completed evaluation run id must be a started evaluation of the selection' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;

-- C1 quant_selection_registration_complete, a DEFERRABLE INITIALLY DEFERRED constraint trigger on the registration: at commit the universe rows,
-- the participant rows and the status log equal the hashed body, and the exposure register holds no QR4_SELECTION row of this selection.
CREATE FUNCTION public.quant_selection_check_registration_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE body pg_catalog.jsonb; wanted INTEGER;
BEGIN
 SELECT r.body_canonical::pg_catalog.jsonb, r.participant_count INTO body, wanted FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Registration is not readable' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM public.quant_selection_universe u WHERE u.selection_id = NEW.selection_id) IS DISTINCT FROM pg_catalog.jsonb_array_length(body -> 'universe')
    OR EXISTS (
     (SELECT e.ord::integer, e.item ->> 'run_id', e.item ->> 'kind', e.item ->> 'status', e.item ->> 'code', e.item ->> 'export_id'
        FROM pg_catalog.jsonb_array_elements(body -> 'universe') WITH ORDINALITY AS e(item, ord)
      EXCEPT
      SELECT u.position::integer, u.run_id, u.member_kind, u.universe_status, u.first_code, u.export_id::text FROM public.quant_selection_universe u WHERE u.selection_id = NEW.selection_id)
     UNION ALL
     (SELECT u.position::integer, u.run_id, u.member_kind, u.universe_status, u.first_code, u.export_id::text FROM public.quant_selection_universe u WHERE u.selection_id = NEW.selection_id
      EXCEPT
      SELECT e.ord::integer, e.item ->> 'run_id', e.item ->> 'kind', e.item ->> 'status', e.item ->> 'code', e.item ->> 'export_id'
        FROM pg_catalog.jsonb_array_elements(body -> 'universe') WITH ORDINALITY AS e(item, ord))) THEN
  RAISE EXCEPTION 'The universe rows must equal the universe of the hashed registration body, positions 1 to n' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM public.quant_selection_participants p WHERE p.selection_id = NEW.selection_id) IS DISTINCT FROM wanted
    OR EXISTS (
     (SELECT e.ord::integer, e.item ->> 'export_id', e.item ->> 'run_id', e.item ->> 'package_hash', e.item ->> 'source_hash', e.item ->> 'rules_hash',
        e.item -> 'validation_binding' ->> 'package_hash', e.item -> 'validation_binding' ->> 'validated_at_utc'
        FROM pg_catalog.jsonb_array_elements(body -> 'participants') WITH ORDINALITY AS e(item, ord)
      EXCEPT
      SELECT p.position::integer, p.export_id::text, p.run_id, p.package_hash, p.source_hash, p.rules_hash, p.validation_package_hash, p.validated_at_utc
        FROM public.quant_selection_participants p WHERE p.selection_id = NEW.selection_id)
     UNION ALL
     (SELECT p.position::integer, p.export_id::text, p.run_id, p.package_hash, p.source_hash, p.rules_hash, p.validation_package_hash, p.validated_at_utc
        FROM public.quant_selection_participants p WHERE p.selection_id = NEW.selection_id
      EXCEPT
      SELECT e.ord::integer, e.item ->> 'export_id', e.item ->> 'run_id', e.item ->> 'package_hash', e.item ->> 'source_hash', e.item ->> 'rules_hash',
        e.item -> 'validation_binding' ->> 'package_hash', e.item -> 'validation_binding' ->> 'validated_at_utc'
        FROM pg_catalog.jsonb_array_elements(body -> 'participants') WITH ORDINALITY AS e(item, ord))) THEN
  RAISE EXCEPTION 'The participant rows must equal the participants of the hashed registration body' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 -- The participants are exactly the universe members with the status PARTICIPANT.
 IF EXISTS (
     (SELECT u.run_id, u.export_id FROM public.quant_selection_universe u WHERE u.selection_id = NEW.selection_id AND u.universe_status = 'PARTICIPANT'
      EXCEPT SELECT p.run_id, p.export_id FROM public.quant_selection_participants p WHERE p.selection_id = NEW.selection_id)
     UNION ALL
     (SELECT p.run_id, p.export_id FROM public.quant_selection_participants p WHERE p.selection_id = NEW.selection_id
      EXCEPT SELECT u.run_id, u.export_id FROM public.quant_selection_universe u WHERE u.selection_id = NEW.selection_id AND u.universe_status = 'PARTICIPANT')) THEN
  RAISE EXCEPTION 'The participants must be exactly the universe members with the status PARTICIPANT' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM public.quant_selection_status_events s WHERE s.selection_id = NEW.selection_id) IS DISTINCT FROM 1
    OR NOT EXISTS (SELECT 1 FROM public.quant_selection_status_events s WHERE s.selection_id = NEW.selection_id AND s.seq = 1 AND s.event = 'REGISTER'
      AND s.status = 'SELECTION_REGISTERED' AND s.code IS NULL AND s.outcome IS NULL AND pg_catalog.cardinality(s.completed_evaluation_run_ids) = 0) THEN
  RAISE EXCEPTION 'A registration commits with exactly its seq 1 REGISTER to SELECTION_REGISTERED event' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 IF EXISTS (SELECT 1 FROM public.quant_exposure_register x WHERE x.kind = 'QR4_SELECTION' AND x.selection_id = NEW.selection_id::text) THEN
  RAISE EXCEPTION 'A registration commits before any exposure register row of the selection' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 -- S2-2 tables: a registration commits before any freeze, evaluation start, outcome or replay event of the selection.
 IF EXISTS (SELECT 1 FROM public.quant_selection_window_freezes f WHERE f.selection_id = NEW.selection_id)
    OR EXISTS (SELECT 1 FROM public.quant_selection_evaluation_starts s WHERE s.selection_id = NEW.selection_id)
    OR EXISTS (SELECT 1 FROM public.quant_selection_outcomes o WHERE o.selection_id = NEW.selection_id)
    OR EXISTS (SELECT 1 FROM public.quant_selection_replay_events e WHERE e.selection_id = NEW.selection_id) THEN
  RAISE EXCEPTION 'A registration commits before any freeze, evaluation start, outcome or replay event of the selection' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_registration_complete';
 END IF;
 RETURN NULL;
END $fn$;

CREATE FUNCTION public.quant_selection_stamp_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 NEW.frozen_at_ms := public.quant_selection_now_ms();
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.quant_selection_stamp_start() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 NEW.started_at_ms := public.quant_selection_now_ms();
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.quant_selection_stamp_outcome() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 NEW.created_at_ms := public.quant_selection_now_ms();
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_freeze_order: the frozen dataset of W is written once, while the selection is SELECTION_REGISTERED (before the first start), not
-- before the window has closed by the database stamp, and over exactly the registered window and bar count.
CREATE FUNCTION public.quant_selection_guard_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE reg RECORD; latest TEXT;
BEGIN
 SELECT r.start_ms, r.end_ms, r.total_bars, public.quant_selection_in_this_transaction(r.xmin) AS in_register INTO reg FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 IF NOT FOUND OR NEW.start_ms IS DISTINCT FROM reg.start_ms OR NEW.end_ms IS DISTINCT FROM reg.end_ms OR NEW.bars_total IS DISTINCT FROM reg.total_bars THEN
  RAISE EXCEPTION 'A window freeze must repeat the registered window and bar count of an existing registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_freeze_order';
 END IF;
 IF reg.in_register THEN
  RAISE EXCEPTION 'A window freeze cannot run in the transaction that wrote the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_freeze_order';
 END IF;
 SELECT e.status INTO latest FROM public.quant_selection_status_events e WHERE e.selection_id = NEW.selection_id ORDER BY e.seq DESC LIMIT 1;
 IF latest IS DISTINCT FROM 'SELECTION_REGISTERED' THEN
  RAISE EXCEPTION 'A window freeze needs the status SELECTION_REGISTERED' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_freeze_order';
 END IF;
 IF NEW.frozen_at_ms < reg.end_ms THEN
  RAISE EXCEPTION 'The window data cannot be frozen before the window has closed' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_freeze_order';
 END IF;
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_start_order: an evaluation start needs the status SELECTION_EVALUATING (the first start writes FIRST_EVALUATION_START before this
-- row), the frozen dataset, the participant of the registration, the dataset hash of the freeze, the registered engine hash and the participant run as parent.
-- QR004 quant_selection_start_deadline: not after the admission deadline by the database stamp. QR004 quant_selection_start_ready: the export of the
-- participant is still a validated one-Pine export of the owner (the same predicate as quant_selection_participant_ready).
CREATE FUNCTION public.quant_selection_guard_start() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE reg RECORD; part RECORD; pkg RECORD; latest TEXT; frozen TEXT;
BEGIN
 SELECT r.owner_id, r.fixture, r.admission_deadline_ms, r.body_canonical::pg_catalog.jsonb -> 'scope' ->> 'engine' AS engine,
   public.quant_selection_in_this_transaction(r.xmin) AS in_register INTO reg FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 SELECT p.run_id, p.package_hash, p.validated_at_utc INTO part FROM public.quant_selection_participants p WHERE p.selection_id = NEW.selection_id AND p.export_id = NEW.export_id;
 IF reg.owner_id IS NULL OR part.run_id IS NULL THEN
  RAISE EXCEPTION 'An evaluation start needs a registered participant' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_order';
 END IF;
 IF reg.in_register THEN
  RAISE EXCEPTION 'An evaluation start cannot run in the transaction that wrote the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_order';
 END IF;
 SELECT e.status INTO latest FROM public.quant_selection_status_events e WHERE e.selection_id = NEW.selection_id ORDER BY e.seq DESC LIMIT 1;
 IF latest IS DISTINCT FROM 'SELECTION_EVALUATING' THEN
  RAISE EXCEPTION 'An evaluation start needs the status SELECTION_EVALUATING' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_order';
 END IF;
 SELECT f.dataset_hash INTO frozen FROM public.quant_selection_window_freezes f WHERE f.selection_id = NEW.selection_id;
 IF frozen IS NULL OR NEW.dataset_hash IS DISTINCT FROM frozen THEN
  RAISE EXCEPTION 'An evaluation start needs the frozen dataset hash of W' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_order';
 END IF;
 IF NEW.parent_run_id IS DISTINCT FROM part.run_id OR NEW.engine_hash IS DISTINCT FROM reg.engine THEN
  RAISE EXCEPTION 'An evaluation start needs the participant run as parent and the registered engine hash' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_order';
 END IF;
 IF NEW.started_at_ms > reg.admission_deadline_ms THEN
  RAISE EXCEPTION 'The admission deadline has passed' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_deadline';
 END IF;
 SELECT x.owner_id, x.run_id, x.mode, x.fixture, x.package_hash INTO pkg FROM public.bi_exports x WHERE x.export_id = NEW.export_id;
 SELECT e.status INTO latest FROM public.bi_status_events e WHERE e.export_id = NEW.export_id ORDER BY e.seq DESC LIMIT 1;
 IF pkg.owner_id IS DISTINCT FROM reg.owner_id OR pkg.run_id IS DISTINCT FROM part.run_id OR pkg.mode IS DISTINCT FROM 'ONE_PINE' OR pkg.fixture IS DISTINCT FROM reg.fixture
    OR pkg.package_hash IS DISTINCT FROM part.package_hash OR latest IS DISTINCT FROM 'EXPORT_VALIDATED'
    OR NOT EXISTS (SELECT 1 FROM public.ql4c_validation v WHERE v.export_id = NEW.export_id AND v.package_hash = part.package_hash AND v.fixture = reg.fixture AND v.validated_at_utc = part.validated_at_utc) THEN
  RAISE EXCEPTION 'The participant export is no longer a validated one-Pine export of the selection owner' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_start_ready';
 END IF;
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_outcome_order: the outcome is stored while the selection is SELECTION_EVALUATING, over the registration hash, the frozen dataset hash
-- and the fixture flag of the selection, and its evaluations are exactly the started evaluations (participant_count of them, same export, parent run and
-- evaluation run id).
CREATE FUNCTION public.quant_selection_guard_outcome() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE reg RECORD; body pg_catalog.jsonb; latest TEXT; frozen TEXT;
BEGIN
 SELECT r.registration_hash, r.fixture, r.participant_count, public.quant_selection_in_this_transaction(r.xmin) AS in_register INTO reg FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'An outcome needs its registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
 END IF;
 IF reg.in_register THEN
  RAISE EXCEPTION 'An outcome cannot be stored in the transaction that wrote the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
 END IF;
 SELECT e.status INTO latest FROM public.quant_selection_status_events e WHERE e.selection_id = NEW.selection_id ORDER BY e.seq DESC LIMIT 1;
 IF latest IS DISTINCT FROM 'SELECTION_EVALUATING' THEN
  RAISE EXCEPTION 'An outcome needs the status SELECTION_EVALUATING' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
 END IF;
 body := NEW.body_canonical::pg_catalog.jsonb;
 SELECT f.dataset_hash INTO frozen FROM public.quant_selection_window_freezes f WHERE f.selection_id = NEW.selection_id;
 IF body ->> 'registration_hash' IS DISTINCT FROM reg.registration_hash OR frozen IS NULL OR body ->> 'window_dataset_hash' IS DISTINCT FROM frozen
    OR body -> 'fixture' IS DISTINCT FROM pg_catalog.to_jsonb(reg.fixture) OR pg_catalog.jsonb_typeof(body -> 'evaluations') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(body -> 'evaluations') IS DISTINCT FROM reg.participant_count THEN
  RAISE EXCEPTION 'The outcome must repeat the registration hash, the frozen dataset hash and the fixture flag, and hold one evaluation per participant' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM public.quant_selection_evaluation_starts s WHERE s.selection_id = NEW.selection_id) IS DISTINCT FROM reg.participant_count
    OR EXISTS (
     (SELECT e.item ->> 'export_id', e.item ->> 'run_id', e.item ->> 'evaluation_run_id' FROM pg_catalog.jsonb_array_elements(body -> 'evaluations') AS e(item)
      EXCEPT SELECT s.export_id::text, s.parent_run_id, s.evaluation_run_id FROM public.quant_selection_evaluation_starts s WHERE s.selection_id = NEW.selection_id)
     UNION ALL
     (SELECT s.export_id::text, s.parent_run_id, s.evaluation_run_id FROM public.quant_selection_evaluation_starts s WHERE s.selection_id = NEW.selection_id
      EXCEPT SELECT e.item ->> 'export_id', e.item ->> 'run_id', e.item ->> 'evaluation_run_id' FROM pg_catalog.jsonb_array_elements(body -> 'evaluations') AS e(item))) THEN
  RAISE EXCEPTION 'The outcome evaluations must be exactly the started evaluations of the selection' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_order';
 END IF;
 RETURN NEW;
END $fn$;

-- QR004 quant_selection_replay_order: a replay mismatch names the stored outcome hash of the selection, and is not written by the transaction that wrote the registration.
CREATE FUNCTION public.quant_selection_guard_replay() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.quant_selection_outcomes o WHERE o.selection_id = NEW.selection_id AND o.outcome_hash = NEW.stored_outcome_hash) THEN
  RAISE EXCEPTION 'A replay mismatch needs the stored outcome hash of the selection' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_replay_order';
 END IF;
 IF EXISTS (SELECT 1 FROM public.quant_selection_registrations r WHERE r.selection_id = NEW.selection_id AND public.quant_selection_in_this_transaction(r.xmin)) THEN
  RAISE EXCEPTION 'A replay mismatch cannot be stored in the transaction that wrote the registration' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_replay_order';
 END IF;
 RETURN NEW;
END $fn$;

-- C3 quant_selection_first_start_complete, a DEFERRABLE INITIALLY DEFERRED constraint trigger on every status event (it acts on FIRST_EVALUATION_START only):
-- at commit the selection holds a frozen dataset, at least one evaluation start and still the one register row bound to the start.
CREATE FUNCTION public.quant_selection_check_first_start_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NEW.event IS DISTINCT FROM 'FIRST_EVALUATION_START' THEN
  RETURN NULL;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.quant_selection_evaluation_starts s WHERE s.selection_id = NEW.selection_id)
    OR NOT EXISTS (SELECT 1 FROM public.quant_selection_window_freezes f WHERE f.selection_id = NEW.selection_id)
    OR (SELECT pg_catalog.count(*) FROM public.quant_exposure_register x WHERE x.kind = 'QR4_SELECTION' AND x.selection_id = NEW.selection_id::text) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'The first evaluation start commits with a frozen dataset, an evaluation start and its exposure register row' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_first_start_complete';
 END IF;
 RETURN NULL;
END $fn$;

-- C2 quant_selection_outcome_complete, a DEFERRABLE INITIALLY DEFERRED constraint trigger on the outcome: at commit the latest status event of the selection
-- is SELECTION_COMPLETED with the outcome value of the stored outcome.
CREATE FUNCTION public.quant_selection_check_outcome_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE last_status TEXT; last_outcome TEXT;
BEGIN
 SELECT e.status, e.outcome INTO last_status, last_outcome FROM public.quant_selection_status_events e WHERE e.selection_id = NEW.selection_id ORDER BY e.seq DESC LIMIT 1;
 IF last_status IS DISTINCT FROM 'SELECTION_COMPLETED' OR last_outcome IS DISTINCT FROM NEW.outcome THEN
  RAISE EXCEPTION 'A stored outcome commits with the SELECTION_COMPLETED status event of the same outcome' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_selection_outcome_complete';
 END IF;
 RETURN NULL;
END $fn$;

CREATE TRIGGER quant_selection_schema_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_schema FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_schema_no_truncate BEFORE TRUNCATE ON public.quant_selection_schema FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_registrations_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_registrations FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_registrations_no_truncate BEFORE TRUNCATE ON public.quant_selection_registrations FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_universe_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_universe FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_universe_no_truncate BEFORE TRUNCATE ON public.quant_selection_universe FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_participants_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_participants FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_participants_no_truncate BEFORE TRUNCATE ON public.quant_selection_participants FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_status_events_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_status_events_no_truncate BEFORE TRUNCATE ON public.quant_selection_status_events FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();

CREATE TRIGGER quant_selection_schema_00_serializable BEFORE INSERT ON public.quant_selection_schema FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_registrations_00_serializable BEFORE INSERT ON public.quant_selection_registrations FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_universe_00_serializable BEFORE INSERT ON public.quant_selection_universe FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_participants_00_serializable BEFORE INSERT ON public.quant_selection_participants FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_status_events_00_serializable BEFORE INSERT ON public.quant_selection_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();

CREATE TRIGGER quant_selection_registrations_01_stamp BEFORE INSERT ON public.quant_selection_registrations FOR EACH ROW EXECUTE FUNCTION public.quant_selection_stamp_registration();
CREATE TRIGGER quant_selection_status_events_01_stamp BEFORE INSERT ON public.quant_selection_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_stamp_event();

CREATE TRIGGER quant_selection_registrations_guard BEFORE INSERT ON public.quant_selection_registrations FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_registration();
CREATE TRIGGER quant_selection_universe_guard BEFORE INSERT ON public.quant_selection_universe FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_universe();
CREATE TRIGGER quant_selection_participants_guard BEFORE INSERT ON public.quant_selection_participants FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_participant();
CREATE TRIGGER quant_selection_status_events_guard BEFORE INSERT ON public.quant_selection_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_status_event();
CREATE CONSTRAINT TRIGGER quant_selection_registrations_complete AFTER INSERT ON public.quant_selection_registrations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quant_selection_check_registration_complete();

ALTER TABLE public.quant_selection_schema ENABLE ALWAYS TRIGGER quant_selection_schema_no_change;
ALTER TABLE public.quant_selection_schema ENABLE ALWAYS TRIGGER quant_selection_schema_no_truncate;
ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_no_change;
ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_no_truncate;
ALTER TABLE public.quant_selection_universe ENABLE ALWAYS TRIGGER quant_selection_universe_no_change;
ALTER TABLE public.quant_selection_universe ENABLE ALWAYS TRIGGER quant_selection_universe_no_truncate;
ALTER TABLE public.quant_selection_participants ENABLE ALWAYS TRIGGER quant_selection_participants_no_change;
ALTER TABLE public.quant_selection_participants ENABLE ALWAYS TRIGGER quant_selection_participants_no_truncate;
ALTER TABLE public.quant_selection_status_events ENABLE ALWAYS TRIGGER quant_selection_status_events_no_change;
ALTER TABLE public.quant_selection_status_events ENABLE ALWAYS TRIGGER quant_selection_status_events_no_truncate;
ALTER TABLE public.quant_selection_schema ENABLE ALWAYS TRIGGER quant_selection_schema_00_serializable;
ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_00_serializable;
ALTER TABLE public.quant_selection_universe ENABLE ALWAYS TRIGGER quant_selection_universe_00_serializable;
ALTER TABLE public.quant_selection_participants ENABLE ALWAYS TRIGGER quant_selection_participants_00_serializable;
ALTER TABLE public.quant_selection_status_events ENABLE ALWAYS TRIGGER quant_selection_status_events_00_serializable;
ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_01_stamp;
ALTER TABLE public.quant_selection_status_events ENABLE ALWAYS TRIGGER quant_selection_status_events_01_stamp;
ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_guard;
ALTER TABLE public.quant_selection_universe ENABLE ALWAYS TRIGGER quant_selection_universe_guard;
ALTER TABLE public.quant_selection_participants ENABLE ALWAYS TRIGGER quant_selection_participants_guard;
ALTER TABLE public.quant_selection_status_events ENABLE ALWAYS TRIGGER quant_selection_status_events_guard;
ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_complete;

-- S2-2 tables: the same freeze, SERIALIZABLE, stamp and guard triggers as the S2-1 tables.
CREATE TRIGGER quant_selection_window_freezes_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_window_freezes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_window_freezes_no_truncate BEFORE TRUNCATE ON public.quant_selection_window_freezes FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_evaluation_starts_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_evaluation_starts FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_evaluation_starts_no_truncate BEFORE TRUNCATE ON public.quant_selection_evaluation_starts FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_outcomes_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_outcomes_no_truncate BEFORE TRUNCATE ON public.quant_selection_outcomes FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_replay_events_no_change BEFORE UPDATE OR DELETE ON public.quant_selection_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_replay_events_no_truncate BEFORE TRUNCATE ON public.quant_selection_replay_events FOR EACH STATEMENT EXECUTE FUNCTION public.quant_selection_insert_only();
CREATE TRIGGER quant_selection_window_freezes_00_serializable BEFORE INSERT ON public.quant_selection_window_freezes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_evaluation_starts_00_serializable BEFORE INSERT ON public.quant_selection_evaluation_starts FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_outcomes_00_serializable BEFORE INSERT ON public.quant_selection_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_replay_events_00_serializable BEFORE INSERT ON public.quant_selection_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_require_serializable();
CREATE TRIGGER quant_selection_window_freezes_01_stamp BEFORE INSERT ON public.quant_selection_window_freezes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_stamp_freeze();
CREATE TRIGGER quant_selection_evaluation_starts_01_stamp BEFORE INSERT ON public.quant_selection_evaluation_starts FOR EACH ROW EXECUTE FUNCTION public.quant_selection_stamp_start();
CREATE TRIGGER quant_selection_outcomes_01_stamp BEFORE INSERT ON public.quant_selection_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_stamp_outcome();
CREATE TRIGGER quant_selection_replay_events_01_stamp BEFORE INSERT ON public.quant_selection_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_stamp_event();
CREATE TRIGGER quant_selection_window_freezes_guard BEFORE INSERT ON public.quant_selection_window_freezes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_freeze();
CREATE TRIGGER quant_selection_evaluation_starts_guard BEFORE INSERT ON public.quant_selection_evaluation_starts FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_start();
CREATE TRIGGER quant_selection_outcomes_guard BEFORE INSERT ON public.quant_selection_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_outcome();
CREATE TRIGGER quant_selection_replay_events_guard BEFORE INSERT ON public.quant_selection_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_selection_guard_replay();
CREATE CONSTRAINT TRIGGER quant_selection_status_events_first_start_complete AFTER INSERT ON public.quant_selection_status_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quant_selection_check_first_start_complete();
CREATE CONSTRAINT TRIGGER quant_selection_outcomes_complete AFTER INSERT ON public.quant_selection_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quant_selection_check_outcome_complete();

ALTER TABLE public.quant_selection_window_freezes ENABLE ALWAYS TRIGGER quant_selection_window_freezes_no_change;
ALTER TABLE public.quant_selection_window_freezes ENABLE ALWAYS TRIGGER quant_selection_window_freezes_no_truncate;
ALTER TABLE public.quant_selection_window_freezes ENABLE ALWAYS TRIGGER quant_selection_window_freezes_00_serializable;
ALTER TABLE public.quant_selection_window_freezes ENABLE ALWAYS TRIGGER quant_selection_window_freezes_01_stamp;
ALTER TABLE public.quant_selection_window_freezes ENABLE ALWAYS TRIGGER quant_selection_window_freezes_guard;
ALTER TABLE public.quant_selection_evaluation_starts ENABLE ALWAYS TRIGGER quant_selection_evaluation_starts_no_change;
ALTER TABLE public.quant_selection_evaluation_starts ENABLE ALWAYS TRIGGER quant_selection_evaluation_starts_no_truncate;
ALTER TABLE public.quant_selection_evaluation_starts ENABLE ALWAYS TRIGGER quant_selection_evaluation_starts_00_serializable;
ALTER TABLE public.quant_selection_evaluation_starts ENABLE ALWAYS TRIGGER quant_selection_evaluation_starts_01_stamp;
ALTER TABLE public.quant_selection_evaluation_starts ENABLE ALWAYS TRIGGER quant_selection_evaluation_starts_guard;
ALTER TABLE public.quant_selection_outcomes ENABLE ALWAYS TRIGGER quant_selection_outcomes_no_change;
ALTER TABLE public.quant_selection_outcomes ENABLE ALWAYS TRIGGER quant_selection_outcomes_no_truncate;
ALTER TABLE public.quant_selection_outcomes ENABLE ALWAYS TRIGGER quant_selection_outcomes_00_serializable;
ALTER TABLE public.quant_selection_outcomes ENABLE ALWAYS TRIGGER quant_selection_outcomes_01_stamp;
ALTER TABLE public.quant_selection_outcomes ENABLE ALWAYS TRIGGER quant_selection_outcomes_guard;
ALTER TABLE public.quant_selection_replay_events ENABLE ALWAYS TRIGGER quant_selection_replay_events_no_change;
ALTER TABLE public.quant_selection_replay_events ENABLE ALWAYS TRIGGER quant_selection_replay_events_no_truncate;
ALTER TABLE public.quant_selection_replay_events ENABLE ALWAYS TRIGGER quant_selection_replay_events_00_serializable;
ALTER TABLE public.quant_selection_replay_events ENABLE ALWAYS TRIGGER quant_selection_replay_events_01_stamp;
ALTER TABLE public.quant_selection_replay_events ENABLE ALWAYS TRIGGER quant_selection_replay_events_guard;
ALTER TABLE public.quant_selection_status_events ENABLE ALWAYS TRIGGER quant_selection_status_events_first_start_complete;
ALTER TABLE public.quant_selection_outcomes ENABLE ALWAYS TRIGGER quant_selection_outcomes_complete;
