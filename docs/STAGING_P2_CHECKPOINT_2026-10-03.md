# Staging P2 release checkpoint — 2026-10-03

The staging API and trading worker now run `f2bd332`, including the news-window changes in `34e8652` and the Activate-for-Paper interface in `f21deff`. Immediate postchecks passed at 05:14:39 UTC (12:14:39 Bangkok). The ten-minute postcheck and browser acceptance are pending; this is not full six-step prototype acceptance.

## Release evidence

- The package contains 583 exact source files and 765 files including dependencies. Linux extraction, file modes, hashes, syntax and imports passed before activation.
- Independent review found and corrected sequential rollback, failed-command handling and runner path-normalization defects. The accepted switch is SHA-256 `6b6d35a9fc1010beca19ce9fa919215888e8f1bdcd3c64fde90e85b42d3e236b`; the runner is `bfc63a6df10b58f6cf691796e87ae663308e21860c9bd682ea44b2bfbb8d40e6`.
- Prepare, API switch, trading switch and immediate postcheck passed. Served assets, authentication guards, Paper health, environment, engine files, research cache and database invariants passed. No signal or AI-job activity occurred in the exact switch interval.
- The research worker remains on `3309d07` with its existing cache. Research admission stays closed. Database, market collection and production were preserved. Future research still needs a separately reviewed worker/engine alignment step.
- Existing bot policies and the old OPEN allocation were not changed. The new-profile news default is enabled. Failed API or invalid release-tree recovery requires read-only reconciliation and a separately reviewed recovery packet; the reviewed rollback path covers healthy sequential rollback only.

Private operational receipts remain under `.qa-local/codex-p2-release/`; independent review is in `.qa-local/codex-p2-v7-audit/`. These references contain local evidence, not publicly available attachments.

## Step 4 continuation

The owner approved path B: a fresh SPT Paper bot, deployment, evidence and alert. The owner completed MFA, and a normal staging test license now permits a third bot. No new bot or AI job has been created yet. Bot creation must use the authenticated quota-enforced API; the current interface lacks a visible create-bot control.

The approved source and all 58 effective inputs are preserved. The planned Bridge exposes eight source parameter bindings plus ATR multiplier 60 and reward-to-risk 1.5. Paper capital is 1,000 USDT. The approved policy values remain unchanged except `blockDuringNews=true`; API money normalization must be accounted for when recording the new policy hash.

Current-release generic Bridge/news checks passed 74/74 using an isolated local database, which was stopped afterward. These fixtures use ATR2/1D and do not certify the exact new ATR60 artifact or natural TradingView execution. Fresh compilation, input review, immutable readiness evidence, activation, owner-entered webhook details and a natural BUY/targeted EXIT accounting chain remain required.

Computer use observed `QL-3A SPT Custom ATR60 PAPER staging 1m` as **Stopped — Triggered too often**. Do not restart it while its old OPEN Paper long remains unresolved. No alert was changed.

Step 5 already completed its bounded 21-evaluation run with `NO_VALID_CANDIDATE`. The holdout remains unopened. This release does not start another optimizer run, apply inputs or qualify a Research Library candidate.

## Next gate

Run the delayed postcheck no earlier than 05:24:40 UTC using the original switch interval. Keep bot, policy and capital writes paused until it passes. Then create the new bot through the normal application flow and continue the exact-artifact checks above. Spot/Paper-only, BTCUSDT 1m and current data limits remain in force.
