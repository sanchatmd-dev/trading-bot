-- Runtime grants for the PostgreSQL API and workers. Run as the schema owner AFTER migration/import:
--   psql -v ON_ERROR_STOP=1 -v runtime_role=<runtime role> -f scripts/grant-postgres-runtime.sql
-- runtime_role is required and has no default: without it the first statement fails and nothing changes.
-- Create the runtime role separately as LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; set its password with psql \password.
-- DATABASE_URL for the API and workers must use that role, not the migration owner.
-- The script is one transaction. It first takes the product's exclusive maintenance lock (robot:maintenance, the
-- lock of migration, restore and key rotation) and fails at once while any API or worker holds its shared lock.
-- Rollback caveat: copies of this script from before the PF-2 revoke grant DELETE on every table. Reapplying such a
-- copy re-grants DELETE on the protected tables below, so a rollback must reapply this script afterwards.
BEGIN;
SELECT set_config('robot.runtime_role',:'runtime_role',true) AS runtime_role;
DO $$
DECLARE
  runtime_role CONSTANT TEXT := current_setting('robot.runtime_role');
  -- PF-2 quarantine, accounting and provenance rows must survive runtime actions. These extensions are optional,
  -- so only installed tables are touched. SELECT, INSERT and table-level UPDATE stay: in particular, UPDATE on
  -- quant_foundation_scheduler carries LOCK TABLE ... IN EXCLUSIVE MODE during enrollment completion.
  protected CONSTANT TEXT[] := ARRAY['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler',
    'quant_jobs','quant_research_chunks','quant_io_ledgers','quant_io_launches',
    'quant_profile_enrollment_receipts','quant_storage_namespace','quant_research_executor_mode'];
  -- Versions and provenance the runtime validates but never rewrites (the Pine tables exist only with the extension).
  read_only CONSTANT TEXT[] := ARRAY['schema_version','pine_bridge_schema','pine_bridge_evidence','pine_market_bars',
    'pine_capture_schema'];
  item TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0)) THEN
    RAISE EXCEPTION 'Stop every PostgreSQL API and worker before maintenance';
  END IF;
  -- Exact name match: to_regrole would case-fold an unquoted name, while the grants below quote it with %I.
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
    RAISE EXCEPTION 'Runtime role % does not exist',runtime_role;
  END IF;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',runtime_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO %I',runtime_role);
  EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',runtime_role);
  -- DELETE only where the runtime may delete; this script never grants it on a protected or read-only table.
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename<>ALL(protected) AND tablename<>ALL(read_only) ORDER BY tablename LOOP
    EXECUTE format('GRANT DELETE ON TABLE public.%I TO %I',item,runtime_role);
  END LOOP;
  -- Remove what an earlier grant left behind, so the result does not depend on the database's history.
  FOREACH item IN ARRAY protected LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM %I',item,runtime_role);
    END IF;
  END LOOP;
  FOREACH item IN ARRAY read_only LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON TABLE public.%I FROM %I',item,runtime_role);
    END IF;
  END LOOP;
  -- The final state is checked, not assumed: any remaining DELETE on a protected table, or any write privilege on a
  -- read-only table (including one held through PUBLIC or an inherited role), rolls everything back.
  FOREACH item IN ARRAY protected LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL
        AND has_table_privilege(runtime_role,format('public.%I',item),'DELETE') THEN
      RAISE EXCEPTION 'Runtime role % can still DELETE from %',runtime_role,item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY read_only LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL
        AND (has_table_privilege(runtime_role,format('public.%I',item),'INSERT')
          OR has_table_privilege(runtime_role,format('public.%I',item),'UPDATE')
          OR has_table_privilege(runtime_role,format('public.%I',item),'DELETE')) THEN
      RAISE EXCEPTION 'Runtime role % can still write to %',runtime_role,item;
    END IF;
  END LOOP;
END $$;
COMMIT;
-- Reapply after future migrations; do not grant DDL or automatic ownership.