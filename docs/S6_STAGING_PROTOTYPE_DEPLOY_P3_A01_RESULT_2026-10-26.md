# S6 staging deploy P3 result (attempt a01)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P3. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P3_A01_RESULT_2026-10-26.json); [build record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P3_BUILD_2026-10-26.json).

## Outcome

Under the owner's GO-P3 (full typed text, equal to the packet wording), Root admitted one attempt (a01). The designated operations worker ran it once at 2026-10-25T17:30:44.559Z: one SSH session, about 6 seconds, no retry. Root verified the linkage. GO-P3 is consumed.

Verdict: **P3_STOP_PRE**, code **FG_STOP_TIMEOUT**, at the fresh gate before any effect. No unit was stopped, no backup was taken and no migration ran; the staging API kept running.

## What the gate saw

Only the staging API was running, as expected; the trading worker, market stream, fallback collector and research worker were proved stopped; the production identities were unchanged. Then two tool limits met the real host:

- The staging API unit's stop timeout is finite but above the 80 seconds that the tool's 90-second stop budget allows with its 10-second margin. The unit policy recorded for staging and the systemd default are both 90 seconds.
- The stream and fallback-collector code-directory walks both stopped at their tree limit, at a different file count than the P0a walk. Two partial walks cannot be compared by count; ruling D16 had called this baseline partial. The tool recorded this as drift, which would have stopped the gate at its end.

Neither is a change on staging.

## What comes next

Ruling D23 widens the P3 and R3 stop budget and makes two partial code-directory walks a recorded fact (a missing or unreadable directory still stops). After a reviewed fix round, attempt a02 lists a01 as its prior attempt, waits for the overlap rule (2845 seconds after a01 started) and needs a new owner GO-P3. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
