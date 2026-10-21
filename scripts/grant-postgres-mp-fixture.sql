-- Fixture grants for the internal multi-Pine run store (F11-01 RS-1, grant model B2, root decision S4). ISOLATED LOCAL CLUSTERS ONLY: never run this on staging or
-- production. The run store is never installed there before APP-3B (owner item O1), and this script exists only so tests and an operator fixture script can
-- read and write the run-store tables that the runtime role must never reach. Run as the schema owner AFTER src/postgres/mp-run-store.sql was installed and AFTER
-- scripts/grant-postgres-runtime.sql:
--   psql -v ON_ERROR_STOP=1 -v runtime_role=<runtime role> -v fixture_role=<fixture role> -f scripts/grant-postgres-mp-fixture.sql
-- Both variables are required and have no default. Both roles must exist: this script creates no role and no other object. Create the fixture role separately as
-- LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT; set its password with psql \password.
-- It grants exactly this and nothing else:
--   * membership of the fixture role in the runtime role, so the fixture role reads the Pine tables, writes the member-set tables and takes FOR SHARE locks
--     like the runtime does (the runtime role never becomes a member of the fixture role: the run store stays invisible to it);
--   * SELECT and INSERT on mp_research_runs and mp_research_run_events (insert-only evidence: no UPDATE, DELETE, TRUNCATE, TRIGGER or REFERENCES);
--   * SELECT on mp_run_store_schema (the marker is written only by the installer).
-- The script is one transaction. It first takes the product's exclusive maintenance lock (robot:maintenance) and fails at once while any API or worker holds its
-- shared lock. It refuses unless the run-store marker exists, and the final state is checked, not assumed: the runtime role must reach no privilege on any run-store
-- table and must not reach the fixture role, and the fixture role must hold SELECT and INSERT on the records, SELECT on the marker, nothing that edits or removes
-- a row, and no ownership. Any failure rolls everything back.
BEGIN;
SELECT set_config('robot.runtime_role',:'runtime_role',true) AS runtime_role;
SELECT set_config('robot.fixture_role',:'fixture_role',true) AS fixture_role;
DO $$
DECLARE
  runtime_role CONSTANT TEXT := current_setting('robot.runtime_role');
  fixture_role CONSTANT TEXT := current_setting('robot.fixture_role');
  marker CONSTANT TEXT := 'mp_run_store_schema';
  records CONSTANT TEXT[] := ARRAY['mp_research_runs','mp_research_run_events'];
  item TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0)) THEN
    RAISE EXCEPTION 'Stop every PostgreSQL API and worker before maintenance';
  END IF;
  -- Exact name match: to_regrole would case-fold an unquoted name, while the grants below quote it with %I.
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
    RAISE EXCEPTION 'Runtime role % does not exist',runtime_role;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=fixture_role) THEN
    RAISE EXCEPTION 'Fixture role % does not exist',fixture_role;
  END IF;
  IF runtime_role = fixture_role THEN
    RAISE EXCEPTION 'The fixture role must differ from the runtime role';
  END IF;
  IF to_regclass(format('public.%I',marker)) IS NULL OR to_regclass('public.mp_research_runs') IS NULL OR to_regclass('public.mp_research_run_events') IS NULL THEN
    RAISE EXCEPTION 'The multi-Pine run store is not installed (marker mp_run_store_schema missing)';
  END IF;
  -- A separate statement: the marker table is planned only once it is known to exist.
  IF NOT EXISTS(SELECT 1 FROM public.mp_run_store_schema WHERE version=1) THEN
    RAISE EXCEPTION 'The multi-Pine run store is not installed (marker row missing)';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=fixture_role AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'Fixture role % must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION',fixture_role;
  END IF;
  -- Refuse before any grant: the runtime role may not already be the fixture role or a member of it (directly or through other roles).
  IF pg_has_role(runtime_role,fixture_role,'MEMBER') THEN
    RAISE EXCEPTION 'Runtime role % can reach fixture role %',runtime_role,fixture_role;
  END IF;
  EXECUTE format('GRANT %I TO %I',runtime_role,fixture_role);
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES ON TABLE public.%I FROM %I',marker,fixture_role);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I',marker,fixture_role);
  FOREACH item IN ARRAY records LOOP
    -- Remove what an earlier grant left behind, so the result does not depend on the database's history.
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES ON TABLE public.%I FROM %I',item,fixture_role);
    EXECUTE format('GRANT SELECT,INSERT ON TABLE public.%I TO %I',item,fixture_role);
  END LOOP;
  -- The final state is checked, not assumed.
  IF pg_has_role(runtime_role,fixture_role,'MEMBER') THEN
    RAISE EXCEPTION 'Runtime role % can reach fixture role %',runtime_role,fixture_role;
  END IF;
  IF NOT pg_has_role(fixture_role,runtime_role,'USAGE') THEN
    RAISE EXCEPTION 'Fixture role % does not inherit the privileges of runtime role %',fixture_role,runtime_role;
  END IF;
  FOREACH item IN ARRAY records || marker LOOP
    -- The runtime role reaches no privilege of any kind (PUBLIC grants and column grants included; every role it can reach by membership counts).
    IF EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(runtime_role,r.oid,'MEMBER')
          AND (has_any_column_privilege(r.oid,format('public.%I',item),'SELECT')
            OR has_any_column_privilege(r.oid,format('public.%I',item),'INSERT')
            OR has_any_column_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_any_column_privilege(r.oid,format('public.%I',item),'REFERENCES')
            OR has_table_privilege(r.oid,format('public.%I',item),'SELECT')
            OR has_table_privilege(r.oid,format('public.%I',item),'INSERT')
            OR has_table_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'DELETE')
            OR has_table_privilege(r.oid,format('public.%I',item),'TRUNCATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'REFERENCES')
            OR has_table_privilege(r.oid,format('public.%I',item),'TRIGGER'))) THEN
      RAISE EXCEPTION 'Runtime role % can still reach internal table %; apply scripts/grant-postgres-runtime.sql first',runtime_role,item;
    END IF;
    -- The fixture role owns no run-store table and, through itself or any reached role, edits or removes no row.
    IF pg_has_role(fixture_role,(SELECT relowner FROM pg_class WHERE oid=to_regclass(format('public.%I',item))),'MEMBER') THEN
      RAISE EXCEPTION 'Fixture role % owns %',fixture_role,item;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(fixture_role,r.oid,'MEMBER')
          AND (has_any_column_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_any_column_privilege(r.oid,format('public.%I',item),'REFERENCES')
            OR has_table_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'DELETE')
            OR has_table_privilege(r.oid,format('public.%I',item),'TRUNCATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'REFERENCES')
            OR has_table_privilege(r.oid,format('public.%I',item),'TRIGGER'))) THEN
      RAISE EXCEPTION 'Fixture role % can still edit or remove rows of %',fixture_role,item;
    END IF;
    IF NOT has_table_privilege(fixture_role,format('public.%I',item),'SELECT') THEN
      RAISE EXCEPTION 'Fixture role % lacks SELECT on %',fixture_role,item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY records LOOP
    IF NOT has_table_privilege(fixture_role,format('public.%I',item),'INSERT') THEN
      RAISE EXCEPTION 'Fixture role % lacks INSERT on %',fixture_role,item;
    END IF;
  END LOOP;
  IF has_table_privilege(fixture_role,format('public.%I',marker),'INSERT') THEN
    RAISE EXCEPTION 'Fixture role % can still write to %',fixture_role,marker;
  END IF;
END $$;
COMMIT;
-- Reapply after future migrations; it changes nothing the second time.
