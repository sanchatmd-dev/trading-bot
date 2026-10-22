# QR-2 S5-4 Stage 2C: isolated functional qualification

Status: **PREPARATION ONLY; DATABASE EXECUTION NOT ADMITTED**. This continues the [Stage 2C integration packet](QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md) under the owner's continuous local GO. Root must review frozen sources, tests and lifecycle code, refresh usage/headroom, and append explicit runtime admission before execution. Functional evidence does not close combined performance or Stage 3.

## Exact test scope

Use one new authenticated loopback PG16 cluster with six sequential test-file processes. Each process uses Node process isolation and test concurrency one. The original proposal selected 18 existing regressions; root extends it before execution with exactly three coverage-integration tests. The total candidate selection is 21 tests and eight sequential helper-created test databases. Verify exact matched names from frozen sources; skipped/unmatched tests are not passes. No full PostgreSQL suite or automatic retries are admitted.

| File | Selected name prefixes | Expected selected tests |
| --- | --- | ---: |
| `test/postgres/qr2-reader.test.mjs` | `T1 golden E2`, `T4 separation:`, `T4 a refused READ COMMITTED`, `T4 snapshot proof:`, `T6 the price table can be absent:`, `T7 read budget:`, `T8 owner scope:`, `T9 cutoffs equal` | 8 |
| `test/postgres/qr2-reader-facts.test.mjs` | `T10 a non-BTCUSDT position`, `T10 R15 pending orders:`, `T10 R15 only the JSON parse failure` | 3 |
| `test/postgres/qr2-owner-independent.test.mjs` | `independent PostgreSQL position and exposure rows`, `independent PostgreSQL concurrent position insert` | 2 |
| `test/postgres/qr2-compute-http.test.mjs` | `the real worker pool gives`, `a real reader snapshot is plain data`, `admin read:` | 3 |
| `test/postgres/qr2-owner-compute.test.mjs` | `owner actual worker sums`, `owner actual worker preserves` | 2 |
| `test/postgres/qr2-coverage-integration.test.mjs` | `coverage integration:` | 3 |

The new file must independently verify producer behavior omitted by the old regressions: five supported owner members with shared/nested coverage, standalone no-fill and absent/empty/budget states, and actual coverage timestamp late arrival across repeatable-read snapshots. Its financial and scope assertions remain independently grounded. The existing concurrent-position case is not relabeled as coverage late-arrival proof. Review the final tests before accepting any of these claims. Some existing admin-route assertions deliberately simulate worker timeout/crash; these are expected test outcomes, not permission to ignore a harness failure.

## Runtime limits

Use a fresh ignored run directory, fresh random credentials, SCRAM authentication, loopback listener and an ephemeral checked port. Never reuse or restart M1/M2 or another retained cluster. Supply a newly constructed `TEST_DATABASE_URL` only for this cluster; never inherit a target/shared `DATABASE_URL` or `TEST_DATABASE_URL`. Root supplies the previously qualified absolute PG16 binary path locally. Credentials and machine paths stay out of tracked evidence.

Only the helpers' UUID-named synthetic test databases may receive application migrations, fixture guards and Pine/capital-model schemas. These isolated fixture migrations do not authorize a shared/target migration. No application configuration or route is enabled. Capture actual PostgreSQL version and settings: shared buffers 16 MiB, work memory 2 MiB, maintenance work memory 16 MiB, maximum connections 16, statement timeout 5 seconds, lock timeout 1 second and idle transaction timeout 10 seconds. The connection ceiling accommodates existing fixture pools, second connections and admin handles; it changes no product pool default.

Admission requires at least 1 GiB free physical memory, 2 GiB free disk and no PostgreSQL process or competing test job. Refuse inadequate headroom without freeing unrelated resources or lowering the gate. Abort on sampled free memory below 384 MiB, disk below 2 GiB, owned runner/test process-tree RSS above 384 MiB or conservatively summed PostgreSQL RSS above 256 MiB. Global PostgreSQL sampling may include an unrelated newly started process; it can trigger refusal but never authorizes terminating that process. Record actual sample gaps. These are observed abort thresholds, not instantaneous heap guarantees.

Each selected file has at most 60 seconds, bounded by 300 seconds of total work. Runner lifetime including cleanup is at most 360 seconds. The independent supervisor begins cancellation at 310 seconds and rejects cleanup beyond 420 seconds. Every command, inventory, stop and probe has its own finite timeout. Keep existing actual compute-pool 256/32/4 MiB limits and 10-second deadline unchanged. No heap stress, extra matrix, cap increase or retry follows automatically.

## Ownership, evidence and cleanup

Root owns this packet, source manifest, supervisor, runtime admission/execution, evidence and Git. The harness writer owns only its assigned ignored runner/report. The tester owns the new test file and its reports. The auditor owns independent source/lifecycle reviews. Freeze all source/test/harness writers before execution. Children do not run the database, use the browser, perform host work or dispatch peers.

Pin the root-approved source manifest, all listed tracked dependencies, explicitly admitted new source/tests and runtime code before startup; verify pins before/after each file and cleanup. The manifest excludes private/untracked source and runtime data. Record exact matched test names, durable flushed START/TERMINAL records, raw TAP/stderr, actual pass/fail/skip counts, exit/signal, durations, query evidence, settings and resource samples. An unmatched START is ABORTED/UNKNOWN. Hashes and sanitized summaries may enter tracked evidence; raw local artifacts remain ignored.

The existing fixture `dispose()` catches cleanup errors. After every file, independently query the owned cluster's database/session inventory. Any leftover fixture database/session fails cleanup and stops further files. Do not issue an extra DROP/FORCE or delete data to conceal a failed dispose. Normal helpers may drop only their own synthetic test databases.

Publish validated run/data/port/runner identity before initialization. Cancellation targets only owned live processes or previously observed PID/creation identities; an exited parent's reused PID is not ownership proof. Attempt exact-cluster fast stop separately from runner termination. Require stopped `pg_ctl` status 3, absent recorded postmaster and owned child identities, and a closed loopback port. Unknown cleanup fails qualification. Retain cluster data and logs; no recursive deletion or restart is authorized. Remove only the exact ephemeral password file after verified path containment.

## Acceptance limits

Root accepts only actual selected passing assertions after independent raw verification and verified cleanup. A small functional run does not establish RC-Q35/36 percentiles, combined envelope capacity, final immutable budgets, public interval rendering or target readiness. Provisional 30-day/span and aggregate resource refusals remain explicit; ranges and financial history quotas are never silently shortened. C3 combined performance and Stage 3 publication/rendering remain OPEN.

Spot/Paper; private source local; private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, shared/target migration, host/VPS, Live, guard reset, Best Inputs apply or backfill. Preparation usage is 52% weekly remaining, short window unknown, with a 3% reserve; refresh before runtime.

## Preparation closure and headroom hold

The frozen six-file inventory contains exactly 21 selected names and eight expected helper-created databases. The three added integration tests passed syntax and independent source review, including corrected synthetic registration/funding/snapshot chronology; they have not executed. The lifecycle audit found and closed three P2 issues: inherited PGHOSTADDR, an obsolete 18-test runtime fallback and an omitted supervisor source pin. The final runner requires the complete 21-test packet and checks all 681 manifest entries plus lifecycle sources. No numerical resource gate was weakened.

Root recorded 1,027,645,440 bytes of free physical memory against the required 1,073,741,824 bytes, with zero PostgreSQL processes and no identified Node test process. This is a preparation observation, not a run or cleanup result. DATABASE EXECUTION REMAINS NOT ADMITTED. Refresh usage, process state and headroom before a later explicit root admission; do not automatically reuse or overwrite any run state.
