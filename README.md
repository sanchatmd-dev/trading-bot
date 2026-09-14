# Astra Trade VPS v2.0.0

Multi-user trade-bot platform รับ Universal Webhook จาก TradingView ตรวจสอบ License และ Risk ของผู้ใช้ แล้วส่งคำสั่งผ่าน Broker Adapter พร้อมบันทึกผลและแจ้ง Email

> ระบบเริ่มต้นด้วย Paper Trading สำหรับผู้ใช้ทุกคน ห้ามเปิด Live ก่อนตั้ง Broker credentials, IP allowlist และทดสอบครบถ้วน

v2 ใช้ฐานข้อมูล `astra-v2.db` ใหม่และไม่แก้ฐานข้อมูล v1 อัตโนมัติ เพื่อป้องกันข้อมูลเดิมเสียหาย

## Architecture

```text
Layer 1 — Signal
TradingView Indicator / Strategy
  BUY · SELL · TP · SL
  Universal Webhook · trade_id · user webhook secret
                    │ HTTPS
                    ▼
Layer 2 — Bot Core on VPS
Webhook receiver → Signal validator → User/License check
                 → Risk manager → Position manager
                 → Durable SQLite queue/database
                 → Trade/Error log → Email notification
                    │ Adapter contract
                    ▼
Layer 3 — Execution
Binance Global · Binance TH · InnovestX
MT5 Bridge · Settrade Bridge · Future HTTP Adapter
```

## ระบบที่เพิ่มใน v2

- User account, salted `scrypt` password hash และ expiring session
- Admin/User roles และ Suspend/Activate user
- License key, Plan, expiry, redemption และ Subscription status control
- Webhook secret แยกผู้ใช้ เก็บเฉพาะ SHA-256 hash และ rotate ได้
- Broker credentials แยกผู้ใช้ เข้ารหัส AES-256-GCM
- Risk profile, equity, Paper/Live และ Kill Switch แยกผู้ใช้
- Global Kill Switch สำหรับ Admin
- Trade/Error/Audit log แยกผู้ใช้
- Execution fields: received time, user, trade ID, symbol, timeframe, event, entry, SL, TP, broker response, order ID, fill, slippage และ error
- Order reconciliation สำหรับ Binance และ HTTP Bridge orders ที่ยัง `SUBMITTED/PARTIALLY_FILLED`
- Max risk/trades/daily loss/open positions, one position per symbol, duplicate/stale signal และ loss-streak pause
- Volatility/News Guard จาก `volatility_percent` และ `news_risk` ใน Signal
- SMTP email เมื่อ Reject, Error หรือ Broker รับ Order

## VPS requirements

- Ubuntu 22.04/24.04 LTS, RAM 1 GB ขึ้นไป
- Public IPv4 และ domain/subdomain ที่มี A record ชี้มายัง VPS
- เปิด TCP 80/443 และ UDP 443
- Docker Engine + Compose plugin

## Installation

```bash
cd /opt
sudo unzip Astra-Trade-VPS-MultiUser-v2.0.0.zip
cd astra-vps-trade-bot-v2
sudo cp .env.example .env
sudo chmod 600 .env
sudo nano .env
```

สร้าง Master key:

```bash
openssl rand -hex 32
```

ใส่ผลลัพธ์ 64 ตัวอักษรใน `MASTER_ENCRYPTION_KEY` แล้วกำหนด:

- `DOMAIN`
- `ADMIN_EMAIL`
- `ADMIN_BOOTSTRAP_PASSWORD` อย่างน้อย 10 ตัวอักษร
- SMTP หากต้องการ Email

เริ่มระบบ:

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100
```

เปิด `https://YOUR-DOMAIN` และ Login ด้วย Admin account จาก `.env` บัญชี Admin จะถูกสร้างเฉพาะฐานข้อมูลใหม่ครั้งแรก

ห้ามเปลี่ยน `MASTER_ENCRYPTION_KEY` หลังบันทึก Broker credentials เพราะข้อมูลเดิมจะถอดรหัสไม่ได้ ควรเก็บ key และ database backup แยกกันในที่ปลอดภัย

## Admin workflow

1. สร้าง User พร้อม temporary password
2. สร้าง License โดยเลือก Plan และจำนวนวัน
3. ส่ง License key ให้ User ทางช่องทางปลอดภัย เพราะระบบแสดง key เต็มเพียงครั้งเดียว
4. User Login และ Activate License
5. User สร้าง Webhook Secret และตั้ง Risk/Broker
6. Admin ระงับ User, License หรือเปิด Global Kill ได้จาก Admin dashboard

ระบบนี้ควบคุม Subscription ด้วย License status/expiry แบบ manual ยังไม่ได้รวม Payment Gateway หรือ recurring billing

## Universal Webhook

ไฟล์ตัวอย่าง Pine Script v6 อยู่ที่ `tradingview/astra_universal_signal.pine` หลังเพิ่ม Indicator ลงกราฟ ให้สร้าง Alert และเลือก Condition เป็น **Any alert() function call** แล้วใส่ Webhook URL ของผู้ใช้ ระบบใส่ Secret ไว้ใน URL จึงไม่ส่ง Secret หรือ Broker API key ใน JSON

URL ของผู้ใช้:

```text
https://YOUR-DOMAIN/webhooks/tradingview/USER_WEBHOOK_SECRET
```

Payload:

```json
{
  "trade_id": "BTC-{{timenow}}",
  "broker": "Binance Global",
  "symbol": "BTCUSDT",
  "timeframe": "15m",
  "event": "BUY",
  "order_type": "MARKET",
  "risk_mode": "PERCENT_EQUITY",
  "risk_value": 0.5,
  "entry": {{close}},
  "sl": 60000,
  "tp": 68000,
  "volatility_percent": 2.4,
  "news_risk": false,
  "leverage": 1,
  "timestamp": "{{timenow}}"
}
```

`event` รองรับ `BUY`, `SELL`, `TP`, `SL`; ระบบกำหนด TP/SL เป็น reduce-only SELL โดยอัตโนมัติสำหรับ Spot

Volatility/News Guard รุ่นนี้ตรวจค่าที่ Indicator หรือระบบข่าวภายนอกส่งใน payload ยังไม่ได้ดาวน์โหลด Economic Calendar เอง หากไม่ส่ง `volatility_percent` ระบบจะไม่มีข้อมูลสำหรับตัดสินความผันผวน และหากไม่ส่ง `news_risk:true` ระบบจะไม่รู้ว่ามีข่าว

## Broker credential formats

Binance Global/TH:

```json
{"apiKey":"...","apiSecret":"...","baseUrl":"https://api.binance.com"}
```

InnovestX:

```json
{"accessToken":"...","baseUrl":"YOUR_OFFICIAL_API_BASE_URL"}
```

MT5, Settrade และ Future Adapter:

```json
{"bridgeUrl":"https://YOUR-PRIVATE-BRIDGE","bridgeToken":"..."}
```

MT5 official integration ติดต่อกับ MetaTrader Terminal ที่ติดตั้งอยู่ในเครื่องเดียวกัน จึงต้องมี Windows VPS/Terminal + Bridge service แล้วให้ Ubuntu Bot เรียกผ่าน HTTPS. Settrade Bridge ต้องสร้างตาม API/SDK และสิทธิ์ของบัญชีที่ผู้ให้บริการอนุมัติ

ทุก API key ต้องเปิดเฉพาะสิทธิ์ Trade, ปิด Withdrawal และจำกัด IP เป็น Public IP ของ VPS

## Email

รองรับ SMTP SSL (`SMTP_SECURE=true`, ปกติ port 465) หรือ STARTTLS (`SMTP_SECURE=false`, ปกติ port 587) ระบบไม่บันทึก SMTP password ลงฐานข้อมูล แต่รับจาก `.env`

## Backup

```bash
chmod +x scripts/backup.sh
sudo ./scripts/backup.sh
```

## Limitations before unattended live trading

- Binance order reconciliation มีแล้ว แต่ balance/equity ยังเป็น snapshot ที่ User ตั้งเอง
- InnovestX adapter ต้องใช้ Base URL และ access token ที่ถูกต้องจากบัญชีจริง และยังไม่มี polling implementation เฉพาะผู้ให้บริการ
- MT5/Settrade/Future adapters เป็น secure HTTP Bridge contract ต้อง deploy Bridge แยก
- News blocking ต้องรับ flag จาก upstream signal/news service
- ระบบ License เป็น local database control ไม่ใช่ cryptographically signed offline license และยังไม่มี billing/payment
- ควรเพิ่ม PostgreSQL/Redis และ external secret manager หากใช้งานเชิงพาณิชย์หลาย VPS
