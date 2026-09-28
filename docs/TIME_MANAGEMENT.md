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
2. Paper scope รวม PF-1 ถึง PF-4, QD-1, QS-1, QR-1 ถึง QR-4 และงานคงเหลือ QL-3A ถึง APP-4 ตาม Roadmap
3. APP-5 แยกเป็นตัวเลือกสำหรับ Spot Exchange เดียว ต้องมีรายละเอียด broker และการอนุมัติ Live ก่อนลงมือเปิดใช้งาน
4. ใช้ SPT Custom evaluator ที่มีอยู่ การรองรับ Pine ใหม่หรือ timeframe ใหม่ต้องประเมิน capability/parity เพิ่ม
5. เจ้าของยืนยันให้ใช้ตลาดเดิม **BINANCE:BTCUSDT Spot 1m** เป็นตลาดหลักสำหรับการเก็บข้อมูลและประมาณการเวลา ใช้หลักฐานเดิมต่อเฉพาะ source/settings/เงื่อนไขที่หลักฐานครอบคลุม
6. ไม่มีงานเปลี่ยนคู่หรือ venue ในงบปัจจุบัน หากเจ้าของขอเปลี่ยนตลาดภายหลัง ให้ประเมิน ingestion/parity และเวลาใหม่ก่อนเริ่ม dataset ของตลาดนั้น
7. ดึงประวัติราคาจาก Exchange สำหรับ warm-up/research และเก็บสดสำหรับหลักฐานที่ประวัติทดแทนไม่ได้ ไม่รอให้ครบ 50,000 แท่งสดโดยอัตโนมัติ
8. Engineering acceptance กับ recommendation eligibility แยกกัน ระบบที่รายงาน NO_VALID_CANDIDATE อย่างถูกต้องพัฒนาเสร็จได้ แม้ยังไม่มี strategy ผ่านเกณฑ์

## 2. งบชั่วโมงคงเหลือ ณ baseline

ชั่วโมงหลักรวมพัฒนา integration และการตรวจรับตามแผน ยังไม่รวม contingency หรือเวลารอเครื่อง/ตลาด ตารางนี้ไม่ใช่คำสั่งให้รันทดสอบหรือ deploy ทันที

| งาน | ชั่วโมงหลัก | Dependency / เงื่อนไข |
| --- | ---: | --- |
| PF-1 ตรวจ policy และ sizing | 12–20 | Baseline เดิม; PF-1C ผ่าน engineering/browser/isolated staging แล้ว; ยังแยก active Bot rollout และ V2 evaluator parity ตารางนี้ยังเป็น baseline ไม่ใช่ estimate งานคงเหลือที่วัดใหม่ |
| QD-1 shared datasets, staged budgets และ chunks <=50K | 48–80 | เพิ่ม stateful recovery/large-data admission; ก่อนเปิด capacity ใหม่ |
| QS-1 global scheduler, isolation และ benchmark calibration | 24–48 | ใช้ QD-1 contracts; ก่อนเปิด heavy jobs บน VPS ร่วม |
| PF-2 Historical Preflight | 24–40 | PF-1; expanded heavy path ต้องผ่าน QD-1/QS-1 |
| PF-3 / PF-4 readiness และข้อเสนอค่าที่อธิบายได้ | 20–32 | ผล PF-2; เจ้าของยืนยันก่อนบันทึกค่า |
| ปิด engineering QL-3A และ provenance | 16–28 | หลักฐานครบตาม gate; ไม่บังคับให้ candidate ทำกำไร |
| QR-1 และ QL-4B export package | 24–40 | durable result contract; fixtures ใช้พัฒนาได้ |
| QR-2 Portfolio Performance | 32–48 | ledger, valuation และ funding contract |
| QR-3 / QR-4 comparison และ follow-up research | 24–40 | immutable library, comparable datasets, owner-started runs |
| QL-4C package/parity/auth/email validation | 16–28 | export contract; real delivery มี candidate และ SMTP gates |
| APP-3B multi-Pine/Bot isolation | 24–40 | ผ่าน engineering dependencies และ allocation isolation |
| APP-4 customer Paper readiness | 32–56 | security, quotas, backup/restore และ lifecycle acceptance |
| **รวมงานหลัก** | **296–500** | ไม่รวมงานที่เสร็จแล้วก่อน baseline |
| **เผื่อย้อนแก้ 30%** | **88.8–150** | integration, parity, snapshot, migration และ staging defects |
| **รวมชั่วโมงทำงาน** | **384.8–650** | ไม่ใช่เวลาปฏิทิน |
| เวลารัน/รอผลระบบที่สำรองแยก | 18–60 | ไม่รวมการสะสม episodes สด; บางส่วนซ้อนกับงานพัฒนาได้ |
| **ผลรวมก่อนหักเวลาซ้อน** | **402.8–710** | ใช้ตั้งงบปัดเป็น **410–720 ชั่วโมง** |

ใช้ 565 ชั่วโมงเป็นค่ากลางสำหรับวางงบ ไม่ใช่ expected value จากสถิติ ความเชื่อมั่นเริ่มต้นปานกลางถึงต่ำ เพราะ PF/QD/QS/QR ยังเป็นแผนและต้องวัด throughput จริง

APP-5 สำหรับ Exchange เดียวสำรองเพิ่ม 180–360 ชั่วโมง รวม contingency และการรัน sandbox เบื้องต้นแล้ว ห้ามบวก 30% ซ้ำ งบรวม Paper + Live จึงประมาณ 590–1,080 ชั่วโมง แต่ยังไม่ใช่กำหนดการ Live ที่ยืนยันแล้ว

### ผลของแผน capacity ที่เพิ่ม

งบเดิม 340–580 ชั่วโมงเป็น baseline ก่อนขยาย capacity/scheduler ปัจจุบันเพิ่ม QD-1 อีก 24–40 ชั่วโมงและ QS-1 24–48 ชั่วโมง รวมเพิ่มงานหลัก 48–88 ชั่วโมง และ runtime allowance จาก 12–36 เป็น 18–60 ชั่วโมง ตัวเลขใหม่ 410–720 ชั่วโมงเป็นงบประมาณรวมเผื่อก่อนหักเวลาซ้อน ไม่ใช่ผล benchmark

QS-1 รวม scheduler/admission/isolation และการ calibrate benchmark เบื้องต้น; APP-3B/APP-4 ใช้งบเดิมตรวจ tenant/load/DR เพื่อไม่บวกงานซ้ำ งบนี้ไม่รวมการซื้อ/ย้าย VPS, distributed worker pool/HA หรือ evaluator สำหรับทุก timeframe ตาราง timeframe เป็น target ต้อง estimate เพิ่มเมื่อเปิด capability ใหม่

## 3. ลำดับใช้เวลาให้คุ้มค่า

ลำดับ phase หลักยังเป็น R-0, APP-3A, QL-2A, QL-3A, QL-4B, QL-4C, APP-3B, APP-4, APP-5 โดยงานที่ผ่านแล้วคงสถานะตาม Roadmap งาน PF/QD/QS/QR เป็นส่วนขยายภายใน phase ไม่ใช่การข้าม gate

| ช่วงทำงาน | งานหลักที่ลงมือ | งานที่ใช้ช่วงรอเครื่อง/ข้อมูลได้ | เงื่อนไขจบช่วง |
| --- | --- | --- | --- |
| A: ลดความเสี่ยงก่อนเก็บใหม่ | PF-1, QD-1/QS-1, PF-2; แก้ provenance ก่อน replay diagnostic เดิม | เตรียม artifact contracts, fixture datasets และสรุป SMTP blocker | ข้อมูล/engine/policy reproducible และรู้สาเหตุ reject/pause |
| B: ล็อกรอบวิจัย | PF-3/PF-4; เจ้าของเลือก snapshot และแผนวิจัย | QR-1 storage/contracts ตาม dependency ที่ผ่านแล้ว | symbol/source/inputs/policy/costs/cutoff/เกณฑ์ครบ; preflight ไม่ติด persistent pause |
| C: เก็บและพัฒนาไปพร้อมกัน | เริ่ม Paper/evidence ที่จำเป็นหลัง compile/input/webhook gates; รักษา snapshot | QL-4B export fixtures, QR-2 Portfolio, QR-3/4 report/replay engineering หลัง engineering dependencies ผ่าน | evidence ของรอบครบ หรือมี blocker ที่ต้องจบรอบด้วยเหตุผล |
| D: ตรวจรับการเชื่อมต่อ | QL-3A gates และ QL-4C validation | SMTP delivery remediation, เตรียม APP-3B isolation fixtures | engineering ผ่านแยกจาก recommendation; email ส่งเฉพาะผลที่ผ่าน |
| E: ความพร้อมใช้งานจริงของ Paper | APP-3B และ APP-4 | งานรัน soak/restore ใช้ช่วงที่ไม่มีการแก้ระบบเดียวกัน | acceptance แต่ละส่วนมีหลักฐานและ rollback/recovery พร้อม |

การทำพร้อมกันหมายถึงให้เครื่องเก็บข้อมูลหรือรัน bounded jobs ระหว่างคนพัฒนางานอื่น ไม่หักชั่วโมงพัฒนาสองงานออกจากกัน ไม่ให้ research jobs แย่งทรัพยากรจน Paper/webhook มีปัญหา กำหนด resource budget ก่อนเปิดงานพร้อมกัน โดย VPS เดิมให้ heavy Quant รันได้ 1 งานรวมทั้งระบบ; jobs อื่นรอคิวและ production health ต้องผ่านก่อนเริ่ม/กลับมารัน

หากผลวิจัยไม่ผ่าน ให้จบ run พร้อม diagnostic และเดินงาน engineering ที่ไม่ติด recommendation gate ต่อ ห้ามวน optimize เปลี่ยน inputs หรือรีเซ็ต guard อัตโนมัติเพื่อเร่งให้ได้ Best Inputs

## 4. แผนข้อมูล BTC 1m

| จำนวนแท่งใหม่ต่อเนื่อง | เวลาสดขั้นต่ำ ไม่มี gaps |
| --- | ---: |
| 100 | 1 ชั่วโมง 40 นาที |
| 2,000 | 33 ชั่วโมง 20 นาที |
| 2,500 | 41 ชั่วโมง 40 นาที |
| 10,000 | 166 ชั่วโมง 40 นาที |
| 50,000 | 833 ชั่วโมง 20 นาที |

50,000 เป็นเพดาน Historical Preflight รวม warm-up และขนาด processing chunk สูงสุด ส่วน research ใช้ budget ตาม timeframe/stage ไม่ใช่ขั้นต่ำ acceptance ปัจจุบัน runtime ยังจำกัด 10,000 แท่ง กติกาจริงอยู่ใน [Roadmap](ROADMAP.md#report-range-and-50000-bar-contract)

SPT Custom หลักฐานปัจจุบันใช้ warm-up 3,250 แท่ง เทียบเวลา 54 ชั่วโมง 10 นาที แต่ backfill ได้ตาม capability ถ้าใช้ Preflight เต็ม 50,000 จะเหลือ measured bars 46,750 แท่ง หรือ 779 ชั่วโมง 10 นาที ไม่ต้องรอ warm-up สดใหม่เมื่อมีประวัติที่ตรวจแล้วและ state reconstruction ถูกต้อง

แยกหลักฐานสามประเภท:

- Historical OHLCV + evaluator: ใช้ development preflight/backtest; ไม่สร้างรายการ actual Paper ย้อนหลังและไม่พิสูจน์ live transport/repaint แทน
- TradingView parity/capture: ใช้เฉพาะ revision/inputs/market ที่หลักฐานครอบคลุม เก็บใหม่เฉพาะส่วนที่เปลี่ยนและจำเป็นตาม gate
- Actual Paper ledger: ใช้ผลการรับคำสั่ง/บัญชีจริงใน Paper; ต้องแยกจาก simulated fills ในรายงานเสมอ

รอบเดิม 100 candidates / 10,000 bars ใช้ประมาณ 102.787 วินาทีตาม [หลักฐาน](QL_3A_HISTORY_RESEARCH_2026-09-27.md) ไม่ใช่ benchmark รับประกันเวลา 50K–1M หรือทุก source ให้จับเวลา fetch, validation, replay, checkpoint, export และผลกระทบ production แยกเมื่อ QD-1/QS-1 พร้อม

### เวลา history coverage กับเวลา compute

| Primary bars 1m รวม warm-up | ความยาวประวัติเทียบชั่วโมง | Workload ตาม stage ที่วางแผน |
| --- | ---: | --- |
| 100K–250K | 1,666.7–4,166.7 | Broad search ภายใน candidate budget |
| 500K | 8,333.3 | Qualified shortlist เท่านั้น |
| 750K–1M | 12,500–16,666.7 | Final candidate/ชุดเล็กตามแผนที่ freeze |

ตัวเลข coverage ไม่ใช่เวลาคำนวณหรือจำนวนชั่วโมงที่ต้องรอสด ใช้ historical backfill ที่ตรวจแล้วเมื่อรองรับ แบ่ง chunk ช่วย memory/recovery แต่ไม่ลดงาน bars × candidates × complexity × MTF ต้องใช้ benchmark ภายใต้ resource limits จึงจะตั้ง compute ETA ได้ ไม่คูณเวลารอบ 10K เป็น SLA ของงานใหญ่

Queue ETA ต้องรวมงานที่อยู่ก่อนหน้าและ production-health pauses; เมื่อยังไม่มี benchmark หรือ health ไม่พร้อม ให้แสดง unknown/ช่วงประมาณพร้อมเหตุผล ห้ามรับประกัน deadline จากจำนวนแท่งอย่างเดียว

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

หากทำงาน 8 ชั่วโมง/วัน 5 วัน/สัปดาห์ งบทำงาน 384.8–650 ชั่วโมงเทียบประมาณ 9.6–16.25 สัปดาห์ทำงาน ใช้วงวางแผน 11–18 สัปดาห์ หรือประมาณ 1,850–3,025 ชั่วโมงปฏิทิน เพื่อรองรับการประสานงานและรันตรวจระบบ โดยการสะสมข้อมูลส่วนใหญ่ต้องเกิดระหว่างพัฒนา

เวลาจบจริงใช้ dependency chain ที่ช้าที่สุด รวมเวลารอที่ทับซ้อนไม่ได้ ไม่บวกทุกแถวของ live collection เข้ากับ engineering โดยตรง หาก qualifying data ไม่พอหลังงานระบบเสร็จ ให้รายงานเวลาเพิ่มแยก ไม่ซ่อนใน contingency 30%

ยังไม่ตั้งวันเสร็จตายตัวก่อนทราบเวลาเริ่มจริง ชั่วโมงทำงานต่อวันและอัตรา episodes ไม่มีการนับเวลาที่ assistant ไม่ได้ทำงานเป็นชั่วโมงพัฒนา และไม่มีการเปิด automation จากเอกสารนี้

## การจัดเวลาของทีมและ Usage

รอบ Data capability/ingestion วันที่ 2026-09-28 ทำ backend และ UI คู่ขนาน พร้อมตรวจ VPS แบบอ่านอย่างเดียว จากนั้นตรวจ integration ก่อน freeze release ชุด Node ผ่าน 318/318 ใน 53.178 วินาที; focused checks 22/22 ใน 15.532 วินาที; PostgreSQL HTTP 2/2, BACKFILL 2/2 และ research adapter 7 ผ่าน/1 ข้าม fixture ส่วนตัว ผ่านแล้ว Browser ใช้ server และ PostgreSQL local จริง ตรวจ desktop/mobile ผ่าน Staging ดึงข้อมูลจริง 2,100 แท่งสำเร็จ การวัดโหลดผ่านช่วง 300 วินาที (5 นาที หรือประมาณ 0.083 ชั่วโมง) โดยมี nonidle intervals 173.210 วินาที; replay จบ 32 งานและหยุดงานท้ายอย่างปลอดภัยหลัง monitor จบ เก็บหลักฐาน helper failure และ rework รอบแรกไว้ครบ ยังไม่รับรอง I/O budget ตาม [หลักฐานรอบนี้](QD_QS_INGESTION_CALIBRATION_2026-09-28.md) ยังไม่ลดงบ baseline จากจำนวน agents หรือเวลาทดสอบ และไม่ต้องรอแท่งตลาดสดเพื่อทำงานชุดนี้

Git checkpoint PF-1B/PF-1C รวมโค้ดและเอกสารหลังตรวจ diff และผล staging แล้ว ไม่ต้องเก็บแท่งใหม่เพื่อบันทึก checkpoint นี้ การ rollout Bot V2 และ evaluator parity ยังเป็นงานแยก; ไม่มีข้อมูล active hours เพิ่มจากงาน Git

รอบ QD-1/QS-1 foundation ล็อกสัญญาร่วมก่อนแบ่ง storage และ scheduler ให้สอง agent ทำคู่ขนาน หัวหน้าทำ contract/integration และตรวจ PostgreSQL แยกในเครื่อง ตามด้วย audit เฉพาะจุด ทั้งรอบไม่ต้องรอแท่งใหม่ การทำพร้อมกันยังไม่ใช่ผลวัด speedup และไม่ลดงบชั่วโมงจากจำนวน agents

รอบ [worker integration](QD_QS_WORKER_CHECKPOINT_2026-09-28.md) แยกงาน SPT state กับ adapter ให้สอง coder และใช้ auditor ตรวจ race; หัวหน้าทำ supervisor, resource health, migration และ integration ใช้ข้อมูลที่เปิดแล้ว 4,533 แท่ง จึงไม่รอเก็บใหม่ การตรวจจริงพบ JSON checkpoint ข้ามภาษาและ race ที่ต้องแก้ก่อนจบ ยังไม่มี active hours ครบถ้วน จึงไม่หักงบด้วยเวลาทดสอบหรือจำนวน agents

งาน offline recovery/crash drill, storage contracts และ bounded staging calibration ผ่านตาม checkpoint ด้านล่างแล้ว งานถัดไปคือ expanded admission, absolute I/O budgets และเชื่อม heavy paths ที่เหลือก่อนเพิ่ม capacity; PF-2 V2 evaluator parity ทำขนานได้เมื่อใช้ contract ที่ล็อกแล้ว งานเหล่านี้ไม่ต้องรอแท่งใหม่

งาน [recovery/storage/staging](QD_QS_RECOVERY_STAGING_2026-09-28.md) ผ่าน worker จริงและ physical crash/restart ใน staging แยกแล้ว โดยใช้ baseline เดิม ไม่รอข้อมูลสดเพิ่ม การแก้ audit สองจุดและ watcher SQL เป็น rework ที่เกิดขึ้นจริง ผล monitor ครั้งแรกไม่ผ่านจึงหยุด worker; รอบที่แยก client warm-up ใช้ baseline 30 samples และ impact 60 samples ผ่าน เก็บทุก attempt โดยไม่รีเซ็ต deadline ของงานเดิม ยังไม่มี active hours ครบถ้วนพอปรับงบ 410–720 ชั่วโมงอย่างน่าเชื่อถือ และการรันสั้นนี้ไม่ใช่ sustained-load benchmark

ปิดบริการทดสอบใหม่ทั้งหมดหลังเก็บหลักฐานแล้ว ไม่มีงานวิจัยใหม่รันค้าง ช่วงวัดสุดท้ายครอบคลุม compute ก่อน crash ประมาณ 3 วินาที ไม่ครอบคลุม resume; อีกช่วงครอบคลุม uninterrupted replay จึงยังต้องสำรองงาน sustained headroom แยก ส่วน retention dry-run และการปฏิเสธ reservation เกิน quota ผ่านบน staging แล้ว งาน capability/range และ scheduler-backed ingestion ภายใต้ 10K เดิมผ่านใน checkpoint ล่าสุดด้านบนแล้ว โดยไม่ต้องรอแท่งสด

หลัง resume ชุด Node ผ่าน 312/312 ใน 79.443 วินาที และ PostgreSQL ตาม checkpoint ผ่าน แต่แตะ usage reserve อีกครั้งก่อนปิด Linux rollout/drill จึงหยุดเปิดงานใหม่ การพัฒนาครั้งถัดไปต้องใช้ขอบเขตสั้นลงและตรวจ allowance ถี่ขึ้น; เวลาทดสอบข้างต้นไม่ใช่ชั่วโมงพัฒนา ไม่เปิด capacity หรือประกาศ staging acceptance จาก local test

ทุก role ใช้ Caveman ตาม AGENTS.md กับบทสนทนา, compact และ handoff ที่ agent เขียนเอง รวมถึง memory ภายใน เพื่อลดข้อความซ้ำและเก็บพื้นที่ context ให้ข้อมูลที่จำเป็น การย่อต้องคงหลักฐาน ข้อจำกัด งานค้างและจุดเริ่มต่อ ยังไม่มีผลวัด token/throughput จึงไม่ลดงบชั่วโมงหรือเปลี่ยน reserve จากนโยบายนี้

ใช้ [Agent Team](AGENT_TEAM.md) และ AGENTS.md ให้หัวหน้าเดียวเลือก task ที่ dependencies ผ่าน ส่งงานสั้นพร้อม file ownership และจุด checkpoint ใช้ workers 1–2 คนตามปกติ สูงสุด 3 เมื่อมีงานอิสระจริง การทำงานพร้อมกันอาจลด elapsed time แต่ห้ามหารงบ 410–720 ชั่วโมงด้วยจำนวน agents โดยไม่มีข้อมูล throughput

ตรวจ account usage ก่อน dispatch/งานแพงและทุก checkpoint กัน reserve 20 percentage points ตามนโยบาย; 20–30% เหลือทำทีละงานเล็ก, <=20% บันทึก checkpoint และไม่เปิดงานใหม่ ค่าไม่ทราบต้องระบุ unknown ไม่ใช่ 100% การกัน quota เป็นประมาณการ ไม่ใช่ hard lock และต้องเผื่อ account usage จาก task อื่น บันทึก snapshot ส่วนตัวใน `.qa-local/agent-team-usage.json` ไม่เก็บ raw account IDs ลง Git

เมื่อรอข้อมูล VPS ให้ทำ local coding/docs/test ที่ dependencies ผ่าน แต่ heavy Quant บน VPS ใช้เพดานปฏิบัติงานหนึ่งงานและต้องผ่าน health/capability ปัจจุบันก่อน Scheduler QD-1/QS-1 ยังไม่ใช่ความสามารถที่ setup agents ทำให้พร้อมใช้

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

The [worker-managed lifecycle staging](QD_QS_LIFECYCLE_STAGING_2026-09-28.md)
reused 4,533 historical bars with one candidate ending at index 3,876. It added no
live collection wait. The database/scheduler/main/evaluator baseline passed;
automatic completion and cleanup took 11.4 seconds after ready, with 30 baseline
and 13 impact samples. Backup-host resolution and seed SQL bindings required
guarded helper corrections; failed artifacts were retained. These are operational
durations, not engineering hours. Active work time remains unknown, so the overall
forecast is unchanged. Remaining stop/recovery cases are separate work; no new
phase estimate or speedup is inferred from this short baseline. The owner approved
a 10-point reserve for this staging set only; the usual reserve remains 20 points.
One active-cancel continuation measured physical stop at 1.429 seconds and preserved
the slot until stopping, but automatic cleanup returned `STOP_UNCONFIRMED`. The
attempt remains failed; resolve cleanup proof before a new supervised acceptance
run. No retry or additional fault case ran. Weekly allowance was 12% remaining at
integration; the short window was unavailable. These shared-account percentages
are not exact task costs, and the remaining two points above reserve are not a
commitment to additional implementation.

The [actual-worker/completion follow-up](QD_QS_RUNTIME_IO_COMPLETION_2026-09-28.md)
reused a retained 1,000-row fixture, adding no live market collection wait.
Missing startup counters were corrected with bounded readiness; the audit's
late-read correction passed the final focused I/O suite, 8/8. Completion checks
passed 15/15. Two staging helper failures required rework: an operation filename
mismatch and an invalid cross-language hash comparison. Both were retained.
The final run passed actual main startup, sequential evaluator readback/checkpoint
verification and automatic completion, with 30 baseline and 36 impact samples.
This closes that bounded verification task, not the full QD-1/QS-1 phases or a new
sustained-load gate. Active engineering hours remain unknown, so the overall
forecast is unchanged; remaining phase acceptance needs separate estimation.

The owner-authorized [physical PROFILE and I/O follow-up](QD_QS_PROFILE_STAGING_IO_2026-09-28.md)
uses at most 1,000 historical Spot bars and a 15-minute supervised drill budget;
it does not require waiting for live bars. Runtime delegation needs an administrator
because the SSH operator lacks noninteractive sudo. Script review and four local
mocked rollback scenarios are complete. Administrator-run delegation and physical
PROFILE result recovery passed. The driver done marker arrived 11 seconds after
the 300-second impact deadline; the monitor stopped the idle worker and reported
failure. All 296 impact samples were healthy, but that run remains failed evidence.
The two monitor startup failures and late marker are recorded rework. The first
bandwidth probe did not prove enforcement (4 MiB write/read in 146/112 ms). The
owner-approved manager refresh completed, followed by an active scratch unit with
exact limits. A helper option error wrote zero bytes; the corrected probe completed
in 16.015 seconds, with direct write/read timings of 7.970/8.007 seconds for 4 MiB
each. These are verification durations, not engineering hours. The subsequent
readiness run passed main/evaluator readback and automatic completion in 35.250
seconds from its ready marker, with 264.750 seconds left before the deadline.
This bounded measurement does not replace sustained-load calibration. All Bots remain stopped until a
future deployment; runtime delegation remains applied and is not reboot-persistent.
Active engineering hours are unknown.
The total project forecast remains unchanged until measured execution evidence is
available; the drill time budget is a limit, not a completion estimate.

Steps 2 and 4 started in parallel after `9d06ba0`, with exclusive resource-control
and data/profile file ownership. Read-only host inspection identified missing
I/O controller delegation; no load or rollout occurred. Local work now includes
main/supervisor I/O wiring, a shared calibration deadline, period UI/API and a
scheduled PROFILE path. The binding mismatch and two audit findings were fixed.
Final Node 331/331 took 54.565 seconds; PostgreSQL PROFILE 2/2, HTTP 2/2 and
BACKFILL 2/2 passed. These durations are verification time, not engineering hours.
Follow-up browser verification passed using isolated Chrome after fixing a stale
period-preview race. Actual application HTTP PROFILE lifecycle and revocation
during conversion passed. Follow-up Node 332/332 took 53.857 seconds; physical
staging and host I/O acceptance remain open. This work uses existing fixtures and needs
no new live bars. Host acceptance depends on administrator preparation, not a
market-data waiting period. Active engineering hours and administrator lead time
remain unknown; the 410–720-hour baseline is unchanged. See the
[work record](QD_QS_RESOURCE_PROFILE_CHECKPOINT_2026-09-28.md).
README and Context were updated with local scope and remaining gates. At the
follow-up integration check, weekly allowance was 37% remaining, the short window
was unknown and the project reserve remained 20 percentage points.

The owner authorized a Git checkpoint for the verified Data capability/ingestion
slice. Diff review and publication are release bookkeeping; they add no measured
engineering hours or capacity acceptance. README and Context were reviewed and
retain the same local/staging scope.

| As of | งาน / สถานะ | Actual hours | Remaining estimate | Blocker / next action |
| --- | --- | --- | --- | --- |
| 2026-09-28 | [Data capability/ingestion](QD_QS_INGESTION_CALIBRATION_2026-09-28.md): local UI/API, shared-worker BACKFILL, page recovery และ retention ผ่าน; staging ดึงจริง 2,100 แท่งและผ่าน bounded calibration | Active hours unknown; Node 318 checks 53.178 วินาที; focused 22 checks 15.532 วินาที; HTTP 2 checks 6.127 วินาที; browser ผ่าน; load window 300 วินาที มี nonidle 173.210 วินาที และเก็บ rework ไว้ | คง baseline เพราะ active hours ยังไม่ครบ; ไม่มีเวลาเก็บแท่งสดเพิ่มสำหรับรอบวิศวกรรมนี้ | ต่อ expanded admission, I/O measurement และ heavy paths ที่เหลือ; คงเพดาน 10K รวม warm-up และยังไม่ปิด QD-1/QS-1 ทั้ง phase |
| 2026-09-28 | [Recovery/storage/staging](QD_QS_RECOVERY_STAGING_2026-09-28.md): physical crash/restart และ bounded isolated rollout ผ่าน | Active hours unknown; final recovery/storage checks 15.687 วินาที; PG recovery 2.564 วินาที; monitor warm-up 3 + baseline 30 + impact 60 samples; รวม rework ตาม checkpoint | คงงบ baseline; ไม่แปลง test duration หรือเวลารอ quota เป็น engineering hours | ต่อ capability/UI, scheduler-backed backfill, sustained headroom และ expanded-budget validation โดยไม่รอข้อมูลสด; QD-1/QS-1 ยังไม่ปิดทั้ง phase |
| 2026-09-28 | [QD-1/QS-1 worker](QD_QS_WORKER_CHECKPOINT_2026-09-28.md): adapter จริง, SPT/Paper state, supervisor/health และ offline migration | Active hours unknown; Node 299 ผ่าน 74.385 วินาที; Python 105 ผ่าน 35.21 วินาที; PG adapter 8 ผ่าน 132.004 วินาที; Linux smoke 5 checks ผ่าน | คง baseline QD-1 48–80 / QS-1 24–48 ชั่วโมงเป็นข้อมูลตั้งต้น ไม่ใช่ประมาณการคงเหลือใหม่ | ใช้ข้อมูลเดิม ไม่รอแท่งใหม่; ต่อ cold recovery, staging/headroom และ storage budgets ก่อนเพิ่ม capacity; smoke ไม่ใช่ full staging rollout |
| 2026-09-28 | [QD-1/QS-1 foundation](QD_QS_FOUNDATION_CHECKPOINT_2026-09-28.md): shared contract, storage และ queue ทำคู่ขนาน; Node 291/291, PostgreSQL 14/14 ผ่าน | Active hours unknown; Node 43.637 วินาที, PG 7.469 และ 4.265 วินาทีเป็นเวลาตรวจ | คง baseline QD-1 48–80 / QS-1 24–48 ชั่วโมงเพื่ออ้างอิง; ยังไม่ใช่ estimate คงเหลือที่วัดใหม่ | ณ checkpoint แรกยังต้องเชื่อม executor/dataset พร้อม state parity, supervisor และ resource admission; รายการ worker ด้านบนเป็นสถานะล่าสุด |
| 2026-09-28 | [PF-1C](PF_1C_CHECKPOINT_2026-09-28.md): venue/costs/draft/Bridge UI และ browser/staging ผ่าน | Active hours unknown; final Node suite 37.1 วินาที; metadata run 121.697 วินาที ทำระหว่างตรวจ UI/เอกสาร | ยังไม่ลดงบรวมด้วยจำนวน agents หรือเวลาทดสอบ; active Bot rollout และ V2 evaluator parity ต้องประเมินจาก scope ถัดไป | ตรวจ diff/checkpoint; ไม่ต้องรอแท่งใหม่เพื่อบันทึกงานนี้; V2 Quant ยังถูก block ก่อน enqueue |
| 2026-09-28 | [PF-1B](PF_1B_CHECKPOINT_2026-09-28.md): PostgreSQL, Bridge และ UI ทำคู่ขนาน ผ่าน 129 checks; local cluster หยุดแล้ว | Unknown; ไม่บวกเวลาซ้อนของ agents; final Node check ประมาณ 7.3 วินาที, PostgreSQL suites ประมาณ 8.9 และ 4.4 วินาทีเป็นเวลาตรวจเท่านั้น | ยังไม่ปรับงบรวม 410–720 ชั่วโมงจาก test runtime; ประเมิน PF-1 ใหม่หลังล็อก venue/enforcement model | ปิด venue filters/shared costs, draft/Bridge UI และ HTTP/browser/staging gate; ไม่ต้องรอแท่งตลาดใหม่ |
| 2026-09-28 | [PF-1A local backend](PF_1A_CHECKPOINT_2026-09-28.md): implementation + focused tests + audit; ไม่มี deployment/collection | Unknown; ไม่มี active-work log ครบทั้ง root และ agents จึงไม่บวกเวลาที่ซ้อนกัน | คง PF-1 baseline 12–20 ชั่วโมงไว้ก่อน re-estimate หลัง integration; ไม่ใช่เวลาที่วัดได้ | ต้องมี isolated PostgreSQL/HTTP/worker evidence; ต่อด้วย venue/Bridge costs, consistency และ UI/draft; ไม่ต้องรอแท่งสดสำหรับ checkpoint นี้ |
| 2026-09-27 | Project agent team: local setup, three bounded role assignments | Unknown; ไม่มี active-work time log ครบ | ยังไม่ลด product estimate เพราะ agent count | ตรวจ active root model; PF-1 เป็น implementation ถัดไป |
| 2026-09-27 | PF/QD/QS/QR และ QL-3A ถึง APP-4 ที่เหลือ: planning baseline | Unknown; ไม่มี time log ครบ | 296–500 ชั่วโมงหลัก + contingency 30% | PF-1 เป็นงานถัดไป; engineering และ recommendation แยก gate |
| 2026-09-27 | Data collection: historical status only | Unknown | ไม่มี finite qualifying-data ETA ที่ยืนยันแล้ว | ล่าสุด validation 0; ตรวจ snapshot/guard และ preflight ก่อนตั้งรอบใหม่ |
| 2026-09-27 | APP-5 optional, not started | Unknown | 180–360 ชั่วโมงรวมเผื่อ สำหรับ venue เดียว | ต้องล็อก broker scope และ Live authorization |

ทุก collection entry ใหม่ต้องบันทึก `as_of`, run/dataset ID, venue/symbol/TF, source/inputs/policy hashes, cutoff, continuous bars/gaps, qualifying episodes ต่อ partition ที่ตรวจได้, guard status, อัตราที่ใช้ประมาณ, blocker และ next check condition เก็บ secrets และตำแหน่งเครื่องไว้ในช่องทางส่วนตัว อ้างอิง evidence ที่ปลอดภัยใน repo

### Change log

| Date | Change | Scope / impact |
| --- | --- | --- |
| 2026-09-28 | ปิด physical cold-recovery drill ของ isolated worker และตรวจผลกระทบช่วงสั้น | ใช้ frozen baseline เดิม; resume หลัง SIGKILL ตรงกับผลเดิมและคิด evaluation ครั้งเดียว ไม่เปิด holdout หรือ campaign ใหม่ เก็บ initial monitor breach/watcher failure เป็น rework; capacity คงเดิม และยังไม่ปรับชั่วโมงรวมจากข้อมูลเวลาไม่ครบ |
| 2026-09-28 | เชื่อม research worker และพิสูจน์ state/resource controls | ใช้ข้อมูลเดิมและ bounded Linux smoke; weekly remaining 68% ก่อนเริ่ม / 61% หลัง cleanup, short window unknown, reserve 20pp; ลบ test DB และหยุด local PG แล้ว; ไม่เปิด capacity, campaign หรือ production rollout |
| 2026-09-28 | เริ่ม QD-1/QS-1 foundation หลัง PF-1 engineering `cf8913d` | ล็อก contract แล้วให้สอง coder ทำคู่ขนานพร้อม audit; ตรวจ local PG และปิด runtime หลังจบ; weekly remaining 71% ก่อนเริ่ม / 68% ตอน integration, short window unknown, reserve 20pp; ไม่หักชั่วโมงจากจำนวน agents |
| 2026-09-28 | PF-1C engineering ครบใน scope Paper/public filters | Node 281, PostgreSQL 38, staging ซ้ำ 30 checks; browser + refresh >2 TTLs; ปิด runtime ทดสอบแล้ว ไม่สลับบริการเดิม; usage เหลือ 71% weekly, short-window unknown, reserve 20pp |
| 2026-09-28 | ทำ PF-1B ต่อโดยแบ่ง PostgreSQL, Bridge และ UI คู่ขนาน | แก้ข้อจำกัดไม่มี PostgreSQL ด้วย cluster local แยกและหยุดหลังตรวจ; ไม่มี VPS load หรือเวลารอเก็บแท่งใหม่; บันทึก actual development hours เป็น unknown |
| 2026-09-28 | เพิ่ม Caveman เป็นกติกาทุก agent รวม compact/handoff/internal memory | Configuration/docs only; ตรวจรูปแบบ role profiles และ diff ไม่รัน product tests ซ้ำ งบเวลาเดิมคงอยู่จนมีผลวัด |
| 2026-09-28 | เริ่ม PF-1 ด้วยทีม coder/tester และ architecture audit | Local backend checkpoint; usage ตรวจต้นงานและก่อนรวมงาน มี reserve 20pp; short-window unknown จึงแบ่งงานสั้น งบรวม 410–720 ชั่วโมงยังไม่ปรับจากจำนวน agents |
| 2026-09-27 | เพิ่ม single-command team และ usage admission | Role models/profiles, exclusive ownership และ task template; งบ product 410–720 ชั่วโมงคงเป็น forecast ก่อนมี throughput ใหม่ |
| 2026-09-27 | ขยาย QD-1 และเพิ่ม QS-1 หลังทบทวน capacity handoff | งบ Paper ปัจจุบัน 410–720 ชั่วโมง; hardware เดิม, global heavy concurrency 1 เป็นแผน; compute/queue ETA รอ benchmark ไม่มีการรันงานหรือเปลี่ยนระบบ |
| 2026-09-27 | เจ้าของยืนยันตลาดหลัก BINANCE:BTCUSDT Spot 1m | ใช้ตลาดเดิมในแผนเวลาและการเก็บข้อมูล นำเงื่อนไขรอยืนยัน BTCUSD และงบเปลี่ยนตลาดออก; ไม่มี runtime action |
| 2026-09-27 | สร้าง Time Management เป็นเอกสารหลักด้านเวลา เชื่อม README/Context/Roadmap และกำหนด checkpoint update rules | Documentation only; baseline Paper 340–580 ชั่วโมงก่อนหักเวลารอซ้อน ใช้ historical preflight ก่อนเก็บสดรอบใหม่ ไม่เริ่ม run/deploy/automation |
