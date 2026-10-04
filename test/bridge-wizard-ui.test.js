import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {inspectSource} from '../src/pine-bridge/source.js';
import {reviewFields} from '../src/pine-bridge/input-review.js';

// P1-UX1: the guided Build Pine Bridge panel. The API is a stub; the real scripts, markup, i18n and styles run in JSDOM.
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const SOURCE='//@version=6\nindicator("Wizard fixture")\nsrc=input.source(close,"Source")\nlen=input.int(14,"Length",minval=1)\nmult=input.float(2.5,"Multiplier")\nflag=input.bool(true,"Flag")\nlabelText=input.string("abc","Label")\nbuy=close>open\nsell=close<open';
const ANALYSIS=inspectSource(SOURCE);
const BOTS=[{id:'bot-1',label:'Staging Bot'}];
const IDS=['pbAnalyze','pbBot','pbLoadBots','pbName','pbSource','pbInspect','pbInputReview','pbInputReviewStatus','pbSptCustom','pbInputFields','pbInputsConfirmed','pbAnalyzeButton','pbStatus','pbCancel','pbGenerate','pbBuy','pbExit','pbAtr','pbRR','pbBroker','pbSymbol','pbTimeframe','pbSlots','pbGenerateButton','pbDiagnostics','pbDownloads'];
const TITLES=['Choose Bot','Paste indicator','Review inputs','Analyze with AI','Configure Bridge and Generate','Install in TradingView'];
const GENERATED={integrated_pine:'//@version=6\nindicator("Draft")',webhook_setup:'GUIDE',bindings:[],fixed_inputs:{},source_hash:ANALYSIS.source_hash,instruction_versions:{},artifact_status:'DRAFT',bridge_capability:{status:'DRAFT'},quant_capability:{status:'UNSUPPORTED'},diagnostics:['draft diagnostics'],deployment_id:'dep-1'};
const analyzed=()=>({job_status:'SUCCEEDED',job_id:'job-analyze',pine_import_id:'src-1',source_version:1,result:{...ANALYSIS,proposal:{buy:'buy',exit:'sell',eligible_inputs:ANALYSIS.inputs.filter(i=>i.eligible).map(i=>i.input_id),diagnostics:['analysis diagnostics']}}});
const apiError=(code,message)=>Object.assign(new Error(message||'Request failed'),{code,status:400});

// A stub that answers like the server and records every request. Overrides map a path to a function(options, callNumber).
function makeApi(overrides={},bots=BOTS){
  const calls=[],counts={};
  const api=async(path,options)=>{
    calls.push({path,options});counts[path]=(counts[path]||0)+1;
    if(overrides[path])return overrides[path](options,counts[path]);
    if(path==='/api/bots')return {bots};
    if(path==='/api/quant/pine-bridge/deployments')return {bot_id:options?.botId,deployments:[]};
    if(path==='/api/quant/pine-bridge/inspect')return {source_hash:ANALYSIS.source_hash,input_count:ANALYSIS.inputs.length,inputs:reviewFields(ANALYSIS)};
    if(path==='/api/quant/pine-bridge/analyze')return {job_id:'job-analyze'};
    if(path==='/api/quant/pine-bridge/generate')return {job_id:'job-generate'};
    if(path==='/api/quant/pine-bridge/jobs/job-analyze')return analyzed();
    if(path==='/api/quant/pine-bridge/jobs/job-generate')return {job_status:'SUCCEEDED',job_id:'job-generate',result:GENERATED};
    throw new Error('Unexpected '+path);
  };
  return {api,calls,counts};
}

function setup({language,reduced=false,coarse=false,storage,seen,overrides,bots,journey=false,kit=true}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  if(seen)w.localStorage.setItem('pbCoachSeen',JSON.stringify(seen));
  if(storage==='blocked')Object.defineProperty(w,'localStorage',{get(){throw new Error('denied');}});
  w.eval(publicFile('i18n.js'));
  const stub=makeApi(overrides,bots),scrolls=[],errors=[],intervals=[];
  w.api=stub.api;
  w.matchMedia=query=>({matches:/reduce/.test(query)?reduced:/coarse/.test(query)?coarse:false,addEventListener(){},removeEventListener(){}});
  w.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push({id:this.id,options});};
  w.URL.createObjectURL=()=>'blob:fixture';w.URL.revokeObjectURL=()=>{};
  // Live job polling waits two seconds; the test shortens exactly that wait. Elapsed-clock ticks are driven by hand.
  const realTimeout=w.setTimeout.bind(w);
  w.setTimeout=(fn,ms,...rest)=>realTimeout(fn,ms===2000?10:ms,...rest);
  w.setInterval=fn=>{intervals.push(fn);return intervals.length;};w.clearInterval=()=>{};
  w.addEventListener('error',event=>errors.push(event.message));
  if(kit)w.eval(publicFile('bridge-wizard.js'));
  w.eval(publicFile('pine-bridge.js'));
  if(journey)w.eval(publicFile('journey.js'));
  const el=id=>d.getElementById(id),panel=el('pbPanel');
  const states=()=>[...d.querySelectorAll('.pbw-step')].map(card=>card.dataset.state);
  const open=()=>[...d.querySelectorAll('.pbw-step')].findIndex(card=>card.classList.contains('is-open'))+1;
  const coach=()=>{const node=el('pbwCoach');return node&&!node.hidden?node:null;};
  const until=async(check,label='condition',limit=3000)=>{const end=Date.now()+limit;while(!check()){if(Date.now()>end)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,5));}};
  const type=(node,value)=>{node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const submit=form=>form.dispatchEvent(new w.Event('submit',{cancelable:true}));
  const openPanel=async()=>{panel.open=true;await until(()=>stub.counts['/api/bots']>0,'bots requested');await until(()=>!panel.querySelector('#pbBot').disabled&&el('pbBot').options.length>0,'bots loaded');};
  // Drives the real panel up to the given current step.
  async function advance(target){
    await openPanel();
    if(target<=2)return;
    type(el('pbSource'),SOURCE);el('pbInspect').click();await until(()=>states()[2]==='current','inspected');
    if(target<=3)return;
    for(const field of el('pbInputFields').querySelectorAll('[data-manual-required]'))field.value='close';
    el('pbInputsConfirmed').click();await until(()=>states()[3]==='current','confirmed');
    if(target<=4)return;
    submit(el('pbAnalyze'));await until(()=>states()[4]==='current','analyzed');
    if(target<=5)return;
    submit(el('pbGenerate'));await until(()=>states()[5]==='current','generated');
  }
  return {dom,w,d,el,panel,calls:stub.calls,counts:stub.counts,scrolls,errors,intervals,states,open,coach,until,type,submit,openPanel,advance,close:()=>w.close()};
}

test('index.html loads the guided panel assets with their cache tokens, kit before panel',()=>{
  const html=publicFile('index.html');
  for(const part of ['/styles-v2.css?v=pa1','/i18n.js?v=mc3','/bridge-wizard.js?v=ux1a','/pine-bridge.js?v=pa1','/journey.js?v=pa1'])assert.ok(html.includes(part),part);
  // The Paper activation change touched these four files, so none may keep the token of the release before it.
  assert.doesNotMatch(html,/(styles-v2\.css|i18n\.js|pine-bridge\.js|journey\.js)\?v=(nw1|rj1|qr1a)["']/,'the activation change gave the files it touched a new cache version');
  const order=['/i18n.js?v=','/app.js?v=','/bridge-wizard.js?v=','/pine-bridge.js?v=','/readiness.js?v=','/journey.js?v='].map(part=>html.indexOf(part));
  assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'load order');
  assert.ok(!/bridge2/.test(html),'the old Bridge token is gone');
});

test('the panel is six stacked steps in fill order; only step 1 is current, the rest are locked and inert; every old id and the new defaults exist',()=>{
  const p=setup();
  try{
    assert.equal(p.panel.tagName,'DETAILS');assert.equal(p.panel.querySelector('summary').textContent,'Build Pine Bridge — draft preview');
    const cards=[...p.d.querySelectorAll('.pbw-step')];
    assert.deepEqual(cards.map(card=>card.querySelector('.pbw-title').textContent),TITLES);
    assert.deepEqual(cards.map(card=>card.querySelector('.pbw-num').textContent),['1','2','3','4','5','6']);
    assert.deepEqual(p.states(),['current','locked','locked','locked','locked','locked']);
    assert.equal(p.open(),1);assert.equal(p.d.querySelectorAll('.pbw-step.is-open').length,1);
    assert.deepEqual(cards.map(card=>card.querySelector('.pbw-chip').textContent),['Current','Locked','Locked','Locked','Locked','Locked']);
    cards.forEach((card,index)=>{
      assert.equal(card.querySelector('.pbw-collapse').hasAttribute('inert'),index!==0,'body '+(index+1));
      assert.equal(card.getAttribute('aria-disabled'),index===0?null:'true','card '+(index+1));
      assert.equal(card.getAttribute('aria-current'),index===0?'step':null);
    });
    for(const id of IDS)assert.ok(p.el(id),'missing id '+id);
    assert.equal(p.el('pbTimeframe').value,'1');
    assert.ok(p.el('pbTimeframe').closest('label').textContent.includes('1 = 1 minute'));
    assert.equal(p.el('pbSymbol').value,'BTCUSDT');assert.equal(p.el('pbAtr').value,'2.0');assert.equal(p.el('pbRR').value,'1.5');
    assert.equal(p.el('pbGenerate').hidden,true);assert.equal(p.el('pbAnalyzeButton').disabled,true);
    assert.equal(p.panel.querySelector('[style]'),null,'the CSP forbids inline styles');
  }finally{p.close();}
});

test('the report box, advanced slots, warnings and cost notes follow the owner spec',()=>{
  const p=setup();
  try{
    // The JSON box is a collapsed, hidden-until-filled report and says it is not Pine code.
    const report=p.el('pbReport');
    assert.equal(report.tagName,'DETAILS');assert.equal(report.open,false);assert.equal(report.hidden,true);
    assert.equal(report.querySelector('summary').textContent,'Analysis report (not Pine code)');assert.ok(report.contains(p.el('pbDiagnostics')));
    // Slots sit in a collapsed advanced block that says they do not change Pine.
    const advanced=p.el('pbSlots').closest('details');
    assert.equal(advanced.open,false);assert.match(advanced.querySelector('summary').textContent,/Advanced: Quant search slots \(optional, does not change Pine\)/);
    const warnings=[...p.el('pbwWarnings').querySelectorAll('li')].map(item=>item.textContent);
    assert.equal(warnings.length,2);
    assert.ok(warnings.some(text=>/Settle Risk settings before Generate; saving Risk later requires a new Generate/.test(text)));
    assert.ok(warnings.some(text=>/Each Generate creates a new deployment id; use the newest draft/.test(text)));
    assert.ok(!warnings.some(text=>/news/i.test(text)),'the news block is no longer a step to take: it is automatic and hidden');
    assert.ok(!/Block during news/.test(p.panel.textContent),'the wizard never mentions the hidden control');
    const notes=[...p.panel.querySelectorAll('.pbw-note')].filter(node=>node.textContent==="Each AI analysis or generation uses paid AI processing and counts toward your plan's limited quota.");
    assert.equal(notes.length,2,'Analyze and Generate each carry the neutral cost note');
    assert.ok(p.el('pbAnalyzeButton').closest('.pbw-pad').contains(notes[0])&&p.el('pbGenerateButton').closest('form').contains(notes[1]));
    assert.match(p.el('pbAtr').closest('label').textContent,/cost-to-stop in Risk manager → Order Preview/);
    assert.ok(!/\bUSD\b|\$\s*\d|dollar|usually under/i.test(p.panel.textContent),'no price or dollar estimate is promised');
  }finally{p.close();}
});

test('opening loads the Bots once, selects the single Bot, finishes step 1, moves focus and scroll to step 2 and shows one coach mark below the source box',async()=>{
  const p=setup();
  try{
    assert.equal(p.counts['/api/bots']||0,0,'nothing is requested before the panel opens');
    await p.openPanel();
    await p.until(()=>p.states()[1]==='current','step 2 current');
    assert.equal(p.counts['/api/bots'],1);assert.equal(p.el('pbBot').value,'bot-1');
    assert.deepEqual(p.states(),['done','current','locked','locked','locked','locked']);assert.equal(p.open(),2);
    assert.equal(p.d.querySelector('#pbStep1 .pbw-summary').textContent,'Bot: Staging Bot');assert.equal(p.d.querySelector('#pbStep1 .pbw-summary').hidden,false);
    assert.equal(p.d.querySelector('#pbStep1 .pbw-edit').hidden,false);assert.equal(p.d.querySelector('#pbStep1 .pbw-chip').textContent,'Done ✓');
    assert.equal(p.d.activeElement,p.el('pbSource'),'focus moves to the first control that needs the owner');
    const bubble=p.coach();
    assert.ok(bubble,'a coach mark is shown');
    assert.equal(bubble.previousElementSibling,p.el('pbSource').closest('label'),'anchored directly below the source box');
    assert.match(bubble.querySelector('.pbw-coach-text').textContent,/^Next: paste your Pine indicator here/);
    assert.equal(bubble.getAttribute('aria-live'),'polite');assert.equal(bubble.querySelector('button').textContent,'Got it');
    assert.equal(p.d.querySelectorAll('.pbw-coach').length,1,'one bubble is moved around');
    // The next step expands, the done step folds away, and the smooth scroll waits for the fold animation.
    await p.until(()=>p.scrolls.some(call=>call.id==='pbStep2'),'scroll to step 2');
    assert.deepEqual(JSON.parse(JSON.stringify(p.scrolls.find(item=>item.id==='pbStep2').options)),{behavior:'smooth',block:'start'});
    assert.equal(p.d.querySelector('#pbStep1 .pbw-collapse').hasAttribute('inert'),true);assert.equal(p.d.querySelector('#pbStep2 .pbw-collapse').hasAttribute('inert'),false);
    assert.equal(p.d.querySelector('#pbStep2').classList.contains('is-open'),true);
    // Closing and opening again does not load the Bots a second time.
    p.panel.open=false;await new Promise(resolve=>setTimeout(resolve,20));p.panel.open=true;await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(p.counts['/api/bots'],1);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('several Bots need an explicit choice: step 1 stays current with a coach mark on the Bot list until one is picked',async()=>{
  const p=setup({bots:[{id:'bot-1',label:'First'},{id:'bot-2',label:'Second'}]});
  try{
    await p.openPanel();await p.until(()=>p.coach(),'coach shown');
    assert.equal(p.d.activeElement,p.el('pbBot'),'the Bot list, not the Load button, takes the focus once the Bots are loaded');
    assert.equal(p.el('pbBot').value,'');assert.equal(p.el('pbBot').options[0].textContent,'Select a Bot');
    assert.deepEqual(p.states(),['current','locked','locked','locked','locked','locked']);
    assert.equal(p.coach().previousElementSibling,p.el('pbBot').closest('label'));assert.match(p.coach().textContent,/choose the Bot for this Bridge/);
    p.el('pbBot').value='bot-2';p.el('pbBot').dispatchEvent(new p.w.Event('change',{bubbles:true}));
    assert.deepEqual(p.states(),['done','current','locked','locked','locked','locked']);
    assert.equal(p.d.querySelector('#pbStep1 .pbw-summary').textContent,'Bot: Second');
    assert.equal(p.coach().previousElementSibling,p.el('pbSource').closest('label'),'the mark moves on to the next control');
    // Reloading the Bots keeps the Bot that is still in the list.
    p.el('pbLoadBots').click();await p.until(()=>p.counts['/api/bots']===2&&!p.el('pbBot').disabled);await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(p.el('pbBot').value,'bot-2');assert.deepEqual(p.states(),['done','current','locked','locked','locked','locked']);
  }finally{p.close();}
});

test('a coach mark dismisses with Got it and with interaction; a dismissed mark is remembered per mark in localStorage',async()=>{
  const p=setup();
  try{
    await p.openPanel();await p.until(()=>p.coach(),'coach shown');
    p.coach().querySelector('button').click();
    assert.equal(p.coach(),null,'Got it hides the mark');
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem('pbCoachSeen')),['source']);
    // Pasting fills the box: the next mark points at Inspect and the Inspect button pulses.
    p.type(p.el('pbSource'),SOURCE);
    assert.ok(p.coach(),'the mark for the next control appears');
    assert.equal(p.coach().previousElementSibling,p.el('pbInspect'));assert.match(p.coach().textContent,/Inspect inputs/);
    assert.equal(p.el('pbInspect').classList.contains('pbw-pulse'),true,'the next primary button pulses when it becomes ready');
    assert.equal(p.el('pbInspect').getAttribute('aria-disabled'),null);
    // Using the control is an interaction and dismisses the mark too.
    p.el('pbInspect').click();
    assert.equal(p.coach(),null);assert.deepEqual(JSON.parse(p.w.localStorage.getItem('pbCoachSeen')).sort(),['inspect','source']);
    await p.until(()=>p.states()[2]==='current','inspected');
    assert.match(p.coach().textContent,/tick this box/,'a fresh mark for the confirmation box');
    p.el('pbwTips').click();assert.deepEqual(JSON.parse(p.w.localStorage.getItem('pbCoachSeen')),[]);
  }finally{p.close();}
  const known=setup({seen:['source']});
  try{
    await known.openPanel();await known.until(()=>known.states()[1]==='current','step 2');
    assert.equal(known.coach(),null,'a remembered mark is not shown again');
    known.type(known.el('pbSource'),SOURCE);assert.ok(known.coach(),'marks that were not dismissed still appear');
  }finally{known.close();}
});

test('the panel works when localStorage is blocked: marks show and dismiss, nothing throws',async()=>{
  const p=setup({storage:'blocked'});
  try{
    await p.openPanel();await p.until(()=>p.coach(),'coach shown');
    p.coach().querySelector('button').click();assert.equal(p.coach(),null);
    p.type(p.el('pbSource'),SOURCE);assert.ok(p.coach());
    p.el('pbwTips').click();
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('the fields unlock in the real fill order with the right focus, hints and coach marks all the way to the download checklist',async()=>{
  // The first status check of the Analyze job waits for the gate, so the "submitting" phase can be observed.
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const p=setup({overrides:{'/api/quant/pine-bridge/jobs/job-analyze':async(options,n)=>{if(n===1){await gate;return {...analyzed(),job_status:'RUNNING'};}return analyzed();}}});
  try{
    const {el,d}=p;
    await p.openPanel();await p.until(()=>p.states()[1]==='current','step 2');
    // Step 2: nothing is ready until a source is pasted; the strategy hint follows the text.
    assert.equal(el('pbInspect').getAttribute('aria-disabled'),'true');
    p.type(el('pbSource'),'//@version=6\nstrategy("x")');assert.equal(el('pbStrategyHint').hidden,false);
    assert.match(el('pbStrategyHint').textContent,/Convert strategies to indicators first/);
    p.type(el('pbSource'),'//@version=6\n// strategy("only a comment")\nindicator("x")');assert.equal(el('pbStrategyHint').hidden,true);
    p.type(el('pbSource'),SOURCE);assert.equal(el('pbStrategyHint').hidden,true);
    // Inspect finishes step 2 and opens the review: focus on the first value, a hint per input type, coach mark on the confirmation box.
    el('pbInspect').click();await p.until(()=>p.states()[2]==='current','review');
    assert.deepEqual(p.states(),['done','done','current','locked','locked','locked']);
    assert.match(d.querySelector('#pbStep2 .pbw-summary').textContent,/^My indicator · \d+ characters · 5 inputs found$/);
    assert.equal(el('pbStatus').textContent,'Review the effective input values below. No AI request has been sent.');
    assert.equal(el('pbInputReview').hidden,false);assert.equal(d.activeElement,el('pbInputFields').querySelector('input,select'));
    const hintOf=type=>el('pbInputFields').querySelector('[data-input-type="'+type+'"]').closest('label').querySelector('.pbw-hint').textContent;
    assert.match(hintOf('source'),/TradingView: indicator Settings → Inputs → Source \(for example close\)/);
    assert.match(hintOf('int'),/Whole number/);assert.match(hintOf('float'),/Decimal number/);assert.match(hintOf('bool'),/On or Off/);assert.match(hintOf('string'),/Text exactly as shown/);
    assert.equal(p.coach().previousElementSibling,el('pbInputsConfirmed').closest('label'));assert.match(p.coach().textContent,/compare every value with TradingView, then tick this box/);
    // The source input has no default and must be filled by hand; Analyze stays locked until the box is ticked.
    assert.equal(el('pbAnalyzeButton').disabled,true);
    el('pbInputFields').querySelector('[data-input-type="source"]').value='close';
    el('pbInputsConfirmed').click();await p.until(()=>p.states()[3]==='current','confirmed');
    assert.deepEqual(p.states(),['done','done','done','current','locked','locked']);
    assert.equal(el('pbAnalyzeButton').disabled,false);assert.equal(d.activeElement,el('pbAnalyzeButton'));
    assert.equal(el('pbStatus').textContent,'','the status of the previous step does not follow the owner to the next one');
    assert.equal(el('pbAnalyzeButton').classList.contains('pbw-pulse'),true,'the next primary button pulses');
    assert.equal(p.coach().previousElementSibling,el('pbAnalyzeButton'));assert.equal(p.coach().textContent.startsWith("Next: click Analyze. It makes one AI call and counts toward your plan's limited quota."),true);assert.ok(!/USD/.test(p.coach().textContent));
    // Step 4: a live job shows an indeterminate bar, the plain phase, elapsed seconds and Cancel; then the Generate form opens.
    p.submit(el('pbAnalyze'));await p.until(()=>!el('pbwProgress').hidden,'progress');
    assert.equal(el('pbCancel').hidden,false);assert.equal(el('pbwProgress').querySelector('.pbw-bar').getAttribute('aria-hidden'),'true');
    assert.equal(el('pbwPhase').textContent,'Submitting…');
    const later=p.w.Date.now()+7000;p.w.Date.now=()=>later;p.intervals.at(-1)();
    assert.match(el('pbwElapsed').textContent,/^[67] s elapsed$/);
    release();await p.until(()=>el('pbwPhase').textContent==='The AI is reading your indicator','phase');
    assert.match(el('pbStatus').textContent,/^RUNNING/);
    await p.until(()=>p.states()[4]==='current','analysis done');
    assert.equal(el('pbwProgress').hidden,true);assert.equal(el('pbCancel').hidden,true);
    assert.deepEqual(p.states(),['done','done','done','done','current','locked']);
    assert.equal(el('pbGenerate').hidden,false);assert.equal(el('pbBuy').value,'buy');assert.equal(el('pbExit').value,'sell');assert.equal(d.activeElement,el('pbBuy'));assert.equal(el('pbStatus').textContent,'');
    assert.equal(el('pbReport').hidden,false);assert.equal(el('pbReport').open,false);assert.match(el('pbDiagnostics').textContent,/analysis diagnostics/);
    assert.equal(el('pbSlots').querySelectorAll('select').length,8);assert.equal(el('pbSlots').closest('details').open,false);
    assert.equal(p.coach().previousElementSibling,el('pbGenerateButton'));
    // Step 5 → 6: Generate opens the install step with the downloads and the ordered checklist.
    p.submit(el('pbGenerate'));await p.until(()=>p.states()[5]==='current','generated');
    assert.deepEqual(p.states(),['done','done','done','done','done','current']);assert.equal(d.activeElement,el('pbDownloads').querySelector('a'));
    assert.deepEqual([...el('pbDownloads').querySelectorAll('a')].map(a=>a.download),['bridge-draft.pine','setup-guide.txt','bindings.json']);
    const items=[...el('pbDownloads').querySelectorAll('ol.pbw-checklist li')].map(li=>li.textContent);
    assert.equal(items.length,6);
    assert.match(items[0],/REPLACE the whole script with bridge-draft\.pine\. Do not append it to the original indicator/);
    assert.match(items[1],/Save/);assert.match(items[2],/Add to chart/);assert.match(items[3],/values you reviewed/);
    assert.match(items[4],/setup-guide\.txt/);assert.match(items[4],/Bridge alert only/);assert.match(items[4],/do not use the alertcondition alerts of the original indicator/);
    assert.match(items[5],/Optional: create a staging capture URL/);
    assert.ok([...el('pbDownloads').querySelectorAll('button')].some(button=>button.textContent==='Create staging capture URL'));
    assert.match(p.coach().textContent,/replace the whole script in TradingView/);
    assert.equal(p.coach().previousElementSibling,el('pbDownloads').querySelector('.pbw-downloads'),'the mark sits below the group of download links, not between them');
    assert.ok(p.panel.querySelector('#pbStep6').contains(el('pbDownloads')));
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('editing an earlier step relocks the later steps with a short notice; Edit opens a done step and Back returns without relocking',async()=>{
  const p=setup();
  try{
    const {el,d}=p;
    await p.advance(5);
    assert.deepEqual(p.states(),['done','done','done','done','current','locked']);assert.equal(el('pbwNotice').hidden,true);
    // Edit is only a view change: nothing relocks, the current step folds away, Back returns to it.
    d.querySelector('#pbStep2 .pbw-edit').click();
    assert.equal(p.open(),2);assert.deepEqual(p.states(),['done','done','done','done','current','locked']);
    assert.equal(d.querySelector('#pbStep2 .pbw-back').hidden,false);assert.equal(d.activeElement,el('pbSource'));assert.equal(el('pbwNotice').hidden,true);
    d.querySelector('#pbStep2 .pbw-back').click();
    assert.equal(p.open(),5);assert.equal(d.querySelector('#pbStep2 .pbw-back').hidden,true);
    // A real edit of the source relocks steps 3 to 6 and tells the owner why.
    d.querySelector('#pbStep2 .pbw-edit').click();p.type(el('pbSource'),SOURCE+'\n// edited');
    assert.deepEqual(p.states(),['done','current','locked','locked','locked','locked']);assert.equal(p.open(),2);
    assert.equal(el('pbwNotice').hidden,false);assert.match(el('pbwNotice').textContent,/Changes require a new review/);
    assert.equal(el('pbGenerate').hidden,true);assert.equal(el('pbInputsConfirmed').checked,false);assert.equal(el('pbInputReview').hidden,true);
    assert.equal(el('pbReport').hidden,true);assert.equal(el('pbDiagnostics').textContent,'');
    // Going forward again removes the notice.
    el('pbInspect').click();await p.until(()=>p.states()[2]==='current','inspected again');assert.equal(el('pbwNotice').hidden,true);
    // Editing a reviewed value relocks Analyze.
    for(const field of el('pbInputFields').querySelectorAll('[data-manual-required]'))field.value='close';
    el('pbInputsConfirmed').click();await p.until(()=>p.states()[3]==='current','confirmed');
    const first=el('pbInputFields').querySelector('[data-input-type="int"]');first.value='20';first.dispatchEvent(new p.w.Event('input',{bubbles:true}));
    assert.deepEqual(p.states(),['done','done','current','locked','locked','locked']);assert.match(el('pbwNotice').textContent,/Changes require a new review/);
    assert.equal(el('pbAnalyzeButton').disabled,true);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('a Generate field changed after a draft makes the draft stale until the value is restored; the finished files stay on the page',async()=>{
  const p=setup();
  try{
    const {el}=p;
    await p.advance(6);
    const links=[...el('pbDownloads').querySelectorAll('a')];assert.equal(links.length,3);
    el('pbAtr').value='3.5';el('pbAtr').dispatchEvent(new p.w.Event('input',{bubbles:true}));
    assert.deepEqual(p.states(),['done','done','done','done','current','locked']);assert.match(el('pbwNotice').textContent,/Generate again to refresh the draft/);
    assert.equal(el('pbDownloads').querySelectorAll('a').length,3,'the download links are not thrown away');
    el('pbAtr').value='2.0';el('pbAtr').dispatchEvent(new p.w.Event('input',{bubbles:true}));
    assert.deepEqual(p.states(),['done','done','done','done','done','current'],'the same values give the same draft again');
    // A second Generate of changed values sends a new request and replaces the downloads.
    el('pbAtr').value='3.5';el('pbAtr').dispatchEvent(new p.w.Event('input',{bubbles:true}));
    p.submit(el('pbGenerate'));await p.until(()=>p.counts['/api/quant/pine-bridge/generate']===2&&p.states()[5]==='current','second draft');
    assert.equal(JSON.parse(p.calls.filter(call=>call.path==='/api/quant/pine-bridge/generate').at(-1).options.body).bridge_options.atr_multiplier,3.5);
  }finally{p.close();}
});

test('reduced motion: no pulse, instant scroll, the panel says so, and the coach marks are still shown',async()=>{
  const p=setup({reduced:true});
  try{
    assert.equal(p.panel.dataset.motion,'reduced');
    await p.openPanel();await p.until(()=>p.states()[1]==='current','step 2');
    assert.ok(p.coach(),'coach marks still appear');
    assert.ok(p.scrolls.some(call=>call.id==='pbStep2'),'the scroll is not delayed for an animation');
    assert.equal(JSON.parse(JSON.stringify(p.scrolls.find(call=>call.id==='pbStep2').options)).behavior,'auto');
    p.type(p.el('pbSource'),SOURCE);
    assert.equal(p.d.querySelectorAll('.pbw-pulse').length,0,'nothing pulses');assert.ok(p.coach());
    p.el('pbInspect').click();await p.until(()=>p.states()[2]==='current','review');
    for(const field of p.el('pbInputFields').querySelectorAll('[data-manual-required]'))field.value='close';
    p.el('pbInputsConfirmed').click();await p.until(()=>p.states()[3]==='current','confirmed');
    assert.equal(p.d.querySelectorAll('.pbw-pulse').length,0);assert.equal(p.d.activeElement,p.el('pbAnalyzeButton'),'focus still moves');
    assert.ok(p.coach());
    // The motion is on by default.
    const full=setup();try{assert.equal(full.panel.dataset.motion,'full');}finally{full.close();}
  }finally{p.close();}
});

test('on a touch screen the step title takes the focus instead of a text field, so no keyboard opens by itself',async()=>{
  const p=setup({coarse:true});
  try{
    await p.openPanel();await p.until(()=>p.states()[1]==='current','step 2');
    assert.equal(p.d.activeElement,p.d.getElementById('pbStep2Title'));assert.equal(p.d.getElementById('pbStep2Title').getAttribute('tabindex'),'-1');
    p.type(p.el('pbSource'),SOURCE);p.el('pbInspect').click();await p.until(()=>p.states()[2]==='current','review');
    assert.equal(p.d.activeElement,p.d.getElementById('pbStep3Title'));
    for(const field of p.el('pbInputFields').querySelectorAll('[data-manual-required]'))field.value='close';
    p.el('pbInputsConfirmed').click();await p.until(()=>p.states()[3]==='current','confirmed');
    assert.equal(p.d.activeElement,p.el('pbAnalyzeButton'),'a button is safe to focus');
  }finally{p.close();}
});

test('Enter in a text field never submits a form; logout clears the panel back to step 1',async()=>{
  const p=setup();
  try{
    await p.advance(5);
    for(const id of ['pbName','pbAtr','pbSymbol']){
      const event=new p.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});p.el(id).dispatchEvent(event);
      assert.equal(event.defaultPrevented,true,id+' Enter is blocked');
    }
    const box=new p.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});p.el('pbInputsConfirmed').dispatchEvent(box);assert.equal(box.defaultPrevented,false);
    p.el('logout').click();
    assert.equal(p.el('pbSource').value,'');assert.equal(p.el('pbDiagnostics').textContent,'');assert.equal(p.el('pbReport').hidden,true);assert.equal(p.el('pbGenerate').hidden,true);
    assert.deepEqual(p.states(),['current','locked','locked','locked','locked','locked']);assert.equal(p.open(),1);
    assert.ok(p.coach()===null||p.coach().previousElementSibling===p.el('pbLoadBots'),'only the first-step mark can be left');assert.equal(p.el('pbwNotice').hidden,true);assert.equal(p.el('pbDownloads').children.length,0);assert.equal(p.el('pbBot').options.length,0);
  }finally{p.close();}
});

test('a finished AI job that failed shows its code, a plain explanation and Try again, which starts a NEW job with a new idempotency key',async()=>{
  const failing=diagnostic=>async(options,n)=>n===1?{job_status:'FAILED',job_id:'job-analyze',diagnostic}:analyzed();
  const p=setup({overrides:{'/api/quant/pine-bridge/jobs/job-analyze':failing('INVALID_AI_OUTPUT')}});
  try{
    const {el}=p,analyzeCalls=()=>p.calls.filter(call=>call.path==='/api/quant/pine-bridge/analyze');
    await p.advance(4);
    p.submit(el('pbAnalyze'));await p.until(()=>!el('pbwFail').hidden,'failure card');
    assert.deepEqual(p.states(),['done','done','done','current','locked','locked']);
    assert.equal(el('pbwFailCode').textContent,'INVALID_AI_OUTPUT');
    assert.match(el('pbwFailWhy').textContent,/The AI answer did not pass the safety checks\. Trying again starts a new AI call/);
    assert.equal(el('pbwRetry').textContent,'Try again');assert.equal(el('pbwFail').getAttribute('role'),'alert');
    assert.ok(el('pbStep4').contains(el('pbwFail')),'the card sits in the step that caused it');
    assert.equal(el('pbwProgress').hidden,true);assert.equal(el('pbGenerate').hidden,true);
    el('pbwRetry').click();await p.until(()=>p.states()[4]==='current','second job');
    const keys=analyzeCalls().map(call=>call.options.headers['Idempotency-Key']);
    assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1],'a finished job keeps its key on the server, so the retry needs a new one');
    assert.equal(analyzeCalls()[0].options.body,analyzeCalls()[1].options.body,'the same request body');
    assert.equal(el('pbwFail').hidden,true);
  }finally{p.close();}
});

test('an AI_QUOTA_EXCEEDED answer shows its code and a plain explanation, in English and Thai',async()=>{
  const server='You reached the limit of 20 AI analyses per 24 hours on your FREE plan. Try again later.';
  for(const language of ['en','th']){
    const p=setup({language,overrides:{'/api/quant/pine-bridge/analyze':async()=>{throw apiError('AI_QUOTA_EXCEEDED',server);}}});
    try{
      const {el}=p;
      await p.advance(4);
      p.submit(el('pbAnalyze'));await p.until(()=>!el('pbwFail').hidden,'quota failure');
      assert.equal(el('pbwFailCode').textContent,'AI_QUOTA_EXCEEDED');
      assert.equal(el('pbwFailWhy').textContent,language==='en'?"Your plan's AI limit for the last 24 hours is used up. Try again later.":'โควตา AI ของแพ็กเกจคุณในรอบ 24 ชั่วโมงที่ผ่านมาใช้ครบแล้ว ลองใหม่อีกครั้งภายหลัง');
      assert.equal(el('pbStatus').textContent,server,'the server text stays visible next to the plain explanation');
      assert.equal(p.calls.filter(call=>call.path==='/api/quant/pine-bridge/analyze').length,1,'nothing retries by itself');
    }finally{p.close();}
  }
});

test('a request that never created a job is retried with the SAME idempotency key; a failed status check can be resumed',async()=>{
  const p=setup({overrides:{'/api/quant/pine-bridge/analyze':async(options,n)=>{if(n===1)throw apiError('AI_QUEUE_FULL','Queue is full');return {job_id:'job-analyze'};}}});
  try{
    const {el}=p,keysOf=path=>p.calls.filter(call=>call.path===path).map(call=>call.options.headers['Idempotency-Key']);
    await p.advance(4);
    p.submit(el('pbAnalyze'));await p.until(()=>!el('pbwFail').hidden,'request failure');
    assert.equal(el('pbwFailCode').textContent,'AI_QUEUE_FULL');assert.match(el('pbwFailWhy').textContent,/Too many AI jobs are waiting/);assert.equal(el('pbStatus').textContent,'Queue is full');
    el('pbwRetry').click();await p.until(()=>p.states()[4]==='current','after retry');
    const keys=keysOf('/api/quant/pine-bridge/analyze');assert.equal(keys.length,2);assert.equal(keys[0],keys[1],'no job exists yet, so the key is reused');
  }finally{p.close();}
  const q=setup({overrides:{'/api/quant/pine-bridge/jobs/job-analyze':async(options,n)=>{if(n===1)throw new TypeError('Failed to fetch');return analyzed();}}});
  try{
    await q.advance(4);
    q.submit(q.el('pbAnalyze'));await q.until(()=>!q.el('pbwFail').hidden,'status failure');
    assert.equal(q.el('pbwFailCode').textContent,'STATUS_CHECK_FAILED');assert.match(q.el('pbwFailWhy').textContent,/The job may still be running/);
    assert.match(q.el('pbStatus').textContent,/refresh status with the same job ID: job-analyze/);
    q.el('pbwRetry').click();await q.until(()=>q.states()[4]==='current','resumed');
    const keys=q.calls.filter(call=>call.path==='/api/quant/pine-bridge/analyze').map(call=>call.options.headers['Idempotency-Key']);assert.equal(keys[0],keys[1],'the same key returns the same job');
  }finally{q.close();}
});

test('a failed Generate shows its own code and retries Generate only; an unknown code is shown raw as text with the generic explanation',async()=>{
  const p=setup({overrides:{'/api/quant/pine-bridge/jobs/job-generate':async(options,n)=>n===1?{job_status:'TIMED_OUT',job_id:'job-generate',diagnostic:'JOB_DEADLINE_EXCEEDED'}:{job_status:'SUCCEEDED',result:GENERATED}}});
  try{
    const {el}=p;
    await p.advance(5);
    p.submit(el('pbGenerate'));await p.until(()=>!el('pbwFail').hidden,'generate failure');
    assert.deepEqual(p.states(),['done','done','done','done','current','locked']);assert.ok(el('pbStep5').contains(el('pbwFail')));
    assert.equal(el('pbwFailCode').textContent,'JOB_DEADLINE_EXCEEDED');assert.match(el('pbwFailWhy').textContent,/did not finish within five minutes/);
    el('pbwRetry').click();await p.until(()=>p.states()[5]==='current','generated after retry');
    assert.equal(p.counts['/api/quant/pine-bridge/generate'],2);assert.equal(p.counts['/api/quant/pine-bridge/analyze'],1,'Try again repeats the failed operation only');
  }finally{p.close();}
  const q=setup({overrides:{'/api/quant/pine-bridge/jobs/job-analyze':async()=>({job_status:'FAILED',job_id:'job-analyze',diagnostic:'<b>SOMETHING_NEW</b>'})}});
  try{
    await q.advance(4);q.submit(q.el('pbAnalyze'));await q.until(()=>!q.el('pbwFail').hidden,'unknown code');
    assert.equal(q.el('pbwFailCode').textContent,'<b>SOMETHING_NEW</b>');assert.equal(q.el('pbwFailCode').querySelector('b'),null,'shown as text');
    assert.equal(q.el('pbwFailWhy').textContent,'The job did not finish. Nothing was generated. Trying again starts a new AI call.');
  }finally{q.close();}
});

test('an Inspect failure is explained next to the pasted source, and the Bot, source and name gate Inspect',async()=>{
  const p=setup({overrides:{'/api/quant/pine-bridge/inspect':async(options,n)=>{if(n===1)throw apiError('INDICATOR_REQUIRED','INDICATOR_REQUIRED');throw apiError('SOMETHING_ELSE','Server says no');}}});
  try{
    const {el}=p;
    await p.openPanel();await p.until(()=>p.states()[1]==='current','step 2');
    el('pbInspect').click();assert.equal(el('pbStatus').textContent,'Select a Bot and paste a Pine indicator first.');assert.equal(p.counts['/api/quant/pine-bridge/inspect']||0,0);
    p.type(el('pbSource'),'//@version=6\nstrategy("x")');el('pbInspect').click();await p.until(()=>/strategy/.test(el('pbStatus').textContent),'explained');
    assert.equal(el('pbStatus').textContent,'This source is a strategy. Convert it to an indicator first.');
    assert.deepEqual(p.states(),['done','current','locked','locked','locked','locked'],'the failure keeps step 2 open');assert.ok(el('pbStep2').contains(el('pbStatus')));
    el('pbInspect').click();await p.until(()=>el('pbStatus').textContent==='Server says no','server text');
    // Emptying the name relocks the later steps (a required field must never be hidden while empty).
    const ok=setup();
    try{
      await ok.advance(4);ok.type(ok.el('pbName'),'  ');assert.deepEqual(ok.states(),['done','current','locked','locked','locked','locked']);
      ok.type(ok.el('pbName'),'Named');assert.deepEqual(ok.states(),['done','done','done','current','locked','locked']);
    }finally{ok.close();}
  }finally{p.close();}
});

test('the journey Open button reveals the current wizard step: panel opens, the current step scrolls into view and takes focus',async()=>{
  const p=setup({journey:true});
  try{
    const {d}=p,clicked=[];
    d.querySelectorAll('#primaryNav button').forEach(button=>button.addEventListener('click',()=>clicked.push(button.dataset.view)));
    d.querySelector('.jr-card[data-step="1"] button.jr-open').click();
    assert.deepEqual(clicked,['quant']);assert.equal(p.panel.open,true);
    assert.ok(p.scrolls.some(call=>call.id==='pbStep1'),'the current step is scrolled to, not the whole panel');assert.ok(!p.scrolls.some(call=>call.id==='pbPanel'));
    await p.until(()=>p.counts['/api/bots']>0&&p.states()[1]==='current','bots loaded');
    // Later, with the panel at step 3, Open lands on step 3.
    p.panel.open=false;p.scrolls.length=0;
    p.type(p.el('pbSource'),SOURCE);p.el('pbInspect').click();await p.until(()=>p.states()[2]==='current','review');
    d.querySelector('.jr-card[data-step="2"] button.jr-open').click();
    assert.ok(p.scrolls.some(call=>call.id==='pbStep3'),'step 2 of the journey also opens the panel at the current step');assert.equal(p.panel.open,true);
    // Steps that are not about the Bridge only switch the page.
    p.scrolls.length=0;clicked.length=0;d.querySelector('.jr-card[data-step="4"] button.jr-open').click();
    assert.deepEqual(clicked,['signals']);assert.equal(p.scrolls.length,0);
    await new Promise(resolve=>setTimeout(resolve,20));// a details toggle is fired by a timer; let it run before the window closes
  }finally{p.close();}
});

const placeholders=text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
// Literals of the two scripts that are shown to the owner: data-ui-label values and capitalized single-quoted texts.
function shownLiterals(){
  const found=new Set();
  for(const file of ['pine-bridge.js','bridge-wizard.js']){
    const source=publicFile(file);
    for(const match of source.matchAll(/data-ui-label="([^"]*)"/g))found.add(match[1]);
    for(const line of source.split('\n')){
      if(/^\s*(\/\/|\/\*)/.test(line))continue;
      for(const match of line.matchAll(/'((?:[^'\x5c]|\x5c.)*)'/g)){
        const text=match[1];
        if(/^[A-Z]/.test(text)&&/[a-z]{3}/.test(text)&&(text.includes(' ')||/^[A-Z][a-z]+$/.test(text)))found.add(text);
      }
    }
  }
  // Not owner texts: a key name, a preset value and the English slot label.
  for(const text of ['Enter','Custom','Slot '])found.delete(text);
  for(const text of found)if(text.startsWith('${'))found.delete(text);// the template helper that fills titles and help texts
  return found;
}

test('Thai pairs are complete, unique, collision-free and keep their placeholders; every shown text has Thai',()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.localStorage.setItem('robotLanguage','th');
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=bridgeWizardPairs;');
    const mine=[...w.__mine],others=w.__pairs.filter(pair=>!w.__mine.includes(pair));
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.ok(mine.length>100);assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){assert.notEqual(en,th);assert.deepEqual(placeholders(en),placeholders(th),'placeholders differ: '+en);}
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
    const sources=publicFile('pine-bridge.js')+publicFile('bridge-wizard.js');
    for(const text of english)assert.ok(sources.includes(text),'pair for a text that is no longer shown: '+text);
    const shown=shownLiterals();assert.ok(shown.size>100,'literal extraction found the static texts: '+shown.size);
    for(const text of shown)assert.notEqual(w.translate(text),text,'missing Thai: '+text);
  }finally{w.close();}
});

test('a full run in Thai: every text that reaches translate() has Thai, every label follows the language and English restores it',async()=>{
  const asked=new Set(),p=setup({language:'th'});
  try{
    const real=p.w.translate;p.w.translate=text=>{asked.add(text);return real(text);};
    const {el,d}=p;
    await p.advance(6);
    for(const node of d.querySelectorAll('#pbPanel [data-ui-label]'))assert.equal(node.textContent,real(node.dataset.uiLabel),node.dataset.uiLabel);
    assert.deepEqual([...d.querySelectorAll('.pbw-title')].map(node=>node.textContent),['เลือก Bot','วาง Indicator','ตรวจ Input','วิเคราะห์ด้วย AI','ตั้งค่า Bridge และสร้างฉบับร่าง','ติดตั้งใน TradingView']);
    assert.deepEqual([...d.querySelectorAll('.pbw-chip')].map(node=>node.textContent),['เสร็จแล้ว ✓','เสร็จแล้ว ✓','เสร็จแล้ว ✓','เสร็จแล้ว ✓','เสร็จแล้ว ✓','ปัจจุบัน']);
    assert.equal(d.querySelector('#pbStep1 .pbw-summary').textContent,'Bot ที่เลือก: Staging Bot');
    assert.match(d.querySelector('#pbStep2 .pbw-summary').textContent,/ตัวอักษร · พบ 5 Input/);
    assert.match(p.coach().textContent,/^ถัดไป: /);assert.equal(p.coach().querySelector('button').textContent,'เข้าใจแล้ว');
    assert.equal(el('pbSource').closest('label').querySelector('span').textContent,'Indicator ต้นฉบับ');
    assert.equal(el('pbwWarnings').querySelectorAll('li').length,2);
    assert.ok(![...el('pbwWarnings').querySelectorAll('li')].some(li=>/ระงับช่วงข่าว|news/i.test(li.textContent)));
    assert.ok([...d.querySelectorAll('#pbPanel .pbw-note')].some(node=>node.textContent==='การวิเคราะห์หรือ generate ด้วย AI แต่ละครั้งมีค่าใช้จ่าย และนับรวมในโควตาที่จำกัดของแพ็กเกจ'));
    assert.equal(el('pbReport').querySelector('summary').textContent,'รายงานการวิเคราะห์ (ไม่ใช่โค้ด Pine)');
    assert.match(el('pbDownloads').querySelector('ol li').textContent,/^เปิด Pine Editor/);assert.equal(el('pbDownloads').querySelector('a').textContent,'ดาวน์โหลด bridge-draft.pine');
    for(const text of asked)assert.notEqual(real(text),text,'a text of the run has no Thai: '+text);
    assert.ok(asked.size>30,'the run translated many texts: '+asked.size);
    const language=el('language');language.value='en';language.dispatchEvent(new p.w.Event('change'));
    assert.equal(d.querySelector('#pbStep1 .pbw-summary').textContent,'Bot: Staging Bot');assert.deepEqual([...d.querySelectorAll('.pbw-title')].map(node=>node.textContent),TITLES);
    assert.match(p.coach().textContent,/^Next: /);assert.equal(d.querySelector('#pbStep6 .pbw-chip').textContent,'Current');
  }finally{p.close();}
});

test('hostile API text is shown as text only: no element, attribute or handler is created from Bot, input, signal or diagnostic data',async()=>{
  const evil='<img src=x onerror=alert(1)>';
  const fields=reviewFields(ANALYSIS).map((field,index)=>index===1?{...field,input_title:'<svg onload=alert(1)>',pine_variable:'<b>x</b>'}:field);
  const hostile=()=>({job_status:'SUCCEEDED',job_id:'job-analyze',pine_import_id:'src-1',source_version:1,result:{...ANALYSIS,declarations:['<u>d</u>','buy','sell'],proposal:{buy:'<u>d</u>',exit:'sell',eligible_inputs:[],diagnostics:['<script>boom()</script>']}}});
  const p=setup({bots:[{id:'bot-1',label:evil}],overrides:{'/api/quant/pine-bridge/inspect':async()=>({source_hash:ANALYSIS.source_hash,input_count:fields.length,inputs:fields}),'/api/quant/pine-bridge/jobs/job-analyze':async()=>hostile()}});
  try{
    await p.advance(5);
    assert.equal(p.panel.querySelectorAll('img,svg,b,i,u,script,iframe').length,0);
    assert.equal(p.panel.querySelector('[onerror],[onload],[onclick],[style]'),null);
    assert.equal(p.d.querySelector('#pbStep1 .pbw-summary').textContent,'Bot: '+evil);
    assert.ok(p.el('pbInputFields').textContent.includes('<svg onload=alert(1)>'));assert.ok(p.el('pbDiagnostics').textContent.includes('<script>boom()</script>'));
    assert.equal(p.d.querySelector('#pbStep4 .pbw-summary').textContent,'Analysis ready: BUY <u>d</u>, EXIT sell');
  }finally{p.close();}
});

test('the scripts stay free of markup injection, inline styles and new endpoints; only the kit uses storage, guarded',()=>{
  const bridge=publicFile('pine-bridge.js'),kit=publicFile('bridge-wizard.js');
  for(const [name,source] of [['pine-bridge.js',bridge],['bridge-wizard.js',kit]]){
    for(const banned of ['outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket','.style.','sessionStorage','http://','https://','onclick='])
      assert.ok(!source.includes(banned),name+' must not contain '+banned);
    assert.ok(!/setAttribute\(.style./.test(source),name+' sets no style attribute');
  }
  assert.equal(bridge.split('innerHTML').length-1,1,'one static template and nothing else');assert.equal(kit.includes('innerHTML'),false);
  assert.equal(bridge.includes('localStorage'),false,'only the kit stores anything');assert.equal(kit.split('localStorage').length-1,2,'one read and one write, both inside try');
  assert.ok(/try\{const list=JSON\.parse\(localStorage/.test(kit)&&/try\{localStorage\.setItem/.test(kit));
  assert.deepEqual([...new Set([...bridge.matchAll(/'(\/api\/[^']*)'/g)].map(match=>match[1]))].sort(),['/api/bots','/api/quant/pine-bridge/','/api/quant/pine-bridge/captures/','/api/quant/pine-bridge/deployments','/api/quant/pine-bridge/deployments/','/api/quant/pine-bridge/inspect','/api/quant/pine-bridge/jobs/']);
});

test('without the kit the panel still works as plain stacked steps and shows the relock notice itself',async()=>{
  const p=setup({kit:false});
  try{
    const {el}=p;
    assert.equal(p.panel.classList.contains('pbw-on'),false);assert.equal(p.d.querySelectorAll('[inert]').length,0,'nothing is made inert without the kit');
    await p.openPanel();assert.equal(el('pbBot').value,'bot-1');
    p.type(el('pbSource'),SOURCE);el('pbInspect').click();await p.until(()=>!el('pbInputReview').hidden,'review shown');
    for(const field of el('pbInputFields').querySelectorAll('[data-manual-required]'))field.value='close';
    el('pbInputsConfirmed').click();assert.equal(el('pbAnalyzeButton').disabled,false);
    p.submit(el('pbAnalyze'));await p.until(()=>!el('pbGenerate').hidden,'analysis shown');
    assert.equal(p.coach(),null);assert.equal(el('pbwNotice').hidden,true);
    p.type(el('pbSource'),SOURCE+'\n// edited');
    assert.equal(el('pbwNotice').hidden,false);assert.match(el('pbwNotice').textContent,/Changes require a new review/);
    assert.equal(el('pbGenerate').hidden,true);assert.equal(p.d.querySelectorAll('[inert]').length,0);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('the styles move the steps with transitions that stop under reduced motion, wrap long text and fit a 375px phone',()=>{
  const css=publicFile('styles-v2.css'),at=css.indexOf('/* Guided Build Pine Bridge panel'),end=css.indexOf('/* Prototype journey');
  assert.ok(at>0&&end>at,'the block sits before the journey and PF-3 blocks, whose own style tests slice from their markers to the end');
  const block=css.slice(at,end);
  const rule=selector=>{const index=block.indexOf(selector+'{');assert.ok(index>=0,'missing rule '+selector);return block.slice(index,block.indexOf('}',index));};
  assert.ok(rule('#pbPanel.pbw-on .pbw-step.is-open .pbw-collapse').includes('grid-template-rows:1fr'),'the open step expands');
  assert.ok(/pbw-on \.pbw-collapse\{[^}]*grid-template-rows:0fr[^}]*transition:[^}]*\.18s/.test(block),'a step folds away in about 180 ms');
  assert.ok(/is-open \.pbw-collapse\{[^}]*transition:[^}]*\.26s ease-out/.test(block),'the next step slides and fades in over about 260 ms');
  assert.ok(/@keyframes pbw-pulse/.test(block)&&rule('#pbPanel .pbw-pulse').includes('ease-out 2'),'two pulse cycles');
  const reduced=block.slice(block.indexOf('@media(prefers-reduced-motion:reduce)'));
  assert.ok(reduced.startsWith('@media(prefers-reduced-motion:reduce){#pbPanel *')&&/animation:none!important;transition:none!important/.test(reduced.slice(0,260)),'no transitions or pulse under reduced motion');
  assert.ok(block.includes('#pbPanel[data-motion="reduced"] *'),'the script flag does the same');
  assert.ok(block.includes('@media(max-width:600px)'),'phone layout');
  for(const selector of ['#pbPanel .pbw-step','#pbPanel .pbw-pad','#pbPanel .pbw-title','#pbPanel select,#pbPanel input,#pbPanel textarea'])assert.ok(rule(selector).includes('min-width:0'),selector+' may shrink');
  for(const selector of ['#pbPanel .pbw-help,#pbPanel .pbw-summary','#pbPanel .pbw-note','#pbPanel .pbw-hint','#pbPanel .pbw-coach','#pbPanel .pbw-fail p','#pbPanel .pbw-checklist li'])assert.ok(rule(selector).includes('overflow-wrap:anywhere'),selector+' wraps long text');
  assert.ok(rule('#pbPanel .pbw-coach').includes('max-width:min(100%,'),'a coach mark never outgrows the screen');
  assert.ok(block.includes('#pbPanel .pbw-coach{max-width:100%}'),'full width on a phone');assert.ok(!block.includes('nowrap'));
  assert.ok(!/(^|[^-])width:\d{3,}px/.test(block)&&!/min-width:\d+px/.test(block),'no fixed width wider than a phone');
  assert.ok(block.includes('#pbPanel [hidden]{display:none!important}'),'hidden parts stay hidden although rules set a display');
  assert.ok(/#pbPanel \.pbw-step\[data-state="locked"\]\{[^}]*pointer-events:none/.test(block),'locked steps cannot be used');
  assert.ok(/#pbPanel button:disabled\{opacity:\.5/.test(block),'a disabled button looks disabled');
});

test('a code or input type that equals an inherited object key (constructor) gets the generic text, never a function',async()=>{
  const fields=reviewFields(ANALYSIS).map((field,index)=>index===0?{...field,type:'constructor'}:field);
  const p=setup({overrides:{'/api/quant/pine-bridge/inspect':async()=>({source_hash:ANALYSIS.source_hash,input_count:fields.length,inputs:fields}),
    '/api/quant/pine-bridge/jobs/job-analyze':async()=>({job_status:'FAILED',job_id:'job-analyze',diagnostic:'constructor'})}});
  try{
    const {el}=p;
    await p.advance(4);
    assert.equal(el('pbInputFields').querySelector('[data-input-type="constructor"]').closest('label').querySelector('.pbw-hint').textContent,'Copy the value exactly as TradingView shows it.');
    p.submit(el('pbAnalyze'));await p.until(()=>!el('pbwFail').hidden,'failure card');
    assert.equal(el('pbwFailCode').textContent,'constructor');
    assert.equal(el('pbwFailWhy').textContent,'The job did not finish. Nothing was generated. Trying again starts a new AI call.');
  }finally{p.close();}
});

test('the drafts list is read when the Bots load and again after Generate, so the new draft can be activated; the six steps do not depend on it',async()=>{
  const LIST='/api/quant/pine-bridge/deployments',failing=setup({overrides:{[LIST]:async()=>{throw apiError('PINE_BRIDGE_DISABLED','Disabled');}}});
  try{
    // A list that cannot be read changes nothing in the six steps: the only Bot is chosen, so step 2 is current, as without a list.
    await failing.openPanel();await failing.until(()=>/Code: PINE_BRIDGE_DISABLED/.test(failing.el('pbDeployStatus').textContent),'list failure shown');
    assert.deepEqual(failing.states(),['done','current','locked','locked','locked','locked']);assert.equal(failing.el('pbStatus').textContent,'');
  }finally{failing.close();}
  const p=setup();
  try{
    const reads=()=>p.calls.filter(call=>call.path===LIST);
    await p.advance(5);
    await p.until(()=>reads().length===1,'read once the Bots loaded');
    assert.equal(reads()[0].options.botId,'bot-1');
    p.submit(p.el('pbGenerate'));await p.until(()=>p.states()[5]==='current','generated');
    await p.until(()=>reads().length===2,'read again after Generate');
    assert.equal(p.calls.filter(call=>call.options?.method==='POST'&&/activate$/.test(call.path)).length,0,'generating never activates');
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});
