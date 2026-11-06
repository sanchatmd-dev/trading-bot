# R7 fresh capacity epoch: design contract EM3 (2026-11-06)

Status: DESIGN_ACCEPTED_NOT_A_GO (Root acceptance 2026-11-06, ruling SB182, after one Opus review and one fix round, re-review READY). No epoch has run. No owner GO is granted. No allowlist instance, pins, KB or certificate exists. No host read is authorized by this document.

- executionReady: false
- releaseAuthorized: false
- ownerReviewed: false

This is a design contract only. It is not an amendment GO, not a measure GO and not an allowlist. Nothing in it starts, schedules or implies an epoch. It moves no scorecard credit by itself.

Prepared by the documentation role (Sonnet 5.5) from Root rulings SB168 and SB180 (2026-11-06). Root accepts or rejects it after one Opus review. The owner does not review it at this stage; owner review happens only at a future amendment GO.

## 1. Purpose and scope

- **Rows.** The contract serves two scorecard rows only: F07-04 and P05-02, in the design stage (D). P05-02 reads F07-04 by cross-view reference.
- **Why a new contract.** The EM2 draft of 2026-10-13 is bound to a staging baseline that no longer exists. The EM2 core fixes the product target eb532ff, the rollback target 325d335, the 2026-10-09 anchor and a close path that converges staging back to eb532ff. Staging now runs API 75c7a5b with the Paper ledger fence and the M6 migration. Converging to eb532ff would be a deployment rollback across those migrations. Root ruled (SB168) that the EM2 draft is not finalized, and that the work restarts as a new epoch name, EM3. This contract does not cite the 2026-10-13 draft as the final contract.
- **Scope.** Staging only. Spot and Paper only. BINANCE:BTCUSDT Spot 1m. No production step, no Live activation, no Pine or Risk Manager change.
- **What the epoch would measure.** A fresh bounded capacity measurement on the staging host, run later and only under owner GOs that do not exist today. The local EM2 and J1 to J4 results cannot stand in for a fresh capacity measurement, and local EM3 results cannot either.
- **Order (SB180 ruling 2).** Step A is this contract, with one Opus review and Root acceptance as design only. Step B is the EM3 core build and the chain re-acceptance, a separate lane, before any epoch GO. The EM3 core sha is pinned at re-acceptance (section 3).

## 2. Baseline

All facts below are recorded staging facts from tracked documents. None is a fresh host read, and none is verified at the time of this draft.

| Item | Baseline | Source |
| --- | --- | --- |
| Product target | API on 75c7a5b (full 40-hex form 75c7a5b336ca6653c0e748cf2b88e1e0ff3b4ac5, read from Git locally) | ROADMAP status block, REPIN-2 complete 2026-11-01 |
| Trading worker | ba1a433, the no-trading-change identity pinned at m0 | ROADMAP status block |
| Set B | Accepted. M6 installed with the exact runtime grant, and the API and trading worker restarted READY | B2 result record, 2026-11-05 |
| Paper ledger fence | Installed. The API and the worker refuse to start without it | ROADMAP status block, deploy P3 entry |
| Research worker | UNKNOWN today. The last recorded state is stopped, flags 0, on its eb532ff tree. Whether the unit shows a failed state is UNKNOWN | Deploy packet and REPIN-2 packet; see N1 |
| Drop-in set (API) | The 18 pre-A2 files plus the A2 layer file, per the B0 export | ROADMAP status block; B0 a05 export (local, read-only) |
| Anchor | End of set B B2 attempt a02, 2026-11-05T18:42:31Z (accepted 18:59Z) | B2 result record |

Rule (N5): the target is the accepted staging pin at allowlist time. Any staging re-pin before the allowlist forces an EM3 baseline re-pin. A staging release of the L6 trace profile and of the OG-1 wiring would be such a re-pin (REPIN-3, under its own GOs), so every baseline constant is kept in one generated block (section 3).

Citation note: ROADMAP line numbers move as the file is edited. Cite ROADMAP by heading, or by the pinned blob d04ab76883260ea59a61c84d77d4f72424234abe of the working copy read for this draft.

## 3. Identity

The EM3 identity replaces every EM2 name so no EM2 name is reused by a core whose hash has changed. These are proposed names for the build in step B; they are not issued ids.

| Element | EM3 value |
| --- | --- |
| Release-core namespace | claude-r7b-measure-em3 (a fresh folder, built by copy-then-verify with no links; this supersedes Q8) |
| Prefix and job ids | r7b-measure-em3 |
| Tags | R7B_MEAS_EM3_* |
| Host heredoc marker | R7B_MEAS_EM3_HOST_JS |
| Pins, receipt, MR and allowlist schemas | r7b-measure-em3-pins, -receipt, -mr, -allow |
| Release, binding and dispatch schemas | r7b-em3-* |
| Window id | R7B-MEASURE-EM-3 |
| Window and sentence files | ROOT-WINDOW-CLOSED-EM-V3.json and ROOT-XS-SENTENCE-EM-V3.json |
| Binding epoch | EM3 |
| Pins and allowlist epoch | EM (kept deliberately, and documented as different from the binding epoch; Root does not align them) |
| Name salt and marked salt | New EM3 values by role, changed together in the core and in the submit template. The values are not recorded here |
| Carried salts | The O1 and bind salts are carried by value and never re-salted, because the stored record view ids were computed with them |
| Enroll layers | Names that sort after every possible two-digit drop-in name (prefix 99-zzz-), for the API and the research worker; the policy-bundle name takes a v3 suffix. The EM-1 policy bundle stays installed (Q11) |
| Amendment and GO ids | Owner items (Q2, Q3). None is issued by this document |
| EM3 core sha | Pinned at re-acceptance. Until then no EM3 hash is claimed. For history only: the accepted EM2 core hash began 6e240b31 and is void for EM3 |

Every job id is checked against the drop-in archive-suffix rule and the KB shape rule. The spent EM2 names join the forbidden-name list (row 20 below). The real adapter and the main entry stay locked in EM3 r1 (Q14).

All baseline constants (target, path roles, manifest counts, import roots, lapse blobs, anchor, layer names, forbidden names) live in one contiguous generated block. A generator outside the core file set rebuilds the block, so a later re-pin is mechanical plus a chain re-run (N5 option c).

## 4. Effect set and close path

- **Steps.** The effect set and close path are carried from the EM2 v4 design (section 6) and the r2 draft, from m0 through xs: the m0 baseline read, the pre-effect hold and full-preview steps, m1 (stop and restart under the enroll layer and policy bundle), the m2a and m2b root reads, m3, mq, m4a, m4b, the xm converge step and the xs stop. The EM2 core defines five read modes (m0, m2a, m2b, m3 and mq) and five effect modes (m1, m4a, m4b, xm and xs). By entry tool they fall into four groups: probe (m0, m2a, m2b, m3, mq), open (m1), close (m4a, m4b) and converge (xm, xs). The close path therefore has two close steps, m4a and m4b. The exact step list and effect text are re-confirmed against the EM3 core at step B, and the section 3 comparison of the EM2 design is re-run against that core.
- **Close path.** The xm effect converges to the accepted staging pin 75c7a5b and never to an older release. The close path has no rollback, restore or convergence to any release other than the accepted staging pin (section 13).
- **Rollback role dropped (row 2 ruling, option b).** EM3 has no rollback target and no old-tree role. The host import root points at the accepted pin tree. A read-only drift check of the tree that A2 replaced is optional and is a read with a STOP, never a convergence target.
- **Tree and transient roles (row 4, option a).** The API tree name comes from the A1 and A2 private records. The research tree name comes from the N1 packet. The release-only roles of the 2026-10-09 release are dropped: incoming, extract partial, cache, recovery policy file and the three transient release units. The transient-unit list read stays as a read-only stray check, because the unit block is carried (row 6, option b); it removes no gate and its pattern is not printed here. Every host-program consumer of a removed role is listed at step B, and the architecture auditor confirms that no STOP becomes a PASS.
- **Fence and M6 (N2, option a).** m0 runs the product's own read-only startup check for the Paper ledger fence from the pinned API tree, inside the existing read-only transaction, and inspects the M6 grant state. Any failure is a new STOP code with zero effects. The check repeats before each API restart (m1 before the stop, m4a, and xm step 0 before the start). The runtime role name is a host literal covered by the leak guard and is not written here.
- **Layer pre-check (row 7 and Q12, option b).** A new read-only m0 group, LAYER_PRE, reads both drop-in directories (salted keys only in output). It STOPs before any effect on any drop-in that sorts at or after an enroll name under byte order and version order, and on any leftover enroll drop-in or pending form. This moves a post-effect stop to before any effect. Whether read-mode IO allows a directory read is a build check (UNKNOWN today).
- **Worker stop on a failed unit (Q6).** Fixed in EM3 if the fix passes (Q6 ruling). The fix adds an m0 STOP when the research unit is in the failed state, accepts a failed state as a proven stop only with no main process, no job, empty control-group processes and changed ticks, and never resets the failed state or restarts.
- **Capacity.** The measurement, its job counts and its budget are fixed at the amendment GO and are not set here.

## 5. Anchor rule, layer sort rule and lapse rule

**Anchor (row 5 and Q10, option b).** The anchor is a constant, 2026-11-05T18:42:31Z, the end of set B B2 attempt a02. It is truncated to the second, which fails closed. It is stored as one tagged line in a Root-owned anchor file that replaces the read of a sibling release PLAN file. The line sha is pinned in the baseline block. The names `ROWS_SINCE_R6` and `r6FinishedMs` become `ROWS_SINCE_ANCHOR` and `anchorFinishedMs` in the core, the host program and the pins derivation. m0 still requires zero job rows since the anchor and stops with QUEUE_NOT_IDLE otherwise. Whether any job row exists since the anchor is UNKNOWN; it is decided by m0 at the epoch and is never inferred from local files.

**Layer sort rule (row 7, option b).** Enroll names sort after every possible two-digit name. The import-time LAYER_SORT check stays for the names known from the B0 export (the admission-off layer, the W7 drop-ins and the A2 layer). LAYER_PRE (section 4) covers every other name, including the research unit's drop-ins, which are UNKNOWN today.

**Lapse rule (row 8, option b).** The lapse block is re-pinned:

- `baseRelease` is 75c7a5b.
- The module list has 16 product modules. Two of them changed between eb532ff and 75c7a5b: the quant foundation recovery module and the quant foundation scheduler module. All 16 have equal blobs at 75c7a5b, ba1a433 and the repository head read for this draft. So the EM2 block would be born lapsed.
- Each module sha256 is computed from the bytes of `git show 75c7a5b:<path>`, never from CRLF working-tree files.
- `checkedEqualAt` is the revisions Root actually compares, for example ba1a433.
- The Paper ledger fence module is added, and the capital model migration module is added if EM3 uses it (N2).
- db.js and server.js are not added, because they change often and the approval would lapse on unrelated edits.
- Allowlist v2 blocks (sha prefix 78296fec) are not copied.

Under the GO text, any change to a lapse-set module ends the approval.

**Carried history blocks (row 6, option b).** The blocks that describe staging database history are carried by value and validated by equality with a Root-owned EM3 carry file, not with allowlist v2. They are the salts, bind formula, W7 crash record block (`w7c2`), `expect`, `unit`, the O1, W7 and B1 source blocks and the record view. The release source block is replaced by EM3 baseline evidence: the B2 result, the A2 result and the anchor line sha. Whether the crashed W7 record and the catalog guards are unchanged after M6 and the fence is UNKNOWN; m0 re-checks the live database against `expect` and fails closed. The `RELEASE_JOBS` and `ACT_JOBS` names stay in the own-job list, because they are archive-suffix names and dropping them could reject leftover archived drop-ins.

## 6. Certificates, controller lock and closure definitions

- **Certificates.** Three certificate kinds exist in the design: release, binding and dispatch. Each is bound to the EM3 schemas (section 3). None exists today.
- **Controller lock.** The controller is a new copy of the v4 controller with the EM3 core sha, the EM3 core file list, epoch EM3 and a new lock name. The v4 controller resolves the core by a fixed relative path to the EM2 candidate, so the copy must change that path. The Root import exception is re-issued by Root for the new closure hash. Controller v2 needs no re-pin (it is historical lineage, imported by nothing in v4).
- **Definitions (N4).** The terms below are defined in this contract; code r1 keeps shape checks only.
  - `authoritySection`: the exact LF bytes of the GO'd amendment section between fixed markers. `authoritySectionSha` is its sha256.
  - `productClosureSha`: the sha256 of the canonical record of the target, the pinned API manifest sha, the pinned worker manifest sha, the lapse modules and the readiness version sha.
  - `configClosureSha`: the sha256 of the canonical record of the enabled config, the startup readiness, the drop-in name keys and text shas read at m0, and the policy tuple. Its values are filled at the STAGE binding, later, on the host.
  - `manifestClosureSha`: the sha256 of both manifest texts plus the manifest counts.
- **Manifest counts, served list and import roots (N6).** The counts (API, worker, served, source and dependency files) are recomputed from the A1 package manifest of the 75c7a5b trees. The served list is taken from the ba1a433 served list that REPIN-2 checked as byte-equal. The import roots are fixed per the rollback ruling and N2. The values are UNKNOWN in this draft.
- **Readiness inventory.** The readiness dependency inventory is regenerated from immutable bytes of `git show 75c7a5b:<path>`, never from the working tree. 13 of its 59 source files changed between eb532ff and 75c7a5b.

## 7. Preconditions of any measure GO

None of these is met or checked today. Each must hold at the time of any future measure GO, and the GO text names them.

1. A fresh bounded health read by the single Operations worker, under its own packet. The capability and health gate is UNKNOWN today.
2. The research worker tree is staged at the target as a byte subset of the API tree, under the N1 owner-GO install packet. Without it the existing code cannot pass the manifest subset rule.
3. The owner is reachable and able to stop staging for the whole host window. An owner who is asleep means the GO is held, not issued.
4. No other heavy VPS job runs in the window.
5. The quiet slot: no active TradingView alert reaches staging; the trading worker state is read and recorded before m1; the no-trading-change sentence is checked at the slot and not assumed. After set B the staging API and trading worker run READY, so an m1 API restart interrupts a live staging Paper API.
6. The fence and M6 reads (section 4) pass at m0.
7. Browser handling: the submit step uses the owner's signed-in Chrome. Select Browser 1 (the owner session) before the m2 precheck. A 401 from another connected browser is not session expiry. The owner opens and reopens the port-forward; Root never does.
8. The budget rule (section 9) allows the whole epoch on one fresh reading.
9. The usage and scope checks of the amendment GO text are met, and no staging re-pin has happened since the allowlist pinned the target (N5).
10. Step B is accepted: the EM3 core is built, its sha is pinned, and Root has re-accepted the chain, before any epoch GO (SB180 ruling 2).
11. The Q14 unlock of the real adapter and the main entry is accepted by Root in a separate acceptance before any allowlist. Until then both stay locked.
12. The N3 D6 applicability record exists for the new closure, and the value pinned in code is taken from it (section 8).
13. The Q13 harness requirement is ruled by Root. It is OPEN today, so this item is unmet until Root rules it (section 8).
14. The allowlist is issued only after Q1 is decided (OPEN, owner), and the owner has decided items Q1 to Q5 and Q16 at the amendment GO (section 10).

## 8. Harness and D6 applicability

- **Harness (Q13).** J1 to J4 and the RC15 harness ran on eb532ff-era bytes. A re-baseline needs a new harness applicability record for the items the EM3 delta touches: the fence and M6 reads, the layer pre-check, the worker stop change, the anchor rename and the effects shapes. Root has not yet ruled the Q13 requirement (OPEN, section 10). Any harness run on the VPS needs an owner GO. Until then, the touched items are local and not host-proven.
- **D6 (N3, option b).** The EM2 core hard-codes a D6 value measured on the old closure. EM3 has no hard-coded old value. The core checks only the shape of a value taken from a D6 applicability record on the new closure. Carrying the old value is unlikely to be justified, because the database layer and the scheduler on the D6 path changed. A D6 rerun on staging needs its own owner GO and its outcome is UNKNOWN. This contract does not block on it.

## 9. Budget rule

AGENTS.md "Usage and checkpoint discipline" is binding at each reading. As of the owner rules of 2026-10-16 and 2026-11-02, with the 3 percentage point reserve:

- Above 5% remaining, admit the whole epoch only if its whole reservation fits remaining minus the 3% reserve, on one fresh reading.
- Above 3% up to 5% remaining, no epoch step, because an epoch is not a tiny task.
- At or below 3% remaining, or with unknown usage, no epoch step.
- Unknown short-window data allows no long unattended run.

Root reads usage before each wave and stops at a band change. These values are quoted with their date and are not hard-coded into any tool. Earlier text with 30% or 15% bands is stale and is not used.

## 10. Open questions Q1 to Q19 and items N1 to N6

Status words: RULED means Root ruled in SB180 (2026-11-06), which adopted the rulings brief of the L2b packet. OPEN means the item has no ruling, or needs the owner. An OPEN item records its safe default: the choice taken if nobody decides. Safe defaults are not decisions. Owner items are decided only at the amendment GO.

| Q | Item | Status | Root ruling (SB180) or open state | Safe default if undecided or declined |
| --- | --- | --- | --- | --- |
| Q1 | Allowlist approver | OPEN (owner) | Not ruled. Recommended (a): Root writes the allowlist, an independent reviewer checks it, and the owner GO names the allowlist sha | No allowlist is issued, so no epoch can start |
| Q2 | Amendment and measure GO ids | OPEN (owner) | Not ruled. Recommended: new EM3 ids, for example amendment V6 and R7B-MEASURE-V3, coded into the EM3 core | No id is valid until the owner names it; a different id means a core edit, a new hash and re-acceptance |
| Q3 | xs GO id | OPEN (owner) | Not ruled. Recommended: a new id bound to window EM-3, for example R7B-XM-STOP-ACTIVE-V3 | No xs sentence is valid; the close path stays unauthorized |
| Q4 | Read steps named | OPEN (owner, confirm) | Not ruled. Recommended: name the full list. The m2a and m2b steps are root reads in code | The amendment grants no read step that it does not name |
| Q5 | Authority for the pre-m0 health read and collision reads | OPEN (owner) | Not ruled. Recommended (a): name them in the amendment as Root-authority read packets before the STAGE binding. The Q12 check also appears in the collision packet | No pre-m0 read runs |
| Q6 | Worker stop on a failed unit | RULED | Option (b): fix narrowly (section 4). If the fix fails two test rounds, revert it and fall back to (a) | Fallback (a): disclose the residual and require a separate owner recovery GO. The owner's acceptance of any residual stays OPEN |
| Q7 | AU1-F1, effects null for abnormal host output | RULED | Option (b) only if bounded to the two documented shapes (signal-key and output-cap reports) with fixtures from the retained EM-1 raw files; otherwise option (a). Null means UNKNOWN, never zero, in both cases | Option (a), disclosed. The owner's acceptance of any residual stays OPEN |
| Q8 | Release-namespace install method (AU1-F2) | RULED (superseded) | EM3 is built directly in a fresh namespace folder by copy-then-verify with no links | Not needed |
| Q9 | GO template source and generator | RULED | Option (a): port the EM-1 generator into a Root-owned EM3 folder outside the core file set and the PLAN file, because dispatch binds the plan sha | Not needed |
| Q10 | Anchor | RULED | Option (b): new anchor 2026-11-05T18:42:31Z in a Root-owned anchor file; ROWS_SINCE_ANCHOR (section 5). m0 still decides QUEUE_NOT_IDLE | Not needed |
| Q11 | EM-1 hB and the denylist | RULED | Option (a): empty denylist. Record locally that the EM3 hB differs from the EM-1 hB and from any EM2 test hB | Not needed |
| Q12 | Enroll-layer leftovers before the first m1 effect | RULED | Implemented in code through the LAYER_PRE group at m0, and also kept in the collision packet the owner sees | Not needed |
| Q13 | Harness proof on the VPS | OPEN | Not ruled in SB180. Recommended: require it for the items the EM3 delta touches, plus a new applicability record; not the option that skips both. Any VPS run needs an owner GO | No VPS harness run; touched items are described as local and not host-proven |
| Q14 | Real adapter and main entry unlock | RULED | Both stay locked in EM3 r1. The unlock is a later, separate Root acceptance before any allowlist. Q6, Q7 and Q18 do not wait for it | Locked |
| Q15 | `marked.jobStatus` and `opStatus` values | RULED | Keep the EM-1 values and disclose the no-MR outcome of the ADRS-unclaimed path. The inventory step must confirm that the EM3 SQL counts only the foundation job table (UNKNOWN today, because the fixed-evaluation path also writes terminal states to another table) | Not needed |
| Q16 | What the owner receives for G1 | OPEN (owner) | Not ruled. Recommended (a): the full reviewed text, the one GO sentence, and a Thai summary written by Sonnet documentation | The owner gets no GO request until the text is complete |
| Q17 | Usage and time budget | RULED | The contract cites AGENTS.md "Usage and checkpoint discipline" as binding at each reading and quotes today's values with their date (section 9) | Not needed |
| Q18 | KB shape rule | RULED | Tighten only `keyRaw` to the renderer rule (8 to 128 characters of letters, digits, underscore and hyphen). Keep the existing id rule for the other four raw ids | Not needed |
| Q19 | ADRS-unclaimed close result | RULED | Settled as MARKED_JOB_STATE (decision D12-2). Fix the stale D10-2 comment and re-run the Q19 fixture on EM3 | Not needed |

New items from the L2b review (the numbering follows the rulings brief):

| N | Item | Status | Root ruling (SB180) or open state | Safe default |
| --- | --- | --- | --- | --- |
| N1 | Research worker tree and compatibility | RULED (design); owner GO OPEN | Option (a): a separate Operations install packet, under its own owner GO, stages a research tree at the target as a byte subset of the API tree, switches the stopped research unit with flags 0, and has its own rollback. It runs before the collision reads and before m0. No EM3 code change is needed. The research unit's current state is UNKNOWN | No install, no epoch. This blocks any measure GO. It does not block the D credit |
| N2 | Fence and M6 reads | RULED | Option (a): the product's own read-only startup check inside the m0 read-only transaction, repeated before each API restart (section 4). The coder verifies the M6 inspect function is read-only (UNKNOWN today) | Not needed |
| N3 | D6 constant | RULED | Option (b): pin a value from a D6 applicability record, checked for shape in code (section 8). A rerun needs an owner GO | No D6 rerun |
| N4 | `authoritySectionSha` and closure definitions | RULED | Defined as written (section 6). Code r1 keeps shape checks only | Not needed |
| N5 | Target and REPIN-3 sequencing | RULED | Option (c): build at 75c7a5b with one generated baseline block and an outside generator. The target is the accepted staging pin at allowlist time, and any re-pin before the allowlist forces an EM3 baseline re-pin | Not needed |
| N6 | Stale manifest counts, served list, import roots and import path | RULED | Recompute the counts from the A1 package manifest of the 75c7a5b trees. Take the served list from the ba1a433 list that REPIN-2 checked as byte-equal. Fix the import roots per the rollback ruling and N2. The values are UNKNOWN in this draft | Not needed |

Other Root rulings that shape the EM3 core (SB180): no host fact is assumed; every host fact stays UNKNOWN until an Operations read under a GO. The remaining stale-item rows of the L2b packet follow the packet's EM3 replacements: the product target and the xm effect text (rows 1 and 3), the epoch, window and schema names (rows 9 to 13, section 3), the readiness inventory regeneration (row 14), the product ranges (row 15, comments only, because the three product files have equal blobs at both revisions), the D6 value (row 17), the no-trading-change sentence (row 18), the D10-2 comment (row 19) and the forbidden-name list (row 20: keep the 79c22b2 names and add the spent EM2 names).

## 11. Disclosed residuals

These stay disclosed in this contract. None is accepted by the owner yet.

- **KB shape rule.** The EM2 rule is inconsistent between the pins check and the renderer. EM3 tightens only `keyRaw` (Q18). Rows outside `keyRaw` keep the looser id rule.
- **AU1-F1.** Effects can be null for abnormal host output. Null means UNKNOWN, never zero, and the held lock stays (Q7).
- **Worker stop on a failed unit.** Fixed if the Q6 fix passes; otherwise a residual with a separate owner recovery GO.
- **Leak guard.** The leak guard covers the listed literals. The auditor checks the new EM3 literals, including the runtime role name.
- **Unobserved m2b-to-m3 gap.** The interval between those steps was not observed in EM2 and stays a disclosed gap.
- **ADRS-unclaimed path.** The path ends with no MR, so check A6 fails by design (Q15, Q19).
- **Stale review labels.** The 2026-10-13 independent review is labelled "Fable-labelled, model identity unverified". Fable is paused (owner, 2026-10-23), so the review for this contract uses an Opus auditor, and the substitution is recorded. Root confirms each earlier finding, including M4, M5 and L1 to L8 from the EM2 r2 draft, or records it as unconfirmed.
- **Cost.** The effort and elapsed time of the step B chain re-acceptance are UNKNOWN.

## 12. GO sentences

The three sentences below are structural templates only. They are TEMPLATE - NOT A GO. They carry no authority, name no id that the owner has issued, and hold blank fill fields. The final wording is carried from the reviewed EM2 draft section 14, adapted to EM3, and is reviewed before it is shown to the owner. Nothing here may be copied into chat as an owner GO.

**TEMPLATE - NOT A GO: amendment GO.** "I approve amendment `<amendment id>` for window `R7B-MEASURE-EM-3`, with allowlist sha256 `<fill at allowlist time>`, valid until `<notAfter fill>`, for the read steps `<named list>`. It ends if any lapse-set module changes."

**TEMPLATE - NOT A GO: measure GO.** "`<measure GO id>`: run the EM3 measurement once, against the staging pin `<pin fill>`, with the owner reachable until the window closes."

**TEMPLATE - NOT A GO: xs GO.** "`<xs GO id>`: stop the active measurement and converge to the accepted staging pin."

## 13. Not authorized

This document does not authorize any of the following, and no later text implies it:

- an epoch, in whole or in part, or any scheduling of one;
- a host read, an SSH session or any Operations packet;
- the research worker tree install (N1) or any unit change;
- an allowlist instance, an allowlist approver or any read scope;
- pins, a KB, a release, binding or dispatch certificate;
- a staging change of any kind, including a re-pin, a restart, a migration or a config change;
- a D6 rerun, a VPS harness run or any heavy VPS job;
- convergence, rollback or restore of staging to any release other than the accepted staging pin;
- unlocking the real adapter or the main entry;
- any change to Pine, the Risk Manager, Paper behavior, Live activation or the production product.

It also moves no credit. After Root accepts this contract as design only, a successor scorecard (not this document) may consider the D stage for F07-04 and P05-02. Its wording would be: Root accepted the re-baselined fresh-epoch design contract as design only; the amendment GO, allowlist and every host value stay open; no epoch run or authorized. The I, V and T stages stay 0. The EM3 core re-pin and chain re-acceptance are local, synthetic and test-only, and they are not a fresh qualifying measurement.

## 14. Sources and pins

Tracked sources: the ROADMAP status block (blob d04ab76883260ea59a61c84d77d4f72424234abe, read at drafting); the set B B2 result record of 2026-11-05; the staging prototype deploy packet of 2026-10-24; the REPIN-2 packet of 2026-10-30; the EM2 measurement readiness document of 2026-10-13; AGENTS.md "Usage and checkpoint discipline".

Root-private sources (not tracked; described by role, no locations): the Root rulings SB168 and SB180; the L2b packet and its checker report; the L2b rulings brief; the L2 review of the EM2 draft; and the EM2 candidate core, controller, open-questions draft and decision records held in the Root evidence store.

Pin rules for the review and for step B:

- Root snapshots immutable copies of every private source before pinning any hash, and pins the snapshot copies. Working copies drift, so a pin to a working copy is not a pin.
- Run a clock read (`date -u`) before every stamp. Do not estimate times.
- Cite ROADMAP by heading or by pinned blob. Line numbers move.
- Hash product module bytes from `git show <revision>:<path>`, not from working-tree files.
- No EM2 file is edited. EM2 records stay immutable history. Each EM3 acceptance record is a new file named for EM3.

Drafting clock read: 2026-11-06T15:16Z.
