import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
const utc=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC';
const WINNER='Qualified recommendations: none. No qualified winner.';
const BANNER='Inspection only. Development scores are not recommendations. Applying settings or starting a Bot is a separate owner action.';
const H=char=>char.repeat(64);

// Everything below is a LABELLED TEST FIXTURE shaped like the API answers. The product page never contains canned data:
// it renders what the stubbed api() returns, so a compatible comparison is shown here only.
const T0=Date.UTC(2026,8,27,7,30);
const listRun=(i,extra={})=>({run_id:'3f2a9c1e-0000-4000-8000-00000000000'+i,created_at:T0+i*3600000,finished_at:T0+i*3600000+120000,status:'NO_VALID_CANDIDATE',phase:'COMPLETE',
  library_class:'NO_VALID_CANDIDATE',library_group:'COMPLETED',completion_reason:'NO_VALID_TRAIN_VALIDATION_CANDIDATE',diagnostic:null,contract_version:'ql3a-research-job-v1',engine_family:'LEGACY',
  market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},dataset:{start_time:T0,end_time:T0+60000,bar_count:1000,warmup_bars:300,digest_kind:'ql3a-dataset-sha256-v1',digest:H('d')},
  source_hash:H('a'),input_lock_hash:H('b'),engine_hash:H('e'),policy_hash:H('c'),cost:{fee_bps:10,slippage_bps:1},candidates:{planned:100,evaluated:100,screen_passed:0},
  development_score:{value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'NO_SCREENED_CANDIDATE'},qualification:{qualified:false,label:'NO_SCREENED_CANDIDATE'},integrity_checked:false,compatibility_key:'aaaaaaaaaaaa',...extra});
const notEvaluated={qualified:false,label:'NOT_EVALUATED'};
const RUNS=[
  listRun(1),
  listRun(2,{status:'SUCCEEDED',library_class:'CANDIDATE_PENDING_ACCEPTANCE',completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',candidates:{planned:100,evaluated:100,screen_passed:3},
    development_score:{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},qualification:{qualified:false,label:'DEVELOPMENT_ONLY'}}),
  listRun(3,{library_class:'INSUFFICIENT_EVIDENCE',library_group:'INSUFFICIENT',qualification:{qualified:false,label:'DEVELOPMENT_ONLY'},development_score:{value:'1.10',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null}}),
  listRun(4,{status:'FAILED',diagnostic:'VERIFIED_MARKET_DATA_REQUIRED',library_class:'INSUFFICIENT_DATA',library_group:'INSUFFICIENT',completion_reason:null,compatibility_key:'bbbbbbbbbbbb',
    development_score:{value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'NOT_EVALUATED'},qualification:notEvaluated,candidates:{planned:100,evaluated:0,screen_passed:null}}),
  listRun(5,{status:'FAILED',diagnostic:'QUANT_ENGINE_CHANGED',library_class:'FAILED',library_group:'FAILED',completion_reason:null,qualification:notEvaluated}),
  listRun(6,{status:'TIMED_OUT',diagnostic:'JOB_DEADLINE_EXCEEDED',library_class:'TIMED_OUT',library_group:'FAILED',completion_reason:null,qualification:notEvaluated}),
  listRun(7,{status:'CANCELLED',library_class:'CANCELLED',library_group:'CANCELLED',completion_reason:null,qualification:notEvaluated}),
  listRun(8,{status:'RUNNING',library_class:'IN_PROGRESS',library_group:'ACTIVE',completion_reason:null,finished_at:null,candidates:{planned:100,evaluated:40,screen_passed:null},qualification:notEvaluated}),
  listRun(9,{compatibility_key:'cccccccccccc'})].reverse();
const libraryOf=(runs=RUNS,extra={})=>({version:'quant-library-v1',schema_present:true,admission_enabled:false,totals:{all:runs.length,ACTIVE:1,COMPLETED:3,INSUFFICIENT:2,FAILED:2,CANCELLED:1},
  qualified_total:0,qualified_winner:null,next_before:null,runs,...extra});
const run=index=>RUNS.find(item=>item.run_id.endsWith(String(index)));

const GATE_NAMES=['COMPLETED_EVALUATION','SCREENED_CANDIDATE','ROBUSTNESS','HOLDOUT_RESULT','HOLDOUT_INDEPENDENT','BLOCKERS_CLEARED','OWNER_RECOMMENDATION_READY','QL4C_VALIDATION'];
const gate=(index,state,codeText=null)=>({gate:'G'+(index+1),name:GATE_NAMES[index],state,code:codeText});
const metrics=(ret,trades,dd='1.5')=>({bars:1350,closed_trades:trades,start_equity:'1000',end_equity:'1030',net_return_percent:ret,max_drawdown_percent:dd,profit_factor:'1.2',gross_profit:'12.5',gross_loss:'5.5'});
function detailOf(item,{warnings=[],withScore=true}={}){
  const bad=warnings.length>0;
  return {version:'quant-library-run-v1',qualified_total:0,qualified_winner:null,
    run:{run_id:item.run_id,created_at:item.created_at,finished_at:item.finished_at,status:item.status,phase:item.phase,library_class:item.library_class,library_group:item.library_group,
      completion_reason:item.completion_reason,diagnostic:item.diagnostic,contract_version:item.contract_version,engine_family:item.engine_family,bot_id:'bot-1',deployment_id:'dep-1',attempts:1,evaluations_started:100,deadline:item.created_at+900000},
    provenance:{source:{scope:'SPT_CUSTOM_ENGINEERING_ONLY',source_hash:H('a'),baseline_snapshot_hash:H('f'),pine_import_id:'imp-1',source_version:1,membership:[]},
      input:{lock_hash:H('b'),signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},bridge:{atr_multiplier:2,rr:1.5},
        bindings:[{slot:3,input_id:'i3',pine_variable:'emaFastInput',effective_value:50,search_domain:{min:30,max:50,step:10}}],fixed_inputs_count:2,fixed_inputs:[],
        domains:[{dimension:'rr',count:5,min:1,max:2}],search:{algorithm:'axis-covered-seeded-grid-v1',seed:7,requested_budget:100,planned_candidates:100,grid_combinations:105}},
      dataset:{market:item.market,start_time:T0,end_time:T0+60000,warmup_bars:300,bar_count:1000,digest_kind:'ql3a-dataset-sha256-v1',digest:H('d'),timestamp_semantics:null,collection_cutoff:null,collection_source:null,binding_sha256:null},
      engine:{engine_hash:H('e'),engine_family:'LEGACY',execution_backend:null,contract_version:'ql3a-research-job-v1'},
      cost_policy:{model:{version:'paper-close-v1',fee_bps:10,slippage_bps:1,risk_percent:1},cost_stress:'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE',policy_hash:H('c'),capital:{equity:'1000',cash:'1000'},ledger_initialization:'Independent historical flat Paper simulation.'},
      validation:{split:{warmup:300,train_end:720,validation_end:860,test_end:1000},rules:{minimum_closed_trades_train:5},max_evaluations:111,acceptance_blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED'],
        holdout_window:{start_time:T0+860*60000,end_time:T0+999*60000}},foundation:null},
    integrity:{contract_hash:H('1'),contract_hash_verified:!warnings.includes('CONTRACT_HASH_MISMATCH'),result_sha256:H('2'),steps_count:100,steps_digest:H('3'),
      report_matches_checkpoints:!warnings.includes('CHECKPOINT_MISMATCH'),checkpoint_problems:warnings.includes('CHECKPOINT_MISMATCH')?['SELECTED_MISMATCH']:[],
      foundation_binding_matches:null,identity_protection:'DB_TRIGGER',result_protection:'APPLICATION_ONLY',warnings},
    completeness:{result_present:true,candidates_planned:100,candidates_recorded:100,holdout_evaluated:false,missing:['NO_FOUNDATION_ROW']},
    limitations:{provenance_gaps:['NO_EFFECTIVE_INPUT_REVIEW_HASH','ENGINE_RELEASE_UNKNOWN','A_GAP_THE_PAGE_DOES_NOT_KNOW'],acceptance_blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED']},
    evaluation:{objective:{rule:'VALIDATION_NET_RETURN_THEN_DRAWDOWN_THEN_PARAMETERS',fixed_before_run:true,source:'ENGINE_CODE'},completion_reason:item.completion_reason,holdout_evaluated:false,
      dimension_coverage_percent:100,candidate_count:100,screen_passed:withScore?3:0,reason_counts:{INSUFFICIENT_VALIDATION_TRADES:97},development_score:bad?{value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'INTEGRITY_CHECK_FAILED'}:item.development_score,
      selected:withScore?{parameters:{rr:1.5,emaFastInput:30},train:metrics('4.1',9),validation:metrics('3.20',8),screen_reasons:[],sensitivity:[],cost_stress:null,test:null}:null,
      candidates:[{index:0,parameters:{rr:1,emaFastInput:30},train:metrics('-0.5',7),validation:metrics('0',0,'0'),screen_reasons:['INSUFFICIENT_VALIDATION_TRADES']}],candidates_truncated:false,stored_values_verified:!bad},
    qualification:{version:'library-qualification-v1',qualified:false,label:item.qualification.label,gates:[gate(0,'PASS'),gate(1,withScore?'PASS':'FAIL',withScore?null:'NO_SCREENED_CANDIDATE'),
      gate(2,withScore?'PASS':'NOT_REACHED'),gate(3,'FAIL','HOLDOUT_NOT_EVALUATED'),gate(4,'NOT_REACHED'),gate(5,'FAIL','ACCEPTANCE_BLOCKERS_PRESENT'),
      gate(6,'FAIL','OWNER_RECOMMENDATION_NOT_READY'),gate(7,'FAIL','QL4C_VALIDATION_NOT_AVAILABLE')],holdout_overlap:{checked:false,overlaps:null,run_ids:[]}},
    compatibility:{version:'library-compat-v1',key:H('k'),short_key:'kkkkkkkkkkkk',fields:{},missing:[]}};
}
const compareOk={version:'quant-library-compare-v1',verdict:'COMPATIBLE',mismatches:[],qualified_total:0,qualified_winner:null,runs:[
  {...listRun(2,{}),disclosed:{bot_id:'bot-1',deployment_id:'dep-1',baseline_snapshot_hash:H('f'),search:{algorithm:'axis-covered-seeded-grid-v1',seed:7,requested_budget:100,planned_candidates:100,grid_combinations:105},domains:[]},
    metrics:{candidates:{planned:100,evaluated:100,screen_passed:3},reason_counts:{},development_score:{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},selected:{parameters:{rr:1.5},train:metrics('4.1',9),validation:metrics('3.20',8)}},metrics_reason:null},
  {...listRun(5,{status:'FAILED',library_class:'FAILED',library_group:'FAILED',qualification:notEvaluated}),disclosed:{bot_id:'bot-1',deployment_id:'dep-1',baseline_snapshot_hash:H('f'),search:{algorithm:'axis-covered-seeded-grid-v1',seed:99,requested_budget:50,planned_candidates:50,grid_combinations:105},domains:[]},
    metrics:null,metrics_reason:'NOT_EVALUATED'}]};
const compareNo={version:'quant-library-compare-v1',verdict:'INCOMPATIBLE',qualified_total:0,qualified_winner:null,
  mismatches:[{field:'dataset',values:[{run_id:run(2).run_id,value:'{"bar_count":1000}'},{run_id:run(4).run_id,value:'{"bar_count":2000}'}]},{field:'engine',values:[{run_id:run(2).run_id,value:H('e')},{run_id:run(4).run_id,value:H('f')}]}],
  runs:[listRun(2,{}),listRun(4,{})]};

function setup({language,handler,journey=false}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[];
  w.api=async(path,options)=>{calls.push({path,options});return handler(path,options);};
  w.eval(publicFile('research-library.js'));
  if(journey)w.eval(publicFile('journey.js'));
  const panel=d.getElementById('qrlPanel');
  const open=async()=>{panel.open=true;panel.dispatchEvent(new w.Event('toggle'));await settle();};
  const text=()=>panel.textContent.replace(/\s+/g,' ').trim();
  const cards=()=>[...panel.querySelectorAll('.qrl-card')];
  const card=index=>panel.querySelector('.qrl-card[data-run$="'+index+'"]');
  const rows=element=>Object.fromEntries([...element.querySelectorAll('.qrl-ev .qrl-k')].map(key=>[key.textContent,key.nextElementSibling.textContent]));
  const click=element=>element.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  const pick=(index,on=true)=>{const box=card(index).querySelector('.qrl-pick');box.checked=on;box.dispatchEvent(new w.Event('change',{bubbles:true}));};
  return {dom,w,d,calls,panel,open,text,cards,card,rows,click,pick,close:()=>w.close()};
}
const router=(overrides={})=>path=>{
  const route=path.split('?')[0];
  if(Object.hasOwn(overrides,route)){const value=overrides[route];return typeof value==='function'?value(path):value;}
  if(route==='/api/quant/library')return libraryOf();
  if(route.startsWith('/api/quant/library/runs/')){const id=route.slice(-1);return detailOf(run(id));}
  if(route==='/api/quant/library/compare')return compareOk;
  throw Object.assign(new Error('unexpected '+path),{status:500,code:'UNEXPECTED'});
};
const apiError=(code,status=503)=>Object.assign(new Error(code||'Request failed'),{code,status});

test('index.html loads the library script before journey.js with its cache token; the panel is created closed on the Quant page with the fixed banner',()=>{
  const html=publicFile('index.html'),dom=new JSDOM(html),d=dom.window.document;
  try{
    const order=['/pine-bridge.js?v=','/readiness.js?v=','/research-library.js?v=rel20261007','/journey.js?v=pa1'].map(part=>html.indexOf(part));
    assert.ok(order.every(index=>index>=0)&&order.every((index,at)=>at===0||index>order[at-1]),'the library script loads after the Bridge panel and before journey.js');
    assert.ok(html.includes('/styles-v2.css?v=pa1')&&html.includes('/i18n.js?v=rel20261007'));
  }finally{dom.window.close();}
  const p=setup({handler:router()});
  try{
    const panel=p.panel;
    assert.ok(panel&&panel.tagName==='DETAILS'&&panel.classList.contains('panel')&&panel.open===false);
    assert.equal(panel.parentElement.getAttribute('data-page'),'quant');
    assert.equal(panel.querySelector('.qrl-summary').textContent,'Research Library');
    assert.equal(panel.querySelector('.qrl-banner').textContent,BANNER);assert.equal(panel.querySelector('.qrl-winner').textContent,WINNER);
    assert.equal(p.calls.length,0,'nothing is requested before the panel is opened');
    assert.equal(panel.querySelector('[style]'),null,'the CSP forbids inline styles');
  }finally{p.close();}
});

test('opening the panel loads the list once with a GET-only owner-scoped read; every run shows its class, raw status, score or reason, qualification and context key',async()=>{
  const p=setup({handler:router()});
  try{
    await p.open();
    assert.deepEqual(p.calls.map(call=>call.path),['/api/quant/library?limit=20']);
    assert.ok(p.calls.every(call=>call.options.silent===true&&call.options.botId===''&&call.options.method===undefined),'GET only, no bot_id scope, no Saved toast');
    p.panel.dispatchEvent(new p.w.Event('toggle'));await settle();assert.equal(p.calls.length,1,'toggling again loads nothing more');
    assert.equal(p.cards().length,9);
    assert.equal(p.panel.querySelector('.qrl-status').textContent,'9 runs in library');
    const classChip=index=>p.card(index).querySelector('.qrl-card-head .qrl-chip');
    const expected={1:['No valid candidate','info'],2:['Candidate pending acceptance','info'],3:['Insufficient evidence','warn'],4:['Insufficient data','warn'],5:['Failed','bad'],6:['Timed out','bad'],7:['Cancelled','muted'],8:['In progress','muted'],9:['No valid candidate','info']};
    for(const [index,[label,tone]] of Object.entries(expected)){
      assert.equal(classChip(index).textContent,label,'class of run '+index);assert.ok(classChip(index).classList.contains('qrl-'+tone),'tone of run '+index);
      assert.equal(p.card(index).querySelector('.qrl-status-raw').textContent,run(index).status,'raw status of run '+index);
    }
    const first=p.card(1),second=p.card(2),running=p.card(8);
    assert.deepEqual(p.rows(first),{'Candidates':'100 / 100','Development score':'— No screened candidate','Qualification':'Not qualified No screened candidate','Context key':'aaaaaaaaaaaa'});
    assert.equal(p.rows(second)['Development score'],'3.20');assert.equal(p.rows(second)['Qualification'],'Not qualified Development only');
    assert.equal(p.rows(running)['Candidates'],'40 / 100');assert.equal(p.rows(p.card(4))['Development score'],'— Not evaluated');
    assert.equal(first.querySelector('.qrl-time').textContent,utc(run(1).created_at));assert.equal(first.querySelector('.qrl-id').textContent,'3f2a9c1e');
    for(const card of p.cards()){
      assert.ok(card.textContent.includes('Development score: in-sample selection, not a recommendation'),'the score is always labelled next to the qualification');
      assert.equal(card.querySelector('.qrl-inspect').textContent,'Inspect');assert.equal(card.querySelector('input[type="checkbox"]').type,'checkbox');
      assert.ok(!/qualified winner|best|top run/i.test(card.textContent.replace('Not qualified','')),'no winner wording on a card');
    }
    assert.equal(p.panel.querySelector('.qrl-winner').textContent,WINNER);
  }finally{p.close();}
});

test('filter chips show the group counts and filter the loaded runs; Load more follows next_before and appends',async()=>{
  const first=RUNS.slice(0,5),rest=RUNS.slice(5);
  const p=setup({handler:router({'/api/quant/library':path=>path.includes('before=')?libraryOf(rest):libraryOf(first,{next_before:first.at(-1).created_at+':'+first.at(-1).run_id,totals:libraryOf().totals})})});
  try{
    await p.open();
    const chips=()=>[...p.panel.querySelectorAll('.qrl-filter')].map(button=>button.textContent.trim());
    assert.deepEqual(chips(),['All 9','Completed 3','Insufficient 2','Failed 2','Cancelled 1','In progress 1']);
    assert.equal(p.cards().length,5);assert.equal(p.panel.querySelector('.qrl-more').hidden,false);
    p.click(p.panel.querySelector('.qrl-more'));await settle();
    assert.deepEqual(p.calls.map(call=>call.path),['/api/quant/library?limit=20','/api/quant/library?limit=20&before='+encodeURIComponent(first.at(-1).created_at+':'+first.at(-1).run_id)]);
    assert.equal(p.cards().length,9);assert.equal(p.panel.querySelector('.qrl-more').hidden,true,'no next cursor, no button');
    const group=name=>p.panel.querySelector('.qrl-filter[data-group="'+name+'"]');
    for(const [name,count] of [['COMPLETED',3],['INSUFFICIENT',2],['FAILED',2],['CANCELLED',1],['ACTIVE',1],['ALL',9]]){
      p.click(group(name));assert.equal(p.cards().length,count,name);assert.equal(group(name).getAttribute('aria-pressed'),'true');
    }
    p.click(group('COMPLETED'));assert.deepEqual(p.cards().map(card=>card.querySelector('.qrl-card-head .qrl-chip').textContent),['No valid candidate','Candidate pending acceptance','No valid candidate'].reverse());
    assert.equal(p.calls.length,2,'filters work on the loaded runs and request nothing');
  }finally{p.close();}
});

test('compare selection: two to four runs; another context is only hinted and the server verdict is final; a compatible comparison lists metrics without ranking',async()=>{
  const p=setup({handler:router()});
  try{
    await p.open();
    const button=()=>p.panel.querySelector('.qrl-compare'),box=index=>p.card(index).querySelector('.qrl-pick');
    assert.equal(button().textContent,'Compare selected');assert.equal(button().disabled,true,'no run selected');
    p.pick(2);assert.equal(button().disabled,true,'one run is not a comparison');assert.equal(p.panel.querySelector('.qrl-selected').textContent,'1 selected');
    assert.deepEqual([...p.panel.querySelectorAll('.qrl-ctx')].map(item=>item.closest('.qrl-card').dataset.run.slice(-1)).sort(),['4','9'],'runs of another context are hinted, not blocked');
    assert.equal(p.panel.querySelector('.qrl-ctx').textContent,'Different context');assert.equal(box(4).disabled,false);
    p.pick(5);assert.equal(button().disabled,false,'two runs');
    p.pick(1);p.pick(3);assert.equal(p.panel.querySelector('.qrl-selected').textContent,'4 selected');
    assert.equal(box(6).disabled,true,'a fifth run cannot be selected');assert.equal(box(1).disabled,false,'selected runs stay unselectable');
    p.pick(3,false);assert.equal(box(6).disabled,false);assert.equal(p.panel.querySelector('.qrl-selected').textContent,'3 selected');
    p.click(button());await settle();
    const path=p.calls.at(-1).path;
    assert.equal(path,'/api/quant/library/compare?'+[2,5,1].map(i=>'run_id='+run(i).run_id).join('&'));assert.ok(p.calls.at(-1).options.method===undefined);
    const view=p.panel.querySelector('.qrl-compare-view');
    assert.equal(view.hidden,false);assert.equal(view.querySelector('.qrl-title').textContent,'Comparison');
    assert.equal(view.querySelector('.qrl-winner').textContent,WINNER);
    const table=view.querySelector('table');assert.ok(table.closest('.qrl-scroll'),'the table scrolls inside its wrapper');
    const headers=[...table.querySelectorAll('thead th')].map(cell=>cell.textContent);assert.deepEqual(headers,['Metric','3f2a9c1e','3f2a9c1e']);
    const line=name=>[...table.querySelectorAll('tbody tr')].find(tr=>tr.querySelector('th').textContent===name);
    assert.deepEqual([...line('Development score').querySelectorAll('td')].map(cell=>cell.textContent),['3.20','— Not evaluated']);
    assert.deepEqual([...line('Validation return %').querySelectorAll('td')].map(cell=>cell.textContent),['3.20','—']);
    assert.deepEqual([...line('Seed').querySelectorAll('td')].map(cell=>cell.textContent),['7','99'],'the search configuration is disclosed');
    assert.deepEqual([...line('Created (UTC)').querySelectorAll('td')].map(cell=>cell.textContent),[utc(run(2).created_at),utc(run(5).created_at)]);
    assert.ok(!/best|top|winner|rank/i.test(view.textContent.replace(WINNER,'').replace('no run is ranked','')),'no ranking wording');
    assert.ok(view.textContent.includes('no run is ranked'));
  }finally{p.close();}
});

test('an incomparable pair shows Not comparable with the differing fields and no metrics; each run stays inspectable',async()=>{
  const p=setup({handler:router({'/api/quant/library/compare':compareNo})});
  try{
    await p.open();p.pick(2);p.pick(4);
    p.click(p.panel.querySelector('.qrl-compare'));await settle();
    const view=p.panel.querySelector('.qrl-compare-view');
    assert.equal(view.querySelector('.qrl-title').textContent,'Not comparable');
    assert.deepEqual([...view.querySelectorAll('.qrl-sub')].map(item=>item.textContent),['Dataset','Engine']);
    assert.ok(view.textContent.includes('{"bar_count":1000}')&&view.textContent.includes('{"bar_count":2000}'));assert.ok(view.textContent.includes('3f2a9c1e'));
    assert.equal(view.querySelectorAll('table').length,1,'only the identity table');
    assert.ok(!view.textContent.includes('Development score')&&!view.textContent.includes('Validation return'),'no metrics for an incomparable pair');
    assert.ok(view.textContent.includes('These runs differ in a fixed context field, so no metrics are compared.'));assert.equal(view.querySelector('.qrl-winner').textContent,WINNER);
    p.click(view.querySelector('.qrl-back'));assert.equal(view.hidden,true,'back to the list');assert.equal(p.cards().length,9);
    const failing=setup({handler:router({'/api/quant/library/compare':()=>{throw apiError('NOT_FOUND',404);}})});
    try{await failing.open();failing.pick(2);failing.pick(5);failing.click(failing.panel.querySelector('.qrl-compare'));await settle();
      assert.equal(failing.panel.querySelector('.qrl-compare-view .qrl-error').textContent,'Not available (NOT_FOUND)');}finally{failing.close();}
  }finally{p.close();}
});

test('Inspect opens the run: outcome, provenance, integrity, gaps, candidates and qualification gates; unknown codes are shown raw; tables scroll inside their wrapper',async()=>{
  const p=setup({handler:router()});
  try{
    await p.open();
    p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    assert.equal(p.calls.at(-1).path,'/api/quant/library/runs/'+run(2).run_id);
    const view=p.panel.querySelector('.qrl-detail-view');
    assert.equal(view.hidden,false);assert.equal(view.querySelector('.qrl-title').textContent.replace('Research run ','').slice(0,8),'3f2a9c1e');
    const sections=[...view.querySelectorAll('.qrl-sec')].map(item=>item.querySelector('.qrl-sec-title').textContent);
    assert.deepEqual(sections,['Outcome','Provenance','Integrity','Gaps','All candidates','Qualification gates']);
    const outcome=p.rows(view.querySelector('.qrl-sec'));
    assert.equal(outcome['Status'],'SUCCEEDED');assert.equal(outcome['Completion reason'],'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');assert.equal(outcome['Development score'],'3.20');
    assert.equal(outcome['Qualification'],'Not qualified Development only');assert.equal(outcome['Created (UTC)'],utc(run(2).created_at));assert.equal(outcome['Finished (UTC)'],utc(run(2).finished_at));
    assert.equal(outcome['Candidates'],'100 evaluated, 3 passed screening');assert.equal(outcome['Selected parameters'],'rr=1.5, emaFastInput=30');
    assert.equal(outcome['Selected validation'],'3.20 % return, 8 trades, 1.5 % drawdown');
    const all=p.rows(view);
    assert.equal(all['Source hash'],H('a'));assert.equal(all['Engine hash'],H('e'));assert.equal(all['Contract hash'],H('1')+' Verified');assert.equal(all['Report matches checkpoints'],'Yes');
    assert.equal(all['Result protection'],'APPLICATION_ONLY');assert.equal(all['Dataset hash'],H('d'));assert.equal(all['Policy hash'],H('c'));
    const gaps=[...view.querySelectorAll('.qrl-gap')].map(item=>item.textContent);
    assert.ok(gaps.includes('NO_EFFECTIVE_INPUT_REVIEW_HASH The run does not record a hash of the reviewed effective inputs.'));
    assert.ok(gaps.some(item=>item.trim()==='A_GAP_THE_PAGE_DOES_NOT_KNOW'),'an unknown gap code is shown raw, with no invented meaning');assert.ok(gaps.some(item=>item.startsWith('NO_FOUNDATION_ROW')));
    const gateRows=[...view.querySelectorAll('.qrl-sec:last-child tbody tr')].map(tr=>[...tr.children].map(cell=>cell.textContent));
    assert.equal(gateRows.length,8);assert.deepEqual(gateRows[0],['G1','Completed evaluation','Pass','—']);assert.deepEqual(gateRows[4],['G5','Holdout independent','Not reached','—']);
    assert.deepEqual(gateRows[7],['G8','QL-4C validation','Fail','QL4C_VALIDATION_NOT_AVAILABLE']);
    assert.equal(view.querySelector('.qrl-sec:last-child .qrl-winner').textContent,WINNER);
    for(const table of view.querySelectorAll('table'))assert.ok(table.closest('.qrl-scroll'),'every table sits in a scrolling wrapper');
    assert.equal(view.querySelector('.qrl-alert'),null,'no integrity warning for a verified run');
    assert.equal(view.querySelector('.qrl-sec').open,true);assert.equal(view.querySelectorAll('.qrl-sec')[1].open,false,'provenance is collapsed until opened');
    p.click(view.querySelector('.qrl-back'));assert.equal(view.hidden,true);
  }finally{p.close();}
});

test('a failed integrity check shows an alert and no development score; a run without a screened candidate says so; errors read Not available with their code',async()=>{
  const p=setup({handler:router()});
  p.w.api=async(path,options)=>{
    p.calls.push({path,options});const id=path.slice(-1);
    if(path.startsWith('/api/quant/library/runs/')){
      if(id==='2')return detailOf(run(2),{warnings:['CHECKPOINT_MISMATCH']});
      if(id==='1')return detailOf(run(1),{withScore:false});
      throw apiError('NOT_FOUND',404);
    }
    return libraryOf();
  };
  try{
    await p.open();
    p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    const view=p.panel.querySelector('.qrl-detail-view'),alert=view.querySelector('.qrl-alert');
    assert.ok(alert&&alert.textContent.startsWith('Integrity check failed.')&&alert.getAttribute('role')==='alert');
    assert.equal(p.rows(view)['Development score'],'— Integrity check failed');
    assert.equal(p.rows(view)['Warnings'],'CHECKPOINT_MISMATCH');assert.equal(view.querySelectorAll('.qrl-sec')[2].open,true,'the integrity section opens when it holds a warning');
    p.click(p.card(1).querySelector('.qrl-inspect'));await settle();
    assert.equal(p.rows(view)['Selected parameters'],'No screened candidate');assert.equal(p.rows(view)['Development score'],'— No screened candidate');
    p.click(p.card(3).querySelector('.qrl-inspect'));await settle();
    assert.equal(view.querySelector('.qrl-error').textContent,'Not available (NOT_FOUND)');assert.equal(view.querySelectorAll('.qrl-sec').length,0);
  }finally{p.close();}
});

test('list states: checking, an API failure, an empty library and missing research tables are explicit, and the banner and the winner line stay',async()=>{
  const checking=setup({handler:()=>new Promise(()=>{})});
  try{await checking.open();assert.equal(checking.panel.querySelector('.qrl-status').textContent,'Checking…');assert.equal(checking.cards().length,0);}finally{checking.close();}
  const empty=libraryOf([],{totals:{all:0,ACTIVE:0,COMPLETED:0,INSUFFICIENT:0,FAILED:0,CANCELLED:0}});
  const states=[
    ['failure',()=>{throw apiError('QUANT_LIBRARY_UNAVAILABLE',503);},'Not available (QUANT_LIBRARY_UNAVAILABLE)'],
    ['network',()=>{throw new TypeError('Failed to fetch');},'Not available (REQUEST_FAILED)'],
    ['http',()=>{throw Object.assign(new Error('x'),{status:502});},'Not available (HTTP_502)'],
    ['empty',()=>empty,'No research runs in the library yet.'],
    ['no tables',()=>({...empty,schema_present:false}),'The research tables are not installed on this release.']];
  for(const [name,handler,message] of states){
    const p=setup({handler});
    try{
      await p.open();
      assert.equal(p.panel.querySelector('.qrl-status').textContent,message,name);
      assert.equal(p.panel.querySelector('.qrl-banner').textContent,BANNER,name);assert.equal(p.panel.querySelector('.qrl-winner').textContent,WINNER,name);
    }finally{p.close();}
  }
});

test('Thai switch translates the panel, the list, the detail and both comparison views; English restores them; codes, hashes and values are never translated',async()=>{
  const p=setup({language:'th',handler:router()});
  try{
    const {d,w}=p;
    assert.equal(p.panel.querySelector('.qrl-summary').textContent,'คลังผลการวิจัย');
    assert.equal(p.panel.querySelector('.qrl-banner').textContent,w.translate(BANNER));assert.notEqual(w.translate(BANNER),BANNER);
    assert.equal(p.panel.querySelector('.qrl-winner').textContent,'ผลที่ผ่านเกณฑ์และแนะนำได้: ไม่มี ยังไม่มีผลที่ผ่านเกณฑ์');
    await p.open();
    assert.equal(p.panel.querySelector('.qrl-status').textContent,'มี 9 การรันในคลัง');
    assert.equal(p.card(1).querySelector('.qrl-card-head .qrl-chip').textContent,'ไม่มี Candidate ที่ใช้ได้');assert.equal(p.card(3).querySelector('.qrl-card-head .qrl-chip').textContent,'หลักฐานไม่เพียงพอ');
    assert.equal(p.card(1).querySelector('.qrl-status-raw').textContent,'NO_VALID_CANDIDATE','the raw status is data and stays as it is');
    assert.equal(p.rows(p.card(2))['คะแนนช่วงพัฒนา'],'3.20');assert.equal(p.rows(p.card(2))['การผ่านเกณฑ์'],'ยังไม่ผ่านเกณฑ์ ใช้ในช่วงพัฒนาเท่านั้น');
    assert.equal(p.rows(p.card(1))['คะแนนช่วงพัฒนา'],'— ไม่มี Candidate ที่ผ่านการคัดกรอง');
    assert.deepEqual([...p.panel.querySelectorAll('.qrl-filter')].map(button=>button.textContent.trim()),['ทั้งหมด 9','เสร็จสมบูรณ์ 3','ไม่เพียงพอ 2','ล้มเหลว 2','ยกเลิกแล้ว 1','กำลังดำเนินการ 1']);
    p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    const view=p.panel.querySelector('.qrl-detail-view');
    assert.deepEqual([...view.querySelectorAll('.qrl-sec-title')].map(item=>item.textContent),['ผลลัพธ์','ที่มา','ความถูกต้องครบถ้วนของข้อมูล','ช่องว่างของข้อมูล','Candidate ทั้งหมด','ด่านการผ่านเกณฑ์']);
    assert.equal(view.querySelector('.qrl-sec:last-child tbody tr:last-child').textContent,'G8การตรวจสอบ QL-4Cไม่ผ่านQL4C_VALIDATION_NOT_AVAILABLE');
    p.click(view.querySelector('.qrl-back'));
    p.pick(2);p.pick(4);p.click(p.panel.querySelector('.qrl-compare'));await settle();
    assert.equal(p.panel.querySelector('.qrl-compare-view .qrl-title').textContent,'การเปรียบเทียบ');
    const language=d.querySelector('#language');
    language.value='en';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(p.panel.querySelector('.qrl-banner').textContent,BANNER);assert.equal(p.panel.querySelector('.qrl-status').textContent,'9 runs in library');
    assert.equal(p.card(1).querySelector('.qrl-card-head .qrl-chip').textContent,'No valid candidate');assert.equal(p.panel.querySelector('.qrl-compare-view .qrl-title').textContent,'Comparison');
    language.value='th';language.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(p.panel.querySelector('.qrl-status').textContent,'มี 9 การรันในคลัง');
    for(const element of p.panel.querySelectorAll('[data-ui-label]')){const text=element.dataset.uiLabel;assert.equal(element.textContent,w.translate(text),text);}
  }finally{p.close();}
});

test('the Thai comparison of an incomparable pair names the fields in Thai while their values stay as stored',async()=>{
  const p=setup({language:'th',handler:router({'/api/quant/library/compare':compareNo})});
  try{
    await p.open();p.pick(2);p.pick(4);p.click(p.panel.querySelector('.qrl-compare'));await settle();
    const view=p.panel.querySelector('.qrl-compare-view');
    assert.equal(view.querySelector('.qrl-title').textContent,'เปรียบเทียบไม่ได้');
    assert.deepEqual([...view.querySelectorAll('.qrl-sub')].map(item=>item.textContent),['ชุดข้อมูล','เอนจิน']);
    assert.ok(view.textContent.includes('{"bar_count":1000}')&&view.textContent.includes(H('e')));
  }finally{p.close();}
});

test('hostile API text is shown as text; source, contract, step payload, lease and worker fields are never rendered; logout clears the panel',async()=>{
  const hostile=listRun(1,{diagnostic:'<img src=x onerror=alert(1)>',status:'<script>boom()</script>',source:'//@version=6 SECRET_SOURCE',contract:{bars:['BAR_SECRET']},steps:[{result:'STEP_PAYLOAD'}],lease_token:'LEASE_SECRET',worker_id:'WORKER_SECRET'});
  const detail=detailOf(hostile);detail.run.diagnostic='<b onmouseover=bad()>x</b>';detail.limitations.provenance_gaps=['<i>raw</i>'];detail.provenance.source.scope='<u>scope</u>';
  const p=setup({handler:router({'/api/quant/library':libraryOf([hostile]),['/api/quant/library/runs/'+hostile.run_id]:detail})});
  try{
    await p.open();p.click(p.card(1).querySelector('.qrl-inspect'));await settle();
    assert.equal(p.panel.querySelectorAll('img,script,b,i,u,iframe,a').length,0);assert.equal(p.panel.querySelector('[onerror],[onmouseover],[style]'),null);
    assert.ok(p.panel.textContent.includes('<img src=x onerror=alert(1)>')||p.panel.textContent.includes('<script>boom()</script>'));
    assert.ok(p.panel.textContent.includes('<b onmouseover=bad()>x</b>')&&p.panel.textContent.includes('<i>raw</i>')&&p.panel.textContent.includes('<u>scope</u>'));
    assert.doesNotMatch(p.panel.textContent,/SECRET_SOURCE|BAR_SECRET|STEP_PAYLOAD|LEASE_SECRET|WORKER_SECRET/);
    p.d.querySelector('#logout').click();await settle();
    assert.equal(p.cards().length,0);assert.equal(p.panel.querySelector('.qrl-detail-view').hidden,true);assert.equal(p.panel.querySelector('.qrl-detail-view').textContent,'');
    assert.equal(p.panel.querySelector('.qrl-selected').textContent,'');assert.equal(p.panel.querySelector('.qrl-winner').textContent,WINNER);
  }finally{p.close();}
});

// Journey step 6 with the real library panel on the same page.
const JOURNEY_ROUTES={'/api/bots':{bots:[],maxBots:5},'/api/quant/pine-bridge/overview':{bridge_enabled:false},'/api/quant/research/history':{admission_enabled:false,total_runs:0,runs:[]}};
const journeyHandler=(library=libraryOf())=>path=>{const route=path.split('?')[0];if(route==='/api/quant/library')return library;if(Object.hasOwn(JOURNEY_ROUTES,route))return JOURNEY_ROUTES[route];throw apiError('UNEXPECTED',500);};

test('journey step 6: the Open button shows the Quant page, opens the library panel and asks it to reveal itself; the card reads the library, never a winner',async()=>{
  const p=setup({handler:journeyHandler(),journey:true});
  try{
    const {d,w}=p,clicked=[];
    d.querySelectorAll('#primaryNav button').forEach(button=>button.addEventListener('click',()=>clicked.push(button.dataset.view)));
    const requests=[];p.panel.addEventListener('qrl:reveal',event=>{requests.push({cancelable:event.cancelable,open:p.panel.open});});
    let scrolled=0;p.panel.scrollIntoView=()=>{scrolled++;};
    d.querySelector('nav button[data-view="journey"]').click();await settle();
    const card=d.querySelector('.jr-card[data-step="6"]');
    assert.equal(card.querySelector('.jr-chip').textContent,'Inspection only');assert.ok(card.querySelector('.jr-chip').classList.contains('jr-ok'));
    assert.deepEqual([...card.querySelectorAll('.jr-note')].map(item=>item.textContent),['9 runs in library',WINNER]);
    assert.equal(card.querySelector('.jr-v').textContent,'Completed 3 · Insufficient 2 · Failed 2 · Cancelled 1 · In progress 1');
    assert.ok(!/best|top|winner/i.test(card.textContent.replace(WINNER,'').replace('no qualified winner exists','')),'no winner wording on the journey card');
    assert.deepEqual(p.calls.map(call=>call.path).filter(path=>path.includes('library')),['/api/quant/library?limit=5']);
    clicked.length=0;p.panel.open=false;
    card.querySelector('button.jr-open').click();await settle();
    assert.deepEqual(clicked,['quant']);assert.equal(p.panel.open,true);
    assert.deepEqual(requests,[{cancelable:true,open:true}],'the panel is open when it is asked to reveal');
    assert.equal(scrolled,1,'the panel scrolls itself; the journey page does not scroll it again');
    assert.deepEqual(p.calls.map(call=>call.path).filter(path=>path.includes('library')),['/api/quant/library?limit=5','/api/quant/library?limit=20'],'the panel loads its list when revealed');
    assert.equal(p.cards().length,9);
    for(const n of [1,2,3,4,5]){p.panel.open=false;d.querySelector('.jr-card[data-step="'+n+'"] button.jr-open').click();assert.equal(p.panel.open,false,'step '+n+' leaves the library panel closed');}
  }finally{p.close();}
});

test('journey step 6 falls back to a plain scroll when nothing handles the reveal, and does nothing when the panel is absent',()=>{
  const bare=setup({handler:journeyHandler()});
  try{
    bare.w.eval(publicFile('journey.js'));
    const scrolled=[];
    bare.panel.scrollIntoView=options=>scrolled.push(options);
    const replacement=bare.panel.cloneNode(true);replacement.id='qrlPanel';bare.panel.replaceWith(replacement);replacement.scrollIntoView=options=>scrolled.push(options);
    bare.d.querySelector('.jr-card[data-step="6"] button.jr-open').click();
    assert.equal(replacement.open,true);assert.equal(JSON.stringify(scrolled),'[{"block":"start"}]','nothing handled the reveal, so the whole panel scrolls into view');
    replacement.remove();
    bare.d.querySelector('.jr-card[data-step="6"] button.jr-open').click();
  }finally{bare.close();}
});

test('journey step 6 shows an unavailable library as Unavailable with its code, and the Thai card follows the language',async()=>{
  const failing=setup({handler:path=>{if(path.startsWith('/api/quant/library'))throw apiError('QUANT_LIBRARY_UNAVAILABLE',503);return journeyHandler()(path);},journey:true});
  try{
    failing.d.querySelector('nav button[data-view="journey"]').click();await settle();
    const card=failing.d.querySelector('.jr-card[data-step="6"]');
    assert.equal(card.querySelector('.jr-chip').textContent,'Unavailable');assert.equal(card.querySelector('.jr-ev-error').textContent,'Not available (QUANT_LIBRARY_UNAVAILABLE)');
  }finally{failing.close();}
  const thai=setup({language:'th',handler:journeyHandler(),journey:true});
  try{
    thai.d.querySelector('nav button[data-view="journey"]').click();await settle();
    const card=thai.d.querySelector('.jr-card[data-step="6"]');
    assert.equal(card.querySelector('.jr-chip').textContent,'ใช้ตรวจดูเท่านั้น');
    assert.equal(card.querySelector('.jr-block p').textContent,thai.w.translate('Research Library lists every preserved run with provenance, including failed, insufficient and cancelled runs. Development scores are not recommendations; no qualified winner exists.'));
    assert.equal(card.querySelector('.jr-v').textContent,'เสร็จสมบูรณ์ 3 · ไม่เพียงพอ 2 · ล้มเหลว 2 · ยกเลิกแล้ว 1 · กำลังดำเนินการ 1');
    assert.match(card.textContent,/ผลที่ผ่านเกณฑ์และแนะนำได้: ไม่มี ยังไม่มีผลที่ผ่านเกณฑ์/);
  }finally{thai.close();}
});

// Patterns are written with ~ for the backslash so that no escape sequence depends on how this file was produced.
const re=(source,flags)=>new RegExp(source.split('~').join(String.fromCharCode(92)),flags);
const CALLS=re("~b(?:label|row|note|chip|block|section|T|tpl|known)~(~s*'([^'~n]*)'",'g');
const TABLE_VALUES=re("~b[A-Z_]+:'([^'~n]*)'",'g'),PAIRS=re("~['[A-Z_]+','([^'~n]*)'~]",'g'),TABLES=re("table~(~[([^~]]*)~]",'g');
const QUOTED=re("'([^'~n]*)'",'g'),TEXTS=re("~b(?:now|next):~s*'([^'~n]*)'",'g'),HOLDERS=re('{(~w+)}','g');

test('Research Library translations are complete, unique, free of collisions, keep their placeholders and are all used',()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.localStorage.setItem('robotLanguage','th');
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=qr1Pairs;');
    const library=publicFile('research-library.js'),journey=publicFile('journey.js');
    const literals=new Set([BANNER,WINNER]);
    for(const source of [library,journey])for(const match of source.matchAll(CALLS))literals.add(match[1]);
    for(const match of library.matchAll(TABLE_VALUES))literals.add(match[1]);
    for(const match of library.matchAll(PAIRS))literals.add(match[1]);
    for(const match of library.matchAll(TABLES))for(const head of match[1].matchAll(QUOTED))literals.add(head[1]);
    for(const match of journey.matchAll(TEXTS))literals.add(match[1]);
    assert.ok(literals.size>100,'literal extraction found the static strings: '+literals.size);
    for(const text of literals)if(/[A-Za-z]{3}/.test(text)&&!/^[A-Z_0-9]+$/.test(text)&&!/^[a-z]+$/.test(text)&&text!=='AI chatbot Bridge')assert.notEqual(w.translate(text),text,'missing Thai: '+text);
    const mine=[...w.__mine],others=w.__pairs.filter(pair=>!w.__mine.includes(pair));
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.ok(mine.length>140);assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){
      assert.notEqual(en,th);assert.ok(library.includes("'"+en+"'")||journey.includes("'"+en+"'"),'pair for text no longer shown: '+en);
      assert.deepEqual([...en.matchAll(HOLDERS)].map(m=>m[1]).sort(),[...th.matchAll(HOLDERS)].map(m=>m[1]).sort(),'placeholders differ: '+en);
    }
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
  }finally{w.close();}
});

const PATHS=re("'(~/api~/[^']*)'",'g'),API_CALLS='=>api(path,';
const FORBIDDEN=re('~b(apply|start|run|export|save|best|top|winner|download|delete|submit)~b','i');

test('research-library.js stays read-only, self-contained and CSP-safe: GET only, one api() call site, no apply, start, export or save control',async()=>{
  const source=publicFile('research-library.js');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket','localStorage','sessionStorage','.style','http://','https://','onclick=','method:',"'POST'","'PUT'","'DELETE'"])
    assert.ok(!source.includes(banned),'forbidden in research-library.js: '+banned);
  assert.deepEqual([...source.matchAll(PATHS)].map(match=>match[1]).sort(),['/api/quant/library/compare?','/api/quant/library/runs/','/api/quant/library?limit=']);
  assert.equal(source.split(API_CALLS).length-1,1,'a single api() call site');
  // Every control that can exist on the page, in every view.
  const p=setup({handler:router()});
  try{
    await p.open();p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    p.click(p.panel.querySelector('.qrl-back'));p.pick(2);p.pick(5);p.click(p.panel.querySelector('.qrl-compare'));await settle();
    const controls=[...p.panel.querySelectorAll('button,input,select,textarea,a,[role="button"]')];
    assert.ok(controls.length>20);
    for(const control of controls){
      assert.ok(['BUTTON','INPUT'].includes(control.tagName),'only buttons and checkboxes: '+control.tagName);
      if(control.tagName==='INPUT')assert.equal(control.type,'checkbox');
      if(control.tagName==='BUTTON'){assert.equal(control.type,'button','no submit button');assert.ok(!FORBIDDEN.test(control.textContent),'forbidden control label: '+control.textContent);}
    }
    assert.equal(p.panel.querySelectorAll('form').length,0);
    assert.ok(p.calls.every(call=>call.options.method===undefined&&call.path.startsWith('/api/quant/library')),'GET requests to the library only');
    const words=p.panel.textContent.split(WINNER).join('').split('not a recommendation').join('').split('are not recommendations').join('').split('no run is ranked').join('');
    assert.ok(!re('~b(best|top|winner|ranked|recommended)~b','i').test(words),'no best, top or winner wording outside the fixed no-winner statements');
  }finally{p.close();}
});

test('library styles: the block sits above the PF-4, Guided Build, journey and PF-3 blocks; cards shrink, long text wraps, tables scroll inside their wrapper, touch targets are 44px, one column on phones',()=>{
  const css=publicFile('styles-v2.css'),at=css.indexOf('/* Quant Research Library (P1-E)'),end=css.indexOf('/* PF-4 Risk proposals');
  assert.ok(at>0&&end>at,'the block sits above the PF-4 block');
  for(const marker of ['/* Guided Build Pine Bridge panel','/* Prototype journey','/* PF-3 readiness report'])assert.ok(css.indexOf(marker)>end,marker+' follows the library block, outside its tail slice');
  const block=css.slice(at,end);
  const rule=selector=>{const index=block.indexOf(selector+'{');assert.ok(index>=0,'missing rule '+selector);return block.slice(index,block.indexOf('}',index));};
  for(const selector of ['.qrl','.qrl-toolbar','.qrl-chips','.qrl-list','.qrl-card','.qrl-card-head','.qrl-v','.qrl-view','.qrl-sec','.qrl-block','.qrl-gap'])assert.ok(rule(selector).includes('min-width:0'),selector+' may shrink');
  for(const selector of ['.qrl-banner','.qrl-winner','.qrl-status','.qrl-note','.qrl-v','.qrl-title','.qrl-alert','.qrl-gap','.qrl-chip','.qrl-ctx'])assert.ok(rule(selector).includes('overflow-wrap:anywhere'),selector+' wraps long text');
  assert.ok(rule('.qrl-code,.qrl-hash,.qrl-status-raw').includes('word-break:break-all'),'long hashes break');
  assert.ok(rule('.qrl-scroll').includes('overflow-x:auto')&&rule('.qrl-scroll').includes('max-width:100%'),'a wide table scrolls inside itself');
  assert.ok(rule('.qrl-table th,.qrl-table td').includes('white-space:nowrap'),'table cells keep their numbers whole inside the scrolling wrapper');
  for(const selector of ['.qrl-filter,.qrl-refresh,.qrl-more,.qrl-compare,.qrl-inspect,.qrl-back','.qrl-summary','.qrl-sec-title','.qrl-pick-label'])assert.ok(rule(selector).includes('min-height:44px'),selector+' is a 44px touch target');
  assert.ok(rule('.qrl-list').includes('minmax(min(100%,320px),1fr)'),'cards never need more than the viewport width');
  assert.ok(block.includes('@media(max-width:600px){.qrl-list{grid-template-columns:minmax(0,1fr)}'),'single column on phones');
  assert.ok(!block.includes('[hidden]'),'no rule overrides a hidden attribute');assert.ok(!re('(^|[^-])width:~d{3,}px').test(block),'no fixed width wider than a phone');
  assert.ok(!/min-width:[0-9]+px/.test(block),'no fixed minimum width');
  // The tail slices of the existing style tests stay clean.
  const tail=css.slice(css.indexOf('/* Prototype journey'));
  assert.ok(!tail.includes('.qrl'));
});

// ---- P1-E1b: UI defects D1 to D5 found by the independent tester ----
const textNodes=(w,root)=>{const out=[],walker=w.document.createTreeWalker(root,w.NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode())out.push(node.data);return out;};
const BAD_WORD=new RegExp('(^|[^A-Za-z_])(null|undefined|NaN)([^A-Za-z_]|$)');
const assertClean=(p,name)=>{
  for(const data of textNodes(p.w,p.panel))assert.ok(!['null','undefined','NaN'].includes(data.trim()),name+': a text node reads '+data.trim());
  const found=BAD_WORD.exec(p.panel.textContent);
  assert.equal(found,null,name+': the panel text holds '+(found&&found[2]));
  assert.ok(!p.panel.textContent.includes('[object Object]'),name+': an object was printed');
};
const fullDetail=()=>{
  const body=detailOf(run(2));
  body.provenance.foundation={job_id:'job-1',status:'SUCCEEDED',attempts:1,runtime_used_ms:1200,stop_reason:null,diagnostic:null,created_at:T0,deadline_at:T0+900000,budget:{candidates:100,max_evaluations:111},
    dataset_metadata:{venue:'binance-global',cutoff:T0+60000},dataset_binding:{dataset_sha256:H('9')},chunk_rows:1};
  body.provenance.dataset.collection_cutoff=T0+60000;body.provenance.dataset.binding_sha256=H('9');
  body.evaluation.holdout_evaluated=true;body.evaluation.selected.test=metrics('1.9',9);
  body.evaluation.selected.sensitivity=[{dimension:'rr',parameters:{rr:2},train:metrics('1',9),validation:metrics('2.9',8)}];
  body.evaluation.selected.cost_stress={train:metrics('3.5',9),validation:metrics('2.4',8)};
  body.qualification.holdout_overlap={checked:true,overlaps:true,run_ids:[run(1).run_id]};
  return body;
};
const sparseDetail=()=>{
  const body=detailOf(run(5),{withScore:false});
  Object.assign(body.evaluation,{completion_reason:null,holdout_evaluated:null,dimension_coverage_percent:null,candidate_count:null,screen_passed:null,reason_counts:null,selected:null,candidates:[]});
  body.evaluation.development_score={value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'NOT_EVALUATED'};
  Object.assign(body.provenance.source,{scope:null,source_hash:null,baseline_snapshot_hash:null,pine_import_id:null,source_version:null,membership:[]});
  Object.assign(body.provenance.input,{lock_hash:null,signals:null,bridge:null,bindings:[],fixed_inputs_count:null,domains:[{dimension:'rr'}],search:null});
  Object.assign(body.provenance.dataset,{market:null,start_time:null,end_time:null,warmup_bars:null,bar_count:null,digest_kind:null,digest:null});
  Object.assign(body.provenance.engine,{engine_hash:null,engine_family:null,contract_version:null});
  body.provenance.cost_policy={model:null,policy_hash:null,capital:null,ledger_initialization:null};
  body.provenance.validation={split:null,rules:null,max_evaluations:null,acceptance_blockers:[],holdout_window:null};
  Object.assign(body.integrity,{result_sha256:null,steps_count:0,report_matches_checkpoints:null,checkpoint_problems:[]});
  body.completeness={result_present:false,candidates_planned:null,candidates_recorded:0,holdout_evaluated:null,missing:[]};
  body.limitations={provenance_gaps:[],acceptance_blockers:[]};body.qualification.gates.forEach(gate=>{gate.code=null;});
  // The leanest answer: optional keys absent altogether.
  delete body.evaluation.candidates_truncated;delete body.provenance.foundation;delete body.run.deadline;
  return body;
};
const tamperedDetail=()=>detailOf(run(2),{warnings:['CONTRACT_HASH_MISMATCH','CHECKPOINT_MISMATCH']});

test('D1: no text node reads null, undefined or NaN for full, sparse and tampered runs, a sparse list card and both comparison views',async()=>{
  const bodies={full:fullDetail(),sparse:sparseDetail(),tampered:tamperedDetail()};
  const sparseCard={run_id:'3f2a9c1e-0000-4000-8000-000000000007',status:'FAILED'};
  const p=setup({handler:router({'/api/quant/library':libraryOf([run(2),run(5),sparseCard])})});
  try{
    await p.open();assertClean(p,'list with a sparse card');
    assert.equal(p.cards().length,3);
    for(const [name,body] of Object.entries(bodies)){
      p.w.api=async path=>{p.calls.push({path});return path.startsWith('/api/quant/library/runs/')?body:libraryOf();};
      p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
      assert.equal(p.panel.querySelector('.qrl-detail-view').hidden,false,name);
      for(const section of p.panel.querySelectorAll('.qrl-detail-view .qrl-sec'))section.open=true;
      assertClean(p,name+' detail');
    }
    assert.ok(p.panel.querySelector('.qrl-detail-view').textContent.includes('Integrity check failed.'),'the tampered view is the last one shown');
    for(const [name,body] of [['compatible',compareOk],['incomparable',compareNo]]){
      p.w.api=async path=>{p.calls.push({path});return path.startsWith('/api/quant/library/compare')?body:libraryOf();};
      p.pick(2);p.pick(5);p.click(p.panel.querySelector('.qrl-compare'));await settle();
      assertClean(p,name+' comparison');
      p.pick(2,false);p.pick(5,false);
    }
  }finally{p.close();}
});

test('D2: Inspect and Compare selected show their view directly above the list, scroll it to the top and focus its heading; Back returns the focus to the control that opened it',async()=>{
  const p=setup({handler:router()}),scrolled=[];
  p.w.HTMLElement.prototype.scrollIntoView=function(options){scrolled.push({element:this,options:JSON.stringify(options)});};
  try{
    await p.open();
    const detail=p.panel.querySelector('.qrl-detail-view'),comparison=p.panel.querySelector('.qrl-compare-view'),list=p.panel.querySelector('.qrl-list');
    const above=node=>(node.compareDocumentPosition(list)&p.w.Node.DOCUMENT_POSITION_FOLLOWING)!==0;
    assert.ok(above(detail)&&above(comparison),'both views sit before the list');
    assert.equal(detail.nextElementSibling,list,'the detail view is directly above the list');assert.equal(comparison.nextElementSibling,detail);
    const inspect=p.card(2).querySelector('.qrl-inspect');inspect.focus();assert.equal(p.d.activeElement,inspect);
    p.click(inspect);await settle();
    const heading=detail.querySelector('.qrl-title');
    assert.equal(detail.hidden,false);assert.equal(heading.getAttribute('tabindex'),'-1');assert.equal(p.d.activeElement,heading,'the heading holds the focus');
    assert.ok(scrolled.some(entry=>entry.element===detail&&entry.options==='{"block":"start"}'),'the view scrolls to the top');
    p.click(detail.querySelector('.qrl-back'));
    assert.equal(detail.hidden,true);
    const again=p.card(2).querySelector('.qrl-inspect');
    assert.notEqual(again,inspect,'the list was rebuilt');assert.equal(p.d.activeElement,again,'the focus is back on the Inspect button of the same run');
    p.pick(2);p.pick(5);scrolled.length=0;
    const button=p.panel.querySelector('.qrl-compare');button.focus();p.click(button);await settle();
    assert.equal(comparison.hidden,false);assert.equal(p.d.activeElement,comparison.querySelector('.qrl-title'));
    assert.ok(scrolled.some(entry=>entry.element===comparison&&entry.options==='{"block":"start"}'));
    p.click(comparison.querySelector('.qrl-back'));
    assert.equal(comparison.hidden,true);assert.equal(p.d.activeElement,button,'the focus is back on Compare selected');
    // An answer that is an error gets the same treatment: a heading with the focus and a way back.
    p.w.api=async path=>{if(path.startsWith('/api/quant/library/runs/'))throw apiError('NOT_FOUND',404);return libraryOf();};
    const other=p.card(5).querySelector('.qrl-inspect');other.focus();p.click(other);await settle();
    assert.equal(detail.querySelector('.qrl-error').textContent,'Not available (NOT_FOUND)');assert.equal(p.d.activeElement,detail.querySelector('.qrl-title'));
    p.click(detail.querySelector('.qrl-back'));assert.equal(p.d.activeElement,p.card(5).querySelector('.qrl-inspect'));
    // The opener may be gone when the view closes (the filter hid its card): the focus goes to the panel summary instead of the page.
    p.w.api=async path=>path.startsWith('/api/quant/library/runs/')?detailOf(run(2)):libraryOf();
    p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    p.click(p.panel.querySelector('.qrl-filter[data-group="FAILED"]'));
    p.click(detail.querySelector('.qrl-back'));assert.equal(p.d.activeElement,p.panel.querySelector('.qrl-summary'));
  }finally{p.close();}
});

test('D3: a rebuilt list keeps the keyboard focus on the equivalent control: checkbox, filter chip and Load more',async()=>{
  const first=RUNS.slice(0,5),rest=RUNS.slice(5);
  const page=path=>path.includes('before=')?libraryOf(rest):libraryOf(first,{next_before:first.at(-1).created_at+':'+first.at(-1).run_id,totals:libraryOf().totals});
  const p=setup({handler:router({'/api/quant/library':page})});
  try{
    await p.open();
    for(const on of [true,false]){
      const box=p.card(8).querySelector('.qrl-pick');box.focus();box.checked=on;box.dispatchEvent(new p.w.Event('change',{bubbles:true}));
      const now=p.d.activeElement;
      assert.notEqual(now,box,'the checkbox was rebuilt');assert.ok(now.classList.contains('qrl-pick')&&now.dataset.run===run(8).run_id&&now.checked===on&&p.panel.contains(now));
    }
    const chip=p.panel.querySelector('.qrl-filter[data-group="FAILED"]');chip.focus();p.click(chip);
    const rebuilt=p.d.activeElement;
    assert.notEqual(rebuilt,chip,'the chip was rebuilt');assert.ok(rebuilt.classList.contains('qrl-filter')&&rebuilt.dataset.group==='FAILED'&&rebuilt.getAttribute('aria-pressed')==='true');
    p.click(p.panel.querySelector('.qrl-filter[data-group="ALL"]'));
    const more=p.panel.querySelector('.qrl-more');more.focus();p.click(more);await settle();
    assert.equal(more.hidden,true,'the last page hides Load more');
    const landed=p.d.activeElement;
    assert.ok(landed.classList.contains('qrl-inspect')&&landed.dataset.run===rest[0].run_id,'the focus moves to the first run that page added');
  }finally{p.close();}
});

test('D4: a panel note says integrity is checked when a run is opened; an unverified run marks its selected candidate and its candidate metrics while the values stay visible',async()=>{
  const NOTE='Integrity is checked when a run is opened.',CHIP='Unverified stored values';
  const checking=setup({handler:()=>new Promise(()=>{})});
  try{await checking.open();assert.equal(checking.panel.querySelector('.qrl-integrity-note').hidden,true,'nothing to explain while the list loads');}finally{checking.close();}
  const empty=libraryOf([],{totals:{all:0,ACTIVE:0,COMPLETED:0,INSUFFICIENT:0,FAILED:0,CANCELLED:0}});
  for(const handler of [()=>empty,()=>{throw apiError('QUANT_LIBRARY_UNAVAILABLE',503);}]){
    const quiet=setup({handler});
    try{await quiet.open();assert.equal(quiet.panel.querySelector('.qrl-integrity-note').hidden,true);}finally{quiet.close();}
  }
  const p=setup({handler:router()});
  try{
    await p.open();
    const note=p.panel.querySelector('.qrl-integrity-note');
    assert.equal(note.hidden,false);assert.equal(note.textContent,NOTE);assert.equal(note.previousElementSibling,p.panel.querySelector('.qrl-status'),'right under the totals');
    // A verified run carries no mark.
    p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    const view=p.panel.querySelector('.qrl-detail-view');
    assert.ok(!view.textContent.includes(CHIP),'a verified run shows no unverified mark');
    // A tampered run marks both headings. Its stored values stay visible.
    p.w.api=async path=>path.startsWith('/api/quant/library/runs/')?tamperedDetail():libraryOf();
    p.click(p.card(2).querySelector('.qrl-inspect'));await settle();
    const subheads=[...view.querySelectorAll('.qrl-subhead')].filter(item=>item.textContent.startsWith('Selected candidate'));
    assert.equal(subheads.length,1);assert.equal(subheads[0].textContent,'Selected candidate'+CHIP);assert.ok(subheads[0].querySelector('.qrl-chip.qrl-warn'));
    const summary=[...view.querySelectorAll('.qrl-sec-title')].find(item=>item.textContent.startsWith('All candidates'));
    assert.equal(summary.textContent,'All candidates'+CHIP);assert.equal(summary.querySelector('[data-ui-label]').textContent,'All candidates','the title stays a plain label beside the mark');
    assert.equal(p.rows(view)['Selected parameters'],'rr=1.5, emaFastInput=30','the stored values stay visible');assert.ok(view.querySelectorAll('.qrl-sec')[4].querySelector('table'),'the candidate table is still there');
    assert.equal(view.querySelectorAll('.qrl-chip').length>=2&&[...view.querySelectorAll('.qrl-chip')].filter(item=>item.textContent===CHIP).length,2,'one mark per heading, no more');
  }finally{p.close();}
  const thai=setup({language:'th',handler:router()});
  try{
    await thai.open();
    assert.equal(thai.panel.querySelector('.qrl-integrity-note').textContent,'ระบบตรวจความถูกต้องครบถ้วนของข้อมูลเมื่อเปิดดูการรัน');
    thai.w.api=async path=>path.startsWith('/api/quant/library/runs/')?tamperedDetail():libraryOf();
    thai.click(thai.card(2).querySelector('.qrl-inspect'));await settle();
    const view=thai.panel.querySelector('.qrl-detail-view');
    assert.equal([...view.querySelectorAll('.qrl-chip')].filter(item=>item.textContent==='ค่าที่เก็บไว้ยืนยันไม่ได้').length,2);
    assert.ok([...view.querySelectorAll('.qrl-subhead')].some(item=>item.textContent==='Candidate ที่เลือกค่าที่เก็บไว้ยืนยันไม่ได้'));
  }finally{thai.close();}
});

test('D5: a group that has runs on the server but none loaded says so and points to Load more; a group with no runs still says No runs in this group',async()=>{
  const loaded=RUNS.filter(item=>['FAILED','ACTIVE'].includes(item.library_group));
  const totals={all:9,ACTIVE:1,COMPLETED:3,INSUFFICIENT:2,FAILED:2,CANCELLED:0};
  const p=setup({handler:router({'/api/quant/library':libraryOf(loaded,{totals,next_before:loaded.at(-1).created_at+':'+loaded.at(-1).run_id})})});
  try{
    await p.open();
    const choose=group=>p.click(p.panel.querySelector('.qrl-filter[data-group="'+group+'"]'));
    const lines=()=>[...p.panel.querySelectorAll('.qrl-list > .qrl-note')].map(item=>item.textContent);
    choose('COMPLETED');
    assert.equal(p.cards().length,0);assert.deepEqual(lines(),['3 runs in this group are not loaded yet. Use Load more.'],'the count comes from the totals');
    choose('INSUFFICIENT');assert.deepEqual(lines(),['2 runs in this group are not loaded yet. Use Load more.']);
    choose('CANCELLED');assert.equal(p.cards().length,0);assert.deepEqual(lines(),['No runs in this group.'],'a group with no runs keeps its own sentence');
    choose('FAILED');assert.equal(p.cards().length,2);assert.deepEqual(lines(),[],'no message while cards match');
    choose('ALL');assert.deepEqual(lines(),[]);
  }finally{p.close();}
  const thai=setup({language:'th',handler:router({'/api/quant/library':libraryOf(loaded,{totals})})});
  try{
    await thai.open();thai.click(thai.panel.querySelector('.qrl-filter[data-group="COMPLETED"]'));
    assert.deepEqual([...thai.panel.querySelectorAll('.qrl-list > .qrl-note')].map(item=>item.textContent),['ยังไม่ได้โหลดการรันในกลุ่มนี้อีก 3 รายการ ใช้ปุ่มโหลดเพิ่ม']);
    const language=thai.d.querySelector('#language');language.value='en';language.dispatchEvent(new thai.w.Event('change'));await settle();
    assert.deepEqual([...thai.panel.querySelectorAll('.qrl-list > .qrl-note')].map(item=>item.textContent),['3 runs in this group are not loaded yet. Use Load more.']);
  }finally{thai.close();}
});
