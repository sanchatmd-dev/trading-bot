# S6 staging set B, B0 attempt a01: first read stopped by a tool defect, a01 used and not a reference

Packet: [the set B packet r7](S6_STAGING_SETB_PACKET_R7_2026-11-03.md), job B0 (read-only preflight and reference record). Environment: Staging QL-P2 Prototype. Recorded by the Claude root for a job run on 4 November 2026 (UTC). This is a stop record. Nothing was accepted.

## What ran

- **Authority.** The owner's GO-B0 of 2026-11-03 (one attempt, not valid after 2026-11-04T12:00Z). Root used it for attempt a01 only.
- **Job.** `s6-setb-b0-a01-5733e8f78f` (manifest `8154186f`, runner receipt `ed7284e6`). The operations worker started the runner once and made no retry.
- **Host time.** 2026-11-04T06:03:42Z to 06:03:44Z, about two seconds.
- **Mode.** First read: no reviewed reference existed, so B0 was to record one.

## End

The job ended with code `B0_STOP_TREE` (verdict `B0_STOPPED`) at item 11, after items 1 to 10 had completed. B0 stops when it cannot show that the staged API tree is exactly as expected, and it stops closed. The stop is a safe stop, not a damage report.

## Cause

A defect in a sealed tool, found by Root from the code. The job builds its dependencies for the tree check without the job's user id, so the check read every file as owned by another user and could never pass on a real host. The test worlds and the earlier rehearsals passed their own user id, so none of them caught it. An Opus scoping audit read all eight sealed tools and found the defect only in B0. It found no open guard on the host and no other tool affected. The earlier suspicion of a fail-open guard was refuted.

## Host state after

- The staging API stayed running.
- The overlay that B0 creates was removed by the stop path.
- One record folder, its record file, the item 10 export file and the a01 consumed marker stay on the host, as expected when B0 ends after its record opens. Nothing to undo. No guard was reset.

## Why a01 is not a reference

A first read counts as a reference only when it completes with the drift code and a finished first-read record. a01 stopped earlier, so it is used and cannot serve as the reference for a compare attempt. The GO-B0 record is back to PENDING_READY with a01 marked used. No GO is open.

## Fixes (local only, nothing deployed)

- **B0 round r3h:** sealed; B0-local user id taken from the same source the other host reads use, with tests for the host-shaped dependencies. Sealed is not accepted for host use.
- **Prep tool r3c, r3d and r3e:** accepted in turn for Root use; r3e is current and supersedes the earlier two. It enforces the attempt policy (which attempt is a first read, which is a compare).
- **Rehearsal harness:** core round r3k and jobs round r5e are sealed on dependencies shaped like the host's. All six chains passed on throwaway local clusters (after earlier attempts were stopped by the free-memory precheck), including a negative step where a wrong user id stops B0 at the tree check. This is functional evidence only.

## Still needed (owner decisions)

- **Gap G-B0-EXP.** No sealed tool brings the private B0 record files back from the host. Design option B is adopted: a read-only fetch job, B0F. B0F round r3 is the seal candidate (tester PASS, Opus audit ready to seal once the errata hash is set). It is not sealed.
- **Errata E-FR4:** a02 as the second first read, a03 as the compare, a04 as a spare.
- **Errata E-FR5:** the B0F job, its GO, its limits (including an output cap above the packet maximum) and questions Q1 to Q6.
- **Read-only tree owner check** on the staged API tree before the next B0 run.

## Scope

Spot/Paper only. No Live, no guard reset, no Best Inputs apply, no optimizer. Nothing is deployed.
