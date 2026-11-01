# P1-F acceptance record template (2026-11-02)

This is a blank template, not a result. Root fills it during and after the owner's P1-F walkthrough. Nothing here is acceptance, a GO or a status claim. Every verdict starts as NOT RUN. Root decides each verdict; no agent or document fills a verdict on Root's behalf.

Sources for the clauses: the six-step acceptance matrix and the P1-F row of the staging prototype plan, part 4 of the owner walkthrough of 2026-10-31, the PM-1 S3 prototype rows, and the P1-F gap map of 2026-11-02 (a local planning input).

## Header

| Field | Value |
| --- | --- |
| Pin | API `75c7a5b`; trading worker `ba1a433` (as recorded in the Roadmap status; live staging state not verified by this template, so Root confirms before use) |
| Date of walkthrough | (blank until the walkthrough) |
| Reading | (blank until owner decision D-P1F-0: A strict matrix, or B journey with recorded gaps) |
| Walkthrough by | Owner, through the owner's own sign-in and port forward. Root reads alongside, view only, and never opens the staging UI itself. |
| Record filled by | Root |

Unchanged gates, not touched by this record: Spot/Paper only. Live locked. Private acceptance NOT RUN. READY false. P13j and N1 held. No GO is open unless the active handoff says so.

## How to fill a row

- Observed result: what was actually seen, in plain words. Leave blank if nothing was seen.
- Evidence kind, one of: owner observation; Root read-alongside; read-only readback; historical carry; local test. A read-only readback needs its own owner GO first.
- Pin: the release the evidence was observed on. A historical carry names the older release and is never the current pin.
- EN / TH and Desktop / Phone: mark each combination that was actually observed. Unobserved stays blank.
- Verdict: PASS, FAIL, RECORDED GAP or NOT RUN. RECORDED GAP means an honest "not available yet" state was seen and written down; it is not a pass.
- Depends on: the owner decision the verdict hinges on, if any. Decisions: D-P1F-0 (strict matrix or journey with gaps), D-S2-1 (generate and store the ten-input draft without activating it), D-S2-2 (development window and parity method for the effects proof, no holdout access), D-S3-1 (PF-4 save on a staging Bot, and which Bot), D-S5-1 (which lock a new optimizer run uses), D-S6-1 (is the freeze in P1-F scope).

Process note: publishing the updated walkthrough and the commit/push at this checkpoint are not evidence rows. Root records them in the result record, not as matrix evidence.

Column key for all tables below: Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on.

## Step 1. AI chatbot bridging

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 An actual AI job runs from an authorized source and its effective inputs (no canned response) | | | | | | NOT RUN | none |
| 1.2 The job returns a complete Pine draft | | | | | | NOT RUN | none |
| 1.3 The job returns a guide | | | | | | NOT RUN | none |
| 1.4 Source and input identity is reproducible and bound to the draft and guide | | | | | | NOT RUN | none |
| 1.5 A failure is shown plainly and can be retried (the matrix says failure is visible and recoverable; a failure may not occur on demand) | | | | | | NOT RUN | none |
| 1.6 Owner compiles the draft in TradingView (owner action; not a matrix clause, taken from the PM-1 S3 prototype rows, which list it as not re-exercised) | | | | | | NOT RUN | none |

## Step 2. Ten numeric inputs

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 Owner explicitly selects eight eligible numeric source inputs plus Bridge ATR Multiplier and RR (ten in all) | | | | | | NOT RUN | D-S2-1 |
| 2.2 All ten round-trip through the UI | | | | | | NOT RUN | D-S2-1 |
| 2.3 All ten round-trip into the generated Pine | | | | | | NOT RUN | D-S2-1 |
| 2.4 All ten round-trip into the stored snapshot (slot count and hash recheck) | | | | | | NOT RUN | D-S2-1 |
| 2.5 No input is silently dropped or truncated | | | | | | NOT RUN | D-S2-1 |
| 2.6 Each input shows a declared optimizer range | | | | | | NOT RUN | D-S2-1 |
| 2.7 Each input has a real supported effect (local effects replay on an authorized development window; no holdout access; private acceptance stays NOT RUN) | | | | | | NOT RUN | D-S2-2 |
| 2.8 Fresh scoped TradingView and evaluator parity for the changed input set | | | | | | NOT RUN | D-S2-2 |

Notes for step 2 (plan caveats, not verdict rows): the contract supports 2 to 10 slots; no filler inputs may be invented; no arbitrary Pine support is claimed. Bridge defaults (Bridge ATR Multiplier and RR) are not individualized Risk advice.

## Step 3. Preflight and suggested Risk values

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.1 Report shows signals, intents, fills and rejects (historical Preflight from PF-2) | | | | | | NOT RUN | D-P1F-0 |
| 3.2 Report shows cash, exposure and data limitations (readiness report; with PF-2 off, an honest "historical unavailable" state is expected; honest-state check, not a matrix clause) | | | | | | NOT RUN | D-P1F-0 |
| 3.3 Proposals are deterministic and stay within owner limits | | | | | | NOT RUN | none |
| 3.4 Proposals show before and after values with provenance | | | | | | NOT RUN | none |
| 3.5 Stale inputs are detected | | | | | | NOT RUN | none |
| 3.6 Values are saved only on explicit user save (save needs the Bot stopped and the confirmation step) | | | | | | NOT RUN | D-S3-1 |
| 3.7 User can type values by hand and rerun the preview | | | | | | NOT RUN | none |
| 3.8 A preview is never presented as approval to Run | | | | | | NOT RUN | none |

## Step 4. Real signal transport and Paper execution

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1 A real TradingView BUY arrives through the authenticated webhook (owner's single alert check; no resend; a synthetic fixture does not satisfy this clause) | | | | | | NOT RUN | none |
| 4.2 A targeted reduce-only EXIT is traced (a natural EXIT may not occur in the window) | | | | | | NOT RUN | none |
| 4.3 Risk decision and allocation are visible end to end | | | | | | NOT RUN | none |
| 4.4 Paper fill and ledger entry are visible end to end (one new Paper fill, no Live action) | | | | | | NOT RUN | none |
| 4.5 Duplicate rejection verified independently (the owner does not resend on purpose) | | | | | | NOT RUN | carry rule 2 |
| 4.6 Capped or rejected entry is shown as such and its accounting reconciles | | | | | | NOT RUN | carry rule 2 |
| 4.7 Owner isolation verified independently | | | | | | NOT RUN | carry rule 2 |

Note for 4.x: state which Bot is the alert target, so the evidence is not read against a Bot whose report state is held by owner choice.

## Step 5. Quant optimizer

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.1 User submits one admitted bounded job (not submitted in this walkthrough; view only) | | | | | | NOT RUN | D-P1F-0, D-S5-1 |
| 5.2 Progress is visible | | | | | | NOT RUN | D-P1F-0 |
| 5.3 Cancel is available and works | | | | | | NOT RUN | D-P1F-0 |
| 5.4 The job ends in a durable terminal result | | | | | | NOT RUN | D-P1F-0 |
| 5.5 Selected source dimensions and the Bridge pair take part in the declared search | | | | | | NOT RUN | D-P1F-0, D-S5-1 |
| 5.6 Validation and holdout rules are enforced | | | | | | NOT RUN | D-P1F-0 |
| 5.7 With admission closed, the page states plainly that the optimizer is paused (not a canned result; honest-state check, not a matrix clause) | | | | | | NOT RUN | D-P1F-0 |

## Step 6. Quant Library and selection

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6.1 Completed, failed, insufficient and cancelled runs persist with owner, source, input, dataset, engine, cost/policy and validation provenance | | | | | | NOT RUN | none |
| 6.2 Runs reopen after a restart (the recent re-pin restart can be observed) | | | | | | NOT RUN | none |
| 6.3 A run can be inspected in detail (detail view fails closed if the exposure register is present without access; record which state appears) | | | | | | NOT RUN | none |
| 6.4 Only compatible results compare; incompatible pairs are refused with a reason | | | | | | NOT RUN | none |
| 6.5 Development scores are kept apart from qualified recommendations | | | | | | NOT RUN | none |
| 6.6 No winner is shown when none qualifies | | | | | | NOT RUN | none |
| 6.7 Freeze presence (a PM-1 prototype row, not named in the matrix) | | | | | | NOT RUN | D-S6-1 |
| 6.8 Applying settings or starting a Bot stays a separate owner action | | | | | | NOT RUN | none |

Row count: 6 + 8 + 8 + 7 + 7 + 8 = 44.

## Carry rules: Root rulings still to make

None of these is a pass. Each is a ruling Root has not yet made. Record the ruling and its reason here before any carried evidence is used in a verdict.

1. Historical natural BUY and targeted EXIT pair (accepted 2026-10-04 on an older release). Ruling to make: does it stand in for clause 4.2 on the current pin? Under any ruling it is a historical carry on an older release, never current-pin evidence, and it does not certify current host health.
2. Local duplicate, cap and isolation controls. Ruling to make: are they acceptable as the independent evidence for clauses 4.5 to 4.7, or is a read-only staging readback needed (own owner GO)?
3. Historical optimizer run of 2026-10-02 (21 candidates on 6,600 bars, ended with no valid candidate, old lock, older release). Ruling to make: under reading B only, may it stand as historical evidence for clauses 5.4 to 5.6? It does not show progress or cancel on the current pin, and it did not use the new ten-input lock.
4. Historical real-provider AI evidence on an older release (one visible failure, a successful retry, two complete drafts). Ruling to make: does it carry for clause 1.5 only, with 1.1 to 1.4 needing a fresh job on the current pin?
5. Historical Preflight and Risk evidence from earlier packets. Ruling to make: does any of it carry for clauses 3.1 to 3.6, given PF-2 is not running on staging?
6. Any carried row must state: older release, date, what it shows and what it does not show.

## What Root must not claim

- No full six-step matrix pass under reading B. Under reading B, steps 3 and 5 may at most show RECORDED GAP for the missing parts, and the record is a narrower acceptance, labelled as such.
- No acceptance of P1-F before the owner walkthrough has happened and this record is filled and reviewed.
- No pass from a historical carry unless Root has first written the ruling above, and even then it is labelled historical.
- No claim that a preview is approval to Run, that a suggested value is advice, or that a development score is a qualified recommendation.
- No claim that a step passed on desktop or phone, or in EN or TH, unless that combination was observed.
- No claim about live staging state that no read-only readback or owner observation supports; write UNKNOWN instead.
- No claim that full QR-2 portfolio valuation, email delivery or the QL-4B/QL-4C export features are done, and no whole phase marked green from this narrower acceptance; they stay separate unfinished scope.
- No evidence that is not sanitized: keep identifiers, addresses, secrets and machine locations out of this record.
- No lifting of any gate: Spot/Paper only, Live locked, private acceptance NOT RUN, READY false, P13j and N1 held.
- This record is not a GO and issues none. Any host effect named in a row needs its own GO under recorded owner authority.
