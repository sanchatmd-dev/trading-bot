-- Rollback of src/postgres/quant-io-release-guard-hardening.sql. Restores the exact original definition of
-- quant_io_foundation_release_guard() from src/postgres/quant-io-runtime-schema.sql: the body below is copied from that file
-- unchanged, with no pinned search_path. CREATE OR REPLACE keeps the OID, owner, grants and the trigger. No row is read or changed.
-- Rolling back removes the protection; use it only to return to the exact applied schema state.

CREATE OR REPLACE FUNCTION public.quant_io_foundation_release_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('RUNNING','STOPPING') AND
    (NEW.status NOT IN ('RUNNING','STOPPING') OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
    IF EXISTS (SELECT 1 FROM quant_io_launches WHERE job_id=OLD.job_id AND state<>'STOP_PROVEN')
      OR EXISTS (SELECT 1 FROM quant_io_ledgers l,
          LATERAL jsonb_array_elements(l.state->'operations') AS op
          WHERE l.job_id=OLD.job_id AND op->>'status' IN
            ('RESERVED','ACTIVE','STOP_REQUIRED','CRASHED_UNCONFIRMED')) THEN
      RAISE EXCEPTION 'Foundation I/O launch unresolved';
    END IF;
  END IF;
  RETURN NEW;
END $$;
