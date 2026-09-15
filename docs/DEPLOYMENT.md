# Deployment and recovery — v2.1 Paper staging

## Deployment decision

- Private Paper staging: supported, subject to the checks below.
- Internet-facing multi-user service: not signed off.
- Live trading: hard-disabled. Do not remove the gate as an operational workaround.
- Existing exchange orders/positions: v2.1 does not cancel or protect them. Manage them directly with the broker before upgrading.

## Upgrade from v2.0

1. Stop webhook delivery and the old bot. Check actual open orders/positions directly at each broker.
2. Take a consistent backup and save the exact old application revision and configuration. Preserve the encryption key separately.
3. Rehearse migration on a COPY of that backup in an isolated Paper environment first.
4. v2.1 migrates schema version 0 to 3 in a transaction. Existing signals are labelled LEGACY. Legacy queued signals are rejected; PROCESSING becomes UNKNOWN.
5. Old `positions` and `daily_stats` tables are preserved, not imported into Paper/Live ledgers. The mode of historical data cannot be inferred safely. New simulated positions begin empty.
6. UNKNOWN outcomes are never resent automatically and block new orders for the affected user/Broker. Review using broker statements. No production manual-reconciliation UI or balance-import endpoint is shipped yet.
7. Re-enter credentials only if needed for recovery. Old encrypted credentials without tenant binding are intentionally rejected by the new recovery path.
8. Confirm schema version, users, secrets, historical logs, simulated positions, queue health and ability to log in before resuming Paper signals.

Never run two bot processes against the same DB. A separate SQLite lifetime lock prevents competing server instances and releases on process crash. Do not delete its file to bypass an active lock.

## Backups and restore drill

Local backup, with `DB_PATH` pointing to the intended database:

```sh
node scripts/backup.mjs /absolute/new-snapshot.db
```

The script uses a consistent SQLite snapshot, refuses overwrite, restricts file permissions where supported, and runs `integrity_check`.
Container deployment: `sh scripts/backup.sh`. Each attempt uses a fresh temporary directory; failed snapshots are retained for diagnosis.

Restore drill:

1. Stop the target application; never replace a DB that is open, including its WAL/SHM sidecars.
2. Copy the backup to a NEW directory, without copying sidecars or the instance-lock file.
3. Start an isolated instance using that new DB path and the matching encryption key, localhost binding, Paper-only mode and SMTP disabled.
4. Verify integrity, schema version, users, historical logs, fill counts, positions, and successful credential decryption with the matching tenant context.
5. Run a fresh simulated BUY/SL cycle and duplicate replay; confirm no duplicate fill and no outbound order submission.
6. Keep encrypted off-host backups and test this procedure periodically. Automated snapshot/restore tests do not replace a VPS disaster-recovery drill.

Rollback requires a pre-upgrade database snapshot **and** the matching old application revision. Do not run v2.0 against the migrated live database. Reverting to the old revision also reintroduces the reviewed safety defects; keep it offline/Paper.

## Monitoring

- `/healthz`: DB readable, worker heartbeat <30 seconds, oldest queued job <5 minutes. Returns 503 when unhealthy.
- Inspect UNKNOWN orders immediately. Health does not certify broker positions or exit protection.
- Inspect `notification_outbox` for FAILED/DISABLED messages; SMTP failures do not fail an order.
- Watch queue age/depth, disk space, SQLite errors, rejected signals, login failures and backup age.
- Docker log files rotate at 10 MB × 3. Database/audit retention is manual; no automatic deletion of trade history.
- Graceful shutdown awaits active worker and SMTP tasks. Forced kill remains recoverable through UNKNOWN, not resend.
- HTTP limits: 64 KiB JSON, 240 requests/minute per client, 20 login attempts/15 minutes, queue cap 1000 unresolved/queued orders. Set `TRUST_LOOPBACK_PROXY=true` only when the app listens on loopback behind a same-host proxy; it uses the right-most forwarded hop.
- Application request timeout 15 seconds; SMTP attempt timeout 20 seconds. Tune only after load tests.

## Required before public staging

- Deploy and verify HTTPS with the intended domain; restrict UI/Admin access using VPN or reverse-proxy access policy while exposing only the webhook route as required.
- Test proxy request/body/connection limits, trusted proxy IP handling, concurrent logins, burst delivery and disk-full behavior.
- Verify SMTP delivery with the actual provider, database migration on a representative backup, restore on another host and container startup/shutdown.
- Pin reviewed container image digests and CI action revisions in the deployment environment; tags in this development Compose/CI remain moving tags.
- Configure external uptime/disk/queue/backup alerts and document who responds.
- Review authentication, session storage and administration controls; add MFA before wider use.

## Required before Live release

1. Broker-specific verified adapters with explicit capabilities. MT5/Settrade/InnovestX bridges are not implemented by this release.
2. Authoritative account balances/equity and fresh market prices, asset/quote/currency identity, decimal step-size filters and reserved funds.
3. Native SL/TP or an explicitly tested protective mechanism that remains effective during VPS/TradingView failure; no bare entry without verified protection.
4. Persistent execution intents, lookup by namespaced client order ID, UNKNOWN handling, fee-aware fills and reconciliation of external/manual trades.
5. Tested cancel-pending and close-position workflows, separate from pause-entries. Expired licenses must not strand protective management; suspended-account policy needs an operator procedure.
6. Contract/sandbox tests for timeout-after-accept, duplicate webhook, restart-after-fill, partial fills, cancellation, rejected orders, rate limits, precision and credential rotation.
7. Test staged activation and rollback with a human-approved checklist. Do not make Live a freely toggled profile field.

## Validation scope for this change

Tests cover risk bypasses, partial-fill accounting, atomic rollback, restart quarantine, immutable mode, pending reservations, tenant-bound encryption, session revocation, rate/body limits, migration, backup restore, process locking, and HTTP authentication/webhooks.
They do not establish real broker integration, exchange SL/TP behavior, live market/fee accuracy, actual SMTP provider delivery, VPS Docker runtime readiness or production load capacity.
