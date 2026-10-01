import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
const utc=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC';
const HOUR=3600000;
const BANNER='Staging preview (P0). This page shows what runs on this staging release now and what each step still needs. It is not six-step acceptance. Paper only; Live is locked.';
// Exact owner-approved static copy. A change here must be a deliberate product decision.
const SPEC=[
  {n:1,title:'AI chatbot Bridge',view:'quant',now:'Quant Lab → Build Pine Bridge: inspect inputs locally (no AI), then Analyze/Generate sends the authorized indicator to the configured AI provider and returns a draft Pine with a guide.',next:'Re-verify one fresh end-to-end AI job on this release.'},
  {n:2,title:'Ten numeric inputs',view:'quant',now:'Contract supports 2–10 slots: up to eight selected numeric source inputs plus Bridge ATR Multiplier and RR.',next:'Select a supported source with eight eligible numeric inputs and round-trip all ten through UI, generated Pine and stored snapshot.'},
  {n:3,title:'Preflight and Risk settings',view:'risk',now:'Risk manager → Order Preview: saved or hypothetical Draft authority, Generic or Bridge mode, venue filters and cost estimates. A preview saves nothing.',next:'Historical Preflight on staging (PF-2/R7), PF-3 report and PF-4 deterministic recommendations with before/after values and explicit save.'},
  {n:4,title:'Real signals and Paper execution',view:'signals',now:'Trade log shows each signal from receipt through the Risk decision to the simulated Paper fill. Live trading stays locked.',next:'Trace one real TradingView BUY and targeted EXIT with ledger evidence in a bounded observation window.'},
  {n:5,title:'Quant optimizer',view:'quant',now:'Historical runs appear with their original run identity. New research jobs stay closed until the foundation gates pass.',next:'Foundation migration and startup (B2), one bounded dataset (B3), diagnostics (W7), D6/R7, then one admitted bounded job with declared budget and holdout rules.'},
  {n:6,title:'Quant Library and selection',view:'quant',now:'History lists preserved runs, including failures. It is not a qualified recommendation; no qualified winner exists.',next:'QR-1 durable library storage and view, QR-3 comparison and QR-4 qualification.'}
];
const HASH_A='a'.repeat(64),HASH_B='b'.repeat(64),HASH_C='c'.repeat(64);

// Test fixtures only: the product UI never contains canned data. Everything the page shows comes from the stubbed API.
function fixtures(now=Date.now()){
  const run=(i,extra={})=>({run_id:'3f2a9c1e-0000-4000-8000-00000000000'+i,bot_id:'bot-1',deployment_id:'dep-'+i,status:i?'FAILED':'NO_VALID_CANDIDATE',phase:'COMPLETE',
    created_at:now-i*48*HOUR,updated_at:now-i*48*HOUR,attempts:1,evaluations_started:100,contract_hash:HASH_A,source_hash:HASH_A,baseline_snapshot_hash:HASH_B,input_lock_hash:HASH_B,
    dataset_hash:HASH_C,source_slots:[{slot:3,input_id:'i3',pine_variable:'emaFastInput',effective_value:50,search_domain:{min:30,max:70,step:10}},
      {slot:4,input_id:'i4',pine_variable:'emaSlowInput',effective_value:200,search_domain:{min:150,max:250,step:25}},{slot:5,input_id:'i5',pine_variable:'atrLenInput',effective_value:14,search_domain:{min:10,max:20,step:2}}],
    bridge_domains:{atr_multiplier:[1.5,2,2.5,3],rr:[1,1.5,2]},candidates_completed:100-i,candidates_planned:100,
    result_summary:i?null:{completion_reason:'NO_VALID_TRAIN_VALIDATION_CANDIDATE',candidate_count:100},diagnostic:null,owner_recommendation_ready:false,...extra});
  const overview={bridge_enabled:true,capture_enabled:false,ai:{provider:'openai-chat',model:'gpt-4.1-mini',configured:true},
    sources:{count:2,latest:{pine_import_id:'11111111-2222-4333-8444-555555555555',source_name:'My indicator',source_version:1,source_hash:HASH_A,created_at:now-9*HOUR,
      numeric_inputs:{total:10,eligible:8,reviewed:true,selected_slots:3}}},
    jobs:{by_status:{FAILED:1,SUCCEEDED:2},latest:{job_id:'job-1',operation:'generate',job_status:'SUCCEEDED',created_at:now-5*HOUR,updated_at:now-5*HOUR,attempts:1,
      usage_summary:{input_tokens:1200,output_tokens:800,cost_usd:0.00176},diagnostic:null,has_draft:true}},
    deployments:{by_state:{DRAFT:2,READY:1},latest_ready:{deployment_id:'d1d1d1d1-aaaa-4bbb-8ccc-dddddddddddd',source_version:1,snapshot_hash:HASH_B,created_at:now-3*HOUR}}};
  const history={admission_enabled:false,total_runs:7,runs:[0,1,2,3,4].map(i=>run(i))};
  const bots={bots:[{id:'bot-1',label:'Staging Bot'},{id:'bot-2',label:'Second Bot'}],maxBots:5};
  const session={me:{botSession:{state:'SETUP'},paperAccounts:[{broker:'binance-global'}],bot:{id:'bot-1',label:'Staging Bot'}},
    signals:[{received_at:now-1*HOUR,status:'FILLED'},{received_at:now-2*HOUR,status:'REJECTED'},{received_at:now-3*HOUR,status:'QUEUED'},{received_at:now-30*HOUR,status:'FILLED'}]};
  return {now,run,overview,history,bots,session};
}
const answer=fx=>path=>{
  if(path==='/api/bots')return fx.bots;
  if(path==='/api/quant/pine-bridge/overview')return fx.overview;
  if(path.startsWith('/api/quant/research/history'))return fx.history;
  throw new Error('Unexpected '+path);
};
const apiError=(code,status=503)=>Object.assign(new Error(code||'Request failed'),{code,status});

function setup({language,handler,session}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[];
  w.api=async(path,options)=>{calls.push({path,options});return handler(path,options);};
  if(session){w.me=session.me;w.signals=session.signals;}
  w.eval(publicFile('journey.js'));
  const card=n=>d.querySelector('.jr-card[data-step="'+n+'"]');
  const text=n=>card(n).textContent.replace(/\s+/g,' ').trim();
  const chip=n=>card(n).querySelector('.jr-chip').textContent;
  const open=async()=>{d.querySelector('nav button[data-view="journey"]').click();await settle();};
  return {dom,w,d,calls,card,text,chip,open};
}

// Key/value evidence rows as {label: value}; sentence rows as a list.
const rowsOf=(p,n)=>Object.fromEntries([...p.card(n).querySelectorAll('.jr-ev .jr-k')].map(key=>[key.textContent,key.nextElementSibling.textContent]));
const notesOf=(p,n)=>[...p.card(n).querySelectorAll('.jr-note')].map(item=>item.textContent);
const errorsOf=(p,n)=>[...p.card(n).querySelectorAll('.jr-ev-error')].map(item=>item.textContent);

test('index.html adds the journey nav right after Overview, a hidden page with the exact banner and versioned scripts',()=>{
  const html=publicFile('index.html'),dom=new JSDOM(html),d=dom.window.document;
  try{
    assert.deepEqual([...d.querySelectorAll('#primaryNav button')].slice(0,3).map(button=>button.dataset.view),['overview','journey','signals']);
    assert.equal(d.querySelector('#primaryNav [data-view="journey"]').textContent,'Prototype journey');
    const section=d.querySelector('section[data-page="journey"]');
    assert.ok(section&&section.hidden);
    assert.equal(section.querySelector('.jr-banner p').textContent,BANNER);
    assert.ok(section.querySelector('#journeyRoot'));
    assert.equal(section.querySelector('[style]'),null,'the CSP forbids inline styles');
    const order=['/i18n.js?v=','/app.js?v=','/pine-bridge.js?v=','/journey.js?v=p0j1'].map(part=>html.indexOf(part));
    assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'journey.js loads after i18n.js, app.js and pine-bridge.js');
    assert.match(html,/styles-v2\.css\?v=p0j1/);assert.match(html,/i18n\.js\?v=p0j1/);
  }finally{dom.window.close();}
});

test('renders six step cards with the exact static status text and an Open button each',()=>{
  const p=setup({handler:answer(fixtures())});
  try{
    assert.equal(p.d.querySelectorAll('.jr-card').length,6);
    for(const spec of SPEC){
      const card=p.card(spec.n);
      assert.equal(card.querySelector('.jr-num').textContent,String(spec.n));
      assert.equal(card.querySelector('.jr-title').textContent.trim(),spec.n+' '+spec.title);
      const blocks=[...card.querySelectorAll('.jr-block')];
      assert.deepEqual(blocks.map(block=>block.querySelector('h3').textContent),['Available now','Evidence','Next dependency']);
      assert.equal(blocks[0].querySelector('p').textContent,spec.now);
      assert.equal(blocks[2].querySelector('p').textContent,spec.next);
      assert.equal(card.querySelector('button.jr-open').textContent,'Open');
      assert.equal(card.querySelector('button.jr-open').type,'button');
    }
    assert.equal(p.d.querySelector('.jr-banner p').textContent,BANNER);
    assert.equal(p.calls.length,0,'nothing is requested before the page is opened');
  }finally{p.w.close();}
});

test('chips follow the live API data and the loaded session',async()=>{
  const fx=fixtures(),p=setup({handler:answer(fx),session:fx.session});
  try{
    await p.open();
    assert.deepEqual([1,2,3,4,5,6].map(n=>p.chip(n)),['Live on staging','Partial','Preview available','Receiving','Paused — admission closed','Planned']);
    assert.deepEqual([1,2,3,4,5,6].map(n=>p.card(n).querySelector('.jr-chip').className),['jr-chip jr-ok','jr-chip jr-warn','jr-chip jr-info','jr-chip jr-ok','jr-chip jr-warn','jr-chip jr-muted']);
  }finally{p.w.close();}
  const variants=[
    ['admission open',f=>{f.history.admission_enabled=true;},5,'Admission open'],
    ['Bridge disabled',f=>{f.overview={bridge_enabled:false};},1,'Unavailable'],
    ['AI provider not configured',f=>{f.overview.ai={provider:null,model:null,configured:false};},1,'Unavailable'],
    ['no signal within 24 hours',f=>{f.session.signals=[{received_at:f.now-30*HOUR,status:'FILLED'}];},4,'Idle'],
    ['no signals at all',f=>{f.session.signals=[];},4,'Idle']];
  for(const [name,change,step,expected] of variants){
    const f=fixtures();change(f);
    const q=setup({handler:answer(f),session:f.session});
    try{await q.open();assert.equal(q.chip(step),expected,name);}finally{q.w.close();}
  }
  const unknown=setup({handler:answer(fx)});
  try{await unknown.open();assert.equal(unknown.chip(4),'Unavailable');assert.deepEqual(notesOf(unknown,4),['Not available']);}finally{unknown.w.close();}
});

test('evidence comes from the API responses, with long hashes in wrapping containers',async()=>{
  const fx=fixtures(),p=setup({handler:answer(fx),session:fx.session});
  try{
    await p.open();
    assert.deepEqual(rowsOf(p,1),{'AI provider':'openai-chat · gpt-4.1-mini','Analyzed sources':'2','Latest source':'My indicator · v1','Source hash':HASH_A,
      'AI jobs':'FAILED 1 · SUCCEEDED 2','Latest job':'generate · SUCCEEDED · '+utc(fx.now-5*HOUR)+' · draft returned','AI usage (latest job)':'1200 in / 800 out tokens · USD 0.00176'});
    assert.deepEqual(rowsOf(p,2),{'Latest research run':'3f2a9c1e','Source slots in run':'3','ATR multiplier grid':'1.5–3 (4 values)','RR grid':'1–2 (3 values)'});
    assert.deepEqual(rowsOf(p,3),{'Bot session':'SETUP','Paper accounts':'1','Bots':'2 / 5','Ready Bridge deployments':'1',
      'Latest ready deployment':'d1d1d1d1 · v1 · '+utc(fx.now-3*HOUR),'Snapshot hash':HASH_B});
    assert.deepEqual(rowsOf(p,4),{'Bot scope':'Staging Bot','Signals received (24 h)':'3','Filled (24 h)':'1','Rejected (24 h)':'1','Latest signal received':utc(fx.now-1*HOUR)});
    assert.deepEqual(rowsOf(p,5),{'Latest run status':'NO_VALID_CANDIDATE','Candidates':'100 / 100','Run ID':'3f2a9c1e','Dataset hash':HASH_C,
      'Created (UTC)':utc(fx.now),'Completion reason':'NO_VALID_TRAIN_VALIDATION_CANDIDATE'});
    assert.deepEqual(notesOf(p,6),['7 preserved research runs (history only)']);
    const runs=[...p.card(6).querySelectorAll('li.jr-run')];
    assert.equal(runs.length,5);
    assert.deepEqual([...runs[0].children].map(item=>item.textContent),['NO_VALID_CANDIDATE',utc(fx.now),'100/100 Candidates','3f2a9c1e']);
    assert.deepEqual([...runs[1].children].map(item=>item.textContent),['FAILED',utc(fx.now-48*HOUR),'99/100 Candidates','3f2a9c1e']);
    assert.equal([...p.d.querySelectorAll('.jr-v .jr-hash')].filter(item=>item.textContent.length===64).length,3,'full 64-character hashes sit in .jr-hash');
    assert.match(p.d.querySelector('.jr-stamp').textContent,/^Status checked: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
  }finally{p.w.close();}
});

test('step 2 falls back to the latest source inputs and then to an explicit empty state',async()=>{
  const fx=fixtures();fx.history.runs=[];fx.history.total_runs=0;
  const p=setup({handler:answer(fx),session:fx.session});
  try{
    await p.open();
    assert.deepEqual(rowsOf(p,2),{'Latest source':'My indicator · v1','Numeric inputs':'10','Eligible numeric inputs':'8','Input review confirmed':'Yes','Selected source slots':'3'});
    assert.deepEqual(notesOf(p,5),['No research runs recorded yet.']);
    assert.deepEqual(notesOf(p,6),['0 preserved research runs (history only)']);
    assert.equal(p.card(6).querySelectorAll('li').length,0);
  }finally{p.w.close();}
  const empty=fixtures();empty.history.runs=[];empty.overview.sources={count:0,latest:null};
  const q=setup({handler:answer(empty),session:empty.session});
  try{await q.open();assert.deepEqual(notesOf(q,2),['No analyzed source or research run yet.']);}finally{q.w.close();}
  const unreviewed=fixtures();unreviewed.history.runs=[];unreviewed.overview.sources.latest.numeric_inputs={total:4,eligible:0,reviewed:false,selected_slots:null};
  const r=setup({handler:answer(unreviewed),session:unreviewed.session});
  try{await r.open();assert.equal(rowsOf(r,2)['Input review confirmed'],'No');assert.equal(rowsOf(r,2)['Selected source slots'],'—');}finally{r.w.close();}
  const unknown=fixtures();unknown.history.runs=[];unknown.overview.sources.latest.numeric_inputs=null;
  const s=setup({handler:answer(unknown),session:unknown.session});
  try{await s.open();assert.deepEqual(notesOf(s,2),['Input details are not available for the latest source.']);}finally{s.w.close();}
});

test('an API failure shows Not available with its code on the affected cards and never blanks the others',async()=>{
  const fx=fixtures();
  const failing=(failures)=>path=>{
    for(const [prefix,error] of Object.entries(failures))if(path.startsWith(prefix))throw error;
    return answer(fx)(path);
  };
  const bridge=setup({handler:failing({'/api/quant/pine-bridge/overview':apiError('PINE_BRIDGE_DISABLED')}),session:fx.session});
  try{
    await bridge.open();
    assert.equal(bridge.chip(1),'Unavailable');
    assert.deepEqual(errorsOf(bridge,1),['Not available (PINE_BRIDGE_DISABLED)']);
    assert.deepEqual(errorsOf(bridge,3),['Not available (PINE_BRIDGE_DISABLED)']);
    assert.equal(rowsOf(bridge,3)['Bot session'],'SETUP');
    assert.equal(rowsOf(bridge,2)['Source slots in run'],'3','step 2 still uses the research history');
    assert.deepEqual([4,5,6].map(n=>bridge.chip(n)),['Receiving','Paused — admission closed','Planned']);
    assert.equal(rowsOf(bridge,5)['Latest run status'],'NO_VALID_CANDIDATE');
  }finally{bridge.w.close();}
  const history=setup({handler:failing({'/api/quant/research/history':apiError('QUANT_HISTORY_UNAVAILABLE',500)}),session:fx.session});
  try{
    await history.open();
    assert.deepEqual(errorsOf(history,5),['Not available (QUANT_HISTORY_UNAVAILABLE)']);
    assert.deepEqual(errorsOf(history,6),['Not available (QUANT_HISTORY_UNAVAILABLE)']);
    assert.deepEqual([history.chip(5),history.chip(6)],['Unavailable','Planned']);
    assert.equal(rowsOf(history,2)['Numeric inputs'],'10','step 2 falls back to the latest source');
    assert.equal(history.chip(1),'Live on staging');assert.equal(rowsOf(history,1)['AI provider'],'openai-chat · gpt-4.1-mini');
    assert.equal(history.chip(4),'Receiving');
  }finally{history.w.close();}
  const bots=setup({handler:failing({'/api/bots':apiError(undefined,500)}),session:fx.session});
  try{await bots.open();assert.deepEqual(errorsOf(bots,3),['Not available (HTTP_500)']);assert.equal(rowsOf(bots,3)['Ready Bridge deployments'],'1');}finally{bots.w.close();}
  const network=setup({handler:failing({'/api/bots':new TypeError('Failed to fetch'),'/api/quant/pine-bridge/overview':apiError('A_CODE'),'/api/quant/research/history':apiError('B_CODE')}),session:fx.session});
  try{
    await network.open();
    assert.deepEqual(errorsOf(network,3),['Not available (REQUEST_FAILED)','Not available (A_CODE)']);
    assert.deepEqual(errorsOf(network,2),['Not available (B_CODE, A_CODE)']);
    assert.equal(network.chip(4),'Receiving');
  }finally{network.w.close();}
});

test('an unexpected response shape degrades only the cards that read it',async()=>{
  const fx=fixtures(),p=setup({handler:path=>path.startsWith('/api/quant/research/history')?null:answer(fx)(path),session:fx.session});
  try{
    await p.open();
    assert.deepEqual([2,5,6].map(n=>errorsOf(p,n)),[['Not available (RENDER_ERROR)'],['Not available (RENDER_ERROR)'],['Not available (RENDER_ERROR)']]);
    assert.equal(p.chip(1),'Live on staging');assert.equal(p.chip(4),'Receiving');
    assert.equal(rowsOf(p,3)['Bots'],'2 / 5');
  }finally{p.w.close();}
});

test('opening loads three independent owner-scoped reads; Refresh reloads only while the page is visible; stale answers are ignored',async()=>{
  const fx=fixtures(),p=setup({handler:answer(fx),session:fx.session});
  try{
    await p.open();
    assert.deepEqual(p.calls.map(call=>call.path),['/api/bots','/api/quant/pine-bridge/overview','/api/quant/research/history?limit=5']);
    assert.ok(p.calls.every(call=>call.options.silent===true&&call.options.botId===''&&call.options.method===undefined),'GET only, no bot_id scope, no Saved toast');
    const section=p.d.querySelector('section[data-page="journey"]');
    p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.calls.length,3,'hidden page: Refresh loads nothing');
    section.hidden=false;
    p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.calls.length,6,'visible page: Refresh reloads all three');
  }finally{p.w.close();}
  const slow=fixtures(),stale=structuredClone(slow.overview);stale.ai.model='stale-model';
  let overviewCalls=0;
  const q=setup({session:slow.session,handler:path=>{
    if(path!=='/api/quant/pine-bridge/overview')return answer(slow)(path);
    return ++overviewCalls===1?new Promise(resolve=>setTimeout(()=>resolve(stale),80)):slow.overview;
  }});
  try{
    await q.open();await q.open();
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(overviewCalls,2);
    assert.equal(rowsOf(q,1)['AI provider'],'openai-chat · gpt-4.1-mini','the older, slower answer never replaces the newer one');
  }finally{q.w.close();}
});

test('Thai switch translates every static text and re-renders dynamic evidence; English restores it',async()=>{
  const fx=fixtures(),p=setup({language:'th',handler:answer(fx),session:fx.session});
  try{
    const {d,w}=p;
    assert.equal(d.querySelector('.jr-banner p').textContent,'พรีวิวบน Staging (P0) หน้านี้แสดงสิ่งที่ทำงานอยู่บน Staging รุ่นนี้ในตอนนี้ และสิ่งที่แต่ละขั้นตอนยังต้องมีเพิ่ม ไม่ใช่การรับรองครบทั้งหกขั้นตอน ใช้ Paper เท่านั้น ส่วน Live ถูกล็อก');
    assert.equal(d.querySelector('#primaryNav [data-view="journey"]').textContent,'เส้นทางต้นแบบ');
    await p.open();
    assert.deepEqual([1,2,3,4,5,6].map(n=>p.chip(n)),['ใช้งานได้บน Staging','ทำได้บางส่วน','ดูตัวอย่างได้','กำลังรับสัญญาณ','หยุดชั่วคราว — ปิดรับงาน','วางแผนไว้']);
    assert.equal(p.card(2).querySelector('.jr-title').textContent.trim(),'2 Input ตัวเลขสิบตัว');
    assert.deepEqual(notesOf(p,6),['7 การรันวิจัยที่เก็บรักษาไว้ (เฉพาะประวัติ)']);
    assert.equal(p.card(6).querySelector('li.jr-run .jr-run-count').textContent,'100/100 Candidate');
    assert.equal(rowsOf(p,2)['ตารางค่า ATR multiplier'],'1.5–3 (4 ค่า)');
    assert.match(d.querySelector('.jr-stamp').textContent,/^ตรวจสถานะเมื่อ: /);
    for(const element of d.querySelectorAll('[data-page="journey"] [data-ui-label]')){
      const label=element.dataset.uiLabel;
      assert.equal(element.textContent,w.translate(label),label);
      if(label!=='AI chatbot Bridge')assert.notEqual(element.textContent,label,'untranslated: '+label);
    }
    const language=d.querySelector('#language');
    language.value='en';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(d.querySelector('.jr-banner p').textContent,BANNER);
    assert.deepEqual([1,2,3,4,5,6].map(n=>p.chip(n)),['Live on staging','Partial','Preview available','Receiving','Paused — admission closed','Planned']);
    assert.deepEqual(notesOf(p,6),['7 preserved research runs (history only)']);
    assert.equal(p.card(1).querySelector('.jr-block p').textContent,SPEC[0].now);
    language.value='th';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(p.chip(6),'วางแผนไว้');assert.equal(rowsOf(p,5)['รหัสรัน'],'3f2a9c1e');
  }finally{p.w.close();}
});

test('journey translations are complete, unique, free of collisions and keep their placeholders',()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.localStorage.setItem('robotLanguage','th');
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=journeyPairs;');
    const source=publicFile('journey.js'),literals=new Set([BANNER,'Prototype journey']);
    for(const match of source.matchAll(/\b(?:T|tpl|label|chip|note|row)\(\s*'([^'\n]*)'/g))literals.add(match[1]);
    for(const match of source.matchAll(/\b(?:title|now|next):\s*'([^'\n]*)'/g))literals.add(match[1]);
    assert.ok(literals.size>80,'literal extraction found the static strings');
    for(const text of literals)if(text!=='AI chatbot Bridge')assert.notEqual(w.translate(text),text,'missing Thai: '+text);
    const mine=[...w.__mine],others=w.__pairs.filter(pair=>!w.__mine.includes(pair));
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const text of english)assert.ok(literals.has(text),'pair for text no longer shown: '+text);
    for(const [en,th] of mine){
      assert.notEqual(en,th);
      assert.deepEqual([...en.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...th.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),'placeholders differ: '+en);
    }
    for(const [en,th] of others){for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);}
  }finally{w.close();}
});

test('hostile API text is shown as text and source, draft, secret or provider fields are never rendered',async()=>{
  const fx=fixtures();
  fx.overview.sources.latest.source_name='<img src=x onerror=alert(1)>';
  fx.overview.sources.latest.source='//@version=6 SECRET_PINE_SOURCE';
  fx.overview.jobs.latest.diagnostic='<script>boom()</script>';
  fx.overview.jobs.latest.result={integrated_pine:'DRAFT_PINE_TEXT',webhook_setup:'GUIDE_TEXT'};
  fx.overview.jobs.latest.provider_request_id='req-secret';fx.overview.jobs.latest.idempotency_key='idem-secret';
  fx.overview.webhook_url='https://hooks.example/secret-path';fx.overview.ai.api_key='sk-test-secret';
  fx.history.runs[0].source='//@version=6 SECRET_RUN_SOURCE';fx.history.runs[0].contract={source:'CONTRACT_SOURCE'};fx.history.runs[0].steps=[{result:'STEP_PAYLOAD'}];
  fx.history.runs[0].diagnostic='<b onmouseover=bad()>x</b>';
  const p=setup({handler:answer(fx),session:fx.session});
  try{
    await p.open();
    const page=p.d.querySelector('section[data-page="journey"]');
    assert.equal(page.querySelectorAll('img,script,b,iframe,a').length,0);
    assert.equal(page.querySelector('[onerror],[onmouseover],[style]'),null);
    assert.ok(page.textContent.includes('<img src=x onerror=alert(1)>'));
    assert.ok(page.textContent.includes('<script>boom()</script>'));
    assert.ok(page.textContent.includes('<b onmouseover=bad()>x</b>'));
    assert.doesNotMatch(page.textContent,/SECRET_PINE_SOURCE|SECRET_RUN_SOURCE|CONTRACT_SOURCE|STEP_PAYLOAD|DRAFT_PINE_TEXT|GUIDE_TEXT|req-secret|idem-secret|hooks\.example|sk-test-secret/);
  }finally{p.w.close();}
});

test('Open buttons click the matching navigation entry; steps 1 and 2 also open the Build Pine Bridge panel',async()=>{
  const p=setup({handler:answer(fixtures())});
  try{
    const {d}=p,clicked=[];
    d.querySelector('[data-page="quant"]').insertAdjacentHTML('beforeend','<details class="panel"><summary>Build Pine Bridge — draft preview</summary></details>');
    const details=d.querySelector('[data-page="quant"] details');
    d.querySelectorAll('#primaryNav button').forEach(button=>button.addEventListener('click',()=>clicked.push(button.dataset.view)));
    let scrolled=0;details.scrollIntoView=()=>{scrolled++;};
    for(const spec of SPEC){
      clicked.length=0;details.open=false;
      p.card(spec.n).querySelector('button.jr-open').click();
      assert.deepEqual(clicked,[spec.view],'step '+spec.n);
      assert.equal(details.open,spec.n<=2,'Build Pine Bridge panel for step '+spec.n);
    }
    assert.equal(scrolled,2);
  }finally{p.w.close();}
  const bare=setup({handler:answer(fixtures())});
  try{bare.card(1).querySelector('button.jr-open').click();}finally{bare.w.close();}
});

test('works with app.js: nav shows the page, Thai title, owner-scoped requests and Refresh re-reads the session',async()=>{
  const fx=fixtures(),dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document,requests=[];
  try{
    w.fetch=async path=>{
      requests.push(path);
      const route=path.split('?')[0];
      const body=route==='/api/bots'?fx.bots:route==='/api/quant/pine-bridge/overview'?fx.overview:route==='/api/quant/research/history'?fx.history:null;
      return {ok:body!==null,json:async()=>body??{error:'Unexpected '+path}};
    };
    w.freshMe=fx.session.me;w.freshSignals=fx.session.signals;
    w.eval(publicFile('i18n.js')+'\n'+publicFile('app.js')+`
      authenticated=true;selectedBot='bot-2';me=window.freshMe;signals=window.freshSignals;
      load=async function(){await new Promise(resolve=>setTimeout(resolve,5));me=window.freshMe;signals=window.freshSignals;};
    `+'\n'+publicFile('journey.js'));
    const card=n=>d.querySelector('.jr-card[data-step="'+n+'"]');
    d.querySelector('nav button[data-view="journey"]').click();await settle();
    assert.equal(d.querySelector('[data-page="journey"]').hidden,false);
    assert.equal(d.querySelector('#pageTitle').textContent,'Prototype journey');
    assert.deepEqual(requests,['/api/bots','/api/quant/pine-bridge/overview','/api/quant/research/history?limit=5'],'no bot_id even with Bot 2 selected');
    assert.match(card(4).textContent,/Signals received \(24 h\)3/);
    w.freshSignals=[{received_at:fx.now-HOUR,status:'FILLED'}];
    d.querySelector('#refresh').click();await settle();
    assert.equal(requests.length,6);
    assert.match(card(4).textContent,/Signals received \(24 h\)1Filled \(24 h\)1Rejected \(24 h\)0/);
    const language=d.querySelector('#language');language.value='th';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(d.querySelector('#pageTitle').textContent,'เส้นทางต้นแบบ');
    assert.equal(d.querySelector('nav button[data-view="journey"]').textContent,'เส้นทางต้นแบบ');
  }finally{w.close();}
});

test('journey.js stays read-only, self-contained and CSP-safe',()=>{
  const source=publicFile('journey.js');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket','localStorage','sessionStorage','setAttribute(','.style','http://','https://','onclick='])
    assert.ok(!source.includes(banned),'forbidden in journey.js: '+banned);
  const paths=[...source.matchAll(/'(\/api\/[^']*)'/g)].map(match=>match[1]).sort();
  assert.deepEqual(paths,['/api/bots','/api/quant/pine-bridge/overview','/api/quant/research/history?limit=']);
  assert.ok(!/method\s*:/.test(source),'only GET requests');
  assert.equal(source.split('=>api(path,').length-1,1,'a single api() call site');
});

test('journey styles keep the page inside a 390px viewport and wrap long hashes',()=>{
  const css=publicFile('styles-v2.css'),block=css.slice(css.indexOf('/* Prototype journey'));
  assert.ok(block.length>500);
  const rule=selector=>{const at=block.indexOf(selector+'{');assert.ok(at>=0,'missing rule '+selector);return block.slice(at,block.indexOf('}',at));};
  assert.ok(rule('.jr-root').includes('grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))'),'cards never need more than the viewport width');
  assert.ok(block.includes('@media(max-width:600px){.jr-root{grid-template-columns:minmax(0,1fr)}.jr-open{width:100%}}'),'single column on phones');
  for(const selector of ['.jr-card','.jr-v','.jr-run'])assert.ok(rule(selector).includes('min-width:0'),selector+' may shrink');
  for(const selector of ['.jr-v','.jr-hash','.jr-note','.jr-run','.jr-banner p','.jr-title'])assert.ok(rule(selector).includes('overflow-wrap:anywhere'),selector+' wraps long text');
  assert.ok(rule('.jr-hash').includes('word-break:break-all'));
  assert.ok(!block.includes('nowrap'),'nothing is forced onto one line');
  assert.ok(!/min-width:\d+px/.test(block)&&!/[^-]width:\d{3,}px/.test(block),'no fixed widths wider than a phone');
  assert.ok(rule('.jr-open').includes('min-height:44px'),'touch target');
  assert.ok(css.includes('.analytics-page[hidden]{display:none}'),'existing hidden convention untouched');
  assert.ok(!block.includes('[hidden]')||block.includes('.jr-stamp'),'no rule overrides the hidden attribute of the page section');
  assert.ok(!/\.jr-(page|root)[^{]*\{[^}]*display:(?!grid)/.test(block));
});

// PF-3 hook (P1-B1): step 3 learns the readiness verdict from the pf3:report event of the Risk panel. No request, no bot_id.
const announce=(p,detail)=>p.d.dispatchEvent(new p.w.CustomEvent('pf3:report',{detail}));
const READINESS={bot_id:'bot-1',verdict:'CAPABILITY_UNAVAILABLE',historical_status:'UNAVAILABLE',generated_at:'2026-10-02T12:00:00.000Z'};

test('step 3 appends the readiness rows only after a pf3:report event; the chip and every other row stay as they were',async()=>{
  const fx=fixtures(),p=setup({handler:answer(fx),session:fx.session});
  try{
    await p.open();
    const before=rowsOf(p,3),chipBefore=p.chip(3),requests=p.calls.length;
    assert.equal(before['Readiness verdict'],undefined,'no readiness row without a report');
    announce(p,READINESS);await settle();
    assert.deepEqual(rowsOf(p,3),{...before,'Readiness verdict':'CAPABILITY_UNAVAILABLE','Report bot':'bot-1',
      'Report time':'2026-10-02 12:00:00 UTC','Historical evidence':'UNAVAILABLE'});
    assert.equal(p.chip(3),chipBefore);assert.equal(chipBefore,'Preview available');
    assert.equal(p.calls.length,requests,'the event causes no request');
    assert.equal(p.card(3).querySelector('.jr-v .jr-hash').textContent.length>0,true);
    // A newer report replaces the rows; a malformed event removes them instead of leaving stale values.
    announce(p,{...READINESS,verdict:'READY_TO_START_PAPER',historical_status:'AVAILABLE'});await settle();
    assert.equal(rowsOf(p,3)['Readiness verdict'],'READY_TO_START_PAPER');assert.equal(rowsOf(p,3)['Historical evidence'],'AVAILABLE');
    announce(p,null);await settle();
    assert.equal(rowsOf(p,3)['Readiness verdict'],undefined);
    announce(p,{verdict:7});await settle();assert.equal(rowsOf(p,3)['Readiness verdict'],undefined);
    announce(p,{...READINESS,generated_at:'not a time'});await settle();
    assert.equal(rowsOf(p,3)['Report time'],'—');
    // Logout clears the readiness rows with the rest of the page.
    announce(p,READINESS);await settle();assert.equal(rowsOf(p,3)['Readiness verdict'],'CAPABILITY_UNAVAILABLE');
    p.d.querySelector('#logout').click();await settle();
    assert.equal(rowsOf(p,3)['Readiness verdict'],undefined);
    for(const n of [1,2,4,5,6])assert.equal(rowsOf(p,n)['Readiness verdict'],undefined,'only step 3 reads the event');
  }finally{p.w.close();}
});

test('the readiness rows of step 3 and the journey page stay text only and translate to Thai',async()=>{
  const fx=fixtures(),p=setup({language:'th',handler:answer(fx),session:fx.session});
  try{
    await p.open();
    announce(p,{...READINESS,bot_id:'<img src=x onerror=alert(1)>'});await settle();
    const rows=rowsOf(p,3);
    assert.equal(rows['ผลประเมินความพร้อม'],'CAPABILITY_UNAVAILABLE');assert.equal(rows['หลักฐานย้อนหลัง'],'UNAVAILABLE');
    assert.equal(rows['เวลาของรายงาน'],'2026-10-02 12:00:00 UTC');assert.equal(rows['Bot ของรายงาน'],'<img src=x onerror=alert(1)>');
    assert.equal(p.d.querySelectorAll('[data-page="journey"] img').length,0);
    for(const element of p.d.querySelectorAll('[data-page="journey"] [data-ui-label]')){
      const label=element.dataset.uiLabel;assert.equal(element.textContent,p.w.translate(label),label);
    }
    const language=p.d.querySelector('#language');
    language.value='en';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(rowsOf(p,3)['Readiness verdict'],'CAPABILITY_UNAVAILABLE');
  }finally{p.w.close();}
});
