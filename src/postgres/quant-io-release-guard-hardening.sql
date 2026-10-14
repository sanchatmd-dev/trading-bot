-- GH2 hardening of the I/O foundation release guard (local candidate; applied offline and separately from the version-1 extensions).
-- Finding GH1-IO-RELEASE: quant_io_foundation_release_guard() of quant-io-runtime-schema.sql reads quant_io_launches and
-- quant_io_ledgers by unqualified name under the caller's search_path, and pg_temp is searched first for relations. A runtime role
-- with the database TEMP privilege (the PUBLIC default; the repo grant script never revokes it) could create empty TEMP tables with
-- those names and release a RUNNING or STOPPING job while a launch or ledger operation is still unresolved.
-- Here the same logic is replaced with exactly two textual changes, public. on the two relation names, plus SECURITY INVOKER and a
-- pinned search_path. Every status set, the lease test, the LATERAL expression and the error message are byte-for-byte unchanged.
-- CREATE OR REPLACE keeps the OID, owner, grants and the BEFORE UPDATE trigger on quant_foundation_jobs. No grant changes.
-- Idempotent. The migration classifies the live definition first and writes only over the exact original.
-- Rollback: src/postgres/quant-io-release-guard-hardening-rollback.sql restores the original definition.

CREATE OR REPLACE FUNCTION public.quant_io_foundation_release_guard() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status IN ('RUNNING','STOPPING') AND
    (NEW.status NOT IN ('RUNNING','STOPPING') OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
    IF EXISTS (SELECT 1 FROM public.quant_io_launches WHERE job_id=OLD.job_id AND state<>'STOP_PROVEN')
      OR EXISTS (SELECT 1 FROM public.quant_io_ledgers l,
          LATERAL jsonb_array_elements(l.state->'operations') AS op
          WHERE l.job_id=OLD.job_id AND op->>'status' IN
            ('RESERVED','ACTIVE','STOP_REQUIRED','CRASHED_UNCONFIRMED')) THEN
      RAISE EXCEPTION 'Foundation I/O launch unresolved';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
