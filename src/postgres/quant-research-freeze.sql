-- QR-1b terminal-result freeze (local candidate; applied offline and separately from the version-1 extensions).
-- Database triggers refuse edits of terminal research results for any role that cannot disable triggers.
-- Every function is SECURITY INVOKER, schema-qualifies each relation and pins search_path, so a session TEMP table
-- named like a research table can never be read in its place. Guards raise SQLSTATE QR001.
-- Idempotent: every statement converges. Guards on the FOUNDATION tables are installed only where those tables exist.
-- Rollback: src/postgres/quant-research-freeze-rollback.sql drops exactly the objects created here.

CREATE OR REPLACE FUNCTION public.quant_research_freeze_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'quant-research-freeze-v1'::text $fn$;

CREATE OR REPLACE FUNCTION public.quant_research_status_is_terminal(run_status TEXT) RETURNS BOOLEAN
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT COALESCE(run_status IN ('SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT'), false) $fn$;

CREATE OR REPLACE FUNCTION public.quant_research_freeze_job_update() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF public.quant_research_status_is_terminal(OLD.status) THEN
  RAISE EXCEPTION 'Quant terminal research result is immutable' USING ERRCODE = 'QR001';
 END IF;
 RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.quant_research_freeze_job_delete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Quant research runs cannot be deleted' USING ERRCODE = 'QR001';
END $fn$;

-- The parent row is locked FOR SHARE: a concurrent UPDATE of its status (FOR NO KEY UPDATE) conflicts with it, so a child
-- insert cannot commit after the terminal transition. Writers already hold FOR UPDATE on the parent, so they never wait.
CREATE OR REPLACE FUNCTION public.quant_research_freeze_step_insert() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE parent_status TEXT;
BEGIN
 SELECT j.status INTO parent_status FROM public.quant_jobs j WHERE j.run_id = NEW.run_id FOR SHARE;
 IF public.quant_research_status_is_terminal(parent_status) THEN
  RAISE EXCEPTION 'Quant terminal research result is immutable' USING ERRCODE = 'QR001';
 END IF;
 RETURN NEW;
END $fn$;

CREATE OR REPLACE TRIGGER quant_job_terminal_freeze BEFORE UPDATE ON public.quant_jobs
 FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_job_update();
CREATE OR REPLACE TRIGGER quant_job_terminal_no_delete BEFORE DELETE ON public.quant_jobs
 FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_job_delete();
CREATE OR REPLACE TRIGGER quant_job_step_terminal_insert BEFORE INSERT ON public.quant_job_steps
 FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_step_insert();
ALTER TABLE public.quant_jobs ENABLE ALWAYS TRIGGER quant_job_terminal_freeze;
ALTER TABLE public.quant_jobs ENABLE ALWAYS TRIGGER quant_job_terminal_no_delete;
ALTER TABLE public.quant_job_steps ENABLE ALWAYS TRIGGER quant_job_step_terminal_insert;

-- FOUNDATION extension: binding row and chunk rows of a terminal run. Chunks keep one legitimate terminal-time write,
-- the recovery clear of unit_name and unit_token after a cancel.
DO $do$
BEGIN
 IF to_regclass('public.quant_research_foundation') IS NOT NULL THEN
  CREATE OR REPLACE TRIGGER quant_research_binding_terminal_insert BEFORE INSERT ON public.quant_research_foundation
   FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_step_insert();
  ALTER TABLE public.quant_research_foundation ENABLE ALWAYS TRIGGER quant_research_binding_terminal_insert;
 END IF;
 IF to_regclass('public.quant_research_chunks') IS NOT NULL THEN
  CREATE OR REPLACE FUNCTION public.quant_research_freeze_chunk_change() RETURNS trigger
   LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $fn$
  DECLARE parent_status TEXT;
  BEGIN
   SELECT j.status INTO parent_status FROM public.quant_jobs j WHERE j.run_id = OLD.run_id FOR SHARE;
   IF NOT public.quant_research_status_is_terminal(parent_status) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
   END IF;
   IF TG_OP = 'DELETE'
    OR NEW.unit_name IS NOT NULL OR NEW.unit_token IS NOT NULL
    OR ROW(NEW.run_id, NEW.step_id, NEW.kind, NEW.parameters, NEW.identity_hash, NEW.next_bar, NEW.checkpoint, NEW.checkpoint_hash)
       IS DISTINCT FROM ROW(OLD.run_id, OLD.step_id, OLD.kind, OLD.parameters, OLD.identity_hash, OLD.next_bar, OLD.checkpoint, OLD.checkpoint_hash)
   THEN
    RAISE EXCEPTION 'Quant terminal research result is immutable' USING ERRCODE = 'QR001';
   END IF;
   RETURN NEW;
  END $fn$;
  CREATE OR REPLACE TRIGGER quant_research_chunk_terminal_insert BEFORE INSERT ON public.quant_research_chunks
   FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_step_insert();
  CREATE OR REPLACE TRIGGER quant_research_chunk_terminal_freeze BEFORE UPDATE OR DELETE ON public.quant_research_chunks
   FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_chunk_change();
  ALTER TABLE public.quant_research_chunks ENABLE ALWAYS TRIGGER quant_research_chunk_terminal_insert;
  ALTER TABLE public.quant_research_chunks ENABLE ALWAYS TRIGGER quant_research_chunk_terminal_freeze;
 END IF;
END $do$;
