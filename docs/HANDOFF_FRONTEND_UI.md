# Handoff Report: Frontend UI & Quant Lab Implementation

รายงานส่งมอบงาน UI ทั้งหมด (Trading Control Panel, Risk Guard, Interactive Charting และ Quant Lab Studio) สำหรับระบบ **Robot Trade VPS v2.1**

---

## 1. ภาพรวมการส่งมอบงาน (Executive Summary)

งาน UI ทั้งหมดถูกพัฒนาตามข้อกำหนดใน `docs/HANDOFF_TRADING_CONTROL_UI.md`, ภาพสเก็ตช์ต้นแบบ (Reference Dashboard Image), และความต้องการเพิ่มเติมของระบบ Quant Lab Studio โดยครอบคลุม 3 ส่วนหลัก:

1. **Trading Control Panel & Bot Lifecycle (Bot Manager v2):**
   - แผงควบคุมสถานะบอท 4 ปุ่ม (`RUN`, `PAUSE`, `STOP`, `RESET`) ตาม State Machine ของ Backend (Schema 14)
   - การ์ดแสดงผลบัญชีคู่ขนาดใหญ่ (**EQUITY Card** และ **BALANCE Card**) พร้อมระบบตรวจจับและไฮไลต์ตัวเลขเมื่อมีการเปลี่ยนแปลงจริง (`.value-flash`)
   - Bounded Polling ทุก 4 วินาที (เฉพาะเมื่อบอททำงาน และหยุดทันทีเมื่อสลับหน้า/ซ่อนแท็บด้วย Page Visibility API)
   - โมดอลยืนยันก่อนกดยุติหรือรีเซ็ต (`<dialog id="lifecycleConfirmDialog">`) แสดงข้อความเตือนความเสี่ยงชัดเจน
   - ระบบ **Policy Lock & Draft Gating** ในหน้า Risk Manager ล็อกฟอร์มเมื่อบอททำงาน และบล็อกปุ่ม RUN หากมีการแก้ไขฟอร์มค้างไว้ที่ยังไม่ได้บันทึก

2. **Interactive Dashboard Charting (Lightweight Charts v4+):**
   - รักษาความสมบูรณ์ 100% ของระบบชาร์ตในหน้า Analytics (`public/interactive-chart.js`)
   - ดึง OHLCV 1h ตรงจาก Binance Public API แสดงผลร่วมกับ Dual EMAs, ATR Bands, Volume Histogram และ Entry/SL/TP Levels จาก `/api/positions`

3. **Quant Lab Studio UI:**
   - เพิ่มเมนูและแท็บ Quant Lab บน Sidebar
   - อินเทอร์เฟซ 4 แท็บในตัว:
     1. **Backtest Panel:** คำนวณผลตอบแทนจาก Synthetic OHLCV พร้อมวาดกราฟเส้น Equity Curve (SVG) แบบ Real-time
     2. **Optimizer Panel:** รัน Search Grid & Constraints พร้อมคัดกรอง Overfitting ผ่าน Sensitivity & Stress Test
     3. **Risk Preview Panel:** จำลอง Position Sizing และเช็คเพดานความเสี่ยงก่อนส่งคำสั่ง
     4. **Pine Export Panel:** ดึงโครงสร้างชุดพารามิเตอร์และตัวแปร Strategy เป็นไฟล์ชุด Bundle 6 ไฟล์
   - พัฒนา **Python Quant Bridge** (`src/quant_bridge.py`) รันแบบ Loopback (พอร์ต 7654) แยกสภาพแวดล้อมออกจาก Node.js
   - เชื่อมต่อ Reverse Proxy เส้นทาง `/api/quant/*` บน PostgreSQL Server

---

## 2. รายการไฟล์ที่มีการเปลี่ยนแปลงและสร้างขึ้นใหม่ (File Inventory)

| ไฟล์ | สถานะ | รายละเอียดการทำงาน |
|---|---|---|
| `public/styles-v2.css` | **แก้ไข (Rewrite)** | คลีนไฟล์แก้ปัญหา Encoding UTF-16 LE เดิม, คงสไตล์ Interactive Charting ครบถ้วน, เพิ่มสไตล์ Bot Card v2, 4-button TCP, Account Cards, Risk Summary, Animation, Modal Dialog และ Quant Lab Responsive Layouts |
| `public/i18n.js` | **แก้ไข** | เพิ่มพจนานุกรมคำแปล EN / TH สำหรับ Lifecycle states, ปุ่มควบคุม, ข้อความความพร้อม (Readiness), คำเตือน Modal Dialog และ Quant Lab |
| `public/index.html` | **แก้ไข** | เพิ่ม `<dialog id="lifecycleConfirmDialog">`, เมนู `Quant Lab` ใน Sidebar, Section HTML ของ Quant Lab 4 แท็บ และอัปเดตเวอร์ชัน Asset ทั้งหมดเป็น `?v=robot20` ป้องกัน Browser Cache |
| `public/bots.js` | **แก้ไข (Rewrite)** | ออกแบบการเรนเดอร์ Bot Card ใหม่ทั้งหมด, จัดการ State Machine ของปุ่มควบคุม, Bounded Polling, Modal Confirmation, Fallback Clipboard และเชื่อมต่อ `/api/bot/session/*` |
| `public/app.js` | **แก้ไข** | เพิ่มตัวตรวจจับสถานะฟอร์ม Risk Manager (`window._riskDirty`) และฟังก์ชัน `lockRiskForm(locked)` เพื่อ Freeze ค่าในฟอร์มเมื่อบอททำงาน |
| `public/quant-lab.js` | **สร้างใหม่** | จัดการ Event, Tab Switcher, ดึงข้อมูลจาก API `/api/quant/*`, เรนเดอร์การ์ดผลลัพธ์, คำนวณและวาดกราฟเส้น SVG Equity Curve |
| `src/quant_bridge.py` | **สร้างใหม่** | Python Microservice (HTTP บนพอร์ต 7654) เชื่อมต่อคลาสและ Contracts ของ `quant_lab/src/robot_quant/` (Backtest, Optimizer, Risk Preview, Exporter) |
| `src/postgres/server.js` | **แก้ไข** | เพิ่ม Reverse Proxy สำหรับ Request ที่ขึ้นต้นด้วย `/api/quant/*` ส่งต่อไปยัง Python Bridge พร้อมระบบตรวจสอบ Authentication Session |
| `package.json` | **แก้ไข** | เพิ่ม npm script `"quant:bridge": "cd quant_lab && uv run --no-sync python ../src/quant_bridge.py"` |

---

## 3. รายละเอียดเชิงเทคนิคและการทำงาน (Technical Architecture)

```
[ Browser Client ]
       │
       ├─── GET /api/bot/session  ────────► [ Node.js Postgres Server (:8080) ]
       ├─── POST /api/bot/session/:action ─► [ DB Transaction FOR UPDATE ]
       │                                            │
       └─── POST /api/quant/* ────────────► [ Proxy Route ]
                                                    │ (HTTP 127.0.0.1:7654)
                                                    ▼
                                            [ Python Quant Bridge ]
                                                    │
                                            [ quant_lab (Pure Python Engine) ]
```

### 3.1 Bot Lifecycle State Machine (`public/bots.js`)
- **SETUP:** ปลดล็อกปุ่ม `RUN` (เฉพาะเมื่อบันทึกการตั้งค่าแล้วและไม่มี Unsaved Edits), ปุ่มอื่นปิดใช้งาน
- **RUNNING:** ปลดล็อกปุ่ม `PAUSE` และ `STOP`, ปุ่มอื่นปิดใช้งาน
- **PAUSED:** ปลดล็อกปุ่ม `RUN` (Resume กลับมาทำงาน) และ `STOP`, ปุ่มอื่นปิดใช้งาน
- **STOPPED:** ปลดล็อกปุ่ม `RESET` เท่านั้น (เตือนว่าเป็นการ Archive Session เพื่อเริ่มรอบใหม่)

### 3.2 Dynamic Account Cards & Visual Flash
- แสดงข้อมูลแยกตามบัญชีและสกุลเงินชัดเจน (เช่น Binance Global USDT, Bitkub THB) โดยไม่มีการรวมยอดข้ามสกุลเงิน
- มีการจำค่าก่อนหน้าไว้ใน `accountSnapshots[botId]`: เมื่อมี Polling รอบใหม่และตัวเลขเปลี่ยนจริง จะเพิ่มคลาส `.value-flash` (350ms Transition) และเคารพการตั้งค่า `prefers-reduced-motion`

### 3.3 Risk Policy Lock & Gating
- มี Event Listener ดักจับ `input` / `change` ใน `#riskForm` เพื่อตั้งค่า `window._riskDirty = true`
- หาก `_riskDirty === true` ปุ่ม `RUN` บน TCP จะถูกปิดใช้งาน พร้อมแจ้งเหตุผลว่า *"Save settings first"*
- เมื่อบอทอยู่ในสถานะ `RUNNING` หรือ `PAUSED` ฟังก์ชัน `lockRiskForm(true)` จะปิดการแก้ไข Input ทั้งหมด พร้อมแสดงแถบเตือนสีเหลืองป้องกันการแก้ไขที่ Backend ปฏิเสธ (HTTP 409)

---

## 4. ขั้นตอนการทดสอบและตรวจรับงาน (Verification & Runbook)

### 4.1 สภาพแวดล้อมที่ต้องเตรียม (Prerequisites)
1. **PostgreSQL Database:**
   - ต้องมี Instance ของ PostgreSQL รันอยู่ (Local หรือ VPS)
   - ตั้งค่าในไฟล์ `.env` ที่ root ของโปรเจกต์:
     ```env
     DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<dbname>
     ```
2. **Python Environment:**
   - ใช้งานผ่าน `uv` ในไดเรกทอรี `quant_lab`

### 4.2 คำสั่งเริ่มต้นการทำงาน (Startup Commands)
เปิด 2 Terminal แยกกัน:

**Terminal 1 (Backend Web Server):**
```bash
npm run start:postgres
```

**Terminal 2 (Quant Lab Engine Bridge):**
```bash
npm run quant:bridge
```
*(หรือรันผ่าน `cd quant_lab && uv run python ../src/quant_bridge.py`)*

---

### 4.3 Checklist การตรวจสอบบนหน้า Browser (`http://127.0.0.1:8080`)

- [ ] **การแสดงผลและการตอบสนอง (Responsive & Layout):**
  - เปิดหน้า **Bot Manager**: ต้องเห็น Bot Card v2, State badge, Mode badge, บัตร Equity/Balance 2 คอลัมน์, และแถบปุ่ม TCP 4 ปุ่มเรียงตามลำดับ
  - ปรับขนาดหน้าจอเป็น Mobile: ปุ่ม TCP ต้องตัดเป็น Grid 2x2 สวยงาม ปุ่มไม่ล้นจอ (ขนาด $\ge 44\text{px}$)
- [ ] **การสลับภาษา (EN / TH):**
  - สลับ Dropdown ภาษาที่มุมขวาบน: ข้อความปุ่ม, ซับไตเติลของปุ่ม, สถานะ Readiness, และข้อความในไดอะล็อกต้องเปลี่ยนเป็นภาษาไทย/อังกฤษอย่างถูกต้อง
- [ ] **การทำงานของ State Machine & Confirmation Modal:**
  - กดปุ่ม **RUN**: สถานะต้องเปลี่ยนเป็น `RUNNING`, ปุ่ม PAUSE และ STOP ต้องเปิดใช้งาน, หน้า Risk Manager ต้องล็อกฟอร์ม
  - กดปุ่ม **STOP**: ต้องมี Dialog Modal เด้งขึ้นมาเตือนว่า *"ไม่ปิดสัญญาในตลาด (No auto-liquidation)"* และต้องกดยืนยันก่อนจึงจะหยุด
  - กดปุ่ม **RESET**: ต้องมี Dialog Modal เด้งขึ้นมาเตือนเรื่องการ Archive Session
- [ ] **ความสมบูรณ์ของ Interactive Charting:**
  - สลับไปหน้า **Analytics**: กราฟ TradingView Lightweight Charts ต้องยังคงโหลดแท่งเทียนจาก Binance Public API ได้ปกติ, ปรับ Period ของ Dual EMA และ ATR Band ได้
- [ ] **การทำงานของ Quant Lab Studio:**
  - สลับไปหน้า **Quant Lab**: ต้องเห็น 4 แท็บ (`Backtest`, `Optimizer`, `Risk Preview`, `Pine Export`)
  - กดปุ่ม **Run Backtest**: ต้องมีกราฟเส้น Equity Curve แสดงขึ้นมาพร้อมสรุปผลกำไร/Drawdown
  - กดปุ่ม **Run Optimizer**: ต้องประมวลผล Grid Search และแสดงรายการ Top Candidates
  - กดปุ่ม **Compute Preview** ในแท็บ Risk: ต้องคำนวณขนาด Position Sizing ตามสมการได้อย่างถูกต้อง
