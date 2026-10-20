-- Rollback of src/postgres/best-inputs-package-schema.sql. Drops only the objects that file creates (their triggers, indexes and constraints go with the tables).
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED and counted zero rows in every package table
-- (package evidence is never dropped by this file; see best-inputs-package-migration.js).
DROP TABLE public.ql4c_validation;
DROP TABLE public.bi_status_events;
DROP TABLE public.bi_attempts;
DROP TABLE public.bi_trace_reproductions;
DROP TABLE public.bi_clearances;
DROP TABLE public.bi_evidence_records;
DROP TABLE public.bi_compile_records;
DROP TABLE public.bi_package_files;
DROP TABLE public.bi_exports;
DROP TABLE public.bi_blobs;
DROP TABLE public.bi_package_schema;
DROP FUNCTION public.bi_guard_clearance();
DROP FUNCTION public.bi_guard_candidate_record();
DROP FUNCTION public.bi_guard_validation();
DROP FUNCTION public.bi_guard_attempt();
DROP FUNCTION public.bi_guard_status_event();
DROP FUNCTION public.bi_guard_package_file();
DROP FUNCTION public.bi_guard_export_complete();
DROP FUNCTION public.bi_guard_export();
DROP FUNCTION public.bi_latest_status(UUID);
DROP FUNCTION public.bi_lock_export(UUID);
DROP FUNCTION public.bi_freeze();
DROP FUNCTION public.bi_require_serializable();
DROP FUNCTION public.bi_retryable_codes();
DROP FUNCTION public.bi_package_version();
