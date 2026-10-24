# S6 API service start result

Packet: [S6-API-SERVICE-START-1](S6_API_SERVICE_START_PACKET_2026-10-24.md). Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 24 October 2026 (Bangkok). Evidence: [result record](evidence/S6_API_SERVICE_START_RESULT_2026-10-24.json).

## Outcome

The owner asked to see this packet's checklist, told root to use the answers that let the prototype be finished and tried, and confirmed the hard-gate items 2, 3, 5, 7 and 9. Before dispatch, root also checked the deployed revision's source: the API process verifies its schema and does not migrate at start, Live trading is locked in code, and the process starts no gated action by itself. The collector and runner had been built and independently reviewed twice beforehand. Root admitted one attempt, and the designated operations worker ran it once at 2026-10-24T01:04:18.180Z. It took about eight seconds and made one SSH session. Nothing was retried.

Verdict: **VERIFIED_RUNNING**.

| Phase | Result |
| --- | --- |
| P1 pre-check | All gates passed: systemd 255, user-manager linger `yes`, unit `loaded`, `inactive`/`dead` before the start, fragment identity PASS, no ExecStartPre or ExecStartPost steps, unit file state `static` |
| P2 start | One `systemctl --user start` of the exact unit, exit 0 |
| P3 verification | 2 polls about five seconds apart, both `active`/`running` with all five service predicates passing and no restart |

An independent Opus reviewer verified the linkage of manifest, marker, output and receipt and the verdict rule (RESULT_LINKAGE_VERIFIED). Root accepts this record as an observation of a successful start under the owner GO.

## What this does not establish

- Application health or HTTP readiness beyond the systemd state.
- Database identity, owner ID or applicability. Owner ID stays UNKNOWN and applicability UNKNOWN_NOT_QUERIED.
- That the service survives a host reboot. The unit file state is `static`, so the unit is not enabled to start at boot; a reboot would stop it again. Enabling it is a separate configuration change.
- Why the service had stopped, and real process termination on Windows.
- The environment files' database target. The owner confirmed it in the checklist; the run itself checked only that the unit has no extra start steps.

## What comes next

The service is left running, as the owner asked. The next step on the prototype path is [S6-OWNER-ID-RO-2](S6_QL_P2_OWNER_ID_READONLY_RO2_PACKET_2026-10-24.md), the read-only owner identity read, which needs an owner GO naming it. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, migration or target route activation took place.
