# S6 staging set C process and layer pre-read packet

Packet ID: **S6-STAGING-SETC-PREREAD-M-1**. Phase: **PRM** (GO name GO-SETC-PRM). Status: **draft r1, proposed, not accepted, NOT RUN, NO EXECUTION GO**. `PACKET_SHA` is the sha256 of this file's final LF blob once Root installs it under `docs/` (file name `docs/S6_STAGING_SETC_PREREAD_M_PACKET_<install date>.md`, Root ruling SB437 O11); Root records it in the tool pin (`prmPacket`) and the acceptance record, never in this file.

Pin: `ab1c1f194cd20c3953a9b9628adc6322895058f1`. Staged API tree name (TREE_NAME): `r3-api-ab1c1f194cd2`.

> **This packet proposes one read-only job on the owner's staging host.** It starts, stops, restarts, reloads and writes nothing, and it changes no unit, file or database. It still contacts the host, so it runs only after a **new explicit owner GO that names S6-STAGING-SETC-PREREAD-M-1, phase PRM and Staging QL-P2 Prototype**. Approval of this document, of the set C packet, of the pre-read packet S6-STAGING-SETC-PREREAD-1 or of any earlier S6 GO does not authorize it.

This is a draft for review. It is drafted from design r3 (Part A) sections A10 (items 1 to 12) and A11, with facts from sections A1 to A7 and the risks A-R1 to A-R7, and from Root rulings SB437 to SB442. It edits no set C, REPIN-3, set B or pre-read packet. The set C packet r6b sha is pinned in the sealed set C tools and stays unchanged. The PRM tool is not built-and-sealed by this document: it is accepted only after Root installs this packet, fills the `prmPacket` pin, runs the mutant run, seals the tool and an independent seal check passes.

## 1. Owner summary

1. **Why.** The set C start-and-measure window (GO-SETC-M, the SM gate) compares the API and worker processes, the production units, the loaded configuration layer, the start command and the API port with values Root gives it. After REPIN-3, no accepted record holds four of the layer values or the start command in the form the SM gate reads (SB436). This job takes one fresh read in exactly that form, with byte copies of the SM functions, so that for an unchanged host the values are equal by construction.
2. **What it does.** It reads only. In one SSH session it reads host health, the properties of the ten bound units, the configuration layer of the staging API and the trading worker, the running processes of the API and worker, the listener on the API port, and the staged API tree.
3. **What it returns.** Digests, booleans, closed labels, counts and ISO host times only. It returns no path, unit name, host name, address, user name, environment value, key name paired with a value, port number, inode, process id or raw systemd text.
4. **What it decides.** Nothing. Root builds the GO-SETC-M values from the receipt. The receipt grants no authority.
5. **What this receipt stands for.** An accepted GO-SETC-PRM receipt is the process export that section 3 item 5 of the set C packet requires within 6 hours of GO-SETC-M. It stands in for the GO-AR3 process export, by Root ruling SB437 item 2 (P2-3). The set C packet bytes do not change. GO-AR3 stays only as the ruled fallback.
6. **The one condition that matters to you.** Between this read and GO-SETC-M, nothing may restart the API or the worker, edit a unit file or a drop-in of the staging API or the trading worker, edit an environment file of the staging API or the trading worker, or run a daemon-reload of their manager (SB438 N3). Nothing may change the manager environment, restart a production unit or change the staged tree either. Most of these make GO-SETC-M refuse with no unit touched, and this read is then repeated under a new GO.
   - Two kinds of change are not detected before the window and can end with the API stopped in an owner-action hold: a unit file or drop-in edit followed by a daemon-reload, and an edit of an environment file of the API or the worker outside the few keys that the check scans (a process reads these files at its start, so this edit needs no daemon-reload). Root accepts these residuals only on the condition above (SB437 item 2, SB438 item 2).
   - A stream restart does not stop GO-SETC-M, but we ask that it be avoided.

## 2. Root rulings it rests on

- **SB435** and **SB436**: the need for a fresh read in the SM form, and the finding that no accepted record holds it.
- **SB437**: design r1 NOT_READY; open items O1 to O15 ruled, among them O1 (reads by byte copies of the sealed SM core), O5 (listener check on the API port), O6 (a fresh PRM before every GO-SETC-MR), O7 (the environment reads are stated plainly) and O11 (names). Item 2: this receipt is the set C packet section 3 item 5 process export in place of GO-AR3, with no byte change to the set C packet. SB426 Q4 (health stops) applies by analogy. Item 2 (P2-2) also accepts the residual of a unit file or drop-in edit followed by a daemon-reload.
- **SB438**: design r2 recheck. Item 1 rules the held-entry form (section 5 below and section 12). Item 2 (N3) adds the owner condition on environment files.
- **SB439**: design r3 accepted and interfaces frozen. **SB440** and **SB441**: build rounds B1 and B2 reviewed; SB440 item 1 sets the payload at 131072 bytes (amends design A4) and SB441 item 3 also applies. **SB442**: round B3 passed; round S (this packet, then the install, the pin fill, the mutant run, the seal and the independent seal check) starts.

## 3. Preconditions (Root, before the GO request)

1. GO-SETC-R0 is accepted, or the O3 probe is used (valid only if GO-SETC-M is issued within 6 hours of the probe).
2. A quiet slot: no other S6 host job, no R7 epoch, no local timing suite, and no `.qa-local` writes by any agent during the admission.
3. No restart automation is due before GO-SETC-M: no package upgrade, `needrestart` or unattended-upgrades service restart is scheduled, and there is no known crash loop of the API or the worker or out-of-memory pressure.
4. The owner is awake and reachable for about 15 minutes.
5. Remaining usage is above the 30 % band, read fresh by Root.
6. This packet is installed only after prep-sm S0b is accepted (the SB442 item 3 held-fresh age check is enforced only after S0b). The PRM tool is built, reviewed, sealed and independently seal-checked after this packet is installed as LF bytes and its `prmPacket` pin is filled. The pins of this packet, the set C packet r6b, the tool sources, binding, known hosts, SSH arguments and payload template are recomputed at admission, and any difference refuses before the host is contacted.
7. The PRM prep rehearsal is done and its folder is dropped.

## 4. The job

One job, in one SSH session, strictly read only, in this order:

- **PRM1 bound.** The tool checks the bound object (shape, pin, TREE_NAME, role list digest, the shape of the set B digest, candidate digest and tree digest; the set B value itself is checked locally) and records the host UTC start time. A bad shape stops with no read.
- **PRM2 health.** It reads `/proc/meminfo`, `/proc/loadavg`, the CPU count and the count of live S6 payloads. It stops before any unit read only on a live S6 payload or on available memory below 512 MiB (as the pre-read, by analogy with SB426 Q4). Any other failure of this stage ends in a collection-unknown stop. Every other value is recorded.
- **PRM3 units.** It takes one settled `systemctl show` snapshot of the ten bound staging and production units with fixed property lists. If a staging unit is transitioning, it polls for up to 30 s; a staging role still transitioning after that sets PRM_SETTLE and gives PRM_STOP. It then counts transitioning roles, pending jobs and roles that need a reload.
- **PRM4 reference.** For the staging API, the trading worker and the stream unit it computes the process digest, the restart count, the restart policy (API and worker only; null for the stream unit), the config digest and the drop-in digest in the SM gate form, and it computes the production unit rows and their digest.
- **PRM5 layer.** It computes the configuration layer in the SM gate form: the API drop-in list and file digests, the other drop-in inventory, the API and worker environment digests, the worker drop-in list and the closed flag tokens.
- **PRM6 process.** For the API and the worker, when the unit is running, it checks the running process against the bound candidate and against the loaded unit form (working directory, executable and argument vector) and reduces the links and command line to digests and booleans.
- **PRM6b listener.** When the API is running, it counts the listeners on the API port from `/proc` and checks that the running API owns the one listener.
- **PRM7 tree.** It walks the staged API tree [TREE_NAME `r3-api-ab1c1f194cd2`] with a 4 s cap and records EXACT or NOT_EXACT. This is a fact and a predictor, not a stop.
- **PRM8 frame.** It records the host UTC end time and writes one framed public JSON line to its standard output.

Allowed commands: `systemctl show` with fixed property lists for the ten bound units, `systemctl list-jobs`, `systemctl show-environment`, `systemctl show` of the environment property of the API and the worker, `/proc` reads (including the status and command line of same-user processes in the health stage), reads of unit drop-in files and environment files, a scan of the unit file and its drop-ins that runs only when the API unit names no environment file, and a read of the staged API tree.

It must be said plainly (SB437 O7). Unlike the pre-read S6-STAGING-SETC-PREREAD-1, this job reads the environment of the staging API unit:

- **The API unit `Environment` property.** The `Environment` and `UnsetEnvironment` properties of the staging API and the trading worker are read in memory and reduced at once to digests and closed flag tokens. This can hold key material in memory on the host. No value, and no key name paired with a value, leaves the process.
- **`systemctl show-environment`.** The manager environment is read in memory and scanned only for a fixed key list. It is reduced at once to booleans and flags (no digest), and its buffer is zero-filled.
- **Environment files and drop-ins.** The environment files named by the API unit, and the node environment files named on its command line, are read in memory and scanned only for the same fixed key list. The API drop-in files are read and hashed. Only digests leave.
- **Buffers.** The read buffers are zero-filled by the copied functions. A decoded text string in memory cannot be zero-filled, and this packet claims only the buffers.
- **Not done.** There is no database session, no HTTP request, no journal read and no code loaded from the tree.
- **Host traces.** The tool writes no file on the host. The only host traces are the shell input buffer (the here-document input that every S6 tool has) and the normal SSH login log lines.
- **Never happens.** No `start`, `stop`, `restart`, `reload`, `daemon-reload`, `set-environment`, `reset-failed` or `systemd-run`. Nothing is started, stopped, reloaded or written. No retry.
- **Known gap, by choice.** The SM gate may still stop on login-kill, heavy jobs, failed units, the database gate, the hooks recheck, the lock holders, the stop-timeout gate or the backup root. This job does not read these, so GO-SETC-M may still refuse with no unit touched (A-R6).

## 5. Output and Root reading key

The output is one public JSON receipt (`prm-receipt.json`, one canonical line). Every string value in it is a hex digest, an ISO time or a member of a closed vocabulary; an exact body validator refuses anything else. A second guard, the needle rule, refuses an output that echoes a whole private bound value; that receipt is a failure receipt with verdict OUTPUT_INVALID and no host facts are kept.

Verdicts:

- **PRM_COLLECTED**: every value was read, no stop code is set, no unit read failed, the layer facts are read, the three reference processes and restarts are read, the production rows are read, the API and the worker are both running with their process booleans read, the listener is read and the tree label is not NOT_RUN. It means "every value was read". Whether the values are acceptable is decided by the prep and Root.
- **PRM_COLLECTED_HELD** (SB438 item 1): the held-entry form, used only after a window that ended with the API stopped or with the API and the worker stopped. The API reads NOT_RUNNING (class INACTIVE or FAILED, no main process); the worker reads RUNNING or NOT_RUNNING; the process values of each stopped role and its reference process are empty; its restart count is still read; the listener reads NOT_READ; every other member reads as for PRM_COLLECTED. It means "every value that a held entry has was read". A stopped worker with a running API is not a held entry and gives PRM_STOP. A PRM_COLLECTED_HELD receipt never serves the GO-SETC-M prep.
- **PRM_STOP**, **TRANSPORT_FAILED** and **OUTPUT_INVALID**: every other result. For PRM_STOP the receipt field `codes` holds every stop code in the fixed order and the envelope field `code` holds the first one. A PRM_STOP can carry an empty `codes` list; the envelope `code` is then null.

**Root reading key.** The SM gate raises none of LAYER, SETC_STOP_DRIFT and PRODUCTION_DIFFERENCE because of the bound values, and the SM starts pass the units and listener readiness checks, when all of these hold between this receipt (M) and the SM gate's own read (G):

- the layer facts equal G's layer facts, and the layer `ok` value is true;
- the reference process digests and restart counts of the API, the worker and the stream unit equal G's;
- the production unit rows and their digest equal G's;
- for the API and the worker, `procAllOk` and `loadedFormProcOk` are both true for the bound candidate, and the unit configuration digest is unchanged;
- the listener `ok` is true: the running API owns the one listener on the bound port.

Root accepts the receipt by ruling and checks the verdict, research class inactive, no reload needed, tree EXACT, every required boolean true, and the clock comparison. A wrong derivation of the candidate shows as `procAllOk` false with `loadedFormProcOk` true; a configuration loaded without a restart shows as the reverse. Each costs a Root investigation and a new PRM GO, never a GO-SETC-M, because the prep refuses with UNITS_NOT_PROVEN.

**Clock comparison.** The receipt carries the host UTC start and end times beside the local spawn and close times. Root compares them: the host times must lie within five seconds of the local interval. A failed comparison does not change the verdict; Root rules on it.

## 6. Durations

About 1 to 2 minutes of host time. The local bounds are: an internal work deadline of 240 s, a remote timeout of 300 s plus a kill-after of 10 s, a local cutoff of 330 s and an overall limit of 340 s. The remote command is wrapped in the 300 s timeout. There is no API gap: nothing is stopped or restarted.

## 7. Rollback and stop point

No rollback is needed. The tool changes no unit, file or database. The only host traces are the shell input buffer and the normal SSH login log lines. A lost or failed transport leaves nothing to recover; a new attempt needs a new owner GO, and Root starts it only after the remote bound (310 s after the spawn) has passed, so two PRM processes never overlap.

The stop point is the accepted receipt plus Root's reading under section 5, recorded in a tracked ruling. Every later job needs its own GO.

**Timing.** A receipt serves one GO-SETC-M issue window. The PRM host start becomes the export time of the set C packet section 3 item 5, whose notAfter is at least the window end plus 4657 s and at most the export time plus 6 hours, so GO-SETC-M must be issued within about 4 h 40 min of the host start (section 12). An API or worker restart, a unit or drop-in edit, an environment file change, a daemon-reload, a production unit restart or a change of the staged tree in between voids the receipt. For the changes the SM gate detects, it refuses (fail closed, no unit touched, GO-SETC-M spent) and a new GO-SETC-PRM comes first. Two changes are not detected before the window: a unit file or drop-in edit followed by a daemon-reload, and an edit of an environment file outside the scanned keys. These can end with the API stopped in an owner-action hold (section 1 item 6, section 8 residual R3); the owner condition in section 1 item 6 is the only protection against them.

## 8. Residual risks and unknowns

- **A-R1, restart.** Any API or worker restart between this read and the SM gate stops the SM with SETC_STOP_DRIFT, touches no unit and burns the GO-SETC-M attempt. A stream restart is recorded only and does not stop the SM.
- **A-R2, collector timer.** A collector timer firing during the read shows a transitioning or running collector. The tool records it; the SM gate exempts the collector service while its timer runs. The tool's own exemption covers only a RUNNING collector service whose timer is RUNNING; a staging role still transitioning after the 30 s settle gives PRM_SETTLE and PRM_STOP. Root reads the classes.
- **A-R3, key material in memory.** The environment reads see key material in memory on the host. Only digests and closed tokens leave, and the exact body validator is the guard. A digest of a low-entropy environment map is guessable in principle; the receipt never pairs it with a key name.
- **A-R4, wrong candidate or loaded form.** See section 5. Costs a Root investigation and a new PRM GO.
- **A-R5, tree walk cap.** A slow disk gives NOT_EXACT, which also predicts the SM TOOL_PIN stop.
- **A-R6, known gap by choice.** See section 4. After the record opens and before any unit effect, the SM also checks the tree, the lock holders, the stop-timeout gate and the backup root. Each fails closed with no unit touched.
- **A-R7, listener read.** The listener read walks the fd links of other processes only when a listener on the API port is not held by the API, and then the result is already not ok. A slow walk ends PRM_LISTENER_READ (fail closed, one PRM GO).
- **Residual R3 (narrowed, SB438 N3).** See section 1 item 6: a unit file or drop-in edit followed by a daemon-reload, and an environment file edit outside the scanned keys, are not detected before the window. Accepted only on the owner condition.
- **Receipt size.** A very large drop-in directory fails closed (OUTPUT_INVALID or TRANSPORT_FAILED) with no unit touched and one PRM GO spent.

## 9. Owner checklist before the GO

1. I know this job changes no unit, file or database.
2. I know it reads the API and worker environment properties and the manager environment in memory and returns only digests.
3. I know its result is used only to prepare GO-SETC-M (and GO-SETC-MR).
4. Before GO-SETC-M I will not restart the API or the worker, and I will not edit a unit file or drop-in of the staging API or the trading worker.
5. Before GO-SETC-M I will not change an environment file of the staging API or the trading worker (SB438 N3), and I will not run a daemon-reload.
6. I will avoid a stream restart.

## 10. Suggested owner GO wording (TEMPLATE, NOT A GO)

Root fills the brackets; the owner types the line. This is a template and not a GO. Each GO is its own line; there is no combined line.

> TEMPLATE - NOT A GO. GO S6-STAGING-SETC-PREREAD-M-1 PRM attempt [a01] for Staging QL-P2 Prototype only, pin [ab1c1f194cd20c3953a9b9628adc6322895058f1], sealed tool [SHA256SUMS], read only, in one SSH session with the reviewed tool: a bounded health read; systemctl show of the ten bound staging and production units with fixed property lists, including the environment property of the staging API and the trading worker read in memory and reduced to digests; the manager environment read for a fixed key list; a hash-only read of the staging API drop-in files; a read of the environment files named by the staging API unit and its command line, scanned in memory for a fixed key list only; the process links and command lines of the running API and trading worker reduced to digests; a count of the listeners on the staging API port from /proc; a walk of the staged API tree [TREE_NAME r3-api-ab1c1f194cd2 under the REPIN-3 tree root]. No start, stop, restart or reload; no database session; the tool writes no file and changes no unit; the shell input buffer and the normal SSH login log lines are the only host traces. notAfter [UTC].

`notAfter` is at least the GO window end plus 310 s, and Root also applies the prep tool's margin (start-by time plus the 340 s overall limit plus 15 minutes).

## 11. Not authorized

This packet excludes everything listed in section 14 of the set C packet r6b, and in addition:

- any unit control verb (start, stop, restart, reload, daemon-reload), `set-environment` and `reset-failed`;
- any journal read;
- any HTTP request;
- any database session.

Spot and Paper only; BINANCE:BTCUSDT Spot 1m. No Live activation, guard reset, Best Inputs apply or optimizer.

## 12. Standing rule for GO-SETC-M and GO-SETC-MR

A GO-SETC-PRM receipt serves one GO-SETC-M issue window, which must be used within about 4 h 40 min of its host start (section 7 Timing). A later GO-SETC-M needs a new GO-SETC-PRM. Every GO-SETC-MR needs a fresh GO-SETC-PRM first (SB437 O6, amended by SB438 item 1). The order is: the window ends, a new GO-SETC-PRM attempt, its acceptance, the MR prep and rehearsal, then the GO-SETC-MR request.

When the SM window ends with the API or the worker stopped, the fresh read is accepted in its held form (PRM_COLLECTED_HELD): the stopped units are reported as not running, and their process values and the API port check are left empty. The MR prep accepts the held form only when the stopped roles equal the stopped roles of the SM receipt. A held PRM must also be newer than the window end and within 6 hours of the GO-SETC-MR issue (SB442 item 3).

**GO-SETC-M request line (Root adds it outside the GO line).** Root adds this line to every GO-SETC-M request it sends to the owner; the GO line keeps the set C packet section 10 brackets only:

> Process export for set C packet section 3 item 5: the accepted GO-SETC-PRM receipt [PRM attempt], receipt sha [first 8 hex], host start [UTC], is the process export in place of a GO-AR3 reading, by Root ruling SB437 item 2; the set C packet bytes are unchanged. Between that read and this GO, no API or worker restart, no unit file or drop-in edit of the staging API or the trading worker, no environment-file change of the staging API or the trading worker and no daemon-reload is known to Root.
