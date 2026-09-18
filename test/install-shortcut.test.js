import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source = fs.readFileSync(new URL('../public/install-shortcut.js', import.meta.url), 'utf8');
function fixture({installed=false, ua='iPhone', dismissed=false}={}) {
  const dom = new JSDOM('<select id="language"><option value="en">EN</option><option value="th">TH</option></select><input>', {url:'https://robot.test', runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window;
  Object.defineProperty(w.navigator, 'userAgent', {value:ua});
  w.matchMedia = () => ({matches:installed, addEventListener(){}});
  w.HTMLDialogElement.prototype.showModal = function(){this.open=true;};
  w.HTMLDialogElement.prototype.close = function(){this.open=false;};
  let show = () => {};
  w.setTimeout = fn => {show=fn;};
  if(dismissed) w.localStorage.setItem('robotInstallDismissedUntil', String(Date.now()+86400000));
  w.eval(source);
  return {w, show:()=>show(), dialog:()=>w.document.querySelector('dialog'), close:()=>w.close()};
}
test('shortcut guidance respects installed state, desktop, cooldown and active input', () => {
  for(const options of [{installed:true},{ua:'Desktop'},{dismissed:true}]) {
    const f=fixture(options);
    try {f.show(); assert.ok(!f.dialog()?.open);} finally {f.close();}
  }
  const f=fixture();
  try {f.w.document.querySelector('input').focus(); f.show(); assert.equal(f.dialog().open,false);} finally {f.close();}
});
test('iOS guidance translates and dismissal survives reload', () => {
  const f=fixture();
  try {
    f.show(); assert.equal(f.dialog().open,true);
    assert.match(f.dialog().textContent,/Safari/);
    const language=f.w.document.querySelector('select');
    language.value='th'; language.dispatchEvent(new f.w.Event('change'));
    assert.match(f.dialog().textContent,/หน้าจอโฮม/);
    f.dialog().querySelector('.install-later').click();
    assert.equal(f.dialog().open,false);
    assert.ok(Number(f.w.localStorage.getItem('robotInstallDismissedUntil'))>Date.now());
    f.show(); assert.equal(f.dialog().open,false);
  } finally {f.close();}
});
test('Android invokes native install prompt only from user click and stops after install', async () => {
  const f=fixture({ua:'Android'});
  try {
    let prompts=0;
    const event=new f.w.Event('beforeinstallprompt',{cancelable:true});
    event.prompt=async()=>{prompts++;}; event.userChoice=Promise.resolve({outcome:'accepted'});
    f.w.dispatchEvent(event); assert.equal(event.defaultPrevented,true);
    f.show(); assert.equal(prompts,0);
    assert.equal(f.dialog().querySelector('.install-now').hidden,false);
    f.dialog().querySelector('.install-now').click();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(prompts,1); assert.equal(f.dialog().open,false);
    f.w.dispatchEvent(new f.w.Event('appinstalled')); f.show();
    assert.equal(f.dialog().open,false);
  } finally {f.close();}
});
