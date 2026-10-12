# Claude to Codex: whole-project handoff, 2026-10-12

The owner asked Claude to plan J2 and then hand the whole project, the latest work and the J2 plan to Codex. Claude has stopped dispatching, and every child assignment is complete. Since the Codex handoff of 2026-10-11, Claude ran the J1 attempts J1-R4 to J1-R9 on the VPS, one owner GO per attempt. J1-R9 passed. No deployment, product change, service change, measurement epoch, enrollment or Live action occurred. Codex must revalidate the checkout and take sole command before resuming work.

## Read order and authority

1. Read the private `.qa-local/claude-to-codex-handoff-2026-10-12.md` first. It holds the artifact index, the freeze hashes, the host facts that cannot be tracked and the attempt timeline.
2. Read the J2 plan: `.qa-local/claude-r7b-j2-plan/J2-PLAN.md`, which root accepted with the owner's decisions, and the full analysis `PLAN-DRAFT.md` beside it.
3. Read the latest evidence:
   - [J1-R9 pass](evidence/R7B_J1R9_2026-10-12.json);
   - [RC11 and the J1-R9 preparation](evidence/R7B_J1R9_RC11_LOCAL_2026-10-12.json);
   - the earlier attempt and package records listed below.
4. Read `AGENTS.md`, `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and the current top sections of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md).

Roadmap owns implementation priority. This handoff transfers context; it issues no GO.

## Whole-project status

Spot/Paper-only, BINANCE:BTCUSDT Spot 1m and reduce-only EXIT remain required. The old QL-3A OPEN allocation is unresolved and its old alert stays stopped. The W7 C2 CRASHED record and its full-allowance charge stay as they are. All earlier GOs are consumed or closed. No automatic optimizer or data-range loop, guard reset, Best Inputs apply, holdout access or Live activation.

| Owner step | Completed evidence | Remaining gate |
| --- | --- | --- |
| AI chatbot and Bridge | Provider/Bridge evidence; staging source binding | Authenticated journey; source adaptations; separate Claude adapter candidate |
| Ten numeric inputs | S1/S2/S3/S5 accepted; S7 local replay; selection/snapshot staging | S4 runtime; S6 confirmLookback decision; complete acceptance |
| Preflight and Risk Manager | PF-3/PF-4 staging; scoped W7/D6 evidence | R7 measurement (J1 passed once; J2 to J4 open), capacity, enrollment; PF-2 activation; UI release; last observed Preflight OFF |
| Signal and Paper | Natural BUY and same-entry reduce-only EXIT evidence | Old OPEN allocation unresolved; no Live activation |
| Quant optimizer | 21-candidate run returned NO_VALID_CANDIDATE; separate raw backfill of 515 bars | Qualified winner; no automatic retry, campaign or holdout access |
| Research Library | Library and History staged | Qualified strategy export and complete end-to-end acceptance |

The [Codex handoff of 2026-10-10](CODEX_TO_CLAUDE_HANDOFF_2026-10-10.md) still holds the wider backlog. Since the Codex handoff of 2026-10-11 (HEAD `30e50ac`), only documentation, `AGENTS.md` and ignored `.qa-local/` files changed; no product code or release changed.

## Work completed by Claude since the Codex handoff

The active gate is R7: run the sealed, isolated PostgreSQL harness on the VPS before any new measurement epoch. The harness runs four jobs, J1 to J4, and each needs its own owner GO. Each J1 attempt used one run directory, no retry and one operations worker; root admitted and accepted every row. Each failure was diagnosed locally and fixed in a new package candidate, with tests and Opus audits, before a new GO.

| Attempt | Package | Result | Cause and fix | Evidence |
| --- | --- | --- | --- | --- |
| J1-R4 | RC6 | Failed before the suite | The job's IO limits read back differently from the plan; RC7 aligned the limits | [RC6](evidence/R7B_J1R4_RC6_LOCAL_2026-10-11.json), [run](evidence/R7B_J1R4_2026-10-11.json) |
| J1-R5 | RC7 | Failed at PostgreSQL start | A status parse of the PostgreSQL process file; a read-only diagnostic found it and RC8 fixed it | [RC7](evidence/R7B_J1R5_RC7_LOCAL_2026-10-11.json), [run](evidence/R7B_J1R5_2026-10-12.json), [diagnostic](evidence/R7B_J1R5_DIAG_2026-10-12.json) |
| J1-R6 | RC8 | Failed at the suite entry | The host shell exported one extra environment name; RC9 removes it | [RC8](evidence/R7B_J1R6_RC8_LOCAL_2026-10-12.json), [run](evidence/R7B_J1R6_2026-10-12.json) |
| J1-R7 | RC9 | Nine cases denied a file read | The product checks every parent folder of its store, outside the suite's read grant; RC10 attests those folders and answers that one check | [RC9](evidence/R7B_J1R7_RC9_LOCAL_2026-10-12.json), [run](evidence/R7B_J1R7_2026-10-12.json), [RC10](evidence/R7B_J1R8_RC10_LOCAL_2026-10-12.json) |
| J1-R8 | RC10 | Ten of eleven cases passed | The measurement tool's JSON envelope delivered oid values as strings, and the product compares them as numbers; RC11 restores six listed oid columns and names every refusal | [run](evidence/R7B_J1R8_2026-10-12.json), [RC11](evidence/R7B_J1R9_RC11_LOCAL_2026-10-12.json) |
| J1-R9 | RC11 | **Passed** | All eleven cases passed; outer proof, bundle and strict postflight accepted | [run](evidence/R7B_J1R9_2026-10-12.json) |

The packages, decisions, audits, runners and run records are ignored local files under `.qa-local/`, frozen. A Git clone does not contain them. Use the existing workspace.

## Last known runtime (J1-R9, 2026-10-12 13:18 to 13:25 UTC)

- Product health before and after the job: PAPER_ONLY, the five research flags off, nothing queued, the research worker inactive.
- Only the staging fallback unit's start time changed between the two health reads. Its five-minute timer moves it, and the rule allows that.
- Unit tasks peaked at 22 of 32 and role connections at 3 of 9. The suite took about 22.5 seconds, within about 24 seconds of job wall time.
- The job artefacts of J1-R4 to J1-R9 stay on the host, about 55 MB plus job output per attempt (an estimate, not measured on the host). The owner chose to keep them all. Current free disk is unknown.

## J2 plan (owner decisions of 2026-10-12)

J2 runs five cases: H-4, H-5, H-7b, H-7c and H-7d. All five are built in the current harness.

**Owner decisions:**
- Run J2 on the unchanged RC11 package, the one J1 passed on.
- Proceed with the job cgroup tasks peak unknown, and disclose it.
- Keep every retained host artefact.

**Plan findings that matter first:**
- **High:** the preflight gate used for J1 accepts only J1. An unchanged derivation would refuse J2 at the preflight row, after nine host contacts, and use up the GO. A new reviewed J2 gate is the first build step.
- Several root and runner files carry J1-only values: the job id pattern, the job kind and the eleven-case count. Each becomes a listed change with its reason; renaming alone does not cover them.
- The RC11 package root already exists on the host, and bootstrap refuses an existing root. J2 uses a new root name and uploads the same package again.
- **Accepted by the owner:** on RC11, a failing stateful case exports only its code, not the list of checks that failed. A J2 failure may therefore need a local diagnosis and a new GO.

## Next bounded work

Follow `J2-PLAN.md`:
1. Recheck Git, file ownership, usage and the frozen hashes listed in the private handoff and the plan.
2. Write the J2 decisions file in a new `codex-r7b-j2r1-*` namespace.
3. Build and test the J2 preflight gate.
4. Derive the J2 operations preparation and the runner from the frozen J1-R9 namespaces. Keep the delta tests at zero unexplained differences.
5. Run the local replays, an independent tester and an architecture audit.
6. Freeze, write the GO packet and the runbook, then ask the owner for one J2-R1 GO.

J3 (H-12b, H-14, H-15) and J4 (H-13) stay closed until they have their own preparation and GO.

## Checkout, ownership and transfer

**Branch and commits:**
- Branch `codex/app3a-market-wait-checkpoint`.
- HEAD `4f68a59` (J1-R9 run evidence), on `b747c5d` (RC11 and J1-R9 preparation), both pushed.
- Hosted CI on `4f68a59`: three checks passed and four were skipped, as expected for a docs-only commit.
- This handoff and its doc paragraphs are the only new tracked changes. They need the owner's commit approval.
- Two dated PNG files and `scripts/build-spt-exit-diagnostic.mjs` remain untouched owner files.

**Usage:** Claude weekly usage at handoff was 78% used, with the owner's floor for this continuation at 2% remaining. Codex must read its own usage.

**State at hand-over:** no Claude agent, workflow, timer or host session is active. Once this checkpoint is saved, Claude yields command. No Codex session was launched or messaged automatically.
