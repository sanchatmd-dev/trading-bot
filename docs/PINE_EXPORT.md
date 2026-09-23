# Pine export: user-selected alert source

Status: proposed M5–M7 customer workflow. Offline export utilities exist in the repository, while authenticated Bot-scoped export, owner review/import and Email Report for this revised workflow remain planned.

Integration: [the revised roadmap](ROADMAP.md) sequences Bridge generation, a Bot Paper run, one source-parity-backed Quant optimization run, mode-specific export and owner review. The owner may apply the reviewed values and start the Bot again; the workflow then ends. No post-export Paper acceptance cycle or automatic return to Quant is required. Historical QL-1 through QL-4 work is recorded in [the archived roadmap](ROADMAP_ARCHIVE_2026-09-24.md).

## Candidate and risk prerequisites

Preserve user indicator logic and keep Bridge ATR-for-SL and RR separate from all source inputs. The Bridge always initializes its own pair to versioned defaults 2.0 and 1.5. One Pine / one Bot must optimize every strategy input parameter and that pair; multiple Pine scripts / one Bot freeze source inputs and optimize only the shared Bridge pair. Preserve source hashes and an input-only diff; record Bridge changes separately.

Expose Webhook ready, Optimization supported and Export validated as independent states. Protected/unsupported indicators can use available alert hooks without being advertised as optimizable. Webhook events alone are insufficient to evaluate alternative inputs. Preset-overridden and visual-only inputs must be identified before defining the search space.

- Export only a supported strategy template/indicator combination with a selected immutable optimization run and its baseline, out-of-sample and cost-stress evidence. Do not promise conversion of arbitrary Python code into Pine.
- Capture requested settings, the account/bot policy snapshot, permitted optimization bounds and their versions. The optimizer cannot raise hard limits or disable locked guards. VPS execution still rechecks current policy and cash.
- Declare equity basis, fees/slippage/spread, market-rule rounding, indicator warm-up, candle/session conventions and stop/exit assumptions. Map costs explicitly; Pine's fixed-tick slippage cannot be silently treated as a dynamic percentage model.
- Validate the selected source's indicator/signal/transaction timing and sizing on matched datasets. Track source-specific validation separately from strategy profitability. Changing any material assumption marks that evidence stale.
- The initial UI is operator/private tooling with Risk Policy, Optimization Bounds, Validation Results and Export & Deployment views; customer access requires the scoped APIs and isolation gates in the roadmap.

## Export selection

Before generating a package, the user must select exactly one alert source. Do not silently select or change the source for an optimized strategy.

Offer both sources with capability explanations. Existing `alert()` hooks may need a private transport adapter to format execution JSON. An `indicator()` cannot generate native strategy order-fill events: that option requires a separate validated `strategy()` wrapper preserving the original signal logic. Mark unavailable modes clearly instead of silently rewriting the original. Generated setup instructions alone cannot add missing alert hooks to protected code.

| UI option | Package value | Trigger | TradingView setup |
| --- | --- | --- | --- |
| Signal events — `alert()` | `alert_calls` | The selected strategy signal condition and configured calculation/frequency policy | Select **alert() function calls only**. The script supplies the JSON message. |
| Strategy order-fill events | `order_fills` | An order is filled by TradingView's broker emulator | Select **Order fills only** and use `{{strategy.order.alert_message}}` as the alert message. |

Order-fill events are simulated TradingView fills, not confirmation of an order or fill at Robot Trade or an external broker. The UI and setup guide must say this clearly in EN/TH.

Each TradingView deployment uses one alert source. A multiple-Pine Bot package may contain one deployment per member script, all tied to the same shared Bridge pair and export_id. A combined “both” execution option is outside this requirement. Comparison packages need distinct deployment identities and must not execute the same logical event twice on one Bot.

## Generated artifacts

Step 5 has exactly two user-facing deliverables:

1. **Best Inputs package** — `inputs.json`, a supported Pine Script output and TradingView `setup.md`.
2. **Email Report** — a concise, owner-scoped summary of the Best Inputs and the Quant evidence needed to review them for the selected Bot's Risk Manager.

| Bot connections | Best Inputs and Pine edits | Email recommendations |
| --- | --- | --- |
| One Pine / one Bot | Optimize every strategy input parameter plus Bridge ATR-for-SL and RR, and export the complete optimized set. Unsupported parameters block a complete optimized export. | Complete Best Inputs summary; only the independent Bridge pair maps to Bridge settings on Bot Risk Manager. |
| Multiple Pine scripts / one Bot | Export only best shared Bridge ATR-for-SL and RR as actionable input values. Generated Pine copies preserve each source's inputs and logic and apply only the Bridge pair; Setup Guide identifies all affected scripts. | Only the best Bridge pair as recommended settings, plus Bot/Pine identities, timestamps and aggregate Quant metrics. |

Resolve the connected Pine count and membership on the server, not from indicator counts or a client mode flag. Keep fixed source-input snapshots privately for reproducibility. Membership or source changes invalidate the associated validation. For one Pine, the earlier 10-parameter ceiling is superseded: all strategy input parameters and the Bridge pair enter optimization with explicit domains and bounds. Credentials, transport/display settings and hard Bot limits remain configuration. Multiple-Pine research must evaluate the combined fixed signals under shared Bot limits rather than average independent per-script winners.

Each source receives `pine_import_id` when registered in Step 1/2. A server-issued `export_id` identifies one immutable Best Inputs package and its Email Report, bound to `bot_id`, `run_id`, all participating `pine_import_id`/source-version pairs and the risk-policy snapshot. Include these IDs and an ISO-8601 UTC creation timestamp in package metadata and email. Report creation and outbox enqueue use `export_id` as an idempotency key. SMTP delivery follows at-least-once semantics; duplicate deliveries carry the same report ID.

The Email Report includes actual recommended values, `bot_id`, one or more `pine_import_id` values, `run_id`, `export_id`, generation timestamp, policy version/hash, validation and stale status, objective, train/validation/test scores, trade/sample count, maximum drawdown, Win Rate, Profit Factor and fee/slippage assumptions. Only the Bridge ATR/RR pair maps to Bridge Settings on Bot Risk Manager; source inputs belong in Pine. Include an authenticated review link. Send only to the verified Bot owner, without webhook URLs/secrets or broker credentials.

Email is a notification and review aid; it does not apply values to a Bot or start it. The owner opens the authenticated review view and checks the Best Pine Inputs and proposed Bot Risk Manager settings. On explicit apply, the server rechecks Bot ownership, policy version, Bridge-setting bounds and stale evidence, then records an audit event without changing hard limits or guards. Pine-only source values remain in the Best Inputs package. If the owner chooses to start the Bot with the reviewed Pine values, the setup guide explains deliberate alert replacement. A stale or incompatible candidate cannot be silently applied. The owner may also finish without applying or starting the Bot.

- `strategy.pine`: Pine v6 generated from a supported strategy template and the selected parameters, risk snapshot and alert source.
- `inputs.json` and an input-change list: original and optimized existing input values, effective preset, source hash and run identity; this is the default existing-indicator deliverable.
- `indicator.pine` (when source is available/supported): an optional private copy with approved input defaults and separately disclosed transport edits. Preserve original trading logic and source notices.
- For existing-indicator exports, `strategy.pine` is a separate validated simulation/order-fill wrapper, not a replacement for the original indicator. Never claim arbitrary Pine source can be converted automatically with equivalent behavior.
- `strategy.json`: strategy identity/version, selected parameters, `alert_source`, calculation/fill assumptions and supported symbols/timeframes.
- `risk-profile.json`: versioned risk snapshot; never overrides current server hard limits automatically.
- `setup.md`: source-specific TradingView condition, message, symbol/timeframe and webhook setup instructions. Keep webhook credentials outside shareable packages.
- `validation.html`: parity results for the selected source and disclosure of execution differences.

These files form the Best Inputs package; they do not add extra user-facing delivery categories beyond the package and Email Report.

The source must be visible in the export preview, package metadata, strategy header and eventual deployment/log UI. Include `alert_source` in the versioned webhook contract when that contract is implemented; do not assume the current receiver validates this new field.

## Webhook and deployment contract

The [R-1 allocation contract](ROADMAP.md#historical-r-1--per-entry-positions-and-targeted-tpsl) establishes server-owned independent entries and targeted TP/SL. Exports reuse accepted ownership semantics: preserve P1/P2 targets and actual-fill-based sizing, handle multiple exits per candle, and reject incompatible receivers rather than falling back to legacy full-symbol exits. The current SPT Bridge still needs source-specific acceptance for this revised workflow.

Execution ownership follows [UNIVERSAL_RISK_MANAGER.md](UNIVERSAL_RISK_MANAGER.md). Map exits to a strategy-owned position group and declared quantity/percentage basis. Never export an unscoped close-all signal as the default for multiple indicators sharing a bot/symbol. Older deployment groups retain explicit exit ownership during replacements.

Plan `schema_version`, `strategy_id`, `strategy_version`, `deployment_id`, `risk_profile_version`, `alert_source`, `bar_close_time` and an event sequence alongside existing event/price/risk fields. The deployment binds these to the selected run, bot and risk profile on the server. Final field names/compatibility rules are validated in QL-1/QL-2 before receiver changes in QL-4.

Do not use a payload `user_id` as authorization. Keep webhook secrets and broker credentials out of exported files. Separate stable event identity from timestamps used for signal-age checks; retain original event time and receipt time for audit. Preserve legacy clients through a versioned compatibility path rather than assuming new metadata already works.

Display requested versus applied quantity, effective risk version and any rejection/capping reason in trade reconciliation. Define unknown/stale deployment behavior and existing-position exit ownership before rollout. A Pine BUY event can be rejected by the VPS, and an emulator position must never be treated as confirmation of a VPS position.

## Generation rules

For `alert_calls`:
- Generate execution messages through `alert()` only, with an explicit frequency/calculation policy. Bar-close signals are the initial supported baseline.
- If the same strategy includes simulated orders for backtesting, suppress their order-fill alerts using supported `disable_alert` parameters. The setup guide must still select only alert() calls.

For `order_fills`:
- Generate complete JSON `alert_message` payloads for each supported entry, partial/full exit, TP and SL fill event.
- Do not also emit execution webhooks through `alert()`.
- Define order creation time, simulated fill time, price and quantity semantics explicitly. These values are not actual VPS cash, inventory or broker fills.

For both sources:
- Event identity must be stable per logical event, distinct across legitimate scale-ins/partial exits, and separate from send timestamps. Include deployment identity in duplicate handling.
- The VPS authenticates the destination bot, validates the versioned contract, rechecks current risk/balance and calculates or caps execution size. It records the original signal and resulting order separately.
- The selected source affects timing and backtest assumptions; do not switch source by changing a label on the same validation result.
- Changing source creates a new export/deployment version and requires recreating the TradingView alert. Document a switchover that disables the previous alert and resolves existing position/exit ownership without leaving duplicate entry routes.
- Never claim the exporter automatically creates or inspects a user's TradingView alert settings.

## Acceptance criteria

1. UI requires a source selection and supports EN/TH explanations.
2. Each selection generates the correct Pine template, metadata and matching setup guide.
3. Template tests verify that the unselected execution alert path is disabled/absent and JSON is valid for all supported event types.
4. Pine compilation and Strategy Tester checks are recorded in TradingView; local text/template tests alone are insufficient.
5. The pre-optimization Paper run verifies webhook intake and produces the session/fill/data record used by Quant Lab. Do not make a second post-export Paper run a condition for completing this workflow.
6. Event timing and source metadata in the source parity/export evidence reconcile with the available TradingView and Paper records. Any differences in simulated/actual sizing and rejection reasons are visible to the owner.
7. Source changes invalidate prior source-specific validation and create a clearly versioned deployment with documented alert replacement.
8. Exported risk/optimization metadata round-trips without loss of monetary precision or relaxation of account limits. Run, template, dataset and policy versions identify the evidence behind each package.
9. Unknown/stale versions and overlapping old/new alerts are tested with existing open positions; the transition must preserve explicitly authorized exits without duplicate entries.
10. Input-only optimization preserves source logic: changes outside approved input values are absent from the indicator logic diff, baseline signals match the supported evaluator, and ineffective/preset-overridden fields are excluded or explicitly resolved through existing inputs.
11. Unsupported/closed-source indicators remain connectable only through their actual exposed alert capabilities; the UI does not claim optimization, hidden-value access or order-fill support without verified prerequisites.
12. Every eligible export produces the Best Inputs package and an owner-scoped Email Report with matching `export_id`, `pine_import_id` member list, Bot/run provenance, UTC timestamp, input values and key metrics. Report creation/outbox enqueue are idempotent; duplicate mail deliveries can be recognized by report ID. NO_VALID_CANDIDATE and EMAIL_FAILED are separate from EXPORT_READY.
13. Email delivery alone cannot mutate Risk Manager settings or start a Bot. Explicit owner review of Best Pine Inputs and Bot Risk Manager settings revalidates owner, Bot, policy version, bounds and evidence freshness and records an audit event. Starting a Bot with the reviewed values is a separate explicit owner action and ends this workflow; it does not launch another optimization automatically.

Reference: [TradingView Alerts](https://www.tradingview.com/pine-script-docs/concepts/alerts/) and [Strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/).
