-- QR-3 S2c-1: comparison specs, participants and status events, with guards and marker (local candidate; applied offline and
-- separately from the version-1 extensions; docs/QR_3_FAIR_COMPARISON_CONTRACT.md sections 6.1, 7, 8 and 10, root rulings RC-C37 to RC-C42,
-- shared plan docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md RC-25 to RC-30).
-- This file is the first sub-slice (S2c-1) of extension quant-comparison version 1. The sub-slice S2c-2 (evaluation records with the F3 trigger,
-- benchmarks, outcomes with their commit check, replay events and the COMPLETE transition) joins this same version-1 file before any staging
-- step, so the marker stays version 1. Nothing here is installed anywhere yet.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (shared function quant_comparison_insert_only, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (trigger *_00_serializable, which sorts first);
--   QR004  an INSERT that breaks a comparison rule is refused. Every QR004 is raised with CONSTRAINT = '<guard name>', so a writer maps the
--          refusal by guard (node-postgres err.constraint): quant_comparison_spec_parent, quant_comparison_participant_spec,
--          quant_comparison_participant_position, quant_comparison_participant_fixture, quant_comparison_status_spec,
--          quant_comparison_status_transition and quant_comparison_create_complete.
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
-- Every S2c-2 insert guard (evaluation records, benchmarks, outcomes, replay events) must apply the same rule. The check counts only register rows
-- written by the current transaction (xmin), so register rows of an earlier transaction never satisfy a spec-only create. Residual, accepted:
-- the register binds nothing to a comparison, so an extra register row of this comparison_id written after an immediate check, or in a later
-- transaction, stays possible. The check reads quant_exposure_register, so the register extension must be installed.
-- Residual, accepted (root ruling QR-3 S2c-1 round 3): an extra QR3 register row written later for an existing comparison id is not blocked by
-- this extension (that would need a register change). It can only add exposure, so readers stay conservative.
-- S2c-2 adds to that function the zero-row checks of the evaluation, benchmark, outcome and replay tables.
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
-- only, nothing after a terminal status, and the database-clock time. COMPLETE needs an outcome row, which this sub-slice does not have: it is
-- refused until S2c-2 adds the outcome table.
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
  IF NEW.status = 'COMPLETE' THEN
   RAISE EXCEPTION 'COMPLETE needs an outcome row, which this version does not store yet' USING ERRCODE = 'QR004', CONSTRAINT = 'quant_comparison_status_transition';
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

CREATE TRIGGER quant_comparison_schema_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_schema FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_schema_no_truncate BEFORE TRUNCATE ON public.quant_comparison_schema FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_specs_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_specs_no_truncate BEFORE TRUNCATE ON public.quant_comparison_specs FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_participants_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_participants_no_truncate BEFORE TRUNCATE ON public.quant_comparison_participants FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_status_events_no_change BEFORE UPDATE OR DELETE ON public.quant_comparison_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only();
CREATE TRIGGER quant_comparison_status_events_no_truncate BEFORE TRUNCATE ON public.quant_comparison_status_events FOR EACH STATEMENT EXECUTE FUNCTION public.quant_comparison_insert_only();

CREATE TRIGGER quant_comparison_schema_00_serializable BEFORE INSERT ON public.quant_comparison_schema FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_specs_00_serializable BEFORE INSERT ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_participants_00_serializable BEFORE INSERT ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();
CREATE TRIGGER quant_comparison_status_events_00_serializable BEFORE INSERT ON public.quant_comparison_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_require_serializable();

CREATE TRIGGER quant_comparison_specs_guard BEFORE INSERT ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_spec();
CREATE CONSTRAINT TRIGGER quant_comparison_specs_complete AFTER INSERT ON public.quant_comparison_specs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_check_create();
CREATE TRIGGER quant_comparison_participants_guard BEFORE INSERT ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_participant();
CREATE TRIGGER quant_comparison_status_events_guard BEFORE INSERT ON public.quant_comparison_status_events FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_guard_status_event();

ALTER TABLE public.quant_comparison_schema ENABLE ALWAYS TRIGGER quant_comparison_schema_no_change;
ALTER TABLE public.quant_comparison_schema ENABLE ALWAYS TRIGGER quant_comparison_schema_no_truncate;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_no_change;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_no_truncate;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_no_change;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_no_truncate;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_no_change;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_no_truncate;
ALTER TABLE public.quant_comparison_schema ENABLE ALWAYS TRIGGER quant_comparison_schema_00_serializable;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_00_serializable;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_00_serializable;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_00_serializable;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_guard;
ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_complete;
ALTER TABLE public.quant_comparison_participants ENABLE ALWAYS TRIGGER quant_comparison_participants_guard;
ALTER TABLE public.quant_comparison_status_events ENABLE ALWAYS TRIGGER quant_comparison_status_events_guard;
