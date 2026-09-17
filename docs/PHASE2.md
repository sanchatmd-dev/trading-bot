# Phase 2 — exact Paper accounting and shared PostgreSQL

Status: deployed to production as immutable release `0321ae6` on 2026-09-18 (Asia/Bangkok), PostgreSQL schema 11. This is a Paper-only infrastructure release, not approval for Live trading or commercial launch.

## Runtime boundaries

The PostgreSQL runtime is under `src/postgres/`. The existing SQLite runtime and `npm start` remain available for the current deployment and pre-cutover rollback. Never run both runtimes as writers for the same customer service. Maintaining both implementations is temporary migration debt; retire SQLite only after an accepted cutover and retention period.

- API processes authenticate, validate and durably enqueue; they never execute orders.
- Separate worker processes execute Paper orders. PostgreSQL is the durable queue; Redis is not required for this bounded workload.
- Workers claim an owner with `FOR UPDATE SKIP LOCKED`, then its bot and earliest queued signal. Different owners can run in parallel; one owner's five profiles execute sequentially while keeping their cash and risk separate.
- Claim, risk checks, order intent, fill, position, cash journal, audit and notification enqueue commit in one transaction on one pinned connection. A crash before commit rolls everything back to QUEUED. A crash after commit cannot replay a terminal fill.
- This transaction design is valid only for instantaneous local Paper simulation. A future Live adapter requires an external-order state machine, broker idempotency and reconciliation. Never put a remote broker request inside this transaction and call it exactly-once.
- Mail uses `SKIP LOCKED` and 60-second leases. SMTP is **at least once**: a crash after delivery but before acknowledgment can resend email, but cannot resend a fill.
- Sessions, CSRF, MFA, recovery codes, password reset, RBAC, bot ownership, account suspension and rate attempts retain Phase 1 behavior. Failed requests do not roll back rate attempts. Request bodies are read before opening database transactions.
- API writes use SERIALIZABLE transactions and buffer JSON until commit. Conflicts return `409 RETRY_TRANSACTION`; clients must refresh and intentionally retry. Writes are not replayed by the UI automatically. Webhook intake uses READ COMMITTED with owner/bot locks, a short queue-capacity lock, and unique `(user_id, trade_id)` enforcement; duplicates return 409.
- Running services hold shared advisory maintenance locks. Import and key rotation require the exclusive lock and refuse active services. Direct database sessions and external maintenance tools must still be controlled operationally.

## Decimal contract

PostgreSQL schema 11 uses `NUMERIC(38,18)` for monetary and quantity columns. `decimal.js` performs arithmetic; PostgreSQL NUMERIC values and API money outputs stay strings. Counts, timestamps and displayed ratios remain numbers. Send money as JSON strings to preserve all digits; numeric input cannot recover precision already lost by the sender.

- Input money supports up to 18 fractional digits and absolute values below `10^20`; larger or non-finite values fail closed.
- Automatic quantities round down to 18 places; cash multiplication rounds half-even to 18 places. No floating-point epsilon permits cash overdrafts.
- Position cost is stored separately from rounded average price. Exact fill quote amounts drive cash and FIFO costs. The last partial exit consumes the exact remaining cost.
- Risk UI sends monetary settings and preview prices as strings when the API advertises `moneyFormat=decimal-string`. SQLite retains its previous numeric contract. Browser charts round only for presentation.
- USDT and THB remain separate by bot and broker. Paper book equity is cost-based, not mark-to-market. Fills still do not simulate trading fees; custom fees affect analytics only.

### Legacy precision

Import first backs up SQLite using `scripts/backup.mjs`, checks schema 10, integrity and foreign keys, and requires an empty PostgreSQL target. Every non-transient source row is verified by a canonical row hash after copying. IDs, hashes, ciphertext, policies and history are preserved. Identity sequences are reseeded. Sessions, login/reset challenges, reset mail and rate-limit rows are deliberately not copied; MFA enrollment and unused recovery codes remain.

SQLite REAL values may contain more than 18 fractional digits. Import rejects these by default. After reviewing the rehearsal report, an operator may explicitly pass `--round-legacy-to-18`; the report lists counts and maximum absolute change per column. This rounds to the declared decimal contract, not to cents. Never claim the original REAL data had arbitrary decimal precision. The source backup remains authoritative.

Imported fills carry `legacy_float=1`. FIFO may normalize a near-flat quantity difference of at most `0.000000000001` asset units only for a cycle containing imported fills. API metadata `legacyPrecisionAdjustments` records each adjustment and the UI shows a legacy precision notice. This changes analytics matching only, **not recorded fills, cash, execution limits or native PostgreSQL cycles**. Larger differences fail closed and require reconciliation. Existing unfinished cycles can retain legacy provenance until flat.

Imported PROCESSING/SUBMITTED/PARTIALLY_FILLED orders are quarantined as UNKNOWN, never replayed automatically. Negative reconstructed cash is reported. Do not activate a target with unexplained reconciliation warnings.

## Isolated setup

Requirements: Node.js 24+, PostgreSQL 16+, and compatible `pg_dump`/`pg_restore` for operator tools and integration tests. Keep PostgreSQL on a private network or Unix socket. Use certificate-verified TLS for a remote database; do not disable certificate checking.

```sh
npm ci
npm test
# Use a dedicated test cluster/account with CREATEDB and CREATEROLE. Never use production credentials.
TEST_DATABASE_URL=postgresql://test_user:TEST_PASSWORD@127.0.0.1:5432/test_control npm run test:postgres
```

For a fresh private instance, set `DATABASE_URL`, the unchanged required encryption configuration, `PUBLIC_ORIGIN` and Paper mode in the protected environment. Initialize offline before starting either service:

```sh
node --env-file=.env scripts/migrate-postgres.mjs
npm run start:postgres
# In a second terminal/process:
npm run worker:postgres
```

For an existing SQLite service, use the import instead of bootstrapping an empty customer database:

```sh
node --env-file=.env scripts/import-postgres.mjs /absolute/schema10.db /absolute/new-verified-copy.db
# Only after reviewing the precision report, repeat into a NEW EMPTY target if necessary:
node --env-file=.env scripts/import-postgres.mjs /absolute/schema10.db /absolute/another-new-copy.db --round-legacy-to-18
```

`compose.postgres.yaml` is a separate private development example, not an override for `compose.yaml`. Set `POSTGRES_PASSWORD` and a matching URL using host `postgres`, port 5432 and database `robot` in `.env`. Initialize with `docker compose -f compose.postgres.yaml run --rm api node scripts/migrate-postgres.mjs`, then start API and worker. The database has no published port; API binds host loopback. Do not use the example's owner credential as a commercial runtime credential.

For production, provision a schema-owner/migration role and a separate `robot_app` LOGIN role with NOSUPERUSER, NOCREATEDB and NOCREATEROLE. Set its password using a secure operator prompt, not shell history. After import, apply `scripts/grant-postgres-runtime.sql` as the owner and use the runtime credential for API/worker. Neither service runs DDL at startup. Keep test cluster credentials separate; production runtime must not be able to create/drop databases.

`PG_POOL_SIZE` defaults to 5 per process; one connection holds the session-level maintenance lock. Each process also has a pool of at most 2 for durable attempt/session updates, so budget up to **7 connections per process**, plus migration, backup, monitoring and admin headroom. Runtime pool minimum is 2. Use direct PostgreSQL or session pooling; transaction-mode PgBouncer is incompatible with the session advisory lock. Do not increase replicas without measuring queue delay, locks and connection utilization.

## Backup, restore and rotation

```sh
node --env-file=.env scripts/backup-postgres.mjs /absolute/new-backup.dump
```

The custom archive is created with exclusive file creation, restrictive permissions, size and SHA-256 output. Keep backups encrypted off-host, with the matching release and encryption keys protected separately. A local dump alone is not disaster recovery or PITR. Test restore into an empty isolated database using `pg_restore --exit-on-error --no-owner`; verify row counts/hashes, constraints, sequences and decryptability before accepting it. PostgreSQL client programs obtain passwords from protected environment/passfiles, never inline command arguments.

For encryption rotation, stop **all** PostgreSQL APIs/workers and use `scripts/rotate-postgres-key.mjs /absolute/new-pre-rotation.dump` with the existing keyring plus `NEW_ENCRYPTION_KEY` and a new `NEW_ENCRYPTION_KEY_ID` in a protected environment. The script takes a backup and rewrites all bound credentials, webhook secrets, MFA secrets and recovery mail atomically. Unreadable data rolls the entire rotation back. Update service keys before restart; preserve old keys with old backups. The SQLite rotation script must not be used on PostgreSQL.

Emergency password reset also has a PostgreSQL-specific operator script: stop API/worker, take a backup, supply `RESET_EMAIL` and `RESET_PASSWORD` through a protected environment, then run `scripts/reset-postgres-password.mjs`. It revokes sessions/recovery links but preserves MFA; it is not an MFA bypass. Remove the temporary password environment afterward. Do not use SQLite operator scripts for a PostgreSQL service.

## Production cutover gate and immutable releases

1. Provision persistent, supervised PostgreSQL and separate roles, storage monitoring, scheduled off-host backups and a tested restore path. The temporary QA cluster is **not** a production database.
2. Build a new immutable release directory from a reviewed commit and `npm ci --omit=dev`. Keep the previous revision and protected configuration.
3. Rehearse import/restore on a verified copy. Review numeric rounding, negative cash, UNKNOWN orders, all owner/bot IDs, currencies, encrypted secrets and analytics. Do not run the mail/execution worker against copied production data during rehearsal.
4. Schedule a maintenance window. Pause webhook ingress and stop the SQLite service. Kill switch alone is insufficient because it permits exits. Confirm the old writer stopped, then take the final backup and import into a fresh PostgreSQL target.
5. Apply runtime grants, retain the same master key and public webhook URLs, and configure distinct supervised API/worker services using the immutable `current` release path. Never start the old SQLite writer concurrently.
6. Atomically swap the `current` symlink, start PostgreSQL worker and API, check `/healthz`, authentication/MFA, risk, logs and analytics, then restore ingress. In-flight old sessions are revoked. Check queue age and worker heartbeats; health fails closed after 30 seconds without a worker tick or when the oldest queued job exceeds five minutes.
7. Before accepting new PostgreSQL writes, rollback may restore the old release/config/SQLite backup with ingress paused. **After new PostgreSQL writes, switching back to the old SQLite file loses data.** Freeze both writers and reconcile/export the delta or restore a consistent PostgreSQL backup with a compatible release. There is no automatic reverse migration.

## Verification record

- Windows: 89 existing/regression/UI tests pass (88 previous plus one decimal-form test).
- Isolated PostgreSQL 16.15 on the VPS: 15 integration tests pass, covering concurrent duplicates, four independent OS workers, SIGKILL before commit, exact cash boundaries, partial fills/cost allocation, five-bot quota, ownership, funding reservations, suspension/staleness, mail leases, FIFO/MDD, HTTP MFA/CSRF/reset, offline maintenance, import rollback, full dump/restore row hashes and key-rotation rollback.
- Production-copy rehearsal: 3 users/bots, 525 signals, 151 fills, 151 cash-journal rows and 12 funding rows copied; 4 encrypted webhook/MFA records decrypt; 67 closed cycles calculate. No negative cash or interrupted orders in that snapshot. Reviewed rounding affects 29 field values, each by less than `5e-19`. This is a point-in-time rehearsal, not a production migration.
- Chrome via a private SSH tunnel: 1440×900 Desktop and 390×844 Mobile. Login, session reload, Risk preview/save, Analytics values/charts, EN/TH and mobile navigation passed. No horizontal document overflow, invalid chart coordinates or relevant console errors. A hidden-user-selector CSS issue and stale language legend were fixed during QA. Screenshots are outside the repository.
- GitHub Actions [Safety checks #24](https://github.com/sanchatmd-dev/trading-bot/actions/runs/35269699025) passed for 639fe80: Linux/Windows tests, PostgreSQL integration and container build. Verified in the GitHub UI on 2026-09-18; connector run/status results were empty and did not reflect the visible run. Four non-failing annotations concern action runtime deprecation. Docker/Compose startup, sustained load, failover, physical iOS/Android, Safari and independent security review remain separate acceptance work.
- Final local checks: 69 JavaScript modules pass syntax checks, `git diff --check` passes and `npm audit --omit=dev` reports zero known production dependency vulnerabilities. Production cutover imported 3 users, 534 signals and 151 fills with zero interrupted orders and negative-cash accounts. PostgreSQL is supervised and Unix-socket-only; the API and worker use the restricted `robot_app` role. Pre-import SQLite and post-import PostgreSQL backups were verified. Service restart and HTTPS health checks passed at v2.2.0/PAPER_ONLY with an empty queue; no production test trades were submitted.

## Capacity limitations

Acceptance follow-up on 2026-09-18 restored a fresh production snapshot into a separate temporary database: all 27 table row fingerprints matched, including 539 signals and 151 fills/cash rows; four encrypted records decrypted and schema 11 verified. The temporary database was removed and the verified archive/report retained under shared/backups (see Context.md). This establishes same-VPS database restore only. Production Overview/Analytics and session restoration were observed in Chrome. The owner completed a fresh login; a new unexpired session created at 03:35:08.838 Asia/Bangkok had mfa_verified=1, and the authenticated Overview rendered successfully. The owner deferred automatic off-host backups until after the final project because no destination is available; no schedule or off-host copy was configured.

Four-worker correctness is not a throughput SLA. Queue admission remains globally bounded at 1,000 unfinished orders with a short intake lock. One owner's bots execute serially. Analytics currently scans that bot/broker's complete fill history; add measured indexes, incremental aggregation/caching and pagination before large commercial history. Off-host backups/PITR, HA, billing, abuse controls and broker-certified Live adapters are not delivered by this phase.

Implementation follows [node-postgres transaction guidance](https://node-postgres.com/features/transactions), [PostgreSQL locking semantics](https://www.postgresql.org/docs/current/explicit-locking.html) and the [decimal.js arithmetic API](https://mikemcl.github.io/decimal.js/).
