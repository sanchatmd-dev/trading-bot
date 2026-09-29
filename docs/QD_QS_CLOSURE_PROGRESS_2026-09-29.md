# QD-1 / QS-1 closure implementation progress — 2026-09-29

The owner requested continuation through both engineering phases. The [phase checklist](QD_QS_PHASE_CLOSURE.md) records the remaining mandatory gates; neither phase is closed. Production and current admission remain unchanged at Spot 1m / 10K bars.

## Isolated I/O diagnostic

A new immutable staging clone retained its 120-file base manifest and replaced only the reviewed supervisor, I/O and storage modules. The unchanged Python evaluator consumed an existing 1,000-bar candidate fixture, with no new data collection, database research job or holdout evaluation.

The single diagnostic succeeded at 06:47:12 UTC in 2.526 seconds, returning checkpoint index 1,000. It retained the three-second readiness gate, CPU 50%, memory 512 MiB, 16 tasks and device read/write rates of 524,288 bytes per second. The private failure diagnostic was absent because this gate passed. This does not identify or fix the earlier actual-main `QUANT_IO_GATE_FAILED` failure.

Final checks found no runner/evaluator process, populated cgroup, pending unit job, storage reservation or pending artifact. Existing service identities, Paper health and prior isolated database records remained unchanged. No live external cap sample was captured during the short run; acceptance is limited to launch settings and successful internal gate checks. Pressure acceptance remains open.

## Health recovery integration — local only

New `health-recovery-gate.js` requires fresh, spaced healthy observations over a minimum duration. It rejects stale observations, excessive gaps, slow completed probes and backwards clocks. Duration uses a monotonic clock; observation identity uses a separate wall clock. Failed heartbeat observations invalidate admission probes already in flight.

The scheduler now identifies CLAIM and HEARTBEAT checks. `scheduler-health.js` delays claims during recovery and retains immediate unhealthy-heartbeat quarantine. Main-worker integration is opt-in through a reviewed `QUANT_HEALTH_RECOVERY_FILE`; no staging or production service has enabled it. Engine manifests include the changed entry point and helper modules. Existing job hashes are not rewritten; incompatible jobs cannot silently resume.

This is process-local temporal recovery. The opt-in wrapper now bounds asynchronous caller waits, requests cooperative abort and keeps an uncooperative probe latched until settlement so a timeout cannot multiply probes. Settlement checks monotonic elapsed time even if the event loop delayed the timer. Late success is discarded. It does not interrupt synchronous JavaScript, prove external DB work terminated, establish persistent backoff or calibrate stricter recovery thresholds. Restart begins blocked and requires fresh observations. Independent audit found and then closed the delayed-timer defect; nine focused wrapper/scheduler checks passed.

## Capacity contract — local only

`capacity-contract.js` adds pure, strict V2 policy/request validation without changing V1 runtime requests. The server-trusted policy binds market, SPT Custom source/settings, evaluator identity, evidence references, measured capacity, compute limits and fixed I/O safety reserves. Passing shape/hash checks does not prove genuine evidence, enrollment, authorization or resource enforcement.

Stage maxima remain 20K / 50K / 250K / 500K / 1M raw bars. The lower measured policy ceiling also applies. Raw totals include the 500 seed bars, so 1M raw permits at most 999,500 processed bars. Initial policy chunks remain at most 1,000; the architectural 50K maximum alone grants no expansion. Production, unsupported timeframe/model, client policy overrides and reduced safety reserves reject.

This module is not wired into admission. Streaming artifacts, trusted PROFILE enrollment, cumulative I/O accounting and expanded stateful execution still require implementation and acceptance.

## Checks and limitations

- Earlier combined Node subset: 54 passed, zero failed/skipped, 16.835 seconds. The later combined run below supersedes this count.
- Isolated PostgreSQL: foundation scheduler 14/14; data foundation 2/2; research foundation 7 passed and one Python parity test skipped. Recovery delayed claims, retained STOPPING until acknowledgement, preserved deadlines and issued a new lease token.
- The temporary local PostgreSQL service was stopped after checks. These durations are test runtime, not total engineering effort.
- Source audit found no blocking health-integration finding. Independent root review accepted the pure capacity contract; runtime integration is still pending.
- No commit, push, production deployment, Bot restart, new research campaign or capacity enablement occurred in this wave.

## Next gates

An isolated writer created a typed, fsynced 4,096-byte readiness file and reservation, then physically exited through SIGKILL at 06:53:51 UTC on 2026-09-29. Signal 9, PID zero, empty cgroup and no pending unit job were verified. The read-only inspection confirmed the file identity, hash, size, timestamp and matching ledger. Pre-expiry maintenance with `apply:false` and a 24-hour minimum returned `STORAGE_MAINTENANCE_GUARD`; a second inspection confirmed that both artifacts were unchanged. Existing services and database state were unchanged. No process runs while the pair ages.

The later file/reservation timestamp makes the earliest cleanup **2026-09-30 at 06:53:52 UTC / 13:53:52 Asia/Bangkok** (rounded up). Physical pair creation and the pre-expiry guard pass; deletion after genuine 24-hour aging remains pending. This direct StorageBudget crash fixture proves only storage-pair behavior and does not replace actual-supervisor crash recovery. Do not alter timestamps or lower retention.

Diagnose the original actual-main startup context before retrying pressure. Continue the phase checklist in bounded local slices while the retention clock runs.

## Additional bounded local progress — 2026-09-29

Managed legacy backtest and optimization requests now deny in both server and Python paths. The database FOUNDATION mode remains authoritative for API admission; Python requires a matching flag. Full-history summary, equity-curve and breakdown endpoints now also reject in managed mode before loading ledger history. Settings, health, sizing and persisted status remain available. The real PostgreSQL HTTP check verifies these denials. These changes have not been rolled out. Existing research-enqueue full-artifact preparation still needs managed resource admission before heavy-path coverage is accepted.

The V2 streaming artifact module now supports `publishStream`, `readV2` and `inspect`. It writes immutable chunks of at most 1,000 rows and syncs the dependency directory before committing the manifest. Root independent review and Astra P2 re-audit passed. Runtime wiring and retention enrollment remain absent. V2 artifacts count against quota, but all remain preserved until reference tracing is implemented.

The current Node run reports 75 tests total: 74 passed and one Windows symlink-privilege skip, in 16.155 seconds. This supersedes the earlier 54-test subset; do not add those totals. Existing PostgreSQL suites report foundation 14/14, data foundation 2/2, and research foundation 7 passed with one parity skip. The new real-PostgreSQL HTTP test passed (1); two Python loopback tests passed separately. These are test runtimes, not engineering hours.

Linux directory-durability acceptance remains pending. The health wrapper remains process-local: persistent backoff and bounded termination of hung probes are not proven. Readiness-pair timestamps and earliest cleanup are recorded above; the genuine 24-hour aging gate remains in force. Neither QD-1 nor QS-1 is closed.

## Actual-main diagnostic and terminal protocol

The next isolated diagnostic used the actual main, scheduler and evaluator with unchanged initial readiness limits. It reached candidate checkpoint index 3,000 before failing with `QUANT_IO_TELEMETRY_UNAVAILABLE`. At 07:24:40 UTC, the private diagnostic identified a monitor-stage limits-file read returning `ENOENT` after valid limits and counters had previously been accepted. The fourth evaluator's successful exit is unknown. Cgroup teardown racing launcher completion is a hypothesis, not a proven cause.

The diagnostic harness completed successfully as a diagnostic and confirmed cleanup; the research job itself failed and produced no result or holdout evaluation. Delayed checks at 07:27:53 UTC confirmed all new processes stopped, zero active jobs/execution slots, unchanged previous seven job records, healthy original services and an unchanged retention pair. No retry occurred under that operation.

A local `quant-io-terminal-v1` correction makes Python flush its framed result and wait for an exact ACK followed by EOF. The supervisor waits for any pending sample, reads final limits/counters against the latest accepted identity while Python is alive, then sends ACK. Abort, extra output, missing counters, regression and close before ACK reject. The worker selects this protocol only with reviewed I/O controls. Existing three-second readiness and resource limits are unchanged. Linux acceptance, including actual launcher ACK/close ordering, remains pending.

## V2 preparation and scheduler integration — local only

The streaming PROFILE pipeline converted and verified 50,000 synthetic raw bars into 49,500 derived bars, with a separate 50,501-row conversion fixture producing 50,001 derived bars. These prove data conversion, not SPT trading-state parity. V2 contracts accept only PROFILE with explicit trusted capacity policy, `paper-close-v1`, exact source/settings/budget bindings and separate conversion/evaluator identities. Results remain `evaluator_admission:false` with required blockers.

The scheduler now supports this explicit policy internally. PostgreSQL checks verify default denial, shared execution slot, strict input handling and cancellation after policy removal. The actual worker and public PROFILE service still need V2 integration and trusted evidence resolution; passing a policy or structural hash does not authorize expanded runtime work. V1 contracts remain unchanged.

The pure I/O ledger adds immutable reservation, observation, settlement, crash charging and lease-fencing transitions. Nine focused tests pass. It is not durable or connected to runtime. Pre-launch accounting, externally verified device/domain evidence, stop decisions and atomic database persistence remain required.

Latest combined Node run: 106 tests, 105 passed and one Windows symlink-privilege skip, 16.307 seconds. PostgreSQL reruns: foundation 15, research seven with one parity skip, data two, and HTTP one passed. Python chunk/terminal tests passed 38 before the additional exact-ACK EOF test; the latter passed in its eight-test focused suite. Do not add overlapping runs as unique totals.

Opt-in health probes now forward cooperative cancellation, stop later stages after cancellation and use pool queries outside the scheduler transaction client. Startup requires at least three research pool connections in this mode, preventing runtime-lock plus scheduler-lock starvation. In-flight SQL retains existing pool/server timeouts; this is not proof of SQL termination at the shorter caller deadline. Fifteen focused resource/wrapper/scheduler checks pass; runtime recovery calibration remains pending.

## Parallel runtime and PF-2 checkpoint

The owner approved QD/QS runtime and I/O as the main work, with bounded local
PF-2 engineering in parallel. The [PF-2 checkpoint](PF_2_CONTRACT_CHECKPOINT_2026-09-29.md)
records a reviewed immutable development-only plan contract, not a replay engine
or runtime admission. Library/Export implementation did not start in this wave.

The pure I/O ledger now uses `quant-io-ledger-v2`. It reserves allowances before
cgroup creation, then binds verified identities and counts bootstrap bytes from
cgroup-lifetime counters. Stop decisions latch across affected active domains
when observations or terminal readbacks threaten the shared cleanup reserve.
Root review reproduced a multi-domain defect before correction; the new
regression cases pass. The combined ledger, preflight and capacity subset passed
26/26 in 0.336 seconds. These checks overlap prior subsets and are not additional
unique tests. Durable database persistence, verified device/domain evidence and
physical enforcement remain unimplemented.

Independent Sol review subsequently found that repeated unknown-final crashes
could reuse the shared overshoot reserve. The ledger now quarantines compute
after any unknown-final crash: new reservations and pending binds reject even
after stop acknowledgement or a lease change, and active siblings require stop.
Observation and terminal accounting remain available. Fifteen focused ledger
tests pass after two new regression cases. Durable integration must enforce one
ledger per job and preserve its crash history; creating a fresh ledger cannot
be used to restart the same job's accounting. Physical simultaneous-stop tail
bounds still require calibration.

Independent Sol recheck closed that pure-ledger blocker within the existing
ledger history. The final combined preflight, capacity and ledger subset passed
28/28 in 0.430 seconds. It supersedes the earlier 26-test subset; no physical or
durable I/O enforcement is inferred from either result.

The new terminal-handshake packet uploaded with all eleven hashes verified.
Initial setup stopped with `EACCES` on the first copied read-only overlay file,
before creating a unit, environment, policy or job. Inspection confirmed private
copied files with distinct inodes, unchanged parent bytes and unchanged original
services, eight terminal job pairs and retention artifact. No workload ran from
this failed setup. A guarded continuation is under review; the failure remains
recorded and does not count as terminal-protocol acceptance.

Subsequently, the reviewed continuation succeeded and the single authorized
actual-worker diagnostic passed. Research returned `NO_VALID_CANDIDATE`,
foundation `SUCCEEDED`, cursor 3,876, one candidate and no holdout. Automatic
completion and cleanup took 9.982 seconds from the issued marker. Delayed checks
at 08:57:59 UTC confirmed zero active slots/processes, unchanged prior eight
jobs, original services and retention pair. See the
[terminal staging record](QD_QS_TERMINAL_HANDSHAKE_2026-09-29.md) for scope,
observed impact and remaining gates. No separate per-child ACK trace was logged;
the earlier `ENOENT` cause remains unproven.
