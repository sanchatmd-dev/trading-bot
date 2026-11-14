# S6 staging set C pre-read packet

Packet ID: **S6-STAGING-SETC-PREREAD-1**. Phase: **PR** (GO name GO-SETC-PR). Status: **draft r1, proposed, not accepted, NOT RUN, NO EXECUTION GO**. `PACKET_SHA` is the sha256 of this file's final LF blob once Root installs it under `docs/`; Root records it in the tool pin and the acceptance record, never in this file.

Pin: `ab1c1f194cd20c3953a9b9628adc6322895058f1`. Staged API tree name (TREE_NAME): `r3-api-ab1c1f194cd2`.

> **This packet proposes one read-only job on the owner's staging host.** It starts, stops, restarts and reloads nothing and changes no unit, file or database. It still contacts the host, so it runs only after a **new explicit owner GO that names S6-STAGING-SETC-PREREAD-1, phase PR and Staging QL-P2 Prototype**. Approval of this document, of the set C packet or of any earlier S6 GO does not authorize it.

This is a draft for review. It is drafted from design r1 section 5 (items 1 to 12), with facts from design r1 sections 1.1 to 1.5 and 7 and from Root rulings SB424 to SB429. It edits no set C, REPIN-3 or set B packet; the set C packet r6b sha is pinned in all four sealed set C tools and stays unchanged.

## 1. Owner summary

1. **Why.** The set C R0 job reads the staging and production units itself, and it refuses with no effect if what it reads differs from the values Root gave it in the precondition record. No accepted record holds those values in the exact form R0 reads (SB425). This job takes one fresh read in that same form.
2. **What it does.** It reads only. In one SSH session it reads the host health, the properties of the ten bound units, the staged API tree, and a few database facts through one read-only database session.
3. **What it returns.** Labels, booleans, counts, ISO times and hex digests only. It returns no path, unit name, host name, address, user name, database role or database name, environment value or raw systemd text.
4. **What it decides.** Nothing. Root compares the receipt with the R0 inputs and builds the R0 precondition from it. The receipt grants no authority.
5. **The one condition that matters to you.** Between this read and GO-SETC-R0, nothing may restart the API, change a unit, start the research worker or upgrade and restart PostgreSQL. If any of these happens, R0 may refuse at its P2 check with no effect, and this read is repeated under a new GO.

## 2. Root rulings it rests on

- **SB425** (item 1), **SB424** and **SB420** (item 5): SB425 rules that R0 needs a fresh R0-form host read before each GO-SETC-R0, and that a small read-only pre-read packet and tool provide it. SB424 names the blocker B3. SB420 item 5 lists the GO-SETC preconditions.
- **SB426**: rulings Q1 to Q12 on design r0 (database facts read here, selector class read, `tradingFlagsOf` closed tokens, memory and live-payload stops only, host clock times in the receipt, 3 h age limit, two separate GO lines, packet file name and install order).
- **SB427**: design r1 accepted, interfaces frozen, open items O1 to O3 and recheck notes N1 to N6 ruled.
- **SB428** and **SB429**: build rounds B1 and B2 reviewed. SB428 ruled the deviations found by the two lanes. SB429 recorded the B2 tester pass and recheck, and sent the pre-read tool to round S (real-PostgreSQL sweep, mutant run, seal and independent seal check), unsealed, after this packet is installed and its pin is filled. The pre-read tool is not accepted until the seal and the seal check are done.

## 3. Preconditions (Root, before the GO request)

1. H3 is accepted by Root ruling: the RW receipt and envelope exist and the research worker is stopped.
2. A quiet slot: no other S6 host job, no R7 epoch, no local timing suite, and no `.qa-local` writes by any agent during the admission.
3. No restart automation is due before R0: no package upgrade, `needrestart` or unattended-upgrades service restart is scheduled, and there is no known crash loop of the API or out-of-memory pressure. Root plans the later R0 start away from a scheduled collector timer firing.
4. The owner is awake and reachable for about 15 minutes.
5. Remaining usage is above the 30 % band, read fresh by Root.
6. The pre-read tool is built, reviewed, sealed and independently seal-checked after this packet is installed as LF bytes and its `preReadPacket` pin is filled. The pins of this packet, the set C packet r6b, core, runner, binding, known hosts, SSH arguments and payload template are recomputed at admission, and any difference refuses before the host is contacted. The R0 seal record pin is a constant inside the tool and is not recomputed.
7. The PR prep rehearsal is done and its folder is dropped (design r1 section 2.6).

## 4. The job

One job, in one SSH session, strictly read only. It uses the same reads as the sealed R0 gate, in this order:

- **PR1 bound.** The tool checks the bound object (shape, pin, TREE_NAME, role list digest, binding digest and SQL digest) and records the host UTC start time. A bad shape stops with no read.
- **PR2 node.** It records the node major version. A major other than 24 is recorded and stops only the database stage.
- **PR3 health.** It reads `/proc/meminfo`, `/proc/loadavg` and the CPU count, the pending systemd jobs per scope, and the count of live S6 payloads. It stops before any unit read when another S6 tool is in flight or available memory is below 512 MiB. It also stops before any unit read when a health read fails: an unparsable `/proc/meminfo` or `/proc/loadavg`, a bad CPU count or a failed `systemctl list-jobs` ends in a collection-unknown stop and no unit is read. The R0 floors (memory, load, pending jobs) are recorded as three booleans, because R0 would stop on them; they do not stop this job.
- **PR4 units.** For each of the ten bound staging and production units it reads one fixed `systemctl show` property list, the same one R0 uses, and reduces it with the same sealed functions to a config digest, a run digest, a load state and an active state. For the staging API it also derives the API config digest from the same properties. For the trading worker it records two closed flag tokens (see below).
- **PR5 tree.** It walks the staged API tree and records whether it is exactly the expected tree, whether any file is other-writable or foreign-owned, the file count and the digest. If it is not exactly the expected tree, no database stage runs.
- **PR6 database.** Only when the tree is exact, no file is other-writable, no file has a foreign owner, and the node major version is 24, the database client module (`pg`) is loaded from the staged API tree and runs inside the tool's own process. The tool opens one read-only, repeatable-read session through the migration connection selector and reads the server version number, the database size, the data directory check, the session identity check and the selector class.
- **PR7 frame.** It records the host UTC end time and writes one framed public JSON line to its standard output.

Allowed commands: `systemctl show` with fixed property lists for the ten bound units, `systemctl list-jobs`, `/proc` reads, a read of the staged API tree, and one read-only database session through the migration connection selector, in process.

It must be said plainly:

- The `pg` module is loaded from the staged API tree and runs in the tool's process, only after the tree reads exact. This is code from the tree run in process; Root accepted it in ruling Q1 (design risk R4).
- The trading worker's `Environment` property is read in memory, as R0 reads it, and reduced at once to two closed tokens (the QR3 comparison flag and the fixed-evaluation flag). No environment value leaves the process. The buffer that held the raw text is zero-filled; a decoded text string in memory cannot be, and this packet claims only the buffer.
- The API unit's `Environment` property is never read. The tool does not run R0's API show command, because it also returns the API environment text, which can hold key material.
- The tool writes no file on the host. Its only host traces are the shell's here-document input buffer, which every S6 tool has, and the normal SSH login and database connection log lines.
- Never happens: no `start`, `stop`, `restart`, `reload`, `daemon-reload`, `set-environment` or `show-environment`; no journal read; no database write; no SQL outside the sealed query list; no retry.
- Known gap, by choice: R0 also stops on heavy jobs, a login-kill setting, leftover S6 units and failed units. The pre-read does not read these, so R0 may still stop on them, with no effect (design risk R8).

## 5. Output and Root reading key

The output is one public JSON receipt (`pr-receipt.json`, one canonical line). It holds, per bound role label: load state and active state labels, config digest, run digest and a `parseOk` boolean. It also holds the API config digest, the tree facts, the database facts (server version number, size, data directory label, selector class), the trading flag tokens, the host UTC times and counts of failed reads. The verdict is `PR_COLLECTED` only when no stop code is set, every unit is read, the tree is exact and every database field is read. Otherwise it is `PR_STOP`, `TRANSPORT_FAILED` or `OUTPUT_INVALID`. For `PR_STOP`, the receipt field `codes` holds every stop code in the fixed stop order, and the envelope field `code` holds the first one. If the local runner finds an echo of a private bound value, the receipt is a failure receipt with verdict `OUTPUT_INVALID` and code `OUTPUT_ECHO`, and no host facts are kept.

The local runner refuses an output that echoes a whole private bound value (a path, unit name, host or user name, selector member or the data directory). Role labels, the TREE_NAME, the pin and digests are never treated as private values.

**Root reading key.** R0 raises none of P2_UNIT_DRIFT, FACT_API_CONFIG_CHANGED or the version part of P2_DATABASE_IDENTITY because of the precondition values when all of these hold between this receipt (PR) and R0's own read (G):
- for every role, `PR.units[k].configDigest` equals `G.perRole[k].configDigest`;
- for every staging role, `activeState` is equal;
- the staging API `runDigest` is equal;
- `PR.apiConfigDigest` equals `G.apiConfigDigest`;
- `PR.db.serverVersionNum` equals `G.identity.version`.

The database size is not compared, because R0 uses the larger of its live read and the precondition value. A different production `runDigest` with an equal config digest is only a recorded fact.

Root accepts the receipt by ruling and checks: `PR_COLLECTED`, selector class OWNER, research worker inactive, trading flags read and neither token equal to 1 (the prep refuses a flag of 1), `apiEntrySuffixFound` (it settles the api.entrySuffix flag of SB425 item 3 by host observation), `apiDigestFormEqual` true (a false value gives the prep refusal API_DIGEST and the host stop PR_DIGEST_FORM), tree exact, every `parseOk` true (a role whose line does not parse changes its digest at every start of that unit and needs an explicit acknowledgement; a collector with an active timer cannot be acknowledged), and the R0 floor booleans.

**Clock comparison (Q6).** The receipt carries the host UTC start and end times beside the local spawn and close times. Root compares them: the host times must lie within five seconds of the local interval. This covers the earlier host `date -u` preflight read, so no separate host dispatch is needed for it. A failed comparison does not change the verdict; Root rules on it.

## 6. Durations

About 1 to 3 minutes of host time. The local bounds are: an internal work deadline of 240 s, a remote timeout of 300 s plus a kill-after of 10 s, a local cutoff of 330 s and an overall limit of 340 s. The remote command is wrapped in the 300 s timeout. There is no API gap: nothing is stopped or restarted.

## 7. Rollback and stop point

No rollback is needed. The tool changes no unit, no file and no database. The only host traces are the shell input buffer and the normal SSH login and database connection log lines. A lost or failed transport leaves nothing to recover; a new attempt needs a new owner GO, and Root starts it only after the remote bound (310 s after the spawn) has passed, so two pre-read processes never overlap.

The stop point is the accepted receipt plus Root's reading under section 5, recorded in a tracked ruling. Every later job needs its own GO.

**Timing.** At most 3 hours may pass from the receipt's local close time to each R0 prep (the rehearsal and the real prep), and the GO-SETC-R0 request is sent inside the same window. An API restart, a unit change, a research start or a PostgreSQL upgrade with restart in between voids the receipt; R0 then may refuse with no effect and a new GO-SETC-PR attempt comes first.

## 8. Residual risks and unknowns

- **R1, API restart.** The API run digest changes on any API restart, including a crash restart, a `needrestart` or unattended-upgrades restart, or an out-of-memory kill. A restart fails R0 closed at P2 with no effect and costs the R0 GO attempt and a new pre-read GO.
- **R2, self-changing STG unit.** A staging unit that changes active state by itself, for example the collector service started by an active collector timer, makes R0 read a drift even with a correct pre-read. This is a property of the sealed R0 comparison and fails closed. Root times R0 away from a timer firing; the pre-read cannot predict one.
- **R3, volatile digest.** A role whose start line does not parse has a config digest that changes at every start of that unit, including production units.
- **R4, code from the tree.** The `pg` module from the staged tree runs in process. It is gated by the exact tree walk, the same path R0 uses.
- **R5, first real admission scan.** The R0 admission scan has never run against the real `.qa-local`. A stale same-family file refuses it; the R0 rehearsal finds this before the GO request.
- **R6, selector class.** The selector class read here is evidence for the expectation. The R0 receipt stays the authoritative read.
- **R7, private files read by the prep.** The prep tool reads Root's private binding files. This is Root only and happens locally; no agent reads them, and it is covered by section 3 item 7.
- **R8, unread R0 stops.** See section 4, known gap.
- **R9, rehearsal folder.** A rehearsal folder stays runnable until it is dropped. Root drops it before the GO request (section 3 item 7).

## 9. Owner checklist before the GO

1. I know this job writes no file and changes no unit or database.
2. I know the shell input buffer and the normal SSH and database connection logs are its only host traces.
3. I know its result is used only to prepare GO-SETC-R0, or GO-SETC-R after GO-SETC-M is accepted.
4. I will not restart the API between this read and GO-SETC-R0.

## 10. Suggested owner GO wording (TEMPLATE, NOT A GO)

Root fills the brackets; the owner types the line. Each GO is its own line; there is no combined line. The owner may type GO-SETC-PR and, in the same sitting, GO-SETC-R0, but the R0 line is typed only after Root has accepted this receipt and sent the R0 request that carries its sha.

> TEMPLATE - NOT A GO. GO S6-STAGING-SETC-PREREAD-1 PR attempt [a01] for Staging QL-P2 Prototype only, pin [pin], sealed tool [SHA256SUMS], read only, in one SSH session with the reviewed tool: a bounded health read; systemctl show of the ten bound staging and production units with fixed property lists; a read of the staged API tree [TREE_NAME r3-api-ab1c1f194cd2 under the REPIN-3 tree root]; one read-only database session through the migration connection selector, in process, with the database module loaded from that tree, reading the server version, the database size, the data directory, the session identity and the selector class. No start, stop, restart or reload; the tool writes no file and changes no unit or database; the shell input buffer and the normal SSH and database connection logs are the only host traces. notAfter [UTC].

`notAfter` is at least the GO window end plus 310 s, and Root also applies the prep tool's margin (start-by time plus the 340 s overall limit plus 15 minutes).

## 11. Not authorized

This packet excludes everything listed in section 14 of the set C packet r6b, and in addition:
- any unit control verb (start, stop, restart, reload, daemon-reload);
- any read of the API unit's environment;
- any journal read.

Spot and Paper only; BINANCE:BTCUSDT Spot 1m. No Live activation, guard reset, Best Inputs apply or optimizer.

## 12. Standing rule for GO-SETC-R

A GO-SETC-R (the SV run) also needs its own GO-SETC-PR, taken after GO-SETC-M is accepted. The reason is that SV compares the same units, and the window restarts the API and the trading worker, so the earlier read is void. The order is: GO-SETC-M accepted, a new GO-SETC-PR attempt, its acceptance, the SV prep and rehearsal, then the GO-SETC-R request. This rule is stated here and in ruling SB426 only. The set C packet is not revised for it, because a revision would re-pin and re-seal R0, SV, SM and SMR.
