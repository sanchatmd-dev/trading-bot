# QL-3A — bounded research started

Planning update (2026-09-27): the owner approved readiness before Run Bot.
[Roadmap](ROADMAP.md#approved-extension--readiness-before-run-bot) now owns the
PF-1 static checks, PF-2 Historical Preflight, PF-3 readiness report and PF-4
calculated setting proposals, with separate engineering and recommendation
gates. These features are planned, not delivered by the diagnostic code below.
Historical replay uses exchange data and a supported evaluator or fixed-input
signal CSV; no TradingView MCP is required. The next implementation task is
PF-1. This update does not start a new search, activate EXIT v1 or reset guards.

Latest development follow-up (2026-09-27): the owner-authorized dedicated
[Spot EXIT v1 draft](QL_3A_SPOT_EXIT_V1_2026-09-27.md) is implemented separately
from the frozen runtime profile. Four predeclared historical replays compare
old/new EXIT at baseline/doubled costs, without holdout or optimization. New
baseline net loss improves to -5.1852783497 USDT, but all three position episodes
still lose and validation remains at zero closed trades. Setup Expiry and
Confirmation Lookback min/max changes have no signal-vector effect on this
development window. The input lock is retained. No new Alert, live collection,
source activation or guard reset follows this failed development preflight.

Status: **in progress; first offline run returned `NO_VALID_CANDIDATE`**, 2026-09-26. This is a valid fail-closed outcome, not a Best Inputs recommendation. QL-4B remains gated. The original SPT deployment remains DRAFT/capture-only; a separate Custom Paper deployment is now READY and collecting under its own Bot session. Production is unchanged, and runtime Quant remains UNSUPPORTED.

Latest result (2026-09-27): the owner-authorized continuation used a fixed,
verified historical 10,000-bar dataset with 3,250 warm-up bars. The durable
staging job completed all 100 approved Custom/Bridge candidates in 102.787
seconds with 100% dimension coverage. It returned `NO_VALID_CANDIDATE`: seven
to sixteen train trades and zero validation trades for every candidate. The
baseline diagnostic reproduced 18 validation BUYs blocked by the loss-streak
guard. Holdout was not evaluated. Paper sizing was also checked: residual cash
below one venue quantity step explains the current BUY rejections; the open
Long had no observed exit trigger. See the
[continuation record](QL_3A_HISTORY_RESEARCH_2026-09-27.md). Historical research
no longer needs additional live bars for this completed run. Candidate
validation still fails; source/operating behavior needs review before a newly
declared experiment. Custom baseline repaint passed separately. No policy,
capital, guard reset, Best Inputs or production change was made.

The subsequent [SPT signal review](QL_3A_SPT_SIGNAL_REVIEW_2026-09-27.md)
reproduced the baseline exactly without holdout data. Nine closed allocations
belong to three losing position episodes: net -8.7642227794 USDT, including
4.7422203794 USDT fees and 0.4745084 USDT execution adjustments. Native EXIT
still requires a bearish entry-style setup. The review proposes a versioned
Spot exit specification and a declared validation plan; no new source, policy
or research run has been approved or applied by that review.

2026-09-27 local checkpoint: [durable research jobs](QL_3A_DURABLE_JOBS.md) now implement PostgreSQL persistence, candidate/check progress, explicit cancellation, fenced restart recovery, immutable source/input/dataset/policy contracts and bounded calculation budgets. The owner approved eight source slots plus Bridge ATR/RR; exact IDs and grids are recorded in the [input lock](evidence/QL_3A_APPROVED_INPUT_LOCK_2026-09-27.json). All 47 Node/Bridge/PostgreSQL checks (including ten new grid/job checks) and three Python boundary checks passed against isolated resources. A real-source baseline stdio check had five train trades and zero validation trades without evaluating holdout. These are engineering checks, not natural trade collection or varied-input parity. The API/worker is disabled by default; no active staging/production rollout or owner optimization was performed. Dataset sufficiency, varied-input parity and fresh Custom repaint evidence remain acceptance gates.

The [isolated staging checkpoint](evidence/QL_3A_INPUT_REVIEW_STAGING_2026-09-26.json) passed 13/13 local UI/backend checks, 12/12 VPS backend checks and 25/25 tests against a temporary PostgreSQL 16 cluster. The private SPT reference review covered all 58 inputs. At that checkpoint, no code was deployed to the active staging service, Gemini was not called, TradingView Custom parity had not been measured, and no new Paper trades were collected.

TradingView `Custom` baseline check: the existing source-bound state trace was set to the reference Custom values on standard BINANCE:BTCUSDT 1m, with Long + Exit, HTF filter off and original notifications off. Its export had 5,415 closed bars. Restoring the Custom trace state after the 1,006-bar warm-up, the parameter-aware evaluator matched all 4,409 later BUY/EXIT flags and all 14 compared state fields within 1e-7 (maximum numeric difference 5.24e-10). The 5,185 bars covered by the frozen independent Binance Spot dataset matched OHLCV exactly. The Custom reference values produced the same BUY/EXIT flags and 15 exported state fields as the former fixed preset over their 5,316-bar overlap. This establishes **baseline parity for that one Custom setting only**; varied parameter values and a Custom-specific 100-observation repaint check remain unverified. The local effective-input hash is a reference audit, not a registered owner attestation. [Sanitized evidence](evidence/QL_3A_CUSTOM_TV_BASELINE_2026-09-26.json) records the scope and hashes; the raw CSV remains private.

## Roadmap and workflow review

2026-09-27 approved planning extension: [QD-1 and QR-1 through QR-4](ROADMAP.md#approved-extension--quant-research-library-and-best-performance)
add 50,000-bar dataset admission, a Research Library, portfolio/strategy reports
and explicit owner follow-ups. Current research code still enforces 10,000 bars
and its supported profile. No schema/API/engine or recommendation gate changed
in this documentation update. PF-1 remains next; expanded ranges depend on QD-1.

2026-09-27 follow-up: [Custom axis parity](evidence/QL_3A_CUSTOM_AXIS_PARITY_2026-09-27.json)
now matches the baseline and **16 min/max settings across all eight selected
source slots** on a common 5,808-bar Spot window. Each case cold-starts with
3,250 preceding bars and compares 2,558 measured bars: zero BUY/EXIT or state
mismatches, maximum numeric error 5.09e-10 at tolerance 1e-7. The earlier
1,250-bar cold-start comparisons failed the Slow EMA numeric criterion and are
retained. The [procedure](QL_3A_VARIED_INPUT_PARITY.md) separates same-variant
checkpoint results, GUI input review and expected local artifact hashes from
full TradingView source-byte verification, which was not performed.

Confirmation Lookback 3/5/7 had identical signal vectors in this dataset with
mode Any; the approved slot/grid remains unchanged pending usefulness review.
Any selected mixed candidate still needs exact-input parity. Fresh Custom
repaint, chronological trade coverage and customer capability gates remain open.
No optimization or Best Inputs export occurred.

Custom repaint collection is now active. The separate capture-only native trace
compiled on standard BINANCE:BTCUSDT 1m, and all 58 effective inputs matched the
registered Custom snapshot. Both its new Alert and the existing ATR60 Paper
Alert were confirmed Active. The conservative start is 2026-09-27 05:29:08.236
UTC. At 05:31:19.605 UTC, three observations had arrived with zero rejections;
two distinct closed bars qualify after the start. See the
[collection evidence](evidence/QL_3A_CUSTOM_REPAINT_COLLECTION_2026-09-27.json).
At that collection-start checkpoint, the 100-observation gate and later
historical repaint comparison remained open.
This step does not execute orders or change the Paper policy or risk counters.

At **2026-09-27 07:21:50 UTC**, the scoped Custom repaint check passed. The
first 100 eligible consecutive closed-bar observations (05:30 through 07:09 UTC)
matched the later TradingView CSV on BUY, EXIT and close with **zero changes,
zero missing observations and zero bar gaps**. The sample contains two positive
BUY flags and no positive EXIT flags; positive EXIT-event stability was not
observed in this window. The largest delivery delay was 9,832 ms, and the capture
session had zero rejections at freeze. This closes the documented 100-observation
baseline repaint gate, not a universal non-repainting guarantee or parity for
new candidate settings. See the
[repaint result](evidence/QL_3A_CUSTOM_REPAINT_RESULT_2026-09-27.json).

The [Paper readback](evidence/QL_3A_ATR60_COLLECTION_REPAINT_CHECK_2026-09-27.json)
at 07:21:39 UTC has 1,070 closed market bars with no internal gaps, 24 natural
BUY events (one filled, 23 rejected), six rejected native EXIT events and one
OPEN Long allocation. **Zero ATR60 trades have closed.** Fourteen BUY rejections
were from the prior daily-loss condition; the other nine are
`BELOW_QUANTITY_STEP`. The session remains RUNNING, deployment READY and no
research job exists. Chronological closed-trade coverage and candidate
validation remain unresolved; neither the repaint result nor waiting alone
qualifies Best Inputs or opens QL-4B. No risk counters or policy were changed.

At **2026-09-27 01:06:41 UTC** (08:06:41 Asia/Bangkok), the
[latest ATR60 collection](evidence/QL_3A_ATR60_COLLECTION_LATEST_2026-09-27.json)
has **695 closed bars with zero gaps**. Natural event counts remain 15 BUY and
six NATIVE EXIT; one BUY filled and its Long allocation remains OPEN, with zero
closed ATR60 trades. The session is RUNNING, deployment READY, daily realized R
zero and streak one. The earlier 667-bar snapshot below remains historical.

Fresh read-only collection check at **2026-09-27 00:38:41 UTC** (07:38:41
Asia/Bangkok): the ATR60 segment has **667 closed bars with zero internal gaps**,
15 natural BUY events and six natural NATIVE EXIT events. One BUY filled after
UTC rollover; its Long allocation is still OPEN. Fourteen earlier BUYs were
rejected by the unchanged daily-loss guard. All six exits were rejected with
`TARGET_NOT_OPEN`; no ATR60 trade has closed yet. The current UTC day's ledger
has one trade and realized R zero; loss streak remains one. Session RUNNING,
deployment READY, all four staging services active and the TradingView ATR60
alert Active. No research job exists. Historical `QUEUED` pending records are
receiver handoff records, not proof of an unprocessed worker backlog.

The [collection snapshot](evidence/QL_3A_ATR60_COLLECTION_STATUS_2026-09-27.json)
keeps this segment distinct from the earlier ATR2 trade. Market continuity does
not prove webhook continuity across the recorded receiver-maintenance interval.
The [varied-input parity procedure](QL_3A_VARIED_INPUT_PARITY.md) now has 17
private artifacts prepared, with exact default bindings and original logic
preserved. Compilation, exports, cold-start convergence, variant comparisons
and fresh Custom repaint evidence remain pending. Preparation is not acceptance.

Subsequent staging rollout (2026-09-27): checkpoint `6320169` is pushed and the API/dedicated Quant research worker run from a separate staging release. Quant extension 1 preserves base schema 14 and the Bot's policy, capital, session and daily/streak rows. Restricted-role submission validated the approved eight source slots and 100-candidate plan inside an intentional rollback; no job or optimization was committed. HTTP auth/CSRF/schema readbacks and worker startup passed. A conservative receiver-maintenance interval of 17:31:26–17:31:57 UTC on 2026-09-26 must be accounted for in natural webhook continuity; market stream continued. See [rollout evidence](evidence/QL_3A_DURABLE_JOBS_STAGING_ROLLOUT_2026-09-27.json). Dataset cutoff, trade coverage, varied-input parity and fresh Custom repaint remain open; production is unchanged.

The governing order remains R-0, APP-3A, QL-2A, QL-3A, QL-4B, QL-4C, APP-3B, APP-4, APP-5. The five-step workflow runs Paper before one Quant optimization job, then delivers only validated Best Inputs and Email Report for owner review and optional new Bot start. It has no automatic re-optimization loop. QL-2A's accepted source-specific baseline is enough to start QL-3A engineering. It does not qualify arbitrary Pine, additional source inputs, multiple Pine scripts or customer optimization.

## First offline research run

`python -m robot_quant.ql3a` verifies the QL-2A accepted private report, exact frozen CSV, source/snapshot, input hashes and unchanged QL-2A implementation. It reuses the reviewed source trace's closed-bar BUY/EXIT/ATR values and the `bridge-exit-v2`/`paper-close-v1` replay. The program cannot write to production, register readiness, activate a Bot, export Pine or send email. It is separate from the existing synthetic EMA optimizer.

- One Pine, zero selected dynamic source slots. Only independent Bridge ATR multiplier and RR vary. The provisional offline grid is 1.0, 1.5, 2.0, 2.5 and 3.0 for each dimension: 25 of 25 combinations; both dimensions participate. These are research values, not approved Bot bounds.
- The 4,179 measured bars split chronologically into 2,507 train, 836 validation and 836 untouched test bars, after the unchanged 1,006-bar checkpoint/warm-up. The complete Pine/Bridge/Paper state is carried forward. The Paper policy and capital stay frozen. A candidate is chosen from train/validation only; test replay occurs once after selection, if any.
- An initial engineering sample floor of five closed trades per partition, nonnegative validation return at least as good as the baseline, maximum 20% drawdown, adjacent-grid sensitivity within two percentage points, and nonnegative validation return under double fee/slippage are explicit gates. These floors are provisional and do not establish statistical adequacy for owner delivery. The workflow's later validation gate remains separate.
- The run ID is an offline content hash. It is not the server-issued `run_id` required by the owner workflow. This first runner is synchronous and bounded; durable progress/cancel/restart recovery remain QL-3A work before any service job.

[Sanitized first-run evidence](evidence/QL_3A_FIRST_RUN_2026-09-26.json) records domains, hashes, split, outcomes and limitations. Raw inputs and per-candidate records remain private outside Git.

## Observed result and blocker

All 25 pairs produced **three closed trades in train and zero in validation**. Every pair failed both train and validation sample floors. The baseline pair (ATR 2.0, RR 1.5) had 29 native BUY and 38 native EXIT candidates in train, then six BUY and 19 native EXIT candidates in validation. These are indicator signals, not executed trades.

For the baseline, train had 56 Paper decisions: six fills, 25 `Maximum daily loss reached` rejections and 25 `TARGET_NOT_OPEN` rejections. Validation had 12 decisions: zero fills, six `Maximum daily loss reached` and six `TARGET_NOT_OPEN`. The frozen policy has `maxDailyLossR=3` and `pauseAfterLossStreak=3`; the optimizer did not weaken either guard. Baseline train return was -0.95978754644% and validation return 0% with no validation trade. The test partition was not evaluated for candidate selection or performance because no train/validation candidate qualified.

More bars alone do not guarantee acceptance. Future work needs a new, adequately populated frozen Paper dataset under the unchanged policy or a separately reviewed policy revision followed by new parity evidence. Do not repeat optimization automatically or infer profitable values from native signal counts. QL-4B must not create a recommendation from this run.

## Follow-up work: Custom source inputs and Paper execution sample

The owner selected the SPT `Custom` preset and up to eight user-mapped numeric signal inputs for the next research scope. `spt_custom_evaluator.py` now implements ten eligible SPT-specific signal variables; each job may bind at most eight distinct source slots, while Bridge ATR multiplier and RR remain the two independent mandatory slots. It validates source hash, membership/input identities, selected slots, effective settings and search grids. A candidate can change only selected values. Each candidate starts its own causal signal state; a changed EMA/ATR setting cannot inherit the Daily/Swing checkpoint. Its Bridge ATR(14) is calculated separately from the Indicator's selectable ATR length. The existing fixed QL-2A evaluator and historical 25-pair result are unchanged.

This is **candidate code, not accepted Custom parity or a working owner optimizer**. The source defaults are still `Daily/Swing`, and several raw `Custom` defaults differ from the accepted profile. The Chatbot worktree now offers a local, no-AI input inspection step, requires owner review of every effective TradingView value before AI analysis, and records the source/effective-input hashes, reviewer and time. For the exact approved SPT source hash it can fill the reviewed `Custom` reference values, which the owner must also set in TradingView. The complete typed snapshot is frozen with the source revision; selected and fixed inputs inherit those values. The owner must choose at most eight slots and bounds. A Custom TradingView trace with identical effective inputs, sufficient warm-up, matching independent Spot candles and quantitative state/signal/repaint checks is required before any varied input can qualify. The old 4,179-bar fixed-profile comparison does not certify changed settings. Job persistence, budget controls and dimension coverage also remain QL-3A work. This Chatbot change is local and not deployed.

The separate Paper blocker is operational. `ledger_streak` persists across days and Bot session resets, so a paused entry path may stay closed even after daily loss counters roll over. A local owner-only re-arm path now requires the Bot to be STOPPED with its locked policy, the selected Paper account to have no pending/unknown orders or open positions/allocations, **no account trading/PnL activity on the current UTC day**, a streak at or above the session's locked policy threshold, and a 10–500-character review reason. It resets only that account's loss streak and writes an audit event; it never edits the risk policy, cash, PnL, closed trades or the daily loss counter. The owner must resolve positions while exits are still possible, stop the Bot, wait for the next UTC day, review/re-arm, reset the stopped session, then explicitly start a new Paper run. This code is local and has not been deployed or used to collect new validation trades.

For a new run, record the Bot/session/account, unchanged locked policy, start/cutoff timestamps, independent closed Spot bars, all Paper decisions and completed allocations. Freeze a new dataset and recheck the train/validation/test trade floors and Pine-to-evaluator parity before another bounded optimization. If validation still has zero closed trades, keep `NO_VALID_CANDIDATE`; do not lower risk guards or infer results from BUY counts. No automatic second optimization follows an owner export.

## New staging Paper dataset preparation

On 2026-09-26, a separate staging Bot, `QL-3A SPT Custom Paper 2026-09-26`, was prepared from the approved Spot source and the reviewed 58-input Custom baseline. The deterministic Bridge keeps ATR multiplier 2.0 and RR 1.5. Its locked policy hash matches the prior baseline (`e151fccd990ddd34ee368a410903f6d0edb2e1480c8585c07de5d49456cafff7`); no loss guard was weakened or reset. This is operator assembly, not a new AI API acceptance result. No dynamic optimization slots have been selected for this collection baseline.

The operator installed a dedicated staging Paper webhook route. Nginx configuration validation and reload succeeded with nonfatal `proxy_headers_hash` warnings. Readback confirmed that the route targets the staging Bridge receiver and disables access logging for its token URL. A request with an invalid token and empty JSON returned HTTP 400 `UNSUPPORTED_SCHEMA_VERSION`; this confirms routing to the receiver, not valid webhook authentication or Paper execution. The staging API, worker and market stream were active when checked.

**Collection is enabled; the first natural EXIT reached Paper:** the new artifact was saved separately as `QL-3A SPT Custom Paper 1m`, compiled and added to standard BINANCE:BTCUSDT 1m. All 58 source inputs were checked against the frozen snapshot, including the Custom overrides, Long + Exit, HTF off and original notifications off. The two Bridge inputs remain 2.0 and 1.5. The one generic TradingView repaint alert caution was reviewed; it does not establish universal non-repaint behavior or varied-input Quant parity.

Readiness records reuse the existing generic Paper contract matrix for the unchanged template/receiver/execution code; code comparison ignored CRLF line endings only. Those fixture counts are not natural trades from this Bot. Recording readiness honored the maintenance lock by briefly stopping the staging API and worker. Their transient units were recreated with their prior commands after stop removed the definitions; both services, the market stream and production services were confirmed active afterward. Capture-only delivery could have been interrupted during that maintenance window, so any later capture continuity check must include it.

The new deployment is READY and its independent Bot session is RUNNING. TradingView alert `QL-3A SPT Custom PAPER staging 1m` was confirmed Active with only webhook delivery. The conservative dataset collection start was recorded at **2026-09-26 11:21:10 UTC** (18:21:10 Asia/Bangkok), after confirming the alert. At **11:29:48 UTC**, eight closed market bars had been stored with no internal gap. One natural EXIT was queued and processed as a SELL decision, then rejected with `TARGET_NOT_OPEN` because the new Bot had no open allocation. This establishes natural webhook delivery into the Paper decision path, including the rejection; a BUY fill and completed trade remain unobserved. [Collection evidence](evidence/QL_3A_CUSTOM_PAPER_COLLECTION_2026-09-26.json) records the exact dataset/session identifiers and hashes without credentials or machine locations.

The cutoff is not frozen yet. Collect independent closed Spot bars, all decisions including rejections, and completed allocations under the locked policy. Do not automatically re-arm a loss guard or repeat optimization. Freeze a new dataset only after reviewing continuity, sufficient closed-trade coverage for the chronological partitions and Custom parity; collection duration alone does not satisfy those gates. The Chatbot/re-arm implementation remains undeployed to the active service; this step used a separate operator checkout to prepare and activate the staging Bot.

At **13:01:24 UTC**, collection had 100 closed market bars with no internal gap, two BUY events and three EXIT events. One BUY filled and its matching EXIT filled, closing one Long allocation with zero remaining quantity. The exit payload reason was `SL`; this does not establish execution of a native bearish Indicator exit. The other BUY was rejected with `Maximum daily loss reached`, and two unmatched exits were rejected with `TARGET_NOT_OPEN`. The Bot remained RUNNING and the deployment READY, but the entry path was blocked by the daily-loss guard.

Read-only fill/ledger review at **13:02:19 UTC** found BUY price 84,190.42, SELL price 84,157.62 and quantity 0.01186 BTC. Gross price loss was 0.389008 USDT; the two fees totaled 1.9966077544 USDT, giving net loss 2.3856157544 USDT. The ledger's initial price-to-stop risk was 0.2313886 USDT (19.51 USDT per BTC), so realized loss was approximately -10.31 R, exceeding the unchanged 3 R daily limit after one closed trade. Fee-inclusive allocation cost differs from raw fill price by design. This narrow 1m stop relative to transaction costs explains the guard rejection; the evidence does not justify weakening or resetting the guard. Cost/stop-distance suitability needs review before treating further waiting as sufficient for validation-trade coverage.

The owner authorized preparation of a revised collection baseline. A [cost-to-stop review](evidence/QL_3A_COST_BASELINE_REVIEW_2026-09-26.json) used the latest 2,000 independent 1m bars and the unchanged 10 bps fee/1 bp slippage model. Its engineering criterion was round-trip fees plus modeled slippage at most half the raw stop distance on at least 95% of reference bars. ATR multiplier 60 was the first checked value meeting that criterion (96.5% of bars; 95th-percentile cost/stop ratio 0.449). ATR 2 met it on none of those bars. This criterion addresses baseline transaction-cost suitability; it is not a performance optimization, Best Inputs, future guarantee or a revision of the product's Bridge defaults.

A separate immutable ATR 60 / RR 1.5 deployment was prepared as DRAFT on the **same Bot, account, source, Custom inputs and 1m timeframe**. The existing deployment remains active while the replacement awaits real TradingView compilation, input review and a new alert. Read-only verification confirmed the session remained RUNNING with the same run ID, daily realized R remained -10.31 and loss streak remained 1. No account, session, risk counter or policy was reset. New BUY execution remains gated by UTC daily rollover (07:00 Asia/Bangkok on 2026-09-27) and every other risk check. Any replacement activation must preserve these counters, record a separate dataset segment/cutoff and retain its inherited guard state; historical and revised settings must not be mixed as one fixed-input dataset.

## Progress without waiting for UTC rollover

The ATR60 artifact was saved separately as `QL-3A SPT Custom ATR60 Paper 1m`, compiled on standard BINANCE:BTCUSDT 1m, and its source inputs were reviewed against the unchanged Custom snapshot. Original notifications and the HTF filter remain off. The generic TradingView repaint caution remains a limitation. Replacement activation at **2026-09-26 13:29:47 UTC** preserved the same Bot, account, RUNNING session/run ID, policy, daily realized R (-10.309996924654023578) and loss streak (1). The old deployment became EXIT_ONLY; its alert was paused after the new ATR60 alert was confirmed Active. The staging API and worker resumed successfully, and the market stream stayed active. Maintenance briefly interrupted receiver availability and must be accounted for in capture continuity evidence.

The [new dataset segment](evidence/QL_3A_ATR60_PAPER_COLLECTION_2026-09-26.json) starts conservatively at **13:30:56 UTC** (20:30:56 Asia/Bangkok), after alert confirmation. At 13:31:37 UTC, one closed market bar was stored and no natural webhook had arrived for this deployment. This enables continued bar/signal collection immediately; today's daily-loss guard still prevents new accepted BUY fills. Rollover merely removes that daily condition, subject to all other checks and a new signal. It does not guarantee sample sufficiency or phase acceptance.

A separate [offline engineering replay](evidence/QL_3A_COST_BASELINE_REPLAY_2026-09-26.json) completed immediately using the frozen Custom TradingView observations. After 1,006 warm-up bars, 3,527 chronological bars were evaluated; the final 882 holdout bars were not opened. Two predetermined baselines, ATR2/RR1.5 and ATR60/RR1.5, used the unchanged fees, slippage and risk policy. This was a simulation from a declared historical flat 1,000 USDT account, not a reset of the live ledger or an owner optimization job.

Node/Python execution parity matched all decisions, levels, ticks, quantity steps, fees and allocation targets: 78 decisions for ATR2 and 75 for ATR60. ATR2 produced three closed trades, all SL exits; ATR60 produced five closed trades, all NATIVE exits. Both had **zero validation closed trades**. ATR60 ultimately encountered `Trading paused after loss streak`; transaction-cost suitability does not establish profitability or sufficient collection. No Best Inputs were generated, no holdout performance was inspected, and the actual live-trade count contributed by this replay is zero.

QL-3A engineering can continue before daily rollover: implement durable job persistence/progress/cancel/restart recovery, freeze the owner's selected numeric slots and bounded domains, and verify varied-input source parity. Signal-only observations can also continue while accepted BUYs are blocked. QL-4B remains gated until the required chronological trade coverage and candidate checks pass. Do not reset risk counters, introduce a fresh account to evade them, lower fees, count replay fills as live fills or promise that a fixed waiting duration completes acceptance.

## Private reproduction

```powershell
.\quant_lab\.venv\Scripts\python.exe -m robot_quant.ql3a `
  --bundle .qa-local/ql2a-source-private.json `
  --csv '<frozen QL-2A baseline TradingView CSV>' `
  --baseline .qa-local/ql2a-checkpoint-baseline-private.json `
  --output .qa-local/ql3a-research-private.json
```

The command records all 25 candidates privately. It has no test suite or production side effects. Later QL-3A work must add durable job controls and independently check parity for any selected non-default Bridge pair before phase acceptance.
