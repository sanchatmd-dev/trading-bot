import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));

// Test fixtures only: a release whose Pine Bridge is switched off, and one whose answer omits the flag.
const DISABLED={bridge_enabled:false,sources:{count:0},jobs:{by_status:{},latest:null},deployments:{by_state:{},latest_ready:null}};
const MISSING={sources:{count:0},jobs:{by_status:{},latest:null},deployments:{by_state:{},latest_ready:null}};
const reply=bridge=>path=>{
  if(path==='/api/quant/pine-bridge/overview')return bridge;
  if(path==='/api/signals?limit=1')return [];
  if(path==='/api/risk/readiness-report')return {verdict:'INSUFFICIENT_ACTIVITY'};
  throw new Error('Unexpected '+path);
};

async function guide(bridge,language){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  w.api=async(path)=>reply(bridge)(path);
  w.eval('var selectedBot="bot-2",me={user:{id:"bot-1"},risk:{saved:true},botSession:{state:"SETUP"}},botSessions={"bot-2":{state:"SETUP"}};'+
    'function runReadiness(state,risk){return risk&&risk.saved?{ready:true,reason:""}:{ready:false,reason:"Save settings first"};}');
  d.querySelector('#botSlots').innerHTML='<article data-bot-card="bot-2"><button type="button" data-bot-copy="bot-2">Copy webhook</button></article>';
  w.eval(publicFile('setup-guide.js'));
  d.querySelector('[data-page="bots"]').hidden=false;d.querySelector('nav button[data-view="bots"]').click();await settle();
  const step=key=>d.querySelector('.sg-step[data-step="'+key+'"]');
  return {w,d,step,chip:key=>step(key).querySelector('.st').textContent,reason:key=>step(key).querySelector('.sg-reason')?.textContent};
}

for(const [name,bridge] of [['bridge_enabled false',DISABLED],['bridge_enabled missing',MISSING]]){
  test('Setup guide: '+name+' shows the Bridge steps as Unavailable, not Do this now or Not yet (English)',async()=>{
    const p=await guide(bridge);
    try{
      assert.deepEqual(['analyze','draft','activate'].map(p.chip),['Unavailable','Unavailable','Unavailable']);
      assert.equal(p.reason('analyze'),'Could not read this status.');
      assert.equal(p.step('analyze').getAttribute('aria-current'),'step');
      assert.equal(p.chip('bot'),'Done');
      assert.equal(p.chip('alert'),'Not yet','steps that do not depend on the Bridge keep their own status');
    }finally{p.w.close();}
  });
  test('Setup guide: '+name+' shows the Bridge steps as Unavailable (Thai)',async()=>{
    const p=await guide(bridge,'th');
    try{
      assert.deepEqual(['analyze','draft','activate'].map(p.chip),['ไม่พร้อมใช้งาน','ไม่พร้อมใช้งาน','ไม่พร้อมใช้งาน']);
      assert.equal(p.reason('analyze'),'อ่านสถานะนี้ไม่ได้');
    }finally{p.w.close();}
  });
}
