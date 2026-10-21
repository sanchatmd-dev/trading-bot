-- Rollback of src/postgres/mp-run-store.sql. Drops only the objects that file creates (their triggers, indexes and constraints go with the tables).
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED and counted zero rows in both record tables
-- (runs and events are never dropped by this file; see mp-run-store-migration.js). Run this extension's rollback before the member-set rollback.
DROP TABLE public.mp_research_run_events;
DROP TABLE public.mp_research_runs;
DROP TABLE public.mp_run_store_schema;
DROP FUNCTION public.mp_run_store_guard_transition();
DROP FUNCTION public.mp_run_store_guard_result();
DROP FUNCTION public.mp_run_store_guard_order();
DROP FUNCTION public.mp_run_store_guard_complete();
DROP FUNCTION public.mp_run_store_guard_stale();
DROP FUNCTION public.mp_run_store_guard_run();
DROP FUNCTION public.mp_run_store_require_serializable();
DROP FUNCTION public.mp_run_store_freeze();
DROP FUNCTION public.mp_run_store_version();
