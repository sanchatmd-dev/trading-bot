# QD-1 / QS-1 research worker integration checkpoint

Date: 2026-09-28. Continues the [foundation checkpoint](QD_QS_FOUNDATION_CHECKPOINT_2026-09-28.md)
after PF-1 `cf8913d`. This is engineering integration, not expanded-capacity
acceptance, a new optimization campaign or a production deployment.

## Implemented

- An opt-in research worker uses the existing research API, candidate workflow
  and result schema with the foundation's durable fair queue and single slot.
  Raw OHLCV is referenced by immutable content identity; frozen market ATR14,
  price tick and quantity step are a separate verified artifact. Source ATR
  remains an independent optimized input.
- Each candidate advances in chunks of at most 1,000 rows. SPT indicators,
  setup/confirmation/cooldown state, Bridge positions, Paper balances,
  allocations, costs, daily guards, loss streaks and metrics survive a durable
  checkpoint. Continuation does not replay or retain the raw prefix or fill
  history. Dataset, engine, snapshot, parameters, kind and cursor are bound.
- Checkpoints contain decimal strings for floating evaluator state. This preserves
  exact binary float reconstruction and integrity across Python, Node JSON and
  PostgreSQL JSONB. Decimal accounting remains exact. State is capped at 1 MiB.
- SQL mode guards exclude mixed legacy/foundation research execution. Offline
  installation preserves LEGACY mode by default. Both extensions are version 1;
  base schema remains 14. Active jobs prevent a mode change.
- The Linux supervisor uses a transient systemd service for each Python chunk:
  default CPU quota 50% of one CPU, memory 512 MiB, 16 tasks, Nice 10, IOWeight 10,
  one native-library thread, no core dump, 64 open files, and at most 30 seconds
  per process. Input is capped at 8 MiB and stdout at 2 MiB. Defaults are
  provisional controls, not calibrated production headroom. IOWeight is relative
  priority, not an absolute disk-bandwidth reservation.
- Cancellation waits for physical process/cgroup termination. Persisted unit
  names plus same-worker settled-launch proof prevent a late systemd start from
  racing slot release. Timeout, uncertain stop or lease loss never permits stale
  output to commit. Shutdown during claim cannot launch a new evaluation.
- Health admission and heartbeats check the local Paper API, DB latency, pending
  trading queue depth/age, available memory, free disk, disk fraction and load.
  Incomplete/unknown health blocks compute. Thresholds require an explicit
  reviewed operator file; they are not relaxed automatically.
- Freshness checks hold owner/Bot locks through scheduler mutations, preventing
  policy, membership or funding changes from racing result publication.

## Verification and boundaries

| Evidence | Result and scope |
| --- | --- |
| Node application suite | 299/299 passed, 74.385 seconds. Includes atomic sidecar publication, concurrent publishers, tampering, short reads and cancellation. |
| Local process/health checks | 6/6 passed, 2.493 seconds. Windows execution is mechanical subprocess proof, not Linux resource certification. |
| PostgreSQL foundation regressions | Scheduler 13/13, storage/restart 1/1, original research 8/8 and offline migration 1/1 passed in disposable databases. |
| PostgreSQL research adapter | 8/8 passed with no skips, 132.004 seconds. Includes the actual Python supervisor/worker path, shutdown during claim, cancellation quarantine and owner-lock serialization. The real baseline candidate consumed 3,876 bars in four chunks from an isolated split wholly inside the already-exposed 4,533 bars; exact original-evaluator equality, one persisted step and one evaluation charged. No search or holdout evaluation. |
| Python suite | 105/105 passed, 35.21 seconds, including real Node JSON roundtrips and SPT/Paper carry-state regressions. Ruff findings were corrected by removing unused imports, sorting imports and explicitly marking adjacent-pair zip as non-strict; full Ruff then passed and all 31 chunk-state tests passed again in 14.00 seconds. |
| Real accepted SPT baseline | 4,533 already-exposed preholdout bars; chunk sizes 7, 257 and 1,250 exactly matched the unchanged reference evaluator. Signal trace: 60 BUY and 82 native EXIT; 115 events, 75 decisions, 10 fills matched. Four independent Python CLI processes also matched. |
| Cross-language checkpoint | Five Node JSON roundtrips at 1,000-row chunks matched the original real baseline result exactly: 75 decisions, 10 fills; largest checkpoint 3,174 bytes, 3.25 seconds. |
| Linux supervisor smoke | Five bounded checks passed on the VPS: observed `cpu.max=25000 100000`, `memory.max=134217728`, `pids.max=16`; timeout, stdout overflow, memory exhaustion and descendant termination all confirmed physical stop. This smoke used CPU25%/128MiB, not the default worker envelope. |
| VPS cleanup/health | No remaining `robot-quant-*` units or probe processes. The four existing application/worker/database/Quant services remained active. No production migration, configuration edit or service restart. |

The baseline evidence uses actual approved SPT source enrollment. Synthetic
tests cover additional source axes, warm-up, SL/TP/native EXIT, guards and UTC
midnight. Mechanical integration fixtures are not a qualified research run or
new TradingView parity evidence. No original reserved holdout bars were read.
Prior `NO_VALID_CANDIDATE` and zero validation-trade findings remain unchanged.

Integration exposed and corrected issues absent from the earlier synthetic
foundation: Python/Node float serialization changed checkpoint hashes; shutdown
could arrive during claim; owner freshness checks needed transaction locks;
sidecar publication needed atomic completion before visibility. The audit also
kept terminal API state and engine identity aligned with foundation execution.

## Offline staging activation procedure

This procedure describes the next controlled rollout; it was not executed on
the application's VPS database in this checkpoint.

1. Preserve the database/artifact backup and verify restore in an isolated target.
   Stop every API and worker participating in the PostgreSQL runtime lock. Drain
   active research jobs; changing mode while jobs remain is rejected.
2. Install with `node scripts/migrate-quant-foundation.mjs`. It takes the exclusive
   maintenance lock, checks extension versions, installs atomically and leaves
   the existing executor mode unchanged (LEGACY for a fresh installation).
3. Configure the staging API and research worker consistently with
   `QUANT_RESEARCH_FOUNDATION_ENABLED=1` and a protected absolute
   `QUANT_RESEARCH_DATASET_ROOT`. The worker additionally requires
   `QUANT_HEALTH_LIMITS_FILE` and a loopback `QUANT_HEALTH_URL` ending in `/healthz`.
   Configure the Python runtime with `QUANT_RESEARCH_PYTHON` when needed.
4. The limits JSON must contain exactly `maxDbMs`, `maxApiMs`, `maxQueueAgeMs`,
   `maxQueueDepth`, `minMemoryBytes`, `minDiskBytes`, `maxLoad1` and
   `maxDiskUsedFraction`. Measure and review values against Trading/Web/DB
   baseline before setting them. The last value must be below 1.
5. While offline, explicitly select
   `node scripts/migrate-quant-foundation.mjs --mode=FOUNDATION`. Start the API and
   dedicated research worker in Paper staging. Verify one approved engineering
   fixture, cancellation and recovery with the current 10K/1m V1 admission.
6. Rollback of execution mode also requires offline maintenance and drained
   jobs, then `--mode=LEGACY` and matching process configuration. Preserve
   immutable evidence and artifacts; rollback does not delete the extensions.

The local real-Python integration test additionally accepts
`QUANT_REAL_CONTRACT_FILE` and `QUANT_TEST_PYTHON` for the existing private
approved fixture. Without that private fixture it is explicitly skipped;
ordinary CI exercises the synthetic adapter tests. Process integration tests
are invoked explicitly with
`node --test test/integration/process-supervisor.test.mjs`; Linux requires a
working user systemd manager. These checks are not part of the Node-only suite.

## Remaining gates before capacity expansion

1. Cold worker crash recovery remains deliberately quarantined. A missing unit
   is not proof that an old launcher cannot start it later. Keep STOPPING and
   investigate offline with every executor/launcher stopped and process trees
   and cgroups verified. A reviewed recovery command and crash/reboot drill are
   still required; never clear the slot merely because a lease expired.
2. Complete isolated staging research-worker rollout, host health calibration,
   cancellation/pause latency measurements and Trading/Web/PostgreSQL impact
   checks. The bounded supervisor smoke does not satisfy that acceptance.
3. Bring other heavy paths into the same admission authority. Add disk/temp
   reservations, retention, entitlement quotas and absolute I/O budgets where
   required. Raw storage publication does not prove power-loss durability.
4. Finish paged exchange ingestion, capability/calendar/range/UI contracts and
   migration/backup/restore exercises. Validate larger state/resource budgets
   before raising evaluator admission.

Capacity stays **10,000 bars, BINANCE:BTCUSDT Spot 1m, PAPER_ONLY, V1**. PF-2 V2
historical evaluator parity remains a separate gate. No automatic rerun, Best
Inputs application or Live activation is introduced.

Disposable test databases were removed and the local PostgreSQL cluster was
stopped. `git diff --check` passed; changed-file scanning found no known private
machine location or key patterns. The unrelated diagnostic remains untouched.
The owner authorized commit/push of this foundation and worker integration
checkpoint on the existing work branch. Git publication does not deploy it.

Full active engineering hours were not measured. Verification runtimes are not
development hours or a speedup claim. Weekly usage was 68% remaining at the
start, 63% during integration and 61% at final cleanup; the short window was
unavailable. The 20-percentage-point reserve remains. See Time Management for
the unchanged planning baseline and next bounded work.
