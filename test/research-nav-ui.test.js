import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
const T0=Date.UTC(2026,8,1,0,0);

// Test fixtures only: one library run with its measurement context, as /api/quant/library returns it.
const RUN={run_id:'3f2a9c1e-0000-4000-8000-000000000001',created_at:T0+86400000,status:'SUCCEEDED',library_class:'NO_VALID_CANDIDATE',library_group:'COMPLETED',
  market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},dataset:{start_time:T0,end_time:T0+3*86400000,bar_count:4320,warmup_bars:300},
  cost:{fee_bps:10,slippage_bps:1},candidates:{planned:100,evaluated:100},development_score:{value:null,reason:'NO_SCREENED_CANDIDATE'},
  qualification:{qualified:false,label:'NO_SCREENED_CANDIDATE'},compatibility_key:'aaaaaaaaaaaa'};
const LIST={version:'quant-library-v1',schema_present:true,totals:{all:1,COMPLETED:1},qualified_total:0,qualified_winner:null,next_before:null,runs:[RUN]};

function setup({language}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[];
  w.api=async path=>{calls.push(path);if(path.startsWith('/api/quant/library?'))return LIST;throw Object.assign(new Error('unexpected'),{status:404});};
  w.eval('var selectedBot="",me={user:{id:"bot-1"}},botProfiles=[{id:"bot-1",label:"Momentum BTC"},{id:"bot-2",label:"Mean Revert ETH"}];');
  for(const id of ['pbPanel','qrjPanel']){const panel=d.createElement('details');panel.id=id;d.querySelector('[data-page="quant"]').append(panel);}
  w.eval(publicFile('research-library.js'));w.eval(publicFile('research-nav.js'));
  return {dom,w,d,calls};
}

test('Research jump bar opens each workspace in place and sends no request',async()=>{
  const p=setup();
  try{
    const bar=p.d.querySelector('#researchNav'),page=p.d.querySelector('[data-page="quant"]');
    assert.equal(page.firstElementChild,bar);
    assert.deepEqual([...bar.querySelectorAll('.rnav-go')].map(button=>button.textContent),['Build Pine Bridge','Research job','Research Library','Backtest and legacy tools']);
    const reveals=[];
    for(const id of ['pbPanel','qrjPanel'])p.d.getElementById(id).addEventListener(id==='pbPanel'?'pb:reveal':'qrj:reveal',event=>{reveals.push(id);event.preventDefault();});
    bar.querySelector('[data-target="pbPanel"]').click();bar.querySelector('[data-target="qrjPanel"]').click();
    assert.deepEqual(reveals,['pbPanel','qrjPanel']);
    assert.equal(p.d.getElementById('pbPanel').open,true);assert.equal(p.d.getElementById('qrjPanel').open,true);
    bar.querySelector('[data-target="qrlPanel"]').click();assert.equal(p.d.getElementById('qrlPanel').open,true);await settle();
    assert.ok(p.calls.every(path=>path.startsWith('/api/quant/library?')),'only the library itself reads its list when opened');
  }finally{p.w.close();}
});

test('Library cards show what a result was measured on before any score, and say the list covers every Bot',async()=>{
  const p=setup();
  try{
    const panel=p.d.getElementById('qrlPanel');panel.open=true;panel.dispatchEvent(new p.w.Event('toggle'));await settle();
    assert.equal(panel.querySelector('.qrl-scope').textContent,'Runs from every Bot of this account. Inspect a run to see its Bot.');
    const card=panel.querySelector('.qrl-card');
    assert.equal(card.querySelector('.qrl-card-head').nextElementSibling.className,'qrl-prov','provenance comes right after the head');
    assert.deepEqual([...card.querySelectorAll('.qrl-pv')].map(item=>item.textContent),
      ['binance-global · BTCUSDT · 1m','2026-09-01 00:00 → 2026-09-04 00:00 UTC · 4,320 bars','Fee 10 bps · Slippage 1 bps']);
  }finally{p.w.close();}
  const th=setup({language:'th'});
  try{
    const panel=th.d.getElementById('qrlPanel');panel.open=true;panel.dispatchEvent(new th.w.Event('toggle'));await settle();
    assert.deepEqual([...panel.querySelectorAll('.qrl-pv')].slice(1).map(item=>item.textContent),
      ['2026-09-01 00:00 → 2026-09-04 00:00 UTC · 4,320 แท่ง','ค่าธรรมเนียม 10 bps · Slippage 1 bps']);
    assert.equal(th.d.querySelector('#researchNav .rnav-go').textContent,'สร้าง Pine Bridge');
  }finally{th.w.close();}
});

test('research-nav.js stays request-free and markup-safe',()=>{
  const source=publicFile('research-nav.js');
  for(const banned of ['api(','fetch(','innerHTML','outerHTML','insertAdjacentHTML','.style','localStorage','http://','https://'])assert.ok(!source.includes(banned),'research-nav.js must not contain '+banned);
});