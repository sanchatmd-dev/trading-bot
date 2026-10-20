-- Rollback of src/postgres/quant-comparison.sql. Drops only the objects that file creates (their triggers, indexes and constraints go with the tables).
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED and counted zero rows in every comparison table
-- (comparison evidence is never dropped by this file, and the exposure register is never touched by it; see quant-comparison-migration.js).
DROP TABLE public.quant_comparison_replay_events;
DROP TABLE public.quant_comparison_outcomes;
DROP TABLE public.quant_comparison_benchmarks;
DROP TABLE public.quant_comparison_evaluations;
DROP TABLE public.quant_comparison_status_events;
DROP TABLE public.quant_comparison_participants;
DROP TABLE public.quant_comparison_specs;
DROP TABLE public.quant_comparison_schema;
DROP FUNCTION public.quant_comparison_check_outcome();
DROP FUNCTION public.quant_comparison_check_create();
DROP FUNCTION public.quant_comparison_guard_replay_event();
DROP FUNCTION public.quant_comparison_guard_outcome();
DROP FUNCTION public.quant_comparison_guard_benchmark();
DROP FUNCTION public.quant_comparison_guard_evaluation();
DROP FUNCTION public.quant_comparison_guard_status_event();
DROP FUNCTION public.quant_comparison_guard_participant();
DROP FUNCTION public.quant_comparison_guard_spec();
DROP FUNCTION public.quant_comparison_require_serializable();
DROP FUNCTION public.quant_comparison_insert_only();
DROP FUNCTION public.quant_comparison_in_this_transaction(xid);
DROP FUNCTION public.quant_comparison_version();
