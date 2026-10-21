# Claude local root to Claude cloud root: handoff, 2026-10-21

On 2026-10-21 (Bangkok) the owner told the local Claude root ("Root: astra-vps-trade-bot-v2") to stop, save a checkpoint, write a handoff and continue as Root in a new Claude cloud chat. The local root has stopped: no workflow, agent, test or PostgreSQL cluster is running, and no GO is open. From this handoff on, the cloud chat is the only root. The local chat no longer dispatches, writes or runs Git.

## Read order

1. `AGENTS.md` and `.agents/skills/caveman/SKILL.md`, then the top notes of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md).
2. This file, especially "Uncommitted local work" and "Binding root rulings kept only here".
3. The contract decision rows named below and the evidence records they cite.

The private local checkpoint and design drafts live in the ignored `.qa-local/` folder of the owner's computer. A cloud session cannot read them; everything the next root needs from them is copied into this file.

## Git state

Branch `codex/app3a-market-wait-checkpoint`. Before this handoff commit, HEAD equalled origin at `f6d52b4`. CI passed 9 of 9 checks on every pushed head tonight, the last one being `f6d52b4`. Commits were pushed without force under the owner's milestone commit authority. Nothing was deployed, migrated or installed on any environment, no flag was turned on, and there was no host step.

## What landed since 1480385 (all local engineering evidence, nothing installed)

- `b4fd745` QR-3 S2c-2: comparison result tables (RC-C45).
- `20929f1` QR-4 S2-2: window freeze, evaluation starts, outcome and replay (RC-S29).
- `1beba46` QR-2 S3b: per-Bot view computed in a worker thread (RC-Q36). The route stays off. Its p95 bar was met in one of two runs.
- `ac38303` F11 multi-Pine research run contract builder (RD-MP-18).
- `4357208` QR-2 S4-1: capital-model declaration extension (RC-Q37), provisional.
- `fe8df2c` QR-2 S4-2: pure owner-total allocation module (RC-Q38), provisional.
- `1ca3d37` QR-2 S4-3: export, confirmed rollback and restore rehearsal (RC-Q39).
- `de6fb3b` foreign-key trigger check in every extension classifier (PKG RC-33).
- `00fd0c5` F11 RS-1: internal run store extension, isolated clusters only (RD-MP-19).
- `d4d914f` F11 RS-4: pure per-member admission checks with one-Pine parity (RD-MP-20).
- `be1b68d` F11 RS-2: run-store writer and readers (RD-MP-21). It also allowlists `src/postgres/mp-run-store.js` in the run-contract import guard.
- `268f793` F11 RS-3: run-store isolation suite (RD-MP-22).
- The `docs:` status commits `027b320`, `50ffd6a`, `f12d058`, `601450b` and `f6d52b4`.

Engine-hash closures (FOUNDATION, LEGACY, INGESTION, PF-2 engine and evaluator) were recomputed after every commit and never changed.

## Uncommitted local work (not visible to a cloud session)

These changes stay uncommitted in the owner's local checkout. The cloud root starts from origin and does not have them. A full snapshot (a diff of tracked changes and copies of new files) is saved privately on the owner's computer.

1. **F11 RS-5, the internal fixture admission service** (`src/multi-pine/fixture-service.js`, `test/postgres/mp-fixture-admit.test.mjs`, and a one-line allowlist addition in `test/multi-pine-run-contract.test.js`). State:
   - Round 1 was written and reviewed. The tester killed 10 of 10 mutations.
   - The round 2 coder fixes X1 to X6 (below) are in the working tree.
   - The round 2 tester was stopped mid-run. Root restored the one mutation it had left in the guard test, so the file again equals the tester's start hash.
   - The final sole-runner pass has not run.
2. **Documentation fixes from the Fable consistency check** (D1 to D7 below). The documentation agent had applied them in the working tree (twelve evidence files renamed to `_2026-10-21`, contract dates, status split). None of it is verified or committed.

The next root chooses one of two paths:
- Ask the owner to have the local checkout commit and push this work as is, then verify it.
- Redo both items from the rulings below on the pushed revision (recommended if the owner is not at the computer).

Do not assume either item is done.

## Binding root rulings kept only here

**F11 RS-5 (DESIGN 7.1 sequence; contract 5.1, RD-MP-15 to RD-MP-22):**
- **V1, constructor and input.** `MultiPineFixtureService.admit(input)` with a closed input list. The constructor takes the fixture-role db, the Store on the same db, readBotState, clock, engineHash and supported_source_hash, all from config, never from request input. deadline_seconds defaults to the one-Pine default, in whole seconds from 60 to 900.
- **V2, quant capability.** The service builds each member's quant capability itself. State is SUPPORTED only when the member source hash equals the configured supported source hash and the member passed the step-3 checks. The record carries that member's source hash and effective-inputs hash.
- **V3, step order.**
  1. Closed-key shape, then the fixture flag, then refuse non-empty parameter_slots.
  2. Owner and Bot authorization.
  3. Read-only replay check: LOAD on the same submission hash, or `MP_INPUT_INVALID` field `idempotency_key` on a different one.
  4. T1: `freezeOrLoadMemberSet`, outside any transaction.
  5. T2 (SERIALIZABLE): FOR SHARE locks, freshness check, the RS-4 checks, dataset span from the exported content-digest query, capital accounts, `buildMultiResearchContract`, `insertMultiRun`.
  6. T2 retries 40001, 40P01 and a lost idempotency-key race at most three times. On attempts after the first, it calls `findMultiRunByKey` first (X6).
  7. Every refusal inside T2 is thrown out of the transaction callback and mapped outside it.
- **V4, return shape.** `{ok:true, action:'ADMIT'|'LOAD', run:{run_id, contract_hash, status, owner_recommendation_ready:false}}`. Status is ADMITTED on ADMIT and the stored run's current status on LOAD.
- **V5, side effects.** A side-effect digest proves admit writes nothing outside the member-set and run-store tables. No runtime root imports the service.
- **V6, V7.** engine_hash is injected (R12 decides it in RS-6). Use existing codes only.
- **X1, guard allowlist.** The run-contract import guard also allows exactly `src/multi-pine/fixture-service.js`.
- **X2, real Bot-state reader.** One test uses the real `storeBotState` reader and a stale case that changes database rows.
- **X3, capability end to end.** An end-to-end tap case reaches `MP_MEMBER_QUANT_UNSUPPORTED`.
- **X4, shared constant.** Import `MAX_DATASET_BARS` from the member-admission module; no local copy.

**Documentation fixes (from the Fable consistency check, confirmed by root):**
- **D1, Bangkok dates.** This project dates work in Bangkok time, and every commit from `b4fd745` on is 2026-10-21. Rename the twelve evidence files committed tonight from `_2026-10-20` to `_2026-10-21` and set their `date` and `rootAcceptance.date`. The files: QR3_S2C2, QR4_S2_2, QR2_S3B, F11_01_RUN_CONTRACT, QR2_S4_1, QR2_S4_2, QR2_S4_3, EXTENSION_FK_TRIGGERS, F11_01_RUN_STORE_RS1, F11_01_MEMBER_ADMISSION_RS4, F11_01_RUN_STORE_RS2 and F11_01_RUN_STORE_ISOLATION_RS3.
- **D2, links.** Update every link to those files.
- **D3, contract dates.** Date the contract rows RC-Q36 to RC-Q39, RC-C45, RC-S29, PKG RC-33 and RD-MP-18 to RD-MP-22 as 2026-10-21, and fix the headers that call them "the same day".
- **D4, status split.** Move tonight's sentences out of the 2026-10-20 status paragraph (line 3 of the four status files) into a new paragraph above it: "Claude local slices, 2026-10-21 (Bangkok): …".
- **D5, stale Roadmap paragraph.** The Roadmap APP-3B scope paragraph (near line 2424) still says the multi-Pine run slices have not started. Correct it.
- **D6, mutation wording.**
  - QR2_S4_1: write "4 of 5 killed, one survivor not killable by design".
  - QR2_S4_1 and F11_01_RUN_STORE_RS1: add a limit that some mutants were killed only by the classifier definition pin.
  - QR3_S2C2: add the limit for the evaluation body CHECK.
- **D7, guard-edit wording.** In RS2 and RS3, say root edited the import guard and verified that edit itself: an empty allowlist fails the guard, and the full unit suite, run by root alone, passed 2321 tests with 0 fail. In RS2, add `test/multi-pine-run-contract.test.js` with its LF hash at `be1b68d` to `files`.

**QR-2 S4 (recorded in RC-Q37 to RC-Q39):** the Opus draft is primary. Owner items OW1 to OW10 are applied with their strict provisional options:
- next-midnight effective time;
- the full owner Bot set;
- withdrawal as a new SHARED_HYPOTHETICAL version;
- THB kept;
- a cap of 1000 versions;
- strict range applicability;
- no admin declaration;
- export custody stays with the owner.

S4-4 (the PUT) and S4-5 (the owner route) are held for those owner decisions. For S4-4:
- map `paper_capital_models_effective_from_check` by constraint name;
- treat 40001 as a dispatcher retry, never a 409;
- keep the PUT transaction short;
- choose between an owner-row FOR UPDATE and an advisory lock then.

## Next work for the cloud root

1. Verify the cloud environment before dispatching: Node, `npm test`, and PostgreSQL 16 with `pg_dump` and `pg_restore` for the PostgreSQL suites (one file per process, scram, at most 100 connections, `FREEZE_TEST_PG_BIN`). Report what is missing to the owner.
2. Confirm the Git rule with the owner. `AGENTS.md` lets a cloud agent only return a patch, never commit or push. Whether the cloud root may commit and push on this branch is the owner's call; ask before the first push.
3. RS-5: recover the local work-in-progress or redo it (rulings above), then run the final pass over every importer and record RD-MP-23 with its evidence.
4. Documentation fixes D1 to D7.
5. Later F11 slices:
   - RS-6, execution. It needs the combined Python evaluator and root items R5, R7, R11 and R12.
   - The multi-Pine package slice (R6).
   - Owner items O1 (never install the run store on staging or production before APP-3B) and O2 (multi-run windows as search history).
6. Blocked:
   - QR-3 S3 and QR-4 S3 need FE-2b, which rotates engine hashes and needs a release plan plus an owner GO.
   - QR-2 S4-4 and S4-5 need the owner's S4 decisions.

## Owner decisions still open

- QR-3 OPEN-1 (tie band wider than 0.50) and OPEN-2 (a single eligible participant).
- QR-4 OD-S3 tie tolerances.
- QR-2 O-1 (history-limit scope) and OW1 to OW10.
- F11 O1 and O2.
- The FE-2b release plan and GO.
- The staging fixture owner account.
- Account deletion against insert-only owner rows.
- Server memory headroom before QR-2 is switched on anywhere.

The N1 terminal-evidence line stays held: never reword, reroute or split it.

## Other sessions

The owner started the side task "Bound the other test readiness waits by wall time" in a separate local session. It reports to the root by session name. Ask the owner for its result, or look for its branch or pull request.

## Working rules that proved necessary tonight

- **Workflow limits.** One workflow runs at most three lanes in distinct packages, with one writer per file. Serialize mutation runs against reviewers that run tests.
- **Final pass.** Before every commit, a final sole-runner pass runs every test file that imports or runs a changed module (found with `git grep`), plus the full unit suite and the grant tests. Importers include the guards of earlier slices: twice tonight an import guard of an earlier slice refused a new importer.
- **PostgreSQL testers.** Testers run every test command in the foreground and return only after the after-run hashes are taken and their cluster is stopped. One tester returned early and left a cluster running.
- **Agent dates.** Check dates and counts in agent packets against the raw results before writing evidence. Use Bangkok dates for evidence, matching the existing records.
- **Mutation testers.** After a mutation tester stops early, compare every touched file with its start hash and restore from its backup.
- **Network.** No network beyond what the environment needs; agents never use `npx` or fetch packages. Never read keys, IdentityFile or known-hosts. Keep secrets and machine paths out of tracked files.
- **Protected files.** Never touch the untracked files `docs/target-system-current-2026-09-29.png`, `docs/target-system-current-2026-09-30.png` and `scripts/build-spt-exit-diagnostic.mjs`.
- **Product limits.** Spot/Paper only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT. No deploy, migration, restart, production config change, campaign, Live, guard reset or Best Inputs apply without an explicit owner GO. Host or VPS work goes only through the single operations worker after a fresh health check and a fresh bounded GO, and a cloud session never does host work.

## Usage at handoff

At 02:50Z on 2026-10-21 the 5-hour window was 11% used and the weekly all-models window 74% used (Fable bucket 17%). The weekly reset is 09:00Z the same day. The owner's floor is 2%: at the floor, stop admitting work, checkpoint and tell the owner, who may apply a Full Reset.
