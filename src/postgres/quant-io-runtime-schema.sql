-- Optional runtime launch intent. Apply offline with foundation and I/O ledger schema.
CREATE TABLE quant_io_launches (
  job_id UUID NOT NULL REFERENCES quant_io_ledgers(job_id),
  operation_id TEXT NOT NULL,
  lease_token UUID NOT NULL,
  unit_name TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('INTENT_RECORDED','STARTING','SPAWNED','RELEASED','STOP_PROVEN')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (job_id,operation_id)
);

CREATE FUNCTION quant_io_launch_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Quant I/O launch intent cannot be deleted'; END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.unit_name IS DISTINCT FROM OLD.unit_name
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NOT ((OLD.state='INTENT_RECORDED' AND NEW.state IN ('STARTING','STOP_PROVEN'))
      OR (OLD.state='STARTING' AND NEW.state IN ('SPAWNED','STOP_PROVEN'))
      OR (OLD.state='SPAWNED' AND NEW.state IN ('RELEASED','STOP_PROVEN'))
      OR (OLD.state='RELEASED' AND NEW.state='STOP_PROVEN')) THEN
    RAISE EXCEPTION 'Quant I/O launch intent cannot regress';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quant_io_launch_guard BEFORE UPDATE OR DELETE ON quant_io_launches
  FOR EACH ROW EXECUTE FUNCTION quant_io_launch_guard();

-- Every scheduler instance sees this guard, including one without an optional
-- application callback. STOPPING continues to hold the global slot.
CREATE FUNCTION quant_io_foundation_release_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE TRIGGER quant_io_foundation_release_guard BEFORE UPDATE ON quant_foundation_jobs
  FOR EACH ROW EXECUTE FUNCTION quant_io_foundation_release_guard();
