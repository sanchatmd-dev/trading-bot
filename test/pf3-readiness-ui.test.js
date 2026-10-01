import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildReadinessReport} from '../src/postgres/pf3-readiness-report.js';
import {HEALTHY,changePolicy,createEnvelopeWorld,persistentPause,pf3Facts} from './helpers/pf3-envelope-fixture.js';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
const utc=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC';
const FIXED='Diagnostic only. Not approval to Run. Saves nothing.';
const HEADING='Diagnostic only — saves nothing, starts nothing';
const WARNING='Saving Risk changes makes READY Bridge deployments stale; generate and activate again before trading.';
const PATH='/api/risk/readiness-report';

// Real reports from the production builder over validated PF-2 envelopes: the UI is tested against the real shape.
const cleanups=[];
const world=await createEnvelopeWorld({after:fn=>cleanups.push(fn)});
test.after(async()=>{for(const fn of cleanups)await fn();});
const S=world.envelope.result.window.evaluation_start_time,MINUTE=60000;
const reportOf=options=>structuredClone(buildReadinessReport(pf3Facts(world,options)));
const KITCHEN={intents:{buy:11,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
  rejected_by_reason:{'Kill switch is active: entries paused':1,'Maximum trades per day reached':1,'Trading paused after loss streak':1,
    'Signal is stale':1,'A reason nobody classified':1}};
const FAULTY={intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
  rejected_by_reason:{'Signal is stale':1,'A reason nobody classified':1}};
const REPORTS={
  READY_TO_START_PAPER:reportOf(),
  CONFIGURATION_FAILURE:reportOf({edit:facts=>changePolicy(facts,{killSwitch:true})}),
  EXECUTION_FAULT_REVIEW_REQUIRED:reportOf({spec:FAULTY}),
  CAPABILITY_UNAVAILABLE:reportOf({edit:facts=>{facts.preflightEnabled=false;facts.historical={status:'DISABLED'};}}),
  INSUFFICIENT_ACTIVITY:reportOf({spec:{}})};

function setup({language,handler,scope}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[],events=[];
  w.api=async(path,options)=>{calls.push({path,options});return handler(path,options);};
  if(scope!==undefined)w.selectedBot=scope;
  d.addEventListener('pf3:report',event=>events.push(event.detail));
  w.eval(publicFile('readiness.js'));
  const root=d.querySelector('#pf3Root'),page=d.querySelector('[data-page="risk"]');
  const text=()=>root.textContent.replace(/\s+/g,' ').trim();
  const block=title=>[...root.querySelectorAll('.pf3-block')].find(item=>item.querySelector('h3').textContent===title);
  const rowsOf=title=>Object.fromEntries([...block(title).querySelectorAll('.pf3-ev .pf3-k')].map(key=>[key.textContent,key.nextElementSibling?.textContent]));
  const open=async()=>{d.querySelector('nav button[data-view="risk"]').click();await settle();};
  return {dom,w,d,calls,events,root,page,text,block,rowsOf,open};
}
const answer=report=>path=>{if(path!==PATH)throw new Error('Unexpected '+path);return structuredClone(report);};
const apiError=(code,status=503)=>Object.assign(new Error(code||'Request failed'),{code,status});

test('index.html: panel after the Risk form and outside it, fixed texts, warning, versioned scripts',()=>{
  const html=publicFile('index.html'),dom=new JSDOM(html),d=dom.window.document;
  try{
    const form=d.querySelector('#riskForm'),panel=d.querySelector('#pf3Panel');
    assert.ok(panel&&form&&!form.contains(panel),'the panel sits outside the form');
    assert.equal(form.nextElementSibling,panel);assert.equal(panel.parentElement,d.querySelector('section[data-page="risk"]'));
    assert.equal(panel.querySelector('h2').textContent,'Readiness report');assert.equal(panel.querySelector('.panel-title p').textContent,HEADING);
    assert.equal(panel.querySelector('#pf3Refresh').textContent,'Refresh report');assert.equal(panel.querySelector('#pf3Refresh').type,'button');
    assert.equal(panel.querySelectorAll('input,select,textarea,form,a').length,0,'no field can save or start anything');
    assert.equal(panel.querySelectorAll('button').length,1);assert.equal(panel.querySelector('[style]'),null,'the CSP forbids inline styles');
    assert.equal(form.querySelector('.pf3-save-warning').textContent,WARNING);
    const order=['/i18n.js?v=','/app.js?v=','/pine-bridge.js?v=','/readiness.js?v=pf3a1','/journey.js?v=ux1a'].map(part=>html.indexOf(part));
    assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'readiness.js loads after app.js and before journey.js');
    assert.match(html,/styles-v2\.css\?v=ux1a/);assert.match(html,/i18n\.js\?v=ux1a/);
    assert.doesNotMatch(html,/(styles-v2\.css|i18n\.js|journey\.js)\?v=p0j1["']/,'changed files carry a new cache version');
  }finally{dom.window.close();}
});

test('each verdict renders its label, code, meaning and the fixed diagnostic lines',async()=>{
  const labels={CONFIGURATION_FAILURE:['Configuration failure','bad','A setting or the current state blocks Bridge entries. Fix the listed items first.'],
    EXECUTION_FAULT_REVIEW_REQUIRED:['Execution fault — review required','bad','Past Paper evidence contains faults or unknown results. Review them before relying on it.'],
    CAPABILITY_UNAVAILABLE:['Capability unavailable','warn','Evidence or a capability needed for a readiness claim is missing, stale or disabled.'],
    INSUFFICIENT_ACTIVITY:['Insufficient activity','warn','The evidence window shows too few closed episodes, or a pause is active.'],
    READY_TO_START_PAPER:['Ready to start Paper collection','ok','Evidence for starting a bounded Paper collection is complete. This is not approval to Run.']};
  for(const [verdict,report] of Object.entries(REPORTS)){
    assert.equal(report.verdict,verdict,'fixture '+verdict);
    const p=setup({handler:answer(report)});
    try{
      assert.match(p.text(),/Open the report to check readiness\./);
      assert.equal(p.calls.length,0,'nothing is requested before the report is opened');
      await p.open();
      const chip=p.root.querySelector('.pf3-chip');
      assert.equal(chip.textContent,labels[verdict][0]);assert.ok(chip.className.split(' ').includes('pf3-'+labels[verdict][1]),verdict);
      assert.equal(p.root.querySelector('.pf3-head code').textContent,verdict);
      assert.equal(p.root.querySelector('.pf3-meaning').textContent,labels[verdict][2]);
      assert.equal(p.root.querySelector('.pf3-fixed').textContent,FIXED);
      assert.equal(p.d.querySelector('#pf3Panel .panel-title p').textContent,HEADING);
      assert.equal(p.root.querySelectorAll('button,input,select,textarea,a').length,0,'the report has no control');
      assert.equal(p.root.querySelector('.pf3-verdict .pf3-ev .pf3-v').textContent,utc(Date.parse(report.generated_at)));
    }finally{p.w.close();}
  }
});

const ALL=reportOf({spec:KITCHEN,edit:facts=>{facts.globalKill=true;facts.daily.loss_streak=3;facts.historical.evidence.engineCurrent=false;}});

test('blockers are grouped by category in rank order with a source tag and the detail; no blocker says so',async()=>{
  const p=setup({handler:answer(ALL)});
  try{
    await p.open();
    const blockers=p.block('Blockers');
    assert.deepEqual([...blockers.querySelectorAll('.pf3-cat h4')].map(item=>item.textContent),
      ['Configuration','Execution fault review','Capability','Activity']);
    const items=[...blockers.querySelectorAll('li.pf3-blocker')].map(item=>[item.querySelector('code').textContent,item.querySelector('.pf3-tag').textContent]);
    assert.deepEqual(items.map(item=>item[0]),ALL.blockers.map(item=>item.code));
    assert.deepEqual(items.find(item=>item[0]==='HISTORICAL_CONFIGURATION_REJECTIONS'),['HISTORICAL_CONFIGURATION_REJECTIONS','Historical']);
    assert.deepEqual(items.find(item=>item[0]==='CURRENT_LOSS_STREAK_PAUSE'),['CURRENT_LOSS_STREAK_PAUSE','Current']);
    const detail=[...blockers.querySelectorAll('li.pf3-blocker')].find(item=>item.querySelector('code').textContent==='CURRENT_LOSS_STREAK_PAUSE').querySelector('.pf3-detail');
    assert.equal(detail.textContent,'3 >= 3');
    const reason=name=>[...blockers.querySelectorAll('li.pf3-blocker')].find(item=>item.querySelector('code').textContent===name).querySelector('.pf3-reason')?.textContent;
    assert.equal(reason('CURRENT_LOSS_STREAK_PAUSE'),'The loss-streak pause is active now, so no estimate is possible.');
    assert.equal(reason('GLOBAL_KILL_ACTIVE'),'The administrator global kill is on.');
    for(const item of ALL.blockers)assert.ok(reason(item.code),'a blocker the builder emits has a meaning: '+item.code);
  }finally{p.w.close();}
  const ready=setup({handler:answer(REPORTS.READY_TO_START_PAPER)});
  try{await ready.open();assert.match(ready.block('Blockers').textContent,/No blockers\./);assert.equal(ready.block('Blockers').querySelectorAll('li').length,0);}finally{ready.w.close();}
});

test('the current card shows the PF-1 facts of the saved policy, the account, the guards and the READY deployment',async()=>{
  const report=reportOf({edit:facts=>{facts.daily.trades=2;facts.daily.realized_r='-1.5';facts.exposure.openPositions=1;facts.exposure.hasPendingOrder=true;
    facts.exposure.reservedNotional='10';facts.deployment.staleCode='STALE_CAPITAL';}});
  const p=setup({handler:answer(report)});
  try{
    await p.open();
    const rows=p.rowsOf('Current state (PF-1)'),policy=report.current.policy;
    assert.equal(rows['Policy source'],'SAVED_POLICY');assert.equal(rows['Policy hash'],policy.hash);assert.equal(rows['Saved policy hash'],policy.saved_hash);
    assert.equal(rows['Policy check'],'CONSISTENT');assert.equal(rows['Bot session'],'SETUP');
    assert.equal(rows['Cash'],'800');assert.equal(rows['Cash available'],'790');assert.equal(rows['Reserved by orders'],'10');
    assert.equal(rows['Book equity (cost basis)'],'1000');assert.equal(rows['Configured equity'],'1000');assert.equal(rows['Configured balance'],'800');
    assert.equal(rows['Open positions'],'1');assert.equal(rows['Pending order'],'Yes');assert.equal(rows['Order outcome uncertain'],'No');
    assert.equal(rows['Kill switch'],'No');assert.equal(rows['Global kill'],'No');assert.equal(rows['Loss streak'],'0 / 3');
    assert.equal(rows['Trades today'],'2 / 10');assert.equal(rows['Realized R today'],'-1.5 / 3');assert.equal(rows['Day-scoped pauses'],'None');
    assert.equal(rows['READY deployment'],report.current.deployment.deployment_id);assert.equal(rows['Deployment is current'],'No');
    assert.equal(rows['Stale reason'],'STALE_CAPITAL');assert.equal(rows['Execution model'],'paper-close-v1');assert.equal(rows['Bridge risk %'],'1');
    assert.equal(p.block('Current state (PF-1)').querySelectorAll('.pf3-hash').length,3,'long hashes wrap in .pf3-hash');
  }finally{p.w.close();}
  const bare=reportOf({edit:facts=>{facts.deployment=null;}});
  const q=setup({handler:answer(bare)});
  try{await q.open();assert.match(q.block('Current state (PF-1)').textContent,/No READY Bridge deployment\./);}finally{q.w.close();}
});

test('the historical card shows the funnel, rejection classes, TARGET_NOT_OPEN, pauses, provenance flags and information-only lists',async()=>{
  const p=setup({handler:answer(ALL)});
  try{
    await p.open();
    const rows=p.rowsOf('Historical evidence (PF-2)'),h=ALL.historical,e=h.evidence,f=h.funnel;
    assert.equal(rows['Status'],'AVAILABLE');assert.equal(rows['Evidence job'],e.job_id);assert.equal(rows['Evidence plan hash'],e.plan_hash);
    assert.equal(rows['Engine unchanged since evidence'],'No');assert.equal(rows['Policy unchanged since evidence'],'Yes');
    assert.equal(rows['Capital unchanged since evidence'],'Yes');assert.equal(rows['Deployment is the READY one'],'Yes');
    assert.equal(rows['Execution model'],'paper-close-v1');
    assert.equal(rows['Native signals (BUY / exit)'],f.native_signals.buy+' / '+f.native_signals.native_exit);
    assert.equal(rows['Bridge intents (BUY / SL / TP / native)'],'11 / 6 / 0 / 0');
    assert.equal(rows['Orders accepted'],String(f.orders.accepted));
    assert.equal(rows['Accepted with size adjustment, includes quantity-step rounding'],String(f.orders.capped));
    assert.equal(rows['Orders rejected (BUY / EXIT)'],'5 (5 / 0)');assert.equal(rows['Fills (BUY / EXIT)'],'6 / 6');
    assert.equal(rows['Closed allocations'],'6');assert.equal(rows['Episodes (closed / losing / non-losing)'],'6 / 2 / 4');
    assert.equal(rows['Window (UTC)'],utc(h.window.evaluation_start_time)+' → '+utc(h.window.last_time));
    assert.equal(rows['Evaluated bars'],'1000 (0.6944 days)');
    assert.equal(rows['TARGET_NOT_OPEN (total / verified / unverified)'],'0 / 0 / 0');
    assert.equal(rows['Rejected BUY that capping would turn into a fill'],'0');
    assert.equal(rows['Persistent pause in the window'],'No');assert.equal(rows['Active guards at the end'],'None');
    assert.match(rows['Paused minutes by guard'],/KILL_SWITCH 0 · MAX_TRADES_PER_DAY 0 · MAX_DAILY_LOSS 0 · LOSS_STREAK 0/);
    assert.equal(rows['End cash'],'800');assert.equal(rows['Open allocations at the end'],'0');
    assert.equal(rows['Initial capital (cash / equity)'],'800 / 1000');
    assert.equal(rows['Acceptance blockers (information only)'],'EVALUATOR_PARITY_REQUIRED, SOURCE_SETTINGS_CAPABILITY_REQUIRED');
    assert.match(rows['Evidence limitations'],/V1_ONLY/);
    // The rejection class table: every key, its count, class label, code and side.
    const table=p.block('Historical evidence (PF-2)').querySelector('table.pf3-table');
    assert.deepEqual([...table.querySelectorAll('th')].map(item=>item.textContent),['Reason','Count','Class','Code','Side']);
    const body=[...table.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent));
    assert.equal(body.length,5);
    assert.deepEqual(body.map(cells=>cells[2]).sort(),['Configuration failure','Execution fault','Expected policy skip','Loss protection pause','Unknown']);
    assert.deepEqual(body.find(cells=>cells[0]==='Kill switch is active: entries paused'),['Kill switch is active: entries paused','1','Configuration failure','KILL_SWITCH','BUY']);
    assert.equal(body.reduce((sum,cells)=>sum+Number(cells[1]),0),f.orders.rejected);
    assert.ok(p.block('Historical evidence (PF-2)').querySelector('.pf3-table-wrap'),'the table scrolls inside its own wrapper');
  }finally{p.w.close();}
  // Unavailable evidence names the code and shows no funnel.
  const disabled=setup({handler:answer(REPORTS.CAPABILITY_UNAVAILABLE)});
  try{
    await disabled.open();
    const rows=disabled.rowsOf('Historical evidence (PF-2)');
    assert.equal(rows['Status'],'UNAVAILABLE');assert.equal(rows['Unavailable because'],'PF2_DISABLED');
    assert.match(disabled.block('Historical evidence (PF-2)').textContent,/No historical evidence is used for readiness\./);
    assert.equal(disabled.block('Historical evidence (PF-2)').querySelector('table'),null);assert.equal(rows['Orders accepted'],undefined);
  }finally{disabled.w.close();}
});

test('TARGET_NOT_OPEN counts, truncated pauses and a latest job are shown as data',async()=>{
  const report=structuredClone(ALL);
  report.historical.rejections.target_not_open={total:5,verified:2,unverified:3,basis:{WARMUP_ENTRY:2,REJECTED_BUY:0,CLOSED_EARLIER:0}};
  report.historical.pauses={...report.historical.pauses,persistent:true,active_kinds:['LOSS_STREAK'],partial:true,truncated:true,dropped_periods:4,
    paused_minutes_by_kind:{KILL_SWITCH:0,MAX_TRADES_PER_DAY:60,MAX_DAILY_LOSS:0,LOSS_STREAK:120}};
  report.historical.latest_job={job_id:'job-77',status:'RUNNING',diagnostic:null,created_at:S};
  const p=setup({handler:answer(report)});
  try{
    await p.open();
    const rows=p.rowsOf('Historical evidence (PF-2)');
    assert.equal(rows['TARGET_NOT_OPEN (total / verified / unverified)'],'5 / 2 / 3');
    assert.equal(rows['Persistent pause in the window'],'Yes');assert.equal(rows['Active guards at the end'],'LOSS_STREAK');
    assert.match(rows['Paused minutes by guard'],/MAX_TRADES_PER_DAY 60 · MAX_DAILY_LOSS 0 · LOSS_STREAK 120/);
    assert.match(p.block('Historical evidence (PF-2)').textContent,/Pause periods are partial: the list was truncated\./);
    assert.equal(rows['Latest PF-2 job'],'job-77 · RUNNING · '+utc(S));
  }finally{p.w.close();}
});

test('the collection estimate names its status, declares window and assumptions and never shows an ETA for a pause',async()=>{
  const trades=count=>({intents:{buy:count,exit_sl:count},fills:{buy:count,exit:count,exit_by_reason:{SL:count}},episodes:{closed:count,losing:0}});
  const cases=[
    ['READY',reportOf(),'Estimate'],['five',reportOf({spec:trades(5)}),'Estimate'],
    ['stale',reportOf({edit:facts=>{facts.historical.evidence.planPolicyHash='f'.repeat(64);}}),'Not available'],
    ['pause',reportOf({edit:facts=>{facts.daily.loss_streak=3;}}),'No ETA: a persistent pause is active'],
    ['none',reportOf({spec:{}}),'No ETA: no closed episodes in the window'],
    ['two',reportOf({spec:trades(2)}),'Too few closed episodes for a rate'],['three',reportOf({spec:trades(3)}),'Estimate']];
  for(const [name,report,status] of cases){
    const p=setup({handler:answer(report)});
    try{
      await p.open();
      const rows=p.rowsOf('Collection estimate'),block=p.block('Collection estimate');
      assert.equal(rows['Estimate status'],status,name);assert.equal(rows['Basis'],'PF-2 development window');
      assert.equal(block.querySelectorAll('ul.pf3-list li').length,7,'the seven assumptions are always declared');
      assert.match(block.textContent,/Not a guarantee/);
      if(report.activity_projection.status==='ESTIMATED'){
        assert.equal(rows['Closed episodes per day'],report.activity_projection.rate_per_day);
        assert.equal(rows['First closed episode'],'about '+report.activity_projection.targets[0].days+' days');
        assert.equal(rows['Engineering minimum (5 episodes)'],'about '+report.activity_projection.targets[1].days+' days');
        assert.equal(rows['Planning target (30 episodes)'],'about '+report.activity_projection.targets[2].days+' days');
      }else{
        assert.equal(rows['Closed episodes per day'],undefined,name+': no rate without an estimate');
        for(const target of ['First closed episode','Engineering minimum (5 episodes)','Planning target (30 episodes)'])assert.equal(rows[target],undefined,name+': '+target);
      }
      assert.equal(/Low evidence/.test(block.textContent),report.activity_projection.low_evidence===true,name);
    }finally{p.w.close();}
  }
  // The window length is shown for the estimate: 1000 evaluated bars are 0.6944 days.
  const p=setup({handler:answer(reportOf())});
  try{await p.open();assert.equal(p.rowsOf('Collection estimate')['Window days'],'0.6944');}finally{p.w.close();}
});

test('opening the Risk page loads one read-only report; Refresh reloads it; a hidden page is not refreshed by the global button',async()=>{
  const p=setup({handler:answer(REPORTS.READY_TO_START_PAPER)});
  try{
    await p.open();
    assert.deepEqual(p.calls.map(call=>call.path),[PATH]);
    assert.ok(p.calls.every(call=>call.options.silent===true&&call.options.method===undefined&&call.options.body===undefined&&call.options.botId===undefined),
      'GET only, the shared bot scope, no Saved toast');
    p.d.querySelector('#pf3Refresh').click();await settle();
    assert.equal(p.calls.length,2);
    p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.calls.length,2,'hidden Risk page: the global Refresh loads nothing');
    p.page.hidden=false;
    p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.calls.length,3,'visible Risk page: the global Refresh reloads');
    p.d.querySelector('#logout').click();await settle();
    assert.match(p.text(),/Open the report to check readiness\./,'logout drops the report');
  }finally{p.w.close();}
});

test('the All Bots scope asks for one bot and requests nothing',async()=>{
  const p=setup({handler:answer(REPORTS.READY_TO_START_PAPER),scope:'all'});
  try{
    await p.open();
    assert.equal(p.calls.length,0);assert.match(p.text(),/Select one bot for this operation/);
    assert.deepEqual(p.events,[null]);
  }finally{p.w.close();}
});

test('late responses are dropped: an older answer never replaces a newer one, nor does an answer for the previous bot',async()=>{
  const slow=structuredClone(REPORTS.CONFIGURATION_FAILURE),fast=REPORTS.READY_TO_START_PAPER;
  let calls=0;
  const p=setup({handler:()=>++calls===1?new Promise(resolve=>setTimeout(()=>resolve(structuredClone(slow)),90)):structuredClone(fast)});
  try{
    await p.open();await p.open();
    await new Promise(resolve=>setTimeout(resolve,160));
    assert.equal(calls,2);assert.equal(p.root.querySelector('.pf3-head code').textContent,'READY_TO_START_PAPER');
    assert.equal(p.events.length,1,'the dropped answer announces nothing');
  }finally{p.w.close();}
  // A bot switch while a report is in flight: the old answer is ignored, the new bot is read.
  const answers=[{delay:90,report:slow},{delay:0,report:fast}];
  const q=setup({scope:'bot-1',handler:()=>{const next=answers.shift();return new Promise(resolve=>setTimeout(()=>resolve(structuredClone(next.report)),next.delay));}});
  try{
    q.page.hidden=false;
    q.d.querySelector('nav button[data-view="risk"]').click();
    q.w.selectedBot='bot-2';
    q.d.querySelector('#botSwitcher').dispatchEvent(new q.w.Event('change'));
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(q.calls.length,2);assert.equal(q.root.querySelector('.pf3-head code')?.textContent,'READY_TO_START_PAPER');
    assert.deepEqual(q.events.map(event=>event===null?null:event.verdict),[null,'READY_TO_START_PAPER'],'the switch announces that the old report is gone, then the new bot');
  }finally{q.w.close();}
  // The same switch while the Risk page is hidden clears the report without reading.
  const r=setup({scope:'bot-1',handler:answer(fast)});
  try{
    await r.open();assert.equal(r.calls.length,1);
    r.d.querySelector('#botSwitcher').dispatchEvent(new r.w.Event('change'));await settle();
    assert.equal(r.calls.length,1);assert.match(r.text(),/Open the report to check readiness\./);
  }finally{r.w.close();}
});

test('an API failure shows Not available with its code; a malformed report degrades only the sections that read it',async()=>{
  for(const [error,expected] of [[apiError('PF3_READINESS_UNAVAILABLE'),'PF3_READINESS_UNAVAILABLE'],[apiError(undefined,500),'HTTP_500'],
    [new TypeError('Failed to fetch'),'REQUEST_FAILED'],[apiError('RETRY_TRANSACTION',409),'RETRY_TRANSACTION']]){
    const p=setup({handler:()=>{throw error;}});
    try{
      await p.open();
      assert.ok(p.text().includes('Not available ('+expected+')'),p.text());assert.deepEqual(p.events,[null],'a failed read announces that no report is shown');
      assert.equal(p.root.querySelector('.pf3-chip'),null,'no stale verdict stays on screen');
    }finally{p.w.close();}
  }
  const broken=structuredClone(REPORTS.READY_TO_START_PAPER);
  broken.historical={status:'AVAILABLE',unavailable_code:null,latest_job:null,evidence:{},window:{},funnel:null,rejections:null,pauses:null,account_end:null};
  const p=setup({handler:answer(broken)});
  try{
    await p.open();
    assert.equal(p.root.querySelector('.pf3-chip').textContent,'Ready to start Paper collection');
    assert.match(p.block('Historical evidence (PF-2)').textContent,/Not available \(RENDER_ERROR\)/);
    assert.match(p.block('Current state (PF-1)').textContent,/Policy source/,'the current card still renders');
    assert.match(p.block('Collection estimate').textContent,/Estimate status/);
    assert.equal(p.events.length,1,'the verdict is still announced');
  }finally{p.w.close();}
  const empty=setup({handler:()=>null});
  try{await empty.open();assert.match(empty.text(),/Not available \(REQUEST_FAILED\)|Open the report|RENDER_ERROR/);}finally{empty.w.close();}
});

test('every rendered report announces pf3:report with exactly the four fields the journey reads',async()=>{
  const p=setup({handler:answer(REPORTS.INSUFFICIENT_ACTIVITY)});
  try{
    await p.open();
    assert.equal(p.events.length,1);
    const report=REPORTS.INSUFFICIENT_ACTIVITY;
    assert.deepEqual({...p.events[0]},{bot_id:report.bot_id,verdict:'INSUFFICIENT_ACTIVITY',historical_status:'AVAILABLE',generated_at:report.generated_at});
    p.d.querySelector('#pf3Refresh').click();await settle();
    assert.equal(p.events.length,2);
    p.d.querySelector('#logout').click();await settle();
    assert.equal(p.events.length,3);assert.equal(p.events[2],null,'logout announces that the report is gone');
  }finally{p.w.close();}
});

test('Thai switch translates the static text and every rendered label; English restores it',async()=>{
  const p=setup({language:'th',handler:answer(ALL)});
  try{
    const {d,w}=p;
    assert.equal(d.querySelector('#pf3Panel h2').textContent,'รายงานความพร้อม');
    assert.equal(d.querySelector('#pf3Panel .panel-title p').textContent,w.translate(HEADING));
    assert.equal(d.querySelector('#pf3Refresh').textContent,'รีเฟรชรายงาน');
    assert.equal(d.querySelector('#riskForm .pf3-save-warning').textContent,w.translate(WARNING));
    assert.notEqual(w.translate(WARNING),WARNING);
    await p.open();
    assert.equal(p.root.querySelector('.pf3-chip').textContent,'การตั้งค่าไม่ถูกต้อง');
    assert.equal(p.root.querySelector('.pf3-fixed').textContent,w.translate(FIXED));
    assert.deepEqual([...p.block('สิ่งที่ขัดขวาง').querySelectorAll('.pf3-cat h4')].map(item=>item.textContent),
      ['การตั้งค่า','ตรวจสอบข้อผิดพลาดในการทำงาน','ความสามารถ','กิจกรรม']);
    for(const element of d.querySelectorAll('#pf3Panel [data-ui-label]')){
      const label=element.dataset.uiLabel;
      assert.equal(element.textContent,w.translate(label),label);assert.notEqual(element.textContent,label,'untranslated: '+label);
    }
    const language=d.querySelector('#language');
    language.value='en';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(p.root.querySelector('.pf3-chip').textContent,'Configuration failure');
    assert.equal(d.querySelector('#pf3Panel h2').textContent,'Readiness report');
    language.value='th';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(p.root.querySelector('.pf3-chip').textContent,'การตั้งค่าไม่ถูกต้อง');
    // Raw data stays raw: codes, hashes, rejection reasons are never translated.
    assert.ok(p.text().includes('KILL_SWITCH'));assert.ok(p.text().includes('Signal is stale'));
  }finally{p.w.close();}
});

test('every label of every report shape has a Thai text; the pf3 pairs are complete, unique and collision-free',async()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.localStorage.setItem('robotLanguage','th');
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=pf3Pairs;window.__journey=journeyPairs;');
    const mine=[...w.__mine],others=w.__pairs.filter(pair=>!w.__mine.includes(pair));
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){
      assert.notEqual(en,th);
      assert.deepEqual([...en.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...th.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),'placeholders differ: '+en);
    }
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
    // Literals the source can show: calls, table headers and every capitalized text of readiness.js, plus journey rows and the HTML.
    const source=publicFile('readiness.js'),shown=new Set([HEADING,WARNING,'Readiness report','Refresh report']);
    for(const match of source.matchAll(/\b(?:T|tpl|label|note|row|group)\(\s*'([^'\n]*)'/g))shown.add(match[1]);
    for(const match of source.matchAll(/table\(\[([^\]]+)\]/g))for(const item of match[1].matchAll(/'([^']+)'/g))shown.add(item[1]);
    for(const match of source.matchAll(/'([A-Z][^'\n]*)'/g))if(/[a-z]/.test(match[1])&&!/^[A-Z0-9_ ]+$/.test(match[1]))shown.add(match[1]);
    for(const match of publicFile('journey.js').matchAll(/\brow\(\s*'([^'\n]*)'/g))shown.add(match[1]);
    assert.ok(shown.size>90,'literal extraction found the static strings: '+shown.size);
    for(const text of shown)assert.notEqual(w.translate(text),text,'missing Thai: '+text);
    for(const text of english)assert.ok(shown.has(text),'pair for text no longer shown: '+text);
  }finally{w.close();}
  // Rendered labels of every report shape, in English and in Thai.
  const reports=[...Object.values(REPORTS),ALL,reportOf({spec:{intents:{buy:3,exit_sl:3},fills:{buy:3,exit:3,exit_by_reason:{SL:3}},episodes:{closed:3,losing:0}}}),
    reportOf({edit:facts=>{facts.historical.evidence.planPolicyHash='e'.repeat(64);}}),reportOf({spec:{intents:{buy:2,exit_sl:2},fills:{buy:2,exit:2,exit_by_reason:{SL:2}},episodes:{closed:2,losing:0}}})];
  for(const language of ['en','th']){
    for(const report of reports){
      const p=setup({language,handler:answer(report)});
      try{
        await p.open();
        for(const element of p.root.querySelectorAll('[data-ui-label]')){
          const label=element.dataset.uiLabel;
          assert.equal(element.textContent,p.w.translate(label),label);
          if(language==='th')assert.notEqual(element.textContent,label,'untranslated: '+label);
        }
      }finally{p.w.close();}
    }
  }
});

test('hostile values are shown as text; no element, attribute or handler is created from report data',async()=>{
  const report=structuredClone(ALL);
  report.bot_id='<img src=x onerror=alert(1)>';report.blockers[0].detail='<script>boom()</script>';
  report.historical.rejections.items[0].reason='<b onmouseover=bad()>x</b>';report.historical.latest_job={job_id:'<iframe>',status:'<a href=x>',diagnostic:null,created_at:S};
  report.current.policy.source='<svg onload=bad()>';report.limitations.push('<img src=y onerror=bad()>');
  report.historical.evidence.acceptance_blockers=['<u onclick=bad()>x</u>'];
  const p=setup({handler:answer(report)});
  try{
    await p.open();
    assert.equal(p.root.querySelectorAll('img,script,b,iframe,a,svg,u').length,0);
    assert.equal(p.root.querySelector('[onerror],[onmouseover],[onload],[onclick],[style]'),null);
    for(const hostile of ['<img src=x onerror=alert(1)>','<script>boom()</script>','<b onmouseover=bad()>x</b>','<svg onload=bad()>','<img src=y onerror=bad()>'])
      assert.ok(p.text().includes(hostile),hostile);
  }finally{p.w.close();}
});

test('readiness.js stays read-only, self-contained and CSP-safe: one GET, no storage, no markup injection',()=>{
  const source=publicFile('readiness.js');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket','localStorage',
    'sessionStorage','setAttribute(','.style','http://','https://','onclick=','method:','body:','confirm(','prompt('])
    assert.ok(!source.includes(banned),'forbidden in readiness.js: '+banned);
  assert.deepEqual([...source.matchAll(/'(\/api\/[^']*)'/g)].map(match=>match[1]),[PATH]);
  assert.equal(source.split('await api(').length-1,1,'a single api() call site');
  assert.ok(!/\b(save|apply|start|run)\w*\s*\(/i.test(source.replace(/starts?\b/gi,'')),'no save, apply, start or run call');
  assert.ok(source.includes("'pf3:report'"));
  assert.deepEqual([...new Set([...source.matchAll(/addEventListener\('([a-z:0-9]+)'/g)].map(match=>match[1]))].sort(),['change','click']);
});

test('works with app.js: the Risk navigation shows the page and reads the selected bot; the report never touches the Risk form',async()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document,requests=[];
  try{
    w.fetch=async(path,options)=>{requests.push({path,method:options?.method??'GET'});
      return {ok:true,json:async()=>structuredClone(REPORTS.READY_TO_START_PAPER)};};
    w.eval(publicFile('i18n.js')+'\n'+publicFile('app.js')+`
      authenticated=true;selectedBot='bot-2';me={moneyFormat:'decimal-string'};
      load=async function(){};
    `+'\n'+publicFile('readiness.js'));
    const form=d.querySelector('#riskForm');w.eval('window._riskDirty=false;');
    d.querySelector('nav button[data-view="risk"]').click();await settle();
    assert.equal(d.querySelector('[data-page="risk"]').hidden,false);
    assert.deepEqual(requests,[{path:PATH+'?bot_id=bot-2',method:'GET'}],'owner-scoped bot, GET only');
    assert.equal(d.querySelector('#pf3Root .pf3-chip').textContent,'Ready to start Paper collection');
    assert.equal(w._riskDirty,false,'a report never marks the Risk form dirty');
    // Enter in the panel cannot reach the Risk form: it is not inside it and has no field.
    d.querySelector('#pf3Refresh').click();await settle();
    assert.equal(requests.length,2);assert.ok(requests.every(request=>request.method==='GET'));
    assert.equal(form.contains(d.querySelector('#pf3Panel')),false);
  }finally{w.close();}
});

test('PF-3 styles keep the panel inside a 390px viewport and wrap long values',()=>{
  const css=publicFile('styles-v2.css'),at=css.indexOf('/* PF-3 readiness report'),block=css.slice(at);
  assert.ok(at>0&&block.length>800);
  const rule=selector=>{const index=block.indexOf(selector+'{');assert.ok(index>=0,'missing rule '+selector);return block.slice(index,block.indexOf('}',index));};
  for(const selector of ['.pf3-panel','.pf3-root','.pf3-block','.pf3-ev','.pf3-v','.pf3-blocker'])assert.ok(rule(selector).includes('min-width:0'),selector+' may shrink');
  for(const selector of ['.pf3-v','.pf3-code,.pf3-hash','.pf3-blocker','.pf3-detail','.pf3-note'])assert.ok(rule(selector).includes('overflow-wrap:anywhere'),selector+' wraps long text');
  assert.ok(rule('.pf3-code,.pf3-hash').includes('word-break:break-all'));
  assert.ok(rule('.pf3-table-wrap').includes('overflow-x:auto'),'a wide table scrolls inside itself');
  assert.ok(!block.includes('nowrap'),'nothing is forced onto one line');
  assert.ok(!/min-width:\d+px/.test(block)&&!/[^-]width:\d{3,}px/.test(block),'no fixed widths wider than a phone');
  assert.ok(!block.includes('[hidden]'),'no rule overrides a hidden attribute');
  assert.ok(block.includes('@media(max-width:600px)'),'phone layout');
});

test('a blocker code or category the page does not know is shown with its raw code and detail and no invented meaning',async()=>{
  const report=structuredClone(REPORTS.READY_TO_START_PAPER);
  report.blockers=[{code:'SOMETHING_NEW_FROM_A_LATER_SERVER',category:'CAPABILITY',source:'CURRENT',detail:'detail text'},
    {code:'ANOTHER_ONE',category:'NOT_A_KNOWN_CATEGORY',source:'CURRENT',detail:null}];
  const p=setup({handler:answer(report)});
  try{
    await p.open();
    const items=[...p.block('Blockers').querySelectorAll('li.pf3-blocker')];
    assert.equal(items.length,2,'a blocker of an unknown category is listed too, under Other');
    assert.deepEqual([...p.block('Blockers').querySelectorAll('.pf3-cat h4')].map(item=>item.textContent),['Capability','Other']);
    assert.equal(items[1].querySelector('code').textContent,'ANOTHER_ONE');
    assert.equal(items[0].querySelector('code').textContent,'SOMETHING_NEW_FROM_A_LATER_SERVER');
    assert.equal(items[0].querySelector('.pf3-reason'),null);assert.equal(items[0].querySelector('.pf3-detail').textContent,'detail text');
  }finally{p.w.close();}
});

test('with journey.js loaded: a rendered report feeds journey step 3 and a cleared report takes it away again',async()=>{
  const p=setup({scope:'bot-1',handler:answer(REPORTS.INSUFFICIENT_ACTIVITY)});
  try{
    p.w.eval(publicFile('journey.js'));
    const step=()=>[...p.d.querySelectorAll('.jr-card[data-step="3"] .jr-ev .jr-k')].map(key=>[key.textContent,key.nextElementSibling.textContent]);
    assert.equal(step().some(([key])=>key==='Readiness verdict'),false,'nothing before a report');
    p.page.hidden=false;
    await p.open();
    assert.deepEqual(step().filter(([key])=>['Readiness verdict','Report bot','Report time','Historical evidence'].includes(key)),
      [['Readiness verdict','INSUFFICIENT_ACTIVITY'],['Report bot',REPORTS.INSUFFICIENT_ACTIVITY.bot_id],
        ['Report time',utc(Date.parse(REPORTS.INSUFFICIENT_ACTIVITY.generated_at))],['Historical evidence','AVAILABLE']]);
    assert.equal(p.d.querySelector('.jr-card[data-step="3"] .jr-chip').textContent,'Preview available');
    // A bot switch drops the report and the journey drops its rows; the next report brings them back.
    p.w.selectedBot='bot-2';
    p.d.querySelector('#botSwitcher').dispatchEvent(new p.w.Event('change'));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(step().some(([key])=>key==='Readiness verdict'),true,'the report of the new bot is read again and feeds the journey');
    p.w.selectedBot='all';
    p.d.querySelector('#pf3Refresh').click();await settle();
    assert.equal(step().some(([key])=>key==='Readiness verdict'),false,'All Bots shows no report, so the journey shows none');
  }finally{p.w.close();}
});
