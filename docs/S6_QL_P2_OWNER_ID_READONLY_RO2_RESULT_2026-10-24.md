# S6 owner identity read RO-2 result

Packet: [S6-OWNER-ID-RO-2](S6_QL_P2_OWNER_ID_READONLY_RO2_PACKET_2026-10-24.md). Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 24 October 2026 (Bangkok). Evidence: [result record](evidence/S6_QL_P2_OWNER_ID_READONLY_RO2_RESULT_2026-10-24.json).

## Outcome

The owner gave a GO naming this packet after the service start was verified. The collector and runner had been built and reviewed beforehand. Root admitted one attempt, and the designated operations worker ran it once at 2026-10-24T02:13:00.591Z. It took about one second and made one SSH session. Nothing was retried.

Verdict: **STOP_UNKNOWN**, code `API_REVISION_MISMATCH`.

| Stage | Result |
| --- | --- |
| Binding | PASS |
| Service guard | PASS: the service is `active`/`running` and all five predicates pass |
| Serving process | STOP: the running process working directory differs from the frozen expected working directory |
| Artifact, database channel, database identity and schema, identity read, stability recheck | not run |

The code name says revision, but the check that fired is an exact comparison of the running process working directory, as reported by the kernel, with the frozen expected value. It does not show that a different revision is deployed, because the artifact and revision stages never ran. No database client was created and no SQL ran. An independent reviewer verified the result linkage; root accepts this record as a stop record only.

## What this does not establish

- Which of several explanations is true: a symbolic link in the frozen path that the kernel resolves, a different working directory set by the unit, a replaced or deleted release directory, a different release, or a stale frozen value.
- The serving revision, database identity, owner ID or applicability. Owner ID stays UNKNOWN and applicability UNKNOWN_NOT_QUERIED.

## What comes next

A separately reviewed read-only diagnostic would classify the difference (equal after resolving links, deleted release, other) without exposing the path, under its own owner GO. This attempt is consumed and is not retried. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, database write or service change took place.
