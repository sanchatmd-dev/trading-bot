# L10 REPIN-3 release packet: one staging pin for the API, trading worker and research worker (draft r0)

Packet ID: S6-STAGING-REPIN-3. Status: draft r0, written by the architecture auditor (Opus 5.5 / high). It has not been reviewed or installed, and nothing has run. It contains no GO, moves no credit and authorizes no host step. Root decides on every item. All facts were read at HEAD `65e2c7f` from Git blobs and tracked docs. No host fact was observed, so every host fact below is UNKNOWN until an operations read under a GO.

## 0. Verdict

**Ready to build locally. Not ready for any GO.**

**What Root can do now, with no GO.**
- Write the A0 record from Git blobs only. It covers the pin facts, the closures, the engine identity table, the environment-key sets, the startup-assert difference and the M7/M9 compatibility matrix.
- Review and install this packet.
- Build and seal the three tool lanes of section 3.
- Write and land the targeted QR-3 grant product code. This is needed only for H7.
- Run the real-adapter rehearsal on a throwaway local PostgreSQL cluster.
- Read CI on the pin commit. All 9 checks must pass.
- Sync the Roadmap and Time Management.
- Prepare the owner question list in section 8, items U1 to U6.

**Owner GOs, in order. Each GO has one effect.**
1. **H1 GO-REPIN3-A1.** Stage the REPIN-3 trees inert on staging for the API, the trading worker and the research worker. The gate runs read-only reads, including a read of the research job states. No unit changes. **Credit: none (this is a prerequisite).**
2. **H2 GO-REPIN3-A2.** Pair switch: the API moves from `75c7a5b` and the trading worker from `ba1a433`, both to the REPIN-3 pin. It runs the immediate and delayed checks, then the owner browser check, then A2M under the same GO. Spot/Paper only, and both QR-3 flags stay off. **Credit: none by itself.**
   - H2 is the precondition for owner journey O7, which can move F02-02 T and P02-01 T. That needs the owner's ten-input readback, not REPIN-3 itself (SB170).
   - F10-01 cannot move. Full S5 (L5) is not in HEAD, so it moves only if L5 lands in the pin before the freeze.
   - F10-02 cannot move, because both flags are off and V is 0.
3. **H3 GO-RW-D1.** Start the staging research worker on the REPIN-3 tree in FOUNDATION mode with the D1 stop checks, run one bounded cancel-and-stop job, and read back. No optimizer loop, no campaign, and the research flags stay as ruled. **Credit: F06-01 T from 0 to 1 is a candidate.** For P05-01 T from 0 to 1, Root must first rule whether a tool-driven cancel counts as the "staging owner journey" (U5). If it does not, P05-01 T needs a further GO that opens owner research admission on the API for a bounded window.
4. **H7 is two GOs, not one.** The plan row H7 under-counts it.
   - **H7a GO-QR3-B:** an online backup plus restore verification. The B1 dump from 2026-11-04 is past its 72-hour limit.
   - **H7b GO-QR3-M:** an offline window that installs M7 (exposure register), then M9 (QR-3 comparison tables), then the targeted runtime grants, with `--inspect` after each.
   - **Credit: none now.** Under the cumulative rule F10-02 T needs I and V first; I can reach 1 at the S5 scorecard (RR-7), but V is 0. T also needs a real staging comparison, which needs both flags on (a further GO-QR3-ON) after V.
   - **Blocker for Root first:** contract row RC-C36 requires one data-model window that covers the QR-1b freeze (set C), the register, the QR-3 tables and the grant reapply, under one owner GO that names every step. H7 as a separate window conflicts with RC-C36 (section 8, U4).

**Contingent rollback GOs, typed only if needed:** GO-RA3, GO-RWR and GO-QMR. GO-AR3 is a read-only reference reading, used only after drift or past the 6-hour age rule.

**Corrections to plan.md section 3b:**
- The H2 row should not list F10-01 or F10-02.
- The H7 row should list no credit now.
- H7 needs two GOs.
- The plan's L10 row says "full S5" ships. It does not, unless L5 lands first.

## 1. Change set between the staging pins and HEAD

**Staging today, from tracked records:**
- API: `75c7a5b`, with the REPIN-2 layer, QR-2 flag effective 1, and M6 plus its exact grant (set B).
- Trading worker: `ba1a433`.
- Research worker: stopped on `eb532ff` since 2026-10-09, without the D1 stop checks (E109 section 4).

`ba1a433` is an ancestor of `75c7a5b`, and `75c7a5b` is an ancestor of HEAD. The forbidden ancestor `a877733` is not an ancestor of HEAD.

**Candidate pin:** `65e2c7f` (HEAD; docs only after `0fe7644`), or a later commit that is CI-green and Root-accepted. Root sets the pin only after reading CI 9 of 9 on it. Any change of the pin after a GO voids that GO.

**Commits:** 40 since `75c7a5b`. 12 of them touch runtime paths:

| Family | Commits | Runtime paths | Unit closure hit |
| --- | --- | --- | --- |
| QR-2 read path (b-1a, b-1b, b-2) | 898b067, cc74538, 39c7ced | src/portfolio/qr2-coverage-limits.js (new chunk constant 4096 only; budgets unchanged), qr2-coverage-snapshot.js, src/postgres/qr2-coverage-reader.js | API |
| Set B tools | 91ea49e, 4d49659 | scripts/grant-paper-capital-model-runtime.mjs, src/postgres/paper-capital-model-grants.js, paper-capital-model-grant-state.js | none (A0 confirms) |
| v3 trace profile (L6) | faa3179 | src/postgres/quant-research.js, quant-library.js, src/quant-library/trace-reproduction.js, src/quant-research/research-contract-v3.js, runtime-engine-files.js, quant_lab/src/robot_quant/research_engine.py | API and research; engine closure |
| QR-3 finalizer (L8-A) | 0d51ed3 | src/postgres/comparison-finalizer.js, comparison-store.js | API and research (through the wiring) |
| QR-3 owner API (L8-B) | ce66c78 | src/postgres/qr3-routes.js, qr3-participant-context.js, server.js | API |
| QR-3 wiring (L8-W, OG-1) | 0fe7644 | src/postgres/qr3-comparison-wiring.js, qr3-routes.js, quant-research-main.js, server.js, runtime-engine-files.js (manifest plus 6 entries) | API and research; engine closure |
| Thai text | 4dc9fbd, 32ec0d8 | public/i18n.js, public/index.html | API (served) |
| QR-3 UI (L8-C) | 32ec0d8 | public/qr3-comparison.js (new), public/research-library.js | API (served) |
| F09 build service (L7) | f38048b | src/postgres/bi-package-store.js | none: unwired; imported by no root |

**Closure scan.** This is the auditor's relative-import walk; A0 derives the exact counts.
- Trading worker, from worker-main.js: 38 files at `ba1a433`, `75c7a5b` and HEAD. No file differs.
- API, from server.js: 145 files at `75c7a5b`, 154 at HEAD. 13 files changed since `75c7a5b` and 19 since `ba1a433`. The new members are the QR-3 route, wiring, store and finalizer modules plus research-contract-v3. They are imported statically even when the flag is off. The new modules show only frozen constants at top level (no top-level await), so nothing is computed at import. A0 confirms this.
- Research worker, from quant-research-main.js: 96 files at `ba1a433`, 103 at HEAD, with 7 changed. Against the running `eb532ff` tree, the whole closure is different (418 commits).

**Byte-equal from `75c7a5b` to HEAD:** schema.sql, src/config.js, worker-main.js, db.js, paper-ledger-fence.js, the M6 SQL, migration and rollback files, and qr2-capital-model-route.js. So set B RS and RB stay compatible.

**Dependencies.** package.json, the lock file, quant_lab pyproject.toml and uv.lock are unchanged since `ba1a433`. Since `eb532ff`, only the package.json test script changed. N3 holds, and the P1 a02 dependency archive is reusable subject to A0.

**Environment keys.**
- API adds `QR3_COMPARISON_ENABLED`.
- Research worker adds `QUANT_FIXED_EVAL_ENABLED` and `QR3_COMPARISON_ENABLED`.
- Both are on only when exactly '1', so absent means off.

**Re-map against the REPIN-2 rules (section 2.4):**
- server.js changed: a new route set and a new environment key. That is case 1, so the REPIN-2 API-only shortcut is void and REPIN-3 uses the full form.
- Case 5 (public): new cache tokens, and qr3-comparison.js joins the served list.
- Case 7 (QR-2 read path).
- Case 4 check: budgets are unchanged, so no range newly computes. The reader method did change (keyset chunks, cooperative build), so Root re-measures RC-Q36 memory and time at A0 and A2M.
- Pair test: the worker closure is blob-equal, so code alone would allow the API to move by itself. The owner goal is one pin for all units, so H2 moves both (U2).

**Migrations.**
- The tree changes no SQL file, migration or schema between `ba1a433` and HEAD.
- The QR-3 comparison tables are M9: quant-comparison.sql, with 8 tables, 13 functions, insert-only and serializable triggers, and marker table `quant_comparison_schema` version 1. They are in both staging trees already, but are not installed on staging (set D, E109 section 5).
- The M9 migration refuses unless `quant_job_schema` version 1 exists and **M7 (exposure register) is INSTALLED** (quant-comparison-migration.js:196-204). So H7 installs M7 and then M9. Both need SELECT and INSERT runtime grants.
- The repository grant script stays forbidden, because it conflicts with staging grants v4. H7 therefore needs a new targeted grant and revoke tool for M7 and M9 in the set B pattern (91ea49e, 4d49659). This is tracked product code.
- An installed but ungranted register makes the Quant Library detail and compare views fail closed. The grant must therefore land in the same window as M7.
- M7 and M9 each refuse rollback once a row exists. With both flags off nothing writes rows, so the rollback stays data-safe while the flags stay off.
- Not needed: M8 (bi tables, F09 unwired) and set C (H4).

## 2. Engine identity consequences

**Rotations at HEAD.**
- L6 rotated 7 of 9 identities: legacy, foundation, fixed-eval, mp-combined, ingestion, pf2-engine and trace (SB175).
- L8-W rotated foundation (6ac76700), ingestion (7f6b48aa), pf2_engine (43340272) and fixed_eval (af986ecb), and newly pinned mp-combined (2e31e235) (SB187).
- The staging FOUNDATION identity on the research tree is 07b1eea8, a different value (P05-01 sourceIdentity).
- A0 derives the full table at the pin against `eb532ff`, `ba1a433` and `75c7a5b` from Git blobs. It uses two independent derivations and LF reads.

**Consequences on staging. These are the owner-accepted consequences of SB172 and SB184.**
- Queued or checkpointed foundation jobs that bind the old engine fail closed after the switch (AUTHORIZATION_REVOKED or FOUNDATION_FORBIDDEN). Legacy checkpoints refuse with QUANT_ENGINE_CHANGED.
- Stored v1 runs can no longer be trace-reproduced or built into a package through S3. Stored multi-Pine fixture runs cannot build.
- Comparisons frozen before the rotation become unevaluable. None exist on staging, because M9 is absent.
- Real v3 runs stay refused, because no production capability reader exists. v1 admission continues (Q8).
- No stored hash is rewritten. Old terminal evidence stays immutable, and exact replay may be unavailable.

**Drain or cancel is the owner's choice (U1).** The research worker has been stopped since 2026-10-09 and the admission flags are 0, so the expected in-flight set is empty, or holds stale R7B-era rows. The H1 gate reads the counts read-only. Options:
- **(a) Drain on the old tree first.** This needs its own GO to start the `eb532ff` worker, which lacks the D1 checks. Not recommended.
- **(b) Explicit cancel through the existing cancellation protocol before H3.** Affected runs are recorded and never classed as success. This needs an operator-tool step, because the API research routes are closed.
- **(c) Let the REPIN-3 worker fail them closed at start, and record each one.**
- If H1 reads zero in-flight rows, the choice is moot and Root records "none".

**Other consequences.**
- **EM3 N5:** REPIN-3 before the R7 epoch allowlist forces an EM3 baseline re-pin. That is a regeneration of one generated block, before H8.
- **SB180 row 21 / N1(a):** EM3 needs a separate research-tree install packet under its own GO before any epoch. H1 plus H3 can serve as that packet if A0 shows the EM3 subset rule passes on the REPIN-3 research tree. Root rules on this.
- **RR-F3 (L11-B):** after H1 to H3 and H7, L11-B can carry by blob equality.

## 3. Tools to build and seal locally

Every tool follows the one-use runner pattern of main packet section 7: manifest, consumed marker, nonce, receipt, envelope, retained output, a 120-second Root argv GO window, a host progress record before each effect, the lost-receipt wait, and the termination rule. Each tool pins this packet's LF blob sha plus the hashes of the main, follow-up, collector, REPIN-2 and set B r7 packets. No tool runs the repository grant script, a reload outside its named step, or any production unit command. Production identity is checked before and after every effect.

**Lane T1: switch family. Rebuilt from REPIN-2 A1/A2RA plus the main packet P1/P4 worker form plus the set B lane.**
- **A1 (H1).** Transport one package and stage inert trees for the API, the trading worker and the research worker. Whether the API and the worker share one tree follows the P1 precedent; A0 states it.
- **A1 gate (read-only).**
  - Host health floors, free disk for three trees, the logout-kill setting, no pending manager job.
  - Production identity.
  - The drop-in and environment digests against the set B end state.
  - The AR-form process export of all units.
  - Database reads: schema 14, fence INSTALLED, M6 INSTALLED with grant EXACT, `quant_job_schema` version, M7 and M9 `--inspect` (expected ABSENT), research job-state counts by status and engine-hash class, and the research unit's drop-in and environment-key digests.
- **A1 returns** the layer-name booleans for all three units. It keeps the family-token marker naming of RP3 and RP4.
- **A2 (H2): pair switch in the P4 order.**
  1. Stop the trading worker, then stop the API, with proved stops (90-second stop-timeout gate).
  2. Add one drop-in layer per unit, sorting last.
  3. Run one manager reload (host-wide).
  4. Start the API, then the trading worker.
  5. Pass the loaded-configuration gate. QR-2 effective 1; QR-3 and the five research flags 0.
  6. Check worker readiness: heartbeat, no fence, replication-role or schema refusal.
  7. Run the immediate checks, then the delayed check at about 300 seconds.
  8. Write the AR-form export.
  9. Unwind in-run before readiness.
  10. Keep the two-way hooks-and-links rule, extended to the research unit.
- **A2M.** A read-only memory read after the owner browser steps: API resident memory, host available memory, the QR-2 worker thread, and the RC-Q36 re-measure.
- **AR3.** A read-only reference reading.
- **RA3.** Archive the REPIN-3 layers. The API returns to the REPIN-2 layer (`75c7a5b`) and the trading worker to its P4 layer (`ba1a433`), with one reload. It must handle every recognised layer state that A2 can leave, the lost-receipt case and the market-change stops. The REPIN-2 RA is retired while the REPIN-3 layer is live, by the supersede rule of REPIN-2 section 2.4.

**Lane T2: research family. New, and the highest risk.**
- **RW (H3).** Gate:
  - The research unit is inactive.
  - The staged REPIN-3 research tree is exact.
  - The environment-key set equals the A0 set; the two new keys are absent or 0.
  - The HEAD startup asserts are satisfied: Linux resource isolation, the worker-unit assertion, health limits and the local health probe, dataset-root ownership, `quant_job_schema` version 1, and the foundation marker tables.
  - The capacity and recovery policy files are present when the profile v2 or Preflight flags require them.
- **RW effects.**
  1. Add one research drop-in layer and run one reload.
  2. Start the worker and prove readiness.
  3. **J1:** enqueue one bounded, labelled, zero-search-space foundation job (10K bars or fewer, the narrow profile) through the operator path ruled in U5. Cancel it after the first chunk and read back the terminal CANCELLED state with no later chunk.
  4. **J2:** enqueue a second job. Send a graceful SIGTERM to the worker mid-chunk. Read back that the D1 stop is terminal: no resume, no chunk or FINISH commit after the stop. Restart, prove readiness, and read back that J2 is not resumed.
  5. End state, per owner choice U3: worker stopped again (default), or idle with admission closed.
- **RWR.** Stop the research worker and archive its layer. The research unit returns to stopped on `eb532ff`.
- **Note on set C.** After set C E3 lands, an `eb532ff` research tree refuses the foundation migration (main packet section 5, set C row). RWR is valid only before H4, or with E3 rolled back first.

**Lane T3: H7 family. Rebuilt from set B B1, B2 and RB.**
- **QB (H7a).** Online backup, then restore verification into a throwaway cluster, with the dump name pinned by job, attempt and sequence. The dump must be 72 hours old or less at GO-QR3-M.
- **QM (H7b), in the B2 window form:**
  1. Gate reads: M7 and M9 ABSENT, research worker inactive, lock holders.
  2. Stop the trading worker, then the API.
  3. Window dump.
  4. Install M7 on the migration selector. Run `--inspect`.
  5. Install M9. Run `--inspect`.
  6. Run the targeted grant (new product tool). Expect EXACT for both.
  7. Check the pre-change ACL digest for unrelated objects.
  8. Start the API, then the worker.
  9. Run the immediate and delayed checks.
  10. Write the post-window dump and the AR-form export.
  - Both QR-3 flags stay 0.
- **QMR.** Revoke, then roll back M9, then roll back M7. This is valid only while both are empty.
- **New product code, coder lane plus CI:** a quant-comparison grant module, a CLI script, a grant-state read, and tests including a real-cluster ACL test.

**Rehearsal, alone on the machine, PostgreSQL in the foreground, on a throwaway local cluster.**
- **Real adapters:** each tool runs at least once through the real dependency builder and the real adapter factory, with the real bound shape and no injected adapters. A discriminating test must fail on a deliberately mis-wired build. This is the lesson of B0 a01 and B2 a01.
- **Database fixture:** staging-shaped schema 14, FOUNDATION mode, fence, M6 plus exact grant, the roles of grants v4, and a sanitized row set sized from the H1 job-state counts.
- **Unit manager:** a recorded-transcript fake. Host units cannot run locally.
- **The RW foundation path:** it refuses on any platform other than Linux, so it cannot run on this Windows machine. Its rehearsal is either the CI Linux PostgreSQL job running the D1 graceful-stop and contract-guard tests at the pin, plus the tool logic against the real database adapter with a platform seam; or a sanitized Linux bundle. U7 records this gap.
- **The M7 and M9 compatibility matrix:** the `75c7a5b` and HEAD API and research closures start and serve with M7 and M9 ABSENT, INSTALLED-and-granted, and INSTALLED-and-ungranted (expected fail-closed views).

## 4. GO line drafts (TEMPLATE - NOT A GO)

Root fills the pin, the attempt, the job references and the notAfter, and the owner types each line. Preconditions for every line:
- a fresh host health read (G-FRESH-HEALTH is UNKNOWN);
- the owner awake and reachable for the whole window, able to stop staging (memory rule "GO reachability item 3");
- Browser 1 for any owner browser step;
- a quiet slot: no other host job, no R7 epoch, no local timing suite;
- the current usage band;
- tools sealed and accepted, and the A0 record pinned.

**H1**
> TEMPLATE - NOT A GO. GO S6-STAGING-REPIN-3 A1 attempt a01 for Staging QL-P2 Prototype only, REPIN-3 pin [pin] (includes trace v3: yes; QR-2 b-2: yes; QR-3 API, UI and wiring with both flags off: yes; F09 build service unwired: yes): in one SSH session with the reviewed tool, read only first, check the host health floors, the logout-kill setting, the manager state, production identity, the drop-in and environment digests against the set B end state, the process references, and the database state including the research job counts; then stage the REPIN-3 trees for the staging API, trading worker and research worker inert. Nothing starts, stops or reloads. notAfter [UTC].

**H2**
> TEMPLATE - NOT A GO. GO S6-STAGING-REPIN-3 A2 attempt a01 for Staging QL-P2 Prototype only, REPIN-3 pin [pin], trees from A1 job [ref]: switch the staging API from 75c7a5b and the trading worker from ba1a433 to the pin, with stop proofs, one layer each, one manager reload, start, the loaded-configuration gate (QR-2 effective 1, QR-3 and the five research flags 0), immediate checks and a delayed check; in-run unwind before readiness; research worker untouched and stopped; Spot/Paper only, Live locked; then, after my browser steps, the read-only A2M under this GO. Rollback is GO-RA3 only. notAfter [UTC].

**H3**
> TEMPLATE - NOT A GO. GO S6-STAGING-REPIN-3 RW attempt a01 for Staging QL-P2 Prototype only, research tree from A1 job [ref] at pin [pin]: add one research layer, one manager reload, start the research worker in FOUNDATION mode with the D1 stop checks, run job J1 (cancel after the first chunk) and job J2 (graceful stop mid-chunk, restart, no resume), each bounded, labelled, zero search space and within 10K bars; no optimizer loop, no campaign, no admission change unless ruled; old-engine rows handled per my choice [drain | cancel | fail-closed]; end state [stopped | idle with admission closed]. Rollback is GO-RWR. notAfter [UTC].

**H7a**
> TEMPLATE - NOT A GO. GO S6-STAGING-QR3-B attempt a01 for Staging QL-P2 Prototype only, pin [pin]: an online backup of the staging database to the protected backup place and restore verification into a throwaway cluster. No unit change, no migration. This uses the migration connection selector read-only. notAfter [UTC].

**H7b**
> TEMPLATE - NOT A GO. GO S6-STAGING-QR3-M attempt a01 for Staging QL-P2 Prototype only, pin [pin], under Root ruling [RC-C36 split | merged with set C]: an offline window; stop the trading worker and then the API with proofs; window dump; install M7 (exposure register), then M9 (QR-3 comparison tables), each with --inspect; the targeted runtime grant, EXACT; restart the API and the worker READY; immediate and delayed checks; post-window dump; both QR-3 flags stay 0; research worker stays as H3 left it. This uses the migration connection selector. Rollback is GO-QMR while the tables are empty. notAfter [UTC].

## 5. Files and writers

One writer per file:
- **A0 record and acceptance records:** Root, under `.qa-local/s6-staging-repin3-a0-2026-11-07/`.
- **Packet:** the architecture auditor drafts r1 under `.qa-local/s6-staging-repin3-design-2026-11-07/`. After acceptance, Sonnet documentation installs it as `docs/S6_STAGING_REPIN_3_PACKET_<date>.md` (CRLF, no private values).
- **Tool lanes T1, T2 and T3:** each has its own build folder `.qa-local/s6-staging-repin3-build-<t1|t2|t3>-2026-11-07/` and its own review folder. The writer is the coder of that lane only.
- **Product code for T3:** new `src/postgres/quant-comparison-grants.js`, `src/postgres/quant-comparison-grant-state.js`, `scripts/grant-quant-comparison-runtime.mjs` and their tests. The coder writes them, and Root commits the exact paths.
- **Roadmap and Time Management sync:** Sonnet documentation, after acceptance.
- **Must not change:** any staging-pin product file, Pine, the Risk Manager, Live gates, flags, budgets, the REPIN-2 and set B sealed tools, and their packets.

## 6. Review panel

Fable 5.1 is paused, so a second Opus 5.5 / high auditor substitutes, recorded in each packet.
- **This packet:** architecture auditor (Opus high) plus the second Opus (GO packet). Fix rounds re-check only the changes.
- **T1:** coder (Sonnet high), tester (Sonnet medium), Opus auditor (high), plus the second Opus for A2 and RA3.
- **T2:** debugger-grade implementer (Opus medium, research recovery and fencing risk), tester (Sonnet medium), Opus auditor (high), plus the second Opus.
- **T3:** coder (Sonnet high) for the tools and the grant product code, tester (Sonnet medium) with a real-cluster ACL check, Opus auditor (high), plus the second Opus. CI 9 of 9 on the commit.
- **Rehearsal:** a Sonnet tester, alone on the machine. Root reviews.
- Mutation runs and test-running reviewers never run in parallel on one checkout. No reviewer grants acceptance.

## 7. Size and order

**Size L.** These are estimates, not measured; REPIN-2 took about 1.5 days and set B about 3.5 days. The local work for T1 and T2 is about 2 to 4 days. T3 plus the grant code is about 2 to 3 days more. Host windows, without the GO waits:
- H1: about 10 to 20 minutes.
- H2: about 30 to 60 minutes, including the browser check and A2M. The API and worker gap is about 20 to 40 seconds.
- H3: about 30 to 90 minutes.
- H7a: about 15 minutes.
- H7b: about 20 to 40 minutes.

**Order:**
1. CI on the pin.
2. A0.
3. Packet r1 review and install.
4. T1 and T2 in parallel (separate packages), then the rehearsal.
5. Owner answers U1 to U6.
6. H1.
7. H2, then the owner browser check, including the QR-3 panel unavailable state and the Thai text, then A2M.
8. H3.
9. T3 build, RC-C36 ruling, H7a, then H7b, after H2 is accepted. H7b runs as its own window, not inside H2's window, under the one-effect rule.
10. EM3 baseline re-pin, before H8.

## 8. Unknowns and open decisions

- **U1 (owner): drain, cancel or fail-closed** for old-engine research rows. The counts are unknown until the H1 gate reads them.
- **U2 (owner): trading worker move.** Move the trading worker to the pin (one pin, one restart, code-neutral because the closure is blob-equal), or keep it on `ba1a433`.
- **U3 (owner): research worker end state after H3.**
- **U4 (Root): RC-C36.** Amend RC-C36, which Root owns, to allow an M7 and M9 window before set C, or merge H7 into H4 after owner decisions D1 to D4. Owner decisions D1 to D4 are not the "D1 stop checks".
- **U5 (Root): the H3 job path.** Either an operator-tool enqueue and cancel, or opening owner research admission on the API for a bounded window (an extra GO). Also whether P05-01 T needs the owner UI journey.
- **U6 (owner): Thai review.** The Thai review OD-C19 of the 129 QR-3 pairs in `32ec0d8` is pending. Only the 48 pairs of `4dc9fbd` are approved (SB178). It must be done before H2.
- **U7: the RW foundation path cannot be rehearsed on the local Windows machine.** Root picks the CI or sanitized-Linux route.
- **U8: staging facts unknown:**
  - host health and memory headroom with 9 more API modules;
  - the research unit's drop-ins, environment, Python environment and dataset root;
  - whether HEAD's research startup asserts pass against the `eb532ff` configuration;
  - the `quant_job_schema` version and the M7 state;
  - free disk for three trees.
- **U9: CI on `65e2c7f`** has not been read in this packet. The S5 full-suite note in SB187 was not finished locally.
- **U10: the F06-01 V carry.** quant-research.js changed (v3 selector R5), while the D1 foundation files are unchanged. The scorer must classify this under Rule C3 before T moves.
- **U11: pin timing.** If L5 (full S5) or L11 is to ride REPIN-3, the pin waits. Otherwise both go to a later re-pin.
- **U12: usage band** at each dispatch. Unknown here.