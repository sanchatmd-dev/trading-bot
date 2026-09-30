-- PF-2 preflight extension, applied offline by migrateQuantFoundation on every foundation migration.
-- Any migrate run on a release that contains this file installs these tables, so on staging that run is the
-- owner-authorized PF-2 operations packet. New tables only; the five foreign keys add internal RI triggers on
-- the referenced existing tables and take ShareRowExclusiveLock on them while the migration applies.
-- Requires quant_foundation_schema 1 and pine_bridge_schema 1 (quant_foundation_jobs, pine_deployments, users).
CREATE TABLE quant_preflight_schema(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO quant_preflight_schema VALUES(1);

-- Owner-registered development/holdout boundary. One write-once row per bot for BINANCE:BTCUSDT Spot 1m.
-- The row holds a timestamp only, never market data. A boundary never moves in V1.
CREATE TABLE quant_holdout_boundaries(
 owner_id TEXT NOT NULL REFERENCES users(id),
 bot_id TEXT NOT NULL REFERENCES users(id),
 venue TEXT NOT NULL CHECK(venue='binance-global'),
 market TEXT NOT NULL CHECK(market='SPOT'),
 symbol TEXT NOT NULL CHECK(symbol='BTCUSDT'),
 timeframe TEXT NOT NULL CHECK(timeframe='1'),
 holdout_start_time BIGINT NOT NULL CHECK(holdout_start_time>0 AND holdout_start_time%60000=0 AND holdout_start_time<=253402300799999),
 created_by TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(owner_id,bot_id,venue,market,symbol,timeframe)
);
CREATE FUNCTION quant_holdout_boundary_write_once() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Holdout boundary is write-once'; END $$;
CREATE TRIGGER quant_holdout_boundary_write_once BEFORE UPDATE OR DELETE ON quant_holdout_boundaries
 FOR EACH ROW EXECUTE FUNCTION quant_holdout_boundary_write_once();

-- One row per PREFLIGHT foundation job. plan_json is TEXT (not JSONB) so the exact canonical bytes stay under the hash CHECK.
CREATE TABLE quant_preflight_jobs(
 job_id UUID PRIMARY KEY REFERENCES quant_foundation_jobs(job_id),
 owner_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 plan_hash TEXT NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
 plan_json TEXT NOT NULL,
 deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id),
 profile_job_id UUID NOT NULL REFERENCES quant_foundation_jobs(job_id),
 created_at BIGINT NOT NULL,
 unit_name TEXT,
 unit_token UUID,
 CONSTRAINT quant_preflight_jobs_plan_sha_check CHECK(encode(sha256(convert_to(plan_json,'UTF8')),'hex')=plan_hash),
 CONSTRAINT quant_preflight_jobs_unit_pair_check CHECK((unit_name IS NULL)=(unit_token IS NULL))
);
CREATE INDEX quant_preflight_jobs_bot ON quant_preflight_jobs(owner_id,bot_id,created_at DESC);
-- Only the process-unit pair (unit_name, unit_token) may change after insert; a row is never deleted.
CREATE FUNCTION quant_preflight_jobs_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preflight job binding cannot be deleted'; END IF;
 IF ROW(NEW.job_id,NEW.owner_id,NEW.bot_id,NEW.plan_hash,NEW.plan_json,NEW.deployment_id,NEW.profile_job_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.owner_id,OLD.bot_id,OLD.plan_hash,OLD.plan_json,OLD.deployment_id,OLD.profile_job_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Preflight job binding is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quant_preflight_jobs_guard BEFORE UPDATE OR DELETE ON quant_preflight_jobs
 FOR EACH ROW EXECUTE FUNCTION quant_preflight_jobs_guard();
