# S6 API service diagnostic result

Packet: [S6-API-SERVICE-RO-1](S6_API_SERVICE_MISMATCH_READONLY_PACKET_2026-10-24.md). Environment: Staging QL-P2 Prototype. Result recorded by the Claude root on 24 October 2026 (Bangkok). Evidence: [result record](evidence/S6_API_SERVICE_MISMATCH_READONLY_RESULT_2026-10-24.json).

## Outcome

The owner gave a GO naming this packet. A new collector and runner were built for it and independently reviewed in two rounds: a tester with mutation testing on copies, an Opus auditor and an Opus second opinion substituting for the paused Fable reviewer. Root then admitted one attempt with a fresh one-use manifest. The designated operations worker ran it once at 2026-10-23T19:26:15.320Z. It took about one second, made one SSH session and one read-only property query, and ended with exit status 0, no error output and no termination needed. Nothing was retried.

Verdict: **SERVICE_GUARD_MISMATCH_OBSERVED_AT_NEW_SNAPSHOT**.

| Predicate (unchanged old guard) | Result | Retained label |
| --- | --- | --- |
| Active state is `active` | FAIL | `inactive` |
| Substate is `running` | FAIL | `dead` |
| Reload flag is `no` | PASS | `no` |
| Main PID has the running shape | FAIL | no raw PID retained |
| Fragment path equals the expected path | PASS | present, not empty |

The unit identity matched the bound unit and its load state is `loaded`. In plain terms, the exact API service selected for the prototype environment is installed and configured as expected, but it was **not running** at this observation. The failed main-PID shape is consistent with an inactive unit; the raw value was not stored.

An independent Opus reviewer verified the linkage of the manifest, marker, output and receipt, the timing inside the admission window, the transport fields, the predicate conclusions and the absence of raw data. Root accepts this record as a diagnostic observation only.

## What this does not establish

- It does not prove why the earlier owner-ID attempt stopped. A new observation cannot establish the historical cause, although a stopped service would explain that guard failing.
- It does not say why the service is stopped. No logs, status output or journal were read.
- It establishes no service health, serving revision, database identity, owner ID or applicability. Owner ID stays UNKNOWN and applicability UNKNOWN_NOT_QUERIED.
- Real process termination on Windows remains unverified; it was not needed in this run.

## What comes next

Starting, restarting or repairing the service is a service change. It needs its own reviewed packet and an explicit owner GO naming that packet; the earlier GO and the owner's continuous local authority do not cover it. A later owner-ID read also needs the service guard to pass first. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, service change or target route activation took place.
