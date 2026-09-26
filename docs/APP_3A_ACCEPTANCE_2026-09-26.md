# APP-3A Bridge acceptance checkpoint — 2026-09-26

Status: **APP-3A Bridge engineering acceptance passed in staging; QL-2A may start**. Hosted Paper timing and deployment-specific readiness recording are complete. The earlier checkpoint followed `a4341f9`, with the isolated suite committed as `987adc3`. Owner SPT activation, production rollout and Quant certification remain separate. The governing gates remain [ROADMAP.md](ROADMAP.md) and [PINE_BRIDGE_ADAPTER_API.md](PINE_BRIDGE_ADAPTER_API.md).

## Evidence reviewed

| Check | Result and scope |
| --- | --- |
| Direct AI and source integrity | Approved Spot revision 4 analyzed/generated successfully. Its source prefix is unchanged. Artifact, source and frozen input hashes are recorded in the Spot audit. |
| Compilation and inputs | Integrated v4 compiled on standard BINANCE:BTCUSDT 1m. Saved/reopened inputs match the DRAFT snapshot, including HTF off, native notifications off and Bridge 2.0/1.5. The TradingView repaint caution has a bounded source review; Quant readiness is separate. |
| v4 real capture | 22 unique events: 11 BUY, 8 SL EXIT and 3 TP EXIT. 21 duplicate deliveries, 0 rejected, 0 Bridge execution events. All 22 frozen market hashes were present at intake. |
| v4 first-touch audit | Every captured EXIT targets a captured BUY and occurs on its first SL/TP touch across all intervening frozen candles. Missing references, interval gaps, first-touch mismatches, BUY close/ATR mismatches and rounded-level mismatches are all 0. The auxiliary original HTF-off native trace has no missing observations or earlier native EXIT flags in those intervals; it remains separate from the v4 snapshot. |
| Focused Node checks | 22 passed, 0 failed across Bridge contract, market, UI and existing SPT transport tests. The older SPT transport tests do not imply that their legacy artifact is the v4 artifact. |
| Isolated PostgreSQL checks | 24 passed, 0 failed. A new Unix-socket-only temporary cluster hosted per-run databases. The runner stopped that cluster afterward. No production or active capture database was used by the tests. |
| v2 HTTP targeted NATIVE EXIT | Real loopback HTTP v2 receiver and execution worker open Paper allocations and close only the referenced long. A second long and another Bot's allocation remain open. Repeated BUY/EXIT deliveries cause no duplicate fills or capture writes. v2 on the v1 route is rejected. Synthetic source/data are explicitly fixture evidence. |
| v2 bounded market wait | No signal exists while the matching bar is missing. Concurrent retries create one pending intent. After the bar is committed, BUY queues and fills; a separately delayed NATIVE EXIT then closes that long. Observed fixture timings: receipt-to-freeze commit 222 ms, freeze-to-queue commit 12 ms, total 234 ms. These are wall-clock fixture measurements, not a TradingView/live-stream latency distribution. |
| v2 expiry | Deadline is exactly receipt + 5,000 ms unless the signal-age deadline is earlier. The expiry check occurred at 5,021 ms; the intent was already ineligible after its 5,000 ms deadline and created 0 signals. A late bar/retry does not revive it. Changed retry facts conflict. |
| v2 revalidation | Waiting does not extend signal age. Changed policy and mismatched market ATR reject before queue admission with 0 signals. Existing suite checks owner scope, revision/capital changes, recovery/cancellation, fail-closed readiness and backup/restore. |

The suite-wide capture assertions were corrected to compare counts before and after each HTTP fixture, because earlier tests deliberately insert capture events. The capture quota test now verifies the last permitted delivery at the current 10,000-delivery limit and rejects the next delivery. These are test corrections; runtime behavior was not changed.

## Hosted Paper closure evidence

At 2026-09-26 05:52 UTC, a fresh Unix-socket-only PostgreSQL cluster hosted an independent test Bot, HTTP API and continuously running Paper/market-wait workers. The canary reused the exact compiled Spot v4 source/artifact and its embedded deployment identity **only inside this separate database**. Its Bot policy, capital, session and snapshot were rebuilt for that test Bot. No existing capture deployment was activated. Runtime processes used a restricted database role that could not write market bars or readiness evidence; the operator recorded evidence and exercised owner activation separately in the canary.

The market input consisted of independently collected, hash-checked Binance Spot 1m closed bars. Controlled HTTP BUY and targeted NATIVE EXIT intents deliberately preceded insertion of their matching bars into the canary database by about 200 ms. No signal existed before those bars were committed. These are hosted runtime measurements with real market bars, **not natural SPT signals or an observed TradingView-to-Paper execution**.

| Measurement | BUY | Targeted NATIVE EXIT |
| --- | --- | --- |
| Closed-bar timestamp, milliseconds UTC | 1790401800000 | 1790401860000 |
| HTTP receipt timestamp | 1790401933045 | 1790401933807 |
| Market commit observed | 1790401933284 | 1790401934020 |
| Queue validation timestamp | 1790401933473 | 1790401934225 |
| Queue commit observed | 1790401933519 | 1790401934257 |
| Receipt to market commit observed | 239 ms | 213 ms |
| Market commit to queue commit observed | 235 ms | 237 ms |
| Receipt to queue commit observed | 474 ms | 450 ms |
| Worker outcome | FILLED | FILLED |

Post-commit observation includes database polling overhead; these two samples are not a latency distribution. Duplicate deliveries produced **0 additional fills**. The two fills were BUY/SELL of 0.01189 BTC at 83,986.95/83,970.16, with quote fees 0.9986048355/0.9984052024. The targeted long closed fully; no short allocation was created. The canary Bot was stopped, both runtime children exited and its database/cluster were removed/stopped.

The expiry case received at `1790401934539` had deadline `1790401939539`, exactly 5,000 ms later. The polling worker recorded `MARKET_WAIT_EXPIRED` at `1790401939735` (5,196 ms after receipt). The extra 196 ms is the time until recording the expired status, not additional eligibility: queue admission refuses an expired deadline. The case created **0 signals and 0 fills**; a late real bar and duplicate retry did not revive it.

### Readiness manifest and selected model

The private original-deployment manifest records source version 4, exact source/artifact/snapshot hashes, effective chart inputs, 0 compilation errors, and **1 reviewed generic TradingView alert repaint caution**. This caution is not claimed to be a compiler error or proof that the source never repaints. Native notifications are off, HTF is off, Spot mode is `Long + Exit`, Bridge values are 2.0/1.5 and dynamic slots are 0. The 10 SL / 10 TP / 5 simultaneous / 5 native-conflict / 5 rejected / 5 capped cases reference the controlled suite; they are not invented counts of natural SPT signals. The public, secret-free evidence summary is [the readiness record](evidence/APP_3A_READINESS_2026-09-26.json).

The selected **canary** model is `paper-close-v1`, price tick 0.01, quantity step 0.00001, fee 10 bps, slippage 1 bp and risk 1%, with 1,000 quote units of configured capital. Its test policy permits BUY plus reduce-only exits and uses a 300-second signal-age limit to replay recently closed collector bars; production and the original owner's settings were not relaxed. The 5-second wait remains independent of that age limit.

A rehearsal with **10 bps slippage was correctly rejected** (`BUY take profit must be above entry`): in this quiet market the slipped BUY price exceeded the frozen ATR/RR TP. Selecting 1 bp establishes this canary's supported model, not approval of 1 bp for production or evidence that 10 bps always works. QL-2A must reproduce rejection, fees, sizing caps and cost stress rather than forcing fills or moving the frozen protection levels.

The original DRAFT has no readiness row written and no owner activation. Its operator manifest is review evidence, not an activation grant. The isolated replica has snapshot hash `3885169ec524ed7d1617007f5444a8583c07d8b6571a22a7a811686450d43766` and evidence hash `725451c38616a6a985bfd66a4455497d45ab036e11900128cdba4aada7045304`. A post-run read-only check confirmed the original remains **DRAFT, 0 execution events**, with its v4 capture still 22 received / 21 duplicate / 0 rejected. The auxiliary trace increased to 828 received / 0 rejected; collector/capture continuity was preserved.

## Follow-ups outside APP-3A closure

Preserve earlier provider `OUTCOME_UNKNOWN` jobs without resend. Their unreturned usage/charges remain an accounting follow-up; the suite verifies recovery does not silently resubmit them. Owner activation requires a fresh review of policy/capital/membership, market metadata and the chosen execution model; the canary activation does not activate or approve the owner's Bot.

Natural SPT `NATIVE EXIT` is **not** a requirement to wait for before accepting the controlled Bridge route. Its absence is a source-specific observation, retained in the Spot audit. The former TradingView transport fixture proves BUY/targeted NATIVE EXIT capture only; it cannot be substituted for v4 natural source evidence. The new v2 HTTP fixture supplies explicit v2 Paper routing evidence.

Quant evaluator coverage, initialization, the 2,000-bar/sample floors, repaint evidence across the required settings and optimization bounds belong to QL-2A. SPT remains `Quant UNSUPPORTED`. Automatic Futures-to-Spot source adaptation is still unimplemented; such sources remain blocked pending a separately approved supported revision. Production rollout, durable service installation and SMTP remediation retain their own operational gates.

## Private reproducibility records

- `.qa-local/audit-spt-v4-first-touch.mjs` and `.qa-local/spt-v4-first-touch-result.json` contain the read-only audit captured at 2026-09-26 05:29:01 UTC.
- `.qa-local/run-app3a-acceptance.sh` creates its own temporary PostgreSQL cluster and runs `test/postgres/pine-bridge.test.mjs` from a tracked-file source archive.
- `.qa-local/replay-spt-native-exits.mjs` and `.qa-local/spt-native-exit-replay.json` retain the historical NATIVE-exit feasibility result and initialization limitations.
- `.qa-local/export-app3a-hosted-bundle.mjs` performs a read-only source/market export; `.qa-local/run-app3a-hosted.sh` creates the separate cluster. `scripts/app3a-hosted-paper-canary.mjs` exercises the hosted runtime and cleanup. Its private results are `.qa-local/app3a-hosted-result.json` and `.qa-local/spt-v4-readiness-manifest.json`.

Private Pine, environment files, capture URLs/tokens and raw provider bodies are excluded from Git. The evidence file paths above identify operator records rather than public downloadable source.
