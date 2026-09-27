-- Optional offline foundation extension. Existing base schema is unchanged.
CREATE TABLE quant_foundation_schema (version INTEGER PRIMARY KEY CHECK (version = 1));
INSERT INTO quant_foundation_schema VALUES (1);

CREATE TABLE quant_foundation_scheduler (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  service_counter BIGINT NOT NULL DEFAULT 0 CHECK (service_counter >= 0)
);
INSERT INTO quant_foundation_scheduler DEFAULT VALUES;

CREATE TABLE quant_foundation_owners (
  owner_id TEXT PRIMARY KEY,
  last_served BIGINT NOT NULL DEFAULT 0 CHECK (last_served >= 0)
);

CREATE TABLE quant_foundation_jobs (
  job_id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES quant_foundation_owners(owner_id),
  idempotency_key TEXT NOT NULL,
  contract JSONB NOT NULL,
  contract_hash TEXT NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','PAUSED','STOPPING','CANCELLED','SUCCEEDED')),
  created_at BIGINT NOT NULL,
  deadline_at BIGINT NOT NULL CHECK (deadline_at > created_at),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  worker_id TEXT,
  lease_token UUID,
  lease_until BIGINT,
  run_started_at BIGINT,
  runtime_used_ms BIGINT NOT NULL DEFAULT 0 CHECK (runtime_used_ms >= 0),
  stop_reason TEXT CHECK (stop_reason IN ('LEASE_EXPIRED','CANCELLED','RUNTIME_EXCEEDED','HEALTH_UNAVAILABLE')),
  diagnostic TEXT,
  checkpoint JSONB,
  next_bar INTEGER NOT NULL DEFAULT 0 CHECK (next_bar >= 0),
  result JSONB,
  UNIQUE(owner_id,idempotency_key),
  CHECK ((status IN ('RUNNING','STOPPING')) = (lease_token IS NOT NULL)),
  CHECK ((status = 'RUNNING') = (lease_until IS NOT NULL)),
  CHECK ((status = 'STOPPING') = (stop_reason IS NOT NULL))
);
-- STOPPING reserves the same global slot until physical stop is acknowledged.
CREATE UNIQUE INDEX quant_foundation_one_executor ON quant_foundation_jobs ((TRUE))
  WHERE status IN ('RUNNING','STOPPING');
CREATE INDEX quant_foundation_queue ON quant_foundation_jobs(owner_id,created_at,job_id)
  WHERE status IN ('QUEUED','PAUSED');

CREATE FUNCTION quant_foundation_immutable_contract() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.contract IS DISTINCT FROM OLD.contract OR NEW.contract_hash IS DISTINCT FROM OLD.contract_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
    RAISE EXCEPTION 'Foundation job contract is immutable';
  END IF;
  IF NEW.next_bar < OLD.next_bar THEN RAISE EXCEPTION 'Foundation checkpoint cannot regress'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quant_foundation_contract_guard BEFORE UPDATE ON quant_foundation_jobs
  FOR EACH ROW EXECUTE FUNCTION quant_foundation_immutable_contract();
