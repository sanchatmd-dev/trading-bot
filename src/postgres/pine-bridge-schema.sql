-- Optional, versioned APP-3A extension to base schema 14. Applied offline only.
CREATE TABLE pine_bridge_schema(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO pine_bridge_schema VALUES(1);
CREATE TABLE pine_sources(
  pine_import_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  bot_id TEXT NOT NULL REFERENCES users(id), source_version INTEGER NOT NULL CHECK(source_version>0),
  source_hash TEXT NOT NULL, source_name TEXT NOT NULL, source TEXT NOT NULL,
  analysis JSONB NOT NULL, created_at BIGINT NOT NULL,
  UNIQUE(owner_id,bot_id,pine_import_id,source_version)
);
CREATE TABLE pine_source_revisions(
  pine_import_id TEXT NOT NULL REFERENCES pine_sources(pine_import_id), source_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL, source TEXT NOT NULL, analysis JSONB NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY(pine_import_id,source_version)
);
CREATE TABLE pine_memberships(
  pine_import_id TEXT PRIMARY KEY REFERENCES pine_sources(pine_import_id), owner_id TEXT NOT NULL REFERENCES users(id),
  bot_id TEXT NOT NULL REFERENCES users(id), source_version INTEGER NOT NULL, connected BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY(pine_import_id,source_version) REFERENCES pine_source_revisions(pine_import_id,source_version)
);
CREATE TABLE pine_bridge_jobs(
  job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), bot_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK(operation IN ('analyze','generate')), idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, request JSONB NOT NULL, pine_import_id TEXT NOT NULL REFERENCES pine_sources(pine_import_id),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','VALIDATING','RETRY_WAIT','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','OUTCOME_UNKNOWN')),
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deadline BIGINT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 2), attempt_id TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0, next_attempt BIGINT NOT NULL DEFAULT 0,
  result JSONB, diagnostic TEXT, usage JSONB NOT NULL DEFAULT '[]',
  UNIQUE(owner_id,bot_id,operation,idempotency_key)
);
CREATE INDEX pine_bridge_jobs_queue ON pine_bridge_jobs(status,next_attempt,created_at);
CREATE TABLE pine_bridge_attempts(
  attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES pine_bridge_jobs(job_id),
  dispatched_at BIGINT NOT NULL, finished_at BIGINT, outcome TEXT, usage JSONB, provider_request_id TEXT
);
CREATE TABLE pine_deployments(
  deployment_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), bot_id TEXT NOT NULL REFERENCES users(id),
  pine_import_id TEXT NOT NULL REFERENCES pine_sources(pine_import_id), source_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL, snapshot_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','READY','EXIT_ONLY','REVOKED')),
  created_at BIGINT NOT NULL
);
CREATE TABLE pine_bridge_events(
  deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id), event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL, entry_ref TEXT NOT NULL, bar_time BIGINT NOT NULL,
  payload JSONB NOT NULL,
  signal_id BIGINT REFERENCES signals(id), outcome TEXT NOT NULL,
  PRIMARY KEY(deployment_id,event_id)
);
CREATE TABLE pine_bridge_pending(
  deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id), event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL, payload JSONB NOT NULL,
  received_at BIGINT NOT NULL, deadline_at BIGINT NOT NULL, checked_at BIGINT,
  status TEXT NOT NULL CHECK(status IN ('WAITING_MARKET','QUEUED','REJECTED')),
  diagnostic TEXT, signal_id BIGINT REFERENCES signals(id),
  PRIMARY KEY(deployment_id,event_id)
);
CREATE INDEX pine_bridge_pending_due ON pine_bridge_pending(deadline_at,received_at) WHERE status='WAITING_MARKET';
CREATE TABLE pine_bridge_entries(
  deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id), entry_ref TEXT NOT NULL,
  allocation_id TEXT NOT NULL REFERENCES ledger_position_allocations(position_id),
  PRIMARY KEY(deployment_id,entry_ref), UNIQUE(allocation_id)
);
CREATE TABLE pine_bridge_evidence(
  deployment_id TEXT PRIMARY KEY REFERENCES pine_deployments(deployment_id), snapshot_hash TEXT NOT NULL,
  evidence JSONB NOT NULL, evidence_hash TEXT NOT NULL, recorded_at BIGINT NOT NULL
);
CREATE TABLE pine_market_bars(
  broker TEXT NOT NULL,symbol TEXT NOT NULL,timeframe TEXT NOT NULL,bar_time BIGINT NOT NULL,
  bar JSONB NOT NULL, provenance JSONB NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(broker,symbol,timeframe,bar_time)
);
CREATE UNIQUE INDEX pine_one_entry_route ON pine_deployments(bot_id,pine_import_id) WHERE state='READY';
