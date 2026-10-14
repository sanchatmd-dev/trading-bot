# EM2 measurement readiness (2026-10-13)

## สรุปภาษาไทย (สำหรับเจ้าของโปรเจกต์)

เอกสารนี้สรุปความพร้อมของรอบวัดผล R7B รอบใหม่ (EM2) ตามหลักฐานที่มีอยู่เท่านั้น ส่วนที่ทำบนเครื่อง local เสร็จและผ่านการตรวจแล้วในขอบเขต TEST_ONLY ได้แก่ controller, การกู้คืน, กรณีผลลัพธ์ไม่ทราบ, การทดสอบสั่งหยุด process และรายงาน held-lock เวอร์ชัน 12 ตัว adapter จริงและ mainCLI ยังถูกล็อกไว้ เอกสารนี้ไม่ได้ให้สิทธิ์ใดๆ และไม่ใช่ GO ยังเหลือเงื่อนไขที่ต้องปิดก่อนวัดจริง เช่น ขอบเขตการอ่านตาม amendment ใหม่, ช่วงเวลาที่เงียบและเจ้าของนั่งอยู่หน้าเครื่อง, GO ครั้งเดียวสำหรับ M1 พร้อม M4/XM ที่เตรียมไว้ล่วงหน้า, GO-M-SUBMIT ทันทีก่อนส่ง POST หนึ่งครั้งใน Chrome ของเจ้าของ, หลักฐาน KB/pins/allowlist/การชื่อชนกัน/การไม่ถูกใช้ไปแล้ว, การตรวจสุขภาพและความสามารถของ host รอบใหม่ และ Preflight สุดท้าย ผลของ EM-1 ที่ล้มเหลวถูกบันทึกเป็นบทเรียนแล้ว และยังไม่มีสิ่งใดพิสูจน์ว่า host พร้อมในตอนนี้ สถานะ host ปัจจุบันยังไม่ได้ตรวจซ้ำ

## 1. Purpose and status

This document is a readiness summary for the next fresh R7B measurement epoch (EM2). It lists what is locally ready, what each remaining gate needs, who acts, and a proposed safe order. It reports recorded facts and does not upgrade any status.

Status line:

- The local EM2 controller, recovery matrix, unknown-outcome handling, process-kill handling and held-lock report version 12 are accepted in TEST_ONLY scope (synthetic callbacks and fake IO).
- The real adapter and mainCLI remain locked. Every accepted evidence file states `executionReady: false` where the field is present.
- No host contact, host health proof, operational pins, allowlist, owner GO, job or measurement exists for EM2. Current host health was not rechecked for the latest handoff.
- This document grants no authority. It is not a GO and does not infer one.

Actors used below: Owner (the project owner in chat), Root (the single commander), Ops (the single designated operations worker, only on an explicit bounded root dispatch).

## 2. Locally ready components

All items are local, synthetic and TEST_ONLY. Evidence files are in `docs/evidence/`.

| Component | Status string | Stated limits (abridged, as recorded) | Evidence |
| --- | --- | --- | --- |
| Local readiness inventory and proposal compiler | LOCAL_READINESS_AND_PROPOSAL_COMPILER_ACCEPTED (file status; its readiness record is LOCAL_READINESS_INVENTORY_ACCEPTED) | Static declared dependency inventory; no integrated startup or host state proof; no STAGE/FULL pins, PB, allowlist, owner GO or job; execution and helper locks active; `executorRelease` is NOT_RELEASED. | [LOCAL_PREPARATION](evidence/R7B_EM2_LOCAL_PREPARATION_2026-10-13.json) |
| Native STAGE and FULL previews | LOCAL_SYNTHETIC_NATIVE_PREVIEWS_ACCEPTED | Pins produced in memory only; no operational pins installed. | [NATIVE_PREVIEWS](evidence/R7B_EM2_NATIVE_PREVIEWS_2026-10-13.json) |
| Release-admission core and narrow A7 | LOCAL_CORE_AND_NARROW_A7_EVIDENCE_ACCEPTED | A7 accepted only as retained local evidence; full result and frame bodies not retained; source inventory completed after execution; no byte-for-byte revalidation or fresh source revision certification; parity and source-settings gates open. | [CORE_AND_A7](evidence/R7B_EM2_CORE_AND_A7_2026-10-13.json) |
| Synthetic M0 to FULL to M1 chain | LOCAL_SYNTHETIC_NATIVE_STAGE_FULL_M1_CHAIN_ACCEPTED | Orchestration and provenance equality only; all host facts and authority synthetic; real adapter locked. | [NATIVE_CHAIN](evidence/R7B_EM2_NATIVE_CHAIN_2026-10-13.json) |
| Recovery and M2A hints (native) | LOCAL_SYNTHETIC_RECOVERY_AND_M2A_HINTS_ACCEPTED | Authority, clocks, service facts, host responses and effects synthetic; m1/m3/xm predecessors are supplied test handoffs; no real adapter release, host health, approval, admission or measurement. | [RECOVERY_LOCAL](evidence/R7B_EM2_RECOVERY_LOCAL_2026-10-13.json) |
| Persistent STAGE controller | LOCAL_TEST_ONLY_STAGE_CONTROLLER_ACCEPTED | Trusted fake callbacks only; file fsync checks do not prove hardware power-loss durability; no reconciliation API or automatic held-lock cleanup. | [CONTROLLER_STAGE](evidence/R7B_EM2_CONTROLLER_STAGE_LOCAL_2026-10-13.json) |
| Persistent FULL controller | LOCAL_TEST_ONLY_CONTROLLER_LINEAGE_AND_PERSISTENCE_ACCEPTED | Trusted synthetic callbacks and fixed roots; exception tests do not prove process-kill, OS-crash or power-loss durability; incomplete or changed ownership holds indefinitely. | [CONTROLLER_FULL](evidence/R7B_EM2_CONTROLLER_FULL_LOCAL_2026-10-13.json) |
| Controller recovery matrix (12 cases) | LOCAL_TEST_ONLY_CONTROLLER_RECOVERY_MATRIX_ACCEPTED | Two clean runs do not prove the earlier XS/malformed refusal was transient or identify its cause; load, cold-start and antivirus conditions untested. The earlier partial-failure checkpoint is preserved and not accepted. | [RECOVERY_LOCAL](evidence/R7B_EM2_CONTROLLER_RECOVERY_LOCAL_2026-10-13.json), [CHECKPOINT](evidence/R7B_EM2_CONTROLLER_RECOVERY_CHECKPOINT_2026-10-13.json) |
| Unknown-outcome handling (9 cases) | LOCAL_TEST_ONLY_CONTROLLER_UNKNOWN_OUTCOME_HOLD_ACCEPTED | Valid allowlist only; allowlist faults not combined with transport/raw faults; held locks stay held; no unlock API. | [UNKNOWN_OUTCOME](evidence/R7B_EM2_CONTROLLER_UNKNOWN_OUTCOME_LOCAL_2026-10-13.json) |
| Process-kill handling (17 rows) | LOCAL_TEST_ONLY_CONTROLLER_PROCESS_KILL_HOLD_ACCEPTED | Kills at controller boundaries and inside the fake transport only; not mid-write; process termination is not OS crash or power loss; xs and m4a only, other modes not run; the independent replay matched all rows but its final child-liveness probe failed, which root treated as a harness probe defect, not a pass. | [PROCESS_KILL](evidence/R7B_EM2_CONTROLLER_PROCESS_KILL_LOCAL_2026-10-13.json) |
| Held-lock report (v11 frozen, v12 accepted) | LOCAL_TEST_ONLY_READ_ONLY_REPORT_ACCEPTED; LOCAL_TEST_ONLY_HELD_REPORT_V12_ACCEPTED | Read-only; observed stability only; synthetic reconstruction for FULL held-lock; multi-attempt history interplay not tested; no unlock or authority. | [HELD_REPORT](evidence/R7B_EM2_HELD_REPORT_LOCAL_2026-10-13.json), [HELD_REPORT_V12](evidence/R7B_EM2_HELD_REPORT_V12_LOCAL_2026-10-13.json) |

The v12 evidence records that the local controller and report track has no further unrun item from the handoff, and that remaining EM2 work is owner-gated measurement preparation.

## 3. Remaining gates

Source ids: OQ/RQ rows are in `.qa-local/claude-r7b-measurement-root-decisions.md` (private, ignored by Git). "Handoff" is `.qa-local/codex-to-claude-handoff-2026-10-13.md` section "J1-J4 and operating gates" and its public counterpart [CODEX_TO_CLAUDE_HANDOFF_2026-10-13.md](CODEX_TO_CLAUDE_HANDOFF_2026-10-13.md), section "Authority, operating gates and Git". No gate below is closed by this document.

| # | Gate | Source | Current state | What closes it | Who acts | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | Fresh amendment and read scope; amendment v4 names the read steps (m0, m3, contingency reads), which run on root authority | OQ-13; Addendum 1 (H2/O-10); Handoff | Open. A private EM2 amendment draft (revision 2, marked DRAFT, NOT A GO) now exists with 37 values that need m0 or fresh host reads, 19 open questions and an independent second-model review; it is not yet reviewed by the owner. The code requires collision and readiness review evidence in the binding before m0, so those reviews come first. | Reviewed amendment text delivered to the owner and the owner GO for the amendment (GO R7-CRASHED-BASELINE-AMENDMENT-V4 in Addendum 1 wording, naming allowlist sha and code sha) | Root drafts; Owner grants | Reviewed text; new allowlist (G6) |
| G2 | Quiet slot, no-expected-alerts sentence, owner at desktop | OQ-19, RQ-3; Handoff | Open. The owner picks the slot; the GO text carries the tool-derived worst-case gap per restart and the no-alert sentence (no expected TradingView/Paper alerts). | Owner picks the slot and is at the desktop for port-forward and sign-in before m1; root verifies Trading identity after each restart | Owner; Root | G1 |
| G3 | One owner GO message for M1 plus pre-armed M4 and XM, naming the M2 submit | OQ-10; Addendum 1 (message order) | Open. It cannot share a message with the amendment GO because hB exists only after m0. | One GO message (R7B-MEASURE-V1 in Addendum 1 wording) naming hB and the submit, sent after m0 and FULL pins exist | Owner; Root pre-arms | G1, m0 result, FULL pins, G6 |
| G4 | Immediate GO-M-SUBMIT in the owner's signed-in Chrome with exactly one POST | OQ-1, RQ-3; Handoff | Open. Owner opens the port-forward and signs in; root never types credentials; one POST with the pinned key KB through the reviewed snippet; the tool proves zero marked jobs before and exactly one after; replay only KB on a lost response. Fallback: owner submits the same snippet by hand. The M1-to-submit gap is bounded at 30 minutes, else XM. The Chrome extension must be listed as connected at the m2 precheck (it was not connected when this was decided on 2026-10-09). | Per-action owner GO-M-SUBMIT in chat right before the POST | Owner; Root | G2, G3 |
| G5 | New KB, pins, allowlist, name-collision and nonconsumption proof | Handoff; LOCAL_PREPARATION `namespaceDecision` | Open. Prospective EM2/V2 names and static salts are retained subject to explicit collision and nonconsumption proof. No current remote absence is established. A local directory absence is not remote proof. EM-1 is closed and consumed. | Fresh KB and pins, collision check and nonconsumption proof against the host, via authorized reads only; before release, install the nine EM2 core files byte for byte at the declared allowlist namespace (it currently holds older tool bytes) and rebind the helper evidence to the EM2 core hash | Root; Ops for host reads | G1 |
| G6 | Operational allowlist for this epoch | Addendum 15 (next epoch needs a new allowlist); Handoff | Open. None exists (no operational allowlist or pins installed, per the accepted evidence). | New allowlist reviewed and pinned | Root; approval route not stated in the sources read | Review |
| G7 | Fresh host health and capability gate | AGENTS.md "Host and product safety"; Handoff ("no current health proof") | Open. All host windows are closed. The last accepted host observation (Paper-only, research flags off) is historical only. Existing support is 10K bars and a narrow profile. | A bounded read-only health and capability check under a job ID, budget and logs, dispatched by root to Ops only after G1 | Ops on explicit root dispatch | G1 |
| G8 | EM-1 lessons handled | Addendum 15 | Recorded, not shown here as closed. (a) API enabled-config env: QUANT_STORAGE_LIMITS_FILE and QUANT_RESEARCH_DATASET_ROOT were required by the API when data/foundation are enabled, and m0 had no enabled-configuration env check. (b) Tool defect T1: receipts parsed locally as SCHEMA with effects [] although the host listed effects. (c) Tool defect T2: stopApi threw on ActiveState=failed, so xm failed. (d) The PB file stays installed; a new epoch must handle PB_EXISTS or use a new PB name. | Local tool corrections are accepted with execution blocked: [measure v2](evidence/R7B_MEASURE_V2_LOCAL_2026-10-10.json) (`LOCAL_CORRECTIONS_ACCEPTED_EXECUTION_BLOCKED`; storage-limit and dataset-root settings identified as a tool regression, enabled-configuration audit) and [measure tool v3](evidence/R7B_MEASURE_TOOL_V3_LOCAL_2026-10-10.json) (`LOCAL_TOOL_FIX_ACCEPTED_EXECUTION_BLOCKED`; stop-proof fix for T2, operational acceptance false). A read-only [EM2 lessons audit](evidence/R7B_EM2_EM1_LESSONS_AUDIT_2026-10-13.json) found all four lessons carried in the EM2 core candidate (T2 for the API stop path; the worker stop path still throws on a failed unit). Two findings remain: abnormal host output shapes record effects as null locally (low, fail-closed), and the release namespace check needs the EM2 files installed byte for byte before release (see G5). No host proof exists yet | Root; reviewers | Local review |
| G9 | Final JF and hF, then Preflight | RQ-2, OQ-18; Handoff | Open. JF acceptance A1-A7 under PF plus G1-G4 (the old G1-G4 job gates of the decision record). On failure: quarantine, retire PF, no second JF, revised contract. Preflight GO names the JF id hash and hF and needs recorded root acceptance. The tracked JB receipt is QUARANTINED_BOOTSTRAP, NOT_FOR_PREFLIGHT. Evaluator parity at Preflight time stays a Preflight-GO precondition. | Separate JF and Preflight gates after measurement | Root accepts; Owner GO | Measurement outcome |
| G10 | D6 carry conditions | OQ-6, RQ-5; Handoff | Carry W 363.083 ms with an applicability record. A D6 rerun is asked under its own owner GO (about 50 minutes) only if Node or PostgreSQL identity differs or closure-hash time grows more than 10%. Cache stays UNKNOWN; no eviction; no limit raise. | Applicability record and local comparison of 325d335 against eb532ff | Root; Owner only if a rerun is needed | G5 |
| G11 | Usage and time budget | AGENTS.md "Usage and checkpoint discipline"; Handoff | Unknown for this plan. The decision record notes the amendment-to-m1 margin was raised to 3 hours. The old PLAN 780/1410 figures are stale. Code envelopes are not measured downtime. | Fresh usage read before each dispatch wave; stay within the bands | Root | None |

## 4. Proposed safe order

This is a proposal for root and the owner to review. It does not authorize any step. Each host step needs its own gate in section 3 closed first.

| Step | Action | Scope | Needs |
| --- | --- | --- | --- |
| 1 | Re-verify Git, file ownership, usage and the client's model/effort state; confirm one commander | Local | Root |
| 2 | Read the targeted decision records; list unclosed T1/T2 and env-model items (G8) | Local | Root |
| 3 | Draft amendment v4 text, the allowlist proposal and the fresh KB/pin proposal; compare 325d335 and eb532ff locally (G10) | Local only | Root, reviewers |
| 4 | Review the drafts independently; record the review | Local only | Auditor or tester |
| 5 | Send the amendment text to the owner; owner grants or declines the amendment GO | Chat | Owner |
| 6 | Bounded read-only host health and capability check (G7) and name-collision and nonconsumption reads (G5) | Host reads under root authority after the amendment; Ops, serial, alone | G1 closed |
| 7 | Run m0 (read-only); derive FULL pins, hF/hB; review | Host reads under root authority | Steps 5 and 6 |
| 8 | Owner picks the quiet slot, is at the desktop, opens the port-forward and signs in; root states the worst-case gap and no-alert sentence | Owner present | G2 |
| 9 | One owner GO for M1 plus pre-armed M4 and XM naming the submit | Chat | G3 |
| 10 | M1; then within 30 minutes the immediate GO-M-SUBMIT and exactly one POST in the owner's Chrome; else XM | Owner present; host effects | G3, G4 |
| 11 | M3 background watch (15 s poll to deadline plus 120 s, bounded, no retry), then M4 close | Host; owner present until close | G3 |
| 12 | Final JF/hF acceptance, then a separate Preflight GO | Chat; local review | G9 |

If any step returns an unexpected state, stop and report; do not retry with changed flags. A lost or unknown outcome holds and is reported; nothing is deleted, reset or restored by default.

## 5. Not authorized by this document

This document does not authorize, and no reader should infer authorization for:

- Live activation.
- Best Inputs apply.
- An automatic optimizer or data-range loop.
- Guard reset.
- Any holdout or owner-boundary change.
- Deployment, migration, service restart or production config change.
- Git commit, push or other publication.
- A new research campaign, or a global rename of EM2/V2.
- Real adapter or mainCLI release, any host action, any M-step, any submit POST, or any Preflight.
- A D6 rerun, a sysctl change, a limit raise or a cache eviction.

Spot/Paper-only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, immutable research evidence and independent holdout gates stay as required by AGENTS.md. Any GO must come from the owner in chat or from standing authority recorded in the active handoff and Roadmap; no workflow or agent issues or infers a GO.

## 6. Sources

- `AGENTS.md`: "Host and product safety"; "Claude root ultracode" (GO rules).
- `docs/ROADMAP.md`: top status paragraphs (EM2 local acceptances) and the final change-log section.
- [Codex to Claude handoff](CODEX_TO_CLAUDE_HANDOFF_2026-10-13.md).
- Private (ignored by Git): `.qa-local/claude-r7b-measurement-root-decisions.md` (OQ/RQ table, Addenda 1 and 15) and `.qa-local/codex-to-claude-handoff-2026-10-13.md`.
- Evidence files linked in section 2.
- Private (ignored by Git): draft folder `.qa-local/claude-r7b-em2-amendment-draft/` (open questions Q1-Q19 in `OPEN-QUESTIONS-r2.md`); public record: `docs/evidence/R7B_EM2_AMENDMENT_DRAFT_2026-10-13.json`.

## 7. Decisions needed before the amendment GO

Source: private open-questions list Q1-Q19 (r2) and `docs/evidence/R7B_EM2_AMENDMENT_DRAFT_2026-10-13.json`. The draft is not a GO and carries no authority. Nothing below is decided or approved. The source says root decides root items and the owner decides owner items; it does not label each question. "Not stated" means the source does not say. Every default is a recommendation only. Consequence is listed only where the source states it.

| Q | Decision | Who decides | Recommended default (recommendation only) | Consequence if declined |
| --- | --- | --- | --- | --- |
| Q1 | Who approves the allowlist (G6). | Not stated | Root writes, independent review, owner approves by the amendment GO naming the allowlist sha256. | Root-acceptance only conflicts with Addendum 1 H2 item 1. |
| Q2 | Which GO and amendment ids EM2 uses. | Not stated | Use the code ids `R7-CRASHED-BASELINE-AMENDMENT-V5` and `R7B-MEASURE-V2`. | Keeping EM-1 ids V4/V1 needs a code change, new code sha, re-acceptance, and reuses spent ids. |
| Q3 | Which id the xs GO uses. | Not stated | New id bound to window EM-2 (for example `R7B-XM-STOP-ACTIVE-V2`). | Reusing the V1 id could be read as an EM-1 approval. |
| Q4 | Which read steps the amendment names. | Not stated | Full EM-1 list, stated to the owner so the owner confirms m2a and m2b are read steps. | The shorter list does not match the code without a code change. |
| Q5 | Authority for the pre-m0 host health check and name-collision reads. | Not stated | Name them in the amendment as root-authority read packets outside the allowlist. | Not stated. |
| Q6 | Handling of a failed research unit at worker stop. | Not stated | Accept as a disclosed residual, with a separate owner recovery GO if it happens. | Fixing it before release changes the code sha and needs re-acceptance. |
| Q7 | Handling of finding AU1-F1. | Not stated | Accept with an operating rule: effects null means UNKNOWN, never zero. | Fixing it before release changes the code sha and needs re-acceptance. |
| Q8 | Release-namespace install method (AU1-F2). | Not stated | Keep the name; archive current bytes, install EM2 files, nothing deleted. | Renaming is a code change with a new code sha and re-acceptance. |
| Q9 | Source of GO sentence templates and generator. | Root (the source says root decides) | Root ports the EM-1 generator into a new reviewed folder outside code files and PLAN.md. | A PLAN.md edit can void issued dispatch certificates. |
| Q10 | Anchor for jobs since the release r6 finish. | Not stated | Keep the anchor; m0 decides. | Moving the anchor is a code change and needs a new design review. |
| Q11 | EM-1 hB and the denylist. | Not stated | Keep the EM2 denylist empty; root records that the new hB differs from the EM-1 hB. | A non-empty denylist refuses every non-close job; allowing it is a redesign. |
| Q12 | Enroll-layer absence check before the first m1 effect. | Not stated | Add a pre-m1 read for the `.pending` forms and later-sorting `.conf` names. | Accepting the risk means one PB effect, then xm. |
| Q13 | Harness proof on the VPS before the amendment GO. | Not stated | Reviewed isolated VPS harness run for items the EM2 delta touches; EM-1 results only with an explicit root applicability record; not "proceed without". | Not stated. |
| Q14 | Real adapter and mainCLI unlock. | Root (the source says root decides) | Root reviews and accepts the unlock first, then installs, then writes the allowlist. | Writing the allowlist on locked bytes needs a void copy, new instance and new owner GO. |
| Q15 | Values of marked.jobStatus and marked.opStatus. | Not stated | Keep EM-1 values and disclose the no-MR outcome of the ADRS-unclaimed path in the measure GO. | Not stated. |
| Q16 | What the owner receives for G1. | Not stated | Reviewed full amendment text plus the one GO sentence, with a Thai summary. | Not stated. |
| Q17 | Usage and time budget for the epoch. | Not stated | Root reads usage before each wave; run only above the 30% band; no new step at or below 15%. | Not stated. |
| Q18 | KB shape rule. | Not stated | Generate KB under the stricter renderer rule; record the code inconsistency as a residual. | Tightening `validatePins` is a code change, new code sha, re-acceptance. |
| Q19 | ADRS-unclaimed close result: code comment against Addendum 12. | Not stated | Cheap local tester check on a fixture, then treat D12-2 as binding if confirmed. | Not stated. |

### สรุปภาษาไทย (การตัดสินใจก่อน GO ของ amendment)

เอกสารนี้ยังไม่ใช่ GO และยังไม่มีการตัดสินใจใดถูกอนุมัติ ข้อที่เจ้าของโปรเจกต์น่าจะต้องดูคือ Q1 ใครอนุมัติ allowlist (ค่าแนะนำคือผ่าน GO ของ amendment ที่ระบุ sha256) และ Q2 การใช้รหัส GO ตามโค้ด (V5 และ R7B-MEASURE-V2) รวมถึง Q4 ที่ต้องยืนยันว่า m2a และ m2b เป็นขั้นตอนอ่านเท่านั้น ส่วน Q6 และ Q7 เป็นความเสี่ยงที่เหลือซึ่งแนะนำให้ยอมรับพร้อมระบุไว้ในข้อความ GO ของการวัด Q16 คือสิ่งที่เจ้าของจะได้รับ (ข้อความ amendment เต็มพร้อมประโยค GO หนึ่งประโยค และสรุปภาษาไทย) และ Q17 คืองบการใช้งานและเวลา ซึ่งตามแหล่งข้อมูลยังไม่ทราบ ทุกค่าที่แนะนำเป็นเพียงข้อเสนอ ส่วนข้อที่เหลือแหล่งข้อมูลไม่ได้ระบุว่าใครเป็นผู้ตัดสิน