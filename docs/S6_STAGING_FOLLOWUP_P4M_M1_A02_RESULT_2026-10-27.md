# S6 staging follow-up P4M m1 attempt a02: stream proved, collector run unproved, rolled back

Packet: [S6-STAGING-PROTO-FOLLOWUP-1](S6_STAGING_PROTOTYPE_FOLLOWUP_PACKET_2026-10-26.md), phase P4M, job m1. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 27 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_FOLLOWUP_P4M_M1_A02_RESULT_2026-10-27.json).

## Outcome

Under the owner's GO, the job ran once from 02:03:53Z to 02:05:34Z: verdict **P4M_STOP_ROLLED_BACK**, code M_COLLECTOR_NOSTART. The GO is consumed (no retry).

## What happened

The gate passed in full, including the fallback collector timer's calendar trigger (ruling D38). The tool started the market stream, which caught up the 14-page gap in about 30 seconds and stored a live bar about 35 seconds later; the stored BTCUSDT 1m bars are contiguous from 2026-10-17T12:28Z to 2026-10-27T02:05Z. The tool then started the fallback collector service once without blocking. The start was accepted, but the service's invocation did not change within 30 seconds, so the run could not be proved and the tool rolled back as designed: it stopped the stream and proved all three market units stopped and inactive with no job left. The stored bars stay. The staging API and trading worker were not touched, and production identity stayed equal to the baseline.

The likely cause is a very short collector run (nothing was left to fetch) whose unit systemd unloaded before the next read. A start skipped by a unit condition or a dependency is not excluded.

## Next

The owner chose to run P4M with the stream only. Ruling D40 removes the collector run and the timer start from m1 and moves the delayed check to 600 seconds after the live proof. Ruling D41 adds a gate rule so that starting the stream cannot start the collector or the timer (packet revision 9). Both tools were re-verified and re-pinned. The retry is attempt a03, listing a01 and a02 as prior attempts, and needs a new owner GO. A later packet looks at the collector's last run, read only, before any collector or timer start.
