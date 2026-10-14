# Claude to Codex: whole-project handoff, 2026-10-15

The owner asked Claude to stop, save a checkpoint and hand the whole project and the latest work to Codex. Claude has stopped dispatching. Every Claude child agent has finished or was stopped and cleaned up, and no local PostgreSQL test cluster or test process is left running. No GO is open. No host step has run since the owner-approved read-only VPS check of 2026-10-13 (RO1). Nothing is deployed. Codex must revalidate the checkout and take sole command before resuming work.

## Read order and authority

1. Read the private `.qa-local/claude-to-codex-handoff-2026-10-15.md` first. It holds the worktree and packet index, file hashes, the acceptance records and the next steps that cannot be tracked. The full root timeline is `.qa-local/claude-takeover-2026-10-13/CHECKPOINT.md`.
2. Read `AGENTS.md`, `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and the current top sections of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md).
3. Read the owner decision list [OWNER_DECISIONS_2026-10-13.md](OWNER_DECISIONS_2026-10-13.md) and the Paper evidence records [O3 exit scale](evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json), [F4 funding race](evidence/PAPER_FUNDING_RACE_F4_LOCAL_2026-10-13.json) and [database guard hardening](evidence/DB_GUARD_HARDENING_GH2_LOCAL_2026-10-13.json).

Roadmap owns implementation priority. This handoff transfers context; it issues no GO.

## Git state

- Branch `codex/app3a-market-wait-checkpoint` equals its origin at `7b159a3` (not `main`). CI passed all nine checks on `10ad82e`, the last code commit; the docs commit `7b159a3` also passed its scope checks.
- The working tree has only the owner's three untracked files, which must not be touched: `docs/target-system-current-2026-09-29.png`, `docs/target-system-current-2026-09-30.png` and `scripts/build-spt-exit-diagnostic.mjs`. This handoff file is new and uncommitted unless the owner authorizes its commit.
- Every commit below was authorized by the owner one commit or commit pair at a time and pushed without force.

## Work completed by Claude since the Codex handoff of 2026-10-13

| Commit | Change | Evidence |
| --- | --- | --- |
| `dfe4755` | Codex evidence files and the Codex handoff | as committed |
| `a577689` | Paper exit cost fix (O3) and execution worker fault isolation (W1) | O3 record, followUp FX-O3W1 |
| `0555330` | Database guard hardening, result freeze, TEMP privilege tool, wider guard test coverage | GH2 record |
| `1de80b6`, `82dde57`, `4d86822` | Test harness fixes for CI: serialized root hooks, test-role passwords, one database test file per process | GH2 record, followUps PGX1-PGX3 |
| `8aefbf4` | W1 fault-class hardening: more transient network codes, constructor-keyed faults, Bridge network errors are transient | O3 record, followUp CI2 |
| `6ef8045` | G1: a FIFO exit larger than the open lots prices the uncovered part at the unlotted average cost; false divergence audit rows removed | O3 record, followUp CI2 |
| `e0626aa` | CR1B: bounded server-side retry of API serialization failures | F4 record, followUp CI2 |
| `7d6edb9` | F4 slice S3: `migrate()` ensures the Paper ledger fence table | F4 record, followUp CI2 |
| `40e3b6b` | F4 slice S4: every Paper capital decision takes the fence; the funding race is fixed in code | F4 record, followUp CI3 |
| `08b4cb8` | S5b: read-only Paper ledger detection script `scripts/check-paper-ledger.mjs` | F4 record, followUp CI3 |
| `10ad82e` | TH1: test-only cleanup (phase2 workers drain the queue, an old test-side retry removed, an ignored argument removed) | O3 record, followUp CI3 |
| `c83625c`, `b6f83c1`, `7b159a3` | Status documentation for the commits above | — |

Each code change had an independent review (Opus on every slice, Fable on the high-risk ones, a Tester on all) and a combined full local run before commit. The design for the Paper ledger release (FD1-r2) is code-complete on this branch except the host steps (S7) and their documentation (S8).

**Deploy impact.** From `40e3b6b` on, the API and the worker refuse to start on a database without the fence table. Any staging or production deploy of this branch must first stop the services, run `scripts/migrate-postgres.mjs` offline as the migration owner, check `scripts/paper-ledger-fence.mjs --inspect` reports INSTALLED, and then start the services, under its own owner GO. The read-only prechecks and runbook notes for that window are in the S3 and S4 acceptance records.

## Open work, in suggested order

1. **Three Codex worker slices, reviewed but not committed.** They are in sibling worktrees under `astra-codex-wt/` (packets and returns in each worktree's `.qa-local/`):
   - CX1 `db-tx-closed`: a closed-transaction guard in `src/postgres/db.js`. An Opus review found that a write queued during COMMIT or ROLLBACK could still persist. Round 2 fixed it (the transaction now closes before COMMIT or ROLLBACK, and the error carries SQLSTATE 25000). This version has not had a full suite run yet.
   - CX2 `fence-replication-role`: startup refuses a session whose `session_replication_role` is not `origin`.
   - CX3 `quant-bridge-sqlstate`: the legacy Quant proxy rethrows database errors instead of reporting an engine outage, plus a boundary and teardown fix.
   CX2 and CX3 passed focused checks and three mutation checks, and the full database suite passed on a tree with both (739 tests, 733 pass, 0 fail, 6 skipped); the unit suite was stopped before it finished. A combined tree of `7b159a3` with all three is prepared in `.qa-local/int-r6`. Next: run both full suites there, re-run the Opus probe for the COMMIT/ROLLBACK window against the final `db.js`, then ask the owner before committing.
2. **Read-only detection on the hosts (RO2).** A packet that runs the committed detection script read-only on staging and then production is reviewed and accepted for an owner GO (three review rounds; local proof 113 of 113). Its purpose is to show which Paper defects exist on each host and to size the production fix. Each environment needs its own owner GO and the single operations worker. Production runs only after staging collected a report.
3. **Production Paper exposure.** On 2026-10-13 production held 352 open Paper lots whose exit could hit the decimal-scale failure and stall Paper execution there. A production backport of O3 and W1 (with the W1 hardening) is prepared on a local branch based on the older production tree, and a G1 port for that line is accepted as a local candidate. Neither is pushed or deployed. A production switch tool does not exist yet; derive it from the staging tool once that is accepted. The deployed production commit is known only up to the older tree and must be re-hashed on the host first.
4. **Staging worker switch tooling (DP1-S).** Round 3 is written and proven on a fake host (135 of 135), but its independent review was started and then stopped when the owner stopped the session. Re-run that review before any GO. It targets a commit before `40e3b6b`; a later commit needs the migrate window first.
5. **Follow-ups not started:** a slow `DROP DATABASE` in one recovery test's cleanup that can pass the 15-second statement limit under heavy checkpoint load (test-only); a per-connection replication-role check in the pool; the legacy Quant optimize call that holds a transaction longer than the idle timeout; widening the fence writer guard to scripts; the open W1 residuals.
6. **Owner decisions** still open are collected in the decision list (groups A to G). Several rules are used provisionally in the committed code and are marked there.

## Known runtime and usage

- Last host facts are from RO1 (2026-10-13): production and staging Paper health PAPER_ONLY, no stuck signals, fresh worker heartbeats, no negative Paper cash; production had the 352 exposed lots above. Nothing on the hosts changed since then through this project.
- Claude usage at the stop: weekly all-models 12% used, Fable 8% used. Codex workers reported about 15% Codex weekly usage.
- Claude chat worker sessions are idle with no task. No Codex worker is active.
