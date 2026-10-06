import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));

// Test fixtures only: Pine Bridge overview, signal and readiness answers for one Bot.
const FRESH={bridge_enabled:true,sources:{count:1,latest:null},jobs:{by_status:{},latest:null},deployments:{by_state:{},latest_ready:null}};
const BUILT={bridge_enabled:true,sources:{count:2},jobs:{by_status:{SUCCEEDED:2},latest:{job_status:'SUCCEEDED',has_draft:true}},deployments:{by_state:{DRAFT:1,READY:1},latest_ready:{deployment_id:'d1'}}};
const reply=({bridge=FRESH,signals=[],verdict='INSUFFICIENT_ACTIVITY'}={})=>path=>{
  if(path==='/api/quant/pine-bridge/overview'){if(bridge instanceof Error)throw bridge;return bridge;}
  if(path==='/api/signals?limit=1')return signals;
  if(path==='/api/risk/readiness-report')return {verdict};
  throw new Error('Unexpected '+path);
};

function setup({language,handler=reply(),session='SETUP',saved=true,selected='bot-2'}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[];
  w.api=async(path,options={})=>{calls.push({path,botId:options.botId,method:options.method||'GET'});return handler(path,options);};
  // The globals app.js and bots.js own; runReadiness is reduced to the saved-policy check it performs.
  w.eval('var selectedBot='+JSON.stringify(selected)+',me={user:{id:"bot-1"},risk:{saved:'+saved+'},botSession:{state:"SETUP"}},botSessions={"bot-2":{state:'+JSON.stringify(session)+'}};'+
    'function runReadiness(state,risk){return risk&&risk.saved?{ready:true,reason:""}:{ready:false,reason:"Save settings first"};}');
  d.querySelector('#botSlots').innerHTML='<article data-bot-card="bot-2"><div class="trading-control-panel"><button class="tcp-btn tcp-btn--run" type="button">Run</button></div>'+
    '<button type="button" class="mini" data-bot-copy="bot-2">Copy webhook</button></article>';
  w.eval(publicFile('setup-guide.js'));
  const page=d.querySelector('[data-page="bots"]');
  const step=key=>d.querySelector('.sg-step[data-step="'+key+'"]');
  const chip=key=>step(key).querySelector('.st').textContent;
  const open=async()=>{page.hidden=false;d.querySelector('nav button[data-view="bots"]').click();await settle();};
  return {dom,w,d,calls,page,step,chip,open};
}

test('Setup guide sits above the Bot cards and reads nothing while Bot Manager is hidden',async()=>{
  const p=setup();
  try{
    const panel=p.d.querySelector('#sgPanel');
    assert.equal(panel.nextElementSibling.id,'botSlots');
    assert.equal(p.d.querySelector('#sgTitle').textContent,'Setup guide');
    assert.equal(p.d.querySelectorAll('.sg-step').length,7);
    p.d.querySelector('nav button[data-view="overview"]').click();await settle();
    assert.equal(p.calls.length,0);
  }finally{p.w.close();}
});

test('A new Bot: step 2 is current, later Bridge steps wait, and status comes from three GET reads',async()=>{
  const p=setup();
  try{
    await p.open();
    assert.deepEqual(p.calls.map(call=>[call.path,call.botId,call.method]),
      [['/api/quant/pine-bridge/overview','bot-2','GET'],['/api/signals?limit=1','bot-2','GET'],['/api/risk/readiness-report','bot-2','GET']]);
    assert.equal(p.d.querySelector('.sg-count').textContent,'1 of 7 steps done');
    assert.equal(p.chip('bot'),'Done');
    assert.equal(p.step('analyze').getAttribute('aria-current'),'step');assert.equal(p.chip('analyze'),'Do this now');
    assert.deepEqual(['draft','activate','alert','run'].map(p.chip),['Not yet','Not yet','Not yet','Not yet']);
    assert.equal(p.chip('risk'),'Insufficient activity','a readiness warning does not block the next steps');
    assert.deepEqual([...p.d.querySelectorAll('.sg-go')].map(button=>button.closest('.sg-step').dataset.step+':'+button.textContent),
      ['analyze:Open Pine Bridge','alert:Copy webhook','risk:Open Risk manager']);
    assert.equal(p.step('analyze').querySelector('.sg-go').className,'primary sg-go');
  }finally{p.w.close();}
});

test('A built and running Bot shows Setup complete; an unsaved policy keeps step 6 open with its reason',async()=>{
  const done=setup({handler:reply({bridge:BUILT,signals:[{id:1}],verdict:'READY_TO_START_PAPER'}),session:'RUNNING'});
  try{
    await done.open();
    assert.equal(done.d.querySelector('.sg-count').textContent,'Setup complete');
    assert.equal(done.d.querySelectorAll('.sg-go').length,0,'no action is offered for finished steps');
    assert.equal(done.d.querySelectorAll('.sg-seg.sg-done').length,7);
  }finally{done.w.close();}
  const unsaved=setup({handler:reply({bridge:BUILT,signals:[{id:1}],verdict:'READY_TO_START_PAPER'}),saved:false});
  try{
    await unsaved.open();
    assert.equal(unsaved.step('risk').getAttribute('aria-current'),'step');
    assert.equal(unsaved.step('risk').querySelector('.sg-reason').textContent,'Save settings first');
    assert.equal(unsaved.chip('run'),'Not yet');
  }finally{unsaved.w.close();}
});

test('A failed status read shows Unavailable instead of guessing',async()=>{
  const p=setup({handler:reply({bridge:Object.assign(new Error('Bridge disabled'),{status:409})})});
  try{
    await p.open();
    assert.deepEqual(['analyze','draft','activate'].map(p.chip),['Unavailable','Unavailable','Unavailable']);
    assert.equal(p.step('analyze').getAttribute('aria-current'),'step');
    assert.equal(p.step('analyze').querySelector('.sg-reason').textContent,'Could not read this status.');
  }finally{p.w.close();}
});

test('Buttons only navigate, copy or focus: Copy webhook uses the Bot card button and Go to Run never presses Run',async()=>{
  const p=setup({handler:reply({bridge:BUILT,signals:[{id:1}],verdict:'READY_TO_START_PAPER'})});
  try{
    await p.open();
    const copied=[],ran=[],views=[];
    p.d.querySelector('[data-bot-copy="bot-2"]').addEventListener('click',()=>copied.push('bot-2'));
    p.d.querySelector('.tcp-btn--run').addEventListener('click',()=>ran.push(1));
    p.d.querySelectorAll('#primaryNav button').forEach(button=>button.addEventListener('click',()=>views.push(button.dataset.view)));
    const go=p.step('run').querySelector('.sg-go');
    assert.equal(go.textContent,'Go to Run');
    go.click();await settle();
    assert.equal(p.d.activeElement,p.d.querySelector('.tcp-btn--run'));assert.deepEqual(ran,[]);
    p.w.eval('botSessions["bot-2"]={state:"SETUP"}');
    const fresh=setup();
    try{
      await fresh.open();
      const copies=[];fresh.d.querySelector('[data-bot-copy="bot-2"]').addEventListener('click',()=>copies.push(1));
      fresh.step('alert').querySelector('.sg-go').click();assert.deepEqual(copies,[1]);
      const nav=[];fresh.d.querySelectorAll('#primaryNav button').forEach(button=>button.addEventListener('click',()=>nav.push(button.dataset.view)));
      fresh.step('risk').querySelector('.sg-go').click();assert.deepEqual(nav,['risk']);
      assert.ok(fresh.calls.every(call=>call.method==='GET'));
    }finally{fresh.w.close();}
  }finally{p.w.close();}
});

test('All bots shows a note and reads nothing; Thai translates every step',async()=>{
  const all=setup({selected:'all'});
  try{
    await all.open();
    assert.equal(all.calls.length,0);
    assert.equal(all.d.querySelector('.sg-note').hidden,false);assert.equal(all.d.querySelector('.sg-steps').hidden,true);
  }finally{all.w.close();}
  const th=setup({language:'th'});
  try{
    await th.open();
    assert.equal(th.d.querySelector('#sgTitle').textContent,'ขั้นตอนตั้งค่า Bot');
    assert.equal(th.d.querySelector('.sg-count').textContent,'เสร็จแล้ว 1 จาก 7 ขั้น');
    assert.equal(th.step('analyze').querySelector('.sg-name').textContent,'ให้ AI วิเคราะห์ Indicator');
    assert.equal(th.chip('analyze'),'ทำขั้นนี้');
    assert.equal(th.step('analyze').querySelector('.sg-go').textContent,'เปิด Pine Bridge');
  }finally{th.w.close();}
});

test('setup-guide.js stays read only and markup-safe',()=>{
  const source=publicFile('setup-guide.js');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket','.style','localStorage','sessionStorage','method:','http://','https://'])
    assert.ok(!source.includes(banned),'setup-guide.js must not contain '+banned);
  assert.deepEqual([...source.matchAll(/api\('([^']+)'/g)].map(match=>match[1]),['/api/quant/pine-bridge/overview','/api/signals?limit=1','/api/risk/readiness-report']);
  assert.doesNotMatch(source,/tcp-btn--run[^;]*\.click\(/,'Go to Run focuses the Run button and never presses it');
  const html=publicFile('index.html');
  assert.ok(html.indexOf('/overview.js')<html.indexOf('/setup-guide.js'),'setup-guide.js loads after bots.js and overview.js');
});