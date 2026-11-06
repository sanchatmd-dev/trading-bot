# P1-F acceptance record (2026-11-06)

Status: DRAFT, not accepted. This record is filled from Root's working record of the P1-F walkthrough. It is not acceptance, not a GO and not a status claim. Root decides acceptance after the open items in the Status section are closed. Reading B applies, so this is a narrower acceptance, never a full six-step matrix pass.

Sources for the clauses: the six-step acceptance matrix and the P1-F row of the staging prototype plan, part 4 of the owner walkthrough of 2026-10-31, the PM-1 S3 prototype rows, the P1-F gap map of 2026-11-02, and the record template of 2026-11-02. Owner decisions are from the owner's chat reply recorded in Root ruling SB161.

## Header

| Field | Value |
| --- | --- |
| Pin | API `75c7a5b`; trading worker `ba1a433` (as recorded in the Roadmap status; live staging state was not re-verified by this record, so the pin is as recorded, not independently confirmed) |
| Dates of walkthrough | 2026-11-02 to 2026-11-06 |
| Reading | B, journey with recorded gaps (owner decision D-P1F-0, 2026-11-02) |
| Other owner decisions | D-S2-1 yes (generate and store the draft, do not activate); D-S2-2 yes (development window and parity method, no holdout access); D-S3-1 preview only (no save); D-S6-1 no (the library freeze is not in P1-F scope) |
| Walkthrough by | Root drove the pages at the owner's request, inside the owner's own signed-in sessions (staging UI and TradingView web), desktop only. The owner did not drive these steps. Nearest template evidence kind: Root read-alongside; it is stated plainly here that Root operated the pages, so no row is an owner observation. The Part 3 alert was created by the owner in TradingView. |
| Record filled by | Root (draft prepared by the documentation role from Root's working record) |

Unchanged gates, not touched by this record: Spot/Paper only. Live locked. Private acceptance NOT RUN. READY false. P13j and N1 held. No GO is open unless the active handoff says so.

## How to fill a row

- Observed result: what was actually seen, in plain words. Blank if nothing was seen.
- Evidence kind, one of: owner observation; Root read-alongside; read-only readback; historical carry; local test. A read-only readback needs its own owner GO first. In this record, "Root read-alongside (Root-driven)" means Root operated the page at the owner's request.
- Pin: the release the evidence was observed on, as recorded (API `75c7a5b`, worker `ba1a433`). A historical carry names the older release and is never the current pin.
- EN / TH and Desktop / Phone: only combinations actually observed are marked. Unobserved stays blank. Phone was not observed for any row. "TH (render)" means the section was opened in Thai on desktop on 2026-11-06 in a view-only pass and rendered in Thai; the row's result was not re-verified in Thai.
- Verdict: PASS, FAIL, RECORDED GAP or NOT RUN. RECORDED GAP means an honest "not available yet" state was seen and written down; it is not a pass. A partial result in the working record is recorded here as RECORDED GAP or NOT RUN, with the reason, because a clause that names a full set cannot pass on part of it.
- Depends on: the owner decision the verdict hinges on, if any.

Column key for all tables below: Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on.

## Step 1. AI chatbot bridging

Source used: an owner-pasted Pine v5 indicator (public library imports kept). The owner supplied it as a source they may use; Root did not verify licence terms.

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 An actual AI job runs from an authorized source and its effective inputs (no canned response) | 2026-11-02: inspect (no AI) found 8 inputs; the analyze job succeeded in 4 s on attempt 1 and the generate job (3e056763) succeeded in 5 s on attempt 1, both with a real AI provider and recorded cost (about 0.008 and 0.009 USD). The AI diagnostic was specific to the source (it mapped the indicator's own reversal signals to BUY and EXIT and noted the indicator's inverted naming), so it was not canned. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | PASS | none |
| 1.2 The job returns a complete Pine draft | Draft of 161 lines and 9,390 characters. The original source is unchanged and found verbatim inside the draft (0 original bytes changed, 3,905 appended). 5 imports kept, 10 input declarations, 2 bridge alert calls (BUY and EXIT), confirmed-bar logic and ATR used. No URL and no long secret-like literal in the Pine. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | PASS | none |
| 1.3 The job returns a guide | The page showed the downloads (draft, setup guide, bindings) and the ordered TradingView steps (replace script, save, add to chart, set reviewed inputs, create the Bridge alert only, optional capture). The setup-guide file content itself was not read (the file fetch failed), so only the on-screen guide is evidenced. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | PASS | none |
| 1.4 Source and input identity is reproducible and bound to the draft and guide | The SHA-256 recomputed in the page from the submitted text equals the displayed hash, the job's source hash and the result's source hash (prefix 71132102). The result binds deployment 8e60d7d0, the Pine import, the instruction versions and a source span and input id per input. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | PASS | none |
| 1.5 A failure is shown plainly and can be retried | No failure occurred and none was forced. | | | | | NOT RUN | none |
| 1.6 Owner compiles the draft in TradingView | 2026-11-02, at the owner's request, in the owner's signed-in TradingView web session: Root rebuilt the stored draft (length, line count and hash prefix c4032096 checked equal), pasted it into the Pine Editor, and the console showed "Compiled" and "Added to chart" on the BTCUSDT 1m chart with plotted values and no runtime error mark. Root, not the owner, performed the compile. The draft was then saved as a private script (not published). A compiler warning was noted: the bridge template compares the chart symbol id with a fixed string, which could raise a false runtime error on a chart with extra symbol settings (product backlog finding, not fixed). | Root read-alongside (Root-driven in the owner's TradingView session) | 75c7a5b / ba1a433 | EN | Desktop | PASS | none |

Step 1 verdict count: PASS 5, NOT RUN 1. Bridge capability blockers (TradingView compile review, signal mapping review, effective input snapshot review, native alert isolation, Paper evidence) were shown on the page on 2026-11-02, before the compile (1.6), the saved script and the capture; the current blocker state is UNKNOWN (no later readback). Deployment 8e60d7d0 stays DRAFT and is not activated (owner decision D-S2-1).

## Step 2. Ten numeric inputs

This source has 5 eligible numeric inputs and 3 fixed non-numeric inputs (each with an explicit excluded reason). With the Bridge ATR Multiplier and RR, 7 of the 10 slots were exercised. Ten needs a source with at least 8 eligible numeric inputs, such as the SPT Custom ATR60 prototype source (20 eligible).

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 Owner explicitly selects eight eligible numeric source inputs plus Bridge ATR Multiplier and RR (ten in all) | Only 5 source inputs were eligible, plus ATR (2.0) and RR (1.5): 7 of 10. Slots 3 to 7 were selected in the UI by Root on the owner's instruction, not by the owner. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-S2-1 |
| 2.2 All ten round-trip through the UI | The review step showed all 8 source inputs with defaults equal to the source. Seven slots were exercised; ten were not, so the clause cannot pass. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | RECORDED GAP | D-S2-1 |
| 2.3 All ten round-trip into the generated Pine | The generated Pine declares the 8 source inputs and the 2 bridge inputs (ATR multiplier, RR). Slots do not change the Pine (UI note). The 7 exercised slots are consistent; ten were not exercised. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-S2-1 |
| 2.4 All ten round-trip into the stored snapshot (slot count and hash recheck) | The stored result bindings hold 7 slots (ATR 2, RR 1.5, five source inputs with effective values equal to defaults). The hash recheck of the stored snapshot was not run; it needs a read-only staging read under its own GO. | Root read-alongside (Root-driven), bindings read on the page only | 75c7a5b / ba1a433 | EN | Desktop | NOT RUN | D-S2-1 |
| 2.5 No input is silently dropped or truncated | The 8 source inputs resolve to 5 slots plus 3 fixed inputs with explicit excluded reasons. Nothing was silent. Scope: this source only. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | PASS | D-S2-1 |
| 2.6 Each input shows a declared optimizer range | Ranges are shown for the 5 source slots (Root chose them from the declared minimum, maximum and step). The ATR and RR bindings carry no search domain in the bridge result; whether the Quant page shows them was not checked. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-S2-1 |
| 2.7 Each input has a real supported effect | For this source the quant capability reads UNSUPPORTED (evaluator required for array, matrix and import use), so an effects replay is impossible on this source. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-S2-2 |
| 2.8 Fresh scoped TradingView and evaluator parity for the changed input set | Same evaluator reason as 2.7. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-S2-2 |

Step 2 verdict count: PASS 1, RECORDED GAP 6, NOT RUN 1. Notes: the contract supports 2 to 10 slots; no filler inputs were invented; no arbitrary Pine support is claimed. Bridge defaults are not individualized Risk advice.

## Step 3. Preflight and suggested Risk values

Reading B and D-S3-1 apply: view and preview only. Nothing was saved. The journey page stated Preview available with readiness CAPABILITY_UNAVAILABLE and historical evidence UNAVAILABLE (PF-2 not enabled).

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.1 Report shows signals, intents, fills and rejects (historical Preflight from PF-2) | The Historical Preflight step reads "closed on this server" (PREFLIGHT_DISABLED) and Start Preflight is disabled. An honest not-available state, no report. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | RECORDED GAP | D-P1F-0 |
| 3.2 Report shows cash, exposure and data limitations | Readiness verdict CAPABILITY_UNAVAILABLE and historical evidence UNAVAILABLE; an honest state, no cash or exposure report. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | RECORDED GAP | D-P1F-0 |
| 3.3 Proposals are deterministic and stay within owner limits | A proposal (18966376) was computed for Main Bot with no declared limits (the owner's choice). Determinism by rerun and limit adherence were not exercised. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | NOT RUN | none |
| 3.4 Proposals show before and after values with provenance | The proposal showed the policy before and after (remaining daily notional 100000, executions 10) and advisories (loss guards locked, capital never changed, historical after-state not simulated). A sizing proposal with provenance was not seen. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | NOT RUN | none |
| 3.5 Stale inputs are detected | Not exercised. | | | | | NOT RUN | none |
| 3.6 Values are saved only on explicit user save | The Save control was disabled and the confirmation box unticked. No save was made (D-S3-1 preview only), so the clause is not exercised. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | NOT RUN | D-S3-1 |
| 3.7 User can type values by hand and rerun the preview | Not exercised. The sizing preview needs an Order Preview price and stop loss; it waits for the owner's numbers. | | | | | NOT RUN | none |
| 3.8 A preview is never presented as approval to Run | The page stated "These limits change nothing". No Run approval was shown, and the Save control stayed disabled. Root ruling P1F-R2: the observed page satisfies the clause for this preview. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | PASS | none |

Step 3 verdict count: PASS 1, RECORDED GAP 2, NOT RUN 5. Observations from 2026-11-02. "TH (render)" in this step means the section opened in Thai; the Risk manager area still has the untranslated lines listed in the Thai section.

## Step 4. Real signal transport and Paper execution

Alert target: deployment 8e60d7d0 (a DRAFT on Main Bot, not activated), through a CAPTURE_ONLY capture session with execution disabled, created by Root on staging at the owner's request on 2026-11-02. The owner created the TradingView alert and pasted the capture address; Root never read, printed or typed that address. Because execution is disabled on this path, no Paper fill is expected from it.

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1 A real TradingView BUY arrives through the authenticated webhook | Read-only capture read on 2026-11-06 in the owner's session: the capture is open, CAPTURE_ONLY, 32 real deliveries received (16 BUY and 16 EXIT, strictly alternating, 32 unique event ids), 0 rejected, 0 duplicates, no error, 32 of 100 event limit; first bar 2026-11-02, newest bar 2026-11-05. The owner created the single alert; there was no resend. The read was made at the owner's chat request of 2026-11-06 (owner asked Root to do the alert check); no separate GO was issued. Capture-only: this shows transport into the capture, not execution. | Root read-alongside (Root-driven read-only capture read, owner session) | 75c7a5b / ba1a433 | EN | Desktop | PASS | none |
| 4.2 A targeted reduce-only EXIT is traced | EXIT messages arrived in the capture, but no reduce-only EXIT was traced through execution (execution disabled on this path). The 2026-10-04 historical pair is a carry rule 1 question, pending Root. | | | | | NOT RUN | none |
| 4.3 Risk decision and allocation are visible end to end | Not run: capture-only path, execution disabled. | | | | | NOT RUN | none |
| 4.4 Paper fill and ledger entry are visible end to end | Not run: no Paper fill is expected from a capture-only path, and Root made no Paper or Live action; whether any Paper fill happened elsewhere on staging is UNKNOWN (not read). | | | | | NOT RUN | none |
| 4.5 Duplicate rejection verified independently | Capture shows 0 duplicates received; duplicate rejection on execution was not exercised. | | | | | NOT RUN | carry rule 2 |
| 4.6 Capped or rejected entry is shown as such and its accounting reconciles | Not exercised. | | | | | NOT RUN | carry rule 2 |
| 4.7 Owner isolation verified independently | Not exercised. | | | | | NOT RUN | carry rule 2 |

Step 4 verdict count: PASS 1, NOT RUN 6. History: on 2026-11-02 Root stopped four TradingView alerts on the owner's decisions (three capture-only alerts that posted failures to closed captures, then the old ETRP (2, 3) alert); nothing was deleted. Finding for the owner (Root changed nothing): on 2026-11-06 the alert "SPT Spot Bridge v4 STAGING CAPTURE ONLY 1m" is still Active and its deliveries fail with a 404 against a closed capture; the owner decides whether to stop it.

## Step 5. Quant optimizer

Reading B: view only. No job was submitted. The page states that research admission is closed ("You can inspect and prepare inputs") and the journey page shows the step as Paused.

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.1 User submits one admitted bounded job | Not submitted. Admission is closed; a new run needs open admission and fresh gates. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-P1F-0, D-S5-1 |
| 5.2 Progress is visible | Progress controls exist but stay hidden until a job exists. No job ran. | | | | | NOT RUN | D-P1F-0 |
| 5.3 Cancel is available and works | Cancel controls exist but stay hidden until a job exists. Not exercised. | | | | | NOT RUN | D-P1F-0 |
| 5.4 The job ends in a durable terminal result | No new job. Three preserved runs show terminal states (two ended with no valid candidate, one failed), dated 2026-09 and 2026-10; whether they stand in under reading B is carry rule 3, pending Root. | | | | | NOT RUN | D-P1F-0 |
| 5.5 Selected source dimensions and the Bridge pair take part in the declared search | No new job; the preserved run used an older lock. | | | | | NOT RUN | D-P1F-0, D-S5-1 |
| 5.6 Validation and holdout rules are enforced | No new job. The preserved run page shows holdout not evaluated. | | | | | NOT RUN | D-P1F-0 |
| 5.7 With admission closed, the page states plainly that the optimizer is paused | The research job panel states that research admission is closed and the journey page states Paused, admission closed. Not a canned result. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | PASS | D-P1F-0 |

Step 5 verdict count: PASS 1, RECORDED GAP 1, NOT RUN 5. Observations from 2026-11-02.

## Step 6. Quant Library and selection

D-S6-1 is no: the library freeze is a later gap with its own migration GO.

| Clause | Observed result | Evidence kind | Pin | EN/TH | Desktop/Phone | Verdict | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6.1 Completed, failed, insufficient and cancelled runs persist with full provenance | The library shows 3 runs (2 completed, 1 failed; insufficient 0, cancelled 0, in progress 0), so the insufficient and cancelled kinds were not shown. The inspected run lists its own provenance gaps (no effective input review hash, engine release unknown, no parity or repaint evidence, no immutable finish time, result not frozen in the database, no benchmark objective) and blockers. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | RECORDED GAP | none |
| 6.2 Runs reopen after a restart | The runs from 2026-09 and 2026-10 are still listed after the later API restarts (including the 2026-10-31 re-pin restart). | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | PASS | none |
| 6.3 A run can be inspected in detail | Inspecting run 7552f3e6 showed the Bot, created and finished times, status NO_VALID_TRAIN_VALIDATION_CANDIDATE, 21 evaluated and 0 screened, holdout not evaluated. Whether the exposure register state appeared was not recorded. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | PASS | none |
| 6.4 Only compatible results compare; incompatible pairs are refused with a reason | Compare is disabled until runs are selected; no pair was compared. | | | | | NOT RUN | none |
| 6.5 Development scores are kept apart from qualified recommendations | The development score is labelled in-sample and not a recommendation. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | PASS | none |
| 6.6 No winner is shown when none qualifies | The library reads "Qualified recommendations: none. No qualified winner." | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN; TH (render) | Desktop | PASS | none |
| 6.7 Freeze presence | Out of P1-F scope by D-S6-1. The inspected run lists "result not frozen in the database" as a gap. | Root read-alongside (Root-driven) | 75c7a5b / ba1a433 | EN | Desktop | RECORDED GAP | D-S6-1 |
| 6.8 Applying settings or starting a Bot stays a separate owner action | Not exercised. | | | | | NOT RUN | none |

Step 6 verdict count: PASS 4, RECORDED GAP 2, NOT RUN 2. Observations from 2026-11-02 (the 6.3 exposure register state was not recorded; Root ruling P1F-R2 treats that note as optional for this view-only pass).

## Thai (TH) desktop pass, 2026-11-06

View only, in the owner's signed-in session, owner away: each nav section was opened by its nav button only (no action button, no save, no job), the visible text was sampled, then the language was set back to English. Every section rendered in Thai (nav labels and most text): Overview, Prototype journey, Trade log, Bot Manager, Analytics, Risk manager, Quant Lab, Build Pine Bridge (steps 1 and 2), Research job, Research Library. English-only lines were mostly names and codes.

RECORDED GAP (untranslated UI text in Thai): the Quant Lab synthetic backtest area (about 28 lines), the Risk manager (about 27 lines), and one Analytics sentence (historical analytics unavailable while managed Quant execution is enabled).

Phone: NOT RUN for every row.

## Totals

Row count: 6 + 8 + 8 + 7 + 7 + 8 = 44. Verdicts: PASS 13, FAIL 0, RECORDED GAP 11, NOT RUN 20. This is a count of rows under reading B, not a matrix pass.

## Carry rules: Root rulings

None of these is a pass. Root ruling P1F-R2 (2026-11-06): none of carries 1 to 5 is used for any verdict in this record; each stays as labelled historical context (older release, date, what it shows and does not show), which meets rule 6. A later Root ruling may revisit a carry only with a new record entry. No carried evidence is used in any verdict above.

1. Historical natural BUY and targeted EXIT pair (accepted 2026-10-04 on an older release). Ruling to make: does it stand in for clause 4.2 on the current pin? Under any ruling it is a historical carry on an older release, never current-pin evidence, and it does not certify current host health. Pending Root.
2. Local duplicate, cap and isolation controls. Ruling to make: are they acceptable as the independent evidence for clauses 4.5 to 4.7, or is a read-only staging readback needed (own owner GO)? Pending Root.
3. Historical optimizer run of 2026-10-02 (21 candidates on 6,600 bars, ended with no valid candidate, old lock, older release). Ruling to make: under reading B only, may it stand as historical evidence for clauses 5.4 to 5.6? It does not show progress or cancel on the current pin, and it did not use the new ten-input lock. Pending Root.
4. Historical real-provider AI evidence on an older release (one visible failure, a successful retry, two complete drafts). Ruling to make: does it carry for clause 1.5 only, with 1.1 to 1.4 needing a fresh job on the current pin? Pending Root. (Clauses 1.1 to 1.4 now have a fresh job on the current pin, recorded above.)
5. Historical Preflight and Risk evidence from earlier packets. Ruling to make: does any of it carry for clauses 3.1 to 3.6, given PF-2 is not running on staging? Pending Root.
6. Any carried row must state: older release, date, what it shows and what it does not show. Pending Root.

## What Root must not claim

- No full six-step matrix pass under reading B. Under reading B, steps 3 and 5 may at most show RECORDED GAP for the missing parts, and the record is a narrower acceptance, labelled as such.
- No acceptance of P1-F before the owner walkthrough has happened and this record is filled and reviewed. The owner phone pass and the other open items below are not done.
- No pass from a historical carry unless Root has first written the ruling above, and even then it is labelled historical.
- No claim that a preview is approval to Run, that a suggested value is advice, or that a development score is a qualified recommendation.
- No claim that a step passed on desktop or phone, or in EN or TH, unless that combination was observed. Phone was not observed; TH was a view-only render pass.
- No claim about live staging state that no read-only readback or owner observation supports; write UNKNOWN instead.
- No claim that full QR-2 portfolio valuation, email delivery or the QL-4B/QL-4C export features are done, and no whole phase marked green from this narrower acceptance; they stay separate unfinished scope.
- No evidence that is not sanitized: keep identifiers, addresses, secrets and machine locations out of this record.
- No lifting of any gate: Spot/Paper only, Live locked, private acceptance NOT RUN, READY false, P13j and N1 held.
- This record is not a GO and issues none. Any host effect named in a row needs its own GO under recorded owner authority.

## Status

DRAFT, not accepted. Gates unchanged: Spot/Paper only, Live locked, private acceptance NOT RUN, READY false, P13j and N1 held.

Remaining before Root acceptance:

1. Owner phone pass (all rows are Desktop only).
2. Sizing preview with the owner's numbers (preview only under D-S3-1; no save).
3. The 2.4 snapshot hash recheck, which needs a read-only staging read under its own GO.
4. Thai text gaps recorded, not fixed on staging: the Quant Lab backtest area, the Risk manager, and one Analytics sentence (a local text fix is in preparation; the owner reviews the Thai wording before any deploy).
5. Owner decision on the still-Active alert "SPT Spot Bridge v4 STAGING CAPTURE ONLY 1m" that fails with 404 against a closed capture.
6. A true ten-slot proof needs a source with at least 8 eligible numeric inputs (for example the SPT Custom ATR60 prototype source); the owner chooses the source.
7. Product backlog: the bridge template's fixed symbol-id comparison raises a compiler warning (1.6); not fixed.

Root rulings already made (P1F-R2, 2026-11-06): carries are context only (above); 3.8 PASS on the observed page; 2.2 and 2.3 stay RECORDED GAP (seven of ten slots, the clause names ten); 3.4 stays NOT RUN (no sizing proposal with provenance was seen).
