-- Rollback of src/postgres/quant-selection.sql. Drops only the objects that file creates (their triggers, indexes and constraints go with the tables).
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED, counted zero rows in every selection table and found no
-- QR4_SELECTION row in the exposure register (selection evidence is never dropped by this file; see quant-selection-migration.js).
DROP TABLE public.quant_selection_replay_events;
DROP TABLE public.quant_selection_outcomes;
DROP TABLE public.quant_selection_evaluation_starts;
DROP TABLE public.quant_selection_window_freezes;
DROP TABLE public.quant_selection_status_events;
DROP TABLE public.quant_selection_participants;
DROP TABLE public.quant_selection_universe;
DROP TABLE public.quant_selection_registrations;
DROP TABLE public.quant_selection_schema;
DROP FUNCTION public.quant_selection_check_outcome_complete();
DROP FUNCTION public.quant_selection_check_first_start_complete();
DROP FUNCTION public.quant_selection_guard_replay();
DROP FUNCTION public.quant_selection_guard_outcome();
DROP FUNCTION public.quant_selection_guard_start();
DROP FUNCTION public.quant_selection_guard_freeze();
DROP FUNCTION public.quant_selection_stamp_outcome();
DROP FUNCTION public.quant_selection_stamp_start();
DROP FUNCTION public.quant_selection_stamp_freeze();
DROP FUNCTION public.quant_selection_check_registration_complete();
DROP FUNCTION public.quant_selection_guard_status_event();
DROP FUNCTION public.quant_selection_guard_participant();
DROP FUNCTION public.quant_selection_guard_universe();
DROP FUNCTION public.quant_selection_guard_registration();
DROP FUNCTION public.quant_selection_stamp_event();
DROP FUNCTION public.quant_selection_stamp_registration();
DROP FUNCTION public.quant_selection_require_serializable();
DROP FUNCTION public.quant_selection_insert_only();
DROP FUNCTION public.quant_selection_transitions();
DROP FUNCTION public.quant_selection_in_this_transaction(xid);
DROP FUNCTION public.quant_selection_now_ms();
DROP FUNCTION public.quant_selection_version();
