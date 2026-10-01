// Exact UI text translation; never translate user data, credentials, logs or JSON.
const uiPairs = [
['Overview','ภาพรวม'],['Trade log','ประวัติการเทรด'],['Risk manager','จัดการความเสี่ยง'],['Broker connections','เชื่อมต่อโบรกเกอร์'],['Account and License','บัญชีและ License'],['Admin dashboard','แผงควบคุมผู้ดูแล'],
['MULTI-BROKER EXECUTION PLATFORM','แพลตฟอร์มส่งคำสั่งหลายโบรกเกอร์'],['Refresh','รีเฟรช'],['Log out','ออกจากระบบ'],
['Sign in to Robot trade','เข้าสู่ Robot trade'],['Use the account created by your administrator','ใช้บัญชีที่ Admin สร้างให้'],['Email','อีเมล'],['Password','รหัสผ่าน'],['Show password','แสดงรหัสผ่านเพื่อรองรับ In-app Browser'],['Sign in','เข้าสู่ระบบ'],
['Paper staging only — Live is locked','Paper staging เท่านั้น — Live ถูกล็อก'],
['SL/TP are simulated, not broker protection orders. Bridge fills use their frozen fee and slippage model; generic Paper fills omit fees. Kill switch pauses new entries but permits position-reducing orders.','SL/TP เป็นการจำลอง ไม่ใช่คำสั่งป้องกันที่ Broker · Bridge ใช้ค่าธรรมเนียมและ slippage ตามรุ่นที่ล็อกไว้ ส่วน Paper ทั่วไปไม่รวมค่าธรรมเนียม · Kill switch หยุดเปิดใหม่ แต่ยังให้ลดสถานะได้'],
['Mode','โหมด'],['Kill switch','หยุดเปิดสถานะใหม่'],['License','สิทธิ์ใช้งาน'],['Trades today','เทรดวันนี้'],['Recent signals','สัญญาณล่าสุด'],['Open positions','สถานะที่เปิดอยู่'],
['Execution & Error log','บันทึกคำสั่งและข้อผิดพลาด'],['Tracked from signal receipt to broker response','บันทึกตั้งแต่รับ Signal ถึง Broker response'],
['Received','เวลารับสัญญาณ'],['User','ผู้ใช้'],['Trade ID','รหัสการเทรด'],['Symbol','สัญลักษณ์'],['TF','กรอบเวลา'],['Event','เหตุการณ์'],['Entry / SL / TP','ราคาเข้า / SL / TP'],['Status','สถานะ'],['Order ID','รหัสคำสั่ง'],['Fill','ราคาจับคู่'],['Slippage','ส่วนต่างราคาจับคู่'],['Error / Response','ข้อผิดพลาด / ผลตอบกลับ'],['Rejected notes','หมายเหตุรายการที่ถูกปฏิเสธ'],['Save note','บันทึกหมายเหตุ'],
['Risk setting per user','ตั้งค่าความเสี่ยงรายผู้ใช้'],['Rechecked before execution · Per-broker account limits · UTC trading day','ตรวจซ้ำก่อนประมวลผล · จำกัดต่อบัญชี Broker · วันตัดยอด UTC'],['Save','บันทึก'],
['Max risk / trade (%)','ความเสี่ยงสูงสุดต่อเทรด (%)'],['Max trades / day','จำนวนเทรดสูงสุดต่อวัน'],['Max daily loss (R)','ขาดทุนสูงสุดต่อวัน (R)'],['Pause after loss streak','หยุดหลังขาดทุนติดต่อกัน'],['Max open positions','จำนวนสถานะเปิดสูงสุด'],['Max signal age (sec)','อายุสัญญาณสูงสุด (วินาที)'],['Max order notional','มูลค่าคำสั่งสูงสุด'],['Max daily notional','มูลค่ารวมสูงสุดต่อวัน'],['Max volatility (%)','ความผันผวนสูงสุด (%)'],['Side mode','ฝั่งที่อนุญาต'],['Allowed symbols','สัญลักษณ์ที่อนุญาต'],
['Paper Trading','เทรดจำลอง'],['Block repeated entries for same symbol','บล็อกการเปิดเพิ่มใน Symbol เดิม'],['Reduce-only Spot SELL','ขาย Spot เพื่อลดสถานะเท่านั้น'],['Block high volatility','ระงับเมื่อผันผวนสูง'],['Block during news','ระงับช่วงข่าว'],
['Equity snapshot','ยอดเงินทุนอ้างอิง'],
['Binance Global: USD symbols use USDT equity (BTCUSD → BTCUSDT). This is a symbol alias, not a currency conversion. THB accounts remain THB.','Binance Global: สัญลักษณ์ USD ใช้ทุนหน่วย USDT (BTCUSD → BTCUSDT) เป็นการเทียบชื่อสัญลักษณ์ ไม่ใช่การแปลงสกุลเงิน บัญชี THB ยังคงเป็น THB'],
['Max Risk 100% is a ceiling, not a target. Stop loss, available equity and notional limits still apply.','Max Risk 100% คือเพดาน ไม่ใช่เป้าหมาย ระบบยังตรวจ Stop loss เงินทุนที่เหลือ และวงเงินคำสั่ง'],
['Encrypted Broker credentials','ข้อมูลเชื่อมต่อโบรกเกอร์ที่เข้ารหัส'],['AES-256-GCM encrypted storage','จัดเก็บแบบเข้ารหัส AES-256-GCM'],['Broker','โบรกเกอร์'],['Credentials JSON','ข้อมูลเชื่อมต่อ JSON'],['Enabled','เปิดใช้งาน'],['Encrypt and save','เข้ารหัสและบันทึก'],['Connections','การเชื่อมต่อ'],
['Live and Bridge are disabled in this release. Custom URLs are not accepted. Real API keys are not needed for Paper testing.','Live และ Bridge ถูกปิดในรุ่นนี้ ไม่รับ URL ที่ผู้ใช้กำหนดเอง และไม่จำเป็นต้องใส่ API key จริงเพื่อทดสอบ Paper'],
['User account','บัญชีผู้ใช้'],['License key','รหัสสิทธิ์ใช้งาน'],['Activate','เปิดใช้สิทธิ์'],['Webhook secret','รหัสลับ Webhook'],['Each user has a separate secret, shown only once','Secret แยกต่อผู้ใช้ และแสดงครั้งเดียว'],['Create / rotate secret','สร้าง / เปลี่ยน Secret'],['Not created yet','ยังไม่ได้สร้าง'],['Universal Webhook','เว็บฮุคมาตรฐาน'],
['Users','ผู้ใช้ทั้งหมด'],['Licenses','สิทธิ์ใช้งานทั้งหมด'],['Global Kill','หยุดเปิดสถานะทุกบัญชี'],['Change','เปลี่ยน'],['Create user','สร้าง User'],['Role','บทบาท'],['Create account','สร้างบัญชี'],['Create license','สร้าง License'],['Plan','แพ็กเกจ'],['Duration (days)','อายุ (วัน)'],['Shown only once','แสดงครั้งเดียว'],['Subscriptions / Licenses','การสมัครสมาชิก / สิทธิ์ใช้งาน'],
['Change password','เปลี่ยน Password'],['Current password','รหัสผ่านปัจจุบัน'],['New password (10+ characters)','รหัสผ่านใหม่ (อย่างน้อย 10 ตัวอักษร)'],
['No signals yet','ยังไม่มี Signal'],['No positions yet','ยังไม่มี Position'],['UTC · Totals separated by account','UTC · แยกยอดตามบัญชี'],
['Saved','บันทึกแล้ว'],['Encrypted and saved','เข้ารหัสและบันทึกแล้ว'],['Activated','เปิดใช้งานแล้ว'],['Created','สร้างแล้ว'],['The previous secret will stop working. Continue?','Secret เดิมจะใช้ไม่ได้ ยืนยัน?'],
['PAPER · LIVE LOCKED','จำลอง · ล็อกการเทรดจริง'],['ENTRIES PAUSED','หยุดเปิดสถานะใหม่ชั่วคราว'],['PAPER RUNNING','กำลังทำงานแบบจำลอง'],['SAVED · LIVE LOCKED','บันทึกแล้ว · ล็อกการเทรดจริง'],['DISABLED','ปิดใช้งาน'],['NOT SET','ยังไม่ได้ตั้งค่า'],['Toggle','สลับสถานะ'],['Response','ผลตอบกลับ'],['Offline','ออฟไลน์'],
['Forgot Password','ลืมรหัสผ่าน'],['Close','ปิด'],['Menu','เมนู'],['Close menu','ปิดเมนู'],
['Contact your administrator to reset your password securely.','ติดต่อผู้ดูแลเพื่อรีเซ็ตรหัสผ่านอย่างปลอดภัย'],
['Automatic email recovery is not configured. Never send your password, webhook secret or broker API keys in chat.','ยังไม่ได้ตั้งค่าการกู้รหัสผ่านทางอีเมลอัตโนมัติ อย่าส่งรหัสผ่าน รหัสลับ Webhook หรือ API key ของโบรกเกอร์ในแชต'],
['No rejection reason recorded','ไม่มีเหตุผลการปฏิเสธที่บันทึกไว้']
];
uiPairs.push(...[["Symbol / Event","สัญลักษณ์ / เหตุการณ์"],["Explanation","คำอธิบาย"],["Details / Notes","รายละเอียด / หมายเหตุ"],["Your current webhook is encrypted at rest and visible only in your signed-in account. Treat this URL like a password.","Webhook ปัจจุบันจัดเก็บแบบเข้ารหัสและแสดงเฉพาะบัญชีที่เข้าสู่ระบบ เก็บ URL นี้เป็นความลับเหมือนรหัสผ่าน"],["Current webhook","Webhook ปัจจุบัน"],["Copy webhook","คัดลอก Webhook"],["Existing webhook URL","URL Webhook เดิม"],["Verify and save current URL","ยืนยันและบันทึก URL ปัจจุบัน"],["Current URL is ready to copy.","URL ปัจจุบันพร้อมคัดลอก"],["Waiting for the next authenticated signal, or paste your existing URL below. No rotation is needed.","รอสัญญาณที่ยืนยันตัวตนสำเร็จครั้งถัดไป หรือวาง URL เดิมด้านล่าง ไม่ต้องเปลี่ยนรหัสลับ"],["Create a webhook to begin.","สร้าง Webhook เพื่อเริ่มใช้งาน"],["Copied","คัดลอกแล้ว"],["Select the URL and copy it with Ctrl+C or Command+C.","เลือก URL แล้วคัดลอกด้วย Ctrl+C หรือ Command+C"],["There is no open Spot position to close. Check that the earlier BUY was filled. TradingView does not receive fill confirmation; do not resend this exit as a BUY.","ไม่มีสถานะ Spot ให้ปิด ตรวจสอบว่า BUY ก่อนหน้าสำเร็จแล้วหรือไม่ TradingView ไม่ได้รับผลยืนยันการซื้อ อย่าส่งคำสั่งปิดนี้ซ้ำเป็น BUY"],["The calculated BUY exceeds available equity. A tight stop loss can make Percent Equity sizing very large. Reduce risk_value or use a smaller explicit quantity; do not remove the equity guard.","ขนาด BUY ที่คำนวณเกินทุนคงเหลือ Stop Loss ที่แคบทำให้ขนาด Percent Equity สูงมาก ลด risk_value หรือใช้จำนวนซื้อที่เล็กลง โดยไม่ปิดกฎตรวจทุน"],["This symbol is outside Allowed symbols. Review and add it in Risk manager only if you intend to trade it. USD and USDT aliases share the same Binance Global position.","สัญลักษณ์นี้ไม่อยู่ใน Allowed symbols ตรวจสอบและเพิ่มในหน้าความเสี่ยงเฉพาะเมื่อคุณต้องการเทรด USD และ USDT ใช้สถานะ Binance Global เดียวกัน"],["The signal requests more risk than your policy allows. Lower risk_value or review the risk limit. Old rejected orders are not retried automatically.","สัญญาณขอความเสี่ยงสูงกว่าที่กำหนด ลด risk_value หรือตรวจเพดานความเสี่ยง รายการเก่าที่ปฏิเสธจะไม่ถูกส่งซ้ำอัตโนมัติ"],["This account uses USDT quote currency. Binance Global accepts USD aliases and normalizes them to USDT; historical rejections remain unchanged.","บัญชีนี้ใช้คู่ราคา USDT โดย Binance Global รับชื่อ USD และแปลงเป็น USDT ส่วนรายการปฏิเสธเดิมจะไม่ถูกเปลี่ยน"],["The order exceeds Max order notional. Reduce the requested size or explicitly review that limit.","มูลค่าคำสั่งเกิน Max order notional ลดขนาดคำสั่งหรือตรวจเพดานนี้ก่อนเปลี่ยน"],["The daily notional budget is exhausted or insufficient. Reduce size or wait for the next UTC trading day.","วงเงินเทรดรายวันไม่พอหรือใช้หมดแล้ว ลดขนาดหรือรอวันใหม่ตามเวลา UTC"],["The signal is older than Max signal age. Use TradingView timenow as timestamp and investigate delivery delays; do not replay stale signals.","สัญญาณเก่ากว่า Max signal age ใช้ timenow ของ TradingView เป็น timestamp และตรวจความล่าช้า ไม่ควรส่งสัญญาณเก่าซ้ำ"],["Repeated-symbol entries are blocked by the current Risk Manager setting. Turn off Block repeated entries for same symbol only if scale-in is intended.","Risk Manager กำลังบล็อกการเปิดเพิ่มใน Symbol เดิม ปิด Block repeated entries for same symbol เมื่อต้องการเพิ่ม Position เท่านั้น"],["This rejection came from an older release. New unique trade_id entries can scale into an existing symbol when the repeated-symbol block is off.","รายการนี้ถูกปฏิเสธโดยเวอร์ชันเดิม ปัจจุบันใช้ trade_id ใหม่เพื่อเพิ่ม Position ใน Symbol เดิมได้เมื่อปิดตัวเลือกบล็อก"],["An entry protection rule rejected this order. Review the original reason below and the Risk manager settings. Nothing was sent to a live broker.","กฎป้องกันการเปิดสถานะปฏิเสธคำสั่งนี้ ตรวจเหตุผลต้นฉบับด้านล่างและหน้าความเสี่ยง ไม่มีคำสั่งถูกส่งไปโบรกเกอร์จริง"]]);
const rejectionHelp={"No Spot position available to sell":"There is no open Spot position to close. Check that the earlier BUY was filled. TradingView does not receive fill confirmation; do not resend this exit as a BUY.","Order exceeds available configured Spot equity":"The calculated BUY exceeds available equity. A tight stop loss can make Percent Equity sizing very large. Reduce risk_value or use a smaller explicit quantity; do not remove the equity guard.","Symbol is not allowed":"This symbol is outside Allowed symbols. Review and add it in Risk manager only if you intend to trade it. USD and USDT aliases share the same Binance Global position.","Risk percent exceeds policy":"The signal requests more risk than your policy allows. Lower risk_value or review the risk limit. Old rejected orders are not retried automatically.","Calculated risk exceeds maximum risk percent":"The signal requests more risk than your policy allows. Lower risk_value or review the risk limit. Old rejected orders are not retried automatically.","This account supports USDT quote currency only":"This account uses USDT quote currency. Binance Global accepts USD aliases and normalizes them to USDT; historical rejections remain unchanged.","Maximum order notional exceeded":"The order exceeds Max order notional. Reduce the requested size or explicitly review that limit.","Maximum daily notional exceeded":"The daily notional budget is exhausted or insufficient. Reduce size or wait for the next UTC trading day.","Signal is stale":"The signal is older than Max signal age. Use TradingView timenow as timestamp and investigate delivery delays; do not replay stale signals.","Position or pending order already exists for symbol":"Repeated-symbol entries are blocked by the current Risk Manager setting. Turn off Block repeated entries for same symbol only if scale-in is intended.","Scale-in is disabled until aggregate position risk is supported":"This rejection came from an older release. New unique trade_id entries can scale into an existing symbol when the repeated-symbol block is off."};
function explainRejection(reason){return translate(rejectionHelp[reason]||"An entry protection rule rejected this order. Review the original reason below and the Risk manager settings. Nothing was sent to a live broker.");}
uiPairs.push(['Cap Percent Equity size to available funds and notional limits','ลดขนาด Percent Equity อัตโนมัติให้ไม่เกินทุนและเพดานมูลค่าคำสั่ง']);
uiPairs.push(
  ['Configured Paper capital','ทุน Paper ที่กำหนด'],
  ['These inputs are cumulative funding, not current balances. Changes add or withdraw capital without resetting PnL. Preview includes unsaved funding changes.','ช่องนี้คือทุนสะสม ไม่ใช่ยอดคงเหลือปัจจุบัน การแก้ค่าคือเพิ่มหรือลดทุนโดยไม่ล้างกำไรขาดทุน Preview รวมค่าทุนที่ยังไม่บันทึก'],
  ['Current Paper ledger','ยอดบัญชี Paper ปัจจุบัน'],
  ['Cash includes fills and recorded fees. Book equity uses position cost, not live market prices. Currencies are never combined.','เงินสดรวมผลซื้อขายและค่าธรรมเนียมที่บันทึกแล้ว ทุนตามบัญชีใช้ต้นทุน Position ไม่ใช่ราคาตลาดสด และไม่รวมข้ามสกุลเงิน'],
  ['Cash','เงินสด'],['Book equity','ทุนตามบัญชี'],['Closed round trips','รอบเทรดที่ปิดครบ'],
  ['Realized net profit','กำไรสุทธิที่รับรู้'],['Realized max drawdown','Drawdown ที่รับรู้สูงสุด'],
  ['Trades count completed flat-to-flat cycles. PnL and drawdown include partial exits and exclude unrealized moves. Custom fees affect analytics only.','จำนวนเทรดนับรอบตั้งแต่เปิดจนปิดหมด กำไรขาดทุนและ Drawdown รวมการขายบางส่วน แต่ไม่รวมราคาที่ยังไม่รับรู้ ค่าธรรมเนียมกำหนดเองมีผลเฉพาะ Analytics'],
  ['Percentages unavailable: funding changed in this period or legacy funding history is incomplete.','ไม่แสดงเปอร์เซ็นต์: มีการเปลี่ยนทุนในช่วงนี้ หรือไม่มีประวัติทุนเดิมครบถ้วน']
);
uiPairs.push(
  ['Default values seed the calculator. Max Values are enforced by the bot. UTC trading day.','ค่า Default ใช้เติมเครื่องคำนวณ ส่วน Max Value คือเพดานที่ Bot บังคับใช้ วันตัดยอด UTC'],
  ['Setting','รายการ'],['Default','ค่าเริ่มต้น'],['Max Value','ค่าสูงสุด'],
  ['Risk / trade (%)','ความเสี่ยง / เทรด (%)'],['Trades / day','จำนวนเทรด / วัน'],['Daily loss (R)','ขาดทุนต่อวัน (R)'],
  ['Loss streak pause','หยุดหลังขาดทุนติดต่อกัน'],['Open positions','จำนวน Position ที่เปิด'],['Signal age (sec)','อายุสัญญาณ (วินาที)'],
  ['Order notional','มูลค่าคำสั่ง'],['Daily notional','มูลค่ารวมต่อวัน'],['Volatility (%)','ความผันผวน (%)'],
  ['Account funds','เงินทุนบัญชี'],['Total Equity','Total Equity'],['Balance','Balance'],
  ['Total Equity limits portfolio risk. Balance is cash currently available to buy and cannot exceed Total Equity.','Total Equity ใช้จำกัดความเสี่ยงของพอร์ต ส่วน Balance คือเงินสดที่พร้อมซื้อและต้องไม่เกิน Total Equity'],
  ['Real-time order check','ตรวจสอบคำสั่งแบบ Real-time'],['Uses the same risk engine as incoming TradingView signals. Preview only; no order is created.','ใช้ Risk Engine เดียวกับสัญญาณ TradingView เป็นเพียงการคำนวณล่วงหน้าและไม่สร้างคำสั่งซื้อ'],
  ['Entry','ราคาเข้า'],['Stop Loss','Stop Loss'],['Risk (%)','ความเสี่ยง (%)'],['Enter price and Stop Loss','กรอกราคาเข้าและ Stop Loss'],
  ['Risk amount','จำนวนเงินที่เสี่ยง'],['Order quantity','จำนวนสินทรัพย์'],['Order notional','มูลค่าคำสั่ง'],['Free balance','Balance คงเหลือ'],
  ['Open / Remaining slots','เปิดอยู่ / เปิดเพิ่มได้'],['Positions this size','จำนวน Position ที่เปิดได้ด้วยขนาดนี้'],
  ['Checking…','กำลังตรวจสอบ…'],['Likely accepted','มีแนวโน้มผ่าน'],['Would be rejected','จะถูกปฏิเสธ'],['Check input','ตรวจสอบข้อมูล'],
  ['Order size will be reduced to remain within available funds and limits.','ระบบจะลดขนาดคำสั่งให้ไม่เกินเงินทุนและเพดานที่ตั้งไว้'],
  ['All current checks passed.','ผ่านการตรวจสอบทั้งหมดในขณะนี้']
);
uiPairs.push(
  ['Analytics','วิเคราะห์ผลการเทรด'],['User','ผู้ใช้'],['Currency','สกุลเงิน'],['Asset','สินทรัพย์'],['All assets','ทุกสินทรัพย์'],
  ['Custom fee (bps)','ค่าธรรมเนียมกำหนดเอง (bps)'],['Daily','รายวัน'],['Weekly','รายสัปดาห์'],['Monthly','รายเดือน'],['Annually','รายปี'],['Custom','กำหนดเอง'],['From','จาก'],['To','ถึง'],
  ['Equity curve','กราฟ Equity'],['Cumulative realized PnL and drawdown','กำไรขาดทุนสะสมและ Drawdown'],['Win / Loss','ชนะ / แพ้'],['Asset performance','ผลลัพธ์รายสินทรัพย์'],['Closed positions','Position ที่ปิดแล้ว'],
  ['Total trades','จำนวนเทรดทั้งหมด'],['Win rate','อัตราชนะ'],['Net profit','กำไรสุทธิ'],['Profit factor','Profit factor'],['Max drawdown','Drawdown สูงสุด'],['Expectancy','กำไรคาดหวัง'],
  ['Avg win / loss','กำไรเฉลี่ย / ขาดทุนเฉลี่ย'],['Max win streak','ชนะต่อเนื่องสูงสุด'],['Max loss streak','แพ้ต่อเนื่องสูงสุด'],['Average holding','เวลาถือเฉลี่ย'],['Fee impact','ผลกระทบค่าธรรมเนียม'],['Starting equity','Equity เริ่มต้น'],
  ['Wins','ชนะ'],['Losses','แพ้'],['Breakeven','เท่าทุน'],['Closed','เวลาปิด'],['Entry / Exit','เข้า / ออก'],['Fees','ค่าธรรมเนียม'],['Holding','เวลาถือ'],
  ['No closed positions in this period','ไม่มี Position ปิดในช่วงนี้'],['Loading analytics…','กำลังโหลดข้อมูลวิเคราะห์…']
);
rejectionHelp['Order exceeds available configured Spot balance']='The calculated BUY exceeds available balance. Increase Balance only when it reflects actual available cash, or reduce the order size.';
rejectionHelp['No remaining Spot sizing budget']='No usable balance or daily budget remains for another Spot entry.';
uiPairs.push(
  ['The calculated BUY exceeds available balance. Increase Balance only when it reflects actual available cash, or reduce the order size.','ขนาด BUY เกิน Balance ที่พร้อมใช้ เพิ่ม Balance เฉพาะเมื่อเป็นเงินสดที่มีอยู่จริง หรือลดขนาดคำสั่ง'],
  ['No usable balance or daily budget remains for another Spot entry.','ไม่มี Balance หรือวงเงินรายวันเหลือสำหรับเปิด Position เพิ่ม']
);
uiPairs.push(
 ['Confirm identity','ยืนยันตัวตน'],['Confirm','ยืนยัน'],['Verify','ตรวจสอบ'],['Back to sign in','กลับไปเข้าสู่ระบบ'],
 ['After confirmation, retry your action.','หลังยืนยันตัวตน กรุณาทำรายการอีกครั้ง'],
 ['Authenticator or recovery code','รหัส Authenticator หรือรหัสกู้คืน'],
 ['Send recovery link','ส่งลิงก์กู้รหัสผ่าน'],['Reset password','ตั้งรหัสผ่านใหม่'],
 ['Password reset. Sign in with your new password.','ตั้งรหัสผ่านใหม่แล้ว เข้าสู่ระบบด้วยรหัสผ่านใหม่'],
 ['If this account is eligible, a recovery link will be sent. Check your email or contact your administrator.','หากบัญชีนี้ใช้การกู้คืนได้ ระบบจะส่งลิงก์ให้ ตรวจอีเมลหรือติดต่อผู้ดูแล']
);
const uiTranslations = new Map();
uiPairs.push(['Bot Manager','จัดการ Bot'],['Select one bot for this operation','เลือก Bot หนึ่งตัวก่อนทำรายการ']);
// Trading Control Panel labels
uiPairs.push(
  // Lifecycle button labels
  ['Run','รัน'],['Pause','หยุดพัก'],['Stop','หยุด'],['Reset','รีเซ็ต'],
  // State badges
  ['SETUP','ตั้งค่า'],['RUNNING','กำลังทำงาน'],['PAUSED','หยุดพัก'],['STOPPED','หยุด'],
  // Mode badges
  ['PAPER','จำลอง'],['LIVE','เงินจริง'],
  // Readiness & status messages
  ['Ready to start','พร้อมเริ่มทำงาน'],
  ['Save settings first','บันทึกการตั้งค่าก่อน'],
  ['Settings are invalid','ค่าตั้งไม่ถูกต้อง'],
  ['Unsaved changes — save first','มีการเปลี่ยนแปลงที่ยังไม่บันทึก'],
  ['Loading…','กำลังโหลด…'],
  ['Saving…','กำลังบันทึก…'],
  ['Connections verified','การเชื่อมต่อถูกต้อง'],
  ['Cannot start: no funded broker','ไม่สามารถเริ่มได้: ยังไม่มีทุนในโบรกเกอร์'],
  ['Bot is running','Bot กำลังทำงาน'],
  ['Bot is paused','Bot หยุดพักชั่วคราว'],
  ['Bot is stopped','Bot หยุดทำงาน'],
  ['Select a single bot to run','เลือก Bot ก่อนเริ่มทำงาน'],
  // Account card labels
  ['EQUITY','ทุนตามบัญชี'],['BALANCE','เงินสด'],
  ['Updated','อัปเดต'],['just now','เพิ่งอัปเดต'],
  ['Stale data — refresh to update','ข้อมูลเก่า กด Refresh เพื่ออัปเดต'],
  // Disabled button reasons (for aria-label / title)
  ['Not available in SETUP state','ไม่พร้อมใช้ในสถานะตั้งค่า'],
  ['Not available while running','ไม่พร้อมใช้ขณะทำงาน'],
  ['Not available while paused','ไม่พร้อมใช้ขณะหยุดพัก'],
  ['Not available in STOPPED state','ไม่พร้อมใช้ในสถานะหยุด'],
  ['Save and fix settings to run','บันทึกและแก้ไขการตั้งค่าก่อนเริ่ม'],
  // Risk summary
  ['Capital','ทุน'],['Per-trade','ต่อเทรด'],['Daily Loss','ขาดทุนต่อวัน'],
  // Confirmation dialog — Stop
  ['Stop bot?','หยุด Bot?'],
  ['Stopping blocks all incoming signals, including protective exit signals. Open positions are NOT automatically closed.','การหยุดจะบล็อกสัญญาณทั้งหมด รวมถึงสัญญาณออกเพื่อป้องกันความเสี่ยง Position ที่เปิดอยู่จะไม่ถูกปิดอัตโนมัติ'],
  ['Yes, stop bot','ยืนยัน หยุด Bot'],
  // Confirmation dialog — Reset
  ['Reset session?','รีเซ็ต Session?'],
  ['This archives the current session. Trade history, balances, and PnL are preserved. The bot returns to SETUP state.','การรีเซ็ตจะ archive Session ปัจจุบัน ประวัติการเทรด ยอดเงิน และกำไรขาดทุนจะยังคงอยู่ Bot จะกลับสู่สถานะตั้งค่า'],
  ['Yes, reset session','ยืนยัน รีเซ็ต Session'],
  ['Cancel','ยกเลิก'],
  // TCP panel header
  ['Trading Control Panel','แผงควบคุมการเทรด'],
  ['Daily Profit','กำไรวันนี้'],['Win Rate','อัตราชนะ'],
  // All Bots scope card
  ['All Bots','รวมทุก Bot'],
  ['Total portfolio value','มูลค่าพอร์ตรวม'],
  ['Combined daily P/L','กำไรขาดทุนรวมวันนี้'],
  ['Read-Only','อ่านอย่างเดียว'],
  ['All Bots: overview and trade log only. Select a bot to edit settings.','ทุก Bot: ดูภาพรวมและประวัติ เลือก Bot ก่อนแก้การตั้งค่า']
);
// Prototype journey (P0 staging preview). One named block so a test can prove these pairs stay unique and complete.
const journeyPairs=[
  ['Prototype journey','เส้นทางต้นแบบ'],
  ['Staging preview (P0). This page shows what runs on this staging release now and what each step still needs. It is not six-step acceptance. Paper only; Live is locked.','พรีวิวบน Staging (P0) หน้านี้แสดงสิ่งที่ทำงานอยู่บน Staging รุ่นนี้ในตอนนี้ และสิ่งที่แต่ละขั้นตอนยังต้องมีเพิ่ม ไม่ใช่การรับรองครบทั้งหกขั้นตอน ใช้ Paper เท่านั้น ส่วน Live ถูกล็อก'],
  ['Available now','ใช้งานได้ตอนนี้'],['Evidence','หลักฐาน'],['Next dependency','สิ่งที่ต้องมีขั้นถัดไป'],['Open','เปิดดู'],
  ['Live on staging','ใช้งานได้บน Staging'],['Unavailable','ไม่พร้อมใช้งาน'],['Partial','ทำได้บางส่วน'],['Preview available','ดูตัวอย่างได้'],
  ['Receiving','กำลังรับสัญญาณ'],['Idle','ไม่มีสัญญาณเข้า'],['Admission open','เปิดรับงาน'],['Paused — admission closed','หยุดชั่วคราว — ปิดรับงาน'],['Planned','วางแผนไว้'],
  ['Ten numeric inputs','Input ตัวเลขสิบตัว'],['Preflight and Risk settings','Preflight และการตั้งค่า Risk'],['Real signals and Paper execution','สัญญาณจริงและการทำงานแบบ Paper'],
  ['Quant optimizer','ตัวปรับค่าเหมาะสม Quant'],['Quant Library and selection','Quant Library และการคัดเลือก'],
  ['Not available','ไม่มีข้อมูล'],['Not configured','ยังไม่ได้กำหนดค่า'],['Not recorded','ไม่ได้บันทึกไว้'],['None yet','ยังไม่มี'],['Yes','ใช่'],['No','ไม่ใช่'],
  ['Main Bot','Bot หลัก'],['draft returned','ได้รับฉบับร่างแล้ว'],['Status checked: {time}','ตรวจสถานะเมื่อ: {time}'],
  ['Bridge is disabled on this release.','Bridge ถูกปิดในรุ่นนี้'],
  ['AI provider','ผู้ให้บริการ AI'],['Analyzed sources','ซอร์สที่วิเคราะห์แล้ว'],['Latest source','ซอร์สล่าสุด'],['Source hash','Hash ของซอร์ส'],
  ['AI jobs','งาน AI'],['Latest job','งานล่าสุด'],['AI usage (latest job)','การใช้ AI (งานล่าสุด)'],
  ['{input} in / {output} out tokens · USD {cost}','Token เข้า {input} / ออก {output} · USD {cost}'],['Diagnostic','ข้อมูลวินิจฉัย'],
  ['Latest research run','การรันวิจัยล่าสุด'],['Source slots in run','Slot ซอร์สในการรัน'],['ATR multiplier grid','ตารางค่า ATR multiplier'],['RR grid','ตารางค่า RR'],
  ['{min}–{max} ({count} values)','{min}–{max} ({count} ค่า)'],
  ['Numeric inputs','Input ตัวเลข'],['Eligible numeric inputs','Input ตัวเลขที่ใช้ได้'],['Input review confirmed','ยืนยันการตรวจ Input แล้ว'],['Selected source slots','Slot ซอร์สที่เลือก'],
  ['Input details are not available for the latest source.','ไม่มีรายละเอียด Input ของซอร์สล่าสุด'],
  ['No analyzed source or research run yet.','ยังไม่มีซอร์สที่วิเคราะห์หรือการรันวิจัย'],
  ['Bot session','Session ของ Bot'],['Paper accounts','บัญชี Paper'],['Bots','จำนวน Bot'],['Ready Bridge deployments','Bridge deployment ที่พร้อมใช้'],
  ['Latest ready deployment','Deployment ที่พร้อมล่าสุด'],['Snapshot hash','Hash ของ Snapshot'],
  ['Bot scope','ขอบเขต Bot'],['Signals received (24 h)','สัญญาณที่รับ (24 ชม.)'],['Filled (24 h)','จับคู่แล้ว (24 ชม.)'],['Rejected (24 h)','ถูกปฏิเสธ (24 ชม.)'],
  ['Latest signal received','สัญญาณล่าสุดที่รับ'],['Counts cover the latest 200 loaded signals.','จำนวนนับครอบคลุมสัญญาณล่าสุด 200 รายการที่โหลดไว้'],
  ['No research runs recorded yet.','ยังไม่มีการรันวิจัยที่บันทึกไว้'],['Latest run status','สถานะการรันล่าสุด'],['Candidates','Candidate (เสร็จ / ตามแผน)'],
  ['Run ID','รหัสรัน'],['Dataset hash','Hash ของ Dataset'],['Created (UTC)','สร้างเมื่อ (UTC)'],['Completion reason','เหตุผลที่จบการรัน'],
  ['{n} preserved research runs (history only)','{n} การรันวิจัยที่เก็บรักษาไว้ (เฉพาะประวัติ)'],['{done}/{planned} Candidates','{done}/{planned} Candidate'],
  ['Quant Lab → Build Pine Bridge: inspect inputs locally (no AI), then Analyze/Generate sends the authorized indicator to the configured AI provider and returns a draft Pine with a guide.','Quant Lab → Build Pine Bridge: ตรวจ Input ในเครื่องก่อน (ไม่ใช้ AI) แล้วกด Analyze/Generate เพื่อส่ง Indicator ที่ได้รับอนุญาตไปยัง AI provider ที่ตั้งค่าไว้ และรับ Pine ฉบับร่างพร้อมคู่มือกลับมา'],
  ['Re-verify one fresh end-to-end AI job on this release.','ทดสอบงาน AI แบบครบวงจรใหม่หนึ่งงานบนรุ่นนี้อีกครั้ง'],
  ['Contract supports 2–10 slots: up to eight selected numeric source inputs plus Bridge ATR Multiplier and RR.','Contract รองรับ 2–10 slot: Input ตัวเลขจากซอร์สที่เลือกได้สูงสุดแปดตัว บวก Bridge ATR Multiplier และ RR'],
  ['Select a supported source with eight eligible numeric inputs and round-trip all ten through UI, generated Pine and stored snapshot.','เลือกซอร์สที่รองรับและมี Input ตัวเลขที่ใช้ได้แปดตัว แล้วตรวจให้ครบทั้งสิบตัวผ่าน UI, Pine ที่สร้างขึ้น และ Snapshot ที่บันทึกไว้'],
  ['Risk manager → Order Preview: saved or hypothetical Draft authority, Generic or Bridge mode, venue filters and cost estimates. A preview saves nothing.','Risk manager → Order Preview: ใช้สิทธิ์ตามที่บันทึกไว้หรือแบบ Draft สมมติ โหมด Generic หรือ Bridge พร้อม venue filter และประมาณการต้นทุน การ Preview ไม่บันทึกอะไรทั้งสิ้น'],
  ['Historical Preflight on staging (PF-2/R7), PF-3 report and PF-4 deterministic recommendations with before/after values and explicit save.','Historical Preflight บน Staging (PF-2/R7), รายงาน PF-3 และข้อเสนอแนะแบบกำหนดผลได้ PF-4 พร้อมค่าก่อน/หลัง และการบันทึกที่ผู้ใช้ยืนยันเอง'],
  ['Trade log shows each signal from receipt through the Risk decision to the simulated Paper fill. Live trading stays locked.','Trade log แสดงแต่ละสัญญาณตั้งแต่รับสัญญาณ ผ่านการตัดสินใจของ Risk จนถึงการจับคู่จำลองของ Paper ส่วนการเทรดจริง (Live) ยังคงถูกล็อก'],
  ['Trace one real TradingView BUY and targeted EXIT with ledger evidence in a bounded observation window.','ติดตาม BUY จริงจาก TradingView หนึ่งรายการและ EXIT ที่ระบุเป้าหมาย พร้อมหลักฐานใน ledger ภายในช่วงสังเกตการณ์ที่จำกัด'],
  ['Historical runs appear with their original run identity. New research jobs stay closed until the foundation gates pass.','การรันในอดีตแสดงพร้อมรหัสรันเดิม งานวิจัยใหม่ยังปิดอยู่จนกว่าจะผ่าน foundation gate'],
  ['Foundation migration and startup (B2), one bounded dataset (B3), diagnostics (W7), D6/R7, then one admitted bounded job with declared budget and holdout rules.','Foundation migration และ startup (B2), dataset แบบจำกัดหนึ่งชุด (B3), diagnostics (W7), D6/R7 จากนั้นรับงานแบบจำกัดหนึ่งงานพร้อมงบประมาณและกฎ holdout ที่ประกาศไว้'],
  ['History lists preserved runs, including failures. It is not a qualified recommendation; no qualified winner exists.','ประวัติแสดงการรันที่เก็บรักษาไว้ รวมถึงรายการที่ล้มเหลว ไม่ใช่คำแนะนำที่ผ่านเกณฑ์ และยังไม่มีผู้ชนะที่ผ่านเกณฑ์'],
  ['QR-1 durable library storage and view, QR-3 comparison and QR-4 qualification.','QR-1 การจัดเก็บและแสดง Library แบบถาวร, QR-3 การเปรียบเทียบ และ QR-4 การคัดกรองคุณสมบัติ']
];
uiPairs.push(...journeyPairs);
for (const [en,th] of uiPairs) {uiTranslations.set(en,{en,th});uiTranslations.set(th,{en,th});}
let uiLanguage='en';
try {if(localStorage.getItem('robotLanguage')==='th')uiLanguage='th';} catch {}
function translate(text) {return uiTranslations.get(text)?.[uiLanguage]??text;}
const originalUiText=new WeakMap(), originalUiAttributes=new WeakMap();
function translateUI(){
  if(!document?.body)return;
  document.documentElement.lang=uiLanguage;
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let node;
  while((node=walker.nextNode())){
    if(node.parentElement.closest('script,style,pre,textarea,#signalRows,#recentSignals .list-row,#positions .list-row,#accountInfo p,#userRows,#licenseRows,#webhookResult,#newLicenseResult,#loginError,#passwordMessage'))continue;
    const current=node.textContent.trim(),old=originalUiText.get(node);
    // Retain canonical text through language toggles, but detect renderer updates.
    const source=old&&(current===old.en||current===old.th)?old:uiTranslations.get(current);
    if(!source)continue;
    originalUiText.set(node,source);
    if(current!==source[uiLanguage])node.textContent=node.textContent.replace(current,source[uiLanguage]);
  }
  for(const element of document.querySelectorAll('input[placeholder],button.save-note,textarea.review-note')){
    const attr=element.matches('input')?'placeholder':element.matches('textarea')?'aria-label':null;
    const current=attr?element.getAttribute(attr):element.textContent;
    const source=originalUiAttributes.get(element)||uiTranslations.get(current);
    if(source){originalUiAttributes.set(element,source);if(attr)element.setAttribute(attr,source[uiLanguage]);else if(current!==source[uiLanguage])element.textContent=source[uiLanguage];}
  }
  for(const element of document.querySelectorAll('[data-rejection]')){const text=explainRejection(element.dataset.rejection);if(element.textContent!==text)element.textContent=text;}
  for(const element of document.querySelectorAll('[data-ui-label]')){const text=translate(element.dataset.uiLabel);if(element.textContent!==text)element.textContent=text;}
  document.querySelector('#language').value=uiLanguage;
}
let saveToastTimer;
function showSaved(){
  const toast=document.querySelector('#saveToast');
  toast.textContent=translate('Saved');toast.hidden=false;
  clearTimeout(saveToastTimer);saveToastTimer=setTimeout(()=>{toast.hidden=true;},3500);
}
document.querySelector('#language').addEventListener('change',event=>{
  uiLanguage=event.target.value==='th'?'th':'en';
  try{localStorage.setItem('robotLanguage',uiLanguage);}catch{}
  translateUI();
});
document.querySelector('#forgotPassword').addEventListener('click',()=>document.querySelector('#recoveryDialog').showModal());
translateUI();
new MutationObserver(translateUI).observe(document.body,{childList:true,subtree:true,characterData:true});
try {if(sessionStorage.getItem('robotSaved')){sessionStorage.removeItem('robotSaved');showSaved();}}catch{}
