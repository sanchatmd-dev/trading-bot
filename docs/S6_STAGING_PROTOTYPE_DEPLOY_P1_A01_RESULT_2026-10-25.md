# S6 staging deploy P1 result (attempt a01)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P1. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 25 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P1_A01_RESULT_2026-10-25.json); [build record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P1_BUILD_2026-10-25.json).

## Outcome

Under the owner's permission for GO-P1 when ready, Root admitted one attempt (a01) with the reviewed tool and the package built from pin `ba1a433`. The designated operations worker ran it once at 2026-10-24T19:57:45.394Z: one SSH session, about 6 seconds, exit 0, no retry. The host received the whole package (55362089 bytes, 4 files) and every digest, the framing and the check lists matched; the host Node is major 24 and both stage directories belong to the session account.

Verdict: **P1_STOP_PRE**, code **PRE_STAGE_ANCHOR**, effect phase **PRE**: nothing was written on the host. Root verified the linkage. GO-P1 is consumed.

## Cause

Root's binding pointed the API stage directory one level too high: the R7B release tool kept its trees in a releases subdirectory, so the API anchor tree was not found where the binding said. That subdirectory is the same directory that holds the trading trees, so the second attempt binds both stage directories to it.

## What comes next

Attempt a02 is prepared in a new run directory and lists a01 as a prior attempt; it needs a new owner GO-P1. P0b waits, because it runs from the API tree that P1 stages. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no host write, deployment, migration, service change or database access took place.
