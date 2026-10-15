# PM-1 baseline — 2026-10-15

Baseline PM1-B1-2026-10-15 completes all 54 inventory rows (40 project, 14 prototype), including explicit UNKNOWN credits. Source checkpoint: `faa32a43bd6aa9342c349b155b2ea6c23ec296a7`. This is engineering progress, not acceptance readiness, measured labor, or a confidence interval.

| View | Evidence-supported lower bound | Upper bound | Weight of rows containing UNKNOWN |
| --- | ---: | ---: | ---: |
| project | 46.12% | 70.40% | 72.57% |
| prototype | 52.00% | 82.42% | 75.83% |

No single percentage or midpoint is justified. UNKNOWN weight counts the entire weight of each affected row; it is neither unfinished work nor the width of the interval. Historical estimates 70%/85% and 60%/75% are NON-COMPARABLE. This first baseline has no prior baseline and no progress delta.

## Method and reproducibility

For each deliverable, credit = 0.10D + 0.40I + 0.30V + 0.20T. Multiply by the frozen category weight and deliverable share, then sum per view. Stages are cumulative: I requires D; V requires D/I; T requires D/I/V. Enumerate all legal assignments to UNKNOWN credits to obtain bounds. Weights and equal shares were frozen before scoring; no target or denominator was changed to fit a headline.

[Method](../PROGRESS_MEASUREMENT.md), [frozen inventory](PM1_INVENTORY_V1_2026-10-15.json), [complete scorecard and SHA-256 evidence manifest](PM1_BASELINE_2026-10-15.json), [assessment A](PM1_ASSESSMENT_A_2026-10-15.json), [assessment B](PM1_ASSESSMENT_B_2026-10-15.json), [independent verification](PM1_VERIFICATION_2026-10-15.json). Assessment proposals are retained unchanged; final root decisions and overrides are in the scorecard.

```powershell
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_BASELINE_2026-10-15.json
```

Run from the checkout with source Git objects available. The original local design evidence is retained byte-for-byte as `PM1_LEGACY_DESIGN_2026-10-15.md`; if the ignored source is absent on another checkout, restore that copy to `.qa-local/codex-legacy-optimize-design-2026-10-15/REPORT.md` before replay. Never overwrite a changed source: compare its SHA-256 with the manifest first.

## Category contributions

These are percentage-point contributions to each view, not category completion percentages.

| View/category | Weight | Lower contribution | Upper contribution |
| --- | ---: | ---: | ---: |
| project/F01 | 10 | 5.00 | 9.33 |
| project/F02 | 12 | 6.00 | 11.20 |
| project/F03 | 12 | 9.12 | 10.32 |
| project/F04 | 10 | 6.00 | 9.20 |
| project/F05 | 12 | 4.40 | 8.40 |
| project/F06 | 10 | 5.00 | 7.00 |
| project/F07 | 10 | 7.50 | 7.75 |
| project/F08 | 6 | 3.00 | 5.40 |
| project/F09 | 6 | 0.00 | 0.60 |
| project/F10 | 4 | 0.00 | 0.40 |
| project/F11 | 4 | 0.00 | 0.40 |
| project/F12 | 4 | 0.10 | 0.40 |
| prototype/P01 | 15 | 7.50 | 15.00 |
| prototype/P02 | 15 | 4.50 | 6.75 |
| prototype/P03 | 20 | 10.00 | 17.33 |
| prototype/P04 | 20 | 15.00 | 20.00 |
| prototype/P05 | 20 | 10.00 | 14.00 |
| prototype/P06 | 10 | 5.00 | 9.33 |

## Deliverable scores

D = accepted design; I = implementation; V = independent verification; T = declared target acceptance. U = UNKNOWN. Each reference resolves to a pinned source in the JSON manifest; historical source identity and carry limits are preserved there. Local engineering acceptance does not imply staging or production acceptance.

| ID | Outcome | Target | D/I/V/T | Evidence | Next reconciliation or gate |
| --- | --- | --- | --- | --- | --- |
| F01-01 | Owner authentication and tenant-scoped access | staging | 1/1/U/U | E001, E002, E003 | Reconcile dispatcher/session/tenant tests and retained staging scope. |
| F01-02 | Bot creation and lifecycle | staging | 1/1/U/0 | E004, E005 | Owner-authorized capacity-compatible Create Bot and lifecycle journey. |
| F01-03 | Shared UI and journey visibility | staging | 1/1/U/U | E006, E005, E004 | Reconcile final UI scope and P1-F behavioral evidence. |
| F02-01 | Single-Pine registry, AI generation and guide | staging | 1/1/U/U | E003, E007, E008 | Root decide frozen oneoff versus ongoing generator applicability, reconcile hashes. |
| F02-02 | Ten-input selection and round-trip | staging | 1/1/U/0 | E005, E009, E010 | Authenticated ten-input generation/snapshot round-trip. |
| F02-03 | Versioned authenticated transport and scoped targeting | staging | 1/1/U/U | E003, E011 | Reconcile scoped receiver dependency changes before historical verification carry. |
| F03-01 | Paper risk decisions, allocation and targeted EXIT baseline | staging | 1/1/U/U | E003, E012, E011 | Reconcile exact corrected accounting baseline and staging identity. |
| F03-02 | O3/G1/F4 accounting corrections | local integrated code | 1/1/1/1 | E008, E013, E014 | Root confirm bounded accounting carry despite separate PO1 integration failure; host migration/deploy separateF12. |
| F03-03 | Worker transient faults, bounded rejection and systemic hold | staging | 1/1/1/0 | E008, E014, E015 | Stage final W1 closure under authorized release and observe. |
| F03-04 | Database transaction and runtime lease integrity | staging | 1/1/0/0 | E016, E013 | Complete fixture closure, independently verify original6 cases, root integration and exactCI, later staging. |
| F03-05 | Tracked script and source writer guard | local test integration | 1/1/1/1 | E017 | None for bounded inventory outcome; preserve explicit limits. |
| F04-01 | Spot ingestion and bounded BACKFILL provenance | staging | 1/1/1/1 | E018 | None for oneoff outcome; PF2/R7 separate. |
| F04-02 | Prototype charts and market-data diagnostics | staging | 1/1/U/U | E011, E019, E004 | Reconcile chart/diagnostic final bytes and exact label coverage. |
| F04-03 | PF-2 historical Preflight | staging | 1/1/U/0 | E020, E021, E022 | R7 admission/enrollment and PF2 activation under owner gates. |
| F04-04 | PF-3 readiness report | staging | 1/1/U/U | E008, E004 | Reconcile PF3 changed functions/tests and authenticated final report. |
| F04-05 | PF-4 deterministic Risk proposals | staging | 1/1/U/0 | E008, E004 | Reconcile changes then owner-confirmed saved-policy journey under authorized stopped state. |
| F05-01 | Supported source evaluator baseline | local validated engine | 1/1/U/U | E012, E023 | Reconcile fixed evaluator source/hash closure against current engine. |
| F05-02 | Selected-input empirical parity and supported effects | staging qualification | 1/0/0/0 | E005, E024 | Owner dimension decision and new frozen lock if approved, then declared effects/parity proof. |
| F05-03 | Cost, chronological validation and holdout semantics | local validated engine | 1/1/U/U | E025, E012, E026 | Reconcile current cost/partition/holdout implementation against retained checks. |
| F06-01 | Immutable research jobs, progress and cancellation | staging | 1/1/U/U | E001, E002, E026 | Map current durable-job closure to applicable independent acceptance and staged recovery. |
| F06-02 | Bounded optimizer execution and terminal outcome | staging admitted run | 1/1/1/1 | E026, E008, E006 | Root confirm review-record pins sufficient for frozen oneoff V; no new run required to earn profit. |
| F06-03 | Legacy optimize request and transaction containment | local integrated code | U/0/0/0 | E027 | Root approve deadline/outcome contract then bounded implementation/verification. |
| F07-01 | W7 recovery and D6 diagnostic admission prerequisites | supervised staging | 1/1/1/1 | E028, E029, E030, E008 | Fresh R7 measurement and PF-2 remain separate. Root confirm this historical-outcome interpretation. |
| F07-02 | R7 J1-J4 scheduler and resource-accounting cases | supervised staging | 1/1/1/1 | E031, E032 | Fresh measurement epoch. |
| F07-03 | EM2 measurement controller and recovery tooling | local accepted tooling | 1/1/1/1 | E033, E034, E035, E036 | Operational effect contract, release and admitted epoch; no authority follows from local completion. |
| F07-04 | Fresh R7 capacity measurement and qualification | supervised staging | U/0/0/0 | E037, E031 | Root finalize reviewed amendment/effects and owner gates before admitted epoch. |
| F08-01 | Owner-scoped Library storage and inspection | staging | 1/1/U/U | E008, E004, E038, E039 | Reconcile Library final UI/API bytes to accepted historical/CI records. |
| F08-02 | QR-1b durable artifact freeze | staging | 1/1/U/0 | E038, E040 | Reconcile final verification; owner D1-D4 and staging restore/GO/catalog gates. |
| F09-01 | Qualified Best Inputs package and validation | staging | U/0/0/0 | E041, E008, E042 | Eligible M4 evidence, reviewed package contract, compilation/provenance/validation. |
| F09-02 | Export and matching email report delivery | staging | U/0/0/0 | E041, E008, E043 | Validated package, SMTP 550 remediation, matching report and confirmed owner receipt. |
| F09-03 | Explicit review, import and owner handoff | staging | U/0/0/0 | E041, E008 | QL-4C validated fresh package and explicit owner review/import. |
| F10-01 | QR-2 actual Paper portfolio performance | staging | U/0/0/0 | E042, E008 | Finalize allocation/valuation/return contract then implement QR-2. |
| F10-02 | QR-3 full fair comparison | staging | U/0/0/0 | E042, E008 | Define complete common context and independent evidence, then QR-3. |
| F10-03 | QR-4 qualified best-performance selection | staging | U/0/0/0 | E042, E008 | QR-2/QR-3 and eligible independent validation before qualified selection. |
| F11-01 | Multi-Pine contracts and evaluator/package compatibility | isolated accepted fixture | U/0/0/0 | E041, E001, E008 | Reviewed isolated multi-source evaluator/package fixture. |
| F11-02 | APP-3B multi-Pine Paper isolation and canary | staging | U/0/0/0 | E008, E044 | Define measured thresholds, then isolated implementation and shared-symbol Paper canary. |
| F12-01 | MD-1 production market-data scaling | production qualification | U/0/0/0 | E008 | Fix target load and agreed threshold; operational/data-rights contracts. |
| F12-02 | Customer lifecycle, quotas and entitlement | Paper beta | U/0/0/0 | E045, E046, E008 | Bound customer lifecycle/entitlement/quota contract after APP-3B. |
| F12-03 | Customer security and launch operations | Paper beta | U/0/0/0 | E008, E045 | Reviewed customer operational/security contract, restore/alerts/concurrent-service checks. |
| F12-04 | Reviewed Paper production rollout and observation | production | 1/0/0/0 | E045, E008, E047, E048, E049, E050 | Root reconcile DP1 contract; close dependencies, observations, policy and production GO gates. |
| P01-01 | Generate the supported Bridge and guide | staging owner journey | 1/1/U/U | E003, E007, E008 | Root decide frozen oneoff versus ongoing generator applicability, reconcile hashes. |
| P02-01 | Ten-input round-trip and coherent selection | staging owner journey | 1/1/U/0 | E005, E009, E010 | Authenticated ten-input generation/snapshot round-trip. |
| P02-02 | Effects and parity of the selected dimensions | staging qualification | 1/0/0/0 | E005, E024 | Owner dimension decision and new frozen lock if approved, then declared effects/parity proof. |
| P03-01 | Historical Preflight on an admitted supported profile | staging owner journey | 1/1/U/0 | E020, E021, E022 | R7 admission/enrollment and PF2 activation under owner gates. |
| P03-02 | Readiness with honest historical status | staging owner journey | 1/1/U/U | E008, E004 | Reconcile PF3 changed functions/tests and authenticated final report. |
| P03-03 | Policy-bound Risk preview and save | staging owner journey | 1/1/U/0 | E008, E004, E004 | Reconcile changes then owner-confirmed saved-policy journey under authorized stopped state. |
| P04-01 | Real same-entry TradingView BUY and targeted EXIT | staging owner journey | 1/1/1/1 | E006, E011 | No repeat required for this frozen one-off pair; current deployment and wider accounting gates remain separate. |
| P04-02 | Paper risk, isolation and ledger reconciliation | staging owner journey | 1/1/U/U | E003, E012, E011 | Reconcile exact corrected accounting baseline and staging identity. |
| P05-01 | Snapshot, progress, cancel and durable result controls | staging owner journey | 1/1/U/U | E001, E002, E026 | Map current durable-job closure to applicable independent acceptance and staged recovery. |
| P05-02 | Current profile capacity and admission | supervised staging | U/0/0/0 | E037, E031 | Root finalize reviewed amendment/effects and owner gates before admitted epoch. |
| P05-03 | One bounded supported terminal run | staging admitted run | 1/1/1/1 | E026, E008, E006 | Root confirm review-record pins sufficient for frozen oneoff V; no new run required to earn profit. |
| P06-01 | Reopen and inspect preserved runs | staging owner journey | 1/1/U/U | E008, E004, E038, E039 | Reconcile Library final UI/API bytes to accepted historical/CI records. |
| P06-02 | Artifact durability and freeze | staging owner journey | 1/1/U/0 | E038, E040 | Reconcile final verification; owner D1-D4 and staging restore/GO/catalog gates. |
| P06-03 | Minimal compatible comparison and qualification display | staging owner journey | 1/1/U/U | E008, E004, E038 | Reconcile final Library comparison bytes and independent acceptance evidence. |

## Acceptance gates

Gate statuses remain separate from the arithmetic. They do not grant a GO.

| Gate | Status | Scope | Limitation or next step |
| --- | --- | --- | --- |
| G-BRIDGE | PASS | Historical fixed supported Bridge engineering and natural same-entry Paper pair | Not current host health or arbitrary Pine support. |
| G-INPUTS | OPEN | Authenticated ten-input selection and all selected empirical effects/parity | Close S4 behavioral and remaining S6/S7 acceptance within the frozen selection contract. |
| G-PREFLIGHT | BLOCKED | PF-2 target activation and accepted historical outcome | Close capacity/enrollment and the separately authorized measurement/activation gates. |
| G-R7 | OPEN | Current R7 measurement epoch and capacity qualification | Review amendment and obtain the required successful runtime measurement; J1-J4 prerequisite success is narrower. |
| G-PO1-CI | BLOCKED | Current runtime lease integration closure | Verify the unintegrated fixture correction with a complete PF2 fixture and close exact-commit CI. |
| G-DP1-24H | OPEN | Staging worker 24-hour observation | Observe and review no earlier than 2026-10-15T22:17:53.400Z (2026-10-16 05:17:53.400 Asia/Bangkok). Time alone is not a pass. |
| G-PRODUCTION | BLOCKED | Production Paper correction rollout | Close staging observation, policy, live identity/dependency and release gates before authorized deployment. |
| G-FREEZE | OPEN | QR-1b target migration and owner policy decisions | Resolve the required policy and target integration gates; local evidence does not prove staging migration. |
| G-LAUNCH | OPEN | MD-1, customer Paper beta and qualified export/delivery | Implement and accept the declared remaining product and launch outcomes. Optional Live remains excluded. |
| G-FRESH-HEALTH | UNKNOWN | Current host health at scoring time | No host access in this measurement task; historical observations are dated evidence only. |

## Next comparison

Preserve this inventory and scorecard. Create a new dated snapshot, cite new evidence and reconcile source equivalence per changed row. With the same inventory, report lower/upper changes and resolved UNKNOWN weight separately; never subtract midpoints. If scope, weights, shares or targets change, version the inventory and report the scope effect separately before claiming progress. No product tests, host access, deployment, or new operational acceptance occurred during this measurement.
