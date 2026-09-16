import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
function setup(language){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'});
  if(language)dom.window.localStorage.setItem('robotLanguage',language);
  dom.window.eval(publicFile('i18n.js'));
  return dom;
}
test('UI defaults to English; language persists, preserves inputs and protects user text',async()=>{
  const dom=setup(),w=dom.window,d=w.document;
  try{
    assert.equal(d.documentElement.lang,'en');
    assert.equal(d.querySelector('#loginBtn').textContent,'Sign in');
    assert.equal(d.querySelector('#pageTitle').textContent,'Overview');
    d.querySelector('#email').value='private@example.test';
    d.querySelector('[name=maxRiskPercent]').value='37';
    d.querySelector('#signalRows').innerHTML='<tr><td><textarea class="review-note">Save</textarea></td></tr>';
    const language=d.querySelector('#language');
    language.value='th';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(d.querySelector('#loginBtn').textContent,'เข้าสู่ระบบ');
    assert.equal(d.querySelector('[name=maxRiskPercent]').value,'37');
    assert.equal(d.querySelector('#email').value,'private@example.test');
    assert.equal(d.querySelector('textarea.review-note').value,'Save');
    assert.equal(w.localStorage.getItem('robotLanguage'),'th');
    w.showSaved();assert.equal(d.querySelector('#saveToast').textContent,'บันทึกแล้ว');
    assert.equal(d.querySelector('#saveToast').hidden,false);
    language.value='en';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(d.querySelector('#saveToast').textContent,'Saved');
    assert.equal(d.querySelector('#loginBtn').textContent,'Sign in');
  }finally{w.close();}
  const restored=setup('th');assert.equal(restored.window.document.documentElement.lang,'th');restored.window.close();
});
test('Forgot Password opens recovery guidance without claiming email delivery',()=>{
  const dom=setup(),d=dom.window.document;
  try{
    let opened=false;d.querySelector('#recoveryDialog').showModal=()=>{opened=true;};
    d.querySelector('#forgotPassword').click();
    assert.equal(opened,true);
    assert.match(d.querySelector('#recoveryDialog').textContent,/Automatic email recovery is not configured/);
    assert.match(d.querySelector('#recoveryDialog pre').textContent,/reset-password.sh/);
  }finally{dom.window.close();}
});
test('save popup follows successful API writes, not errors; Rejected notes are escaped and save correctly',async()=>{
  const dom=setup(),w=dom.window,d=w.document;let succeed=true,lastRequest;
  try{
    w.fetch=async(path,options)=>{lastRequest={path,options};return{ok:succeed,json:async()=>succeed?{ok:true}:{error:'Save failed'}};};
    w.eval(publicFile('app.js'));
    await w.api('/api/risk',{method:'PUT',body:'{}'});
    assert.equal(d.querySelector('#saveToast').hidden,false);
    d.querySelector('#saveToast').hidden=true;succeed=false;
    await assert.rejects(w.api('/api/risk',{method:'PUT',body:'{}'}),/Save failed/);
    assert.equal(d.querySelector('#saveToast').hidden,true);
    succeed=true;
    // Expose fixture through a renderer executed within the original app script's lexical scope.
    const fixture={id:1,user_id:'test-user',trade_id:'fixture',received_at:Date.now(),symbol:'BTCUSDT',status:'REJECTED',error_message:'Signal is stale',review_note:'</textarea><script>bad()</script>'};
    w.eval(publicFile('app.js')+'\nsignals='+JSON.stringify([fixture])+';renderSignals();');
    assert.equal(d.querySelector('#signalRows script'),null);
    assert.equal(d.querySelector('.review-note').value,fixture.review_note);
    assert.match(d.querySelector('.rejection-help').textContent,/older than Max signal age/);
    assert.match(w.explainRejection('No Spot position available to sell'),/no open Spot position/);
    assert.match(w.explainRejection('Order exceeds available configured Spot equity'),/exceeds available equity/);
    assert.match(w.explainRejection('Symbol is not allowed'),/Allowed symbols/);
    d.querySelector('.review-note').value='Reviewed';
    d.querySelector('.save-note').click();await settle();
    assert.equal(lastRequest.path,'/api/signals/1/note');
    assert.deepEqual(JSON.parse(lastRequest.options.body),{note:'Reviewed'});
  }finally{w.close();}
});
