# S6 staging collector restart packet

Packet ID: **S6-STAGING-COLLECTOR-START-1**. Status: **NOT RUN; NO EXECUTION GO**. Revision 3 (applies rulings D49 and D50 from the tool reviews). `PACKET_SHA` is the sha256 of this file's final LF blob; Root records it in the tool pin and the acceptance record, never in this file.

> **This packet proposes one step with effects on the owner's staging host and its rollback.** It runs only after a **new explicit owner GO that names S6-STAGING-COLLECTOR-START-1, the phase (P4C, or RC for the rollback) and Staging QL-P2 Prototype**. Approval of this document, of earlier S6 packets or of any earlier GO does not authorize it.

Prepared on 27 October 2026 (Bangkok) by the Claude root under Root rulings D47 to D50, at the owner's request ("Prepare the collector restart packet here, with the journal-based run proof and the same change for the delayed timer check"). It follows the [collector diagnosis](S6_STAGING_COLLECTOR_DIAG_D1_RESULT_2026-10-27.md) and never edits the [follow-up packet](S6_STAGING_PROTOTYPE_FOLLOWUP_PACKET_2026-10-26.md) or the [main packet](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md).

## Owner summary

1. **Why.** The fallback collector ran in P4M attempt a02. The diagnosis d1 proved this from the journal: systemd unloaded the unit after a run of under a second, so the a02 tool could not see the run. The collector service and timer have been stopped since then. The market stream runs and must stay untouched.
2. **What c1 does.**
   - **Checks first:** the host, the production units, the staging API's Paper-only health answer, the pair, the stream and the collector units. The stream must be the same process as at a03, with no start link to the collector. The collector's type, restart setting and collect mode must be as recorded.
   - **Self-test:** it runs the journal proof on the a02 run.
   - **The run:** it runs the collector once and proves that run from the journal. The proof needs a completed start job and the collector's summary line from the same run, with no failure or skip entry.
   - **The timer:** it starts the timer and checks that the timer's first run falls within 15 minutes.
   - **On failure:** if anything fails before the timer is ready, it stops only the timer and the collector service. If an immediate check fails after the timer is ready, the units are left running, the job stops there and the delayed check does not run; the owner decides on GO-RC.
3. **What c6 does.** About 6 to 37 minutes after the timer is ready, it checks, read only:
   - that the timer started at least one clean collector run;
   - that every run since the timer started is clean;
   - that the timer's last trigger matches a proved run;
   - that the timer is still scheduled and the stream is unchanged.
4. **How to undo.** GO-RC stops only the timer and the collector service. It refuses before any effect if the two units' links could reach the stream (GO-RM is then needed; it stops all three market units), or when the host, production identity, the research worker, a pending job or a unit needing a reload is not as expected. If the stream's start lists or its failure or success handlers name a collector unit, rc stops the two units but reports a half state, because the stream could start them again.

## Root rulings

- **D47** (design). Jobs c1, c6 and rc, and the run proof:
  - the run proof is the run-group rule over the diagnosis tool's journal facts, with the host forms d1 observed pinned;
  - any other form fails closed;
  - the gate self-tests the proof on the a02 run before any effect.
  
  Kept from the accepted P4M rules: the f1 host floors, the Paper-only health gate, and the D41 rule that the stream must not start the collector units. Added: a pin of the collector's collect mode. The rc tool refuses when stopping the collector units could reach the stream; this is a deliberate exception to D41 item 1, because GO-RM is the fallback.
- **D48** (build contract). The process witness is the collector's summary line. The c6 trigger re-read, the c1 timer start time, stream reads without the environment property, and the wording fixes are applied in this revision.
- **D49** (tool reviews). The pair is read without environment properties; the echo guard holds unit names and directories; c1 also refuses a start link between the two collector units; the rollback stops first and reads the cause afterwards; c6 runs only after a c1 pass; rc reports a half state when the stream could start a collector unit again. A newest run whose summary line has not yet arrived stays pending; if it never arrives, c1 rolls back and c6 stops (never a pass).
- **D50** (fix-round reviews). The stream's failure and success handlers count like its start lists in c1 and rc; the self-test also pins the a02 run's end and its witness counts; wording fixes.

## 1. Purpose and limits

The job starts the fallback collector service once and the fallback collector timer. It proves each collector run from the systemd journal, not from the unit's invocation ID.

The collector writes only append-only public market bars. The stream is never started, stopped or restarted by any job of this packet. The tool is a separate family copied by value from the accepted P4M tool (snapshot r3), with the reviewed collector and timer code of the a02-era tool and the journal reader of the diagnosis tool. Those tools stay unchanged.

## 2. Preconditions (Root, before the GO request)

1. P4M attempt a03 (m1, m6) and the diagnosis d1 are accepted, and their records are pinned by hash.
2. The tool is built, reviewed and accepted against this packet. Its snapshot and build record are committed, and a dry admission passes.
3. The collector service and timer are stopped, and the market stream runs as recorded at a03 and d1.

## 3. Jobs

### 3.1 c1 gate (read only, before the first effect)

The gate reads:
- **Host:** the health floors (memory, load, no heavy job, no live payload, Node major); the systemd version; the clock-synchronisation state; no pending job and no unit needing a reload; the login manager's setting for killing user processes at logout, stopping if that setting is on or unknown.
- **Production and pair:** the four production units against the baseline of the accepted delayed check r6 a02 (digest `b5789332`); the staging API's loopback health answer, which must report Paper-only mode; the staging API and trading worker against the P4M a03 record; the research worker stopped.
- **Stream:** running as the same process with the same restart count as at a03; configuration digest unchanged since P0a and P3; no start link, failure handler or success handler of the stream that names the collector service or timer. It is read without its environment property.
- **Collector service and timer:**
  - stopped, not failed, with configuration digests unchanged;
  - the collector's type (simple) and restart setting (no) as recorded at a03 (a02 agrees), and its collect mode (inactive) as observed by d1;
  - the timer's trigger counts, accuracy, delay and persistence equal to a03 (the calendar text is not compared);
  - stop timeouts, the start command and the Node version;
  - the `pg` and `decimal.js` packages;
  - hooks and direct links: no hook, no link to a unit other than a target, a slice, a mount or the three market units, no link by which a start or stop of the two units reaches the stream, and no start link between the collector service and the timer;
  - the collector script's code closure, equal to the revision recorded at a03.
- **Collector environment:** the collector's environment sources are read only inside the host-side process; the tool uses only the database connection key, the PostgreSQL client keys that can fill a connection part, the Node options and the library and module path keys, and returns only booleans. The staging API and trading worker are read without their environment properties.
- **Database:** read only through the migration connection selector (fence inspect; BTCUSDT 1m bar facts and the Paper counter reading as counts).
- **Self-test:** the journal proof is applied to the collector's a02 period and must prove the a02 run exactly as d1 saw it (its start and end, one process entry and one summary line, no other witness). If the journal no longer holds that period, c1 stops before any effect.

### 3.2 c1 effects, in order

1. **Run the collector service once**, started without blocking. Prove the run from its journal:
   - exactly one new run within 300 seconds;
   - a completed start job within 30 seconds;
   - the collector's summary line of the same run;
   - any success, process-exit (status 0) or resources entry of that run is accepted beside the summary line, never in its place;
   - no failure or skip entry.
   
   Any other journal form stops. A state read taken with the proof, before its journal read, requires the unit inactive, not failed, with no job, and its invocation ID empty or equal to the run's.
2. **Start the timer.** It is ready when active and waiting, with a next elapse within 15 seconds, stable for 3 seconds. Its first scheduled run must fall within 900 seconds of readiness. The timer start time is recorded for c6.
3. **Immediate checks:** the collector service and timer as expected, the stream unchanged, the pair unchanged, the research worker stopped, production identity equal to the baseline, health equal to the gate answer, a read-only database transaction for the bar facts and the Paper counter reading as counts, and counts of the stream's journal event kinds as a record.
4. **In-run rollback.** If the run or the timer start cannot be proved, the tool stops the timer and then the collector service, each to inactive, with the accepted stop proofs, clearing a failed state of only those two units with reset-failed after proving them stopped, and then reads the collector journal kinds for the cause (an error in that read never skips a stop). It never stops or restarts the stream. Verdicts: a pass, a pre-effect stop, a rollback, a half state, or a stop after readiness (units left as they are; the delayed check does not run; Root reports and the owner decides on GO-RC or GO-RM). The stored bars stay.

### 3.3 c6 delayed check (read only)

c6 runs in a separate session under the same GO, with its own record directory, and only after c1 has written its result with a pass verdict. Its window comes from the c1 record: it opens 310 seconds plus the timer accuracy and randomized delay after the timer's first scheduled run, and stays open for 1200 seconds.

It proves from the journal:
- at least one collector run started by the timer, with a completed start job and the collector's summary line of the same run, and no failure or skip entry;
- that every collector run since the timer started is clean in the same way;
- that the timer's last trigger is tied to a proved run.

It reads the timer first and the collector again after the journal read. It re-reads the last trigger and waits again within its bound if anything changed. It also checks that the timer is active with a next elapse, that no market unit failed, that the collect mode is unchanged, and that the stream, pair, research worker and production identity are unchanged, and it reads the staging database read only for the bar facts (fresh, contiguous, with live rows).

c6 sends no control command and opens no database write.

### 3.4 rc rollback (its own GO-RC)

The gate checks:
- the host (refusing when the Node major or the process table cannot be read);
- production identity (refusing on a difference);
- the research worker stopped (refusing if it runs);
- the two units' state, stop timeout, timer format, hooks and links;
- that stopping them reaches no other unit;
- that no start list or conflict of the two units names the stream and no stop of them reaches it (otherwise, or when the stream cannot be read, rc refuses and GO-RM is needed);
- that no job of the stream or any other unit is pending and no unit needs a reload.

Effect: stop the timer and then the collector service, with stop proofs and reset-failed of only those two units. The stream is read for the record only. If the stream's start lists or its failure or success handlers name a collector unit, the verdict is a half state, because the stream could start that unit again. No reload, no database connection, no environment read.

## 4. Durations

- **c1:** a few minutes; the gate and self-test take most of it, and the collector run itself took under a second at a02. Host bound 1,140 seconds.
- **c6:** starts about 6 to 37 minutes after the timer is ready and takes under 10 minutes (bound 540 seconds).
- **rc:** bound 540 seconds.
- **API:** no API gap; the API, trading worker and stream keep running.

## 5. Owner checklist before GO-C

1. **Production untouched** (hard gate, main packet item 7).
2. **Who can stop staging** (hard gate, main packet item 3): reachable during c1 and c6.
3. **Public market data:** the collector calls the public, keyless Binance market-data REST endpoint at each timer run, on a calendar schedule whose text stays on the host.
4. **Bridge Paper effects** (as accepted with GO-P4 and GO-P4M a03): bars are already fresh through the stream. The collector only appends public market bars, so the Paper exposure does not change. The Pine Bridge switch is not re-read (ruling D47).
5. **Rollback order:** GO-RC or GO-RM before R4 or R4H, and before RX when the collector is failed.

## 6. Residual risks

- **systemd 255 forms.** Some forms are not yet proved on this host. The proof fails closed on each: a differing form rolls back or stops, and never passes. The catalog IDs for success, exit, failure and exec-skip entries have not been seen on this host.
- **Exit status.** A `simple` unit logs no success entry. A clean exit is shown by three things together: no failure entry, the summary line (printed only after a complete run), and the state cross-check under the pinned collect mode. A failure entry lost to journal rate limiting, together with a summary line printed just before a failed database close and a state read that shows success, would pass; that case is narrow.
- **Journald lag.** A failure entry not yet stored at the proof read is covered by the state cross-check under the collect-mode pin.
- **Same-user journal entries.** In user scope a same-user process could write an entry that looks like a manager entry. The trusted summary line must share the run group, and the closed output schema bounds what returns. A same-user process can also control these units directly; the proof guards against misreading, not against that user.
- **Calendar text not compared.** A changed calendar expression with the same trigger count passes; the 900-second first-run bound limits it, and c6 proves at least one run.
- **Self-test retention.** If the journal no longer holds the a02 period, c1 stops before any effect, and a later revision pins a newer proved run.
- **Later runs.** No tool bounds the period of later calendar runs. c6 proves at least one run. A sub-second first run that ends within the 3-second stability read passes readiness; the immediate collector check and c6, which counts runs from the timer start, cover it.
- **Short calendar period.** c6 reads about 3,200 seconds of journal. A calendar period under about 100 seconds would exceed its run-group cap, and c6 stops (fail closed).
- **False c6 stop.** A run that starts after the c6 proof loop makes the final timer check read running, and c6 stops (a false stop, fail safe).
- **Failed run after c6.** A failed timer run after c6 leaves the service failed until the next good run. RX refuses in that window, and GO-RC clears it.
- **Paths through targets.** The gate checks direct links only. A start, stop or conflict path through a target or mount is not read. The a02 collector start, with the same configuration, did not stop the stream.
- **Unwatched after c6.** No tool watches the timer or the stream afterwards.
- **Transient loads.** The show reads may load the collector service for a moment.

## 7. Suggested owner GO wording

GO-C (c1 and its delayed check c6):

> GO S6-STAGING-COLLECTOR-START-1 P4C attempt a01 for Staging QL-P2 Prototype only, pinned revision ba1a433 (includes QR-2 O7: yes) on the staging API and trading worker, which this step does not stop, restart or change, and on the staging market stream, which this step does not start, stop or restart: in one SSH session with the reviewed tool, first re-check, read only, the host health floors (memory, load, no heavy job, no live payload, the expected Node major), the systemd version, the clock-synchronisation state, that no systemd job is pending and no unit needs a reload, and the login manager's setting for killing user processes at logout (and stop if that setting is on or unknown); the four production units against the production baseline recorded by the accepted delayed check r6 a02 (digest b5789332); the staging API's loopback health answer, which must report Paper-only mode; the staging API and trading worker against the accepted P4M a03 record; the research worker as stopped; the staging market stream as running as the same process with the same restart count as at P4M attempt a03, with its configuration digest unchanged since P0a and P3 and no start link, failure handler or success handler of the stream that names the fallback collector service or timer; and the fallback collector service and timer as stopped, not failed, with configuration digests unchanged since P0a and P3, the collector's unit type (simple) and restart setting (no) as recorded at P4M attempt a03 and its collect mode (inactive) as observed by the diagnosis d1, the timer's trigger counts, accuracy, delay and persistence equal to those read at P4M attempt a03 (the calendar text is not compared and stays on the host), and inside the reviewed rules for their stop timeout, start command (no extra Node argument), node version (the node binary named in the start command run with --version only), the presence of the `pg` and `decimal.js` packages, the hooks and direct dependency links (no hook, no link to a unit other than a target, a slice, a mount or the three market units, no direct link by which a start or stop of the collector service or timer reaches the stream, and no start link between the collector service and the timer), and the code hashes of the collector script and its imports on their real paths, which must equal the same known repository revision as at P4M attempt a03. The tool reads the collector's environment sources only inside the host-side process and uses only its database connection key, the PostgreSQL client keys that can fill a connection part, the Node options and the library and module path keys, never printing, returning or storing a value; it reads the staging API, the trading worker and the market stream without their environment properties; and it returns only whether they name the staging database socket, port and database of the migration connection selector and whether the Node options and library and module path keys are empty. It reads the staging database read only through the migration connection selector (the pin's read-only fence inspect and one read-only transaction for the BTCUSDT 1m bar facts and the Paper counter reading as counts), and reads the systemd journal of the fallback collector service over the P4M a02 period to check that the journal proof still proves the a02 collector run exactly as the diagnosis d1 saw it (if the journal no longer holds that period, the tool stops before any effect). Then run the fallback collector service once on its current code, started without blocking, and prove that run from its systemd journal: exactly one new run within 300 seconds, with a completed start job within 30 seconds and the collector's summary line of the same run, any success, process-exit (status 0) or resources entry of that run accepted beside the summary line but never in its place, and no failure or skip entry; any other journal form stops. Then start the fallback collector timer and require its first scheduled run within 15 minutes of the timer becoming ready. No daemon reload. If the run or the timer start cannot be proved, the tool stops the fallback collector timer and service again, clears a failed state of only those two units with reset-failed after proving them stopped, proves both stopped and inactive, and then reads the collector's journal kinds for the cause; it never stops or restarts the market stream; the stored bars stay. Immediate checks, including a read-only database transaction for the bar facts and the Paper counter reading as counts and counts of a fixed list of market-stream journal event kinds as a record (if an immediate check fails, the timer and the collector service are left as they are, the job stops after readiness, the delayed check does not run and I decide on GO-RC), then, only after c1 has written a pass result, one read-only delayed check, in a separate session under this GO with its own record directory, inside the window that the tool computes from the c1 record (it opens 310 seconds plus the timer accuracy and randomized delay after the timer's first scheduled run and stays open for 1200 seconds), which proves from the journal at least one collector run started by the timer (a completed start job and the collector's summary line of the same run, with no failure or skip entry), every collector run since the timer started clean in the same way, and the timer's last trigger tied to a proved run; the delayed check also checks that the timer is active with a next elapse, that the collect mode is unchanged, that no market unit failed and that the market stream, the pair, the research worker and the production units are unchanged, and reads the staging database read only for the bar facts. Journal message text, invocation IDs, boot IDs, unit names, paths and user names stay inside the host-side process; the tool returns labels, counts, booleans, digests, timestamps, time offsets and public systemd catalog IDs only. The tool writes one record directory per job, with a progress record and a result file, in the dedicated protected backup directory, and the shell's temporary here-document file that carries the tool; its show reads may load the fallback collector service, its timer and the stopped research worker for a moment. The collector calls only the public, keyless Binance market-data endpoint and appends market bars only. I know that Bridge Paper effects stay as accepted with GO-P4 and GO-P4M; a pair rollback after this step needs GO-RC or GO-RM first, and a full restore (RX) needs GO-RC or GO-RM first when the collector is failed. After the delayed check, no tool watches the timer or the stream. I confirm checklist items 1, 2, 3 and 4. No retry. notAfter [UTC].

GO-RC (rc):

> GO S6-STAGING-COLLECTOR-START-1 RC for Staging QL-P2 Prototype only, pinned revision ba1a433 (includes QR-2 O7: yes), reversing c1 job [job reference]: in one SSH session with the reviewed tool, first re-check, read only, the host health (recorded; another S6 job in flight, an unreadable process table or an unexpected Node major refuses), the systemd version, the login manager's setting for killing user processes at logout (stop if on or unknown), the four production units against the production baseline r6 a02 (a difference refuses), the research worker as stopped (refuses if it runs), the state, stop timeout, timer format and hooks and links of the fallback collector service and timer, that stopping them reaches no other unit, that no start list or conflict of the two units names the market stream and no stop of them reaches it (otherwise, or if the market stream cannot be read, the tool refuses and GO-RM is needed instead, Root ruling D47), that no job of the market stream or of any other unit is pending and that no unit needs a reload; then stop the fallback collector timer and then the fallback collector service, prove each stopped, clear a failed state of only those two units with reset-failed, and prove each stopped and inactive; if the market stream's start lists or its failure or success handlers name either unit, the result is a half state, because the stream could start it again. The market stream is read for the record only and receives no command. No daemon reload, no database connection, no environment read, no other unit. Stored bars stay. The tool writes one record directory with a progress record and a result file in the dedicated protected backup directory. No retry. notAfter [UTC].

## 8. Review record

- Design: spec revision 1 by an Opus designer (Fable substitute), reviewed GO WITH CONDITIONS (no P1, six P2s; ruling D47).
- Spec revision 2, re-reviewed GO WITH CONDITIONS (one P2, the summary-line witness; ruling D48).
- Tool build: tester PASS; architecture auditor and a second Opus reviewer (Fable substitute) GO WITH CONDITIONS with no P1 (ruling D49).
- Fix round: tester PASS; auditor GO; second reviewer GO WITH CONDITIONS with no P1 or P2 (ruling D50, applied in this revision).
- The tool build and its reviews are recorded in the build record before the GO request.

## 9. Exclusions

This packet excludes:
- any start, stop or restart of the market stream, the staging API, the trading worker, the research worker or a production unit;
- a daemon reload;
- any database write by the tool;
- any change to the P4M, diagnosis, follow-up or main packet tools;
- Live trading, a guard reset, Best Inputs apply and the optimizer.

Spot and Paper only; BINANCE:BTCUSDT Spot 1m. Private acceptance NOT RUN; READY false; P13j and N1 held.

## 10. Evidence and what comes next

Evidence:
- the [diagnosis d1 result](S6_STAGING_COLLECTOR_DIAG_D1_RESULT_2026-10-27.md);
- the [P4M a03 result](S6_STAGING_FOLLOWUP_P4M_A03_RESULT_2026-10-27.md);
- the [a02 result](S6_STAGING_FOLLOWUP_P4M_M1_A02_RESULT_2026-10-27.md).

Next: the tool build and its reviews, acceptance, a dry admission, and the owner GO-C request.
