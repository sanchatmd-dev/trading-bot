# S6 staging collector diagnosis packet

Packet ID: **S6-STAGING-COLLECTOR-DIAG-1**. Status: **NOT RUN; NO EXECUTION GO**. Revision 2 (applies ruling D45 from the tool reviews). `PACKET_SHA` is the sha256 of this file's final LF blob; Root records it in the tool pin and the acceptance record, never in this file.

> **This packet proposes one read-only job on the owner's staging host.** It starts, stops, restarts and reloads nothing and changes no data. It still contacts the host, so it runs only after a **new explicit owner GO that names S6-STAGING-COLLECTOR-DIAG-1, phase P4D and Staging QL-P2 Prototype**. Approval of this document, of the follow-up packet or of any earlier S6 GO does not authorize it.

Prepared on 27 October 2026 (Bangkok) by the Claude root under Root rulings D43 to D45, after the owner asked Root to continue. It follows the [S6 staging prototype follow-up packet](S6_STAGING_PROTOTYPE_FOLLOWUP_PACKET_2026-10-26.md), which it never edits.

## Owner summary

1. **Why.** P4M attempt a02 [rolled back](S6_STAGING_FOLLOWUP_P4M_M1_A02_RESULT_2026-10-27.md) because the tool could not prove the one run of the fallback collector. The tool counted a run only when the unit's invocation ID changed. A collector run that ends within a second leaves an inactive, unreferenced unit, which systemd may unload. An unloaded unit reads with an empty ID, so such a run looks like "no start". A start skipped by a unit condition, a rate limit, a failure or a dropped start job would also look like "no start".
2. **What this job does.** It reads, once and read only, what systemd and its journal kept about that collector start. It also reads the current state of the collector service and timer, and takes a short health snapshot of the running market stream, which nothing has watched since the [P4M a03 check](S6_STAGING_FOLLOWUP_P4M_A03_RESULT_2026-10-27.md).
3. **What it returns.** Labels, counts, booleans, digests and time offsets only. Root then applies a fixed reading key on the local machine to name the cause. The host never names it.
4. **What it decides.** Nothing by itself. Its result tells Root how a later packet must prove a collector run before the collector service and timer may start again. Until then they stay stopped.

## Root rulings

- **D43** (design). The host extracts closed-label facts; Root applies the reading key locally.
  - Reads kept: R1, R2, R3, R6, R7 and the stream snapshot S.
  - Reads dropped: the journal drop control, the long history, every database read, and any read of an earlier host record directory.
  - Tool family: a separate family copied by value from the accepted P4M tool (snapshot r3), which stays unchanged.
- **D44** (build contract). Spec revision 2 is the contract, with two reading-key and schema fixes and ten minor items for the build.
- **D45** (tool reviews). This revision corrects the packet and GO wording to what the tool does: no journal persistence check, the transient loads and the shell's temporary file disclosed. Two small host hardenings and stricter reading-key rules for H2.

## 1. Purpose and limits

One job, `d1`, in mode `COLLECTOR_DIAG`, in one SSH session, strictly read only.

It cannot recreate a journal that the host no longer keeps. If the journal no longer holds the a02 period, or the reading user cannot see the manager's entries, the result is inconclusive by design, never a guess. "H2" (the run happened and the unit was then unloaded) is an inference from a proved run in the journal plus the unit's loaded state and reference counts now.

## 2. Preconditions (Root, before the GO request)

1. P4M attempt a03 jobs m1 and m6 are accepted (commit `61031d0`). The fallback collector service and timer are stopped, and the m6 record shows them inactive with no job.
2. The follow-up packet (revision 9) and the main packet are unchanged.
3. The diagnosis tool is built, reviewed and accepted against this packet. Its snapshot and build record are committed, and a dry admission passes.
4. The manifest pins two records by hash: the a02 retained record (host start and end, catch-up and live times, the a02 stop code) and the a03 m1 facts. Any difference refuses before the host is contacted.

## 3. Job d1

### 3.1 Gate before the record directory (read only; a failure refuses with no record directory)

The gate checks:
- the bound object and its limits;
- the Node major version;
- the host facts (memory, CPU count, load; another S6 payload in flight refuses);
- the systemd major version (255) and the clock-synchronisation state (recorded);
- the systemd job list (recorded only);
- the a02 window recomputed on the host;
- the dedicated protected backup directory (owned, no group or world write, its own record directory absent);
- the remaining time.

No unit `show` runs in the gate; its unit list and job list read states without loading any unit, so nothing is loaded before R1.

### 3.2 Reads, in this order

- **R1, loaded-unit probe.** One `list-units --all` per scope. It returns three booleans: whether the service manager holds the stream, the collector service and the timer loaded now. It runs before any `show`, because `show` can load a unit.
- **R2, collector journal.** The fallback collector service's journal, its manager and process entries, from five minutes before the a02 host start to now. It is read as JSON with a fixed field list, ascending, with no line limit; caps on entries and bytes keep the oldest entries. For each entry the job returns:
  - the systemd catalog message ID (a public 32-digit ID) or none;
  - the job type, job result, unit result and exit code as short lower-case words, or "other";
  - the exit status as a number;
  - the source (manager or process);
  - an invocation group index, with the empty ID as group "none";
  - the offset from the a02 host start;
  - for manager entries, one boolean from an in-process test for systemd's "skipped because of an unmet condition check" wording.
  
  It also returns whether each group was seen before the collector start window, plus truncation flags and counts of dropped entries.
- **R3, stream journal control.** The same read for the market stream over the same span. It proves that the journal still holds the a02 period and that this user can see the manager's entries.
- **R6, current collector state.** `show` of the collector service, then of its timer. Fields:
  - load state and garbage-collection mode;
  - unit-file state;
  - the counts of units that want or trigger it;
  - the result, exit status and timestamps of the last run (1-second resolution);
  - whether an invocation ID is set, and which R2 group it matches;
  - the results and times of the last condition and assert checks (labels and offsets only);
  - the restart count;
  - the timer's last trigger as an offset.
- **R7, boot continuity.** The current kernel boot ID is compared, inside the host process, with the boot ID of the a02 journal entries. The job returns one boolean.
- **S, stream snapshot.** The stream's unit class, whether it is the same process and restart count as at a03, and its journal event counts since the a03 live proof. The counted kinds are connected, closed bars, catch-up failures, stream failures, socket errors and disconnects.

### 3.3 Unit checks (after the record directory opens; recorded; every read still runs)

These checks are recorded with the first stop code kept, and every read still runs:
- the stream is running, with the same process as a03;
- the collector service and timer are inactive with no job;
- the staging API and trading worker are running unchanged (process, restart count, configuration and drop-in digests);
- the research worker is stopped;
- the four production units match the production baseline recorded by the accepted delayed check r6 a02 (digest `b5789332`).

The pair's environment properties are read inside the host process, size-checked and discarded, as at m6; they are never returned or stored.

### 3.4 Writes and output

The only host write is one record directory in the dedicated protected backup directory, with a progress record and a result file (labels only). Apart from it, the shell writes only the temporary here-document file through which it receives the tool, as for every earlier S6 tool.

The host verdict is `DIAG_COLLECTED` when every read is done and no stop code was set; otherwise it is `DIAG_STOP` with the code. No hypothesis label appears anywhere in the host output.

Message text, invocation IDs, the boot ID, unit names, paths and user names stay in the host process. The closed output schema admits only labels from fixed sets, short lower-case words, counts, booleans, hex digests and time offsets; journal fields from the collector's own output lines are not returned at all. The tool also refuses any output that echoes a bound unit name, the backup directory or a journal invocation ID it has read, and zero-fills the journal output buffers after parsing.

### 3.5 Allowed commands and bounds

The allowed commands are:
- `systemctl show` with fixed property lists;
- `systemctl list-units` and `list-jobs` in fixed forms;
- `systemctl --version` and the clock-sync read;
- `journalctl` in exactly two fixed forms (manager and process match groups for one bound unit, `--since` and `--until` given as epoch seconds, a span of at most 14 days).

No control verb, no `--no-block` or `--wait`, no environment read, no database session.

Each journal call is bounded at 30 seconds and 1 MiB. The worst path is 205 seconds against a 300-second host bound.

## 4. Root reading key (evidence rule, applied locally)

Root and an auditor apply the key of spec revision 2, section 18, with the D44 fixes, to the accepted facts. The first matching rule wins. Each label below is followed by the decision for a later collector packet.

- **INCONCLUSIVE** (the read failed, was cut inside the a02 period, the journal no longer holds that period, or the manager's entries are not visible): any later start carries its own live proof.
- **H2** (a run started in the collector start window, succeeded and ended within a02; the unit is not held loaded now, nothing wants or triggers it, and its state read shows a fresh load with no invocation ID; WEAK when another fact is odd): replace the invocation-ID rule with a journal run proof, or with a bounded blocking start that holds a reference until the run ends. The old m6 timer-run proof gets the same change.
- **H2_UNCONFIRMED** (a run is proved, but R1 or R6 failed): treated as H2 for the proof design; the loaded-state premise stays unproved.
- **H2_PREMISE_FALSE or H4K** (a run is proved, but the unit is held loaded now, something wants or triggers it, or its state read shows an invocation ID; H4K when that ID is the a02 run's): no collector start; an auditor reviews the a02 show path read only.
- **H1C** (a unit-file condition skip; STRONG with the in-process wording witness, WEAK without it): no collector or timer start; a read-only packet reads the condition types; the owner decides on a unit change outside P4M.
- **H1A, H1D, H1L, H4F, H4F0** (an assert, a dependency, the start rate limit, a failed run, or a failure before the run): no start; diagnose the failure first.
- **H3_RESULT, H3_SILENT** (the start job did not run): a later start uses a bounded blocking start so the job result is known, and the journal proof still applies.
- **H4L** (the run started late): bound the later proof by the observed delay plus a margin.
- **H4M, H4X, F5_CONTRADICTION** (unexplained, or contradicting the a02 gate): escalate with the facts; no collector start.

A run proved on a different boot keeps its label, with the flag `bootChanged`, and Root reads it as weaker.

A stream finding is any of these:
- the stream is not running, or is not the same process;
- it has restarted;
- it has more than one stream invocation;
- it logged a catch-up failure, stream failure, socket error or disconnect.

The stream finding is unknown when the process or restart facts are missing. Root reports any stream finding to the owner, who decides on a GO-RM or a restart packet. The job itself never acts.

## 5. Rollback and stop point

No rollback: the job has no effect. A gate refusal leaves no record directory. A stop after the record opens leaves the record directory and nothing else.

The stop point is the accepted record plus Root's reading under section 4, recorded in a tracked result. Any collector or timer start needs a later packet and its own owner GO.

## 6. Durations

The job is expected to take under 30 seconds, with a host bound of 300 seconds and a worst path of 205 seconds. There is no API gap: nothing is stopped or restarted.

## 7. Residual risks and unknowns

- **systemd 255 behaviour.** Several items come from systemd 255 knowledge, not from observation on this host:
  - the catalog message IDs;
  - the job and unit result fields;
  - the condition-skip wording;
  - that `list-units` loads nothing while `show` loads a unit;
  - whether a timer reference keeps the service loaded.
  
  The job returns the IDs and words verbatim, so a difference changes Root's key, never the host output.
- **Transient loads.** The `show` reads load the collector service, its timer and the stopped research worker for a moment, and the clock-synchronisation read can start the idle time-date service on demand, as for every earlier S6 tool. R1 runs before any `show`, so this does not affect the loaded-state fact.
- **Lower bounds.** Process lines and summary lines are lower bounds: a very short run may log output without unit metadata.
- **Late runs.** The admission and the host gate refuse a run after 10 November 2026, 01:53 UTC (the 14-day journal span from the a02 window). The stream journal read keeps its oldest entries, so from about a day after a03 its cap is reached and the stream finding may read as unknown.
- **Stream watching.** The stream snapshot is a single read; after it, no tool watches the stream.

## 8. Owner checklist before the GO

1. I know this job changes nothing on staging and that the collector service and timer stay stopped.
2. I know its result is evidence for a later collector packet, which needs its own GO.
3. I know a stream finding is reported to me and nothing acts on it without my GO.

## 9. Suggested owner GO wording

> GO S6-STAGING-COLLECTOR-DIAG-1 P4D attempt a01 for Staging QL-P2 Prototype only, pinned revision ba1a433 (includes QR-2 O7: yes), read only: in one SSH session with the reviewed tool, first re-check, read only, the host health (recorded; another S6 job in flight refuses), the systemd version and clock-synchronisation state, and the systemd job list (recorded); then, read only and in this order: list which of the staging market stream, the fallback collector service and its timer the service manager currently holds loaded, before any show of those units (the earlier host unit list and job list load nothing); read the systemd journal of the fallback collector service (manager and process entries) from five minutes before P4M attempt a02 to now; read the systemd journal of the staging market stream over the same span as the control; read the current systemd state of the fallback collector service, then of its timer, including its unit-file state and the counts of units that want or trigger it; compare the current kernel boot ID with the boot ID of the attempt a02 journal entries, inside the host process; take a snapshot of the running market stream (its unit class, same process and restart count as at P4M attempt a03, and its journal event counts since the attempt a03 live proof); then check the staging API and trading worker, the research worker and the four production units against the production baseline recorded by the accepted delayed check r6 a02 (digest b5789332). The tool starts, stops, restarts and reloads nothing, sends no control command to any unit, opens no database session, reads no environment source (the pair units' environment properties are read inside the host process, size-checked and discarded, as at m6), and writes nothing except one record directory with a progress record and a result file in the dedicated protected backup directory and the shell's temporary here-document file that carries the tool; its show reads may load the fallback collector service, its timer and the stopped research worker for a moment, and the clock read may start the idle time-date service on demand. Journal message text, invocation IDs, the boot ID, unit names, paths and user names stay inside the host-side process and are never printed, returned or stored; the tool returns only labels, counts, booleans, digests and time offsets, and no diagnosis label. The fallback collector service and timer stay stopped. I confirm checklist items 1, 2 and 3. No retry. notAfter [UTC].

## 10. Review record

- Design: spec revision 1 by an Opus designer (Fable substitute), reviewed GO WITH CONDITIONS (one P1, five P2s). Ruling D43 simplified the design.
- Spec revision 2, re-reviewed GO WITH CONDITIONS (two P2s). Ruling D44 sets them as build conditions.
- Tool build: tester PASS; architecture auditor and a second Opus reviewer (Fable substitute) GO WITH CONDITIONS. Their shared P2, the persistence clause, is removed by this revision (ruling D45).
- The tool build and its reviews are recorded in the build record before the GO request.

## 11. Exclusions

This packet excludes:
- any start, stop, restart, reload or reset of any unit;
- any database session;
- any environment or secret read;
- any change to the P4M tool, the follow-up packet or the main packet;
- Live trading, a guard reset, Best Inputs apply and the optimizer.

Spot and Paper only; BINANCE:BTCUSDT Spot 1m. Private acceptance NOT RUN; READY false; P13j and N1 held.

## 12. Evidence and what comes next

Evidence: the [a02 result](S6_STAGING_FOLLOWUP_P4M_M1_A02_RESULT_2026-10-27.md) and the [a03 result](S6_STAGING_FOLLOWUP_P4M_A03_RESULT_2026-10-27.md).

Next: the tool build and its reviews, then acceptance, a dry admission and the owner GO request. After the run, Root records the facts and the reading-key label in a tracked result, and proposes the later collector packet that the label calls for.
