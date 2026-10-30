# S6 QR-2 boundary read attempt a01: collected, E0 start stays proven

Packet: [S6-QR2-BOUNDARY-READ-1](S6_QR2_BOUNDARY_READ_1_PACKET_2026-10-30.md), phase BR. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 30 October 2026 (Bangkok).

Evidence: [result record](evidence/S6_QR2_BOUNDARY_READ_1_A01_RESULT_2026-10-30.json).

## Outcome

The owner pasted the GO-BR line for attempt a01 in chat; Root set notAfter to 2026-10-31T14:00:00Z under the 24-hour precedent. The job ran once, is consumed, and had no retry.

**Verdict: BR_PASS.** The read ran from 14:16:19.913Z to 14:16:20.055Z (142 ms) in one read-only repeatable-read transaction, then rolled back. Transport exit 0, no stderr, one database session, no overall breach. An independent linkage review found the manifest, receipt, envelope and retained output linked and the block shapes and labels valid.

## What was read

One fixed query set over fills, signals, users, legacy positions, ledger allocations and worker heartbeats, plus the schema version, the column catalog and the server identity settings. It returned counts, epoch times, fixed labels, ordinals and Bot slot numbers only.

- **Database:** read-only true, PostgreSQL major 16, identity equal, schema version 14, 37 required columns present.
- **Scopes:** two, both with the same owner ordinal. No non-Paper fill. Bot slot 2 and Bot slot 3.

## Results per Bot

| Bot slot | Fills | Buys / sells | First fill (UTC) | Last fill (UTC) | Before E0 |
| --- | --- | --- | --- | --- | --- |
| 2 | 3 | 2 / 1 | 2026-09-26 11:37:02 | 2026-09-27 00:34:02 | 3 |
| 3 | 24 | 12 / 12 | 2026-10-03 12:02:02 | 2026-10-08 02:05:07 | 0 |

- **Slot 2** has 3 fills, all before the E0 start (26 and 27 September): two buys and one sell. All carry no marker.
- **Slot 3** has 24 fills, all in E0 (3 to 8 October). Its first fill is the P2 key fill, and the P2 signal belongs to this scope only.
- **No later fills:** nothing at or after the switch gap, the E2 start or after 8 October. Both Bots have no legacy open position.
- **Lots:** every BUY has a fee-inclusive lot (2 pairs for slot 2, 12 for slot 3); no pair without fee, no tie, no missing quote, no quantity difference, no fill before the first lot.

## Outcomes per unknown

- **U1, E0 start:** refuted for slot 2 only, by its 3 pre-E0 fills. Slot 3 has none. The P2 failed-from point is confirmed.
- **U2, E0 end, gap and E1 start; E1 and E2 edges:** not refuted, but vacuous. No fill sits near or after those edges, so the read cannot confirm them positively.
- **U4, markers:** all ABSENT (3 before E0, 24 in E0). The later epochs have no fills, so no marker evidence.
- **U5, lot fee boundary:** null confirmed.
- **U6, lot table boundary:** null confirmed.
- **U7, quiet E1 tail:** no sign. No leftover old-role heartbeat, so this read gives no stop time for the earlier worker (T8 stays unsettled).
- **U8, other writers:** no sign. No late fill without an intent, no backlog, no cross-bucket signal, no orphan lot scope.
- **Q6, old open quantity:** none open in either scope.
- **E0 earlier start:** **NOT PROVEN.** No tracked record names the worker tree of 26 and 27 September (a mixed tree and a separate operator checkout). The code content points to the E0 booking rule, but that is inference, not deployment evidence, and the packet forbids moving E0 earlier on inference.

## What it means for the record

The proven E0 start (2026-10-01T16:16Z) stays unless the owner decides otherwise. Root recommends keeping it: Bot 3 then reconciles, and the three test-era fills of Bot 2 stay "stopped by design" with a note. The owner decides. A further packet (U3) would be needed to prove an earlier start.

## State now

- Staging is unchanged: the API runs pin `33e5a8c` and the trading worker runs `ba1a433`. No database write, no unit command, no file change on the host.
- Production is untouched.
- Scope: Spot/Paper only, and Live is hard-locked. Private acceptance is not run; READY is false; P13j and N1 stay held.
