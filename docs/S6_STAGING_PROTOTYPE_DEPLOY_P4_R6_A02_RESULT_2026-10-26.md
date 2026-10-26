# S6 staging deploy P4 check r6 attempt a02: production baseline (ruling D30)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P4. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P4_R6_A02_RESULT_2026-10-26.json); [first check](S6_STAGING_PROTOTYPE_DEPLOY_P4_R6_A01_RESULT_2026-10-26.md).

## Outcome

Under a new owner GO, the read-only check ran once more at 09:33:41Z with the reviewed tool of ruling D30, listing attempt a01 as its prior attempt. Verdict **P4_CHECK_STOP** with code CHK_PROTECTED, as D30 expected, because the run compares production with the combined value P0a recorded under the old formula. Every staging check passed again. No effect: read only.

## Staging

The staging API and trading worker still run the pinned prototype in the same processes as at readiness, with no restarts. Health, heartbeat, loaded code bytes, journal (0 refusals), queue and loaded configuration all passed. No Paper row moved since the switch gate.

## Production baseline

Three production units have configuration and run digests equal to their P0a values under the new formula, which shows the formula change leaves parsed units untouched. The fourth keeps the same main process (started before the switch, no restarts, active) and now has stable digests that ignore the runtime status text of its start command. Root accepted the four digest rows of this run as the production baseline. The check, the pair rollbacks (R4, R4H) and the restore (RX) compare production against it from now on, so the rollbacks are ready at their gates again. Each rollback still needs its own owner GO.

## Residual and next

The restore (RX) does not re-check production identity after its own reload. The market stream, fallback collector and research worker stay stopped until the follow-up packet phases. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
