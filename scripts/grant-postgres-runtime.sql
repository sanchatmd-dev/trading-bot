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
-- Reapply after future migrations; do not grant DDL or automatic ownership.
