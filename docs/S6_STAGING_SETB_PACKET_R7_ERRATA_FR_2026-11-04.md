# S6 staging set B packet r7: errata E-FR1 to E-FR3 (first read)

Document ID: **S6-STAGING-SETB-1-R7-ERRATA-FR**. Date: 2026-11-04. Author: documentation role (Sonnet 5.5 / medium), child of "Root: astra-vps-trade-bot-v2".

## 0. What this document is

1. This document amends the set B packet r7 (`docs/S6_STAGING_SETB_PACKET_R7_2026-11-03.md`) for the first-read path of set B job B0. It does not change the packet r7 file. Where this document and the packet r7 text differ on the points named below, this document governs. Everywhere else the packet r7 stands unchanged.
2. The set B job B0 manifest names this document by its sha256 in its preconditions (ruling SB100 item 3). The hash is of the file as committed, with LF line endings. No B0 tool constant changes, so no B0 re-seal follows from this document.
3. Nothing in this document is a GO. It issues no approval, starts no job and changes no gate. A GO for set B job B0 is a separate owner record (ruling SB99 item 1) and covers only what it names. The packet r7 gates, the Spot/Paper-only limits and the one-writer rules stand.
4. Basis: Root rulings SB94 to SB100 (`root-ruling-sb1.md`); the B0 gap spec of 2026-11-04 (`b0-gap-spec-2026-11-04.md`); the sealed B0 round r3g (seal record `seal-b0-r3g.json`, build snapshot `build-snapshot-b0-r3g`, whose rebuild notes carry the first-read completeness rule, the working-directory root rule and the B2 bind rule used below). All three live in the local evidence folders, not in tracked files.

| Item | Short name | Ruling | Packet r7 section amended |
| --- | --- | --- | --- |
| E-FR1 | First-read rule | SB94 item 2, SB97 item 1, SB98 item 1, SB99 | 4.1 items 9 and 10; R3-OQ15 (section 15, OQ-15 part 2) |
| E-FR2 | Root review of a first read; a02 binding | SB96 item 1, SB98 item 1, SB99 item 2 | 4.1 item 10; R3-OQ15 |
| E-FR3 | B2 gate item 4 reference | SB96 item 1, SB98 items 1 and 2, SB99 | 4.3 gate item 4 |
| G-B0-RT | Runtime connection form | SB94 item 3, SB99 item 3, SB100 item 1 | 4.4 (connection spec): no change |

## 1. E-FR1: the first-read rule

Reason (ruling SB94 item 2). The first set B job B0 attempt has no reviewed set B receipt. The records Root holds do not contain the API drop-in list or the process facts in the compared form, so a normal B0 would most likely stop at item 9 and spend the owner GO without leaving a reference. Owner decision O1 (ruling SB99): approve option FR-2, first read then compare. Option FR-1, a first-read pass that writes a receipt, was rejected because it needs a B1 contract v6 and a re-pin cascade.

Rule.

1. The bound B0 object has a closed boolean key `firstRead`, always present. `firstRead` true requires a null `ref`, null `dropIns` and attempt `a01`. Any other mix is refused at admission. `firstRead` false keeps the packet r7 rules (hex `ref` and `dropIns`).
2. Root may set `firstRead` true only when no Root-reviewed set B receipt (B0, B2, RS, RB or RBC) exists, only for attempt `a01`, and only once per packet revision. The tool guards the attempt and the null reference; the other conditions are this Root rule.
3. With `firstRead` true, B0 records and does not compare in two places. At packet section 4.1 item 9 it computes both drop-in list digests (API and trading worker) and does not compare them. At item 10 it does not compare the process facts. Every other item 9 stop stays (working directory, API sources and runtime key, QR-2 flag, research flags, job list, stop timeouts). Items 11 to 16 run as in a normal B0.
4. A first read still writes the AR-form export. The export (in both modes) also holds the main-process start times of the three units and the B2 layer facts in the form of E-FR3. The export is a private file (mode 0600) in the job record directory; its copy in `.qa-local` stays private. The API environment digest therefore never reaches a public body.
5. A first read writes no receipt and no snapshot record. After the overlay removal and before the receipt, it ends `B0_STOP_DRIFT` with the body label `drift.mode` equal to `FIRST_READ` and `firstRead.completed` true. The end code `B0_STOP_DRIFT` therefore carries two meanings (real drift, or a first read); a reader of the end code alone must read `drift.mode` before it names a reference.
6. Completeness rule (round r3g). A first read is a reference only when all of these hold: the end is `B0_STOP_DRIFT`; `drift.mode` is `FIRST_READ`; `firstRead.completed` is true; and `anchors.drifted` is empty. Any other first-read end is not a reference. A first read can also end `B0_STOP_DRIFT` with mode `FIRST_READ` at item 10 (a dead or unreadable main process) or at item 15 (anchor drift or a P2 listener); the export is then written but the read is incomplete.
7. A stop before the export (round r3g note). The API drop-in directory is read before the export is written. A drop-in directory that is not one directory holding only regular readable files with allowed names ends `PRE_DROPIN_SHAPE` or `PRE_DROPIN_READ`, and an unreadable main process unit ends `PRE_PROC_UNREADABLE`. These are item codes in both modes and none writes an export, so none can be a reference.
8. Meaning of the receipt field. In the next attempt (a02, `firstRead` false), the receipt field `dropInListsEqualRepin2` means "equal to the reference that Root bound": the REPIN-2 end state, or a reviewed first-read export. The field name is unchanged, so B1 and its contract (v5) are unchanged. B1 never sees a01, because a01 has no receipt.
9. After Root accepts the a02 receipt, its export is the B2 reference (SETB-R7). GO-B2 still needs that export to be at most 6 hours old at the GO. A real drift in a02 ends `B0_STOP_DRIFT`; its export may become the next reference under R3-OQ15 only after Root review.

## 2. E-FR2: Root review of a first read, and the a02 binding

Root reviews the a01 export before anything binds it. Root records each point below; any failure stops the set B path for an owner question.

1. Completeness first: the four conditions of E-FR1 item 6 hold. If not, the export is not a reference and E-FR2 points (a) to (d) are not applied.
2. (a) The trading-worker drop-in digest equals the A2 manifest trading drop-in digest, if Root has confirmed the two forms are equal. Otherwise Root records "not comparable", and point (c) alone covers the worker.
3. (b) The API main process started no later than the A2 a01 delayed-check time, and its restart count equals the count A2 recorded, if one is recorded.
4. (c) The worker main process started no later than the AR a01 or A1 a01 record time, and its restart count equals that record's count.
5. (d) The API drop-in file digests contain the A2 layer drop-in content digest, and the live API drop-in count equals the count Root derives from the REPIN-2 records, if Root has confirmed that the A2 record digest has the `readDropIns` file-digest form; otherwise Root records "not comparable" and the count check alone applies.
6. (e) Items 9 (other checks) and 11 to 16 passed. The end is `B0_STOP_DRIFT` with `FIRST_READ`, and no other code.
7. A difference Root cannot explain from a reviewed record is an unreviewed change. Root does not adopt it as a reference.

What the review replaces: the automatic continuity check from the REPIN-2 end state to B0, which a first read cannot make. Every other B0 hard check stays, and the a02 compare restores the automatic check before B1 or B2 spends anything. Residual (recorded, not closed): a change between A2 (2026-11-01) and a01 that leaves the start times, restart counts and the A2 drop-in content in place, for example an added drop-in file that the main process has not loaded. Point (d) catches a count difference, and the B2 reload and layer gates catch an unloaded change.

The a02 binding is a Root step, with values never printed:

1. `ref` is the members `export.arForm.processes` and `export.arForm.restarts` of the reviewed a01 export, with digest H(C({processes, restarts})) in the form the prep tool uses.
2. `dropIns` is the a01 AR-form drop-in digests of the API and the trading worker: `export.arForm.dropInDigests.STG_API` and `export.arForm.dropInDigests.STG_TRADING`.
3. `firstRead` is false and the attempt is `a02`.
4. Working-directory rule (round r3g, option (b); a rule for the prep tool and Root, not code). The B0 layer check compares the loaded API working directory with the bound tree root, while B2 gate item 4 compares it with the B2 connection `pgRoot`. At bind, the prep tool asserts that the B0 connection `pgRoot` equals the B0 tree root, and the B2 `pgRoot` must equal the same value.

## 3. E-FR3: B2 gate item 4 reference

Reason. Packet section 4.3 gate item 4 compares the API layer with "the accepted REPIN-2 end-state record". After A2 no accepted record holds the post-A2 API drop-in list in the form B2 binds (finding G-B2-LAYER, confirmed in ruling SB96 item 1). Without a fix, B2 would end `B2_STOP_LAYER` after B1 and after GO-B2 is spent. Owner decision O6 (ruling SB99): E-FR3 approved.

Amendment. In packet section 4.3 gate item 4, the words "equal to the accepted REPIN-2 end-state record" read: equal to the layer facts in the Root-reviewed B0 export that is the B2 reference. The other tests of item 4 (loaded working directory equals the B2 connection `pgRoot`, which is the tree; QR-2 flag effective 1; research flags 0; no environment file sets the QR-2 flag; no heap-size option, as the sealed B2 r3e code also tests) are unchanged. In the same item, the words "Trading-worker drop-in list equal to its P4 list" read: trading-worker drop-in list equal to the worker drop-in list in the same Root-reviewed B0 export. Root binds it from the export only after E-FR2 point (a) or (c) holds for the worker.

Bind rule (round r3g, from `layerChecks`).

1. B0 exports `layer` with exactly the five keys B2 binds as `B.layer`: the API drop-in list, the API drop-in files, the other inventory, the API environment digest and the worker drop-in list. It exports the booleans B2 tests beside the compare in a separate member, `layerChecks`: `workingDirectoryIsTree`, `qr2InFile` and `heapOption`.
2. B0 records `qr2InFile`, `heapOption` and an empty API environment digest; it does not stop on them. Root decides.
3. Root binds B2 `B.layer` from the export only when `layerChecks` equals {`workingDirectoryIsTree` true, `qr2InFile` false, `heapOption` false} and every `layer` member passes the B2 layer shape check (the API environment digest must be a non-empty hex digest). Otherwise Root does not bind and asks the owner.
4. The `pgRoot` rule of E-FR2 item 4 applies.
5. B2 re-reads the live layer at its own gate and compares it with the bound facts. The binding does not replace that read.
6. The `layer` form was cross-tested in round r3f (part of the sealed r3g suite) against what the sealed B2 r3e layer function computes on the same fake unit (three worlds). A form slip would otherwise end B2 `B2_STOP_LAYER`.

B2 code is unchanged. Only this reading of gate item 4 changes.

## 4. G-B0-RT: closed (ruling SB100 item 1)

The gap was whether the staging runtime role can connect over the bound socket form without a password, and whether the API connection setting has that same identity. Without it, B0 item 5 or the API source compare would stop B0 (ruling SB94 item 3; option RT-B of the gap spec, owner question O2 and O3).

Result. At the owner request, Root ran the approved read-only check on the staging host as the service user. It printed form flags only and no value. The answers: the API connection setting is in socket form, has no password, names the runtime role, matches the bound socket directory and has no extra query keys; and a password-less socket connection as the runtime role succeeds. The check changed nothing on the host except a temporary file, removed in the same command, and its hash on the host matched.

Ruling. The API connection setting has exactly the bound socket identity, and the runtime role connects over the socket without a password. The bound socket form (RT-B) holds lane-wide. No code change, no packet change and no pg_ident or authentication change is needed. G-B0-RT is closed.

## 5. Owner decisions recorded (ruling SB99)

Owner, in chat at the computer:

| Question | Decision |
| --- | --- |
| O1 First-read design | FR-2 approved (FR-1 not chosen) |
| O4 Where the errata live | An errata file, not a packet r8 (this document) |
| O6 B2 gate item 4 reference | E-FR3 approved |
| O5 New GO-B0 | Allowed when ready, for the first-read path: attempts a01 (first read) and a02 (compare). The GO record is separate from this document and covers nothing else. |
| O2 API connection form; O3 password-less socket | Owner unsure; answered by the read-only check of section 4 (ruling SB100) |

Related Root work order (ruling SB99 item 2): B0 round r3g sealed; prep tool r3; this errata file pinned by sha256 in the B0 manifest preconditions; jobs rehearsal r5d; then Root check, prep and dry admission; then the operations-worker run of a01. None of these steps is approved by this document.

## 6. What does not change

The packet r7 gates, durations, exclusions and the Spot/Paper-only scope; B1 and its contract (v5); B2 code; the RS, RB and RBC jobs; the lane; the reading of every other B0 item; the immutable-evidence and holdout rules. The stream difference is still recorded and never stops B0 (OQ-15 part 1).
