-- F11-01 member-set extension T1: insert-only multi-Pine member-set tables, guards and marker (local candidate; applied offline and separately
-- from the version-1 extensions; docs/MULTI_PINE_CONTRACT.md RD-MP-11 to RD-MP-15, packaging RD-MP-13, guards RD-MP-14, transaction RD-MP-15).
-- A frozen member set is one parent row (the S1 record, verbatim) and one child row per member. No store function, service, route or reader of
-- these rows ships with this file.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (shared function mp_freeze, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (the meaning of PKG RC-25 and RC-26: a writer
--          reads and appends under one snapshot; trigger mp_require_serializable, named *_00_serializable so it fires first);
--   QR004  an INSERT that breaks the member-set rules is refused (PKG RC-25). Each QR004 is raised with CONSTRAINT = the name of the guard
--          trigger that raised it, so the writer maps the guard that fired (RD-MP-14: mp_member_set_members_guard and mp_member_sets_complete
--          both map to MP_MEMBER_SET_STALE).
-- Insert guards never need UPDATE privilege and take no lock: they read the pine rows through the writer's SERIALIZABLE snapshot. A pine row that a
-- concurrent transaction changes and commits after that snapshot is NOT detected here (one read-write dependency is a valid serial order), so the set
-- would be stale at birth: the freeze service closes that window with FOR SHARE locks on the member deployments (RD-MP-15; a row changed after the
-- snapshot then fails 40001), and freshness at read stays the authority. The application retries 40001 from the start of its transaction.
--
-- Insert order of one set (one SERIALIZABLE transaction):
--   1. mp_member_sets         the parent. Its CHECKs tie every column to the verbatim S1 record in column record. UNIQUE(owner_id, bot_id,
--                             content_digest) is the insert-or-load key of RD-MP-11.
--   2. mp_member_set_members  one row per member, ordinal 1..pine_count. The guard reads committed rows and requires: the parent, the same owner and
--                             Bot, the same exit_version, the member projection equal to record->members[ordinal-1]; the named deployment of the
--                             same owner, Bot, import and source version, state DRAFT, snapshot_hash equal; the connected membership of the same
--                             owner, Bot and source version; the source revision with the same source_hash and effective_inputs_hash; the Bridge
--                             evidence row of the deployment with the same snapshot_hash and evidence_hash.
--   3. commit                 a DEFERRABLE INITIALLY DEFERRED constraint trigger refuses a parent whose member count differs from pine_count. After the
--                             commit the primary key (member_set_id, ordinal) with ordinal <= pine_count blocks any extra member.
-- The database does not recompute the SHA-256 hashes (SQL canonical JSON differs from the application form): the application re-checks every loaded
-- record. A hash is a tie and never an authorization. exit_version is derived by the application (RD-MP-12); the database limits it to the versions
-- the receiver knows and keeps parent and members equal.
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into installed tables replays the guards and
-- needs a superuser with --disable-triggers, and logical replication of these tables is not supported.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like an extension object can
-- never be used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- Dependency: the foreign keys name pine_source_revisions and pine_deployments, so those Pine Bridge tables cannot be dropped while this extension is
-- installed (at any row count). Roll back the member-set extension first; that rollback itself refuses while any record row exists.
-- Completeness: the deferred guard also requires pine_count to equal the number of connected memberships of the Bot, so a set can never freeze a
-- strict subset of the connected Pine imports (QR004, constraint mp_member_sets_complete).
-- This file is not idempotent by itself: src/postgres/mp-member-set-migration.js classifies the live catalog first and runs it only over ABSENT.
-- Rollback: src/postgres/mp-member-set-rollback.sql drops exactly the objects created here.
-- Requires the base users table and the Pine Bridge extension (pine_bridge_schema version 1).

CREATE TABLE public.mp_member_set_schema(
 version INTEGER NOT NULL,
 CONSTRAINT mp_member_set_schema_pkey PRIMARY KEY(version),
 CONSTRAINT mp_member_set_schema_version_check CHECK(version=1)
);
INSERT INTO public.mp_member_set_schema VALUES(1);

CREATE TABLE public.mp_member_sets(
 member_set_id UUID NOT NULL,
 owner_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 version TEXT NOT NULL,
 pine_count SMALLINT NOT NULL,
 membership_hash TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 set_hash TEXT NOT NULL,
 execution_model_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL,
 capital_basis_hash TEXT NOT NULL,
 funding_cutoff BIGINT NOT NULL,
 bridge_atr_multiplier TEXT NOT NULL,
 bridge_rr TEXT NOT NULL,
 exit_version TEXT NOT NULL,
 same_bar_order TEXT NOT NULL,
 fixture BOOLEAN NOT NULL,
 record JSONB NOT NULL,
 created_at_utc TEXT NOT NULL,
 CONSTRAINT mp_member_sets_pkey PRIMARY KEY(member_set_id),
 CONSTRAINT mp_member_sets_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT mp_member_sets_bot_id_fkey FOREIGN KEY(bot_id) REFERENCES public.users(id),
 CONSTRAINT mp_member_sets_content_key UNIQUE(owner_id,bot_id,content_digest),
 CONSTRAINT mp_member_sets_set_hash_key UNIQUE(member_set_id,set_hash),
 CONSTRAINT mp_member_sets_identity_key UNIQUE(member_set_id,owner_id,bot_id),
 CONSTRAINT mp_member_sets_version_check CHECK(version='mp-member-set-v1'),
 CONSTRAINT mp_member_sets_pine_count_check CHECK(pine_count>=2 AND pine_count<=3),
 CONSTRAINT mp_member_sets_membership_hash_check CHECK(membership_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_sets_content_digest_check CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_sets_set_hash_check CHECK(set_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_sets_execution_model_hash_check CHECK(execution_model_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_sets_policy_hash_check CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_sets_capital_basis_hash_check CHECK(capital_basis_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_sets_funding_cutoff_check CHECK(funding_cutoff>=0 AND funding_cutoff<=9007199254740991),
 CONSTRAINT mp_member_sets_bridge_atr_multiplier_check CHECK(CASE WHEN bridge_atr_multiplier ~ '^(0|[1-9][0-9]{0,39})(\.[0-9]{0,39}[1-9])?$'
  THEN bridge_atr_multiplier::numeric>0 AND bridge_atr_multiplier::numeric<=1000 ELSE false END),
 CONSTRAINT mp_member_sets_bridge_rr_check CHECK(CASE WHEN bridge_rr ~ '^(0|[1-9][0-9]{0,39})(\.[0-9]{0,39}[1-9])?$'
  THEN bridge_rr::numeric>0 AND bridge_rr::numeric<=1000 ELSE false END),
 CONSTRAINT mp_member_sets_exit_version_check CHECK(exit_version IN ('bridge-exit-v1','bridge-exit-v2')),
 CONSTRAINT mp_member_sets_same_bar_order_check CHECK(same_bar_order='exit-first-ordinal-v1'),
 CONSTRAINT mp_member_sets_fixture_check CHECK(fixture),
 CONSTRAINT mp_member_sets_record_check CHECK(pg_catalog.jsonb_typeof(record)='object'),
 CONSTRAINT mp_member_sets_created_at_utc_check CHECK(created_at_utc ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?Z$'),
 CONSTRAINT mp_member_sets_record_ties_check CHECK(COALESCE(record->'member_set_id'=pg_catalog.to_jsonb(member_set_id::text) AND record->'owner_id'=pg_catalog.to_jsonb(owner_id)
  AND record->'bot_id'=pg_catalog.to_jsonb(bot_id)
  AND record->'version'=pg_catalog.to_jsonb(version) AND record->'mode'='"MULTI_PINE"'::jsonb AND record->'pine_count'=pg_catalog.to_jsonb(pine_count)
  AND record->'membership_hash'=pg_catalog.to_jsonb(membership_hash) AND record->'content_digest'=pg_catalog.to_jsonb(content_digest)
  AND record->'set_hash'=pg_catalog.to_jsonb(set_hash)
  AND record->'execution_model_hash'=pg_catalog.to_jsonb(execution_model_hash) AND record->'policy_hash'=pg_catalog.to_jsonb(policy_hash)
  AND record->'capital_basis_hash'=pg_catalog.to_jsonb(capital_basis_hash)
  AND record->'funding_cutoff'=pg_catalog.to_jsonb(funding_cutoff)
  AND record->'bridge_pair'=pg_catalog.jsonb_build_object('atr_multiplier',bridge_atr_multiplier,'rr',bridge_rr)
  AND record->'bridge_atr_period'='14'::jsonb AND record->'market'='{"broker":"binance-global","symbol":"BTCUSDT","timeframe":"1"}'::jsonb
  AND record->'exit_version'=pg_catalog.to_jsonb(exit_version) AND record->'same_bar_order'=pg_catalog.to_jsonb(same_bar_order)
  AND record->'fixture'=pg_catalog.to_jsonb(fixture)
  AND record->'created_at'=pg_catalog.to_jsonb(created_at_utc)
  AND CASE WHEN pg_catalog.jsonb_typeof(record->'members')='array' THEN pg_catalog.jsonb_array_length(record->'members')=pine_count ELSE false END
  AND (record-ARRAY['version','owner_id','bot_id','mode','pine_count','members','membership_hash','bridge_pair','bridge_atr_period','market','exit_version',
   'execution_model_hash','policy_hash','funding_cutoff','capital_basis_hash','same_bar_order','fixture','member_set_id','content_digest','set_hash','created_at'])='{}'::jsonb,false))
);

CREATE TABLE public.mp_member_set_members(
 member_set_id UUID NOT NULL,
 ordinal SMALLINT NOT NULL,
 owner_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 pine_import_id TEXT NOT NULL,
 source_version INTEGER NOT NULL,
 source_hash TEXT NOT NULL,
 effective_inputs_hash TEXT NOT NULL,
 deployment_id TEXT NOT NULL,
 deployment_snapshot_hash TEXT NOT NULL,
 exit_version TEXT NOT NULL,
 evidence_hash TEXT NOT NULL,
 CONSTRAINT mp_member_set_members_pkey PRIMARY KEY(member_set_id,ordinal),
 CONSTRAINT mp_member_set_members_set_fkey FOREIGN KEY(member_set_id,owner_id,bot_id) REFERENCES public.mp_member_sets(member_set_id,owner_id,bot_id),
 CONSTRAINT mp_member_set_members_revision_fkey FOREIGN KEY(pine_import_id,source_version) REFERENCES public.pine_source_revisions(pine_import_id,source_version),
 CONSTRAINT mp_member_set_members_deployment_fkey FOREIGN KEY(deployment_id) REFERENCES public.pine_deployments(deployment_id),
 CONSTRAINT mp_member_set_members_import_key UNIQUE(member_set_id,pine_import_id),
 CONSTRAINT mp_member_set_members_deployment_key UNIQUE(member_set_id,deployment_id),
 CONSTRAINT mp_member_set_members_ordinal_check CHECK(ordinal>=1 AND ordinal<=3),
 CONSTRAINT mp_member_set_members_pine_import_id_check CHECK(pg_catalog.length(pine_import_id)>=1 AND pg_catalog.length(pine_import_id)<=200),
 CONSTRAINT mp_member_set_members_deployment_id_check CHECK(pg_catalog.length(deployment_id)>=1 AND pg_catalog.length(deployment_id)<=200),
 CONSTRAINT mp_member_set_members_source_version_check CHECK(source_version>0),
 CONSTRAINT mp_member_set_members_source_hash_check CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_set_members_effective_inputs_hash_check CHECK(effective_inputs_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_set_members_snapshot_hash_check CHECK(deployment_snapshot_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_set_members_evidence_hash_check CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_member_set_members_exit_version_check CHECK(exit_version IN ('bridge-exit-v1','bridge-exit-v2'))
);
CREATE INDEX mp_member_set_members_deployment ON public.mp_member_set_members(deployment_id);

CREATE FUNCTION public.mp_member_set_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'mp-member-set-v1-schema'::text $fn$;

CREATE FUNCTION public.mp_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Multi-Pine member-set records are insert-only' USING ERRCODE = 'QR002';
END $fn$;

-- Every INSERT into a member-set table must run in a SERIALIZABLE transaction (QR003, as for the exposure register and the package tables).
CREATE FUNCTION public.mp_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Multi-Pine member-set writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

-- The member insert guard. Every QR004 names this trigger in CONSTRAINT, so the writer maps by the guard that fired (RD-MP-14).
CREATE FUNCTION public.mp_guard_member() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE parent RECORD; dep RECORD; membership RECORD; revision RECORD; proof RECORD;
BEGIN
 SELECT s.owner_id, s.bot_id, s.pine_count, s.exit_version, s.record INTO parent FROM public.mp_member_sets s WHERE s.member_set_id = NEW.member_set_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A member row needs its member set row first' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 IF NEW.ordinal OPERATOR(pg_catalog.>) parent.pine_count THEN
  RAISE EXCEPTION 'A member ordinal cannot exceed the pine_count of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 IF NEW.owner_id IS DISTINCT FROM parent.owner_id OR NEW.bot_id IS DISTINCT FROM parent.bot_id OR NEW.exit_version IS DISTINCT FROM parent.exit_version THEN
  RAISE EXCEPTION 'A member row must carry the owner, Bot and exit_version of its member set' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 IF (parent.record OPERATOR(pg_catalog.->) 'members'::text) OPERATOR(pg_catalog.->) (NEW.ordinal::integer OPERATOR(pg_catalog.-) 1) IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'ordinal', NEW.ordinal, 'pine_import_id', NEW.pine_import_id, 'source_version', NEW.source_version, 'source_hash', NEW.source_hash,
    'effective_inputs_hash', NEW.effective_inputs_hash, 'deployment_id', NEW.deployment_id, 'deployment_snapshot_hash', NEW.deployment_snapshot_hash,
    'exit_version', NEW.exit_version, 'evidence_hash', NEW.evidence_hash) THEN
  RAISE EXCEPTION 'A member row must equal the member of the stored record at its ordinal' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 SELECT d.owner_id, d.bot_id, d.pine_import_id, d.source_version, d.state, d.snapshot_hash INTO dep FROM public.pine_deployments d WHERE d.deployment_id = NEW.deployment_id;
 IF NOT FOUND OR dep.owner_id IS DISTINCT FROM NEW.owner_id OR dep.bot_id IS DISTINCT FROM NEW.bot_id
    OR dep.pine_import_id IS DISTINCT FROM NEW.pine_import_id OR dep.source_version IS DISTINCT FROM NEW.source_version THEN
  RAISE EXCEPTION 'A member deployment must exist with the same owner, Bot, import and source version' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 IF dep.state IS DISTINCT FROM 'DRAFT' THEN
  RAISE EXCEPTION 'A member deployment must be DRAFT' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 IF dep.snapshot_hash IS DISTINCT FROM NEW.deployment_snapshot_hash THEN
  RAISE EXCEPTION 'A member deployment_snapshot_hash must equal the snapshot_hash of the deployment' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 SELECT m.owner_id, m.bot_id, m.source_version, m.connected INTO membership FROM public.pine_memberships m WHERE m.pine_import_id = NEW.pine_import_id;
 IF NOT FOUND OR membership.connected IS DISTINCT FROM true OR membership.owner_id IS DISTINCT FROM NEW.owner_id
    OR membership.bot_id IS DISTINCT FROM NEW.bot_id OR membership.source_version IS DISTINCT FROM NEW.source_version THEN
  RAISE EXCEPTION 'A member import must be a connected membership of the same owner, Bot and source version' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 SELECT r.source_hash, r.analysis OPERATOR(pg_catalog.->>) 'effective_inputs_hash'::text AS effective_inputs_hash INTO revision
  FROM public.pine_source_revisions r WHERE r.pine_import_id = NEW.pine_import_id AND r.source_version = NEW.source_version;
 IF NOT FOUND OR revision.source_hash IS DISTINCT FROM NEW.source_hash OR revision.effective_inputs_hash IS DISTINCT FROM NEW.effective_inputs_hash THEN
  RAISE EXCEPTION 'A member source_hash and effective_inputs_hash must equal the source revision' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 SELECT e.snapshot_hash, e.evidence_hash INTO proof FROM public.pine_bridge_evidence e WHERE e.deployment_id = NEW.deployment_id;
 IF NOT FOUND OR proof.snapshot_hash IS DISTINCT FROM dep.snapshot_hash OR proof.evidence_hash IS DISTINCT FROM NEW.evidence_hash THEN
  RAISE EXCEPTION 'A member needs the Bridge evidence row of its deployment with the same snapshot_hash and evidence_hash' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_set_members_guard';
 END IF;
 RETURN NEW;
END $fn$;

-- Deferred to commit: a member set row commits only with all of its members, and pine_count covers every connected membership of the Bot.
CREATE FUNCTION public.mp_guard_set_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE member_count INTEGER; connected_count INTEGER;
BEGIN
 SELECT pg_catalog.count(*)::integer INTO member_count FROM public.mp_member_set_members m WHERE m.member_set_id = NEW.member_set_id;
 IF member_count IS DISTINCT FROM NEW.pine_count THEN
  RAISE EXCEPTION 'A member set needs exactly pine_count member rows in the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_sets_complete';
 END IF;
 SELECT pg_catalog.count(*)::integer INTO connected_count FROM public.pine_memberships p WHERE p.owner_id = NEW.owner_id AND p.bot_id = NEW.bot_id AND p.connected;
 IF connected_count IS DISTINCT FROM NEW.pine_count THEN
  RAISE EXCEPTION 'A member set pine_count must equal the connected memberships of its Bot' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_member_sets_complete';
 END IF;
 RETURN NULL;
END $fn$;

CREATE TRIGGER mp_member_set_schema_no_change BEFORE UPDATE OR DELETE ON public.mp_member_set_schema FOR EACH ROW EXECUTE FUNCTION public.mp_freeze();
CREATE TRIGGER mp_member_set_schema_no_truncate BEFORE TRUNCATE ON public.mp_member_set_schema FOR EACH STATEMENT EXECUTE FUNCTION public.mp_freeze();
CREATE TRIGGER mp_member_sets_no_change BEFORE UPDATE OR DELETE ON public.mp_member_sets FOR EACH ROW EXECUTE FUNCTION public.mp_freeze();
CREATE TRIGGER mp_member_sets_no_truncate BEFORE TRUNCATE ON public.mp_member_sets FOR EACH STATEMENT EXECUTE FUNCTION public.mp_freeze();
CREATE TRIGGER mp_member_set_members_no_change BEFORE UPDATE OR DELETE ON public.mp_member_set_members FOR EACH ROW EXECUTE FUNCTION public.mp_freeze();
CREATE TRIGGER mp_member_set_members_no_truncate BEFORE TRUNCATE ON public.mp_member_set_members FOR EACH STATEMENT EXECUTE FUNCTION public.mp_freeze();

CREATE TRIGGER mp_member_set_schema_00_serializable BEFORE INSERT ON public.mp_member_set_schema FOR EACH ROW EXECUTE FUNCTION public.mp_require_serializable();
CREATE TRIGGER mp_member_sets_00_serializable BEFORE INSERT ON public.mp_member_sets FOR EACH ROW EXECUTE FUNCTION public.mp_require_serializable();
CREATE TRIGGER mp_member_set_members_00_serializable BEFORE INSERT ON public.mp_member_set_members FOR EACH ROW EXECUTE FUNCTION public.mp_require_serializable();
CREATE TRIGGER mp_member_set_members_guard BEFORE INSERT ON public.mp_member_set_members FOR EACH ROW EXECUTE FUNCTION public.mp_guard_member();
CREATE CONSTRAINT TRIGGER mp_member_sets_complete AFTER INSERT ON public.mp_member_sets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.mp_guard_set_complete();

ALTER TABLE public.mp_member_set_schema ENABLE ALWAYS TRIGGER mp_member_set_schema_no_change;
ALTER TABLE public.mp_member_set_schema ENABLE ALWAYS TRIGGER mp_member_set_schema_no_truncate;
ALTER TABLE public.mp_member_sets ENABLE ALWAYS TRIGGER mp_member_sets_no_change;
ALTER TABLE public.mp_member_sets ENABLE ALWAYS TRIGGER mp_member_sets_no_truncate;
ALTER TABLE public.mp_member_set_members ENABLE ALWAYS TRIGGER mp_member_set_members_no_change;
ALTER TABLE public.mp_member_set_members ENABLE ALWAYS TRIGGER mp_member_set_members_no_truncate;
ALTER TABLE public.mp_member_set_schema ENABLE ALWAYS TRIGGER mp_member_set_schema_00_serializable;
ALTER TABLE public.mp_member_sets ENABLE ALWAYS TRIGGER mp_member_sets_00_serializable;
ALTER TABLE public.mp_member_set_members ENABLE ALWAYS TRIGGER mp_member_set_members_00_serializable;
ALTER TABLE public.mp_member_set_members ENABLE ALWAYS TRIGGER mp_member_set_members_guard;
ALTER TABLE public.mp_member_sets ENABLE ALWAYS TRIGGER mp_member_sets_complete;
