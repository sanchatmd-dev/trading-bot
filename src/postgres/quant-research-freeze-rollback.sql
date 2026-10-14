-- Rollback of src/postgres/quant-research-freeze.sql. Drops only the objects that file creates; no data is read or changed.
-- Function drops carry no CASCADE: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
DO $do$
BEGIN
 IF to_regclass('public.quant_research_chunks') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS quant_research_chunk_terminal_freeze ON public.quant_research_chunks;
  DROP TRIGGER IF EXISTS quant_research_chunk_terminal_insert ON public.quant_research_chunks;
 END IF;
 IF to_regclass('public.quant_research_foundation') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS quant_research_binding_terminal_insert ON public.quant_research_foundation;
 END IF;
 IF to_regclass('public.quant_job_steps') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS quant_job_step_terminal_insert ON public.quant_job_steps;
 END IF;
 IF to_regclass('public.quant_jobs') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS quant_job_terminal_no_delete ON public.quant_jobs;
  DROP TRIGGER IF EXISTS quant_job_terminal_freeze ON public.quant_jobs;
 END IF;
END $do$;
DROP FUNCTION IF EXISTS public.quant_research_freeze_chunk_change();
DROP FUNCTION IF EXISTS public.quant_research_freeze_step_insert();
DROP FUNCTION IF EXISTS public.quant_research_freeze_job_delete();
DROP FUNCTION IF EXISTS public.quant_research_freeze_job_update();
DROP FUNCTION IF EXISTS public.quant_research_status_is_terminal(TEXT);
DROP FUNCTION IF EXISTS public.quant_research_freeze_version();
