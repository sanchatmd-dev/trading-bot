-- QR-3 S2c: comparison specs, participants and status events (S2c-1) and evaluation records, benchmarks, outcomes and replay events (S2c-2), with guards and marker (local candidate; applied offline and
-- separately from the version-1 extensions; docs/QR_3_FAIR_COMPARISON_CONTRACT.md sections 6.1, 7, 8 and 10, root rulings RC-C37 to RC-C42,
-- shared plan docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md RC-25 to RC-30).
-- This file holds both sub-slices of extension quant-comparison version 1: S2c-1 (specs, participants, status events, the create commit check)
-- and S2c-2 (evaluation records with the F3 freeze-order guard, benchmarks, outcomes with their commit check, replay events and the COMPLETE
-- transition). Both join one version-1 file before any staging step, so the marker stays version 1. Nothing here is installed anywhere yet.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (shared function quant_comparison_insert_only, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (trigger *_00_serializable, which sorts first);
--   QR004  an INSERT that breaks a comparison rule is refused. Every QR004 is raised with CONSTRAINT = '<guard name>', so a writer maps the
--          refusal by guard (node-postgres err.constraint): quant_comparison_spec_parent, quant_comparison_participant_spec,
--          quant_comparison_participant_position, quant_comparison_participant_fixture, quant_comparison_status_spec,
--          quant_comparison_status_transition, quant_comparison_create_complete, quant_comparison_eval_spec, quant_comparison_eval_freeze_order,
--          quant_comparison_eval_window, quant_comparison_eval_status, quant_comparison_benchmark_spec, quant_comparison_benchmark_freeze_order,
--          quant_comparison_benchmark_status, quant_comparison_outcome_spec, quant_comparison_outcome_spec_hash, quant_comparison_outcome_freeze_order,
--          quant_comparison_outcome_status, quant_comparison_outcome_order, quant_comparison_outcome_complete, quant_comparison_replay_spec and
--          quant_comparison_replay_order.
-- Insert guards never need UPDATE privilege and never lock a row: no SELECT ... FOR UPDATE or FOR SHARE and no LOCK TABLE, because the
-- runtime role holds SELECT and INSERT only on these tables. A race between two status events of one comparison ends on the primary key
-- (comparison_id, seq): the second writer waits for the first and fails with 23505 or 40001, so at most one event takes a given seq.
-- Clock: frozen_at_ms and the status event at_ms come from the DATABASE clock (clock_timestamp), stamped by the guard trigger; a value the
-- writer supplies is overwritten. They are never compared with the register at_ms (application clock, RC-C39). A status event at_ms is the
-- clock reading, or the previous event at_ms (the spec frozen_at_ms for the first event) plus one when the clock reading is not later, so the
-- times of one comparison strictly increase even when two events fall in one millisecond or the clock stepped back. This max(clock, previous + 1)
-- rule is accepted for status events only (root ruling QR-3 S2c-1 round 2): a result row of S2c-2 (evaluation record, benchmark, outcome, replay
-- event) refuses an equal or earlier time instead of moving it.
-- Create atomicity (RC-C40): a DEFERRABLE INITIALLY DEFERRED constraint trigger on the spec row checks at commit that the participants,
-- the single SPEC_FROZEN event and exactly one register event per participant, all written by THIS transaction, belong to the spec. The create
-- transaction holds only the create rows: the status guard refuses every event with seq > 1 while the spec row was written by the current
-- transaction (quant_comparison_in_this_transaction), so SET CONSTRAINTS ALL IMMEDIATE cannot be used to add later rows before the commit.
-- Every S2c-2 insert guard (evaluation records, benchmarks, outcomes, replay events) applies the same rule. The check counts only register rows
-- written by the current transaction (xmin), so register rows of an earlier transaction never satisfy a spec-only create. Residual, accepted:
-- the register binds nothing to a comparison, so an extra register row of this comparison_id written after an immediate check, or in a later
-- transaction, stays possible. The check reads quant_exposure_register, so the register extension must be installed.
-- Residual, accepted (root ruling QR-3 S2c-1 round 3): an extra QR3 register row written later for an existing comparison id is not blocked by
-- this extension (that would need a register change). It can only add exposure, so readers stay conservative.
-- That function also checks that the evaluation, benchmark, outcome and replay tables hold no row of the new comparison.
-- Result rows (S2c-2, RC-C42, RC-C43): an evaluation record, a benchmark and an outcome are accepted only while the last status event is EVALUATING, and
-- carry the frozen spec hash (F3: an evaluation record also names its own comparison id and spec hash and covers the spec window); each time is the
-- database clock and strictly later than the spec freeze, else the row is refused (QR004 *_freeze_order) and never moved; a replay event must be strictly
-- later than the outcome it names and written by a later transaction. An outcome row and the COMPLETE status event are one unit: the COMPLETE event needs an outcome row written by the same
-- transaction (status guard), and an outcome row needs a COMPLETE event written by the same transaction at commit (constraint trigger
-- quant_comparison_outcomes_complete, DEFERRABLE INITIALLY DEFERRED, so SET CONSTRAINTS ALL IMMEDIATE right after the outcome insert fails closed). The outcome
-- record must list exactly the stored participants, and every participant it reports as evaluated needs its stored evaluation row and time. A race between a cancel and an outcome ends on the status key (comparison_id, seq): one terminal event
-- wins, and a lost outcome transaction leaves no outcome row.
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into installed tables replays the
-- clock stamps and the commit check and needs a superuser with --disable-triggers; logical replication of these tables is not supported.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like a comparison
-- object can never be used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- This file is not idempotent by itself: src/postgres/quant-comparison-migration.js classifies the live catalog first and runs it only
-- over ABSENT. Rollback: src/postgres/quant-comparison-rollback.sql drops exactly the objects created here.
-- Requires the base users table, the version-1 research extension (quant_job_schema) and the exposure register extension.

CREATE TABLE public.quant_comparison_schema(
 version INTEGER NOT NULL,
 CONSTRAINT quant_comparison_schema_pkey PRIMARY KEY(version),
 CONSTRAINT quant_comparison_schema_version_check CHECK(version=1)
);
INSERT INTO public.quant_comparison_schema VALUES(1);

CREATE TABLE public.quant_comparison_specs(
 comparison_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 parent_comparison_id TEXT,
 mode TEXT NOT NULL,
 fixture BOOLEAN NOT NULL,
 broker TEXT NOT NULL,
 symbol TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 start_ms BIGINT NOT NULL,
 end_ms BIGINT NOT NULL,
 participant_count SMALLINT NOT NULL,
 context_key TEXT NOT NULL,
 spec_hash TEXT NOT NULL,
 spec_canonical TEXT NOT NULL,
 spec_body_hash TEXT NOT NULL,
 request_key_hash TEXT,
 frozen_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_comparison_specs_pkey PRIMARY KEY(comparison_id),
 CONSTRAINT quant_comparison_specs_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT quant_comparison_specs_parent_fkey FOREIGN KEY(parent_comparison_id) REFERENCES public.quant_comparison_specs(comparison_id),
 CONSTRAINT quant_comparison_specs_comparison_id_check CHECK(comparison_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CONSTRAINT quant_comparison_specs_parent_check CHECK(parent_comparison_id IS NULL OR parent_comparison_id<>comparison_id),
 CONSTRAINT quant_comparison_specs_mode_check CHECK(mode='STANDARDIZED'),
 CONSTRAINT quant_comparison_specs_market_check CHECK(broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'),
 CONSTRAINT quant_comparison_specs_window_check CHECK(start_ms>=0 AND start_ms%60000=0 AND end_ms>start_ms AND end_ms%60000=0 AND end_ms<=253402300800000),
 CONSTRAINT quant_comparison_specs_count_check CHECK(participant_count BETWEEN 2 AND 4),
 CONSTRAINT quant_comparison_specs_context_key_check CHECK(context_key ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_specs_spec_hash_check CHECK(spec_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_specs_spec_body_hash_check CHECK(spec_body_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_specs_spec_size_check CHECK(pg_catalog.octet_length(spec_canonical)<=65536),
 CONSTRAINT quant_comparison_specs_spec_digest_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(spec_canonical,'UTF8')),'hex')=spec_body_hash),
 CONSTRAINT quant_comparison_specs_spec_body_check CHECK(COALESCE(
  pg_catalog.jsonb_typeof(spec_canonical::jsonb)='object'
  AND spec_canonical::jsonb->>'version'='qr3-spec-v1'
  AND spec_canonical::jsonb->>'mode'=mode
  AND spec_canonical::jsonb->>'benchmark'='qr3-bh-close-same-cost-v1'
  AND CASE WHEN pg_catalog.jsonb_typeof(spec_canonical::jsonb->'participants')='array'
       THEN pg_catalog.jsonb_array_length(spec_canonical::jsonb->'participants')=participant_count ELSE false END
  AND pg_catalog.jsonb_typeof(spec_canonical::jsonb #> '{period,start_ms}')='number' AND spec_canonical::jsonb #>> '{period,start_ms}'=start_ms::text
  AND pg_catalog.jsonb_typeof(spec_canonical::jsonb #> '{period,end_ms}')='number' AND spec_canonical::jsonb #>> '{period,end_ms}'=end_ms::text,false)),
 CONSTRAINT quant_comparison_specs_request_key_check CHECK(request_key_hash IS NULL OR request_key_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_specs_frozen_at_check CHECK(frozen_at_ms>=0 AND frozen_at_ms<=253402300799999)
);
CREATE INDEX quant_comparison_specs_owner ON public.quant_comparison_specs(owner_id,frozen_at_ms);
CREATE UNIQUE INDEX quant_comparison_specs_request_key ON public.quant_comparison_specs(owner_id,request_key_hash) WHERE request_key_hash IS NOT NULL;

CREATE TABLE public.quant_comparison_participants(
 comparison_id TEXT NOT NULL,
 participant_id TEXT NOT NULL,
 position SMALLINT NOT NULL,
 source_hash TEXT NOT NULL,
 origin TEXT NOT NULL,
 fixture BOOLEAN NOT NULL,
 context_key TEXT NOT NULL,
 freeze_canonical TEXT NOT NULL,
 freeze_hash TEXT NOT NULL,
 CONSTRAINT quant_comparison_participants_pkey PRIMARY KEY(comparison_id,participant_id),
 CONSTRAINT quant_comparison_participants_position_key UNIQUE(comparison_id,position),
 CONSTRAINT quant_comparison_participants_comparison_id_fkey FOREIGN KEY(comparison_id) REFERENCES public.quant_comparison_specs(comparison_id),
 CONSTRAINT quant_comparison_participants_participant_id_check CHECK(participant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CONSTRAINT quant_comparison_participants_position_check CHECK(position BETWEEN 1 AND 4),
 CONSTRAINT quant_comparison_participants_source_hash_check CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_participants_origin_check CHECK(origin IN ('LIBRARY_RUN','IMPORTED','FIXTURE')),
 CONSTRAINT quant_comparison_participants_fixture_check CHECK((origin='FIXTURE')=fixture),
 CONSTRAINT quant_comparison_participants_context_key_check CHECK(context_key ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_participants_freeze_size_check CHECK(pg_catalog.octet_length(freeze_canonical)<=262144),
 CONSTRAINT quant_comparison_participants_freeze_hash_check CHECK(freeze_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_participants_freeze_digest_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(freeze_canonical,'UTF8')),'hex')=freeze_hash),
 CONSTRAINT quant_comparison_participants_freeze_body_check CHECK(COALESCE(
  pg_catalog.jsonb_typeof(freeze_canonical::jsonb)='object'
  AND freeze_canonical::jsonb->>'participant_id'=participant_id
  AND freeze_canonical::jsonb->>'source_hash'=source_hash
  AND pg_catalog.jsonb_typeof(freeze_canonical::jsonb->'prior_exposed_by')='array',false))
);

CREATE TABLE public.quant_comparison_status_events(
 comparison_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 status TEXT NOT NULL,
 reason_code TEXT,
 at_ms BIGINT NOT NULL,
 CONSTRAINT quant_comparison_status_events_pkey PRIMARY KEY(comparison_id,seq),
 CONSTRAINT quant_comparison_status_events_comparison_id_fkey FOREIGN KEY(comparison_id) REFERENCES public.quant_comparison_specs(comparison_id),
 CONSTRAINT quant_comparison_status_events_seq_check CHECK(seq>=1),
 CONSTRAINT quant_comparison_status_events_status_check CHECK(status IN ('SPEC_FROZEN','EVALUATING','COMPLETE','FAILED','CANCELLED')),
 CONSTRAINT quant_comparison_status_events_first_check CHECK((seq=1)=(status='SPEC_FROZEN')),
 CONSTRAINT quant_comparison_status_events_reason_check CHECK(reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 CONSTRAINT quant_comparison_status_events_reason_status_check CHECK((status='FAILED' AND reason_code IS NOT NULL) OR status='CANCELLED' OR (status NOT IN ('FAILED','CANCELLED') AND reason_code IS NULL)),
 CONSTRAINT quant_comparison_status_events_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999)
);

-- QR-3 S2c-2: evaluation records, benchmarks, outcomes and replay events. Size caps are provisional until the RD-6 read budget is fixed.
-- Result rows (evaluation, benchmark, outcome, replay event) carry a DATABASE-clock time stamped by their guard; the guard refuses an equal or
-- earlier time than the spec freeze (a replay event: than its outcome) instead of moving it, so a stored result can never predate its spec (F3).
CREATE TABLE public.quant_comparison_evaluations(
 comparison_id TEXT NOT NULL,
 participant_id TEXT NOT NULL,
 spec_hash TEXT NOT NULL,
 evaluation_run_id TEXT,
 body_canonical TEXT NOT NULL,
 body_hash TEXT NOT NULL,
 created_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_comparison_evaluations_pkey PRIMARY KEY(comparison_id,participant_id),
 CONSTRAINT quant_comparison_evaluations_participant_fkey FOREIGN KEY(comparison_id,participant_id) REFERENCES public.quant_comparison_participants(comparison_id,participant_id),
 CONSTRAINT quant_comparison_evaluations_spec_hash_check CHECK(spec_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_evaluations_run_id_check CHECK(evaluation_run_id IS NULL OR evaluation_run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CONSTRAINT quant_comparison_evaluations_body_hash_check CHECK(body_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_evaluations_body_size_check CHECK(pg_catalog.octet_length(body_canonical)<=4194304),
 CONSTRAINT quant_comparison_evaluations_body_digest_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body_canonical,'UTF8')),'hex')=body_hash),
 CONSTRAINT quant_comparison_evaluations_body_check CHECK(COALESCE(
  pg_catalog.jsonb_typeof(body_canonical::jsonb)='object'
  AND pg_catalog.jsonb_typeof(body_canonical::jsonb->'record_comparison_id')='string'
  AND body_canonical::jsonb->>'record_comparison_id'=comparison_id
  AND pg_catalog.jsonb_typeof(body_canonical::jsonb->'record_spec_hash')='string'
  AND body_canonical::jsonb->>'record_spec_hash'=spec_hash
  AND pg_catalog.jsonb_typeof(body_canonical::jsonb #> '{window,start_ms}')='number'
  AND pg_catalog.jsonb_typeof(body_canonical::jsonb #> '{window,end_ms}')='number',false)),
 CONSTRAINT quant_comparison_evaluations_created_at_check CHECK(created_at_ms>=0 AND created_at_ms<=253402300799999)
);

CREATE TABLE public.quant_comparison_benchmarks(
 comparison_id TEXT NOT NULL,
 benchmark_id TEXT NOT NULL,
 spec_hash TEXT NOT NULL,
 body_canonical TEXT NOT NULL,
 body_hash TEXT NOT NULL,
 created_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_comparison_benchmarks_pkey PRIMARY KEY(comparison_id),
 CONSTRAINT quant_comparison_benchmarks_comparison_id_fkey FOREIGN KEY(comparison_id) REFERENCES public.quant_comparison_specs(comparison_id),
 CONSTRAINT quant_comparison_benchmarks_benchmark_id_check CHECK(benchmark_id='qr3-bh-close-same-cost-v1'),
 CONSTRAINT quant_comparison_benchmarks_spec_hash_check CHECK(spec_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_benchmarks_body_hash_check CHECK(body_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_benchmarks_body_size_check CHECK(pg_catalog.octet_length(body_canonical)<=262144),
 CONSTRAINT quant_comparison_benchmarks_body_digest_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body_canonical,'UTF8')),'hex')=body_hash),
 CONSTRAINT quant_comparison_benchmarks_body_check CHECK(COALESCE(
  pg_catalog.jsonb_typeof(body_canonical::jsonb)='object'
  AND body_canonical::jsonb->>'benchmark_id'=benchmark_id,false)),
 CONSTRAINT quant_comparison_benchmarks_created_at_check CHECK(created_at_ms>=0 AND created_at_ms<=253402300799999)
);

CREATE TABLE public.quant_comparison_outcomes(
 comparison_id TEXT NOT NULL,
 outcome TEXT NOT NULL,
 spec_hash TEXT NOT NULL,
 context_key TEXT NOT NULL,
 body_canonical TEXT NOT NULL,
 outcome_hash TEXT NOT NULL,
 only_qualified_participant_id TEXT,
 created_at_ms BIGINT NOT NULL,
 CONSTRAINT quant_comparison_outcomes_pkey PRIMARY KEY(comparison_id),
 CONSTRAINT quant_comparison_outcomes_comparison_id_fkey FOREIGN KEY(comparison_id) REFERENCES public.quant_comparison_specs(comparison_id),
 CONSTRAINT quant_comparison_outcomes_only_qualified_fkey FOREIGN KEY(comparison_id,only_qualified_participant_id) REFERENCES public.quant_comparison_participants(comparison_id,participant_id),
 CONSTRAINT quant_comparison_outcomes_outcome_check CHECK(outcome IN ('QUALIFIED_RANKING','QUALIFIED_TIE','NO_QUALIFIED_RESULT','INADEQUATE_EVIDENCE')),
 CONSTRAINT quant_comparison_outcomes_spec_hash_check CHECK(spec_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_outcomes_context_key_check CHECK(context_key ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_outcomes_outcome_hash_check CHECK(outcome_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_outcomes_body_size_check CHECK(pg_catalog.octet_length(body_canonical)<=262144),
 CONSTRAINT quant_comparison_outcomes_body_digest_check CHECK(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body_canonical,'UTF8')),'hex')=outcome_hash),
 CONSTRAINT quant_comparison_outcomes_only_qualified_check CHECK(only_qualified_participant_id IS NULL OR outcome='NO_QUALIFIED_RESULT'),
 CONSTRAINT quant_comparison_outcomes_body_check CHECK(COALESCE(
  pg_catalog.jsonb_typeof(body_canonical::jsonb)='object'
  AND body_canonical::jsonb->>'version'='qr3-outcome-v1'
  AND body_canonical::jsonb->>'mode'='STANDARDIZED'
  AND body_canonical::jsonb->>'outcome'=outcome
  AND body_canonical::jsonb->>'spec_hash'=spec_hash
  AND body_canonical::jsonb->>'context_key'=context_key
  AND pg_catalog.jsonb_typeof(body_canonical::jsonb->'participants')='array'
  AND (body_canonical::jsonb->>'only_qualified_participant_id') IS NOT DISTINCT FROM only_qualified_participant_id,false)),
 CONSTRAINT quant_comparison_outcomes_created_at_check CHECK(created_at_ms>=0 AND created_at_ms<=253402300799999)
);

CREATE TABLE public.quant_comparison_replay_events(
 replay_event_id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
 comparison_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 replay_run_id TEXT,
 prior_outcome_hash TEXT NOT NULL,
 replay_outcome_hash TEXT,
 first_differing_code TEXT,
 at_ms BIGINT NOT NULL,
 CONSTRAINT quant_comparison_replay_events_pkey PRIMARY KEY(replay_event_id),
 CONSTRAINT quant_comparison_replay_events_comparison_id_fkey FOREIGN KEY(comparison_id) REFERENCES public.quant_comparison_specs(comparison_id),
 CONSTRAINT quant_comparison_replay_events_kind_check CHECK(kind IN ('REPLAY_MATCH','REPLAY_MISMATCH','REPRODUCTION_DISABLED')),
 CONSTRAINT quant_comparison_replay_events_run_id_check CHECK(replay_run_id IS NULL OR replay_run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CONSTRAINT quant_comparison_replay_events_prior_hash_check CHECK(prior_outcome_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_replay_events_replay_hash_check CHECK(replay_outcome_hash IS NULL OR replay_outcome_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT quant_comparison_replay_events_code_check CHECK(first_differing_code IS NULL OR first_differing_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 CONSTRAINT quant_comparison_replay_events_shape_check CHECK(COALESCE(
  (kind='REPLAY_MATCH' AND replay_outcome_hash IS NOT NULL AND replay_outcome_hash=prior_outcome_hash AND first_differing_code IS NULL)
  OR (kind='REPLAY_MISMATCH' AND replay_outcome_hash IS NOT NULL AND replay_outcome_hash<>prior_outcome_hash AND first_differing_code IS NOT NULL)
  OR (kind='REPRODUCTION_DISABLED' AND replay_outcome_hash IS NULL AND first_differing_code IS NULL),false)),
 CONSTRAINT quant_comparison_replay_events_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999)
);
CREATE INDEX quant_comparison_replay_events_comparison ON public.quant_comparison_replay_events(comparison_id,at_ms);

CREATE FUNCTION public.quant_comparison_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'quant-comparison-v1'::text $fn$;

-- True when the row version with this xmin was written by the current transaction or one of its subtransactions: the writer is still in progress
-- and the row is visible to this session, so it is its own. Only the low 32 bits of the xid are stored (a freeze keeps the raw xmin), so the
-- 64-bit id is rebuilt from the current transaction id by circular distance. A frozen or system xid (below 3) is never the current transaction,
-- and a negative distance is an earlier transaction, so the answer is false. A row older than 2^31 transactions may be rebuilt to a wrong
-- 64-bit id; the status lookup then raises invalid_parameter_value or answers something other than in progress, and the helper answers false.
CREATE FUNCTION public.quant_comparison_in_this_transaction(row_xmin xid) RETURNS boolean
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

CREATE FUNCTION public.quant_comparison_insert_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Quant comparison records are insert-only' USING ERRCODE = 'QR002';
END $fn$;

-- Every INSERT into a comparison table must run in a SERIALIZABLE transaction (QR003, as for the exposure register).
CREATE FUNCTION public.quant_comparison_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Quant comparison writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

-- Spec insert: a parent must be an earlier comparison of the same owner (F4); the freeze time is the database clock.
CREATE FUNCTION public.quant_comparison_guard_spec() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE parent_owner TEXT;
BEGIN
 IF NEW.parent_comparison_id IS NOT NULL THEN
  SELECT s.owner_id INTO parent_owner FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.parent_comparison_id;
  IF NOT FOUND OR parent_owner IS DISTINCT FROM NEW.owner_id THEN
   RAISE EXCEPTION 'A parent comparison must exist and belong to the same owner' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_spec_parent';
  END IF;
 END IF;
 NEW.frozen_at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 RETURN NEW;
END $fn$;

-- Participant insert: the spec exists, the position is inside the declared count and a fixture participant stays in a fixture comparison.
-- After the create commit every position 1..count is taken (unique), so no later participant row can exist.
CREATE FUNCTION public.quant_comparison_guard_participant() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE spec_row RECORD;
BEGIN
 SELECT s.participant_count, s.fixture INTO spec_row FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A participant needs its comparison spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_participant_spec';
 END IF;
 IF NEW.position > spec_row.participant_count THEN
  RAISE EXCEPTION 'A participant position must not exceed the declared participant count' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_participant_position';
 END IF;
 IF NEW.fixture IS TRUE AND spec_row.fixture IS NOT TRUE THEN
  RAISE EXCEPTION 'A fixture participant is refused in a non-fixture comparison' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_participant_fixture';
 END IF;
 RETURN NEW;
END $fn$;

-- Status event insert: seq = last + 1, the edges SPEC_FROZEN to EVALUATING, FAILED or CANCELLED and EVALUATING to COMPLETE, FAILED or CANCELLED
-- only, nothing after a terminal status, and the database-clock time. COMPLETE needs the outcome row written by the same transaction (the outcome
-- insert comes first; the outcome commit check demands the COMPLETE event).
CREATE FUNCTION public.quant_comparison_guard_status_event() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE spec_frozen BIGINT; spec_current BOOLEAN; last_event RECORD; previous_ms BIGINT; clock_ms BIGINT;
BEGIN
 SELECT s.frozen_at_ms, public.quant_comparison_in_this_transaction(s.xmin) INTO spec_frozen, spec_current FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A status event needs its comparison spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_spec';
 END IF;
 SELECT e.seq, e.status, e.at_ms INTO last_event FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id ORDER BY e.seq DESC LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.seq IS DISTINCT FROM 1 OR NEW.status IS DISTINCT FROM 'SPEC_FROZEN' THEN
   RAISE EXCEPTION 'The first status event must be seq 1 SPEC_FROZEN' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
  END IF;
  previous_ms := spec_frozen;
 ELSE
  IF spec_current IS TRUE THEN
   RAISE EXCEPTION 'A later status event needs the create committed first' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
  END IF;
  IF last_event.status IN ('COMPLETE', 'FAILED', 'CANCELLED') THEN
   RAISE EXCEPTION 'No status event may follow a terminal status' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
  END IF;
  IF NEW.seq IS DISTINCT FROM last_event.seq + 1 THEN
   RAISE EXCEPTION 'A status event must have seq = last + 1' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
  END IF;
  IF NOT ((last_event.status = 'SPEC_FROZEN' AND NEW.status IN ('EVALUATING', 'FAILED', 'CANCELLED'))
       OR (last_event.status = 'EVALUATING' AND NEW.status IN ('COMPLETE', 'FAILED', 'CANCELLED'))) THEN
   RAISE EXCEPTION 'This status transition is not allowed' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
  END IF;
  IF NEW.status = 'COMPLETE' AND NOT EXISTS (SELECT 1 FROM public.quant_comparison_outcomes o WHERE o.comparison_id = NEW.comparison_id AND public.quant_comparison_in_this_transaction(o.xmin)) THEN
   RAISE EXCEPTION 'COMPLETE needs the outcome row written by the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
  END IF;
  previous_ms := last_event.at_ms;
 END IF;
 clock_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 NEW.at_ms := CASE WHEN clock_ms > previous_ms THEN clock_ms ELSE previous_ms + 1 END;
 RETURN NEW;
END $fn$;

-- Commit check of the create transaction (RC-C40): the spec row, its participants, its first status event and its register events agree.
CREATE FUNCTION public.quant_comparison_check_create() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE declared TEXT[]; stored TEXT[]; event_count INTEGER; register_count INTEGER; register_bad INTEGER; register_clocks INTEGER;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(NEW.spec_canonical::jsonb->'participants') AS e WHERE pg_catalog.jsonb_typeof(e) IS DISTINCT FROM 'string') THEN
  RAISE EXCEPTION 'A comparison spec lists its participants as text ids' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_create_complete';
 END IF;
 SELECT pg_catalog.array_agg(x COLLATE "C" ORDER BY x COLLATE "C") INTO declared FROM pg_catalog.jsonb_array_elements_text(NEW.spec_canonical::jsonb->'participants') AS x;
 SELECT pg_catalog.array_agg(p.participant_id COLLATE "C" ORDER BY p.participant_id COLLATE "C") INTO stored FROM public.quant_comparison_participants p WHERE p.comparison_id = NEW.comparison_id;
 IF stored IS DISTINCT FROM declared OR pg_catalog.cardinality(stored) IS DISTINCT FROM NEW.participant_count::integer THEN
  RAISE EXCEPTION 'A comparison needs exactly the participants its spec declares, in the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_create_complete';
 END IF;
 SELECT pg_catalog.count(*)::integer INTO event_count FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id;
 IF event_count IS DISTINCT FROM 1 OR NOT EXISTS (SELECT 1 FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id AND e.seq = 1 AND e.status = 'SPEC_FROZEN') THEN
  RAISE EXCEPTION 'A new comparison needs exactly its SPEC_FROZEN status event' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_create_complete';
 END IF;
 IF EXISTS (SELECT 1 FROM public.quant_comparison_evaluations x WHERE x.comparison_id = NEW.comparison_id)
  OR EXISTS (SELECT 1 FROM public.quant_comparison_benchmarks x WHERE x.comparison_id = NEW.comparison_id)
  OR EXISTS (SELECT 1 FROM public.quant_comparison_outcomes x WHERE x.comparison_id = NEW.comparison_id)
  OR EXISTS (SELECT 1 FROM public.quant_comparison_replay_events x WHERE x.comparison_id = NEW.comparison_id) THEN
  RAISE EXCEPTION 'A new comparison has no evaluation, benchmark, outcome or replay row' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_create_complete';
 END IF;
 -- The register carries one event per participant: same owner, market and window, the participant run and source hash of the participant row,
 -- one clock value, written by this transaction (xmin of the current transaction id; a row of an earlier transaction or of a subtransaction counts as
 -- mismatching). The register unique key makes a second event of one participant and window impossible, so a count equal to the
 -- participant count with no mismatching row is a one-to-one match.
 SELECT pg_catalog.count(*)::integer,
   pg_catalog.count(*) FILTER (WHERE NOT (r.kind = 'QR3_COMPARISON' AND r.owner_id = NEW.owner_id AND r.broker = NEW.broker AND r.symbol = NEW.symbol
     AND r.timeframe = NEW.timeframe AND r.start_ms = NEW.start_ms AND r.end_ms = NEW.end_ms AND r.xmin = pg_catalog.pg_current_xact_id()::xid
     AND EXISTS (SELECT 1 FROM public.quant_comparison_participants p WHERE p.comparison_id = NEW.comparison_id AND p.participant_id = r.participant_run_id AND p.source_hash = r.source_hash)))::integer,
   pg_catalog.count(DISTINCT r.at_ms)::integer
   INTO register_count, register_bad, register_clocks FROM public.quant_exposure_register r WHERE r.comparison_id = NEW.comparison_id;
 IF register_count IS DISTINCT FROM NEW.participant_count::integer OR register_bad IS DISTINCT FROM 0 OR register_clocks IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'A comparison needs exactly one exposure register event per participant in the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_create_complete';
 END IF;
 RETURN NULL;
END $fn$;

-- S2c-2 result guards. Every one reads the spec, refuses while the spec row was written by the current transaction (a result row needs the create
-- committed first, as a later status event does) and never locks a row. A value that is readable but wrong is the guard's refusal (QR004); a value
-- that is unreadable (a missing or mistyped field) is left to the table CHECK, which always refuses it. Times are the database clock and strictly
-- later than the spec freeze, else the row is refused, never moved (F3, RC-C43).

-- Evaluation record insert (F3): the frozen spec hash, the record's own comparison id and spec hash, the spec window, status EVALUATING and a
-- time strictly after the freeze.
CREATE FUNCTION public.quant_comparison_guard_evaluation() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE spec_row RECORD; doc JSONB; last_status TEXT; clock_ms BIGINT;
BEGIN
 SELECT s.spec_hash, s.frozen_at_ms, s.start_ms, s.end_ms, public.quant_comparison_in_this_transaction(s.xmin) AS in_create INTO spec_row FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'An evaluation record needs its comparison spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_spec';
 END IF;
 IF spec_row.in_create IS TRUE THEN
  RAISE EXCEPTION 'An evaluation record needs the create committed first' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_status';
 END IF;
 IF NEW.spec_hash IS DISTINCT FROM spec_row.spec_hash THEN
  RAISE EXCEPTION 'An evaluation record must carry the frozen spec hash' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_freeze_order';
 END IF;
 doc := NEW.body_canonical::jsonb;
 IF (pg_catalog.jsonb_typeof(doc->'record_comparison_id') = 'string' AND doc->>'record_comparison_id' IS DISTINCT FROM NEW.comparison_id)
  OR (pg_catalog.jsonb_typeof(doc->'record_spec_hash') = 'string' AND doc->>'record_spec_hash' IS DISTINCT FROM spec_row.spec_hash) THEN
  RAISE EXCEPTION 'An evaluation record must reference its own comparison and frozen spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_freeze_order';
 END IF;
 IF (pg_catalog.jsonb_typeof(doc #> '{window,start_ms}') = 'number' AND doc #>> '{window,start_ms}' IS DISTINCT FROM spec_row.start_ms::text)
  OR (pg_catalog.jsonb_typeof(doc #> '{window,end_ms}') = 'number' AND doc #>> '{window,end_ms}' IS DISTINCT FROM spec_row.end_ms::text) THEN
  RAISE EXCEPTION 'An evaluation record must cover the spec window' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_window';
 END IF;
 SELECT e.status INTO last_status FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id ORDER BY e.seq DESC LIMIT 1;
 IF last_status IS DISTINCT FROM 'EVALUATING' THEN
  RAISE EXCEPTION 'An evaluation record needs the status EVALUATING' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_status';
 END IF;
 clock_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 IF clock_ms <= spec_row.frozen_at_ms THEN
  RAISE EXCEPTION 'An evaluation record must be created strictly after the spec freeze' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_eval_freeze_order';
 END IF;
 NEW.created_at_ms := clock_ms;
 RETURN NEW;
END $fn$;

-- Benchmark insert: the same F3 checks as an evaluation record (spec hash, status EVALUATING, time strictly after the freeze).
CREATE FUNCTION public.quant_comparison_guard_benchmark() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE spec_row RECORD; last_status TEXT; clock_ms BIGINT;
BEGIN
 SELECT s.spec_hash, s.frozen_at_ms, public.quant_comparison_in_this_transaction(s.xmin) AS in_create INTO spec_row FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A benchmark needs its comparison spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_benchmark_spec';
 END IF;
 IF spec_row.in_create IS TRUE THEN
  RAISE EXCEPTION 'A benchmark needs the create committed first' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_benchmark_status';
 END IF;
 IF NEW.spec_hash IS DISTINCT FROM spec_row.spec_hash THEN
  RAISE EXCEPTION 'A benchmark must carry the frozen spec hash' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_benchmark_freeze_order';
 END IF;
 SELECT e.status INTO last_status FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id ORDER BY e.seq DESC LIMIT 1;
 IF last_status IS DISTINCT FROM 'EVALUATING' THEN
  RAISE EXCEPTION 'A benchmark needs the status EVALUATING' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_benchmark_status';
 END IF;
 clock_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 IF clock_ms <= spec_row.frozen_at_ms THEN
  RAISE EXCEPTION 'A benchmark must be created strictly after the spec freeze' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_benchmark_freeze_order';
 END IF;
 NEW.created_at_ms := clock_ms;
 RETURN NEW;
END $fn$;

-- Outcome insert: the frozen spec hash and context key, status EVALUATING, the benchmark row, the outcome record covering exactly the stored
-- participants, and a time strictly after the freeze. The COMPLETE event follows in the same transaction (check below and status guard).
CREATE FUNCTION public.quant_comparison_guard_outcome() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE spec_row RECORD; doc JSONB; last_status TEXT; clock_ms BIGINT; declared TEXT[]; stored TEXT[]; evaluations JSONB;
BEGIN
 SELECT s.spec_hash, s.context_key, s.frozen_at_ms, public.quant_comparison_in_this_transaction(s.xmin) AS in_create INTO spec_row FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'An outcome needs its comparison spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_spec';
 END IF;
 IF spec_row.in_create IS TRUE THEN
  RAISE EXCEPTION 'An outcome needs the create committed first' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_status';
 END IF;
 IF NEW.spec_hash IS DISTINCT FROM spec_row.spec_hash OR NEW.context_key IS DISTINCT FROM spec_row.context_key THEN
  RAISE EXCEPTION 'An outcome must carry the frozen spec hash and context key' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_spec_hash';
 END IF;
 SELECT e.status INTO last_status FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id ORDER BY e.seq DESC LIMIT 1;
 IF last_status IS DISTINCT FROM 'EVALUATING' THEN
  RAISE EXCEPTION 'An outcome needs the status EVALUATING' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_status';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.quant_comparison_benchmarks b WHERE b.comparison_id = NEW.comparison_id) THEN
  RAISE EXCEPTION 'An outcome needs the benchmark row of its comparison' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_order';
 END IF;
 doc := NEW.body_canonical::jsonb;
 IF pg_catalog.jsonb_typeof(doc->'participants') = 'array' THEN
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(doc->'participants') AS e WHERE pg_catalog.jsonb_typeof(e) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(e->'id') IS DISTINCT FROM 'string') THEN
   RAISE EXCEPTION 'An outcome lists its participants as objects with a text id' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_order';
  END IF;
  SELECT pg_catalog.array_agg((e->>'id') COLLATE "C" ORDER BY (e->>'id') COLLATE "C") INTO declared FROM pg_catalog.jsonb_array_elements(doc->'participants') AS e;
  SELECT pg_catalog.array_agg(p.participant_id COLLATE "C" ORDER BY p.participant_id COLLATE "C") INTO stored FROM public.quant_comparison_participants p WHERE p.comparison_id = NEW.comparison_id;
  IF declared IS DISTINCT FROM stored THEN
   RAISE EXCEPTION 'An outcome must cover exactly the participants of its comparison' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_order';
  END IF;
  -- Every participant the record reports as evaluated (any status but the not-evaluated, unavailable and excluded ones of contract 8.2) needs its stored evaluation
  -- row, and the record created_at_ms must equal the stored one. This read of the evaluation rows is also what makes SERIALIZABLE turn the race between
  -- an evaluation record and the outcome into one 40001 (the evaluation guard reads the status events, this guard reads the evaluation rows).
  SELECT pg_catalog.jsonb_object_agg(v.participant_id, v.created_at_ms) INTO evaluations FROM public.quant_comparison_evaluations v WHERE v.comparison_id = NEW.comparison_id;
  evaluations := COALESCE(evaluations, '{}'::jsonb);
  -- A NOT_EVALUATED participant has no stored evaluation row. An UNAVAILABLE one may have a row or not; when it has one the time must match too.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(doc->'participants') AS e
             WHERE (COALESCE(e->>'status', '') = 'NOT_EVALUATED' AND (evaluations->>(e->>'id')) IS NOT NULL)
                OR (COALESCE(e->>'status', '') NOT IN ('NOT_EVALUATED', 'EXCLUDED_COVERAGE', 'EXCLUDED_INTEGRITY', 'EXCLUDED_INCOMPATIBLE')
                    AND (evaluations->>(e->>'id')) IS NULL AND COALESCE(e->>'status', '') <> 'UNAVAILABLE')
                OR (COALESCE(e->>'status', '') NOT IN ('NOT_EVALUATED', 'EXCLUDED_COVERAGE', 'EXCLUDED_INTEGRITY', 'EXCLUDED_INCOMPATIBLE')
                    AND (evaluations->>(e->>'id')) IS NOT NULL
                    AND (pg_catalog.jsonb_typeof(e->'created_at_ms') IS DISTINCT FROM 'number'
                         OR (e->>'created_at_ms') IS DISTINCT FROM (evaluations->>(e->>'id'))))) THEN
   RAISE EXCEPTION 'An evaluated participant of an outcome needs its stored evaluation record and the stored time' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_order';
  END IF;
 END IF;
 clock_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 IF clock_ms <= spec_row.frozen_at_ms THEN
  RAISE EXCEPTION 'An outcome must be created strictly after the spec freeze' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_freeze_order';
 END IF;
 NEW.created_at_ms := clock_ms;
 RETURN NEW;
END $fn$;

-- Replay event insert: an outcome exists (written by an earlier transaction), the event names its hash, and the time is strictly later than the outcome. The outcome row never changes (I4).
CREATE FUNCTION public.quant_comparison_guard_replay_event() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE spec_in_create BOOLEAN; outcome_row RECORD; clock_ms BIGINT;
BEGIN
 SELECT public.quant_comparison_in_this_transaction(s.xmin) INTO spec_in_create FROM public.quant_comparison_specs s WHERE s.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A replay event needs its comparison spec' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_replay_spec';
 END IF;
 IF spec_in_create IS TRUE THEN
  RAISE EXCEPTION 'A replay event needs the create committed first' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_replay_order';
 END IF;
 SELECT o.outcome_hash, o.created_at_ms, public.quant_comparison_in_this_transaction(o.xmin) AS in_outcome_transaction INTO outcome_row FROM public.quant_comparison_outcomes o WHERE o.comparison_id = NEW.comparison_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A replay event needs the outcome row of its comparison' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_replay_order';
 END IF;
 IF outcome_row.in_outcome_transaction IS TRUE THEN
  RAISE EXCEPTION 'A replay event needs the outcome committed in an earlier transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_replay_order';
 END IF;
 IF NEW.prior_outcome_hash IS DISTINCT FROM outcome_row.outcome_hash THEN
  RAISE EXCEPTION 'A replay event must name the stored outcome hash' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_replay_order';
 END IF;
 clock_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
 IF clock_ms <= outcome_row.created_at_ms THEN
  RAISE EXCEPTION 'A replay event must be later than the outcome' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_replay_order';
 END IF;
 NEW.at_ms := clock_ms;
 RETURN NEW;
END $fn$;

-- Commit check of the outcome (RC-C42): an outcome row and the COMPLETE event are one unit. At commit the last status event is a COMPLETE written
-- by this transaction. SET CONSTRAINTS ALL IMMEDIATE runs the check right after the outcome insert, when the event is not there yet, so it fails closed.
CREATE FUNCTION public.quant_comparison_check_outcome() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE last_event RECORD;
BEGIN
 SELECT e.status, public.quant_comparison_in_this_transaction(e.xmin) AS mine INTO last_event FROM public.quant_comparison_status_events e WHERE e.comparison_id = NEW.comparison_id ORDER BY e.seq DESC LIMIT 1;
 IF NOT FOUND OR last_event.status IS DISTINCT FROM 'COMPLETE' OR last_event.mine IS NOT TRUE THEN
  RAISE EXCEPTION 'An outcome and the COMPLETE status event are written by one transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_outcome_complete';
 END IF;
 RETURN NULL;
END $fn$;

CREATE TRIGGER quant_comparison_schema_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_schema FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_schema_no_truncate BEFORE TRUNCATE ON public.quant_comparison_schema FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_specs_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_specs_no_truncate BEFORE TRUNCATE ON public.quant_comparison_specs FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_participants_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_participants_no_truncate BEFORE TRUNCATE ON public.quant_comparison_participants FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_status_events_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_status_events_no_truncate BEFORE TRUNCATE ON public.quant_comparison_status_events FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();

CREATE TRIGGER quant_comparison_evaluations_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_evaluations FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_evaluations_no_truncate BEFORE TRUNCATE ON public.quant_comparison_evaluations FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_benchmarks_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_benchmarks FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_benchmarks_no_truncate BEFORE TRUNCATE ON public.quant_comparison_benchmarks FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_outcomes_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_outcomes_no_truncate BEFORE TRUNCATE ON public.quant_comparison_outcomes FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_replay_events_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_replay_events_no_truncate BEFORE TRUNCATE ON public.quant_comparison_replay_events FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();

CREATE TRIGGER quant_comparison_schema_00_serializable BEFORE INSERT ON public.quant_comparison_schema FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_specs_00_serializable BEFORE INSERT ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_participants_00_serializable BEFORE INSERT ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_status_events_00_serializable BEFORE INSERT ON public.quant_comparison_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();

CREATE TRIGGER quant_comparison_evaluations_00_serializable BEFORE INSERT ON public.quant_comparison_evaluations FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_benchmarks_00_serializable BEFORE INSERT ON public.quant_comparison_benchmarks FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_outcomes_00_serializable BEFORE INSERT ON public.quant_comparison_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_replay_events_00_serializable BEFORE INSERT ON public.quant_comparison_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();

CREATE TRIGGER quant_comparison_specs_guard BEFORE INSERT ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_spec();
CREATE CONSTRAINT TRIGGER quant_comparison_specs_complete AFTER INSERT ON public.quant_comparison_specs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_check_create();
CREATE TRIGGER quant_comparison_participants_guard BEFORE INSERT ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_participant();
CREATE TRIGGER quant_comparison_status_events_guard BEFORE INSERT ON public.quant_comparison_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_status_event();
CREATE TRIGGER quant_comparison_evaluations_guard BEFORE INSERT ON public.quant_comparison_evaluations FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_evaluation();
CREATE TRIGGER quant_comparison_benchmarks_guard BEFORE INSERT ON public.quant_comparison_benchmarks FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_benchmark();
CREATE TRIGGER quant_comparison_outcomes_guard BEFORE INSERT ON public.quant_comparison_outcomes FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_outcome();
CREATE TRIGGER quant_comparison_replay_events_guard BEFORE INSERT ON public.quant_comparison_replay_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_replay_event();
CREATE CONSTRAINT TRIGGER quant_comparison_outcomes_complete AFTER INSERT ON public.quant_comparison_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_check_outcome();

ALTER TABLE public.quant_comparison_schema ENABLE ALWAYS TRIGGER quant_comparison_schema_no_change;
ALTER TABLE public.quant_comparison_schema ENABLE ALWAYS TRIGGER quant_comparison_schema_no_truncate;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_no_change;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_no_truncate;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_no_change;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_no_truncate;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_no_change;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_no_truncate;
ALTER TABLE public.quant_comparison_evaluations ENABLE ALWAYS TRIGGER quant_comparison_evaluations_no_change;
ALTER TABLE public.quant_comparison_evaluations ENABLE ALWAYS TRIGGER quant_comparison_evaluations_no_truncate;
ALTER TABLE public.quant_comparison_benchmarks ENABLE ALWAYS TRIGGER quant_comparison_benchmarks_no_change;
ALTER TABLE public.quant_comparison_benchmarks ENABLE ALWAYS TRIGGER quant_comparison_benchmarks_no_truncate;
ALTER TABLE public.quant_comparison_outcomes ENABLE ALWAYS TRIGGER quant_comparison_outcomes_no_change;
ALTER TABLE public.quant_comparison_outcomes ENABLE ALWAYS TRIGGER quant_comparison_outcomes_no_truncate;
ALTER TABLE public.quant_comparison_replay_events ENABLE ALWAYS TRIGGER quant_comparison_replay_events_no_change;
ALTER TABLE public.quant_comparison_replay_events ENABLE ALWAYS TRIGGER quant_comparison_replay_events_no_truncate;
ALTER TABLE public.quant_comparison_schema ENABLE ALWAYS TRIGGER quant_comparison_schema_00_serializable;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_00_serializable;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_00_serializable;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_00_serializable;
ALTER TABLE public.quant_comparison_evaluations ENABLE ALWAYS TRIGGER quant_comparison_evaluations_00_serializable;
ALTER TABLE public.quant_comparison_benchmarks ENABLE ALWAYS TRIGGER quant_comparison_benchmarks_00_serializable;
ALTER TABLE public.quant_comparison_outcomes ENABLE ALWAYS TRIGGER quant_comparison_outcomes_00_serializable;
ALTER TABLE public.quant_comparison_replay_events ENABLE ALWAYS TRIGGER quant_comparison_replay_events_00_serializable;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_guard;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_complete;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_guard;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_guard;
ALTER TABLE public.quant_comparison_evaluations ENABLE ALWAYS TRIGGER quant_comparison_evaluations_guard;
ALTER TABLE public.quant_comparison_benchmarks ENABLE ALWAYS TRIGGER quant_comparison_benchmarks_guard;
ALTER TABLE public.quant_comparison_outcomes ENABLE ALWAYS TRIGGER quant_comparison_outcomes_guard;
ALTER TABLE public.quant_comparison_replay_events ENABLE ALWAYS TRIGGER quant_comparison_replay_events_guard;
ALTER TABLE public.quant_comparison_outcomes ENABLE ALWAYS TRIGGER quant_comparison_outcomes_complete;
