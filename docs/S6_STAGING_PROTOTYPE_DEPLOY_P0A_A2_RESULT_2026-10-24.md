# S6 staging deploy P0a result (second attempt)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P0a, attempt 2. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 24 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P0A_A2_RESULT_2026-10-24.json). First attempt: [result](S6_STAGING_PROTOTYPE_DEPLOY_P0A_RESULT_2026-10-24.md).

## Outcome

The owner gave a new GO-P0a for the second attempt. Root admitted one attempt against the reviewed D15 build after searching every local checkout. The designated operations worker ran it once at 2026-10-24T16:00:55.893Z: one SSH session, about 9.6 seconds, transport exit 0, no retry. The collector reached stage 10, so every read completed. Root verified the linkage of manifest, marker, receipt, envelope and retained output. The GO is consumed.

Verdict: **P0A_STOP_CONDITION**. Stop: P0A_DISK_LOW. P4 block: P4_NODE_UNVERIFIED. Fact: FACT_UNIT_STOPPED.

## What the host showed

| Area | Observation |
| --- | --- |
| Host | 2 CPUs, 7158 MiB of 7940 MiB available, load 0.03 per CPU, no heavy job, no pending job, no live payload, boot between 15 and 24 October |
| Volumes | Release trees and backup directory on one volume with 89072 MiB free; database volume path from Root's binding not found |
| Staging API | active, tree `EXACT_eb532ff`, Node 24 verified, newest code layer and admission-off layer as expected, one listener on its port |
| API flags | QR-2 flag unset in every source; the five research flags are 0 in effect (admission-off layer); one Node environment file sets the first research flag to 1, overridden by the unit setting; no heap option |
| Staging trading worker | inactive, tree `EXACT_4d86822`, Node version unverified while stopped |
| Other staging writers | 5 staging units are stopped (STG_TRADING, STG_STREAM, STG_COLLECTOR_SVC, STG_COLLECTOR_TIMER, STG_RESEARCH); every start-command file exists; all are persistent units |
| Stream and collector code | The directory walk reached the tree limit (11295 files counted each) |
| Production units | all 4 active and running |
| Database tools | PostgreSQL client and server binaries all major 16; the P2 port is free |

## What it means

The only stop comes from Root's binding, not from the host: the database data-directory path was taken from a 2 October tool and no longer exists, so the database volume could not be measured. The volume that holds the release trees and the backup directory has ample space. The API runs the eb532ff release (the hypothesis of the working-directory diagnostic is now observed), and the trading worker's tree is the 4d86822 release, but the trading worker, market stream and fallback collector are stopped, so staging Paper trading is not running now. Root ruling D16 in the packet records how each finding carries into the next phases.

Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, migration, service change, database access or target route activation took place.
