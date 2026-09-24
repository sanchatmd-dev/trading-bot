# Pine export: indicator Bridge workflow

Status: proposed M5–M7 customer workflow. Offline export utilities exist in the repository, while authenticated Bot-scoped export, owner review/import and Email Report for this revised workflow remain planned.

Integration: [the revised roadmap](ROADMAP.md) sequences Bridge generation, a Bot Paper run, one source-parity-backed Quant optimization run, mode-specific export and owner review. The owner may apply the reviewed values and start the Bot again; the workflow then ends. No post-export Paper acceptance cycle or automatic return to Quant is required. Historical QL-1 through QL-4 work is recorded in [the archived roadmap](ROADMAP_ARCHIVE_2026-09-24.md).

## Candidate and risk prerequisites

Preserve user indicator logic and keep Bridge ATR-for-SL and RR separate from source inputs, with initial defaults 2.0 and 1.5. One Pine / one Bot optimizes 0–8 user-selected numeric source inputs plus these 2 Bridge slots (at most 10); every other source input stays fixed. Multiple Pine scripts freeze all source inputs and optimize only the shared Bridge pair. Preserve source hashes and an input-only diff; record Bridge changes separately. The chatbot accepts indicators only and rejects strategies before AI use; the user converts externally first.

Expose Webhook ready, Optimization supported and Export validated as independent states. Protected/unsupported indicators can use available alert hooks without being advertised as optimizable. Webhook events alone are insufficient to evaluate alternative inputs. Preset-overridden and visual-only inputs must be identified before defining the search space.

- Export only an indicator with proven Quant capability under the [stage-specific numerical scope/parity gates](PINE_BRIDGE_ADAPTER_API.md), with an immutable run and baseline, out-of-sample and cost-stress evidence. A generated/compiled Bridge alone does not prove this capability. Do not promise arbitrary Python/Pine conversion.
- Capture requested settings, the account/bot policy snapshot, permitted optimization bounds and their versions. The optimizer cannot raise hard limits or disable locked guards. VPS execution still rechecks current policy and cash.
- Declare equity basis, fees/slippage/spread, market-rule rounding, indicator warm-up, candle/session conventions and stop/exit assumptions. Map costs explicitly; Pine's fixed-tick slippage cannot be silently treated as a dynamic percentage model.
- Freeze `bridge-exit-v1` and its Paper/Quant fill model in the package: signal-bar close/ATR levels, next-bar protection, SL-before-TP-before-native priority and execution-bar close with adverse slippage/fees. Reports distinguish trigger levels from modeled fill prices and explain that protection is evaluated at bar close.
- Validate the selected source's indicator/signal/transaction timing and sizing on matched datasets. Track source-specific validation separately from strategy profitability. Changing any material assumption marks that evidence stale.
- The initial UI is operator/private tooling with Risk Policy, Optimization Bounds, Validation Results and Export & Deployment views; customer access requires the scoped APIs and isolation gates in the roadmap.

## Export selection

This indicator-only workflow uses exactly one alert source, `alert_calls`, displayed explicitly in the preview and manifest. Do not create strategy wrappers or offer order-fill generation. Existing offline strategy/order-fill utilities remain historical capabilities outside this workflow. Native indicator alert routes must be isolated through existing configuration to satisfy the zero-unrelated-payload gate.

| UI option | Package value | Trigger | TradingView setup |
| --- | --- | --- | --- |
| Signal events — `alert()` | `alert_calls` | Selected indicator and Bridge conditions evaluated on closed bars | Select **Any alert() function call** after native-alert isolation is verified. The Bridge supplies JSON. |

Each TradingView deployment uses one alert source. A multiple-Pine Bot package may contain one deployment per member script, all tied to the same shared Bridge pair and export_id. Until APP-3B passes multi-Pine isolation, recovery and shared-symbol Paper canary, these packages are internal fixture artifacts; owner review/apply/start remains disabled. Comparison packages need distinct deployment identities and must not execute one logical event twice on a Bot.

## Generated artifacts

Step 5 has exactly two user-facing deliverables:

1. **Best Inputs package** — `inputs.json`, a supported Pine Script output and TradingView `setup.md`.
2. **Email Report** — a concise, owner-scoped summary of the Best Inputs and the Quant evidence needed to review them for the selected Bot's Risk Manager.

| Bot connections | Best Inputs and Pine edits | Email recommendations |
| --- | --- | --- |
| One Pine / one Bot | Optimize the 0–8 selected numeric source inputs plus Bridge ATR/RR. Export the complete source-input snapshot, labelling optimized fields and fixed unchanged fields. | Identify selected slots and optimized/fixed values; only the Bridge pair maps to Bot Risk Manager. |
| Multiple Pine scripts / one Bot | Internally prepare only the best shared Bridge ATR/RR pair, with preserved fixed source inputs and a guide listing member scripts. Owner-facing delivery follows APP-3B acceptance. | After APP-3B, recommend only the shared Bridge pair, with Bot/Pine identities, timestamps and aggregate Quant metrics. |

Resolve Pine membership on the server. Keep fixed source-input snapshots for reproducibility, private in multiple-Pine mode. Membership/source/selection/domain/fixed-value changes invalidate evidence. For one Pine the 10-slot ceiling includes 2 mandatory Bridge slots and at most 8 distinct user-selected numeric slots; each needs an explicit domain and bound. This replaces all-source-parameter optimization. Excluded types and configuration stay fixed. Multiple-Pine research evaluates combined fixed signals under shared Bot limits.

Each source receives `pine_import_id` when registered in Step 1/2. A server-issued `export_id` identifies one immutable Best Inputs candidate and its report draft, bound to `bot_id`, `run_id`, all participating `pine_import_id`/source-version pairs and the risk-policy snapshot. Include these IDs and an ISO-8601 UTC creation timestamp. QL-4B creates the drafts only. QL-4C validates package/Pine/parity/ownership/freshness before publishing a one-Pine recommendation or enabling apply. Outbox enqueue is idempotent by export_id and occurs only after validation plus SMTP remediation and confirmed owner receipt; no draft enqueues mail. Multiple-Pine owner delivery/apply also requires APP-3B acceptance. SMTP delivery then follows at-least-once semantics with the same report ID on duplicates.

The Email Report includes actual recommended values, `bot_id`, one or more `pine_import_id` values, `run_id`, `export_id`, generation timestamp, policy version/hash, validation and stale status, objective, train/validation/test scores, trade/sample count, maximum drawdown, Win Rate, Profit Factor and fee/slippage assumptions. Only the Bridge ATR/RR pair maps to Bridge Settings on Bot Risk Manager; source inputs belong in Pine. Include an authenticated review link. Send only to the verified Bot owner, without webhook URLs/secrets or broker credentials.

Email is a notification and review aid; it does not apply values to a Bot or start it. The owner sees recommendations only after the required QL-4C and, for multi-Pine, APP-3B gates. On explicit apply, the server rechecks ownership, policy version, Bridge bounds, source membership and freshness, then records an audit event without changing hard limits. Pine-only source values remain in the package. Starting with reviewed values requires deliberate alert replacement. A stale/incompatible candidate cannot be applied.

- `inputs.json` and an input-change list: selected slot IDs, before/after values, fixed source values, effective presets, source hash and run identity. In multiple-Pine mode only the Bridge pair is actionable; fixed snapshots stay in private provenance.
- `indicator.pine`: complete private indicator with approved numeric defaults and Bridge values; preserve logic, source notices and every unselected input. Step 2 preserves original bytes; Step 5 permits only the selected numeric default edits and Bridge changes, disclosed in the diff.
- `indicator.json`: indicator identity/version, selected numeric slots, fixed input snapshot, `alert_source`, bridge-exit version, calculation/fill assumptions and supported chart symbol/timeframe.
- `risk-profile.json`: versioned risk snapshot; never overrides current server hard limits automatically.
- `setup.md`: source-specific TradingView condition, message, symbol/timeframe and webhook setup instructions. Keep webhook credentials outside shareable packages.
- `validation.html`: parity results for the selected source and disclosure of execution differences.

These files form the Best Inputs package; they do not add extra user-facing delivery categories beyond the package and Email Report.

The source must be visible in the export preview, package metadata, indicator header and eventual deployment/log UI. APP-3A adds `alert_source` to the dedicated versioned webhook contract; the current legacy receiver is not assumed to validate it.

## Webhook and deployment contract

The [R-1 allocation contract](ROADMAP.md#historical-r-1--per-entry-positions-and-targeted-tpsl) establishes server-owned independent entries and targeted TP/SL. Exports reuse accepted ownership semantics: preserve P1/P2 targets and actual-fill-based sizing, handle multiple exits per candle, and reject incompatible receivers rather than falling back to legacy full-symbol exits. The current SPT Bridge still needs source-specific acceptance for this revised workflow.

Execution ownership follows [UNIVERSAL_RISK_MANAGER.md](UNIVERSAL_RISK_MANAGER.md). Map exits to a strategy-owned position group and declared quantity/percentage basis. Never export an unscoped close-all signal as the default for multiple indicators sharing a bot/symbol. Older deployment groups retain explicit exit ownership during replacements.

APP-3A fixes the versioned Bridge webhook/receiver fields and semantics in [the Adapter API](PINE_BRIDGE_ADAPTER_API.md#versioned-webhook-contract--app-3a): `schema_version`, `deployment_id`, `pine_import_id`, source version, stable `event_id`, `entry_ref`, event/bar time, broker/symbol/timeframe and the facts needed to verify Bridge levels. Owner/Bot authorization and allocation ID come from authenticated server records. APP-3A implements strict receiver validation and an isolated Paper path; QL-2A replays that same contract. Subsequent export metadata adds run/export/policy versions without changing the meaning of earlier webhook fields.

Do not use a payload `user_id` as authorization. Keep webhook secrets and broker credentials out of exported files. Separate stable event identity from timestamps used for signal-age checks; retain original event time and receipt time for audit. Preserve legacy clients through a versioned compatibility path rather than assuming new metadata already works.

Display requested versus applied quantity, effective risk version and any rejection/capping reason in trade reconciliation. Define unknown/stale deployment behavior and existing-position exit ownership before rollout. A Pine BUY event can be rejected by the VPS, and an emulator position must never be treated as confirmation of a VPS position.

## Generation rules

For `alert_calls`:
- Generate execution messages through `alert()` only, with an explicit frequency/calculation policy. Bar-close signals are the initial supported baseline.
- Prove zero unrelated native alert payloads and zero duplicate logical events using the quantitative adapter gates. Reject strategy/order-fill generation in this workflow.

For each deployment:
- Event identity must be stable per logical event, distinct across legitimate scale-ins/partial exits, and separate from send timestamps. Include deployment identity in duplicate handling.
- The VPS authenticates the destination bot, validates the versioned contract, rechecks current risk/balance and calculates or caps execution size. It records the original signal and resulting order separately.
- The selected source affects timing and backtest assumptions; do not switch source by changing a label on the same validation result.
- Changing source creates a new export/deployment version and requires recreating the TradingView alert. Document a switchover that disables the previous alert and resolves existing position/exit ownership without leaving duplicate entry routes.
- Never claim the exporter automatically creates or inspects a user's TradingView alert settings.

## Acceptance criteria

1. UI identifies indicator-only `alert_calls` and explains the 2 mandatory plus 0–8 selected numeric slots in EN/TH.
2. Package, metadata and guide reflect the confirmed slot mapping and fixed-value snapshot.
3. Template checks cover duplicate/invalid/nonnumeric selections and native-alert isolation. Export requires Bridge, Quant and candidate/package gates; initial draft delivery requires only its structural gate.
4. Record TradingView compilation and quantitative native/Bridge/evaluator parity evidence. Quant sample/repaint evidence may use existing traces or evidence-backed point-in-time replay; no mandatory wait for new daily bars applies to Bridge generation. Generated text alone is insufficient. No Strategy Tester gate is introduced for this indicator-only workflow.
5. The pre-optimization Paper run verifies webhook intake and produces the session/fill/data record used by Quant Lab. Do not make a second post-export Paper run a condition for completing this workflow.
6. Event timing and source metadata in the source parity/export evidence reconcile with the available TradingView and Paper records. Any differences in simulated/actual sizing and rejection reasons are visible to the owner.
7. Source changes invalidate prior source-specific validation and create a clearly versioned deployment with documented alert replacement.
8. Exported risk/optimization metadata round-trips without loss of monetary precision or relaxation of account limits. Run, template, dataset and policy versions identify the evidence behind each package.
9. Unknown/stale versions and overlapping old/new alerts are tested with existing open positions; the transition must preserve explicitly authorized exits without duplicate entries.
10. Input-only optimization preserves source logic: changes outside approved input values are absent from the indicator logic diff, baseline signals match the supported evaluator, and ineffective/preset-overridden fields are excluded or explicitly resolved through existing inputs.
11. Unsupported/closed-source indicators are rejected by this chatbot generation path. Any separate exposed-alert integration does not confer optimization or export support.
12. QL-4B creates a private Best Inputs candidate and owner-scoped Email Report draft with matching `export_id`, source identities, provenance, UTC timestamp and metrics. QL-4C must validate before a one-Pine owner-facing recommendation/apply or mail enqueue; APP-3B additionally gates multi-Pine. Enqueue by export_id only after SMTP remediation/owner receipt. Keep EXPORT_CANDIDATE, EXPORT_VALIDATED/READY, EMAIL_BLOCKED_SMTP, EMAIL_PENDING/SENT/FAILED and NO_VALID_CANDIDATE distinct.
13. Email delivery alone cannot mutate Risk Manager settings or start a Bot. Explicit owner review of Best Pine Inputs and Bot Risk Manager settings revalidates owner, Bot, policy version, bounds and evidence freshness and records an audit event. Starting a Bot with the reviewed values is a separate explicit owner action and ends this workflow; it does not launch another optimization automatically.

Reference: [TradingView Alerts](https://www.tradingview.com/pine-script-docs/concepts/alerts/) and [Strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/).
