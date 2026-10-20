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
  -- The same holds for quant_exposure_register: its UPDATE only carries the writer LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE;
  -- a database trigger refuses every row UPDATE (QR002). It is insert-only evidence, so the runtime never gets DELETE.
  -- Accepted residual risk (root ruling 2026-10-20): that UPDATE also allows LOCK TABLE ... ACCESS EXCLUSIVE, bounded by the statement and
  -- idle-in-transaction timeouts, as for the scheduler.
  -- The Best Inputs package record tables (F09 builder slice S2, optional extension) are insert-only evidence: the runtime keeps SELECT and
  -- INSERT and loses UPDATE and DELETE (and holds no TRUNCATE or TRIGGER); database triggers refuse an edit by any other role (QR002).
  -- The same holds for the quant comparison (QR-3), quant selection (QR-4) and member set (F11) record tables below: optional extensions,
  -- only installed tables are touched (the selection tables beyond the first four, and the later comparison tables, appear in later slices).
  protected CONSTANT TEXT[] := ARRAY['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler',
    'quant_jobs','quant_research_chunks','quant_io_ledgers','quant_io_launches',
    'quant_profile_enrollment_receipts','quant_storage_namespace','quant_research_executor_mode','quant_exposure_register'];
  -- Versions and provenance the runtime validates but never rewrites (the Pine tables exist only with the extension).
  read_only CONSTANT TEXT[] := ARRAY['schema_version','pine_bridge_schema','pine_bridge_evidence','pine_market_bars',
    'pine_capture_schema','quant_exposure_register_schema','bi_package_schema','quant_comparison_schema','quant_selection_schema',
    'mp_member_set_schema'];
  insert_only CONSTANT TEXT[] := ARRAY['bi_exports','bi_package_files','bi_blobs','bi_status_events','bi_attempts','bi_compile_records',
    'bi_evidence_records','bi_clearances','bi_trace_reproductions','ql4c_validation',
    'quant_comparison_specs','quant_comparison_participants','quant_comparison_status_events','quant_comparison_evaluations','quant_comparison_benchmarks',
    'quant_comparison_outcomes','quant_comparison_replay_events',
    'quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events',
    'quant_selection_window_freezes','quant_selection_evaluation_starts','quant_selection_outcomes','quant_selection_replay_events',
    'mp_member_sets','mp_member_set_members'];
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
      AND tablename<>ALL(protected) AND tablename<>ALL(read_only) AND tablename<>ALL(insert_only) ORDER BY tablename LOOP
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
  FOREACH item IN ARRAY insert_only LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON TABLE public.%I FROM %I',item,runtime_role);
    END IF;
  END LOOP;
  -- The final state is checked, not assumed: any remaining DELETE on a protected table, or any write privilege on a
  -- read-only table, rolls everything back. For a read-only table the check covers PUBLIC and every role the runtime role can reach by
  -- membership (SET ROLE; INHERIT FALSE and NOINHERIT included), and INSERT or UPDATE held on a single column counts too.
  FOREACH item IN ARRAY protected LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL
        AND has_table_privilege(runtime_role,format('public.%I',item),'DELETE') THEN
      RAISE EXCEPTION 'Runtime role % can still DELETE from %',runtime_role,item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY read_only LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL
        AND EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(runtime_role,r.oid,'MEMBER')
          AND (has_any_column_privilege(r.oid,format('public.%I',item),'INSERT')
            OR has_any_column_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'INSERT')
            OR has_table_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'DELETE'))) THEN
      RAISE EXCEPTION 'Runtime role % can still write to %',runtime_role,item;
    END IF;
  END LOOP;
  -- Insert-only tables: SELECT and INSERT stay, nothing that edits or removes a row. The check covers PUBLIC and every role the runtime role
  -- can reach by membership (SET ROLE), INHERIT FALSE and NOINHERIT included: has_table_privilege(runtime_role,...) alone ignores those.
  -- UPDATE also counts on a single column (has_any_column_privilege), which has_table_privilege does not see.
  FOREACH item IN ARRAY insert_only LOOP
    IF to_regclass(format('public.%I',item)) IS NOT NULL
        AND EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(runtime_role,r.oid,'MEMBER')
          AND (has_any_column_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'UPDATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'DELETE')
            OR has_table_privilege(r.oid,format('public.%I',item),'TRUNCATE')
            OR has_table_privilege(r.oid,format('public.%I',item),'TRIGGER'))) THEN
      RAISE EXCEPTION 'Runtime role % can still edit or remove rows of %',runtime_role,item;
    END IF;
    IF to_regclass(format('public.%I',item)) IS NOT NULL
        AND NOT (has_table_privilege(runtime_role,format('public.%I',item),'SELECT')
          AND has_table_privilege(runtime_role,format('public.%I',item),'INSERT')) THEN
      RAISE EXCEPTION 'Runtime role % lacks SELECT or INSERT on %',runtime_role,item;
    END IF;
  END LOOP;
END $$;
COMMIT;
-- Reapply after future migrations; do not grant DDL or automatic ownership.