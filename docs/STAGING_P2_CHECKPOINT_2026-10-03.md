# Staging P2 release checkpoint — 2026-10-03

The staging API and trading worker now run `f2bd332`, including the news-window changes in `34e8652` and the Activate-for-Paper interface in `f21deff`. Immediate postchecks passed at 05:14:39 UTC and the delayed check passed at 05:28:06 UTC. The new Paper bot has a generated draft that compiled in TradingView; readiness recording, activation and a natural trade pair remain pending. This is not full six-step prototype acceptance.

## Release evidence

- The package contains 583 exact source files and 765 files including dependencies. Linux extraction, file modes, hashes, syntax and imports passed before activation.
- Independent review found and corrected sequential rollback, failed-command handling and runner path-normalization defects. The accepted switch is SHA-256 `6b6d35a9fc1010beca19ce9fa919215888e8f1bdcd3c64fde90e85b42d3e236b`; the runner is `bfc63a6df10b58f6cf691796e87ae663308e21860c9bd682ea44b2bfbb8d40e6`.
- Prepare, API switch, trading switch and immediate postcheck passed. Served assets, authentication guards, Paper health, environment, engine files, research cache and database invariants passed. No signal or AI-job activity occurred in the exact switch interval.
- The research worker remains on `3309d07` with its existing cache. Research admission stays closed. Database, market collection and production were preserved. Future research still needs a separately reviewed worker/engine alignment step.
- Existing bot policies and the old OPEN allocation were not changed. The new-profile news default is enabled. Failed API or invalid release-tree recovery requires read-only reconciliation and a separately reviewed recovery packet; the reviewed rollback path covers healthy sequential rollback only.

Private operational receipts remain under `.qa-local/codex-p2-release/`; independent review is in `.qa-local/codex-p2-v7-audit/`. These references contain local evidence, not publicly available attachments.

## Step 4 continuation

After the delayed release check passed, the authenticated quota-enforced API created the third bot, `SPT Prototype Paper 2026-10-03`. Its session is RUNNING with Paper capital of 1,000 USDT and news blocking enabled. The normal wizard completed AI analysis and generation. Deployment `b45d9f9d` is DRAFT; no webhook event or trading signal existed at the 05:50:48 UTC read-only check. The current interface still lacks a visible create-bot control.

The approved source and all 58 effective inputs are preserved. The generated Bridge exposes eight source parameter bindings plus ATR multiplier 60 and reward-to-risk 1.5. The approved policy values remain unchanged except `blockDuringNews=true`; normal API decimal-string normalization was checked. An independent deterministic rebuild matches the 62,337-byte generated artifact exactly.

The private TradingView script `QL-P2 SPT Paper 2026-10-03 b45d9f9d` compiled and was added to the standard BTCUSDT 1m chart at 05:51:08 UTC. An initial editor transfer left a sample header and failed; replacing the entire editor with the generated file corrected it. The latest compile has one reviewed warning about the strict ticker guard. All 58 source inputs and both Bridge inputs were saved and reopened for review. Native notifications are disabled, and the chart layout was saved. Independent source, template and screenshot review passed. No new alert has been created.

Current-release generic Bridge/news checks passed 74/74 using an isolated local database, which was stopped afterward. Their case counts and accounting metrics cover generic ATR2/1D fixtures, not exact SPT ATR60/model parity or natural TradingView trades. The manual readiness gate combines those scoped regressions with exact source/artifact/input/compile review and an external runtime binding. The proposed evidence states these limits explicitly. Operator recording, separate activation, owner-entered webhook details and a natural BUY/targeted EXIT accounting chain remain required.

Computer use observed `QL-3A SPT Custom ATR60 PAPER staging 1m` as **Stopped — Triggered too often**. Do not restart it while its old OPEN Paper long remains unresolved. No alert was changed.

Step 5 already completed its bounded 21-evaluation run with `NO_VALID_CANDIDATE`. The holdout remains unopened. This release does not start another optimizer run, apply inputs or qualify a Research Library candidate.

## Next gate

Review and record the new deployment's immutable evidence through the operator-only script, then activate through the normal application. Prepare an alert for the exact new chart instance; the owner enters its private webhook details. The public staging route differs from the internal route and was verified read-only. Observe an accepted natural BUY and a targeted EXIT for the same entry before accepting Step 4. Spot/Paper-only, BTCUSDT 1m and current data limits remain in force. PF-2 remains disabled, and the fresh import's generic Quant capability remains UNSUPPORTED; the older source-specific research result does not certify this import.
