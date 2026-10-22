# QR-2 S5-4 Stage 2C: combined measurement preparation

Status: **PREPARATION ONLY; NO RUNTIME GO**. This packet continues the existing local Stage 2C scope. Functional CI and the priced-account interior-gap differential must be qualified before any diagnostic runtime admission. The local Windows functional packet remains NOT RUN below its unchanged 1 GiB headroom gate. No earlier measurement or CI badge admits this workload.

## Acceptance remains complete

RC-Q35/36 in the portfolio performance contract retain every bar: at the admitted read limit with open lots, main event-loop maximum <=100 ms and p99 <=50 ms, concurrent cheap-request p95 <=100 ms, and complete report-route p95 <= matched inline baseline p95 +300 ms AND <5000 ms. Worker limits remain 256/32/4 MiB and deadline 10000 ms. No queue, retry, slot-release, fixed-error or after-commit-audit rule changes. Account and supported-owner paths require their own evidence. Historical relative p95 was not reliably met; the old 3937 ms number is not a current baseline.

The original measurement source has been located and hash-identified locally. It used nearest-rank percentiles, three warmups and twenty observations, in-process route invocation, a 10 ms event-loop histogram/heartbeat and a 50 ms SELECT 1 probe. It is not reusable unchanged: its long range and off-grid prices violate the new qualification envelope, and its old probe was a DB round trip rather than HTTP. Source recovery does not certify its historical execution or current performance.

## Root method decisions

Use the same frozen fixture, reporting clock, current authorized reader and response contract for both modes. The comparator is current inline executeQr2Job (S3a behavior), while the measured mode uses the unchanged actual default compute pool. Both validate current coverage; no product bypass, alternate registry or historical-source merge is allowed. Report that this compares execution modes on current source, not a reproduction of the historical binary.

The eventual full measurement uses a loopback-only synthetic HTTP adapter that invokes the real account/owner route and its normal deferred/after-commit path. Authentication is a labelled fixture seam, never target authentication evidence. A separate constant-response cheap endpoint on the same main event loop supplies actual HTTP observations. Client requests run independently of the measured event loop so blocked client scheduling cannot hide latency. Record the HTTP transport overhead in both modes. No application or target route is activated.

For each account/owner and inline/worker case, use three warmups and twenty retained observations, with the same transport, fixture and clock. Calculate nearest-rank route p95 from the twenty complete wall times. Record every cheap-request duration and calculate pooled nearest-rank p95 per case, also reporting per-observation tails. Record event-loop histogram maximum/p99 and heartbeat gaps for each complete observation, including one established timer tick before the request and a drained tick afterward. Report the maximum of observation p99 values rather than claiming a merged histogram percentile. All failures and outliers remain; no repeat-until-green selection. The auditor must verify boundary/aggregation behavior before implementation acceptance.

## Fixture qualification

One market, one union, five supported accounts. For aligned B, use common end B+20800 minutes and authorized starts B+[0,100,200,300,400] minutes. Of close indices 1..20800, omit 1001,1003,...,2599. Independent arithmetic gives 20800 union minutes, 20000 stored rows, five distinct windows, 99000 derivation visits and 4000 isolated missing intervals across the windows. These fit provisional limits without claiming to saturate all seven dimensions. Derive exact skeleton and identifier charges from the pinned estimator before allocating or seeding; the rough byte allowances in the proposal are not measured results. Stage 3 public interval materialization remains outside Stage 2C.

Use live fixture producers for a heavy open-lot account plus four cash-only members. The candidate 1000 BUY/320 SELL recipe is a starting shape, not proof of its row count. Derive and independently query funding, journal, fills, allocations, snapshots, current-position and exposure materializations; the owner read limit counts the last two separately. Reach the existing 5000-row admission ceiling only with legitimate bounded producer records, without changing amounts after the fact, dropping history or raising limits. If exact-cap construction fails, retain attained counts and leave at-limit acceptance open. Independently qualify cash, quantities, fees, realized/unrealized PnL and financial gate outcomes. Synthetic registration/reporting clocks must preserve funding/fill/snapshot chronology. Valuation predecessors must avoid accidental unrelated stale-price failures.

## Staged ownership and runtime gates

Root owns packet decisions, source freeze, runtime admission, evidence and Git. One author owns the entire coupled fixture/measurement harness; separate read-only financial and lifecycle reviews may run independently. No child runs PostgreSQL, browser, host work, Git or dispatches peers. Preparation may write only assigned ignored harness/report paths and execute pure analytical checks; no DB, worker, socket or HTTP process starts during preparation.

First prepare a two-job diagnostic only: one account and one five-member owner job on one fixture using the actual default pool. Verify producer counts, independently derived coverage charges, financial bodies/digests, input/output bytes and cleanup. This qualifies fixture viability and plumbing only, never percentile acceptance. The full baseline/measurement matrix requires a separate root admission after that diagnostic. Root must set finite seeding, SQL, command, process, sample and whole-run budgets from the reviewed recipe before either admission; no unbounded setup is permitted.

Every runtime admission requires refreshed account usage, source identity, no competing local tests/PG and at least 1 GiB free physical memory plus 2 GiB disk. Do not lower the gate or free unrelated resources. Use a fresh authenticated loopback cluster, explicit ownership, durable START/TERMINAL evidence, bounded identity-safe cancellation and independent verified cleanup. Never reuse retained clusters, hide failed dispose with an extra DROP, or retry automatically. Fixed guards and the 3% usage reserve remain. Resource observations are samples, not instantaneous heap guarantees.

## Open work

The exact financial seed recipe, byte accounting, independent client/HTTP implementation, monitoring-boundary tests, finite setup budget and final lifecycle source review are still preparation work. Diagnostic and full measurement are NOT RUN. The priced-account differential and current exact CI must be accepted separately. Production cap selection, Stage 3 publication/rendering, full S5 and prototype completion remain OPEN.

Spot/Paper; private source local; private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, shared/target migration, host/VPS, Live, guard reset, Best Inputs apply or backfill.
