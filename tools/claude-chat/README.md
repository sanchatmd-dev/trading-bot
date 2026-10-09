# Astra Claude Chat

หน้าแชทส่วนตัวสำหรับสั่ง Claude ทำงานบน repo นี้ เช่น อ่านโค้ด แก้ไฟล์ รันเทสต์ และใช้ git ทำงานผ่าน [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) ซึ่งเป็นแกนเดียวกับ Claude Code

ค่าใช้จ่ายตัดจาก **เครดิต API รายเดือนที่มากับ Max** (Max 20x ได้ $200, Max 5x ได้ $100) โดยไม่ใช้โควตา usage ของ Max จึงใช้ทำงานต่อได้ตอนติด usage limit

> ทำไมไม่ใช้ Claude Code ตรงๆ: เอกสารของ Anthropic ระบุว่าเครดิตนี้ **ใช้กับ Claude Code ไม่ได้** แต่ใช้กับ Claude API และ Claude Agent SDK ได้ ([ที่มา](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)) โปรแกรมนี้จึงเรียก Agent SDK ด้วย Console API key แทน

เครื่องมือนี้เป็นของนักพัฒนาเท่านั้น ไม่อยู่ใน Docker image และไม่ใช่ส่วนของบอทเทรด

## 1. รับเครดิตและสร้าง API key (ทำครั้งเดียว, เจ้าของเท่านั้น)

ขั้นตอนนี้ **เจ้าของ repo ทำเอง** ผู้ช่วย AI ห้ามสร้าง key, อ่าน หรือคัดลอกค่าใน `.env`

1. เปิด claude.ai ในเบราว์เซอร์ → **Settings → Billing** → ส่วน **API credits** แล้วกดรับ (claim) เครดิต
2. เลือกหรือสร้าง Console organization แล้วกด Link ต้องเป็น Max มาแล้วอย่างน้อย 7 วัน และ **เปลี่ยน org เองภายหลังไม่ได้**
3. ที่ [platform.claude.com](https://platform.claude.com) → **Settings → Billing** ตรวจว่าเห็นยอดใน **Promotional credits**
4. **Settings → Workspaces** → สร้าง workspace เช่น `trading-bot` แล้วตั้ง **Spend limit** เป็นเพดานจริงที่ไม่ยอมให้เกิน (นี่คือตัวหยุดที่แท้จริง ตัวหยุดอื่นในโปรแกรมนี้เป็นเพียงค่าประมาณ)
5. สร้าง **API key** ใน workspace นั้น (ขึ้นต้นด้วย `sk-ant-api`) แล้ววางเองในไฟล์ `tools/claude-chat/.env` (`ANTHROPIC_API_KEY=...`)

ไม่ต้องใส่บัตรใน Console ถ้าไม่ได้ซื้อเครดิตเพิ่มหรือเปิด auto-reload เมื่อเครดิตหมด request จะหยุดเองโดยไม่ถูกเก็บเงิน และเครดิตใหม่จะมาในรอบบิลถัดไป เครดิตที่เหลือไม่ทบไปเดือนหน้า การซื้อเครดิตและการเปิด auto-reload เป็นการตัดสินใจของเจ้าของเท่านั้น

## 2. ติดตั้งและเปิดใช้

ต้องมี Node.js 22.9 ขึ้นไป (repo นี้ใช้ 24) และ git ที่ push ไป GitHub ได้อยู่แล้ว

```sh
git clone https://github.com/sanchatmd-dev/trading-bot.git
cd trading-bot/tools/claude-chat
npm ci
cp .env.example .env        # Windows: copy .env.example .env
# เปิด .env แล้วใส่ ANTHROPIC_API_KEY=sk-ant-api...
npm start
```

เปิดลิงก์ที่แสดงในเทอร์มินัล เช่น `http://127.0.0.1:8787/#token=...` แล้วพิมพ์สั่งงานได้เลย

## 3. ส่งงานต่อจาก Claude Code (handoff)

ใช้เมื่อ usage ของ Claude Code ใกล้หมดและ **เจ้าของสั่งใน chat ให้ส่งต่อ** (กฎอยู่ในหัวข้อ "API-credit continuation" ของ `AGENTS.md`) root บันทึก checkpoint ไว้ใต้ `.qa-local/` ก่อน แล้วรัน

```sh
node tools/claude-chat/handoff.mjs .qa-local/<checkpoint>.md
```

คำสั่งนี้ทำตามลำดับ

1. ตรวจว่า checkpoint เป็นไฟล์ธรรมดาที่อยู่ใต้ `.qa-local/` ของ repo จริงๆ (ปฏิเสธ `..`, symlink และ junction ที่ชี้ออกนอก และไฟล์ `claude-chat*` ของเครื่องมือนี้เอง)
2. ถ้ายังไม่มีเซิร์ฟเวอร์ที่ตอบด้วย token ใน `.qa-local/claude-chat-state.json` จะเริ่ม `node --env-file-if-exists=.env server.mjs` แบบ detached (ไม่ผูกกับเทอร์มินัลที่สั่ง) โดยผูกที่ `127.0.0.1` เท่านั้น เขียน log ที่ `.qa-local/claude-chat.log` ตัดตัวแปร `CLAUDE*`/`ANTHROPIC_*` ทุกตัวออกจาก environment (key มาจาก `tools/claude-chat/.env` เท่านั้น) และรอไม่เกิน 30 วินาที
3. ถ้าเซิร์ฟเวอร์จบเองก่อนพร้อม จะแจ้งให้ `set ANTHROPIC_API_KEY in tools/claude-chat/.env` (ไม่พิมพ์ค่า key) ถ้าพอร์ตถูกโปรเซสอื่นใช้อยู่จะหยุดและรายงาน
4. ถ้าแชทของ Astra กำลังทำงานอยู่ (busy) จะหยุดที่รหัสออก 3 และรายงาน ไม่ขัดจังหวะหรือรีเซ็ตแชทที่ใช้อยู่ (แม้ใส่ `--replace`) ถ้าแชทว่างแต่ยังมีบทสนทนาค้างอยู่ (มี session id) ก็หยุดที่รหัสออก 3 เช่นกัน พร้อมพิมพ์ session id เพราะแชทใหม่จะทับงานของเจ้าของ เมื่อเจ้าของยืนยันแล้วให้รันซ้ำพร้อม `--replace` ถ้ามีเซิร์ฟเวอร์ Astra ที่ยังทำงานอยู่ในพอร์ตอื่นตามไฟล์สถานะ จะหยุดที่รหัสออก 2 และบอกพอร์ตนั้น ไม่เริ่มเซิร์ฟเวอร์ตัวที่สอง (กฎผู้เขียนคนเดียว) ปิดตัวเดิมก่อนด้วย pid (ดูหัวข้อ "การปิดเซิร์ฟเวอร์") ช่วงเวลาระหว่างตรวจสถานะกับเปิดแชทใหม่ยังมีช่องว่างเล็กน้อย (race) ที่ไม่ได้กันไว้
5. เปิดแชทใหม่ ตั้งสิทธิ์เป็น **ถามทุกครั้ง (`default`)** แล้วส่งข้อความแรก คือคำนำคงที่ ตามด้วยเนื้อหา checkpoint คำนำสั่งว่า ทำต่อจากงานที่ Claude Code root ส่งมาตามกฎ API-credit continuation, ตรวจ branch/revision/dirty paths ก่อน, ห้ามทำงานที่เสร็จแล้วซ้ำ, Astra เป็นผู้เขียนคนเดียว, ทำงานคนเดียวโดยไม่ใช้ Workflow tool และใช้ subagent ได้เฉพาะภายในเพดานที่เจ้าของตั้ง, กฎ safety/Git/host/browser/GO ใน `AGENTS.md` ใช้ครบ และการเปิดใช้ ultracode ของ root ไม่ใช้กับ Astra, ห้ามซื้อเครดิตหรือเปิด auto-reload, เมื่อเจ้าของสั่งหยุดให้บันทึก checkpoint ลง `.qa-local/` แล้วหยุด
6. พิมพ์ลิงก์ `http://127.0.0.1:<port>/#token=<token>` ที่เทอร์มินัล (ที่เดียวเท่านั้น ไม่เขียนลง log) และเปิดเบราว์เซอร์ให้ (macOS `open`, Windows `start`, Linux `xdg-open`)

ตัวเลือก: `--no-open` พิมพ์ลิงก์โดยไม่เปิดเบราว์เซอร์ (สำหรับเทสต์และ agent), `--port N` เลือกพอร์ต (ค่าเริ่มต้น `CHAT_PORT` หรือ 8787), `--replace` อนุญาตให้แชทใหม่ทับแชทว่างที่ยังมีบทสนทนาค้าง (ใช้หลังเจ้าของยืนยันเท่านั้น) รหัสออก: 0 สำเร็จ, 1 อินพุตไม่ถูกต้อง, 2 เริ่มเซิร์ฟเวอร์ไม่ได้ พอร์ตถูกโปรเซสอื่นใช้ หรือมี Astra ทำงานอยู่ในพอร์ตอื่น, 3 Astra busy หรือมีแชทค้างอยู่โดยไม่ได้ใส่ `--replace`

Astra เป็นผู้บัญชาการและผู้เขียนคนเดียวระหว่างที่ทำต่อ Claude Code root ไม่เขียน checkout นี้ เมื่อจะกลับ ให้บอก Astra ให้บันทึก checkpoint ลง `.qa-local/` แล้วหยุด

### ไฟล์สถานะและ log

- `.qa-local/claude-chat-state.json` เก็บ `pid`, `port` และ `token` ของเซิร์ฟเวอร์ที่ handoff เริ่ม token สุ่มใหม่ทุกครั้งที่เริ่มเซิร์ฟเวอร์ ใครอ่านไฟล์นี้ได้ก็คุม Astra ได้ จึงห้ามเอาไปแปะที่ใด
- บน macOS/Linux ไฟล์นี้ถูกตั้งเป็นโหมด `0600` บน **Windows ไม่มีโหมดแบบ POSIX จึงไม่อ้างว่าเป็น `0600`** ไฟล์พึ่งสิทธิ์ (ACL) ที่สืบทอดจากโฟลเดอร์ `.qa-local/` ซึ่งปกติให้เจ้าของบัญชี, SYSTEM และ Administrators เท่านั้น ถ้าเครื่องใช้ร่วมกับผู้ใช้อื่น ให้ตรวจด้วย `icacls .qa-local` ก่อน
- `.qa-local/claude-chat.log` เก็บผลลัพธ์ของเซิร์ฟเวอร์ ไม่มี token และไม่มี API key `.qa-local/` ถูก `.gitignore` กันไว้
- Claude ในแชทนี้อ่านไฟล์ `claude-chat*` ใน `.qa-local/` ไม่ได้ (ดูหัวข้อความปลอดภัย)

### การปิดเซิร์ฟเวอร์ (โดยเฉพาะ Windows)

- ถ้าเปิดด้วย `npm start` ในเทอร์มินัล กด **Ctrl+C** (หรือ Ctrl+Break บน Windows) จะปิดเซิร์ฟเวอร์และ Claude ที่กำลังทำงานอยู่อย่างเรียบร้อย
- เซิร์ฟเวอร์ที่ handoff เริ่มทำงานแบบ detached ไม่มีหน้าต่างคอนโซลให้กด Ctrl+C ให้ปิดด้วย pid ในไฟล์สถานะ:
  - Windows (PowerShell): `taskkill /T /F /PID (Get-Content .qa-local/claude-chat-state.json | ConvertFrom-Json).pid` การปิดแบบ `/F` ไม่รัน handler ปิดงาน ส่วน `/T` ปิด process ลูก (`claude.exe`) ด้วย
  - macOS/Linux: `kill <pid>`
- หลังปิดแล้ว handoff ครั้งถัดไปจะเริ่มเซิร์ฟเวอร์ใหม่พร้อม token ใหม่

## 4. การใช้งาน

- **พิมพ์สั่งงาน** เช่น "รันเทสต์แล้วสรุปผล" หรือ "แก้บั๊กใน src/risk.js บน branch ใหม่ แล้ว commit และ push" ส่งข้อความเพิ่มระหว่างที่ Claude ทำงานอยู่ก็ได้
- **สิทธิ์**
  - *แก้ไฟล์อัตโนมัติ · ถามก่อนรันคำสั่ง* (ค่าเริ่มต้นของ `npm start`): แก้ไฟล์ใน repo ได้เลย (ยกเว้นไฟล์ที่ห้ามแก้ ดูหัวข้อความปลอดภัย) แต่คำสั่ง shell เช่น git commit/push หรือ npm จะขึ้นการ์ดให้กดอนุญาตก่อน (คำสั่งอ่านอย่างเดียวบางคำสั่งอาจรันได้ทันที)
  - *ถามทุกครั้ง* (ค่าเริ่มต้นของแชทที่เริ่มจาก handoff): ถามก่อนแก้ไฟล์ด้วย
  - *วางแผนก่อน*: Claude วางแผนให้อ่านก่อนโดยยังไม่แก้ไฟล์
  - **อนุญาตเสมอในแชทนี้** มีผลเฉพาะแชทปัจจุบัน ไม่ถูกบันทึกลงไฟล์ settings และไม่ล้มข้อห้ามด้านความปลอดภัย
- **หยุด** ขัดจังหวะงานที่กำลังทำ, **แชทใหม่** เริ่มบทสนทนาใหม่, **ประวัติ** เปิดแชทเก่ามาทำต่อ (แสดงเฉพาะแชทที่ Astra สร้างเอง)
- **โมเดล** สลับได้กลางแชท ราคาต่อ 1 ล้าน token (input / output) ณ ต.ค. 2026 ดูราคาล่าสุดที่ [pricing](https://platform.claude.com/docs/en/about-claude/pricing)

  | โมเดล | ราคา | เหมาะกับ |
  |---|---|---|
  | Opus 5.5 (ค่าเริ่มต้น) | $4 / $20 | งานโค้ดหลายขั้นตอน แก้บั๊กยาก |
  | Sonnet 5.5 | $2 / $10 | งานทั่วไป ประหยัดกว่าครึ่ง |
  | Haiku 5.5 | $0.10 / $0.50 | งานง่าย ถามตอบสั้นๆ |

- ตัวเลข **$** มุมบนคือค่าใช้จ่าย **สะสมโดยประมาณ** ของแชทนี้ (รวมทุกรอบที่ถูกหยุดด้วยเพดานต่อรอบแล้วทำต่อ) ถ้าตั้ง `CHAT_MAX_SESSION_USD` จะแสดงเพดานต่อท้าย ยอดจริงดูที่ Console → [Cost](https://platform.claude.com/cost)

## ใช้จากมือถือ

โปรแกรมรับการเชื่อมต่อเฉพาะจากเครื่องตัวเอง (`127.0.0.1`) และ **ปฏิเสธการตั้ง `CHAT_HOST` ที่ไม่ใช่ loopback** เว้นแต่ตั้ง `CHAT_ALLOW_REMOTE=1` ถ้าจะใช้จากมือถือ ให้เชื่อมผ่านเครือข่ายส่วนตัว เช่น [Tailscale](https://tailscale.com) หรือ SSH tunnel โดยใช้พอร์ตเดียวกันทั้งสองฝั่ง (`ssh -L 8787:127.0.0.1:8787 you@your-pc`) เพราะเซิร์ฟเวอร์ตรวจ header `Host` ต้องเป็น `127.0.0.1`/`localhost`/`[::1]` ตามด้วยพอร์ตที่เซิร์ฟเวอร์ฟังอยู่ ถ้าเข้าด้วยชื่ออื่น (เช่นชื่อเครื่องใน Tailscale) ให้ใส่ชื่อนั้นพร้อมพอร์ตใน `CHAT_ALLOWED_HOSTS` **อย่าเปิดพอร์ตนี้สู่อินเทอร์เน็ตสาธารณะ** เพราะผู้ที่เข้าถึงได้จะสั่งรันคำสั่งบนเครื่องคุณได้

## ความปลอดภัย

Claude ในโปรแกรมนี้ **แก้ไฟล์และรันคำสั่งบนเครื่องที่รันอยู่ได้จริง** ควรรันบนเครื่องพัฒนา ไม่ใช่ VPS production ที่บอทเทรดอยู่

**การเข้าถึงเซิร์ฟเวอร์**

- ทุก request ต้องมี token จากลิงก์ ลิงก์ใหม่จะสุ่มทุกครั้งที่เปิดโปรแกรม เว้นแต่ตั้ง `CHAT_TOKEN`
- ฟังเฉพาะ loopback เว้นแต่ตั้ง `CHAT_ALLOW_REMOTE=1` (ดูหัวข้อมือถือ)
- ตรวจ `Host` ทุก request (กัน DNS rebinding) และปฏิเสธ request ที่มี `Origin` เป็นเว็บอื่น (HTTP 403) request ที่ไม่มี `Origin` เช่นจากสคริปต์ handoff ผ่านได้ถ้ามี token
- ลิงก์ที่มี token พิมพ์ได้เฉพาะเมื่อ `CHAT_PRINT_URL` ไม่ใช่ `0` handoff ตั้งเป็น `0` เพื่อไม่ให้ token เข้า log และ token ถูกตัดออกจาก environment ที่ส่งให้ Claude และคำสั่งที่ Claude รัน

**สิ่งที่ Claude ทำไม่ได้ ในทุกโหมดสิทธิ์ (ไม่ใช่เฉพาะแชทจาก handoff)**

ใช้ทั้ง deny rule ของ SDK และตัวตรวจในโค้ด (hook `PreToolUse` และ `canUseTool`) ที่ปฏิเสธก่อนถึงการ์ดขออนุญาต

| เครื่องมือ | ห้าม |
|---|---|
| Edit / Write / NotebookEdit / MultiEdit | `.git/**`, `.claude/**`, `.github/**`, `.codex/**`, `**/.mcp.json`, `tools/claude-chat/**` (ที่ความลึกใดก็ได้), `**/package.json`, `**/package-lock.json`, `.env` และ `.env.*`, `.qa-local/claude-chat*` (state, sessions, log) |
| Read | `.env` และ `.env.*` (รวม `.env.example` เพราะ syntax ของ rule ไม่มี negation), `.qa-local/claude-chat*` อ่านไฟล์เดี่ยวใต้ `.qa-local/` เช่น checkpoint ยังทำได้ |
| Grep / Glob | ข้อห้ามเดียวกับ Read และ **ห้ามค้นใน `path` ใต้ `.qa-local/`** ห้าม pattern ของ Glob หรือ `glob` ของ Grep ที่ตรงกับ `.env` (รวมรูปแบบ `.e[n]v`, `.e?v`, `{.env,x}`) ที่ระบุ `claude-chat` ร่วมกับ wildcard หรือที่อยู่ใต้ `.qa-local` เมื่อส่วนสุดท้ายของ pattern อาจตรงกับไฟล์ state (เช่น `.qa-local/*`, `.qa-local/**`, `.qa-local/*.json`, `.qa-local/c*`) ส่วน pattern ที่ส่วนสุดท้ายตรงไม่ได้ เช่น `.qa-local/*.md` ทำได้ |
| ทุกเครื่องมือไฟล์ | path แบบ device/UNC (ขึ้นต้น `\\` หรือ `//` เช่น `\\?\C:\...`, `\\localhost\C$\...`), ชื่อสั้น Windows 8.3 (`ENV~1`), และ path จริง (realpath) ที่ชี้เข้าที่ห้าม รวมถึงไฟล์ใหม่ใต้ junction/symlink (ตรวจ path จริงของ folder บนสุดที่มีอยู่) |
| Bash | `git push` ที่มี `-f`, `--force`, `--force-with-lease`, `--mirror`, `--delete`, `-d`, refspec ขึ้นต้น `+` หรือ `:branch` ไม่สนตัวพิมพ์ของชื่อ `git`/`git.exe`, ตัดเครื่องหมายคำพูดและ backslash ตามที่ shell ทำ (`g\it`, `git -C "x y" push -f`); `git -c`/`--config-env` ที่ตั้ง alias หรือ `remote.*.push`/`remote.*.mirror`; `git config` ที่เขียนค่าเหล่านี้หรือ alias ที่มี push; `git send-pack` ที่มี force, `--mirror` หรือ refspec อันตราย; option ยาวที่เป็นตัวย่อของ option อันตรายตั้งแต่ 2 ตัวอักษรขึ้นไป (git รับตัวย่อที่ไม่กำกวม เช่น `--force-w`, `--mirr`, `--dele`, `--prun`); หลัง `--` ยังตรวจ refspec ขึ้นต้น `+` และ `:ref`; การตั้ง `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, `GIT_CONFIG_PARAMETERS` (ทั้งแบบกำหนดค่าและ `export`) ข้อความ commit ของ `git commit`/`tag`/`merge` (`-m`, `--message`) ไม่ถูกตรวจเป็นคำสั่ง ยกเว้นข้อความที่มี `$` หรือ backquote |
| Bash (tripwire ตามข้อความ) | คำสั่งที่มี `.env` (ยกเว้น `.env.example`), `claude-chat-state`/`claude-chat-sessions`/`claude-chat.log`, `ANTHROPIC_API_KEY`, `$env:` หรือ `Env:` (drive ของ PowerShell), `/proc/.../environ` หรือคำสั่งที่พิมพ์ environment ทั้งหมด ได้แก่ `env`/`printenv` ที่มีแต่ option (เช่น `env -0`, `env -u NAME`, `printenv -0`), `set` เปล่าๆ, `export`/`export -p`, `declare`/`typeset` เปล่าๆ หรือ `-p`/`-x`, `compgen -e` ส่วน `.env` ตรวจเฉพาะที่เป็นชื่อ path (ตามหลังช่องว่าง เครื่องหมายคำพูด `=` `/` `\` หรือตัวคั่นคำสั่ง) จึงไม่ตรงกับ `process.env` หรือ `prod.env` และข้อความ commit ตามข้างบนไม่ถูกตรวจ |

ข้อจำกัดที่ต้องรู้ (residual):

- เครื่องมือ **Bash ยังเข้าถึงไฟล์ได้** ตัวป้องกันข้างบนไม่ใช่ sandbox tripwire ตามข้อความเพียงลดช่องโหว่ ไม่ได้ปิด คำสั่งที่อำพรางตัว (เช่น `node -e` ที่ประกอบชื่อไฟล์เอง, glob, ตัวแปร, `Get-ChildItem Env:`, สคริปต์ที่เขียนไว้ก่อน) ยังผ่านไปถึงการ์ดขออนุญาตได้ จึงให้แชทจาก handoff ใช้โหมด `default` เจ้าของต้องอ่านทุกคำสั่งก่อนกดอนุญาต และ environment ของ Claude มี `ANTHROPIC_API_KEY` ที่คำสั่งอ่านได้โดยออกแบบ
- ตัวตรวจ `git push` เป็นการจับรูปแบบคำสั่ง รูปแบบอ้อม (ตัวแปร `$x push -f`, alias ที่ตั้งไว้ในไฟล์ config ก่อนแล้ว, สคริปต์) ยังไปถึงการ์ดขออนุญาต `git -c push.*` (เช่น `push.default`) ไม่ถูกปฏิเสธ และ `--f` ตัวอักษรเดียวไม่ถูกตรวจ (git ถือว่ากำกวมอยู่แล้ว) ส่วนกฎ deny ของ CLI แบบ `Bash(git push --force*)` ไม่ครอบคลุมตัวย่อ ตัวย่อถูกปฏิเสธโดยตัวตรวจในโค้ดเท่านั้น
- Grep ที่ไม่ระบุ `path` (ทั้ง repo) ยังทำได้ โดยพึ่ง ripgrep ที่เคารพ `.gitignore` (`.env` และ `.qa-local/` ถูก ignore) ยังไม่ยืนยันกับ CLI จริง เจ้าของควรตรวจสอบตอนใช้ key จริงครั้งแรก
- กฎ deny ของ SDK (glob `**/`) และการกรองผลของ Grep ใน CLI จริง ยังไม่ได้ทดสอบกับ key จริง ตัวตรวจในโค้ดเป็นชั้นสำรอง
- ค่าใช้จ่ายตอน resume อาจนับซ้ำ (ยอดสูงกว่าจริง ซึ่งปลอดภัยกว่า), Windows ไม่มีโหมด `0600` (พึ่ง ACL), โปรเซสในเครื่องที่ยึดพอร์ตที่บันทึกไว้ได้รับ token และ checkpoint ได้ (ต้องเป็นผู้ใช้เดียวกัน) และมีช่องว่างเล็กน้อยระหว่างตรวจสถานะกับเปิดแชทใหม่
- ถ้าต้องแก้ไฟล์ที่ห้ามไว้ ให้เจ้าของแก้เอง

**ค่าใช้จ่าย**

- `CHAT_MAX_BUDGET_USD` หยุดแต่ละรอบ ส่วนยอดสะสมของทั้งแชทดูที่มุมบน และตั้ง `CHAT_MAX_SESSION_USD` เพื่อหยุดทั้งแชท (ต้องเริ่มแชทใหม่ถึงทำต่อได้) ทั้งสองค่าเป็นการประมาณฝั่งโปรแกรม เพดานจริงคือ Spend limit ของ workspace ใน Console ตั้งไว้เสมอ

**ข้อมูลประจำตัวและเซสชัน**

- โปรแกรมตัดตัวแปร `CLAUDE*` และ `ANTHROPIC_*` (ไม่สนตัวพิมพ์เล็กใหญ่) ที่สืบทอดมาทิ้งก่อนเริ่ม Claude เพื่อไม่ให้ไปใช้สิทธิ์ subscription หรือ session ของ Claude Code ตัวอื่น และจะหยุดทันทีถ้า Claude รายงานว่าไม่ได้ใช้ `ANTHROPIC_API_KEY`
- ถ้าเปิดเองด้วย `npm start` แล้วตั้ง `ANTHROPIC_API_KEY` ไว้ใน shell ค่านั้นจะทับค่าใน `.env` (พฤติกรรมของ `node --env-file`) แต่ handoff ตัดตัวแปรนี้จาก shell ออกเสมอ
- รายการ "ประวัติ" และการเปิดแชทเดิมจำกัดเฉพาะแชทที่ Astra สร้างเอง (เก็บ session id ไว้ใน `.qa-local/claude-chat-sessions.json`) session อื่นของ Claude Code ใน repo เดียวกันไม่ถูกแสดงและเปิดไม่ได้ แชทที่สร้างก่อนเพิ่มกลไกนี้จะไม่แสดง
- `.env` ถูก `.gitignore` กันไว้แล้ว อย่าส่ง API key ให้ใคร
- กำชับให้ทำงานบน branch แยก ส่วนการ push ปกติจะเกิดหลังคุณกดอนุญาตคำสั่งนั้น (เว้นแต่เคยกด "อนุญาตเสมอ" ไว้ในแชทเดียวกัน)

## ค่าตั้งใน `.env`

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `ANTHROPIC_API_KEY` | (ต้องใส่) | Console API key จาก org ที่ผูกกับ Max |
| `CHAT_MODEL` | `claude-opus-5-5` | โมเดลเริ่มต้น |
| `CHAT_EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max` สูงขึ้นละเอียดขึ้นแต่แพงขึ้น |
| `CHAT_MAX_BUDGET_USD` | `5` | หยุดรอบงานเมื่อค่าประมาณถึงยอดนี้ ส่งข้อความต่อจะทำต่อในแชทเดิมด้วยงบรอบใหม่ |
| `CHAT_MAX_SESSION_USD` | (ไม่ตั้ง) | หยุดทั้งแชทเมื่อค่าประมาณสะสมถึงยอดนี้ |
| `CHAT_PERMISSION_MODE` | `acceptEdits` | สิทธิ์เริ่มต้น: `default` / `acceptEdits` / `plan` (handoff ใช้ `default`) |
| `CHAT_REPO_DIR` | repo ที่มีโฟลเดอร์นี้ | โฟลเดอร์ที่ให้ Claude ทำงาน |
| `CHAT_HOST` / `CHAT_PORT` | `127.0.0.1` / `8787` | ที่อยู่ของหน้าแชท ไม่ใช่ loopback ต้องตั้ง `CHAT_ALLOW_REMOTE=1` |
| `CHAT_ALLOW_REMOTE` | (ไม่ตั้ง) | `1` อนุญาต `CHAT_HOST` ที่ไม่ใช่ loopback |
| `CHAT_ALLOWED_HOSTS` | (ว่าง) | ค่า `Host` เพิ่มเติม (`ชื่อ:พอร์ต` คั่นด้วยจุลภาค) เช่นชื่อเครื่องใน Tailscale |
| `CHAT_PRINT_URL` | (พิมพ์) | `0` ไม่พิมพ์ลิงก์ที่มี token (handoff ตั้งให้) |
| `CHAT_TOKEN` | สุ่มใหม่ทุกครั้ง | token คงที่ (อย่างน้อย 24 ตัวอักษร) เพื่อให้ลิงก์ใช้ได้ต่อหลังรีสตาร์ท |

## ข้อความที่อาจเจอ

- **เครดิต API หมด…**: เครดิตเดือนนี้หมด รอรอบบิลถัดไปหรือซื้อเครดิตใน Console
- **API key ไม่ถูกต้อง…**: ตรวจ `ANTHROPIC_API_KEY` ใน `.env`
- **ถึงเพดานงบต่อรอบ…**: ถึง `CHAT_MAX_BUDGET_USD` ส่งข้อความต่อเพื่อทำต่อ
- **ถึงเพดานงบต่อแชท…**: ถึง `CHAT_MAX_SESSION_USD` เริ่มแชทใหม่เพื่อทำต่อ
- **หยุดทำงาน: Claude ไม่ได้ใช้ ANTHROPIC_API_KEY…**: มีการตั้งค่าบัญชีอื่นทับอยู่ (เช่น `apiKeyHelper` ใน `.claude/settings.json`) จึงหยุดไว้เพื่อไม่ให้เกิดค่าใช้จ่ายผิดบัญชี
- **Host not allowed / Origin not allowed**: เข้าด้วยชื่อหรือพอร์ตที่ไม่ตรงกับที่เซิร์ฟเวอร์ฟังอยู่ (ดูหัวข้อมือถือ)

## ข้อจำกัด

- ทำงานได้ทีละแชท เปิดหลายแท็บได้ แต่ทุกแท็บจะเห็นแชทเดียวกัน
- รันบนเครื่องของคุณ ไม่มี cloud sandbox แบบ Claude Code บนเว็บ
- โหลด `CLAUDE.md` และ `.claude/settings.json` ของ repo แต่ไม่โหลด settings ส่วนตัวใน `~/.claude`
- ยอดสะสมนับตั้งแต่เริ่มหรือโหลดแชทใน Astra (แชทที่เปิดจากประวัติเริ่มนับที่ 0)
- ทดสอบอัตโนมัติด้วย agent จำลองเท่านั้น: การใช้ key จริงและ Node 24 บน macOS/Linux ยังไม่ได้ทดสอบ (Windows ทดสอบด้วย Node 24 แล้ว)

## ทดสอบ

```sh
npm test
```

ชุดทดสอบใช้ agent จำลอง จึงไม่เรียก API และไม่เสียเครดิต (ครอบคลุม deny list, ตรวจ Host/Origin, force push, เพดานงบ, session ของ Astra และ handoff ด้วยเซิร์ฟเวอร์จำลอง) เทสต์ handoff ตัวหนึ่งรันสคริปต์จริงกับเซิร์ฟเวอร์จริงที่ไม่มี key เพื่อดูว่าจบเองและแจ้งให้ตั้ง key โดยจะข้ามไปถ้ามี `tools/claude-chat/.env` หรือไฟล์สถานะของ handoff อยู่