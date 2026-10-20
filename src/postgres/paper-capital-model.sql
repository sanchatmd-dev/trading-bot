-- QR-2 S4-1 paper capital model declaration extension (local candidate; applied offline and separately from the version-1 extensions;
-- docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md 4.2, 7.2 and 7.5).
-- One insert-only table records, for one owner and one currency, which capital model the owner declares for the owner's paper accounts:
-- INDEPENDENT_ACCOUNTS (each Bot account has its own capital, so an owner total is only a sum) or SHARED_HYPOTHETICAL (one pool of capital that no
-- ledger holds, so there is no owner total). A declaration is a version: versions run 1, 2, 3 without a gap for one (owner_id, currency), the
-- newest version applies from its effective_from (a UTC midnight) forward only, and a correction or a withdrawal is a new version, never an edit.
-- No store function, service, route or reader of these rows ships with this file.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on both tables of this file (shared function paper_capital_model_freeze, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused (a writer reads the owner set and the earlier versions and appends under one
--          snapshot; trigger paper_capital_models_00_serializable, named so it fires first);
--   stamp  declared_at is overwritten by the database clock (trigger paper_capital_models_10_stamp), so a client value is never stored;
--   QR004  an INSERT that breaks a declaration rule is refused (PKG RC-25) by trigger paper_capital_models_20_guard. Each QR004 is raised with
--          CONSTRAINT = the name of one rule family, so a writer maps the error by that name and never by message text:
--            paper_capital_models_owner    the owner is an existing main account (no parent) and declared_by is the owner;
--            paper_capital_models_version  version is 1 for the first row of an (owner, currency) pair, else the highest earlier version plus 1;
--            paper_capital_models_clock    effective_from is not before the database stamp, at most 86400000 ms after it (the next UTC midnight
--                                          only) and not before the previous version's effective_from; declared_at is not before the previous
--                                          version's declared_at;
--            paper_capital_models_bot_set  bot_set is an array of 1 to 5 strings in strictly ascending (byte order) order, every id belongs to the
--                                          owner set (the owner row plus the rows whose parent_user_id is the owner) and the array is the full
--                                          owner set at write time.
-- The table CHECKs refuse the rest (currency, capital_model, version 1 to 1000, bot_set shape, effective_from on a UTC midnight, declared_at range).
-- Insert guards never need UPDATE privilege and take no lock: they read users and the earlier versions through the writer's SERIALIZABLE snapshot.
-- A concurrent createBot that commits after that snapshot is NOT detected here (one read-write dependency is a valid serial order); the later PUT
-- slice closes that window with a lock on the owner row before it reads the owner set, and the application retries 40001 from the start.
-- Why effective_from is never before its own stamp: every row has effective_from >= declared_at (database clock) and effective_from never
-- decreases, so a new row only adds or replaces instants at or after its own stamp. The stamp is taken at insert, the commit comes later: a row
-- stamped 23:59:59 and committed 00:00:30 applies from 00:00 but is visible from its commit only. A reader therefore treats a range end just
-- after the latest midnight as provisional, and the writer keeps its transaction short. A pending row may be superseded by a later row with
-- the same effective_from.
-- Restore and replication limits: a full pg_restore works (data loads before the post-data triggers, so rows and declared_at come back unchanged).
-- A data-only restore into an installed table replays the triggers: the stamp overwrites declared_at with the restore time, the version guard
-- refuses rows out of order and QR003 fires (COPY runs at READ COMMITTED). A data-only restore is unsupported: with --disable-triggers (superuser)
-- pg_restore re-enables the triggers origin-only, so the classifier reports OTHER (TRIGGER_NOT_ALWAYS); the repair is ALTER TABLE ... ENABLE ALWAYS
-- TRIGGER for each guard, then --inspect. Logical replication of this table is not supported without a design change.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like a users or
-- extension object can never be used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- Dependency: the foreign keys name users, so users cannot be dropped while this extension is installed. Requires the base schema 14 and users only.
-- This file is not idempotent by itself: src/postgres/paper-capital-model-migration.js classifies the live catalog first and runs it only over ABSENT.
-- Rollback: src/postgres/paper-capital-model-rollback.sql drops exactly the objects created here; the migration tool runs it at zero rows, or with
-- rows only after the live row count and the canonical export digest match the owner's confirmation (O12).

CREATE TABLE public.paper_capital_model_schema(
 version INTEGER NOT NULL,
 CONSTRAINT paper_capital_model_schema_pkey PRIMARY KEY(version),
 CONSTRAINT paper_capital_model_schema_version_check CHECK(version=1)
);
INSERT INTO public.paper_capital_model_schema VALUES(1);

CREATE TABLE public.paper_capital_models(
 owner_id TEXT NOT NULL,
 currency TEXT NOT NULL,
 version BIGINT NOT NULL,
 capital_model TEXT NOT NULL,
 bot_set JSONB NOT NULL,
 effective_from BIGINT NOT NULL,
 declared_at BIGINT NOT NULL,
 declared_by TEXT NOT NULL,
 CONSTRAINT paper_capital_models_pkey PRIMARY KEY(owner_id,currency,version),
 CONSTRAINT paper_capital_models_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT paper_capital_models_declared_by_fkey FOREIGN KEY(declared_by) REFERENCES public.users(id),
 CONSTRAINT paper_capital_models_currency_check CHECK(currency IN ('USDT','THB')),
 CONSTRAINT paper_capital_models_version_check CHECK(version>=1 AND version<=1000),
 CONSTRAINT paper_capital_models_capital_model_check CHECK(capital_model IN ('INDEPENDENT_ACCOUNTS','SHARED_HYPOTHETICAL')),
 CONSTRAINT paper_capital_models_bot_set_check CHECK(CASE WHEN pg_catalog.jsonb_typeof(bot_set)='array'
  THEN pg_catalog.jsonb_array_length(bot_set)>=1 AND pg_catalog.jsonb_array_length(bot_set)<=5 ELSE false END),
 CONSTRAINT paper_capital_models_effective_from_check CHECK(effective_from>=0 AND effective_from<=253402300799999 AND effective_from%86400000=0),
 CONSTRAINT paper_capital_models_declared_at_check CHECK(declared_at>=0 AND declared_at<=253402300799999)
);

CREATE FUNCTION public.paper_capital_model_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'paper-capital-model-v1'::text $fn$;

-- The database clock in epoch milliseconds. VOLATILE (clock_timestamp), so the planner never caches it.
CREATE FUNCTION public.paper_capital_model_now_ms() RETURNS BIGINT
 LANGUAGE sql SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) * 1000)::bigint $fn$;

CREATE FUNCTION public.paper_capital_model_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Paper capital model declarations are insert-only' USING ERRCODE = 'QR002';
END $fn$;

CREATE FUNCTION public.paper_capital_model_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Paper capital model writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.paper_capital_model_stamp() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 NEW.declared_at := public.paper_capital_model_now_ms();
 RETURN NEW;
END $fn$;

-- The declaration insert guard (QR004). A NULL in a required column is left to the NOT NULL constraint, which refuses the row right after the triggers.
CREATE FUNCTION public.paper_capital_model_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE owner_row RECORD; previous RECORD; has_previous BOOLEAN; expected_version BIGINT; owner_count INTEGER;
BEGIN
 IF NEW.owner_id IS NULL OR NEW.currency IS NULL OR NEW.version IS NULL OR NEW.bot_set IS NULL OR NEW.effective_from IS NULL OR NEW.declared_by IS NULL THEN
  RETURN NEW;
 END IF;
 -- owner
 SELECT u.parent_user_id INTO owner_row FROM public.users u WHERE u.id = NEW.owner_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'The owner must be an existing main account' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_owner';
 END IF;
 IF owner_row.parent_user_id IS NOT NULL THEN
  RAISE EXCEPTION 'A child Bot cannot be the owner of a capital model declaration' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_owner';
 END IF;
 IF NEW.declared_by IS DISTINCT FROM NEW.owner_id THEN
  RAISE EXCEPTION 'declared_by must be the owner' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_owner';
 END IF;
 -- version
 SELECT p.version, p.effective_from, p.declared_at INTO previous FROM public.paper_capital_models p
  WHERE p.owner_id = NEW.owner_id AND p.currency = NEW.currency ORDER BY p.version DESC LIMIT 1;
 has_previous := FOUND;
 IF has_previous THEN expected_version := previous.version + 1; ELSE expected_version := 1; END IF;
 IF NEW.version IS DISTINCT FROM expected_version THEN
  RAISE EXCEPTION 'The version must follow the highest earlier version of the owner and currency without a gap' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_version';
 END IF;
 -- clock
 IF NEW.effective_from < NEW.declared_at THEN
  RAISE EXCEPTION 'effective_from cannot be before the database stamp' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_clock';
 END IF;
 IF NEW.effective_from > NEW.declared_at + 86400000 THEN
  RAISE EXCEPTION 'effective_from can be at most one day after the database stamp' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_clock';
 END IF;
 IF has_previous AND NEW.effective_from < previous.effective_from THEN
  RAISE EXCEPTION 'effective_from cannot be before the previous version' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_clock';
 END IF;
 IF has_previous AND NEW.declared_at < previous.declared_at THEN
  RAISE EXCEPTION 'The database stamp cannot be before the previous version stamp' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_clock';
 END IF;
 -- bot_set: shape, strings, strictly ascending, inside the owner set, the full owner set
 IF pg_catalog.jsonb_typeof(NEW.bot_set) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'bot_set must be an array of 1 to 5 Bot ids' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_bot_set';
 END IF;
 IF pg_catalog.jsonb_array_length(NEW.bot_set) < 1 OR pg_catalog.jsonb_array_length(NEW.bot_set) > 5 THEN
  RAISE EXCEPTION 'bot_set must be an array of 1 to 5 Bot ids' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_bot_set';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(NEW.bot_set) AS e(item) WHERE pg_catalog.jsonb_typeof(e.item) IS DISTINCT FROM 'string') THEN
  RAISE EXCEPTION 'Every bot_set element must be a string' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_bot_set';
 END IF;
 IF EXISTS (SELECT 1 FROM (SELECT t.id, pg_catalog.lag(t.id) OVER (ORDER BY t.ord) AS previous_id
     FROM pg_catalog.jsonb_array_elements_text(NEW.bot_set) WITH ORDINALITY AS t(id, ord)) s
   WHERE s.previous_id IS NOT NULL AND s.id COLLATE "C" <= s.previous_id COLLATE "C") THEN
  RAISE EXCEPTION 'bot_set must be strictly ascending' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_bot_set';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(NEW.bot_set) AS t(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = t.id AND (u.id = NEW.owner_id OR u.parent_user_id = NEW.owner_id))) THEN
  RAISE EXCEPTION 'Every bot_set id must belong to the owner set' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_bot_set';
 END IF;
 SELECT pg_catalog.count(*)::integer INTO owner_count FROM public.users u WHERE u.id = NEW.owner_id OR u.parent_user_id = NEW.owner_id;
 IF pg_catalog.jsonb_array_length(NEW.bot_set) IS DISTINCT FROM owner_count THEN
  RAISE EXCEPTION 'bot_set must be the full owner set' USING ERRCODE = 'QR004', CONSTRAINT = 'paper_capital_models_bot_set';
 END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER paper_capital_model_schema_no_change BEFORE UPDATE OR DELETE ON public.paper_capital_model_schema FOR EACH ROW EXECUTE FUNCTION public.paper_capital_model_freeze();
CREATE TRIGGER paper_capital_model_schema_no_truncate BEFORE TRUNCATE ON public.paper_capital_model_schema FOR EACH STATEMENT EXECUTE FUNCTION public.paper_capital_model_freeze();
CREATE TRIGGER paper_capital_models_no_change BEFORE UPDATE OR DELETE ON public.paper_capital_models FOR EACH ROW EXECUTE FUNCTION public.paper_capital_model_freeze();
CREATE TRIGGER paper_capital_models_no_truncate BEFORE TRUNCATE ON public.paper_capital_models FOR EACH STATEMENT EXECUTE FUNCTION public.paper_capital_model_freeze();
CREATE TRIGGER paper_capital_models_00_serializable BEFORE INSERT ON public.paper_capital_models FOR EACH ROW EXECUTE FUNCTION public.paper_capital_model_require_serializable();
CREATE TRIGGER paper_capital_models_10_stamp BEFORE INSERT ON public.paper_capital_models FOR EACH ROW EXECUTE FUNCTION public.paper_capital_model_stamp();
CREATE TRIGGER paper_capital_models_20_guard BEFORE INSERT ON public.paper_capital_models FOR EACH ROW EXECUTE FUNCTION public.paper_capital_model_guard();

ALTER TABLE public.paper_capital_model_schema ENABLE ALWAYS TRIGGER paper_capital_model_schema_no_change;
ALTER TABLE public.paper_capital_model_schema ENABLE ALWAYS TRIGGER paper_capital_model_schema_no_truncate;
ALTER TABLE public.paper_capital_models ENABLE ALWAYS TRIGGER paper_capital_models_no_change;
ALTER TABLE public.paper_capital_models ENABLE ALWAYS TRIGGER paper_capital_models_no_truncate;
ALTER TABLE public.paper_capital_models ENABLE ALWAYS TRIGGER paper_capital_models_00_serializable;
ALTER TABLE public.paper_capital_models ENABLE ALWAYS TRIGGER paper_capital_models_10_stamp;
ALTER TABLE public.paper_capital_models ENABLE ALWAYS TRIGGER paper_capital_models_20_guard;
