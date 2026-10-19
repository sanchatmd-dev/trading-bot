import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

// The compare view lists the context a compatible set shares: market, data window and cost model. The compare API carries the
// same market, dataset and cost fields as a list row (src/postgres/quant-library.js), so the block is never empty.
// Everything below is a LABELLED TEST FIXTURE shaped like the API answers; the page contains no canned data.
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
const H=char=>char.repeat(64);
const T0=Date.UTC(2026,8,27,7,30);
const MINUTE=60000;
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const DATASET={start_time:T0,end_time:T0+999*MINUTE,warmup_bars:300,bar_count:1000,digest_kind:'ql3a-dataset-sha256-v1',digest:H('d')};
const COST={fee_bps:12,slippage_bps:3};
const ID=index=>'3f2a9c1e-0000-4000-8000-00000000000'+index;
const BASE=(index,extra={})=>({run_id:ID(index),created_at:T0+index*3600000,finished_at:T0+index*3600000+120000,status:'SUCCEEDED',library_class:'CANDIDATE_PENDING_ACCEPTANCE',
  library_group:'COMPLETED',completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',diagnostic:null,engine_family:'LEGACY',qualification:{qualified:false,label:'DEVELOPMENT_ONLY'},
  compatibility_key:'aaaaaaaaaaaa',...extra});
const listRun=index=>({...BASE(index),phase:'COMPLETE',contract_version:'ql3a-research-job-v1',market:MARKET,dataset:DATASET,source_hash:H('a'),input_lock_hash:H('b'),engine_hash:H('e'),
  policy_hash:H('c'),cost:COST,candidates:{planned:100,evaluated:100,screen_passed:3},development_score:{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},integrity_checked:false});
const library={version:'quant-library-v1',schema_present:true,admission_enabled:false,totals:{all:2,ACTIVE:0,COMPLETED:2,INSUFFICIENT:0,FAILED:0,CANCELLED:0},
  qualified_total:0,qualified_winner:null,next_before:null,runs:[listRun(3),listRun(2)]};
// The compare answer in the shape the server returns: the base keys, then the shared context, then disclosed and metrics.
const metrics=(ret,trades)=>({bars:1350,closed_trades:trades,start_equity:'1000',end_equity:'1030',net_return_percent:ret,max_drawdown_percent:'1.5',profit_factor:'1.2',gross_profit:'12.5',gross_loss:'5.5'});
const compareRun=index=>({...BASE(index),market:MARKET,dataset:DATASET,cost:COST,
  disclosed:{bot_id:'bot-1',deployment_id:'dep-1',baseline_snapshot_hash:H('f'),search:{algorithm:'axis-covered-seeded-grid-v1',seed:7,requested_budget:100,planned_candidates:100,grid_combinations:105},domains:[]},
  metrics:{candidates:{planned:100,evaluated:100,screen_passed:3},reason_counts:{},development_score:{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},
    selected:{parameters:{rr:1.5},train:metrics('4.1',9),validation:metrics('3.20',8)}},metrics_reason:null});
const compareOk={version:'quant-library-compare-v1',verdict:'COMPATIBLE',rules:{compatibility:'library-compat-v1',qualification:'library-qualification-v1'},mismatches:[],
  qualified_total:0,qualified_winner:null,runs:[compareRun(2),compareRun(3)]};
const compareNo={version:'quant-library-compare-v1',verdict:'INCOMPATIBLE',rules:{compatibility:'library-compat-v1',qualification:'library-qualification-v1'},
  mismatches:[{field:'dataset',values:[{run_id:ID(2),value:'{"bar_count":1000}'},{run_id:ID(3),value:'{"bar_count":2000}'}]}],qualified_total:0,qualified_winner:null,
  runs:[BASE(2),BASE(3,{compatibility_key:'bbbbbbbbbbbb'})]};

function setup(compare){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  w.eval(publicFile('i18n.js'));
  w.api=async path=>{
    const route=path.split('?')[0];
    if(route==='/api/quant/library')return library;
    if(route==='/api/quant/library/compare')return compare;
    throw Object.assign(new Error('unexpected '+path),{status:500,code:'UNEXPECTED'});
  };
  w.eval(publicFile('research-library.js'));
  const panel=d.getElementById('qrlPanel');
  const card=index=>panel.querySelector('.qrl-card[data-run$="'+index+'"]');
  const click=element=>element.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  const pick=index=>{const box=card(index).querySelector('.qrl-pick');box.checked=true;box.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const compareNow=async()=>{panel.open=true;panel.dispatchEvent(new w.Event('toggle'));await settle();pick(2);pick(3);click(panel.querySelector('.qrl-compare'));await settle();};
  return {w,panel,compareNow,close:()=>w.close()};
}
const clean=element=>element.textContent.replace(/\s+/g,' ').trim();
const minute=ms=>new Date(ms).toISOString().slice(0,16).replace('T',' ');

test('compatible comparison: the Shared context block names the asset, the date window and the fee and slippage',async()=>{
  const p=setup(compareOk);
  try{
    await p.compareNow();
    const view=p.panel.querySelector('.qrl-compare-view');
    assert.equal(view.hidden,false);assert.equal(view.querySelector('.qrl-title').textContent,'Comparison');
    const shared=view.querySelector('.qrl-shared');
    assert.ok(shared,'the shared context block is shown');
    assert.equal(shared.querySelector('.qrl-sub').textContent,'Shared context');
    const parts=[...shared.querySelectorAll('.qrl-pv')].map(clean);
    assert.equal(parts.length,3,'market, data window and cost model');
    assert.equal(parts[0],'binance-global · BTCUSDT · 1m');
    assert.equal(parts[1],minute(T0)+' → '+minute(T0+999*MINUTE)+' UTC · 1,000 bars');
    assert.equal(parts[2],'Fee 12 bps · Slippage 3 bps');
    const text=clean(shared);
    assert.ok(text.includes('BTCUSDT')&&text.includes('2026-09-27 07:30')&&text.includes('2026-09-28 00:09')&&text.includes('Fee 12 bps')&&text.includes('Slippage 3 bps'));
    assert.equal(view.querySelector('.qrl-winner').textContent,'Qualified recommendations: none. No qualified winner.');
  }finally{p.close();}
});

test('incomparable runs show the differing fields and no Shared context block',async()=>{
  const p=setup(compareNo);
  try{
    await p.compareNow();
    const view=p.panel.querySelector('.qrl-compare-view');
    assert.equal(view.hidden,false);assert.equal(view.querySelector('.qrl-title').textContent,'Not comparable');
    assert.equal(view.querySelector('.qrl-shared'),null);
    assert.ok(view.textContent.includes('These runs differ in a fixed context field, so no metrics are compared.'));
  }finally{p.close();}
});
