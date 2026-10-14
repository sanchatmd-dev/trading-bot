# Owner decisions: รายการรอตัดสินใจ (2026-10-13)

เอกสารนี้รวมการตัดสินใจที่ยังเปิดอยู่จากงานต่อเนื่องของ Claude วันนี้ เพื่อให้เจ้าของโปรเจกต์ตอบได้ในรอบเดียว เอกสารนี้ไม่ใช่ GO ไม่ได้อนุมัติหรือตัดสินใจสิ่งใด และไม่ให้สิทธิ์ทำงานบนโฮสต์ ค่าที่ระบุว่า "ค่าแนะนำ" เป็นข้อเสนอเท่านั้น ถ้าแหล่งข้อมูลไม่ได้ระบุค่าแนะนำหรือผลของการปฏิเสธ จะเขียนว่า "แหล่งไม่ระบุ" ตารางภาษาอังกฤษอยู่ท้ายเอกสาร

## สรุปภาษาไทย

### กลุ่ม A: การวัด EM2 (amendment)

- ขอให้: ตรวจข้อความ amendment ฉบับร่าง (ยังเป็น DRAFT ไม่ใช่ GO เจ้าของยังไม่ได้ตรวจ) แล้วตัดสินใจว่าจะให้ GO ของ amendment หรือไม่ ชื่อ GO ตามถ้อยคำ Addendum 1 คือ R7-CRASHED-BASELINE-AMENDMENT-V4 แต่ข้อ Q2 เสนอใช้รหัสตามโค้ด (V5) ให้ดูข้อ Q2 ด้วย
- ตัวเลือกและค่าแนะนำ: มีคำถาม Q1 ถึง Q19 ครบอยู่ในตาราง English ด้านล่าง (ย่อไว้) รายละเอียดเต็มอยู่ใน [EM2 readiness ส่วนที่ 7](EM2_MEASUREMENT_READINESS_2026-10-13.md)
- แหล่งไม่ได้ระบุว่าข้อใดเป็นของเจ้าของ ข้อใดเป็นของ root ยกเว้น Q9 และ Q14 ที่แหล่งระบุว่า root ตัดสิน ข้อที่สรุปไทยของแหล่งยกว่าน่าจะต้องให้เจ้าของดู: Q1 (ใครอนุมัติ allowlist), Q2 (รหัส GO), Q4 (ยืนยันว่า m2a และ m2b เป็นขั้นตอนอ่านอย่างเดียว), Q6 และ Q7 (ความเสี่ยงที่เหลือ), Q16 (สิ่งที่เจ้าของจะได้รับ), Q17 (งบการใช้งานและเวลา ซึ่งตามแหล่งยังไม่ทราบ)
- ผลถ้าปฏิเสธ: ระบุเป็นรายข้อในตาราง ส่วนข้อที่ไม่มีระบุคือ "แหล่งไม่ระบุ"
- เกตที่ยังเปิดทั้งหมดอยู่ใน section 3 ของเอกสาร readiness (G1 ถึง G11) ไม่มีเกตใดปิดโดยเอกสารนี้ การเลือกช่วงเวลาเงียบ (G2) และ GO ของ M1/M4/XM (G3) เป็นของเจ้าของ และเกิดหลังจาก amendment GO เท่านั้น

### กลุ่ม B: การตรึงผลวิจัย QR-1b (result freeze)

สถานะ: ผู้สมัครแบบ local ผ่านการยอมรับแล้ว commit และ push ไปที่ branch codex/app3a-market-wait-checkpoint แล้ว (ไม่ใช่ main) แต่ยังไม่ deploy และไม่ได้ migrate บน staging

- D1: อนุมัติ design A หรือไม่ (trigger ในฐานข้อมูลห้ามแก้แถว terminal ของ quant_jobs) และจะห้าม DELETE ทุกแถว หรือห้ามเฉพาะแถว terminal ค่าแนะนำ: ห้าม DELETE ทุกแถว (เป็นค่าเริ่มต้นของผู้สมัคร) ผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- D2: จะเพิ่มการตรวจ REVOKE DELETE และ TRUNCATE ในหน้าต่างปรับสิทธิ์รอบหลังหรือไม่ ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- D3: จะอนุญาตให้ทดสอบเขียนเชิงลบ (negative write probe) บน staging จริงหรือไม่ หรือทำบน restore rehearsal เท่านั้น ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- D4: ต้องมีตาราง seal แบบ append-only ก่อน QR-2 หรือไม่ ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- เกต staging ก่อน apply (ยังไม่ปิด): ซ้อมกู้คืนแบบ physical พร้อม rollback; GO รายผลกระทบจากเจ้าของ ใช้ operations worker คนเดียว รู้สุขภาพโฮสต์และแผนงาน และไม่ทับซ้อนกับ R7B/EM2; สำรองข้อมูลและเก็บ cold archive โดยหยุดผู้เขียนภายใต้ maintenance lock; อ่าน catalog ของ staging เรื่องสิทธิ์ TEMP และ parameter ACL
- ข้อสังเกตที่ไม่ใช่การตัดสินใจแต่ควรรู้ (QR1B-MODE-GUARDS, ระดับ MEDIUM): guard เดิมใน quant-research-foundation-schema.sql ยังไม่ถูกแก้ในแพ็กเกจนี้ ต้องมีแพ็กเกจของตัวเอง

### กลุ่ม C: การเสริมความแข็งแรงของ guard ในฐานข้อมูล (GH1/GH2)

สถานะ: ผู้สมัครแบบ local ผ่านการยอมรับแล้ว commit และ push ไปที่ branch codex/app3a-market-wait-checkpoint แล้ว (ไม่ใช่ main) แต่ยังไม่ deploy และไม่ apply บน staging การ apply บน staging ต้องมี GO ของตัวเองผ่าน operations worker และต้องยืนยันก่อนว่า staging ยังเป็นนิยามเดิม

- C1: อนุมัติตัวเลือก (b) ของ GH2 สำหรับผู้สมัครบน staging หรือไม่ ผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- C2: จะ REVOKE TEMP จาก PUBLIC บนฐานข้อมูลของแอปหรือไม่ แหล่งระบุว่าปิดช่องโหว่ shadowing ทั้งกลุ่ม แต่เป็นการเปลี่ยน grant ต้องรีสตาร์ตบริการและตรวจความพร้อม และต้องมีหน้าต่าง staging ถ้าอนุมัติ ผู้รันเครื่องมือต้องเป็นเจ้าของฐานข้อมูลที่เป็น superuser หรือมีสิทธิ์ pg_read_all_stats ซึ่งการให้สิทธิ์นี้ก็เป็นการเปลี่ยน grant อีกรายการ มิฉะนั้นเครื่องมือจะปฏิเสธ (RT2) ค่าแนะนำ: แหล่งไม่ระบุ (ดูกลุ่ม E ข้อ E1 และ E2 ที่เกี่ยวข้อง)
- C3: จะ apply GH1, GH2, bot-parent hardening และ QR-1b freeze ในหน้าต่างออฟไลน์เดียวหรือไม่ (แต่ละตัวมี migration และ rollback ของตัวเอง) ค่าแนะนำ: แหล่งไม่ระบุ
- C4 (ภายหลัง): จะผูก hardening เข้ากับการติดตั้งใหม่และบังคับให้สถานะ hardened หรือไม่
- ข้อสังเกต: rollback จะเปิดช่อง shadow bypass กลับโดยไม่แจ้ง (GH2-ROLLBACK-SILENT, INFO) และการป้องกันนี้เป็น defense in depth ต่อ SQL ที่รันด้วย role ของ runtime

### กลุ่ม D: commit และการเผยแพร่

ตอบแล้วเมื่อ 2026-10-14: เจ้าของอนุญาต commit และ push ทีละ commit เพื่อรัน CI งานจนถึง 4d86822 จึง commit และ push ไปที่ branch codex/app3a-market-wait-checkpoint แล้ว (ไม่ใช่ main) ส่วนที่ยังอยู่ในเครื่องและยังไม่ commit: รอบแก้ของ G1 และ CR1B และรอบ hardening ของ W1 การ commit หรือ push ครั้งต่อไปต้องได้รับอนุญาตจากเจ้าของทุกครั้ง เอกสาร readiness ระบุชัดว่าไม่อนุญาต commit, push หรือการเผยแพร่ใด ๆ

### กลุ่ม E: หน้าต่าง staging สำหรับ guard ของฐานข้อมูล (OPS1 ฉบับร่าง r6)

ฉบับร่าง OPS1 r6 เป็นเอกสารส่วนตัวในเครื่อง ไม่ใช่ GO และไม่ให้สิทธิ์ใด ๆ หน้าต่าง staging เองต้องมี GO รายผลกระทบจากเจ้าของแยกต่างหาก และทำผ่าน operations worker คนเดียวเท่านั้น ข้อต่อไปนี้คือคำถามเปิดของฉบับร่าง ถ้าแหล่งไม่ได้ระบุค่าแนะนำหรือผลถ้าปฏิเสธ จะเขียนว่า "แหล่งไม่ระบุ"

- E1 (Q2 ของฉบับร่าง, เจ้าของ): ตัดสินใจเรื่อง C2 (REVOKE TEMP จาก PUBLIC) ดูข้อ C2 ในกลุ่ม C ซึ่งเป็นเรื่องเดียวกัน ส่วนที่ฉบับร่างเพิ่มคือคำถามของ root ว่าจะผูก REVOKE เข้ากับ `scripts/grant-postgres-runtime.sql` และการตรวจความพร้อมตอนเริ่มบริการภายหลัง (C4) หรือไม่ เพราะตอนนี้ยังไม่มีโค้ดใดเรียกใช้โมดูลนี้ นอกจากนี้ยังไม่ทราบว่าการเชื่อมต่อของเจ้าของฐานข้อมูลใดจะรัน `--revoke` และ `--restore` ถ้า schema owner ไม่ใช่เจ้าของฐานข้อมูล ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E2 (Q10 ของฉบับร่าง, เจ้าของ): ผู้รันขั้น E5 ต้องเป็นเจ้าของฐานข้อมูลและมองเห็นทุก session ให้เลือก (a) เจ้าของฐานข้อมูลที่เป็น superuser อยู่แล้ว (b) ให้สิทธิ์ `pg_read_all_stats` แบบ INHERIT แก่เจ้าของที่ไม่ใช่ superuser ซึ่งเป็นการเปลี่ยน grant ที่ต้องมี GO รายผลกระทบเดียวกัน และต้องตัดสินใจว่าจะถอนสิทธิ์หลังจบหน้าต่างหรือไม่ หรือ (c) ไม่รัน E5 ตัวเลือกการ override แบบไม่ปลอดภัยไม่ใช่ทางเลือก ฉบับร่างไม่ได้เลือกให้ ค่าแนะนำ: แหล่งไม่ระบุ ผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E3 (Q11 ของฉบับร่าง, เจ้าของ): ระบุ login role ที่ต้องคง TEMP ไว้ (`--allow-temp-role`) ค่าเริ่มต้นของฉบับร่างคือไม่มี role ใดเลย ผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E4 (Q3 ของฉบับร่าง, เจ้าของ): จะสลับ staging API ไปใช้ release นี้ในหน้าต่างเดียวกัน (W10) หรือภายหลัง ระหว่างนั้น Library จะแสดงสถานะต่ำกว่าความเป็นจริง ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E5 (Q4 ของฉบับร่าง, เจ้าของ, คือ D1): คงการ "ห้าม DELETE ทุกแถว" (ไบต์ที่ผ่านการยอมรับแล้ว) หรือขอรุ่นที่ห้ามเฉพาะแถว terminal ซึ่งต้องเป็นผู้สมัครใหม่ ดูกลุ่ม B ข้อ D1 ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E6 (Q5 ของฉบับร่าง, เจ้าของ, คือ D3): ทดสอบเขียนเชิงลบบน staging จริง หรือทำบน restore rehearsal เท่านั้น ดูกลุ่ม B ข้อ D3 ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E7 (Q6 ของฉบับร่าง, root): ถ้าหยุดกลางหน้าต่าง จะยกเลิกทั้งหน้าต่าง (ค่าเริ่มต้นของฉบับร่าง) หรือคงขั้นตอนอิสระที่ทำเสร็จแล้ว ผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E8 (Q7 ของฉบับร่าง, เจ้าของ): ระยะเวลาสังเกตการณ์หลังหน้าต่าง คือเพิ่ม 10 นาทีเท่านั้น หรือเพิ่ม 24 ชั่วโมงด้วย ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E9 (Q8 ของฉบับร่าง, root): ฟิลด์ใดของ JSON จาก `--inspect` ที่ผ่านการลบข้อมูลละเอียดอ่อนแล้วจะบันทึกลงหลักฐานที่ติดตามใน Git (JSON เต็มมีชื่อ role และชื่อฐานข้อมูล) ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E10 (Q1 ของฉบับร่าง, root): การอ่านที่ไม่มี CLI ใดครอบคลุม (การสืบทอดตาราง, เจ้าของ/ACL/COST, OID และนิยาม, trigger, เวอร์ชัน, digest, การอ่าน ACL ของ parameter และ CREATE และอื่น ๆ) ต้องใช้การอ่านด้วย `psql` ที่ผ่านการตรวจ หรือเครื่องมืออ่านอย่างเดียวที่ผ่านการตรวจเพิ่ม ส่วนที่ CLI ตรวจได้ตอบแล้ว ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- E11 (Q12 ของฉบับร่าง, เจ้าของ): จะทำ logical backup ครั้งที่สองหลังขั้น W8 หรือไม่ เพื่อให้การ restore แบบ logical ภายหลังได้สถานะที่เสริมความแข็งแรงและตรึงแล้ว หรือพึ่งสำเนา physical อย่างเดียว (หมายเหตุ: archive ของ W2 เก็บสถานะก่อนหน้าต่าง การ restore จาก archive นั้นจะไม่คืนการเสริมความแข็งแรงและการตรึง) ค่าแนะนำและผลถ้าปฏิเสธ: แหล่งไม่ระบุ
- ข้อเท็จจริงสำหรับเจ้าของ (ไม่ใช่คำถามใหม่; ฉบับร่างหัวข้อ 7.1 และบันทึก rehearsal สาธารณะ `docs/evidence/DB_GUARD_WINDOW_LOCAL_REHEARSAL_2026-10-13.json` followUps LR3): การ restore แบบ logical ปลอดภัยเฉพาะการ restore เต็มรูปแบบลงฐานข้อมูลเปล่าเท่านั้น ห้าม restore แบบ data-only และห้าม restore โดยปิด trigger บนฐานข้อมูลที่ถูกตรึงแล้ว

### กลุ่ม F: การออกแบบ QR-2 Paper Portfolio Performance

สถานะ: เป็นแค่การออกแบบในเครื่อง (local design only) ยังไม่มีการเขียนโค้ดใด ๆ และเอกสารออกแบบเป็นเอกสารส่วนตัว ที่มา: ส่วนที่ 12 "Owner decisions (merged)" ของเอกสารออกแบบ O1 ถึง O16 ทุกข้อเป็นของเจ้าของ ยกเว้นรายการระดับ root ที่ไม่ใช่การตัดสินใจของเจ้าของ (audit dedup key, hook หลัง commit ใน `request-dispatch.js`, การสั่งนับข้อมูลบน staging แบบอ่านอย่างเดียว) เอกสารนี้ไม่ใช่ GO

- การตัดสินใจที่ขวางสไลซ์โค้ดแรก S1: O1, O3, O4, O7, O9, O11, O15, O16 (เอกสารออกแบบระบุว่าต้องบันทึกครบก่อนเริ่ม S1)
- O2 ขวาง S4 และ S5 (ไม่ขวาง S1 ถึง S3)
- O1 (ขวาง S1): เกณฑ์อายุราคา ค่าแนะนำ: `fresh_ms` 180 วินาที และ `carry_ms` 900 วินาที ราคาที่เก่าเกินยังให้ค่าและผลตอบแทน แต่ติดธงอายุ
- O2 (ขวาง S4, S5): โมเดลเงินทุนร่วมและยอดรวมที่มีอยู่ ค่าแนะนำ: ใช้การประกาศ v1 (`INDEPENDENT_ACCOUNTS` หรือ `SHARED_HYPOTHETICAL`) ไม่แสดงยอดรวมจนกว่าจะประกาศ เปลี่ยนป้ายของ tile ใน Overview และแก้ `bots.js:129` ทันที ส่วน pool แบบมี sleeve เป็น S4b ภายหลังเท่านั้น
- O3 (ขวาง S1): ทุนที่ตั้งค่าไว้แต่ไม่มีสินทรัพย์รองรับ ค่าแนะนำ: ไม่นับใน NAV แสดงในบรรทัดแยก การกำหนดขนาดสถานะไม่เปลี่ยน
- O4 (ขวาง S1): วิธีคำนวณผลตอบแทน ค่าแนะนำ: TWR เป็นหลัก Modified Dietz เป็นรอง พร้อมป้ายของตัวเอง แสดง money PnL เสมอ ไม่ใช้ IRR
- O5 (ขวาง S6): การเก็บผล ค่าแนะนำ: คำนวณตอนอ่าน บวกรายงานที่ตรึงแบบไม่บังคับ (S6) ไม่มี materializer ใน trading worker งานปิดวันแบบ materialized ใด ๆ ต้องเป็นโปรเซสแยกหลังผ่าน QD-1/QS-1
- O6 (ขวาง S2): ตลาดที่ไม่รองรับ ค่าแนะนำ: โบรกเกอร์ THB และสัญลักษณ์ที่ไม่ใช่ BTCUSDT แสดงเป็นไม่มีราคา (`UNSUPPORTED_MARKET`) ไม่ซ่อน การขยายแหล่งข้อมูลเป็นการตัดสินใจของ QD-1
- O7 (ขวาง S1): บัญชีรุ่นเก่า (legacy) ค่าแนะนำ: ใช้กฎ `legacy-two-seed-v1` ทางเลือก: ถือว่าทั้งบัญชีใช้ไม่ได้
- O8 (ขวาง S3): ด่าน Legacy Quant บนเส้นทาง QR-2 ค่าแนะนำ: ไม่ใช้ ทางเลือก: ใช้เพื่อความสอดคล้องกับ analytics
- O9 (ขวาง S1): นิยามช่วงเวลา ค่าแนะนำ: จุดสิ้นสุดแบบ exclusive ที่ 00:00Z สัปดาห์ ISO เริ่มวันจันทร์ ติดป้ายแยกจาก rolling 7 วันของ analytics
- O10 (ขวาง S7): guard แบบ append-only บนตาราง input ของ ledger ค่าแนะนำ: ยังไม่ทำตอนนี้ แยกเป็นสไลซ์ S7 พร้อมการตรวจและ GO ของตัวเอง
- O11 (ขวาง S1): ทุกการเปลี่ยนแปลงชนิด `CONFIGURATION` นับเป็นเงินฝากหรือถอนจากภายนอกสำหรับการคำนวณผลตอบแทน ค่าแนะนำ: ยืนยัน
- O12 (ขวาง S4, S6): นโยบายเก็บและ rollback ของ declaration และรายงานที่ตรึง ค่าแนะนำ: เก็บไว้ rollback ปฏิเสธถ้ายังมีแถว เว้นแต่ export และยืนยันจำนวนแล้ว
- O13 (ไม่ขวางสไลซ์ใด): ประมาณการ net-liquidation ค่าแนะนำ: ตัดออกจากรายงานจริง เวอร์ชันภายหลังทำได้เฉพาะเป็นการจำลอง liquidation ที่ติดป้ายแยก
- O14 (ขวาง S2): การระบุเวอร์ชัน strategy ค่าแนะนำ: รายงานรายบอท บวกแท็ก deployment ต่อ fill ไม่มีผลตอบแทนรายกลยุทธ์ก่อน APP-3B
- O15 (ขวาง S1): กฎความพร้อมของราคา (B5) ค่าแนะนำ: Option M ใช้เวลาตลาดเป็น as-of พร้อมธงข้อมูลว่าดึงมาเมื่อใด
- O16 (ขวาง S1): ผลของการละเมิด ledger invariant (N1/N2, ผลของ F4) ค่าแนะนำ: บัญชีเป็น `LEDGER_INVARIANT_VIOLATED` ผลตอบแทนเป็น null สำหรับช่วงที่ตัดกับช่วงที่ละเมิด NAV และข้อเท็จจริงยังแสดงพร้อมป้าย และบันทึก finding ลง audit
- ผลถ้าปฏิเสธ: แหล่งไม่ระบุ ยกเว้นทางเลือกที่ระบุไว้ในข้อ O7 และ O8

### กลุ่ม G: การแก้ความถูกต้องของ Paper ledger (F4, O3, G1, worker หยุดค้าง)

สถานะ: การแก้ O3 (สไลซ์ S2 เฉพาะส่วน O3 ไม่รวม G1) และการแก้ W1 (สไลซ์ S1) เขียนโค้ดแล้วและผ่านการตรวจอิสระในเครื่องเมื่อ 2026-10-14 commit และ push ไปที่ branch codex/app3a-market-wait-checkpoint แล้ว (ไม่ใช่ main) แต่ยังไม่ deploy (บันทึก: followUp FX-O3W1 ใน `docs/evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json`) ระหว่างรอคำตอบ โค้ดใช้ค่าแนะนำของ D7 ถึง D11 ไปก่อนแบบชั่วคราว และมีข้อตัดสินใจใหม่ D13 กับ D14 ส่วน F4 (fence) ยังเป็นแค่การออกแบบ ยังไม่มีโค้ด ส่วน G1 มีโค้ดแก้ในเครื่องแล้ว ผ่านการตรวจอิสระแบบมีข้อให้แก้ กำลังอยู่ในรอบแก้ ยังไม่ commit และยังไม่ push เอกสารออกแบบ (FD1-r2) เป็นเอกสารส่วนตัว ที่มา: ส่วนที่ 11 "Owner decisions (merged)" D1 ถึง D12 และรายการสไลซ์ของเอกสารออกแบบ ส่วน D13 และ D14 มาจากรอบตรวจของการแก้ W1 ทุกข้อเป็นการตัดสินใจของเจ้าของ เอกสารนี้ไม่ใช่ GO

สรุปข้อบกพร่องแบบภาษาง่าย (เฉพาะ Spot/Paper ไม่เกี่ยวกับเส้นทาง Live ยืนยันแล้วในเครื่อง ยังไม่ได้แก้บน staging หรือ production): (1) F4: การถอนหรือเติมเงินทุนอ่านเงินสด Paper จาก snapshot เก่าของ request ถ้ามี fill commit ระหว่างรอ การถอนอาจทำให้เงินสดติดลบ และเงินทุนเริ่มต้นตอนสั่ง run อาจคลาดเคลื่อน (หลักฐาน `docs/evidence/PAPER_FUNDING_RACE_F4_LOCAL_2026-10-13.json`) (2) O3: ตอนออกจากสถานะ ต้นทุนที่ตัดออกอาจต้องใช้ทศนิยมเกิน 18 หลัก ระบบจึง throw error สัญญาณขาออกค้างสถานะ QUEUED โดยไม่มีข้อความหรือการแจ้งเตือน และเพราะ worker ทำงานเรียงตามเจ้าของที่เก่าที่สุด สัญญาณของเจ้าของคนอื่นจึงค้างด้วย ผลกระทบหลักอยู่ที่การกำหนดขนาดแบบ legacy webhook ส่วนเส้นทาง Pine Bridge ไม่พบความล้มเหลวในการตรวจเชิงคำนวณ (หลักฐาน `docs/evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json`) (3) G1: ยืนยันจากการอ่านโค้ดเท่านั้น การขาย FIFO ที่ใหญ่กว่า lot ที่มีบนสถานะที่มีปริมาณไม่อยู่ใน lot ทำให้กำไรที่รับรู้สูงเกินจริงและเหลือต้นทุนค้างที่ปริมาณศูนย์ โดยไม่มี error (4) W1: exception แบบกำหนดแน่นอนเพียงตัวเดียวใน worker หยุด Paper execution ของทุกเจ้าของ โดยไม่บันทึกเหตุผล การออกแบบเสนอ release เดียวที่แบ่งเป็นสไลซ์ S1 ถึง S8 ตรวจรับแยกกัน แล้ว deploy ไป staging พร้อมกันในหน้าต่างบำรุงรักษาเดียว

การตรวจ VPS แบบอ่านอย่างเดียวที่เจ้าของอนุมัติเมื่อ 2026-10-13 รายงานผลแล้ว (followUp RO1 ในหลักฐานของ O3 และ F4): ยังไม่พบความเสียหายทั้งบน production และ staging ไม่มีสัญญาณค้าง QUEUED heartbeat ของ worker สดใหม่ และไม่มีเงินสด Paper ติดลบ แต่ production มี lot เปิดอยู่ 352 lot ของเจ้าของ 4 คน ซึ่งการออกจะชนความล้มเหลวเรื่องทศนิยมตามโค้ดที่วิเคราะห์ (ยังไม่ได้เทียบกับโค้ดที่ deploy จริง) ส่วน staging ไม่มี ข้อ D6 จึงเหลือนโยบายซ่อมถ้าพบแถวที่ได้รับผล และ query ของ G1 (Q6, Q7) ที่ยังไม่ได้รัน

- D1: อนุมัติ release หรือไม่ (fence A สำหรับ F4, L-fix สำหรับ O3 และ G1, และ W1) ค่าแนะนำ: อนุมัติทั้งสี่เป็นสไลซ์แยกกันใน staging deployment เดียว ทางเลือก: แหล่งไม่ระบุ
- D2: การจัดแพ็กเกจ fence ค่าแนะนำ: ขั้น ensure ภายใน `migrate()` ของแกนหลัก ไม่เพิ่มเลขเวอร์ชัน (ใหม่ใน r2) ทางเลือก: installer แยกแบบ classify-first ตาม r1
- D3: ขอบเขต fence ใน `recordFunding` ค่าแนะนำ: ทุกการเรียก ทางเลือก: เฉพาะตอนมีการเปลี่ยนแปลงทุน
- D4: ลำดับเทียบกับ CR1 (b) ค่าแนะนำ: release นี้ก่อน แล้ว (b) ตามมา ต้องยอมรับ 409 ตอนเติมเงิน, PF-4 apply และ SETUP run ที่ชนกับ fill จนกว่า (b) จะเสร็จ ทางเลือก: ทำพร้อมกัน
- D5: เติมแถว fence หนึ่งแถวต่อผู้ใช้ที่มีอยู่ตอน ensure หรือไม่ ค่าแนะนำ: ไม่เติม ทางเลือก: เติม (ลด noise ของ SSI ตอน insert ครั้งแรกสำหรับ Bot ที่มีอยู่)
- D6: อนุญาตการรันแบบอ่านอย่างเดียว Q1 ถึง Q7 บน staging และอ่าน log ของ worker ผ่าน operations worker (เจ้าของอนุมัติการตรวจแล้วเมื่อ 2026-10-13 ผลบันทึกแยก) และนโยบายซ่อมถ้าพบแถว ค่าแนะนำ: ไม่แก้ด้วย SQL ทำเครื่องหมาย run ที่ได้รับผลว่า tainted แล้วเติมเงินใหม่หรือส่งสัญญาณใหม่ผ่านเส้นทางปกติ ทางเลือก: แหล่งไม่ระบุ
- D7: ขอบเขตการ retry ของ W1 ค่าแนะนำ: 3 ครั้ง หน่วง 1 วินาทีและ 5 วินาที ทางเลือก: ขอบเขตอื่น
- D8: สถานะสุดท้ายของ W1 ค่าแนะนำ: REJECTED พร้อม `EXECUTION_FAULT: <class>` และตัวนับในหน่วยความจำ ไม่แก้ schema ทางเลือก: สถานะใหม่และตัวนับความพยายามที่เก็บถาวร (แก้ schema)
- D9: รูปแบบการแก้ O3 ค่าแนะนำ: ปัดเศษครั้งเดียวต่อการออก และตัดส่วนที่เหลือทั้งหมดเมื่อปิดเต็ม ไม่แก้ schema ทางเลือก: เก็บต้นทุนคงเหลือรายละ lot (ต้อง migration และ backfill)
- D10: เมื่อต้นทุนที่ออกมากกว่าต้นทุนของสถานะ ค่าแนะนำ: ตัดให้เหลือ 0 ใช้ยอดที่ใช้จริงคำนวณกำไร และเขียน audit `ledger.cost_clamped` ทางเลือก: throw (การออกจะกลายเป็น REJECTED ภายใต้ W1)
- D11: ลำดับการใช้ lot ใน G1 ค่าแนะนำ: lot ก่อน แล้วปริมาณที่ไม่อยู่ใน lot ที่ต้นทุนเฉลี่ย (ตรงกับพฤติกรรมปัจจุบันและ QR-2 replay) ทางเลือก: ปริมาณที่ไม่อยู่ใน lot ก่อน (FIFO แท้)
- D12: ใช้ database trigger บังคับ fence ตอน insert ของ Paper หรือไม่ (ตัวเลือก O6 ของ r1) ค่าแนะนำ: ไม่ใช้ ทางเลือก: แหล่งไม่ระบุ
- D13 (ใหม่ จากรอบตรวจ W1): เมื่อ fault แบบเดียวกัน (class และ SQLSTATE เดียวกัน) เกิดกับเจ้าของตั้งแต่ 2 คนขึ้นไปภายใน 60 วินาที ค่าแนะนำ: พักสัญญาณเหล่านั้นไว้ที่ QUEUED โดยไม่มีเวลาสิ้นสุด ไม่ reject ระหว่างพัก และเขียน audit `worker.systemic_suspected` หนึ่งแถวต่อเจ้าของที่อยู่ในหลักฐานตอนที่ key เริ่มถูกพัก โดยระบุเฉพาะสัญญาณของเจ้าของคนนั้น เจ้าของที่มาเจอ fault เดียวกันหลังจาก key ถูกพักแล้วจะไม่ได้แถว audit ของตัวเอง สัญญาณที่ถูกพักนานกว่าอายุสูงสุดของสัญญาณ (ค่าเริ่มต้น 60 วินาที) จะถูก reject ว่า stale เมื่อเลิกพัก และ fault ที่เกิดกับเจ้าของคนเดียวจะไม่เริ่มการพัก สัญญาณของเจ้าของคนนั้นจึงถูก reject ทีละรายการ (ใช้ชั่วคราวใน local candidate) ทางเลือก: กำหนดเวลาพักสูงสุด เช่น 10 นาที แล้ว reject ตามปกติ
- D14 (ใหม่ จากรอบตรวจ W1): fault ที่ไม่นับรวมในขอบเขตการ retry ค่าแนะนำ: SQLSTATE class 42, 28, 3D, 3F, 0A, 25 และ XX ถือเป็นปัญหาของโค้ด schema สิทธิ์ หรือเซิร์ฟเวอร์ ไม่นับ และให้เจ้าของรอ 5 วินาที ส่วน fault ชั่วคราว (class 08, 40, 53, 55, 57, 58 และ error เครือข่าย) ไม่นับ และให้รอ 1 วินาที (ใช้ชั่วคราวใน local candidate) ทางเลือก: นับ fault ของสภาพแวดล้อมเหมือน fault ทั่วไป (สัญญาณจะถูก reject หลัง 3 ครั้ง)
- ผลถ้าปฏิเสธ: แหล่งไม่ระบุ ยกเว้นทางเลือกที่ระบุไว้ในแต่ละข้อ

---

## English table

Nothing here is decided or approved. Defaults are recommendations only. "Not stated" means the source does not say.

### A. EM2 measurement (amendment GO)

Asked: review the draft amendment (DRAFT, NOT A GO, owner has not reviewed it) and decide whether to grant the amendment GO. Detail: [EM2 readiness, section 7](EM2_MEASUREMENT_READINESS_2026-10-13.md) and [amendment draft record](evidence/R7B_EM2_AMENDMENT_DRAFT_2026-10-13.json). The source does not label which question is owner-facing; it says root decides Q9 and Q14. The source's Thai summary highlights Q1, Q2, Q4, Q6, Q7, Q16, Q17. Open gates G1-G11 are in section 3 of the readiness doc.

| Q | Decision | Recommended default (recommendation only) | If declined |
| --- | --- | --- | --- |
| Q1 | Who approves the allowlist | Root writes, independent review, owner approves via the amendment GO naming the allowlist sha256 | Root-only acceptance conflicts with Addendum 1 H2 item 1 |
| Q2 | GO and amendment ids | Code ids `R7-CRASHED-BASELINE-AMENDMENT-V5` and `R7B-MEASURE-V2` | Keeping V4/V1 needs a code change, new code sha, re-acceptance, and reuses spent ids |
| Q3 | Id for the xs GO | New id bound to window EM-2 | Reusing V1 id could read as an EM-1 approval |
| Q4 | Read steps named in the amendment | Full EM-1 list; owner confirms m2a and m2b are read steps | Shorter list does not match the code without a code change |
| Q5 | Authority for pre-m0 health check and collision reads | Root-authority read packets outside the allowlist | Not stated |
| Q6 | Failed research unit at worker stop | Accept as disclosed residual; separate owner recovery GO if it happens | Fix changes code sha, needs re-acceptance |
| Q7 | Finding AU1-F1 | Accept; operating rule: effects null means UNKNOWN, never zero | Fix changes code sha, needs re-acceptance |
| Q8 | Release-namespace install (AU1-F2) | Keep name; archive current bytes, install EM2 files, delete nothing | Rename is a code change, new sha, re-acceptance |
| Q9 | GO sentence templates and generator (root decides) | Port EM-1 generator into a new reviewed folder outside code files and PLAN.md | A PLAN.md edit can void issued dispatch certificates |
| Q10 | Anchor for jobs since release r6 finish | Keep the anchor; m0 decides | Moving it is a code change, new design review |
| Q11 | EM-1 hB and denylist | Keep EM2 denylist empty; record that new hB differs from EM-1 hB | Non-empty denylist refuses every non-close job; allowing it is a redesign |
| Q12 | Enroll-layer absence check before first m1 effect | Add a pre-m1 read for `.pending` forms and later-sorting `.conf` names | Accepting the risk means one PB effect, then xm |
| Q13 | Harness proof on the VPS before the amendment GO | Reviewed isolated VPS harness run for items EM2 touches; EM-1 results only with explicit applicability record; not "proceed without" | Not stated |
| Q14 | Real adapter and mainCLI unlock (root decides) | Root reviews and accepts unlock, then installs, then writes the allowlist | Allowlist on locked bytes needs a void copy, new instance, new owner GO |
| Q15 | marked.jobStatus and marked.opStatus values | Keep EM-1 values; disclose no-MR outcome of the ADRS-unclaimed path in the measure GO | Not stated |
| Q16 | What the owner receives for G1 | Reviewed full amendment text plus one GO sentence, with a Thai summary | Not stated |
| Q17 | Usage and time budget | Root reads usage before each wave; run only above the 30% band; no new step at or below 15% | Not stated |
| Q18 | KB shape rule | Generate KB under the stricter renderer rule; record code inconsistency as residual | Tightening `validatePins` is a code change, new sha, re-acceptance |
| Q19 | ADRS-unclaimed close result vs Addendum 12 | Cheap local tester check, then treat D12-2 as binding if confirmed (the draft record states the ADRS-unclaimed path ends without an MR, so that epoch cannot pass JF acceptance A6) | Not stated |

### B. QR-1b result freeze

Source: [QR1B freeze record](evidence/QR1B_FREEZE_LOCAL_2026-10-13.json). Local candidate accepted; committed and pushed to branch codex/app3a-market-wait-checkpoint (not main), not deployed, no staging migration.

| ID | Decision | Recommended default (recommendation only) | If declined |
| --- | --- | --- | --- |
| D1 | Approve design A; refuse every DELETE, or only terminal rows | Refuse every DELETE (candidate default) | Not stated |
| D2 | Add REVOKE DELETE and TRUNCATE checks in a later grants window | Not stated | Not stated |
| D3 | Live negative write probe on staging, or restore rehearsal only | Not stated | Not stated |
| D4 | Append-only seal table required before QR-2 | Not stated | Not stated |

Staging gates, none closed: physical-restore rehearsal including rollback; per-effect owner GO, one operations worker, known host health and job plan, no overlap with R7B/EM2; backup and cold archive with writers stopped under the maintenance lock; staging catalog read of TEMP privilege and parameter ACLs. Finding QR1B-MODE-GUARDS (medium, defense in depth) needs its own packet.

### C. Database guard hardening (GH1/GH2)

Sources: [GH2 record](evidence/DB_GUARD_HARDENING_GH2_LOCAL_2026-10-13.json), [GH1 record](evidence/QR_GUARD_HARDENING_LOCAL_2026-10-13.json). Local candidates accepted; committed and pushed to branch codex/app3a-market-wait-checkpoint (not main), not deployed, no staging apply. Staging apply needs its own GO through the operations worker, and staging must first be confirmed to hold the original definitions.

| ID | Decision | Recommended default (recommendation only) | If declined |
| --- | --- | --- | --- |
| C1 | Approve option (b) hardening for a staging candidate (GH2 design records option (b) as recommended) | Option (b) | Not stated |
| C2 | Revoke TEMP from PUBLIC on the application database (closes the shadowing class; needs service restarts and readiness check; grant change needs a staging window; the tool runs only as a database owner that is a superuser or holds pg_read_all_stats, and granting that role is a further grant change, RT2; see also E1 and E2 below) | Not stated | Not stated |
| C3 | Apply GH1, GH2, bot-parent hardening and the QR-1b freeze in one offline window, each with its own migration and rollback | Not stated | Not stated |
| C4 | Later: chain hardening into fresh installs and make the hardened state mandatory | Not stated | Not stated |

Note: a rollback silently reopens the shadow bypass (GH2-ROLLBACK-SILENT, info). The protection is defense in depth against SQL run as the runtime role.

### D. Commit and publication

Answered 2026-10-14: the owner authorized each commit and push for CI, so the work through 4d86822 is committed and pushed to branch `codex/app3a-market-wait-checkpoint` (not main). Still local and not committed: the G1 and CR1B fix rounds and the W1 hardening round. Any further commit or push needs owner authorization each time. The readiness doc ([section 5](EM2_MEASUREMENT_READINESS_2026-10-13.md)) does not authorize any commit, push or publication.

### E. Staging window for the database guards (OPS1 draft r6)

The OPS1 r6 draft is a private local document. It is not a GO and grants nothing. The staging window itself needs its own per-effect owner GO, run through the single operations worker. These are the draft's open questions, numbered E1-E11 here with the draft's own question number. "Not stated" means the draft does not say.

| ID | Draft Q | Decides | Decision | Recommended default (recommendation only) | If declined |
| --- | --- | --- | --- | --- | --- |
| E1 | Q2 | Owner (C2); root for the rest | Decide C2 itself (see C2 above; same question). The draft adds root-level items: whether to wire the revoke into `scripts/grant-postgres-runtime.sql` and a startup readiness check later (C4), since nothing imports the module today; and which database-owner connection runs `--revoke` and `--restore` if the schema owner is not the database owner | Not stated | Not stated |
| E2 | Q10 | Owner | The E5 operator must be the database owner and see every session. Choose (a) a database owner that is already a superuser; (b) grant `pg_read_all_stats` (INHERIT) to the non-superuser owner, which is a grant change needing the same per-effect GO, and decide whether to revoke it after the window; or (c) do not run E5. The unsafe override is not an option. The draft does not choose | Not stated | Not stated |
| E3 | Q11 | Owner | Name any login role that must keep TEMP (`--allow-temp-role`) | Default none | Not stated |
| E4 | Q3 | Owner | Switch the staging API to the release in this window (W10) or later; the Library under-claims until then | Not stated | Not stated |
| E5 | Q4 | Owner (D1) | Keep "refuse every DELETE" (accepted bytes) or request a terminal-only variant (new candidate). Same question as D1 above | Not stated | Not stated |
| E6 | Q5 | Owner (D3) | Live negative probe on staging, or rehearsal only. Same question as D3 above | Not stated | Not stated |
| E7 | Q6 | Root | On a mid-window stop, abort the whole window or keep completed independent steps | Abort the whole window (draft default) | Not stated |
| E8 | Q7 | Owner | Observation length: +10 min only, or also +24 h | Not stated | Not stated |
| E9 | Q8 | Root | Which sanitized fields of the `--inspect` JSON go into tracked evidence (the full JSON names roles and the database) | Not stated | Not stated |
| E10 | Q1 (remaining part) | Root | Reads that no guard CLI covers (inheritance, owner/ACL/cost, OIDs and definitions, triggers, versions, digests, parameter-ACL and CREATE reads, and similar) still need reviewed `psql` reads or a further reviewed read-only tool. The part the CLIs cover is answered | Not stated | Not stated |
| E11 | Q12 | Owner | Take a second logical backup after W8 so that a later logical restore carries the hardened and frozen state, or rely on the physical copy only. Note: the W2 archive holds the pre-window state, so restoring it would not bring back the hardening or the freeze | Not stated | Not stated |

Fact for the owner, not a new question (draft section 7.1; public rehearsal record `docs/evidence/DB_GUARD_WINDOW_LOCAL_REHEARSAL_2026-10-13.json`, followUps LR3): a logical restore is safe only as a full restore into an empty database. A data-only restore, or a restore with triggers disabled, is not allowed on a frozen database.

Draft Q9 is closed in the draft and is not listed. Draft risks K8 and K22 also touch E2 and C2; the draft states them as risks, not as decisions.

### F. QR-2 Paper Portfolio Performance design

Status: local design only. No code has been written. The design document is private. Source: design section 12, "Owner decisions (merged)", O1-O16. All are owner decisions here; the design lists three root-level items that are not owner decisions (the audit dedup key, the after-commit hook in `request-dispatch.js`, and whether to dispatch the read-only staging count). This is not a GO.

Blocks the first code slice S1 (the design requires these recorded before S1): O1, O3, O4, O7, O9, O11, O15, O16. O2 blocks S4 and S5 (not S1-S3). "Not stated" means the design does not say; the design gives a default for every item, and an "If declined" alternative only where noted.

| ID | Decides | Decision | Recommended default (recommendation only) | Blocks | Alternative / if declined |
| --- | --- | --- | --- | --- | --- |
| O1 | Owner | Price age thresholds | `fresh_ms` 180 s, `carry_ms` 900 s; stale prices still give values and returns, flagged with age | S1 | Not stated |
| O2 | Owner | Shared-capital model and existing totals | v1 declaration (`INDEPENDENT_ACCOUNTS` / `SHARED_HYPOTHETICAL`), no total until declared; relabel the Overview tile and fix `bots.js:129` now; pool with sleeves only later as S4b | S4, S5 | Pool with sleeves (S4b) is the later option |
| O3 | Owner | Unbacked configured equity | Exclude from NAV, show on its own line; sizing unchanged | S1 | Not stated |
| O4 | Owner | Return methods | TWR primary, Modified Dietz secondary with its own label, money PnL always, no IRR | S1 | Not stated |
| O5 | Owner | Persistence | Derive on read plus optional frozen reports (S6); no materializer in the trading worker; any materialized day-close job is a separate process after QD-1/QS-1 admission | S6 | Not stated |
| O6 | Owner | Unsupported markets | THB brokers and non-BTCUSDT symbols shown unpriced (`UNSUPPORTED_MARKET`), not hidden; widening sources is a QD-1 decision | S2 | Not stated |
| O7 | Owner | Legacy accounts | Rule `legacy-two-seed-v1` | S1 | Whole account unavailable |
| O8 | Owner | Legacy Quant gate on QR-2 routes | Do not apply | S3 | Apply it, for consistency with analytics |
| O9 | Owner | Period definitions | Exclusive end at 00:00Z; ISO week from Monday, labelled distinctly from analytics' rolling 7 days | S1 | Not stated |
| O10 | Owner | Append-only guards on ledger input tables | Not now; separate slice S7 with its own audit and GO | S7 | Not stated |
| O11 | Owner | Treat every `CONFIGURATION` delta as an external deposit or withdrawal for returns | Confirm | S1 | Not stated |
| O12 | Owner | Retention and rollback policy for declarations and frozen reports | Keep; rollback refuses with rows unless exported and count-confirmed | S4, S6 | Not stated |
| O13 | Owner | Net-liquidation estimate | Drop from the actual report; any later version only as a separately labelled simulated liquidation | None | Not stated |
| O14 | Owner | Strategy-version attribution | Per-Bot reports plus a per-fill deployment tag; no per-strategy returns before APP-3B | S2 | Not stated |
| O15 | Owner | Price availability rule (B5) | Option M: market-time as-of with an informational retrieval flag | S1 | Not stated |
| O16 | Owner | Effect of a ledger-invariant violation (N1/N2, F4 effect) | Account `LEDGER_INVARIANT_VIOLATED`; null returns for periods that intersect the violation span; NAV and facts visible and labelled; findings audited | S1 | Not stated |

### G. Paper ledger correctness fixes (F4, O3, G1, worker stall)

Status: the O3 fix (slice S2, O3 part only, without G1) and the W1 fix (slice S1) are written and were independently verified on this machine on 2026-10-14. They are committed and pushed to branch codex/app3a-market-wait-checkpoint (not main) but not deployed (record: followUp FX-O3W1 in `docs/evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json`). Until the owner answers, they use the recommended defaults of D7-D11 provisionally, and they add two new decisions, D13 and D14. F4 (the fence) is still design only, with no code. A G1 fix exists locally, passed independent review with requested changes, is in a fix round and is not committed or pushed. The design document (FD1-r2) is private. Source: design section 11, "Owner decisions (merged)", D1-D12, plus its slice list; D13 and D14 come from the W1 review rounds. All are owner decisions here. This is not a GO.

Plain-language summary of the defects (Spot/Paper only; no Live path; confirmed locally; not fixed on staging or production): (1) F4: a funding change or run reads Paper cash from a stale request snapshot. If a fill commits while the request waits, a withdrawal can drive cash negative and a bot start can record a wrong initial capital (evidence: `docs/evidence/PAPER_FUNDING_RACE_F4_LOCAL_2026-10-13.json`). (2) O3: on an exit, the removed cost can need more than 18 decimal places, so the ledger throws. The exit signal stays QUEUED with no message or notification, and because the serial worker picks the oldest owner first, other owners' signals stay QUEUED too. Legacy webhook sizing is the main exposure; the Pine Bridge path showed no failure in arithmetic checks (evidence: `docs/evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json`). (3) G1: confirmed by reading code only. A FIFO exit larger than the available lots on a position with unlotted quantity overstates realized profit and leaves cost at zero quantity, with no error. (4) W1: one deterministic exception in the execution tick stops Paper execution for every owner and records no reason. The design proposes one release made of separately accepted slices S1-S8, deployed to staging together in one maintenance window.

The read-only VPS check approved by the owner on 2026-10-13 has reported (followUp RO1 in the O3 and F4 evidence): no damage yet on production or staging (no QUEUED signals, fresh worker heartbeats, no negative Paper cash), but production holds 352 open lots for 4 owners whose exit would hit the decimal-scale failure under the analysed code (the deployed code was not compared); staging holds none. D6 below therefore covers the repair policy if affected rows are found, and the G1 queries (Q6, Q7), which were not run.

"Not stated" means the design does not say; the design gives a default for every item.

| ID | Decides | Decision | Recommended default (recommendation only) | Slice | Alternative / if declined |
| --- | --- | --- | --- | --- | --- |
| D1 | Owner | Approve the release: fence A for F4, the L-fix for O3 and G1, and W1 | Approve all four as separate slices in one staging deployment | S1-S4 | Not stated |
| D2 | Owner | Fence packaging | Ensure step inside core `migrate()` with no version bump (new in r2) | S3 | r1's separate classify-first installer |
| D3 | Owner | Fence scope in `recordFunding` | Every call | S4 | Only when a capital delta exists |
| D4 | Owner | Order relative to CR1 (b); accept 409 on funding, PF-4 apply and SETUP run when they race a fill until (b) lands | Release first, (b) next | S6 | Together |
| D5 | Owner | Backfill one fence row per existing user at ensure time | No | S3 | Yes (removes first-insert SSI noise for existing Bots) |
| D6 | Owner | Authorize the read-only Q1-Q7 run and worker log read through the operations worker (owner approved the check on 2026-10-13; result recorded separately); repair policy if rows are found | No SQL repair; mark affected runs tainted; re-fund or re-send through normal routes | S5b, S7 | Not stated |
| D7 | Owner | W1 retry bound | 3 attempts with 1 s and 5 s backoff | S1 | Another bound |
| D8 | Owner | W1 terminal status | REJECTED with `EXECUTION_FAULT: <class>` and in-memory counters, no schema change | S1 | New status and a persisted attempt counter (schema change) |
| D9 | Owner | O3 fix form | Round once per exit and remove the whole remainder on full close, no schema change | S2 | Store remaining cost per lot (migration and backfill) |
| D10 | Owner | Divergence when exit cost exceeds position cost | Clamp to 0, use the applied amount for profit, write `ledger.cost_clamped` audit | S2 | Throw (the exit then becomes REJECTED under W1) |
| D11 | Owner | G1 consumption order | Lots first, then unlotted quantity at its average cost (matches today and the QR-2 replay) | S2 | Unlotted quantity first (true FIFO) |
| D12 | Owner | Optional database trigger enforcing the fence on Paper inserts (r1 O6) | No | S3, S4 | Not stated |
| D13 | Owner | W1 shared-fault hold: the same fault class and SQLSTATE on 2 or more owners within 60 s (new, from the W1 reviews) | Hold those signals QUEUED with no time cap, never reject them while held, and write one `worker.systemic_suspected` audit row per owner in the evidence when the key enters the hold, naming only that owner's signal; an owner that joins an already held key gets no row of its own; a held signal older than the maximum signal age (60 s by default) is rejected as stale once the hold ends, and a fault that hits only one owner never starts the hold, so that owner's signals are rejected one at a time (used provisionally in the local candidate) | S1 | Cap the hold (for example 10 minutes), then reject as usual |
| D14 | Owner | W1 faults that never count toward the retry bound (new, from the W1 reviews) | SQLSTATE classes 42, 28, 3D, 3F, 0A, 25 and XX (code, schema, privilege or server faults): the owner waits 5 s; transient classes 08, 40, 53, 55, 57, 58 and network errors: the owner waits 1 s (used provisionally in the local candidate) | S1 | Count environment faults like other faults (the signal is rejected after 3 attempts) |

The Slice column is read from the design's slice table (S1 W1 worker isolation; S2 L-fix for O3 and G1; S3 fence packaging; S4 fence call sites; S5b detection script; S6 CR1 (b); S7 host steps). The design does not map each decision to a slice, so this column is an inference. The design states only that all slices depend on S0, the owner decisions.

### Source ambiguities

- Q-by-Q owner versus root labels are not in the sources, except Q9 and Q14 (root).
- C1 recommendation comes from the GH2 design note inside the evidence record; the ownerDecisions line itself gives no default.
- The Thai summary in the readiness doc cites V5 ids for Q2; gate G1 uses the Addendum 1 V4 wording.
- Group G: the design does not map D1-D12 to slices, so the Slice column is inferred. G1 has no public evidence file; its description comes from the private design only. W1 and its local fix are recorded in the O3 evidence (followUp FX-O3W1). The read-only VPS check found no damage yet (followUp RO1).
