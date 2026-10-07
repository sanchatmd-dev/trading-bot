-- Run as the schema owner AFTER migration/import. Create robot_app separately
-- as LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; set its password with psql \password.
-- DATABASE_URL for API and worker must use robot_app, not the migration owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO robot_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO robot_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO robot_app;
-- Runtime validates schema but must never rewrite its version or provenance.
REVOKE INSERT,UPDATE,DELETE ON schema_version FROM robot_app;
-- If the optional Pine Bridge extension is installed, protect its version too.
DO $$ BEGIN
  IF to_regclass('public.pine_bridge_schema') IS NOT NULL THEN
    REVOKE INSERT,UPDATE,DELETE ON pine_bridge_schema FROM robot_app;
    REVOKE INSERT,UPDATE,DELETE ON pine_bridge_evidence,pine_market_bars FROM robot_app;
  END IF;
  IF to_regclass('public.pine_capture_schema') IS NOT NULL THEN
    REVOKE INSERT,UPDATE,DELETE ON pine_capture_schema FROM robot_app;
  END IF;
END $$;
-- PF-2 quarantine, accounting and provenance rows must survive runtime actions. These extensions are optional,
-- so revoke only for installed tables. Keep SELECT, INSERT and table-level UPDATE: in particular, UPDATE on
-- quant_foundation_scheduler is required by LOCK TABLE ... IN EXCLUSIVE MODE during enrollment completion.
DO $$ DECLARE protected_table TEXT;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler',
    'quant_jobs','quant_research_chunks','quant_io_ledgers','quant_io_launches',
    'quant_profile_enrollment_receipts','quant_storage_namespace','quant_research_executor_mode'
  ] LOOP
    IF to_regclass(format('public.%I',protected_table)) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM robot_app',protected_table);
    END IF;
  END LOOP;
END $$;
-- Reapply after future migrations; do not grant DDL or automatic ownership.
