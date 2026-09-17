// Security state is persisted so restart cannot reset MFA attempts or reuse reset tokens.
export function migrateAuth(store){
  store.db.exec(`
    ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN elevated_until INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0;
    DELETE FROM sessions;
    CREATE TABLE user_security(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mfa_secret TEXT,pending_secret TEXT,pending_expires INTEGER NOT NULL DEFAULT 0,last_step INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE mfa_recovery(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,
      PRIMARY KEY(user_id,code_hash));
    CREATE TABLE auth_challenges(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE password_resets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);
    CREATE INDEX idx_reset_user ON password_resets(user_id);
    CREATE TABLE security_limits(key_hash TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE security_mail(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      encrypted_body TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'PENDING');
    PRAGMA user_version=10;
  `);
}

export function invalidateAuth(store,userId){
  for(const table of ['sessions','auth_challenges','password_resets','security_mail'])store.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  store.db.prepare('UPDATE user_security SET pending_secret=NULL,pending_expires=0 WHERE user_id=?').run(userId);
}
