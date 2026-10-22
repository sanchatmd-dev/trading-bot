# QR-2 S5-4 Stage 2B-M2: shared coverage and worker transport measurements

Status: **BOUNDED LOCAL M2 ACCEPTED; INTEGRATION AND IMMUTABLE LIMITS REMAIN OPEN**. This packet continues the owner's local Roadmap GO and the [M1 qualification](QR2_S5_4_STAGE2B_M1_PACKET_2026-10-23.md). Product source, public responses and routes remain unchanged. The objective is evidence for immutable coverage limits before account/owner integration, not a new research campaign or target capacity claim.

## Data and attempts

Use one new loopback PG16 cluster under ignored `.qa-local/qr2-s5-4-m2/run-<timestamp>`. Reuse the reviewed M1 lifecycle design in a separate directory; never change M1 evidence or restart its clusters. Keep SCRAM authentication, explicit qualified binary path, exact synthetic schema/primary key, source baseline checks, retained stopped data and verified PID/port cleanup. The root alone executes the fixture. No application configuration, private data, migrations, target or host access is permitted.

Maximum resident data is 43,200 synthetic rows, in batches of at most 10,000. Four primary cells have three observations each, followed by four tiny boundary attempts: at most 16 measured attempts, including failures. Within each primary cell, seed once; label the first observation first-touch and the following observations warm, without claiming cold cache or p95. Dense single and five-window cells may use separately seeded equivalent data. No additional cells or cap increases follow automatically.

1. Dense 43,200 minutes, one window and 43,200 stored closes.
2. Same dense extent, five distinct nested windows with a common end. Starts are 0, 1,080, 2,160, 3,240 and 4,320 minutes. This is a supported-owner shape at the seam, not actual owner-reader integration.
3. Alternating occupancy across 1,440 minutes, five nested windows with starts 0, 2, 4, 6 and 8 minutes. Store even-numbered closes only.
4. Same alternating extent, twenty nested windows with starts 0 through 38 minutes in steps of two. Label this planner stress; existing owner guards still allow at most five supported accounts.

All cells must read one union array once per observation. Distinct windows retain their own bounds and indexes. Do not store timestamp arrays on members or duplicate a full registry per binding. Four boundary attempts use at most three rows: an exact input-byte admitted read, its one-row sentinel overflow, an exact conservative output-byte admitted read and a one-byte-lower whole refusal. Derive the byte thresholds from the actual qualified registry/context; do not approximate them. Expected refusals must occur before worker/public-envelope allocation and be recorded separately from unexpected failures.

## Budgets and lifecycle

Experiment-only arguments are `union_minutes=43200`, `timestamp_rows=43200`, `unique_windows=20`, `derivation_visits=250000`, `output_intervals=15000`, `coverage_input_bytes=1048576` and `coverage_output_bytes=4194304`, except the explicitly lowered tiny byte-boundary cases. These are not selected production defaults or evidence that every combination up to them is safe. No route can accept or increase them.

Keep the M1 limits: `shared_buffers=16MB`, `work_mem=2MB`, `max_connections=8`, statement timeout 5 seconds, lock timeout 1 second and idle transaction timeout 10 seconds. Harness work has a 105-second deadline, leaving 15 seconds within its 120-second lifetime for cleanup. External supervisor starts cancellation at 110 seconds and fails any cleanup overrun beyond its 150-second total. A measured case child has a 30-second external deadline; each worker operation has the existing 10-second deadline and is terminated and awaited on timeout/error. One worker and one database read operate at a time. No retries or queues.

The measurement-only worker uses the existing limits of 256 MiB old generation, 32 MiB young generation and 4 MiB stack. Fail closed on process heap flags using the existing guard before spawning. This worker is not the production compute pool. Read-only import and tiny transport preflight must pass before database startup. Those preflights are separately counted, not added to the 16 measurement attempts.

Admission requires at least 768 MiB free physical memory, 2 GiB free disk and no other PostgreSQL fixture. Keep sampled aborts at 384 MiB free memory, 192 MiB runner-process-tree RSS and 256 MiB conservatively summed PostgreSQL RSS. The root may reduce scope after a stop but cannot silently raise thresholds. Record actual sampling gaps; sampled RSS is not a hard cap or proof of transient peaks. A global PostgreSQL sample never authorizes killing unrelated processes. Stop only the recorded cluster and verified owned process identities. Unknown cleanup fails and requires root recovery. No recursive deletion is authorized.

## Measurement contract

Invoke the actual `readCoverageSnapshot` in a read-only repeatable-read transaction. Preserve its explicit row/byte admission. Send exactly one registry and independently qualified accounts/budgets to the measurement worker using `postMessage`. The worker performs one independent registry validation, then constructs each distinct Stage-1 coverage object once. Its per-window slice is temporary and processed serially; record this additional construction pass and allocation rather than calling it zero-copy. Registry union timestamp storage remains shared.

Construct the exact prospective owner fragment from the Stage 2A contract and the account fragment for each binding, reusing the unique coverage objects. Check actual UTF-8 bytes against the registry's conservative output bound. Return one bounded owner-envelope JSON string plus compact timings/counts/digests, never a second timestamp registry. Count the response string bytes and acknowledge that JSON-string transport is not full production object transport. Root validates the returned JSON against an independent dense/alternating recipe and the exact closed shape. Missing intervals use Stage 1's public half-open bounds; no truncation or fabricated availability state.

Record main-thread enqueue time, receipt acknowledgement, worker validation, unique coverage construction, serialization and round-trip/reply receipt separately. Cross-thread receipt time is elapsed transport plus scheduling, not pure cloning time. Record worker heap/RSS observations and the process supervisor samples. If component separation would add unbounded replay, keep the combined read/decode/build timing label. Do not subtract unrelated timings to invent a component cost.

Record plain SELECT elapsed time and exact unforced `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for each primary fixture shape. Preserve recipes, query parameters, rows, plans, transaction facts, source hashes and actual byte counts. A sequential scan or sort on these fixtures is an observation to interpret, not an instruction to force an index. The maximum selected rows do not prove total scan cost on a larger mixed-market table.

## Review and next action

The coder owns ignored runner/cases/worker files. Root owns this packet, the separate supervisor and tracked evidence/notes. Independent tester owns only its oracle/results reports; auditor owns only its review. All product files, prior fixtures and historical evidence are read-only. Children have no Git, browser, DB runtime, host or dispatch authority. Initial usage is 66% weekly remaining, short window unknown, 3% reserve; refresh before runtime and integration.

Acceptance requires exact recipe/count/interval/envelope agreement, one shared union, actual worker transport, byte admission before refused allocation, unchanged sources, independently checked raw evidence and verified cleanup. Failed attempts remain preserved. Append and await a durable attempt-start record before each observation begins, then append its terminal record. A forced process stop may bypass finally; an unmatched start remains an aborted or unknown outcome and is counted, never silently omitted. Root then considers a bounded immutable-limit proposal with explicit measurement margins and remaining integration requirements. No product cap is selected by this packet. Account/owner authorization and pre-admission, financial noninterference, full responses, production worker integration and EN/TH rendering remain open.

Spot/Paper, private source local, private acceptance NOT RUN, READY false and N1 held remain unchanged. No deployment, target route activation, shared/target migration, host/VPS, Live, guard reset, Best Inputs apply or backfill.

## Root runtime admission

Independent packet, lifecycle and harness reviews passed with explicit limits. Review found and closed the durable-attempt journal issue before execution. Root confirms that the supervisor differs from reviewed M1 only in its owned directory. Root admits one execution with the existing ceilings; import and tiny transport preflights must pass before database startup. Fresh usage is 62% weekly remaining, with the short window unknown and a 3% reserve. Read-only preflight observed about 818 MiB free physical memory, more than 19 GiB free disk and no PostgreSQL process; the supervisor rechecks admission and monitors the run. Product sources remain unchanged.

## Accepted local outcome

The single admitted run completed 16 measured attempts: 14 successful replies and two expected pre-worker refusals. Independent offline verification checked all 14 saved owner envelopes, complete START/TERMINAL journals, nine unchanged source pins, the 16 actual union reads and four separate EXPLAIN executions. The runner took 13.449 seconds; the supervisor completed verified cleanup in 15.727 seconds. All seven resource samples stayed within the admitted thresholds; stopped data remains retained. The [evidence](evidence/PM1_QR2_S5_4_STAGE2B_M2_LOCAL_2026-10-23.json) preserves raw artifact hashes and limits.

This accepts only the measurement seam. Product source and public responses remain unchanged. A separately reviewed local integration packet must qualify shared coverage with financial snapshots through the actual compute pool before immutable limits are selected. Full Stage 2/S5, public rendering and target acceptance remain open.
