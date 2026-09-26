# QL-3A — bounded research started

Status: **in progress; first offline run returned `NO_VALID_CANDIDATE`**, 2026-09-26. This is a valid fail-closed outcome, not a Best Inputs recommendation. QL-4B remains gated. The existing SPT deployment is DRAFT/capture-only, production is unchanged, and runtime Quant remains UNSUPPORTED.

The [isolated staging checkpoint](evidence/QL_3A_INPUT_REVIEW_STAGING_2026-09-26.json) passed 13/13 local UI/backend checks, 12/12 VPS backend checks and 25/25 tests against a temporary PostgreSQL 16 cluster. The private SPT reference review covered all 58 inputs. These checks did not deploy code to the active staging service, call Gemini, establish TradingView Custom parity or collect new Paper trades.

## Roadmap and workflow review

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

## Private reproduction

```powershell
.\quant_lab\.venv\Scripts\python.exe -m robot_quant.ql3a `
  --bundle .qa-local/ql2a-source-private.json `
  --csv '<frozen QL-2A baseline TradingView CSV>' `
  --baseline .qa-local/ql2a-checkpoint-baseline-private.json `
  --output .qa-local/ql3a-research-private.json
```

The command records all 25 candidates privately. It has no test suite or production side effects. Later QL-3A work must add durable job controls and independently check parity for any selected non-default Bridge pair before phase acceptance.
