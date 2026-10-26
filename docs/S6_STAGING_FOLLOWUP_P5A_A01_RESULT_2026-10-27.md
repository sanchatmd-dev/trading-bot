# S6 staging follow-up P5a: per-Bot performance panel on

Packet: [S6-STAGING-PROTO-FOLLOWUP-1](S6_STAGING_PROTOTYPE_FOLLOWUP_PACKET_2026-10-26.md) (revision 5), phase P5a. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 27 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_FOLLOWUP_P5A_A01_RESULT_2026-10-27.json); [tool build](evidence/S6_STAGING_FOLLOWUP_P5A_BUILD_2026-10-27.json).

## Outcome

Under the owner's GO, the job ran once from 19:52:17Z to 19:56:51Z with verdict **P5A_PASS**. The staging API stopped, one drop-in layer set the QR-2 flag to 1, one manager reload ran, and the API started again on the same pinned tree. The API was unavailable for 4.4 seconds (bound 280 seconds).

## Checks

All immediate checks passed: served pages, authenticated routes including the three QR-2 routes, health, heartbeat, loaded configuration (QR-2 effective 1 from the new layer only, research flags 0, no heap option), loaded code bytes, journal (no refusal lines), queue and production identity. The delayed check about 266 seconds after readiness passed. The trading worker kept its process; the research worker, market stream and fallback collector stayed stopped.

## Production

The four production units read equal to the r6 a02 baseline after the shared manager reload (combined digest `b5789332`), so the D30 normalisation held across a real reload.

## Owner check

The owner asked Root to run the browser check of the per-Bot panel (27 October 2026, about 03:00 Bangkok). Root opened the staging web app through the owner's own port forwarding in the owner's signed-in browser, view only, entered no credential and changed no setting. The Overview page shows the "Paper account performance" panel with its report scope, Bot, broker, currency and period controls.

- SPT Prototype Paper Bot, period All Time Registered: "Server report received". Book equity (cost basis) 997.09 USDT, available cash, reserved notional and fees, unbacked equity and capital flows are COMPLETE. Marked equity, realized and unrealized PnL, fees, money PnL, TWR, Modified Dietz and max drawdown read UNAVAILABLE with RECONCILIATION_FAILED (first failure from 3 October, code LEDGER_RULE_UNREPLAYABLE, not the whole account, no ledger invariant violated); exposure NAV_NOT_AVAILABLE. Bar coverage: inspection completed, one gap from 17 October 12:28Z to now (13,416 missing minutes, the market writers are stopped). Reads: 1 funding, 24 journal rows, 24 fills, 12 lots, 25 snapshots; read 497 ms, compute 15 ms. A second load gave the same answer.
- Main Bot, period Week: "Server report received", COMPLETE, book equity 1000 USDT, reconciliation OK, 1 funding and 1 snapshot, no fill.
- Main Bot, custom range 4 to 26 October: "Server report received", COMPLETE.
- Main Bot, periods Month and All Time Registered, and custom range 1 to 26 October; QL-3A SPT Custom Paper Bot, All Time Registered: refused, HTTP 503 QR2_REPORT_FAILED.

Reading: the panel and the per-Bot route work on staging. A 503 appears only when the report range reaches back before the stored staging market bars begin (about 3 October); in the pinned code the market-bar coverage step maps its range-admission refusal to QR2_REPORT_FAILED. This is a product finding for a later packet; P4M fills only the recent gap and does not change it.

## Next

P4M (fresh market data) binds against this record and needs its own owner GO. R5a turns the panel off again and needs its own owner GO. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
