# S6 staging follow-up P4M attempt a03: market stream on (stream only), delayed check passed

Packet: [S6-STAGING-PROTO-FOLLOWUP-1](S6_STAGING_PROTOTYPE_FOLLOWUP_PACKET_2026-10-26.md), phase P4M, jobs m1 and m6. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 27 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_FOLLOWUP_P4M_A03_RESULT_2026-10-27.json). Earlier attempts: [a01](S6_STAGING_FOLLOWUP_P4M_M1_A01_RESULT_2026-10-27.md), [a02](S6_STAGING_FOLLOWUP_P4M_M1_A02_RESULT_2026-10-27.md).

## Outcome

Under the owner's GO for attempt a03, job m1 ran once from 05:27:27Z to 05:28:02Z with verdict **P4M_PASS**, and the read-only delayed check m6 ran once at 05:39:30Z with verdict **P4M_M6_PASS**. Both jobs are consumed (no retry).

## m1: start the market stream (stream only)

The gate passed in full, including the rule from ruling D41 that the stream's start lists name neither the fallback collector service nor its timer. The tool started the staging market stream on its current code. It caught up the one-page gap left since attempt a02 and stored a live bar about 30 seconds later; the stored BTCUSDT 1m bars are contiguous from 2026-10-27T02:05Z to 2026-10-27T05:28Z. As ruling D40 requires, the collector service and timer were not started and were proved stopped. All ten immediate checks passed: the stream, the collector and timer stopped, the staging API and trading worker unchanged (same processes, restart counts and configuration), the research worker stopped, no pending job or reload, loopback API health, fresh bars, and production identity equal to the baseline.

## m6: delayed read-only check

The check ran about 688 seconds after the m1 live proof, inside its window. The stream was still the same process with no restart, the bars were contiguous with recent live rows, the collector service and timer were still stopped, the pair and the research worker were unchanged, and production identity still matched. Every check passed. The check wrote only its own record directory.

## State now

The staging prototype reads fresh BTCUSDT 1m bars from the market stream, beside the per-Bot performance panel turned on by P5a. With fresh bars, Pine Bridge alerts to staging can create Paper signals and fills on the pinned pair. After m6 no tool watches the stream. The fallback collector and its timer stay stopped; nothing refills a gap that a stream outage would leave until the stream restarts and catches up or a later packet starts the collector. A later packet looks, read only, at the collector's last run before any collector or timer start.
