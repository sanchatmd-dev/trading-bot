import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
// Wait for a visible outcome, not for a fixed time; the bound only stops a broken test from hanging.
const until=async(check,limit=4000)=>{const end=Date.now()+limit;while(!check()&&Date.now()<end)await settle(10);};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
const RAW='11111111-2222-4333-8444-555555555555',PROFILE='22222222-3333-4444-8555-666666666666',PREFLIGHT='33333333-4444-4555-8666-777777777777';
const DEPLOY='d1d1d1d1-aaaa-4bbb-8ccc-dddddddddddd';
const failure=(code,status=409)=>Object.assign(new Error(code),{code,status});
const PAST=Date.UTC(2026,8,30,0,0);
const minute=ms=>new Date(ms).toISOString().slice(0,16);

// Test fixtures only: answers shaped like the PF-2 routes. Each route answers from its queue, then from its default.
function setup({language,selected='bot-1',routes={},raw=null,storage=null,noStorage=false}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  // Watch timers (3 s and longer) fire at once and are recorded, so the back-off is checked without waiting.
  const delays=[],realTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>{if(ms>=1000)delays.push(ms);return realTimeout(fn,ms>=1000?0:ms);};
  const calls=[],queues={};
  const defaults={
    'GET /api/quant/data/holdout-boundaries':()=>({bot_id:selected,holdout_start_time:null}),
    'GET /api/quant/pine-bridge/deployments':()=>({deployments:[{deployment_id:DEPLOY,state:'READY',source_version:2},{deployment_id:'e2e2e2e2-aaaa-4bbb-8ccc-dddddddddddd',state:'DRAFT'}]}),
    'GET /api/quant/data/preflights':()=>[],
    'POST /api/quant/data/holdout-boundaries':()=>({registered:true}),
    'POST /api/quant/data/profile-enrollments':()=>({job_id:PROFILE,status:'QUEUED',next_bar:0,total_bars:100}),
    'GET /api/quant/data/profiles/':()=>({job_id:PROFILE,status:'SUCCEEDED',next_bar:100,total_bars:100,result:{profile_hash:'ab12',nested:{x:1}}}),
    'POST /api/quant/data/preflights':()=>({job_id:PREFLIGHT,status:'QUEUED',next_bar:0,total_bars:500}),
    'GET /api/quant/data/preflights/':()=>({job_id:PREFLIGHT,status:'SUCCEEDED',next_bar:500,total_bars:500,envelope:{}}),
    'POST /api/quant/data/preflights/cancel':()=>({job_id:PREFLIGHT,status:'STOPPING',next_bar:3,total_bars:500})};
  for(const [key,list] of Object.entries(routes))queues[key]=[...list];
  w.api=async(path,options={})=>{
    const method=options.method||'GET';
    calls.push({method,path,botId:options.botId,silent:options.silent,key:options.headers?.['idempotency-key']??null,body:options.body?JSON.parse(options.body):null});
    const route=path.startsWith('/api/quant/data/preflights/')?(path.endsWith('/cancel')?'/api/quant/data/preflights/cancel':'/api/quant/data/preflights/'):
      path.startsWith('/api/quant/data/profiles/')?'/api/quant/data/profiles/':path;
    const next=queues[method+' '+route]?.length?queues[method+' '+route].shift():defaults[method+' '+route];
    if(!next)throw new Error('Unexpected '+method+' '+route);
    const value=await(typeof next==='function'?next():next);
    if(value instanceof Error)throw value;
    return structuredClone(value);
  };
  if(storage)for(const [name,value] of Object.entries(storage))w.sessionStorage.setItem(name,JSON.stringify(value));
  if(noStorage)Object.defineProperty(w,'sessionStorage',{get(){throw new Error('storage blocked');},configurable:true});
  w.eval('var selectedBot='+JSON.stringify(selected)+',me={user:{id:"bot-1"}};'+(raw?'var qDataJob='+JSON.stringify(raw)+',qDataJobBotId="bot-1";':''));
  w.eval(publicFile('preflight-runner.js'));
  const q=id=>d.getElementById(id),panel=q('pfrPanel'),cards=()=>[...panel.querySelectorAll('.pfr-card')];
  const parts={hInput:()=>cards()[0].querySelector('input[type="datetime-local"]'),hCheck:()=>cards()[0].querySelector('input[type="checkbox"]'),
    hRegister:()=>cards()[0].querySelector('.primary'),hStatus:()=>cards()[0].querySelector('.pfr-status'),hValue:()=>cards()[0].querySelector('.pfr-value'),
    hForm:()=>cards()[0].querySelector('.pfr-form'),hPreview:()=>cards()[0].querySelector('.pfr-preview'),
    raw:()=>cards()[1].querySelector('input[type="text"]'),deploy:()=>cards()[1].querySelector('select'),enroll:()=>cards()[1].querySelector('.primary'),
    eStatus:()=>cards()[1].querySelector('.pfr-status'),eJob:()=>cards()[1].querySelector('.pfr-job'),
    profile:()=>cards()[2].querySelector('input[type="text"]'),start:()=>cards()[2].querySelector('.primary'),
    cancel:()=>[...cards()[2].querySelectorAll('.pfr-actions button')][1],yes:()=>[...cards()[2].querySelectorAll('.pfr-actions button')][2],
    pStatus:()=>cards()[2].querySelector('.pfr-status'),pJob:()=>cards()[2].querySelector('.pfr-job')};
  const type=(input,value)=>{input.value=value;input.dispatchEvent(new w.Event('input'));};
  const pick=value=>{parts.deploy().value=value;parts.deploy().dispatchEvent(new w.Event('change'));};
  const open=async()=>{d.querySelector('[data-page="risk"]').hidden=false;d.querySelector('nav button[data-view="risk"]').click();await settle();};
  const switchTo=async bot=>{w.eval('selectedBot='+JSON.stringify(bot));d.querySelector('#botSwitcher').dispatchEvent(new w.Event('change'));await settle();};
  const posts=()=>calls.filter(call=>call.method==='POST'),gets=prefix=>calls.filter(call=>call.method==='GET'&&call.path.startsWith(prefix));
  const setVisibility=state=>{Object.defineProperty(d,'visibilityState',{value:state,configurable:true});d.dispatchEvent(new w.Event('visibilitychange'));};
  return {dom,w,d,q,panel,cards,parts,calls,posts,gets,type,pick,open,switchTo,delays,setVisibility};
}

test('The panel sits after the PF-3 report; opening Risk reads boundary, deployments and the Preflight list, and writes nothing',async()=>{
  const p=setup();
  try{
    assert.equal(p.q('pf3Panel').nextElementSibling,p.panel);
    assert.equal(p.calls.length,0,'nothing before the Risk page opens');
    await p.open();
    assert.deepEqual(p.calls.map(call=>[call.method,call.path,call.botId]).sort(),[['GET','/api/quant/data/holdout-boundaries','bot-1'],['GET','/api/quant/data/preflights','bot-1'],['GET','/api/quant/pine-bridge/deployments','bot-1']]);
    assert.deepEqual([...p.parts.deploy().options].map(option=>option.value),['',DEPLOY],'only READY deployments are offered');
    assert.equal(p.parts.deploy().value,DEPLOY,'a single READY deployment is preselected');
    assert.equal(p.parts.hRegister().disabled,true);assert.equal(p.parts.enroll().disabled,true);assert.equal(p.parts.start().disabled,true);
  }finally{p.w.close();}
  const all=setup({selected:'all'});
  try{await all.open();assert.equal(all.panel.querySelector('.pfr-note').hidden,false);assert.ok(all.cards().every(card=>card.hidden));assert.equal(all.calls.length,0);}
  finally{all.w.close();}
});

test('Holdout: refuses future and partial minutes, shows the exact value, needs the box ticked after the last edit, posts once, then reads it back',async()=>{
  const p=setup({routes:{'GET /api/quant/data/holdout-boundaries':[{holdout_start_time:null},{holdout_start_time:PAST}]}});
  try{
    await p.open();
    p.type(p.parts.hInput(),minute(Date.now()+3*3600000));
    assert.match(p.parts.hStatus().textContent,/The time is in the future\./);assert.equal(p.parts.hPreview().textContent,'');
    p.type(p.parts.hInput(),minute(PAST)+':30');assert.match(p.parts.hStatus().textContent,/Use a whole minute\./);
    p.type(p.parts.hInput(),minute(PAST));
    assert.equal(p.parts.hStatus().textContent,'','a corrected value clears the old message');
    assert.equal(p.parts.hPreview().textContent,'Will register 2026-09-30 00:00 UTC (Bangkok local 2026-09-30 07:00) · '+PAST+' ms');
    assert.equal(p.parts.hRegister().disabled,true,'the permanence box is required');
    p.parts.hCheck().click();assert.equal(p.parts.hRegister().disabled,false);
    p.type(p.parts.hInput(),minute(PAST-60000));
    assert.equal(p.parts.hCheck().checked,false,'an edit unticks the box');assert.equal(p.parts.hRegister().disabled,true);
    p.type(p.parts.hInput(),minute(PAST));p.parts.hCheck().click();
    assert.equal(p.posts().length,0,'nothing is written before the click');
    p.parts.hRegister().click();p.parts.hRegister().click();await until(()=>/registered/.test(p.parts.hStatus().textContent));
    assert.deepEqual(p.posts().map(call=>[call.path,call.body,call.silent]),[['/api/quant/data/holdout-boundaries',{bot_id:'bot-1',holdout_start_time:PAST},true]],'two clicks send one request');
    assert.match(p.parts.hValue().textContent,/2026-09-30 00:00 UTC/);assert.equal(p.parts.hForm().hidden,true,'read only once registered');
    assert.match(p.parts.hStatus().textContent,/Holdout boundary registered\./);
  }finally{p.w.close();}
});

test('Holdout: a failed read keeps the form closed and reads again on the next open; refusals and closed features read plainly',async()=>{
  const p=setup({routes:{'GET /api/quant/data/holdout-boundaries':[failure('SERVICE_UNAVAILABLE',500)],'POST /api/quant/data/holdout-boundaries':[{registered:false}]}});
  try{
    await p.open();
    assert.equal(p.parts.hForm().hidden,true);assert.equal(p.parts.hRegister().disabled,true);
    assert.equal(p.parts.hStatus().className,'pfr-status pfr-bad');assert.equal(p.parts.hStatus().querySelector('code').textContent,'SERVICE_UNAVAILABLE');
    await p.open();
    assert.equal(p.gets('/api/quant/data/holdout-boundaries').length,2);assert.equal(p.parts.hForm().hidden,false);
    p.type(p.parts.hInput(),minute(PAST));p.parts.hCheck().click();p.parts.hRegister().click();
    await until(()=>/already registered/.test(p.parts.hStatus().textContent));
    assert.match(p.parts.hStatus().textContent,/This boundary was already registered\./);
  }finally{p.w.close();}
  const exists=setup({routes:{'POST /api/quant/data/holdout-boundaries':[failure('HOLDOUT_BOUNDARY_EXISTS')]}});
  try{
    await exists.open();exists.type(exists.parts.hInput(),minute(PAST));exists.parts.hCheck().click();exists.parts.hRegister().click();
    await until(()=>exists.parts.hStatus().querySelector('code'));
    assert.match(exists.parts.hStatus().textContent,/A different holdout boundary is already registered for this bot\. It cannot be changed\./);
  }finally{exists.w.close();}
  const closed=setup({routes:{'GET /api/quant/data/holdout-boundaries':[failure('PREFLIGHT_DISABLED',503)]}});
  try{await closed.open();assert.equal(closed.parts.hStatus().className,'pfr-status pfr-closed');assert.match(closed.parts.hStatus().textContent,/This step is closed on this server\./);}
  finally{closed.w.close();}
});

test('Keys: a retry with the same inputs reuses the key, a revert to the same inputs reuses it, a real change or a success rotates it',async()=>{
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[new TypeError('Failed to fetch'),new TypeError('Failed to fetch'),new TypeError('Failed to fetch')]}});
  try{
    await p.open();
    assert.equal(p.parts.raw().value,RAW,'the last finished raw job of this bot is offered');
    p.parts.enroll().click();await until(()=>p.posts().length===1&&!p.parts.enroll().disabled);
    p.type(p.parts.raw(),RAW.replace('1111','1112'));p.type(p.parts.raw(),RAW);
    p.parts.enroll().click();await until(()=>p.posts().length===2&&!p.parts.enroll().disabled);
    assert.equal(p.posts()[1].key,p.posts()[0].key,'retyping the same value keeps the key');
    p.type(p.parts.raw(),RAW.replace('1111','1113'));
    p.parts.enroll().click();await until(()=>p.posts().length===3&&!p.parts.enroll().disabled);
    assert.notEqual(p.posts()[2].key,p.posts()[0].key,'different inputs get a new key');
    p.type(p.parts.raw(),RAW);
    p.parts.enroll().click();await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
    assert.equal(p.posts()[3].key,p.posts()[0].key,'back to the first inputs: the first key again');
    p.parts.enroll().click();await until(()=>p.posts().length===5&&p.gets('/api/quant/data/profiles/').length===2);await settle(40);
    assert.notEqual(p.posts()[4].key,p.posts()[3].key,'a success rotates the key');
    assert.match(p.posts()[0].key,/^[A-Za-z0-9_-]{8,128}$/);assert.deepEqual(p.posts()[0].body,{bot_id:'bot-1',raw_job_id:RAW,deployment_id:DEPLOY});
    assert.equal(p.parts.profile().value,PROFILE,'the verified profile job fills the Preflight input');
    assert.deepEqual([...p.parts.eJob().querySelectorAll('dt')].map(node=>node.textContent),['profile_hash'],'scalar fields only');
  }finally{p.w.close();}
});

test('A bot switch while an enroll POST is in flight keeps the answer under its bot; coming back shows it and offers no second enroll',async()=>{
  const slow=gate();
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[slow.promise.then(()=>({job_id:PROFILE,status:'RUNNING',next_bar:5,total_bars:100}))],
    'GET /api/quant/data/profiles/':[{job_id:PROFILE,status:'RUNNING',next_bar:6,total_bars:100}]}});
  try{
    await p.open();
    p.parts.enroll().click();p.parts.enroll().click();await settle();
    assert.equal(p.posts().length,1,'two clicks in one task send one request');
    await p.switchTo('bot-2');
    slow.open();await settle();
    assert.equal(p.parts.eJob().textContent,'','the other bot shows nothing of it');
    assert.equal(p.gets('/api/quant/data/profiles/').length,0,'no watching for a bot that is not on screen');
    await p.switchTo('bot-1');
    await until(()=>/RUNNING/.test(p.parts.eJob().textContent));
    assert.match(p.parts.eJob().textContent,new RegExp(PROFILE));
    p.type(p.parts.raw(),RAW);
    assert.equal(p.parts.enroll().disabled,true,'an active job blocks a second enroll');
    assert.equal(p.posts().length,1);
  }finally{p.w.close();}
});

test('Preflight: starts on click, refreshes PF-3 on SUCCEEDED; worker codes read plainly; status codes stay untranslated in Thai',async()=>{
  const p=setup({routes:{'GET /api/quant/data/preflights/':[{job_id:PREFLIGHT,status:'RUNNING',next_bar:250,total_bars:500}]}});
  try{
    await p.open();
    let refreshed=0;p.q('pf3Refresh').addEventListener('click',()=>refreshed++);
    p.type(p.parts.profile(),PROFILE);p.parts.start().click();await until(()=>refreshed>0);
    assert.deepEqual([p.posts()[0].path,p.posts()[0].body],['/api/quant/data/preflights',{bot_id:'bot-1',deployment_id:DEPLOY,profile_job_id:PROFILE}]);
    assert.ok(p.posts()[0].key);assert.match(p.parts.pStatus().textContent,/Preflight finished\./);assert.match(p.parts.pJob().textContent,/Evidence stored\./);
  }finally{p.w.close();}
  const bad=setup({language:'th',routes:{'GET /api/quant/data/preflights/':[{job_id:PREFLIGHT,status:'FAILED',next_bar:3,total_bars:500,diagnostic:'PF2_EVALUATOR_HASH_MISMATCH'}]}});
  try{
    await bad.open();bad.type(bad.parts.profile(),PROFILE);bad.parts.start().click();await until(()=>/PF2_EVALUATOR/.test(bad.parts.pJob().textContent));
    assert.match(bad.parts.pJob().textContent,/ตัวประเมินของ Preflight ไม่ตรงกับ deployment นี้/);
    assert.ok([...bad.parts.pJob().querySelectorAll('.no-i18n')].some(node=>node.textContent==='FAILED'),'the status code is data, not translated');
  }finally{bad.w.close();}
});

test('An active Preflight on the server is adopted on open; Cancel needs two clicks, hides while in flight and during STOPPING',async()=>{
  const cancel=gate();
  const p=setup({routes:{'GET /api/quant/data/preflights':[[{job_id:PREFLIGHT,bot_id:'bot-1',status:'RUNNING',next_bar:9,total_bars:500,profile_job_id:PROFILE}]],
    'GET /api/quant/data/preflights/':[{job_id:PREFLIGHT,status:'RUNNING',next_bar:10,total_bars:500}],
    'POST /api/quant/data/preflights/cancel':[cancel.promise.then(()=>({job_id:PREFLIGHT,status:'STOPPING',next_bar:10,total_bars:500}))]}});
  try{
    // Keep the watch quiet while checking Cancel: the page is hidden right after the list is adopted.
    await p.open();await until(()=>/RUNNING/.test(p.parts.pJob().textContent));
    p.setVisibility('hidden');
    assert.equal(p.parts.start().disabled,true,'an adopted active job blocks Start');
    assert.equal(p.parts.cancel().hidden,false);
    p.parts.cancel().click();assert.equal(p.parts.yes().hidden,false);assert.equal(p.posts().length,0,'the first click only asks');
    p.parts.yes().click();await settle();
    assert.equal(p.parts.cancel().hidden,true,'no second Cancel while one is in flight');
    cancel.open();await until(()=>/Cancel requested/.test(p.parts.pStatus().textContent));
    assert.deepEqual(p.posts().map(call=>[call.path,call.body]),[['/api/quant/data/preflights/'+PREFLIGHT+'/cancel',{}]]);
    assert.equal(p.parts.cancel().hidden,true,'STOPPING offers no Cancel');
  }finally{p.w.close();}
  const busy=setup({routes:{'POST /api/quant/data/preflights':[failure('PREFLIGHT_ALREADY_ACTIVE')],
    'GET /api/quant/data/preflights':[[],[{job_id:PREFLIGHT,bot_id:'bot-1',status:'QUEUED',next_bar:0,total_bars:500}]],'GET /api/quant/data/preflights/':[{job_id:PREFLIGHT,status:'SUCCEEDED',next_bar:500,total_bars:500}]}});
  try{
    await busy.open();busy.type(busy.parts.profile(),PROFILE);busy.parts.start().click();
    await until(()=>busy.gets('/api/quant/data/preflights').filter(call=>call.path==='/api/quant/data/preflights').length===2);
    await until(()=>/SUCCEEDED/.test(busy.parts.pJob().textContent));
    assert.match(busy.parts.pJob().textContent,new RegExp(PREFLIGHT),'the refusal adopts the active job so it can be watched');
  }finally{busy.w.close();}
});

test('Watching: back-off 3, 3, 5, 10, 20 s; stops on a refusal, a closed feature or five failures; pauses while hidden and resumes when shown',async()=>{
  const running=n=>({job_id:PROFILE,status:'RUNNING',next_bar:n,total_bars:100});
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'GET /api/quant/data/profiles/':[running(1),running(2),running(3),running(4)]}});
  try{await p.open();p.parts.enroll().click();await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));assert.deepEqual(p.delays,[3000,3000,5000,10000,20000]);}
  finally{p.w.close();}
  for(const [name,answers,stop] of [['404',[failure('NOT_FOUND',404)],1],['closed',[failure('QUANT_PROFILE_DISABLED',503)],1],
    ['five 5xx',Array.from({length:6},()=>failure('BAD_GATEWAY',502)),5]]){
    const x=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'GET /api/quant/data/profiles/':answers}});
    try{
      await x.open();x.parts.enroll().click();await until(()=>/Watching stopped/.test(x.parts.eJob().textContent));await settle(40);
      assert.equal(x.gets('/api/quant/data/profiles/').length,stop,name+': reads before stopping');
      const again=[...x.parts.eJob().querySelectorAll('button')].find(node=>node.textContent==='Check status');
      assert.ok(again,name+': a manual GET retry is offered');
    }finally{x.w.close();}
  }
  const v=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[{job_id:PROFILE,status:'RUNNING',next_bar:0,total_bars:100}]}});
  try{
    await v.open();v.setVisibility('hidden');v.parts.enroll().click();await settle(40);
    assert.equal(v.gets('/api/quant/data/profiles/').length,0,'hidden tab: no reads');
    v.setVisibility('visible');await until(()=>/Profile enrolled/.test(v.parts.eStatus().textContent));
    assert.equal(v.gets('/api/quant/data/profiles/').length,1,'shown again: the watch resumes');
  }finally{v.w.close();}
});

test('POST refusals map known, *_REQUIRED and unknown codes; step-up asks to press again',async()=>{
  for(const [error,text] of [[failure('PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED'),/Register the holdout boundary first\./],[failure('PREFLIGHT_SOMETHING_REQUIRED'),/A required earlier step is missing\./],
    [failure('BRAND_NEW_CODE'),/The request failed\./],[failure('STEP_UP_REQUIRED',403),/Confirm your identity, then press the button again\./]]){
    const x=setup({routes:{'POST /api/quant/data/preflights':[error]}});
    try{
      await x.open();x.type(x.parts.profile(),PROFILE);x.parts.start().click();await until(()=>x.parts.pStatus().querySelector('code'));
      assert.match(x.parts.pStatus().textContent,text);assert.equal(x.parts.pStatus().querySelector('code').textContent,error.code);
    }finally{x.w.close();}
  }
});

test('Thai: the panel translates; the runner pairs and the four new PF-3 pairs collide with no other pair',async()=>{
  const p=setup({language:'th'});
  try{await p.open();assert.equal(p.q('pfrTitle').textContent,'Preflight ย้อนหลัง (PF-2)');assert.equal(p.parts.start().textContent,'เริ่ม Preflight');}
  finally{p.w.close();}
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.localStorage.setItem('robotLanguage','th');
    w.eval(publicFile('i18n.js')+';window.__all=uiPairs;window.__mine=pfrPairs;window.__pf3=pf3Pairs;');
    const added=['Holdout accessed','Orders executed','Development window only','checked by server'];
    const mine=[...w.__mine,...w.__pf3.filter(pair=>added.includes(pair[0]))];
    assert.equal(mine.length,w.__mine.length+4);
    const others=w.__all.filter(pair=>!mine.includes(pair)),problems=[];
    for(const [en,th] of mine)for(const [otherEn,otherTh] of others){if(otherEn===en||otherEn===th)problems.push(en);if(otherTh===th||otherTh===en)problems.push(th);}
    assert.deepEqual(problems,[]);assert.equal(new Set(mine.map(pair=>pair[1])).size,mine.length,'duplicate Thai text');
    assert.ok(!w.__all.some(([en])=>en==='Job'||en==='bars'),'no generic pair that would rewrite data nodes');
    const source=publicFile('preflight-runner.js');
    for(const match of source.matchAll(/\b(?:label|button|field)\('([^'\n]+)'/g))assert.notEqual(w.translate(match[1]),match[1],'missing Thai: '+match[1]);
    for(const match of source.matchAll(/say\([^,()]+,null,'([^'\n]+)'/g))assert.notEqual(w.translate(match[1]),match[1],'missing Thai: '+match[1]);
    for(const match of source.matchAll(/^\s+[A-Z_0-9]+:'([^'\n]+)'/gm))assert.notEqual(w.translate(match[1]),match[1],'missing Thai: '+match[1]);
  }finally{w.close();}
});

test('preflight-runner.js writes only from buttons, stays markup-safe and keeps keys in memory',()=>{
  const source=publicFile('preflight-runner.js');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','.style','localStorage','indexedDB','confirm(','http://','https://'])
    assert.ok(!source.includes(banned),'preflight-runner.js must not contain '+banned);
  assert.equal([...source.matchAll(/method:'POST'/g)].length,3,'holdout, the shared enroll/Preflight submit, and cancel');
  assert.ok(publicFile('i18n.js').includes('.ov-data,.no-i18n,'),'data nodes are skipped by the language switch');
  // Every sessionStorage access sits inside the guarded store helper.
  const helper=source.slice(source.indexOf('const stored={'),source.indexOf('};',source.indexOf('const stored={')));
  assert.equal([...source.matchAll(/sessionStorage/g)].length,[...helper.matchAll(/sessionStorage/g)].length);
  for(const line of helper.split('\n').filter(text=>text.includes('sessionStorage')))assert.match(line,/try\{/,'guarded: '+line.trim());
});

const ENTRY='pfr.enroll.bot-1.bot-1',PF_ENTRY='pfr.preflight.bot-1.bot-1',INPUTS=JSON.stringify({bot_id:'bot-1',raw_job_id:RAW,deployment_id:DEPLOY});
test('Reload: a stored enroll entry adopts its job (GET only), blocks a second Enroll and is cleared on a terminal status',async()=>{
  const running={job_id:PROFILE,status:'RUNNING',next_bar:7,total_bars:100};
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},storage:{[ENTRY]:{inputs:INPUTS,key:'stored-key-123',job_id:PROFILE}},
    routes:{'GET /api/quant/data/profiles/':[running,running]}});
  try{
    await p.open();
    await until(()=>/RUNNING/.test(p.parts.eJob().textContent));
    assert.equal(p.parts.enroll().disabled,true,'the adopted job blocks a second Enroll');
    assert.equal(p.posts().length,0);
    await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
    assert.equal(p.w.sessionStorage.getItem(ENTRY),null,'a terminal status clears the entry');
  }finally{p.w.close();}
});

test('Reload during an unanswered POST: the stored key is reused for the same inputs; the entry is written before the request',async()=>{
  const slow=gate();
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},storage:{[ENTRY]:{inputs:INPUTS,key:'stored-key-123',job_id:null}},
    routes:{'POST /api/quant/data/profile-enrollments':[slow.promise.then(()=>({job_id:PROFILE,status:'QUEUED',next_bar:0,total_bars:100}))]}});
  try{
    await p.open();
    p.parts.enroll().click();await settle();
    assert.equal(p.posts()[0].key,'stored-key-123','the same inputs reuse the stored key');
    assert.deepEqual(JSON.parse(p.w.sessionStorage.getItem(ENTRY)),{inputs:INPUTS,key:'stored-key-123',job_id:null,unknown:true,blocked:false},'written before the answer; a reloaded entry without a job id counts as an unknown outcome');
    slow.open();await until(()=>JSON.parse(p.w.sessionStorage.getItem(ENTRY)||'{}').job_id===PROFILE||p.w.sessionStorage.getItem(ENTRY)===null);
    await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
  }finally{p.w.close();}
});

test('A refusal clears the entry, a network error keeps it, and blocked storage still works from memory',async()=>{
  const refused=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[failure('INVALID_FIELDS',400)]}});
  try{await refused.open();refused.parts.enroll().click();await until(()=>refused.parts.eStatus().querySelector('code'));assert.equal(refused.w.sessionStorage.getItem(ENTRY),null);}
  finally{refused.w.close();}
  const lost=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[new TypeError('Failed to fetch')]}});
  try{await lost.open();lost.parts.enroll().click();await until(()=>lost.parts.eStatus().querySelector('code'));
    assert.equal(JSON.parse(lost.w.sessionStorage.getItem(ENTRY)).key,lost.posts()[0].key,'an unanswered request keeps its key for the retry');}
  finally{lost.w.close();}
  const blocked=setup({raw:{job_id:RAW,status:'SUCCEEDED'},noStorage:true});
  try{await blocked.open();blocked.parts.enroll().click();await until(()=>/Profile enrolled/.test(blocked.parts.eStatus().textContent));assert.equal(blocked.posts().length,1);}
  finally{blocked.w.close();}
});

test('A change event alone unticks the holdout box; a listed Preflight of another bot is never adopted',async()=>{
  const p=setup({routes:{'GET /api/quant/data/preflights':[[{job_id:PREFLIGHT,bot_id:'bot-9',status:'RUNNING',next_bar:1,total_bars:500}]]}});
  try{
    await p.open();
    p.parts.hInput().value=minute(PAST);p.parts.hInput().dispatchEvent(new p.w.Event('change'));
    p.parts.hCheck().click();assert.equal(p.parts.hRegister().disabled,false);
    p.parts.hInput().value=minute(PAST-60000);p.parts.hInput().dispatchEvent(new p.w.Event('change'));
    assert.equal(p.parts.hCheck().checked,false);assert.match(p.parts.hPreview().textContent,/2026-09-29 23:59 UTC/);
    await settle(40);
    assert.equal(p.parts.pJob().textContent,'','a job of another bot is ignored');
    p.type(p.parts.profile(),PROFILE);assert.equal(p.parts.start().disabled,false);
  }finally{p.w.close();}
});

test('Unknown outcomes: a lost answer then a codeless 403 or RETRY_TRANSACTION keeps the key; a lost answer then a refusal blocks until a typed CLEAR',async()=>{
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[new TypeError('Failed to fetch'),failure(undefined,403),failure('RETRY_TRANSACTION'),failure('INVALID_FIELDS',400)]}});
  try{
    await p.open();
    const click=async n=>{p.parts.enroll().click();await until(()=>p.posts().length===n&&!p.parts.enroll().disabled||p.panel.querySelector('.pfr-blocked:not([hidden])'));};
    await click(1);await click(2);
    assert.match(p.parts.eStatus().textContent,/This attempt started nothing\. Sign in again if asked, then press the button again\./);
    await click(3);
    assert.equal(new Set(p.posts().map(call=>call.key)).size,1,'403 and RETRY_TRANSACTION keep the key');
    assert.equal(JSON.parse(p.w.sessionStorage.getItem(ENTRY)).key,p.posts()[0].key,'the entry stays');
    await click(4);
    assert.equal(p.posts()[3].key,p.posts()[0].key);
    const box=p.panel.querySelector('.pfr-blocked:not([hidden])');
    assert.ok(box,'a refusal after an unknown outcome holds the inputs');
    assert.match(box.textContent,/An earlier request may already have started a job\. Check with the operator before you send it again\./);
    assert.equal(p.parts.enroll().disabled,true,'no new key for these inputs');
    assert.equal(JSON.parse(p.w.sessionStorage.getItem(ENTRY)).blocked,true);
    const [typed]=box.querySelectorAll('input'),forget=box.querySelector('button');
    p.type(typed,'clear');assert.equal(forget.disabled,true,'the exact word is required');
    p.type(typed,'CLEAR');forget.click();
    assert.equal(p.parts.enroll().disabled,false);assert.equal(p.w.sessionStorage.getItem(ENTRY),null);
    p.parts.enroll().click();await until(()=>p.posts().length===5);
    assert.notEqual(p.posts()[4].key,p.posts()[0].key,'after CLEAR a new key is used');
    await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
  }finally{p.w.close();}
  const first=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[failure('INVALID_FIELDS',400)]}});
  try{
    await first.open();first.parts.enroll().click();await until(()=>first.parts.eStatus().querySelector('code'));
    assert.equal(first.w.sessionStorage.getItem(ENTRY),null,'a first-try refusal clears the entry');
    first.parts.enroll().click();await until(()=>first.posts().length===2);
    assert.notEqual(first.posts()[1].key,first.posts()[0].key,'and rotates the key');
    await until(()=>/Profile enrolled/.test(first.parts.eStatus().textContent));
  }finally{first.w.close();}
});

test('IDEMPOTENCY_CONFLICT retires the key without a block, even after an unknown outcome',async()=>{
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[new TypeError('Failed to fetch'),failure('IDEMPOTENCY_CONFLICT')]}});
  try{
    await p.open();
    p.parts.enroll().click();await until(()=>p.posts().length===1&&!p.parts.enroll().disabled);
    p.parts.enroll().click();await until(()=>p.posts().length===2&&!p.parts.enroll().disabled);
    assert.match(p.parts.eStatus().textContent,/The server holds a different request under this key\. Press the button again to send it with a new key\./);
    assert.equal(p.panel.querySelector('.pfr-blocked:not([hidden])'),null,'no block');assert.equal(p.w.sessionStorage.getItem(ENTRY),null,'the entry of that key goes');
    p.parts.enroll().click();await until(()=>p.posts().length===3);
    assert.notEqual(p.posts()[2].key,p.posts()[1].key,'the next click mints a new key');
    await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
  }finally{p.w.close();}
});

test('Adoption holds the buttons while its read is pending and clears an entry only when it still records the finished job',async()=>{
  const read=gate();
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},storage:{[ENTRY]:{inputs:INPUTS,key:'k1',job_id:PROFILE}},
    routes:{'GET /api/quant/data/profiles/':[read.promise.then(()=>({job_id:PROFILE,status:'RUNNING',next_bar:3,total_bars:100}))]}});
  try{
    await p.open();
    assert.equal(p.parts.enroll().disabled,true,'Enroll waits for the adoption read');
    const other={inputs:'{"other":1}',key:'k9',job_id:null};p.w.sessionStorage.setItem(ENTRY,JSON.stringify(other));
    read.open();await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
    assert.deepEqual(JSON.parse(p.w.sessionStorage.getItem(ENTRY)),other,'an entry of another request survives the end of this job');
  }finally{p.w.close();}
  const ended=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[{job_id:PROFILE,status:'FAILED',next_bar:0,total_bars:100}]}});
  try{await ended.open();ended.parts.enroll().click();await until(()=>/FAILED/.test(ended.parts.eJob().textContent));await settle();
    assert.equal(ended.w.sessionStorage.getItem(ENTRY),null,'a replayed job that already ended is settled at once');}
  finally{ended.w.close();}
});

test('Preflight entries persist like enroll: written before the POST, adopted after a reload; the entry name is fixed when the request starts',async()=>{
  const slow=gate();
  const p=setup({routes:{'POST /api/quant/data/preflights':[slow.promise.then(()=>({job_id:PREFLIGHT,status:'QUEUED',next_bar:0,total_bars:500}))]}});
  try{
    await p.open();p.type(p.parts.profile(),PROFILE);p.parts.start().click();await settle();
    const before=JSON.parse(p.w.sessionStorage.getItem(PF_ENTRY));
    assert.equal(before.key,p.posts()[0].key);assert.equal(before.job_id,null);
    p.w.eval('me={user:{id:"someone-else"}}');
    slow.open();await until(()=>JSON.parse(p.w.sessionStorage.getItem(PF_ENTRY)||'{}').job_id===PREFLIGHT||p.w.sessionStorage.getItem(PF_ENTRY)===null);
    assert.equal(p.w.sessionStorage.getItem('pfr.preflight.someone-else.bot-1'),null,'the answer lands under the name the request started with');
  }finally{p.w.close();}
  const r=setup({storage:{[PF_ENTRY]:{inputs:JSON.stringify({bot_id:'bot-1',deployment_id:DEPLOY,profile_job_id:PROFILE}),key:'pk',job_id:PREFLIGHT}},
    routes:{'GET /api/quant/data/preflights/':[{job_id:PREFLIGHT,status:'RUNNING',next_bar:5,total_bars:500},{job_id:PREFLIGHT,status:'RUNNING',next_bar:6,total_bars:500}]}});
  try{
    await r.open();await until(()=>/RUNNING/.test(r.parts.pJob().textContent));
    r.type(r.parts.profile(),PROFILE);assert.equal(r.parts.start().disabled,true,'the adopted Preflight blocks a second Start');
    await until(()=>/Preflight finished/.test(r.parts.pStatus().textContent));
  }finally{r.w.close();}
});

test('CLEAR on a blocked entry that holds a job id resets its stored flags and keeps the job id',async()=>{
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},storage:{[ENTRY]:{inputs:INPUTS,key:'k1',job_id:PROFILE,unknown:true,blocked:true}},
    routes:{'GET /api/quant/data/profiles/':[new TypeError('Failed to fetch')]}});
  try{
    await p.open();await until(()=>p.panel.querySelector('.pfr-blocked:not([hidden])'));
    const box=p.panel.querySelector('.pfr-blocked:not([hidden])');
    assert.match(box.textContent,/Sending it again after that may create a second job\./);
    p.type(box.querySelector('input'),'CLEAR');box.querySelector('button').click();
    assert.deepEqual(JSON.parse(p.w.sessionStorage.getItem(ENTRY)),{inputs:INPUTS,key:'k1',job_id:PROFILE,unknown:false,blocked:false});
  }finally{p.w.close();}
});

test('A success retires only the key of its inputs: I1 lost, I2 succeeds, back to I1 reuses its key; a replayed ended job shows its status',async()=>{
  const I2=RAW.replace('1111','1114');
  const p=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[new TypeError('Failed to fetch')]}});
  try{
    await p.open();
    p.parts.enroll().click();await until(()=>p.posts().length===1&&!p.parts.enroll().disabled);
    p.type(p.parts.raw(),I2);p.parts.enroll().click();await until(()=>/Profile enrolled/.test(p.parts.eStatus().textContent));
    p.type(p.parts.raw(),RAW);p.parts.enroll().click();await until(()=>p.posts().length===3);
    assert.equal(p.posts()[2].key,p.posts()[0].key,'I1 keeps its key after I2 succeeded');
    assert.notEqual(p.posts()[1].key,p.posts()[0].key);
    await until(()=>p.gets('/api/quant/data/profiles/').length===2);await settle(40);
  }finally{p.w.close();}
  const replay=setup({raw:{job_id:RAW,status:'SUCCEEDED'},routes:{'POST /api/quant/data/profile-enrollments':[{job_id:PROFILE,status:'FAILED',next_bar:0,total_bars:100}]}});
  try{await replay.open();replay.parts.enroll().click();await until(()=>/FAILED/.test(replay.parts.eJob().textContent));
    assert.doesNotMatch(replay.parts.eStatus().textContent,/queued/,'an ended job is not reported as queued');}
  finally{replay.w.close();}
});