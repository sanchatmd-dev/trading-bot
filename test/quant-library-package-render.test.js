import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {assemble} from '../src/pine-bridge/template.js';
import {RULES} from '../src/quant-research/contract.js';
import {LIBRARY_VERSIONS,holdoutWindow} from '../src/quant-library/derive.js';
import {PACKAGE_FILES,MANIFEST_PATH,TRACE_FILES,CANDIDATE_BLOCKERS,OWNER_RECOMMENDATION_CONTRACT_VERSIONS,STATUS,bindingHash,packageHash,scanContent,
  evaluateBuildEligibility,evaluateStructure,evaluateCompile,evaluateProvenance,evaluateValidation,evaluatePackage,bindingComplete}
  from '../src/quant-library/package-gates.js';
import {renderPackage,PACKAGE_MARKET,RENDER_REFUSAL_CODES} from '../src/quant-library/package-render.js';
import {contractOf,hex,metricsOf,parameters,MINUTE,T0} from './helpers/quant-library-fixture.mjs';

/*
 * Every package below is a LABELLED ENGINEERING FIXTURE unless a test says otherwise: synthetic data, never a research result and
 * never a recommendation. The renderer and the gate module are pure, so no database, clock, network or file is used here.
 */
const OWNER='owner-a',BOT='bot-a',DEPLOY='3c1d0a52-7b9e-4c1a-9a26-0f1e2d3c4b5a',IMPORT='8a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e',RUN_ID='run-render-0001',
  EXPORT_ID='9f1c2b7e-3d4a-4b5c-8d6e-0123456789ab',NEW_VERSION=OWNER_RECOMMENDATION_CONTRACT_VERSIONS[0],NOW='2026-10-19T12:00:00Z';
const clone=value=>JSON.parse(JSON.stringify(value));
const reverseKeys=value=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])])):value;
const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;};
const withRate=(metric,rate)=>({...metric,win_rate:rate});

const SOURCE=['//@version=6','indicator("Render fixture indicator", overlay=true)','emaFastInput = input.int(50, "EMA fast", minval=30, maxval=50, step=10)',
  'useSlowFilter = input.bool(true, "Slow filter")','notifyEnabled = input.bool(false, "Notify")','emaFast = ta.ema(close, emaFastInput)',
  'emaSlow = ta.ema(close, 100)','buySignal = ta.crossover(emaFast, emaSlow)','sellSignal = ta.crossunder(emaFast, emaSlow)','plot(emaFast)',''].join('\n');
const STATEMENT='emaFastInput = input.int(50, "EMA fast", minval=30, maxval=50, step=10)';
const SPAN_START=SOURCE.indexOf(STATEMENT);
const TRACE=Object.freeze({
  equity:{columns:['time','equity'],rows:[['2026-10-19T00:00:00Z','1000'],['2026-10-19T00:01:00Z','1001.5']]},
  trades:{columns:['entry_time','exit_time','pnl'],rows:[['2026-10-19T00:05:00Z','2026-10-19T00:20:00Z','1.5']]},
  decisions:{columns:['time','decision'],rows:[['2026-10-19T00:05:00Z','accepted']]}});

/**
 * A complete run in the stored shape plus the renderer input and everything C1 to C4 need around the rendered package. The
 * callbacks change one thing before the render: contract(c), result(r, c), input(i).
 */
function scenario(edit={}){
  const contract=clone(contractOf({owner:OWNER,bot:BOT,deployment:DEPLOY,importId:IMPORT,tag:'render'}));
  Object.assign(contract,{version:NEW_VERSION,source:SOURCE,source_hash:hash(SOURCE),policy_version:'policy-v1',acceptance_blockers:[...CANDIDATE_BLOCKERS]});
  contract.snapshot.policy={max_daily_loss_percent:'3',equities:{'binance-global':'1000'}};
  contract.snapshot.membership=[{pine_import_id:IMPORT,source_version:1,source_hash:contract.source_hash}];
  contract.input_lock.selection.bindings[0].source_span={start:SPAN_START,end:SPAN_START+STATEMENT.length};
  edit.contract?.(contract);
  const P=edit.parameters??parameters(1);
  const evaluation=(kind,params,train,validation,testPart)=>({kind,parameters:params,train,validation,...(testPart?{test:testPart}:{})});
  const best=evaluation('CANDIDATE',P,withRate(metricsOf('4.1',9),'55.56'),withRate(metricsOf('3.2',8),'62.50'));
  const neighbour=(name,value)=>{const params={...P,[name]:value};return {dimension:name,parameters:params,result:evaluation('SENSITIVITY',params,metricsOf('3.0',9),metricsOf('2.9',8))};};
  const selected={parameters:P,result:best,screen_reasons:[],sensitivity:[neighbour('atr_multiplier',2),neighbour('rr',1.25),neighbour('emaFastInput',40)],
    cost_stress:evaluation('STRESS',P,metricsOf('3.5',9),metricsOf('2.4',8)),test:withRate(metricsOf('1.9',9,'1.5'),'66.67')};
  const result={scope:contract.scope,contract_hash:hash(canonical(contract)),input_lock_hash:contract.input_lock.lock_hash,dataset_hash:contract.dataset.sha256,
    search_algorithm:contract.plan.algorithm,seed:contract.plan.seed,budget:contract.plan.requested_budget,candidate_count:6,selected_dimensions:3,covered_dimensions:3,
    dimension_coverage_percent:100,candidates:[{parameters:P,result:best,screen_reasons:[]}],selected,owner_recommendation_ready:false,
    acceptance_blockers:contract.acceptance_blockers,holdout_evaluated:true,completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'};
  edit.result?.(result,contract);
  const run={owner_id:OWNER,bot_id:BOT,run_id:RUN_ID,status:'SUCCEEDED',contract,contract_hash:hash(canonical(contract)),submission_hash:hex('submission-render'),result,
    created_at_utc:'2026-10-19T11:30:00Z',integrity:{contract_hash_verified:true,report_matches_checkpoints:true}};
  const input={export_id:EXPORT_ID,created_at:NOW,run,fixture:true,library_versions:clone(LIBRARY_VERSIONS),risk_limits:{max_daily_loss_percent:'3'},trace:clone(TRACE),exit_version:'bridge-exit-v2'};
  edit.input?.(input);
  const rendered=renderPackage(input);
  const {files,binding,package_hash:packageHashValue,binding_hash:bindingHashValue}=rendered;
  const effective=binding.effective_input_hash,stepsDigest=hash(canonical({candidate:{parameters:selected.parameters,result:selected.result},sensitivity:selected.sensitivity,cost_stress:selected.cost_stress}));
  const holdoutDigest=hash(canonical({test:selected.test})),scope={source_hash:contract.source_hash,effective_input_hash:effective,dataset_digest:contract.dataset.sha256,engine_hash:contract.engine_hash};
  const evidence={dataset_alignment:{matched_percent:100,unmatched_bars:0,future_leakage:0,scope},
    native_parity:{match_percent:100,missing_events:0,additional_events:0,shift_bars:0,sample:{warmup_bars:800,lookback:100,closed_bars:5000,native_events:200,buy_events:60,exit_events:60},scope},
    bridge_parity:{match_percent:100,sl_tp_diff_ticks:0,exit_version:'bridge-exit-v2',scope},repaint:{observations:120,changed_flags:0,scope},
    quant_baseline:{coverage_percent:100,decision_match_percent:100,quantity_step_diff:0,cash_diff_minor_units:1,scope}};
  const proof={VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED:'native_parity',CUSTOM_REPAINT_EVIDENCE_REQUIRED:'repaint'};
  const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:contract.dataset.start_time,
    end_time:contract.dataset.end_time+MINUTE,warmup_bars:contract.dataset.warmup_bars,total_bars:contract.dataset.bar_count,cutoff:contract.dataset.end_time+MINUTE,source:'binance-spot-klines-v1'};
  const members=contract.snapshot.membership;
  const subject={owner_id:OWNER,export_id:EXPORT_ID,run,binding,internal:false,export:{library_versions:clone(LIBRARY_VERSIONS)},current_rules:clone(RULES),replay_mismatch:false,
    files:{...files},package_hash:packageHashValue,binding_hash:bindingHashValue,
    holdout:{earlier_holdouts:[{start_time:T0-5000*MINUTE,end_time:T0-4000*MINUTE}],earlier_searched:[{start_time:T0-5000*MINUTE,end_time:T0-4000*MINUTE}],registered_boundary:{exists:false},exposure_register:[]},
    compile:{export_id:EXPORT_ID,indicator_sha256:hash(files['indicator.pine']),pine_version:6,errors:[],
      warnings:[{text:'The variable notifyEnabled is never used.',disposition:'ACCEPTED_BENIGN',reviewer_role:'ROOT'}],unresolved_references:0,collisions:0,duplicate_bindings:0,
      mapping_check:contract.input_lock.selection.bindings.map(item=>({slot:item.slot,pine_variable:item.pine_variable})),compiled_at_utc:'2026-10-19T11:00:00Z',
      operator_role:'ROOT',method:'ROOT_COORDINATED_TRADINGVIEW'},
    native_alert_isolation:{routes_disabled:true,unrelated_payloads:0,native_payloads:0},deployment:{exit_version:'bridge-exit-v2'},
    dataset:{readable:true,digest:contract.dataset.sha256,metadata},hard_limits:{max_daily_loss_percent:{max:'5'}},
    trace_reproduction:TRACE_FILES.map(path=>({path,sha256:hash(files[path]),steps_digest:stepsDigest,holdout_digest:holdoutDigest})),evidence,
    clearances:CANDIDATE_BLOCKERS.map(blocker=>({blocker,run_id:RUN_ID,export_id:EXPORT_ID,parameter_hash:hash(canonical(P)),evidence_hash:hash(canonical(evidence[proof[blocker]]))})),
    current:{deployment_id:DEPLOY,membership:clone(members),policy_version:contract.policy_version,policy_hash:contract.snapshot.policy_hash,input_lock_hash:contract.input_lock.lock_hash,
      dataset_available:true,bot_owner_id:OWNER},
    bridge_bounds:{atr_multiplier:{min:'0.5',max:'5'},rr:{min:'0.5',max:'3'}},
    attempt:{attempt_id:'attempt-0001',validator_engine_hash:hex('validator-engine'),validated_at_utc:'2026-10-19T12:05:00Z'},attempt_no:1};
  return {contract,result,selected,run,input,rendered,subject};
}
const codesOf=result=>[...result.codes];

test('a rendered one-Pine fixture passes B0 before and C1 to C4 and Q after the render, against the unchanged gate module',()=>{
  const {rendered,subject,input}=scenario();
  assert.equal(evaluateBuildEligibility({owner_id:OWNER,run:subject.run,holdout:subject.holdout,binding:rendered.binding,internal:false,current_rules:clone(RULES)}).pass,true,'B0 on the rendered binding');
  assert.deepEqual(codesOf(evaluateStructure(subject)),[],'C1');
  assert.deepEqual(codesOf(evaluateCompile(subject)),[],'C2');
  assert.deepEqual(codesOf(evaluateProvenance(subject)),[],'C3');
  assert.deepEqual(codesOf(evaluateValidation(subject)),[],'C4');
  const all=evaluatePackage(subject);
  assert.deepEqual(all.gates.map(gate=>[gate.gate,gate.state]),[['C1','PASS'],['C2','PASS'],['C3','PASS'],['C4','PASS'],['Q','PASS']]);
  assert.equal(all.status,STATUS.EXPORT_VALIDATED);
  assert.equal(all.record.package_hash,rendered.package_hash);
  assert.equal(all.record.binding_hash,rendered.binding_hash);
  assert.equal(all.record.fixture,true);
  assert.equal(all.ready,false,'a fixture is never READY');
  assert.equal(input.fixture,true);
});

test('the file set is exactly the canonical set, the hashes are the gate hashes and every file is scan-clean',()=>{
  const {rendered}=scenario();
  assert.deepEqual(Object.keys(rendered.files),[...PACKAGE_FILES]);
  assert.ok(Object.values(rendered.files).every(content=>typeof content==='string'&&content.length>0));
  assert.deepEqual(rendered.manifest,JSON.parse(rendered.files[MANIFEST_PATH]));
  assert.equal(rendered.package_hash,packageHash(rendered.manifest));
  assert.equal(rendered.package_hash,hash(canonical(rendered.manifest)));
  assert.equal(rendered.binding_hash,bindingHash(rendered.binding));
  assert.deepEqual(rendered.manifest.binding,rendered.binding);
  assert.equal(bindingComplete(rendered.binding),true);
  assert.deepEqual(rendered.manifest.files.map(file=>file.path),PACKAGE_FILES.filter(path=>path!==MANIFEST_PATH).sort());
  for(const file of rendered.manifest.files){
    assert.equal(file.sha256,hash(rendered.files[file.path]),file.path);
    assert.equal(file.bytes,Buffer.byteLength(rendered.files[file.path]),file.path);
  }
  assert.equal(rendered.manifest.identity.export_id,EXPORT_ID);
  assert.equal(rendered.manifest.fixture,true);
  for(const [path,content] of Object.entries(rendered.files)){
    assert.deepEqual(scanContent(content),[],path);
    assert.ok(!content.includes('\r'),path+' has no carriage return');
    if(path!=='indicator.pine')assert.ok(content.endsWith('\n'),path+' ends with one line feed');
  }
  assert.ok(Object.isFrozen(rendered)&&Object.isFrozen(rendered.files)&&Object.isFrozen(rendered.manifest)&&Object.isFrozen(rendered.binding));
  assert.equal(RENDER_REFUSAL_CODES.includes('RENDER_INPUT_INVALID'),true);
  assert.deepEqual({...PACKAGE_MARKET},{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
});

test('the render is byte-stable: same input same bytes, key order of the input does not matter, the input is never changed',()=>{
  const {input,rendered}=scenario();
  const frozen=deepFreeze(clone(input)),before=JSON.stringify(frozen);
  const again=renderPackage(frozen);
  assert.equal(JSON.stringify(frozen),before,'input unchanged');
  assert.deepEqual({...again.files},{...rendered.files});
  assert.equal(again.package_hash,rendered.package_hash);assert.equal(again.binding_hash,rendered.binding_hash);
  const shuffled=renderPackage(reverseKeys(clone(input)));
  assert.deepEqual({...shuffled.files},{...rendered.files},'reversed key order');
  assert.equal(shuffled.package_hash,rendered.package_hash);
  const source=fs.readFileSync(new URL('../src/quant-library/package-render.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/Date\.now|new Date|Math\.random|randomUUID|node:fs|node:net|node:http|node:child_process|fetch\(|process\.|setTimeout/,'no clock, random, file, network or process access');
});

test('a different export id or creation time changes the hashes and nothing else of the indicator bytes',()=>{
  const base=scenario().rendered;
  const other=scenario({input:i=>{i.export_id='11111111-2222-4333-8444-555555555555';}}).rendered;
  assert.notEqual(other.package_hash,base.package_hash);
  assert.equal(other.files['indicator.pine'],base.files['indicator.pine']);
  assert.equal(other.binding_hash,base.binding_hash,'the binding does not carry the export id');
  const later=scenario({input:i=>{i.created_at='2026-10-19T12:00:01Z';}}).rendered;
  assert.notEqual(later.binding_hash,base.binding_hash);
  assert.notEqual(later.package_hash,base.package_hash);
});

test('indicator.pine is the original source with only the approved numeric default edits plus the reviewed Bridge block',()=>{
  const {rendered,selected}=scenario();
  const indicator=rendered.files['indicator.pine'],edited=SOURCE.replace('input.int(50,','input.int(30,');
  assert.equal(selected.parameters.emaFastInput,30);
  assert.ok(indicator.startsWith(edited));
  assert.equal(indicator,assemble(edited,{bridge:{atr_multiplier:1.5,rr:1},signals:{buy:'buySignal',exit:'sellSignal'},bindings:[],fixed_inputs:[]},
    {deployment_id:DEPLOY,pine_import_id:IMPORT,source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'}).integrated_pine);
  const code=indicator.replace(/\/\/.*$/gm,'');
  assert.equal([...code.matchAll(/\bindicator\s*\(/g)].length,1);
  assert.doesNotMatch(code,/\bstrategy\s*(?:\(|\.)/);
  const json=JSON.parse(rendered.files['indicator.json']);
  assert.deepEqual(json.edits.map(edit=>({before:edit.before,after:edit.after,input_id:edit.input_id})),[{before:'50',after:'30',input_id:'input_3'}]);
  assert.equal(SOURCE.slice(json.edits[0].start,json.edits[0].end),'50');
  assert.equal(json.alert_source,'alert_calls');assert.equal(json.symbol,'BINANCE:BTCUSDT');assert.equal(json.timeframe,'1');assert.equal(json.exit_version,'bridge-exit-v2');
  assert.equal(json.indicator.name,'Render fixture indicator');assert.equal(json.pine_version,6);
});

test('an unchanged selected value keeps the original bytes and records no edit',()=>{
  const {rendered}=scenario({parameters:{atr_multiplier:2,rr:1.5,emaFastInput:50}});
  assert.ok(rendered.files['indicator.pine'].startsWith(SOURCE));
  assert.deepEqual(JSON.parse(rendered.files['indicator.json']).edits,[]);
  assert.equal(evaluateCompile(scenario({parameters:{atr_multiplier:2,rr:1.5,emaFastInput:50}}).subject).pass,true);
});

test('a named defval literal and a float input are located and edited',()=>{
  const source=['//@version=6','indicator("Named fixture", overlay=true)','rsiLevel = input.float(title="Level", defval=0.5, minval=0.1, maxval=0.9, step=0.2)',
    'emaFast = ta.ema(close, 20)','buySignal = ta.crossover(emaFast, rsiLevel)','sellSignal = ta.crossunder(emaFast, rsiLevel)','plot(emaFast)',''].join('\n');
  const statement=source.split('\n')[2],start=source.indexOf(statement);
  const run=scenario({parameters:{atr_multiplier:2,rr:1.5,rsiLevel:0.7},contract:c=>{
    c.source=source;c.source_hash=hash(source);c.snapshot.membership[0].source_hash=c.source_hash;
    Object.assign(c.input_lock.selection.bindings[0],{pine_variable:'rsiLevel',type:'float',effective_value:0.5,source_span:{start,end:start+statement.length}});
    c.input_lock.selection.fixed_inputs=[];
    c.input_lock.domains={atr_multiplier:c.input_lock.domains.atr_multiplier,rr:c.input_lock.domains.rr,rsiLevel:[0.1,0.3,0.5,0.7,0.9]};
  }});
  assert.ok(run.rendered.files['indicator.pine'].includes('defval=0.7,'));
  assert.deepEqual(JSON.parse(run.rendered.files['indicator.json']).edits.map(edit=>[edit.before,edit.after]),[['0.5','0.7']]);
  const inputs=JSON.parse(run.rendered.files['inputs.json']);
  assert.deepEqual(inputs.source_inputs[0].domain,{min:'0.1',max:'0.9',step:'0.2'});
  assert.equal(evaluateCompile(run.subject).pass,true);
  assert.equal(evaluateProvenance(run.subject).pass,true);
});

test('inputs.json and metrics.json carry the stored values as decimal strings and verbatim metrics',()=>{
  const {rendered,selected}=scenario({input:i=>{i.units={emaFastInput:'bars'};}});
  const inputs=JSON.parse(rendered.files['inputs.json']);
  assert.deepEqual(inputs.source_inputs,[{slot:3,input_id:'input_3',pine_variable:'emaFastInput',kind:'int',unit:'bars',before:'50',after:'30',domain:{min:'30',max:'50',step:'10'}}]);
  assert.deepEqual(inputs.bridge,{atr_multiplier:{unit:'ATR multiple',before:'2',after:'1.5',domain:{min:'1',max:'4',step:'0.5'}},
    rr:{unit:'reward to risk ratio',before:'1.5',after:'1',domain:{min:'1',max:'2',step:'0.25'}}});
  assert.deepEqual(inputs.fixed_inputs,[{input_id:'input_10',pine_variable:'notifyEnabled',value:false},{input_id:'input_9',pine_variable:'useSlowFilter',value:true}]);
  assert.deepEqual(JSON.parse(rendered.files['quant-data/metrics.json']),{train:selected.result.train,validation:selected.result.validation,test:selected.test});
  const validation=JSON.parse(rendered.files['quant-data/validation.json']);
  assert.deepEqual(validation.candidate,{parameters:selected.parameters,result:selected.result});
  assert.deepEqual(validation.holdout,{test:selected.test});
  assert.deepEqual(validation.parity,{state:'NOT_RECORDED_AT_BUILD'});
  const risk=JSON.parse(rendered.files['risk-profile.json']);
  assert.deepEqual(risk.limits,{max_daily_loss_percent:'3'});assert.equal(risk.policy_hash,scenario().contract.snapshot.policy_hash);
});

test('trace files render as stable CSV with quoting, and an optional boundary ref and limitation codes reach the package',()=>{
  const {rendered}=scenario({input:i=>{
    i.trace.decisions={columns:['time','note','flag','size'],rows:[['2026-10-19T00:05:00Z','has,comma "and" quote',true,1.25],['2026-10-19T00:06:00Z','line\nbreak',null,0]]};
    i.holdout_boundary_ref={boundary_id:'boundary-1'};i.limitations={codes:['RULES_VERSION_DIFFERS','ANOTHER_LIMIT','RULES_VERSION_DIFFERS']};
  }});
  assert.equal(rendered.files['quant-data/decisions.csv'],'time,note,flag,size\n2026-10-19T00:05:00Z,"has,comma ""and"" quote",true,1.25\n2026-10-19T00:06:00Z,"line\nbreak",,0\n');
  assert.equal(rendered.files['quant-data/equity.csv'],'time,equity\n2026-10-19T00:00:00Z,1000\n2026-10-19T00:01:00Z,1001.5\n');
  assert.deepEqual(rendered.binding.holdout_boundary_ref,{boundary_id:'boundary-1'});
  assert.deepEqual(rendered.manifest.limitations.codes,['ANOTHER_LIMIT','RULES_VERSION_DIFFERS']);
  assert.match(rendered.manifest.limitations.text,/ANOTHER_LIMIT, RULES_VERSION_DIFFERS/);
  const empty=scenario({input:i=>{i.trace.trades={columns:['entry_time','exit_time','pnl'],rows:[]};}});
  assert.equal(empty.rendered.files['quant-data/trades.csv'],'entry_time,exit_time,pnl\n');
  assert.equal(evaluateStructure(empty.subject).pass,true);
});

test('a non-fixture package carries no fixture banner and passes C1 and C3, and validation.html escapes every value',()=>{
  const live=scenario({contract:c=>{c.scope='SPT_NON_ENGINEERING_TEST';},input:i=>{i.fixture=false;}});
  assert.equal(live.rendered.manifest.fixture,false);assert.equal(live.rendered.binding.fixture,false);
  assert.doesNotMatch(live.rendered.files['validation.html'],/LABELLED ENGINEERING FIXTURE/);
  assert.doesNotMatch(live.rendered.files['setup-guide.md'],/LABELLED ENGINEERING FIXTURE/);
  assert.doesNotMatch(live.rendered.manifest.limitations.text,/Labelled engineering fixture/);
  assert.deepEqual(codesOf(evaluateStructure(live.subject)),[]);
  const fixture=scenario();
  assert.match(fixture.rendered.files['validation.html'],/LABELLED ENGINEERING FIXTURE/);
  assert.match(fixture.rendered.files['setup-guide.md'],/LABELLED ENGINEERING FIXTURE/);
  const hostile=scenario({result:r=>{r.selected.sensitivity[0].dimension='<script>alert("x")</script>&';}});
  const html=hostile.rendered.files['validation.html'];
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;'));
  assert.doesNotMatch(html,/<script|src=|href=|https?:/i,'no script or external reference');
});

test('the gate module still judges the rendered bytes: a tampered file, a changed Bridge block and a stripped or foreign trace record are refused',()=>{
  const base=scenario().subject;
  const tampered=clone(base);tampered.files['indicator.pine']+='\n// changed\n';
  assert.ok(codesOf(evaluateStructure(tampered)).includes('BI_CHECKSUM_MISMATCH'));
  const logic=clone(base);logic.files['indicator.pine']=logic.files['indicator.pine'].replace('"Bridge Risk-to-Reward"','"Bridge Risk-to-Reward!"');
  assert.notEqual(logic.files['indicator.pine'],base.files['indicator.pine']);
  assert.ok(codesOf(evaluateCompile(logic)).includes('BI_SOURCE_LOGIC_CHANGED'));
  const noTrace=clone(base);noTrace.trace_reproduction=[];
  assert.deepEqual(codesOf(evaluateProvenance(noTrace)),['BI_RESULT_MISMATCH','HOLDOUT_MISMATCH']);
  const otherTrace=clone(base);otherTrace.trace_reproduction[0].sha256=hex('other');
  assert.deepEqual(codesOf(evaluateProvenance(otherTrace)),['BI_RESULT_MISMATCH']);
});

test('the renderer refuses input it cannot render without inventing a value, and a refusal returns no package',()=>{
  const refused=(edit,code)=>assert.throws(()=>scenario(edit),error=>error.code===code&&error instanceof Error,code+' '+JSON.stringify(Object.keys(edit)));
  refused({input:i=>{i.export_id='export_run-1_alert_calls';}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.created_at='2026-10-19 12:00:00';}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.created_at='2026-13-45T99:00:00Z';}},'RENDER_INPUT_INVALID');
  refused({input:i=>{delete i.fixture;}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.library_versions=null;}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.risk_limits={};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.risk_limits={max_daily_loss_percent:'three'};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.exit_version='bridge-exit-v1';}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.trace.equity={columns:['time'],rows:[['a','b']]};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.trace.trades={columns:['a','a'],rows:[]};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.trace.decisions={columns:['time','x'],rows:[['t',Number.NaN]]};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{delete i.trace.decisions;}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.limitations={codes:['bad code']};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.run.contract_hash=hex('not-the-contract');}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.run.result={...i.run.result,selected:{...i.run.result.selected,test:undefined}};}},'RENDER_INPUT_INVALID');
  refused({input:i=>{i.run.result={...i.run.result,selected:null};}},'RENDER_INPUT_INVALID');
  refused({result:r=>{r.selected.parameters={...r.selected.parameters,rr:Number.POSITIVE_INFINITY};}},'RENDER_INPUT_INVALID');
  refused({result:r=>{r.selected.parameters={atr_multiplier:1.5,rr:1};}},'RENDER_INPUT_INVALID');
  refused({parameters:{atr_multiplier:1.5,rr:1,emaFastInput:35.5}},'RENDER_INPUT_INVALID');
  refused({contract:c=>{c.snapshot.membership.push({pine_import_id:'import-2',source_version:1,source_hash:hex('second')});}},'RENDER_MULTI_PINE_UNSUPPORTED');
  refused({contract:c=>{c.snapshot.market.symbol='ETHUSDT';}},'BI_MARKET_SCOPE_INVALID');
  refused({contract:c=>{c.snapshot.market.timeframe='5';}},'BI_MARKET_SCOPE_INVALID');
  refused({input:i=>{i.fixture=false;}},'BI_FIXTURE_LABEL_MISSING');
  refused({contract:c=>{c.input_lock.selection.bindings[0].source_span={start:0,end:5};}},'RENDER_SOURCE_UNRESOLVED');
  refused({contract:c=>{c.input_lock.selection.bindings[0].effective_value=49;}},'RENDER_SOURCE_UNRESOLVED');
  refused({contract:c=>{c.deployment_id='not-a-uuid';}},'RENDER_ASSEMBLE_FAILED');
  refused({contract:c=>{const p='rt_'+hash(DEPLOY).slice(0,12)+'_';c.source=SOURCE+p+'collide = 1\n';c.source_hash=hash(c.source);c.snapshot.membership[0].source_hash=c.source_hash;}},'RENDER_ASSEMBLE_FAILED');
  refused({contract:c=>{c.source=SOURCE+'strategy("x")\n';c.source_hash=hash(c.source);c.snapshot.membership[0].source_hash=c.source_hash;}},'RENDER_CONTENT_REFUSED');
});

test('content the C1 scan would refuse never leaves the renderer',()=>{
  const key='api_key = AbCdEf0123456789XyZ';
  assert.throws(()=>scenario({input:i=>{i.trace.decisions={columns:['time','note'],rows:[['2026-10-19T00:05:00Z',key]]};}}),error=>error.code==='RENDER_CONTENT_REFUSED'&&/BI_SECRET_DETECTED/.test(error.message));
  assert.throws(()=>scenario({input:i=>{i.trace.decisions={columns:['time','note'],rows:[['2026-10-19T00:05:00Z','C:\\Users\\someone\\file.txt']]};}}),
    error=>error.code==='RENDER_CONTENT_REFUSED'&&/BI_MACHINE_PATH_DETECTED/.test(error.message));
});

/* ---- round 2: custom sources, anchored span, required exit version and the low findings ---- */

const BRIDGE_PARAMS={atr_multiplier:1.5,rr:1};
/**
 * A scenario over a custom source. specs: [{variable, type, value, after, statement, slot, span?}]. The statement text must occur once
 * in the source; its stored span is the exact statement unless span is given. Bindings are written in the order of specs, whatever their slot.
 */
function custom(source,specs,edit={}){
  const parameters={...BRIDGE_PARAMS,...Object.fromEntries(specs.map(spec=>[spec.variable,spec.after]))};
  return scenario({parameters,contract:c=>{
    c.source=source;c.source_hash=hash(source);c.snapshot.membership[0].source_hash=c.source_hash;
    c.input_lock.selection.bindings=specs.map(spec=>{
      const start=source.indexOf(spec.statement);
      return {slot:spec.slot,input_id:'input_'+spec.slot,pine_variable:spec.variable,effective_value:spec.value,type:spec.type,
        search_domain:{min:1,max:100,step:1},source_span:spec.span===undefined?{start,end:start+spec.statement.length}:spec.span};
    });
    c.input_lock.selection.fixed_inputs=[];
    c.input_lock.domains={atr_multiplier:c.input_lock.domains.atr_multiplier,rr:c.input_lock.domains.rr,
      ...Object.fromEntries(specs.map(spec=>[spec.variable,[spec.value,spec.after]]))};
  },input:edit.input,result:edit.result});
}
const TAIL=['emaFast = ta.ema(close, 20)','buySignal = ta.crossover(emaFast, 1)','sellSignal = ta.crossunder(emaFast, 1)','plot(emaFast)',''];
const sourceOf=(...lines)=>['//@version=6','indicator("Custom fixture", overlay=true)',...lines,...TAIL].join('\n');
const A='aLen = input.int(10, "A")',B='bLen = input.int(20, "B")';
const failure=(thunk,code,detail)=>assert.throws(thunk,error=>error.code===code&&(detail===undefined||detail.test(error.message)),code+' '+detail);

test('two edits in a source where the bindings are written out of source order are sorted by position and the slots are sorted in inputs.json',()=>{
  const source=sourceOf(A,B);
  const run=custom(source,[{variable:'bLen',type:'int',value:20,after:25,statement:B,slot:2},{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1}]);
  const indicator=run.rendered.files['indicator.pine'];
  assert.ok(indicator.startsWith(source.replace('input.int(10,','input.int(15,').replace('input.int(20,','input.int(25,')));
  const edits=JSON.parse(run.rendered.files['indicator.json']).edits;
  assert.deepEqual(edits.map(edit=>[edit.input_id,edit.before,edit.after]),[['input_1','10','15'],['input_2','20','25']]);
  assert.ok(edits[0].start<edits[1].start);
  assert.deepEqual(JSON.parse(run.rendered.files['inputs.json']).source_inputs.map(item=>item.slot),[1,2]);
  assert.deepEqual(JSON.parse(run.rendered.files['indicator.json']).selected_slots.map(item=>item.slot),[1,2]);
  assert.equal(evaluateCompile(run.subject).pass,true);
});

test('two bindings that edit the same bytes are refused as overlapping edits',()=>{
  const source=sourceOf(A);
  failure(()=>custom(source,[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1},{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:2}]),
    'RENDER_SOURCE_UNRESOLVED',/overlapping edits/);
});

test('when a call has both a named defval and a positional argument the named one is the default',()=>{
  const statement='lvl = input.float(0.5, defval=0.7, minval=0.1)',source=sourceOf(statement);
  const run=custom(source,[{variable:'lvl',type:'float',value:0.7,after:0.9,statement,slot:1}]);
  assert.ok(run.rendered.files['indicator.pine'].includes('input.float(0.5, defval=0.9, minval=0.1)'));
  assert.deepEqual(JSON.parse(run.rendered.files['indicator.json']).edits.map(edit=>[edit.before,edit.after]),[['0.7','0.9']]);
  failure(()=>custom(source,[{variable:'lvl',type:'float',value:0.5,after:0.9,statement,slot:1}]),'RENDER_SOURCE_UNRESOLVED',/default literal/);
});

test('a stored span outside the source or not a valid range is refused as a bad source span',()=>{
  const source=sourceOf(A),start=source.indexOf(A),end=start+A.length;
  for(const span of [{start,end:source.length+10},{start,end:source.length+1},{start:-1,end},{start:end,end:start},{start:start+0.5,end},{start,end:undefined},null])
    failure(()=>custom(source,[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1,span}]),'RENDER_SOURCE_UNRESOLVED',/source span/);
  assert.equal(custom(source,[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1,span:{start,end}}]).rendered.manifest.binding.pine_import_id,IMPORT);
});

test('the stored span must hold the statement of the bound variable, with the bound call kind, ending at its closing parenthesis',()=>{
  const first='fastLen = input.int(10, "F")',second='slowLen = input.int(10, "S")',source=sourceOf(first,second);
  const start=source.indexOf(first),secondStart=source.indexOf(second);
  const bind=(variable,span)=>()=>custom(source,[{variable,type:'int',value:10,after:15,statement:first,slot:1,span}]);
  // a wide span from the first statement over the second names the first variable, not the bound one
  failure(bind('slowLen',{start,end:secondStart+second.length}),'RENDER_SOURCE_UNRESOLVED',/another variable/);
  // a span that starts on the bound variable but runs past its closing parenthesis
  failure(bind('slowLen',{start:secondStart,end:secondStart+second.length+8}),'RENDER_SOURCE_UNRESOLVED',/closing parenthesis/);
  failure(bind('fastLen',{start,end:start+first.length+1}),'RENDER_SOURCE_UNRESOLVED',/closing parenthesis/);
  // a span that stops before the closing parenthesis
  failure(bind('fastLen',{start,end:start+first.length-1}),'RENDER_SOURCE_UNRESOLVED',/unbalanced/);
  // a span that starts inside the statement is not anchored at an input statement
  failure(bind('fastLen',{start:start+first.indexOf('='),end:start+first.length}),'RENDER_SOURCE_UNRESOLVED',/no input statement/);
  failure(bind('fastLen',{start:start+1,end:start+first.length}),'RENDER_SOURCE_UNRESOLVED',/another variable/);
  // a span that starts mid-line, after another identifier, is not at a line start
  const prefixed='x'+first,prefixedSource=sourceOf(prefixed),prefixedStart=prefixedSource.indexOf(prefixed);
  failure(()=>custom(prefixedSource,[{variable:'fastLen',type:'int',value:10,after:15,statement:first,slot:1,span:{start:prefixedStart+1,end:prefixedStart+prefixed.length}}]),'RENDER_SOURCE_UNRESOLVED',/line start/);
  // the second statement still resolves when the span is exact
  const ok=custom(source,[{variable:'slowLen',type:'int',value:10,after:15,statement:second,slot:1}]);
  assert.ok(ok.rendered.files['indicator.pine'].includes('slowLen = input.int(15, "S")')&&ok.rendered.files['indicator.pine'].includes('fastLen = input.int(10, "F")'));
  // an int binding on an input.float call is refused
  const floatStatement='ratio = input.float(10, "R")';
  failure(()=>custom(sourceOf(floatStatement),[{variable:'ratio',type:'int',value:10,after:15,statement:floatStatement,slot:1}]),'RENDER_SOURCE_UNRESOLVED',/call kind/);
  // a typed declaration is accepted
  const typed='var int typedLen = input.int(10, "T")';
  assert.ok(custom(sourceOf(typed),[{variable:'typedLen',type:'int',value:10,after:15,statement:typed,slot:1}]).rendered.files['indicator.pine'].includes('input.int(15, "T")'));
});

test('a CR-only source renders after a lone carriage return and refuses a span that is not at a line start',()=>{
  const source=['indicator("Cr fixture", overlay=true)',A,B,...TAIL].join('\r');
  const run=custom(source,[{variable:'bLen',type:'int',value:20,after:25,statement:B,slot:1}]);
  const edits=JSON.parse(run.rendered.files['indicator.json']).edits;
  assert.deepEqual(edits.map(edit=>source.slice(edit.start,edit.end)),['20']);
  assert.ok(run.rendered.files['indicator.pine'].startsWith(source.replace('input.int(20,','input.int(25,')));
  assert.equal(evaluateCompile(run.subject).pass,true);
  const prefixed='x'+A,prefixedSource=['indicator("Cr fixture", overlay=true)',prefixed,...TAIL].join('\r'),prefixedStart=prefixedSource.indexOf(prefixed);
  failure(()=>custom(prefixedSource,[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1,span:{start:prefixedStart+1,end:prefixedStart+prefixed.length}}]),'RENDER_SOURCE_UNRESOLVED',/line start/);
});

test('exit_version is required and never defaulted',()=>{
  failure(()=>scenario({input:i=>{delete i.exit_version;}}),'BI_BINDING_INCOMPLETE');
  failure(()=>scenario({input:i=>{i.exit_version=null;}}),'BI_BINDING_INCOMPLETE');
  failure(()=>scenario({input:i=>{i.exit_version=2;}}),'RENDER_INPUT_INVALID');
  failure(()=>scenario({input:i=>{i.exit_version='';}}),'RENDER_INPUT_INVALID');
  failure(()=>scenario({input:i=>{i.exit_version='bridge-exit-v1';}}),'RENDER_INPUT_INVALID');
  assert.equal(scenario().rendered.binding.exit_version,'bridge-exit-v2');
  assert.equal(RENDER_REFUSAL_CODES.includes('BI_BINDING_INCOMPLETE'),true);
});

test('the manifest binds the exact bytes of inputs.json and carries the artifact schemas and the trace semantics',()=>{
  const {rendered,subject}=scenario();
  assert.equal(rendered.manifest.inputs.inputs_sha256,hash(rendered.files['inputs.json']));
  assert.notEqual(rendered.manifest.inputs.inputs_sha256,hash(rendered.files['indicator.json']));
  assert.deepEqual(Object.keys(rendered.manifest).sort(),['binding','evidence','files','fixture','identity','inputs','limitations','schema_version']);
  const {artifact_schemas:schemas,trace_semantics:semantics}=rendered.manifest.evidence;
  assert.ok(Object.keys(schemas).length>0&&Object.keys(schemas).every(path=>PACKAGE_FILES.includes(path)&&typeof schemas[path]==='string'));
  for(const path of ['inputs.json','indicator.json','risk-profile.json','quant-data/metrics.json','quant-data/validation.json',...TRACE_FILES])assert.ok(Object.hasOwn(schemas,path),path);
  assert.match(semantics,/native signals/i);assert.match(semantics,/intents/i);assert.match(semantics,/fills/i);assert.match(semantics,/position episode/i);
  assert.match(rendered.files['setup-guide.md'],/alert message field/);
  assert.equal(evaluateStructure(subject).pass,true);
});

test('the selected parameters must be exactly the bound variables plus the Bridge pair, and membership must match the contract',()=>{
  failure(()=>scenario({result:r=>{r.selected.parameters={...r.selected.parameters,ghostDim:3};}}),'RENDER_INPUT_INVALID',/exactly the binding variables/);
  failure(()=>scenario({result:r=>{delete r.selected.parameters.emaFastInput;}}),'RENDER_INPUT_INVALID',/exactly the binding variables/);
  failure(()=>scenario({contract:c=>{c.snapshot.membership[0].pine_import_id='7a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e';}}),'RENDER_INPUT_INVALID',/membership\[0\]/);
  failure(()=>scenario({contract:c=>{c.snapshot.membership[0].source_version=2;}}),'RENDER_INPUT_INVALID',/membership\[0\]/);
  failure(()=>scenario({contract:c=>{c.snapshot.membership[0].source_hash=hex('other-source');}}),'RENDER_INPUT_INVALID',/membership\[0\]/);
});

test('an extra selected parameter that sorts after every expected key is refused',()=>{
  failure(()=>scenario({result:r=>{r.selected.parameters={...r.selected.parameters,zzz:3};}}),'RENDER_INPUT_INVALID',/exactly the binding variables/);
});

test('at most eight selected source inputs are rendered, and nine are refused',()=>{
  const build=count=>{
    const specs=Array.from({length:count},(_,index)=>({variable:'len'+index,type:'int',value:10+index,after:30+index,statement:'len'+index+' = input.int('+(10+index)+', "L'+index+'")',slot:index+1}));
    return custom(sourceOf(...specs.map(spec=>spec.statement)),specs);
  };
  const eight=build(8);
  assert.equal(JSON.parse(eight.rendered.files['inputs.json']).source_inputs.length,8);
  assert.equal(JSON.parse(eight.rendered.files['indicator.json']).edits.length,8);
  failure(()=>build(9),'RENDER_INPUT_INVALID',/more than 8 selected source inputs/);
});

test('a CRLF source is edited in place and its line endings are kept',()=>{
  const source=['//@version=6','indicator("Crlf fixture", overlay=true)',A,B,...TAIL].join('\r\n');
  const run=custom(source,[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1},{variable:'bLen',type:'int',value:20,after:25,statement:B,slot:2}]);
  const edits=JSON.parse(run.rendered.files['indicator.json']).edits;
  assert.deepEqual(edits.map(edit=>source.slice(edit.start,edit.end)),['10','20']);
  assert.ok(run.rendered.files['indicator.pine'].startsWith(source.replace('input.int(10,','input.int(15,').replace('input.int(20,','input.int(25,')));
});

test('Markdown and HTML in the indicator title, the units and the run id are escaped in setup-guide.md',()=>{
  const title='<img src=x onerror=1> [go](javascript:1) *b* _c_ `d`';
  const source=['//@version=6','indicator("'+title+'", overlay=true)',A,...TAIL].join('\n');
  const run=custom(source,[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1}],{input:i=>{i.units={aLen:'bars <b>x</b>\n[l](u)'};}});
  const guide=run.rendered.files['setup-guide.md'];
  assert.ok(!guide.includes('<img')&&!guide.includes('<b>'));
  assert.ok(!/(?<!\\)\[go\]/.test(guide)&&!/(?<!\\)\]\(/.test(guide));
  assert.ok(guide.includes('\\[go\\]\\(javascript:1\\)')&&guide.includes('&lt;img src=x onerror=1&gt;'));
  assert.ok(guide.includes('bars &lt;b&gt;x&lt;/b&gt; \\[l\\]\\(u\\)'));
  assert.ok(!guide.split('\n').some(line=>line.startsWith('[')),'no injected line');
  const id=custom(sourceOf(A),[{variable:'aLen',type:'int',value:10,after:15,statement:A,slot:1}],{input:i=>{i.run.run_id='run-<i>-1';}});
  assert.ok(id.rendered.files['setup-guide.md'].includes('run-&lt;i&gt;-1')&&!id.rendered.files['setup-guide.md'].includes('<i>'));
});

test('validation.html escapes a single quote',()=>{
  const {rendered}=scenario({result:r=>{r.selected.sensitivity[0].dimension="O'Brien";}});
  assert.ok(rendered.files['validation.html'].includes('O&#39;Brien'));
  assert.ok(!rendered.files['validation.html'].includes("O'Brien"));
});

test('numbers are written as plain decimals: no exponent in CSV, inputs or risk limits, and small exact values are kept',()=>{
  const {rendered}=scenario({input:i=>{
    i.trace.equity={columns:['time','a','b','c','d','e'],rows:[['t',1e21,1e-7,1.2345678901234566e-7,-1.5e-9,-0]]};
    i.risk_limits={max_daily_loss_percent:'3',tiny:1.5e-7,huge:1e21};
  }});
  assert.equal(rendered.files['quant-data/equity.csv'],'time,a,b,c,d,e\nt,1000000000000000000000,0.0000001,0.00000012345678901234566,-0.0000000015,0\n');
  assert.deepEqual(JSON.parse(rendered.files['risk-profile.json']).limits,{huge:'1000000000000000000000',max_daily_loss_percent:'3',tiny:'0.00000015'});
  for(const [path,content] of Object.entries(rendered.files))if(path.endsWith('.csv'))assert.doesNotMatch(content,/\d[eE][+-]?\d/,path);
  const statement='lvl = input.float(0.5, "L")';
  const small=custom(sourceOf(statement),[{variable:'lvl',type:'float',value:0.5,after:1.2345678901234566e-7,statement,slot:1}]);
  assert.equal(JSON.parse(small.rendered.files['inputs.json']).source_inputs[0].after,'0.00000012345678901234566');
});

test('created_at must be a real calendar time',()=>{
  for(const stamp of ['2026-02-30T00:00:00Z','2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-10-19T24:00:00Z','2026-00-10T00:00:00Z','2026-10-00T00:00:00Z','2026-10-19T12:60:00Z'])
    failure(()=>scenario({input:i=>{i.created_at=stamp;}}),'RENDER_INPUT_INVALID');
  for(const stamp of ['1900-02-29T00:00:00Z','2100-02-29T00:00:00Z'])failure(()=>scenario({input:i=>{i.created_at=stamp;}}),'RENDER_INPUT_INVALID');
  assert.equal(scenario({input:i=>{i.created_at='2000-02-29T00:00:00Z';}}).rendered.binding.created_at,'2000-02-29T00:00:00Z');
  assert.equal(scenario({input:i=>{i.created_at='2028-02-29T23:59:59Z';}}).rendered.binding.created_at,'2028-02-29T23:59:59Z');
  assert.equal(scenario({input:i=>{i.created_at='2026-12-31T23:59:59.123456789Z';}}).rendered.binding.created_at,'2026-12-31T23:59:59.123456789Z');
});
