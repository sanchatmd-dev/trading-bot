# S6 staging deploy P1 result (attempt a02)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P1. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 25 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P1_A02_RESULT_2026-10-25.json); first attempt: [a01](S6_STAGING_PROTOTYPE_DEPLOY_P1_A01_RESULT_2026-10-25.md).

## Outcome

Under a new owner GO-P1 for attempt a02 (pin `ba1a433`, QR-2 O7 included), the designated operations worker ran the reviewed tool once at 2026-10-25T00:40:52.263Z: one SSH session, about 14 seconds, exit 0, no retry. Verdict **P1_PASS**. Root verified the linkage.

| Check | Result |
| --- | --- |
| Package received | 55362089 bytes, 4 files, digests and framing match |
| API tree | staged exact: 1589 files, digest match, 0 bad, extra or missing; node --check 145 files, 0 failed |
| Trading tree | staged exact: 1589 files, digest match; node --check 38 files, 0 failed |
| Units | all ten loaded; configuration and run state unchanged (no start, stop, reload or drop-in) |
| Old trees | preserved; the stage directory gained the incoming copy and the two new trees |
| Host | Node major 24, 7078 MiB available, load 0.01 per CPU |

## What it means

The new version is on the staging host but inert: no unit uses it until P4. P0b runs next under the owner GO-P0b, reading the database read-only from the staged API tree. P2 to P5a each need a new owner GO. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment activation, migration, service change or database access took place.
