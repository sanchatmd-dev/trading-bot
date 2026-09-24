-- Optional evidence-only capture extension. Does not change execution readiness.
CREATE TABLE pine_capture_schema(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO pine_capture_schema VALUES(1);
CREATE TABLE pine_capture_sessions(
  capture_id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id),
  owner_id TEXT NOT NULL REFERENCES users(id), bot_id TEXT NOT NULL REFERENCES users(id),
  snapshot_hash TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, closed BOOLEAN NOT NULL DEFAULT FALSE,
  received INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE INDEX pine_capture_deployment ON pine_capture_sessions(deployment_id);
CREATE TABLE pine_capture_events(
  capture_id TEXT NOT NULL REFERENCES pine_capture_sessions(capture_id), event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL, payload JSONB NOT NULL, received_at BIGINT NOT NULL,
  market_present_at_intake BOOLEAN, market_checked_at BIGINT, market_hash_at_intake TEXT,
  PRIMARY KEY(capture_id,event_id)
);
