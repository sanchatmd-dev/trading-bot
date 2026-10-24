# S6 API working-directory diagnostic result

Packet: [S6-API-CWD-RO-1](S6_API_CWD_READONLY_PACKET_2026-10-24.md). Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 24 October 2026 (Bangkok). Evidence: [result record](evidence/S6_API_CWD_READONLY_RESULT_2026-10-24.json).

## Outcome

The owner gave a GO naming this packet with the packet's full suggested wording. Root admitted one attempt against the reviewed build pinned in the [preparation evidence](evidence/S6_API_CWD_READONLY_PREPARATION_2026-10-24.json), after searching every local checkout for an earlier attempt. The designated operations worker ran it once at 2026-10-24T09:15:10.067Z: one SSH session, about 1.3 seconds, exit 0, no retry. The service guard passed (active and running, no pending reload, unit identity matched), and all five stages passed.

Verdict: **CWD_CLASSIFIED_AT_NEW_SNAPSHOT**, class **OTHER**.

| Field | Value |
| --- | --- |
| Exact, resolved, release-directory, home or root equality | all false |
| Frozen directory | a real directory (`DIRECTORY`), not a symlink, resolves to itself |
| Frozen release directory | resolves to the frozen directory (`true`) |
| Process directory relative to the frozen directory | `SIBLING` |
| Live server-script argument | resolves to the process directory (`EQUAL_KERNEL_CWD`) |
| Unit WorkingDirectory | equals the process directory (`EQUAL_KERNEL_CWD`) |
| Live argument vector equals the frozen one | `false` |

An independent Opus reviewer verified the linkage of manifest, marker, receipt, envelope and retained output, recomputed the verdict and the class from the reviewed code, and found no path, PID or unit name in the retained output (RESULT_LINKAGE_VERIFIED). Root accepts this record as an observation.

## What it means

The API service runs from a directory next to the one the binding was frozen from. The unit configuration and the running process agree with each other; the frozen binding is what no longer describes the service. Tracked release evidence shows that the combined S07 staging release switched the API to a new release through systemd drop-ins on 8 October 2026, which fits this result if the binding was frozen from the earlier base release. That is a hypothesis: this attempt returns no paths and does not show which revision runs.

Because the earlier pre-start source review covered revision 5e398e7, root re-checked the source of the API revisions that tracked evidence records as activated afterwards: 325d335 (S07, 8 October) and eb532ff (R7B, 9 October), the latest API activation recorded. At both revisions the API verifies schema 14 without migrating at start, Live trading is locked in code with no environment switch that enables it, and the API process starts no order or fund action by itself. The safety basis of the owner's start GO therefore holds for any of these revisions. The live process runs the `src/postgres/server.js` entry, since its release-directory label was derived from exactly one such argument.

## What this does not establish

- Which revision runs in the sibling directory, or whether its content differs from the frozen one.
- When or why the unit configuration changed.
- Owner ID or applicability. Owner ID stays UNKNOWN and applicability UNKNOWN_NOT_QUERIED.
- Real process termination behaviour on Windows.

## What comes next

The result is blocking under the packet's outcome table: class OTHER, and a live argument vector that differs from the frozen one blocks any owner-ID packet on its own. No retry, re-freeze or restart follows from it. The next step is either the owner's explanation of the intended staging layout, or a separately reviewed binding-update packet that re-freezes the working directory and argument vector with owner-supplied values, followed by a new owner-ID read packet. Each needs its own owner GO. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, migration, service change or target route activation took place.
