# S6 staging collector diagnosis d1: the a02 collector run happened and was unloaded (H2)

Packet: [S6-STAGING-COLLECTOR-DIAG-1](S6_STAGING_COLLECTOR_DIAG_PACKET_2026-10-27.md), phase P4D, job d1. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 27 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_COLLECTOR_DIAG_D1_RESULT_2026-10-27.json).

## Outcome

Under the owner's GO, the read-only job ran once at 10:48:33Z and finished in under a second with verdict **DIAG_PASS**. Every read finished and no gate check stopped. It started, stopped and reloaded nothing. The GO is consumed (no retry).

## What the facts show

- **The collector ran in attempt a02.** About 70.6 seconds after the a02 host start, inside the expected start window, systemd logged the collector's start job as done under a new invocation. The collector printed its summary line about 0.45 seconds later. No failure, skip or later run follows in the journal.
- **systemd then unloaded it.** Today neither the collector service nor its timer is held loaded. The state read shows a fresh load with no invocation ID, nothing wants or triggers the service, and the host has not rebooted since a02.
- **The evidence is complete.** The control read of the stream journal shows the a02 period is still kept and the service manager's entries are visible.

Reading key ([packet section 4](S6_STAGING_COLLECTOR_DIAG_PACKET_2026-10-27.md)): **H2**. The run succeeded, and systemd unloaded the unreferenced unit. The a02 tool counted a run only when the unit's invocation ID changed, and an unloaded unit reads with an empty ID before and after, so it could not see this run.

## Stream snapshot

The market stream is running as the same process as at P4M attempt a03, with no restart. It has written 320 closed bars since the a03 live proof, and its journal shows no catch-up failure, stream failure, socket error or disconnect.

## Next

The collector service and timer stay stopped. Before they start again, a later packet must replace the run proof: either a journal run proof bounded after the start, or a bounded blocking start that keeps a reference until the run ends. The delayed timer-run check needs the same change. That packet needs its own owner GO.
