# APP-3A Bridge acceptance checkpoint — 2026-09-26

Status: **isolated Bridge engineering checks passed; phase acceptance remains open for the hosted v2 Paper timing record and deployment-specific readiness record**. This checkpoint follows `a4341f9`. It does not activate a deployment, start a Bot, certify Quant support or change production. The governing gates remain [ROADMAP.md](ROADMAP.md) and [PINE_BRIDGE_ADAPTER_API.md](PINE_BRIDGE_ADAPTER_API.md).

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

## Remaining phase evidence

1. Record hosted v2 Paper receipt/freeze/queue timing against the independently collected Spot bar under the staging execution configuration. Current real TradingView observations are capture-only; the Paper/wait measurements above are controlled fixtures. Do not describe them as an observed TradingView-to-Paper run. Preserve collector continuity and missing-bar diagnostics.
2. Complete the deployment-specific readiness manifest with reviewed warning count, exact source/artifact/snapshot references and the selected Paper fee/slippage/risk model. Operator evidence recording and owner activation remain separate actions; no readiness row or activation was created in this checkpoint.
3. Preserve earlier provider `OUTCOME_UNKNOWN` jobs without resend. Their unreturned usage/charges remain an accounting follow-up; the suite verifies recovery does not silently resubmit them.

Natural SPT `NATIVE EXIT` is **not** a requirement to wait for before accepting the controlled Bridge route. Its absence is a source-specific observation, retained in the Spot audit. The former TradingView transport fixture proves BUY/targeted NATIVE EXIT capture only; it cannot be substituted for v4 natural source evidence. The new v2 HTTP fixture supplies explicit v2 Paper routing evidence.

Quant evaluator coverage, initialization, the 2,000-bar/sample floors, repaint evidence across the required settings and optimization bounds belong to QL-2A. SPT remains `Quant UNSUPPORTED`. Automatic Futures-to-Spot source adaptation is still unimplemented; such sources remain blocked pending a separately approved supported revision. Production rollout, durable service installation and SMTP remediation retain their own operational gates.

## Private reproducibility records

- `.qa-local/audit-spt-v4-first-touch.mjs` and `.qa-local/spt-v4-first-touch-result.json` contain the read-only audit captured at 2026-09-26 05:29:01 UTC.
- `.qa-local/run-app3a-acceptance.sh` creates its own temporary PostgreSQL cluster and runs `test/postgres/pine-bridge.test.mjs` from a tracked-file source archive.
- `.qa-local/replay-spt-native-exits.mjs` and `.qa-local/spt-native-exit-replay.json` retain the historical NATIVE-exit feasibility result and initialization limitations.

Private Pine, environment files, capture URLs/tokens and raw provider bodies are excluded from Git. The evidence file paths above identify operator records rather than public downloadable source.
