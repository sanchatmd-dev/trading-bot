# S6 staging set B packet r7: erratum E-FR4 (second first read, attempts a02 and a03)

Document ID: **S6-STAGING-SETB-1-R7-ERRATA-FR4**. Date: 2026-11-04. Status: **APPROVED by the owner on 2026-11-04 (about 14:53Z UTC)**, with a spare attempt a04 (Root rulings SB121 and SB122). Author: documentation role (Sonnet 5.5 / low), child of "Root: astra-vps-trade-bot-v2".

## 0. What this document is

1. This erratum amends the errata file `docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR_2026-11-04.md` (E-FR1 to E-FR3) for the first-read path of set B job B0. It does not change the packet r7 file or the E-FR file. Where this document and E-FR1 items 1 and 2 differ, this document governs after the owner approves it. Everywhere else the packet r7 and E-FR1 to E-FR3 stand unchanged.
2. Nothing in this document is a GO. It issues no approval, starts no job and changes no gate. A GO for set B job B0 is a separate owner record and covers only what it names.
3. Basis: Root rulings SB107, SB108 and SB109 (`root-ruling-sb1.md`), kept in the local evidence folders, not in tracked files.

| Item | Short name | Ruling | Text amended |
| --- | --- | --- | --- |
| E-FR4 | Second first read; attempt policy; B0 round r3h | SB107, SB108 item 3, SB109 items 1 to 4 | E-FR1 items 1 and 2; E-FR2 (attempt ids) |

## 1. Reason

1. Attempt a01 of set B job B0 (2026-11-04, 06:03Z) ended `B0_STOP_TREE` at item 11. Cause: a tool defect. The job read file owners with a placeholder user id, so every file in the tree looked foreign-owned and item 11 could never pass on a real host.
2. The stop came after items 9 and 10 and before the anchor items. The end is not `B0_STOP_DRIFT` with `FIRST_READ` completed, so by the E-FR1 item 6 completeness rule a01 is not a reference. No reference exists.
3. The host was left clean. The API kept running, the stop path removed the overlay, and nothing needs to be undone. No guard was reset. Attempt a01 is used (consumed marker written).
4. Audit result (SB108): the same placeholder id did not open any guard on the host. The defect is fail-closed and is limited to B0.

## 2. The fix

1. B0 round r3h is sealed (seal file `seal-b0-r3h.json`, toolSourceSha e02fdf13). It supersedes the r3g seal for every later B0 attempt. Sealed is not accepted for host use and is not a GO.
2. The user id now comes from the job process, with a range check. The tree check and the linger check use it.
3. The B0 tool no longer guards which attempt may be a first read. That policy moves to the prep tool and the owner GO record (section 4).

## 3. Change to E-FR1 items 1 and 2

1. E-FR1 item 2 allowed a first read only for attempt a01 and only once per packet revision. This erratum allows the first read once more, on attempt a02, because a01 was used without producing a reference.
2. Attempt a03 is the compare attempt. It is bound from the Root-reviewed a02 export exactly as E-FR2 describes for a02, with a02 and a03 in place of a01 and a02: the review points of E-FR2 apply to the a02 export, and the binding steps (`ref`, `dropIns`, `firstRead` false, the working-directory rule) apply to a03.
3. The B0 object key `firstRead` still requires null `ref` and null `dropIns` when true. The tool accepts it on any valid attempt id. The attempt id rule is the policy in section 4.
4. E-FR1 items 3 to 9 and E-FR2 and E-FR3 stand, with a02 and a03 read as the first-read and compare attempts.

## 4. Attempt policy (ruling SB109 item 3)

The prep tool enforces these rules, and the B0 tool does not:

1. A first read is allowed only when the owner GO record names that attempt as FIRST_READ.
2. No listed earlier attempt may be a complete reference (end `B0_STOP_DRIFT`, mode `FIRST_READ`, first read completed, no anchor drift).
3. No listed earlier attempt may have run with `firstRead` false.
4. Every listed earlier attempt must have a readable receipt.
5. A compare attempt needs the GO record mode COMPARE, with the id of its reference attempt. The reference export must come from that attempt.
6. The attempt id must be the next id after the highest earlier attempt id (a01 only when there is none; never a00). The list of earlier attempts names every earlier attempt, and the prep tool refuses a run when it sees a consumed attempt that the list leaves out.
7. Replacing an accepted reference needs an explicit owner ruling.

## 5. Check before the next run

Before any new GO window, the read-only tree owner check runs on the staging host (ruling SB108 item 5, audit finding P2-2): the owner runs it, or Root runs it through the owner's web console with the owner's permission. It prints counts only: entries in the staged tree not owned by the service user, other-writable entries, entries that are neither a regular file nor a directory, and unreadable entries. Root records the counts. Any count above zero stops the path for an owner question, because item 11 would stop on it. Then Root runs the prep tool (round r3c) check, prep and dry admission.

## 6. Residual risk

Items 12 to 16 of the B0 job have never run on a host. Attempt a02 may stop there for a reason that has nothing to do with the first-read rule (a host-only stop). Such a stop spends that attempt. If a02 stops that way, there is no spare attempt under the plan above, and a03 cannot be the compare attempt. The owner may want a spare attempt a04 (decision O8).

## 7. Owner decisions needed

| Question | Options | Owner decision |
| --- | --- | --- |
| O7 Approve E-FR4 | Approve or change this erratum | Approved 2026-11-04 |
| O8 GO-B0 attempts | a02 FIRST_READ and a03 COMPARE; and whether a spare a04 is allowed, and in which mode | Approved 2026-11-04: a02 FIRST_READ, a03 COMPARE against the reviewed a02 export, spare a04 COMPARE against the same export (used only if a03 fails for a transport or host-only reason) |

## 8. What this document does not approve

1. No GO by itself: it does not open the GO-B0 record and starts no run.
2. GO-B1, GO-B2, RS, RB, RBX, RBC and AR-B are excluded and need their own records.
3. The Spot/Paper-only scope, the packet r7 gates and the immutable-evidence and holdout rules are unchanged.
