-- Rollback of src/postgres/quant-research-guard-hardening.sql. Restores the two original function definitions of
-- src/postgres/quant-research-foundation-schema.sql: the bodies below are copied from that file unchanged, with no pinned
-- search_path. CREATE OR REPLACE keeps the owner, the grants and the triggers. No row is read or changed.
-- Rolling back removes the protection; use it only to return to the exact applied schema state.

CREATE OR REPLACE FUNCTION public.quant_research_mode_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE selected TEXT;
BEGIN
 SELECT mode INTO selected FROM quant_research_executor_mode WHERE singleton FOR SHARE;
 IF NEW.status IN ('QUEUED','RUNNING') AND ((COALESCE(NEW.contract->>'execution_backend','')='quant-foundation-v1') IS DISTINCT FROM (selected='FOUNDATION')) THEN
  RAISE EXCEPTION 'Research executor mode mismatch';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.quant_research_mode_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.mode IS DISTINCT FROM OLD.mode AND (EXISTS(SELECT 1 FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')) OR EXISTS(SELECT 1 FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED','RUNNING','STOPPING'))) THEN
  RAISE EXCEPTION 'Stop and drain every research executor before changing mode';
 END IF;
 RETURN NEW;
END $$;
