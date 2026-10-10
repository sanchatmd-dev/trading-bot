# Claude to Codex — project handoff, 2026-10-10

## Read order and authority

At about 07:30 UTC (14:30 Bangkok) on 2026-10-10 the owner asked Claude to hand the whole
project and the latest work to Codex. Claude root stops here and Codex becomes the sole
root. The previous Claude to Codex handoff was on 2026-10-08
([Claude to Codex](CLAUDE_TO_CODEX_HANDOFF_2026-10-08.md)); Codex handed root back to
Claude the same day ([Codex to Claude](CODEX_TO_CLAUDE_HANDOFF_2026-10-08.md)).

Read in this order. CLAUDE.md is Claude-only; Codex reads AGENTS.md and the Caveman
skill. Then read the private handoff in the ignored local directory
(`.qa-local/claude-to-codex-handoff-2026-10-10.md`) first, then this file, README,
Context, the top sections of the Roadmap and Time Management, the newest entries of
`.qa-local/claude-root-current.md` and Addenda 13 to 15 of
`.qa-local/claude-r7b-measurement-root-decisions.md`. Host facts, tool pins, receipts and
identifiers live only in the private notes. This summary is not a live-state certificate:
re-verify Git, file ownership, usage and the authorized runtime before any dispatch.

No Claude workflow, agent, timer or monitor is running. Claude children are idle and must
not be resumed.

Existing authority is unchanged: Spot/Paper only, no Live, no production change, no
automatic apply, no guard reset, no automatic optimizer or data-range loop, no new
campaign or holdout access, no replay of a closed GO, no restart of the old QL-3A alert
until the old OPEN is resolved, and no reset, reopen, edit or deletion of the W7 C2
CRASHED record. Binance Global data stays keyless and limited to OHLCV and Preflight.

## Git baseline

- Main checkout branch `codex/app3a-market-wait-checkpoint`: this handoff commit on top
  of `c5e90d1` (Astra Claude Chat handoff command and hardening), `fa090d2` (Astra Claude
  Chat) and `c0a2ebe` (API-credit continuation policy). Pushed.
- `claude-worker/pine-anthropic-adapter` at `9abee46` (Claude provider adapter for the
  Pine assistant, base `eb532ff`, hosted CI 9/9) is not merged; a staging release needs
  its own owner GO.
- Untracked owner files stay untouched: two `docs/target-system-current-*.png` images
  and `scripts/build-spt-exit-diagnostic.mjs`.

## Staging state (verified about 07:15 UTC; re-verify)

- Staging runs `eb532ff` (the inactive release of 2026-10-09). The API is running with
  health 200 PAPER_ONLY and all five research, foundation, PROFILE v2, enrollment and
  Preflight flags 0. The research worker is stopped. The protected Trading units stayed
  active throughout.
- The staging API was down from about 07:07 to 07:15 UTC during today's measurement
  attempt (see below). Webhooks sent in that span were lost; Paper trading kept running.
- Nothing was deleted. The measurement policy file installed by the attempt stays in the
  policy directory and is not referenced by any unit. The enrollment layers were renamed
  out and the admission-off layers are back in place; the private notes list each file.

## What Claude did, 2026-10-09 to 2026-10-10

- Released `eb532ff` inactive on staging (2026-10-09; see the
  [evidence](evidence/R7B_INACTIVE_RELEASE_2026-10-09.json)).
- Landed the API-credit continuation policy and Astra Claude Chat (`c0a2ebe`, `fa090d2`,
  `c5e90d1`) and built the Claude provider adapter on a worker branch (`9abee46`).
- Built and reviewed the R7B bootstrap measurement tool and its root scripts, then ran the
  first measurement epoch on 2026-10-10 under owner GOs:
  - The first baseline read (m0) stopped read-only on two tool defects: a PostgreSQL
    version string that the leak guard mistook for an IP address, and a wrong assumption
    that the API carries a base capacity-policy path (it does not, correctly). Two fix
    rounds with independent tests and audits followed, and the second baseline read
    passed 28 of 28 checks.
  - The bootstrap artifact, the measurement policy and the full pins were built and
    independently reviewed. Node and PostgreSQL identity match the D6 record, so no D6
    rerun is needed.
  - The first effect step (m1) turned enrollment on for the first time under `eb532ff`
    (R7 a1 had done so under `325d335` on 2026-10-08).
    The API refused to start (`QUANT_STORAGE_LIMITS_REQUIRED`): with data and foundation
    enabled, `eb532ff` needs a storage-limits file and a dataset root on the API, and the
    enrollment layer did not provide them.
  - The tool's convergence step could not recover an API unit left in the failed state,
    so the owner approved a one-time manual recovery. Staging was restored to the
    pre-attempt state.
  - Root closed the measurement window. No enrollment was submitted and no marked job
    exists. The [evidence](evidence/R7B_MEASURE_EM1_2026-10-10.json) has the record.

## Next work (Codex root; the owner decides)

1. Intake: Git, hosted CI, usage, the private handoff; a read-only staging health check
   if the owner approves one.
2. Root cause, locally and without host access: list everything the `eb532ff` API needs
   to start with research, foundation, PROFILE v2 and enrollment on, compare it with the
   working research worker and with the R7 activation of 2026-10-08 (which, per the
   private notes, started the API with enrollment on under `325d335`; verify), and decide
   the enrollment layer lines.
3. Fix the measurement tool in a new version: the enrollment layer, a baseline check that
   the enabled configuration is complete before any effect, the receipt parser that hid
   the m1 and convergence effects, the convergence path for a failed API unit, and a new
   policy file name.
4. Run the measurement tool's PostgreSQL harness on the VPS (owner rule below) as its own
   bounded job with an owner GO.
5. A new measurement epoch needs a new allowlist and new owner GOs.
6. Still open from earlier: merge or release decision for the Claude provider adapter,
   CI coverage for `tools/**`, a live check of Astra Claude Chat with the owner's real key,
   worktree cleanup, and the earlier UI decisions (S6, Create Bot at full capacity, s08).

## Owner rules added on 2026-10-10

- Work that needs a lot of memory does not run on the local machine (7.4 GB). It runs on
  the VPS or in Claude cloud. The owner chose the VPS for the measurement harness, after a
  measurement window closes and never during one.
- During a measurement the owner is at the desk from before m1 until the submit POST and
  the m2b receipt, and reachable by mobile until the m4b receipt.
- Any policy-revert warning blocks the next GO until a manual-operations GO clears it.

## Practical notes

- The browser page-script tool does not wait for a bare promise; prefix `await` and
  record both the rendered and the invoked snippet hash before any one-shot submit. It
  also masks some key names in returned objects; return a JSON string instead.
- On this Windows host, set `MSYS_NO_PATHCONV=1` for Node calls that carry POSIX paths.
- Owner answers can take time; ask for windows measured from when the root reads the
  answer.

## Usage

Claude at about 07:06 UTC on 2026-10-10: 5-hour window 7%, weekly all-models 47%. Codex
usage is separate and unknown to Claude; Codex reads its own before admission.
