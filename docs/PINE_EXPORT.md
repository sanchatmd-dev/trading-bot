# Pine export: user-selected alert source

Status: planned requirement. The exporter and its UI are not implemented yet. The existing Universal Signal Bridge remains unchanged.

Integration: [ROADMAP.md](ROADMAP.md), extended from planning baseline `e4e473e`. QL-1 defines shared strategy/risk contracts, QL-2 proves accounting/risk parity, QL-3 produces constrained optimization candidates, and QL-4 delivers export plus Paper validation. The roadmap's shared Risk Management requirements apply to both sources.

## Candidate and risk prerequisites

The user-facing requirement is to preserve the user's existing indicator logic and optimize only selected existing inputs. Templates and simulation adapters are internal. Preserve the original source/hash and provide an input-only diff; transport hooks and a strategy wrapper are separately reviewed artifacts, not optimizer changes to the indicator.

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

Each exported deployment uses one source. A combined “both” execution option is outside this requirement. Users may create separate packages for comparison, but those must have distinct deployment identities and must not unintentionally execute the same strategy twice on one bot.

## Generated artifacts

- `strategy.pine`: Pine v6 generated from a supported strategy template and the selected parameters, risk snapshot and alert source.
- `inputs.json` and an input-change list: original and optimized existing input values, effective preset, source hash and run identity; this is the default existing-indicator deliverable.
- `indicator.pine` (when source is available/supported): an optional private copy with approved input defaults and separately disclosed transport edits. Preserve original trading logic and source notices.
- For existing-indicator exports, `strategy.pine` is a separate validated simulation/order-fill wrapper, not a replacement for the original indicator. Never claim arbitrary Pine source can be converted automatically with equivalent behavior.
- `strategy.json`: strategy identity/version, selected parameters, `alert_source`, calculation/fill assumptions and supported symbols/timeframes.
- `risk-profile.json`: versioned risk snapshot; never overrides current server hard limits automatically.
- `setup.md`: source-specific TradingView condition, message, symbol/timeframe and webhook setup instructions. Keep webhook credentials outside shareable packages.
- `validation.html`: parity results for the selected source and disclosure of execution differences.

The source must be visible in the export preview, package metadata, strategy header and eventual deployment/log UI. Include `alert_source` in the versioned webhook contract when that contract is implemented; do not assume the current receiver validates this new field.

## Webhook and deployment contract

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
5. Separate Paper forward tests verify each source: an eligible logical event executes at most once, retries are deduplicated, rejected entries remain visible, and partial exits remain correctly identified without overselling inventory.
6. Event timing and source metadata reconcile across TradingView, webhook logs and VPS Paper orders. Differences in simulated/actual sizing and rejection reasons are visible.
7. Source changes invalidate prior source-specific validation and create a clearly versioned deployment with documented alert replacement.
8. Exported risk/optimization metadata round-trips without loss of monetary precision or relaxation of account limits. Run, template, dataset and policy versions identify the evidence behind each package.
9. Unknown/stale versions and overlapping old/new alerts are tested with existing open positions; the transition must preserve explicitly authorized exits without duplicate entries.
10. Input-only optimization preserves source logic: changes outside approved input values are absent from the indicator logic diff, baseline signals match the supported evaluator, and ineffective/preset-overridden fields are excluded or explicitly resolved through existing inputs.
11. Unsupported/closed-source indicators remain connectable only through their actual exposed alert capabilities; the UI does not claim optimization, hidden-value access or order-fill support without verified prerequisites.

Reference: [TradingView Alerts](https://www.tradingview.com/pine-script-docs/concepts/alerts/) and [Strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/).
