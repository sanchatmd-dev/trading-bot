# Phase 1: Account security

Status: implemented locally, not deployed. This phase covers MFA, browser sessions, password recovery, role-based access and encryption-key rotation. It does not enable Live trading, subscriptions/billing or horizontal scaling. Production remains on schema 9 until an explicitly approved deployment.

## Authentication and sessions

- Browser authentication uses opaque HttpOnly cookies, not JavaScript-readable bearer tokens. Legacy `astraV2Token` storage is removed on page load.
- Public HTTPS uses `__Host-robot_session` and `__Host-robot_challenge`, `Secure`, `SameSite=Strict`, `Path=/`, and no Domain attribute. Loopback HTTP uses non-prefixed cookies for local development only.
- Unsafe API requests require the exact configured Origin and JSON content type. Authenticated writes also require a session-bound CSRF header. Webhooks continue to authenticate with their per-bot secret and do not require browser headers.
- Sessions expire after 24 hours or 30 minutes idle by default. Login and identity confirmation rotate the session. Password changes, password recovery, MFA changes, suspension and role changes revoke existing sessions and outstanding login/recovery challenges.
- Administrator APIs, cross-owner analytics and credential/webhook/password mutations require identity confirmation within the last 10 minutes. MFA-enabled accounts must supply an authenticator or unused recovery code when confirming identity. A failed operation is not replayed automatically after confirmation.
- Login/MFA/reset attempt limits persist in SQLite across restarts. Request/body limits remain in place. This is a single-process design, not a distributed rate limiter.

## MFA and roles

Users enroll from Account and License → Account security by confirming their password, adding the displayed key to an authenticator app and supplying a 6-digit code. TOTP uses RFC 6238, a 30-second step and a one-step clock allowance. Used steps cannot be reused. Keep the VPS clock synchronized.

Ten recovery codes are displayed once. Store them offline or in a password manager; each works once. Only their hashes are stored. Active and pending TOTP keys are tenant-bound AES-256-GCM ciphertext. Enrollment expires after 10 minutes.

| Role | Own bot controls | View users/operations | Manage users, roles, licenses and global pause | Cross-owner analytics |
| --- | --- | --- | --- | --- |
| USER | Yes | No | No | No |
| SUPPORT | Yes | Yes | No | No |
| ADMIN | Yes | Yes | Yes | Yes |

ADMIN and SUPPORT must enroll in MFA before accessing privileged controls and cannot disable it through the API. Existing administrators can sign in to enroll; the enrollment requirement does not suspend existing Paper webhooks. Unknown roles receive no application permissions. Only main accounts can sign in. Bot scopes remain owned by the authenticated main account.

Administrators cannot suspend themselves or change their own role. Changing another account's role revokes its sessions. Support cannot read another user's webhook/credentials or alter their bot settings. Normal trading/license policy still applies to Support's own Paper bots.

## Email password recovery

Configure the existing SMTP settings with a verified provider. STARTTLS or implicit TLS is required by the mail sender. Without SMTP, the UI retains safe administrator-contact guidance. The public response never confirms whether an address exists.

Recovery links expire after 15 minutes, work once, and are replaced by a newer request. Tokens are hashed in `password_resets`; the retryable mail body is encrypted. Links use a URL fragment, which the browser removes before continuing, rather than a token query in access logs. SMTP retries are bounded and expired mail is deleted. Gmail accepted a plain-text SMTP test from the VPS on 2026-09-18 (Asia/Bangkok), and the owner confirmed inbox receipt. This verifies transport, not a completed production password reset.

Resetting a password does **not** bypass or disable MFA. An MFA-enabled account still needs a valid authenticator or recovery code. The operator password-reset helper also preserves MFA. Loss of both authenticator and all recovery codes requires a separately reviewed identity-verification/operator recovery procedure; no public MFA bypass is provided.

## Configuration and migration

Set these deliberately before activation:

```dotenv
PUBLIC_ORIGIN=https://www.robottrade.io
SESSION_TTL_HOURS=24
SESSION_IDLE_MINUTES=30
ENCRYPTION_KEY_ID=k1
ENCRYPTION_PREVIOUS_KEYS={}
```

Keep the existing `MASTER_ENCRYPTION_KEY` unchanged during the schema upgrade. Do not generate a replacement just to deploy. `PUBLIC_ORIGIN` must match the browser's exact scheme, host and port; redirect other hostnames to this canonical origin in the proxy. The local `.env.example` origin is not suitable for the VPS. A mismatched origin will reject login/writes.

Audit reverse-proxy and upstream logs separately: webhook paths contain secrets. Disable/redact raw webhook access logging and never log authentication bodies, cookies or CSRF headers. Application redaction does not sanitize an external proxy's logs. Restrict database/backups/environment files to the service/operator account.

Schema 10 adds security tables and session metadata. Migration intentionally signs everyone out. Existing user IDs, password hashes, bot ownership, risk settings, history, licenses and encrypted secrets are preserved. Webhook URLs are not rotated by the migration. New ciphertext includes a key ID; existing tenant-bound v2 data remains readable with the current master key.

Rehearse against a new verified copy of schema 9, never the active database:

```sh
node scripts/rehearse-phase1.mjs /absolute/schema9.db /absolute/new-rehearsal.db
```

The helper uses `scripts/backup.mjs`, compares every pre-existing table except the intentionally revoked sessions, checks integrity/foreign keys and prints only counts. It does not start a server or worker and does not send orders/email. Do not reuse its target path.

Deployment checklist:

1. Run `npm ci` and `npm test` in a new immutable release directory. Complete rendered desktop/mobile authentication QA and real SMTP delivery checks in isolated staging.
2. Rehearse against a recent production backup. Review preservation checks and ensure administrators can enroll and store recovery codes.
3. Pause signal delivery, stop the service, and run `scripts/backup.mjs` for a final pre-v10 snapshot. Save the old revision/configuration and key separately. Rehearse that snapshot too.
4. Configure the canonical origin, proxy/header policy, SMTP and existing encryption key. Keep Paper-only mode and one process per database.
5. Switch the `current` symlink to the tested immutable release, restart, and check `/healthz`, schema 10, integrity, foreign keys, cookie flags, denied unauthenticated/CSRF requests and successful admin MFA enrollment/login.
6. Verify existing webhook URLs and Paper history are preserved before resuming signals. Do not send production test trades without separate approval.

Rollback requires the matching old application **and** its pre-v10 database, configuration and key. Do not point schema-9 code at schema 10. Restoring a snapshot loses activity after the snapshot; do not automatically restore after accepting new signals.

## Encryption-key rotation

This is an offline operator operation, separate from deployment and separate from rotating a webhook secret or exchange API key. New writes use a versioned envelope (`v3.<key-id>...`) with tenant context and key ID authenticated by AES-GCM. Previous versioned keys can be supplied through the secret environment when required. Never reuse an ID for different key material.

1. Stop the bot. Save its exact environment securely; keep a tested backup and old key separately.
2. Supply `DB_PATH`, the current `MASTER_ENCRYPTION_KEY`, current `ENCRYPTION_KEY_ID`, any `ENCRYPTION_PREVIOUS_KEYS`, and a new random 64-hex `NEW_ENCRYPTION_KEY` with a new `NEW_ENCRYPTION_KEY_ID` through protected environment configuration. Never put keys in command arguments, chat or Git.
3. Run the script with a new backup destination:

   ```sh
   node scripts/rotate-encryption-key.mjs /absolute/new-pre-rotation.db
   ```

4. The script refuses an active bot lock, makes a verified backup, and re-encrypts credentials, webhook secrets, MFA keys and recovery mail in one transaction. Any unreadable row rolls back the rewrite. Legacy unbound v1 credentials require owner re-entry before rotation; mixed unversioned keys are not guessed.
5. After successful commit, update the service's master key and key ID to the new values **before restarting**. Do not start with the old environment. Remove the temporary new-key variables from the service configuration after updating it. Preserve the old key with its backup for recovery.
6. Verify credential/secret decryption, login and MFA without logging plaintext. Webhook URLs and hashes remain unchanged.

Exchange API keys still require broker-side replacement/revocation. The account webhook rotation button immediately invalidates the old URL and requires updating TradingView alerts manually.

## Validation and remaining release gates

Local verification on 2026-09-18: `npm test` passed 88/88 tests; `node --check` passed all 47 JavaScript modules; `git diff --check` passed. All new security tests use isolated local fixtures, not production accounts.

Automated coverage includes RFC TOTP vectors, replay/recovery-code reuse, CSRF/Origin/cookies, idle/absolute session rules, enrollment enforcement, privilege/tenant boundaries across scoped endpoints, revocation during a streaming request, reset expiration/reuse, encrypted mail retries, migration preservation, key-rotation backup/rollback, and DOM authentication flows in EN/TH.

The execution policy still refuses agent-launched local servers. The owner started an isolated QA server manually at 127.0.0.1:8091; no policy was weakened. Rendered Chrome QA covered 1440×900 desktop and 390×844 mobile, account security, MFA login using a single-use fixture recovery code, EN/TH, cookie-session reload, mobile navigation and the identity-confirmation dialog. Eight desktop pages had no horizontal overflow; mobile Account, Risk and Overview were inspected. A narrow Bot toolbar description was fixed with a single-column mobile layout. Screenshots were saved outside the repository as desktop-account.png, mobile-account-th.png and mobile-mfa-login.png.

One Chrome extension-style connection error appeared without a corresponding application failure; other inspected console output was empty. Physical iOS/Android and Safari were not tested. Recovery token submission, TOTP/replay and session revocation were verified by automated isolated tests; no production password was reset. No production migration, key rotation or deployment has been performed at this pre-release checkpoint. These changes and tests are an internal review, not an independent penetration test or commercial-security certification.

Before selling access, retain the deployment restrictions, complete the remaining QA/restore/provider checks, and obtain a separate security assessment. Shared/distributed infrastructure and decimal money remain later-phase work.

Design references: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), and [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238).
