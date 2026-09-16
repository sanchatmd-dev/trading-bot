// Exact UI text translation; never translate user data, credentials, logs or JSON.
const uiPairs = [
['Overview','ภาพรวม'],['Trade log','ประวัติการเทรด'],['Risk manager','จัดการความเสี่ยง'],['Broker connections','เชื่อมต่อโบรกเกอร์'],['Account and License','บัญชีและ License'],['Admin dashboard','แผงควบคุมผู้ดูแล'],
['MULTI-BROKER EXECUTION PLATFORM','แพลตฟอร์มส่งคำสั่งหลายโบรกเกอร์'],['Refresh','รีเฟรช'],['Log out','ออกจากระบบ'],
['Sign in to Robot trade','เข้าสู่ Robot trade'],['Use the account created by your administrator','ใช้บัญชีที่ Admin สร้างให้'],['Email','อีเมล'],['Password','รหัสผ่าน'],['Show password','แสดงรหัสผ่านเพื่อรองรับ In-app Browser'],['Sign in','เข้าสู่ระบบ'],
['Paper staging only — Live is locked','Paper staging เท่านั้น — Live ถูกล็อก'],
['SL/TP are not broker protection orders. Fills are simulated instantly without fees. Kill switch pauses new entries but permits position-reducing orders.','SL/TP ยังไม่ใช่คำสั่งป้องกันที่ Broker · Fill จำลองทันทีและไม่รวมค่าธรรมเนียม · Kill switch หยุดเปิดใหม่ แต่ยังให้ส่งคำสั่งลดสถานะได้'],
['Mode','โหมด'],['Kill switch','หยุดเปิดสถานะใหม่'],['License','สิทธิ์ใช้งาน'],['Trades today','เทรดวันนี้'],['Recent signals','สัญญาณล่าสุด'],['Open positions','สถานะที่เปิดอยู่'],
['Execution & Error log','บันทึกคำสั่งและข้อผิดพลาด'],['Tracked from signal receipt to broker response','บันทึกตั้งแต่รับ Signal ถึง Broker response'],
['Received','เวลารับสัญญาณ'],['User','ผู้ใช้'],['Trade ID','รหัสการเทรด'],['Symbol','สัญลักษณ์'],['TF','กรอบเวลา'],['Event','เหตุการณ์'],['Entry / SL / TP','ราคาเข้า / SL / TP'],['Status','สถานะ'],['Order ID','รหัสคำสั่ง'],['Fill','ราคาจับคู่'],['Slippage','ส่วนต่างราคาจับคู่'],['Error / Response','ข้อผิดพลาด / ผลตอบกลับ'],['Rejected notes','หมายเหตุรายการที่ถูกปฏิเสธ'],['Save note','บันทึกหมายเหตุ'],
['Risk setting per user','ตั้งค่าความเสี่ยงรายผู้ใช้'],['Rechecked before execution · Per-broker account limits · UTC trading day','ตรวจซ้ำก่อนประมวลผล · จำกัดต่อบัญชี Broker · วันตัดยอด UTC'],['Save','บันทึก'],
['Max risk / trade (%)','ความเสี่ยงสูงสุดต่อเทรด (%)'],['Max trades / day','จำนวนเทรดสูงสุดต่อวัน'],['Max daily loss (R)','ขาดทุนสูงสุดต่อวัน (R)'],['Pause after loss streak','หยุดหลังขาดทุนติดต่อกัน'],['Max open positions','จำนวนสถานะเปิดสูงสุด'],['Max signal age (sec)','อายุสัญญาณสูงสุด (วินาที)'],['Max order notional','มูลค่าคำสั่งสูงสุด'],['Max daily notional','มูลค่ารวมสูงสุดต่อวัน'],['Max volatility (%)','ความผันผวนสูงสุด (%)'],['Side mode','ฝั่งที่อนุญาต'],['Allowed symbols','สัญลักษณ์ที่อนุญาต'],
['Paper Trading','เทรดจำลอง'],['One position per symbol (required)','One position per symbol (บังคับในรุ่นนี้)'],['Reduce-only Spot SELL','ขาย Spot เพื่อลดสถานะเท่านั้น'],['Block high volatility','ระงับเมื่อผันผวนสูง'],['Block during news','ระงับช่วงข่าว'],
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
['Forgot Password','ลืมรหัสผ่าน'],['Close','ปิด'],
['Ask your administrator to reset your password securely. Automatic email recovery is not configured.','ติดต่อผู้ดูแลให้รีเซ็ตรหัสผ่านอย่างปลอดภัย ยังไม่ได้ตั้งค่าการกู้รหัสผ่านทางอีเมลอัตโนมัติ'],
['VPS owner: sign in through SSH, then run the recovery command below. Enter the account email and a new password when prompted. No existing password is shown.','เจ้าของ VPS: เข้าผ่าน SSH แล้วรันคำสั่งกู้คืนด้านล่าง กรอกอีเมลบัญชีและรหัสผ่านใหม่เมื่อระบบถาม ระบบจะไม่แสดงรหัสผ่านเดิม'],
['Never send your password, webhook secret or broker API keys in chat.','อย่าส่งรหัสผ่าน รหัสลับ Webhook หรือ API key ของโบรกเกอร์ในแชต'],
['No rejection reason recorded','ไม่มีเหตุผลการปฏิเสธที่บันทึกไว้']
];
const uiTranslations = new Map();
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
