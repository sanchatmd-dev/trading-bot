# Time Management — Project execution and data collection

## หน้าที่ของเอกสาร

เอกสารหลักด้านเวลาและการจัดสรรงานของโครงการ ใช้ร่วมกับ [README](../README.md), [Context](../Context.md) และ [Roadmap](ROADMAP.md)

- Roadmap เป็นแหล่งหลักของขอบเขต ลำดับงาน สถานะ และ acceptance gates
- เอกสารนี้เป็นแหล่งหลักของงบเวลา งานที่ทำระหว่างรอได้ เวลาสะสมข้อมูล และประมาณการงานคงเหลือ
- README อธิบายผลิตภัณฑ์และวิธีเริ่มต้น; Context อธิบายสถาปัตยกรรมและข้อจำกัด
- หากขอบเขตหรือ gate เปลี่ยน ให้แก้ Roadmap และประเมินเวลาในเอกสารนี้ใน checkpoint เดียวกัน ไม่สร้างลำดับงานที่ขัดกัน

Baseline: 2026-09-27, timezone Asia/Bangkok, documentation only. ยังไม่มีการวัดชั่วโมงพัฒนาจริงย้อนหลังอย่างครบถ้วน ตัวเลขด้านล่างเป็นประมาณการ ไม่ใช่ SLA หรือเวลารับประกันว่าจะพบ Best Inputs

## 1. ขอบเขตและสมมติฐาน

1. ผู้พัฒนา 1 คนร่วมกับ Codex ใช้ code/evidence เดิมต่อ ไม่สมมติว่ามีหลายคนทำงานเต็มเวลาพร้อมกัน
2. Paper scope รวม PF-1 ถึง PF-4, QD-1, QR-1 ถึง QR-4 และงานคงเหลือ QL-3A ถึง APP-4 ตาม Roadmap
3. APP-5 แยกเป็นตัวเลือกสำหรับ Spot Exchange เดียว ต้องมีรายละเอียด broker และการอนุมัติ Live ก่อนลงมือเปิดใช้งาน
4. ใช้ SPT Custom evaluator ที่มีอยู่ การรองรับ Pine ใหม่หรือ timeframe ใหม่ต้องประเมิน capability/parity เพิ่ม
5. ผู้ใช้ระบุ BTCUSD 1m แต่หลักฐานเดิมผูกกับ BINANCE:BTCUSDT Spot 1m งบนี้สมมติว่าใช้คู่เดิมต่อ ต้องยืนยันก่อนเริ่ม dataset ใหม่ ห้ามเปลี่ยนชื่อคู่หรือใช้หลักฐานข้ามตลาดโดยปริยาย
6. หากเปลี่ยนเป็น BTC/USD จริงบน venue อื่น สำรองงานเชื่อมข้อมูลและ parity เพิ่ม 12–32 ชั่วโมงก่อนเผื่อแก้งาน ประเมินใหม่เมื่อทราบ venue
7. ดึงประวัติราคาจาก Exchange สำหรับ warm-up/research และเก็บสดสำหรับหลักฐานที่ประวัติทดแทนไม่ได้ ไม่รอให้ครบ 50,000 แท่งสดโดยอัตโนมัติ
8. Engineering acceptance กับ recommendation eligibility แยกกัน ระบบที่รายงาน NO_VALID_CANDIDATE อย่างถูกต้องพัฒนาเสร็จได้ แม้ยังไม่มี strategy ผ่านเกณฑ์

## 2. งบชั่วโมงคงเหลือ ณ baseline

ชั่วโมงหลักรวมพัฒนา integration และการตรวจรับตามแผน ยังไม่รวม contingency หรือเวลารอเครื่อง/ตลาด ตารางนี้ไม่ใช่คำสั่งให้รันทดสอบหรือ deploy ทันที

| งาน | ชั่วโมงหลัก | Dependency / เงื่อนไข |
| --- | ---: | --- |
| PF-1 ตรวจ policy และ sizing | 12–20 | งานถัดไป; ใช้ semantics ของ worker จริง |
| QD-1 ข้อมูล 50,000 แท่งและ resource/range gates | 24–40 | ก่อนเปิดช่วงข้อมูลที่ขยายจาก runtime ปัจจุบัน |
| PF-2 Historical Preflight | 24–40 | PF-1; expanded data path ต้องผ่าน QD-1 |
| PF-3 / PF-4 readiness และข้อเสนอค่าที่อธิบายได้ | 20–32 | ผล PF-2; เจ้าของยืนยันก่อนบันทึกค่า |
| ปิด engineering QL-3A และ provenance | 16–28 | หลักฐานครบตาม gate; ไม่บังคับให้ candidate ทำกำไร |
| QR-1 และ QL-4B export package | 24–40 | durable result contract; fixtures ใช้พัฒนาได้ |
| QR-2 Portfolio Performance | 32–48 | ledger, valuation และ funding contract |
| QR-3 / QR-4 comparison และ follow-up research | 24–40 | immutable library, comparable datasets, owner-started runs |
| QL-4C package/parity/auth/email validation | 16–28 | export contract; real delivery มี candidate และ SMTP gates |
| APP-3B multi-Pine/Bot isolation | 24–40 | ผ่าน engineering dependencies และ allocation isolation |
| APP-4 customer Paper readiness | 32–56 | security, quotas, backup/restore และ lifecycle acceptance |
| **รวมงานหลัก** | **248–412** | ไม่รวมงานที่เสร็จแล้วก่อน baseline |
| **เผื่อย้อนแก้ 30%** | **74.4–123.6** | integration, parity, snapshot, migration และ staging defects |
| **รวมชั่วโมงทำงาน** | **322.4–535.6** | ไม่ใช่เวลาปฏิทิน |
| เวลารัน/รอผลระบบที่สำรองแยก | 12–36 | ไม่รวมการสะสม episodes สด; บางส่วนซ้อนกับงานพัฒนาได้ |
| **ผลรวมก่อนหักเวลาซ้อน** | **334.4–571.6** | ใช้ตั้งงบปัดเป็น **340–580 ชั่วโมง** |

ใช้ 460 ชั่วโมงเป็นค่ากลางสำหรับวางงบ ไม่ใช่ expected value จากสถิติ ความเชื่อมั่นเริ่มต้นปานกลางถึงต่ำ เพราะ PF/QD/QR ยังเป็นแผนและต้องวัด throughput จริง

APP-5 สำหรับ Exchange เดียวสำรองเพิ่ม 180–360 ชั่วโมง รวม contingency และการรัน sandbox เบื้องต้นแล้ว ห้ามบวก 30% ซ้ำ งบรวม Paper + Live จึงประมาณ 520–940 ชั่วโมง แต่ยังไม่ใช่กำหนดการ Live ที่ยืนยันแล้ว

## 3. ลำดับใช้เวลาให้คุ้มค่า

ลำดับ phase หลักยังเป็น R-0, APP-3A, QL-2A, QL-3A, QL-4B, QL-4C, APP-3B, APP-4, APP-5 โดยงานที่ผ่านแล้วคงสถานะตาม Roadmap งาน PF/QD/QR เป็นส่วนขยายภายใน phase ไม่ใช่การข้าม gate

| ช่วงทำงาน | งานหลักที่ลงมือ | งานที่ใช้ช่วงรอเครื่อง/ข้อมูลได้ | เงื่อนไขจบช่วง |
| --- | --- | --- | --- |
| A: ลดความเสี่ยงก่อนเก็บใหม่ | PF-1, QD-1, PF-2; แก้ provenance ก่อน replay diagnostic เดิม | เตรียม artifact contracts, fixture datasets และสรุป SMTP blocker | ข้อมูล/engine/policy reproducible และรู้สาเหตุ reject/pause |
| B: ล็อกรอบวิจัย | PF-3/PF-4; เจ้าของเลือก snapshot และแผนวิจัย | QR-1 storage/contracts ตาม dependency ที่ผ่านแล้ว | symbol/source/inputs/policy/costs/cutoff/เกณฑ์ครบ; preflight ไม่ติด persistent pause |
| C: เก็บและพัฒนาไปพร้อมกัน | เริ่ม Paper/evidence ที่จำเป็นหลัง compile/input/webhook gates; รักษา snapshot | QL-4B export fixtures, QR-2 Portfolio, QR-3/4 report/replay engineering หลัง engineering dependencies ผ่าน | evidence ของรอบครบ หรือมี blocker ที่ต้องจบรอบด้วยเหตุผล |
| D: ตรวจรับการเชื่อมต่อ | QL-3A gates และ QL-4C validation | SMTP delivery remediation, เตรียม APP-3B isolation fixtures | engineering ผ่านแยกจาก recommendation; email ส่งเฉพาะผลที่ผ่าน |
| E: ความพร้อมใช้งานจริงของ Paper | APP-3B และ APP-4 | งานรัน soak/restore ใช้ช่วงที่ไม่มีการแก้ระบบเดียวกัน | acceptance แต่ละส่วนมีหลักฐานและ rollback/recovery พร้อม |

การทำพร้อมกันหมายถึงให้เครื่องเก็บข้อมูลหรือรัน bounded jobs ระหว่างคนพัฒนางานอื่น ไม่หักชั่วโมงพัฒนาสองงานออกจากกัน ไม่ให้ research jobs แย่งทรัพยากรจน Paper/webhook มีปัญหา กำหนด resource budget ก่อนเปิดงานพร้อมกัน

หากผลวิจัยไม่ผ่าน ให้จบ run พร้อม diagnostic และเดินงาน engineering ที่ไม่ติด recommendation gate ต่อ ห้ามวน optimize เปลี่ยน inputs หรือรีเซ็ต guard อัตโนมัติเพื่อเร่งให้ได้ Best Inputs

## 4. แผนข้อมูล BTC 1m

| จำนวนแท่งใหม่ต่อเนื่อง | เวลาสดขั้นต่ำ ไม่มี gaps |
| --- | ---: |
| 100 | 1 ชั่วโมง 40 นาที |
| 2,000 | 33 ชั่วโมง 20 นาที |
| 2,500 | 41 ชั่วโมง 40 นาที |
| 10,000 | 166 ชั่วโมง 40 นาที |
| 50,000 | 833 ชั่วโมง 20 นาที |

50,000 เป็นเพดาน primary bars รวม warm-up ต่อ calculation สำหรับ timeframe ที่รองรับ ไม่ใช่ขั้นต่ำ acceptance ปัจจุบัน runtime ยังจำกัด 10,000 แท่ง กติกาจริงอยู่ใน [Roadmap](ROADMAP.md#report-range-and-50000-bar-contract)

SPT Custom หลักฐานปัจจุบันใช้ warm-up 3,250 แท่ง เทียบเวลา 54 ชั่วโมง 10 นาที แต่ backfill ได้ตาม capability ถ้าใช้เพดาน 50,000 จะเหลือ measured bars 46,750 แท่ง หรือ 779 ชั่วโมง 10 นาที ไม่ต้องรอ warm-up สดใหม่เมื่อมีประวัติที่ตรวจแล้วและ state reconstruction ถูกต้อง

แยกหลักฐานสามประเภท:

- Historical OHLCV + evaluator: ใช้ development preflight/backtest; ไม่สร้างรายการ actual Paper ย้อนหลังและไม่พิสูจน์ live transport/repaint แทน
- TradingView parity/capture: ใช้เฉพาะ revision/inputs/market ที่หลักฐานครอบคลุม เก็บใหม่เฉพาะส่วนที่เปลี่ยนและจำเป็นตาม gate
- Actual Paper ledger: ใช้ผลการรับคำสั่ง/บัญชีจริงใน Paper; ต้องแยกจาก simulated fills ในรายงานเสมอ

รอบเดิม 100 candidates / 10,000 bars ใช้ประมาณ 102.787 วินาทีตาม [หลักฐาน](QL_3A_HISTORY_RESEARCH_2026-09-27.md) ไม่ใช่ benchmark รับประกันเวลา 50,000 แท่งหรือทุก source ให้จับเวลา fetch, validation, replay และ export แยกเมื่อ QD-1 พร้อม

## 5. Collection ETA และเกณฑ์หยุดรอ

ติดตาม flat-to-flat position episodes แยกจาก signals, orders, fills และ allocations เป้าหมายวางแผน 30 train / 20 validation / 20 holdout episodes ไม่ใช่ acceptance threshold ใหม่ ใช้เกณฑ์ version ปัจจุบันจาก Roadmap เสมอ

เมื่อแบ่ง 60/20/20 และ activity สม่ำเสมอ การได้ validation/holdout ช่วงละ 20 อาจต้องประมาณ 100 episodes รวม: 2/4/8 episodes ต่อวันเทียบเวลา 1,200/600/300 ชั่วโมงตามลำดับ เป็นตัวอย่าง ไม่ใช่อัตรา SPT ที่วัดแล้ว

สำหรับแต่ละ partition ที่อนุญาตให้ตรวจ: `remaining_hours = missing_episodes / eligible_episodes_per_hour` ใช้อัตราจาก development/collection window ที่ระบุและ snapshot เดียวกัน รายงาน sample size และช่วงประมาณ ห้ามเปิดดู holdout เพื่อปรับ strategy หรือกำหนดจุดหยุดตามผลตอบแทน

- หาก guard pause ถาวร, เงินไม่พอ minimum order, webhook/data ขาด หรืออัตรา qualifying episodes เป็นศูนย์: ETA เป็น `unknown/blocked` พร้อมสาเหตุ ห้ามอ้างว่ารอครบชั่วโมงแล้วจะผ่าน
- ก่อนรอข้ามวัน ตรวจสุขภาพการรับแท่ง, snapshot, rejection reasons, guard state และอัตราการปิด episodes จากข้อมูลที่อนุญาต
- ใช้ bounded historical development preflight วินิจฉัยก่อนเสนอรอบใหม่ รักษาข้อจำกัดความเสี่ยงและให้เจ้าของอนุมัติการเปลี่ยนค่า
- เก็บผ่าน gate แล้วให้ freeze evidence; การเก็บต่อเพื่ออีกวัตถุประสงค์ต้องระบุเหตุผล ไม่ขยายเป้าหมายเดิมย้อนหลัง
- revision ใหม่ต้องมี ID และแผนหลักฐานใหม่ เก็บหลักฐานเก่าไว้ ห้ามเริ่มนับใหม่โดยไม่อธิบายว่าหลักฐานส่วนใดใช้ต่อได้

## 6. ชั่วโมงงานกับเวลาปฏิทิน

หากทำงาน 8 ชั่วโมง/วัน 5 วัน/สัปดาห์ งบทำงาน 322.4–535.6 ชั่วโมงเทียบประมาณ 8.1–13.4 สัปดาห์ทำงาน ใช้วงวางแผน 9–15 สัปดาห์ หรือประมาณ 1,500–2,500 ชั่วโมงปฏิทิน เพื่อรองรับการประสานงานและรันตรวจระบบ โดยการสะสมข้อมูลส่วนใหญ่ต้องเกิดระหว่างพัฒนา

เวลาจบจริงใช้ dependency chain ที่ช้าที่สุด รวมเวลารอที่ทับซ้อนไม่ได้ ไม่บวกทุกแถวของ live collection เข้ากับ engineering โดยตรง หาก qualifying data ไม่พอหลังงานระบบเสร็จ ให้รายงานเวลาเพิ่มแยก ไม่ซ่อนใน contingency 30%

ยังไม่ตั้งวันเสร็จตายตัวก่อนทราบเวลาเริ่มจริง ชั่วโมงทำงานต่อวันและอัตรา episodes ไม่มีการนับเวลาที่ assistant ไม่ได้ทำงานเป็นชั่วโมงพัฒนา และไม่มีการเปิด automation จากเอกสารนี้

## 7. วิธีอัปเดตพร้อมเอกสารหลัก

ทุก checkpoint ที่เปลี่ยน scope/status/gate, หลัง run จบ/ล้มเหลว, rollout/rollback หรือ handoff:

1. อัปเดต Roadmap: สถานะและ scope `planned/local/staging/production`, evidence, blocker, next action
2. อัปเดต Time Management: ชั่วโมงจริงที่บันทึกได้ งานคงเหลือ low/high, เวลารอซ้อน/ไม่ซ้อน, collection snapshot และเหตุผลที่ ETA เปลี่ยน
3. ตรวจ README/Context: แก้เมื่อ product/architecture/current summary เปลี่ยน ถ้าไม่เปลี่ยนให้บันทึกว่า reviewed unchanged ไม่เพิ่มประวัติซ้ำทุกไฟล์
4. บันทึก change entry ใน Roadmap และเอกสารนี้ในชุดแก้ไขเดียวกัน เมื่อมีการ commit ให้อยู่ checkpoint เดียวกัน แยก commit/push/deploy/acceptance ชัดเจน
5. ทบทวนระหว่างวันที่กำลังทำงานเมื่อพบ blocker; ไม่ตั้งงานติดตามอัตโนมัติโดยไม่มีคำขอจากเจ้าของ

เกณฑ์เสนอ replan: งานใด forecast เกิน upper bound หรือเวลารวมเปลี่ยนเกิน 20%, evidence ใช้ต่อไม่ได้, เปลี่ยนตลาด/source/policy หรือ collection rate ไม่รองรับช่วงที่วางแผน ต้องอธิบายผลกระทบก่อนเปิดรอบใหม่

สูตรติดตาม: `forecast_active_total = recorded_actual_hours + estimated_remaining_hours + unused_rework_allowance` ใช้ contingency กับงานที่เหลือ ไม่บวกเผื่อซ้ำกับ rework ที่บันทึกเป็น actual แล้ว งานที่ไม่เคยจับเวลาให้เป็น `unknown` ห้ามใส่ศูนย์หรือเดาชั่วโมงย้อนหลัง

### Execution ledger

| As of | งาน / สถานะ | Actual hours | Remaining estimate | Blocker / next action |
| --- | --- | --- | --- | --- |
| 2026-09-27 | PF/QD/QR และ QL-3A ถึง APP-4 ที่เหลือ: planning baseline | Unknown; ไม่มี time log ครบ | 248–412 ชั่วโมงหลัก + contingency 30% | PF-1 เป็นงานถัดไป; engineering และ recommendation แยก gate |
| 2026-09-27 | Data collection: historical status only | Unknown | ไม่มี finite qualifying-data ETA ที่ยืนยันแล้ว | ล่าสุด validation 0; ตรวจ snapshot/guard และ preflight ก่อนตั้งรอบใหม่ |
| 2026-09-27 | APP-5 optional, not started | Unknown | 180–360 ชั่วโมงรวมเผื่อ สำหรับ venue เดียว | ต้องล็อก broker scope และ Live authorization |

ทุก collection entry ใหม่ต้องบันทึก `as_of`, run/dataset ID, venue/symbol/TF, source/inputs/policy hashes, cutoff, continuous bars/gaps, qualifying episodes ต่อ partition ที่ตรวจได้, guard status, อัตราที่ใช้ประมาณ, blocker และ next check condition เก็บ secrets และตำแหน่งเครื่องไว้ในช่องทางส่วนตัว อ้างอิง evidence ที่ปลอดภัยใน repo

### Change log

| Date | Change | Scope / impact |
| --- | --- | --- |
| 2026-09-27 | สร้าง Time Management เป็นเอกสารหลักด้านเวลา เชื่อม README/Context/Roadmap และกำหนด checkpoint update rules | Documentation only; baseline Paper 340–580 ชั่วโมงก่อนหักเวลารอซ้อน ใช้ historical preflight ก่อนเก็บสดรอบใหม่ ไม่เริ่ม run/deploy/automation |
