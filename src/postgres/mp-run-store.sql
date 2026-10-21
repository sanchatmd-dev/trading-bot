-- F11-01 internal multi-Pine run store, slice RS-1 (local candidate; applied offline and separately from the other extensions; docs/MULTI_PINE_CONTRACT.md
-- RD-MP-2 option B, packaging RD-MP-13, guards PKG RC-25 and RC-26). Two insert-only record tables: mp_research_runs (one row per admitted run, the frozen
-- multi-Pine contract) and mp_research_run_events (status events; the status of a run is its last event). There is no UPDATE path at all, so a terminal run
-- is immutable by construction: the transition guard refuses any event after a terminal event. No store function, service, route or reader ships with this
-- file (slice RS-2 and later).
--
-- Isolation: the tables carry no status, result, lease, attempt or deployment_id column and nothing outside this extension references them, so no owner
-- reader, worker claim, mode guard, QR-3 participant lookup or QR-4 lookup of the one-Pine path can see a run. Beyond that, the runtime role holds no privilege
-- on these tables (scripts/grant-postgres-runtime.sql category internal_only); a separate fixture role writes them in isolated clusters only
-- (scripts/grant-postgres-mp-fixture.sql). The foreign keys onto users and mp_member_sets add PostgreSQL-internal referential-integrity triggers to those tables
-- (the member-set extension has the same kind of foreign keys onto pine tables); this file adds no user trigger and no other object to any table of another
-- extension, and the member-set classifier ignores internal triggers of other tables' keys. The classifier of mp-run-store-migration.js refuses (OTHER) any derived
-- object that could expose run-store rows: inheritance on either side, a foreign key from a table outside the run store, a publication membership (also FOR ALL
-- TABLES and FOR TABLES IN SCHEMA public), and a view, rule or materialized view outside the extension that depends on a run-store table.
-- Accepted residuals (root ruling K3; isolated clusters only, owner item O1; slice RS-3 adds the test): the runtime role can read table statistics
-- (pg_stat_user_tables, reltuples), so it can see run counts; and it holds DELETE on users, so deleting a user that owns a fixture run fails with 23503 naming
-- the run-store key (an existence signal). Neither residual exposes a row.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (function mp_run_store_freeze, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (function mp_run_store_require_serializable; the triggers are
--          named *_00_serializable so they fire first);
--   QR004  an INSERT that breaks a run-store rule is refused (PKG RC-25). Each QR004 is raised with CONSTRAINT = the name of the guard trigger that raised
--          it, so the writer maps the guard that fired:
--            mp_research_runs_guard             run insert: member set row missing, or owner, Bot, pine_count, membership_hash, same_bar_order, policy_hash,
--                                               funding_cutoff or members differ from the member set row, or the member set is not a fixture set;
--            mp_research_runs_set_stale         run insert: a member of the set is no longer as it was frozen (the same reads as the member guard of
--                                               mp-member-set.sql), or the Bot's connected memberships differ from pine_count;
--            mp_research_runs_complete          commit: the run has no seq 1 ADMITTED event written by the same transaction (deferred constraint trigger);
--            mp_research_run_events_order       event insert: seq is not the last seq plus one (also stamps at_ms);
--            mp_research_run_events_result      event insert: reason_code, result and result_hash do not follow the status, or the result does not tie to the run;
--            mp_research_run_events_transition  event insert: first event not ADMITTED or not from the run's transaction, a status edge outside the graph,
--                                               or any event after a terminal event.
-- Status graph: seq 1 ADMITTED (same transaction as the run row); ADMITTED -> RUNNING | FAILED | CANCELLED | TIMED_OUT; RUNNING -> SUCCEEDED |
-- NO_VALID_CANDIDATE | FAILED | CANCELLED | TIMED_OUT; nothing follows a terminal status. reason_code is required on FAILED, CANCELLED and TIMED_OUT and absent
-- otherwise; result and result_hash are required on SUCCEEDED and NO_VALID_CANDIDATE and absent otherwise.
-- Clocks: created_at_ms and deadline_ms of a run come from the application clock (comparable with the exposure register at_ms); at_ms of an event comes from
-- the DATABASE clock, stamped by mp_run_store_guard_order as max(clock, previous at_ms + 1); a value the writer supplies is overwritten.
-- The database does not recompute any SHA-256 hash (SQL canonical JSON differs from the application form): the application recomputes contract_hash and
-- result_hash and re-checks every loaded run. A hash is a tie and never an authorization.
-- Insert guards never need UPDATE privilege and take no lock: they read through the writer's SERIALIZABLE snapshot. A pine row that a concurrent transaction
-- changes and commits after that snapshot is not detected by the stale guard alone; the writer closes that window with FOR SHARE locks on the member
-- deployments and the Bot's memberships (RD-MP-15), and freshness at read stays the authority. The application retries 40001 from the start of its transaction.
-- The seq 1 event is accepted only from the transaction that wrote the run row (xmin of the current top-level transaction): a run insert behind a SAVEPOINT is
-- therefore refused. The same holds for a PL/pgSQL EXCEPTION block (it opens a subtransaction): the run and its seq 1 event are written by the top-level
-- transaction with no SAVEPOINT and no EXCEPTION block around them (the slice RS-2 writer brief says so).
-- Other rules, as ruled (K4): the fixture role holds SELECT only on the marker table; the run guard also ties policy_hash and funding_cutoff of the contract to
-- the member set; reason_code is absent on SUCCEEDED and NO_VALID_CANDIDATE. deadline_ms - created_at_ms is bounded exactly as deadline_seconds of the one-Pine
-- research job (src/postgres/quant-research.js: minimum 60 s, maximum 900 s).
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into installed tables replays the guards and needs a
-- superuser with --disable-triggers, and logical replication of these tables is not supported.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like an extension object can never be
-- used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- Dependency: the foreign keys name mp_member_sets (extension mp_member_set_schema version 1, which must be INSTALLED) and users. The member-set rollback
-- therefore fails loudly while this extension is installed (at any row count); roll back this extension first. Its own rollback refuses while any row exists.
-- This file is not idempotent by itself: src/postgres/mp-run-store-migration.js classifies the live catalog first and runs it only over ABSENT.
-- Rollback: src/postgres/mp-run-store-rollback.sql drops exactly the objects created here.

CREATE TABLE public.mp_run_store_schema(
 version INTEGER NOT NULL,
 CONSTRAINT mp_run_store_schema_pkey PRIMARY KEY(version),
 CONSTRAINT mp_run_store_schema_version_check CHECK(version=1)
);
INSERT INTO public.mp_run_store_schema VALUES(1);

CREATE TABLE public.mp_research_runs(
 run_id UUID NOT NULL,
 owner_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 member_set_id UUID NOT NULL,
 set_hash TEXT NOT NULL,
 membership_hash TEXT NOT NULL,
 pine_count SMALLINT NOT NULL,
 contract_version TEXT NOT NULL,
 contract JSONB NOT NULL,
 contract_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 submission_hash TEXT NOT NULL,
 engine_hash TEXT NOT NULL,
 dataset_content_digest TEXT NOT NULL,
 created_at_ms BIGINT NOT NULL,
 deadline_ms BIGINT NOT NULL,
 fixture BOOLEAN NOT NULL,
 CONSTRAINT mp_research_runs_pkey PRIMARY KEY(run_id),
 CONSTRAINT mp_research_runs_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT mp_research_runs_bot_id_fkey FOREIGN KEY(bot_id) REFERENCES public.users(id),
 CONSTRAINT mp_research_runs_set_fkey FOREIGN KEY(member_set_id,owner_id,bot_id) REFERENCES public.mp_member_sets(member_set_id,owner_id,bot_id),
 CONSTRAINT mp_research_runs_set_hash_fkey FOREIGN KEY(member_set_id,set_hash) REFERENCES public.mp_member_sets(member_set_id,set_hash),
 CONSTRAINT mp_research_runs_idempotency_key UNIQUE(owner_id,bot_id,idempotency_key),
 CONSTRAINT mp_research_runs_set_hash_check CHECK(set_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_research_runs_membership_hash_check CHECK(membership_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_research_runs_pine_count_check CHECK(pine_count>=2 AND pine_count<=3),
 CONSTRAINT mp_research_runs_contract_version_check CHECK(contract_version='ql3a-research-job-multi-v1'),
 CONSTRAINT mp_research_runs_contract_check CHECK(pg_catalog.jsonb_typeof(contract)='object'),
 CONSTRAINT mp_research_runs_contract_size_check CHECK(pg_catalog.pg_column_size(contract)<=262144),
 CONSTRAINT mp_research_runs_contract_hash_check CHECK(contract_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_research_runs_idempotency_key_check CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 CONSTRAINT mp_research_runs_submission_hash_check CHECK(submission_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_research_runs_engine_hash_check CHECK(engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_research_runs_dataset_content_digest_check CHECK(dataset_content_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_research_runs_created_at_ms_check CHECK(created_at_ms>=1 AND created_at_ms<=8640000000000000),
 CONSTRAINT mp_research_runs_deadline_ms_check CHECK(deadline_ms>=created_at_ms+60000 AND deadline_ms<=created_at_ms+900000),
 CONSTRAINT mp_research_runs_fixture_check CHECK(fixture),
 CONSTRAINT mp_research_runs_contract_ties_check CHECK(COALESCE(contract->'version'=pg_catalog.to_jsonb(contract_version) AND contract->'mode'='"MULTI_PINE"'::jsonb
  AND contract->'owner_id'=pg_catalog.to_jsonb(owner_id) AND contract->'bot_id'=pg_catalog.to_jsonb(bot_id)
  AND contract->'member_set_id'=pg_catalog.to_jsonb(member_set_id::text) AND contract->'set_hash'=pg_catalog.to_jsonb(set_hash)
  AND contract->'membership_hash'=pg_catalog.to_jsonb(membership_hash) AND contract->'pine_count'=pg_catalog.to_jsonb(pine_count)
  AND contract->'engine_hash'=pg_catalog.to_jsonb(engine_hash) AND contract->'dataset'->'content_digest'=pg_catalog.to_jsonb(dataset_content_digest)
  AND contract->'fixture'='true'::jsonb AND contract->'same_bar_order'='"exit-first-ordinal-v1"'::jsonb
  AND CASE WHEN pg_catalog.jsonb_typeof(contract->'acceptance_blockers')='array' THEN contract->'acceptance_blockers' ? 'MULTI_PINE_REQUIRES_APP_3B' ELSE false END
  AND CASE WHEN pg_catalog.jsonb_typeof(contract->'members')='array' THEN pg_catalog.jsonb_array_length(contract->'members')=pine_count ELSE false END
  AND contract ?& ARRAY['version','mode','pine_count','member_set_id','set_hash','membership_hash','members','owner_id','bot_id','policy_hash','funding_cutoff','capital','model','rules',
   'engine_hash','dataset','split','budget','seed','bridge_domains','same_bar_order','fixture','acceptance_blockers']
  AND (contract-ARRAY['version','mode','pine_count','member_set_id','set_hash','membership_hash','members','owner_id','bot_id','policy_hash','funding_cutoff','capital','model','rules',
   'engine_hash','dataset','split','budget','seed','bridge_domains','same_bar_order','fixture','acceptance_blockers'])='{}'::jsonb
  AND NOT (contract ?| ARRAY['deployment_id','pine_import_id','source_version']),false))
);

CREATE TABLE public.mp_research_run_events(
 run_id UUID NOT NULL,
 seq INTEGER NOT NULL,
 status TEXT NOT NULL,
 at_ms BIGINT NOT NULL,
 reason_code TEXT,
 result JSONB,
 result_hash TEXT,
 CONSTRAINT mp_research_run_events_pkey PRIMARY KEY(run_id,seq),
 CONSTRAINT mp_research_run_events_run_fkey FOREIGN KEY(run_id) REFERENCES public.mp_research_runs(run_id),
 CONSTRAINT mp_research_run_events_seq_check CHECK(seq>=1 AND seq<=64),
 CONSTRAINT mp_research_run_events_status_check CHECK(status IN ('ADMITTED','RUNNING','SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT')),
 CONSTRAINT mp_research_run_events_at_ms_check CHECK(at_ms>=1 AND at_ms<=8640000000000000),
 CONSTRAINT mp_research_run_events_reason_code_check CHECK(reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 CONSTRAINT mp_research_run_events_result_check CHECK(result IS NULL OR pg_catalog.jsonb_typeof(result)='object'),
 CONSTRAINT mp_research_run_events_result_size_check CHECK(result IS NULL OR pg_catalog.pg_column_size(result)<=1048576),
 CONSTRAINT mp_research_run_events_result_hash_check CHECK(result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION public.mp_run_store_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'mp-run-store-v1-schema'::text $fn$;

CREATE FUNCTION public.mp_run_store_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Multi-Pine run store records are insert-only' USING ERRCODE = 'QR002';
END $fn$;

-- Every INSERT into a run-store table must run in a SERIALIZABLE transaction (QR003, as for the member-set tables).
CREATE FUNCTION public.mp_run_store_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Multi-Pine run store writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

-- Run insert, binding: the run ties to the frozen member set row it names.
CREATE FUNCTION public.mp_run_store_guard_run() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE parent RECORD;
BEGIN
 SELECT s.owner_id, s.bot_id, s.pine_count, s.membership_hash, s.same_bar_order, s.policy_hash, s.funding_cutoff, s.fixture, s.record INTO parent
  FROM public.mp_member_sets s WHERE s.member_set_id = NEW.member_set_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A run needs its member set row' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF NEW.owner_id IS DISTINCT FROM parent.owner_id OR NEW.bot_id IS DISTINCT FROM parent.bot_id THEN
  RAISE EXCEPTION 'A run must carry the owner and Bot of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF NEW.pine_count IS DISTINCT FROM parent.pine_count THEN
  RAISE EXCEPTION 'A run must carry the pine_count of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF NEW.membership_hash IS DISTINCT FROM parent.membership_hash THEN
  RAISE EXCEPTION 'A run must carry the membership_hash of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF (NEW.contract OPERATOR(pg_catalog.->) 'same_bar_order'::text) IS DISTINCT FROM pg_catalog.to_jsonb(parent.same_bar_order) THEN
  RAISE EXCEPTION 'A run contract must carry the same_bar_order of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF (NEW.contract OPERATOR(pg_catalog.->) 'policy_hash'::text) IS DISTINCT FROM pg_catalog.to_jsonb(parent.policy_hash)
    OR (NEW.contract OPERATOR(pg_catalog.->) 'funding_cutoff'::text) IS DISTINCT FROM pg_catalog.to_jsonb(parent.funding_cutoff) THEN
  RAISE EXCEPTION 'A run contract must carry the policy_hash and funding_cutoff of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF (NEW.contract OPERATOR(pg_catalog.->) 'members'::text) IS DISTINCT FROM (parent.record OPERATOR(pg_catalog.->) 'members'::text) THEN
  RAISE EXCEPTION 'A run contract must carry the members of the stored member set record' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 IF parent.fixture IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'A run needs a fixture member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_guard';
 END IF;
 RETURN NEW;
END $fn$;

-- Run insert, staleness: the same reads as the member guard of the member-set extension, on the committed pine rows.
CREATE FUNCTION public.mp_run_store_guard_stale() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE item RECORD; dep RECORD; membership RECORD; revision RECORD; proof RECORD; member_count INTEGER := 0; connected_count INTEGER;
BEGIN
 FOR item IN SELECT m.* FROM public.mp_member_set_members m WHERE m.member_set_id = NEW.member_set_id ORDER BY m.ordinal LOOP
  member_count := member_count OPERATOR(pg_catalog.+) 1;
  SELECT d.owner_id, d.bot_id, d.pine_import_id, d.source_version, d.state, d.snapshot_hash INTO dep FROM public.pine_deployments d WHERE d.deployment_id = item.deployment_id;
  IF NOT FOUND OR dep.owner_id IS DISTINCT FROM item.owner_id OR dep.bot_id IS DISTINCT FROM item.bot_id
     OR dep.pine_import_id IS DISTINCT FROM item.pine_import_id OR dep.source_version IS DISTINCT FROM item.source_version THEN
   RAISE EXCEPTION 'A member deployment must still exist with the same owner, Bot, import and source version' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
  END IF;
  IF dep.state IS DISTINCT FROM 'DRAFT' THEN
   RAISE EXCEPTION 'A member deployment must still be DRAFT' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
  END IF;
  IF dep.snapshot_hash IS DISTINCT FROM item.deployment_snapshot_hash THEN
   RAISE EXCEPTION 'A member deployment snapshot_hash must still equal the frozen one' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
  END IF;
  SELECT p.owner_id, p.bot_id, p.source_version, p.connected INTO membership FROM public.pine_memberships p WHERE p.pine_import_id = item.pine_import_id;
  IF NOT FOUND OR membership.connected IS DISTINCT FROM true OR membership.owner_id IS DISTINCT FROM item.owner_id
     OR membership.bot_id IS DISTINCT FROM item.bot_id OR membership.source_version IS DISTINCT FROM item.source_version THEN
   RAISE EXCEPTION 'A member import must still be a connected membership of the same owner, Bot and source version' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
  END IF;
  SELECT r.source_hash, r.analysis OPERATOR(pg_catalog.->>) 'effective_inputs_hash'::text AS effective_inputs_hash INTO revision
   FROM public.pine_source_revisions r WHERE r.pine_import_id = item.pine_import_id AND r.source_version = item.source_version;
  IF NOT FOUND OR revision.source_hash IS DISTINCT FROM item.source_hash OR revision.effective_inputs_hash IS DISTINCT FROM item.effective_inputs_hash THEN
   RAISE EXCEPTION 'A member source_hash and effective_inputs_hash must still equal the source revision' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
  END IF;
  SELECT e.snapshot_hash, e.evidence_hash INTO proof FROM public.pine_bridge_evidence e WHERE e.deployment_id = item.deployment_id;
  IF NOT FOUND OR proof.snapshot_hash IS DISTINCT FROM dep.snapshot_hash OR proof.evidence_hash IS DISTINCT FROM item.evidence_hash THEN
   RAISE EXCEPTION 'A member must still have the Bridge evidence row of its deployment with the same snapshot_hash and evidence_hash' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
  END IF;
 END LOOP;
 IF member_count IS DISTINCT FROM NEW.pine_count THEN
  RAISE EXCEPTION 'The member set must still have pine_count member rows' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
 END IF;
 SELECT pg_catalog.count(*)::integer INTO connected_count FROM public.pine_memberships p WHERE p.owner_id = NEW.owner_id AND p.bot_id = NEW.bot_id AND p.connected;
 IF connected_count IS DISTINCT FROM NEW.pine_count THEN
  RAISE EXCEPTION 'The run pine_count must equal the connected memberships of its Bot' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_set_stale';
 END IF;
 RETURN NEW;
END $fn$;

-- Deferred to commit: a run commits only with its seq 1 ADMITTED event, written by the same transaction.
CREATE FUNCTION public.mp_run_store_guard_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.mp_research_run_events e WHERE e.run_id = NEW.run_id AND e.seq = 1 AND e.status = 'ADMITTED'
    AND e.xmin = pg_catalog.pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'A run needs its seq 1 ADMITTED event written by the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_runs_complete';
 END IF;
 RETURN NULL;
END $fn$;

-- Event insert, order: seq is the last seq plus one. Stamps at_ms from the database clock, strictly after the previous event.
CREATE FUNCTION public.mp_run_store_guard_order() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE last_row RECORD; last_seq INTEGER := 0; previous_ms BIGINT := 0; clock_ms BIGINT;
BEGIN
 SELECT e.seq, e.at_ms INTO last_row FROM public.mp_research_run_events e WHERE e.run_id = NEW.run_id ORDER BY e.seq DESC LIMIT 1;
 IF FOUND THEN
  last_seq := last_row.seq;
  previous_ms := last_row.at_ms;
 END IF;
 IF NEW.seq IS DISTINCT FROM (last_seq OPERATOR(pg_catalog.+) 1) THEN
  RAISE EXCEPTION 'An event seq must be the last seq of its run plus one' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_order';
 END IF;
 clock_ms := pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) OPERATOR(pg_catalog.*) 1000)::bigint;
 NEW.at_ms := CASE WHEN clock_ms OPERATOR(pg_catalog.>) previous_ms THEN clock_ms ELSE previous_ms OPERATOR(pg_catalog.+) 1 END;
 RETURN NEW;
END $fn$;

-- Event insert, result: reason_code, result and result_hash follow the status; a result ties to its run.
CREATE FUNCTION public.mp_run_store_guard_result() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE run_hash TEXT;
BEGIN
 IF NEW.status IN ('FAILED','CANCELLED','TIMED_OUT') THEN
  IF NEW.reason_code IS NULL OR NEW.result IS NOT NULL OR NEW.result_hash IS NOT NULL THEN
   RAISE EXCEPTION 'A FAILED, CANCELLED or TIMED_OUT event needs a reason_code and no result' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
 ELSIF NEW.status IN ('SUCCEEDED','NO_VALID_CANDIDATE') THEN
  IF NEW.reason_code IS NOT NULL OR NEW.result IS NULL OR NEW.result_hash IS NULL THEN
   RAISE EXCEPTION 'A SUCCEEDED or NO_VALID_CANDIDATE event needs a result and a result_hash and no reason_code' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'A result must be a JSON object' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
  SELECT r.contract_hash INTO run_hash FROM public.mp_research_runs r WHERE r.run_id = NEW.run_id;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'A result needs its run row' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
  IF (NEW.result OPERATOR(pg_catalog.->) 'run_id'::text) IS DISTINCT FROM pg_catalog.to_jsonb(NEW.run_id::text)
     OR (NEW.result OPERATOR(pg_catalog.->) 'contract_hash'::text) IS DISTINCT FROM pg_catalog.to_jsonb(run_hash) THEN
   RAISE EXCEPTION 'A result must name the run_id and the contract_hash of its run' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
  IF (NEW.result OPERATOR(pg_catalog.->) 'owner_recommendation_ready'::text) IS DISTINCT FROM 'false'::jsonb THEN
   RAISE EXCEPTION 'A result must carry owner_recommendation_ready false' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result OPERATOR(pg_catalog.->) 'acceptance_blockers'::text) IS DISTINCT FROM 'array'
     OR NOT ((NEW.result OPERATOR(pg_catalog.->) 'acceptance_blockers'::text) OPERATOR(pg_catalog.?) 'MULTI_PINE_REQUIRES_APP_3B') THEN
   RAISE EXCEPTION 'A result must list the MULTI_PINE_REQUIRES_APP_3B blocker' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
 ELSE
  IF NEW.reason_code IS NOT NULL OR NEW.result IS NOT NULL OR NEW.result_hash IS NOT NULL THEN
   RAISE EXCEPTION 'An ADMITTED or RUNNING event carries no reason_code, result or result_hash' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_result';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;

-- Event insert, transition: the status graph. The first event is ADMITTED, written by the transaction that wrote the run row. No event follows a terminal one.
CREATE FUNCTION public.mp_run_store_guard_transition() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE run_row RECORD; last_status TEXT; has_last BOOLEAN; allowed BOOLEAN;
BEGIN
 SELECT r.xmin = pg_catalog.pg_current_xact_id()::xid AS in_create INTO run_row FROM public.mp_research_runs r WHERE r.run_id = NEW.run_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'An event needs its run row' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_transition';
 END IF;
 SELECT e.status INTO last_status FROM public.mp_research_run_events e WHERE e.run_id = NEW.run_id ORDER BY e.seq DESC LIMIT 1;
 has_last := FOUND;
 IF NOT has_last THEN
  IF NEW.status IS DISTINCT FROM 'ADMITTED' THEN
   RAISE EXCEPTION 'The first event of a run must be ADMITTED' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_transition';
  END IF;
  IF run_row.in_create IS NOT TRUE THEN
   RAISE EXCEPTION 'The ADMITTED event must be written by the transaction that wrote the run' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_transition';
  END IF;
 ELSE
  IF last_status IN ('SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT') THEN
   RAISE EXCEPTION 'No event can follow a terminal event' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_transition';
  END IF;
  allowed := CASE last_status
   WHEN 'ADMITTED' THEN NEW.status IN ('RUNNING','FAILED','CANCELLED','TIMED_OUT')
   WHEN 'RUNNING' THEN NEW.status IN ('SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT')
   ELSE false END;
  IF allowed IS NOT TRUE THEN
   RAISE EXCEPTION 'This status transition is not allowed' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_research_run_events_transition';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER mp_run_store_schema_no_change BEFORE UPDATE OR DELETE ON public.mp_run_store_schema FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_freeze();
CREATE TRIGGER mp_run_store_schema_no_truncate BEFORE TRUNCATE ON public.mp_run_store_schema FOR EACH STATEMENT EXECUTE FUNCTION public.mp_run_store_freeze();
CREATE TRIGGER mp_research_runs_no_change BEFORE UPDATE OR DELETE ON public.mp_research_runs FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_freeze();
CREATE TRIGGER mp_research_runs_no_truncate BEFORE TRUNCATE ON public.mp_research_runs FOR EACH STATEMENT EXECUTE FUNCTION public.mp_run_store_freeze();
CREATE TRIGGER mp_research_run_events_no_change BEFORE UPDATE OR DELETE ON public.mp_research_run_events FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_freeze();
CREATE TRIGGER mp_research_run_events_no_truncate BEFORE TRUNCATE ON public.mp_research_run_events FOR EACH STATEMENT EXECUTE FUNCTION public.mp_run_store_freeze();

CREATE TRIGGER mp_run_store_schema_00_serializable BEFORE INSERT ON public.mp_run_store_schema FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_require_serializable();
CREATE TRIGGER mp_research_runs_00_serializable BEFORE INSERT ON public.mp_research_runs FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_require_serializable();
CREATE TRIGGER mp_research_run_events_00_serializable BEFORE INSERT ON public.mp_research_run_events FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_require_serializable();
CREATE TRIGGER mp_research_runs_guard BEFORE INSERT ON public.mp_research_runs FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_run();
CREATE TRIGGER mp_research_runs_set_stale BEFORE INSERT ON public.mp_research_runs FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_stale();
CREATE CONSTRAINT TRIGGER mp_research_runs_complete AFTER INSERT ON public.mp_research_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_complete();
CREATE TRIGGER mp_research_run_events_order BEFORE INSERT ON public.mp_research_run_events FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_order();
CREATE TRIGGER mp_research_run_events_result BEFORE INSERT ON public.mp_research_run_events FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_result();
CREATE TRIGGER mp_research_run_events_transition BEFORE INSERT ON public.mp_research_run_events FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_transition();

ALTER TABLE public.mp_run_store_schema ENABLE ALWAYS TRIGGER mp_run_store_schema_no_change;
ALTER TABLE public.mp_run_store_schema ENABLE ALWAYS TRIGGER mp_run_store_schema_no_truncate;
ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_no_change;
ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_no_truncate;
ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER mp_research_run_events_no_change;
ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER mp_research_run_events_no_truncate;
ALTER TABLE public.mp_run_store_schema ENABLE ALWAYS TRIGGER mp_run_store_schema_00_serializable;
ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_00_serializable;
ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER mp_research_run_events_00_serializable;
ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_guard;
ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_set_stale;
ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_complete;
ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER mp_research_run_events_order;
ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER mp_research_run_events_result;
ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER mp_research_run_events_transition;
