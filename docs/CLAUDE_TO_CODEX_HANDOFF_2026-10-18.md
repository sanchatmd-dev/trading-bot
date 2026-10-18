# Claude to Codex: whole-project handoff, 2026-10-18

The owner asked Claude to hand the whole project and the latest work to Codex. Claude has stopped dispatching. No agent, workflow or test process is running, and no GO is open. During its tenure, which began at `4bddbd5` on 2026-10-17, Claude ran exactly one owner-approved release window with two read-only host steps. It deployed nothing, migrated nothing and restarted no service. Codex must revalidate the checkout and take sole command before resuming work. This handoff transfers context; it issues no GO.

## Read order and authority

1. Read the private `.qa-local/claude-to-codex-handoff-2026-10-18.md` first. It holds the tool directories, hashes, decision records and the dry-run procedure that cannot be tracked. The full Claude root timeline is `.qa-local/claude-takeover-2026-10-17/CHECKPOINT.md`, and the latest resume note is `.qa-local/claude-takeover-2026-10-17/RESUME-2026-10-18T1153Z.md`.
2. Read `AGENTS.md`, `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and the top entries of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md). The newest dated note supersedes earlier ones.
3. Read the DP1-P records from this tenure: [SSH wiring](evidence/DP1P_SSH_WIRING_S1_LOCAL_2026-10-17.json), [SSH helper](evidence/DP1P_SSH_PS_HELPER_F1_LOCAL_2026-10-17.json), [P2 metadata chain](evidence/DP1P_METADATA_P2_CHAIN_LOCAL_2026-10-17.json), [private stage one C01](evidence/DP1P_METADATA_STAGE1_PRIVATE_C01_2026-10-17.json), [release-window tools](evidence/DP1P_RELEASE_WINDOW_TOOLS_LOCAL_2026-10-17.json), [first release window](evidence/DP1P_RELEASE_WINDOW_A03_C01_2026-10-17.json), [B1 design and runtime](evidence/DP1P_SUPERVISOR_B1_LOCAL_2026-10-18.json) and [B1 build chain](evidence/DP1P_SUPERVISOR_B1_BUILD_LOCAL_2026-10-18.json). The Codex side of the previous switch is [CODEX_TO_CLAUDE_HANDOFF_2026-10-17.md](CODEX_TO_CLAUDE_HANDOFF_2026-10-17.md); its whole-project table still holds except for the DP1 row updated below.

Roadmap owns implementation priority.

## Git state

- Branch `codex/app3a-market-wait-checkpoint` (not `main`). Before this handoff commit, HEAD equalled origin at `0e82061`. All Claude commits in this tenure are docs-only and were pushed without force under the owner's milestone commit authority of 2026-10-17. CI for `0e82061` showed the gate and both scope checks passing, with the product checks skipped by path filters because the commit is docs-only.
- AGENTS.md changed twice in this tenure (`131386a`, `54e94ab`): a workflow runs at most three lanes in non-overlapping packages, design work that references itself is not split into lanes, read-only reviewers writing only their own report directory do not count as touching a package, verify panels are sized to risk, and fix rounds re-verify only the changed files.
- The working tree has only the owner's three untracked files, which must not be touched: `docs/target-system-current-2026-09-29.png`, `docs/target-system-current-2026-09-30.png` and `scripts/build-spt-exit-diagnostic.mjs`.
- All new tool code lives under ignored `.qa-local/`. Tracked product source is unchanged.

## Work completed by Claude since the Codex handoff of 2026-10-17

| Item | Result |
| --- | --- |
| SSH handle helper and SSH wiring | The PowerShell handle helper was accepted locally on its own after native fixtures and independent review; the runner and launcher wiring candidates were accepted locally with limits. |
| P2 metadata chain (package, materializer, pure finalizer, adapter) | Accepted locally. |
| Private stage one C01 | Prepared on real inputs and recorded; its admission was prepared separately as A03. |
| Release-window design and tools W2 to W6 | Design adopted; the window library, operations session, root commands, post-window review and dry-run harness were accepted locally with limits. Five consecutive real-turn dry runs passed; the worst root turn was 10.8 s and the worst metadata GO age 13.6 s. |
| First release window W-A03-C01 (2026-10-17T14:00Z) | Ran once under an owner GO: admission A03 CLEAR, metadata C01 OBSERVED_METADATA, post-window review METADATA_CONTACT_COMPLETE, GO consumed. These were the only two host steps of the tenure, both read-only. The env and timeout binaries reported GNU coreutils 9.4 (self-reported, not qualified). |
| B1 design | Opus and Fable drafts judged by an Opus auditor. The owner accepted design decisions OD1 to OD10: three separate B2 windows in the order NORMAL, TERM, KILL, each with its own fresh GO, and an UNKNOWN result stops B2. |
| B1 build chain | Probe sources, behaviour runtime, assembly, behaviour package P3B, materializer M3B, finalizer F3B, adapter AD-P3B, window library W2B, operations session W3B, root commands and prior review W4B, post-window review W5B and dry-run harness W6B, each accepted locally with limits. See the [B1 build record](evidence/DP1P_SUPERVISOR_B1_BUILD_LOCAL_2026-10-18.json). |
| Real-turn dry runs DRY-1 | Started. Run d1 (NORMAL) passed with the single operations worker and a live root decision: GO age 18.7 s of the 75 s cap. Run d2 was prepared but never started and must not be reused. |

## Owner decisions in this tenure

- OD1 to OD10 for B1/B2 as above.
- A standing GO for the B2 windows was given on 2026-10-17 at 19:07Z and ended unused at the owner's stop on 2026-10-18 at 01:06Z. Every B2 window now needs a fresh owner GO.
- The workflow lane rule and its clarification (AGENTS.md).
- The usage floor of 2 percent was a Claude-only continuation. The AGENTS default floor of 3 percent applies to Codex.
- REA stays paused. PM-1 S1 is unchanged; no new scorecard was calculated.

## Open work, in suggested order

1. **Finish DRY-1.** At least five consecutive green real-turn runs, including the TERM and KILL cases, with the Codex root making the live decisions and the single Codex operations worker running the operations session, alone and serially. Root turn time belongs to the commander, so the five-run count restarts under Codex; Claude's d1 stays as a reference. Run with nothing else active on the computer: the runner's 4-second pre-contact budget and the adapter's 10-second budget are load-sensitive. A quiet-machine run over 3 seconds or 7 seconds respectively should open a budget review before any real window.
2. **Prepare NORMAL.** Write the C01 acceptance record outside the reviewed records directory, check two evidence bindings by hand that the prior-review tool does not check, run the prior-review tool on the real C01 records (a refusal stops preparation), prepare a fresh admission A04, run stage one on real inputs, build the real window contract and write the GO request. Then ask the owner for a fresh GO.
3. **B2 windows.** NORMAL, then TERM, then KILL. Each starts only after root accepts the previous PASS, and each needs its own fresh owner GO, fresh admission and fresh stage-one job. An UNKNOWN result stops B2 for an owner decision. Known limit: a local runner refusal before any contact is classed UNKNOWN rather than NOT_EXECUTED; report it to the owner with the runner's public line.
4. **Everything else is unchanged from the 2026-10-17 handoff.** Settlement, RD7 measurement and owner-approved limits, OD3/OD4/HZ and owner-present production S3 remain open. A fatal S3 fault means stop and report; recovery needs a separately approved rollback job. The application candidate `70ea7f9` is not deployed. Deploying HEAD differs from deploying that candidate because ledger fencing needs its own migration window. Do not deploy, backport PO1 or LO1, migrate, change grants, restart services, repair SQL, open research flags or run a new campaign by inference.

## Platform notes for Codex

- The B1 tools were built under Claude roles and the Claude Workflow tool. Codex uses its own roles from AGENTS.md: the DRY-1 and window operations worker is the Codex operations role, dispatched explicitly, alone and serially, and Codex keeps its three-child maximum.
- Fable reviews in this tenure are Claude-only evidence; Codex skips those rows. Every Fable finding used for acceptance was confirmed by root or an Opus auditor.
- Never reuse an old GO, admission, claim, job or prepared dry-run world. Never run another role's or a historical script in place; copy it to a new directory first.

## Known runtime and usage

- The host runtime was not checked after the C01 window, so its current state is unknown, not healthy. No SSH process remained after that window.
- Locally there was no agent, harness or test process at handoff time.
- Claude usage read at 2026-10-18T15:30Z: the 5-hour window at 0 percent, weekly all models at 85 percent used, Fable at 31 percent used. Codex usage is unknown to Claude; read it fresh before any dispatch.
- A summary does not certify live state. Check Git, ownership, runtime and usage before acting.
