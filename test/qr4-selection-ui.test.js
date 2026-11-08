import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {D} from '../src/money.js';
import * as selection from '../src/selection/index.js';

const {buildRegistration,rankSelection,CODE_LIST,STATUSES:MODULE_STATUSES,OUTCOMES:MODULE_OUTCOMES,OBJECTIVE_REGISTRY,QR4_VERSIONS,EXPOSURE_SENTENCE,NO_SIGNIFICANCE_SENTENCE,NO_PROFIT_SENTENCE,
  NO_WINNER_TEXT,NO_QUALIFYING_TEXT,INADEQUATE_EVIDENCE_TEXT,DEVELOPMENT_PANEL_TEXT,OVERLAYS:MODULE_OVERLAYS,UNIVERSE_STATUSES,PARTICIPANT_RESULTS,FILTER_CODE_LIST}=selection;

// QR-4 slice Q4-C UI (contract 11.2, 12.1, 12.2, test plan 16.3 items 2 to 8). Everything below is a LABELLED TEST FIXTURE shaped like the answers of
// src/postgres/qr4-routes.js. The outcome bodies come from the real pure ranking function, so the label text and the fixed sentences are the real ones. The page
// contains no canned data and renders only what the stubbed api() returns. The Thai strings under test are a DRAFT for the owner review OD-S19.
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
const sha=text=>createHash('sha256').update(text).digest('hex');
const H=char=>char.repeat(64);
const MS=60000,DAY=86400000,T0=Date.UTC(2026,9,20,0,0,0);
const PATH='/api/quant/selections';
const OWNER='owner-a';
const SID='5b8f2c6e-0000-4000-8000-000000000001',SID2='5b8f2c6e-0000-4000-8000-000000000002',SID3='5b8f2c6e-0000-4000-8000-000000000003';
const EN_WINNER='Qualified recommendations: none. No qualified winner.';
const TH_WINNER='ผลที่ผ่านเกณฑ์และแนะนำได้: ไม่มี ยังไม่มีผลที่ผ่านเกณฑ์';
const SEEN=new Set();
const apiError=(code,status=409)=>Object.assign(new Error(code||'Request failed'),{code,status});
const unavailable=()=>Object.assign(new Error('Not found'),{status:404});

/* ---- the outcome comes from the real pure modules ---- */
const ENGINE=sha('engine'),POLICY=sha('policy'),DATASET=sha('window-dataset'),RULES_OBJECT={maximum_drawdown_percent:'25',minimum_closed_trades_test:10};
const canonicalText=value=>Array.isArray(value)?'['+value.map(canonicalText).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalText(value[k])).join(',')+'}':JSON.stringify(value);
const OBJECTIVE_ID=QR4_VERSIONS.objective;
const TEST_REGISTRY=(()=>{const registry=structuredClone(OBJECTIVE_REGISTRY);registry[OBJECTIVE_ID].tie_tolerances.return_pp='0.5';registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp='0.5';return registry;})();
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
const SCOPE={market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},
  cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},capital:{equity:'1000',cash:'1000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},
  valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const W={kind:'PROSPECTIVE',start_ms:T0+DAY,end_ms:T0+DAY+1000*MS,warmup_bars:200};
function member(i,over={}){
  const run='run-'+i,exp='exp-'+i,pkgHash=sha('pkg'+i);
  const binding={mode:'ONE_PINE',fixture:false,pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i,membership:[{pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:sha('lock'+i)};
  const range=(from,to)=>({start_ms:T0-from*DAY,end_ms:T0-to*DAY});
  return {kind:'RESEARCH_RUN',owner_id:OWNER,run_id:run,export_id:exp,created_at_ms:T0-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:sha('src'+i),market:{...SCOPE.market},
    qualification:{version:'library-qualification-v2',qualified:true,label:'QUALIFIED',gates:GATES.map(gate=>({gate,name:'N_'+gate,state:'PASS',code:null}))},integrity_checked:true,
    package:{export_id:exp,package_hash:pkgHash,status:'EXPORT_VALIDATED',binding,current:{...structuredClone(binding),dataset_available:true,bot_owner_id:OWNER},replay_mismatch:false},
    validation_records:[{run_id:run,mode:'ONE_PINE',record:{fixture:false,export_id:exp,package_hash:pkgHash,binding_hash:sha('bind'+i),validated_at_utc:'2026-10-18T10:00:00Z',
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:structuredClone(SCOPE.data_model),cost_model:structuredClone(SCOPE.cost_model),capital:structuredClone(SCOPE.capital),policy:structuredClone(SCOPE.policy),engine:ENGINE},
    library_class:'READY_FOR_REVIEW',rules_hash:sha(canonicalText(RULES_OBJECT)),rules:structuredClone(RULES_OBJECT),
    data_windows:{dataset:range(40,10),train:range(40,32),validation:range(32,26),holdout:range(26,10)},registered_boundary_ms:null,...over};
}
function registrationOf(n=3,{fixture=false}={}){
  const out=buildRegistration({owner_id:OWNER,selection_id:SID,registered_at_ms:T0,confirmed:true,fixture,scope:structuredClone(SCOPE),window:{...W},objective:{id:OBJECTIVE_ID},
    filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},admission_deadline_ms:W.end_ms+DAY,
    universe:Array.from({length:n},(_,k)=>{const m=member(k+1);if(fixture){m.package.binding.fixture=true;m.package.current.fixture=true;m.validation_records[0].record.fixture=true;}return m;})},
  {dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},exposure_register:[],searched_windows:[],universe_cap:20,requester_owner_id:OWNER,
    policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},prior_selection_ids:[],existing_registrations:[],objective_registry:TEST_REGISTRY,fixture_selections_allowed:fixture});
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.registration;
}
function evaluation(reg,i,v={}){
  const result={evaluation_bars:reg.window.evaluation_bars,metrics:{net_return_percent:v.net??'2',max_drawdown_percent:v.dd??'5',closed_trades:v.trades??9},episodes:v.episodes??8,
    rejected_intents:v.rejected??0,fees:'1.2',slippage:'0.4',exposure_percent:'35',cost_stress:{net_return_percent:v.stress??'1'},benchmark:{net_return_percent:v.bench??'0.1'}};
  return {run_id:'ev-'+i,parent_run_id:'run-'+i,selection_id:reg.selection_id,mode:'QR4_SELECTION_EVAL',status:'SUCCEEDED',integrity:{contract_hash_verified:true,report_matches_checkpoints:true},
    engine_hash:ENGINE,dataset_hash:DATASET,result,result_hash:selection.digest(result)};
}
const outcomeOf=(reg,list)=>{
  const out=rankSelection(reg,list.map((v,k)=>evaluation(reg,k+1,v)),{window_dataset_hash:DATASET});
  assert.equal(out.status,'SELECTION_COMPLETED',JSON.stringify(out).slice(0,300));
  return out;
};
/** The answer of the detail route (src/postgres/qr4-routes.js runDetail and outcomeView) for a stored outcome. */
function detailOf(reg,outcome,over={}){
  const {label,...rest}=outcome;
  return {ok:true,selection_id:reg.selection_id,status:'SELECTION_COMPLETED',code:null,seq:3,fixture:reg.fixture,internal_view:reg.fixture,
    registration:{registration_hash:reg.registration_hash,registration_key:reg.registration_key,registered_at_ms:reg.registered_at_ms,frozen_at_ms:reg.registered_at_ms,
      admission_deadline_ms:reg.admission_deadline_ms,window:reg.window,scope:reg.scope,objective:reg.objective,filters:reg.filters,prior_selection_count:reg.prior_selection_count,
      prior_selection_ids:reg.prior_selection_ids,participant_count:reg.participant_count,universe:reg.universe,
      participants:reg.participants.map(item=>({export_id:item.export_id,run_id:item.run_id,package_hash:item.package_hash,source_hash:item.source_hash,rules_hash:item.rules_hash,validation_binding:item.validation_binding}))},
    events:[{seq:1,event:'REGISTER',status:'SELECTION_REGISTERED',code:null,at_ms:T0},{seq:2,event:'FIRST_EVALUATION_START',status:'SELECTION_EVALUATING',code:null,at_ms:T0+1},
      {seq:3,event:'ALL_EVALUATIONS_DONE',status:'SELECTION_COMPLETED',code:null,at_ms:T0+2}],
    progress:{participants:reg.participant_count,started:reg.participant_count,window_frozen:true},metrics_visible:true,replay_mismatch:false,
    outcome:{...rest,outcome_hash:outcome.outcome_hash,created_at_ms:T0+5,label},overlays:[],label_visible:label!==null,hide_recommended_values:false,hide_package_links:false,...over};
}
/** A selection that has not completed. The hostile default carries an outcome the page must not show. */
function openDetailOf(reg,status,over={}){
  const base=detailOf(reg,outcomeOf(reg,[{net:'5'},{net:'4'},{net:'3'}]),{status,metrics_visible:false,label_visible:false});
  return {...base,status,code:null,progress:{participants:reg.participant_count,started:status==='SELECTION_REGISTERED'?0:1,window_frozen:status!=='SELECTION_REGISTERED'},
    events:[{seq:1,event:'REGISTER',status:'SELECTION_REGISTERED',code:null,at_ms:T0}],...over};
}
const REG=registrationOf(3);
const BEST=outcomeOf(REG,[{net:'5',dd:'4'},{net:'3',dd:'6'},{net:'1',dd:'9'}]);
const TIED=outcomeOf(REG,[{net:'5',dd:'4'},{net:'5.2',dd:'4.1'},{net:'1',dd:'9'}]);
const NONE=outcomeOf(REG,[{net:'-1'},{net:'-2'},{net:'-3'}]);
const INADEQUATE=outcomeOf(REG,[{episodes:2},{episodes:3},{episodes:1}]);

/* ---- the list and the preview ---- */
const listRow=(id,status,outcome=null,over={})=>({selection_id:id,fixture:false,internal_view:false,status,code:null,outcome,window:{kind:'PROSPECTIVE',start_ms:W.start_ms,end_ms:W.end_ms,evaluation_bars:1000,warmup_bars:200,total_bars:1200},
  participant_count:3,registered_at_ms:T0,frozen_at_ms:T0,frozen_at_utc:new Date(T0).toISOString(),admission_deadline_ms:W.end_ms+DAY,...over});
const countsOf=rows=>{
  const by_status=Object.fromEntries(MODULE_STATUSES.map(name=>[name,0])),by_outcome=Object.fromEntries(MODULE_OUTCOMES.map(name=>[name,0]));
  for(const row of rows){by_status[row.status]+=1;if(row.outcome)by_outcome[row.outcome]+=1;}
  return {by_status,by_outcome};
};
const listOf=(rows,over={})=>({ok:true,selections:rows,total:rows.length,truncated:false,counts:countsOf(rows),order:'CREATION',...over});
const memberScope=()=>({data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},
  capital:{equity:'1000',cash:'1000'},policy:{policy_version:'risk-v1',policy_hash:POLICY}});
const memberOf=(i,over={})=>({run_id:'run-'+i,export_id:'exp-'+i,created_at_ms:T0+i*MS,created_at_utc:new Date(T0+i*MS).toISOString(),kind:'RESEARCH_RUN',run_status:'SUCCEEDED',
  library_class:'READY_FOR_REVIEW',qualification_label:'QUALIFIED',package_status:'EXPORT_VALIDATED',eligible:true,status:'PARTICIPANT',code:null,detail:null,
  checks:{E1:'PASS',E2:'PASS',E3:'PASS',E4:'PASS',E5:'NOT_REACHED',E6:'PASS'},failures:[],mismatched_fields:[],scope:memberScope(),...over});
const excluded=(i,code,over={})=>memberOf(i,{eligible:false,status:'EXCLUDED',code,detail:'G8',checks:{E1:'FAIL',E2:'PASS',E3:'PASS',E4:'PASS',E5:'NOT_REACHED',E6:'PASS'},
  failures:[{check:'E1',code,detail:'G8'}],...over});
const previewOf=(members,over={})=>({ok:true,order:'CREATION',fixture:false,scope_declared:false,declared_scope:null,universe_cap:50,universe_count:members.length,
  participant_count:members.filter(item=>item.status==='PARTICIPANT').length,stale_count:members.filter(item=>item.status==='QUALIFIED_STALE').length,
  excluded_count:members.filter(item=>item.status==='EXCLUDED').length,min_participants:2,max_participants:4,registration_wired:true,members,...over});

const previewHandler=members=>(path,options)=>previewOf(members,{scope_declared:JSON.parse(options.body).scope!==undefined});
const router=(overrides={})=>(path,options)=>{
  const [route]=path.split('?');
  const key=(options?.method||'GET')+' '+route;
  if(Object.hasOwn(overrides,key)){const value=overrides[key];return typeof value==='function'?value(path,options):value;}
  if(key==='GET '+PATH)return listOf([listRow(SID,'SELECTION_COMPLETED','BEST_IN_SCOPE')]);
  if(key==='GET '+PATH+'/'+SID)return detailOf(REG,BEST);
  throw apiError('UNEXPECTED',500);
};

function setup({language,handler=router(),library=false}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=qr4SelectionPairs;window.__tr=uiTranslations;');
  const calls=[];
  w.api=async(path,options)=>{calls.push({path,options});return handler(path,options);};
  if(library)w.eval(publicFile('research-library.js'));
  w.eval(publicFile('qr4-selection.js'));
  const panel=d.getElementById('qr4Panel');
  const $=selector=>panel.querySelector(selector),$$=selector=>[...panel.querySelectorAll(selector)];
  const record=()=>{for(const root of [panel,d.getElementById('qrlPanel')])if(root)for(const element of root.querySelectorAll('[data-ui-label]'))SEEN.add(element.dataset.uiLabel);};
  const open=async()=>{panel.open=true;panel.dispatchEvent(new w.Event('toggle'));await settle();record();};
  const click=async element=>{element.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));await settle();record();};
  const view=async(id=SID)=>{const button=$$('.qr4-view-button').find(item=>item.dataset.id===id);assert.ok(button,'a View button for '+id);await click(button);};
  const text=element=>(element??panel).textContent.replace(/\s+/g,' ').trim();
  const posts=()=>calls.filter(call=>call.options?.method==='POST');
  const language_=async value=>{const select=d.getElementById('language');select.value=value;select.dispatchEvent(new w.Event('change',{bubbles:true}));await settle();record();};
  return {dom,w,d,panel,calls,$,$$,open,click,view,text,posts,record,language:language_,close:()=>w.close()};
}
// The value text of the row whose key text is `key` (the colon between them is drawn by the stylesheet, so it is not in the text).
const rowOf=(p,root,key)=>{const found=[...root.querySelectorAll('.qrl-ev > .qrl-k')].find(element=>element.textContent===key);return found?p.text(found.nextElementSibling):undefined;};
const after=(p,first,second)=>Boolean(first.compareDocumentPosition(second)&p.w.Node.DOCUMENT_POSITION_FOLLOWING);
const metricOf=(root,key)=>root.querySelector('.qr4-metric[data-metric='+key+']');

test('index.html loads the script after the QR-3 panel with its cache token; the panel is created closed on the Quant page and requests nothing',()=>{
  const html=publicFile('index.html');
  const order=['/i18n.js?v=','/app.js?v=','/research-library.js?v=','/qr3-comparison.js?v=qr3c2','/qr4-selection.js?v=qr4s2','/journey.js?v=jd2'].map(part=>html.indexOf(part));
  assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'the script loads after i18n.js, the library and the QR-3 panel, before journey.js');
  const p=setup();
  try{
    assert.ok(p.panel&&p.panel.tagName==='DETAILS'&&p.panel.open===false);
    assert.equal(p.panel.parentElement.getAttribute('data-page'),'quant');
    assert.equal(p.$('.qrl-summary').textContent,'Qualified selection');
    assert.equal(p.calls.length,0,'nothing is requested before the panel is opened');
    assert.equal(p.panel.querySelector('[style]'),null,'the CSP forbids inline styles');
    assert.equal(p.$('.qr4-tools').hidden,true);
  }finally{p.close();}
});

test('a 404 without a code is an honest unavailable state, never an error stack; the page makes one GET with no bot_id and reads in Thai too',async()=>{
  const p=setup({handler:()=>{throw unavailable();}});
  try{
    await p.open();
    assert.equal(p.calls.length,1);
    assert.equal(p.calls[0].path,PATH);
    assert.deepEqual({...p.calls[0].options},{silent:true,botId:''},'GET only, no bot_id, no toast');
    assert.equal(p.text(p.$('.qr4-status')),'Qualified selection is not available on this release.');
    assert.equal(p.$('.qr4-tools').hidden,true,'no form and no list are offered');
    assert.doesNotMatch(p.text(),/HTTP_404|Error|stack|undefined|NOT_FOUND/);
    assert.equal(p.$('.qr4-refresh').hidden,false);
  }finally{p.close();}
  const th=setup({language:'th',handler:()=>{throw unavailable();}});
  try{await th.open();assert.equal(th.text(th.$('.qr4-status')),'รุ่นนี้ยังไม่เปิดให้ใช้การคัดเลือกที่ผ่านเกณฑ์');}finally{th.close();}
  const schema=setup({handler:()=>{throw apiError('QR4_SCHEMA_ABSENT',503);}});
  try{await schema.open();assert.equal(schema.text(schema.$('.qr4-status')),'The selection tables are not installed on this release.');assert.equal(schema.$('.qr4-tools').hidden,true);}finally{schema.close();}
  let fail=true;
  const broken=setup({handler:path=>{if(fail)throw apiError(null,500);return router()(path);}});
  try{
    await broken.open();
    assert.match(broken.text(broken.$('.qr4-status')),/Not available.*HTTP_500/);assert.equal(broken.$('.qr4-refresh').hidden,false);
    fail=false;await broken.click(broken.$('.qr4-refresh'));
    assert.equal(broken.$('.qr4-tools').hidden,false,'Check again reads again');
  }finally{broken.close();}
});

test('the selection list: every selection in the order the server sends, counts for every outcome and every status (zero included), incomplete and cancelled ones listed, no metric',async()=>{
  const rows=[listRow(SID,'SELECTION_COMPLETED','BEST_IN_SCOPE'),listRow(SID2,'SELECTION_INCOMPLETE',null,{code:'QR4_ADMISSION_REFUSED'}),
    listRow(SID3,'SELECTION_CANCELLED'),listRow('5b8f2c6e-0000-4000-8000-000000000004','SELECTION_COMPLETED','NO_QUALIFYING_STRATEGY'),
    listRow('5b8f2c6e-0000-4000-8000-000000000005','SELECTION_COMPLETED','INADEQUATE_EVIDENCE',{fixture:true,internal_view:true}),listRow('5b8f2c6e-0000-4000-8000-000000000006','SELECTION_REGISTERED')];
  const p=setup({handler:router({['GET '+PATH]:listOf(rows)})});
  try{
    await p.open();
    assert.equal(p.$('.qr4-tools').hidden,false);
    const cards=p.$$('.qr4-selection');
    assert.deepEqual(cards.map(card=>card.dataset.selection),rows.map(row=>row.selection_id),'the order of the server, not a sort');
    const list=p.$('.qr4-list-box');
    assert.equal(rowOf(p,list,'Selections'),'6');
    const byOutcome=rowOf(p,list,'Counts by outcome'),byStatus=rowOf(p,list,'Counts by status');
    for(const name of MODULE_OUTCOMES)assert.ok(byOutcome.includes(': '+(name==='TIED_IN_SCOPE'?0:1)),name+' has a count in '+byOutcome);
    assert.ok(byOutcome.includes('Tie for first place within the selected scope: 0'),'a zero count is shown');
    assert.ok(byStatus.includes('Registered: 1')&&byStatus.includes('Evaluating: 0')&&byStatus.includes('Completed: 3')&&byStatus.includes('Incomplete: 1')&&byStatus.includes('Cancelled: 1'));
    assert.match(p.text(cards[1]),/Incomplete.*QR4_ADMISSION_REFUSED/);
    assert.match(p.text(cards[2]),/Cancelled/);
    assert.match(p.text(cards[4]),/Internal view/);
    assert.doesNotMatch(p.text(list),/Net return|drawdown|Buy & Hold/i,'a list row shows no metric of W');
    assert.equal(p.panel.querySelector('a[href]'),null);
    assert.deepEqual(p.calls.map(call=>call.path),[PATH]);
  }finally{p.close();}
});

test('the universe preview: POST /preview with an empty body, members in creation order with the first failing code, the exact holdout note and no rank or metric',async()=>{
  const members=[memberOf(1),excluded(2,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE'),memberOf(3,{status:'QUALIFIED_STALE',eligible:false,code:'QR4_PARTICIPANT_NOT_READY',detail:'STALE',
    checks:{E1:'PASS',E2:'FAIL',E3:'PASS',E4:'PASS',E5:'NOT_REACHED',E6:'PASS'},failures:[{check:'E2',code:'QR4_PARTICIPANT_NOT_READY',detail:'STALE'}]})];
  const p=setup({handler:router({['POST '+PATH+'/preview']:previewOf(members)})});
  try{
    await p.open();
    await p.click(p.$('.qr4-preview-run'));
    const sent=p.posts();
    assert.equal(sent.length,1);
    assert.equal(sent[0].path,PATH+'/preview');
    assert.equal(sent[0].options.body,'{}','no scope is declared yet');
    assert.deepEqual({...sent[0].options,body:undefined},{silent:true,botId:'',method:'POST',body:undefined});
    const box=p.$('.qr4-preview-box');
    assert.equal(p.text(p.$('.qr4-holdout-note')),'Their holdout periods differ. They are not compared here.');
    assert.deepEqual(p.$$('.qr4-member').map(card=>card.dataset.run),['run-1','run-2','run-3'],'creation order as sent');
    assert.equal(rowOf(p,box,'Runs in the universe'),'3');assert.equal(rowOf(p,box,'Participants'),'1');assert.equal(rowOf(p,box,'Excluded'),'1');
    assert.equal(rowOf(p,box,'Participants needed'),'2 to 4');
    const second=p.$$('.qr4-member')[1];
    assert.match(p.text(second),/Excluded/);
    assert.match(rowOf(p,second,'First failing code'),/Development scores cannot be ranked\. \(QR4_DEVELOPMENT_SCORE_NOT_RANKABLE\)/);
    assert.match(rowOf(p,second,'Checks'),/E1 Fail/);
    assert.match(p.text(p.$$('.qr4-member')[2]),/Qualified, package not fresh/);
    assert.match(p.text(box),/The scope check is not run until a scope is chosen\./);
    assert.doesNotMatch(p.text(box),/Net return|Maximum drawdown|Rank\b/i,'the preview shows no metric and no rank');
    assert.equal(p.panel.querySelector('a[href]'),null,'no package review view exists yet, so no link is built');
    assert.ok(p.calls.every(call=>!/bot_id/.test(call.path+String(call.options?.body))));
  }finally{p.close();}
});

test('Use this scope sends the member scope with every decimal in the canonical form of D(x).toFixed(), risk_percent included, and no bot_id',async()=>{
  const messy={data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.010',quantity_step:'001.000'},cost_model:{version:'paper-close-v1',fee_bps:'10.0',slippage_bps:'1.50',risk_percent:'01'},
    capital:{equity:'1000.00',cash:'0500.5'},policy:{policy_version:'risk-v1',policy_hash:POLICY}};
  const p=setup({handler:router({['POST '+PATH+'/preview']:previewOf([memberOf(1,{scope:messy}),memberOf(2,{scope:{...memberScope(),capital:{equity:null,cash:'1'}}})])})});
  try{
    await p.open();await p.click(p.$('.qr4-preview-run'));
    const buttons=p.$$('.qr4-use-scope');
    assert.deepEqual(buttons.map(item=>item.disabled),[false,true],'a scope with an unreadable value cannot be declared');
    await p.click(buttons[0]);
    const sent=p.posts();
    assert.equal(sent.length,2);
    const body=JSON.parse(sent[1].options.body);
    const canon=value=>D(value).toFixed();
    assert.deepEqual(body,{scope:{market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},
      data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:canon('0.010'),quantity_step:canon('001.000')},
      cost_model:{version:'paper-close-v1',fee_bps:canon('10.0'),slippage_bps:canon('1.50'),risk_percent:canon('01')},capital:{equity:canon('1000.00'),cash:canon('0500.5')},
      policy:{policy_version:'risk-v1',policy_hash:POLICY}}});
    assert.deepEqual([body.scope.data_model.price_tick,body.scope.data_model.quantity_step,body.scope.cost_model.fee_bps,body.scope.cost_model.slippage_bps,body.scope.cost_model.risk_percent,
      body.scope.capital.equity,body.scope.capital.cash],['0.01','1','10','1.5','1','1000','500.5']);
    assert.match(p.text(p.$('.qr4-declared')),/Declared scope/);
    assert.equal(sent.some(call=>/bot/i.test(String(call.options.body))),false,'no request body names a Bot');
    await p.click(p.$('.qr4-clear-scope'));
    assert.equal(p.posts().at(-1).options.body,'{}','clearing the scope previews without one');
  }finally{p.close();}
});

test('register: the form needs a chosen scope, a readable window and the confirm token; the body carries exactly the fields of the route and no tolerance or registry',async()=>{
  let registered=0;
  const p=setup({handler:router({['POST '+PATH+'/preview']:previewHandler([memberOf(1),memberOf(2),memberOf(3)]),
    ['POST '+PATH]:()=>{registered+=1;return {ok:true,existing:false,selection_id:SID,status:'SELECTION_REGISTERED',registration_hash:H('r'),evaluation_started:false};},
    ['GET '+PATH+'/'+SID]:openDetailOf(REG,'SELECTION_REGISTERED')})});
  try{
    await p.open();
    const form=p.$('.qr4-create'),submit=async()=>{form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await settle();p.record();};
    const field=name=>form.querySelector('[name='+name+']');
    await submit();
    assert.match(p.text(form),/Choose a scope in the universe preview first\./);
    assert.equal(p.posts().length,0,'nothing is sent without a scope');
    await p.click(p.$('.qr4-preview-run'));await p.click(p.$('.qr4-use-scope'));
    await submit();
    assert.match(p.text(p.$('.qr4-register-message')),/Enter the window start and end as YYYY-MM-DD HH:MM in UTC\./);
    const typed=()=>form.dispatchEvent(new p.w.Event('input',{bubbles:true}));
    field('window_begin').value='2026-12-01 00:00';field('window_end').value='2026-12-01 16:40';field('warmup_bars').value='200';
    field('window_end').value='2026-11-30 16:40';typed();await submit();
    assert.match(p.text(p.$('.qr4-register-message')),/The window end must be after the window start\./);
    field('window_end').value='2026-12-01 16:40';field('warmup_bars').value='x';typed();await submit();
    assert.match(p.text(p.$('.qr4-register-message')),/Enter the warm-up bars as a whole number\./);
    field('warmup_bars').value='200';typed();await submit();
    assert.match(p.text(p.$('.qr4-register-message')),/Confirm the registration before you create it\./);
    const before=p.posts().length;
    // the review block shows W, the bars, the objective, the filters, the tolerance note, the universe, the participants, the compute budget and the exposure warning
    const review=p.text(p.$('.qr4-review'));
    for(const part of ['2026-12-01 00:00:00 UTC → 2026-12-01 16:40:00 UTC','1000','1200',OBJECTIVE_ID,'Set by the server. They are not part of the request.','3 evaluation runs of 1200 bars',
      'It becomes development evidence as soon as the first evaluation starts.'])assert.ok(review.includes(part),part+' in '+review);
    form.querySelector('[name=confirmed]').checked=true;
    form.querySelector('[name=beats_buy_and_hold]').checked=true;field('drawdown_limit_percent').value='20.0';typed();
    await submit();
    assert.equal(registered,1);
    assert.equal(p.posts().length,before+1);
    const body=JSON.parse(p.posts().find(call=>call.path===PATH).options.body);
    assert.deepEqual(Object.keys(body).sort(),['confirmed','filters','objective','scope','window']);
    assert.equal(body.confirmed,true);
    assert.deepEqual(body.window,{kind:'PROSPECTIVE',start_ms:Date.UTC(2026,11,1,0,0),end_ms:Date.UTC(2026,11,1,16,40),warmup_bars:200});
    assert.deepEqual(body.objective,{id:OBJECTIVE_ID});
    assert.deepEqual(body.filters,{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:true});
    assert.deepEqual(Object.keys(body.scope).sort(),['capital','cost_model','data_model','market','policy']);
    assert.equal(JSON.stringify(body).match(/toler|registry|bot|engine|valuation|admission/i),null);
    assert.equal(p.calls.at(-1).path,PATH+'/'+SID,'the new selection opens');
    assert.match(p.text(p.$('.qr4-register-message')),/Selection registered\. No evaluation has started\./);
  }finally{p.close();}
});

test('a refused registration shows the translated meaning and the raw code; the first refusals of the production release read in both languages',async()=>{
  for(const [language,expected] of [[undefined,'Selection evaluation is not available on this release.'],['th','รุ่นนี้ยังไม่เปิดให้ประเมินการคัดเลือก']]){
    const p=setup({language,handler:router({['POST '+PATH+'/preview']:previewOf([memberOf(1),memberOf(2)]),['POST '+PATH]:()=>{throw apiError('QR4_EVALUATION_MODE_UNAVAILABLE',409);}})});
    try{
      await p.open();await p.click(p.$('.qr4-preview-run'));await p.click(p.$('.qr4-use-scope'));
      const form=p.$('.qr4-create');
      form.querySelector('[name=window_begin]').value='2026-12-01 00:00';form.querySelector('[name=window_end]').value='2026-12-01 16:40';form.querySelector('[name=confirmed]').checked=true;
      form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await settle();p.record();
      const message=p.text(p.$('.qr4-register-message'));
      assert.ok(message.includes(expected)&&message.includes('QR4_EVALUATION_MODE_UNAVAILABLE'),message);
    }finally{p.close();}
  }
});

test('detail of a registered or evaluating selection shows progress counts only, even when the answer carries an outcome (16.3 item 3)',async()=>{
  for(const status of ['SELECTION_REGISTERED','SELECTION_EVALUATING']){
    const p=setup({handler:router({['GET '+PATH+'/'+SID]:openDetailOf(REG,status)})});
    try{
      await p.open();await p.view();
      const box=p.$('.qr4-view');
      assert.equal(box.hidden,false);
      assert.equal(box.querySelectorAll('.qr4-metric').length,0,'no metric row');
      assert.equal(box.querySelector('.qr4-label-text, .qr4-label-block, .qr4-passing, .qr4-values'),null);
      assert.match(p.text(box),/Results appear only after the selection is complete\./);
      assert.equal(rowOf(p,box,'Participants'),'3');
      assert.equal(rowOf(p,box,'Evaluations started'),status==='SELECTION_REGISTERED'?'0':'1');
      const shown=p.text(box);
      for(const secret of [BEST.outcome_hash,'Best of 3','Net return'])assert.equal(shown.includes(secret),false,secret);
    }finally{p.close();}
  }
});

test('an incomplete and a cancelled selection show their ending code and no metric; nothing offers cancel on a terminal selection',async()=>{
  for(const [status,code] of [['SELECTION_INCOMPLETE','QR4_WINDOW_DATA_GAP'],['SELECTION_CANCELLED',null]]){
    const p=setup({handler:router({['GET '+PATH+'/'+SID]:openDetailOf(REG,status,{code})})});
    try{
      await p.open();await p.view();
      const box=p.$('.qr4-view');
      assert.equal(box.querySelectorAll('.qr4-metric').length,0);
      if(code)assert.match(p.text(box.querySelector('.qr4-ending')),/The data of the window has a gap\. \(QR4_WINDOW_DATA_GAP\)/);
      assert.equal(box.querySelector('.qr4-ask'),null,'no cancel and no replay on a terminal selection');
    }finally{p.close();}
  }
});

test('a completed selection: the label text is the exact server text; the scope statement and the three fixed sentences sit in the same block (16.3 items 4 and 7)',async()=>{
  const p=setup();
  try{
    await p.open();await p.view();
    const block=p.$('.qr4-label-block');
    assert.ok(block);
    assert.equal(BEST.label.label_text,'Best of 3 compared strategies within the selected scope');
    const labelElement=block.querySelector('.qr4-label-text');
    assert.equal(labelElement.textContent,BEST.label.label_text,'exactly the server text');
    assert.ok(labelElement.classList.contains('no-i18n'),'the language switch cannot touch it');
    assert.ok(block.querySelector('.qr4-scope'),'the scope statement is inside the label block');
    assert.equal(p.text(block.querySelector('.qr4-exposure')),EXPOSURE_SENTENCE);
    assert.equal(p.text(block.querySelector('.qr4-no-significance')),NO_SIGNIFICANCE_SENTENCE);
    assert.equal(p.text(block.querySelector('.qr4-no-profit')),NO_PROFIT_SENTENCE);
    assert.ok(after(p,labelElement,block.querySelector('.qr4-scope')),'label first, then its scope');
    const scope=block.querySelector('.qr4-scope');
    assert.equal(rowOf(p,scope,'Asset'),'binance-global:BTCUSDT 1m');
    assert.equal(rowOf(p,scope,'Window (UTC)'),new Date(W.start_ms).toISOString()+' → '+new Date(W.end_ms).toISOString());
    assert.equal(rowOf(p,scope,'Evaluation bars'),'1000');assert.equal(rowOf(p,scope,'Warm-up bars'),'200');assert.equal(rowOf(p,scope,'Total bars'),'1200');
    assert.equal(rowOf(p,scope,'Risk profile'),'risk-v1');
    assert.equal(rowOf(p,scope,'Coverage'),'3 participants of 3 runs, 1000 evaluation bars each');
    assert.equal(rowOf(p,scope,'Objective'),OBJECTIVE_ID);
    assert.equal(rowOf(p,scope,'Tie tolerance: net return (percentage points)'),'0.5');
    assert.equal(rowOf(p,scope,'Selections before this one'),'0');
    assert.match(rowOf(p,scope,'Cost model'),/fee_bps=10, slippage_bps=1, risk_percent=1/);
    // the label is not composed: another server text is shown as sent
    const other=detailOf(REG,BEST);other.outcome.label={...BEST.label,label_text:'Server text 42'};
    const q=setup({handler:router({['GET '+PATH+'/'+SID]:other})});
    try{await q.open();await q.view();assert.equal(q.$('.qr4-label-text').textContent,'Server text 42');assert.equal(q.$('.qr4-label-translation'),null);}finally{q.close();}
  }finally{p.close();}
});

test('the fixed texts equal the modules that own them; the texts of an outcome without a label are the module texts',async()=>{
  assert.equal(EXPOSURE_SENTENCE,'This selection used the period W. That period is now development evidence. A claim about another period needs new independent data.');
  assert.equal(NO_SIGNIFICANCE_SENTENCE,'No statistical significance is claimed.');
  assert.equal(NO_PROFIT_SENTENCE,'This is not a profitability claim or a forecast.');
  assert.equal(NO_WINNER_TEXT,EN_WINNER);
  assert.equal(DEVELOPMENT_PANEL_TEXT,'Development scores, not a ranking.');
  for(const [outcome,expected] of [[NONE,NO_QUALIFYING_TEXT],[INADEQUATE,INADEQUATE_EVIDENCE_TEXT]]){
    const p=setup({handler:router({['GET '+PATH+'/'+SID]:detailOf(REG,outcome)})});
    try{
      await p.open();await p.view();
      const box=p.$('.qr4-view');
      assert.equal(box.querySelector('.qr4-label-block'),null,'no label for '+outcome.outcome);
      assert.equal(p.text(box.querySelector('.qr4-outcome-sentence')),expected);
      assert.equal(p.text(box.querySelector('.qr4-no-winner')),EN_WINNER);
      assert.equal(p.text(box.querySelector('.qr4-exposure')),EXPOSURE_SENTENCE);
      assert.equal(p.text(box.querySelector('.qr4-no-profit')),NO_PROFIT_SENTENCE);
      assert.equal(box.querySelector('.qr4-passing'),null,'nothing passed');
      assert.ok(box.querySelector('.qr4-not-passed')&&box.querySelector('.qr4-values'));
    }finally{p.close();}
  }
});

test('the passing list, the non-passing list and the values of every participant on W follow the order of the server; a null value is an em dash',async()=>{
  const p=setup({handler:router({['GET '+PATH+'/'+SID]:detailOf(REG,BEST)})});
  try{
    await p.open();await p.view();
    const passing=p.$('.qr4-passing');
    const rows=[...passing.querySelectorAll('tbody tr')];
    assert.deepEqual(rows.map(item=>item.children[0].textContent),BEST.ranking.map(item=>String(item.rank)));
    assert.deepEqual(rows.map(item=>item.children[1].textContent),BEST.ranking.map(item=>item.export_id.slice(0,8)),'the ranks come from the server order');
    assert.equal(rows[0].children[3].textContent,BEST.ranking[0].net_return_percent);
    assert.match(rows[0].children[5].textContent,/Net return decided/);
    const mixed=structuredClone(BEST);mixed.not_passed=[{export_id:'exp-9',run_id:'run-9',evaluation_run_id:'ev-9',result:'NOT_QUALIFYING_IN_SCOPE',filter_codes:['FILTER_DRAWDOWN_LIMIT','FILTER_NET_RETURN_POSITIVE']},
      {export_id:'exp-8',run_id:'run-8',evaluation_run_id:'ev-8',result:'EVIDENCE_INADEQUATE',filter_codes:['FILTER_EPISODE_FLOOR']}];
    const q=setup({handler:router({['GET '+PATH+'/'+SID]:detailOf(REG,mixed)})});
    try{
      await q.open();await q.view();
      const failed=[...q.$('.qr4-not-passed').querySelectorAll('tbody tr')];
      assert.deepEqual(failed.map(item=>item.children[0].textContent),['exp-9','exp-8'],'the order of the server');
      assert.match(failed[0].textContent,/Did not qualify within the scope.*Drawdown above the limit \(FILTER_DRAWDOWN_LIMIT\).*Net return not above zero \(FILTER_NET_RETURN_POSITIVE\)/);
      assert.match(failed[1].textContent,/Evidence not adequate.*Too few completed episodes \(FILTER_EPISODE_FLOOR\)/);
    }finally{q.close();}
    const cards=p.$$('.qr4-evaluation');
    assert.deepEqual(cards.map(card=>card.dataset.participant),BEST.evaluations.map(item=>item.export_id),'the server order, not a sort by return');
    const first=cards[0],values=BEST.evaluations[0].values;
    for(const [key,expected] of [['net_return_percent',values.net_return_percent],['benchmark_net_return_percent',values.benchmark_net_return_percent],['max_drawdown_percent',values.max_drawdown_percent],
      ['episodes',String(values.episodes)],['closed_trades',String(values.closed_trades)],['rejected_intents',String(values.rejected_intents)],['fees',values.fees],['slippage',values.slippage],
      ['exposure_percent',values.exposure_percent],['cost_stress_net_return_percent',values.cost_stress_net_return_percent],['evaluation_bars',String(values.evaluation_bars)]])
      assert.equal(p.text(metricOf(first,key).querySelector('.qrl-v')),expected,key);
    assert.equal(rowOf(p,first,'Result hash'),BEST.evaluations[0].result_hash);
    assert.equal(rowOf(p,first,'Exact replay disabled'),'—','the flag is shown only when the answer carries it');
    const hashes=p.$('.qr4-hashes');
    assert.equal(rowOf(p,hashes,'Registration hash'),REG.registration_hash);assert.equal(rowOf(p,hashes,'Outcome hash'),BEST.outcome_hash);assert.equal(rowOf(p,hashes,'Window dataset hash'),DATASET);
    // a null value is an em dash and is marked, never 0; the flag shows when sent
    const hidden=structuredClone(detailOf(REG,BEST));hidden.outcome.evaluations[0].values.net_return_percent=null;hidden.outcome.evaluations[0].exact_replay_disabled=true;hidden.outcome.evaluations[1].exact_replay_disabled=false;
    const r=setup({handler:router({['GET '+PATH+'/'+SID]:hidden})});
    try{
      await r.open();await r.view();
      const card=r.$$('.qr4-evaluation')[0],metric=metricOf(card,'net_return_percent');
      assert.equal(r.text(metric.querySelector('.qrl-v')),'—');assert.equal(metric.dataset.null,'true');
      assert.equal(rowOf(r,card,'Exact replay disabled'),'Yes');assert.equal(rowOf(r,r.$$('.qr4-evaluation')[1],'Exact replay disabled'),'No');
    }finally{r.close();}
  }finally{p.close();}
});

test('a tie shows the tied label text exactly; a Thai reader sees the exact server text and a translation of the fixed template beside it',async()=>{
  assert.equal(TIED.label.label_text,'Tied for best of 3 compared strategies within the selected scope');
  const en=setup({handler:router({['GET '+PATH+'/'+SID]:detailOf(REG,TIED)})});
  try{await en.open();await en.view();assert.equal(en.$('.qr4-label-text').textContent,TIED.label.label_text);assert.equal(en.$('.qr4-label-translation'),null,'no translation in English');}finally{en.close();}
  const th=setup({language:'th',handler:router({['GET '+PATH+'/'+SID]:detailOf(REG,BEST)})});
  try{
    await th.open();await th.view();
    assert.equal(th.$('.qr4-label-text').textContent,BEST.label.label_text,'the server text stays exact in Thai');
    assert.equal(th.text(th.$('.qr4-label-translation')),'ดีที่สุดจาก 3 กลยุทธ์ที่นำมาเปรียบเทียบ ภายในขอบเขตที่เลือก');
    assert.ok(th.text(th.$('.qr4-exposure')).includes('ช่วงเวลา W'));
    assert.ok(th.text(th.$('.qr4-no-significance')).includes('ไม่มีการอ้างความมีนัยสำคัญทางสถิติ'));
    assert.ok(th.text(th.$('.qr4-no-profit')).includes('ไม่ใช่การรับรองว่าจะทำกำไร'));
    // switching the language redraws the view and leaves the server text alone
    await th.language('en');
    assert.equal(th.$('.qr4-label-translation'),null);assert.equal(th.$('.qr4-label-text').textContent,BEST.label.label_text);
  }finally{th.close();}
  const none=setup({language:'th',handler:router({['GET '+PATH+'/'+SID]:detailOf(REG,NONE)})});
  try{await none.open();await none.view();assert.equal(none.text(none.$('.qr4-no-winner')),TH_WINNER);assert.equal(none.text(none.$('.qr4-outcome-sentence')),'ไม่มีกลยุทธ์ที่ผ่านเกณฑ์ภายในขอบเขตที่เลือก');}finally{none.close();}
});

test('WINNER_NOT_READY and SELECTION_REPLAY_MISMATCH suppress the label and the package controls and hide the recommended values (16.3 item 5)',async()=>{
  for(const overlay of ['WINNER_NOT_READY','SELECTION_REPLAY_MISMATCH']){
    const body=detailOf(REG,BEST,{overlays:[overlay],label_visible:false,hide_recommended_values:true,hide_package_links:overlay==='WINNER_NOT_READY'});
    body.outcome.label=null;
    const winners=new Set(BEST.ranking.filter(item=>item.rank===1).map(item=>item.export_id));
    body.outcome.ranking=body.outcome.ranking.map(item=>winners.has(item.export_id)?{...item,net_return_percent:null,max_drawdown_percent:null}:item);
    body.outcome.evaluations=body.outcome.evaluations.map(item=>winners.has(item.export_id)?{...item,values:null}:item);
    const p=setup({handler:router({['GET '+PATH+'/'+SID]:body})});
    try{
      await p.open();await p.view();
      const box=p.$('.qr4-view');
      assert.equal(box.querySelector('.qr4-label-block'),null);
      assert.equal(box.querySelector('.qr4-label-text'),null);
      assert.ok(!p.text(box).includes('Best of 3'));
      assert.equal(box.querySelectorAll('.qr4-overlay').length,1);
      assert.ok(box.querySelector('.qr4-overlay').textContent.includes(overlay));
      assert.match(p.text(box.querySelector('.qr4-overlay')),/The label and the recommended values are hidden\./);
      assert.equal(p.text(box.querySelector('.qr4-no-winner')),EN_WINNER);
      assert.match(p.text(box),/The recommended values are hidden while an overlay applies\./);
      const winnerCard=box.querySelector('.qr4-evaluation[data-participant='+[...winners][0]+']');
      assert.equal(winnerCard.querySelectorAll('.qr4-metric[data-null=true]').length,11,'every value of a recommended participant is an em dash');
      assert.equal(box.querySelectorAll('.qr4-check-package').length,overlay==='WINNER_NOT_READY'?0:BEST.ranking.length,'package controls follow hide_package_links');
      assert.ok(box.querySelector('.qr4-scope')&&box.querySelector('.qr4-exposure'),'the scope and the exposure sentence stay');
    }finally{p.close();}
  }
  // a hostile answer: the overlay and label_visible say suppressed but the outcome still carries a label; the page shows none
  const hostile=detailOf(REG,BEST,{overlays:['WINNER_NOT_READY'],label_visible:false,hide_recommended_values:true,hide_package_links:true});
  const h=setup({handler:router({['GET '+PATH+'/'+SID]:hostile})});
  try{
    await h.open();await h.view();
    assert.ok(hostile.outcome.label!==null);
    assert.equal(h.$('.qr4-view .qr4-label-block'),null);assert.equal(h.$('.qr4-view .qr4-label-text'),null);assert.ok(!h.text(h.$('.qr4-view')).includes('Best of 3'));
  }finally{h.close();}
  const info=detailOf(REG,BEST,{overlays:['RULESET_SUPERSEDED']});
  const q=setup({handler:router({['GET '+PATH+'/'+SID]:info})});
  try{await q.open();await q.view();assert.ok(q.$('.qr4-label-text'),'RULESET_SUPERSEDED is information only');assert.equal(q.$('.qr4-overlay').classList.contains('qrl-alert'),false);}finally{q.close();}
});

test('an overlay that suppresses the label also hides the ranked-first chip and outcome line; only the overlay text and the no-winner sentence remain (contract 8.2)',async()=>{
  for(const overlay of ['WINNER_NOT_READY','SELECTION_REPLAY_MISMATCH']){
    const body=detailOf(REG,BEST,{overlays:[overlay],label_visible:false,hide_recommended_values:true,hide_package_links:overlay==='WINNER_NOT_READY'});
    body.outcome.label=null;
    const p=setup({handler:router({['GET '+PATH+'/'+SID]:body})});
    try{
      await p.open();await p.view();
      const box=p.$('.qr4-view');
      assert.equal(box.querySelector('.qr4-outcome-text'),null,overlay+': no outcome line');
      assert.ok(![...box.querySelectorAll('.qrl-title .qrl-chip')].some(chip=>chip.dataset.uiLabel==='One strategy ranked first within the selected scope'),overlay+': no outcome chip');
      assert.ok(!p.text(box.querySelector('.qrl-title')).includes('ranked first'));
      assert.ok(!p.text(box).includes('ranked first'),overlay+': nothing says a strategy ranked first');
      assert.ok(box.querySelector('.qr4-overlay').textContent.includes(overlay));
      assert.equal(p.text(box.querySelector('.qr4-no-winner')),EN_WINNER);
    }finally{p.close();}
  }
});

test('a fixture selection is an internal view: no label, the no-winner sentence, the internal chip',async()=>{
  const fixtureReg=registrationOf(3,{fixture:true});
  const outcome=outcomeOf(fixtureReg,[{net:'5'},{net:'3'},{net:'1'}]);
  assert.equal(outcome.label,null);
  const p=setup({handler:router({['GET '+PATH+'/'+SID]:detailOf(fixtureReg,outcome)})});
  try{
    await p.open();await p.view();
    const box=p.$('.qr4-view');
    assert.match(p.text(box.querySelector('.qrl-title')),/Internal view/);
    assert.equal(box.querySelector('.qr4-label-block'),null);
    assert.equal(p.text(box.querySelector('.qr4-no-winner')),EN_WINNER);
  }finally{p.close();}
});

test('cancel and replay: a confirm step, then one POST with the confirm token or an empty body; the refusals are named; nothing else is sent',async()=>{
  let detail=openDetailOf(REG,'SELECTION_REGISTERED');
  const p=setup({handler:router({['GET '+PATH+'/'+SID]:()=>detail,['POST '+PATH+'/'+SID+'/cancel']:()=>{detail=openDetailOf(REG,'SELECTION_CANCELLED');return {ok:true,status:'SELECTION_CANCELLED'};}})});
  try{
    await p.open();await p.view();
    await p.click(p.$('.qr4-ask[data-ask=cancel]'));
    assert.equal(p.posts().length,0,'asking sends nothing');
    assert.match(p.text(p.$('.qr4-confirm-row')),/Cancel this selection\? The exposure records stay\./);
    await p.click(p.$('.qr4-confirm-no'));
    assert.equal(p.$('.qr4-confirm-row'),null);
    await p.click(p.$('.qr4-ask[data-ask=cancel]'));await p.click(p.$('.qr4-confirm-yes'));
    assert.equal(p.posts().length,1);
    assert.equal(p.posts()[0].path,PATH+'/'+SID+'/cancel');assert.equal(p.posts()[0].options.body,'{"confirmed":true}');
    assert.match(p.text(p.$('.qr4-view')),/The selection was cancelled\./);
    assert.match(p.text(p.$('.qr4-view .qrl-title')),/Cancelled/);
    assert.equal(p.$('.qr4-ask'),null);
  }finally{p.close();}
  let replay=()=>({ok:true,match:true,outcome_unchanged:true});
  const q=setup({handler:router({['POST '+PATH+'/'+SID+'/replay']:()=>replay()})});
  try{
    await q.open();await q.view();
    await q.click(q.$('.qr4-ask[data-ask=replay]'));await q.click(q.$('.qr4-confirm-yes'));
    assert.equal(q.posts()[0].path,PATH+'/'+SID+'/replay');assert.equal(q.posts()[0].options.body,'{}');
    assert.match(q.text(q.$('.qr4-view')),/The replay reproduced the stored outcome\./);
    replay=()=>{throw apiError('QR4_EVALUATION_MODE_UNAVAILABLE',409);};
    await q.click(q.$('.qr4-ask[data-ask=replay]'));await q.click(q.$('.qr4-confirm-yes'));
    assert.match(q.text(q.$('.qr4-view')),/Selection evaluation is not available on this release\. \(QR4_EVALUATION_MODE_UNAVAILABLE\)/);
    replay=()=>({ok:true,match:false});
    await q.click(q.$('.qr4-ask[data-ask=replay]'));await q.click(q.$('.qr4-confirm-yes'));
    assert.match(q.text(q.$('.qr4-view')),/The replay did not reproduce the stored outcome\./);
  }finally{q.close();}
});

test('package state: a GET of the export id gives a ready chip or the named refusal; no link is built and nothing is opened',async()=>{
  let answer=()=>({ok:true,selection_id:SID,export_id:'exp-1',state:'READY'});
  const p=setup({handler:router({['GET '+PATH+'/'+SID+'/package/exp-1']:()=>answer()})});
  try{
    await p.open();await p.view();
    const first=p.$$('.qr4-check-package')[0];
    assert.equal(first.dataset.export,BEST.ranking[0].export_id);
    // the ranked participant that is exp-1
    const button=p.$$('.qr4-check-package').find(item=>item.dataset.export==='exp-1');
    await p.click(button);
    assert.equal(p.calls.at(-1).path,PATH+'/'+SID+'/package/exp-1');
    assert.deepEqual({...p.calls.at(-1).options},{silent:true,botId:''});
    assert.match(p.text(p.$('.qr4-package')),/Check package state|Package is ready/);
    assert.ok([...p.$$('.qr4-package')].some(item=>item.textContent.includes('Package is ready')));
    answer=()=>{throw apiError('QR4_PARTICIPANT_NOT_READY',409);};
    await p.click(p.$$('.qr4-check-package').find(item=>item.dataset.export==='exp-1'));
    assert.ok([...p.$$('.qr4-package')].some(item=>/Package is not ready.*The package of the run is not ready\. \(QR4_PARTICIPANT_NOT_READY\)/.test(item.textContent)));
    assert.equal(p.panel.querySelector('a[href]'),null);
  }finally{p.close();}
});

test('there is no apply, import, start, email or alert control and no link; the only actions are the owner actions of the contract (16.3 item 6)',async()=>{
  const members=[memberOf(1),memberOf(2)];
  const p=setup({handler:router({['POST '+PATH+'/preview']:previewOf(members),['GET '+PATH+'/'+SID]:detailOf(REG,BEST)})});
  try{
    await p.open();await p.click(p.$('.qr4-preview-run'));await p.view();
    const controls=[...p.panel.querySelectorAll('button,input,select,textarea,a,form')];
    const names=controls.map(item=>((item.matches('form,select')?'':item.textContent)+' '+(item.name||'')+' '+Object.values(item.dataset).join(' ')+' '+item.className).toLowerCase());
    assert.deepEqual(names.filter(name=>/apply|import|start|e-?mail|alert|activate|session|optimi[sz]e|bot/.test(name)),[],'no such control');
    assert.equal(p.panel.querySelector('a'),null,'no link');
    const buttons=[...new Set([...p.panel.querySelectorAll('button')].map(item=>item.textContent))].sort();
    assert.deepEqual(buttons,['Check again','Check package state','Open actual Paper history','Preview universe','Refresh list','Register selection','Replay outcome','Use this scope','View selection'].sort());
    // every request goes to the selection routes, never with a bot_id, and the only methods are GET and POST
    assert.ok(p.calls.every(call=>call.path.startsWith(PATH)&&(call.options?.method===undefined||call.options.method==='POST')));
    assert.ok(p.calls.every(call=>!/bot|apply|import|email|alert/i.test(call.path+String(call.options?.body))));
  }finally{p.close();}
  const source=publicFile('qr4-selection.js');
  assert.ok(!/fetch\(|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|bot_id|\.href|location\./.test(source));
  assert.deepEqual([...source.matchAll(/'(\/api\/[^']*)'/g)].map(match=>match[1]),['/api/quant/selections']);
});

test('the QR-2 context link is labelled actual history and only opens the Overview page; it requests nothing',async()=>{
  const p=setup();
  try{
    await p.open();await p.view();
    const block=p.$('.qr4-qr2');
    assert.equal(block.querySelector('.qrl-sub').textContent,'Actual Paper history');
    assert.match(p.text(block),/never ranked and never compared on this page/);
    let clicked=0;
    p.d.querySelector('nav button[data-view="overview"]').addEventListener('click',()=>{clicked+=1;});
    const before=p.calls.length;
    await p.click(block.querySelector('.qr4-qr2-link'));
    assert.equal(clicked,1);assert.equal(p.calls.length,before);
  }finally{p.close();}
});

test('the library panel carries the development panel sentence in both languages; the existing development texts stay (D3, OD-S20)',async()=>{
  const p=setup({library:true});
  try{
    const note=p.d.querySelector('#qrlPanel .qrl-dev-panel');
    assert.ok(note);
    assert.equal(note.textContent,DEVELOPMENT_PANEL_TEXT);
    assert.ok(p.d.querySelector('#qrlPanel').textContent.includes('Qualified recommendations: none. No qualified winner.'));
    assert.equal(p.d.querySelector('#qrlPanel .qrl-dev-panel').closest('details').id,'qrlPanel');
    assert.equal(p.d.querySelector('#qrlPanel [class*=rank],#qrlPanel [class*=leader]'),null);
  }finally{p.close();}
  const th=setup({language:'th',library:true});
  try{assert.equal(th.d.querySelector('#qrlPanel .qrl-dev-panel').textContent,'คะแนนช่วงพัฒนา ไม่ใช่การจัดอันดับ');}finally{th.close();}
  const source=publicFile('research-library.js');
  assert.ok(source.includes('Development score: in-sample selection, not a recommendation'),'the D3 note stays');
});

const WORD=/\b(best|top|winner|optimal)\b/i;
test('a text scan of the rendered English and Thai finds best, top, winner or optimal only in the label strings and the exact no-winner sentence (16.3 item 2)',async()=>{
  const allowed=[BEST.label.label_text,TIED.label.label_text,'Best of {n} compared strategies within the selected scope','Tied for best of {n} compared strategies within the selected scope',EN_WINNER,TH_WINNER];
  const strip=value=>{let out=value;for(const part of allowed)out=out.split(part).join(' ');return out;};
  const mine=setup();
  const pairs=mine.w.__mine;mine.close();
  for(const [en,th] of pairs){assert.equal(WORD.test(strip(en)),false,'EN: '+en);assert.equal(WORD.test(strip(th)),false,'TH: '+th);}
  for(const language of [undefined,'th']){
    for(const body of [detailOf(REG,BEST),detailOf(REG,TIED),detailOf(REG,NONE),detailOf(REG,INADEQUATE),openDetailOf(REG,'SELECTION_EVALUATING'),
      detailOf(REG,BEST,{overlays:['WINNER_NOT_READY','SELECTION_REPLAY_MISMATCH','RULESET_SUPERSEDED'],label_visible:false,hide_recommended_values:true,hide_package_links:true})]){
      const p=setup({language,library:true,handler:router({['GET '+PATH+'/'+SID]:body,['POST '+PATH+'/preview']:previewOf([memberOf(1),excluded(2,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE')])})});
      try{
        await p.open();await p.click(p.$('.qr4-preview-run'));await p.view();
        const clone=p.panel.cloneNode(true);
        for(const element of clone.querySelectorAll('.qrl-code,.qrl-hash,.qr4-label-text,code'))element.remove();
        assert.equal(WORD.test(strip(clone.textContent)),false,(language??'en')+': '+clone.textContent.match(/.{0,40}\b(best|top|winner|optimal)\b.{0,40}/i)?.[0]);
        const library=p.d.getElementById('qrlPanel');
        assert.equal(WORD.test(strip(library.textContent.replace(EN_WINNER,'').replace(TH_WINNER,''))),false);
      }finally{p.close();}
    }
  }
});

test('every status, outcome, overlay, filter, view state and code of the contract has an English and a Thai string (16.3 item 8)',async()=>{
  const p=setup();
  const pairs=new Map(p.w.__pairs.map(([en,th])=>[en,th]));
  const mine=new Map(p.w.__mine.map(([en,th])=>[en,th]));
  p.close();
  const THAI=/[฀-๿]/;
  const need=[];
  // statuses and outcomes: rendered in the counts of the list
  const list=setup({language:'th',handler:router({['GET '+PATH]:listOf([listRow(SID,'SELECTION_COMPLETED','BEST_IN_SCOPE')])})});
  try{
    await list.open();
    const counts=list.text(list.$('.qr4-list-box'));
    assert.equal(THAI.test(counts),true);
    assert.equal(list.$$('.qr4-count').length,MODULE_STATUSES.length+MODULE_OUTCOMES.length,'one count for every status and every outcome of the module');
  }finally{list.close();}
  assert.ok(MODULE_STATUSES.length===5&&MODULE_OUTCOMES.length===4);
  for(const name of MODULE_OVERLAYS)need.push(name);
  // every code: the open-selection route is refused with the code; the line must name its meaning in English and in Thai
  for(const language of [undefined,'th']){
    let current='NOT_FOUND';
    const q=setup({language,handler:router({['GET '+PATH+'/'+SID]:()=>{throw apiError(current,409);}})});
    try{
      await q.open();
      const codes=[...new Set([...CODE_LIST,'QR4_SCHEMA_ABSENT','QR4_UNAVAILABLE','RETRY_TRANSACTION','METHOD_NOT_ALLOWED'])];
      for(const code of codes){
        current=code;await q.view();
        const line=q.$('.qr4-view .qr4-error');
        assert.ok(line,code);
        const meaning=line.querySelector('[data-ui-label]:not([data-ui-label="The request was refused."])');
        assert.ok(meaning,'a meaning for '+code);
        assert.ok(line.textContent.includes(code),code+' stays visible');
        assert.ok(pairs.has(meaning.dataset.uiLabel),'a Thai pair for '+code);
        if(language==='th')assert.ok(THAI.test(meaning.textContent),'Thai for '+code+': '+meaning.textContent);
      }
    }finally{q.close();}
  }
  // an unknown code is shown as it is, with no invented meaning
  const unknown=setup({handler:router({['GET '+PATH+'/'+SID]:()=>{throw apiError('SOME_NEW_CODE',409);}})});
  try{await unknown.open();await unknown.view();assert.equal(unknown.text(unknown.$('.qr4-view .qr4-error')),'The request was refused. SOME_NEW_CODE');}finally{unknown.close();}
  // the eligibility, filter and result sets of the modules are all covered
  assert.deepEqual([...UNIVERSE_STATUSES].sort(),['EXCLUDED','PARTICIPANT','QUALIFIED_STALE']);
  assert.deepEqual([...PARTICIPANT_RESULTS].sort(),['EVIDENCE_INADEQUATE','NOT_QUALIFYING_IN_SCOPE','PASSED']);
  assert.equal(FILTER_CODE_LIST.length,5);
  assert.ok(need.length===3);
  assert.ok(mine.size>=190);
});

test('every label the pages put on screen has a distinct Thai string (the owner reviews the draft, OD-S19), and the Thai draft does not reuse another English key',async()=>{
  const p=setup();
  const pairs=new Map(p.w.__pairs.map(([en,th])=>[en,th]));
  const mine=p.w.__mine;p.close();
  const THAI=/[฀-๿]/;
  const missing=[...SEEN].filter(label=>!pairs.has(label));
  assert.deepEqual(missing,[],'labels shown without a Thai pair');
  assert.ok(SEEN.size>=120,'the other tests rendered '+SEEN.size+' labels');
  for(const [en,th] of mine){assert.ok(THAI.test(th),'Thai text for '+en);assert.notEqual(en,th);}
  const english=new Set(mine.map(([en])=>en)),thai=mine.map(([,th])=>th);
  assert.equal(english.size,mine.length,'no English key twice');
  assert.equal(new Set(thai).size,thai.length,'no Thai string twice');
});

test('the language switch redraws the list, the preview and the open view in place',async()=>{
  const p=setup({handler:router({['POST '+PATH+'/preview']:previewOf([memberOf(1)])})});
  try{
    await p.open();await p.click(p.$('.qr4-preview-run'));await p.view();
    assert.equal(p.text(p.$('.qr4-holdout-note')),'Their holdout periods differ. They are not compared here.');
    await p.language('th');
    assert.equal(p.text(p.$('.qr4-holdout-note')),'ช่วง Holdout ของแต่ละรันไม่ตรงกัน จึงไม่นำมาเปรียบเทียบกันที่นี่');
    assert.equal(p.$('.qrl-summary').textContent,'การคัดเลือกที่ผ่านเกณฑ์');
    assert.equal(p.$('.qr4-label-text').textContent,BEST.label.label_text);
    await p.language('en');
    assert.equal(p.$('.qrl-summary').textContent,'Qualified selection');
  }finally{p.close();}
});
