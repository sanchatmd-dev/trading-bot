-- Optional offline extension. Completion retains the existing STOPPING slot and lease.
CREATE TABLE quant_profile_enrollment_schema (
  singleton BOOLEAN PRIMARY KEY CHECK (singleton),
  version INTEGER NOT NULL CHECK (version = 1)
);

CREATE TABLE quant_profile_enrollment_receipts (
  version TEXT NOT NULL CHECK (version = 'profile-enrollment-receipt-v1'),
  job_id UUID PRIMARY KEY REFERENCES quant_foundation_jobs(job_id),
  operation_id TEXT NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  lease_token UUID NOT NULL,
  contract_hash TEXT NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  stop_proof_sha256 TEXT NOT NULL CHECK (stop_proof_sha256 ~ '^[a-f0-9]{64}$'),
  readback_proof_sha256 TEXT NOT NULL CHECK (readback_proof_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at BIGINT NOT NULL CHECK (completed_at >= 0 AND completed_at <= 9007199254740991),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (job_id, operation_id) REFERENCES quant_io_launches(job_id, operation_id)
);

CREATE FUNCTION quant_profile_enrollment_receipt_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Profile enrollment receipt is immutable';
END $$;
CREATE TRIGGER quant_profile_enrollment_receipt_guard BEFORE UPDATE OR DELETE ON quant_profile_enrollment_receipts
  FOR EACH ROW EXECUTE FUNCTION quant_profile_enrollment_receipt_guard();

ALTER TABLE quant_foundation_jobs DROP CONSTRAINT quant_foundation_jobs_stop_reason_check;
ALTER TABLE quant_foundation_jobs ADD CONSTRAINT quant_foundation_jobs_stop_reason_check
  CHECK (stop_reason IN ('LEASE_EXPIRED','CANCELLED','RUNTIME_EXCEEDED','HEALTH_UNAVAILABLE','PROFILE_COMPLETING'));

-- The version marker is the final write of the atomic extension installation.
INSERT INTO quant_profile_enrollment_schema VALUES (TRUE, 1);
