-- Rollback of src/postgres/mp-member-set.sql. Drops only the objects that file creates (their triggers, indexes and constraints go with the tables).
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED and counted zero rows in both record tables
-- (member sets are never dropped by this file; see mp-member-set-migration.js).
DROP TABLE public.mp_member_set_members;
DROP TABLE public.mp_member_sets;
DROP TABLE public.mp_member_set_schema;
DROP FUNCTION public.mp_guard_set_complete();
DROP FUNCTION public.mp_guard_member();
DROP FUNCTION public.mp_require_serializable();
DROP FUNCTION public.mp_freeze();
DROP FUNCTION public.mp_member_set_version();
