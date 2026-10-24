# S6 staging deploy P0a result (first attempt)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P0a. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 24 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P0A_RESULT_2026-10-24.json).

## Outcome

The owner gave GO-P0a with the packet wording and notAfter 2026-10-25T14:00:00Z. Root admitted one attempt against the reviewed D14 build, after searching every local checkout for an earlier attempt. The designated operations worker ran it once at 2026-10-24T15:08:58.859Z: one SSH session, about 1.2 seconds, transport exit 0, no retry. The GO is consumed.

Verdict: **STOP_UNKNOWN** at stage 3 (unit properties), code **MISSING_KEY**. Stages 1 (binding) and 2 (host health) completed. Root verified the linkage of manifest, marker, receipt, envelope and retained output.

## What it means

One property that the collector asked `systemctl show` for was absent from the output, and the collector requires every requested key. Tracked evidence from 15 October 2026 ([DP1-P property observation](evidence/DP1P_PROPERTY_OBSERVATION_2026-10-15.json)) recorded the same behaviour on this host: `systemctl show --all` leaves out EnvironmentFiles for a unit that has none, because list-of-record properties print one line per entry. That is the likely cause; the attempt does not show which unit or key it was.

## What comes next

Root ruling D15 in the packet: an absent ExecStart or EnvironmentFiles is recorded as ABSENT, never as empty. For the staging API, ABSENT EnvironmentFiles counts as no systemd environment file only when its loaded unit text declares none; otherwise P0a stops. A reviewed collector fix and a new owner GO naming P0a come before another attempt. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, migration, service change, database access or target route activation took place.
