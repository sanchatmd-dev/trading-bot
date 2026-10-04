import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildReadinessReport} from '../src/postgres/pf3-readiness-report.js';
import {buildProposal} from '../src/postgres/pf4-risk-proposals.js';
import {classifyMarketHealth} from '../src/postgres/market-ohlcv.js';
import {config} from '../src/config.js';
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

// Reports with the advisory market_data item from the real classifier (stored public Binance Spot 1m bars).
const MARKET_LATEST=Math.floor(Date.parse(REPORTS.READY_TO_START_PAPER.generated_at)/MINUTE)*MINUTE;
const marketReport=({age=5,missing=0,item}={})=>{
  const report=structuredClone(REPORTS.READY_TO_START_PAPER);
  report.market_data=item??classifyMarketHealth({now:MARKET_LATEST+age*1000,latest:MARKET_LATEST,first:MARKET_LATEST-3*86400000,edge:{n:1440-missing},
    gaps:{count:missing>0?1:0,missing_minutes:missing,truncated:false,ranges:missing>0?[{from_open_time:MARKET_LATEST-3600000,
      to_open_time:MARKET_LATEST-3600000+(missing-1)*MINUTE,missing_minutes:missing}]:[]}});
  return report;
};
const MARKET_REPORTS={PASS:marketReport(),WARN:marketReport({missing:3}),FAIL:marketReport({age:1000,missing:70}),
  UNAVAILABLE:marketReport({item:classifyMarketHealth({now:MARKET_LATEST,unavailable:'MARKET_DATA_UNAVAILABLE'})}),
  EMPTY:marketReport({item:classifyMarketHealth({now:MARKET_LATEST})})};

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
    const order=['/i18n.js?v=','/app.js?v=','/pine-bridge.js?v=','/readiness.js?v=md1','/journey.js?v=pa1'].map(part=>html.indexOf(part));
    assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'readiness.js loads after app.js and before journey.js');
    assert.match(html,/styles-v2\.css\?v=pa1/);assert.match(html,/i18n\.js\?v=mc2/);
    assert.doesNotMatch(html,/(styles-v2\.css|i18n\.js|journey\.js)\?v=p0j1["']/,'changed files carry a new cache version');
    assert.doesNotMatch(html,/(i18n\.js|readiness\.js|pine-bridge\.js)\?v=(rj1|pf4a|ux1a)["']/,'the news block change gave the files it touched a new cache version');
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
  const reports=[...Object.values(REPORTS),...Object.values(MARKET_REPORTS),ALL,reportOf({spec:{intents:{buy:3,exit_sl:3},fills:{buy:3,exit:3,exit_by_reason:{SL:3}},episodes:{closed:3,losing:0}}}),
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

// The PF-3 part of readiness.js (everything before the PF-4 marker) stays read-only; the PF-4 part has its own rules below.
const PF4_MARKER='/* PF-4 risk proposals';
const pf3Source=()=>{const whole=publicFile('readiness.js'),at=whole.indexOf(PF4_MARKER);assert.ok(at>0,'the PF-4 marker separates the two parts');return whole.slice(0,at);};
const pf4Source=()=>{const whole=publicFile('readiness.js');return whole.slice(whole.indexOf(PF4_MARKER));};

test('the PF-3 part of readiness.js stays read-only, self-contained and CSP-safe: one GET, no storage, no markup injection',()=>{
  const source=pf3Source();
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

// ---- PF-4 Risk proposals: the #pf4Panel sub-form in readiness.js. The proposals come from the real pure builder. ----
const P4='/api/risk/proposals/preview',P4A='/api/risk/proposals/apply',CONFIRM='SAVE_RISK_PROPOSAL';
const base4=()=>({...structuredClone(config.defaultRisk),blockDuringNews:true,capPercentEquitySize:false,maxRiskPercent:5,maxOrderNotional:'2000',
  maxDailyNotional:'20000',equities:{'binance-global':'1000'},balances:{'binance-global':'800'}});
const DECL={loss_per_trade_percent:'1',order_notional_ceiling:'500',allow_repeated_entries:false};
const EVIDENCE4={job_id:'job-1',plan_hash:'a'.repeat(64),policy_current:true,capital_current:true,cappable_buy_rejections:4,
  reasons:[{code:'ORDER_NOTIONAL_LIMIT',count:3},{code:'CASH_LIMIT',count:1}]};
const BRIDGE4={deployment_id:'dep-1',evidence_hash:'b'.repeat(64),risk_percent:1};
const CONSEQUENCES=[{code:'DEPLOYMENT_SNAPSHOT_STALE',deployment_id:'dep-1'},{code:'PF2_EVIDENCE_STALE',job_id:'job-1'}];
function previewAnswer({declared=DECL,evidence=EVIDENCE4,bridgeRisk=BRIDGE4,context={readyDeploymentId:'dep-1'},save,sizing}={}){
  const {proposal}=buildProposal({botId:'bot-1',base:base4(),defaultRisk:config.defaultRisk,declared,evidence,bridgeRisk,context});
  return structuredClone({version:'pf4-preview-v1',report_verdict:'READY_TO_START_PAPER',proposal,
    static:{consistency:{before:{status:'CONSISTENT',issues:[]},after:{status:'CONSISTENT',issues:[]}},
      capacity:{before:{remainingDailyNotional:'20000',remainingDailyExecutions:10},after:{remainingDailyNotional:'30000',remainingDailyExecutions:10}}},
    sizing:sizing??{status:'NOT_REQUESTED',code:null,detail:null,before:null,after:null,capital:null},
    save:save??{allowed:true,refusal_code:null,confirm:CONFIRM,consequences:CONSEQUENCES},flags:{saves_nothing:true,deterministic:true,ai_used:false}});
}
const SAVED={version:'pf4-apply-v1',saved:true,policy_hash_before:'c'.repeat(64),policy_hash_after:'d'.repeat(64),
  changed_fields:['maxRiskPercent','maxOrderNotional'],consequences:CONSEQUENCES,policy:{}};
const router=({preview,apply,report}={})=>(path,options)=>{
  if(path===P4)return typeof preview==='function'?preview(options):structuredClone(preview);
  if(path===P4A)return typeof apply==='function'?apply(options):structuredClone(apply);
  if(path===PATH)return structuredClone(report??REPORTS.READY_TO_START_PAPER);
  throw new Error('Unexpected '+path);
};
const parts=p=>({form:p.d.querySelector('#pf4Form'),root:p.d.querySelector('#pf4Root'),confirm:p.d.querySelector('#pf4Confirm'),
  save:p.d.querySelector('#pf4Save'),compute:p.d.querySelector('#pf4Compute'),sizing:p.d.querySelector('#pf4Sizing'),
  field:name=>p.d.querySelector('#pf4Form [name="'+name+'"]')});
const fill=(p,q,values)=>{for(const [name,value] of Object.entries(values)){const control=q.field(name);control.value=value;control.dispatchEvent(new p.w.Event('input',{bubbles:true}));}};
const rootText=q=>q.root.textContent.replace(/\s+/g,' ').trim();
const tick=(p,q,on=true)=>{q.confirm.checked=on;q.confirm.dispatchEvent(new p.w.Event('change',{bubbles:true}));};
const only=(p,path)=>p.calls.filter(call=>call.path===path);
const rows4=q=>[...q.root.querySelectorAll('.pf3-table tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.replace(/\s+/g,' ').trim()));

test('PF-4 markup: a separate panel after the readiness panel, outside both forms, four declared controls, closed save controls',()=>{
  const dom=new JSDOM(publicFile('index.html')),d=dom.window.document;
  try{
    const panel=d.querySelector('#pf4Panel'),pf3=d.querySelector('#pf3Panel'),risk=d.querySelector('#riskForm'),form=d.querySelector('#pf4Form');
    assert.ok(panel&&form&&pf3&&risk);assert.equal(pf3.nextElementSibling,panel);assert.equal(panel.parentElement,d.querySelector('section[data-page="risk"]'));
    assert.ok(!risk.contains(panel)&&!pf3.contains(panel)&&!panel.contains(risk)&&form.closest('#riskForm')===null,'its Enter key cannot reach the Risk form');
    assert.deepEqual([...form.elements].map(element=>element.name||element.id),
      ['loss_per_trade_percent','order_notional_ceiling','daily_notional_ceiling','allow_repeated_entries','pf4Compute','pf4Sizing','pf4Confirm','pf4Save']);
    assert.ok([...form.querySelectorAll('button')].every(button=>button.type==='button'),'no native submit');
    assert.equal(form.querySelector('#pf4Confirm').disabled,true);assert.equal(form.querySelector('#pf4Save').disabled,true);
    assert.deepEqual([...form.elements.allow_repeated_entries.options].map(option=>option.value),['','false','true']);
    assert.equal(panel.querySelector('[style]'),null,'the CSP forbids inline styles');assert.equal(panel.querySelector('a,script,iframe'),null);
    assert.equal(panel.querySelector('h2').textContent,'Risk proposal');
    assert.equal(panel.querySelector('.panel-title p').textContent,'Deterministic and explained. Nothing is saved until you confirm.');
    assert.deepEqual([...form.querySelectorAll('label')].map(label=>[...label.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim()),
      ['Loss per trade (%)','Order notional ceiling','Daily notional ceiling','Repeated entries','I confirm that I want to save this proposal to the Risk policy']);
    assert.deepEqual([...form.querySelectorAll('button')].map(button=>button.textContent),['Compute proposal','Preview sizing before/after','Save proposal']);
    assert.equal(form.querySelector('#pf4Root').textContent,'');
  }finally{dom.window.close();}
});

test('PF-4 compute posts only the declared limits, renders explained changes, advisories and consequences, and Save opens only with the confirmation',async()=>{
  const answer=previewAnswer({context:{readyDeploymentId:'dep-1'}}),proposal=answer.proposal;
  const p=setup({scope:'bot-1',handler:router({preview:answer,apply:SAVED})}),q=parts(p);let loads=0;p.w.load=async()=>{loads++;};
  try{
    assert.match(rootText(q),/^Declare your limits, then compute a proposal\.$/);assert.equal(p.calls.length,0,'nothing is requested before a click');
    fill(p,q,{loss_per_trade_percent:' 1 ',order_notional_ceiling:'500',daily_notional_ceiling:'',allow_repeated_entries:'false'});
    q.compute.click();await settle();
    const [call]=only(p,P4);assert.equal(only(p,P4).length,1);
    assert.equal(call.options.method,'POST');assert.equal(call.options.silent,true,'a preview shows no Saved toast');
    assert.deepEqual(JSON.parse(call.options.body),{declared:{loss_per_trade_percent:'1',order_notional_ceiling:'500',allow_repeated_entries:false}});
    assert.deepEqual([...q.root.querySelectorAll('.pf3-table th')].map(th=>th.textContent),['Setting','Before','After','Rule','Provenance','Explanation']);
    const rows=rows4(q);
    assert.deepEqual(rows.map(row=>row[0]),proposal.changes.map(item=>({maxRiskPercent:'Max risk per trade (%)',maxOrderNotional:'Max order notional',
      onePositionPerSymbol:'Block repeated entries',capPercentEquitySize:'Cap Percent Equity size',['defaults.orderNotional']:'Default orderNotional'})[item.field]));
    assert.deepEqual(rows[0].slice(1,4),['5','1','Risk ceiling · Lower']);
    assert.match(rows[0][4],/^Saved policy [a-f0-9]{12}You declared loss_per_trade_percent = 1Bridge deployment dep-1 1%$/);
    assert.equal(rows[0][5],'You declared 1% loss per trade. Max risk per trade falls from 5% to 1%. The active Bridge risk is 1%, so entries stay possible. Fees, slippage and gaps can exceed a nominal stop.');
    const flags=rows.find(row=>row[0]==='Block repeated entries');assert.deepEqual(flags.slice(1,3),['Off','On']);
    const cap=rows.find(row=>row[0]==='Cap Percent Equity size');
    assert.match(cap[4],/PF-2 evidence job-1 {0,2}CASH_LIMIT 1, ORDER_NOTIONAL_LIMIT 3/);
    assert.match(cap[5],/^4 historical BUY intents were rejected because the risk-sized order exceeded a limit\. Lower notional ceilings with capping off would reject orders above them; capping keeps them inside the new ceilings\. Capping keeps an order inside every limit/);
    const advisories=[...q.root.querySelectorAll('li.pf4-advisory')].map(item=>item.textContent);
    assert.ok(!advisories.some(text=>/news/i.test(text)),'no advice about the news block: it is automatic and hidden');
    assert.ok(!rows.some(row=>/news/i.test(row[0])),'the news block is never proposed');
    for(const code of ['LOSS_GUARDS_LOCKED','CAPITAL_NEVER_CHANGED','HISTORICAL_AFTER_NOT_SIMULATED','SAVE_STALES_DEPLOYMENT'])assert.ok(advisories.some(text=>text.startsWith(code+' ')),code);
    assert.ok(q.root.querySelector('li.pf4-warn'));
    assert.match(rootText(q),/What a save changes\s*DEPLOYMENT_SNAPSHOT_STALE The READY Bridge deployment becomes stale: generate and activate again before trading\. dep-1\s*PF2_EVIDENCE_STALE The PF-2 evidence no longer matches the saved policy: enroll and run Preflight again\. job-1/);
    assert.match(rootText(q),/Policy check\s*CONSISTENT → CONSISTENT.*Remaining daily notional\s*20000 → 30000/);
    assert.match(rootText(q),/Proposal\s*[a-f0-9]{16}.*Readiness verdict\s*READY_TO_START_PAPER.*Declared limits\s*\{"loss_per_trade_percent":"1"/);
    // Save stays closed until the confirmation is ticked.
    assert.deepEqual([q.confirm.disabled,q.confirm.checked,q.save.disabled],[false,false,true]);
    tick(p,q);assert.equal(q.save.disabled,false);tick(p,q,false);assert.equal(q.save.disabled,true);tick(p,q);
    q.save.click();await settle();
    const [save]=only(p,P4A);assert.equal(only(p,P4A).length,1);
    assert.equal(save.options.method,'POST');assert.equal(save.options.silent,undefined,'the shared helper shows the Saved toast');
    assert.deepEqual(JSON.parse(save.options.body),{base_policy_hash:proposal.base_policy_hash,proposal_hash:proposal.proposal_hash,
      declared:{loss_per_trade_percent:'1',order_notional_ceiling:'500',allow_repeated_entries:false},confirm:CONFIRM});
    assert.equal(loads,1,'the Risk form is reloaded');assert.equal(only(p,PATH).length,1,'and the PF-3 report is read again');
    assert.match(rootText(q),/^Saved\. The Risk policy now matches the proposal\.\s*Policy hash before\s*c{64}\s*Policy hash after\s*d{64}\s*Changed settings\s*maxRiskPercent maxOrderNotional/);
    assert.match(rootText(q),/What a save changes\s*DEPLOYMENT_SNAPSHOT_STALE.*The Risk form and the readiness report were refreshed\.$/);
    assert.deepEqual([q.confirm.disabled,q.confirm.checked,q.save.disabled],[true,false,true],'one save per proposal');
    q.save.disabled=false;q.save.click();await settle();assert.equal(only(p,P4A).length,1,'a forced click saves nothing: there is no proposal');
  }finally{p.w.close();}
});

test('PF-4 Save gating: refusal, edited limits, an unsaved Risk form and a forced click all keep the save closed',async()=>{
  const refused=previewAnswer({save:{allowed:false,refusal_code:'RISK_POLICY_FROZEN',confirm:CONFIRM,consequences:CONSEQUENCES}});
  const p=setup({scope:'bot-1',handler:router({preview:refused,apply:SAVED})}),q=parts(p);
  try{
    q.compute.click();await settle();
    assert.deepEqual([q.confirm.disabled,q.save.disabled],[true,true],'the server refuses this proposal');
    assert.match(rootText(q),/This proposal cannot be saved: The Risk policy is frozen while the bot is running or paused\. Stop the bot first\./);
    q.confirm.disabled=false;q.confirm.checked=true;q.save.disabled=false;q.save.click();await settle();
    assert.equal(only(p,P4A).length,0,'a tampered control still saves nothing: the proposal is not allowed');
  }finally{p.w.close();}
  const ok=previewAnswer(),open=setup({scope:'bot-1',handler:router({preview:ok,apply:SAVED})}),o=parts(open);
  try{
    o.compute.click();await settle();tick(open,o);assert.equal(o.save.disabled,false);
    // Editing a declared limit makes the proposal stale: the confirmation is withdrawn and the save closes.
    fill(open,o,{daily_notional_ceiling:'900'});
    assert.deepEqual([o.confirm.disabled,o.confirm.checked,o.save.disabled],[true,false,true]);
    assert.match(rootText(o),/The limits changed after this proposal was computed\. Compute it again\./);
    assert.ok(o.root.querySelector('table'),'the stale proposal stays visible so the owner sees what changed');
    o.confirm.disabled=false;o.confirm.checked=true;o.save.disabled=false;o.save.click();await settle();
    assert.equal(only(open,P4A).length,0,'a stale proposal is never saved');
    // The select counts as an edit too; computing again clears the stale mark.
    o.compute.click();await settle();assert.deepEqual([o.confirm.disabled,o.save.disabled],[false,true]);assert.doesNotMatch(rootText(o),/Compute it again/);
    // An unsaved Risk form: the page flag decides, on every Risk form event, and the proposal is kept.
    tick(open,o);assert.equal(o.save.disabled,false);
    open.w._riskDirty=true;open.d.querySelector('#riskForm').dispatchEvent(new open.w.Event('input',{bubbles:true}));
    assert.deepEqual([o.confirm.disabled,o.confirm.checked,o.save.disabled],[true,false,true]);
    assert.match(rootText(o),/Save or discard your Risk form changes first\./);assert.ok(o.root.querySelector('table'));
    o.confirm.disabled=false;o.confirm.checked=true;o.save.disabled=false;o.save.click();await settle();assert.equal(only(open,P4A).length,0,'a dirty Risk form blocks the save');
    open.w._riskDirty=false;open.d.querySelector('#riskForm').dispatchEvent(new open.w.Event('change',{bubbles:true}));
    assert.deepEqual([o.confirm.disabled,o.confirm.checked,o.save.disabled],[false,false,true],'open again, but the owner must confirm again');
    assert.doesNotMatch(rootText(o),/Save or discard/);
    // Typing in the Risk form never makes a request.
    assert.equal(open.calls.filter(call=>call.path!==P4).length,0);
  }finally{open.w.close();}
});

test('PF-4 drops late responses and clears on a bot switch, logout and All Bots; All Bots makes no request',async()=>{
  const first=previewAnswer({declared:{loss_per_trade_percent:'2'}}),second=previewAnswer({declared:{loss_per_trade_percent:'3'}});
  const answers=[{value:first,delay:120},{value:second,delay:10}];
  const p=setup({scope:'bot-1',handler:router({preview:()=>new Promise(resolve=>{const next=answers.shift();setTimeout(()=>resolve(structuredClone(next.value)),next.delay);})})}),q=parts(p);
  try{
    q.compute.click();q.compute.click();await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(only(p,P4).length,2);assert.match(rootText(q),/loss_per_trade_percent":"3"/);assert.doesNotMatch(rootText(q),/loss_per_trade_percent":"2"/,'the older answer arrived last and is dropped');
  }finally{p.w.close();}
  for(const [name,disturb] of [['bot switch',x=>{x.w.selectedBot='bot-2';x.d.querySelector('#botSwitcher').dispatchEvent(new x.w.Event('change'));}],
    ['logout',x=>x.d.querySelector('#logout').click()]]){
    const slow=setup({scope:'bot-1',handler:router({preview:()=>new Promise(resolve=>setTimeout(()=>resolve(previewAnswer()),60)),apply:SAVED})}),s=parts(slow);
    try{
      s.compute.click();await settle();disturb(slow);await new Promise(resolve=>setTimeout(resolve,150));
      assert.match(rootText(s),/^Declare your limits, then compute a proposal\.$/,name+': the late preview is dropped');
      assert.equal(s.root.querySelector('table'),null);assert.equal(s.save.disabled,true);
    }finally{slow.w.close();}
    // A save in flight when the bot changes: its answer is not shown and the Risk form is not reloaded for the wrong bot.
    let loads=0;
    const saving=setup({scope:'bot-1',handler:router({preview:previewAnswer(),apply:()=>new Promise(resolve=>setTimeout(()=>resolve(structuredClone(SAVED)),60))})}),v=parts(saving);
    saving.w.load=async()=>{loads++;};
    try{
      v.compute.click();await settle();tick(saving,v);v.save.click();await new Promise(resolve=>setTimeout(resolve,10));disturb(saving);
      await new Promise(resolve=>setTimeout(resolve,150));
      assert.equal(only(saving,P4A).length,1);assert.equal(loads,0,name+': no reload after the bot changed');assert.doesNotMatch(rootText(v),/Saved\./);
    }finally{saving.w.close();}
  }
  const all=setup({scope:'all',handler:router({preview:previewAnswer()})}),a=parts(all);
  try{
    a.compute.click();await settle();a.sizing.click();await settle();
    assert.equal(all.calls.length,0);assert.match(rootText(a),/^Select one bot for this operation$/);assert.equal(a.save.disabled,true);
  }finally{all.w.close();}
});

test('PF-4 shows the meaning of every refusal, clears the proposal, requires a new compute and never retries a save',async()=>{
  const meanings={STALE_POLICY_STATE:'The saved policy changed after this proposal was computed. Compute it again.',
    PROPOSAL_STALE:'The inputs of this proposal changed (policy, evidence or limits). Compute it again.',
    RISK_POLICY_FROZEN:'The Risk policy is frozen while the bot is running or paused. Stop the bot first.',
    CAPITAL_DRIFT:'The saved capital differs from the funding ledger, so a save would add funds. It is refused.',
    BASE_POLICY_CONFLICT:'The saved policy has conflicting settings. Fix them in the Risk form first.',
    PROPOSAL_EMPTY:'These limits change nothing: the saved policy already matches them.',
    RETRY_TRANSACTION:'Another change was in progress. Compute the proposal again.',PF4_FUNDING_INVARIANT:'The save was cancelled because it would have changed funding.',
    CONFIRMATION_REQUIRED:'Confirmation is required to save.',INVALID_FIELDS:'The request was not accepted.'};
  for(const [code,meaning] of Object.entries(meanings)){
    const status=code==='INVALID_FIELDS'||code==='CONFIRMATION_REQUIRED'?400:code==='PF4_FUNDING_INVARIANT'?500:409;
    const p=setup({scope:'bot-1',handler:router({preview:previewAnswer(),apply:()=>{throw apiError(code,status);}})}),q=parts(p);let loads=0;p.w.load=async()=>{loads++;};
    try{
      q.compute.click();await settle();tick(p,q);q.save.click();await settle();await settle();
      assert.equal(only(p,P4A).length,1,code+': one attempt, no automatic retry');assert.equal(only(p,P4).length,1,code+': no automatic recompute');
      assert.ok(rootText(q).startsWith(meaning+' ('+code+')')&&rootText(q).endsWith('Compute the proposal again.'),rootText(q));
      assert.equal(q.root.querySelector('table'),null);assert.deepEqual([q.confirm.disabled,q.confirm.checked,q.save.disabled],[true,false,true]);
      assert.equal(loads,0);assert.equal(only(p,PATH).length,0,'a refused save reloads nothing');
    }finally{p.w.close();}
  }
  const invalid=setup({scope:'bot-1',handler:router({preview:()=>{throw Object.assign(apiError('PF4_DECLARED_INVALID',400),{message:'PF4_DECLARED_INVALID: loss_per_trade_percent'});}})}),i=parts(invalid);
  try{
    fill(invalid,i,{loss_per_trade_percent:'abc'});i.compute.click();await settle();
    assert.match(rootText(i),/^A declared limit is not valid\. Use a plain number inside its range\. \(PF4_DECLARED_INVALID\)\s*loss_per_trade_percent/);
    assert.equal(i.save.disabled,true);
  }finally{invalid.w.close();}
  for(const [error,expected] of [[apiError(undefined,500),'HTTP_500'],[new TypeError('Failed to fetch'),'REQUEST_FAILED'],[apiError('SOMETHING_NEW',409),'SOMETHING_NEW']]){
    const p=setup({scope:'bot-1',handler:router({preview:()=>{throw error;}})}),q=parts(p);
    try{q.compute.click();await settle();assert.ok(rootText(q).includes('('+expected+')'),rootText(q));}finally{p.w.close();}
  }
});

test('PF-4 sizing preview: sends the Order Preview intent, shows before and after, and explains a refusal',async()=>{
  const sizing={status:'COMPUTED',code:null,detail:null,capital:{source:'ACTUAL_UNCHANGED',cash:'800',book_equity:'1000'},limitations:[],
    before:{readiness:{status:'UNKNOWN',reasons:[]},calculation:{status:'REJECTED',reason:'Order exceeds available configured Spot balance'},policy_hash:'e'.repeat(64),policy_source:'SAVED_POLICY'},
    after:{readiness:{status:'UNKNOWN',reasons:[]},calculation:{status:'CAPPED',order:{quantity:'0.008',notional:'400',sizingAdjustment:{reason:'Capped'}}},
      policy_hash:'f'.repeat(64),policy_source:'HYPOTHETICAL_DRAFT',costs:null}};
  const intent={signal:{account_type:'SPOT',broker:'binance-global',symbol:'BTCUSDT',event:'BUY',entry:'50000',sl:'49500'}};
  const p=setup({scope:'bot-1',handler:router({preview:()=>previewAnswer({sizing})})}),q=parts(p);
  try{
    // Without an Order Preview request the button explains what to fill in and asks for nothing.
    q.sizing.click();await settle();assert.equal(p.calls.length,0);
    assert.match(rootText(q),/^Fill in the Order Preview above first: price and Stop Loss for a generic BUY, or a deployed Bridge intent\.$/);
    p.w.riskPreviewRequest=()=>null;q.sizing.click();await settle();assert.equal(p.calls.length,0);
    p.w.riskPreviewRequest=()=>structuredClone(intent);
    fill(p,q,{loss_per_trade_percent:'1'});q.sizing.click();await settle();
    assert.equal(only(p,P4).length,1);assert.deepEqual(JSON.parse(only(p,P4)[0].options.body),{declared:{loss_per_trade_percent:'1'},intent});
    const table=[...q.root.querySelectorAll('.pf3-block')].find(block=>block.querySelector('h3')?.textContent==='Sizing before and after');
    assert.ok(table,'the sizing block');
    const text=table.textContent.replace(/\s+/g,' ');
    assert.match(text,/Capital used\s*ACTUAL_UNCHANGED · Cash 800 · Book equity \(cost basis\) 1000/);
    const cells=[...table.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent));
    assert.deepEqual(cells,[['Calculation','REJECTED','CAPPED'],['Reason','Order exceeds available configured Spot balance','—'],['Sized quantity','—','0.008'],
      ['Sized notional','—','400'],['Capped to limits','No','Yes'],['Policy source','SAVED_POLICY','HYPOTHETICAL_DRAFT']]);
    assert.deepEqual([...table.querySelectorAll('th')].map(th=>th.textContent),['Item','Before','After']);
    // A refused sizing keeps the proposal and says why.
    const refused=setup({scope:'bot-1',handler:router({preview:()=>previewAnswer({sizing:{status:'REFUSED',code:'PF4_SIZING_POLICY_SOURCE',detail:'The effective policy is not the saved policy',
      before:null,after:null,capital:{source:'ACTUAL_UNCHANGED',cash:'800',book_equity:'1000'}}})})}),r=parts(refused);
    try{
      refused.w.riskPreviewRequest=()=>structuredClone(intent);r.sizing.click();await settle();
      assert.match(rootText(r),/Sizing before and after\s*Status\s*REFUSED\s*Reason\s*The effective policy is not the saved policy, so the sizes are not shown\. \(The effective policy is not the saved policy\)/);
      assert.ok(r.root.querySelector('table'),'the proposed changes are still shown');assert.deepEqual([r.confirm.disabled,r.save.disabled],[false,true]);
    }finally{refused.w.close();}
  }finally{p.w.close();}
});

test('PF-4 Thai: static text, every label, the templated explanations, advisories and consequences follow the language; raw data stays raw',async()=>{
  const answer=previewAnswer({context:{readyDeploymentId:'dep-1'}});
  const p=setup({language:'th',scope:'bot-1',handler:router({preview:answer,apply:SAVED})}),q=parts(p),{d,w}=p;
  try{
    assert.equal(d.querySelector('#pf4Panel h2').textContent,'ข้อเสนอ Risk');
    assert.equal(d.querySelector('#pf4Panel .panel-title p').textContent,w.translate('Deterministic and explained. Nothing is saved until you confirm.'));
    assert.deepEqual([q.compute.textContent,q.sizing.textContent,q.save.textContent],['คำนวณข้อเสนอ','ดูขนาดคำสั่งก่อน/หลัง','บันทึกข้อเสนอ']);
    assert.equal(q.field('allow_repeated_entries').options[1].textContent,'บล็อกการเข้าซ้ำ');
    assert.equal(q.root.textContent,w.translate('Declare your limits, then compute a proposal.'));
    q.compute.click();await settle();
    assert.deepEqual([...q.root.querySelectorAll('.pf3-table th')].map(th=>th.textContent),['Setting','Before','After','Rule','Provenance','Explanation'].map(text=>w.translate(text)));
    const rows=rows4(q);
    assert.equal(rows[0][3],'เพดานความเสี่ยง · ลด');
    assert.equal(rows[0][5],'คุณระบุขาดทุนต่อเทรด 1% ความเสี่ยงสูงสุดต่อเทรดลดจาก 5% เป็น 1% ความเสี่ยงของ Bridge ที่ใช้งานอยู่คือ 1% จึงยังเปิดสถานะได้ ค่าธรรมเนียม สลิปเพจ และการเว้นช่องราคา (gap) อาจทำให้ขาดทุนเกินระดับ Stop ที่ตั้งไว้');
    assert.deepEqual(rows.find(row=>row[0]===w.translate('Block repeated entries')).slice(1,3),[w.translate('Off'),w.translate('On')]);
    assert.notEqual(w.translate('Off'),'Off');
    assert.ok(![...q.root.querySelectorAll('li.pf4-advisory')].some(item=>/NEWS_BLOCK|ข่าว/.test(item.textContent)),'no news advisory in Thai either');
    assert.ok(rootText(q).includes('Bridge deployment ที่ READY จะหมดอายุ ต้องสร้างและเปิดใช้งานใหม่ก่อนเทรด'));
    assert.ok(rootText(q).includes('LOSS_CEILING')===false&&rootText(q).includes('SAVED_POLICY')===false,'rule and source names are translated labels');
    assert.ok(rootText(q).includes('CONSISTENT → CONSISTENT')&&rootText(q).includes('LOSS_GUARDS_LOCKED')&&rootText(q).includes('dep-1'),'codes and ids stay raw');
    for(const element of d.querySelectorAll('#pf4Panel [data-ui-label]')){
      const label=element.dataset.uiLabel;assert.equal(element.textContent,w.translate(label),label);assert.notEqual(element.textContent,label,'untranslated: '+label);
    }
    const language=d.querySelector('#language');
    language.value='en';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(d.querySelector('#pf4Panel h2').textContent,'Risk proposal');
    assert.equal(rows4(q)[0][5].startsWith('You declared 1% loss per trade. Max risk per trade falls from 5% to 1%.'),true,'a computed proposal follows the language without a new request');
    assert.equal(only(p,P4).length,1);
    language.value='th';language.dispatchEvent(new w.Event('change'));await settle();assert.equal(rows4(q)[0][3],'เพดานความเสี่ยง · ลด');
    tick(p,q);q.save.click();await settle();
    assert.match(rootText(q),/^บันทึกแล้ว นโยบาย Risk ตรงกับข้อเสนอแล้ว/);
  }finally{p.w.close();}
  // Refusal meanings and every rule/direction pair have a Thai text.
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),win=dom.window;
  try{
    win.localStorage.setItem('robotLanguage','th');win.eval(publicFile('i18n.js')+';window.__mine=pf4Pairs;window.__pairs=uiPairs;');
    const mine=win.__mine,english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.equal(english.size,mine.length);assert.equal(thai.size,mine.length);
    for(const [en,th] of mine)assert.deepEqual([...en.matchAll(/[{](\w+)[}]/g)].map(match=>match[1]).sort(),[...th.matchAll(/[{](\w+)[}]/g)].map(match=>match[1]).sort(),en);
    for(const pair of win.__pairs.filter(pair=>!mine.includes(pair)))for(const text of pair)assert.ok(!english.has(text)&&!thai.has(text),'collides: '+text);
    const source=pf4Source(),shown=new Set();
    for(const match of source.matchAll(/'([A-Z][^'\n]*)'/g))if(/[a-z]/.test(match[1])&&!/^[A-Z0-9_ ]+$/.test(match[1]))shown.add(match[1]);
    for(const match of source.matchAll(/\b(?:T|tpl|label|note|row|group)[(]\s*'([^'\n]*)'/g))shown.add(match[1]);
    for(const match of source.matchAll(/table[(][[]([^\]]+)[\]]/g))for(const item of match[1].matchAll(/'([^']+)'/g))shown.add(item[1]);
    assert.ok(shown.size>80,'literals found: '+shown.size);
    for(const text of shown)assert.notEqual(win.translate(text),text,'missing Thai: '+text);
    const page=new JSDOM(publicFile('index.html')).window.document;
    for(const node of [...page.querySelectorAll('#pf4Panel h2,#pf4Panel p,#pf4Panel label,#pf4Panel button,#pf4Panel option')]){
      const own=[...node.childNodes].filter(child=>child.nodeType===3).map(child=>child.textContent.trim()).join('');
      if(own)assert.ok(english.has(own),'a static text without a pair: '+own);
    }
  }finally{win.close();}
});

test('PF-4 hostile values are shown as text, an unknown rule or advisory shows the server text, and a broken shape degrades one section',async()=>{
  const answer=previewAnswer();
  const hostile='<img src=x onerror=alert(1)>';
  answer.proposal.changes[0].field=hostile;answer.proposal.changes[0].rule='UNKNOWN_RULE';answer.proposal.changes[0].explanation='<script>boom()</script>';
  answer.proposal.changes[0].provenance=[{source:'<b>x</b>',hash:'<svg onload=bad()>'},{source:'OWNER_DECLARED',field:'<u onclick=bad()>x</u>',value:'<iframe>'}];
  answer.proposal.advisories.push({code:'NEW_ADVISORY_CODE',severity:'warn',explanation:'<a href=x>click</a>'});
  answer.save.consequences=[{code:'NEW_CONSEQUENCE',deployment_id:'<i onmouseover=bad()>x</i>'}];
  const p=setup({scope:'bot-1',handler:router({preview:answer})}),q=parts(p);
  try{
    q.compute.click();await settle();
    assert.equal(q.root.querySelectorAll('img,script,b,iframe,a,svg,u,i').length,0);
    assert.equal(q.root.querySelector('[onerror],[onmouseover],[onload],[onclick],[style]'),null);
    const text=rootText(q);
    for(const value of [hostile,'<script>boom()</script>','<b>x</b>','<u onclick=bad()>x</u> = <iframe>','<a href=x>click</a>','NEW_ADVISORY_CODE','NEW_CONSEQUENCE'])assert.ok(text.includes(value),value);
    assert.equal(rows4(q)[0][5],'<script>boom()</script>','an unknown rule falls back to the server explanation');
  }finally{p.w.close();}
  // A malformed answer degrades the sections that read the bad part and still shows the rest.
  const broken=previewAnswer();broken.static=null;broken.proposal.changes=[{field:'maxRiskPercent',before:'1',after:'2',rule:'LOSS_CEILING',direction:'RAISE',provenance:null,explanation:null}];
  broken.proposal.advisories=null;broken.save.consequences=null;
  const b=setup({scope:'bot-1',handler:router({preview:broken})}),r=parts(b);
  try{
    r.compute.click();await settle();
    assert.match(rootText(r),/Proposed changes/);assert.match(rootText(r),/Max risk per trade \(%\)/);assert.match(rootText(r),/Policy before and after/);
    assert.equal(r.root.querySelectorAll('li.pf4-advisory').length,0);
  }finally{b.w.close();}
  const empty=setup({scope:'bot-1',handler:()=>null}),e=parts(empty);
  try{e.compute.click();await settle();assert.ok(rootText(e).includes('(REQUEST_FAILED)'),rootText(e));assert.equal(e.save.disabled,true);}finally{empty.w.close();}
});

test('the PF-4 part of readiness.js has exactly two POST calls, one confirmation constant, one save path and no markup injection or storage',()=>{
  const source=pf4Source();
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket','localStorage',
    'sessionStorage','setAttribute(','.style','http://','https://','onclick=','confirm(','prompt(','setTimeout(','setInterval('])
    assert.ok(!source.includes(banned),'forbidden in the PF-4 part: '+banned);
  assert.deepEqual([...source.matchAll(/'(\/api\/[^']*)'/g)].map(match=>match[1]),[P4,P4A]);
  assert.equal(source.split('await api(').length-1,2,'two api() call sites');
  assert.equal(source.split("method:'POST'").length-1,2);
  assert.equal(source.split('SAVE_RISK_PROPOSAL').length-1,1,'the confirmation constant appears once, in the save body');
  const save=source.slice(source.indexOf('async function savePf4'),source.indexOf('function clearPf4'));
  assert.ok(save.includes("'/api/risk/proposals/apply'")&&save.includes('SAVE_RISK_PROPOSAL')&&!save.includes('silent'),'the save shows the Saved toast');
  const computePart=source.slice(source.indexOf('async function computePf4'),source.indexOf('async function savePf4'));
  assert.ok(computePart.includes("'/api/risk/proposals/preview'")&&computePart.includes('silent:true')&&!computePart.includes('apply'));
  assert.equal(source.split('savePf4').length-1,2,'the save function is defined once and wired once');
  assert.deepEqual([...source.matchAll(/addEventListener\('([a-z:0-9]+)',savePf4/g)].map(match=>match[1]),['click']);
  assert.ok(save.includes('riskDirty()')&&save.includes('p4.stale')&&save.includes('pf4Confirm.checked')&&save.includes("allowed!==true"),'the save re-checks every gate');
  assert.ok(!/localStorage|sessionStorage/.test(source));
  assert.deepEqual([...new Set([...source.matchAll(/addEventListener\('([a-z:0-9]+)'/g)].map(match=>match[1]))].sort(),['change','click','input','submit']);
  // The whole file still has the single readiness-report GET and the two PF-4 paths, nothing else.
  assert.deepEqual([...publicFile('readiness.js').matchAll(/'(\/api\/[^']*)'/g)].map(match=>match[1]),[PATH,P4,P4A]);
});

test('PF-4 styles: the changes table keeps its numbers whole and scrolls, a disabled button looks disabled, the confirm row sits together',()=>{
  const css=publicFile('styles-v2.css'),at=css.indexOf('/* PF-4 Risk proposals'),guided=css.indexOf('/* Guided Build Pine Bridge panel');
  assert.ok(at>0&&guided>at,'the PF-4 block sits above the Guided Build block, outside the tail slices of the bridge, journey and PF-3 style tests');
  const strip=text=>{let out='',rest=text;for(;;){const open=rest.indexOf('/*');if(open<0){out+=rest;break;}out+=rest.slice(0,open);const close=rest.indexOf('*/',open+2);if(close<0)break;rest=rest.slice(close+2);}return out;};
  const block=strip(css.slice(at,guided));
  const rule=selector=>{const index=block.indexOf(selector+'{');assert.ok(index>=0,'missing rule '+selector);return block.slice(index,block.indexOf('}',index));};
  for(const selector of ['.pf4-panel','.pf4-form','.pf4-grid label','.pf4-root','.pf4-prov'])assert.ok(rule(selector).includes('min-width:0'),selector+' may shrink');
  for(const selector of ['.pf4-confirm','.pf4-prov-item','.pf4-advisory'])assert.ok(rule(selector).includes('overflow-wrap:anywhere'),selector+' wraps long text');
  assert.ok(rule('.pf4-actions').includes('flex-wrap:wrap'));assert.ok(rule('.pf4-grid input,.pf4-grid select').includes('max-width:100%'));
  assert.ok(block.includes('@media(max-width:600px)'));
  // UI-1: the numbers of the changes table never wrap, not even per digit, and the table scrolls inside its wrapper.
  const numbers=rule('#pf4Panel .pf4-changes th,#pf4Panel .pf4-changes td:nth-child(2),#pf4Panel .pf4-changes td:nth-child(3)');
  assert.ok(numbers.includes('white-space:nowrap')&&numbers.includes('overflow-wrap:normal'),'headers and Before/After cells');
  assert.ok(rule('#pf4Panel .pf4-changes').includes('min-width:640px'));
  assert.ok(rule('#pf4Panel .pf4-sizing th,#pf4Panel .pf4-sizing td').includes('overflow-wrap:normal'),'the sizing words and numbers stay whole too');
  assert.ok(/[.]pf3-table-wrap[{][^}]*overflow-x:auto/.test(css),'the existing wrapper scrolls');
  // Scoped: every selector that uses nowrap, a fixed min-width or a normal wrap starts at the PF-4 panel, so no other table changes.
  const risky=[...block.matchAll(/([^{}]+)[{]([^}]*)[}]/g)].filter(match=>/nowrap|min-width:[0-9]+px|overflow-wrap:normal/.test(match[2]));
  assert.ok(risky.length>=3);
  for(const [,selectors] of risky)for(const selector of selectors.split(',').map(item=>item.trim()))assert.ok(selector.startsWith('#pf4Panel '),'scoped to the PF-4 panel: '+selector);
  const ids=selector=>(selector.match(/#[A-Za-z0-9_-]+/g)||[]).length;
  assert.ok(ids('#pf4Panel .pf4-changes td:nth-child(2)')>ids('.pf3-table td'),'the id selector beats the PF-3 table rule in any order');
  assert.ok(css.slice(css.indexOf('/* PF-3 readiness report')).includes('.pf3-table th,.pf3-table td{padding:6px;white-space:normal;overflow-wrap:anywhere}'),'the PF-3 table rule is unchanged');
  // UI-2 and UI-3.
  assert.ok(rule('#pf4Panel button:disabled').includes('opacity:.5')&&rule('#pf4Panel button:disabled').includes('cursor:not-allowed'));
  const confirm=rule('.pf4-confirm');assert.ok(confirm.includes('display:flex')&&confirm.includes('align-items:flex-start')&&confirm.includes('gap:8px'));
  assert.ok(rule('.pf4-confirm input').includes('width:auto')&&rule('.pf4-confirm input').includes('flex:none'),'the checkbox keeps its size beside the text');
  // The PF-3, journey and bridge style tests still hold: nothing banned in their slices.
  const tail=css.slice(css.indexOf('/* PF-3 readiness report')),journey=css.slice(css.indexOf('/* Prototype journey')),bridge=css.slice(guided,css.indexOf('/* Prototype journey'));
  for(const slice of [tail,journey,bridge])assert.ok(!slice.includes('nowrap')&&!/min-width:[0-9]+px/.test(slice)&&!/[^-]width:[0-9]{3,}px/.test(slice));
  assert.ok(!tail.includes('[hidden]')&&!journey.includes('[hidden]'));
});

test('PF-4 marks its tables for the stylesheet: six headers in the changes table, three in the sizing table, both inside the scrolling wrapper',async()=>{
  const sizing={status:'COMPUTED',code:null,detail:null,capital:{source:'ACTUAL_UNCHANGED',cash:'800',book_equity:'1000'},limitations:[],
    before:{calculation:{status:'REJECTED',reason:'Order exceeds available configured Spot balance'},policy_source:'SAVED_POLICY'},
    after:{calculation:{status:'CAPPED',order:{quantity:'0.008',notional:'400'}},policy_source:'HYPOTHETICAL_DRAFT'}};
  const p=setup({scope:'bot-1',handler:router({preview:previewAnswer({sizing})})}),q=parts(p);
  try{
    q.compute.click();await settle();
    const changes=q.root.querySelector('table.pf4-changes'),sizes=q.root.querySelector('table.pf4-sizing');
    assert.ok(changes&&sizes,'both tables carry their PF-4 class');
    assert.equal(changes.querySelectorAll('thead th').length,6);assert.equal(sizes.querySelectorAll('thead th').length,3);
    for(const table of [changes,sizes]){assert.ok(table.classList.contains('pf3-table'));assert.ok(table.parentElement.classList.contains('pf3-table-wrap'),'the wrapper scrolls');}
    assert.equal(q.root.querySelectorAll('table').length,2);
    // The cells the stylesheet keeps unwrapped hold the whole numbers and flags.
    const rows=[...changes.querySelectorAll('tbody tr')],first=[...rows[0].children];
    assert.deepEqual([first[1].textContent,first[2].textContent],['5','1']);
    const orderRow=rows.find(tr=>tr.children[0].textContent==='Max order notional');
    assert.deepEqual([orderRow.children[1].textContent,orderRow.children[2].textContent],['2000','500']);
    assert.equal(p.d.querySelectorAll('#pf3Root table.pf4-changes,#pf3Root table.pf4-sizing').length,0,'the PF-3 report tables are not marked');
  }finally{p.w.close();}
});

test('PF-4 with app.js: the sizing button sends the Order Preview intent of riskPreviewRequest (generic or Bridge) and nothing when the form is incomplete',async()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document,requests=[];
  try{
    w.fetch=async(path,options)=>{requests.push({path,method:options?.method??'GET',body:options?.body?JSON.parse(options.body):null});return {ok:true,json:async()=>previewAnswer()};};
    w.eval(publicFile('i18n.js')+'\n'+publicFile('app.js')+`
      authenticated=true;selectedBot='bot-a';me={moneyFormat:'decimal-string',bot:{id:'bot-a'},user:{id:'owner'},risk:{},botSession:{state:'SETUP'}};
      load=async function(){};window.setLegacy=()=>{me={...me,moneyFormat:'number'};};window.setAuth=value=>{authenticated=value;};
    `+'\n'+publicFile('readiness.js'));
    const f=d.querySelector('#riskForm').elements,q=parts({d,w});
    assert.equal(typeof w.riskPreviewRequest,'function');assert.equal(w.riskPreviewRequest(),null,'a generic BUY needs an entry and a Stop Loss');
    q.sizing.click();await settle();assert.equal(requests.length,0);assert.match(rootText(q),/^Fill in the Order Preview above first/);
    f.previewEntry.value='50000';f.previewStopLoss.value='49500';f.previewRiskPercent.value='1';
    q.sizing.click();await settle();
    const [sent]=requests;
    assert.equal(sent.path,'/api/risk/proposals/preview?bot_id=bot-a');assert.equal(sent.method,'POST');
    assert.deepEqual(Object.keys(sent.body),['declared','intent']);assert.deepEqual(Object.keys(sent.body.intent),['signal']);
    assert.deepEqual(sent.body.intent.signal,{...sent.body.intent.signal,account_type:'SPOT',broker:'binance-global',symbol:'BTCUSDT',event:'BUY',
      order_type:'MARKET',risk_mode:'PERCENT_EQUITY',risk_value:'1',entry:'50000',sl:'49500',reduce_only:false});
    f.previewSource.value='BRIDGE';f.previewDeploymentId.value='deployment-a';f.previewBarTime.value='1790553600000';
    q.sizing.click();await settle();
    assert.deepEqual(requests[1].body.intent,{bridge:{deployment_id:'deployment-a',bar_time:1790553600000,event_type:'BUY'}});
    f.previewBridgeEvent.value='EXIT';f.previewEntryRef.value='deployment-a:1790553540000:0';f.previewExitReason.value='TP';
    assert.deepEqual(JSON.parse(JSON.stringify(w.riskPreviewRequest())),{bridge:{deployment_id:'deployment-a',bar_time:1790553600000,event_type:'EXIT',entry_ref:'deployment-a:1790553540000:0',reason:'TP'}});
    q.compute.click();await settle();assert.deepEqual(requests[2].body,{declared:{}},'Compute proposal sends no intent');
    assert.ok(requests.every(request=>request.path.startsWith('/api/risk/proposals/preview')),'only previews were requested');
    assert.notEqual(w._riskDirty,true,'the PF-4 form never marks the Risk form dirty');
    w.setLegacy();assert.equal(w.riskPreviewRequest(),null,'the legacy money format has no saved-authority request');
    w.setAuth(false);assert.equal(w.riskPreviewRequest(),null);
  }finally{w.close();}
});

test('PF-4 re-runs the save gate after every page reload: discarding Risk form changes clears the notice without a new Compute',async()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document,requests=[];
  try{
    w.fetch=async(path,options)=>{requests.push({path,body:options?.body?JSON.parse(options.body):null});return {ok:true,json:async()=>previewAnswer()};};
    // The page loader stands in for load() of app.js: like the real one it ends with the Risk form refilled and the unsaved flag cleared.
    w.eval(publicFile('i18n.js')+'\n'+publicFile('app.js')+`
      authenticated=true;selectedBot='bot-a';me={moneyFormat:'decimal-string',bot:{id:'bot-a'},user:{id:'owner'},risk:{},botSession:{state:'SETUP'}};
      window.reloads=0;window.failNext=false;
      load=async function(){window.reloads++;window._riskDirty=false;if(window.failNext)throw new Error('reload failed');};
    `+'\n'+publicFile('readiness.js'));
    const q=parts({d,w}),p={d,w};
    assert.equal(w.load.pf4Gate,true,'the page loader is wrapped, once');
    q.compute.click();await settle();tick(p,q);assert.equal(q.save.disabled,false);
    w._riskDirty=true;d.querySelector('#riskForm').dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.match(rootText(q),/Save or discard your Risk form changes first\./);assert.deepEqual([q.confirm.disabled,q.confirm.checked,q.save.disabled],[true,false,true]);
    // Refresh discards the edits. Nothing is clicked in the PF-4 form: the gate follows the reload.
    d.querySelector('#refresh').click();await settle();
    assert.equal(w.reloads,1);assert.equal(w._riskDirty,false);
    assert.doesNotMatch(rootText(q),/Save or discard/);assert.ok(q.root.querySelector('table.pf4-changes'),'the proposal is still shown');
    assert.deepEqual([q.confirm.disabled,q.confirm.checked,q.save.disabled],[false,false,true],'open again; the owner confirms again');
    assert.equal(requests.length,1,'only the first Compute was requested');
    // A failing reload still re-runs the gate (finally), and the failure reaches the caller unchanged.
    w._riskDirty=true;d.querySelector('#riskForm').dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.deepEqual([q.confirm.disabled,q.save.disabled],[true,true]);
    w.failNext=true;await assert.rejects(()=>w.load(),/reload failed/);
    assert.deepEqual([q.confirm.disabled,q.save.disabled],[false,true]);assert.doesNotMatch(rootText(q),/Save or discard/);
    // The save itself reloads through the wrapper and still shows its outcome.
    w.failNext=false;
  }finally{w.close();}
  // Without a page loader (this script alone) nothing is wrapped and nothing breaks.
  const alone=setup({scope:'bot-1',handler:router({preview:previewAnswer()})});
  try{assert.equal(typeof alone.w.load,'undefined');parts(alone).compute.click();await settle();assert.ok(parts(alone).root.querySelector('table'));}finally{alone.w.close();}
});

test('PF-4 shows the R rule of the daily loss limit with every proposal, and its money value whenever the risk ceiling rises, in English and Thai',async()=>{
  const R_RULE='The daily loss limit is counted in R (1R is the risk of one trade), so a higher risk per trade raises its money value: for example 3R at 1.5% allows up to 4.5% of equity in one day.';
  const RISES='Max risk per trade rises from 5% to 7%. The daily loss limit of 3R is counted in R, so its money value rises from up to 15% to up to 21% of equity per day.';
  const advisory=(q,code)=>[...q.root.querySelectorAll('li.pf4-advisory')].find(item=>item.textContent.startsWith(code+' '));
  const raise=previewAnswer({declared:{loss_per_trade_percent:'7'}}),lower=previewAnswer({declared:{loss_per_trade_percent:'2'}});
  assert.deepEqual(raise.proposal.advisories.find(item=>item.code==='DAILY_LOSS_VALUE_RISES').values,{before:'5',after:'7',limit:'3',from:'15',to:'21'});
  const p=setup({scope:'bot-1',handler:router({preview:()=>structuredClone(p.answer)})}),q=parts(p);
  try{
    p.answer=raise;q.compute.click();await settle();
    assert.ok(advisory(q,'LOSS_GUARDS_LOCKED').textContent.endsWith('A proposal never loosens a loss guard. '+R_RULE),'the always-on text states the R rule');
    const money=advisory(q,'DAILY_LOSS_VALUE_RISES');
    assert.equal(money.textContent,'DAILY_LOSS_VALUE_RISES '+RISES);assert.ok(money.classList.contains('pf4-warn'),'a raise is a warning');
    // Lowering the ceiling shows the R rule but no money note; so does a proposal without a risk change.
    for(const answer of [lower,previewAnswer({declared:{order_notional_ceiling:'500'}})]){
      p.answer=answer;q.compute.click();await settle();
      assert.equal(advisory(q,'DAILY_LOSS_VALUE_RISES'),undefined);assert.ok(advisory(q,'LOSS_GUARDS_LOCKED').textContent.includes('counted in R'));
    }
  }finally{p.w.close();}
  // Thai: the same two texts, with the numbers filled in; the codes stay raw.
  const th=setup({language:'th',scope:'bot-1',handler:router({preview:raise})}),t=parts(th);
  try{
    t.compute.click();await settle();
    assert.equal(advisory(t,'DAILY_LOSS_VALUE_RISES').textContent,
      'DAILY_LOSS_VALUE_RISES ความเสี่ยงสูงสุดต่อเทรดเพิ่มจาก 5% เป็น 7% วงเงินขาดทุนรายวัน 3R นับเป็น R มูลค่าเงินของวงเงินจึงเพิ่มจากสูงสุด 15% เป็นสูงสุด 21% ของทุนต่อวัน');
    const locked=advisory(t,'LOSS_GUARDS_LOCKED').textContent;
    assert.ok(locked.includes('วงเงินขาดทุนรายวันนับเป็น R (1R คือความเสี่ยงของหนึ่งเทรด)')&&locked.endsWith('เช่น 3R ที่ 1.5% เท่ากับสูงสุด 4.5% ของทุนในหนึ่งวัน'));
    // Switching back to English re-renders the same proposal with the English template.
    const language=th.d.querySelector('#language');language.value='en';language.dispatchEvent(new th.w.Event('change'));await settle();
    assert.equal(advisory(t,'DAILY_LOSS_VALUE_RISES').textContent,'DAILY_LOSS_VALUE_RISES '+RISES);
  }finally{th.w.close();}
});

// Market data section (advisory item from stored public Binance Spot 1m bars).
const MARKET_ADVISORY='Advisory only. Does not change the verdict, enable Historical Preflight or allow trading.';
const marketRows=block=>[...block.querySelectorAll('.pf3-ev')].filter(item=>item.querySelector('.pf3-k')).map(item=>[item.querySelector('.pf3-k').textContent,item.querySelector('.pf3-v').textContent]);

test('Market data section: chip tone, advisory note and rows for PASS, WARN and FAIL; the verdict section is unchanged',async()=>{
  const labels={PASS:['Market data is current','ok'],WARN:['Market data needs attention','warn'],FAIL:['Market data is not usable','bad']};
  for(const status of ['PASS','WARN','FAIL']){
    const report=MARKET_REPORTS[status],item=report.market_data,p=setup({handler:answer(report)});
    try{
      await p.open();
      const block=p.block('Market data');
      assert.ok(block,'section present: '+status);
      const chip=block.querySelector('.pf3-chip');
      assert.equal(chip.textContent,labels[status][0]);assert.ok(chip.classList.contains('pf3-'+labels[status][1]),status);
      assert.equal(block.querySelector('.pf3-head code').textContent,status);
      assert.equal(block.querySelector('.pf3-note').textContent,MARKET_ADVISORY);
      const rows=Object.fromEntries(marketRows(block));
      assert.equal(rows['Latest closed 1m bar'],utc(item.latest_closed_bar.close_time));
      assert.equal(rows['Data age (seconds)'],String(item.age_seconds));
      assert.equal(rows['Bars in the last 24 hours'],item.bars_available+' / '+item.expected_bars);
      assert.equal(rows['Missing 1m bars'],String(item.missing_bars));assert.equal(rows['Gap count'],String(item.gap_count));
      assert.equal(block.querySelectorAll('.pf3-list li').length,item.reasons.length);
      if(status==='PASS')assert.equal(rows['Reasons'],'None');
      if(status==='WARN'){
        assert.equal(rows['Reasons'],'The last 24 hours miss some 1m bars.');
        assert.equal(rows['Gap range'],utc(item.gaps[0].from_open_time)+' – '+utc(item.gaps[0].to_open_time)+' (3 min)');
      }
      if(status==='FAIL')assert.deepEqual([...block.querySelectorAll('.pf3-list li')].map(li=>li.textContent),
        ['The newest closed 1m bar is more than 15 minutes old.','The last 24 hours miss 60 or more 1m bars.']);
      assert.equal(p.root.querySelector('.pf3-chip').textContent,'Ready to start Paper collection','the verdict chip is the same with the item');
      assert.equal(p.root.querySelectorAll('button,input,select,textarea,a').length,0,'the item adds no control');
    }finally{p.w.close();}
  }
});

test('Market data section: unavailable and empty items, ordering between PF-1 and PF-2, and absence without the key',async()=>{
  for(const [name,reason,code] of [['UNAVAILABLE','Stored market data is not available on this server.','MARKET_DATA_UNAVAILABLE'],
    ['EMPTY','No closed 1m bar has been stored yet.',null]]){
    const p=setup({handler:answer(MARKET_REPORTS[name])});
    try{
      await p.open();
      const block=p.block('Market data'),rows=Object.fromEntries(marketRows(block));
      assert.ok(block.querySelector('.pf3-chip').classList.contains('pf3-bad'));
      assert.equal(rows['Reasons'],reason);assert.equal(rows['Latest closed 1m bar'],'—');assert.equal(rows['Data age (seconds)'],'—');
      assert.equal(rows['Bars in the last 24 hours'],'0 / 0');
      assert.equal(rows['Unavailable code'],code??undefined);
    }finally{p.w.close();}
  }
  const p=setup({handler:answer(MARKET_REPORTS.WARN)});
  try{
    await p.open();
    const titles=[...p.root.querySelectorAll('section.pf3-block > h3')].map(item=>item.textContent);
    const at=name=>titles.indexOf(name);
    assert.ok(at('Current state (PF-1)')>=0&&at('Market data')===at('Current state (PF-1)')+1&&at('Historical evidence (PF-2)')===at('Market data')+1,titles.join('|'));
  }finally{p.w.close();}
  const plain=setup({handler:answer(REPORTS.READY_TO_START_PAPER)});
  try{
    await plain.open();
    assert.equal(plain.block('Market data'),undefined,'no market_data key: no section');
    assert.ok(!plain.text().includes('Advisory only. Does not change'));
  }finally{plain.w.close();}
});

test('Market data section: an unknown status or reason shows its raw code; hostile values are text; at most 10 gap ranges',async()=>{
  const report=structuredClone(MARKET_REPORTS.WARN);
  report.market_data.status='SOMETHING_NEW';report.market_data.reasons=['A_NEW_REASON','MARKET_DATA_GAPS'];
  const p=setup({handler:answer(report)});
  try{
    await p.open();
    const block=p.block('Market data'),chip=block.querySelector('.pf3-chip');
    assert.equal(chip.textContent,'SOMETHING_NEW');assert.ok(chip.classList.contains('pf3-muted'));
    const items=[...block.querySelectorAll('.pf3-list li')];
    assert.equal(items[0].querySelector('code').textContent,'A_NEW_REASON');assert.equal(items[1].textContent,'The last 24 hours miss some 1m bars.');
  }finally{p.w.close();}
  const hostile=structuredClone(MARKET_REPORTS.WARN);
  hostile.market_data.unavailable_code='<img src=x onerror=alert(1)>';hostile.market_data.reasons=['<b onmouseover=bad()>x</b>'];
  hostile.market_data.gaps=Array.from({length:12},(_,index)=>({from_open_time:MARKET_LATEST-(index+2)*MINUTE,to_open_time:MARKET_LATEST-(index+2)*MINUTE,missing_minutes:'<u>1</u>'}));
  hostile.market_data.gaps_truncated=true;
  const q=setup({handler:answer(hostile)});
  try{
    await q.open();
    const block=q.block('Market data');
    assert.equal(block.querySelectorAll('img,b,u,script,iframe,a,svg').length,0);assert.equal(block.querySelector('[onerror],[onmouseover],[style]'),null);
    assert.ok(block.textContent.includes('<img src=x onerror=alert(1)>')&&block.textContent.includes('<b onmouseover=bad()>x</b>'));
    assert.equal(marketRows(block).filter(row=>row[0]==='Gap range').length,10,'at most 10 ranges are listed');
    assert.ok(block.textContent.includes('More gaps exist than are listed.'));
  }finally{q.w.close();}
  for(const value of ['nonsense',null,42]){
    const garbage=structuredClone(REPORTS.READY_TO_START_PAPER);garbage.market_data=value;
    const g=setup({handler:answer(garbage)});
    try{await g.open();assert.equal(g.block('Market data'),undefined,'only an object makes a section: '+value);assert.ok(g.root.querySelector('.pf3-verdict'));}finally{g.w.close();}
  }
  const malformed=structuredClone(REPORTS.READY_TO_START_PAPER);malformed.market_data={status:5,reasons:'x',gaps:{},latest_closed_bar:'bad'};
  const m=setup({handler:answer(malformed)});
  try{await m.open();assert.ok(m.block('Market data'),'a malformed item still renders');assert.ok(m.root.querySelector('.pf3-verdict'),'the other sections are untouched');}finally{m.w.close();}
});
