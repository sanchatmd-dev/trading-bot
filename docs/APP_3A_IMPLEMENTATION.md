# APP-3A implementation record

Status: **implementation and isolated receiver tests advanced; APP-3A exit gate remains open**. Date: 2026-09-24. This record supplements [ROADMAP.md](ROADMAP.md) and [PINE_BRIDGE_ADAPTER_API.md](PINE_BRIDGE_ADAPTER_API.md). It does not reduce their acceptance requirements.

## Implemented

- Optional PostgreSQL extension version 1 on base schema 14: owner/Bot-scoped source registry, immutable revisions, membership, jobs/attempts, deployment snapshots, trusted evidence/market records and event/allocation mappings.
- Authenticated analyze/generate/status/cancel APIs, cookie/CSRF/Origin checks, durable idempotency, queue/concurrency limits, deadline/lease recovery, cancellation and usage accounting. Provider outcomes that may have consumed work are not automatically resent.
- Pine v5/v6 indicator preflight; strategy rejection before provider dispatch; 2 independent Bridge numeric slots plus 0–8 selected source slots. Effective input overrides are typed and recorded. Original source bytes remain unchanged; effective settings must be applied in TradingView and reviewed.
- Direct AI API with versioned prompt/guide. AI proposes identifiers and eligibility; backend validates those proposals and renders the reviewed template. No MCP connection or AI-generated executable block enters the backend.
- Private draft UI with dropdown mapping, status/cancel, Pine/manifest/guide downloads and logout cleanup. Membership/revision/activation operations are API capabilities; the UI remains a draft builder.
- Scoped `bridge-exit-v1` receiver and Paper worker. Accepted BUY fills atomically acquire entry/allocation mappings; rejected BUY events acquire none. EXIT resolves the exact open allocation. Duplicates are idempotent; changed payloads with the same event ID conflict. Legacy webhook behavior remains separate.
- Independently collected closed OHLCV and ATR(14), frozen entry-close levels, tick/quantity rounding, recorded fee/slippage model, next-bar protection, SL-before-TP-before-native priority and BUY suppression on exit bars. Missing trusted data or evidence blocks execution.
- Snapshot checks at activation, receipt and queued BUY execution. Source/membership changes invalidate entry routes. Policy/funding changes invalidate BUY freshness. Replacement keeps old deployments EXIT_ONLY, allowing scoped exits. Creating an independent draft does not replace an active deployment until activation.
- Operator-recorded evidence plus owner activation. Runtime DB privileges cannot write evidence or verified bars. Activation requires one connected Pine; multi-Pine activation remains blocked until APP-3B. Activation does not start a Bot or confer Quant support.

The scanner is structural, not a Pine compiler. AI eligibility is a proposal, not proof of signal dependencies. Every deployment starts DRAFT; compilation and source-specific review must be recorded separately.

## Configuration and operation

Feature defaults off (`PINE_BRIDGE_ENABLED=0`). Production database, services, alerts and configuration were not changed. No paid AI request or email was sent. Tests used a separate temporary PostgreSQL cluster, private Unix socket and disposable databases; production credentials and data were not used.

The optional extension is separate from schema 14. Before rollout, take a protected backup, stop API/workers under the maintenance lock, run `node --env-file-if-exists=.env scripts/migrate-pine-bridge.mjs`, and reapply `scripts/grant-postgres-runtime.sql`. Never migrate automatically on service startup. The isolated migration rollback and backup/restore rehearsal passed; this is not a production migration claim.

The direct adapter allowlists `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano`. Privately configure `PINE_AI_MODEL`, `PINE_AI_API_KEY`, both per-million rates and `PINE_AI_RATE_VERSION`. No default pricing is assumed. Other models/providers need a compatible accounting adapter. The adapter counts full source and compact mapping metadata with pinned `js-tiktoken@1.0.21` / `o200k_base`, plus a 1,024-token framing reserve. Limits remain 24,000 input / 4,000 output per attempt, two attempts only for explicit rate refusal, 56,000 reserved tokens and USD 0.50 per job. Polling performs no provider calls. Source is not truncated. See [tokenizer documentation](https://www.npmjs.com/package/js-tiktoken) and [Chat API](https://developers.openai.com/api/reference/resources/chat).

Trusted market ingestion is a separate operator process: `node --env-file-if-exists=.env scripts/collect-pine-bars.mjs BTCUSDT 1D`. It requires a restricted market writer identity; never give its write permission to the API/AI role. The initial collector supports Binance Global USDT spot and explicitly listed intervals, 1,000 contiguous bars and 500 warmup bars. Other markets can produce drafts but require their own verified data adapter before activation. The collector freezes the first bar and rejects changed OHLCV or venue metadata. ATR comparison permits relative floating-point noise up to 1e-10 only when both frozen levels still match exactly at the tick. Collector scheduling and bar arrival before webhook intake remain deployment tasks; absence of a bar rejects intake and must not be represented as successful delivery.

After real source-specific review, an operator records the complete evidence JSON using `scripts/record-pine-bridge-evidence.mjs DEPLOYMENT_ID REVIEWED_EVIDENCE_JSON`. This binds source, artifact and snapshot hashes, numeric gates, execution model and references. The owner can then POST `{}` to `/api/quant/pine-bridge/deployments/{id}/activate`. A generic READY flag cannot substitute for evidence. Fixture evidence must never be copied into a real deployment.

Sources/jobs currently remain until explicit operator-managed deletion; idempotency exceeds the 24-hour minimum. Customer retention/deletion controls and accumulated-storage quotas remain pending before rollout. Private source and provider bodies are not included in audit errors.

## Verification

- Node suite: **123 passed, 0 failed** (includes 12 Bridge core/market/UI tests).
- Full isolated PostgreSQL suite: **45 passed, 0 failed**, including 17 Bridge scenarios. Covers actual receiver/worker fills, duplicate/foreign/unknown targets, stale policy/funding, revisions, old exits, concurrent admission/shutdown, crash rollback, HTTP authentication/CSRF/ownership and backup/restore plus restricted runtime grants.
- Receiver/worker fixtures include 10 SL, 10 TP, 5 both-touched, 5 native/Bridge conflict, 5 rejected and 5 capped cases. Fixture timestamps and market data are synthetic. These establish backend behavior, not TradingView-to-market parity.
- TradingView: generated v6 fixture compiled and ran on standard BINANCE:BTCUSDT 1D. The wrong-symbol runtime guard was first observed on AAPL; changing to the registered chart removed the runtime error and displayed both EMA plots. No compile diagnostic was visible after successful addition. The fixture has no native alert calls before the Bridge. No alert was created or published.
- Reproducible fixture: `tradingview/fixtures/app3a_indicator.pine`, assembled with `scripts/build-pine-bridge-fixture.mjs NEW_OUTPUT_PATH`. Source SHA-256: `9da68b9dfea1b4863d0573fbf3a153030566ebf94375cdfc31b91663f5cf9f8d`; integrated SHA-256: `e3c5dd0e714142cfa5d193cc6c70c59eb722c343a8ac1eb4655874c1388830d3`.
- No live provider delivery, actual SPT compilation, source-specific TradingView webhook capture, market-feed parity or production readiness is claimed.

## SPT review and remaining gates

The original hash still matches R-0. Scanner reads all 58 inputs and reports `request.security`, `ta.pivothigh`, `ta.pivotlow` as Quant dependencies. `buySignal` / `sellSignal` are visible globals. Native `alert()` occurs inside `f_sendNotify`, gated by `notifyEnabled`; setting that existing input false is the candidate isolation configuration, still requiring TradingView verification. `alertcondition()` declarations do not prove alert isolation.

Source presets override several numeric inputs unless `preset=Custom`. Source SL/RR inputs (`slAtrBufferInput`, `minRiskATRInput`, `rr1`–`rr5`) remain separate from the Bridge pair. Their relevance must be reviewed; the scanner's 20 numeric candidates are not an approved optimization list. Visual input `lineForwardBars` must not become an optimization dimension.

The initial byte-bound budget rejected SPT. The pinned tokenizer and compact metadata now admit the full original analysis at **21,745 reserved input tokens**, including framing. This is a local token count, not a successful AI call or price quotation. Source lines over 4,096 UTF-8 bytes are rejected before tokenization (`SOURCE_LINE_TOO_LONG`) to bound pathological long-literal processing. An initial stress test exposed this delay and caused older timestamp-based tests to expire; the final regression is after adding this resource guard.

Before closing APP-3A:

1. Configure an approved provider privately and exercise one actual analyze/generate job, recording measured usage and failure handling. No usable provider configuration was supplied during this increment.
2. Compile the actual integrated SPT candidate; review all warnings, effective settings, Custom preset dependencies, signal bindings and native-alert isolation. The simple fixture does not substitute for SPT acceptance.
3. Verify the market collector against TradingView closed bars and ATR, plus recorded tick/fee/slippage rules. Arrange trusted collection before intake; retain missing-data rejection until this is proven.
4. Capture controlled TradingView BUY, targeted EXIT and duplicate delivery on an isolated receiver. Attach real source-specific evidence and then exercise owner activation. Existing synthetic HTTP/worker fixtures cannot certify external delivery or source parity.

Only after these gates pass may QL-2A start. SMTP 550 remains an independent Email Report delivery gate.
