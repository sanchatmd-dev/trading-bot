# Claude to Codex: project and latest-work handoff

Date: 2026-10-23, Asia/Bangkok. Repository: `sanchatmd-dev/trading-bot`.

## Authority and transfer state

The owner asked the Claude root to stop, save a checkpoint and hand the whole project and the latest work to Codex as root. The Claude root has stopped dispatch. Its last workflow (the P13h-r4b fix and its verification) finished before this handoff; no child agent, test run, PostgreSQL cluster or runtime job is active. Codex becomes the sole root only after it verifies this handoff, the current Git state, file ownership, runtime and its own account usage. Claude must not resume concurrently.

This is a local file handoff. No direct Codex session transport was available to the outgoing root, so delivery and Codex acceptance are not claimed. The local entry point is `.qa-local/codex-handoff-2026-10-23/checkpoint.md` in the active worktree. It holds the checkout locations, the ignored-evidence inventory and the exact continuation steps. The C3 evidence is ignored local data and is not available from a fresh cloud clone; a cloud root can read this document and the tracked records, but it cannot continue the C3 line without the local worktree.

Standing authority carried from the owner's takeover instruction: continuous bounded local Roadmap work within the existing GO, focused tests, independent review by risk, evidence and checkpoint updates, and periodic commit and push to the permitted branch, with exact-revision CI checked step by step. The stop request binds the outgoing root only. It waives no gate for the incoming root.

## Read order and authoritative sources

1. `AGENTS.md` (use the Codex column), `.agents/skills/caveman/SKILL.md`, `docs/AGENT_TEAM.md` and `.agents/TASK_PACKET_TEMPLATE.md`.
2. The ignored entry point `.qa-local/codex-handoff-2026-10-23/checkpoint.md`, then the top notes of `README.md`, `Context.md`, `docs/ROADMAP.md` and `docs/TIME_MANAGEMENT.md`. Roadmap owns the next action.
3. [The earlier Codex-to-Claude handoff](CODEX_TO_CLAUDE_HANDOFF_2026-10-23.md) for the whole-project table, the accepted QR-2 CI history and the Stage 2C context. Its whole-project position is unchanged except for the C3 line below.
4. For the latest work: `docs/QR2_S5_4_STAGE2C_COMBINED_MEASUREMENT_PACKET_2026-10-23.md` (sections P13g to the P13h revision) and `docs/evidence/PM1_QR2_S5_4_STAGE2C_LOCAL_2026-10-23.json` (`combinedMeasurement.preparation`).
5. The ignored folder `.qa-local/qr2-s5-4-stage2c-diagnostic-runtime/`: contract, models, tests, reviews, mutation reports, snapshots and root acceptance records.

## Git and ownership

- Active worktree branch: `codex/fe2b-ci-local-fix`. Push only to `origin/codex/app3a-market-wait-checkpoint-gwylmk`. Do not use `main`, merge WIP `a877733` whole, reset, drop or apply the stashes, or overwrite unrelated work. No force push and no `git add -A`.
- Claude-period commits, all pushed to the permitted branch: `0c97828` (Codex handoff intake and team restoration), `19200ec` (P13g), `ff7a2c3` (P13h), `5335107` (P13i), and the commit that adds this document. The checkpoint records the final pushed revision and its CI.
- The original checkout stays read-only with nine dirty paths: `docs/ROADMAP.md`, `docs/TIME_MANAGEMENT.md`, `src/postgres/mp-package-store.js`, `test/postgres/mp-package-build.test.mjs`, and five untracked test or helper files. Both protected stashes are intact: `ae7db28e0494ea502f37b4da806518518bcdef9d` (three owner-protected files; never drop or apply) and `7a5f3f4c370cb424ed019d966060c242ba14e6ad` (old RS-5 WIP; never apply).
- After the handoff commit the worktree has no tracked change. Everything else of value is ignored local evidence under `.qa-local/`.

## Whole-project position

The project is a Spot/Paper trading and research system, not an accepted production launch. Every row of the whole-project table in the earlier handoff stands. The latest accepted score is still PM-1 S2 at `ca6abb1` (whole project 64-73%, prototype 73-80%, UNKNOWN weights 41.57% and 41.67%); these are historical engineering bounds, not current percentages, and no new percentage may be inferred from test counts or agent activity. The minimal prototype journey, launch and Live remain not accepted.

During the Claude period only the C3 diagnostic-preparation line moved: design documents and pure JavaScript models under `.qa-local/`. No product source, tracked test, fixture, migration, deployment, host or runtime changed.

## Latest work: QR-2 S5-4 Stage 2C, C3 diagnostic preparation

### Accepted during the Claude period

- **P13g, Windows launch contract, design level.** Revision r4 plus root errata E1 to E9 closes the P13f design gap after four rounds of independent Opus review (Fable paused by the owner). A native guardian starts first and owns separate SUPERVISOR, WORKLOAD, PG, PROVISION, INVENTORY and STOP jobs; INVENTORY and STOP form a surviving fixed cleanup path; deadlines are relative requests on the guardian's monotonic clock; ceilings are 300/310/360/420 s from one origin.
- **P13h, pure guardian model**, accepted at round 2 (`guardian-state.mjs` `2b05bb62...`, 182/182 root-run tests).
- **P13i, pure supervisor adapter model**, accepted (`supervisor-adapter.mjs` `7181a54e...`, 126/126 root-run tests; a 300-seed composition test with the supervisor reducer and the guardian model).

All three are pure-model or design evidence. None is runtime, native, process or PostgreSQL evidence, and none authorizes them.

### P13h revision rounds r3 to r4b

These rounds revise the accepted guardian model to close the P13i findings and the defects that review then exposed:

- **r3:** F1, the tick interval is capped at 1000 ms (`PARAM_TICK_RANGE`); F3, an INITDB, PROVISION or STOP exit seen before its resume record is honoured at the record, fail-closed; the property world now reaches CLEAN in permuted runs often enough to assert a threshold.
- **r3b:** the adapter tests were revised for the cap and for F3. No adapter coverage threshold was lowered, and the old cliff-based EXPIRED checks were replaced by a transport-delay EXPIRED test with a control.
- **r4:** M16, a safety defect. A postmaster exit observed before its resume record was ignored, so a later readiness report could carry setup to POSTGRES_READY (contract A1.5.2). Now any postmaster exit observed before POSTGRES_READY fails START_POSTGRES as POSTMASTER_EXITED. M17b: once EXIT has been sent, no workload-start or workload-failure frame follows, and a workload start failure after cleanup has started prevents VERIFIED.
- **r4b:** B1 from the r4 audit. When the postmaster exit arrives during a PROVISION wait, the guardian now abandons that wait and terminates the PROVISION job (contract A2.2). The readiness wait keeps its E2 and R4-3 behaviour.

Status at handoff: **accepted by the Claude root as a pure model only.**
- Root run on Node 24.19.0: guardian 234/234 and adapter 127/127, with 0 failed and 0 skipped.
- The last mutation run passed: 18 mutants, 17 killed, one equivalent. The independent Opus audit returned GO.
- The accepted model is `guardian-state.mjs` `9f5ef30b...`. The immutable copies are in `p13h-r4b-accepted/`, and the root acceptance record is `guardian-state-acceptance-p13h-r4b.md`.
- It supersedes the round-2 acceptance. The P13i adapter (`7181a54e...`) and the supervisor reducer are unchanged, and the adapter suite passes against the new model.
- Every writer packet in these rounds ran read-only commands outside its brief's command list. None changed audited content, and each packet's output was verified independently.

### Evidence-pin drift

The revision rounds edited working copies that the evidence record had pinned. Seven working-copy pins no longer match: `guardian-state.mjs`, `guardian-state-test.mjs`, `guardian-state-test.json`, `guardian-state-author.md`, `supervisor-adapter-test.mjs`, `supervisor-adapter-test.json` and `supervisor-adapter-author.md`. The evidence record now lists them under `supersededWorkingCopyPins` instead of `artifactPins`. The accepted model and test bytes remain verifiable through the pinned snapshot folders `p13h-snapshot-r2/` and `p13i-snapshot-r2/`. The accepted author records and test-result JSON files were not preserved separately; the root acceptance records, which are unchanged and still verify, state the accepted counts. Rule for future revisions: write new per-round files or snapshot every pinned file before editing it.

### Obligations carried to the source packet

- maxInbound at least 8200; the brokered channel buffers the delivery frame (about 2 KB) before the workload exists without blocking the supervisor; the runtime shell schedules a CLOCK event at min(R_s, next reducer deadline).
- Connection slots: lazy pools can reach 20 connections against max_connections 16. Any value above 16 needs a tracked change to functional packet line 24 and a root ruling (E9); until then a shortfall fails closed.
- The job-list attribute must be qualified before runtime, with no fallback. Write-through durability needs a durable journal size and valid data length (E8). The A5.2 implementation obligations stay open.
- r4 audit notes, none blocking: at the postmaster resume record the PG job is left to A1.2; a run that ends normally before the workload resume wait expires can still be VERIFIED without a workload resume record (r3 behaviour); no adapter test reaches the "WORKLOAD_STARTED never sent" path; a failed postmaster resume after an exit reports POSTMASTER_RESUME_FAILED.

### P13j native-slice proposal: held by the owner

Round 1 of the proposal and its review exist (gaps B1 to B7, notes N1 to N16). A safety classifier stopped the round-2 designer while it was reading; nothing was written. On 2026-10-23 the owner chose to hold P13j. The C3 line continues with pure-model and documentation work only. Do not restart, reword, split or reroute P13j, under any platform, without new explicit owner direction. The owner's hold applies on every platform, so moving P13j to another platform is not a way around the stop. The earlier N1 terminal-evidence hold also stands.

## Runtime, usage and gates

- Handoff observation: Windows, Node 24.19.0; free memory 1289 MB (about 1.26 GiB) at 09:01Z (above the unchanged 1 GiB admission floor; readings varied during the day and admission needs a fresh one); free disk about 16.5 GB; zero PostgreSQL processes. No runtime, native compilation, process fixture or PostgreSQL ran in the Claude period.
- Claude usage at the last reading: 5-hour window 10% used, weekly 19% used; the Fable bucket is irrelevant to Codex. Codex usage is separate and unknown to Claude; read it before dispatch and keep the 3% reserve.
- Gates unchanged: Spot/Paper only; `BINANCE:BTCUSDT` Spot 1m; reduce-only EXIT; immutable research evidence and independent holdout gates; private source local only (SHA-256 only); private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, shared or target migration, host or VPS work, Live, guard reset, Best Inputs apply, backfill or private-source upload is authorized. Native compilation, process fixtures, PostgreSQL and the C3 runtime stay closed until their own packet and admission pass.

## Notes for the Codex team

- Use the Codex column of AGENTS.md: at most three concurrent children. Claude ultracode, the Fable roles and the owner's Fable pause apply to Claude only.
- Children repeatedly broke narrow command allowlists with read-only commands. From r4b the Claude root switched to an effect-based rule: only listed writable files may change, and only through the edit tools; in-place shell editing, copies, moves, deletions and file redirection are forbidden. No breach changed audited content; each is recorded in the round reports.
- Reviewers read immutable snapshots while a mutation tester edits the working copy; a reviewer that runs tests never runs in parallel with a mutation tester on the same files.
- Check CI by actual job steps. A documentation-only commit runs only scope and gate steps; it is not runtime evidence.

## Incoming root checklist

1. Confirm the Claude root is stopped and no other root commands this checkout. Open the ignored entry point and verify the worktree, branch, HEAD and remote.
2. Verify both stashes, the nine dirty paths of the read-only original checkout, the evidence pins (`artifactPins` should all verify), resource state and Codex usage. Record the actual Codex model and effort, or UNKNOWN.
3. Confirm the next Roadmap action. Within the existing GO the C3 line may continue only with pure-model and documentation work; P13j stays held.
4. Before any dispatch, write the packet: exact paths, acceptance evidence, stop condition, usage reservation, one writer per file. Root keeps acceptance, Git integration and GO decisions.

This handoff is documentation and checkpoint verification only. It claims no new product test, runtime acceptance, deployment or progress percentage. The Claude root relinquishes command once this handoff is pushed; the project and the prototype remain incomplete.
