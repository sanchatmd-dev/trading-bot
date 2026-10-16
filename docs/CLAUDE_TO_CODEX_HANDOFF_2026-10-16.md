# Claude to Codex: whole-project handoff, 2026-10-16

The owner asked Claude to hand the whole project and the latest work to Codex. Claude has stopped dispatching. No agent or workflow is running, and no GO is open. Claude ran no host step during its tenure, which began when it took over at `7e6ccd1` on 2026-10-15, and it deployed nothing. Codex must revalidate the checkout and take sole command before resuming work.

## Read order and authority

1. Read the private `.qa-local/claude-to-codex-handoff-2026-10-16.md` first. It holds the packet index, file hashes, acceptance records and run procedure that cannot be tracked. The full Claude root timeline is `.qa-local/claude-takeover-2026-10-15/CHECKPOINT.md`.
2. Read `AGENTS.md`, `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and the current top sections of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md).
3. Read the owner decision list [OWNER_DECISIONS_2026-10-13.md](OWNER_DECISIONS_2026-10-13.md), the four DP1-P evidence records [C3R packaging](evidence/DP1P_C3R_PACKAGING_LOCAL_2026-10-15.json), [C3R-2 runtime seam](evidence/DP1P_C3R2_RUNTIME_SEAM_LOCAL_2026-10-15.json), [CREDIT2 placement model](evidence/DP1P_CR2_PLACEMENT_MODEL_LOCAL_2026-10-15.json) and [native observer review (paused)](evidence/DP1P_NATIVE_OBSERVER_REVIEW_PAUSED_2026-10-15.json), and the [PM-1 scorecard S1](progress/PM1_SCORECARD_S1_2026-10-15.md). The Codex side of the previous switch is [CODEX_TO_CLAUDE_HANDOFF_2026-10-15.md](CODEX_TO_CLAUDE_HANDOFF_2026-10-15.md).

Roadmap owns implementation priority. This handoff transfers context; it issues no GO.

## Git state

- Branch `codex/app3a-market-wait-checkpoint` equals its origin at `ecceac3` (not `main`). Commit `ecceac3` is docs-only. The owner authorized it, and it was pushed without force. Its scope and gate checks passed, and the product checks were skipped because the commit is docs-only. Claude made no code commit during its tenure.
- Besides the five uncommitted handoff documents named in the next point, the working tree has only the owner's three untracked files, which must not be touched: `docs/target-system-current-2026-09-29.png`, `docs/target-system-current-2026-09-30.png` and `scripts/build-spt-exit-diagnostic.mjs`.
- This handoff file and the four dated status notes (README, Context, Roadmap, Time Management) are uncommitted unless the owner authorizes their commit.
- The S1 scorecard evidence was committed as LF blobs. A CRLF re-checkout changes the on-disk bytes of the local-bound items E067 to E070, so the next scorecard should bind them by commit `ecceac3`.

## Work completed by Claude since the Codex handoff of 2026-10-15

Every code slice below had an independent tester in every round before root acceptance. The C3R-2 runtime seam also had an Opus auditor in every round. The CREDIT2 model had an Opus auditor in rounds 1 to 3, and its final round 4 was verified by the tester and a root read of the patch. The C3R packaging slice's second reviewer was dispatched as Fable but fell back to a non-team model mid-run, so it is not counted as a Fable or team review. No Fable review is claimed for any slice: two Fable runs on 2026-10-15 fell back to a different model mid-run and were relabeled. Nothing below is wired into a host tool, and nothing is deployed.

| Item | Result | Evidence |
| --- | --- | --- |
| C3R packaging | Accepted local candidate: the new C1L composer (the frozen C1 composer is untouched) and the E2 encoding, with refusals for the R3 to R5 cases. | [C3R packaging record](evidence/DP1P_C3R_PACKAGING_LOCAL_2026-10-15.json) |
| C3R-2 runtime seam | Accepted local candidate. The grammar-maximum payload is 47,904 bytes of the 49,152-byte cap, which leaves 1,248 bytes of headroom against a floor of 1,024. | [C3R-2 record](evidence/DP1P_C3R2_RUNTIME_SEAM_LOCAL_2026-10-15.json) |
| CREDIT2 placement adapter and trace model | Local model only. Derived totals such as T 14 and R 6 are not approved; owner limits and credits are decided only after host-class measurement. | [CREDIT2 record](evidence/DP1P_CR2_PLACEMENT_MODEL_LOCAL_2026-10-15.json) |
| Native observer review | Reviewed, and the owner paused the line. Even a perfect run would leave the WATCH identity UNKNOWN. | [Review record](evidence/DP1P_NATIVE_OBSERVER_REVIEW_PAUSED_2026-10-15.json) |
| PM-1 scorecard S1 | Root accepted and committed. Project 50.17 to 74.12 percent (baseline 46.12 to 70.40 percent, which stays immutable). Prototype 52.00 to 82.42 percent, unchanged. These are bounds, not a score. | [Scorecard S1](progress/PM1_SCORECARD_S1_2026-10-15.md) |

## Owner decisions recorded on 2026-10-15

- A fatal fault in production S3 means stop and report; production may stay in a partial state until an operator acts.
- Recovery happens only through a separate rollback job, with its own owner GO each time.
- The owner stays reachable for the whole S3 window. The operations agent runs and watches, and the owner gives any rollback GO.
- Limits and credits are decided only after measurement on the target host class and owner approval.
- The native observer line is paused. No host steps run for it.
- Commit `ecceac3` was authorized.

## Open work, in suggested order

1. **Staging 24-hour read-only observation.** This is job `dp1s-post-24h` of the retained Codex c02 driver. The packet is ready. The job became eligible at 2026-10-15T22:17:53.400Z (2026-10-16 05:17:53.400 Bangkok). The owner gave no GO, so it has not run. At handoff time root re-hashed the 13 packet pins and all matched, and the job is unconsumed; re-verify at run time, because hashes go stale. It needs a fresh owner GO in chat, a new GO record written by the Codex root (at most 60 seconds old when the tool runs), the single operations worker alone, one SSH connection and no retry. Any trigger means stop and report, with no rollback or retry; the retry job `dp1s-post-24h-2` needs a new root decision and owner GO. The AGENTS default 15 percent usage stop band applies, with no special floor. The 737-second outer wall exceeds a 600-second foreground tool call, so run it in the background or with a timeout of at least 760 seconds. The longer the gap since the switch, the more likely a benign unit change shows up as a trigger. One dated sample does not prove continuous 24-hour health.
2. **DP1-P wiring prerequisites, local design first.** Settle the bindings and certificate provenance (RD6). Build the runner slice: pin the runner-side parser, the public view and the REMOTE_NO_RESULT handling. Fix the `host.mjs` time sources: remove the `Date.now` fallbacks and make the catch unwind unreachable after a fault. The adapter must set "performed" from evidence. The payload margin is only 224 bytes over the floor, and the target-host Node version is unknown. Host-class measurements (RD7) need their own operations packet and owner GO; the owner then approves limits and credits.
3. **Production Paper exposure is unchanged.** The DP1-P candidate `70ea7f9` is not deployed, there is no PO1 or LO1 backport, production held 352 open Paper lots exposed to the O3 exit-scale failure at the last observation (RO2), and the production identity is partly UNKNOWN. Deploying the current branch differs from deploying that candidate: from `40e3b6b` on, API and worker startup requires the ledger fence table, so an applicable release needs its own separately authorized offline migration and inspection window. Do not deploy HEAD, backport PO1 or LO1, migrate, change grants, restart services, repair SQL, open research flags or run a new campaign by inference.
4. **Owner decisions still open.** G1 D11; W1 D7 to D11, D13 and D14; QR-1b D1 to D4; R7/EM2 Q1 to Q19. Resume the native observer line only if the owner asks.

## Known runtime and usage

- The host runtime was not checked by Claude, so its state is unknown, not healthy. The last dated host facts: the staging trading worker was switched to `4d86822` at 2026-10-15 05:17:53.400 Bangkok, with the immediate and 10-minute checks passing, and production was unchanged.
- Locally there was no PostgreSQL, SSH or test process at handoff time. The Codex app processes were running.
- Claude usage read at 2026-10-16 09:23Z: 5-hour window 0 percent used, weekly all-models 52 percent used (about 18 percent at 2026-10-15 13:42Z; the cause of the rise was not determined), Fable 23 percent used. Codex usage is unknown to Claude, so read it fresh before any dispatch.
- A summary does not certify live state. Check Git, ownership, runtime and usage before acting, and never replay an old GO, wrapper or token.
