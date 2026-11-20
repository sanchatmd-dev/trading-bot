# Claude to Codex: project and latest-work handoff

Date: 2026-11-20 (UTC; evening in Asia/Bangkok). Repository: `sanchatmd-dev/trading-bot`.

## Authority and transfer state

At about 10:28Z the owner asked the Claude root to hand the whole project and the latest work to Codex. The Claude root stops dispatch with this handoff. Its last workflow updated the four status documents for this commit. No tool chain, mutant run, rehearsal, PostgreSQL cluster or host run is active, and no GO is open or pending. Codex becomes the sole root only after it verifies this handoff, the Git state, file ownership, runtime and its own usage. Claude must not resume as root at the same time.

This is a local file handoff. No direct Codex session transport was available, so delivery and Codex acceptance are not claimed. The ignored entry point is `.qa-local/codex-handoff-2026-11-20/checkpoint.md` in the active worktree. It holds the locations, the evidence inventory with hashes (`manifest.json` beside it) and the exact continuation steps. The REPIN-3 tools, seals, fills, attempt folders and rulings are ignored local evidence. A fresh cloud clone cannot continue the REPIN-3 line; a cloud root can read this document and the tracked records only.

One Claude helper may still run after this handoff, only at the owner's choice: the owner's staging keep-alive. It is a 10-minute check that the staging web login in the owner's browser stays valid, plus a local loop that requests the forwarded staging health URL every 30 seconds so the owner's port forward stays open. It reads only. It changes no file in the checkout and nothing on the host, and it never enters credentials. It ends with the Claude session or when the owner says so. It is not root work.

Authority carried: every host effect needs its own owner GO, with the owner awake and reachable for the run and the lost-receipt wait. The owner pastes the GO line, and the root checks that it is byte-equal to the requested line before running. The owner's earlier Claude-only permissions (max agent cap, usage down to the 3% floor, overnight local work) bind the Claude root only. Codex uses its own column of AGENTS.md and its own usage reading.

## Read order and authoritative sources

1. `AGENTS.md` (Codex column), `.agents/skills/caveman/SKILL.md`, `docs/AGENT_TEAM.md` and `.agents/TASK_PACKET_TEMPLATE.md`.
2. The ignored entry point `.qa-local/codex-handoff-2026-11-20/checkpoint.md`. Then the top notes of `README.md`, `Context.md`, `docs/ROADMAP.md` and `docs/TIME_MANAGEMENT.md`, which this commit brings up to date through ruling SB556. Roadmap owns the next action.
3. For the whole-project table and earlier context: [the 2026-10-23 handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-23.md), then the Codex-to-Claude handoff of 2026-10-24 and the Roadmap notes since.
4. For the latest work, all ignored local files: the rulings SB489 to SB556 in `.qa-local/s6-setb-p5b-design-2026-10-30/root-ruling-sb1.md` (CRLF; append only); the design `.qa-local/s6-setc-design-2026-11-07/r13-rw/design-r13f-r1.md`, section 7 (fix options) and section 9 (owner questions); and the last sections of `.qa-local/claude-root-2026-10-24/RESUME-2026-10-31T0206Z.md`.

## Git and ownership

- Active worktree branch: `codex/fe2b-ci-local-fix`. Push only with `git push origin HEAD:refs/heads/codex/app3a-market-wait-checkpoint-gwylmk`. Pushing by branch name pushes a stale local branch and is rejected. Base before this commit: `6874173` = origin `-gwylmk`. Never use `main`; no force push, no reset, no `git add -A`.
- The original checkout stays read-only. Its nine dirty paths are unchanged (`docs/ROADMAP.md`, `docs/TIME_MANAGEMENT.md`, `src/postgres/mp-package-store.js`, `test/postgres/mp-package-build.test.mjs` and five untracked test or helper files), and its local `-gwylmk` branch is at `85f5331`.
- Both protected stashes are intact: `ae7db28e0494ea502f37b4da806518518bcdef9d` (owner-protected files; never drop or apply) and `7a5f3f4c370cb424ed019d966060c242ba14e6ad` (old RS-5 WIP; never apply).
- After this commit the worktree has no tracked change. No product source, test, fixture or migration changed in the Claude period since `6874173`; all of the work is local tools, records and host runs.

## Whole-project position

The project is a Spot/Paper trading and research system. It is not an accepted production launch. The newest frozen and Root-accepted scorecard is still PM-1 S6 (2026-11-12, source commit `5f05ade`: project 70.28 to 75.75 percent, prototype 76.08 to 81.08 percent); no new percentage may be inferred from this period. The minimal prototype journey, launch and Live stay not accepted. Production is untouched.

Staging, as last read on 2026-11-18 to 2026-11-20: the API and the trading worker run the REPIN-3 pin `ab1c1f1`. Set C is complete (2026-11-15). The QR-2 flag is effective 1, and the QR-3 and the five research flags are 0. The research worker is stopped: it is inactive on its old configuration after the RW a01 rollback. The market stream runs. The four protected units read active and running at the RWR a01, RD a02 and RC a01 gates.

## Latest work: REPIN-3 RW (H3) and the io finding

The Roadmap top note has the full sequence with ruling numbers. In short:

- Tool rounds r13b to r13d were built, chained and sealed (SB499 to SB534). r13c fitted RW's claim bar (210000 ms) to the staging claim window of 225000 ms that a read-only capacity read found (SB515 to SB518). r13d re-scoped RW J1 and J2 after a false-pass risk (SB521, SB522).
- On 2026-11-18, GO-AR3 a10 and GO-RWP p03 passed. GO-RW-D1 (RW a01) then stopped after effect at READY (RW_STOPPED_AFTER_EFFECT, EFF_READY; SB539). GO-RWR a01 rolled the RW effects back (RWR_PASSED; SB540). The research unit was inactive before RW a01 (SB541 erratum). Request set a01 is spent. The J1 row stays CANCELLED, as the GO line said.
- Round r13e added the read-only diagnosis lane RD (sealed, tool `cd982b4c`; SB541 to SB546). GO-RD a02 passed on 2026-11-19 (RD_PASSED; SB548). The research worker refused at startup with `QUANT_IO_TELEMETRY_UNAVAILABLE` (phase limits, cause filesystem_read, ENOENT), because the `io.max` file of its own cgroup does not exist. It exited with status 1 after 704 ms. PROFILE V2 needs reviewed I/O controls at the pin, so dropping them is not an option.
- Round r13f added the read-only cgroup lane RC (sealed, tool `8f0b66e7`; SB549 to SB555). GO-RC a01 passed on 2026-11-20 at 03:11Z (RC_PASSED; SB556) with the answer IO_NOT_DELEGATED_TO_USER_SLICE:

| Level | cgroup.controllers | cgroup.subtree_control | io files |
| --- | --- | --- | --- |
| cgroup v2 root | cpuset cpu io memory hugetlb pids rdma misc | cpu io memory pids | not read |
| user.slice | cpu io memory pids | cpu memory pids | present |
| deploy user's slice | cpu memory pids | cpu memory pids | none |
| user manager | cpu memory pids | cpu memory pids | none |
| units' slice (research and protected units) | cpu memory pids | cpu memory pids | none |

The system manager's view of the user manager unit gives Delegate yes with DelegateControllers cpu memory pids. systemd is 255 in both managers. The host is a KVM virtual machine (O-A answered). RD and RC changed nothing on staging.

Sealed tool snapshots (ignored, under `.qa-local/`): r13d `670c7705` (the RW, RWP, RWR and AR3 lane fills point at it), r13e `cd982b4c` (RD), r13f `8f0b66e7` (RC). r13f was built from r13e, and r13e from r13d. Every other lane is byte-identical in behaviour, but non-RC lanes need fills re-pointed to a newer snapshot before they use it.

## Next action (owner-gated)

1. Owner decision O1: who applies the root step on staging, the owner by hand or a separately designed and reviewed GO if the deploy user has sudo. Open since SB556. O2, a maintenance window, matters only if F1b is needed. O-B, O3, O4 and O5 (design-r13f-r1 section 9) were relayed with GO-RC and have no recorded answer.
2. The fix packet F1 (design-r13f-r1 section 7.2 and SB556 item 2). Staging only, outside every REPIN tool, under its own owner GO. Steps:
   - Read-only pre-check: no pending system unit-file reload, and the current DropInPaths and Delegate of the deploy user's `user@<uid>.service` recorded.
   - Add a drop-in for that uid only, with an empty `Delegate=` line and then `Delegate=cpu memory pids io`.
   - A system `daemon-reload`.
   - A read-only GO-RC a02, filled from RC a01 as its source.
   - If io still stops above the user manager, the runtime `IOAccounting=yes` on that unit, then a deploy-user `systemctl --user daemon-reexec`, with an RC re-run after each step.
   - Last, F1b: a user-manager restart in an agreed window. It stops and starts every user unit, the protected API, trading and market units included.
   Roll back by removing only the added drop-in (and the runtime IOAccounting change, if made) plus a `daemon-reload`; use `systemctl revert` only if DropInPaths was empty before (SB550). A full removal of io below the user manager can need an F1b window (EBUSY).
3. No RW attempt before RC shows io available to the research slice. A new RW attempt then needs:
   - A new request set (a01 is spent).
   - Fills re-pointed and reviewed.
   - Fresh GO-AR3 and GO-RWP reads inside their windows, then GO-RW-D1 and GO-RWR, with the owner awake for about 2 to 2.5 hours.
   The SB522 J1/J2 evidence is still open. Even with `io.max` present, RW can still refuse with `limits_mismatch` if the device differs (residual R7).

## Open items carried

- Mutant harness: a run that prints no test summary is recorded as SURVIVED. It should be recorded as ERROR with the spawn status, signal and timeout flag, and fail the chain (r13f erratum item 3). Chain scripts should take the mutant bar from the apply-check count.
- The GH-C2 TEMP revoke tool track (TR) is not ready: the chain draft is NOT_READY and there is a TR-4 harness gap, M1 to M8 (SB503). QR-3 stays off. The OPS1-E8 deeper readback pages wait (SB494).
- Staging web login: the owner signs in; it lasts about 24 hours (next expiry about 2026-11-20T18:08Z). Never enter credentials.

## Runtime, usage and gates

- At handoff (10:35Z): Windows, local Node 24.19.0 (host Node 24.21.0), free disk about 73 GB, no PostgreSQL process. Re-read before any admission.
- `.qa-local` must stay under the sealed admission scan cap of 100000 entries (Root kept it under about 90000 by archiving build folders outside the worktree; the checkpoint names the archive).
- Chains need a quiet machine and take about 3.5 to 4 hours each.
- Claude usage at the last reading: weekly 15% used. Codex usage is separate and unknown to Claude; read it before dispatch and keep the 3% reserve.
- Gates unchanged:
  - Spot/Paper only; `BINANCE:BTCUSDT` Spot 1m; reduce-only EXIT; immutable research evidence and independent holdout gates.
  - No Live, guard reset, Best Inputs apply or optimizer loop.
  - No deployment, migration or host change without its own packet and owner GO.

## Incoming root checklist

1. Confirm the Claude root is stopped and no other root commands this checkout. Open the ignored entry point. Verify the worktree, branch, HEAD and remote, both stashes and the original checkout's nine dirty paths.
2. Verify `manifest.json` (every hash), the three sealed snapshots (`sha256sum -c` of SHA256SUMS and SHA256SUMS.root), resource state and Codex usage. Record the actual Codex model and effort, or UNKNOWN.
3. Ask the owner O1 if it is still open. Then design the F1 fix packet with its own review and GO, or the owner's by-hand steps with exact reviewed commands.
4. Before any dispatch, write the packet: exact paths, acceptance evidence, stop condition, usage reservation and one writer per file. Root keeps acceptance, Git integration and GO decisions.

This handoff is documentation and checkpoint work only. It claims no new product test, runtime acceptance, deployment or progress percentage. The project and the prototype remain incomplete.
