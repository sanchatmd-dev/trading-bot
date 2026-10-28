# S6 staging collector restart attempt a01: collector and timer on, delayed check passed

Packet: [S6-STAGING-COLLECTOR-START-1](S6_STAGING_COLLECTOR_START_PACKET_2026-10-27.md), phase P4C, jobs c1 and c6. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 28 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_COLLECTOR_START_A01_RESULT_2026-10-28.json); [build record](evidence/S6_STAGING_COLLECTOR_START_BUILD_2026-10-27.json).

## Outcome

Under the owner's GO-C (full text pasted, byte-equal to the packet revision 3 line, notAfter 2026-10-29T20:00:00Z), job c1 ran once from 07:33:04Z to 07:33:10Z with verdict **C1_PASS**. The read-only delayed check c6 ran once at 07:41:36Z with verdict **C6_PASS**. Each job used one SSH session, exited 0 and wrote nothing to stderr. Both jobs are consumed (no retry). Root verified the receipt, envelope, manifest and retained-output linkage of both jobs.

## c1: run the collector once, then start its timer

The gate passed in full: host health floors, systemd 255 with clock synchronisation, no pending job or reload, the login manager not killing user processes, production identity equal to the baseline (b5789332), loopback health in Paper-only mode, the staging API and trading worker unchanged since P4M attempt a03, the research worker stopped, and the market stream the same process with no restart. The fallback collector service and timer were stopped, with configuration, start command, Node version, packages, links and code hashes as reviewed; nothing links the collector units to the stream.

The journal proof first re-proved the P4M a02 collector run exactly as the diagnosis d1 saw it (self-test offset 5943 ms). The tool then started the collector service once without blocking. Its journal showed exactly one new run: a completed start job 30 ms after the command and the collector's summary line of the same run at 624 ms, with no failure or skip entry; the service ended inactive with result success. The tool then started the timer; its first scheduled run was 113 seconds after the timer became ready, inside the 15-minute bound. All ten immediate checks passed. The Paper counters did not change. The stored BTCUSDT 1m bars were contiguous up to 2026-10-28T07:33Z.

## c6: delayed read-only check

The check ran inside its window, about 509 seconds after the timer became ready. The journal proved 2 collector runs started by the timer since c1, each with a completed start job and the summary line and no failure or skip entry, and the timer's last trigger was tied to a proved run. The timer was active with a next run set, and the collector's collect mode was unchanged. The market stream was still the same process with no restart. The bars were contiguous, with 10 recent rows from the stream up to 2026-10-28T07:41Z. The pair, the research worker and the production units were unchanged. All eight checks passed. The check wrote only its own record directory.

## State now

The staging prototype now has both market-data writers on: the market stream (since P4M attempt a03) and the fallback collector on its timer, which refills a gap that a stream outage leaves. Pine Bridge alerts to staging can create Paper signals and fills on the pinned pair ba1a433, and the per-Bot performance panel is on (P5a). After c6 no tool watches the timer or the stream. A collector rollback needs the owner's GO-RC, which stops only the collector service and timer.

Scope stays Spot/Paper only, Live hard-locked; private acceptance not run; READY false; P13j and N1 held. The QR-2 long-range fixes (422 refusal and panel hint) are committed but not deployed; staging still answers 503 for ranges over the coverage read limit.
