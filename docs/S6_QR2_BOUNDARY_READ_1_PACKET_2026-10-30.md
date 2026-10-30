# S6 QR-2 staging boundary read-only packet

Proposed packet ID: **S6-QR2-BOUNDARY-READ-1**. Job: **BR**. Owner GO name: **GO-BR**. Status: **REVIEWED AND ACCEPTED FOR THE GO-BR REQUEST (Root ruling BR5, 2026-10-30); NOT RUN; NO GO**.

Author: architecture auditor (Opus 5.5 / high), child of "Root: astra-vps-trade-bot-v2", 30 October 2026; fix rounds 1 and 2 by the coder (Sonnet 5.5 / high); worktree HEAD 3abc69e. This is the installed revision 1 of the packet. Reviews: second opinion (Opus 5.5 / high, substituting the paused Fable 5.1), architecture auditor rounds 2 and 3, tester round 3; Root accepted the tool and the packet for the GO-BR request in ruling BR5. This packet grants no access and records no GO. Companion files `queries.sql` (the frozen statement texts of the tool, generated from the build, no host values) and `tool-plan.md` (the first tool plan, superseded by the build and `queries.sql`) stay in the ignored packet and build folders under `.qa-local/`. Rulings BR1 to BR5 are in `root-ruling-br1.md` in the ignored packet folder; fix rounds 1 and 2 applied BR3 and BR4 to the tool, `queries.sql` and this packet. `PACKET_SHA` of the tool is the SHA-256 of this file as committed (LF line endings).

## Owner summary

Bots 2 and 3 show "reconciliation failed" because staging has no boundary record: the replay cannot tell which ledger rule booked each fill. A draft record exists (`.qa-local/qr2-staging-boundary-2026-10-30/`). It rests on deployment records, but four facts can only come from the staging database: whether any fill is older than the draft start, whether any fill falls inside the 12-second worker switch, whether the ledger-rule markers agree with the draft epochs, and whether anything booked fills while no trading worker ran.

This packet reads those facts once, read only, in one SSH session and one read-only database transaction. It returns counts, times and marker labels only, never an account identifier, email, key, price or quantity. Nothing starts, stops, restarts or changes, and production is untouched. One GO (GO-BR) covers it. After the result, Root fixes the record values; wiring the record into the API and moving staging to it are later steps with their own GOs.

## 1. Purpose and boundary

Settle the unknowns of the drafted staging boundary record (proposal section "Unknowns + read shapes"):

- **U1** earliest fill per Bot and the count before the E0 start;
- **U2** fills in the 12.248 s switch gap and up to the first O3 check, with markers;
- **U4** marker counts per draft epoch;
- **U7** no unexplained fill between the 4d86822 worker stop and the E2 start (a fill inside the E2 switch window by the new worker is expected, section 6), and that stop time as far as it is readable without new privileges;
- **U5, U6, U8** as ride-alongs in the same read-only transaction at no extra privilege.

U3 (worker revision history before 1 October) is out of scope. It is needed only if U1 finds fills before the E0 start, and then needs its own packet.

Boundary: one designated operations worker, alone, serial, outside any workflow. One SSH session, the reviewed tool, the existing migration connection selector of the B2 Window 2 precedent (ruling D4(a)) and the database driver loaded from the staged `ba1a433` tree of P1, as in P0c. No environment-source read. No unit command. No write anywhere in the database. No lasting host file (bash may keep the tool input in a private temporary file that it removes at once). There is no journal read (ruling R-J: no); the host region has no process-spawn site.

## 2. Facts used (tracked or Root-accepted)

- Epoch of a fill = `fills.received_at` against the per-environment record; the marker is corroboration only (contract 6.2; `src/portfolio/qr2-boundaries.js`). `received_at` is `Date.now()` at the booking INSERT in `recordExecution` (`src/postgres/ledger.js` line 274); only the trading worker books.
- The replay scope is `(signals.user_id, signals.broker)` over all fills, ordered by `received_at, signal_id, cumulative_quantity` (`src/postgres/qr2-reader.js` lines 242-245). The marker is `markerOf(signals.broker_response)` (lines 66-72): non-string, empty, unparsable, non-object or non-string `ledgerRule` gives null.
- Lot binding L1 and the lot price formula: `src/portfolio/qr2-replay.js` lines 69-107 (`fillQuote`, `amount` = 18 places ROUND_HALF_EVEN).
- Draft instants (epoch ms): E0 from 1790871360000 (2026-10-01T16:16:00.000Z); gap [1792016261152, 1792016273400) (2026-10-14T22:17:41.152Z to 22:17:53.400Z); first O3 check 1792016344757 (DP1S `post0.finished` 2026-10-14T22:19:04.757Z, `o3RuleFills` 0); E1/E2 edge 1792990177825 (P4 x4 a02 pre-switch backup 2026-10-26T04:49:37.825Z); worker running by 1792990192453 (P4 x4 a02 runner end 04:49:52.453Z). P2 Bot first fill: signal 66, cumulative 0.01179, 1791028922172.
- `worker_heartbeats` rows are deleted on a clean worker stop (`src/postgres/worker.js` line 141); a left-over row means an unclean stop.
- `signals.processed_at` is written by `persistIntent` (worker, with `order_intent`) and by the store's final update (`src/postgres/store.js` line 168).
- The P0c tool ran read only through the same selector on 26 October 2026 (P0C_PASS).

## 3. Preconditions and admission items (Root, before dispatch)

1. Root has accepted the boundary proposal's mapping logic (trading worker only; ledger blob equality, not ancestry) and the draft instants that the manifest pins.
2. The BR tool is built, independently reviewed (section 11) and accepted; the payload-size run and a **dry admission** with the real binding and the real job id pass. The dry admission renders a maximal synthetic success frame (every head key, every block key and every label, the real job id, nonce and manifest hash shapes, ISO stamps) and runs the host's own secret-echo check against the real private strings (database name, role, socket, stage and data directories, selector URL). Any hit refuses admission and Root changes the job id or the rules, because the same hit on the real success frame would drop every block after the read and spend the GO. The tool repeats the check inside admission before the marker (refusal `SECRET_ECHO_DRY`, zero host contact).
3. Owner GO-BR naming this packet, its attempt id and a `notAfter`. More than 24 hours between GO and dispatch: Root asks the owner to re-confirm.
4. Root GO window per job (120 s window, age at most 60 s, at least 45 s left, at admission and again before the marker), fresh one-use manifest, start-by at most 10 minutes after dispatch, fresh 16-byte nonce.
5. Root searches every local checkout for an earlier BR manifest or marker; one found stops admission.
6. No other S6 job is in flight and no S6 GO is open (Root record check). No offline window or migration is pending, so no DDL can hold a lock the read waits on.
7. Usage: Root reads usage first; this read-only job follows the AGENTS.md bands (one tiny task above 3%; none at or below 3% or with all usage unknown).
8. The private binding's selector, stage directory and database identity values are taken from the accepted P0b/P0c private records; Root records that no later record changed them (open question Q1).

## 4. Session stages

1. **S0 bound.** Validate the bound object (shape, pin `ba1a433`, nonce, host deadline); Node major 24.
2. **D0 driver.** Load `pg` from the staged `p1-ba1a433` tree; its real path must stay inside that tree's `node_modules`, else stop `PG_OUTSIDE_TREE`.
3. **D1 database.** One connection through the selector (`application_name` `s6_qr2_br_db`), `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL statement_timeout = 10 s`, `lock_timeout = 1 s`, `idle_in_transaction_session_timeout = 20 s`, `SET LOCAL search_path = pg_catalog` (every relation in the texts is `public.`-qualified), then Q0 to Q5 in order (each validated in process before the next), then `ROLLBACK` and close on every path. One snapshot covers all six queries, so the counts agree with each other.
4. **Frame.** One public frame (no private frame). The runner validates it strictly and writes envelope, retained output and receipt.

## 5. Queries and expected outputs

Full shapes are in `queries.sql`. Scope rows carry ordinals only: `scope_ord` (by first fill time), `owner_ord`, `broker_ord`, the Bot `slot` (1 to 5) and `is_child`. The Bot `slot` equals the number the owner sees in the UI (confirmed from `public/bots.js`, `public/overview.js` and `src/postgres/store.js`; the label text is editable and is never returned). No user id, email, label, broker string, signal id or row value is returned.

| Query | Returns | Expected if the draft holds |
| --- | --- | --- |
| Q0 identity and schema | `ro` on, PostgreSQL major, three identity booleans compared inside the database, schema version, required column count (37), heartbeat table present, `observed_at_ms` | `on`, 16, true/true/true, 14, 37, true |
| Q1 scopes (U1, P2 anchor) | per scope: fills, buys, sells, non-Paper count, first and last fill time, pre-E0 count and last pre-E0 time, `first_is_p2_key`, `has_p2_signal`, `legacy_open` | `pre_e0` 0 in every scope; the slot-3 scope `first_is_p2_key` true with first time 1791028922172; `has_p2_signal` true in exactly one scope (a cross rule: the signal is one row of one scope); `non_paper` 0 |
| Q2 edges (U2) | for each edge (E0 start, gap start, gap end, E2 start): last fill before and first fill at or after, with time, side, marker, bucket, scope ordinal | before gap: marker ABSENT; first after gap: O3V1 at or after the gap end; last before E2: O3V1 or ABSENT; first at or after E2_FROM: V2, and it may lie before 1792990192453 (the new worker books the waiting backlog inside the switch window) |
| Q3 cells (U2, U4, U7, U8) | non-empty cells of scope x bucket x side x marker: count, min and max time, distinct signals | no PRE_E0 or GAP cell; E0 cells ABSENT; E1_EARLY and E1 cells O3V1; E2_SWITCH cells (if any) V2 only; E2 cells V2; no UNPARSED or OTHER |
| Q4 worker activity (U7, U8) | last worker-intent `processed_at` before E2, backlog count, first time, scope count (`backlog_scopes`) and later fills (`fills_after_backlog_start`) of signals that waited for E2, the subset of those fills whose signal has no worker intent (`late_fills_no_intent`), `cross_bucket_signals` (signals whose fills fall in more than one bucket), left-over heartbeat count and min/max `last_tick`, other-role and total heartbeat counts, orphan-lot scope count | backlog 0 or first backlog time after the last E1 fill; `late_fills_no_intent` 0; left-over heartbeats 0 or 1 (an unclean 4d86822 stop gives one with `last_tick` near T8) |
| Q5 lots (U5, U6) | per scope: lot count, first and last lot time, BUY and SELL fills before the first lot, simple-pair price classes (WITH_FEE, WITHOUT_FEE, NEITHER, TIE, NO_QUOTE), quantity mismatches, lot signals not checked | WITHOUT_FEE, NEITHER, TIE and quantity mismatches 0; BUY/SELL before the first lot 0 inside E0 |

## 6. How each output fills or refutes the draft record

| Draft value | Confirmed when | Refuted or changed when | Root action on refutation |
| --- | --- | --- | --- |
| E0 `from` 1790871360000 | Q1 `pre_e0` 0 in every scope | any `pre_e0` > 0 | Keep the value and accept RECONCILIATION_FAILED from the earliest pre-E0 fill (honest), or open U3 as its own packet to extend E0 earlier. Never move E0 earlier without revision evidence. |
| E0 `to` / gap / E1 `from` | Q3 GAP cells absent; Q2 last-before-gap ABSENT and first-after-gap O3V1 | GAP fills exist; an O3V1 or V2 marker in an E0 cell; an ABSENT cluster just after the gap | GAP fills stay unreplayable (a narrower gap needs evidence outside this read). Markers in E0 or an ABSENT cluster after the gap: check signal-level marker overwrite (Q4 `cross_bucket_signals` above 0 means a signal has fills in more than one bucket and carries one marker for both; Q3 `signals` against `n` differs for every multi-fill signal and is not the test); if not explained, the edge is wrong and the record waits. |
| E1 `to` / E2 `from` 1792990177825 | E1 cells O3V1; E2_SWITCH and E2 cells V2; Q2 first at/after E2_FROM is V2 | an O3V1, ABSENT, UNPARSED or OTHER fill in E2_SWITCH; V2 in E1; O3V1 in E2 not explained by overwrite | **Rule before GO (E2_SWITCH):** V2-marked fills in E2_SWITCH ([E2_FROM, E2_WORKER_BY)) are the E2 worker booking the backlog (it started inside this window and books queued signals at once, so such fills are expected); the record is unchanged and E2.from stays E2_FROM. Only an O3V1, ABSENT, UNPARSED or OTHER fill there is U8 or an edge error: stop, report, no record until explained. V2 in E1 means the edge is early or a marker overwrite. |
| U7 quiet E1 tail | the Q4 bounds: last worker intent before E2 and the first backlog signal (and a left-over heartbeat) all at or before T9, `fills_after_backlog_start` 0 and `late_fills_no_intent` 0 | `late_fills_no_intent` above 0 (a fill booked inside the backlog window whose signal has no `order_intent`; the worker writes the intent in the same transaction just before every fill it books, so such a fill did not come from the worker path); a left-over heartbeat newer than the last fill by much | **Backlog rule before GO:** `fills_after_backlog_start` above 0 means a worker was booking while a backlog waited, so the backlog is owner isolation or quarantine (a suspended or isolated owner's signals stay queued while the worker books the others) and T8 stays unsettled by this read. It is never a U8 stop on its own, and `backlog_scopes` is a fact for Root, not a test. Only `late_fills_no_intent` above 0, or a marker finding in the U8 row, is a U8 sign. The record values do not depend on T8 (E1 ends at T9 by draft rule; no journal read): record the Q4 bounds in the result. Any fill booked while no worker ran is U8 and stops the record (in this read: `late_fills_no_intent` above 0, or a marker finding in the U8 row). |
| `lot_fee_boundary` null | Q5 WITHOUT_FEE 0, NEITHER 0, TIE 0 | WITHOUT_FEE > 0 | Lots priced without fee exist: a fee boundary (first b74ba50 booking) is needed; new evidence, record waits. NEITHER or TIE > 0: the replay judges; expect LOT_EPOCH_UNKNOWN or LOT_BINDING_MISMATCH for those lots. |
| `lot_table_boundary` null | Q5 BUY and SELL before the first lot 0, or only before E0 | SELL fills before the first lot inside E0 | Root decides a lot-table boundary from evidence; a BUY before the first lot is NO_LOT and not a failure. |
| U8 other writers | Q3 no UNPARSED or OTHER; Q1 `non_paper` 0; Q4 other-role heartbeats 0 and `late_fills_no_intent` 0; E2_SWITCH holds V2 fills only | any of these non-zero | Report; Root rules whether the record can ship. A non-zero `non_paper` is a count for Root to review, never a stop of the job. |
| failed_from of the P2 Bot | Q1 slot-3 scope `first_is_p2_key` true, first time 1791028922172 | false | The scope with `has_p2_signal` true (exactly one scope has it) is the P2 Bot's scope and its `owner_ord` is the owner of Bots 2 and 3, even when its earliest fill is another fill; the diagnosis key is re-derived from that earliest fill. |

Every confirmation still leaves K2 (the loaded tree equals the release record) as the residual named by the proposal.

## 7. Limits

- One attempt, one SSH session, overall at most 90 s locally; remote `timeout --signal=TERM --kill-after=10s` of 60 s; connect 5 s; database connect 5 s; each query at most 10 s (statement timeout) and 12 s (driver); lock timeout 1 s.
- Row caps: Q1 64 scopes, Q2 8 rows, Q3 512 cells, Q5 64 scopes; a row beyond a cap stops `ROW_CAP_Qn`. Output at most 128 KiB (131,072 bytes): the worst-case success frame at the row caps with the largest accepted numbers and the longest job id is under 128,300 bytes (a static test builds it and keeps it under the cap, so a read that passes the row caps always fits; a stop frame that keeps blocks is size checked too). Payload at most 192 KiB.
- Database phase: connect and all six statements share one **29 s** phase cap (database connect 5 s plus two statement bounds of 12 s). Six statements that each stay under their 10 s timeout can still stop `PHASE_TIMEOUT`; the scale rehearsal therefore records the Q0 to Q5 sum, with the bar that the sum stays under 10 s.
- Expected load and scale assumption: the staging database was 86 MiB at P0b. No tracked record states the staging fill, signal or lot row counts, so they are unknown. The tool is rehearsed locally at about 100,000 fills, 50,000 lots and 5,000 signals per scope (20 scopes); the admission bar is every statement under 2 s there, with the milliseconds of each statement recorded in the review. Q5 and the lot counts are computed in one pass (window counts per signal over the fill and lot streams, GROUP BY and FILTER aggregates, no count computed per row and no join or HAVING filter on a computed count, so the planner has no reason to nest-loop an aggregate), so the cost is linear in fills and lots. AccessShareLock only; no FOR UPDATE/SHARE, advisory lock, EXPLAIN ANALYZE, DDL, DML, temporary table, function creation, COPY or SET ROLE.

## 8. Stop conditions and outcomes

Refusals before the marker, each with zero host contact: argv, GO freshness, tool source, manifest shape and freshness, `notAfter`, pins, binding shape and pins, query-set hash, payload size, dry-admission secret echo (`SECRET_ECHO_DRY`), admission scan, existing marker or outputs, prior attempts.

After the marker, every stop code of the host (all rolled back and closed): `ARGV_NOT_ALLOWED` (a statement text outside the frozen allowlist), `BINDING_SHAPE` and `COLLECTION_UNKNOWN` (the bound object failed its own validation, or a frame could not be rendered), `BR_NODE_MAJOR` (Node major is not 24), `PRE_PG_LOAD`, `PG_LOAD` and `PG_OUTSIDE_TREE` (the driver is missing, or its real path leaves the staged tree), `DB_CONNECT` (sanitized class only), `NOT_READ_ONLY` (Q0 `ro` not on), `PG_MAJOR`, `DB_IDENTITY` (any identity boolean false), `SCHEMA_DRIFT` (column count, heartbeat table, schema version), `QUERY_Qn` (statement error or timeout, SQLSTATE class only), `QUERY_TX` (the rollback could not be confirmed, or a frame statement failed outside Q0 to Q5), `PHASE_TIMEOUT` (the 29 s database-phase cap, section 7), `ROW_CAP_Qn` (Q1, Q2, Q3, Q5), `SHAPE_Qn` (Q0 to Q5 returned an unexpected row count, key set or value), `SHAPE_CROSS` (a cross rule failed, including the P2 rule: exactly one scope holds the P2 signal; the blocks read stay in the retained output), `OUTPUT_LIMIT` (the success frame, or a stop frame that keeps blocks, is over 128 KiB and is re-rendered without blocks), `SECRET_ECHO` (a private string would appear in the frame), `DEADLINE` (host deadline), `BR_TERMINATED` (the process got SIGTERM) and `UNCLASSIFIED_STOP` (an error without a known code); transport and validation classes as P0c. Every stop rolls back and closes.

| Outcome | Meaning | Next |
| --- | --- | --- |
| `BR_PASS` | Q0 to Q5 read and validated | Root maps outputs per section 6; a finding is a fact, not a stop of the job |
| `BR_STOP_<code>` | a stage stopped | Report; no retry; a contingency attempt only after a stop before D1 started, under a new GO |
| `STOP_UNKNOWN` / `LOCAL_UNCONFIRMED` | receipt missing, shape invalid, or termination unconfirmed | Treat the database read as possibly done and the result as unknown; any further contact needs a new GO |

## 9. Result record

Ignored local evidence (execution directory): manifest, marker, receipt (job id, nonce, manifest, tool, query-set and binding hashes, UTC start/end, transport exit, stage reached, rollback status, output hash), envelope and retained output.

Tracked result (`docs/S6_QR2_BOUNDARY_READ_1_A01_RESULT_<date>.md` and `docs/evidence/S6_QR2_BOUNDARY_READ_1_A01_RESULT_<date>.json`) holds exactly these fields:

- `packetId`, `packetSha`, `attemptId`, `verdict`, `code`, `stage`, `startedUtc`, `endedUtc`, `elapsedMs`, `receiptSha256` prefix, `envelopeSha256`, `querySetSha256`, `constants` (the 8 pinned values with their tracked sources);
- `db`: `readOnly`, `pgMajor`, `identityEqual` (one boolean for the three), `schemaVersion`, `requiredColumns`, `observedAtMs`;
- `scopes[]`: `scopeOrd`, `ownerOrd`, `brokerOrd`, `slot`, `isChild`, `fills`, `buys`, `sells`, `nonPaper`, `firstAt`, `lastAt`, `preE0`, `preE0LastAt`, `firstIsP2Key`, `hasP2Signal`, `legacyOpen`;
- `edges[]`: `edge`, `sideOfEdge`, `at`, `side`, `marker`, `bucket`, `scopeOrd`;
- `cells[]`: `scopeOrd`, `bucket`, `side`, `marker`, `n`, `signals`, `minAt`, `maxAt`;
- `worker`: `lastIntentBeforeE2`, `backlogN`, `backlogFirstAt`, `backlogScopes`, `fillsAfterBacklogStart`, `lateFillsNoIntent`, `crossBucketSignals`, `hbOldN`, `hbOldMin`, `hbOldMax`, `hbOtherRoleN`, `hbN`, `orphanLotScopes`;
- `lots[]`: `scopeOrd`, `lots`, `firstLotAt`, `lastLotAt`, `buysBeforeFirstLot`, `buysBeforeFirstLotLastAt`, `sellsBeforeFirstLot`, `pairsWithFee`, `pairsWithoutFee`, `pairsNeither`, `pairsTie`, `pairsNoQuote`, `pairsQtyDiffers`, `lotSignalsNotChecked`.

Never tracked: host, path, unit, user or role names, selector values, IP addresses, account ids, emails, signal ids, prices, quantities, nonce, raw output, except the 8 pinned constants, which are copied from their tracked sources (they include one signal id and one quantity that docs/evidence already holds). The tracked JSON is the natural `evidence` path for the boundary record (or one input to the consolidated S8 evidence file); Root decides.

## 10. Named risks

- **Schema-owner connection.** The selector connects as the schema owner, more privilege than a read needs. Controls: READ ONLY transaction, fixed statement texts behind an allowlist, no `SET TRANSACTION`/`SET ROLE`. Residual: the claim "cannot write" holds for these fixed statements on the benign loaded driver.
- **Driver from the staged tree.** As in P0c and RO-2, `pg` is loaded from `p1-ba1a433`; the realpath check keeps it inside that tree, but its content is not re-hashed (open question Q2).
- **Marker granularity.** The marker sits on the signal; a signal with fills in two epochs shows one marker for both. Q4 `cross_bucket_signals` counts such signals; the boundary wins anyway.
- **markerOf parity.** `pg_input_is_valid(..., 'jsonb')` and `JSON.parse` differ on a few inputs (for example `\u0000`); such rows show as UNPARSED, a label the replay folds into null. Rehearsal covers it.
- **Lot screen is a screen.** Simple pairs only, scale-60 division, TIE rows undecided; the replay stays the judge (RC-Q13).
- **Concurrent writers.** The trading worker, API, market stream and collector keep writing. The snapshot is consistent; new fills land in the open E2 epoch and do not affect the record.
- **All staging scopes are read.** The record is per environment, so every Paper scope is counted, including any test account; only ordinals leave the database.
- **Scale.** The staging row counts are unknown (section 7). The local scale rehearsal bounds the cost at 100,000 fills with every statement under 2 s and the Q0 to Q5 sum under 10 s; a statement that exceeds its 10 s timeout on staging, or a sum that exceeds the 29 s database-phase cap, stops `QUERY_Qn` or `PHASE_TIMEOUT` after the read began (GO spent; the earlier queries stay in the retained output). A signal with many fills and many lots multiplies in the Q5 pair join (fills times lots for that signal); staging signals have a few fills at most, so this is not expected to matter.
- **P2 cross rule.** A staging database that has no fill of the P2 signal, or two scopes that claim it, stops `SHAPE_CROSS` after the read; the blocks stay in the retained output and Root reads them, but the attempt is spent.
- **Output size.** The row caps are theoretical maxima. The worst-case success frame at the caps (64 scopes, 512 cells, 64 lot rows, largest accepted numbers) fits the 128 KiB output cap by a static test, so a read that passes the caps is never dropped for size; a read beyond a cap stops `ROW_CAP_Qn` first. The residual is a staging database with more than 64 scopes or 512 cells, which stops after the read (GO spent).
- **Selector and identity drift.** Values come from 24-26 October records; a changed selector or data directory stops at connect or `DB_IDENTITY`, which spends the attempt.
- **Shared host.** Negligible load (seconds, one connection); no production unit, database or file is touched.
- **One-use attempt.** Any stop after the marker spends the GO; no retry.

## 11. Review plan

Before GO-BR is requested: tester (Sonnet 5.5 / medium) runs the suites, the PostgreSQL 16 rehearsal of `tool-plan.md` section 4 and the mutants; architecture auditor (Opus 5.5 / high) audits this packet, the query set against the reader and replay code, and the tool; a second-opinion reviewer (Opus 5.5 / high) substitutes the paused Fable 5.1 because this is a host-adjacent GO packet, and the review record names the substitute. The tester also runs the scale rehearsal (about 100,000 fills, 50,000 lots and 5,000 signals per scope), records the milliseconds of each statement and applies the 2 s bar and the 10 s bar on the Q0 to Q5 sum. A fix round re-verifies changed files only with one suite rerun. After the attempt, an independent reviewer verifies manifest, marker, receipt, envelope and retained-output linkage, re-derives every bucket and label from the retained output, and checks that no identifier left the database. No reviewer grants acceptance; Root decides.

## 12. Open questions for Root

- **Rulings.** BR1, BR2, BR3 and BR4 (`root-ruling-br1.md`; BR4 is the second fix round: Q5 plan, backlog rule, fixture gaps, output cap, stop list) rule these questions: R-J no (no journal read); Q1 Root checks the private P0b, P0c and P4 x4 a02 records and runs the dry admission with the real binding, a postmaster restart is acceptable; Q2 realpath check only; Q3 and Q4 confirmed from code by the build; Q5 non-Paper fills are a count, never a stop; Q6 as designed; Q7 the tracked BR result JSON is the record's `evidence`; Q8 keep; Q9 instants frozen. The questions stay below for the record.
- **Q1 Selector currency.** The B2 Window 2 selector and the P0b database identity values were last used by P4 x4 a02 (26 October). Root confirms from private records that nothing changed them since, and whether a postmaster restart since then is acceptable (identity compares database name, port setting and data directory, not start time).
- **Q2 Driver tree.** Confirm `p1-ba1a433` is still present and unchanged after A2 (it is the RA target). Rule whether BR adds the A1-style tree digest walk (more host reads) or keeps the P0c realpath check only.
- **R-J Journal.** Ruled no (BR1). U7 rests on the Q4 bounds and the record values are unchanged.
- **Q3 Bot mapping.** Confirm the UI "Bot n" equals `users.bot_slot_index`, so `slot` maps scopes to Bots 2 and 3 without an identifier.
- **Q4 Worker proxy.** Confirm `order_intent IS NOT NULL` marks worker-processed signals only (`persistIntent` is the sole writer) before Q4's first bound is trusted.
- **Q5 Non-Paper fills in a scope.** The reader replays every fill of `(user_id, broker)` without a mode filter; rule whether a non-zero `non_paper` matters for the record.
- **Q6 Old open quantity.** P2 evidence shows an open quantity 0.01181 older than the first Bot 3 fill. Q1 `legacy_open` and `pre_e0` show where it lives; if it is a legacy `positions` row with no fill, the record cannot fix it and the position check decides.
- **Q7 Evidence path.** Whether the tracked BR result JSON becomes the record's `evidence` or feeds the consolidated S8 file.
- **Q8 PostgreSQL 16.** `pg_input_is_valid` needs PostgreSQL 16 (P0b recorded 16). Q0 stops on another major; confirm no upgrade since.
- **Q9 Draft instants.** The manifest pins the proposal's instants. If Root changes any (for example the E0 start), the manifest and query constants change before the build is sealed.

## 13. Suggested GO-BR wording

Each line ends with a `notAfter` UTC time that the owner fills in. Brackets are filled by Root before the request. The line names the migration connection selector (ruling D4); there is no journal read (ruling R-J: no).

> GO S6-QR2-BOUNDARY-READ-1 BR attempt [a01 | the next contingency attempt after a stop before the database stage, listing the earlier attempts] for Staging QL-P2 Prototype only, while staging runs API pin 33e5a8c and trading worker revision ba1a433 (includes QR-2 O7: yes), neither of which this step stops, restarts or changes: in one SSH session with the reviewed tool, one read-only database read through the migration connection selector of the B2 Window 2 precedent, with the database driver loaded from the staged ba1a433 tree of P1, in one READ ONLY repeatable-read transaction with a 10-second statement timeout, a 1-second lock timeout and row caps, of the fixed query set of this packet over fills, signals, users, legacy positions, ledger position allocations and worker heartbeats, the schema version and column catalog, and the server's identity settings (database name, port, data directory, version), of every staging scope (any execution mode; non-Paper fills are only counted), then rollback; it returns counts, times, marker labels, fixed bucket and side labels, ordinals, Bot slot numbers, the PostgreSQL major, the schema version, the column count and booleans only, never an account identifier, email, key, price, quantity or message text. No environment-source read, unit command, database write or lasting file change (bash may keep the tool input in a private temporary file that it removes at once). Production untouched. No retry. notAfter [UTC].

## 14. Explicit exclusions

No start, stop, restart, reload, drop-in, flag, migration, grant, backup, restore, delete or repair. No boundary record is written, wired or deployed by this packet; W2 wiring and the API re-pin need their own reviews and GOs. No U3 history read. No application API call, browser or TradingView step. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged. No Live, guard reset, Best Inputs apply, optimizer, holdout or research work.
