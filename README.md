# Robot trade VPS 2.2.0 — PostgreSQL Paper staging

รับ Universal Webhook จาก TradingView พร้อมบัญชีผู้ใช้, License, Risk UI, Trade log และ Email outbox

**รุ่นนี้ล็อก Live ทุก Broker ทั้ง UI, API, Worker และ Adapter ไม่ใช่ระบบพร้อมเทรดเงินจริง**
ไม่ต้องใส่ API key จริงเพื่อทดสอบ Paper และอย่าเปิดบริการสาธารณะก่อนผ่าน deployment checklist

## Phase 0 — deploy แล้ว (50062f5)

เพิ่มบัญชีเงินสด Paper, ประวัติการเพิ่ม/ลดทุน และ recovery หลัง restart พร้อมนิยาม Analytics แบบปิดครบหนึ่งรอบ รายละเอียดและขั้นตอนทดสอบ migration บนสำเนา DB อยู่ใน [Phase 0](docs/PHASE0.md)

ช่อง Equity/Balance คือทุนสะสมที่กำหนด ไม่ใช่ยอดเงินปัจจุบัน การเปลี่ยนค่าเป็นการเพิ่ม/ลดทุนโดยไม่ล้างกำไรขาดทุน หน้า Risk แสดงเงินสดและทุนตามบัญชีแยกต่างหาก รุ่นนี้ยังไม่ประเมินทุนด้วยราคาตลาดสด

## Phase 1 — deploy แล้ว (b441476, schema 10)

Deploy บน VPS แล้วเมื่อ 2026-09-18 (Asia/Bangkok) เพิ่ม MFA/TOTP และ recovery codes, HttpOnly cookie + CSRF, กู้รหัสผ่านทางอีเมล, USER/SUPPORT/ADMIN และเครื่องมือหมุนกุญแจเข้ารหัส ระบบยังคง Paper-only ไม่พร้อมเทรดเงินจริงหรือเปิดขายบริการ

สำรอง DB และซ้อม migration ก่อนอัปเกรด schema 9 → 10 แล้ว ตั้ง `PUBLIC_ORIGIN` ตรงโดเมนจริง โดยคง master key และ webhook เดิมไว้ Tests ก่อน deploy ผ่าน 88/88 ทั้งในเครื่องและ VPS พร้อมตรวจ Desktop/Mobile บน Chrome

ตรวจรับล่าสุดเมื่อ 2026-09-18: service และฐานข้อมูลปกติ Admin เปิด MFA แล้ว 1/1 บัญชี และพบ session ที่ผ่าน MFA Gmail ส่งอีเมลทดสอบถึงผู้ใช้แล้ว แต่ยังไม่มีหลักฐานการกู้รหัสผ่านครบวงจรบน production

งานตรวจรับที่ยังค้าง:

- ผู้ใช้ทดสอบ Forgot Password ครบวงจรและยืนยันว่าเก็บ recovery codes อย่างปลอดภัย
- ซ้อมกู้ระบบครบวงจรในพื้นที่แยก; migration rehearsal ไม่ใช่การทดสอบ restore ระบบทั้งหมด
- ทดสอบอุปกรณ์ iOS/Android จริงและ Safari พร้อมประเมินความปลอดภัยแยกต่างหากก่อนเปิดขายบริการ

รายละเอียดผล deploy และข้อจำกัดอยู่ใน [Phase 1](docs/PHASE1.md)

## Phase 2 — deploy แล้ว (0321ae6, PostgreSQL schema 11)

เพิ่ม PostgreSQL schema 11, การคำนวณเงิน Decimal, API/Worker แยก process, คิวหลาย Worker, transaction ป้องกันบันทึก Fill/เงินซ้ำ และเครื่องมือ import/backup/หมุนกุญแจ ระบบยังคง Paper-only

Tests: ชุดเดิมและ UI 89/89; PostgreSQL จริง 15/15 รวมฆ่า Worker กลาง transaction, หลาย process, MFA/CSRF และ backup/restore ตรวจ Chrome Desktop/Mobile ผ่าน Production ย้ายจริง 534 signals / 151 fills โดยไม่มีงานค้างหรือบัญชีเงินสดติดลบ และผ่าน restart/HTTPS health check หลัง deploy

Production ใช้ PostgreSQL API และ Worker แยก service; `npm start`/SQLite เก็บไว้ชั่วคราวสำหรับประวัติและ recovery เท่านั้น อ่าน [Phase 2](docs/PHASE2.md) โดยเฉพาะ backup และข้อจำกัด rollback หลังรับรายการใหม่

## Phase R-1 — เสร็จสมบูรณ์ใน repo (b2cb863, PostgreSQL schema 12)

เพิ่มระบบติดตาม Position รายไม้ (per-entry allocation tracking) ผ่านตาราง `ledger_position_allocations` บน Schema 12 เพื่อแก้ปัญหาการ Scale-in แล้วคำสั่ง Take Profit ของไม้แรกไปปิดรวบทุกไม้ (Targeted TP/SL per lot) ทำให้แต่ละ Order Lot มีการจัดการกำไร/ขาดทุนที่เป็นอิสระต่อกัน ผ่านการทดสอบครบถ้วนด้วย `test/scale-in.test.js`

## QL-1 — Quant Lab scaffold (32625fb; local validation complete)

เพิ่ม `quant_lab/` เป็น Python 3.12 workspace แยกจาก Node runtime และ Docker
release payload ใช้ `uv.lock` เพื่อล็อก dependencies สำหรับ DuckDB, Polars,
pandas, PyArrow, psycopg, CCXT, yfinance, vectorbt, pandas-ta, QuantStats,
Jupyter, Ruff และ Pytest โดยไม่มี network หรือ database access ระหว่าง tests

contracts แบบ immutable ใน `quant_lab/src/robot_quant/contracts.py` ครอบคลุม
RiskProfile, parameter bounds, strategy definition, optimization run, export
metadata, ownership scope, position intent และ risk decision ข้อมูลเงินใช้ decimal
string สูงสุด 18 ตำแหน่งทศนิยมและ unknown fields/versions ถูกปฏิเสธ

คำสั่งตรวจในเครื่อง:

```sh
cd quant_lab
uv sync --locked --all-extras
uv run --no-sync ruff check .
uv run --no-sync pytest
uv run --no-sync python -m robot_quant.smoke
```

ผล local: Node 104/104, Quant 27/27, Ruff, lock, workflow YAML และ package imports
ผ่านแล้ว. GitHub Actions Linux/Windows และ isolated PostgreSQL integration ของ commit
นี้ยังเป็น acceptance gate ก่อนปิด QL-1. อ่านรายละเอียดใน
[Quant Lab README](quant_lab/README.md). QL-2 เริ่มได้เฉพาะ research แบบแยกส่วน;
ไม่มีการ deploy หรือแก้ production DB จาก QL-1

## การแก้ไขจาก v2.0

- ตรวจ Max risk หลังคำนวณจำนวนทุกโหมด รวม explicit quantity และ fixed notional; BUY ต้องมี SL
- ผูก `execution_mode`, `account_id`, `client_order_id` กับสัญญาณตั้งแต่รับเข้า ไม่เปลี่ยนตาม Risk profile ภายหลัง
- แยก Position/สถิติด้วย user + account + mode; หนึ่ง primary account ต่อ Broker ในรุ่นนี้
- บันทึก Fill, Position, PnL, สถานะ Order และ Email outbox ใน transaction เดียว
- ใช้ cumulative fill ป้องกันลงบัญชีซ้ำ และคิด R จากความเสี่ยงตั้งต้น ไม่เพิ่ม Loss streak ทุก partial fill
- เมื่อ restart งาน LIVE/LEGACY ที่ PROCESSING เปลี่ยนเป็น UNKNOWN ไม่ส่งคำสั่งซ้ำอัตโนมัติ ส่วน Paper ใช้ recovery ตาม Phase 0
- ตรวจรายการค้างตามเวลาแม้คิวไม่ว่าง และหมุนรายการที่ตรวจไม่สำเร็จ
- นับ Pending BUY ใน exposure และจองวงเงิน; อนุญาต Scale-in ตาม Risk settings และใช้ trade_id ไม่ซ้ำ
- Kill switch หมายถึง **หยุดเปิดใหม่**; reduce-only exits ผ่านได้เมื่อ pause หรือ License หมดอายุ แต่ผู้ใช้ Suspended ยังถูกบล็อกทั้งหมด
- News/Volatility Guard ปฏิเสธ entry เมื่อเปิด Guard แต่ข้อมูลขาดหาย
- จำกัด request body, rate, queue; ตรวจ boolean อย่างเข้มงวด; เปลี่ยนรหัสผ่าน/ระงับบัญชีแล้วเพิกถอน Session
- ไม่รับ Broker URL จากผู้ใช้; credentials ใหม่เข้ารหัส AES-GCM พร้อมผูก user/Broker
- Schema migration แบบ transaction, single-instance lock, graceful shutdown, queue health, backup integrity check
- เพิ่ม unit/integration tests และ GitHub Actions สำหรับ Windows/Linux, PostgreSQL 16 และ container build

## Architecture

```text
TradingView → HTTP validation / authentication → durable signal queue
                                                    ↓
                                            Risk / Paper worker
                                                    ↓
                       transaction: fills + allocations + positions + daily ledger
                                                    ↓
                                           notification outbox → SMTP worker

Reconciliation loop → unresolved / pending outcomes → manual review or verified ledger update
Live adapters: LOCKED
```

ระบบปัจจุบันรันบน PostgreSQL 16 (Schema 12) แยก process ชัดเจนระหว่าง Web API และ Background Worker
SQLite ในอดีตถูกเก็บไว้เป็นประวัติก่อน cutover เท่านั้น ห้ามเปิด writer บน SQLite ซ้ำ

## เริ่มทดสอบในเครื่อง

ต้องมี Node.js 24 ขึ้นไป

```sh
npm ci
npm test              # รัน unit/regression tests ทั่วไป
npm run test:postgres # รัน integration tests กับฐานข้อมูล PostgreSQL จริง
```

cp .env.example .env

แก้ `.env`: ตั้งค่าเชื่อมต่อฐานข้อมูล PostgreSQL, ตั้งรหัสผ่าน Admin ใหม่ และสร้าง Master key ด้วย `openssl rand -hex 32`
จากนั้นรัน `npm run start:postgres` และเปิด `http://127.0.0.1:8080`
ค่า `PAPER_TRADING=false` จะทำให้ startup ถูกปฏิเสธ ไม่ใช่ช่องทางปลดล็อก Live

## VPS แบบส่วนตัว

1. สำรองระบบเดิมก่อนอัปเกรด ตาม [คู่มือ deployment](docs/DEPLOYMENT.md)
2. Copy `.env.example` เป็น `.env`
3. ตั้ง `MASTER_ENCRYPTION_KEY` เป็น hex 64 ตัว, `ADMIN_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` อย่างน้อย 10 ตัว
4. ใช้ `DOMAIN=http://localhost` และ `PUBLIC_ORIGIN=http://localhost:8080` สำหรับ private staging ผ่าน tunnel ตามข้อ 6
5. รัน `docker compose up -d --build`
6. เชื่อมจากเครื่องส่วนตัวด้วย `ssh -L 8080:127.0.0.1:80 USER@VPS` แล้วเปิด `http://localhost:8080`

Compose bind proxy ที่ localhost เท่านั้น จึง **ยังรับ webhook จาก TradingView ภายนอกไม่ได้**
ให้ทดสอบ payload ผ่าน tunnel ก่อน การเปิด HTTPS สาธารณะต้องผ่านรายการตรวจในคู่มือ
อย่านำ HTTP ส่วนตัวนี้ไปเปิดบน public interface โดยไม่มี TLS และการจำกัดหน้า Admin

## Universal Webhook

สร้าง Secret ในหน้า Account แล้วใช้ URL ที่ระบบแสดง:

```text
/webhooks/tradingview/USER_WEBHOOK_SECRET
```

```json
{
  "trade_id": "unique-order-0001",
  "broker": "Binance Global",
  "account_type": "Spot",
  "symbol": "BTCUSDT",
  "timeframe": "15m",
  "event": "BUY",
  "order_type": "MARKET",
  "risk_mode": "PERCENT_EQUITY",
  "risk_value": 0.5,
  "entry": 61000,
  "sl": 60000,
  "tp": 63000,
  "volatility_percent": 2.4,
  "news_risk": false,
  "timestamp": "REPLACE_WITH_CURRENT_ISO_TIME"
}
```

ใช้ `trade_id` ใหม่ต่อคำสั่งจริง และใช้ค่าเดิมเมื่อส่งซ้ำเพราะไม่ทราบผล HTTP
HTTP 202 หมายถึงเข้าคิวแล้ว ไม่ใช่ Fill; ตรวจ Trade log เสมอ
Secret อยู่ใน URL ไม่ส่ง API key หรือ secret ของ Broker ใน payload

TP/SL เป็น reduce-only SELL; SL/TP ที่แนบมากับ BUY **ยังไม่ใช่คำสั่งป้องกันที่ Broker**
Paper เติมเต็มทันทีที่ราคาอ้างอิง แม้เป็น LIMIT ไม่จำลอง order book, gap, slippage, fee หรือราคาตลาดจริง
Pine ใน `tradingview/` เป็นตัวอย่าง signal generator ไม่ใช่แหล่งข้อมูล Position ที่เชื่อถือแทน Broker ได้

## ขอบเขต Risk และบัญชี

- Risk settings ใช้ต่อบัญชี Broker; dashboard ไม่บวก notional คนละสกุลเงินเข้าด้วยกัน
- Binance Global จำลองคู่ quote USDT; Binance TH จำลองคู่ quote THB
- InnovestX/Settrade จำลองราคาและ equity หน่วย THB เท่านั้น ไม่ได้เชื่อม API จริง
- MT5/Future ไม่รองรับ Spot simulation และไม่เปิด execution
- Equity เป็นยอดตั้งค่าจำลอง ไม่ได้ดึง balance/mark-to-market จาก Broker
- วันตัดยอด UTC; trade count นับ Order ที่เริ่ม Fill รวม BUY/SELL ไม่ใช่จำนวนรอบเข้าออก
- Daily loss R อัปเดตทุก Fill; Loss streak อัปเดตเมื่อปิด Position ทั้งหมด และไม่ reset เมื่อข้ามวัน
- Zero-fee Paper ไม่ใช่ผลตอบแทนสุทธิจริง; Live fee ledger ยังเป็น release gate
- News/Volatility มาจาก upstream payload ไม่ได้ตรวจสอบกับบริการข่าว/ราคาภายนอก
- เปิด BUY ซ้ำใน symbol เดิมได้เมื่อ `onePositionPerSymbol=false` (ค่าเริ่มต้น) แต่ทุกคำสั่งต้องใช้ `trade_id` ใหม่และผ่าน Risk Manager แยกกัน
- เปิด `onePositionPerSymbol` ใน Risk Manager ได้เมื่อต้องการบล็อกการเพิ่ม Position ใน symbol เดิม; reduce-only SELL ยังบังคับเสมอ

## Bot Manager: Main + 4 Sub-Bots

เลือก Bot Manager เพื่อสร้าง Sub-Bot ได้สูงสุด 4 ตัว รวม Main เป็น 5 Slots ตั้งชื่อแต่ละ Bot แล้วสลับด้วยช่อง Bot ด้านบน

- แต่ละ Bot มี Webhook URL/Secret, Risk, Equity, Balance, Position, Trade Log และ Analytics แยกกัน
- Sub-Bot ใหม่เริ่ม Equity/Balance ที่ 0 ให้เลือก Bot แล้วตั้งทุนใน Risk Manager ก่อนส่งสัญญาณ
- ปุ่ม Copy webhook คัดลอก URL ของ Bot นั้นโดยตรง Main Bot ที่ยังไม่มี URL ให้สร้างใน Account and License
- All Bots รวมรายการของเจ้าของบัญชีเท่านั้น แสดง Broker/สกุลเงินแยกกัน เลือก Bot รายตัวก่อนแก้การตั้งค่า
- Login และ License ใช้บัญชีหลัก การระงับบัญชีหลักมีผลกับทุก Bot
- ระบบรองรับ Multi-bot Slot โดยเก็บ Bot ID ใน users.id และเชื่อมโยงผ่าน parent_user_id พร้อมความปลอดภัยระดับ Schema 12

## Analytics reports

หน้า Analytics ใช้ Paper fills สร้าง Closed Position แบบ FIFO แยกตาม user, Broker และ symbol แล้วคำนวณ Total Trades, Win/Loss, Win Rate, Net Profit, Profit Factor, MDD, Expectancy, Realized Win/Loss Ratio, streak, Average Holding Time และ Fee Impact

- Binance Global แสดง USDT; Binance TH, InnovestX และ Settrade แสดง THB โดยไม่รวมข้ามสกุล
- เลือก Daily, Weekly, Monthly, Annually หรือ Custom UTC date range และกรอง Asset ได้
- Custom fee กำหนดเป็น basis points ต่อ user/Broker และใช้คำนวณรายงานย้อนหลังโดยไม่แก้ historical fills
- Normal user อ่านได้เฉพาะข้อมูลตัวเอง; Admin เลือก user ได้

API ที่ต้องมี authenticated session:

```text
GET /api/analytics/summary?broker=binance-global&period=monthly&symbol=BTCUSDT
GET /api/analytics/equity-curve?broker=binance-global&period=custom&from=2026-09-01&to=2026-09-30
GET /api/analytics/breakdown?broker=binance-global&period=monthly
PUT /api/analytics/settings
```

Body สำหรับตั้งค่าธรรมเนียม: `{"broker":"binance-global","feeBps":10}`

## Credentials และ Email

ไม่จำเป็นต้องเก็บ credentials ใน Paper staging หากต้องทดสอบ storage ให้ใช้ค่าทดสอบ
Binance รับเฉพาะ `apiKey` และ `apiSecret`; ไม่รับ `baseUrl` หรือ `bridgeUrl`
ข้อมูลเข้ารหัส v1 เดิมต้องกรอกใหม่ก่อนใช้ recovery เพราะยังไม่ได้ผูก tenant แบบ v2
อย่าเปลี่ยน Master key โดยไม่มีแผน re-encryption; เก็บ key แยกจาก DB backup

SMTP ใช้ TLS หรือ STARTTLS, ส่งผ่าน outbox แยกและ retry ไม่เกิน 5 ครั้ง
หากไม่ตั้ง SMTP รายการเป็น DISABLED; ส่งล้มเหลวครบจำนวนเป็น FAILED และต้องตรวจติดตาม
License/subscription ยังควบคุมด้วย Admin ไม่ใช่ระบบรับชำระเงินอัตโนมัติ

## ข้อจำกัดและ Release gates

อ่าน [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) ก่อนอัปเกรด
ยังต้องทำ native protective orders, authoritative balances/prices, exchange precision/filter verification,
fee-aware live ledger, broker-specific contract/sandbox tests, และขั้นตอน cancel/close/reconcile จริง
ก่อนออก release ที่เปิด Live ได้ การล็อก Live เป็นมาตรการป้องกัน ไม่ได้หมายความว่างานเหล่านี้เสร็จแล้ว
