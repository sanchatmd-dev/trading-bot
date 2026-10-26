# S6 staging deploy P4 delayed check (r6) and ruling D29

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P4. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P4_R6_A01_RESULT_2026-10-26.json); [switch attempt a02](S6_STAGING_PROTOTYPE_DEPLOY_P4_X4_A02_RESULT_2026-10-26.md).

## Outcome

With the owner's consent, the read-only delayed check ran once at 06:42:55Z, about 113 minutes after the trading worker became ready. Verdict **P4_CHECK_STOP** with code CHK_PROTECTED, because one production identity still differs. Every staging check passed.

## Staging

The staging API and trading worker run the pinned prototype: same processes as at readiness, no restarts, both new trees exact. Health, heartbeat, loaded code bytes, journal (0 refusals), queue and loaded configuration all passed. No Paper row moved since the switch gate.

## Production (ruling D29)

Three of the four production units are unchanged. The fourth keeps the same main process (started before the switch, no restarts, active); only its configuration digest changed. Its start command is in a form the strict parser does not split, so the digest includes the raw start-command line, whose runtime status fields systemd shows differently after the switch's one in-scope reload of the shared service manager. The owner reported production healthy. Root accepts P4 as switched with the staging checks passed.

## Residual and next

Until a reviewed re-baseline of the production identity, the pair rollbacks (R4, R4H) and any later check compare the old identity and refuse before any effect; any rollback needs its own owner GO. The market stream, fallback collector and research worker stay stopped as the packet requires. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
