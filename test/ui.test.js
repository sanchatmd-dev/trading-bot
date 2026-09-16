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
test('Analytics UI exposes responsive controls, charts and strict broker currency',()=>{
  const dom=setup(),d=dom.window.document;
  try{
    assert.ok(d.querySelector('[data-view="analytics"]'));assert.ok(d.querySelector('[data-page="analytics"]'));
    assert.equal(d.querySelector('#analyticsCurrency').textContent,'USDT');assert.ok(d.querySelector('#equityChart'));
    assert.ok(d.querySelector('#winLossDonut'));assert.ok(d.querySelector('#assetBars'));assert.ok(d.querySelector('#closedTrades'));
    assert.match(publicFile('styles-v2.css'),/@media\(max-width:600px\).*#closedTrades/s);
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
test('Risk UI renders editable defaults, maxima, Balance and debounced authoritative preview',async()=>{
  const dom=setup(),w=dom.window,d=w.document,calls=[];
  try{
    w.sessionStorage.setItem('astraV2Token','preview-token');
    const risk={paperTrading:true,killSwitch:false,capPercentEquitySize:true,maxRiskPercent:100,maxTradesPerDay:10,maxDailyLossR:3,pauseAfterLossStreak:3,maxOpenPositions:4,maxSignalAgeSeconds:60,maxOrderNotional:10000,maxDailyNotional:100000,maxVolatilityPercent:5,sideMode:'BOTH',onePositionPerSymbol:false,requireReduceOnlySell:true,blockHighVolatility:true,blockDuringNews:true,allowedSymbols:['BTCUSDT'],equities:{'binance-global':10000},balances:{'binance-global':2500},defaults:{riskPercent:1,tradesPerDay:5,dailyLossR:2,lossStreak:2,openPositions:2,signalAgeSeconds:30,orderNotional:1000,dailyNotional:5000,volatilityPercent:2}};
    w.fetch=async(path,options={})=>{
      calls.push(path);
      const body=path==='/api/me'?{user:{id:'u',email:'u@test',role:'USER',status:'ACTIVE'},risk,license:{status:'ACTIVE'},daily:{trades:0},dailyAccounts:[],brokers:[],globalKill:false}
        :path.startsWith('/api/signals')?[]:path==='/api/positions'?[{user_id:'u',broker:'binance-global',execution_mode:'PAPER',symbol:'ETHUSDT',quantity:1,avg_price:1}]
        :path==='/api/me/webhook-secret'?{urlPath:null}:path==='/api/risk/preview'?{ok:true,order:{quantity:.025,price:100,stopLoss:90,notional:2.5,sizingAdjustment:null},freeBalance:2497.5,positionsOpen:1,positionsRemaining:3,positionCapacity:3}:{ok:true};
      return{ok:true,json:async()=>body};
    };
    w.eval(publicFile('app.js'));await new Promise(resolve=>setTimeout(resolve,80));
    const f=d.querySelector('#riskForm').elements;
    assert.equal(f.defaultRiskPercent.value,'1');assert.equal(f.maxRiskPercent.value,'100');
    assert.equal(f.equityGlobal.value,'10000');assert.equal(f.balanceGlobal.value,'2500');
    assert.equal(f.onePositionPerSymbol.checked,false);assert.equal(f.onePositionPerSymbol.disabled,false);
    assert.equal(d.querySelector('#previewSlots').textContent,'1 / 3');
    f.previewEntry.value='100';f.previewStopLoss.value='90';f.previewEntry.dispatchEvent(new w.Event('input',{bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.ok(calls.includes('/api/risk/preview'));
    assert.equal(d.querySelector('#riskPreviewStatus').textContent,'Likely accepted');
    assert.equal(d.querySelector('#previewCapacity').textContent,'3');
  }finally{w.close();}
});
