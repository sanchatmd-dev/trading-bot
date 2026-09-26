-- Optional QL-3A research extension. Base schema 14 and Paper ledgers stay intact.
CREATE TABLE quant_job_schema(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO quant_job_schema VALUES(1);
CREATE TABLE quant_jobs(
 run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), bot_id TEXT NOT NULL REFERENCES users(id),
 deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id), idempotency_key TEXT NOT NULL,
 submission_hash TEXT NOT NULL, contract_hash TEXT NOT NULL, contract JSONB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT')),
 phase TEXT NOT NULL DEFAULT 'CANDIDATES', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deadline BIGINT NOT NULL,
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3), lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
 evaluations_started INTEGER NOT NULL DEFAULT 0 CHECK(evaluations_started>=0), result JSONB, diagnostic TEXT,
 UNIQUE(owner_id,bot_id,idempotency_key)
);
CREATE INDEX quant_jobs_queue ON quant_jobs(status,created_at);
CREATE TABLE quant_job_steps(
 run_id TEXT NOT NULL REFERENCES quant_jobs(run_id), step_id TEXT NOT NULL, kind TEXT NOT NULL,
 parameters JSONB NOT NULL, result JSONB NOT NULL, completed_at BIGINT NOT NULL,
 PRIMARY KEY(run_id,step_id)
);
CREATE FUNCTION protect_quant_job_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.owner_id,NEW.bot_id,NEW.deployment_id,NEW.idempotency_key,NEW.submission_hash,NEW.contract_hash,NEW.contract,NEW.created_at,NEW.deadline)
    IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_id,OLD.bot_id,OLD.deployment_id,OLD.idempotency_key,OLD.submission_hash,OLD.contract_hash,OLD.contract,OLD.created_at,OLD.deadline)
 THEN RAISE EXCEPTION 'Quant run contract is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quant_job_contract_immutable BEFORE UPDATE ON quant_jobs FOR EACH ROW EXECUTE FUNCTION protect_quant_job_contract();
CREATE FUNCTION protect_quant_job_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Completed Quant checkpoint is immutable'; END $$;
CREATE TRIGGER quant_job_step_immutable BEFORE UPDATE OR DELETE ON quant_job_steps FOR EACH ROW EXECUTE FUNCTION protect_quant_job_step();
