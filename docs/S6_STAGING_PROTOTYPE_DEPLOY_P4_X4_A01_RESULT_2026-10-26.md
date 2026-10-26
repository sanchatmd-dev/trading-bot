# S6 staging deploy P4 result (switch job x4, attempt a01)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P4. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P4_X4_A01_RESULT_2026-10-26.json).

## Outcome

Root issued GO-P4 from the packet line under the owner authority given on 25 October 2026 and admitted attempt a01. The designated operations worker ran it once at 04:15:02Z: one SSH session, about 1.5 seconds, no retry. Verdict **P4_STOP_PRE** with code COLLECTION_UNKNOWN at the first host stage (bound validation): no unit, database or file was touched, and no record directory was created. GO-P4 is consumed.

## Cause

Root reproduced the refusal locally on the exact bytes sent: one public asset of the pinned package, a 5.07 MB image, is above the tool's 4 MiB per-asset bound. The runner did not run the same bound validation before writing its one-use marker, so an input problem that the local side could have caught consumed the GO.

## What comes next

Ruling D27: the per-asset bound becomes 8 MiB and the runner validates the bound before the marker. After that fix round, attempt a02 needs a new owner GO-P4. Staging is unchanged since P3. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
