# Owner walkthrough for the morning, 2026-10-31

## สรุปภาษาไทย

เอกสารนี้เป็นคู่มือสั้น ๆ สำหรับเช้านี้ มีห้าส่วน: (1) สถานะ GO-A2: คุณส่ง GO-A2 แล้ว (2026-10-31 01:51 UTC) Root ใช้ GO นี้สลับ API ของ staging ไปใช้ pin ใหม่ และจะใช้รัน A2M ต่อ ก่อนเวลาหมดอายุ 2026-10-31 18:00 UTC; (2) ขั้นตอนเปิดเบราว์เซอร์ตรวจรายงานรายบอท: บอท 3 ต้องกระทบยอดผ่านพร้อมยอดการเงิน, บอท 2 ต้องแสดง RECONCILIATION_FAILED พร้อมหัวข้อ "สาเหตุที่กระทบยอดไม่ผ่าน" และรหัส EPOCH_UNKNOWN ทั้งภาษาอังกฤษและไทย, รายงานเดือนของบอทหลักต้องกลับมาใช้ได้, รายงานสัปดาห์ต้องแสดงความครอบคลุมแท่งเทียนครบ; (3) ทดสอบ Pine Bridge โดยส่งสัญญาณเตือน TradingView หนึ่งครั้งไปยัง webhook ของ staging แล้วดูว่ามี Paper fill ใหม่หนึ่งรายการในบันทึกการเทรด (ห้ามแก้ Pine หรือ Risk Manager); (4) เดินตามเส้นทางต้นแบบขั้นต่ำ P1-F ทั้งหกขั้น พร้อมผลที่คาดหวัง; (5) เรื่องที่รอคุณตัดสินใจ: set B D1-D7 พร้อมคำแนะนำของ Root และคำถาม Q3 ของ gate L-b

ขอบเขตไม่เปลี่ยน: Spot/Paper เท่านั้น, Live ถูกล็อก, การตรวจรับส่วนตัว (private acceptance) ยังไม่ได้รัน (NOT RUN), READY เป็น false

## Ground rules

- Scope is Spot and Paper only. Live is locked. Private acceptance is NOT RUN. READY is false. Nothing in this guide changes any of that.
- Reach the staging UI only through your own port forward, in your own browser. This guide names no address. Root never opens the staging UI for you.
- Do not change Pine or the Risk Manager at any step.
- You already sent the GO in part 1. No part of this guide asks for another GO or authorizes a host effect. Parts 2 to 4 are read-only for you, except the one alert in part 3.
- If anything looks different from the expected result, stop, note what you saw, and tell Root. Do not retry on your own.

## Part 1. GO-A2 (received)

You sent GO-A2 at 2026-10-31 01:51 UTC. Its not-after time is 2026-10-31 18:00 UTC. Root used it for A2 and uses it once more for A2M, after your browser steps in part 2. You do not type it again.

**What it does.** GO-A2 is the switch of the S6 staging API re-pin (REPIN-2 packet, sections 6 and 6.9). Root's tool stops the staging API, adds one configuration layer that points it at the new tree, reloads the service manager (this reload is host-wide and shared with the production units), starts the API, checks it at once and checks it again after about 5 minutes. On most failures before the API is ready, the tool returns the API to the previous pin by itself. In a few named cases it leaves the API stopped and Root reports to you and waits for your decision. The A2M check (a memory reading) runs under the same GO. Only the staging API moves. The trading worker revision does not change.

**How long.** The API is down only for the stop and restart. The first check is immediate; the second is about 5 minutes later. Your browser steps in part 2 must finish before 18:00 UTC, so that A2M can run under the same GO; after that time A2M needs a new read-only GO line.

**What you see afterwards.**
- Root reports that A2 passed or stopped, with counts and status codes only.
- If it passed: the Main Bot Month report answers again (it has answered 503 since the rollback window), and the per-Bot reports now carry the boundary record. Part 2 tells you what to check.
- If it stopped: Root says where the API stands (on the previous pin, or stopped) and what your options are. A rollback request (GO-RA) is your decision, not Root's.

Type the GO only in the exact form Root supplies in chat.

## Part 2. Browser steps after A2 (packet section 6.9)

Time needed: about 30 minutes. Do it while your port forward is up and before 18:00 UTC. Use English first, then switch to Thai.

**Root reads alongside you (packet 6.9 items 2 and 3).** Do these steps in your Chrome with the Claude in Chrome extension connected. Root reads, view only, the status code and timing of each report request, and each Bot's report response in its own tab of your signed-in session. Root enters no credential, changes no setting, and records only the range label, the status code and the durations, never an address or identifier. Tell Root in chat when your port forward is up and you are signed in.

1. Open the staging UI through your port forward. Sign in as you normally do. Hard-reload the page so the new code loads. Expected: the page loads; no error banner. (Root checks the served page tokens.)
2. Open the admin health view. Expected: it shows `liveEnabled` false. Write the value down; you report it.
3. Open the per-Bot report for **Bot 3**, range All Time (then Week and Month). Expected: the report reconciles and shows financial totals. In the server details, DISAGREES is 0.
4. Open the per-Bot report for **Bot 2**, range All Time (then Week and Month; for those two ranges, report whether each reconciles or shows the same note). Expected for All Time: status `RECONCILIATION_FAILED`. A note under the heading "Why reconciliation failed" appears, with the line "Reason code EPOCH_UNKNOWN". Why Bot 2: its three test-era Paper fills of 26 and 27 September 2026 fall before the proven start of the first recording epoch (1 October 2026, 16:16 UTC), and you chose to keep the proven record. This failure is the expected result, not a defect.
5. Switch the language to Thai on Bot 2. Expected: the heading reads "สาเหตุที่กระทบยอดไม่ผ่าน", the EPOCH_UNKNOWN sentence is shown in Thai, and "Reason code EPOCH_UNKNOWN" is still shown.
6. Open the **Main Bot** report, range Month. Expected: it answers (no 503) and returns the report. Bar coverage may read "not checked" where the range is large; that is expected and is not a regression.
7. Main Bot, range Week. Expected: bar coverage is shown as complete.
8. Main Bot, range All Time. Expected: the report returns; bar coverage may read "not checked".
9. Watch for slowness. A report that takes more than about 5 seconds is a finding for Root; 10 seconds or a timeout fails the step. Note any such range.

**What to report back (short message to Root):**
- The `liveEnabled` value.
- For each of Bot 3, Bot 2 and the Main Bot: the status you saw, for each of Week, Month and All Time.
- For Bot 2: whether the "Why reconciliation failed" note and Reason code EPOCH_UNKNOWN appeared in English and in Thai.
- The Week coverage reading for the Main Bot.
- Any range that was slow, errored or showed a failure code other than EPOCH_UNKNOWN. Any other failure code stops the step for Root's review.

Root separately checks the fill, lot and marker counts against the boundary read and runs A2M. Root accepts A2 only after both and your report.

## Part 3. Pine Bridge alert check

The Pine Bridge switch is already on for both units. This check proves one real alert still becomes one Paper fill. Do it only after Root reports that A2 and A2M are accepted, so the new fill does not enter the A2 count checks.

1. In TradingView, send one alert from your existing Pine Bridge alert to the staging webhook, the way you normally do. Do not edit the Pine script, the alert message or the Risk Manager.
2. Wait a short while, then open the trade log in the staging UI.
3. Expected: exactly one new Paper fill appears, with a time after your alert. No duplicate and no Live action.
4. Tell Root the alert time (approximate) and what the trade log shows: one new fill, none, or more than one. If none appears, do not resend; report it. A rejected or capped entry is a valid guarded outcome and should also be reported as seen.

## Part 4. P1-F walkthrough: the minimal prototype journey

P1-F is Root's acceptance of the whole six-step journey (staging prototype plan, six-step matrix). Walk it on desktop, then repeat the key steps on your phone. Where a step is not available yet, the expected result is a clear on-screen statement of that, not a canned answer. Several steps are known gaps, listed below the steps.

1. **AI chatbot bridging.** Give an authorized indicator source. Expected: a real AI job runs and returns a complete Pine draft, a guide, and a source and input identity you can reproduce. A failure is shown plainly and can be retried.
2. **Ten numeric inputs.** Select eight eligible numeric inputs from the source plus the Bridge ATR Multiplier and RR. Expected: all ten round-trip through the UI, the generated Pine and the stored snapshot, with none silently dropped, and each shows its optimizer range.
3. **Preflight and suggested Risk values.** Run Preflight. Expected: a report of signals, intents, fills, rejects, cash, exposure and data limits. Suggested Risk values show before and after, with their source, and are only saved when you press save. You may type values by hand and rerun the preview. A preview is never an approval to Run.
4. **Real signal transport and Paper execution.** Trace one real TradingView BUY (and a targeted EXIT) through webhook, Risk decision, allocation, Paper fill and ledger. Expected: the trace is visible end to end; a duplicate is rejected; a capped or rejected entry is shown as such. Part 3 is the small version of this step.
5. **Quant optimizer.** View only this morning: open the optimizer page and do not submit a job. A prior 100-candidate run ended with no valid candidate, and a new run needs fresh gates. When a run is gated, the expected result is: progress and cancel are visible, the job ends in a saved terminal result, the selected inputs and the Bridge pair take part in the search, and holdout rules hold.
6. **Quant Library and selection.** Open the library. Expected: completed, failed, insufficient and cancelled runs persist with owner, source, input, dataset, engine, cost and validation provenance, and reopen after a restart. Only compatible results compare. Development scores are kept apart from qualified recommendations, and no winner is shown when none qualifies. Applying settings or starting a Bot is a separate action of yours.

**Known gaps to expect (not defects of this morning):** Preflight proposals beyond the accepted part are not built; the library and comparison work is still planned; the optimizer needs a fresh run; a natural real signal may simply not occur in your window. Multi-Pine private acceptance is NOT RUN and READY stays false.

## Part 5. Decisions waiting for you

### Set B (staging proof of the grant pattern, offline window and restart)

Root's recommendation is shown first on each line.

- **D1. Run set B now, knowing that the USDT owner total reads "unavailable" while Bot 2 halts?** Yes. It proves the offline-window and grant pattern and ends the 503. Be aware that no USDT owner number appears on staging. If you want a visible number first, defer set B until Bot 2's boundary changes.
- **D2. Accept that set B stops the running trading worker and the API for about 20 to 40 seconds?** Accept. Alerts and webhooks are not served in that gap; queued signals run after the restart.
- **D3. How to declare.** (a) No declaration in this packet; build the declaration screen now and ship it with the next planned API re-pin. (b) A dedicated UI re-pin inside this packet (three more GOs: AR, A1, A2; RA only if needed). (c) You send the request from the browser console. Recommendation: (a). Zero rows keep rollback a plain drop, and a declaration adds no visible USDT number now (D1). Not (c): pasting code into a console is error-prone and a bad habit to teach.
- **D4. Refresh the restore source first with B1 (a fresh verified backup; the current one dates from 26 October)?** Yes. The window dump of B2 then becomes the exact pre-change restore source, and B1 proves it restores.
- **D5. Is the existing step-up enough for the declaration request (password plus authenticator code; a fresh login counts for 10 minutes)?** Yes. Keep it; no code change.
- **D6. Keep the market stream and collector running during B2?** Yes, under Root's ruling on market writers during the maintenance lock.
- **D7. After a first declaration, accept that undoing it needs an export step first and that the export file stays on the staging host in your custody?** Only relevant if you choose D3 (b) or (c). Accept if chosen.

### Gate L-b, question Q3

**Plain words.** Gate L-b measures how the report's coverage check behaves on a cold read (the first read of a range, with nothing warm). The most likely good result is that the cold first read already takes 50 ms or less. The current decision map has no row for that case: it lands on row 5 (hold), and the only other route to row 4 would make the RC-Q36 record claim a warm-up step that is not needed. Root proposes one additive reading before any run: row 4 also holds when every first requested read takes 50 ms or less with pass evidence, and every other row 4 condition holds; the RC-Q36 record then states the measured first-read time and no warm-up. Root adds one stricter clause of its own: at least one such read for each listed cell type. No L-b run happens before you answer.

**Root's recommendation:** adopt that reading, with Root's clause. Adopting it does not remove the aging requirement: the aging check still needs "no recurrence" to pass.

**Q3-a (asked with Q3).** The reading names the "mixed" class. Should it cover only "mixed (boundary)", or also "mixed (low resolution)"? An earlier rule says "mixed (low resolution)" never reaches row 4, so including it would be an explicit exception to that rule. **Root's recommendation:** "mixed (boundary)" only; "mixed (low resolution)" stays on row 5.

Reply in one line, for example: "Q3 adopt with Root's clause; Q3-a boundary only".

## Status line

Spot/Paper only. Live locked. Private acceptance NOT RUN. READY false. GO-A2 covers A2 and A2M only, until 18:00 UTC; no other GO is open.
