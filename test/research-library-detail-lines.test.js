import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

/**
 * PM-1 row F08-01, gap C18: the Research Library detail view names the Bot of the opened run (public/research-library.js
 * botName, currentBot, botLine, renderDetail). Contract wording: docs/QUANT_RESEARCH_LIBRARY.md (a run is owner-scoped and its
 * report states which Bot it belongs to); the list scope note says "Runs from every Bot of this account. Inspect a run to see
 * its Bot.", so the detail line is what makes that promise true.
 *   C18a the line "Bot of this run" sits directly after the title and before the first section;
 *   C18b the name is the Bot label when the page knows the Bot, else the raw Bot id (never blank, never invented);
 *   C18c the chip says "Selected bot" only when the run's Bot is the selected Bot (or, with no selection, the account's own
 *        Bot), otherwise "Another Bot of this account"; an empty or missing Bot id is never "Selected bot";
 *   C18d both texts are translated (Thai) and the label is placed with textContent, never as markup.
 * Every value below is a LABELLED TEST FIXTURE shaped like the API answer, not a research result. The page globals
 * botProfiles, selectedBot and me belong to app.js and bots.js; here they are set on the window the way those files declare them.
 */
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const H=char=>char.repeat(64);
const T0=Date.UTC(2026,8,27,7,30);
const RUN_ID='3f2a9c1e-0000-4000-8000-000000000002';
const BOT_ID='bot-aaaa-0001';
const OTHER_ID='bot-bbbb-0002';

const listRun={run_id:RUN_ID,created_at:T0,finished_at:T0+120000,status:'SUCCEEDED',phase:'COMPLETE',library_class:'CANDIDATE_PENDING_ACCEPTANCE',library_group:'COMPLETED',
  completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',diagnostic:null,contract_version:'ql3a-research-job-v1',engine_family:'LEGACY',
  market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},dataset:{start_time:T0,end_time:T0+60000,bar_count:1000,warmup_bars:300,digest_kind:'ql3a-dataset-sha256-v1',digest:H('d')},
  source_hash:H('a'),input_lock_hash:H('b'),engine_hash:H('e'),policy_hash:H('c'),cost:{fee_bps:10,slippage_bps:1},candidates:{planned:100,evaluated:100,screen_passed:3},
  development_score:{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},qualification:{qualified:false,label:'DEVELOPMENT_ONLY'},integrity_checked:false,compatibility_key:'aaaaaaaaaaaa'};
const library={version:'quant-library-v1',schema_present:true,admission_enabled:false,totals:{all:1,ACTIVE:0,COMPLETED:1,INSUFFICIENT:0,FAILED:0,CANCELLED:0},
  qualified_total:0,qualified_winner:null,next_before:null,runs:[listRun]};
const GATE_NAMES=['COMPLETED_EVALUATION','SCREENED_CANDIDATE','ROBUSTNESS','HOLDOUT_RESULT','HOLDOUT_INDEPENDENT','BLOCKERS_CLEARED','OWNER_RECOMMENDATION_READY','QL4C_VALIDATION'];
const gate=(index,state,code=null)=>({gate:'G'+(index+1),name:GATE_NAMES[index],state,code});
const metrics=(ret,trades)=>({bars:1350,closed_trades:trades,start_equity:'1000',end_equity:'1030',net_return_percent:ret,max_drawdown_percent:'1.5',profit_factor:'1.2',gross_profit:'12.5',gross_loss:'5.5'});
function detailBody(botId){
  return {version:'quant-library-run-v1',qualified_total:0,qualified_winner:null,
    run:{run_id:RUN_ID,created_at:T0,finished_at:T0+120000,status:'SUCCEEDED',phase:'COMPLETE',library_class:'CANDIDATE_PENDING_ACCEPTANCE',library_group:'COMPLETED',
      completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',diagnostic:null,contract_version:'ql3a-research-job-v1',engine_family:'LEGACY',bot_id:botId,deployment_id:'dep-1',
      attempts:1,evaluations_started:100,deadline:T0+900000},
    provenance:{source:{scope:'SPT_CUSTOM_ENGINEERING_ONLY',source_hash:H('a'),baseline_snapshot_hash:H('f'),pine_import_id:'imp-1',source_version:1,membership:[]},
      input:{lock_hash:H('b'),signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},bridge:{atr_multiplier:2,rr:1.5},bindings:[],fixed_inputs_count:2,fixed_inputs:[],
        domains:[{dimension:'rr',count:5,min:1,max:2}],search:{algorithm:'axis-covered-seeded-grid-v1',seed:7,requested_budget:100,planned_candidates:100,grid_combinations:105}},
      dataset:{market:listRun.market,start_time:T0,end_time:T0+60000,warmup_bars:300,bar_count:1000,digest_kind:'ql3a-dataset-sha256-v1',digest:H('d'),timestamp_semantics:null,
        collection_cutoff:null,collection_source:null,binding_sha256:null},
      engine:{engine_hash:H('e'),engine_family:'LEGACY',execution_backend:null,contract_version:'ql3a-research-job-v1'},
      cost_policy:{model:{version:'paper-close-v1',fee_bps:10,slippage_bps:1,risk_percent:1},cost_stress:'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE',policy_hash:H('c'),
        capital:{equity:'1000',cash:'1000'},ledger_initialization:'Independent historical flat Paper simulation.'},
      validation:{split:{warmup:300,train_end:720,validation_end:860,test_end:1000},rules:{minimum_closed_trades_train:5},max_evaluations:111,
        acceptance_blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED'],holdout_window:{start_time:T0+860*60000,end_time:T0+999*60000}},foundation:null},
    integrity:{contract_hash:H('1'),contract_hash_verified:true,result_sha256:H('2'),steps_count:100,steps_digest:H('3'),report_matches_checkpoints:true,checkpoint_problems:[],
      foundation_binding_matches:null,identity_protection:'DB_TRIGGER',result_protection:'APPLICATION_ONLY',warnings:[]},
    completeness:{result_present:true,candidates_planned:100,candidates_recorded:100,holdout_evaluated:false,missing:[]},
    limitations:{provenance_gaps:['ENGINE_RELEASE_UNKNOWN'],acceptance_blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED']},
    evaluation:{objective:{rule:'VALIDATION_NET_RETURN_THEN_DRAWDOWN_THEN_PARAMETERS',fixed_before_run:true,source:'ENGINE_CODE'},completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',
      holdout_evaluated:false,dimension_coverage_percent:100,candidate_count:100,screen_passed:3,reason_counts:{},development_score:listRun.development_score,
      selected:{parameters:{rr:1.5},train:metrics('4.1',9),validation:metrics('3.20',8),screen_reasons:[],sensitivity:[],cost_stress:null,test:null},
      candidates:[],candidates_truncated:false,stored_values_verified:true},
    qualification:{version:'library-qualification-v1',qualified:false,label:'DEVELOPMENT_ONLY',gates:[gate(0,'PASS'),gate(1,'PASS'),gate(2,'PASS'),gate(3,'FAIL','HOLDOUT_NOT_EVALUATED'),
      gate(4,'NOT_REACHED'),gate(5,'FAIL','ACCEPTANCE_BLOCKERS_PRESENT'),gate(6,'FAIL','OWNER_RECOMMENDATION_NOT_READY'),gate(7,'FAIL','QL4C_VALIDATION_NOT_AVAILABLE')],
      holdout_overlap:{checked:false,overlaps:null,run_ids:[]}},
    compatibility:{version:'library-compat-v1',key:H('k'),short_key:'kkkkkkkkkkkk',fields:{},missing:[]}};
}

async function waitFor(condition,label){
  for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail('timed out waiting for '+label);
}
/** Opens the library, inspects the one run and returns its .qrl-botline element and the detail view. globals sets botProfiles, selectedBot and me. */
async function inspect({botId,globals={},language}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  try{
    if(language)w.localStorage.setItem('robotLanguage',language);
    w.eval(publicFile('i18n.js'));
    for(const [name,value] of Object.entries(globals))w[name]=value;
    const calls=[];
    w.api=async path=>{
      calls.push(path);
      if(path.startsWith('/api/quant/library/runs/'))return detailBody(botId);
      if(path.startsWith('/api/quant/library'))return library;
      throw new Error('unexpected '+path);
    };
    w.eval(publicFile('research-library.js'));
    const panel=d.getElementById('qrlPanel');
    panel.open=true;panel.dispatchEvent(new w.Event('toggle'));
    await waitFor(()=>panel.querySelector('.qrl-card'),'the list card');
    // The list card does not carry the Bot line: only the detail view does.
    assert.equal(panel.querySelector('.qrl-card .qrl-botline'),null,'the list card shows no Bot line');
    panel.querySelector('.qrl-inspect').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
    await waitFor(()=>!panel.querySelector('.qrl-detail-view').hidden,'the detail view');
    const view=panel.querySelector('.qrl-detail-view');
    assert.deepEqual(calls.filter(path=>path.includes('/runs/')),['/api/quant/library/runs/'+RUN_ID]);
    const line=view.querySelector('.qrl-botline');
    assert.ok(line,'the detail view has a Bot line');
    return {line,view,w,
      text:line.textContent.replace(/\s+/g,' ').trim(),
      chip:line.querySelector('.qrl-chip'),
      name:line.querySelector('.qrl-v'),
      close:()=>w.close()};
  }catch(error){w.close();throw error;}
}
const toneOf=chip=>[...chip.classList].filter(name=>name.startsWith('qrl-')&&name!=='qrl-chip');

test('C18a: the detail view shows "Bot of this run" right after the title and before the first section, once',async()=>{
  const r=await inspect({botId:BOT_ID,globals:{botProfiles:[{id:BOT_ID,label:'Alpha Bot'}],selectedBot:BOT_ID}});
  try{
    assert.equal(r.view.querySelectorAll('.qrl-botline').length,1);
    assert.equal(r.line.tagName,'P');
    assert.equal(r.line.querySelector('[data-ui-label]').textContent,'Bot of this run','the label comes first');
    const children=[...r.view.children];
    const at=children.indexOf(r.line);
    assert.equal(children[at-1].className,'qrl-title','the title is the previous element');
    assert.match(children[at-2].className,/qrl-back/,'the back button opens the view');
    assert.equal(children[at+1].className,'qrl-sec','the first Outcome section follows the line');
    assert.equal(children[at+1].querySelector('.qrl-sec-title').textContent,'Outcome');
    assert.equal(r.view.querySelector('.qrl-alert'),null,'no integrity alert sits between the title and the line for a clean run');
  }finally{r.close();}
});

test('C18b: the line names the Bot by its label when the Bot list knows it, else by the raw Bot id',async()=>{
  const known=await inspect({botId:BOT_ID,globals:{botProfiles:[{id:OTHER_ID,label:'Beta Bot'},{id:BOT_ID,label:'Alpha Bot'}],selectedBot:BOT_ID}});
  try{assert.equal(known.name.textContent,'Alpha Bot');assert.equal(known.text,'Bot of this run: Alpha Bot Selected bot');}finally{known.close();}
  // The Bot list holds other Bots only: the id is shown as it is.
  const unknownBot=await inspect({botId:BOT_ID,globals:{botProfiles:[{id:OTHER_ID,label:'Beta Bot'}],selectedBot:OTHER_ID}});
  try{assert.equal(unknownBot.name.textContent,BOT_ID);assert.equal(unknownBot.text,'Bot of this run: '+BOT_ID+' Another Bot of this account');}finally{unknownBot.close();}
  // A listed Bot without a label also falls back to its id.
  const unlabelled=await inspect({botId:BOT_ID,globals:{botProfiles:[{id:BOT_ID}],selectedBot:BOT_ID}});
  try{assert.equal(unlabelled.name.textContent,BOT_ID);}finally{unlabelled.close();}
  // The Bot list global is missing, or is not an array: no error, the id is shown.
  const absent=await inspect({botId:BOT_ID});
  try{assert.equal(absent.name.textContent,BOT_ID);assert.equal(absent.text,'Bot of this run: '+BOT_ID+' Another Bot of this account');}finally{absent.close();}
  const notArray=await inspect({botId:BOT_ID,globals:{botProfiles:{id:BOT_ID,label:'Alpha Bot'},selectedBot:BOT_ID}});
  try{assert.equal(notArray.name.textContent,BOT_ID,'a Bot list that is not an array is ignored');assert.equal(notArray.chip.textContent,'Selected bot');}finally{notArray.close();}
  // A run without a Bot id shows the dash, never the word null or undefined.
  for(const missing of [null,undefined,'']){
    const none=await inspect({botId:missing,globals:{botProfiles:[{id:BOT_ID,label:'Alpha Bot'}],selectedBot:BOT_ID}});
    try{
      assert.equal(none.name.textContent,'—');assert.equal(none.text,'Bot of this run: — Another Bot of this account','a run without a Bot id is never the selected Bot');
      assert.ok(!/null|undefined|NaN/.test(none.text));
    }finally{none.close();}
  }
});

test('C18c: the chip is "Selected bot" only for the selected Bot, or for the account Bot when nothing is selected; otherwise "Another Bot of this account"',async()=>{
  const profiles=[{id:BOT_ID,label:'Alpha Bot'},{id:OTHER_ID,label:'Beta Bot'}];
  const cases=[
    ['the run Bot is selected',{botProfiles:profiles,selectedBot:BOT_ID},'Selected bot','info'],
    ['another Bot is selected',{botProfiles:profiles,selectedBot:OTHER_ID},'Another Bot of this account','muted'],
    ['the all-Bots scope is selected',{botProfiles:profiles,selectedBot:'all'},'Another Bot of this account','muted'],
    ['nothing is selected and the account Bot is the run Bot',{botProfiles:profiles,selectedBot:'',me:{user:{id:BOT_ID}}},'Selected bot','info'],
    ['nothing is selected and the account Bot is another Bot',{botProfiles:profiles,selectedBot:'',me:{user:{id:OTHER_ID}}},'Another Bot of this account','muted'],
    ['a selection wins over the account Bot',{botProfiles:profiles,selectedBot:OTHER_ID,me:{user:{id:BOT_ID}}},'Another Bot of this account','muted'],
    ['nothing is known about the session',{},'Another Bot of this account','muted']];
  for(const [name,globals,chipText,tone] of cases){
    const r=await inspect({botId:BOT_ID,globals});
    try{
      assert.equal(r.chip.textContent,chipText,name);assert.deepEqual(toneOf(r.chip),['qrl-'+tone],name+' (tone)');
      assert.equal(r.line.querySelectorAll('.qrl-chip').length,1,name+' (exactly one chip)');
    }finally{r.close();}
  }
});

test('C18c2: an empty or missing run Bot id is never "Selected bot", even when no Bot is selected and the account Bot is unknown',async()=>{
  for(const missing of ['',null,undefined]){
    for(const language of [undefined,'th']){
      const r=await inspect({botId:missing,language,globals:{}});
      try{
        assert.equal(r.chip.textContent,language==='th'?'Bot อื่นในบัญชีนี้':'Another Bot of this account','missing id '+String(missing)+' '+(language||'en'));
        assert.deepEqual(toneOf(r.chip),['qrl-muted']);
        assert.equal(r.name.textContent,'—');
      }finally{r.close();}
    }
  }
});

test('C18d: Thai texts appear for the label and both chips, and a hostile Bot label is placed as text, never as markup',async()=>{
  const profiles=[{id:BOT_ID,label:'Alpha Bot'}];
  const selected=await inspect({botId:BOT_ID,language:'th',globals:{botProfiles:profiles,selectedBot:BOT_ID}});
  try{assert.equal(selected.line.querySelector('[data-ui-label]').textContent,'Bot ของรายการนี้');assert.equal(selected.chip.textContent,'Bot ที่เลือก');assert.equal(selected.name.textContent,'Alpha Bot','the Bot label itself is never translated');}
  finally{selected.close();}
  const other=await inspect({botId:BOT_ID,language:'th',globals:{botProfiles:profiles,selectedBot:OTHER_ID}});
  try{assert.equal(other.chip.textContent,'Bot อื่นในบัญชีนี้');}finally{other.close();}
  const hostile=await inspect({botId:BOT_ID,globals:{botProfiles:[{id:BOT_ID,label:'<img src=x onerror=alert(1)>'}],selectedBot:BOT_ID}});
  try{
    assert.equal(hostile.name.textContent,'<img src=x onerror=alert(1)>');
    assert.equal(hostile.line.querySelector('img'),null,'no element is created from the label');
    assert.equal(hostile.view.querySelector('img'),null);
  }finally{hostile.close();}
});
