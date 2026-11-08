import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {QR3_VERSIONS,REGISTRY_DEFAULTS,REQUIRED_MARKET,ADMITTED_COST_MODELS,PARTICIPANT_STATUSES as CONTRACT_STATUSES} from '../src/comparison/common.js';
import {OBJECTIVES} from '../src/comparison/ranking.js';
import {FIXED_NOTICES,NO_WINNER_TEXT} from '../src/comparison/labels.js';
import {PERIOD_CHOICES} from '../src/comparison/period.js';

// QR-3 S5 UI (contract 11.1 to 11.3, test plan 13.3 items 2 to 6). Everything below is a LABELLED TEST FIXTURE shaped like the answers of
// src/postgres/qr3-routes.js; the page contains no canned data and renders only what the stubbed api() returns.
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
const H=char=>char.repeat(64);
const MINUTE=60000;
const T0=Date.UTC(2026,9,1,0,0);
const PATH='/api/quant/comparisons';
const CID='cmp-fixture-0001';
const ID_A='3f2a9c1e-0000-4000-8000-000000000001',ID_B='3f2a9c1e-0000-4000-8000-000000000002';
const EN_WINNER='Qualified recommendations: none. No qualified winner.';
const TH_WINNER='ผลที่ผ่านเกณฑ์และแนะนำได้: ไม่มี ยังไม่มีผลที่ผ่านเกณฑ์';
const SEEN=new Set();
const apiError=(code,status=409)=>Object.assign(new Error(code||'Request failed'),{code,status});
const unavailable=()=>Object.assign(new Error('Not found'),{status:404});

const contextOf=(over={})=>({mode:'STANDARDIZED',scope:'SPT_CUSTOM_ENGINEERING_ONLY',market:{...REQUIRED_MARKET},data_model:{data_profile:'ohlc-1m',price_tick:'0.01',quantity_step:'0.00001'},
  period:{start_ms:T0,end_ms:T0+2000*MINUTE,evaluation_bars:2000},dataset:{digest_kind:'ql3a-dataset-sha256-v1',digest:H('d'),bar_count:3006},engine:H('e'),
  execution:{fill_model:'paper-close-v1',exit_semantics_version:'bridge-exit-v2'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1'},
  capital:{initial_cash:'1000',initial_inventory:'0',quote:'USDT'},risk_policy:H('r'),ledger_initialization:'Independent historical flat Paper simulation.',
  valuation:{price_series:'DATASET_CLOSE'},benchmark:QR3_VERSIONS.benchmark,spec_hash:H('s'),validation_protocol:H('v'),...over});
const subjectOf=(over={})=>({source_hash:H('a'),source_version:1,parameters:{rr:1.5,emaSlowInput:50},warmup_bars:1006,originating_run:'run-x',bot_id:'bot-1',deployment_id:'dep-1',...over});
const participantOf=(index,over={})=>({participant_id:index===1?ID_A:ID_B,position:index,source_hash:H('a'),origin:'LIBRARY_RUN',fixture:true,context_key:H('c'),compatible:true,freeze_hash:H('f'),
  context:contextOf(),subject:subjectOf(index===1?{}:{parameters:{rr:2,emaSlowInput:60}}),parent:{run_id:index===1?ID_A:ID_B,contract_hash:H('1')},prior_exposed_by:[],...over});
const spec=(over={})=>({version:'qr3-spec-v1',mode:'STANDARDIZED',participants:[ID_A,ID_B],benchmark:QR3_VERSIONS.benchmark,objective:QR3_VERSIONS.objective,
  risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},
  uncertainty:{method:QR3_VERSIONS.uncertainty,seed:'7',resamples:100,block_length:5,confidence:'0.95'},
  period:{version:'qr3-period-v1',choice:'CUSTOM',anchor:'CUSTOM',start_ms:T0,end_ms:T0+2000*MINUTE,start_utc:'x',end_utc:'y',evaluation_bars:2000,warmup_bars:1006,total_bars:3006,limit:10000,
    available_history:{start_ms:T0-5000*MINUTE,end_ms:T0+3000*MINUTE},admission:'ADMITTED'},...over});
const metric=(value,reason=null)=>({value,reason});
const metricsOf=(over={})=>({net_return_percent:metric('3.20'),max_drawdown_percent:metric('1.50'),total_fees:metric('4.1'),total_slippage:metric('0.4'),exposure_percent:metric('62.5'),
  rejected_intents:metric('2'),completed_episodes:metric(9),closed_allocations:metric(9),...over});
const resultOf=(index,over={})=>({participant_id:index===1?ID_A:ID_B,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null,reasons:['VALUATION_BASIS_UNCONFIRMED'],primary_metric:null,
  metrics:metricsOf(),excess_over_benchmark:{value:'1.10',exact:'1.1',reason:null},metrics_hidden:false,evaluation_run_id:'ev-'+index,created_at_ms:T0+index,...over});
const resultsOf=(over={})=>({outcome:{outcome:'NO_QUALIFIED_RESULT',outcome_hash:H('o'),created_at_ms:T0+9,only_qualified_participant_id:null,uncertainty:null,limitations:['UNCERTAINTY_METHOD_NOT_APPROVED']},
  participants:[resultOf(1),resultOf(2)],
  benchmark:{benchmark_id:QR3_VERSIONS.benchmark,created_at_ms:T0+5,ok:true,code:null,detail:null,method:'BUY_HOLD',net_return_percent:{value:'2.10',reason:null},max_drawdown_percent:{value:'3.00',reason:null}},
  replay_events:[],qualified_recommendations:NO_WINNER_TEXT,...over});
const EVENTS={SPEC_FROZEN:[{seq:1,status:'SPEC_FROZEN',reason_code:null,at_ms:T0}],
  EVALUATING:[{seq:1,status:'SPEC_FROZEN',reason_code:null,at_ms:T0},{seq:2,status:'EVALUATING',reason_code:null,at_ms:T0+1}],
  COMPLETE:[{seq:1,status:'SPEC_FROZEN',reason_code:null,at_ms:T0},{seq:2,status:'EVALUATING',reason_code:null,at_ms:T0+1},{seq:3,status:'COMPLETE',reason_code:null,at_ms:T0+2}],
  FAILED:[{seq:1,status:'SPEC_FROZEN',reason_code:null,at_ms:T0},{seq:2,status:'FAILED',reason_code:'FIXED_RUN_FAILED',at_ms:T0+2}],
  CANCELLED:[{seq:1,status:'SPEC_FROZEN',reason_code:null,at_ms:T0},{seq:2,status:'CANCELLED',reason_code:null,at_ms:T0+2}]};
// The hostile default: a status other than COMPLETE still carries `results` here, to prove the page shows no metric on its own authority.
const viewOf=(status='COMPLETE',over={})=>({ok:true,comparison_id:CID,
  comparison:{comparison_id:CID,parent_comparison_id:null,mode:'STANDARDIZED',fixture:true,market:{...REQUIRED_MARKET},window:{start_ms:T0,end_ms:T0+2000*MINUTE},participant_count:2,context_key:H('c'),
    spec_hash:H('s'),spec:spec(),spec_body_hash:H('b'),frozen_at_ms:T0,frozen_at_utc:new Date(T0).toISOString()},
  status,status_event:{seq:EVENTS[status].length,at_ms:T0,at_utc:'x',reason_code:null},events:EVENTS[status],derived_status:null,stale:null,
  participants:[participantOf(1),participantOf(2)],context_mismatches:[],results:resultsOf(),notices:[FIXED_NOTICES[0],FIXED_NOTICES[1]],...over});
const libraryOf=()=>({version:'quant-library-compare-v1',verdict:'COMPATIBLE',mismatches:[],runs:[{run_id:ID_A,compatibility_key:'aaaaaaaaaaaa'},{run_id:ID_B,compatibility_key:'bbbbbbbbbbbb'}]});

const router=(overrides={})=>(path,options)=>{
  const [route]=path.split('?');
  const key=(options?.method||'GET')+' '+route;
  if(Object.hasOwn(overrides,key)){const value=overrides[key];return typeof value==='function'?value(path,options):value;}
  if(key==='GET '+PATH+'/availability-check')throw apiError('NOT_FOUND',404);
  if(key==='GET '+PATH+'/'+CID)return viewOf();
  if(key==='GET /api/quant/library/compare')return libraryOf();
  throw apiError('UNEXPECTED',500);
};

function setup({language,handler=router(),library=false}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js')+';window.__tr=uiTranslations;window.__pairs=uiPairs;window.__mine=qr3ComparisonPairs;');
  const calls=[];
  w.api=async(path,options)=>{calls.push({path,options});return handler(path,options);};
  if(library)w.eval(publicFile('research-library.js'));
  w.eval(publicFile('qr3-comparison.js'));
  const panel=d.getElementById('qr3Panel');
  const $=selector=>panel.querySelector(selector),$$=selector=>[...panel.querySelectorAll(selector)];
  const record=()=>{for(const root of [panel,d.getElementById('qrlPanel')])if(root)for(const element of root.querySelectorAll('[data-ui-label]'))SEEN.add(element.dataset.uiLabel);};
  const open=async()=>{panel.open=true;panel.dispatchEvent(new w.Event('toggle'));await settle();record();};
  const view=async(id=CID)=>{$('.qr3-id').value=id;$('.qr3-lookup').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();record();};
  const click=async element=>{element.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));await settle();record();};
  const text=element=>(element??panel).textContent.replace(/\s+/g,' ').trim();
  const labels=()=>[...panel.querySelectorAll('[data-ui-label]')].map(element=>element.dataset.uiLabel);
  const posts=()=>calls.filter(call=>call.options?.method==='POST');
  return {dom,w,d,panel,calls,$,$$,open,view,click,text,labels,posts,record,close:()=>w.close()};
}
const metricRows=p=>p.$$('.qr3-metric');
// The value text of the row whose key text is `key` (the colon between them is drawn by the stylesheet, so it is not in the text).
const rowOf=(p,root,key)=>{const found=[...root.querySelectorAll('.qrl-ev > .qrl-k')].find(element=>element.textContent===key);return found?p.text(found.nextElementSibling):undefined;};
const after=(p,first,second)=>Boolean(first.compareDocumentPosition(second)&p.w.Node.DOCUMENT_POSITION_FOLLOWING);

test('index.html loads the script after the library with its cache token; the panel is created closed on the Quant page and requests nothing',()=>{
  const html=publicFile('index.html');
  const order=['/i18n.js?v=','/app.js?v=','/research-library.js?v=qr3l1q4','/qr3-comparison.js?v=qr3c2','/journey.js?v=jd2'].map(part=>html.indexOf(part));
  assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'the script loads after i18n.js and the library, before journey.js');
  const p=setup();
  try{
    assert.ok(p.panel&&p.panel.tagName==='DETAILS'&&p.panel.open===false);
    assert.equal(p.panel.parentElement.getAttribute('data-page'),'quant');
    assert.equal(p.$('.qrl-summary').textContent,'Fair comparison');
    assert.equal(p.calls.length,0,'nothing is requested before the panel is opened');
    assert.equal(p.panel.querySelector('[style]'),null,'the CSP forbids inline styles');
  }finally{p.close();}
});

test('a 404 without a code is an honest unavailable state, never an error stack; the page makes one GET probe with no bot_id',async()=>{
  const p=setup({handler:()=>{throw unavailable();}});
  try{
    await p.open();
    assert.equal(p.calls.length,1);
    assert.equal(p.calls[0].path,PATH+'/availability-check');
    assert.deepEqual({...p.calls[0].options},{silent:true,botId:''},'GET only, no bot_id, no toast');
    assert.equal(p.text(p.$('.qr3-status')),'Fair comparison is not available on this release.');
    assert.equal(p.$('.qr3-tools').hidden,true,'no form is offered');
    assert.doesNotMatch(p.text(),/HTTP_404|Error|stack|undefined|NOT_FOUND/);
    assert.equal(p.$('.qr3-refresh').hidden,false);
  }finally{p.close();}
});

test('the unavailable state and the other probe answers read in Thai too; a schema gap and a server error are named',async()=>{
  const th=setup({language:'th',handler:()=>{throw unavailable();}});
  try{await th.open();assert.equal(th.text(th.$('.qr3-status')),'รุ่นนี้ยังไม่เปิดให้ใช้การเปรียบเทียบที่เป็นธรรม');}finally{th.close();}
  const schema=setup({handler:()=>{throw apiError('QR3_SCHEMA_ABSENT',503);}});
  try{await schema.open();assert.equal(schema.text(schema.$('.qr3-status')),'The comparison tables are not installed on this release.');assert.equal(schema.$('.qr3-tools').hidden,true);}finally{schema.close();}
  let fail=true;
  const broken=setup({handler:path=>{if(fail)throw apiError(null,500);return router()(path);}});
  try{
    await broken.open();
    assert.match(broken.text(broken.$('.qr3-status')),/Not available.*HTTP_500/);assert.equal(broken.$('.qr3-refresh').hidden,false);
    fail=false;await broken.click(broken.$('.qr3-refresh'));
    assert.equal(broken.$('.qr3-tools').hidden,false,'Check again probes again');
  }finally{broken.close();}
});

test('a complete comparison shows the specification and the period before any metric, the mode badge, both keys and the fixed texts',async()=>{
  const p=setup();
  try{
    await p.open();await p.view();
    const specBlock=p.$('.qr3-spec'),firstMetric=metricRows(p)[0];
    assert.ok(specBlock&&firstMetric);
    assert.ok(after(p,specBlock,firstMetric),'the specification block comes before the first metric');
    assert.ok(after(p,p.$('.qr3-period'),firstMetric)&&after(p,p.$('.qr3-context'),firstMetric));
    assert.ok(after(p,specBlock,p.$('.qr3-result')),'and before the result block');
    const spec=p.text(specBlock);
    assert.match(spec,/Simulated standardized evaluation/);
    for(const part of [CID,H('s'),QR3_VERSIONS.objective,OBJECTIVES[QR3_VERSIONS.objective].rule_text,QR3_VERSIONS.benchmark,QR3_VERSIONS.uncertainty,'2026-10-01 00:00:00 UTC'])assert.ok(spec.includes(part),part);
    assert.equal(rowOf(p,specBlock,'Risk filter: maximum drawdown limit (%)'),'20');
    assert.equal(rowOf(p,specBlock,'Adequacy: minimum episodes (floor)'),'5');assert.equal(rowOf(p,specBlock,'Adequacy: minimum episodes (ranking)'),'20');
    assert.equal(rowOf(p,specBlock,'Tie band (percentage points)'),'0.50');
    assert.equal(rowOf(p,specBlock,'Mode'),'Simulated standardized evaluation');
    const period=p.$('.qr3-period');
    assert.equal(rowOf(p,period,'Requested period'),'Custom range');assert.equal(rowOf(p,period,'Evaluation bars'),'2000');assert.equal(rowOf(p,period,'Warm-up bars'),'1006');
    assert.equal(rowOf(p,period,'Total bars'),'3006');assert.equal(rowOf(p,period,'Admission'),'ADMITTED');
    // both keys: the QR-3 context key and the library-compat-v1 key of each source run
    const cards=p.$$('.qr3-participant');
    assert.equal(cards.length,2);
    assert.equal(rowOf(p,cards[0],'QR-3 context key'),H('c'));
    assert.equal(rowOf(p,cards[0],'Library context key (library-compat-v1)'),'aaaaaaaaaaaa');
    assert.equal(rowOf(p,cards[1],'Library context key (library-compat-v1)'),'bbbbbbbbbbbb');
    const library=p.calls.find(call=>call.path.startsWith('/api/quant/library/compare'));
    assert.equal(library.path,'/api/quant/library/compare?run_id='+ID_A+'&run_id='+ID_B);
    assert.deepEqual({...library.options},{silent:true,botId:''});
    assert.equal(rowOf(p,p.$('.qr3-context'),'QR-3 context key'),H('c'));
    // fixed texts and the exposure consequence
    const all=p.text();
    assert.ok(all.includes(EN_WINNER)&&all.includes(FIXED_NOTICES[0])&&all.includes(FIXED_NOTICES[1])&&all.includes('This window is now development data for later selection.'));
    // neutral order: the cards follow the stored position, not any metric
    assert.deepEqual(cards.map(card=>card.dataset.participant),[ID_A,ID_B]);
    // the subject differences are disclosed apart from the compatibility
    assert.match(p.text(p.$('.qr3-subject')),/parameters/);
  }finally{p.close();}
});

test('NO_QUALIFIED_RESULT shows the no-winner text in English and in Thai',async()=>{
  const en=setup();
  try{await en.open();await en.view();assert.equal(en.text(en.$('.qr3-no-winner')),EN_WINNER);assert.equal(EN_WINNER,NO_WINNER_TEXT);}finally{en.close();}
  const th=setup({language:'th'});
  try{
    await th.open();await th.view();
    assert.equal(th.text(th.$('.qr3-no-winner')),TH_WINNER);
    assert.ok(th.text().includes('งานวิจัยจำลองบนข้อมูลย้อนหลัง'),'the simulated-research notice reads in Thai');
    assert.ok(th.text().includes('ช่วงเวลานี้กลายเป็นข้อมูลพัฒนาสำหรับการคัดเลือกครั้งถัดไปแล้ว'));
  }finally{th.close();}
});

test('the fixed texts, the objective rule, the registry values and the ids equal the modules that own them',async()=>{
  const p=setup();
  try{
    await p.open();await p.view();
    assert.equal(FIXED_NOTICES[0],'Simulated research on historical data. Not actual Paper execution, not a profitability claim and not a recommendation.');
    assert.deepEqual(p.$$('.qr3-notice').map(element=>p.text(element)),[FIXED_NOTICES[0],FIXED_NOTICES[1]]);
    assert.ok(p.text(p.$('.qr3-rule')).includes(OBJECTIVES[QR3_VERSIONS.objective].rule_text));
    // the create form: defaults are the registry values; the fixed ids are the contract ids
    const form=p.$('.qr3-create');
    const value=name=>form.querySelector('[name='+name+']').value;
    assert.equal(value('max_drawdown_percent'),REGISTRY_DEFAULTS.max_drawdown_percent);
    assert.equal(value('min_episodes_floor'),String(REGISTRY_DEFAULTS.min_episodes_floor));
    assert.equal(value('min_episodes_ranking'),String(REGISTRY_DEFAULTS.min_episodes_ranking));
    assert.equal(value('tie_band_pp'),REGISTRY_DEFAULTS.tie_band_pp);
    assert.equal(value('uncertainty_seed')+value('uncertainty_resamples')+value('uncertainty_block_length')+value('uncertainty_confidence'),'','the uncertainty settings have no default');
    assert.deepEqual([...form.querySelector('[name=period_choice]').options].map(option=>option.value),[...PERIOD_CHOICES]);
    assert.equal(form.querySelector('[name=uncertainty_method]').options[0].value,QR3_VERSIONS.uncertainty);
    assert.ok(p.text(form).includes(QR3_VERSIONS.objective)&&p.text(form).includes(QR3_VERSIONS.benchmark));
  }finally{p.close();}
});

test('no metric is built while the comparison is SPEC_FROZEN or EVALUATING, even when the answer carries results; the specification is shown',async()=>{
  for(const status of ['SPEC_FROZEN','EVALUATING']){
    const p=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf(status)})});
    try{
      await p.open();await p.view();
      assert.ok(p.$('.qr3-spec'),status+': the specification is shown');
      assert.equal(metricRows(p).length,0,status+': no metric row');
      assert.equal(p.$('.qr3-result'),null,status+': no result block');
      assert.equal(p.$('.qr3-no-winner'),null);
      assert.ok(p.text().includes('Results appear only after the evaluation is complete.'));
      for(const forbidden of ['3.20','2.10','1.10','62.5',H('o')])assert.ok(!p.text().includes(forbidden),status+': '+forbidden+' must not be shown');
      assert.ok(p.$('.qr3-ask'),status+': a cancel control is offered');
    }finally{p.close();}
  }
});

test('a FAILED or CANCELLED comparison shows no metric and no cancel control',async()=>{
  for(const status of ['FAILED','CANCELLED']){
    const p=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf(status)})});
    try{
      await p.open();await p.view();
      assert.equal(metricRows(p).length,0);
      assert.ok(p.text().includes('No results were stored for this comparison.'));
      assert.equal(p.$('.qr3-ask'),null);
      assert.ok(p.text(p.$('.qr3-history')).includes(status==='FAILED'?'FIXED_RUN_FAILED':'Cancelled'));
    }finally{p.close();}
  }
});

test('an incompatible participant shows its mismatching fields and no metric; a compatible one still shows its own',async()=>{
  const mismatch={field:'dataset',values:[{participant_id:ID_A,value:'{"bar_count":3006}'},{participant_id:ID_B,value:'{"bar_count":4000}'}]};
  const body=viewOf('COMPLETE',{context_mismatches:[mismatch],participants:[participantOf(1),participantOf(2,{compatible:false,context_key:H('9')})],
    results:resultsOf({participants:[resultOf(1),resultOf(2,{status:'DEVELOPMENT_EVIDENCE'})]})});
  const p=setup({handler:router({['GET '+PATH+'/'+CID]:body})});
  try{
    await p.open();await p.view();
    const [first,second]=p.$$('.qr3-participant');
    assert.ok(p.text(p.$('.qr3-context')).includes('dataset'));
    assert.ok(p.text(p.$('.qr3-context')).includes('{"bar_count":4000}'));
    assert.equal(p.$('.qr3-mismatch-alert').textContent,'The participants differ in a fixed context field. They cannot be compared, so no metric is shown.');
    assert.equal(second.querySelectorAll('.qr3-metric').length,0,'no metric for the incompatible participant');
    assert.ok(p.text(second).includes('Metrics are not shown for this participant.')&&p.text(second).includes('Not compatible'));
    assert.ok(first.querySelectorAll('.qr3-metric').length>0);
    assert.ok(!p.text(second).includes('3.20'));
    assert.equal(p.$('.qr3-context table'),null,'no shared-context table is claimed when the contexts differ');
  }finally{p.close();}
  // a status that hides metrics, and the flag metrics_hidden, also show none
  for(const hidden of [{status:'EXCLUDED_INCOMPATIBLE'},{status:'EXCLUDED_COVERAGE'},{status:'EXCLUDED_INTEGRITY'},{status:'UNAVAILABLE'},{status:'NOT_EVALUATED'},{metrics_hidden:true},{metrics:null}]){
    const q=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf('COMPLETE',{results:resultsOf({participants:[resultOf(1,hidden),resultOf(2)]})})})});
    try{
      await q.open();await q.view();
      const [one,two]=q.$$('.qr3-participant');
      assert.equal(one.querySelectorAll('.qr3-metric').length,0,JSON.stringify(hidden));
      assert.ok(two.querySelectorAll('.qr3-metric').length>0);
    }finally{q.close();}
  }
});

test('a null shows an em dash and its reason, never 0; a recorded zero is still shown as it is',async()=>{
  const results=resultsOf({participants:[resultOf(1,{metrics:metricsOf({net_return_percent:metric(null,'METRIC_NOT_RECORDED'),total_fees:undefined,exposure_percent:{value:0,reason:'METRIC_NOT_RECORDED'},
      rejected_intents:metric('0')}),excess_over_benchmark:{value:null,reason:'QR3_BENCHMARK_DATA_UNAVAILABLE',detail:null}}),resultOf(2)],
    benchmark:{benchmark_id:QR3_VERSIONS.benchmark,created_at_ms:T0+5,ok:false,code:'QR3_BENCHMARK_DATA_UNAVAILABLE',detail:null,method:null,
      net_return_percent:{value:null,reason:'QR3_BENCHMARK_DATA_UNAVAILABLE'},max_drawdown_percent:{value:null,reason:'QR3_BENCHMARK_DATA_UNAVAILABLE'}}});
  const p=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf('COMPLETE',{results})})});
  try{
    await p.open();await p.view();
    const row=(card,key)=>card.querySelector('[data-metric='+key+']');
    const [one]=p.$$('.qr3-participant');
    const nullText=key=>p.text(row(one,key).querySelector('.qrl-v'));
    assert.equal(nullText('net_return_percent'),'— METRIC_NOT_RECORDED');
    assert.equal(nullText('total_fees'),'— METRIC_NOT_RECORDED','a missing entry is a null with a reason');
    assert.equal(nullText('exposure_percent'),'— METRIC_NOT_RECORDED','a value that carries a reason is a null, even when it is zero');
    assert.equal(nullText('excess'),'— QR3_BENCHMARK_DATA_UNAVAILABLE');
    assert.equal(nullText('buy_hold'),'— QR3_BENCHMARK_DATA_UNAVAILABLE');
    for(const key of ['net_return_percent','total_fees','exposure_percent','excess','buy_hold'])assert.equal(row(one,key).dataset.null,'true');
    assert.equal(nullText('rejected_intents'),'0','a recorded zero is a value');
    assert.equal(row(one,'rejected_intents').dataset.null,undefined);
    assert.equal(rowOf(p,p.$('.qr3-result'),'Buy & Hold return (%)'),'— QR3_BENCHMARK_DATA_UNAVAILABLE');
    for(const element of p.$$('.qr3-metric[data-null]'))assert.ok(!/(^|\s)0(\s|$)/.test(p.text(element.querySelector('.qrl-v'))),'a null is never shown as 0');
  }finally{p.close();}
});

test('a participant that is not qualified gets no rank, best, top or winner text; no rank, label or highlight is read at all',async()=>{
  const hostile=resultOf(1,{rank:1,label:'best within the selected scope',highlight:true,status:'DEVELOPMENT_EVIDENCE'});
  const p=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf('COMPLETE',{results:resultsOf({participants:[hostile,resultOf(2,{rank:2,label:'top winner'})]})})})});
  try{
    await p.open();await p.view();
    // the specification legitimately names its own "minimum episodes (ranking)" rule; the page that shows the participants and the result has none of these words
    const shown=[p.$('.qrl-title'),p.$('.qr3-result'),p.$('.qr3-participants')].map(element=>p.text(element)).join(' ').replaceAll(EN_WINNER,'').replaceAll(FIXED_NOTICES[1],'');
    assert.doesNotMatch(shown,/\b(rank\w*|best|top|winner|leader|champion|first place)\b/i);
    assert.equal(p.$$('[class*=rank],[class*=best],[class*=highlight],[aria-label*=rank]').length,0);
  }finally{p.close();}
  const source=publicFile('qr3-comparison.js');
  assert.doesNotMatch(source,/\.rank\b|\.highlight\b|\.label\b|\.primary_metric\b/,'the script never reads a rank, a label or a highlight of a participant');
});

test('the view offers no apply, import, start-Bot, email or optimize control and sends no Bot field; the only POSTs are create, cancel and replay',async()=>{
  const p=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf('EVALUATING'),['POST '+PATH]:{ok:true,existing:false,comparison_id:CID},['POST '+PATH+'/'+CID+'/cancel']:{ok:true,comparison_id:CID,status:'CANCELLED'}})});
  try{
    await p.open();await p.view();
    const controls=[...p.panel.querySelectorAll('button,a,input,select,textarea')].map(element=>[element.tagName,element.type,element.name,element.textContent].join(' ')).join('|');
    assert.doesNotMatch(controls,/\b(apply|import|start[ _-]?bot|email|optimi[sz]e|best inputs|activate|live)\b/i);
    assert.equal(p.panel.querySelector('a'),null);
    await p.click(p.$('.qr3-ask'));await p.click(p.$('.qr3-confirm-yes'));
    for(const call of p.posts())assert.match(call.path,new RegExp('^'+PATH+'(/[A-Za-z0-9_.:-]+/(cancel|replay))?$'));
    for(const call of p.calls)assert.doesNotMatch(JSON.stringify(call),/bot_id|deployment|apply|email|import/i);
  }finally{p.close();}
});

test('every text of every rendered state reads in Thai in Thai mode, for the view, the refusals and the actions',async()=>{
  const collect=p=>p.record();
  const states=[
    {name:'complete',view:viewOf()},
    {name:'evaluating',view:viewOf('EVALUATING')},
    {name:'failed',view:viewOf('FAILED')},
    {name:'incompatible',view:viewOf('COMPLETE',{context_mismatches:[{field:'dataset',values:[{participant_id:ID_A,value:'1'},{participant_id:ID_B,value:'2'}]}],participants:[participantOf(1),participantOf(2,{compatible:false})]})},
    {name:'stale',view:viewOf('COMPLETE',{derived_status:'STALE',stale:{first_differing_code:'REPLAY_MISMATCH',detail:null}})},
    {name:'stale-only',view:{ok:true,comparison_id:CID,derived_status:'STALE',stale:{first_differing_code:'QR3_INTEGRITY_FAILED',detail:null},comparison:null,results:null}},
    // statuses no other state shows, a participant without a stored context, identical subjects, replay events and the other mode
    {name:'variants',view:viewOf('COMPLETE',{comparison:{...viewOf().comparison,mode:'ACTUAL_BOT'},participants:[participantOf(1,{context:null,subject:subjectOf()}),participantOf(2,{context:null,subject:subjectOf()})],
      results:resultsOf({participants:[resultOf(1,{status:'INADEQUATE_SAMPLE'}),resultOf(2,{status:'FILTERED_RISK'})],replay_events:[{kind:'REPLAY_MATCH'}]})})}
  ];
  for(const language of [undefined,'th']){
    for(const state of states){
      const p=setup({language,library:true,handler:router({['GET '+PATH+'/'+CID]:state.view,['GET /api/quant/library/compare']:libraryOf()})});
      try{
        await p.open();await p.view();collect(p);
        const view=p.$('.qr3-view');
        assert.equal(view.hidden,false,state.name);
        if(language==='th'){
          for(const element of p.$$('[data-ui-label]'))assert.equal(element.textContent,p.w.eval('translate')(element.dataset.uiLabel),state.name);
          assert.match(p.text(view),/[ก-๛]/,state.name+': Thai text is shown');
        }
      }finally{p.close();}
    }
  }
  // refusal and action texts, create form, cancel and replay confirmations
  const p=setup({language:'th',handler:router({['GET '+PATH+'/'+CID]:viewOf('COMPLETE'),['POST '+PATH+'/'+CID+'/replay']:()=>{throw unavailable();}})});
  try{
    await p.open();await p.view();
    await p.click(p.$('.qr3-ask'));collect(p);await p.click(p.$('.qr3-confirm-yes'));
    assert.ok(p.text().includes('รุ่นนี้ยังไม่เปิดให้เล่นซ้ำ'),'the replay answer reads in Thai');
    p.$('.qr3-id').value='bad id!';p.$('.qr3-lookup').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await settle();collect(p);
    p.$('.qr3-create').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await settle();collect(p);
    assert.ok(p.text(p.$('.qr3-create-message')).includes('ใส่รหัสรัน 2 ถึง 4 รายการ'));
  }finally{p.close();}
  // every refusal sentence of a view answer, and a code the page does not know (shown as the code, with the generic sentence)
  for(const reason of ['NOT_FOUND','QR3_NOT_CANCELLABLE','QR3_CONFIRMATION_REQUIRED','QR3_SCHEMA_ABSENT','QR3_ADMISSION_CLOSED','QR3_ACTUAL_BOT_UNAVAILABLE','RETRY_TRANSACTION','A_CODE_THE_PAGE_DOES_NOT_KNOW']){
    const q=setup({language:'th',handler:router({['GET '+PATH+'/'+CID]:()=>{throw apiError(reason,409);}})});
    try{
      await q.open();await q.view();
      const shown=q.text(q.$('.qr3-view'));
      assert.ok(shown.includes('('+reason+')')&&/[ก-๛]/.test(shown),reason);
      assert.equal(metricRows(q).length,0);
    }finally{q.close();}
  }
});

test('the language switch redraws a loaded view in Thai and back',async()=>{
  const p=setup();
  try{
    await p.open();await p.view();
    assert.equal(p.text(p.$('.qr3-no-winner')),EN_WINNER);
    const select=p.d.getElementById('language');select.value='th';select.dispatchEvent(new p.w.Event('change',{bubbles:true}));await settle();
    assert.equal(p.text(p.$('.qr3-no-winner')),TH_WINNER);
    assert.ok(p.text(p.$('.qr3-spec')).includes('ข้อกำหนด'));
    select.value='en';select.dispatchEvent(new p.w.Event('change',{bubbles:true}));await settle();
    assert.equal(p.text(p.$('.qr3-no-winner')),EN_WINNER);
  }finally{p.close();}
});

test('a stale report keeps its stored numbers and says so; an unreadable one shows no number',async()=>{
  const stale=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf('COMPLETE',{derived_status:'STALE',stale:{first_differing_code:'REPLAY_MISMATCH',detail:null}})})});
  try{
    await stale.open();await stale.view();
    assert.ok(stale.text(stale.$('.qr3-stale')).includes('REPLAY_MISMATCH'));assert.ok(stale.text(stale.$('.qrl-title')).includes('Stale'));
    assert.ok(metricRows(stale).length>0);
  }finally{stale.close();}
  const only=setup({handler:router({['GET '+PATH+'/'+CID]:{ok:true,comparison_id:CID,derived_status:'STALE',stale:{first_differing_code:'QR3_INTEGRITY_FAILED',detail:null},comparison:null,results:null}})});
  try{
    await only.open();await only.view();
    assert.equal(metricRows(only).length,0);assert.equal(only.$('.qr3-spec'),null);assert.ok(only.text().includes('QR3_INTEGRITY_FAILED'));
  }finally{only.close();}
});

test('view refusals: a malformed id sends nothing; NOT_FOUND is a named refusal; a flag turned off after the probe becomes the unavailable state',async()=>{
  let mode='missing';
  const p=setup({handler:path=>{
    if(path===PATH+'/availability-check')throw apiError('NOT_FOUND',404);
    if(path===PATH+'/gone-1'){if(mode==='missing')throw apiError('NOT_FOUND',404);throw unavailable();}
    if(path===PATH+'/odd-1')return {ok:true,comparison_id:'odd-1',status:'COMPLETE',comparison:null,results:resultsOf()};
    return router()(path);
  }});
  try{
    await p.open();
    const before=p.calls.length;
    await p.view('not a valid id!');
    assert.equal(p.calls.length,before,'a malformed id sends nothing');
    assert.ok(p.text(p.$('.qr3-view')).includes('Enter a valid comparison ID.'));
    await p.view('gone-1');
    assert.ok(p.text(p.$('.qr3-view')).includes('Comparison or run not found for this account. (NOT_FOUND)'));
    assert.equal(p.$('.qr3-tools').hidden,false);
    await p.view('odd-1');
    assert.ok(p.text(p.$('.qr3-view')).includes('(ANSWER_UNREADABLE)'),'an answer without its comparison is refused, not drawn');
    assert.equal(metricRows(p).length,0);
    mode='off';await p.view('gone-1');
    assert.equal(p.text(p.$('.qr3-status')),'Fair comparison is not available on this release.');assert.equal(p.$('.qr3-tools').hidden,true);
  }finally{p.close();}
});

test('create sends exactly the frozen specification once, opens the new comparison and shows an admission refusal by code',async()=>{
  const created=[];
  const p=setup({handler:router({['POST '+PATH]:(path,options)=>{created.push(JSON.parse(options.body));return {ok:true,existing:false,comparison_id:CID,status:'SPEC_FROZEN',evaluation_started:false};}})});
  try{
    await p.open();
    const set=(name,value)=>{p.$('[name='+name+']').value=value;};
    const submit=async()=>{p.$('.qr3-create').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await settle();p.record();};
    // nothing is sent until the form is complete
    await submit();assert.equal(p.posts().length,0);assert.ok(p.text(p.$('.qr3-create-message')).includes('Enter 2 to 4 run IDs.'));
    set('run_id_1',ID_A);set('run_id_2',ID_A);await submit();assert.ok(p.text(p.$('.qr3-create-message')).includes('Each run ID may appear once.'));
    set('run_id_2',ID_B);await submit();assert.ok(p.text(p.$('.qr3-create-message')).includes('Enter every uncertainty setting.'));
    set('uncertainty_seed','7');set('uncertainty_resamples','100');set('uncertainty_block_length','5');set('uncertainty_confidence','0.95');
    await submit();assert.ok(p.text(p.$('.qr3-create-message')).includes('Confirm the specification before creating the comparison.'));
    p.$('[name=confirmed]').checked=true;
    set('period_choice','CUSTOM');p.$('[name=period_choice]').dispatchEvent(new p.w.Event('change',{bubbles:true}));
    assert.equal(p.$('.qr3-custom').hidden,false);
    set('custom_start','2026-10-01 00:00');set('custom_end','2026-10-02 01:00');
    set('max_drawdown_percent','abc');await submit();assert.ok(p.text(p.$('.qr3-create-message')).includes('Enter numbers in the specification fields.'));
    set('max_drawdown_percent','20');set('custom_end','2026-02-31 01:00');await submit();assert.ok(p.text(p.$('.qr3-create-message')).includes('Enter the custom times as YYYY-MM-DD HH:MM in UTC.'));
    assert.equal(p.posts().length,0,'every local refusal sent nothing');
    set('custom_end','2026-10-02 01:00');
    await submit();
    assert.equal(created.length,1);
    const start=Date.UTC(2026,9,1,0,0),end=Date.UTC(2026,9,2,1,0);
    const key=created[0].request_key;
    assert.match(key,/^ui-./);
    assert.deepEqual(created[0],{confirmed:true,request_key:key,mode:'STANDARDIZED',participants:[{run_id:ID_A},{run_id:ID_B}],market:{...REQUIRED_MARKET},cost_model_version:ADMITTED_COST_MODELS[0],
      period:{choice:'CUSTOM',start_ms:start,end_ms:end},objective:QR3_VERSIONS.objective,risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},
      tie:{band_pp:'0.50'},benchmark:QR3_VERSIONS.benchmark,uncertainty:{method:QR3_VERSIONS.uncertainty,seed:'7',resamples:100,block_length:5,confidence:'0.95'}});
    assert.deepEqual({...p.posts()[0].options}.silent,true);assert.equal(p.posts()[0].options.botId,'');
    assert.ok(p.text(p.$('.qr3-create-message')).includes('Comparison created. No evaluation has started.'));
    assert.equal(p.$('.qr3-id').value,CID);assert.ok(p.$('.qr3-spec'),'the new comparison is opened');
    // no uncertainty interval is sent as a null method; the request key changes after the form changed
    set('uncertainty_method','NONE');p.$('[name=uncertainty_method]').dispatchEvent(new p.w.Event('change',{bubbles:true}));
    assert.equal(p.$('.qr3-uncertainty').hidden,true);
    await submit();
    assert.equal(created.length,2);assert.deepEqual(created[1].uncertainty,{method:null});assert.notEqual(created[1].request_key,key);
  }finally{p.close();}
  // a refusal keeps the same key for an identical retry and shows the code with a plain sentence
  const keys=[];
  const q=setup({handler:router({['POST '+PATH]:(path,options)=>{keys.push(JSON.parse(options.body).request_key);throw apiError('QR3_ADMISSION_CLOSED',409);}})});
  try{
    await q.open();
    q.$('[name=run_id_1]').value=ID_A;q.$('[name=run_id_2]').value=ID_B;q.$('[name=uncertainty_method]').value='NONE';q.$('[name=confirmed]').checked=true;
    for(let at=0;at<2;at+=1){q.$('.qr3-create').dispatchEvent(new q.w.Event('submit',{bubbles:true,cancelable:true}));await settle();}
    assert.equal(keys.length,2);assert.equal(keys[0],keys[1],'an identical retry keeps its request key');
    assert.equal(q.text(q.$('.qr3-create-message')),'Comparison admission is closed on this release. (QR3_ADMISSION_CLOSED)');
    q.record();
  }finally{q.close();}
  // the other refusals of create, and an answer for a request that was already created
  for(const [reason,sentence] of [['QR3_ACTUAL_BOT_UNAVAILABLE','Comparison of Actual Paper history is not available yet.'],['RETRY_TRANSACTION','The database was busy. Try again.']]){
    const s=setup({handler:router({['POST '+PATH]:()=>{throw apiError(reason,409);}})});
    try{
      await s.open();
      s.$('[name=run_id_1]').value=ID_A;s.$('[name=run_id_2]').value=ID_B;s.$('[name=uncertainty_method]').value='NONE';s.$('[name=confirmed]').checked=true;
      s.$('.qr3-create').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
      assert.equal(s.text(s.$('.qr3-create-message')),sentence+' ('+reason+')');s.record();
    }finally{s.close();}
  }
  const again=setup({handler:router({['POST '+PATH]:{ok:true,existing:true,comparison_id:CID,same_spec:true,evaluation_started:false}})});
  try{
    await again.open();
    again.$('[name=run_id_1]').value=ID_A;again.$('[name=run_id_2]').value=ID_B;again.$('[name=uncertainty_method]').value='NONE';again.$('[name=confirmed]').checked=true;
    again.$('.qr3-create').dispatchEvent(new again.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.equal(again.text(again.$('.qr3-create-message')),'This request was already created.');again.record();
  }finally{again.close();}
  // the flag turned off: a 404 without a code on create becomes the unavailable state
  const r=setup({handler:router({['POST '+PATH]:()=>{throw unavailable();}})});
  try{
    await r.open();
    r.$('[name=run_id_1]').value=ID_A;r.$('[name=run_id_2]').value=ID_B;r.$('[name=uncertainty_method]').value='NONE';r.$('[name=confirmed]').checked=true;
    r.$('.qr3-create').dispatchEvent(new r.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.equal(r.text(r.$('.qr3-status')),'Fair comparison is not available on this release.');
  }finally{r.close();}
});

test('cancel and replay ask first, send an empty body once and refresh the view; refusals and a missing replay route are shown',async()=>{
  let status='EVALUATING';
  const p=setup({handler:router({['GET '+PATH+'/'+CID]:()=>viewOf(status),['POST '+PATH+'/'+CID+'/cancel']:()=>{status='CANCELLED';return {ok:true,comparison_id:CID,status:'CANCELLED'};}})});
  try{
    await p.open();await p.view();
    await p.click(p.$('.qr3-ask'));
    assert.equal(p.posts().length,0,'the first click only asks');
    assert.ok(p.text(p.$('.qr3-confirm-row')).includes('The exposure records stay.'));
    await p.click(p.$('.qr3-confirm-no'));assert.equal(p.$('.qr3-confirm-row'),null);assert.equal(p.posts().length,0);
    await p.click(p.$('.qr3-ask'));await p.click(p.$('.qr3-confirm-yes'));
    assert.equal(p.posts().length,1);
    assert.equal(p.posts()[0].path,PATH+'/'+CID+'/cancel');assert.equal(p.posts()[0].options.body,'{}');assert.deepEqual({...p.posts()[0].options}.botId,'');
    assert.ok(p.text(p.$('.qr3-view')).includes('The evaluation was cancelled.'));
    assert.equal(p.$('.qr3-ask'),null,'a cancelled comparison offers no cancel');
    assert.ok(p.text(p.$('.qrl-title')).includes('Cancelled'));
  }finally{p.close();}
  // a cancel that lost a race: the refusal is shown by its plain sentence and code
  const q=setup({handler:router({['GET '+PATH+'/'+CID]:viewOf('EVALUATING'),['POST '+PATH+'/'+CID+'/cancel']:()=>{throw apiError('QR3_NOT_CANCELLABLE',409);}})});
  try{
    await q.open();await q.view();await q.click(q.$('.qr3-ask'));await q.click(q.$('.qr3-confirm-yes'));
    assert.ok(q.text(q.$('.qr3-view')).includes('This comparison can no longer be cancelled. (QR3_NOT_CANCELLABLE)'));
  }finally{q.close();}
  // replay: only for a complete comparison; a 404 without a code is a missing route, a refusal keeps its code, success says so
  for(const [reply,expected] of [[()=>{throw unavailable();},'Replay is not available on this release.'],[()=>{throw apiError('QR3_INTEGRITY_FAILED',409);},'(QR3_INTEGRITY_FAILED)'],[()=>{throw apiError('QR3_CONFIRMATION_REQUIRED',400);},'Replay is not available now. (QR3_CONFIRMATION_REQUIRED)'],[()=>{throw apiError('QR3_ADMISSION_CLOSED',409);},'Replay is not available now. (QR3_ADMISSION_CLOSED)'],[()=>({ok:true}),'Replay requested.']]){
    const r=setup({handler:router({['POST '+PATH+'/'+CID+'/replay']:reply})});
    try{
      await r.open();await r.view();
      assert.equal(r.$('.qr3-ask').dataset.ask,'replay');
      await r.click(r.$('.qr3-ask'));assert.equal(r.posts().length,0);
      await r.click(r.$('.qr3-confirm-yes'));
      assert.equal(r.posts()[0].path,PATH+'/'+CID+'/replay');assert.equal(r.posts()[0].options.body,'{"confirmed":true}');
      assert.ok(r.text(r.$('.qr3-view')).includes(expected),expected);
      assert.equal(r.$('.qr3-tools').hidden,false,'a missing replay route does not hide the rest');
    }finally{r.close();}
  }
});

test('API text is placed as text: markup in ids, specification strings and codes creates no element',async()=>{
  const evil='<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
  const body=viewOf('COMPLETE',{comparison:{...viewOf().comparison,comparison_id:evil,spec:spec({objective:evil,benchmark:evil})},
    participants:[participantOf(1,{participant_id:evil,subject:subjectOf({bot_id:evil}),origin:evil,prior_exposed_by:[{kind:evil,id:evil,window:{start_ms:T0,end_ms:T0+MINUTE},at_ms:T0}]}),participantOf(2)],
    results:resultsOf({participants:[resultOf(1,{participant_id:evil,reasons:[evil]}),resultOf(2)]})});
  const p=setup({handler:router({['GET '+PATH+'/'+CID]:body})});
  try{
    await p.open();await p.view();
    assert.equal(p.panel.querySelectorAll('img,script').length,0);assert.equal(p.w.pwned,undefined);
    assert.ok(p.text().includes('<img src=x'));
  }finally{p.close();}
  const source=publicFile('qr3-comparison.js');
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|style\s*=|\.style\b/);
});

test('the same-source context check of the library is relabelled, never ranks and shows the library key beside the verdict',async()=>{
  const runs=[3,2].map(index=>({run_id:'3f2a9c1e-0000-4000-8000-00000000000'+index,created_at:T0+index,finished_at:T0+index+1,status:'SUCCEEDED',phase:'COMPLETE',library_class:'CANDIDATE_PENDING_ACCEPTANCE',
    library_group:'COMPLETED',completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',diagnostic:null,contract_version:'ql3a-research-job-v1',engine_family:'LEGACY',market:{...REQUIRED_MARKET},
    dataset:{start_time:T0,end_time:T0+MINUTE,bar_count:1000},cost:{fee_bps:10,slippage_bps:1},candidates:{planned:100,evaluated:100,screen_passed:3},
    development_score:{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},qualification:{qualified:false,label:'DEVELOPMENT_ONLY'},integrity_checked:false,compatibility_key:'kkkkkkkkkkk'+index}));
  const compare={version:'quant-library-compare-v1',verdict:'COMPATIBLE',rules:{compatibility:'library-compat-v1',qualification:'library-qualification-v2'},mismatches:[],qualified_total:0,qualified_winner:null,
    runs:runs.map(run=>({...run,disclosed:{bot_id:'bot-1',deployment_id:'dep-1',baseline_snapshot_hash:H('f'),search:{algorithm:'a',seed:7,requested_budget:100},domains:[]},
      metrics:{candidates:{planned:100,evaluated:100,screen_passed:3},reason_counts:{},development_score:{value:'3.20',basis:'x',reason:null},selected:null},metrics_reason:null}))};
  const handler=path=>{
    const [route]=path.split('?');
    if(route==='/api/quant/library')return {version:'quant-library-v1',schema_present:true,totals:{all:2,ACTIVE:0,COMPLETED:2,INSUFFICIENT:0,FAILED:0,CANCELLED:0},qualified_total:0,qualified_winner:null,next_before:null,runs};
    if(route==='/api/quant/library/compare')return compare;
    return router()(path);
  };
  for(const language of [undefined,'th']){
    const p=setup({language,library:true,handler});
    try{
      const library=p.d.getElementById('qrlPanel');
      library.open=true;library.dispatchEvent(new p.w.Event('toggle'));await settle();
      for(const index of [3,2]){const box=library.querySelector('.qrl-card[data-run$="'+index+'"] .qrl-pick');box.checked=true;box.dispatchEvent(new p.w.Event('change',{bubbles:true}));}
      library.querySelector('.qrl-compare').dispatchEvent(new p.w.MouseEvent('click',{bubbles:true}));await settle();
      const title=library.querySelector('.qrl-compare-view .qrl-title').textContent;
      assert.equal(title,language==='th'?'ตรวจบริบทของซอร์สเดียวกัน':'Same-source context check');
      const viewText=library.querySelector('.qrl-compare-view').textContent;
      assert.ok(viewText.includes(language==='th'?'ส่วนนี้ตรวจว่ารันที่เลือกใช้บริบทของคลังเดียวกัน':'It is not the fair comparison.'));
      assert.ok(viewText.includes(language==='th'?'รหัสบริบทของคลัง (library-compat-v1)':'Library context key (library-compat-v1)'));
      assert.ok(viewText.includes('kkkkkkkkkkk3')&&viewText.includes('kkkkkkkkkkk2'));
      assert.ok(viewText.includes(language==='th'?TH_WINNER:EN_WINNER));
      assert.doesNotMatch(viewText.replace(EN_WINNER,''),/\b(best|top|winner)\b/i);
      p.record();
    }finally{p.close();}
  }
});

// Runs last: SEEN holds every label that any test above (and the library relabel above) put on the page.
test('the new i18n pairs are unique, collision-free and all used; every shown label has a Thai text',()=>{
  const p=setup();
  try{
    const mine=[...p.w.__mine],all=[...p.w.__pairs],others=all.filter(pair=>!mine.includes(pair)),translations=p.w.__tr;
    assert.ok(mine.length>=120);
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){assert.ok(en.trim()&&th.trim()&&/[ก-๛]/.test(th),'pair needs Thai letters: '+en);assert.notEqual(en,th);}
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
    const count=new Map();for(const [en] of all)count.set(en,(count.get(en)||0)+1);
    assert.deepEqual([...count].filter(entry=>entry[1]>1).map(entry=>entry[0]).sort(),['Cash','Open positions','Order notional','User'],'no new duplicate English key');
    for(const text of SEEN)if(!/^[\d\s.,:;()%/&+\-—…]*$/.test(text)&&!/^[A-Z0-9_]+$/.test(text)&&!/^[0-9a-f]{8}$/.test(text))assert.ok(translations.has(text),'no Thai text for: '+text);
    assert.deepEqual(mine.map(pair=>pair[0]).filter(text=>!SEEN.has(text)),[],'pairs for texts no state shows');
  }finally{p.close();}
});
