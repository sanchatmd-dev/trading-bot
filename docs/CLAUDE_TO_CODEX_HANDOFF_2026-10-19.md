# Claude to Codex: whole-project handoff, 2026-10-19

The owner asked Claude to hand the whole project and the latest work to Codex. Claude has stopped. No agent, workflow, test or SSH process is running, and no GO is open. Since the [2026-10-18 handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-18.md), Claude ran two owner-approved B2 supervision windows, NORMAL and TERM, and both passed. The third window, KILL, is prepared but has not run and has no GO. This handoff transfers context; it issues no GO.

## Read order

1. The private `.qa-local/claude-to-codex-handoff-2026-10-19.md` first: directories, hashes, decision records and the window procedure.
2. `AGENTS.md`, `.agents/skills/caveman/SKILL.md` and the top notes of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md).
3. The records [B1 build chain](evidence/DP1P_SUPERVISOR_B1_BUILD_LOCAL_2026-10-18.json), [NORMAL window](evidence/DP1P_B2_WINDOW_NORMAL_2026-10-19.json) and [TERM window](evidence/DP1P_B2_WINDOW_TERM_2026-10-19.json). The [2026-10-18 handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-18.md) still holds the B1 tool list and the older project position.

## Git state

Branch `codex/app3a-market-wait-checkpoint`; before this handoff commit HEAD equalled origin at `7b10ca2`. All commits since the last handoff are docs-only and were pushed without force under the owner's milestone commit authority. The owner's three untracked files remain untouched. All tool code and window records stay under ignored `.qa-local/`.

## What happened since the 2026-10-18 handoff

- Codex briefly took command but could not start the dry runs because another project's tests were loading this computer; the owner returned command to Claude. Codex's takeover notes are kept.
- Preparing the NORMAL window on the real records found one defect: a root tool still capped the renamed prior receipt at 16 KiB, below the real 17,663-byte C01 receipt. A one-line fix (W4B R3) and the matching dry-run harness update (W6B R3) passed independent tests.
- Five consecutive real-turn dry runs passed on the corrected tools, with the owner pausing the other project so the computer was quiet.
- Window W-A04-N01 (NORMAL): admission CLEAR; the probe ran under timeout and timeout exited 0 with no signal; BEHAVIOUR_PASS.
- Window W-A05-T01 (TERM): admission CLEAR; at the 2-second limit timeout sent TERM, the probe handled it, and timeout exited 124 with no signal; BEHAVIOUR_PASS.
- Both GOs are consumed. Each window used two read-only SSH connections, one attempt each.

## Next work

1. **KILL window W-A06-K01.** Admission A06, stage one K01, the real configs and the window contract are prepared and checked. Root turn time belongs to the commander, so run real-turn dry runs under the Codex root on the same harness first, including the KILL case. Then reissue the GO request under Codex and wait for a fresh owner GO. Run it only on a quiet computer with the other project paused, through the single Codex operations worker, alone. The expected result: the probe ignores TERM at 2 seconds, timeout sends KILL 5 seconds later and exits 137. Any UNKNOWN result stops B2 for the owner.
2. **After B2.** B2 is complete only if KILL also passes. Clock qualification, settlement, RD7 measurement and owner-approved limits, and owner-present production S3 remain separately gated. Nothing was deployed, migrated or restarted; REA is paused and PM-1 S1 is unchanged.

## Usage

Claude usage at 2026-10-19T02:40Z: weekly 93 percent used. Codex usage is unknown to Claude; read it fresh. A summary does not certify live state: check Git, ownership, processes and usage before acting, and never reuse an old GO, admission, claim or job.
