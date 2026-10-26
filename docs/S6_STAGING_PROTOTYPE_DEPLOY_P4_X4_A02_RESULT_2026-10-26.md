# S6 staging deploy P4 result (switch job x4, attempt a02)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P4. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P4_X4_A02_RESULT_2026-10-26.json); [attempt a01](S6_STAGING_PROTOTYPE_DEPLOY_P4_X4_A01_RESULT_2026-10-26.md).

## Outcome

Under the owner's GO-P4 for attempt a02, the designated operations worker ran the switch job once at 04:49:30Z: one SSH session, about 22 seconds, no retry. Verdict **P4_STOP_AFTER_READY** with code CHK_PROTECTED. GO-P4 is consumed.

## What happened on staging

- Fresh gate: production identities equal to the P3 record, no other unit needing a reload, login manager not killing user processes, no heavy job, the startup probe passed read only on the same database, both staged trees exact.
- Switch: the API stopped (the trading worker was already stopped), the Paper counter baseline was read and a pre-switch backup of 7998842 bytes was taken; both layers were written, one reload, the loaded gate passed, the API started and became ready, and the trading worker started on the pin and became ready with a fresh heartbeat. The API gap was 6.8 seconds.
- Immediate checks: served assets 34 of 34 and auth routes 6 of 6 matched, the loaded configuration passed; then the production-identity check found a difference from the value that matched at the gate about 20 seconds earlier. The record does not say which production unit or which field changed. The remaining immediate checks and the r5 check did not run.

## State now

The staging API and trading worker run the pinned prototype. The market stream, fallback collector and research worker stay stopped. No automatic rollback runs after readiness. While the production identity differs from the recorded value, the delayed check and the pair rollbacks refuse before any effect. Root asks the owner to check production first and to decide on the staging pair. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
