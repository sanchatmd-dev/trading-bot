import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));

// Test fixtures only. The Pine Bridge overview is owner-wide: it shows READY 2 and a draft whichever Bot is selected.
const OWNER_WIDE={bridge_enabled:true,sources:{count:2},jobs:{by_status:{SUCCEEDED:2},latest:{job_status:'SUCCEEDED',has_draft:true}},deployments:{by_state:{DRAFT:1,READY:2},latest_ready:{deployment_id:'d9'}}};
const NO_READY={verdict:'INSUFFICIENT_ACTIVITY',blockers:[{code:'NO_READY_DEPLOYMENT'}],current:{deployment:null}};
const READY={verdict:'INSUFFICIENT_ACTIVITY',blockers:[],current:{deployment:{deployment_id:'d1',state:'READY',fresh:true}}};

async function guide({report,overview=OWNER_WIDE,language}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  w.api=async(path)=>{
    if(path==='/api/quant/pine-bridge/overview')return overview;
    if(path==='/api/signals?limit=1')return [];
    if(path==='/api/risk/readiness-report'){if(report instanceof Error)throw report;return report;}
    throw new Error('Unexpected '+path);
  };
  w.eval('var selectedBot="main-bot",me={user:{id:"main-bot"},risk:{saved:true},botSession:{state:"SETUP"}},botSessions={"main-bot":{state:"SETUP"}};'+
    'function runReadiness(state,risk){return risk&&risk.saved?{ready:true,reason:""}:{ready:false,reason:"Save settings first"};}');
  d.querySelector('#botSlots').innerHTML='<article data-bot-card="main-bot"><button type="button" data-bot-copy="main-bot">Copy webhook</button></article>';
  w.eval(publicFile('setup-guide.js'));
  d.querySelector('[data-page="bots"]').hidden=false;d.querySelector('nav button[data-view="bots"]').click();await settle();
  const step=key=>d.querySelector('.sg-step[data-step="'+key+'"]');
  return {w,d,step,chip:key=>step(key).querySelector('.st').textContent};
}

test('Setup guide: owner-wide READY 2 but this Bot has no READY deployment shows activate as the current step, never Done',async()=>{
  const p=await guide({report:NO_READY});
  try{
    assert.equal(p.chip('activate'),'Do this now');
    assert.equal(p.step('activate').getAttribute('aria-current'),'step');
    assert.notEqual(p.chip('activate'),'Done');
    assert.deepEqual(['analyze','draft'].map(p.chip),['Done','Done'],'analyze and draft stay account-wide');
    assert.match(p.step('analyze').textContent+p.step('draft').textContent,/Analyze your indicator/);
  }finally{p.w.close();}
});

test('Setup guide: a Bot whose readiness report carries a READY deployment shows activate as Done',async()=>{
  const p=await guide({report:READY});
  try{assert.equal(p.chip('activate'),'Done');}finally{p.w.close();}
});

test('Setup guide: a failed readiness report shows activate as Unavailable, never Done or todo',async()=>{
  const p=await guide({report:Object.assign(new Error('boom'),{status:500})});
  try{
    assert.equal(p.chip('activate'),'Unavailable');
    assert.equal(p.step('activate').querySelector('.sg-reason').textContent,'Could not read this status.');
  }finally{p.w.close();}
});

test('Setup guide: a report without the current section, or an ambiguous READY deployment, is Unavailable',async()=>{
  for(const report of [{verdict:'INSUFFICIENT_ACTIVITY'},
    {verdict:'CAPABILITY_UNAVAILABLE',blockers:[{code:'AMBIGUOUS_READY_DEPLOYMENT'}],current:{deployment:READY.current.deployment}}]){
    const p=await guide({report});
    try{assert.equal(p.chip('activate'),'Unavailable');}finally{p.w.close();}
  }
});

test('Setup guide: a disabled Bridge keeps activate Unavailable even when the report names a deployment',async()=>{
  const p=await guide({report:READY,overview:{...OWNER_WIDE,bridge_enabled:false}});
  try{assert.deepEqual(['analyze','draft','activate'].map(p.chip),['Unavailable','Unavailable','Unavailable']);}finally{p.w.close();}
  const q=await guide({report:{verdict:'CAPABILITY_UNAVAILABLE',blockers:[{code:'BRIDGE_DISABLED'}],current:{deployment:null}}});
  try{assert.equal(q.chip('activate'),'Unavailable');}finally{q.w.close();}
});

test('Setup guide: analyze and draft say they are account-wide even when shown Done',async()=>{
  const p=await guide({report:NO_READY});
  try{
    assert.deepEqual(['analyze','draft'].map(p.chip),['Done','Done']);
    for(const key of ['analyze','draft']){
      assert.equal(p.step(key).querySelector('.sg-text'),null,key+' text stays hidden when Done');
      assert.equal(p.step(key).querySelector('.sg-scope').textContent,'Checked for your whole account, not for one Bot.');
    }
    assert.equal(p.step('activate').querySelector('.sg-scope'),null,'activate is per Bot');
  }finally{p.w.close();}
});

test('Setup guide: the account-wide note has a Thai pair when analyze and draft are Done',async()=>{
  const p=await guide({report:NO_READY,language:'th'});
  try{
    assert.deepEqual(['analyze','draft'].map(p.chip),['เสร็จแล้ว','เสร็จแล้ว']);
    for(const key of ['analyze','draft'])assert.match(p.step(key).querySelector('.sg-scope').textContent,/ตรวจจากทั้งบัญชีของคุณ ไม่ใช่เฉพาะ Bot เดียว/);
  }finally{p.w.close();}
});
