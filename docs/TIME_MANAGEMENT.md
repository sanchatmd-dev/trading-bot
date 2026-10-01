# Time Management — Project execution and data collection

## หน้าที่ของเอกสาร

เอกสารหลักด้านเวลาและการจัดสรรงานของโครงการ ใช้ร่วมกับ [README](../README.md), [Context](../Context.md) และ [Roadmap](ROADMAP.md)

- Roadmap เป็นแหล่งหลักของขอบเขต ลำดับงาน สถานะ และ acceptance gates
- เอกสารนี้เป็นแหล่งหลักของงบเวลา งานที่ทำระหว่างรอได้ เวลาสะสมข้อมูล และประมาณการงานคงเหลือ
- README อธิบายผลิตภัณฑ์และวิธีเริ่มต้น; Context อธิบายสถาปัตยกรรมและข้อจำกัด
- หากขอบเขตหรือ gate เปลี่ยน ให้แก้ Roadmap และประเมินเวลาในเอกสารนี้ใน checkpoint เดียวกัน ไม่สร้างลำดับงานที่ขัดกัน

Baseline: 2026-09-27, timezone Asia/Bangkok, documentation only. ยังไม่มีการวัดชั่วโมงพัฒนาจริงย้อนหลังอย่างครบถ้วน ตัวเลขด้านล่างเป็นประมาณการ ไม่ใช่ SLA หรือเวลารับประกันว่าจะพบ Best Inputs

Checkpoint 2026-09-29 รอบ durable I/O และ PF-2: PostgreSQL ผ่าน 10/10 ใน 2.60 วินาที รวม settlement และการเปลี่ยน lease ที่รักษายอดสะสม Python finalizer ผ่าน 12/12, cross-language parity 1/1 ครอบคลุม 17 กรณี และ Ruff ผ่าน ตัวเลข Node 30/30 ก่อนหน้านี้รวม regression เดิม 29 checks และ parity 1 check จึงไม่บวกซ้ำ ผู้ตรวจอิสระไม่พบ blocker ในขอบเขต local persistence และ order finalizer หลังแก้ transaction/terminal accounting, Decimal context และ CI interpreter งาน Sol สองสายใช้ไฟล์แยกกัน; Luna เตรียมเอกสารและ root แก้สถานะค้างให้ตรงหลักฐานก่อนรับงาน ยังไม่มีชั่วโมงพัฒนารวมที่วัดครบหรือผลประหยัดแยกราย model จึงคงงบเดิม เวลาทดสอบไม่ใช่เวลาพัฒนาทั้งหมด งานถัดไปคือ launch/cancel serialization และ runtime accounting/fault matrix โดยทำ PF-2 stateful replay และ trusted resolver คู่ขนานได้ ดู [หลักฐาน checkpoint](QD_QS_DURABLE_IO_PF2_CHECKPOINT_2026-09-29.md) งาน retention ยังคงรออายุจริงถึง 2026-09-30 13:53:52 น. ไทย

สถานะล่าสุด: [Linux binding/release](QD_QS_LINUX_BINDING_CHECKPOINT_2026-09-29.md) ผ่านหนึ่งกรณี staging ด้วย counters จริง read 0/write 4,096 bytes พร้อม marker รับ payload และ cleanup ครบ [PROFILE runtime](QD_QS_PROFILE_BINDING_CHECKPOINT_2026-09-29.md) ผ่าน local checks/ตรวจ source อิสระและ Linux staging หนึ่งกรณีแล้ว งานถัดไปคือ terminal accounting/fault matrix ยังไม่มีหลักฐาน counters สุดท้ายหลัง process หยุด

Checkpoint Linux binding 2026-09-29: Sol พัฒนา telemetry และ Sol operations รันกรณีแยกหลัง Astra ตรวจ source/packet; Luna เขียนหลักฐานและ root รวมเอกสาร Local checks ผ่าน PostgreSQL 16/16, launcher 5/5, Python 6/6 ต้องแก้ dependency ของ probe, เงื่อนไข cleanup และ race ระหว่าง launch/stop ก่อนรัน staging รอบเดียวผ่าน ใช้เวลา 223 ms จาก receipt ถึง cancel completion; ตัวเลขนี้รวม protocol ไม่ใช่ benchmark เวลา stop ทั้งระบบ Usage ที่สังเกตจากต้นงาน 44% เหลือ 35% หลังหลักฐาน Linux; หน้าต่างระยะสั้นไม่ทราบ สำรอง 20 จุด เป็นยอดบัญชีร่วม ไม่ใช่ค่าใช้จ่ายแยก model เวลาพัฒนารวมยังไม่วัดครบ จึงคงงบ/contingency เดิม งาน PROFILE ผ่าน staging แบบ provisional ตาม checkpoint ถัดไป

## 1. ขอบเขตและสมมติฐาน

CI repair 2026-09-29: Windows ของ commit `421ca07` ล้ม 13 tests เพราะ timestamp ใน fixture หมดอายุก่อนถึงคิวรัน ไม่ใช่ผลตรวจ runtime I/O ล้ม Sol แก้เฉพาะ fixture และพิสูจน์ด้วยเวลาจำลอง 61 วินาที; focused checks ผ่าน 14/14 รวมขอบเขตอายุสัญญาณ Root ตรวจ diff และรันชุด Windows เต็ม: 439 ผ่าน, 0 ล้ม, ข้าม 1 test เพราะไม่มีสิทธิ์ symlink ในเครื่อง ใช้เวลา 122.11 วินาที ผล hosted CI ของชุดแก้ไข `372d8a3` ผ่าน Safety checks และ Quant Lab แล้ว ดู [Roadmap](ROADMAP.md#change-log) Usage ที่สังเกตลดจาก 46% เหลือ 45%; หน้าต่างระยะสั้นไม่ทราบ สำรอง 20 จุด เป็นยอดบัญชีร่วม ไม่ใช่ต้นทุน model เวลาพัฒนารวมยังไม่วัด คงงบและ contingency เดิม README/Context ทบทวนแล้วไม่ต้องเปลี่ยนขอบเขตผลิตภัณฑ์


Checkpoint PROFILE 2026-09-29: Sol เชื่อม fixed Node worker กับ V2 pipeline; Astra ตรวจ source/packet และ Sol operations รัน staging หนึ่งกรณี หลังแก้การบันทึก counter ที่เพิ่มระหว่างตรวจสิทธิ์และเพิ่ม HEARTBEAT ใน fixture ตรวจ Child/launcher 8/8, PostgreSQL PROFILE 7/7 และ regression เพิ่ม 1/1 ผ่าน ข้อมูลสังเคราะห์ 600 แท่งให้ผล 100 แท่งหลัง warm-up จึงไม่ต้องรอเก็บตลาดเพิ่ม Bind 12:53:04 UTC, ผล provisional 12:53:05.673 UTC, monitor จบ 12:53:12.609 UTC; เวลารอบ fixture นี้ไม่ใช่ benchmark ของข้อมูลขนาดใหญ่ ผลเป็น provisional; terminal accounting และ public admission ยังเปิดอยู่ Usage ล่าสุดเหลือ 28% จาก 44% ต้นงานรวม Linux diagnostic กับ PROFILE สำรอง 20 จุด หน้าต่างระยะสั้นไม่ทราบ ยอดบัญชีร่วมไม่ใช่ต้นทุนแยก model เวลาพัฒนารวมยังไม่วัดครบ คง contingency เดิม ดู [หลักฐาน PROFILE](QD_QS_PROFILE_BINDING_CHECKPOINT_2026-09-29.md)

Checkpoint initial binding 2026-09-29: ตรวจ diff และ push งานก่อนหน้าเป็น `d31b42a` แล้ว งานถัดมาผ่าน PostgreSQL 14/14 ในประมาณ 5.16 วินาที และ launcher helpers/I/O controls 11/11 ในประมาณ 1.20 วินาที ผู้ตรวจ Astra ไม่พบ blocker หลังแก้สามจุด: final sample ที่ยังไม่ถูกบันทึก, invocation ID ที่ไม่ใช่ค่าจาก systemd และขอบเขต cgroup ที่ยังพิสูจน์ไม่ได้ Sol แก้โค้ดและตรวจเฉพาะส่วน; Luna เขียนเอกสาร checkpoint และ root ปรับถ้อยคำ/รวมเอกสารหลัก ไม่มีงาน staging ใหม่ และปิด PostgreSQL ที่ใช้ตรวจแล้ว ผล local ใช้ synthetic sampler จึงยังต้องพิสูจน์ positive Linux telemetry ดู [หลักฐาน initial binding](QD_QS_INITIAL_IO_BINDING_CHECKPOINT_2026-09-29.md) Usage ที่สังเกตเริ่ม 51% เหลือ 47% เมื่อจบ checkpoint; หน้าต่างระยะสั้นไม่ทราบ สำรอง 20 จุด ตัวเลขเป็นยอดบัญชีร่วม ไม่ใช่ต้นทุนแยก model เวลาพัฒนารวมและผลประหยัด token ของ Luna ยังไม่วัด จึงคงงบและ contingency เดิม

Checkpoint ก่อนหน้า runtime 2026-09-29: งาน launch intent และ cancel ของ child ที่ยังรอ payload ผ่าน PostgreSQL 4/4 ใน 2.92 วินาที และ focused V1 scheduler 1/1 ผู้ตรวจ Astra ไม่พบ blocker ภายในขอบเขตนี้ Sol ทำ runtime และ operations โดยแยกไฟล์ ส่วน root รวมเอกสาร การตรวจ retained cgroup หนึ่งรอบยังพิสูจน์ counters หลัง process หยุดไม่ได้ จึงคง unknown-final charge/quarantine และไม่ลดงาน accounting ที่เหลือ การทดสอบ cancel บน staging ใช้ฐานข้อมูลใหม่ source 23 ไฟล์ และหนึ่งกรณีที่จำกัด child 30 วินาที พร้อม monitor แยก 60 วินาที ดู [หลักฐาน runtime](QD_QS_RUNTIME_CANCEL_CHECKPOINT_2026-09-29.md) Usage ที่สังเกตระหว่าง wave เหลือ 60% แล้ว 51%; เป็นยอดบัญชีร่วม ไม่ใช่ต้นทุนแยก model หน้าต่างระยะสั้นไม่ทราบ และยังคงสำรอง 20 จุด ยังไม่มีชั่วโมงพัฒนารวมที่วัดครบ จึงคงงบและ contingency เดิม งานถัดจาก checkpoint นั้นคือ trusted initial counter binding และ PROFILE runtime จริง โดย PF-2 stateful replay/trusted resolver ทำแยกไฟล์ควบคู่ได้

ผล staging runtime: monitor ผ่านเมื่อ 2026-09-29 17:12:33 น. ไทย และตรวจซ้ำผ่าน 17:13:32 น. งานจบ `CANCELLED`/`STOP_PROVEN`; ไม่เหลือ process หรือ slot ค้าง บริการเดิมแปดตัวและหลักฐานเดิมคงเดิม ช่วงจาก job marker ถึง done marker 601 ms และจาก ready marker ถึง done marker 408 ms รวมงาน protocol จึงไม่ใช่ benchmark เวลา cancel เพียงอย่างเดียว Baseline/impact อย่างละห้าตัวอย่างไม่แทน sustained-load calibration ฐานข้อมูลและหลักฐาน staging เก็บไว้ตรวจต่อ ไม่มีงานทดสอบรันค้าง

Checkpoint ก่อนหน้า 2026-09-29: เริ่ม PF-2 plan contract ในเครื่องคู่ขนานกับงานหลัก QD/QS runtime/I/O โดยแยกไฟล์และผู้รับผิดชอบ ชุด contract ผ่าน 5 checks ใน 0.277 วินาที ซึ่งเป็นเวลาทดสอบ ไม่ใช่เวลาพัฒนารวม Sol ทำ I/O ledger และเตรียมตรวจ staging; Luna ปรับ checklist ประมาณ 2 นาที ไม่มีการแก้ซ้ำที่รายงาน ยังไม่วัด speedup หรือค่าใช้จ่ายแยกราย model และไม่ลดงบชั่วโมงจากจำนวน agents งาน Library/Export รอบนี้ยังไม่เริ่ม งาน retention ยังคงรออายุจริงถึง 2026-09-30 13:53:52 น. ไทย แต่ไม่ขวาง local engineering ดู [PF-2 checkpoint](PF_2_CONTRACT_CHECKPOINT_2026-09-29.md)

Rework ของรอบเดียวกัน: Root พบกรณีหลาย cgroup ใช้งบร่วมกันและ Sol review พบ unknown-final crash ใช้ overshoot reserve ซ้ำ ทั้งสองแก้พร้อม regression tests แล้ว; ชุด ledger ล่าสุดผ่าน 15 checks ส่วน staging setup หยุดก่อนสร้าง job เพราะสำเนา release คงสิทธิ์อ่านอย่างเดียว ต้องใช้ guarded continuation เฉพาะสำเนาใหม่ บันทึกเวลา engineering รวมเป็น unknown และคง contingency เดิม ไม่ถือว่าผล test local ปิด runtime acceptance

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

ตรวจ account usage ก่อน dispatch/งานแพงและทุก checkpoint กัน reserve 15 percentage points ตามนโยบาย ใช้ทั้ง Codex และ Claude โดยนับ usage ของแต่ละแพลตฟอร์มแยกกัน; มากกว่า 15% ถึง 30% ทำทีละงานเล็ก, <=15% หยุดรับงานใหม่ บันทึก checkpoint และไม่เปิดงานใหม่ ค่าไม่ทราบต้องระบุ unknown ไม่ใช่ 100% การกัน quota เป็นประมาณการ ไม่ใช่ hard lock และต้องเผื่อ account usage จาก task อื่น บันทึก snapshot ส่วนตัวใน `.qa-local/agent-team-usage.json` ไม่เก็บ raw account IDs ลง Git

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

The full-phase continuation on 2026-09-29 is tracked in the
[phase checklist](QD_QS_PHASE_CLOSURE.md) and [implementation record](QD_QS_CLOSURE_PROGRESS_2026-09-29.md).
One isolated direct-evaluator diagnostic completed 1,000 bars in 2.526 seconds;
this cannot forecast larger jobs or explain the actual-main failure. Combined
local checks most recently took 16.307 seconds (105 passed, one Windows symlink
privilege skip), superseding earlier combined subsets. PostgreSQL foundation
rerun passed 15 in 3.763 seconds and managed-route HTTP passed one in 2.872 seconds;
the prior data/research suites remain two and seven passes with one Python parity skip.
Python loopback admission passed two checks separately. Focused health timeout checks
passed nine in 0.296 seconds; these overlap the combined suite and must not be added
as a unique total. Local test PostgreSQL was stopped after verification.
Total active engineering time remains unknown. The latest observed weekly
allowance moved from 93% to 74% remaining; short-window data is unknown and the
20-point reserve applies. Shared counters do not identify model costs.
The genuine readiness retention wait requires at least 24 hours from the later
file/reservation creation time. Physical pair creation and its pre-expiry guard
passed; earliest cleanup is 2026-09-30 13:53:52 Asia/Bangkok. No process runs while
aging. Overlap local enrollment, streaming, I/O accounting and parity work; no market-data wait is
required for these engineering gates. No full-phase completion time or forecast
reduction is claimed from the small diagnostic or agent count.

The actual-main diagnostic had a recorded preflight at 07:21:39 UTC and delayed
postflight at 07:27:53 UTC. Its candidate stopped at checkpoint 3,000 with monitor
limits-file ENOENT; the bounded harness collected 30 baseline and 11 impact samples
and cleaned up. This operational window does not certify total engineering hours
or pressure acceptance. Terminal handshake development and V2 pipeline work run
locally while the same retention pair ages. The 50K synthetic conversion pipeline
completed in about 13 seconds in the local combined checks; do not extrapolate
that duration to candidate research, physical I/O limits or larger admission.

The follow-up diagnostic-only patch passed 24/24 combined local checks in 16.240
seconds after review corrections. That is test runtime, not total engineering
time. Review caught delayed first-failure capture for output overflow and nonzero
exit; both were corrected before the final run. At that earlier checkpoint no
Linux/systemd reproduction or deployment was credited. The direct-evaluator
diagnostic above now passes with the unchanged three-second gate; the original
actual-main failure remains unresolved. Weekly allowance was 94% remaining before final integration, with the short
window unknown and the normal 20-point reserve retained.

The 2026-09-29 proxy diagnosis and smoke passed within their scopes. One new
pressure attempt then failed the evaluator I/O startup gate before fault injection;
automatic cleanup and delayed health/DB checks passed. The recorded diagnostic
preflight at 05:53:16 UTC through delayed readback at 06:13:04 UTC spans about
19 minutes 48 seconds of operational wall time, not total active engineering time.
No market collection wait was added and no pressure acceptance or forecast
reduction is credited. Next work must isolate the unlogged I/O assertion before
another bounded attempt. Normal reserve remains 20 points; this continuation's
observed weekly allowance changed from 99% to 96% remaining, with the short window
unknown. Shared counters do not measure individual agent cost. Luna documentation
needed one factual state correction during root review; no speedup is claimed.

Pressure preparation completed and one isolated launch reached proxy startup.
The proxy exited with status 6/ABRT before monitor, driver or job creation; this
does not exercise health-pressure behavior. Preserve this failed setup and its
cleanup evidence. No pressure gate or forecast reduction is credited. During this
continuation, account usage changed from 98% five-hour / 56% weekly remaining to
15% / 43%; those shared counters cannot attribute cost to this task or an agent.
The normal 20-point reserve prevents another attempt in this checkpoint.

The resumed readiness-maintenance fix passed source audit and 18/18 focused local
checks, repeated independently by root. The earlier single failure was a test
expectation after the first unlink, corrected to verify the retained reservation
and successful retry. The measured focused run took 16.14 seconds; this is not
total engineering time. Staging crash/retention acceptance remains open and must
use genuine retention age. No forecast reduction or production rollout is credited.

The full QD-1/QS-1 closure wave reviewed the remaining gates and found a readiness
maintenance leak after a process crash. A typed-reservation fix is local and
pending acceptance. Pressure setup/seed/monitor/launcher drafts progressed, but
the adapter remains incomplete and no VPS mutation or run occurred. BACKFILL and
PROFILE already use the scheduler; their remaining path acceptance must not be
estimated as new scheduler integration. Larger-profile admission, resource budgets
and current-controls fault/recovery evidence still need separate acceptance.

Usage changed from 97% five-hour / 53% weekly remaining at admission to 10% / 40%
at the stopping snapshot. These shared account observations cannot identify task
or model cost. The normal 20-point reserve applies; no new slice was admitted
after the low-usage readback. No phase closure or forecast reduction is credited.

Health-pressure preparation produced a reviewed design and bounded forwarding
proxy with five passing local fixtures. It still needs isolated environment,
policy and unit copies, six-job identity checks, adapter/monitor/launcher and a
supervised staging run. No pressure runtime or engineering-hour saving is claimed.
Plan a separate bounded implementation/review/cleanup slice before launching it;
account usage percentages alone cannot guarantee the cost of that slice.
The operations estimate for remaining pressure helpers and review is 1–2 hours,
followed by a 2–4 minute supervised run and delayed readback. This is an estimate,
not measured work or a guarantee of acceptance. At the checkpoint, weekly usage
remaining was 7% and the short window was unknown; the current 3-point reserve
leaves four points of uncertain task capacity. The longer slice was not admitted.

The after-readiness timeout attempt passed with confirmed SIGSTOP and
`EVALUATION_TIMED_OUT`. Physical stop was observed 111 ms after the estimated
systemd timeout point; this is not a precise JavaScript timer latency. Automatic
cleanup succeeded, with unchanged pre-signal checkpoint and deadline. Existing
data was reused; no market collection wait was added. Two failed setup attempts
remain recorded. No total engineering-hour saving or capacity increase is claimed.

For the current continuation only, the owner reduced the usage reserve to three
percentage points. The refreshed available weekly allowance was 11%, with no
short-window counter reported. The normal 20-point policy remains unchanged.
The corrected private readiness probe passed six local cases and syntax checks.
One staging rerun observed readiness but failed before SIGSTOP while seeking
additional payload-read evidence. Cleanup succeeded; no timeout gate or project
forecast reduction is credited. A second Luna Low documentation task recorded
this outcome; per-agent usage savings remain unknown.

The 2026-09-29 evaluator-timeout attempt reused the frozen fixture without new
market collection. The bounded readiness probe failed before fault injection;
automatic cleanup succeeded. The recorded preflight-to-final-readback interval
was 103 seconds (18:23:49–18:25:32 UTC on 2026-09-28), not total engineering time.
No fault gate or forecast reduction is credited. Diagnose readiness observation
before another run, then admit the remaining cases sequentially against refreshed
usage and health. Root reviewed and updated README/Context in this checkpoint.
Read-only diagnosis supports a private probe that expires before the allowed
readiness window. No correction or rerun is credited. The closing usage snapshot
showed 20% remaining in the five-hour window and 57% weekly; the normal 20-point
reserve stopped additional fault work. Account-wide percentages do not establish
the cost of this task or of the Luna pilot.

The first Luna Low documentation pilot completed one local evidence review in
under two minutes as reported by the worker. Root reviewed the gate mapping and
accepted the finding that the current README summary should explicitly include
readiness crash cleanup. No runtime checks were delegated to Luna. Its output is
an ignored local review; exact per-agent cost and savings are unknown because
account usage is shared with concurrent work. This is one documentation pilot,
not a measured coding-worker speedup or completion of the three-to-five-task trial.

The 2026-09-29 sequential fault-case request reached local timeout design review
only. Separate evaluator and scheduler clocks require explicit path-specific
acceptance. No VPS connection or new job ran; preparation stopped at the usage
reserve. Timeout, pressure, crash/recovery and readiness cleanup remain pending.
No measured runtime or engineering-hour reduction is recorded. README/Context
were reviewed and retain the correct pending-fault scope.

The 2026-09-29 cancellation follow-up reused the frozen historical fixture and
added no live collection wait. Diagnosis reproduced a missing-transient-unit
stop exit code 5 in the private staging harness. One corrected supervised attempt
passed physical cancellation in 1.474 seconds and automatic confirmed cleanup.
This is a verification duration, not total engineering time. The original failed
attempt remains recorded; remaining timeout, pressure and crash/recovery gates
are unchanged. The normal 20-point usage reserve applies to this follow-up.
Actual engineering hours remain unknown, so no forecast reduction is claimed.

The 2026-09-29 Luna worker policy adds a planned three-to-five-slice pilot for
small local tasks. No agent was dispatched and no throughput or token saving was
measured. Keep the existing project-hour forecast until comparable task evidence
records usage observations, elapsed time, rework and defects; shared account
percentages are not exact per-agent cost.

The 2026-09-29 target-diagram correction distinguishes current 10K/Spot 1m
admission from planned 50K Preflight/chunks and research budgets by stage. It is
documentation only: no new dataset, runtime benchmark or measured engineering
hours. The forecast remains unchanged, and remaining QD/QS gates retain their
prior estimates and uncertainty.

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
| 2026-10-01 | Claude root wave 2: proof tests ที่ขาด (`5b1641f`), E2 follow-up (`06a0f0f`), test residue tidy (`4eb041a`), W7 diagnostic PROFILE enqueue helper สำหรับเจ้าของ (`e6f0dff`), แก้ CI PostgreSQL race (`2b7915f`) และ uid test ของ helper แบบ portable (`28d6f7e`); push ทั้งหมดแล้ว; W7 owner packet (private) และ [staging acceptance packet](PF2_STAGING_ACCEPTANCE_PACKET_2026-10-01.md) ที่ track ไว้สร้างโดยไม่มี VPS access และผ่านการตรวจ; ไม่มี deploy/migration/staging activation/VPS | Active hours unknown; wall-clock รอบงานประมาณ 01:06Z–06:40Z ของ 2026-10-01 UTC (ประมาณ 5 ชั่วโมง 34 นาที; 08:06–13:40 เวลาไทย) รวมการรอ 5-hour usage window; local: helper unit tests 27 ผ่านพร้อม 2 Linux-only skips, PostgreSQL helper 14/14, migration 9/9; regression สุดท้ายที่ `7b8a08d` (ปลายรอบก่อน 2026-09-30 22:52Z, CI flags, isolated local PostgreSQL): PostgreSQL 450 tests ผ่าน 448 ล้ม 0 ข้าม 2 ใน 724 วินาที, Node 783 tests ผ่าน 780 ล้ม 0 ข้าม 3 ใน 224 วินาที; เวลาเหล่านี้เป็นเวลา wall-clock หรือเวลาทดสอบ ไม่ใช่ชั่วโมงพัฒนา | คง baseline 410–720 ชั่วโมง; ไม่อ้าง speedup หรือต้นทุนและไม่ปรับ forecast; usage 5-hour 0% ตอนเริ่มเป็น 74% ณ 05:30Z และ 0% หลัง reset 06:00Z, weekly all-models 23% เป็น 32% และ 33% หลัง reset, weekly Fable 16% เป็น 19% ณ 05:30Z | CI: `06a0f0f` ผ่าน 9/9; `e6f0dff` ล้ม (PostgreSQL race และ Ubuntu uid test); `2b7915f` ผ่าน PostgreSQL แต่ Ubuntu unit ล้ม (uid test); `28d6f7e` ผ่าน 9/9 รวม PostgreSQL, Windows และ Ubuntu และเป็น W7 release commit ตามแผน; gates ที่เหลือ: G1 release record, G3 เจ้าของ GO ต่อ mutating effect, G4 usage, G5 window; คำถามเจ้าของที่ยังเปิด 10 ข้อ; งานถัดไป: เจ้าของตอบและทำ release record, GO, รัน W7 cases C1 และ C2 เอง แล้ววัด D6 และ Roadmap R7 (D6 block durable enrollment proof/R7 และ staging activation ไม่ block W7 diagnostic); backlog: E2 optional F1/F3/F4, R5-21 test seam, design deviations, ให้ grant script มี DELETE revoke, final pre-staging code audit (ทำแล้ว ไม่พบ code defect); SQL receipt defense-in-depth เลื่อน; PF-2 staging API ยังปิด |
| 2026-10-01 | Claude root wave หลัง handoff จาก Codex: แก้ CI ของ WIP checkpoint `f52d4be` (`258e865`, `3ce7e32`), แก้ E2 measured settlement race (`3742961`), รวม V2 PROFILE stop acknowledgement authority เดียวพร้อม deadline test (`338d91b`) และเอกสารบทบาท Fable 5.1 (`96b0e15`); push ทั้งหมดแล้ว ไม่มี deploy/migration/staging activation/VPS | Active hours unknown; wall-clock รอบงานประมาณ 20:30Z–22:20Z ของ 2026-09-30 UTC (ประมาณ 1 ชั่วโมง 50 นาที); full Node 767 tests ผ่าน 764 ล้ม 0 ข้าม 3 ใน 287 วินาที ก่อนแก้ E2; PostgreSQL local แยก: enrollment 38/38, runtime-v2/foundation/recovery 106/106, producer/worker 11/11, io-runtime 57/57, io-ledger 10/10, preflight-schema 16/16; เวลาเหล่านี้เป็นเวลาทดสอบ ไม่ใช่ชั่วโมงพัฒนา | คง baseline 410–720 ชั่วโมง; ไม่อ้าง speedup หรือต้นทุนและไม่ปรับ forecast; usage 5-hour 6% ตอน resume เป็น 66% ณ 22:16Z, weekly all-models 13% เป็น 21%, weekly Fable 7% เป็น 13% | CI: `f52d4be` ล้ม; `258e865` ผ่าน Quant Windows/Ubuntu, Safety Windows/Ubuntu, container และ gate แต่ PostgreSQL ล้มหนึ่งครั้งไม่ทราบสาเหตุ (job logs ต้องลงชื่อเข้าใช้) และรอบถัดไปผ่าน; `3ce7e32` และ `3742961` ผ่าน 9/9; `338d91b` ผ่าน 9/9; งานถัดไป: E2 follow-up, วัด D6 prepare+BEGIN p99 บน Linux (block durable enrollment proof/Roadmap R7 และ staging activation ไม่ block W7 diagnostic), สิทธิ์ UPDATE ระดับ table ของ staging role สำหรับ `LOCK TABLE`, proof tests ที่ขาด (R6-14, R5-19, R5-21, R5-23, S3b-9, W3-4), W7 diagnostic helper; SQL receipt defense-in-depth เลื่อน; PF-2 staging API ยังปิด |
| 2026-09-30 | Wave N: wiring step W2 (`a8dcf6e`), PF-2 R3b (`ad93d7e`) และ heavy-path S3b-1 (`7a488d4` + `a40aa51`) ผ่าน local review และ push; owner รัน retention apply step หนึ่งครั้งและผ่าน; หยุดงานตามคำสั่ง owner ประมาณ 15:00Z | Active hours unknown; wall-clock: W2 coder + audit 7,028 วินาที, W2 fix + tester 2,428 วินาที, R3b coder + audit 5,880 วินาที, R3b test pin 196 วินาที, S3b-1 coder + audit 3,821 วินาที, S3b-1 fix + re-audit 1,303 วินาที; root วินิจฉัยและแก้ CI line-ending ประมาณ 15 นาที; เวลาเหล่านี้เป็นเวลา agent ไม่ใช่ชั่วโมงพัฒนา | คง baseline 410–720 ชั่วโมง; ไม่ลดงบจากจำนวน agents; observed throughput: หนึ่งถึงสอง lane ที่ elevated effort ใช้ 5-hour window ประมาณ 7 points ต่อ lane-hour | W3 เป็นงานถัดไป; R6 ย้ายไปหลัง W3; R5 หลัง W3; S3b-2/S3b-3 และ S3c หลัง W3 ก่อน R5; W4 หลัง S3b-2; W6 หลัง W3; W7 ต้องมี swap host fact; owner question ใหม่เรื่อง sibling-bot PF-2 boundary ก่อน R6/R7; retention gate ปิดแล้วสำหรับ aged pair; ไม่มี agent ทำงาน local test PostgreSQL หยุดแล้ว |
| 2026-09-30 | Wave M: PF-2 R3 (`25f2ff0`) และ R4 (`872a36a`) ผ่าน local review และ push; S3a prepare-under-lease design เสร็จ (design only); W2 กำลังทำในเครื่อง ยังไม่ commit | Active hours unknown; wall-clock: R4 coder + audit 3,168 วินาที (ประมาณ 53 นาที), R4 tester 484 วินาที, lane 3 (R3 test fixes + S3a design panel สาม agent) 6,284 วินาที (ประมาณ 1 ชั่วโมง 45 นาที); เวลาเหล่านี้เป็นเวลา agent ไม่ใช่ชั่วโมงพัฒนา | คง baseline 410–720 ชั่วโมง; ไม่ลดงบจากจำนวน agents; observed throughput: สาม lane xhigh พร้อมกันใช้ 5-hour window ประมาณ 24 points ต่อชั่วโมง | R5 รอ W3; R6 รอ owner decisions สองข้อเรื่อง holdout registry; R7 รอ PROFILE v2 enrollment และ operations packet; S3b-1 ต่อด้วย S3b-2/S3b-3 และ S3c; retention apply step ยังไม่ได้รัน; root หยุด dispatch จน window reset 14:30Z |
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
| 2026-10-01 | Final pre-staging code audit ของ W7 path ที่ `28d6f7e` (Opus): ไม่พบ code defect และไม่พบทางที่ charge หายหรือซ้ำ; Medium 3 ข้อและ Low 3 ข้อแก้เป็น checks ใน W7 owner packet revision 4 และ staging acceptance packet (DB pool อย่างน้อย 4, ตรวจ I/O controls ก่อน offline window, ใช้ BACKFILL ที่เล็กที่สุดอย่างน้อย 501 แท่ง และ compute deadline นับเป็น inconclusive) | Packet และเอกสารเท่านั้น; release commit ยังเป็น `28d6f7e`; ไม่มี deploy/migration/VPS; ไม่กระทบ forecast |
| 2026-10-01 | ถอดบทบาท Fable 5.1 ทั้ง 3 (auditor ความเห็นที่สอง, ผู้ออกแบบทางเลือก, ผู้ร่าง checkpoint) ออกจากทีม agent ตามคำสั่งเจ้าของ; ลบ role files `.claude/agents/fable-*.md` และกฎ usage bucket ของ Fable ใน AGENTS.md | Governance และเอกสารเท่านั้น; Opus auditor ทำ review และ design panel เอง, Sonnet documentation ร่าง checkpoint; ประวัติงาน Fable เดิมคงไว้; ไม่กระทบ forecast |
| 2026-10-01 | Claude root wave 2: proof tests ที่ขาด (`5b1641f`), E2 follow-up (`06a0f0f`), test tidy (`4eb041a`), W7 diagnostic PROFILE enqueue helper (`e6f0dff`) และแก้ CI (`2b7915f`, `28d6f7e`); W7 owner packet พร้อมหลังผ่านการตรวจ; แก้ถ้อยคำ D6 ใน README/Context/Roadmap/Time Management | Local code + CI + เอกสารเท่านั้น ไม่มี deploy/migration/staging activation/VPS; CI 9/9 ที่ `06a0f0f` และ `28d6f7e`; D6 block durable enrollment proof (Roadmap R7) และ staging activation ไม่ block W7 diagnostic เพราะมีเฉพาะ job ที่ marked `completion_mode: 'pf2-enrollment-v1'` เท่านั้นที่รัน enrollment prepare และ BEGIN; usage 5-hour 0% ตอนเริ่มเป็น 74% ณ 05:30Z และ 0% หลัง reset 06:00Z, weekly all-models 23% เป็น 32% และ 33% หลัง reset, weekly Fable 16% เป็น 19% ณ 05:30Z; active hours unknown; ไม่อ้าง speedup และไม่ปรับ forecast |
| 2026-10-01 | Claude root แก้ CI ของ WIP checkpoint `f52d4be` (`258e865`, `3ce7e32`), แก้ E2 measured settlement race (`3742961`) และรวม V2 PROFILE stop acknowledgement authority (`338d91b`) | Local code + CI เท่านั้น ไม่มี deploy/migration/staging activation/VPS; CI 9/9 ที่ `3ce7e32`, `3742961` และ `338d91b`, PostgreSQL ล้มหนึ่งครั้งที่ `258e865` ไม่ทราบสาเหตุ; usage 5-hour 6% ตอน resume เป็น 66% ณ 22:16Z, weekly all-models 13% เป็น 21%, weekly Fable 7% เป็น 13%; ไม่อ้าง speedup และไม่ปรับ forecast |
| 2026-10-01 | ตั้ง Fable 5.1 เป็นบทบาทถาวรของ Claude ตาม 3 งานเดิม: auditor ความเห็นที่สองและผู้ออกแบบทางเลือก (high) กับผู้ร่าง checkpoint และสรุปภาษาไทย (medium) | Policy/docs เท่านั้น ไม่มีงานโค้ด ทดสอบ runtime หรือ deploy; usage 5-hour 3%, weekly all-models 13%, weekly Fable 7%; ไม่อ้าง speedup และไม่ปรับ forecast |
| 2026-09-30 | W2, PF-2 R3b, S3b-1 push และ retention apply step ผ่าน; บันทึก wave N และหยุดงาน 15:00Z | Local code + CI และ owner-run cleanup หนึ่งครั้งเท่านั้น ไม่มี deploy/migration; 5-hour window 54% ณ 12:32Z เป็น 73% ณ 14:26Z, reset 14:30Z แล้ว 4% ณ 14:53Z; weekly all-models 8% เป็น 11%, weekly Fable 4% เป็น 5%; temporary elevated agent tier สิ้นสุด 15:00Z กลับใช้ตาราง AGENTS.md; ไม่ปรับงบชั่วโมงและไม่อ้าง speedup |
| 2026-09-30 | PF-2 R3/R4 push, S3a design panel (Fable pilot ครั้งที่สอง) และบันทึก wave M | Local code + CI เท่านั้น ไม่มี deploy/migration/staging; 5-hour window 6% ใช้แล้ว ณ 10:34Z เป็น 54% ณ 12:32Z, weekly all-models 2% เป็น 8%, weekly Fable 0% เป็น 4%; ไม่ปรับงบชั่วโมงและไม่อ้าง speedup |
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

## Terminal handshake checkpoint — 2026-09-29

The guarded setup continuation and one isolated actual-worker diagnostic passed.
The automatic completion/cleanup interval was 9.982 seconds; the evaluator was
nonidle for 5.413 seconds. Delayed readback at 08:57:59 UTC confirmed no residual
owned workload and unchanged old services/jobs/retention pair. These are measured
runtime intervals, not total engineering hours or an expanded-capacity estimate.
The failed initial setup and reviewed correction remain part of rework history.
Final local preflight/capacity/ledger checks passed 28/28 in 0.430 seconds, with
independent ledger recheck. No new market-bar collection was needed. PF-2 replay,
V2 cost parity, durable I/O and other QD/QS gates remain; retain the existing
engineering contingency and genuine 24-hour retention wait. See
[terminal staging evidence](QD_QS_TERMINAL_HANDSHAKE_2026-09-29.md).

## FTR-1 and PF-2 S1 checkpoint — 2026-09-29

Two local slices were accepted: FTR-1 frozen terminal readback (`292a4b3`) and
the PF-2 S1 Python stateful replay core (`cda2857`). See the
[checkpoint record](QD_QS_FTR1_PF2_S1_CHECKPOINT_2026-09-29.md). The root moved
from Codex to Claude (Opus 5.5) at about 13:55 UTC. The work ran about
14:10 to 15:45 UTC with up to three concurrent children, with independent
tester and auditor review and fixes before acceptance. Account usage on the
5-hour window went from 4% to 27% used; shared counters do not attribute cost to
a model, an agent or a slice. Per-model cost and exact engineering hours are not
measured, so no engineering hours are booked and no speedup is claimed from
agent count or from the platform change.

Measured runtime intervals only: a frozen readback adds at least about 2.5
seconds (the quiescence window) to each PROFILE run, and the launcher skips it
when 5 seconds or less of unit runtime remain. The Linux mechanism proof froze
two transient units in about 10 ms each. These are per-run costs, not total
engineering time and not a capacity or forecast change. The next step, running
`terminate()` on real Linux, needs an owner-approved operations step; it does
not depend on new market bars. The remaining PF-2 slices (S3 trusted resolver,
S4 Node driver, optional S2 CSV) remain open alongside the genuine 24-hour
readiness retention wait (earliest cleanup 2026-09-30 13:53:52 Asia/Bangkok).
The 410–720-hour baseline and existing contingency are unchanged.

## FTR-1 Linux integration checkpoint — 2026-09-29

One supervised Linux staging case (suffix `dda8f44a`) ran the real FTR-1
`terminate()` path on the actual PROFILE child. It ended in the safe fallback,
not in measured settlement: the first frozen read failed the writeback gate, so
the unknown-final charge was kept and the integration goal is not met. See the
[integration record](QD_QS_FTR1_LINUX_INTEGRATION_2026-09-29.md).

Measured intervals only, all for this one case: preflight began at about 16:29
UTC and the 10-minute recheck ran at 17:01 UTC. Launch was 16:51:00 UTC, the
terminal path took 218 ms, the driver was done 10.291 seconds after launch and
the monitor 12.875 seconds after launch. The 218 ms is the fallback path only; it
is not a measurement of the success path, which by design adds at least about 2.5
seconds. The 5-hour usage window went from 39% to 44% used across preparation,
independent pre-run audit and the run; shared counters do not attribute cost to a
model, an agent or a step. The owner ran database setup and launch personally
after a permission block, which is a coordination step, not a measured duration.
No engineering hours are booked and no speedup is claimed. The database p95 values
(1.34 ms baseline, 1.02 ms during the case) are not a capacity benchmark.

The next work is local engineering: design and implement pending-writeback
handling before the frozen read and record the dirty and writeback memory values
on fallback (an auditor design is in progress). A new owner-approved Linux case
with new names follows, and it does not depend on new market bars. The remaining
PF-2 slices and the genuine 24-hour readiness retention wait (earliest cleanup
2026-09-30 13:53:52 Asia/Bangkok) are unchanged. The 410–720-hour baseline and
existing contingency are unchanged; this case adds evidence for the terminal I/O
gate and is not a forecast change.

## FTR-1b writeback drain checkpoint — 2026-09-29

FTR-1b (`54a9fde`, pushed) is a local code slice that adds an opt-in writeback
drain and a fallback diagnostic in response to the FTR-1 case. It has fake-host
tests only; Linux behavior is not proven. See the
[record](QD_QS_FTR1B_WRITEBACK_DRAIN_2026-09-29.md).

Measured intervals, all wall-clock and for this slice only: coder 17:34-17:50 UTC,
first verification 17:54-18:06 UTC and fix round 18:08-18:22 UTC. The independent
audit found one blocking-medium defect (stop during quiescence could wait up to 35
s) and the fix round resolved it. The 5-hour usage window went from 48% to 59%
used over this work; shared counters do not attribute cost to a model, an agent or
a step. The agents ran under an owner-approved temporary elevated tier from
2026-09-29 17:40 UTC to 2026-09-30 03:40 UTC (coder Sonnet 5.5 xhigh, tester Sonnet
5.5 high, auditor Opus 5.5 xhigh, verifier Opus 5.5 high), dispatched through
workflows with explicit model and effort. No engineering hours are booked and no
speedup is claimed.

Next work: an owner-approved Linux case with new names (FTR-1b-INT), where the
owner runs setup and launch; then product wiring through a hashed policy, a
scheduler review of a STOPPING slot held about 50 s and a PostgreSQL regression
for the fallback diagnostic; then the remaining fault matrix and trusted PROFILE
enrollment. The readiness retention cleanup still waits for real age expiry at
2026-09-30 13:53:52 Asia/Bangkok. The 410–720-hour baseline and existing
contingency are unchanged; this slice is not a forecast change.

## PF-2 S3 resolver checkpoint — 2026-09-30

PF-2 S3 (`5006feb`, pushed) is a local, development-only trusted resolver with
synthetic test sources; it is not wired to any runtime and nothing is deployed. See
the [record](PF2_S3_RESOLVER_CHECKPOINT_2026-09-30.md). The same record holds the
FTR-1c design decision, which is proposed and awaiting owner approval.

Measured intervals, all wall-clock and shared 5-hour usage across all models: wave B
19:03-20:02 UTC, 9% to 27% used (S3 build and first fix round plus the three-agent
FTR-1c design panel); wave C about 20:07-20:59 UTC, 27% to 40% (S3 fix rounds plus
the S4 contract draft and review); wave D1 about 21:02-21:17 UTC, 40% to 42% (final
S3 fix and re-check). Shared counters do not attribute cost to an agent or a step.
The independent auditor found four blocking-medium defects across rounds and all
were fixed; the root reran the Node suite at about 21:15 UTC (539 tests, 538 pass,
1 pre-existing skip, 0 fail). The agents ran under the owner-approved temporary
elevated tier from 2026-09-29 17:40 UTC to 2026-09-30 03:40 UTC (coder Sonnet 5.5
xhigh, tester Sonnet 5.5 high, auditor Opus 5.5 xhigh). No engineering hours are
booked and no speedup is claimed.

Next work: the S4 Node driver, which followed as `9a340af` (next section); an
owner decision on FTR-1c; then production adapters and
runtime admission. The readiness retention cleanup still waits for real age expiry
at 2026-09-30 13:53:52 Asia/Bangkok. The 410–720-hour baseline and existing
contingency are unchanged; this slice is not a forecast change.

## PF-2 S4 replay driver checkpoint — 2026-09-30

PF-2 S4 (`9a340af`, pushed) is a local, development-only Node replay driver and
result envelope; it is not wired to a scheduler, database or route, and nothing is
deployed. See the [record](PF2_S4_REPLAY_DRIVER_CHECKPOINT_2026-09-30.md).

Measured intervals, all wall-clock: wave D2 about 21:21-22:59 UTC (S4 build, tester
and auditor, one fix round, plus the S3 documentation worker), with the shared
5-hour usage window going from 42% to 54% used; wave D3 about 23:05-23:33 UTC (a
second fix round restricting interpreters to absolute paths, and a tester
re-check), followed by root checks until about 23:40 UTC. The 5-hour window reset
at 23:30 UTC during wave D3, so the share of that wave is not separable; the weekly
all-models counter went from 14% to 16% used across both waves. Shared counters do
not attribute cost to an agent or a step. The agents ran under the owner-approved
temporary elevated tier. No engineering hours are booked and no speedup is claimed.

Next work: an owner decision on FTR-1c; PF-2 production adapters, runtime admission
and CI wiring of the real-Python driver tests. The readiness retention cleanup
still waits for real age expiry at 2026-09-30 13:53:52 Asia/Bangkok. The
410–720-hour baseline and existing contingency are unchanged; this slice is not a
forecast change.

## QS-1 B1 recovery and PF-2 R1 checkpoint — 2026-09-30

Local slices `4b7d174` (CI), `e8e1920` and `bce4015` (QS-1 B1 recovery) and
`516b624` (PF-2 R1) are pushed; nothing is deployed. See the
[record](QD_QS_B1_RECOVERY_PF2_R1_CHECKPOINT_2026-09-30.md).

Measured intervals, all wall-clock: read-only scheduler and PF-2 runtime reviews
about 23:48-00:06 UTC; wave F (B1 and R1 build, verification and fix rounds) about
00:14-01:17 UTC; wave G (R1 hardening and B1 follow-up) about 01:18-01:50 UTC, then
root checks until about 01:55 UTC. The shared 5-hour usage window went from 1% to
8% used over the reviews, 8% to 23% over wave F and 23% to 29% over wave G and the
root checks; the weekly all-models counter went from 16% to 19%. Shared counters do
not attribute cost to an agent or a step. The agents ran under the owner-approved
temporary elevated tier. No engineering hours are booked and no speedup is claimed.

Next work: owner decisions on FTR-1c (with the B3 tail margin and a 70 s cap) and
PF-2 OD-1 to OD-5; then the B2 abort path and B4 policy-pinned terminal parameters
before product wiring, and PF-2 R2 and R3 after OD-2 and OD-3. The readiness
retention cleanup still waits for real age expiry at 2026-09-30 13:53:52
Asia/Bangkok. The 410–720-hour baseline and existing contingency are unchanged;
this slice is not a forecast change.

## FTR-1c-C commit barrier and heavy-path S1/S2 checkpoint — 2026-09-30

Local slices `f5616f2` (FTR-1c-C commit barrier and writeback drain plan) and
`ff1805d` (heavy-path S1/S2 containment) are pushed; nothing is deployed. See the
[record](QS_FTR1C_C_HEAVY_PATH_S1S2_CHECKPOINT_2026-09-30.md). The owner approved FTR-1c
with the scheduler-review amendment; three independent reviews accepted the local
slice and CI passed 9/9. The heavy-path slice is containment only and does not
close the heavy-path gate.

Measured intervals, all wall-clock: the heavy-path S1/S2 wave (build, audit, one
fix round and re-audit) about 02:14-03:18 UTC; the FTR-1c-C build and verification
about 02:20-02:55 UTC, in parallel; the independent second audit about 02:54-03:10
UTC; root checks, commits and push about 03:10-03:22 UTC, with CI green by about
03:30 UTC. The shared 5-hour usage window went from 35% to 64% used over the
overlapping waves and the weekly all-models counter from 20% to 24%; the second
audit's model has its own weekly counter, which went from 0% to 4%. Shared counters
do not attribute cost to an agent or a step. The agents ran under the
owner-approved temporary elevated tier. No engineering hours are booked and no
speedup is claimed.

Next work: the FTR-1c-INT Linux proof (independent packet audit, then owner-run
setup and launch after the readiness retention check at 2026-09-30 13:53:52
Asia/Bangkok; one run, no retry); the FTR-1c-D hardening packet; then the B2 abort
path and B4 policy-pinned terminal parameters before product wiring; heavy-path S3,
S3c and staging evidence plus the small `server.js` fix packet; PF-2 R2 and R3
after OD-2 and OD-3. The 410–720-hour baseline and existing contingency are
unchanged; this slice is not a forecast change.

## FTR-1c-INT Linux proof, hardening and PF-2 R2 checkpoint — 2026-09-30

The FTR-1c-INT Linux proof ran once, owner-run, no retry, on the FTR-1c-C code
`f5616f2` and returned PASS-MEASURED; local slices `30620ec` (FTR-1c-D hardening),
`dedf834` (wiring step W1), `f00053b` (RC-1) and `07728ad` (PF-2 R2) are pushed;
nothing is deployed. See the [record](QS_FTR1C_INT_LINUX_PROOF_2026-09-30.md). The 24-hour readiness retention
check passed on the aged pair with nothing deleted. Owner decisions OD-1 to OD-5
are approved as recommended.

Measured intervals, all wall-clock: the INT packet build, audit, fix round and
re-audit about 03:34-04:36 UTC; the hardening, W1, RC-1 and R2 wave about
04:33-06:24 UTC (ten agents); root checks, four commits and push about 06:24-06:38
UTC, with CI green by about 06:53 UTC; the INT window about 06:54-07:45 UTC
(retention check 06:54, preflight 06:58, upload 07:00, owner setup 07:33, owner
launch 07:34, result 07:35, postflight 07:36, recheck 07:44). The shared 5-hour
usage window reset at 04:30 UTC and went from 0% to 19% used over the wave and to
24% by 07:46 UTC, when the next wave had started; the weekly all-models counter
went from 26% to 29%. Shared counters do not attribute cost to an agent or a step.
The agents ran under the owner-approved temporary elevated tier. No engineering
hours are booked and no speedup is claimed.

Next work: the retention deletion of the aged readiness pair, owner-run, after
its own audit; PF-2 R3 (the service and holdout registry, in progress), then R4 to
R6; wiring step W2, then W3 to W6 and the W7 Linux proof, which carries the
FTR-1c-D Linux coverage; heavy-path S3 and S3c. The 410–720-hour baseline and
existing contingency are unchanged; this slice is not a forecast change.

## PF-2 R3 and R4, S3a design and wave M checkpoint — 2026-09-30

Local slices `25f2ff0` (PF-2 R3: the preflight service, holdout boundary registry,
trusted-source adapters and scheduler authorize callback) and `872a36a` (PF-2 R4:
the `pf2_replay` protocol mode, widened supervisor I/O allowlist and supervised
runner glue) are pushed; both are library code with no route, worker or process
wiring, and nothing is deployed. R3 passed isolated PostgreSQL 42/42, 16/16 and
1/1, and R4 passed pytest 104 and focused Node 141 (1 Linux-only skip); the full
unit suite is 684 tests with 681 pass, 0 fail and 3 skipped for both. Independent
audits and testers accepted both slices (R3 with test-only fixes, applied). CI is
9/9 green for `872a36a` and for `25f2ff0`. The QS
heavy-path S3a prepare-under-lease design is complete as a design only, with four
owner decisions pending; wiring step W2 is in progress locally and not committed;
the owner-run apply step for the aged readiness pair is prepared and audited but
not run, so the storage retention gate stays open.

Measured intervals, all wall-clock: wave M was dispatched about 10:50-11:00 UTC in
three lanes. The R4 coder plus audit took 3,168 s (about 53 min) and the R4 tester
484 s; lane 3 (the R3 test fixes plus the S3a design panel of three agents) took
6,284 s (about 1 h 45 min). The shared 5-hour usage window went from 6% used at
10:34 UTC to 54% used at 12:32 UTC; the weekly all-models counter went from 2% to
8% and the weekly counter of the second-opinion model (Fable) from 0% to 4%.
Observed throughput: three concurrent xhigh lanes consumed about 24 points of the
5-hour window per hour, so root held further dispatch until the window resets at
14:30 UTC. The S3a design panel was the second Fable pilot task (the alternative
designer; the judge scored it 18 of 25 against 21 of 25 and adopted ten of its
ideas). Shared counters do not attribute cost to an agent or a step. No engineering
hours are booked and no speedup is claimed.

Next work: PF-2 R5 (worker, scheduler and recovery wiring) after wiring slice W3;
R6 (routes) after the two owner decisions on the holdout registry; R7 (staging)
after a durable trusted PROFILE v2 enrollment and the owner-authorized operations
packet; heavy-path S3b-1, then S3b-2 and S3b-3 in one commit, then S3c; W2 to W6
and the W7 Linux proof; the owner-run retention apply step. The 410–720-hour
baseline and existing contingency are unchanged; this slice is not a forecast
change.

## Wiring step W2, PF-2 R3b, heavy-path S3b-1 and the retention apply step — 2026-09-30

Local slices `a8dcf6e` (wiring step W2: the PROFILE V2 launcher and runtime bound
to the policy terminal block, the abort path and the FTR-1c-D follow-ups),
`ad93d7e` (PF-2 R3b: the two owner-approved holdout rules) and `7a488d4` plus the
test-only `a40aa51` (heavy-path S3b-1: the pure V2 research contract module) are
pushed; no product code constructs the W2 launcher or runtime yet, R3b has no
route, S3b-1 is not wired, and nothing is deployed. W2 passed focused unit 109 (1
Linux-only skip), six isolated PostgreSQL files 161/161 and the full unit suite 684
with 0 fail, with an independent audit and an independent tester accepting; CI is
9/9 green. R3b passed isolated PostgreSQL 45/45, 16/16 and 1/1 with an independent
audit accepting (CI 8/9 at `ad93d7e` from the S3b-1 line-ending failure below, 9/9 at `a40aa51`). S3b-1 passed 30 tests and the full unit suite
714 with 0 fail, with an independent audit accepting after one fix; CI for
`7a488d4` was 8/9 because the Windows unit job failed on line endings, and
`a40aa51` normalizes them (CI 9/9 green). The owner approved the two PF-2
holdout rules and the four S3 prepare-under-lease decisions at about 12:45 UTC.
The owner ran the audited retention apply step once at 13:14:05 UTC; it deleted
exactly the aged typed readiness pair after about 30.3 hours of real age, and
root's read-only postflight found only the predicted retention state hash changed,
so the storage retention gate is closed for that pair. Work stopped on owner
instruction at about 15:00 UTC; no agent is running and the local test PostgreSQL
is stopped.

Measured intervals, all wall-clock: W2 coder plus audit 7,028 s (about 1 h 57
min); W2 fix plus tester 2,428 s (about 40 min); R3b coder plus audit 5,880 s
(about 1 h 38 min); R3b test pin 196 s; S3b-1 coder plus audit 3,821 s (about
1 h 4 min); S3b-1 fix plus re-audit 1,303 s (about 22 min); root diagnosed and
fixed the CI line-ending failure in about 15 minutes. The shared 5-hour usage
window went from 54% used at 12:32 UTC to 59% at 12:41, 62% at 13:08, 64% at 13:21
and 73% at 14:26, reset at 14:30 and stood at 4% at 14:53 UTC; the weekly
all-models counter went from 8% to 11% and the weekly Fable counter from 4% to 5%.
Observed throughput: one or two concurrent lanes at the elevated effort consumed
about 7 points of the 5-hour window per lane-hour. The owner's temporary elevated
agent tier ended at 15:00 UTC; the AGENTS.md table applies again. Shared counters
do not attribute cost to an agent or a step. No engineering hours are booked and
no speedup is claimed.

Next work: W3 (worker, scheduler, main and the capacity-policy loader); then PF-2
R6 (routes), moved after W3 because the API needs that loader, with one new owner
question first (whether a bot's PF-2 holdout boundary must also not be later than
the earliest registered PF-2 boundary of any sibling bot of the same owner; root
recommends yes); PF-2 R5 after W3; heavy-path S3b-2 and S3b-3 in one commit and
S3c after W3 and before R5; W4 after S3b-2; W6 after W3; the W7 Linux proof then
needs an explicit swap host fact; R7 after a durable trusted PROFILE v2 enrollment
and the owner-authorized operations packet. The 410–720-hour baseline and existing
contingency are unchanged; this slice is not a forecast change.

## Codex specialist model refresh — 2026-09-30

Local configuration and documentation now use GPT-6.1 Sol for all seven non-Astra
Codex specialist roles. Debugger/operations retain high effort; coder/tester/
routine worker retain medium; documentation/release clerk retain low. Root and
auditor remain Astra. The default child model is GPT-6.1 Sol at medium effort.
Historical Sol/Luna work records remain historical evidence, not current routing.

The owner authorized the usage-threshold exception only for this configuration
and documentation update. No worker or runtime job is started. Static profile
consistency and diff checks validate this scope; product tests are not applicable.
Active engineering hours are unknown; no measured speedup or cost saving is
claimed. The 410–720-hour baseline and standing 15-point reserve are unchanged.
W3 remains next; substantive work requires refreshed usage or separate owner
exception for that named continuation.

## PF-2 staging continuation — 2026-09-30

The owner requested PF-2 staging activation after acceptance and approved the
strictest shared sibling holdout boundary. The local service change passes 47/47
PostgreSQL tests, including concurrent registration/enqueue. W3 integration has
local code and independent source review, but full acceptance remains open.
Root serial PostgreSQL checks total 154 passed and 1 skipped across service,
foundation scheduler/worker/recovery, PROFILE and PROFILE V2 runtime suites.
The full Node suite exceeded its 180-second process budget and remains unverified.
The isolated local PostgreSQL cluster was stopped and the stop verified.
See [local checkpoint](PF2_W3_LOCAL_CHECKPOINT_2026-09-30.md) for exact scope.

The owner explicitly permits remaining usage down to 1% for this named continuation
only. This does not alter the standing 15-point reserve. Work uses one debugger
with sequential bounded auditor reviews; no throughput or model-cost claim is
made. Active engineering hours remain unknown; the 410–720-hour forecast is not
reduced. No market-data wait, VPS operation, migration or deployment occurred.

Next: finish W3 acceptance/diagnostics, then the existing S3/W/R dependencies.
Durable trusted PROFILE V2 enrollment is an explicit additional prerequisite for
R7; W3/W5 provisional CANCELLED output cannot satisfy it. PF-2 staging remains off.

### 2026-10-01 — PF-2 continuation local checkpoint

W3 runtime ผ่าน 43/43; W5 authority ผ่าน PostgreSQL 4/4; รวม PG 167 ผ่านและ 1 skip. Full Node ผ่าน 728 และ 3 skip ใช้ 242.9 วินาที; เป็นเวลาทดสอบ ไม่ใช่เวลา engineering. ผู้ตรวจพบและแก้ diagnostic reason; fixture ใหม่ 9 กรณีแก้แล้วโดยไม่ลด guard. Usage ล่าสุดเหลือ 94% รายสัปดาห์; short window ไม่ทราบ และใช้ floor 1% เฉพาะ continuation ตาม owner. ไม่อ้างต้นทุนแยก model หรือ speedup. S3b-2/S3b-3 เริ่มแบบแยกไฟล์; S3c ตามหลัง. Staging/production ยังไม่เปลี่ยน; README/Context ตรวจและอัปเดตขอบเขต local.

S3/W6 local update 2026-10-01: migration 9/9 และ retention 9/9 ผ่าน; HTTP precheck พบ off-grid regression แล้วแก้ โดย recheck ผ่าน 4/4. Independent S3c และ final regression ยังทำอยู่. Retention test packet ประมาณ 8 นาที และ W6 test packet ประมาณ 10 นาทีเป็นเวลา agent ที่รายงาน ไม่ใช่ active engineering รวม. Usage ล่าสุดเหลือ 90% รายสัปดาห์; short window ไม่ทราบ. ไม่ปรับ forecast จากจำนวน agents. ดู [checkpoint](PF2_S3_W6_LOCAL_CHECKPOINT_2026-10-01.md).

S3c baseline ผ่าน 8/8 บน snapshot ที่ hash ไม่เปลี่ยน ใช้ 57.3 วินาที; รอบแรกมี fixture decimal error และแก้ test หลังแจ้งพร้อม จึงไม่นับรอบนั้นเป็น acceptance. Full Node ล่าสุด 731 ผ่าน/3 skip ใน 247.7 วินาที. Mutation checks ยังทำอยู่. Usage ล่าสุดเหลือ 87% รายสัปดาห์; ตัวเลขบัญชีร่วมและ short window ไม่ทราบ.

Checkpoint 2026-10-01: S3c baseline ผ่าน 12/12 (73.224 วินาที) และ mutation 8 variants ถูกตรวจจับครบใน 7 หมวด Source จริงไม่เปลี่ยนระหว่างทดสอบ เป็น local synthetic/fake OS evidence ไม่ใช่ Linux proof เริ่ม R5 worker/recovery, E1 enrollment admission และ R6 API แยกเจ้าของไฟล์ Usage ล่าสุดใช้ 17% เหลือ 83% weekly; short window ไม่ทราบ ใช้ floor 1% เฉพาะ PF-2 ตามเจ้าของอนุญาต เวลาทดสอบไม่ใช่เวลาพัฒนารวม ไม่มี commit/push/deploy ดู PF2_S3_W6_LOCAL_CHECKPOINT_2026-10-01.md; README/Context ทบทวน ขอบเขต 10K staging/Paper คงเดิม

Checkpoint 2026-10-01: E1 PostgreSQL ผ่าน 3/3 และ migration 9/9; E3 resolver 47/47, preflight PostgreSQL 48/48, historical consumers 1/1 และ independent review ผ่านตามขอบเขต R5 worker รอบแก้ fixture ผ่าน 10/10 ใน 36.3 วินาที; HTTP ผ่าน 8 และยังข้าม positive flow 1 ข้อ E2 authority/runtime แยกเจ้าของไฟล์เริ่มแล้ว Usage ล่าสุดใช้ 25% เหลือ 75% weekly; short window ไม่ทราบ, floor 1% เฉพาะ continuation นี้ ตัวเลขเวลาเป็นเวลาทดสอบ ไม่ใช่เวลาพัฒนารวม ไม่ปรับ forecast หรืออ้าง speedup จากจำนวน agents ไม่มี commit/push/deploy

E2 integration checkpoint: diagnostic regression ผ่าน 43/43 ใน 55.3 วินาที,
migration 9/9 ใน 15.5 วินาที, HTTP 9/9 ใน 123.9 วินาที และ SQL authority 4/4
ใน 9.3 วินาที ยังไม่รับ E2 runtime fault matrix หรือ E4 producer chain
Usage ล่าสุดเหลือ 69% weekly; short window ไม่ทราบ ใช้ floor 1% ตาม continuation
เดิม เวลาทดสอบไม่ใช่เวลาพัฒนารวม ดู [checkpoint](PF2_ENROLLMENT_LOCAL_CHECKPOINT_2026-10-01.md)


Owner stop checkpoint 2026-10-01: ไม่เริ่มงานหรือทดสอบเพิ่มตามคำสั่งเจ้าของ
E2 faults ผ่าน 16/16 ใน 77.2 วินาที; E4 worker chain ผ่าน 1/1 ใน 80.3 วินาที
Full Node ใช้ 463.1 วินาที ได้ 760 pass/2 fail/3 skip; focused closure ยังไม่ผ่าน
I/O runtime 53 pass/2 fail และ I/O ledger 9 pass/1 fail จึงยังไม่รับ final regression
หยุด local PostgreSQL แล้ว ไม่มี staging activation หรือ commit/push/deploy
Usage ล่าสุดใช้ 37% เหลือ 63% weekly; short window ไม่ทราบ สิทธิ floor 1% ของ
PF-2 ไม่ใช่คำสั่งให้ทำต่อหลังเจ้าของขอหยุด เวลาเหล่านี้เป็นเวลาทดสอบ ไม่ใช่
เวลาพัฒนารวม ไม่ปรับ forecast จากจำนวน agents ดู checkpoint ล่าสุด
PF2_ENROLLMENT_LOCAL_CHECKPOINT_2026-10-01.md และ resume จาก failures ที่ระบุ


Git-only continuation: เจ้าของสั่ง commit/push checkpoint ที่หยุดไว้ อนุญาตเฉพาะ
การบันทึกและส่ง Git รอบนี้ ไม่เริ่ม implementation หรือทดสอบใหม่ ไม่เปลี่ยน
สถานะ acceptance/staging Usage ล่าสุดเหลือ 62% weekly; short window ไม่ทราบ

## Claude Fable 5.1 permanent roles — 2026-10-01

The owner made Fable 5.1 a permanent part of the Claude agent team in the three
pilot roles: second-opinion auditor, alternative designer and checkpoint drafter.
The 2026-09-30 pilot supports each role. The second-opinion audit found issues the
Opus audit missed, the design panel adopted ten Fable ideas, and three docs drafts
needed only small root fixes. That audit ran at xhigh effort and used about 227K
tokens in 990 seconds. The xhigh tier ended on 2026-09-30, so the auditor and
designer now run at high and the drafter at medium; root may raise one packet by
one level under the AGENTS.md rule.

Scope is policy and documentation only; no project worker, test, runtime job or
VPS action ran. Usage at the change: 5-hour window 3%, weekly all models 13%,
weekly Fable 7%. No speedup or cost saving is claimed and the forecast is
unchanged. PF-2 work stays stopped at the owner's request.

## PF-2 CI repair, E2 settlement fix และ shared stop acknowledgement — 2026-10-01

เจ้าของกลับมาทำงาน PF-2 บน Claude root หลัง handoff จาก Codex รอบงานประมาณ
20:30Z–22:20Z ของ 2026-09-30 UTC (2026-10-01 เวลาไทย) push 5 commits: `96b0e15`
(เอกสารบทบาทถาวร Fable 5.1), `258e865` (แก้ CI), `3ce7e32` (annotation ของ
PostgreSQL tests ที่ล้มใน CI), `3742961` (แก้ E2 enrollment settlement) และ
`338d91b` (V2 PROFILE stop acknowledgement authority เดียวพร้อม deadline test)
ไม่มี deploy, migration, staging activation หรืองาน VPS; PF-2 staging API ยังปิด

CI: `f52d4be` ล้ม (resolver sort ใน Quant/Safety และ PostgreSQL 19 tests)
`258e865` ผ่าน Quant Windows/Ubuntu, Safety Windows/Ubuntu, container และ gate;
PostgreSQL ล้มหนึ่งครั้งโดยไม่ทราบสาเหตุ เพราะ job logs ต้องใช้ผู้ดูที่ลงชื่อเข้าใช้
และรอบถัดไปผ่าน `3ce7e32` และ `3742961` ผ่าน 9/9 รวม Windows และ PostgreSQL;
`338d91b` ผ่าน 9/9 เช่นกัน สาเหตุที่แก้ใน `258e865`: (1) regression ของ product คือ
PF-2 wiring ส่ง dataset stores ที่ใช้ไม่ได้เมื่อปิด data capability ทำให้ server
ไม่เริ่ม (`PREFLIGHT_CONFIGURATION_INVALID`, HTTP 10 suites) ตอนนี้ส่ง stores
เฉพาะเมื่อเปิด PF-2 และ PF-2 ที่เปิดโดยไม่มี stores ที่ใช้ได้ยัง fail closed
(2) เรียง `PF2_ENGINE_FILES`, ปรับ resolver closure checks ให้ตรง shared runtime
manifest, ปักหมุด closure 21 ไฟล์ของ PF-2 และใช้ application boundary list ร่วม
ชุดเดียว (3) legacy synthetic foundation test เปลี่ยน kind จาก `PREFLIGHT` เป็น
`BACKTEST` (4) Linux stop-proof ล้มเพราะ venv path แบบ Windows ที่ hard-code และ
ไม่มี Python ใน CI PostgreSQL job แก้ด้วย platform paths และ `uv sync` ใน CI
(5) ปรับ I/O guard และ schema inventory tests โดยทุก guard ยังถูกตรวจ (mutants
ถูก kill)

E2: Opus auditor และ Fable second-opinion auditor พบ defect เดียวกันโดยอิสระ คือ
SERIALIZABLE settle ถ่าย snapshot ก่อนรอ scheduler lock ทำให้ owner cancel ที่
ทำพร้อมกันทิ้ง measured settlement `3742961` แก้ด้วย `LOCK TABLE` ก่อน (ไม่ retry),
durable re-read คืน `UNSETTLED` เฉพาะเมื่อไม่มีอะไร settle, clock high-water marks
พร้อม monotonic floor, ผูก authority ตอนสร้าง runtime และตรวจ launch identity ตอน
finalize; Opus re-audit ยอมรับ Carry-note ของ `f52d4be` ปิดแล้ว 20 จาก 23 ข้อ:
R6-15 (startup) แก้แล้ว; W3-4 ยอมรับตาม contract F11 (แถว V2 ที่ PAUSED relaunch
ไม่ได้และถูก cancel ตอน claim) แต่ proof test ยังรอ; S3b-8 ปิดเพราะบังคับ deadline
ทุก lease action ก่อน runtime cap (test P13); `338d91b` ลบ acknowledgement
authority ที่ซ้ำ

หลักฐาน local (CI flags, isolated local PostgreSQL): full Node 767 tests ผ่าน 764
ล้ม 0 ข้าม 3 ใน 287 วินาที (ก่อนแก้ E2); enrollment PostgreSQL 38/38; runtime-v2,
foundation และ recovery 106/106; producer และ worker 11/11; io-runtime 57/57;
io-ledger 10/10; preflight-schema 16/16 ตัวเลขเหล่านี้เป็นเวลาทดสอบ ไม่ใช่ชั่วโมง
engineering; active hours ยังไม่ทราบ คงงบ 410–720 ชั่วโมง ไม่อ้าง speedup หรือ
ต้นทุน และไม่ปรับ forecast Usage บน Claude root: ตอน resume 5-hour 6%, weekly
all-models 13%, weekly Fable 7%; ณ 22:16Z 5-hour 66%, weekly 21%, weekly Fable 13%

งานค้าง: E2 follow-up (veto enrollment เมื่อ settled I/O operation มี stop reason;
คิด terminal runtime ใน unknown-final fallback; unsafe clock totals); D6
prepare+BEGIN p99 ภายใต้ contention ต้องวัดบน Linux และ block durable enrollment
proof (Roadmap R7) กับ staging activation แต่ไม่ block W7 diagnostic;
staging role ต้องมีสิทธิ์ UPDATE ระดับ table สำหรับ `LOCK TABLE`; proof tests ที่ยัง
ขาด R6-14, R5-19, R5-21, R5-23, S3b-9, W3-4; W7 diagnostic helper ยังไม่เสร็จและ
ไม่ได้ทดสอบ; SQL receipt defense-in-depth (schema change) เลื่อนไว้; PostgreSQL CI
ล้มหนึ่งครั้งที่ `258e865` ยังไม่ทราบสาเหตุ

## PF-2 wave 2: E2 follow-up, proof tests, W7 helper และ owner packet — 2026-10-01

Claude root ทำงาน PF-2 ต่อ รอบงานประมาณ 01:06Z–06:40Z ของ 2026-10-01 UTC
(08:06–13:40 เวลาไทย) รวมการรอ 5-hour usage window push 6 commits: `5b1641f`,
`06a0f0f`, `4eb041a`, `e6f0dff`, `2b7915f` และ `28d6f7e` ไม่มี deploy, migration,
staging activation หรืองาน VPS; PF-2 staging API ยังปิด ขอบเขตเดิม: Spot/Paper
เท่านั้น, BINANCE:BTCUSDT 1m, 10,000 แท่งดิบรวม warm-up, ไม่มี Live, ไม่มี
optimizer loop และไม่ reset guard

โค้ดและ tests: `5b1641f` พิสูจน์ carry notes ที่เหลือ R6-14, R5-19 (fake systemd
เท่านั้น), R5-21, R5-23, S3b-9 และ W3-4 (แถว V2 ที่ PAUSED ถูก cancel ตอน claim)
โดยแต่ละข้อมี mutants ที่ถูก kill; R5-21 จับ private function ผ่าน prototype
accessor ชั่วคราว จึงมี test-only seam เป็นงานตามหลัง `06a0f0f` คือ E2 follow-up:
veto enrollment (IO_BUDGET) เมื่อ settled I/O operation มี stop reason โดย measured
DENIED ยังคิด charge เดิม, unknown-final fallback คิด terminal runtime และ unsafe
wall-clock totals นับเป็น anomaly ยอมรับ residual R3 เพราะเข้าถึงไม่ได้กับ wiring
ปัจจุบัน; Opus review ยอมรับ ส่วน backlog ที่ไม่บังคับคือ F1 (charge ก่อน return
UNCONFIRMED), F3 (unsafe total แบบ monotonic) และ F4 (PostgreSQL bounds ที่หลวม)
`4eb041a` เก็บ test residue (unused imports, บรรทัดว่างท้ายไฟล์, skip reasons และ
HTTP fixture stop helper ที่ใช้ร่วมกัน)

W7 helper: `e6f0dff` เพิ่ม owner-only W7 diagnostic PROFILE enqueue helper
`scripts/enqueue-quant-profile-diagnostic.mjs` (dry run เป็นค่าเริ่มต้น; หนึ่ง
SERIALIZABLE transaction ที่ขอ scheduler lock ก่อนโดยจำกัดการรอ lock 1,000 ms;
ตรวจ idle gate ก่อน; การเขียนต้องมี `--enqueue --expect-contract-hash`; idempotent;
refusals มี code; ตรวจ private request file) และ start guard แบบ symlink-safe ของ
`scripts/check-quant-foundation-idle.mjs` Opus review ยอมรับพร้อม fixes ที่แก้ก่อน
commit; local: helper unit tests 27 ผ่านพร้อม 2 Linux-only skips, PostgreSQL helper
14/14, migration 9/9

CI: `06a0f0f` ผ่าน 9/9 `e6f0dff` ล้ม (PostgreSQL race และ Ubuntu uid test)
`2b7915f` ทำให้ HTTP test fixture รอจน server sessions ที่หยุดแล้วปล่อย maintenance
lock ซึ่งแก้ race (`RECOVERY_RUNTIME_ACTIVE`) และน่าจะเป็นสาเหตุของความล้มที่ไม่
ทราบสาเหตุของ `258e865` ด้วย (ยังพิสูจน์ไม่ได้ เพราะ job logs ต้องใช้ผู้ดูที่ลงชื่อ
เข้าใช้); ที่ `2b7915f` PostgreSQL ผ่านแต่ Ubuntu unit ล้มที่ uid test และ `28d6f7e`
ให้ helper test จำลอง uid ที่หายไปแบบ portable `28d6f7e` ผ่าน 9/9 รวม PostgreSQL,
Windows และ Ubuntu และเป็น W7 release commit ตามแผน CI unit job ตอนนี้ annotate
tests ที่ล้ม

W7 owner packet (private และถูก Git ignore) กับ
[staging acceptance packet](PF2_STAGING_ACCEPTANCE_PACKET_2026-10-01.md) ที่ track
ไว้สร้างโดยไม่มี VPS access จริง เจ้าของรันทุกขั้นตอนบน host เอง หนึ่งครั้งต่อหนึ่ง
กรณีและไม่ retry อัตโนมัติ ต้อง export release จาก git blob bytes เพราะ
`git archive` บน Windows checkout นี้เขียน CRLF และ `.gitattributes` export-ignore
`quant_lab/**` (63 ไฟล์ ซึ่ง 24 ไฟล์อยู่ใน engine hashes) engine hashes ที่คำนวณจาก
blob ที่ `e6f0dff` และ `28d6f7e`: ingestion `d7097b8a...` (79 ไฟล์) และ foundation
`d865692f...` (78 ไฟล์) ประวัติการตรวจ: revision 1 ได้ "go with fixes" จาก audit
อิสระสองชุด (Opus และ second-opinion auditor); revision 2 (operations role) ปิดทุก
finding หรือปฏิเสธพร้อมเหตุผล; Opus re-audit ของ revision 2 ไม่พบ High และพบ Medium
สองข้อ (ต้องรัน static grant-role และ psql checks ก่อนติดตั้ง schema ที่ย้อนกลับ
ไม่ได้; early rollback ต้องตรวจ SELECT ของ runtime role บน I/O tables ก่อน restart
release เดิม) กับ Low หลายข้อ; root revision 3 แก้ครบและ auditor คนเดิมปิด gate G2
การตัดสินใจของ root: C2 หยุด worker 1,000 ms หลังเห็น job เป็น STOPPING ครั้งแรก;
stop ที่ LATE ถือว่าสรุปไม่ได้และไม่ retry; เกณฑ์ host คือ disk ว่างอย่างน้อย
20 GiB, memory available อย่างน้อย 4 GiB, load หนึ่งนาทีต่ำกว่า 1.0 และ claim
ภายใน 10 นาที

Gates ที่เหลือ: G1 release record (รวม previous staging release commit และ
configuration digests ที่ตรวจแล้ว), G3 เจ้าของ GO ต่อ mutating effect แต่ละอย่าง,
G4 usage และ G5 window คำถามเจ้าของที่ยังเปิด 10 ข้อ: executor mode; BACKFILL ที่
SUCCEEDED ไม่เกิน 10,000 แท่งและ deployment ที่ READY ที่มีอยู่; ปิด API admission
ระหว่าง W7; offline window; runtime role และ DELETE revoke; การอนุมัติ blob export;
configuration digests; release ก่อนหน้า; end state; psql/tmux บน host

แก้ถ้อยคำ D6: รายการก่อนหน้าเขียนว่า D6 prepare+BEGIN p99 ภายใต้ contention บน Linux
block W-INT และ staging ซึ่งกว้างเกินไป เฉพาะ job ที่ marked
`completion_mode: 'pf2-enrollment-v1'` เท่านั้นที่รัน enrollment prepare และ BEGIN
(`src/postgres/quant-profile-runtime-v2.js` บรรทัด 82-84, 152 และ 164-167); W7
diagnostic jobs ไม่ marked ดังนั้น D6 block durable enrollment proof (Roadmap R7)
และ staging activation ไม่ block W7 diagnostic

หลักฐาน local (CI flags, isolated local PostgreSQL): regression สุดท้ายบันทึกที่
`7b8a08d` ซึ่งเป็นปลายรอบก่อน (2026-09-30 22:52Z): PostgreSQL 450 tests ผ่าน 448
ล้ม 0 ข้าม 2 (724 วินาที); Node 783 tests ผ่าน 780 ล้ม 0 ข้าม 3 (224 วินาที)
commits ของ wave 2 มี focused local runs ข้างต้นและ CI 9/9 ที่ `06a0f0f` และ
`28d6f7e` ตัวเลขเหล่านี้เป็นเวลาทดสอบ ไม่ใช่ชั่วโมง engineering; active hours ยัง
ไม่ทราบ คงงบ 410–720 ชั่วโมง ไม่อ้าง speedup หรือต้นทุน และไม่ปรับ forecast
Usage บน Claude root: ตอนเริ่ม 5-hour 0%, weekly all-models 23%, weekly Fable 16%;
ณ 05:30Z 5-hour 74%, weekly 32%, weekly Fable 19%; หลัง reset 06:00Z 5-hour 0%,
weekly 33%

งานถัดไป: เจ้าของตอบคำถามและทำ G1 release record; เจ้าของ GO; เจ้าของรัน W7 cases C1
และ C2; แล้ววัด D6 และ Roadmap R7 Backlog: E2 optional items F1, F3, F4; test-only
seam ของ R5-21; design deviations (default `profileV2Enabled=true` ของ scheduler
constructor เทียบกับ worker default false และ reason allowlists สองชุด); ให้ grant
script มี DELETE revoke (การรัน grant ครั้งหลังจะ grant DELETE ซ้ำ); SQL receipt
defense-in-depth (schema change) ยังเลื่อน; final pre-staging code audit ทำหลัง checkpoint นี้ (ดู change log)
