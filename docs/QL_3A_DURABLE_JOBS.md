# QL-3A durable research jobs

## Status and scope

Local implementation, checked against a separate PostgreSQL 16 cluster on 2026-09-27. The active Paper collection and production database were not migrated or restarted. The feature is disabled by default and can be enabled only in explicit Paper staging. It is a source-specific engineering API, not accepted customer Quant support or Best Inputs export.

Supported profile: the reviewed SPT Spot v4 source hash, BTCUSDT on Binance global, standard 1m candles, Custom preset, Long + Exit, HTF/RSI/session/BOS/sweep filters off, and Zone + ATR source stops. The complete 58-input owner review is required. Arbitrary Pine, futures, short entries and multiple-Pine research jobs fail closed in this implementation. APP-3B remains the later multiple-Pine gate.

The [approved input lock](evidence/QL_3A_APPROVED_INPUT_LOCK_2026-09-27.json) records the exact source input IDs, baseline/effective-input hashes and owner-approved bounds. No job has been submitted for that lock. Dataset selection and cutoff remain required.

| Source variable | Baseline | Min | Max | Step |
| --- | ---: | ---: | ---: | ---: |
| `emaFastInput` | 50 | 30 | 70 | 10 |
| `emaSlowInput` | 200 | 150 | 250 | 25 |
| `atrLenInput` | 14 | 10 | 20 | 2 |
| `stFactorInput` | 3.2 | 2.4 | 4.0 | 0.4 |
| `zoneAtrMultInput` | 1.15 | 0.75 | 1.55 | 0.2 |
| `setupExpiryInput` | 48 | 24 | 72 | 12 |
| `cooldownInput` | 8 | 4 | 12 | 2 |
| `confirmLookback` | 5 | 3 | 7 | 1 |

Bridge ATR multiplier is 40–80 step 10, baseline 60. Bridge RR is 1–2 step 0.25, baseline 1.5. These research domains do not change the product defaults of ATR 2.0 / RR 1.5. Bridge ATR(14) remains independent of the selected source ATR length. The other 50 typed source inputs remain fixed, including the two unselected numeric source stop guards.

## API

Existing owner authentication, CSRF and request limits apply. Each request runs in the existing database transaction.

- `POST /api/quant/research/jobs`: enqueue with `Idempotency-Key` (8–128 letters, digits, underscores or hyphens). Returns HTTP 202 and a server-generated `run_id`.
- `GET /api/quant/research/jobs/{run_id}`: owner-scoped status, phase, candidate progress, dimension coverage, checks, hashes and result.
- `POST /api/quant/research/jobs/{run_id}/cancel`: empty JSON object. Immediately fences subsequent writes and returns persisted status. Repeating cancellation or reading a terminal job does not restart it.

Submission fields:

| Field | Contract |
| --- | --- |
| `bot_id`, `deployment_id` | Owned, READY, single-Pine deployment with current immutable snapshot and Bridge execution evidence |
| `parameter_slots` | 0–8 unique numeric source mappings; `{slot, input_id, min, max, step}`, slot 3–10 |
| `bridge_domains` | Required `atr_multiplier` and `rr`, each `{min,max,step}` |
| `dataset` | `{start_time,end_time,warmup_bars}`; inclusive UTC milliseconds aligned to closed 1m bars |
| `budget` | Integer 1–100; must cover baseline and adjacent changes in every chosen dimension |
| `seed` | Integer 0–2147483647, recorded with deterministic plan |
| `deadline_seconds` | Optional integer 60–900; default 900 |

The server reads policy, configured capital, source, reviewed inputs, market candles and execution model from registered records. Clients cannot supply replacement policy, Pine source, signals, fees or arbitrary market rows. Verified candles must be contiguous, have matching hashes/profile/tick/quantity step, and include at least 2,000 measured bars. Warm-up is at least `max(1006, 5 × maximum Slow EMA)`; the approved grid therefore requires 1,250 warm-up bars and at least 3,250 total bars. Maximum dataset size is 10,000 bars.

Same owner/Bot/key and identical body returns the existing job. Changed body with the same key returns `IDEMPOTENCY_CONFLICT`. Queue limits are 10 active jobs globally and two per owner. Worker claims allow two RUNNING jobs globally, one per owner.

Progress percentage measures completed search candidates only; sensitivity, stress and holdout checks have a separate count and phase. A 100% candidate percentage does not imply job success, phase acceptance or permission to apply inputs.

## Immutable contract and bounded calculation

The persisted contract freezes source bytes/hash, baseline snapshot hash, selected/fixed typed inputs, grids, full candle dataset/hash, chronological split, execution model, policy, configured historical capital, deterministic plan, seed, budget, deadline and engine fingerprint. SQL triggers reject changes to contract identity and to completed checkpoints. Private source and complete candles stay in the private database; status responses omit them.

Search always begins with baseline and adjacent one-axis changes. Each selected source input and both Bridge dimensions must take at least two values. Insufficient budgets are rejected rather than silently dropping dimensions. Small grids are exhaustive; larger grids use a deterministic seeded sample. The approved ten-dimensional grid has 11,718,750 combinations; the prepared budget of 100 is a sample, not an exhaustive search or a promise of the global optimum. Its initial 21 axis candidates cover all ten dimensions.

Each candidate starts the source evaluator cold, using the same warm-up window. Historical replay starts from declared configured cash/equity and flat simulated positions. It neither consumes nor resets the live account's daily/streak counters. This is an independent research simulation; its fills never count as natural live Paper trades.

Worker execution uses a fixed Python module over bounded stdio, without running Pine or contacting AI services. Each calculation has a 30-second timeout; input is capped at 8 MiB and output at 2 MiB. The evaluation ceiling is planned candidates + at most two neighbors per dimension + stress + holdout + three interrupted-calculation allowances. The persisted counter charges attempts before dispatch. Retries cannot create an unbounded budget.

## Cancellation and recovery

State transitions are QUEUED, RUNNING, then SUCCEEDED, NO_VALID_CANDIDATE, FAILED, CANCELLED or TIMED_OUT. Candidate/check completion is stored independently as an immutable checkpoint.

A RUNNING job has a random lease token, a 30-second lease and heartbeat every five seconds. Every checkpoint/result write checks token, status, lease, deadline, owner authorization, current READY baseline, policy/capital/membership freshness and engine fingerprint. Owner/Bot lock order matches existing policy/funding writers. Cancellation clears the lease immediately; late output cannot commit. The heartbeat interrupts an in-flight subprocess after lease loss; an already finished pure calculation can be discarded.

After process loss, the next worker reclaims an expired lease and skips completed checkpoints. Only an interrupted, uncommitted pure calculation may repeat. After three claim attempts an expired job becomes FAILED. Deadline expiry becomes TIMED_OUT. Graceful termination aborts the subprocess and leaves its uncommitted step recoverable after lease expiry. No AI call or trading order is repeated by this recovery path.

The final selected candidate is determined using train/validation only. Sensitivity checks and doubled fee/slippage stress run before holdout. Candidate/sensitivity/stress subprocesses receive no holdout candles. Once those checks pass, one selected candidate may evaluate the final chronological holdout. A committed holdout checkpoint is reused on recovery; if the process loses an uncommitted holdout calculation, only the same selected candidate may repeat that pure calculation. Recovery never chooses another candidate based on test results.

## Gates and evidence

Current research screening requires five closed trades in each evaluated chronological partition, nonnegative validation return at least equal to baseline, maximum validation/test drawdown 20%, adjacent sensitivity return drop at most two percentage points with five validation trades, and nonnegative doubled-cost validation with five trades. Holdout must have five closed trades and nonnegative return. Failure retains NO_VALID_CANDIDATE; zero validation trades never opens holdout.

Even research SUCCEEDED has `owner_recommendation_ready:false`. Varied-input TradingView parity, fresh Custom repaint evidence, customer capability registration and the remaining phase acceptance gates are still required before QL-4B/export. No automatic second optimization or Bot restart is added.

[Engineering checks](evidence/QL_3A_DURABLE_JOBS_CHECKPOINT_2026-09-27.json) record ten Node checks (including seven real PostgreSQL cases), three Python calculation-boundary checks and one real-source baseline stdio calculation. Synthetic queue fixtures verify engineering behavior only; their five-trade metrics are injected and do not establish strategy performance or natural trades. The real-source baseline check returned five train trades and zero validation trades, evaluated no holdout and produced no Best Inputs.

## Controlled rollout

1. Review this extension and select an explicit staging maintenance window. Preserve the current collection cutoff and account guard state. Do not migrate a database with active runtime locks.
2. With staging processes stopped and the intended staging database configured, run `npm run migrate:quant-research`. The offline script takes the existing maintenance lock, verifies base schema 14 and Pine Bridge extension 1, and installs Quant extension 1 transactionally. It is idempotent and does not alter the Paper ledger.
3. If migration uses a separate administrator role, grant the staging runtime role SELECT on `quant_job_schema`; SELECT/INSERT/UPDATE on `quant_jobs`; SELECT/INSERT on `quant_job_steps`. Existing Pine/source/market/read/audit permissions remain required. Do not grant checkpoint update/delete access.
4. Start the staging API with `PINE_BRIDGE_ENABLED=1`, `PINE_BRIDGE_ENV=staging`, `QUANT_RESEARCH_ENABLED=1` and existing Paper configuration. Start a separate process using `npm run worker:quant-research`, the same staging database/configuration and `QUANT_RESEARCH_PYTHON` pointing to the installed Quant Python environment. Paper execution remains a separate worker.
5. Freeze and review a dataset, then submit the approved lock once with an idempotency key. Record its run ID, hashes and blockers. Monitor the status endpoint; cancellation is explicit. Disable the flag and stop the dedicated Quant worker to disable new research jobs without applying research inputs to any Bot.

No rollout, active-database migration, new owner optimization, email delivery, source export or Bot change was performed by this checkpoint.

## Subsequent staging rollout — 2026-09-27

The owner authorized checkpoint and staging rollout. Implementation checkpoint `6320169` was committed and pushed to the work branch, then deployed to a separate staging release for the API and dedicated Quant research worker. The Paper worker and market stream retain their preceding code. Quant extension 1 was installed with the maintenance lock and a protected database backup; base schema remains 14. The existing configured Quant Python environment was reused without changing its packages or production service. The default Git archive excludes `quant_lab`, so the matching tracked Python source was supplied as a separate controlled bundle. Record the deployed engine fingerprint when submitting a job; Git archive normalizes code line endings, so it can differ from the local checkout fingerprint.

The restricted runtime role can insert/update jobs and insert checkpoints, but cannot update/delete checkpoints. Authenticated HTTP checks returned 400 `INVALID_FIELDS` for an empty submission and 404 for an unknown job; unauthenticated access returned 401 and invalid CSRF returned 403. The approved eight-source/two-Bridge lock accepted a 100-candidate plan inside an intentionally rolled-back transaction. Job counts remained zero. This verifies submission and permissions without starting owner optimization or evaluating new strategy performance.

The staging API, Paper worker, dedicated Quant worker and market stream were active afterward. Health was PAPER_ONLY with queued 0, and Quant worker startup was observed without cycle-failure messages. Production's four services remained active and unchanged. Snapshot, locked policy, capital, session/run ID and daily/streak rows matched across migration.

A conservative receiver-maintenance interval is **2026-09-26 17:31:26–17:31:57 UTC** (2026-09-27 00:31:26–00:31:57 Asia/Bangkok). It spans an initial pre-migration port-format rejection, restoration of the preceding API/worker, and the successful retry. Market stream was not stopped; 3,250 latest market candles were contiguous at readback. That candle continuity does not prove uninterrupted natural webhook delivery. Preserve this interval when reviewing collection quality and freezing the Paper dataset.

[Rollout evidence](evidence/QL_3A_DURABLE_JOBS_STAGING_ROLLOUT_2026-09-27.json) records hashes, backup digest, permissions, maintenance interval and readbacks without credentials or machine locations. Staging services continue using transient systemd units; process restart is configured, but automatic VPS reboot recovery was not introduced by this rollout. QL-4B remains gated by reviewed dataset/trade coverage, varied-input parity and fresh Custom repaint evidence. No Best Inputs, email or Bot restart occurred.
