-- Optional local engineering extension. Apply offline to an isolated database first.
CREATE TABLE quant_io_ledgers (
  job_id UUID PRIMARY KEY REFERENCES quant_foundation_jobs(job_id),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  lease_token UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  state JSONB NOT NULL,
  state_hash TEXT NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CHECK (state->>'job_id' = job_id::text),
  CHECK (state->>'policy_hash' = policy_hash),
  CHECK (state->>'lease_token' = lease_token::text),
  CHECK ((state->>'revision')::bigint = revision)
);

CREATE FUNCTION quant_io_ledger_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Quant I/O ledger cannot be deleted'; END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
    OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'Quant I/O ledger identity or revision cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quant_io_ledger_guard BEFORE UPDATE OR DELETE ON quant_io_ledgers
  FOR EACH ROW EXECUTE FUNCTION quant_io_ledger_guard();
