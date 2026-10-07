# PF-2 staging acceptance packet

## Current execution amendment — 2026-10-01

The owner accepts staging downtime and the mode/database/privilege/admission
effects and authorizes Codex continuation with checkpoint commits/pushes.
Execution may be delegated to the one root-designated operations agent; this
supersedes the owner-typed-host-steps restriction in the original packet below.
The root records the existing owner authority at each bounded dispatch; the
accepted choices do not need to be requested again.

B1 passed one supervised staging run and read-only reconciliation at 11:08 UTC.
Research admission is now disabled at the API; the legacy research worker is
active and idle with physical 512 KiB/s read/write limits. Foundation/V2/
enrollment/preflight remain off. Its transient unit must not be deliberately
stopped until B2 has reviewed recoverable definitions. B2 preparation is next;
no foundation migration, BACKFILL or W7 attempt has occurred.

Do not execute the original packet directly on the currently observed host.
The [prerequisite checkpoint](PF2_W7_PREREQUISITE_CHECKPOINT_2026-10-01.md)
records missing foundation data, the now-established B1 physical controls, a different runtime
role, different code roots per service, and Node argument-loaded environment
files instead of the assumed systemd EnvironmentFile arrangement. Establish
reviewed per-service rollback/configuration evidence and complete separate
bootstrap gates before W7 re-entry. The original G1 record is not complete.
The release for these steps is the one that carries the held branches (CX-A
research-chunk readiness and CX-B PF-2 backlog, including the hardened grant
script); the release record names its commit. One attempt per case, Spot/Paper-only
and the separate D6/R7 gates remain unchanged. The sections below retain the audited
procedure and historical preparation status, subject to this amendment.

## Original preparation record

Status: prepared locally; not executed or approved as a release. The W7 diagnostic
enqueue helper is ready for the release record (reviewed, fixed and pushed in
`e6f0dff`; unchanged at `28d6f7e`, the planned release commit, whose later
commits touched tests and CI only). CI passed 9/9 at `28d6f7e`, including the
PostgreSQL job and the Windows and Ubuntu jobs. Two independent audits of
this packet and of the owner-run W7 packet returned "go with fixes"; revision 2
of the owner packet applies the fixes. The re-audit of revision 2 found no High
item; revision 3 applied its fixes and the same auditor closed the audit gate.
The release record and the owner GO must still be completed before execution.
This packet does not certify the current server state.

Execution requires the reviewed release to be pushed and its required CI checks
to pass. Preparing this packet does not supply commit/push authorization.

The owner requested PF-2 API activation on staging after acceptance. Scope is
10,000 raw BTCUSDT Spot 1m bars including warm-up, Paper only. The earliest
registered same-owner sibling holdout boundary applies. Production, Live,
capacity expansion and automatic retry remain outside this packet.

## Release and operating record

Before execution, record the reviewed release revision, clean release manifest,
host-derived ingestion/foundation/PF-2 engine hashes, capacity-policy hash,
existing staging service identities and configuration fingerprints, and the
commit of the previous staging release (the rollback target). Do not copy
credentials or host locations into this document. Commit/push of the release and
successful CI are separate facts; record each.

The owner runs every host step; agents prepare locally only. Each case has its
own job ID, deadline, log destination and stop plan. One attempt per case; a
failed case does not authorize a retry. Preserve the failure and review its
cause first.

The owner authorizes each mutating effect by name before execution: new release
code on all three staging services; dependency installation with network access
(package scripts disabled); the offline schema installation (additive and not
reversible) and, where it applies, the executor-mode switch; the runtime grant
script below, which now carries the DELETE revoke; the recovery and capacity policy rewrites;
the worker unit drop-in; the two immutable diagnostic job rows; the staging
downtime and the period with API admission off; and a rollback that is argued
statically, not rehearsed. The owner records a GO time before the drain, before
the schema installation and before each job write.

Build the release from git blob bytes. Two traps were confirmed locally:

- On a Windows checkout, `git archive` writes CRLF files even with
  `core.autocrlf=false`, because `.gitattributes` sets `text=auto` and the native
  line ending applies. Only `-c core.autocrlf=false -c core.eol=lf` (or
  `core.autocrlf=input`) gives LF bytes.
- `.gitattributes` marks `quant_lab/**` as `export-ignore`, so `git archive` leaves
  out all 63 `quant_lab` files. The ingestion and foundation engine hashes include
  24 of them, so such a release cannot compute its engine hash, and the helper and
  the worker then refuse every V2 PROFILE.

Export every tracked file from its blob instead, reject an archive whose file
list differs from the tracked-file list (no extra, missing or linked entry), and
verify every file's blob hash on the host. Install dependencies with
`npm ci --omit=dev --ignore-scripts`; no dependency at the release commit has an
install script. Expected engine hashes come from blob bytes, never from a Windows
working tree: compute them with the product hash functions inside the exported
tree, so the file lists and the bytes both come from the commit. At `e6f0dff` and
`28d6f7e` the ingestion engine hash is
`d7097b8a6162cde1ed1d8ea20150f7d2adba5a300e440e9bfa9d9c5e474eebce` (79 files) and
the foundation engine hash is
`d865692f5ed6685ba41ae9226baa005ab4c23b19006d0772816a0254300cd6b9` (78 files),
while the local working tree gives different values. Recompute both at the final
release commit; the host-derived values must equal them.

### W7 diagnostic enqueue helper

- Path `scripts/enqueue-quant-profile-diagnostic.mjs`. At `e6f0dff` and
  `28d6f7e` its LF bytes have SHA-256
  `3e8d7e2ea8d8cfb2f5dc15b72d62697fd6c1ab7d9661f434120af005b5f0bdee`
  and git blob `01907d4d3f543b152c34600563ac975d045e8c2d`. These are commit values.
  Recompute both on the host from the deployed file at the reviewed release
  commit; a mismatch blocks execution. The idle check
  `scripts/check-quant-foundation-idle.mjs` has SHA-256
  `f43ce0fae8fcc230b5117ca822040cffb5e5ffe192c2507f718aa2d8084f9771` and blob
  `2d75b2f1a778f8cc49e873a70e0559002ee258f2` at the same commits.
- Review: the architecture review accepted the helper with fixes. The fix round
  moved the idle gate before the raw, deployment, contract and authority work,
  bounded the scheduler table lock wait to 1,000 ms (refusal
  `QUANT_DIAGNOSTIC_LOCK_TIMEOUT`), prints one redacted line on a crash, resolves
  a start through a symbolic link in both scripts, hardens the request-file
  checks and adds a `sqlstate` output key. Root verification passed: focused unit
  tests with two Linux-only skips, the PostgreSQL helper file 14/14 and the
  migration file 9/9. The Linux file-permission tests run only on Linux CI and
  passed there at `28d6f7e`.
- Output: exactly one JSON line with a fixed, sorted key set on standard output;
  exit 0 for a plan or an enqueue, 2 for a refusal. The line never holds paths,
  hosts, database URLs, SQL or error messages. `sqlstate` is null except for a
  server fault (`QUANT_DIAGNOSTIC_FAILED`), where it holds only the five-character
  code: 40001 means run the same command again, 42501 means a missing grant. A
  gate refusal has null contract and engine hashes because the gate runs before
  the contract is built.
- Invocation: from the canonical release path, not through a link; with the same
  private environment files, database role and capacity policy file as the
  dedicated worker; with the enrollment and preflight flags `0`; as the runtime
  role, never the migration owner. The worker must be stopped and API admission
  off while the helper runs.
- Dry run (the default, always rolled back): keep the whole line. Require
  `ok:true`, outcome `WOULD_ENQUEUE`, `policy_hash` equal to the recorded policy
  hash, `engine_hash` equal to the host-derived ingestion engine hash, `raw_bars`
  at most 10,000, `claim_window_ms` 825,000 (a 900,000 ms budget minus
  `runtime_max_ms` 70,000 and the 5,000 ms margin), `completion_mode` null and
  `evaluator_admission` false.
- Write: `--enqueue --expect-contract-hash=<contract_hash of the dry run>` must
  give outcome `ENQUEUED` and status `QUEUED`; record the job ID. The worker must
  claim the job before its deadline minus 75 seconds, that is within
  `claim_window_ms` of the write.
- A write that reports `QUANT_DIAGNOSTIC_FAILED` with no `sqlstate` or 40001,
  exits with another code or prints no line may still have committed. Run the
  identical command once more before anything else: `EXISTING` returns the job,
  `ENQUEUED` creates it. That rerun is an idempotent read of the same request, not
  a case retry. Any other refusal stops the packet.
- Never run the helper, not even a dry run, while a job is running or stopping
  or a launch or ledger operation is unresolved: its table lock would queue the
  bounded terminal commit of the worker.

Request-file rules: the request is a private file selecting existing records
only, with exactly the five fields `owner_id`, `bot_id`, `raw_job_id`,
`deployment_id` and `idempotency_key`. Its path is absolute and canonical with no
symbolic link. The file is regular, has one link, is owned by the running user,
grants nothing to group or other (mode 0600) and is at most 16,384 bytes. Every
directory above it must belong to the running user or to root and must not be
writable by group or other. A shared temporary directory such as `/tmp` is
therefore refused. Use a fresh idempotency key for every case.

## Offline prerequisites

1. Accept E1–E4, W1–W6, R5/R6 and independent accounting review. Preserve the
   earlier FTR-1c-INT measured result as historical evidence; it does not replace
   W7 on the new release.
2. Stop admission and the dedicated staging research worker using the existing
   controlled procedure. Confirm actual processes and transient units have
   stopped. The offline installer takes the database maintenance lock, so every
   API and worker process that holds the staging database runtime lock must stop
   for the installation: the staging API, the staging trading worker and the
   research worker. Production services stay unchanged. If staging capture runs
   inside the staging API, capture pauses during this window; the owner accepts
   that before the packet starts.
3. Run `scripts/check-quant-foundation-idle.mjs` from the canonical release path
   with the private staging environment. Require its single JSON line with
   `"ok":true` and an empty `codes` list. The exit code alone is not evidence: an
   earlier version printed nothing and exited 0 when started through a link.
   `ok:true` covers running and stopping jobs, unresolved launches and unresolved
   or invalid ledger operations only. Queued and paused V2 jobs appear in
   `queuedPolicies`, and V1 queued jobs do not appear at all. W7 needs an empty
   queue, so also require an empty `queuedPolicies` list and no queued or paused
   foundation or legacy research job. Before the offline installation, a database
   without the I/O tables makes the check refuse with `QUANT_IDLE_SCHEMA_REQUIRED`;
   there the pre-migration idle evidence is an empty foundation queue (no queued,
   paused, running or stopping job) and an empty legacy queue, because no launch
   or ledger row can exist without those tables. After the installation the full
   idle line is required. This read-only snapshot is not a lock: keep admission
   disabled throughout installation. Review queued/paused policy hashes; cancel
   stale jobs through supported controls, never rewrite immutable contracts.
4. Before any step with owner credentials, prove that the owner environment and
   the owner database client reach the same database as the runtime role (equal
   database name, port and server start time); stop on a mismatch. Because the
   installation cannot be undone, also confirm before it that the owner database
   client is psql 10 or later and that the operator has the staging runtime role
   name for the psql variable `runtime_role`. Back up the
   database/configuration under the existing staging procedure.
   Run `node scripts/migrate-quant-foundation.mjs --mode=FOUNDATION` offline with
   the schema owner and the reviewed dataset root. The installer has its own idle
   gates (`QUANT_FOUNDATION_NOT_IDLE`, `QUANT_IO_NOT_IDLE` and the executor-mode
   change trigger) and refuses while any process holds the runtime lock. Require
   its success line and the schema assertions, including enrollment receipt
   immutability and the I/O release guard. Do not install extensions from an API
   request. If the staging database is in LEGACY mode today, `--mode=FOUNDATION`
   is a staging executor switch, which needs its own owner authorization
   (heavy-path decision O1) recorded before execution. In FOUNDATION mode the staging
   API answers 409 on the legacy backtest, optimizer and analytics routes until a
   rollback restores LEGACY. Binding storage to a
   database without a storage namespace requires an empty dataset root; if a
   failed installation leaves only the storage marker file in an otherwise empty
   root with no namespace row, only a separate root-authorized step may move that
   file aside. Record the runtime role's current DELETE grants on the ten tables
   named below. Then, before any runtime-role read of the new tables, reapply the
   runtime grant script as the schema owner:
   `psql -v ON_ERROR_STOP=1 -v runtime_role=<staging runtime role> -f scripts/grant-postgres-runtime.sql`.
   The role comes only from that variable; there is no default, so a missing
   variable or an unknown role stops the script before any change. The script is
   one transaction that first tries the product's maintenance lock
   (`robot:maintenance`, the lock of migration, restore and key rotation) and
   fails at once, without waiting, while any API or worker holds the database.
   The DELETE revoke is now in the script: it grants DELETE only on tables other
   than the foundation job, owner and scheduler tables, the legacy job and
   research chunk tables, both I/O tables, the enrollment receipts, the storage
   namespace and the executor mode; it revokes DELETE on those ten to clear older
   grants; and before COMMIT it checks that the runtime role cannot DELETE from
   any of them, so the result does not depend on statement order or on earlier
   grants. The same final check refuses to commit while the runtime role can
   INSERT, UPDATE or DELETE on the read-only version and provenance tables,
   including through PUBLIC or another role. SELECT, INSERT and UPDATE stay: no runtime statement deletes from
   these tables. Rollback caveat: copies of the grant script from before this
   change grant DELETE on every table. After any rollback that reapplies such a
   copy, reapply this script, or restore exactly the DELETE grants recorded
   above.
5. `LOCK TABLE ... IN EXCLUSIVE MODE` needs table-level UPDATE, DELETE or
   TRUNCATE privilege, or ownership; column grants do not count. The helper locks
   the scheduler table, the worker claim updates it and enrollment completion
   (R7) locks it as well. Before W7 record, as the runtime role,
   `has_table_privilege(current_user, 'quant_foundation_scheduler', 'UPDATE')` =
   true, and table-level SELECT, INSERT and UPDATE on the foundation job and owner
   tables and on both I/O tables. A missing privilege fails closed as
   `QUANT_DIAGNOSTIC_FAILED` with `sqlstate` 42501. After the DELETE revoke,
   UPDATE alone carries these locks. The script already refuses to commit if
   DELETE remains on any of the ten tables; still record DELETE false on them as
   the runtime role.
6. Verify the real release root, storage binding, block-device identity, free
   space, cgroup delegation, I/O controls and current health. The dataset root
   must be on ext4. The host-derived drain need is 2,000 ms plus the dirty-expire
   interval plus twice the writeback interval plus 3,000 ms; it must not exceed
   45,000 ms. The recorded 30 s and 5 s intervals give exactly 45,000 ms, so there
   is no margin. Recheck the filesystem and commit-age bound in the real terminal
   path. Root-approved host thresholds: at least 20 GiB free on the dataset
   filesystem, at least 4 GiB available memory and a one-minute load below 1.0,
   checked before the drain and again before each case.
7. Swap host fact: a drained child unit requests `MemorySwapMax=0`, and at ready
   the launcher requires `memory.swap.max` of the child cgroup to read `0`; on a
   kernel without swap accounting it requires `SwapTotal: 0 kB` instead. Anything
   else fails closed. Record `SwapTotal` and whether swap accounting exists. The
   host had no swap in the 2026-09-29 health check and during FTR-1c-INT. A host
   with swap but without swap accounting blocks W7.
8. Pin the terminal policy to `runtime_max_ms=70000`, `terminal_drain_ms=45000`,
   `tail_margin_ms=5000` in the reviewed capacity policy (70,000 is above the
   60,000 ms sum of the terminal budget, drain, spawn margin and tail margin),
   provided the current host gates accept it. Record the policy file digest and
   the policy hash. A different host requirement blocks this packet; do not
   silently shorten it.
9. Worker unit policy: `TimeoutStopSec=90` and `KillMode=mixed` (owner decision
   OD-C, approved 2026-09-30, host edit only inside the W7 packet), plus
   `Restart=no` for the W7 window (no automatic restart inside a case; the owner
   approves it with the unit drop-in); record the actual readback
   (`TimeoutStopUSec=1min 30s`, `KillMode=mixed`, `Restart=no`). With the
   PROFILE V2 flag on, the worker refuses to start unless `KillMode` is exactly
   `mixed` and the stop timeout is at least 90 s. With the flag off it requires
   `control-group`. Change and revert the unit policy, the restart setting and the
   flag together.

The private environment must identify real reviewed policy, recovery, health and
I/O control files. Startup checks require `QUANT_CAPACITY_POLICY_FILE`,
`QUANT_RECOVERY_POLICY_FILE`, `QUANT_HEALTH_RECOVERY_FILE` and
`QUANT_IO_CONTROLS_FILE`. The running worker must already use the reviewed I/O
controls file, and its cgroup `io.max` must carry the reviewed main rates before the
offline window: the worker checks this at startup, so a gap would otherwise show only
after the irreversible steps. Verify the existing `QUANT_HEALTH_LIMITS_FILE`,
`QUANT_HEALTH_URL`, `QUANT_WORKER_UNIT` and `QUANT_RESEARCH_DATASET_ROOT` values,
the release/storage bindings of the recovery policy, the absolute Python
interpreter and `PG_POOL_SIZE` absent (default 5) or at least 4: a running PROFILE V2
job holds the runtime lock, an observe transaction and the tick heartbeat transaction,
and health recovery needs one more connection for its probe. The helper also
requires `PINE_BRIDGE_ENABLED=1`, `QUANT_RESEARCH_ENABLED=1`,
`QUANT_RESEARCH_FOUNDATION_ENABLED=1` and `QUANT_STORAGE_LIMITS_FILE` in the
environment it loads. The recovery policy names the new release root, which must
be a real path. The minimum healthy period of the health recovery policy must lie
between 1,000 and 60,000 ms (the code bound). Its maximum sample gap (5,000 ms when
absent) must be at least 10,000 ms, because the release health check reuses the claim
admission gate. The minimum healthy period must also let the restarted worker
claim inside the claim window: start the worker only while the time left before
the claim deadline exceeds that period plus two minutes. These are checks of
reviewed staging configuration, not instructions to invent replacement values.
Never use the Windows test loader, synthetic policy,
synthetic telemetry, receipt fixtures or source-hash overrides on staging.

## W7: product Linux proof

Use the diagnostic PROFILE mode first: `QUANT_PROFILE_V2_ENABLED=1`,
`QUANT_PROFILE_V2_ENROLLMENT_ENABLED=0`, `QUANT_PREFLIGHT_ENABLED=0`, together
with `PINE_BRIDGE_ENV=staging`, `PAPER_TRADING=true`, `PINE_BRIDGE_ENABLED=1`,
`QUANT_RESEARCH_ENABLED=1` and `QUANT_RESEARCH_FOUNDATION_ENABLED=1` in the worker
and helper environment. The diagnostic result remains CANCELLED with null SQL
result. The public V1 PROFILE route cannot enqueue this case. The reviewed
owner-only diagnostic enqueue helper (see the release record) creates the
unmarked V2 contract from trusted raw/deployment records. It needs an existing
SUCCEEDED BACKFILL raw job of the same owner and bot with at most 10,000 bars
including warm-up, and a READY, fresh deployment. If no such raw job exists, a
separate bounded BACKFILL step must come first. Use the smallest eligible raw job (at
least 501 raw bars): the compute window after spawn is about 13 seconds, and a
10,000-bar compute is not measured on this host. A compute deadline with safe
accounting is inconclusive, not a pass or a failure; C2 does not follow it, and a new
attempt needs a root decision.

Per case: worker stopped, API admission off, idle line `ok:true` with an empty
queue, helper dry run, helper write, worker start, observation. Keep API
admission off between enqueue and claim. C2 needs its own job: a fresh
idempotency key and its own dry run after the C1 terminal and idle check. The
contract does not include the idempotency key, so the C2 dry run must return the
C1 contract hash, and the C2 write is bound to that hash. The case watcher refuses any stop
target other than the configured research worker unit, and only one watcher
runs at a time.

| Case | Action | Required evidence |
| --- | --- | --- |
| C1 measured completion | One bounded diagnostic PROFILE through the product worker | Worker log line `MEASURED_FINAL_SETTLED`; one ledger operation, SETTLED, whose charge equals the frozen sample deltas and equals the ledger total; launch STOP_PROVEN; job CANCELLED with null result and cleared lease; released slot (idle line `ok:true` afterwards); record claim-to-ack duration from status samples and the elapsed time in the log line. |
| C2 worker stop | Stop the dedicated worker inside the terminal drain: 1,000 ms after the job is first observed STOPPING | UNKNOWN_FINAL_CHARGED once (one operation; ledger total equals its charge), STOP_PROVEN, CANCELLED; the stop completes before 90 seconds with no SIGKILL or timeout of the worker main process; after the worker restarts, no RUNNING or STOPPING job, and the C1 and C2 evidence lines are unchanged after the restart and after the delayed postflight. |
| C3 supervision observation | Observe C1/C2 | Actual stop timeout, KillMode and restart setting, systemd-run client exit and helper termination evidence; the journal must show the service manager's stop lines, otherwise the case is inconclusive. |
| C5 idle observation | Before and after each case | The idle line `ok:true` with empty `codes` and an empty queue; coherent job/launch/ledger state; unchanged unrelated service identities and healthy postflight. |

Root fixed the C2 delay at 1,000 ms after the job is first observed STOPPING: the
only measured drain on this host (FTR-1c-INT) took 2,580 ms within a 5,202 ms
terminal, so the earlier offset of 10 seconds after terminal start would probably
land after the terminal had finished. A stop that lands after the terminal is
LATE: inconclusive, not a pass, and not retried without a root decision. A job
still STOPPING after the restart fails C2 and goes to root for offline recovery.

No heartbeat after cancellation has no direct Linux observable. Record instead
that the lease is cleared from the first STOPPING sample on and that the worker
logged no cycle failure; the direct proof is the local worker test.

The optional C4 SIGKILL case is not automatically added to this packet. A lost or
double charge, mismatched delta, unresolved stop or slot, or unexpected worker
SIGKILL fails acceptance. A safe fallback is not a measured-completion pass.

## D6 and the gate it blocks

D6 is the Linux measurement of the enrollment prepare and BEGIN cost (p99 under
contention), which sets the reserve a marked job needs before its terminal. It
applies to marked enrollment jobs only. The PROFILE V2 runtime
(`src/postgres/quant-profile-runtime-v2.js`) marks a job only when its contract
carries `completion_mode: 'pf2-enrollment-v1'`. Only a marked job runs the
enrollment prepare (strict validation, executable-closure hash, ticket) and the
SERIALIZABLE `beginProfileCompletion` transaction between the accepted frame and
the terminal; an unmarked job goes straight to the cancellation terminal. The
accepted enrollment contract keeps an absent `completion_mode` as the unchanged
diagnostic path, and the W7 helper builds contracts without it and refuses one
that has it.

D6 therefore neither blocks nor is measured by the W7 cases C1 and C2. It blocks
the durable enrollment proof (R7) and with it staging activation. Before R7,
measure prepare plus BEGIN on this host under contention (API reads and cancels
holding the scheduler row, the scheduler lock wait, autovacuum, the executable
closure hash) and set the marked reserve to the measured p99 plus a margin;
below that reserve a marked job takes the diagnostic cancellation path, which
still settles measured.

## Durable enrollment and R7 API proof

After W7 passes and D6 has set the marked reserve, enable the reviewed
staging-only configuration in the API and dedicated worker:
`PINE_BRIDGE_ENV=staging`, `PAPER_TRADING=true`,
`PINE_BRIDGE_ENABLED=1`, `QUANT_RESEARCH_ENABLED=1`,
`QUANT_RESEARCH_FOUNDATION_ENABLED=1`, `QUANT_PROFILE_V2_ENABLED=1` and
`QUANT_PROFILE_V2_ENROLLMENT_ENABLED=1`. Keep `QUANT_PREFLIGHT_ENABLED=0` until
the enrollment below passes. Data admission derives from the research and
foundation flags; there is no separate `QUANT_DATA_ENABLED` flag.

Using the authenticated owner session and CSRF protection, send exactly one
`POST /api/quant/data/profile-enrollments` with a fresh idempotency key and
`{bot_id, raw_job_id, deployment_id}` referring to real authorized records.
The raw dataset must be eligible and the deployment fresh. The server creates
the enrollment contract; do not insert a success row or receipt manually.

Require the same job to have SUCCEEDED, the immutable receipt, a matching valid
result, SETTLED ledger operation, STOP_PROVEN launch, cleared worker/lease and
released slot. Validate the receipt through the product validator and retained
raw/research/ATR references. The result must retain `evaluator_admission=false`.

Enable `QUANT_PREFLIGHT_ENABLED=1` only after that evidence passes. Register the
reviewed, minute-aligned, write-once holdout boundary of the owner using
`POST /api/quant/data/holdout-boundaries`. An existing boundary is inspected,
not reset. Refuse a boundary later than the earliest sibling boundary or a
conflicting legacy holdout; never infer a boundary from test data.

Send one `POST /api/quant/data/preflights` with a fresh idempotency key and
`{bot_id, deployment_id, profile_job_id}` using the exact enrollment job above.
Observe it through `GET /api/quant/data/preflights/{job_id}`. Require successful
worker completion, a valid immutable envelope, unchanged idempotent response,
strict development-only range and `holdout_accessed=false`,
`orders_executed=false`, `evaluator_admission=false`. API-only activation does
not grant V2 evaluator parity, optimization or a Bot start.

## Failure and completion record

On any failed or ambiguous gate, disable new PF-2/enrollment admission. Use the
supported cancellation/worker-stop and offline recovery procedure for the exact
job; retain STOPPING and resource ownership until physical stop and accounting
are proven. Do not clear database flags, delete receipts or undo ledger charges
to make the gate pass. Do not roll back schema or immutable evidence blindly.
A rollback to the previous release runs only from an idle state with an empty
queue, because a release without V2 wiring cannot process a queued V2 job; it
reverts the unit policy and the flags together and keeps the additive schema and
all evidence. Before the previous release starts, check as the runtime role that
it can read both I/O tables, because the release guard runs with the rights of
the caller; if the installation committed but the grants did not run, fix the
grants first.

The rollback rests on a static compatibility statement, not on a rehearsal. The
previous release meets three schema changes: the I/O release guard acts only on
a job that has I/O launch or ledger rows, which a release without V2 wiring never
writes, and it needs the runtime role's SELECT on both I/O tables, which stays;
the stop-reason check is widened, so every earlier value still passes; and the
new tables are not read by the previous release. Record the previous release
commit, verify its files on the host, review its code for assertions on the
changed schema before execution, and after a rollback check its start, health
and logs.

Record each case's actual status, job IDs, release/policy hashes, measured
accounting, retained references, logs, health and delayed postflight. Only a
completed real R7 result plus healthy final state supports the statement
“PF-2 API enabled on staging.” Local synthetic tests cannot support it.
