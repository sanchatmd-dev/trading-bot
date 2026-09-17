// Security state is persisted so restart cannot reset MFA attempts or reuse reset tokens.
export async function invalidateAuth(store, userId) {
  for (const table of ['sessions', 'auth_challenges', 'password_resets', 'security_mail']) await store.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  await store.db.prepare('UPDATE user_security SET pending_secret=NULL,pending_expires=0 WHERE user_id=?').run(userId);
}
