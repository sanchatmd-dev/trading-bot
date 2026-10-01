# Staging preview P0 — 2026-10-01

Status: **P0 visible preview deployed on staging; awaiting the owner's signed-in
walkthrough.** This is an early preview of the six-step journey, not six-step
acceptance. Paper only; Live stays locked. The governing plan is the
[staging prototype delivery plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md); the
[Roadmap](ROADMAP.md) owns status and gates.

## What changed

Release `533755b` adds a **Prototype journey** page and two read-only,
owner-scoped status endpoints:

- `GET /api/quant/research/history` lists preserved research runs with
  whitelisted summary fields. It stays readable while new research admission is
  closed and never returns contracts, steps, full results or Pine source.
- `GET /api/quant/pine-bridge/overview` reports Bridge source, AI job and
  deployment counts, the configured provider and model, and whether the AI
  provider is usable. It never returns Pine source, requests, drafts, provider
  request identifiers or credentials.

No schema, migration, grant, engine-hashed file, Risk rule or guard changed.

## Staging runtime after the switch

| Component | State after P0 |
| --- | --- |
| Staging API | Release `533755b`. Research admission stays closed through the existing B1 setting; foundation, V2 profile, enrollment and preflight stay off. |
| Staging trading worker | Release `533755b`. Previously it ran a mixed tree with four modules older than the API release, including an AI request builder without the filter that blanks non-numeric input values. |
| Research worker, market stream, fallback collector timer | Unchanged and still on their earlier code. |
| Database | Unchanged: schema 14 with the existing Bridge, capture and research extensions. |
| Production | Untouched. |

The switch used new unit drop-ins that set the release directory and keep the
same start command and environment files. Each unit can be rolled back
independently by renaming its drop-in, reloading the user manager and restarting
that unit. The previous API release directory must be kept because the API still
reads one environment file from it.

## Open the preview

The staging web interface listens on the VPS loopback interface only; public HTTPS
forwards only TradingView webhook routes to staging. Open an SSH tunnel from your
own computer that forwards local port 18081 to port 18081 on the VPS loopback
interface, then browse to exactly `http://127.0.0.1:18081`. The staging origin is
configured with `127.0.0.1`; a `localhost` address is rejected by the sign-in
origin check. Sign in with your staging account; agents do not type owner
passwords.

## Walkthrough

1. **Prototype journey** (left menu, second item) — six cards with live status,
   evidence from the API and the next dependency for each step.
2. **AI chatbot Bridge** — Quant Lab → *Build Pine Bridge*. *Inspect inputs* runs
   locally without AI. *Analyze* and *Generate* send the authorized indicator to the
   configured provider and return a draft Pine with a guide. A fresh end-to-end AI
   job has not been run on this release yet; each job has a small provider cost.
3. **Ten numeric inputs** — the contract supports up to eight selected numeric
   source inputs plus Bridge ATR Multiplier and RR. A supported source with eight
   eligible inputs still has to be selected and round-tripped (P1).
4. **Preflight and Risk settings** — Risk manager → *Order Preview* shows saved or
   hypothetical Draft authority, Generic or Bridge mode, venue filters and cost
   estimates. A preview saves nothing. Historical Preflight and recommendations
   (PF-2 activation, PF-3, PF-4) are not available yet.
5. **Real signals and Paper execution** — Trade log shows each signal from receipt
   through the Risk decision to the simulated fill. Staging has received no signal
   since 2026-09-27; a real BUY and targeted EXIT trace remains P1 work.
6. **Quant optimizer** — for the account that submitted it, the journey card shows the preserved 100-candidate run
   with its original identity and result `NO_VALID_CANDIDATE`. New research jobs
   stay closed until the foundation gates pass.
7. **Quant Library and selection** — run history only. There is no qualified
   recommendation and no qualified winner.

## Verification

- Local: full Node suite 846 passed, 0 failed (5 skipped); focused UI suites 44/44
  and PostgreSQL journey and research HTTP suites 13/13 rerun independently.
- Hosted CI for `533755b`: 9/9 checks passed, including PostgreSQL and Windows.
- Local browser check against an isolated fixture database with a temporary test
  account: sign-in, six cards fed by the real server endpoints, 375-pixel mobile
  layout without horizontal overflow, and Thai translation.
- Staging switch: verified release extraction (722 files) and service restarts;
  the served page and script match the release bytes; the new endpoints and
  `/api/me` return 401 without a session; health is ok and Paper-only; the
  research admission flag stayed closed; other staging and production processes
  kept their identities; no queued work, signal or AI job was affected.

## Known limitations

- The legacy synthetic Quant Lab backtest, optimizer and risk-preview routes call
  the production Quant bridge on loopback. Foundation mode later denies backtest
  and optimize; avoid using these legacy tabs on staging until then.
- The fallback market collector timer is a confirmed fifth staging database
  writer. B2 must give it a recovery definition and quiesce it with the other
  writers before any offline migration.
- B2 previously planned to start the research worker on the dormant `28d6f7e`
  release. The API now runs `533755b`, so B2 must use one release for both API and
  research worker; the release pin for B2 and W7 must be re-decided and recorded
  before the offline packet.

## Next

The owner signs in and walks through the page. Then P1 starts in the plan order:
B2 recovery and offline foundation work (P1-A), PF-3/PF-4 (P1-B), the TradingView
signal trace (P1-C), the bounded optimizer run (P1-D) and the library (P1-E).
