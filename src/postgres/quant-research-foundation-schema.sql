-- Optional offline adapter extension. Existing research contracts are unchanged.
CREATE TABLE quant_research_foundation_schema(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO quant_research_foundation_schema VALUES(1);
CREATE TABLE quant_research_executor_mode(singleton BOOLEAN PRIMARY KEY CHECK(singleton),mode TEXT NOT NULL CHECK(mode IN ('LEGACY','FOUNDATION')));
INSERT INTO quant_research_executor_mode VALUES(TRUE,'LEGACY');
CREATE TABLE quant_research_foundation(
 run_id TEXT PRIMARY KEY REFERENCES quant_jobs(run_id),job_id UUID UNIQUE NOT NULL REFERENCES quant_foundation_jobs(job_id),
 contract_hash TEXT NOT NULL CHECK(contract_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE quant_research_chunks(
 run_id TEXT NOT NULL REFERENCES quant_jobs(run_id),step_id TEXT NOT NULL,kind TEXT NOT NULL,
 parameters JSONB NOT NULL,identity_hash TEXT NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 next_bar INTEGER NOT NULL DEFAULT 0 CHECK(next_bar BETWEEN 0 AND 10000),checkpoint JSONB,checkpoint_hash TEXT CHECK(checkpoint_hash ~ '^[a-f0-9]{64}$'),
 unit_name TEXT,unit_token UUID,PRIMARY KEY(run_id,step_id)
);
CREATE FUNCTION quant_research_mode_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE selected TEXT;
BEGIN
 SELECT mode INTO selected FROM quant_research_executor_mode WHERE singleton FOR SHARE;
 IF NEW.status IN ('QUEUED','RUNNING') AND ((COALESCE(NEW.contract->>'execution_backend','')='quant-foundation-v1') IS DISTINCT FROM (selected='FOUNDATION')) THEN
  RAISE EXCEPTION 'Research executor mode mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quant_research_mode_guard BEFORE INSERT OR UPDATE ON quant_jobs FOR EACH ROW EXECUTE FUNCTION quant_research_mode_guard();
CREATE FUNCTION quant_research_mode_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.mode IS DISTINCT FROM OLD.mode AND (EXISTS(SELECT 1 FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')) OR EXISTS(SELECT 1 FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED','RUNNING','STOPPING'))) THEN
  RAISE EXCEPTION 'Stop and drain every research executor before changing mode';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quant_research_mode_change BEFORE UPDATE ON quant_research_executor_mode FOR EACH ROW EXECUTE FUNCTION quant_research_mode_change();
CREATE FUNCTION quant_research_binding_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Research foundation identity is immutable'; END $$;
CREATE TRIGGER quant_research_binding_immutable BEFORE UPDATE OR DELETE ON quant_research_foundation FOR EACH ROW EXECUTE FUNCTION quant_research_binding_immutable();
CREATE FUNCTION quant_research_chunk_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.step_id,NEW.kind,NEW.parameters,NEW.identity_hash) IS DISTINCT FROM ROW(OLD.run_id,OLD.step_id,OLD.kind,OLD.parameters,OLD.identity_hash) OR NEW.next_bar<OLD.next_bar THEN
  RAISE EXCEPTION 'Research chunk identity or progress changed';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quant_research_chunk_guard BEFORE UPDATE ON quant_research_chunks FOR EACH ROW EXECUTE FUNCTION quant_research_chunk_guard();
