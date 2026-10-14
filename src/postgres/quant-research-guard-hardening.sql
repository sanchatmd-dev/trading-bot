-- GH1 research mode-guard hardening (local candidate; applied offline and separately from the version-1 extensions).
-- Finding QR1B-MODE-GUARDS: the two trigger functions of quant-research-foundation-schema.sql read tables by unqualified name
-- under the caller's search_path, and pg_temp is searched first for relations. A runtime role with the database TEMP privilege
-- (the PUBLIC default; the repo grant script never revokes it) could create a TEMP table named like the research table and
-- change what the guard reads. Here the same logic is replaced with every relation schema-qualified and search_path pinned.
-- Both functions stay SECURITY INVOKER. CREATE OR REPLACE keeps the owner, the grants and the triggers that call them.
-- Idempotent: every statement converges. Logic, messages and error codes are unchanged.
-- Rollback: src/postgres/quant-research-guard-hardening-rollback.sql restores the original definitions.

CREATE OR REPLACE FUNCTION public.quant_research_mode_guard() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE selected TEXT;
BEGIN
 SELECT mode INTO selected FROM public.quant_research_executor_mode WHERE singleton FOR SHARE;
 IF NEW.status IN ('QUEUED','RUNNING') AND ((COALESCE(NEW.contract->>'execution_backend','')='quant-foundation-v1') IS DISTINCT FROM (selected='FOUNDATION')) THEN
  RAISE EXCEPTION 'Research executor mode mismatch';
 END IF;
 RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.quant_research_mode_change() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NEW.mode IS DISTINCT FROM OLD.mode AND (EXISTS(SELECT 1 FROM public.quant_jobs WHERE status IN ('QUEUED','RUNNING')) OR EXISTS(SELECT 1 FROM public.quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED','RUNNING','STOPPING'))) THEN
  RAISE EXCEPTION 'Stop and drain every research executor before changing mode';
 END IF;
 RETURN NEW;
END $fn$;
