# Claude to Codex — project handoff, 2026-10-08

## Read order and authority

At about 10:20 UTC (17:20 Bangkok) on 2026-10-08 the owner asked Claude to hand the
whole project, the latest work, the pending owner step O1 and every owner-only task to
Codex. Codex will drive the owner's signed-in browser tab with its computer-use skill
for O1. Claude root stops here and Codex becomes the sole root. The previous handoff was
Claude to Codex on 2026-10-06 ([Claude to Codex](CLAUDE_TO_CODEX_HANDOFF_2026-10-06.md));
the owner then handed root back to Claude the same evening.

Read in this order. CLAUDE.md is Claude-only; Codex reads AGENTS.md and the Caveman
skill. Then read the private handoff in the ignored local directory
(`.qa-local/claude-to-codex-handoff-2026-10-08.md`) first, then this file, README,
Context, the top sections of the Roadmap and Time Management, and the newest entries of
`.qa-local/claude-root-current.md`. Host facts, tool pins, source hashes, receipts and
identifiers live only in the private notes. This summary is not a live-state
certificate: re-verify Git, file ownership, usage and the authorized runtime before any
dispatch.

Claude children and Claude worker sessions are frozen and must not be resumed. Fable
5.1 is no longer on the Claude team (owner, 2026-10-07). No Claude workflow, agent,
timer or cron runs.

Existing authority is unchanged: Spot/Paper only, no Live, no production change, no
automatic apply, no guard reset, no automatic optimizer or data-range loop, no new
campaign or holdout access. Closed GOs are never replayed.

## Git baseline

- Main checkout branch `codex/app3a-market-wait-checkpoint`: this handoff commit on top
  of `705ee94` (s07 release record) and `0ff67ba` (UI Preflight runner panel, hosted CI
  9/9, not released). Pushed.
- Release branch `codex-worker/combined-r7` at `c4aab2a` (pushed); its code equals
  `325d335`, which staging runs. `0ff67ba` is not merged there yet; merge it after R7.
- Untracked owner files stay untouched: two `docs/target-system-current-*.png` images
  and `scripts/build-spt-exit-diagnostic.mjs`.

## Staging state (last verified 09:48 UTC; re-verify)

- The staging API and research worker run `325d335` (combined release s07, accepted
  about 04:00 UTC; see the [S07 record](evidence/COMBINED_S07_STAGING_RELEASE_2026-10-08.json)).
  The trading worker is unchanged.
- D6 passed on staging (09:23 to 09:32 UTC): 1100 of 1100 samples, prepare plus BEGIN
  p99 about 117 ms, worst-case total about 363 ms. The acceptance inequality holds with a
  conservative spawn-to-frame allowance and margin (about 3.5 s against a limit of about
  9.7 s), so R7 needs no engine change. The D6 database and scratch directory were removed.
  Before D6 the owner approved one permission change on the directory that holds the
  database admin file (group write removed).
- R7 is in progress. The new capacity policy (evaluator `3fb2d465`) is installed, and the
  activation step a1 published the enrollment configuration: research, foundation,
  PROFILE V2 and enrollment are on in both the API and the research worker; preflight is
  off. Health is 200 PAPER_ONLY and the queue is idle. Rollback to the release state with
  flags off is the R7 tool's x1 step (idle only).
- The s07 release rollback is no longer available (it closed when D6 started).

## What Claude did, 2026-10-07 to 2026-10-08

- Built and reviewed (Opus auditors, with an independent Opus second opinion in place of
  the removed Fable role) the combined release tool, the D6 tool v2, the R7 policy, the R7
  activation and rollback tool, the R7 read-only verification tool and the owner console
  snippets, all under `.qa-local`.
- Ran the combined release, D6 and the first R7 steps (s1, d0, a1 and their read checks)
  under owner GOs.
- Added the owner Preflight runner panel to the UI (`0ff67ba`) after four review rounds;
  it is not deployed.
- Removed Fable from the agent team (`2da91b7`) on the owner's order.

## Next work (Codex root)

1. Ask the owner to confirm that the R7 GO given to Claude (policy, a2 after root accepts
   the enrollment, rollback before the enrollment POST) carries over to Codex.
2. O1: the owner signs in to the staging UI in their own browser tab; with the owner's
   in-chat permission for that one submit, the enrollment snippets (S0 to S3) send one
   enrollment. The private notes hold the package path, the identifiers and the typed
   confirmation.
3. Read-only w1 and v1; root accepts the enrollment; a2 opens preflight; p1b.
4. b0, then O2: the owner registers the permanent holdout boundary (candidate
   2026-09-25 19:53 UTC, the end of the 515-bar dataset).
5. Regenerate S0 with the enrollment job; O3: the owner sends one preflight and one
   same-key replay; then w2, v2 and q1. Only a completed real R7 result plus a healthy
   final state supports "PF-2 API enabled on staging".
6. After R7: record D6 and R7 evidence, merge `0ff67ba` into the release branch and
   prepare the UI release (s08).

## Owner-only items

- Sign-in to the staging UI (never typed by an agent).
- O1 enrollment submit, O2 holdout boundary (permanent), O3 preflight submit and replay.
- Any rollback after the enrollment POST, any GO outside the R7 GO.
- Later decisions: S6 (the `confirmLookback` replacement), authenticated Create Bot at full
  3/3 capacity, the s08 UI release, the P1-F walkthrough, and acceptance of two recorded
  residuals (duplicate enrollment possible from two separate tabs; same-moment confirms in
  two tabs).

## Practical notes

- Owner answers can arrive one to two hours after a question. Ask for windows measured
  from when the root reads the answer, not fixed clock times.
- A GO is valid for at most 60 seconds at the tool gate. A long-running operations agent
  became too slow; use a fresh, small-context executor and pre-arm it.
- On this Windows host, set `MSYS_NO_PATHCONV=1` for local Node calls that carry host paths.
- Free memory on the local machine is often below 2 GB; run tool checks one at a time with
  a small heap.

## Usage

Claude at about 10:21 UTC on 2026-10-08: 5-hour window 3%, weekly all-models 25%. Codex
usage is separate and unknown to Claude; Codex reads its own before admission.