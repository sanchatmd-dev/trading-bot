-- Rollback of src/postgres/mp-package-store.sql. Drops only the objects that file creates (their triggers, indexes and constraints go with the tables).
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED and counted zero rows in every record table
-- (records are never dropped by this file; see mp-package-store-migration.js). The package store holds no foreign key onto the run store or the member-set store,
-- so their rollbacks are not blocked by it; roll this extension back first all the same.
DROP TABLE public.mp_package_status_events;
DROP TABLE public.mp_package_validations;
DROP TABLE public.mp_package_trace_records;
DROP TABLE public.mp_package_clearances;
DROP TABLE public.mp_package_evidence_records;
DROP TABLE public.mp_package_compile_records;
DROP TABLE public.mp_package_attempts;
DROP TABLE public.mp_package_files;
DROP TABLE public.mp_package_exports;
DROP TABLE public.mp_package_blobs;
DROP TABLE public.mp_package_store_schema;
DROP FUNCTION public.mp_package_store_guard_trace();
DROP FUNCTION public.mp_package_store_guard_clearance();
DROP FUNCTION public.mp_package_store_guard_evidence();
DROP FUNCTION public.mp_package_store_guard_compile();
DROP FUNCTION public.mp_package_store_guard_validation();
DROP FUNCTION public.mp_package_store_guard_attempt();
DROP FUNCTION public.mp_package_store_guard_status();
DROP FUNCTION public.mp_package_store_guard_file();
DROP FUNCTION public.mp_package_store_guard_export_complete();
DROP FUNCTION public.mp_package_store_guard_export();
DROP FUNCTION public.mp_package_store_require_candidate(UUID, TEXT);
DROP FUNCTION public.mp_package_store_latest_status(UUID);
DROP FUNCTION public.mp_package_store_lock_export(UUID);
DROP FUNCTION public.mp_package_store_require_serializable();
DROP FUNCTION public.mp_package_store_freeze();
DROP FUNCTION public.mp_package_store_retryable_codes();
DROP FUNCTION public.mp_package_store_version();
