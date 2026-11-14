# Set C amendment H3D: research worker proof from the AR3 a07 record, REPIN-3 RW (H3) deferred (2026-11-14)

Status: accepted by Root ruling SB453 on 2026-11-14 after three review rounds (Root applied the round 3 text fixes). Owner decision D1 approved 2026-11-14 in chat: "อนุมัติ เลื่อน RW" ("approve, defer RW"; Root ruling SB451). The owner approved the decision, not this text. Root ruling SB453 accepts this text and accepts prep tool r2 round 2 together; prep r2 is cited below "as accepted under SB453". This amendment is **not a GO**. It authorizes no host step, no tool run and no effect. Every GO of set C still needs its own explicit owner GO.

Source: Root rulings SB449, SB450, SB451, SB452 and SB453 (`.qa-local/s6-setb-p5b-design-2026-10-30/root-ruling-sb1.md`), the RW feasibility audit report of 2026-11-14, the precondition 9 audit report of 2026-11-14 (SB450 item 6) and the F3a local proof report of 2026-11-14 (`.qa-local/s6-setc-design-2026-11-07/f3a-proof/report-root.md`).

The pinned packets keep their bytes: the set C packet (`S6_STAGING_SETC_PACKET_2026-11-13.md`), the pre-read packets (`S6_STAGING_SETC_PREREAD_PACKET_2026-11-14.md`, `S6_STAGING_SETC_PREREAD_M_PACKET_2026-11-14.md`) and the REPIN-3 packet (`S6_STAGING_REPIN3_PACKET_2026-11-06.md`) with its amendment A1 (`S6_STAGING_REPIN3_AMENDMENT_A1_2026-11-07.md`). This document amends them by reference, in the same way as REPIN-3 amendment A1. Where this document and a pinned packet disagree on the H3 gate or on the sources of precondition 9, this document wins.

## 1. Why

SB449: the accepted REPIN-3 AR3 a07 read (sealed tool r12, verdict AR3_PASSED) is the first host record of the RW preconditions. The RW fill refused before any write with UNIT_CONFIG_INFEASIBLE on nine items. SB450: the read-only audit found five of the nine are reader artifacts (keys on MULTI drop-in lines), and for those five the values are still unknown and not proven good. Four of the nine are a design gap (the Node `--env-file` sources are not read). RW (H3) cannot run on the sealed r12 tool.

Set C needs only one fact from H3: the research worker is STOPPED. The sealed pre-read and R0 check only the shape of the h3 entry. Nothing in set C reads the research tree, the RW recovery policy, F06 rows or an RW schema. The wait for H3 existed because a later RWR after SC-3 needs MR-H first. That rule stays and is widened (section 5).

## 2. The change

The set C H3 gate becomes "**research worker STOPPED**". It is proven by the accepted REPIN-3 AR3 a07 record only (read only; envelope sha256 `30434cadc0abe95da235889c8dbc7cf1f6115782f897e482ca9dae0ed70f76b2`; verdict AR3_PASSED; research loaded, inactive, dead, no process, control group empty, Restart no, UnitFileState static). No other record stands in for it. An RW record cannot stand in for it before set C, because a later RW needs a fresh AR3 read after set C (section 5).

The AR3 record is the reference, not a replacement for the live read. The research unit is read live at three points, each with its own check:

- (a) Pre-read (GO-SETC-PR) and SM-form pre-read (GO-SETC-PRM): the sealed tools have no research stop of their own. Root rejects the receipt at acceptance unless the research worker reads inactive (pre-read packet `:74`, SM-form pre-read packet `:84`).
- (b) R0 (GO-SETC-R0): Root writes the research unit `activeState` as `inactive` in `r0-precondition.json` (the `units` member). R0 compares the live `activeState` of every STG_ unit with that member and stops with `P2_UNIT_DRIFT` when they differ (`r0-core.mjs:869`, `:1073`, `:1083`, `:4150`). R0 enforces "inactive" only because Root writes `inactive` there.
- (c) GO-SETC-M: the window gate G1-G9 stops with `SETC_STOP_RESEARCH_ACTIVE` when the research worker is not inactive (set C packet `:220`).

## 3. The honest h3 form

R0 precondition member h3 is exactly:

- `accepted`: true
- `receiptSha256`: the sha256 of the AR3 a07 `receipt-a07.json` (receipt sha256 prefix a3cd04c2; Root enters the full value from the file)
- `acceptedAt`: `2026-11-14T14:56:00.000Z`. This is the SB451 ruling heading time (14:56Z, minute precision), padded to the strict ISO form the sealed reader needs (`r0-core.mjs:108-113`: milliseconds and a round trip through `toISOString`). The short form `2026-11-14T14:56Z` fails that check and gives `PRECONDITION_R0`.
- `researchWorker`: `STOPPED`

The same triple goes into two manifests: the GO-SETC-PR manifest member `h3` and the GO-SETC-R0 manifest member `precondition.h3`:

- `recordReference`: `S6-STAGING-REPIN-3 lane AR3 attempt a07 result - RW deferred by SB451 - research worker STOPPED`
- `resultEvidenceSha256`: `30434cadc0abe95da235889c8dbc7cf1f6115782f897e482ca9dae0ed70f76b2` (the envelope sha256 of `envelope-a07.json`)
- `retainedSha`: the same `receipt-a07.json` sha256 as `receiptSha256`

The AR3 a07 file set has no retained-output file (SB449). The mapping `retainedSha` = `receiptSha256` = the receipt-a07 sha256 is a choice of this amendment, not a fact of the record. Prep tool r2 (AR3 source form), as accepted under SB453, emits exactly this mapping and no other. It pins the AR3 form to attempt a07 and to ruling section SB451 (SB452 item 1); Root passes no `h3.binding`.

This form never claims that RW ran, never claims an RW verdict (RW_PASSED) or an RW end state, never claims that GO-RW-D1 ran, and never claims F06-01 credit. The sealed field set cannot say "RW deferred" by itself; the record reference text and this amendment together carry that fact. The sealed code comments name the H3 gate as "the research worker stopped", which this form meets.

## 4. Effect on each section

Line numbers refer to the pinned files as they stand on 2026-11-14.

**Set C packet**

- Section 3 item 2 (`:74`). Old: H3 is accepted and the research worker is stopped (owner choice U3 "stopped"); if U3 is "idle", the window gate refuses until it is stopped under the H3 or RS tools; the order is after H2 and H3. New: the H3 gate is "research worker STOPPED" under section 2 of this amendment; set C does not wait for REPIN-3 RW. The U3 "idle" branch no longer applies, because the research worker is stopped. The H2 wait, the H6 rule and the H8 and H9 rule are unchanged.
- Section 3 item 9 (`:81`) and SM-6 (`:148`). Old: the QR-3 and fixed-evaluation flags are absent or 0 on every unit, covered through digest equality. New: the sources per unit, and what set C proves for each, are named in section 6 of this amendment.
- Section 5 row R0, part (b) (`:106`). Old: precondition is the REPIN-3 H2 and H3 accepted records. New: H2 as before; h3 is the form of section 3 above.
- Section 9 RR-C-11 (`:345`). Old: after H2 and H3 are accepted with the research worker stopped. New: after H2 is accepted and the research worker is proven STOPPED under section 2. "REPIN-3 RWR is invalid after SC-3 unless MR-H runs first" is unchanged for RWR and widened by section 5 below.
- Section 11, research-worker bullet (`:374`). Old: a return to `eb532ff` needs MR-H first. New: unchanged for a return; the policy now covers every research start (section 5 below).
- Section 13 K5 (`:388`). Old: set C waits for H2 and H3. New: set C waits for H2 and for the research worker STOPPED proof; it no longer waits for H3 (RW). The pin coupling stays.
- Section 13 K6 (`:389`). Old: after SC-3 the old research tree refuses the foundation migration; RWR needs MR-H first. New: the `eb532ff` refusal stays the stated reason for RWR; for any other research start the SB451 policy of section 5 below applies.

**Pre-read packet**

- Section 3 item 1 (`:28`). Old: H3 is accepted by Root ruling because the RW receipt and envelope exist and the research worker is stopped. New: the H3 gate is accepted by Root ruling because the AR3 a07 record proves the research worker STOPPED; no RW receipt is required.
- The SM-form pre-read packet (`S6_STAGING_SETC_PREREAD_M_PACKET_2026-11-14.md`) has no H3 wording of its own; it inherits the set C packet preconditions, so section 3 item 2 above applies to it.

**REPIN-3 packet and amendment A1**

- H3 row (`:25`). Old: GO-RW-D1 starts the research worker, runs one bounded job and may credit F06-01. New: unchanged as a text, but deferred; it is not a prerequisite of set C (section 5 below).
- Note on set C (`:163`). Old: RWR is valid only before H4, or with E3 rolled back first. New: unchanged for RWR; widened by section 5 below.
- Order list item 8 "H3" (`:251`). Old: H3 is step 8 of the REPIN-3 order; A1 item 3 placed set C after it. New: H3 is out of the order before set C; it moves after set C and its own prerequisites.
- Amendment A1 item 3 (`:7`). Old: set C after H2 and H3 are accepted with the research worker stopped (U3). New: set C after H2 is accepted and the research worker is STOPPED under section 2 of this amendment.
- Amendment A1 item 4 (`:8`). Old: REPIN-3 RWR becomes invalid after set C step SC-3 unless MR-H runs first. New: unchanged for RWR; widened by section 5 below.

## 5. New rule and the deferral of RW

**K6 widened (SB451 policy).** While SC-3 reads anything other than ORIGINAL (including partial, OTHER or unreadable), no research worker start on the pin tree or on any other tree without MR-H first (SMR allows MR-H alone from the window state). While SC-3 reads ORIGINAL (before set C, or after MR-H) the rule does not apply. The stated reason for RWR is the `eb532ff` refusal of the foundation migration. For other trees the rule is a policy: RW has never run on the real research configuration (SB449, SB450), so the refusal is not a known fact for them.

**RW (H3) deferred, not cancelled.** A later RW needs all of:

- MR-H first while SC-3 is not ORIGINAL (K6 above),
- a REPIN-3 tool round r13 (reader of the MULTI lines, record-only read of the research `--env-file` sources, helper launched with the worker's own environment; SB450 D2). The r13 read also covers the two keys `QR3_COMPARISON_ENABLED` and `QUANT_FIXED_EVAL_ENABLED` in every source of the research worker, Node env files included (section 6),
- a fresh AR3 read after set C,
- the SB450 D2 owner choices after the r13 AR3, re-pointed fills and RWP, each with its own owner GO (GO-RW-D1 included), and
- a test world that holds the set C state that RW will meet (after MR-H, the end state tuple Q1, not the full window end state).

GO-RW-D1 and GO-RWR stay closed until then. Request set a01 for RW stays prepared and unused; whether it stays valid under r13 is an open item (SB450 item 2). F06-01 credit moves later; this amendment grants none.

## 6. Precondition 9 sources (SB452)

Set C packet section 3 item 9 (`:81`) says `QR3_COMPARISON_ENABLED` and `QUANT_FIXED_EVAL_ENABLED` are absent or 0 on every unit. The sealed tools do not read every source that can set them. The product reads `QR3_COMPARISON_ENABLED` only in the API (`src/postgres/server.js:74`) and the research worker (`src/postgres/quant-research-main.js:30`). It reads `QUANT_FIXED_EVAL_ENABLED` only in the research worker (`quant-research-main.js:28`). The trading worker reads neither key. This section names, per unit, what set C proves for precondition 9 and what it leaves unread.

**API: systemd sources**
- Proven ABSENT by the AR3 a07 `apiFlags` fact. It lists every `*_ENABLED` key of the API process environment (`FLAG_KEY_RE`, `r3-lib.mjs:121`; `r3-lanes.mjs:525`). Neither key is there. Root checked this in SB452. It covers only the systemd-supplied environment of the API process at the time of the read (14:34Z on 2026-11-14).
- Currency: what keeps this fact current up to GO-SETC-M is the window gate G1-G9 (set C packet `:220`) and owner condition SB438 N3 (SM-form pre-read packet `:18-19`). Whether the G1-G9 digests cover the manager environment was not checked. Treat that as a residual until Root checks it.

**API: Node env files (three `--env-file` files)**
No sealed set C tool reads them for these two keys. The sealed SM, PRM and SMR scan them only for the P5A key list. For these files, precondition 9 on the API means the narrowed fact below, and this document wins over set C packet `:81` there.

*F3a (chosen path).* After the accepted GO-SETC-PRM read and close to the GO-SETC-M issue, Root reads one route in the owner's staging session (read only, apart from the session idle touch that every authenticated request makes). The probe reads the running API, which loaded its Node env files at its last start, so an env-file edit is not visible to it until the next API restart. Edits from the PRM read to GO-SETC-M fall under N3 (the N3 span runs from the PRM read to GO-SETC-M; an API env-file edit takes effect at the SM API restart).
- The exact GET: `/api/quant/comparisons/availability-check`, in the owner's staging session, with no query, no body and no CSRF header.
- The required disabled answer: status 404 with a body exactly `{"error":"Not found"}` and no `code` key. With the flag not exactly '1' the QR-3 routes are not mounted: `qr3-routes.js:403` returns false before auth, and the request falls to the final 404 (`server.js:754-756`).
- FAIL answers: 503 `{code: QR3_SCHEMA_ABSENT}` (flag '1', schema absent); 404 with `code` NOT_FOUND (flag '1', schema present); any 200; any 5xx or other body.
- 401 or 403 means a bad session. The owner logs in again and Root repeats the read. It is not a pass.
- What it proves: the running API has the QR-3 routes off, so the effective value of `QR3_COMPARISON_ENABLED` is not exactly '1' across all sources. It does not prove absent or 0: a value such as `true` gives the same disabled answer.
- `QUANT_FIXED_EVAL_ENABLED` in the API Node env files is not read on the F3a path. The API does not read this key (`git grep`: only `quant-research-main.js`), so it has no product effect.
- Residual: the existing PostgreSQL test asserts only the 404 status; the body rests on the source read and the local probe. An API Node env-file edit made after the last API start and before the PRM read, with no restart since, is covered by neither the probe nor N3. Before GO-SETC-M Root either accepts this named residual together with the owner's statement that no API env file was edited since the last API start, or takes F3b, which reads the current file content (SB453).

*F3b (fallback).* If the F3a answer is not the required one, or no clean answer holds, Root falls back to a PRM r2 with a key-scoped env-file scan of the API Node env files, and a re-seal of PRM. GO-SETC-PRM then waits for that seal. On this path both keys are read as class tokens, and the fact is read inside the PRM read itself.

The route and the exact disabled answer are named in the GO-SETC-M request.

**Trading worker**
- The product reads neither key, so there is no product effect. The unit `Environment` flags are a configuration check only. Prep tool r2, as accepted under SB453, refuses unless the PRM receipt trading flags for both keys are ABSENT or 0 in the SM and SMR modes, read from the PRM receipt. The R0 mode already checks the PR receipt the same way (prep r2 `setc-prep.mjs:585`, PRE_READ_FLAGS; the SM and SMR check is `setc-prep-sm.mjs:274`, PRM_FLAGS). Its Node env files are not read; that has no product effect.

**Research worker**
- Stopped through set C. No set C tool reads its environment. New rule: before any later research start, both keys are read in every source of the research worker, Node env files included. The r13 round carries this read (section 5).

**SM-6**
- "Covered through digest equality" means the systemd `Environment` property only. Node env files are outside the API environment digest.

## 7. What does not change

- The sealed set C tools (R0, SM, SMR, pre-read PR and PRM) and their pins. The sealed cores check only the shape of h3. Prep tool r2 is a prep tool, not a sealed set C tool.
- The research flags stay off: no research worker start, job, admission change, Preflight, profile enrollment or R7 epoch in set C.
- Spot and Paper only; no Live activation; reduce-only EXIT; the owner rules for each GO; no automatic optimizer or data-range loop.
- The set C packet section 14 (not authorized) and its stop codes.
- Pin `ab1c1f194cd20c3953a9b9628adc6322895058f1`.

## 8. Citation rule

Every set C GO line names this amendment (H3D, 2026-11-14) and Root ruling SB451: GO-SETC-PR, GO-SETC-PRM, GO-SETC-R0, GO-SETC-M, GO-SETC-MR and GO-SETC-R (the SV tool runs under GO-SETC-R). Root rejects a GO request that omits either.
