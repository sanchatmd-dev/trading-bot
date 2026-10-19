import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {assemble} from '../src/pine-bridge/template.js';
import {RULES} from '../src/quant-research/contract.js';
import {LIBRARY_VERSIONS,QUALIFIED_TOTAL,QUALIFIED_WINNER,holdoutWindow,qualification} from '../src/quant-library/derive.js';
import {PACKAGE_GATE_VERSION,MANIFEST_SCHEMA,CODE_PATTERN,MAX_VALIDATION_ATTEMPTS,PACKAGE_FILES,MANIFEST_PATH,RETRYABLE_CODES,BINDING_FIELDS,MODES,STATUS,
  CANDIDATE_BLOCKERS,CAPABILITY_BLOCKERS,OWNER_RECOMMENDATION_CONTRACT_VERSIONS,FRESHNESS_ORDER,EPISODE_GATE_VERSION,METRIC_KEYS,
  bindingHash,packageHash,fileEntries,buildManifest,scanContent,bindingComplete,effectiveInputHash,searchedWindow,ownerRecommendationGate,libraryG8,
  qualifiedFromRecords,evaluateBuildEligibility,evaluateStructure,evaluateCompile,evaluateProvenance,evaluateValidation,evaluateQualification,
  evaluatePackage,transition,freshness,freshnessCodes,isReady,readState,diagnosticBundle,isRetryable,isHardFailure,notReached,INPUT_INVALID,isRefused,TRACE_FILES,QUALIFYING_GATES,
  MULTI_PINE_CONTRACT_VERSION,MULTI_PINE_BLOCKER,REPLAY_STATE_UNAVAILABLE,SUPPORTED_EXIT_VERSIONS}
  from '../src/quant-library/package-gates.js';
import {contractOf,runOf,hex,metricsOf,parameters,MINUTE,T0} from './helpers/quant-library-fixture.mjs';

/*
 * Every package below is a LABELLED ENGINEERING FIXTURE (fixture: true): synthetic data, never a research result and never a
 * recommendation. The gate module is pure, so no database, clock, network or file is used here.
 */
const OWNER='owner-a',BOT='bot-a',DEPLOY='3c1d0a52-7b9e-4c1a-9a26-0f1e2d3c4b5a',IMPORT='8a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e',RUN_ID='run-gold-0001',EXPORT_ID='9f1c2b7e-3d4a-4b5c-8d6e-0123456789ab';
const NEW_VERSION=OWNER_RECOMMENDATION_CONTRACT_VERSIONS[0];
const clone=value=>JSON.parse(JSON.stringify(value));
const json=(value,space=2)=>JSON.stringify(value,null,space)+'\n';
const editJson=(files,path,change)=>{const value=JSON.parse(files[path]);change(value);files[path]=json(value);};
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(key=>[key,sorted(value[key])])):value;

// Every code any evaluation returns in this file, so the final tests can prove coverage and the code pattern.
const seen=new Set();
const note=result=>{for(const gate of result.gates??[result])for(const code of gate.codes)seen.add(code);return result;};
const B0=subject=>note(evaluateBuildEligibility(subject)),C1=subject=>note(evaluateStructure(subject)),C2=subject=>note(evaluateCompile(subject)),
  C3=subject=>note(evaluateProvenance(subject)),C4=subject=>note(evaluateValidation(subject)),ALL=subject=>note(evaluatePackage(subject));
const codesOf=result=>[...result.codes];
const expectCodes=(result,codes,label)=>assert.deepEqual(codesOf(result),codes,label);

const SOURCE=['//@version=6','indicator("Golden fixture indicator", overlay=true)','emaFastInput = input.int(50, "EMA fast", minval=30, maxval=50, step=10)',
  'useSlowFilter = input.bool(true, "Slow filter")','notifyEnabled = input.bool(false, "Notify")','emaFast = ta.ema(close, emaFastInput)',
  'emaSlow = ta.ema(close, 100)','buySignal = ta.crossover(emaFast, emaSlow)','sellSignal = ta.crossunder(emaFast, emaSlow)','plot(emaFast)',''].join('\n');
const STATEMENT='emaFastInput = input.int(50, "EMA fast", minval=30, maxval=50, step=10)';
const SPAN_START=SOURCE.indexOf(STATEMENT),LITERAL_START=SPAN_START+STATEMENT.indexOf('(')+1;
const NOW='2026-10-19T12:00:00Z',CREATED='2026-10-19T11:30:00Z';
const MARKET_OBJECT={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
/** The deterministic Bridge output the contract demands for indicator.pine (section 5.2): the edited source plus the reviewed template block. */
const bridgeIndicator=(prefix,atr,rr,deployment={})=>assemble(prefix,{bridge:{atr_multiplier:Number(atr),rr:Number(rr)},signals:{buy:'buySignal',exit:'sellSignal'},bindings:[],fixed_inputs:[]},
  {deployment_id:DEPLOY,pine_import_id:IMPORT,source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',...deployment}).integrated_pine;
const CLEARANCE_EVIDENCE={VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED:'native_parity',CUSTOM_REPAINT_EVIDENCE_REQUIRED:'repaint'};
const proofHash=(evidence,blocker)=>hash(canonical(evidence[CLEARANCE_EVIDENCE[blocker]]));
/** Re-bind the clearance records to the evidence records now in the subject, so a test that edits one evidence record still isolates its own code. */
const syncClearances=subject=>{for(const item of subject.clearances)if(CLEARANCE_EVIDENCE[item.blocker]&&subject.evidence?.[CLEARANCE_EVIDENCE[item.blocker]])item.evidence_hash=proofHash(subject.evidence,item.blocker);};
const withRate=(metric,rate)=>({...metric,win_rate:rate});

/**
 * A complete, internally consistent golden package subject. The edit callbacks change one thing before everything derived
 * from it (hashes, manifest, compile record, evidence scope) is computed, so a negation produces only its own code.
 * contract(c), result(r, c), binding(b), files(map), manifest(m), subject(s) run in that order.
 */
function golden(edit={}){
  const contract=clone(contractOf({owner:OWNER,bot:BOT,deployment:DEPLOY,importId:IMPORT,tag:'gold'}));
  Object.assign(contract,{version:NEW_VERSION,source:SOURCE,source_hash:hash(SOURCE),policy_version:'policy-v1',acceptance_blockers:[...CANDIDATE_BLOCKERS]});
  contract.snapshot.policy={max_daily_loss_percent:'3',equities:{'binance-global':'1000'}};
  contract.snapshot.membership=[{pine_import_id:IMPORT,source_version:1,source_hash:contract.source_hash}];
  contract.input_lock.selection.bindings[0].source_span={start:SPAN_START,end:SPAN_START+STATEMENT.length};
  edit.contract?.(contract);
  const P=parameters(1);
  const evaluation=(kind,params,train,validation,test)=>({kind,parameters:params,train,validation,...(test?{test}:{})});
  const best=evaluation('CANDIDATE',P,withRate(metricsOf('4.1',9),'55.56'),withRate(metricsOf('3.2',8),'62.50'));
  const neighbour=(name,value)=>{const params={...P,[name]:value};return {dimension:name,parameters:params,result:evaluation('SENSITIVITY',params,metricsOf('3.0',9),metricsOf('2.9',8))};};
  const selected={parameters:P,result:best,screen_reasons:[],sensitivity:[neighbour('atr_multiplier',2),neighbour('rr',1.25),neighbour('emaFastInput',40)],
    cost_stress:evaluation('STRESS',P,metricsOf('3.5',9),metricsOf('2.4',8)),test:withRate(metricsOf('1.9',9,'1.5'),'66.67')};
  const result={scope:contract.scope,contract_hash:hash(canonical(contract)),input_lock_hash:contract.input_lock.lock_hash,dataset_hash:contract.dataset.sha256,
    search_algorithm:contract.plan.algorithm,seed:contract.plan.seed,budget:contract.plan.requested_budget,candidate_count:6,selected_dimensions:3,covered_dimensions:3,
    dimension_coverage_percent:100,candidates:[{parameters:P,result:best,screen_reasons:[]}],selected,owner_recommendation_ready:false,
    acceptance_blockers:contract.acceptance_blockers,holdout_evaluated:true,completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'};
  edit.result?.(result,contract);
  const run={owner_id:OWNER,bot_id:BOT,run_id:RUN_ID,status:'SUCCEEDED',contract,contract_hash:hash(canonical(contract)),submission_hash:hex('submission-gold'),result,
    created_at_utc:CREATED,integrity:{contract_hash_verified:true,report_matches_checkpoints:true}};
  const chosen=result.selected,params=chosen?.parameters??{};
  const slotAfter=String(params.emaFastInput??30),effective=hash(canonical({selected:Object.fromEntries(contract.input_lock.selection.bindings.map(item=>[item.pine_variable,item.effective_value])),
    fixed:Object.fromEntries(contract.input_lock.selection.fixed_inputs.map(item=>[item.pine_variable,item.effective_value])),bridge:contract.input_lock.selection.bridge}));
  const members=contract.snapshot.membership,dataset=(({bars:_bars,...rest})=>rest)(contract.dataset);
  const binding={owner_id:OWNER,bot_id:BOT,run_id:RUN_ID,contract_hash:run.contract_hash,submission_hash:run.submission_hash,deployment_id:DEPLOY,pine_import_id:IMPORT,
    source_version:1,source_hash:contract.source_hash,baseline_snapshot_hash:contract.baseline_snapshot_hash,input_lock_hash:contract.input_lock.lock_hash,
    slot_bindings:contract.input_lock.selection.bindings.map(item=>({slot:item.slot,input_id:item.input_id,pine_variable:item.pine_variable})),
    bridge_domains:{atr_multiplier:contract.input_lock.domains.atr_multiplier,rr:contract.input_lock.domains.rr},effective_input_hash:effective,
    policy_version:contract.policy_version,policy_hash:contract.snapshot.policy_hash,capital:contract.capital,ledger_initialization:contract.ledger_initialization,
    model:contract.model,cost_model_version:contract.model.version,dataset_ref:dataset,split:contract.split,engine_hash:contract.engine_hash,rules:contract.rules,
    acceptance_blockers:contract.acceptance_blockers,library_versions:LIBRARY_VERSIONS,library_record_ref:{run_id:RUN_ID,result_sha256:hash(canonical(result))},
    alert_source:'alert_calls',exit_version:'bridge-exit-v2',market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},mode:members.length===1?'ONE_PINE':'MULTI_PINE',
    pine_count:members.length,membership:clone(members),fixture:true,created_at:NOW};
  edit.binding?.(binding);
  const inputs={run_id:RUN_ID,source_hash:contract.source_hash,effective_input_hash:effective,
    source_inputs:[{slot:3,input_id:'input_3',pine_variable:'emaFastInput',kind:'int',unit:'bars',before:'50',after:slotAfter,domain:{min:'30',max:'50',step:'10'}}],
    bridge:{atr_multiplier:{unit:'ATR multiple',before:'2',after:String(params.atr_multiplier??1.5),domain:{min:'1',max:'4',step:'0.5'}},
      rr:{unit:'reward to risk ratio',before:'1.5',after:String(params.rr??1),domain:{min:'1',max:'2',step:'0.25'}}},
    fixed_inputs:[{input_id:'input_9',pine_variable:'useSlowFilter',value:true},{input_id:'input_10',pine_variable:'notifyEnabled',value:false}]};
  const edits=[{input_id:'input_3',start:LITERAL_START,end:LITERAL_START+2,before:'50',after:slotAfter}];
  const editedSource=SOURCE.slice(0,LITERAL_START)+slotAfter+SOURCE.slice(LITERAL_START+2);
  const indicator=bridgeIndicator(editedSource,inputs.bridge.atr_multiplier.after,inputs.bridge.rr.after);
  const part=metric=>metric?{...metric}:{};
  const files={'inputs.json':json(inputs),'indicator.pine':indicator,
    'indicator.json':json({indicator:{name:'Golden fixture indicator',version:1},pine_version:6,selected_slots:binding.slot_bindings,alert_source:'alert_calls',
      exit_version:'bridge-exit-v2',symbol:'BINANCE:BTCUSDT',timeframe:'1',edits},4),
    'risk-profile.json':json({policy_version:contract.policy_version,policy_hash:contract.snapshot.policy_hash,policy:contract.snapshot.policy,limits:{max_daily_loss_percent:'3'}}),
    'setup-guide.md':'# Setup guide\n\nCreate the TradingView alert from the indicator condition. Webhook credentials stay outside this package.\n',
    'validation.html':'<!doctype html><html><body><h1>Validation</h1><p>Labelled engineering fixture.</p></body></html>\n',
    'quant-data/metrics.json':json({train:part(chosen?.result?.train),validation:part(chosen?.result?.validation),test:part(chosen?.test)}),
    'quant-data/equity.csv':'time,equity\n2026-10-19T00:00:00Z,1000\n','quant-data/trades.csv':'entry_time,exit_time,pnl\n2026-10-19T00:05:00Z,2026-10-19T00:20:00Z,1.5\n',
    'quant-data/decisions.csv':'time,decision\n2026-10-19T00:05:00Z,accepted\n',
    'quant-data/validation.json':json({candidate:{parameters:chosen?.parameters,result:chosen?.result},sensitivity:chosen?.sensitivity,cost_stress:chosen?.cost_stress,holdout:{test:chosen?.test}},0)};
  edit.files?.(files);
  const manifest=buildManifest({identity:{export_id:EXPORT_ID,bot_id:BOT,run_id:RUN_ID,created_at:NOW},binding,inputs:{inputs_sha256:hash(files['inputs.json'])},
    evidence:{engine_hash:contract.engine_hash,run_id:RUN_ID,result_sha256:hash(canonical(result))},
    limitations:{text:'Labelled engineering fixture. Not a research result and not a recommendation.',codes:[]},fixture:true,files});
  edit.manifest?.(manifest);
  files[MANIFEST_PATH]=json(manifest);
  const scope=()=>({source_hash:contract.source_hash,effective_input_hash:effective,dataset_digest:contract.dataset.sha256,engine_hash:contract.engine_hash});
  const own=holdoutWindow(contract);
  const evidence={dataset_alignment:{matched_percent:100,unmatched_bars:0,future_leakage:0,scope:scope()},
    native_parity:{match_percent:100,missing_events:0,additional_events:0,shift_bars:0,
      sample:{warmup_bars:800,lookback:100,closed_bars:5000,native_events:200,buy_events:60,exit_events:60},scope:scope()},
    bridge_parity:{match_percent:100,sl_tp_diff_ticks:0,exit_version:'bridge-exit-v2',scope:scope()},
    repaint:{observations:120,changed_flags:0,scope:scope()},
    quant_baseline:{coverage_percent:100,decision_match_percent:100,quantity_step_diff:0,cash_diff_minor_units:1,scope:scope()}};
  const stepsDigest=hash(canonical({candidate:{parameters:chosen?.parameters,result:chosen?.result},sensitivity:chosen?.sensitivity,cost_stress:chosen?.cost_stress}));
  const holdoutDigest=hash(canonical({test:chosen?.test}));
  const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:contract.dataset.start_time,
    end_time:contract.dataset.end_time+MINUTE,warmup_bars:contract.dataset.warmup_bars,total_bars:contract.dataset.bar_count,cutoff:contract.dataset.end_time+MINUTE,source:'binance-spot-klines-v1'};
  const register=[
    {owner_id:'owner-b',market:{...MARKET_OBJECT},source_hash:hex('other-owner'),window:{...own},comparison_id:'cmp-other-owner',at_utc:'2026-10-19T10:00:00Z'},
    {owner_id:OWNER,market:{...MARKET_OBJECT,symbol:'ETHUSDT'},window:{...own},selection_id:'sel-other-market',at_utc:'2026-10-19T10:00:00Z'},
    {owner_id:OWNER,market:{...MARKET_OBJECT},source_hash:hex('later'),window:{...own},comparison_id:'cmp-after-creation',at_utc:'2026-10-19T11:30:01Z'}];
  const subject={owner_id:OWNER,export_id:EXPORT_ID,run,binding,internal:false,export:{library_versions:clone(LIBRARY_VERSIONS)},current_rules:clone(RULES),replay_mismatch:false,files,package_hash:packageHash(manifest),binding_hash:bindingHash(binding),
    holdout:{earlier_holdouts:[{start_time:T0-5000*MINUTE,end_time:T0-4000*MINUTE}],earlier_searched:[{start_time:T0-5000*MINUTE,end_time:T0-4000*MINUTE}],registered_boundary:{exists:false},
      exposure_register:register},
    compile:{export_id:EXPORT_ID,indicator_sha256:hash(files['indicator.pine']),pine_version:6,errors:[],
      warnings:[{text:'The variable notifyEnabled is never used.',disposition:'ACCEPTED_BENIGN',reviewer_role:'ROOT'}],unresolved_references:0,collisions:0,duplicate_bindings:0,
      mapping_check:contract.input_lock.selection.bindings.map(item=>({slot:item.slot,pine_variable:item.pine_variable})),compiled_at_utc:'2026-10-19T11:00:00Z',
      operator_role:'ROOT',method:'ROOT_COORDINATED_TRADINGVIEW'},
    native_alert_isolation:{routes_disabled:true,unrelated_payloads:0,native_payloads:0},deployment:{exit_version:'bridge-exit-v2'},
    dataset:{readable:true,digest:contract.dataset.sha256,metadata},hard_limits:{max_daily_loss_percent:{max:'5'}},
    trace_reproduction:TRACE_FILES.map(path=>({path,sha256:hash(files[path]),steps_digest:stepsDigest,holdout_digest:holdoutDigest})),
    evidence,
    clearances:CANDIDATE_BLOCKERS.map(blocker=>({blocker,run_id:RUN_ID,export_id:EXPORT_ID,parameter_hash:hash(canonical(params)),evidence_hash:proofHash(evidence,blocker)})),
    current:{deployment_id:DEPLOY,membership:clone(members),policy_version:contract.policy_version,policy_hash:contract.snapshot.policy_hash,
      input_lock_hash:contract.input_lock.lock_hash,dataset_available:true,bot_owner_id:OWNER},
    bridge_bounds:{atr_multiplier:{min:'0.5',max:'5'},rr:{min:'0.5',max:'3'}},
    attempt:{attempt_id:'attempt-0001',validator_engine_hash:hex('validator-engine'),validated_at_utc:'2026-10-19T12:05:00Z'},attempt_no:1,own_holdout:own};
  edit.subject?.(subject);
  return subject;
}
/** Re-pack after a file change so the manifest checksums stay consistent and only the targeted code appears. */
function repack(subject,changes){
  const next=clone(subject);
  for(const [path,value] of Object.entries(changes)){if(value===null)delete next.files[path];else next.files[path]=value;}
  const manifest=JSON.parse(next.files[MANIFEST_PATH]);
  manifest.files=fileEntries(next.files);
  next.files[MANIFEST_PATH]=json(manifest);
  next.package_hash=packageHash(manifest);
  return next;
}
const shape=result=>result.gates.map(gate=>[gate.gate,gate.state,[...gate.codes]]);
const SECOND={pine_import_id:'import-2',source_version:1,source_hash:hex('second-source')};
/**
 * The F17-like multi-Pine internal fixture (RC-11): two members, the multi-Pine contract version, the completion reason that derives
 * G7 PASS, a holdout evaluated, candidate blockers plus MULTI_PINE_REQUIRES_APP_3B, clearance records for the candidate blockers,
 * and a package created internal. G7 stays FAIL for it (the version is never listed) and that is the tolerated failure.
 */
const internalGolden=(edit={})=>golden({...edit,contract:c=>{c.version=MULTI_PINE_CONTRACT_VERSION;c.snapshot.membership.push(clone(SECOND));
  c.acceptance_blockers=[...CANDIDATE_BLOCKERS,MULTI_PINE_BLOCKER];edit.contract?.(c);},subject:s=>{s.internal=true;edit.subject?.(s);}});

test('the golden fixture passes B0 at build and C1 to C4 at the attempt, reaches EXPORT_VALIDATED, is never READY and never a G8 source',()=>{
  const subject=golden(),result=ALL(subject),build=B0(subject);
  assert.equal(PACKAGE_GATE_VERSION,'best-inputs-gates-v1');
  assert.equal(build.pass,true,'B0 is a build-time gate and is evaluated on its own');
  assert.deepEqual(result.gates.map(gate=>[gate.gate,gate.state]),[['C1','PASS'],['C2','PASS'],['C3','PASS'],['C4','PASS'],['Q','PASS']],'the attempt never re-runs B0');
  assert.deepEqual([...QUALIFYING_GATES],['C1','C2','C3','C4']);
  assert.deepEqual(codesOf(result),[]);
  assert.equal(result.pass,true);assert.equal(result.refused,undefined);
  assert.equal(result.status,STATUS.EXPORT_VALIDATED);
  assert.deepEqual([...result.limitations],[]);
  assert.equal(result.ready,false,'a fixture is never READY');
  assert.ok(!('package' in result)&&!('diagnostic' in result),'no build decision at attempt time');
  assert.equal(result.record.fixture,true);
  assert.equal(result.record.export_id,EXPORT_ID);
  assert.equal(result.record.package_hash,subject.package_hash);assert.equal(result.record.binding_hash,subject.binding_hash);
  assert.deepEqual(result.record.gate_results.map(gate=>gate.gate),['C1','C2','C3','C4']);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.gates)&&Object.isFrozen(result.record)&&result.gates.every(Object.isFrozen));
  const records=[{run_id:RUN_ID,mode:'ONE_PINE',record:result.record}];
  assert.equal(libraryG8(records,RUN_ID).state,'FAIL','a fixture record is never a G8 source');
  assert.deepEqual({...qualifiedFromRecords(records)},{total:0,winner:null,runs:[]});
  assert.equal(readState({status:result.status,binding:subject.binding,current:subject.current,replay_mismatch:false,requester_owner_id:OWNER}).ready,false);
});

test('golden package reads the same when files are bytes and each stage can be evaluated alone',()=>{
  const subject=golden();
  const bytes={...subject,files:Object.fromEntries(Object.entries(subject.files).map(([path,content])=>[path,Buffer.from(content,'utf8')]))};
  assert.equal(ALL(bytes).pass,true);
  for(const run of [B0,C1,C2,C3,C4])assert.equal(run(subject).pass,true,run.name);
  assert.equal(evaluateQualification(subject,ALL(subject).gates).pass,true);
});

/* ---- 11.1 item 2: one negation per check ---- */

test('B0: one negation per check gives exactly the expected code',()=>{
  const cases=[
    ['foreign run',subject=>{subject.owner_id='owner-b';},['NOT_FOUND']],
    ['absent run',subject=>{subject.run=null;},['NOT_FOUND']],
    ['run not completed',subject=>{subject.run.status='RUNNING';},['STATUS_NOT_COMPLETED']],
    ['no result',subject=>{subject.run.result=null;},['NO_RESULT','OWNER_RECOMMENDATION_NOT_READY']],
    ['report does not match checkpoints',subject=>{subject.run.integrity.report_matches_checkpoints=false;},['INTEGRITY_CHECK_FAILED']],
    ['contract hash not verified',subject=>{subject.run.integrity.contract_hash_verified=false;},['INTEGRITY_CHECK_FAILED']],
    ['integrity unknown',subject=>{subject.run.integrity=null;},['INTEGRITY_CHECK_FAILED']],
    ['NO_VALID_CANDIDATE status',subject=>{subject.run.status='NO_VALID_CANDIDATE';},['BI_RUN_NOT_QUALIFIABLE']],
    ['completion reason',subject=>{subject.run.result.completion_reason='CANDIDATE_FAILED_CHECKS';},['BI_RUN_NOT_QUALIFIABLE','OWNER_RECOMMENDATION_NOT_READY']],
    ['no selected candidate',subject=>{subject.run.result.selected=null;},['NO_SCREENED_CANDIDATE']],
    ['train sample below the rule',subject=>{subject.run.result.selected.result.train.closed_trades=4;},['NO_SCREENED_CANDIDATE']],
    ['validation sample below the rule',subject=>{subject.run.result.selected.result.validation.closed_trades=4;},['NO_SCREENED_CANDIDATE']],
    ['sensitivity drop too large',subject=>{subject.run.result.selected.sensitivity[0].result.validation.net_return_percent='0.5';},['SENSITIVITY_FAILED']],
    ['sensitivity sample too small',subject=>{subject.run.result.selected.sensitivity[1].result.validation.closed_trades=4;},['SENSITIVITY_FAILED']],
    ['sensitivity absent',subject=>{delete subject.run.result.selected.sensitivity;},['SENSITIVITY_FAILED']],
    ['stored sensitivity reason',subject=>{subject.run.result.selected.screen_reasons=['SENSITIVITY_FAILED'];},['SENSITIVITY_FAILED']],
    ['cost stress negative',subject=>{subject.run.result.selected.cost_stress.validation.net_return_percent='-0.1';},['COST_STRESS_FAILED']],
    ['cost stress absent',subject=>{subject.run.result.selected.cost_stress=null;},['COST_STRESS_FAILED']],
    ['both robustness checks',subject=>{subject.run.result.selected.cost_stress=null;delete subject.run.result.selected.sensitivity;},['SENSITIVITY_FAILED','COST_STRESS_FAILED']],
    ['holdout not evaluated',subject=>{subject.run.result.holdout_evaluated=false;},['HOLDOUT_NOT_EVALUATED']],
    ['holdout metrics absent',subject=>{delete subject.run.result.selected.test;},['HOLDOUT_NOT_EVALUATED']],
    ['too few holdout trades',subject=>{subject.run.result.selected.test.closed_trades=4;},['INSUFFICIENT_TEST_TRADES']],
    ['negative holdout return',subject=>{subject.run.result.selected.test.net_return_percent='-0.7';},['NEGATIVE_HOLDOUT_RETURN']],
    ['holdout drawdown above the rule',subject=>{subject.run.result.selected.test.max_drawdown_percent='20.5';},['TEST_DRAWDOWN_EXCEEDED']],
    ['stored holdout reason',subject=>{subject.run.result.selected.screen_reasons=['NEGATIVE_HOLDOUT_RETURN'];},['NEGATIVE_HOLDOUT_RETURN']],
    ['holdout lookup not made',subject=>{subject.holdout=null;},['HOLDOUT_INDEPENDENCE_NOT_CHECKED','BI_EXPOSURE_REGISTER_UNAVAILABLE']],
    ['boundary state unknown',subject=>{subject.holdout.registered_boundary=null;},['HOLDOUT_INDEPENDENCE_NOT_CHECKED']],
    ['searched windows unknown',subject=>{delete subject.holdout.earlier_searched;},['HOLDOUT_INDEPENDENCE_NOT_CHECKED']],
    ['earlier holdout reused',subject=>{subject.holdout.earlier_holdouts.push({start_time:subject.own_holdout.start_time-10*MINUTE,end_time:subject.own_holdout.start_time+MINUTE});},['HOLDOUT_WINDOW_REUSED']],
    ['earlier searched window overlaps',subject=>{subject.holdout.earlier_searched.push({start_time:subject.own_holdout.end_time,end_time:subject.own_holdout.end_time+MINUTE});},['BI_HOLDOUT_OVERLAPS_SEARCHED_DATA']],
    ['holdout before the registered boundary',subject=>{subject.holdout.registered_boundary={exists:true,start_time:subject.own_holdout.start_time+MINUTE};},['BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY']],
    ['search record incomplete',subject=>{delete subject.run.result.seed;},['BI_SEARCH_RECORD_MISSING']],
    ['dimension coverage below 100',subject=>{subject.run.result.dimension_coverage_percent=66;},['BI_DIMENSION_COVERAGE']],
    ['dropped dimension',subject=>{subject.run.result.covered_dimensions=2;},['BI_DIMENSION_COVERAGE']],
    ['capability blocker',subject=>{subject.run.contract.acceptance_blockers.push(...CAPABILITY_BLOCKERS);},['BI_CAPABILITY_BLOCKER_PRESENT']],
    ['unknown blocker name',subject=>{subject.run.contract.acceptance_blockers.push('NEW_UNKNOWN_BLOCKER');},['BI_CAPABILITY_BLOCKER_PRESENT']],
    ['blockers unknown',subject=>{subject.run.contract.acceptance_blockers=null;},['BLOCKERS_UNKNOWN']],
    ['claimed mode differs from the frozen membership',subject=>{subject.binding.mode='MULTI_PINE';},['BI_BINDING_MISMATCH']],
    ['claimed ONE_PINE on a two-member run',subject=>{subject.run.contract.snapshot.membership.push({...SECOND});},['BI_MULTI_PINE_INTERNAL_ONLY','BI_BINDING_MISMATCH']],
    ['register entry of the same owner and market overlaps the holdout',subject=>{subject.holdout.exposure_register.push({owner_id:OWNER,market:{...MARKET_OBJECT},source_hash:hex('s'),
      window:{...subject.own_holdout},comparison_id:'cmp-1',at_utc:'2026-10-19T11:00:00Z'});},['BI_HOLDOUT_EXPOSED_BY_SELECTION']],
    ['exposure register absent',subject=>{delete subject.holdout.exposure_register;},['BI_EXPOSURE_REGISTER_UNAVAILABLE']],
    ['run creation time absent',subject=>{delete subject.run.created_at_utc;},['BI_EXPOSURE_REGISTER_UNAVAILABLE']],
    ['binding boundary ref without a registered ref',subject=>{subject.binding.holdout_boundary_ref={boundary_id:'b-1'};},['BI_BINDING_MISMATCH']],
    ['rules absent from the contract',subject=>{delete subject.run.contract.rules;},['BI_BINDING_INCOMPLETE']],
    ['legacy contract version',subject=>{subject.run.contract.version='ql3a-research-job-v2';},['OWNER_RECOMMENDATION_NOT_READY']],
    ['non-fixture package while no episode gate exists',subject=>{subject.binding.fixture=false;},['BI_EPISODE_GATE_UNAVAILABLE']]];
  for(const [label,change,codes] of cases){
    const subject=golden();
    change(subject);
    const result=B0(subject);
    expectCodes(result,codes,label);
    assert.equal(result.pass,false,label);assert.equal(result.state,'FAIL',label);
  }
  for(const field of BINDING_FIELDS){
    const subject=golden();
    delete subject.binding[field];
    expectCodes(B0(subject),field==='fixture'?['BI_BINDING_INCOMPLETE','BI_EPISODE_GATE_UNAVAILABLE']:['BI_BINDING_INCOMPLETE'],'binding field '+field);
  }
  const optional=golden();
  assert.equal(B0(optional).pass,true,'holdout_boundary_ref is optional: both absent is allowed');
  optional.binding.holdout_boundary_ref='x';
  expectCodes(B0(optional),['BI_BINDING_INCOMPLETE','BI_BINDING_MISMATCH'],'a present boundary reference must be an object');
  // R8: the packaged holdout_boundary_ref must equal the registered boundary ref.
  const REF={boundary_id:'boundary-1',sha256:hex('boundary')};
  const registered=(ref,binding)=>golden({subject:s=>{s.holdout.registered_boundary={exists:true,start_time:s.own_holdout.start_time-MINUTE,...(ref?{ref}:{})};},
    binding:b=>{if(binding)b.holdout_boundary_ref=binding;}});
  assert.equal(B0(registered(REF,{...REF})).pass,true,'equal refs pass');
  assert.equal(B0(registered(null,null)).pass,true,'a registered boundary without a ref and no packaged ref: both absent');
  expectCodes(B0(registered(REF,{...REF,sha256:hex('other')})),['BI_BINDING_MISMATCH'],'a different ref');
  expectCodes(B0(registered(REF,null)),['BI_BINDING_MISMATCH'],'registered boundary but no packaged ref');
  expectCodes(B0(registered(null,REF)),['BI_BINDING_MISMATCH'],'packaged ref but no registered ref');
  const noBoundary=golden({binding:b=>{b.holdout_boundary_ref=REF;}});
  expectCodes(B0(noBoundary),['BI_BINDING_MISMATCH'],'packaged ref while no boundary is registered');
  const unknownBoundary=golden({subject:s=>{s.holdout.registered_boundary=null;},binding:b=>{b.holdout_boundary_ref=REF;}});
  expectCodes(B0(unknownBoundary),['HOLDOUT_INDEPENDENCE_NOT_CHECKED'],'an unknown boundary is reported once, as not checked');
  const internal=internalGolden();
  assert.equal(B0(internal).pass,true,'multi-Pine is allowed on the internal path');
  const ok=golden({result:r=>{r.selected.test.max_drawdown_percent='20';}});
  assert.equal(B0(ok).pass,true,'a drawdown equal to the rule limit passes');
});

test('B0: a request is judged only by the run, never leaks a foreign run, and reports independent checks together',()=>{
  const foreign=golden();
  foreign.owner_id='owner-b';
  expectCodes(B0(foreign),['NOT_FOUND']);
  // The attempt-time evaluation refuses a foreign or absent run without any gate, status or transition and leaks nothing.
  for(const subject of [foreign,golden({subject:s=>{s.run=null;}}),golden({subject:s=>{delete s.owner_id;}})]){
    const result=ALL(subject);
    assert.equal(result.refused,'NOT_FOUND');assert.equal(result.pass,false);
    assert.deepEqual([...result.gates],[]);assert.deepEqual(codesOf(result),[]);
    assert.equal(result.status,null);assert.equal(result.next,null);assert.equal(result.record,null);assert.equal(result.ready,false);
  }
  const many=golden();
  many.run.result.holdout_evaluated=false;
  many.run.contract.acceptance_blockers.push(...CAPABILITY_BLOCKERS);
  delete many.binding.exit_version;
  expectCodes(B0(many),['HOLDOUT_NOT_EVALUATED','BI_CAPABILITY_BLOCKER_PRESENT','BI_BINDING_INCOMPLETE'],'independent checks of one gate still report');
});

test('C1: one negation per check gives exactly the expected code',()=>{
  const missing=PACKAGE_FILES.map(path=>[`file ${path} missing`,subject=>{delete subject.files[path];},['BI_ARTIFACT_MISSING']]);
  const cases=[
    ...missing,
    ['files not an object',subject=>{subject.files=null;},['BI_ARTIFACT_MISSING']],
    ['unlisted file',subject=>{subject.files['notes.txt']='hello';},['BI_ARTIFACT_UNEXPECTED']],
    ['unreadable JSON file',subject=>{subject.files['inputs.json']='{not json';},['BI_ARTIFACT_MISSING','BI_CHECKSUM_MISMATCH']],
    ['manifest is not JSON',subject=>{subject.files[MANIFEST_PATH]='{not json';},['BI_MANIFEST_SCHEMA_INVALID']],
    ['manifest schema version',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.schema_version='best-inputs-manifest-v0';});},['BI_MANIFEST_SCHEMA_INVALID']],
    ['manifest extra section',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.extra=true;});},['BI_MANIFEST_SCHEMA_INVALID']],
    ['manifest limitations code',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.limitations.codes=['not a code'];});},['BI_MANIFEST_SCHEMA_INVALID']],
    ['manifest fixture not boolean',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.fixture='yes';});},['BI_MANIFEST_SCHEMA_INVALID']],
    ['one changed byte in a listed file',subject=>{subject.files['setup-guide.md']=subject.files['setup-guide.md'].replace('package.','package?');},['BI_CHECKSUM_MISMATCH']],
    ['wrong package hash',subject=>{subject.package_hash=hex('other');},['BI_CHECKSUM_MISMATCH']],
    ['package hash absent',subject=>{delete subject.package_hash;},['BI_CHECKSUM_MISMATCH']],
    ['wrong binding hash',subject=>{subject.binding_hash=hex('other');},['BI_CHECKSUM_MISMATCH']],
    ['stored binding differs from the packaged binding',subject=>{subject.binding={...subject.binding,created_at:'2026-10-19T12:00:01Z'};},['BI_CHECKSUM_MISMATCH']]];
  for(const [label,change,codes] of cases){
    const subject=golden();
    change(subject);
    expectCodes(C1(subject),codes,label);
  }
  const base=golden();
  expectCodes(C1(repack(base,{'inputs.json':'{not json'})),['BI_ARTIFACT_MISSING'],'an unreadable JSON file with consistent checksums');
  assert.equal(C1(repack(base,{'setup-guide.md':'Changed guide text.\n'})).pass,true,'a re-packed change keeps the checksums consistent');
  const listed=golden({manifest:m=>{m.files.push({path:'extra.bin',sha256:hex('x'),bytes:1});}});
  expectCodes(C1(listed),['BI_CHECKSUM_MISMATCH'],'manifest lists a file that is not in the set');
  const dropped=golden({manifest:m=>{m.files.pop();}});
  expectCodes(C1(dropped),['BI_CHECKSUM_MISMATCH'],'manifest omits a file');
  const wrongBytes=golden({manifest:m=>{m.files[0].bytes+=1;}});
  expectCodes(C1(wrongBytes),['BI_CHECKSUM_MISMATCH'],'byte count differs');
  const duplicate=golden({manifest:m=>{m.files.push({...m.files[0]});}});
  expectCodes(C1(duplicate),['BI_CHECKSUM_MISMATCH'],'duplicate manifest entry');
  const twoErrors=golden();
  delete twoErrors.files['quant-data/equity.csv'];
  twoErrors.files['notes.txt']='x';
  expectCodes(C1(twoErrors),['BI_ARTIFACT_MISSING','BI_ARTIFACT_UNEXPECTED'],'independent checks still report');
  assert.equal(C1(base).pass,true);
});

test('C1: content, number format, metric, alert source, indicator and market checks',()=>{
  const withGuide=text=>golden({files:files=>{files['setup-guide.md']=text;}});
  expectCodes(C1(withGuide('Send alerts to https://hooks.example.com/webhook/9f8e7d6c5b4a39281716a5b4c3d2e1f0 now.')),['BI_SECRET_DETECTED']);
  expectCodes(C1(withGuide('Install from C:\\Users\\me\\bot\\config.json please.')),['BI_MACHINE_PATH_DETECTED']);
  expectCodes(C1(withGuide('Both https://x.example.com/alerts?token=abcdef123456 and /home/example/app/.env appear.')),['BI_SECRET_DETECTED','BI_MACHINE_PATH_DETECTED']);
  const bytes=golden({files:files=>{files['quant-data/trades.csv']=Buffer.from('a,b\n-----BEGIN PRIVATE KEY-----\n','utf8');}});
  expectCodes(C1(bytes),['BI_SECRET_DETECTED'],'a secret in a byte file');
  const unlisted=golden();
  unlisted.files['notes.txt']='api_key = "AKIAABCDEFGHIJKLMNOP"';
  expectCodes(C1(unlisted),['BI_ARTIFACT_UNEXPECTED','BI_SECRET_DETECTED'],'an unlisted file is scanned too');
  const metricsAs=change=>golden({files:files=>editJson(files,'quant-data/metrics.json',change)});
  expectCodes(C1(metricsAs(m=>{m.test.net_return_percent=1.9;})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(metricsAs(m=>{m.train.gross_profit='1e3';})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(metricsAs(m=>{m.train.closed_trades='9';})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(metricsAs(m=>{m.validation.win_rate=62.5;})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(golden({manifest:m=>{m.identity.created_at='2026-10-19 12:00:00';}})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(golden({manifest:m=>{m.identity.created_at='2026-10-19T12:00:00+07:00';}})),['BI_NUMERIC_FORMAT_INVALID'],'timestamps are UTC');
  expectCodes(C1(golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs[0].after=30;})})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(golden({files:files=>editJson(files,'inputs.json',i=>{delete i.bridge.rr.unit;})})),['BI_NUMERIC_FORMAT_INVALID']);
  expectCodes(C1(golden({files:files=>editJson(files,'indicator.json',i=>{i.alert_source='native';})})),['BI_ALERT_SOURCE_INVALID']);
  expectCodes(C1(golden({binding:b=>{b.alert_source='native';}})),['BI_ALERT_SOURCE_INVALID']);
  const pine=source=>golden({files:files=>{files['indicator.pine']=source;}});
  expectCodes(C1(pine(SOURCE.replace('indicator("Golden fixture indicator", overlay=true)','strategy("Golden fixture", overlay=true)'))),['INDICATOR_REQUIRED']);
  expectCodes(C1(pine(SOURCE+'indicator("second")\n')),['INDICATOR_REQUIRED']);
  expectCodes(C1(pine(SOURCE+'strategy.entry("x", strategy.long)\n')),['INDICATOR_REQUIRED']);
  expectCodes(C1(pine('plot(close)\n')),['INDICATOR_REQUIRED']);
  assert.equal(C1(pine(SOURCE+'// strategy("only a comment")\nlabel = "indicator(" \n')).pass,true,'comments and strings are not code');
  expectCodes(C1(golden({files:files=>editJson(files,'indicator.json',i=>{i.symbol='BINANCE:ETHUSDT';})})),['BI_MARKET_SCOPE_INVALID']);
  expectCodes(C1(golden({files:files=>editJson(files,'indicator.json',i=>{i.timeframe='5';})})),['BI_MARKET_SCOPE_INVALID']);
  expectCodes(C1(golden({binding:b=>{b.market={...b.market,timeframe:'5'};}})),['BI_MARKET_SCOPE_INVALID']);
  expectCodes(C1(golden({binding:b=>{b.market={...b.market,broker:'binance-us'};}})),['BI_MARKET_SCOPE_INVALID']);
});

test('C2: one negation per check gives exactly the expected code',()=>{
  const cases=[
    ['no compile record',subject=>{subject.compile=null;},['BI_COMPILE_EVIDENCE_MISSING']],
    ['record of another export',subject=>{subject.compile.export_id='other-export';},['BI_COMPILE_EVIDENCE_MISSING']],
    ['record without operator role',subject=>{delete subject.compile.operator_role;},['BI_COMPILE_EVIDENCE_MISSING']],
    ['record without method',subject=>{subject.compile.method='';},['BI_COMPILE_EVIDENCE_MISSING']],
    ['record time not UTC',subject=>{subject.compile.compiled_at_utc='2026-10-19 11:00';},['BI_COMPILE_EVIDENCE_MISSING']],
    ['record for another indicator',subject=>{subject.compile.indicator_sha256=hex('other-indicator');},['BI_COMPILE_SOURCE_MISMATCH']],
    ['compile error',subject=>{subject.compile.errors=['line 3: undeclared identifier'];},['BI_COMPILE_ERRORS']],
    ['unresolved reference',subject=>{subject.compile.unresolved_references=1;},['BI_COMPILE_ERRORS']],
    ['identifier collision',subject=>{subject.compile.collisions=1;},['BI_COMPILE_ERRORS']],
    ['duplicate binding',subject=>{subject.compile.duplicate_bindings=1;},['BI_COMPILE_ERRORS']],
    ['slot mapped to another variable',subject=>{subject.compile.mapping_check[0].pine_variable='emaSlowInput';},['BI_SLOT_BINDING_MISMATCH']],
    ['slot mapping absent',subject=>{subject.compile.mapping_check=[];},['BI_SLOT_BINDING_MISMATCH']],
    ['extra mapping',subject=>{subject.compile.mapping_check.push({slot:4,pine_variable:'atrLenInput'});},['BI_SLOT_BINDING_MISMATCH']],
    ['warning without disposition',subject=>{delete subject.compile.warnings[0].disposition;},['BI_COMPILE_WARNINGS_UNREVIEWED']],
    ['warning without reviewer',subject=>{subject.compile.warnings.push({text:'new',disposition:'ACCEPTED_BENIGN'});},['BI_COMPILE_WARNINGS_UNREVIEWED']],
    ['registered source hash',subject=>{subject.run.contract.source_hash=hex('other-source');},['BI_SOURCE_HASH_MISMATCH']],
    ['registered source text',subject=>{subject.run.contract.source=subject.run.contract.source+'\n// edited';},['BI_SOURCE_HASH_MISMATCH','BI_SOURCE_LOGIC_CHANGED']],
    ['packaged source hash',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.binding.source_hash=hex('other-source');});},['BI_SOURCE_HASH_MISMATCH']],
    ['native alert isolation absent',subject=>{subject.native_alert_isolation=null;},['BI_NATIVE_ALERT_ISOLATION_UNPROVEN']],
    ['native route still enabled',subject=>{subject.native_alert_isolation.routes_disabled=false;},['BI_NATIVE_ALERT_ISOLATION_UNPROVEN']],
    ['unrelated payload',subject=>{subject.native_alert_isolation.unrelated_payloads=1;},['BI_NATIVE_ALERT_ISOLATION_UNPROVEN']],
    ['native payload',subject=>{subject.native_alert_isolation.native_payloads=2;},['BI_NATIVE_ALERT_ISOLATION_UNPROVEN']]];
  for(const [label,change,codes] of cases){
    const subject=golden();
    change(subject);
    expectCodes(C2(subject),codes,label);
  }
  const both=golden();
  both.compile=null;both.native_alert_isolation=null;
  const result=C2(both);
  expectCodes(result,['BI_COMPILE_EVIDENCE_MISSING','BI_NATIVE_ALERT_ISOLATION_UNPROVEN'],'independent checks still report');
  assert.equal(isHardFailure(result),false,'missing evidence is retryable, not a hard failure');
});

test('C2 logic diff: one byte changed outside the approved defaults gives BI_SOURCE_LOGIC_CHANGED',()=>{
  const indicator=(golden().files)['indicator.pine'];
  const changed=golden({files:files=>{files['indicator.pine']=files['indicator.pine'].replace('close, 100)','close, 101)');}});
  assert.equal(changed.files['indicator.pine'].length,indicator.length,'one byte differs');
  expectCodes(C2(changed),['BI_SOURCE_LOGIC_CHANGED']);
  const first=golden({files:files=>{files['indicator.pine']=files['indicator.pine'].replace('//@version=6','//@version=5');}});
  expectCodes(C2(first),['BI_SOURCE_LOGIC_CHANGED']);
  const outside=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits[0].start=0;i.edits[0].end=2;i.edits[0].before='//';})});
  expectCodes(C2(outside),['BI_SOURCE_LOGIC_CHANGED'],'an edit outside the span of the selected input');
  const wrongValue=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits[0].after='40';})});
  expectCodes(C2(wrongValue),['BI_SOURCE_LOGIC_CHANGED'],'edit value differs from inputs.json');
  const noEdit=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits=[];})});
  expectCodes(C2(noEdit),['BI_SOURCE_LOGIC_CHANGED'],'a changed default needs a disclosed edit');
  const wrongBefore=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits[0].before='60';})});
  expectCodes(C2(wrongBefore),['BI_SOURCE_LOGIC_CHANGED']);
  const unknownInput=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits[0].input_id='input_77';})});
  expectCodes(C2(unknownInput),['BI_SOURCE_LOGIC_CHANGED']);
  const nonNumeric=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits[0].after='close';})});
  expectCodes(C2(nonNumeric),['BI_SOURCE_LOGIC_CHANGED']);
  const twice=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits.push({...i.edits[0]});})});
  expectCodes(C2(twice),['BI_SOURCE_LOGIC_CHANGED'],'two edits for one input');
  const missingFile=golden({files:files=>{delete files['indicator.json'];}});
  expectCodes(C2(missingFile),['BI_SOURCE_LOGIC_CHANGED'],'edits unreadable');
  assert.equal(C2(golden()).pass,true,'the disclosed default edit and the appended block are allowed');
});

test('C3: one negation per check gives exactly the expected code',()=>{
  const cases=[
    ['no run',subject=>{subject.run=null;},['BI_PROVENANCE_UNRESOLVED']],
    ['contract hash does not resolve',subject=>{subject.run.contract_hash=hex('other');},['BI_PROVENANCE_UNRESOLVED']],
    ['no packaged binding',subject=>{delete subject.files[MANIFEST_PATH];},['BI_PROVENANCE_UNRESOLVED']],
    ['inputs slot value differs from the candidate',subject=>{editJson(subject.files,'inputs.json',i=>{i.source_inputs[0].after='40';});},['BI_INPUTS_MISMATCH']],
    ['inputs Bridge value differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.bridge.rr.after='1.25';});},['BI_INPUTS_MISMATCH']],
    ['inputs before value differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.source_inputs[0].before='40';});},['BI_INPUTS_MISMATCH']],
    ['inputs run differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.run_id='other-run';});},['BI_INPUTS_MISMATCH']],
    ['inputs source differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.source_hash=hex('x');});},['BI_INPUTS_MISMATCH']],
    ['inputs effective-input hash differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.effective_input_hash=hex('x');});},['BI_INPUTS_MISMATCH']],
    ['inputs slot absent',subject=>{editJson(subject.files,'inputs.json',i=>{i.source_inputs=[];});},['BI_INPUTS_MISMATCH']],
    ['inputs slot input differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.source_inputs[0].input_id='input_4';});},['BI_INPUTS_MISMATCH']],
    ['inputs domain differs',subject=>{editJson(subject.files,'inputs.json',i=>{i.source_inputs[0].domain.max='60';});},['BI_INPUTS_MISMATCH']],
    ['inputs not an object',subject=>{subject.files['inputs.json']='[]';},['BI_INPUTS_MISMATCH']],
    ['fixed input changed',subject=>{editJson(subject.files,'inputs.json',i=>{i.fixed_inputs[0].value=false;});},['BI_FIXED_INPUT_CHANGED']],
    ['fixed input removed',subject=>{editJson(subject.files,'inputs.json',i=>{i.fixed_inputs.pop();});},['BI_FIXED_INPUT_CHANGED']],
    ['policy snapshot differs',subject=>{editJson(subject.files,'risk-profile.json',p=>{p.policy.max_daily_loss_percent='4';});},['BI_POLICY_SNAPSHOT_MISMATCH']],
    ['policy hash differs',subject=>{editJson(subject.files,'risk-profile.json',p=>{p.policy_hash=hex('other-policy');});},['BI_POLICY_SNAPSHOT_MISMATCH']],
    ['limit weaker than the hard limit',subject=>{editJson(subject.files,'risk-profile.json',p=>{p.limits.max_daily_loss_percent='7';});},['BI_RISK_RELAXATION']],
    ['limit absent from the profile',subject=>{editJson(subject.files,'risk-profile.json',p=>{p.limits={};});},['BI_RISK_RELAXATION']],
    ['hard limits unknown',subject=>{subject.hard_limits=null;},['BI_RISK_RELAXATION']],
    ['hard limits empty',subject=>{subject.hard_limits={};},['BI_RISK_RELAXATION']],
    ['metrics differ',subject=>{editJson(subject.files,'quant-data/metrics.json',m=>{m.validation.net_return_percent='9.9';});},['BI_RESULT_MISMATCH']],
    ['metrics partition absent',subject=>{editJson(subject.files,'quant-data/metrics.json',m=>{delete m.train;});},['BI_RESULT_MISMATCH']],
    ['candidate step differs',subject=>{editJson(subject.files,'quant-data/validation.json',v=>{v.candidate.parameters.rr=2;});},['BI_RESULT_MISMATCH']],
    ['sensitivity step differs',subject=>{editJson(subject.files,'quant-data/validation.json',v=>{v.sensitivity.pop();});},['BI_RESULT_MISMATCH']],
    ['cost stress step differs',subject=>{editJson(subject.files,'quant-data/validation.json',v=>{v.cost_stress.validation.net_return_percent='9.9';});},['BI_RESULT_MISMATCH']],
    ['holdout step differs',subject=>{editJson(subject.files,'quant-data/validation.json',v=>{v.holdout.test.net_return_percent='9.9';});},['HOLDOUT_MISMATCH']],
    ['holdout step absent',subject=>{editJson(subject.files,'quant-data/validation.json',v=>{delete v.holdout;});},['HOLDOUT_MISMATCH']],
    ['dataset unreadable',subject=>{subject.dataset.readable=false;},['BI_DATASET_UNAVAILABLE']],
    ['dataset state unknown',subject=>{subject.dataset=null;},['BI_DATASET_UNAVAILABLE']],
    ['dataset bytes differ',subject=>{subject.dataset.digest=hex('other-dataset');},['BI_DATASET_HASH_MISMATCH']],
    ['packaged engine evidence differs',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.evidence.engine_hash=hex('other-engine');});},['BI_ENGINE_HASH_MISMATCH']],
    ['binding engine differs',subject=>{editJson(subject.files,MANIFEST_PATH,m=>{m.binding.engine_hash=hex('other-engine');});},['BI_ENGINE_HASH_MISMATCH']],
    ['deployment exit version differs',subject=>{subject.deployment.exit_version='bridge-exit-v1';},['BI_EXIT_VERSION_UNSUPPORTED']],
    ['deployment unknown',subject=>{subject.deployment=null;},['BI_EXIT_VERSION_UNSUPPORTED']],
    ['fixture request without the label',subject=>{subject.fixture_request=true;editJson(subject.files,MANIFEST_PATH,m=>{m.fixture=false;});},['BI_FIXTURE_LABEL_MISSING']]];
  for(const [label,change,codes] of cases){
    const subject=golden();
    change(subject);
    expectCodes(C3(subject),codes,label);
  }
  const altered={owner_id:'owner-b',bot_id:'bot-b',run_id:'run-b',contract_hash:hex('x1'),submission_hash:hex('x2'),deployment_id:'deploy-b',pine_import_id:'import-b',
    source_version:9,source_hash:hex('x3'),baseline_snapshot_hash:hex('x4'),input_lock_hash:hex('x5'),slot_bindings:[],bridge_domains:{atr_multiplier:[1],rr:[1]},
    effective_input_hash:hex('x6'),policy_version:'policy-v9',policy_hash:hex('x7'),capital:{equity:'1',cash:'1'},ledger_initialization:'another ledger',
    model:{version:'paper-close-v1',price_tick:0.5},dataset_ref:{sha256:hex('x8')},split:{warmup:1,train_end:2,validation_end:3,test_end:4},
    rules:{...RULES,minimum_closed_trades_test:9},acceptance_blockers:[],market:{broker:'binance-global',symbol:'ETHUSDT',timeframe:'1'},mode:'MULTI_PINE',pine_count:2,
    membership:[{pine_import_id:'import-9',source_version:1,source_hash:hex('x9')}]};
  for(const [field,value] of Object.entries(altered)){
    const subject=golden({binding:b=>{b[field]=value;}});
    expectCodes(C3(subject),['BI_BINDING_MISMATCH'],'binding field '+field);
  }
  assert.equal(Object.keys(altered).length,27,'every run-derived binding field is compared');
  expectCodes(C3(golden({contract:c=>{c.model.version='paper-close-cost-v2';}})),['BI_COST_MODEL_UNSUPPORTED'],'cost model V2 is refused until its parity passes');
  expectCodes(C3(golden({binding:b=>{b.cost_model_version='paper-close-cost-v2';}})),['BI_BINDING_MISMATCH','BI_COST_MODEL_UNSUPPORTED']);
  expectCodes(C3(golden({binding:b=>{b.exit_version='bridge-exit-v9';},subject:s=>{s.deployment.exit_version='bridge-exit-v9';}})),['BI_EXIT_VERSION_UNSUPPORTED'],'an unsupported version is refused even when it matches the deployment');
  // S10 and U3: only bridge-exit-v2 has a Bridge template, so C2 fails a package with another named version (non-retryable) and never reports a logic change or a PASS for it.
  assert.deepEqual([...SUPPORTED_EXIT_VERSIONS],['bridge-exit-v2']);
  const legacy=golden({binding:b=>{b.exit_version='bridge-exit-v1';},subject:s=>{s.deployment.exit_version='bridge-exit-v1';}});
  expectCodes(C3(legacy),['BI_EXIT_VERSION_UNSUPPORTED'],'a bridge-exit-v1 package is refused');
  expectCodes(C2(legacy),['BI_EXIT_VERSION_UNSUPPORTED'],'C2 never passes a version without a template, and never reports BI_SOURCE_LOGIC_CHANGED for it');
  assert.equal(isRetryable('BI_EXIT_VERSION_UNSUPPORTED'),false);
  for(const name of ['constructor','__proto__','bridge-exit-v9']){
    const odd=golden({binding:b=>{b.exit_version=name;},subject:s=>{s.deployment.exit_version=name;}});
    expectCodes(C2(odd),['BI_EXIT_VERSION_UNSUPPORTED'],'C2 fails the name '+name);
    assert.ok(!ALL(odd).codes.includes('BI_SOURCE_LOGIC_CHANGED'),name);
    assert.equal(ALL(odd).status,STATUS.EXPORT_REFUSED,name);
  }
  const legacyAll=ALL(legacy);
  assert.deepEqual(legacyAll.gates.map(gate=>[gate.gate,gate.state]),[['C1','PASS'],['C2','FAIL'],['C3','NOT_REACHED'],['C4','NOT_REACHED'],['Q','NOT_REACHED']]);
  assert.deepEqual(codesOf(legacyAll),['BI_EXIT_VERSION_UNSUPPORTED']);
  assert.ok(!legacyAll.codes.includes('BI_SOURCE_LOGIC_CHANGED'));
  assert.equal(legacyAll.status,STATUS.EXPORT_REFUSED,'a non-retryable refusal');
  const legacyEdited=golden({binding:b=>{b.exit_version='bridge-exit-v1';},subject:s=>{s.deployment.exit_version='bridge-exit-v1';},files:files=>{files['indicator.pine']=files['indicator.pine'].replace('close, 100)','close, 101)');}});
  expectCodes(C3(legacyEdited),['BI_EXIT_VERSION_UNSUPPORTED']);
  assert.ok(!ALL(legacyEdited).codes.includes('BI_SOURCE_LOGIC_CHANGED'),'the refusal code wins before the byte compare');
  expectCodes(C3(golden({binding:b=>{b.fixture=false;},manifest:m=>{m.fixture=false;}})),['BI_FIXTURE_LABEL_MISSING'],'engineering scope implies fixture true');
  expectCodes(C3(golden({manifest:m=>{m.fixture=false;}})),['BI_FIXTURE_LABEL_MISSING'],'manifest and binding labels must agree');
});

test('C3 slots: nine source slots, duplicate slots, nonnumeric, NaN and infinity (11.1 item 9)',()=>{
  const slot=index=>({slot:index,input_id:'input_'+index,pine_variable:'v'+index,kind:'int',unit:'bars',before:'1',after:'1',domain:{min:'1',max:'2',step:'1'}});
  const nine=golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs=[i.source_inputs[0],...Array.from({length:8},(_,index)=>slot(index+4))];})});
  expectCodes(C3(nine),['BI_SLOT_LIMIT'],'nine source slots');
  const duplicateSlot=golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs.push({...i.source_inputs[0],input_id:'input_5',pine_variable:'other'});})});
  expectCodes(C3(duplicateSlot),['BI_SLOT_LIMIT'],'duplicate slot number');
  const duplicateVariable=golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs.push({...i.source_inputs[0],slot:5,input_id:'input_5'});})});
  expectCodes(C3(duplicateVariable),['BI_SLOT_LIMIT'],'duplicate variable');
  const duplicateInput=golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs.push({...i.source_inputs[0],slot:5,pine_variable:'other'});})});
  expectCodes(C3(duplicateInput),['BI_SLOT_LIMIT'],'duplicate input id');
  const extraBridge=golden({files:files=>editJson(files,'inputs.json',i=>{i.bridge.stop={...i.bridge.rr};})});
  expectCodes(C3(extraBridge),['BI_SLOT_LIMIT'],'exactly two Bridge slots');
  const oneBridge=golden({files:files=>editJson(files,'inputs.json',i=>{delete i.bridge.rr;})});
  expectCodes(C3(oneBridge),['BI_SLOT_LIMIT']);
  const eight=golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs=[i.source_inputs[0],...Array.from({length:7},(_,index)=>slot(index+4))];})});
  assert.ok(!C3(eight).codes.includes('BI_SLOT_LIMIT'),'eight slots are within the limit');
  for(const value of ['abc','NaN','Infinity','-Infinity','','1e3',' 30','30.5','35','0x1e','31','10']){
    const subject=golden({files:files=>editJson(files,'inputs.json',i=>{i.source_inputs[0].after=value;})});
    expectCodes(C3(subject),['BI_INPUTS_MISMATCH','BI_INPUT_OUT_OF_DOMAIN'],'value '+JSON.stringify(value)+' is out of domain and not the candidate value');
  }
  for(const value of ['NaN','Infinity','abc']){
    const bridge=golden({files:files=>editJson(files,'inputs.json',i=>{i.bridge.atr_multiplier.after=value;})});
    expectCodes(C3(bridge),['BI_INPUTS_MISMATCH','BI_INPUT_OUT_OF_DOMAIN'],'Bridge value '+value);
  }
  const offGrid=golden({result:r=>{r.selected.parameters.emaFastInput=35;}});
  expectCodes(C3(offGrid),['BI_INPUT_OUT_OF_DOMAIN'],'a candidate value off the searched grid');
  const offBridge=golden({result:r=>{r.selected.parameters.rr=1.1;}});
  expectCodes(C3(offBridge),['BI_INPUT_OUT_OF_DOMAIN'],'a Bridge value off the searched grid');
  const nonNumeric=golden({contract:c=>{c.input_lock.selection.bindings[0].type='bool';}});
  expectCodes(C3(nonNumeric),['BI_INPUTS_MISMATCH','BI_INPUT_OUT_OF_DOMAIN'],'a nonnumeric slot type');
  const fractionalInt=golden({result:r=>{r.selected.parameters.emaFastInput=30.5;},contract:c=>{c.input_lock.domains.emaFastInput=[30,30.5,40];}});
  expectCodes(C3(fractionalInt),['BI_INPUTS_MISMATCH','BI_INPUT_OUT_OF_DOMAIN'],'an integer slot needs an integer value (the declared domain also differs)');
});

test('C3 metrics: an absent metric stays absent and a zero for a missing metric is fabricated (11.1 item 10)',()=>{
  const absent=golden({result:r=>{delete r.selected.test.profit_factor;}});
  assert.equal(C1(absent).pass,true,'absent in the run and absent in the package');
  assert.equal(C3(absent).pass,true);
  assert.equal(ALL(absent).pass,true);
  const zero=golden({result:r=>{delete r.selected.test.profit_factor;},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.test.profit_factor='0';})});
  expectCodes(C1(zero),['BI_METRIC_FABRICATED']);
  const zeroNumber=golden({result:r=>{delete r.selected.test.profit_factor;},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.test.profit_factor=0;})});
  assert.ok(C1(zeroNumber).codes.includes('BI_METRIC_FABRICATED'));
  const nullValue=golden({result:r=>{delete r.selected.result.train.gross_loss;},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.train.gross_loss=null;})});
  expectCodes(C1(nullValue),['BI_METRIC_FABRICATED'],'a null is still an invented value');
  const storedNull=golden({result:r=>{r.selected.test.profit_factor=null;}});
  assert.equal(C1(storedNull).pass,true,'a stored null is kept as null');
  assert.equal(C3(storedNull).pass,true);
  const wholePartition=golden({result:r=>{r.selected.test={bars:100,closed_trades:9};},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.test.profit_factor='1.2';})});
  expectCodes(C1(wholePartition),['BI_METRIC_FABRICATED']);
  assert.deepEqual([...METRIC_KEYS],['bars','closed_trades','start_equity','end_equity','net_return_percent','max_drawdown_percent','profit_factor','gross_profit','gross_loss']);
});

test('C4: one negation per check gives exactly the expected code',()=>{
  const cases=[
    ['no run',subject=>{subject.run=null;},['BI_PROVENANCE_UNRESOLVED']],
    ['no packaged binding',subject=>{delete subject.files[MANIFEST_PATH];},['BI_PROVENANCE_UNRESOLVED']],
    ['alignment record absent',subject=>{delete subject.evidence.dataset_alignment;},['BI_DATASET_ALIGNMENT_MISSING']],
    ['alignment record malformed',subject=>{subject.evidence.dataset_alignment.matched_percent='100';},['BI_DATASET_ALIGNMENT_MISSING']],
    ['alignment below 100 percent',subject=>{subject.evidence.dataset_alignment.matched_percent=99.9;},['BI_DATASET_ALIGNMENT_FAILED']],
    ['unmatched bar',subject=>{subject.evidence.dataset_alignment.unmatched_bars=1;},['BI_DATASET_ALIGNMENT_FAILED']],
    ['future-data leakage',subject=>{subject.evidence.dataset_alignment.future_leakage=1;},['BI_DATASET_ALIGNMENT_FAILED']],
    ['native parity record absent',subject=>{delete subject.evidence.native_parity;},['BI_PARITY_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']],
    ['sample absent',subject=>{delete subject.evidence.native_parity.sample;},['BI_PARITY_EVIDENCE_MISSING']],
    ['warm-up below 500',subject=>{subject.evidence.native_parity.sample.warmup_bars=499;},['BI_PARITY_SAMPLE_FLOOR_NOT_MET']],
    ['warm-up below five lookbacks',subject=>{subject.evidence.native_parity.sample.lookback=200;subject.evidence.native_parity.sample.warmup_bars=999;},['BI_PARITY_SAMPLE_FLOOR_NOT_MET']],
    ['fewer than 2000 closed bars',subject=>{subject.evidence.native_parity.sample.closed_bars=1999;},['BI_PARITY_SAMPLE_FLOOR_NOT_MET']],
    ['fewer than 100 native events',subject=>{subject.evidence.native_parity.sample.native_events=99;},['BI_PARITY_SAMPLE_FLOOR_NOT_MET']],
    ['fewer than 30 BUY',subject=>{subject.evidence.native_parity.sample.buy_events=29;},['BI_PARITY_SAMPLE_FLOOR_NOT_MET']],
    ['fewer than 30 native exits',subject=>{subject.evidence.native_parity.sample.exit_events=29;},['BI_PARITY_SAMPLE_FLOOR_NOT_MET']],
    ['native signal match below 100 percent',subject=>{subject.evidence.native_parity.match_percent=99;},['BI_NATIVE_SIGNAL_PARITY_FAILED']],
    ['missing native event',subject=>{subject.evidence.native_parity.missing_events=1;},['BI_NATIVE_SIGNAL_PARITY_FAILED']],
    ['additional native event',subject=>{subject.evidence.native_parity.additional_events=1;},['BI_NATIVE_SIGNAL_PARITY_FAILED']],
    ['one-bar shift',subject=>{subject.evidence.native_parity.shift_bars=1;},['BI_NATIVE_SIGNAL_PARITY_FAILED']],
    ['bridge parity record absent',subject=>{delete subject.evidence.bridge_parity;},['BI_PARITY_EVIDENCE_MISSING']],
    ['bridge match below 100 percent',subject=>{subject.evidence.bridge_parity.match_percent=99;},['BI_BRIDGE_PARITY_FAILED']],
    ['SL/TP difference of one tick',subject=>{subject.evidence.bridge_parity.sl_tp_diff_ticks=1;},['BI_BRIDGE_PARITY_FAILED']],
    ['bridge parity for another exit version',subject=>{subject.evidence.bridge_parity.exit_version='bridge-exit-v1';},['BI_BRIDGE_PARITY_FAILED']],
    ['repaint record absent',subject=>{delete subject.evidence.repaint;},['BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']],
    ['one full-history recomputation',subject=>{subject.evidence.repaint.observations=1;},['BI_REPAINT_EVIDENCE_MISSING']],
    ['99 observations',subject=>{subject.evidence.repaint.observations=99;},['BI_REPAINT_EVIDENCE_MISSING']],
    ['changed native flag',subject=>{subject.evidence.repaint.changed_flags=1;},['BI_REPAINT_FLAGS_CHANGED']],
    ['changed flag with few observations',subject=>{subject.evidence.repaint.changed_flags=1;subject.evidence.repaint.observations=10;},['BI_REPAINT_FLAGS_CHANGED','BI_REPAINT_EVIDENCE_MISSING']],
    ['baseline absent',subject=>{delete subject.evidence.quant_baseline;},['BI_QUANT_BASELINE_FAILED']],
    ['baseline coverage',subject=>{subject.evidence.quant_baseline.coverage_percent=99;},['BI_QUANT_BASELINE_FAILED']],
    ['baseline decision match',subject=>{subject.evidence.quant_baseline.decision_match_percent=99;},['BI_QUANT_BASELINE_FAILED']],
    ['venue-step quantity difference',subject=>{subject.evidence.quant_baseline.quantity_step_diff=1;},['BI_QUANT_BASELINE_FAILED']],
    ['cash difference of two minor units',subject=>{subject.evidence.quant_baseline.cash_diff_minor_units=2;},['BI_QUANT_BASELINE_FAILED']],
    ['evidence for another source',subject=>{subject.evidence.native_parity.scope.source_hash=hex('other');},['BI_PARITY_SCOPE_MISMATCH']],
    ['evidence for other inputs',subject=>{subject.evidence.repaint.scope.effective_input_hash=hex('other');},['BI_PARITY_SCOPE_MISMATCH']],
    ['evidence for another dataset',subject=>{subject.evidence.dataset_alignment.scope.dataset_digest=hex('other');},['BI_PARITY_SCOPE_MISMATCH']],
    ['evidence for another engine',subject=>{subject.evidence.bridge_parity.scope.engine_hash=hex('other');},['BI_PARITY_SCOPE_MISMATCH']],
    ['evidence without scope',subject=>{delete subject.evidence.quant_baseline.scope;},['BI_PARITY_SCOPE_MISMATCH']],
    ['source version changed',subject=>{subject.current.membership[0].source_version=2;},['BI_SOURCE_VERSION_STALE']],
    ['source hash changed',subject=>{subject.current.membership[0].source_hash=hex('new-source');},['BI_SOURCE_VERSION_STALE']],
    ['Pine membership changed',subject=>{subject.current.membership.push({pine_import_id:'import-2',source_version:1,source_hash:hex('second')});},['BI_MEMBERSHIP_CHANGED']],
    ['policy version changed',subject=>{subject.current.policy_version='policy-v2';},['BI_POLICY_SNAPSHOT_MISMATCH']],
    ['policy hash changed',subject=>{subject.current.policy_hash=hex('new-policy');},['BI_POLICY_SNAPSHOT_MISMATCH']],
    ['deployment changed',subject=>{subject.current.deployment_id='deploy-2';},['BI_DEPLOYMENT_CHANGED']],
    ['selection changed',subject=>{subject.current.input_lock_hash=hex('new-lock');},['BI_SELECTION_CHANGED']],
    ['dataset no longer available',subject=>{subject.current.dataset_available=false;},['BI_DATASET_UNAVAILABLE']],
    ['current state unknown',subject=>{subject.current=null;},[...FRESHNESS_ORDER]],
    ['Bridge bounds unknown',subject=>{subject.bridge_bounds=null;},['BI_BRIDGE_PAIR_OUT_OF_BOUNDS']],
    ['ATR multiplier above the permitted bound',subject=>{subject.bridge_bounds.atr_multiplier.max='1.2';},['BI_BRIDGE_PAIR_OUT_OF_BOUNDS']],
    ['RR below the permitted bound',subject=>{subject.bridge_bounds.rr.min='1.5';},['BI_BRIDGE_PAIR_OUT_OF_BOUNDS']],
    ['no clearance records',subject=>{subject.clearances=[];},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['one blocker cleared',subject=>{subject.clearances.pop();},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['clearance for another export',subject=>{subject.clearances[0].export_id='other-export';},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['clearance for another run',subject=>{subject.clearances[0].run_id='other-run';},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['clearance for other parameters',subject=>{subject.clearances[0].parameter_hash=hex('other-parameters');},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['clearance without evidence hash',subject=>{subject.clearances[0].evidence_hash='x';},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['clearance with a SHA-256 of other evidence',subject=>{subject.clearances[0].evidence_hash=hex('any-evidence');},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['parity clearance carrying the repaint digest',subject=>{subject.clearances[0].evidence_hash=proofHash(subject.evidence,CANDIDATE_BLOCKERS[1]);},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['repaint clearance carrying the parity digest',subject=>{subject.clearances[1].evidence_hash=proofHash(subject.evidence,CANDIDATE_BLOCKERS[0]);},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['capability blocker cannot be cleared',subject=>{subject.run.contract.acceptance_blockers.push(...CAPABILITY_BLOCKERS);
      subject.clearances.push({blocker:CAPABILITY_BLOCKERS[0],run_id:RUN_ID,export_id:EXPORT_ID,parameter_hash:subject.clearances[0].parameter_hash,evidence_hash:hex('x')});},['ACCEPTANCE_BLOCKERS_PRESENT']],
    ['blockers unknown',subject=>{subject.run.contract.acceptance_blockers=null;},['BLOCKERS_UNKNOWN']]];
  for(const [label,change,codes] of cases){
    const subject=golden(),evidenceBefore=canonical(subject.evidence);
    change(subject);
    if(canonical(subject.evidence)!==evidenceBefore)syncClearances(subject);
    expectCodes(C4(subject),codes,label);
  }
  const equal=golden();
  equal.evidence.quant_baseline.cash_diff_minor_units=-1;
  assert.equal(C4(equal).pass,true,'one minor unit of cash difference is within the rule');
  const missing=golden();
  missing.evidence=null;
  const result=C4(missing);
  expectCodes(result,['BI_DATASET_ALIGNMENT_MISSING','BI_PARITY_EVIDENCE_MISSING','BI_REPAINT_EVIDENCE_MISSING','BI_QUANT_BASELINE_FAILED','ACCEPTANCE_BLOCKERS_PRESENT'],'all missing evidence reports together');
  assert.equal(isHardFailure(result),true,'a failed baseline is not retryable');
  // R6: the contract has no missing-evidence code for the quant baseline and the retryable list is closed.
  const noBaseline=golden();
  delete noBaseline.evidence.quant_baseline;
  const baselineResult=C4(noBaseline);
  expectCodes(baselineResult,['BI_QUANT_BASELINE_FAILED'],'a missing quant baseline record');
  assert.equal(isRetryable('BI_QUANT_BASELINE_FAILED'),false);assert.equal(isHardFailure(baselineResult),true);
  assert.equal(ALL(noBaseline).status,STATUS.EXPORT_REFUSED,'a missing baseline is terminal on the attempt');
  assert.equal(ALL(noBaseline).next.ok,true);
  // R15: a clearance clears a blocker only with the digest of its own evidence record.
  const cleared=golden();
  assert.deepEqual(cleared.clearances.map(item=>item.evidence_hash),[proofHash(cleared.evidence,CANDIDATE_BLOCKERS[0]),proofHash(cleared.evidence,CANDIDATE_BLOCKERS[1])]);
  assert.notEqual(cleared.clearances[0].evidence_hash,cleared.clearances[1].evidence_hash);
  assert.equal(C4(cleared).pass,true);
  const swapped=golden();
  [swapped.clearances[0].evidence_hash,swapped.clearances[1].evidence_hash]=[swapped.clearances[1].evidence_hash,swapped.clearances[0].evidence_hash];
  expectCodes(C4(swapped),['ACCEPTANCE_BLOCKERS_PRESENT'],'digests of the wrong records');
  const stale=golden();
  stale.evidence.repaint.observations=121;
  expectCodes(C4(stale),['ACCEPTANCE_BLOCKERS_PRESENT'],'evidence replaced after the clearance was written');
  syncClearances(stale);
  assert.equal(C4(stale).pass,true,'a clearance written for the new evidence clears again');
  const partial=golden();
  partial.clearances[1].evidence_hash=partial.clearances[0].evidence_hash;
  assert.equal(C4(partial).pass,false);
  const retry=golden();
  delete retry.evidence.repaint;delete retry.evidence.dataset_alignment;retry.clearances=[];
  const retryable=C4(retry);
  assert.equal(isHardFailure(retryable),false);
  assert.ok(retryable.codes.every(isRetryable));
});

test('Q: a qualification record only after one attempt passed every gate',()=>{
  const subject=golden(),gates=[C1(subject),C2(subject),C3(subject),C4(subject)];
  const passed=note(evaluateQualification(subject,gates));
  assert.equal(passed.pass,true);
  assert.deepEqual(Object.keys(passed.record).sort(),['attempt_id','binding_hash','export_id','fixture','gate_results','package_hash','validated_at_utc','validator_engine_hash']);
  assert.equal(passed.record.attempt_id,'attempt-0001');assert.equal(passed.record.validated_at_utc,'2026-10-19T12:05:00Z');
  assert.equal(passed.record.validator_engine_hash,hex('validator-engine'));
  assert.deepEqual(passed.record.gate_results.map(item=>item.gate),['C1','C2','C3','C4']);
  for(const gate of ['C1','C2','C3','C4']){
    const failing=gates.map(item=>item.gate===gate?{...item,state:'FAIL',pass:false,codes:['BI_SECRET_DETECTED']}:item);
    assert.deepEqual(evaluateQualification(subject,failing),notReached('Q'),'a failing '+gate+' leaves Q NOT_REACHED');
  }
  assert.deepEqual(evaluateQualification(subject,gates.slice(0,3)),notReached('Q'));
  assert.deepEqual(evaluateQualification(subject,null),notReached('Q'));
  // R2: B0 is a build-time gate. A passing, failing or absent B0 result does not change Q at attempt time.
  const withB0=[B0(subject),...gates],failedB0=[{gate:'B0',state:'FAIL',pass:false,codes:['BI_SECRET_DETECTED']},...gates];
  assert.deepEqual(evaluateQualification(subject,withB0).record.gate_results.map(item=>item.gate),['C1','C2','C3','C4']);
  assert.equal(evaluateQualification(subject,failedB0).pass,true,'Q never reads B0');
  // R7: bad caller attempt metadata refuses the call; it is never a package failure and never a status.
  const bad=[['no attempt',s=>{s.attempt=null;},['attempt.attempt_id','attempt.validator_engine_hash','attempt.validated_at_utc']],
    ['time not UTC',s=>{s.attempt.validated_at_utc='2026-10-19T12:05:00+07:00';},['attempt.validated_at_utc']],
    ['engine hash',s=>{s.attempt.validator_engine_hash='x';},['attempt.validator_engine_hash']],
    ['attempt id',s=>{s.attempt.attempt_id='';},['attempt.attempt_id']]];
  for(const [label,change,fields] of bad){
    const input=golden({subject:change});
    const q=evaluateQualification(input,gates);
    assert.equal(isRefused(q),true,label);assert.equal(q.refused,INPUT_INVALID,label);assert.deepEqual([...q.fields],fields,label);
    assert.equal(q.pass,false);assert.ok(!('state' in q),'a refusal is no gate outcome: '+label);assert.deepEqual([...q.codes],[]);
    const all=ALL(input);
    assert.equal(all.refused,INPUT_INVALID,label);assert.deepEqual([...all.fields],fields,label);
    assert.equal(all.pass,false);assert.deepEqual([...all.gates],[]);
    assert.equal(all.status,null,'no status event');assert.equal(all.next,null,'no transition');assert.equal(all.record,null,'no record');assert.equal(all.ready,false);
    assert.notEqual(all.status,STATUS.EXPORT_REFUSED,'bad attempt metadata never refuses the package');
  }
  assert.equal(ALL(golden()).status,STATUS.EXPORT_VALIDATED,'the same package validates with good metadata');
});

/* ---- ordering: hard failures, retryable failures and result values ---- */

test('a hard failure leaves every later gate NOT_REACHED; a retryable failure does not (11.1 item 2)',()=>{
  const cases=[
    ['C1 fails hard',subject=>{delete subject.files['quant-data/equity.csv'];},['FAIL','NOT_REACHED','NOT_REACHED','NOT_REACHED','NOT_REACHED']],
    ['C2 fails hard',subject=>{subject.compile.collisions=1;},['PASS','FAIL','NOT_REACHED','NOT_REACHED','NOT_REACHED']],
    ['C3 fails hard',subject=>{subject.dataset.readable=false;},['PASS','PASS','FAIL','NOT_REACHED','NOT_REACHED']],
    ['C4 fails hard',subject=>{subject.evidence.repaint.changed_flags=1;},['PASS','PASS','PASS','FAIL','NOT_REACHED']],
    ['C2 fails on missing evidence only',subject=>{subject.compile=null;},['PASS','FAIL','PASS','PASS','NOT_REACHED']]];
  for(const [label,change,states] of cases){
    const subject=golden();
    change(subject);
    const result=ALL(subject);
    assert.deepEqual(result.gates.map(gate=>gate.state),states,label);
    assert.equal(result.pass,false,label);
    for(const gate of result.gates.filter(item=>item.state==='NOT_REACHED'))assert.deepEqual([...gate.codes],[],label);
  }
  const both=golden();
  both.compile=null;both.evidence.repaint=null;both.evidence.dataset_alignment=null;
  const result=ALL(both);
  assert.deepEqual(result.gates.map(gate=>gate.state),['PASS','FAIL','PASS','FAIL','NOT_REACHED']);
  assert.deepEqual(codesOf(result),['BI_COMPILE_EVIDENCE_MISSING','BI_DATASET_ALIGNMENT_MISSING','BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']);
  assert.equal(result.status,STATUS.EXPORT_CANDIDATE,'only missing evidence: the package stays a candidate for a retry');
  assert.equal(result.next.ok,true);
  const hard=golden();
  hard.compile=null;hard.evidence.repaint.changed_flags=1;
  assert.equal(ALL(hard).status,STATUS.EXPORT_REFUSED);
  // R2: a B0 failure is a build outcome (no export row) and the attempt never re-evaluates it.
  const unbuilt=golden({subject:s=>{s.run.status='RUNNING';}});
  expectCodes(B0(unbuilt),['STATUS_NOT_COMPLETED']);
  assert.deepEqual({...transition(null,{kind:'BUILD',b0_pass:B0(unbuilt).pass})},{ok:true,to:null,codes:[]});
  const attempt=ALL(unbuilt);
  assert.deepEqual(attempt.gates.map(gate=>gate.gate),['C1','C2','C3','C4','Q']);
  assert.equal(attempt.status,STATUS.EXPORT_VALIDATED,'an attempt that passes C1 to C4 never turns into a build decision');
  const grown=golden({subject:s=>{s.holdout.exposure_register.push({owner_id:OWNER,market:{...MARKET_OBJECT},source_hash:hex('s'),window:{...s.own_holdout},comparison_id:'cmp-late',
    at_utc:'2026-10-19T11:00:00Z'});}});
  expectCodes(B0(grown),['BI_HOLDOUT_EXPOSED_BY_SELECTION']);
  assert.equal(ALL(grown).status,STATUS.EXPORT_VALIDATED,'a register that grows after the build does not stop an attempt (QR-3 K6)');
});

test('gate order and codes do not depend on result values (11.1 item 5)',()=>{
  const tweak=r=>{
    r.selected.result.validation.net_return_percent='7.7';r.selected.result.train.net_return_percent='9.9';r.selected.test.net_return_percent='0.1';
    r.selected.test.max_drawdown_percent='0.4';r.selected.cost_stress.validation.net_return_percent='7.0';
    for(const item of r.selected.sensitivity)item.result.validation.net_return_percent='7.1';
  };
  const mutations=[
    s=>s,s=>{s.run.status='RUNNING';},s=>{delete s.files['setup-guide.md'];},s=>{s.compile=null;},s=>{s.evidence.repaint.changed_flags=1;},s=>{s.holdout=null;},
    s=>{s.current.deployment_id='deploy-2';},s=>{s.hard_limits=null;},s=>{s.run.result.holdout_evaluated=false;},s=>{s.dataset.digest=hex('x');}];
  for(const [index,mutate] of mutations.entries()){
    const a=golden(),b=golden({result:tweak});
    mutate(a);mutate(b);
    // a metric change leaves the package checksums and results consistent in B only, so compare after the same repack.
    assert.deepEqual(shape(ALL(a)),shape(ALL(b)),'mutation '+index);
    assert.deepEqual(codesOf(B0(a)),codesOf(B0(b)),'build codes, mutation '+index);
  }
  assert.deepEqual(shape(ALL(golden())),shape(ALL(golden({result:tweak}))));
});

/* ---- 11.1 item 3: missing, null, empty or wrong-type input ---- */

test('missing, null, empty and wrong-type input is a FAIL with a valid code and never an exception (11.1 item 3)',()=>{
  const garbage=[undefined,null,'',[],{},0,-1,NaN,Infinity,'x',true,false,()=>1];
  const paths=['owner_id','export_id','run','holdout','binding','files','package_hash','binding_hash','compile','native_alert_isolation','deployment','dataset','hard_limits',
    'evidence','clearances','current','bridge_bounds','attempt','run.status','run.result','run.contract','run.integrity','run.owner_id','run.run_id','run.contract_hash',
    'run.submission_hash','run.result.selected','run.result.holdout_evaluated','run.result.completion_reason','run.result.selected.test','run.result.selected.result',
    'run.result.selected.parameters','run.contract.source','run.contract.input_lock','run.contract.snapshot','run.contract.dataset','run.contract.split','run.contract.model',
    'run.contract.rules','run.contract.engine_hash','run.contract.acceptance_blockers','run.contract.version','holdout.earlier_holdouts','holdout.earlier_searched',
    'holdout.registered_boundary','compile.errors','compile.warnings','compile.mapping_check','compile.indicator_sha256','compile.compiled_at_utc','compile.export_id',
    'evidence.dataset_alignment','evidence.native_parity','evidence.native_parity.sample','evidence.bridge_parity','evidence.repaint','evidence.quant_baseline',
    'current.membership','current.dataset_available','attempt.attempt_id','attempt.validator_engine_hash','attempt.validated_at_utc',
    'run.created_at_utc','holdout.exposure_register','trace_reproduction','dataset.metadata','dataset.readable','dataset.digest','export','export.library_versions','attempt_no',
    ...BINDING_FIELDS.map(field=>'binding.'+field)];
  const NONE_LISTS=['holdout.earlier_holdouts','holdout.earlier_searched','holdout.exposure_register','compile.warnings'];
  const assign=(object,path,value)=>{const keys=path.split('.');let target=object;for(const key of keys.slice(0,-1))target=target[key];target[keys.at(-1)]=value;};
  let evaluations=0;
  for(const path of paths){
    for(const value of garbage){
      const subject=golden();
      // Only a value that equals what is already there, or an empty list that means "none", may pass; every other change must fail.
      const before=canonical(path.split('.').reduce((object,key)=>object?.[key],subject)??null);
      assign(subject,path,value);
      let result,build;
      assert.doesNotThrow(()=>{result=ALL(subject);build=B0(subject);},path+' = '+String(value));
      evaluations++;
      const same=value!==undefined&&canonical(value)===before;
      const none=NONE_LISTS.includes(path)&&Array.isArray(value)&&value.length===0;
      const free=path==='attempt.attempt_id'&&typeof value==='string'&&value.length>0;
      // The build gate B0 and the attempt gates C1 to C4 and Q judge different fields; a package is sound only when both pass.
      assert.equal(build.pass===true&&result.pass===true,same||none||free,path+' = '+String(value));
      for(const code of [...result.codes,...build.codes])assert.match(code,CODE_PATTERN);
      assert.equal(result.ready,false);
    }
  }
  assert.ok(evaluations>800);
  const everything=[undefined,null,'x',5,[],{},NaN,true];
  for(const input of everything){
    for(const gate of [B0,C1,C2,C3,C4]){
      let result;
      assert.doesNotThrow(()=>{result=gate(input);});
      assert.equal(result.pass,false);assert.equal(result.state,'FAIL');assert.ok(result.codes.length>0);
    }
    assert.doesNotThrow(()=>ALL(input));
    assert.equal(ALL(input).pass,false);
    assert.doesNotThrow(()=>{ownerRecommendationGate(input);libraryG8(input,input);qualifiedFromRecords(input);diagnosticBundle(input);bindingComplete(input);
      scanContent(input);fileEntries(input);packageHash(input);bindingHash(input);effectiveInputHash(input);searchedWindow(input);freshnessCodes(input,input);
      freshness(input);readState(input);isReady(input);transition(input,input);evaluateQualification(input,input);});
  }
});

/* ---- 11.1 item 4: the run's own rules ---- */

test('thresholds come from the run\'s own rules and a differing current RULES is a limitation (11.1 item 4)',()=>{
  const control=golden();
  assert.deepEqual([...B0(control).limitations],[],'identical rules carry no limitation');
  assert.deepEqual(control.run.contract.rules,RULES);
  const looser=golden({contract:c=>{c.rules={...RULES,minimum_closed_trades_test:3,maximum_drawdown_percent:30};},result:r=>{r.selected.test=metricsOf('1.9',4,'25');}});
  const looserResult=ALL(looser);
  assert.equal(looserResult.pass,true,'judged by its own rules');
  assert.deepEqual([...looserResult.limitations],['RULES_VERSION_DIFFERS']);
  assert.equal(looserResult.status,STATUS.EXPORT_VALIDATED);
  const underCurrent=golden({result:r=>{r.selected.test=metricsOf('1.9',4,'25');}});
  expectCodes(B0(underCurrent),['INSUFFICIENT_TEST_TRADES','TEST_DRAWDOWN_EXCEEDED'],'the same numbers fail under the current rules');
  const stricter=golden({contract:c=>{c.rules={...RULES,minimum_closed_trades_test:12};}});
  expectCodes(B0(stricter),['INSUFFICIENT_TEST_TRADES'],'stricter own rules fail although no stored reason names it and the current rules would pass');
  assert.deepEqual([...B0(stricter).limitations],['RULES_VERSION_DIFFERS']);
  const sensitivity=golden({contract:c=>{c.rules={...RULES,sensitivity_max_drop_percentage_points:0.2};}});
  expectCodes(B0(sensitivity),['SENSITIVITY_FAILED'],'the sensitivity rule is the run\'s own');
  const train=golden({contract:c=>{c.rules={...RULES,minimum_closed_trades_train:10};}});
  expectCodes(B0(train),['NO_SCREENED_CANDIDATE']);
  // R10: current_rules is a required input; without it the call is refused and nothing is judged or claimed.
  for(const absent of [undefined,null,'x',[],5]){
    const unknownCurrent=golden({subject:s=>{s.current_rules=absent;}});
    const build=B0(unknownCurrent),attempt=ALL(unknownCurrent);
    assert.equal(build.refused,INPUT_INVALID);assert.deepEqual([...build.fields],['current_rules']);assert.equal(build.pass,false);
    assert.equal(attempt.refused,INPUT_INVALID);assert.deepEqual([...attempt.fields],['current_rules']);assert.equal(attempt.status,null);assert.equal(attempt.next,null);
  }
  const foreignWithoutRules=golden({subject:s=>{s.owner_id='owner-b';delete s.current_rules;}});
  expectCodes(B0(foreignWithoutRules),['NOT_FOUND'],'ownership is judged before input, so a foreign run leaks nothing');
  const nonNumeric=golden({contract:c=>{c.rules={...RULES,maximum_drawdown_percent:'20'};}});
  expectCodes(B0(nonNumeric),['BI_BINDING_INCOMPLETE'],'unreadable rules are never replaced by a constant');
});

/* ---- 11.1 item 6: hashes ---- */

test('binding_hash and package_hash are stable across key order and whitespace and change with any byte (11.1 item 6)',()=>{
  const subject=golden(),manifest=JSON.parse(subject.files[MANIFEST_PATH]);
  assert.match(subject.binding_hash,/^[a-f0-9]{64}$/);assert.match(subject.package_hash,/^[a-f0-9]{64}$/);
  assert.equal(bindingHash(sorted(subject.binding)),subject.binding_hash,'binding key order');
  assert.equal(packageHash(sorted(manifest)),subject.package_hash,'manifest key order');
  assert.equal(packageHash(JSON.stringify(manifest)),subject.package_hash,'compact JSON text');
  assert.equal(packageHash(JSON.stringify(manifest,null,'\t')),subject.package_hash,'tab-indented JSON text');
  assert.equal(packageHash('\n\n '+JSON.stringify(sorted(manifest),null,7)+'\n'),subject.package_hash,'reordered and respaced JSON text');
  assert.equal(packageHash(subject.files[MANIFEST_PATH]),subject.package_hash);
  assert.equal(packageHash('{not json'),null);assert.equal(packageHash(null),null);assert.equal(bindingHash([]),null);
  assert.equal(golden().package_hash,subject.package_hash,'deterministic rebuild');assert.equal(golden().binding_hash,subject.binding_hash);
  const again=buildManifest({identity:manifest.identity,binding:manifest.binding,inputs:manifest.inputs,evidence:manifest.evidence,limitations:manifest.limitations,
    fixture:manifest.fixture,files:subject.files});
  assert.deepEqual(again,manifest);
  assert.equal(packageHash(again),subject.package_hash);
  assert.deepEqual(fileEntries(subject.files).map(entry=>entry.path),PACKAGE_FILES.filter(path=>path!==MANIFEST_PATH).sort());
  assert.equal(manifest.schema_version,MANIFEST_SCHEMA);
  const rebuilt=files=>packageHash(buildManifest({identity:manifest.identity,binding:manifest.binding,inputs:manifest.inputs,evidence:manifest.evidence,
    limitations:manifest.limitations,fixture:manifest.fixture,files}));
  for(const path of PACKAGE_FILES.filter(item=>item!==MANIFEST_PATH)){
    const files={...subject.files};
    const bytes=Buffer.from(files[path],'utf8');
    bytes[bytes.length-2]^=1;
    files[path]=bytes;
    assert.notEqual(rebuilt(files),subject.package_hash,'one byte of '+path);
  }
  assert.notEqual(rebuilt({...subject.files,'quant-data/new.csv':'x'}),subject.package_hash,'an added file');
  const key={...manifest,fixture:false};
  assert.notEqual(packageHash(key),subject.package_hash,'a manifest value');
  assert.notEqual(bindingHash({...subject.binding,exit_version:'bridge-exit-v1'}),subject.binding_hash);
  assert.equal(bindingHash({...subject.binding}),subject.binding_hash);
});

/* ---- 11.1 item 7: content scan ---- */

test('content scan refuses a tokened webhook URL, a bearer pattern, a private key and Windows and POSIX absolute paths (11.1 item 7)',()=>{
  const secrets=['https://hooks.example.com/webhook/9f8e7d6c5b4a39281716a5b4c3d2e1f0','https://example.com/alerts?token=abcdef123456','http://x.example/a?secret=zz9988776655',
    'Authorization: Bearer abcdefghijklmnop12345','bearer eyJhbGciOiJIUzI1NiJ9.payload.signature123','api_key = "AKIAABCDEFGHIJKLMNOP"','{"password":"correct-horse-battery"}',
    '-----BEGIN RSA PRIVATE KEY-----','-----BEGIN PRIVATE KEY-----','https://user:hunter2pass@host.example/path'];
  for(const value of secrets)assert.deepEqual(scanContent(value),['BI_SECRET_DETECTED'],value);
  const paths=['C:\\Users\\me\\bot\\config.json','c:/Users/me/bot','D:\\data\\x','/home/example/app/.env','path=/Users/me/Documents/x','"/var/lib/example-app"','\\\\server\\share\\x',
    'see ~/secrets/key','config in (/etc/example-app/app.conf)','{"path":"/tmp/work/file"}'];
  for(const value of paths)assert.deepEqual(scanContent(value),['BI_MACHINE_PATH_DETECTED'],value);
  assert.deepEqual(scanContent('token https://x.example/a?token=abcdef123456 at C:\\Users\\me'),['BI_SECRET_DETECTED','BI_MACHINE_PATH_DETECTED']);
  const benign=['https://www.tradingview.com/chart/','quant-data/manifest.json','Webhook credentials stay outside this package.','See https://docs.example.com/guides/setup for details',
    '// see /not/a/path','2026-10-19T12:00:00Z','a/b/c.csv','mailto:person@example.com','The secret is never stored here.','token: short','https://example.com/path/segment-without-digits-in-it',''];
  for(const value of benign)assert.deepEqual(scanContent(value),[],value);
  for(const value of [undefined,null,5,{},[]])assert.deepEqual(scanContent(value),[]);
  const golds=golden();
  for(const content of Object.values(golds.files))assert.deepEqual(scanContent(content),[],'the golden package has no secret and no path');
});

/* ---- 11.1 items 11 to 14: holdout, blockers, real shape, multi-Pine ---- */

test('holdout independence: reuse, searched-data overlap and registered boundary (11.1 item 11)',()=>{
  const own=holdoutWindow(golden().run.contract);
  assert.deepEqual(own,golden().own_holdout);
  const searched=searchedWindow(golden().run.contract);
  assert.equal(searched.end_time+MINUTE,own.start_time,'the searched window ends where the holdout begins');
  assert.equal(searched.start_time,T0);
  assert.equal(searchedWindow({}),null);assert.equal(searchedWindow(null),null);
  const run=(lookups)=>golden({subject:s=>{Object.assign(s.holdout,lookups);}});
  expectCodes(B0(run({earlier_holdouts:[{...own}]})),['HOLDOUT_WINDOW_REUSED']);
  expectCodes(B0(run({earlier_holdouts:[{start_time:own.end_time,end_time:own.end_time+MINUTE}]})),['HOLDOUT_WINDOW_REUSED'],'sharing one bar is an overlap');
  assert.equal(B0(run({earlier_searched:[{...searched}]})).pass,true,'the run\'s own searched window ends where its holdout begins and does not overlap it');
  expectCodes(B0(run({earlier_searched:[{start_time:searched.start_time,end_time:own.start_time}]})),['BI_HOLDOUT_OVERLAPS_SEARCHED_DATA'],'an earlier run searched the first holdout bar');
  expectCodes(B0(run({earlier_searched:[{start_time:own.start_time+MINUTE,end_time:own.end_time-MINUTE}]})),['BI_HOLDOUT_OVERLAPS_SEARCHED_DATA']);
  expectCodes(B0(run({registered_boundary:{exists:true,start_time:own.start_time+MINUTE}})),['BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY']);
  expectCodes(B0(run({earlier_holdouts:[{...own}],earlier_searched:[{...own}],registered_boundary:{exists:true,start_time:own.end_time}})),
    ['HOLDOUT_WINDOW_REUSED','BI_HOLDOUT_OVERLAPS_SEARCHED_DATA','BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY'],'independent checks report together');
  assert.equal(B0(run({registered_boundary:{exists:true,start_time:own.start_time}})).pass,true,'a holdout that starts at the boundary is allowed');
  assert.equal(B0(run({registered_boundary:{exists:true,start_time:own.start_time-MINUTE}})).pass,true);
  assert.equal(B0(run({earlier_holdouts:[{start_time:own.end_time+MINUTE,end_time:own.end_time+2*MINUTE}]})).pass,true,'a later disjoint window is independent');
  for(const bad of [{earlier_holdouts:'x'},{earlier_holdouts:[{start_time:1}]},{earlier_holdouts:[{start_time:5,end_time:1}]},{earlier_searched:null},{registered_boundary:{exists:true}},{registered_boundary:{exists:'yes'}}])
    expectCodes(B0(run(bad)),['HOLDOUT_INDEPENDENCE_NOT_CHECKED'],JSON.stringify(bad));
  assert.ok(B0(golden({contract:c=>{c.split=null;}})).codes.includes('HOLDOUT_INDEPENDENCE_NOT_CHECKED'),'an unreadable own window cannot be shown independent');
});

test('blockers: a capability blocker refuses B0; candidate blockers allow B0 and fail C4 until clearance records exist (11.1 item 12)',()=>{
  assert.deepEqual([...CAPABILITY_BLOCKERS],['CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']);
  assert.deepEqual([...CANDIDATE_BLOCKERS],['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED']);
  const capability=golden({contract:c=>{c.acceptance_blockers=[...CANDIDATE_BLOCKERS,...CAPABILITY_BLOCKERS];}});
  expectCodes(B0(capability),['BI_CAPABILITY_BLOCKER_PRESENT']);
  expectCodes(C4(capability),['ACCEPTANCE_BLOCKERS_PRESENT'],'a capability blocker is never cleared by a candidate clearance');
  const candidate=golden({subject:s=>{s.clearances=[];}});
  assert.equal(B0(candidate).pass,true,'candidate evidence blockers do not refuse the build');
  expectCodes(C4(candidate),['ACCEPTANCE_BLOCKERS_PRESENT']);
  const result=ALL(candidate);
  assert.deepEqual(result.gates.map(gate=>gate.state),['PASS','PASS','PASS','FAIL','NOT_REACHED']);
  assert.equal(result.status,STATUS.EXPORT_CANDIDATE,'cleared later by append-only records, same package bytes');
  const partial=golden({subject:s=>{s.clearances=s.clearances.slice(0,1);}});
  expectCodes(C4(partial),['ACCEPTANCE_BLOCKERS_PRESENT']);
  const none=golden({contract:c=>{c.acceptance_blockers=[];},subject:s=>{s.clearances=[];}});
  assert.equal(C4(none).pass,true,'a contract without blockers needs no clearance');
  assert.equal(B0(none).pass,true);
  assert.equal(ALL(golden()).pass,true,'with both clearance records the candidate passes');
});

test('the current real contract shape never passes B0 and never qualifies a run (11.1 item 13)',()=>{
  const real=runOf({scenario:'PENDING',owner:OWNER,bot:BOT,deployment:DEPLOY,importId:IMPORT});
  assert.equal(real.contract.scope,'SPT_CUSTOM_ENGINEERING_ONLY');
  assert.deepEqual(real.contract.acceptance_blockers,['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']);
  assert.equal(real.result.owner_recommendation_ready,false);
  const subject=golden({subject:s=>{s.run={...clone(real),owner_id:OWNER,integrity:{contract_hash_verified:true,report_matches_checkpoints:true}};}});
  const result=B0(subject);
  assert.equal(result.pass,false);
  assert.ok(result.codes.includes('BI_CAPABILITY_BLOCKER_PRESENT'));
  assert.ok(result.codes.includes('OWNER_RECOMMENDATION_NOT_READY'));
  assert.equal(transition(null,{kind:'BUILD',b0_pass:result.pass}).to,null,'a B0 failure builds no export row');
  const full=ALL(subject);
  assert.equal(full.pass,false,'the real contract shape also fails its own C1 to C4 binding checks');
  assert.equal(full.record,null);assert.equal(full.ready,false);
  assert.equal(diagnosticBundle(subject.run).label,'DIAGNOSTIC_ONLY');
  const library=qualification({status:real.status,result:real.result,blockers:real.contract.acceptance_blockers,integrity:{contract_hash_verified:true,report_matches_checkpoints:true},holdoutOverlap:{overlaps:false}});
  assert.equal(library.qualified,false);
  assert.equal(library.gates[5].code,'ACCEPTANCE_BLOCKERS_PRESENT');assert.equal(library.gates[6].code,'OWNER_RECOMMENDATION_NOT_READY');assert.equal(library.gates[7].code,'QL4C_VALIDATION_NOT_AVAILABLE');
  assert.equal(QUALIFIED_TOTAL,0);assert.equal(QUALIFIED_WINNER,null);
  assert.deepEqual({...qualifiedFromRecords([])},{total:0,winner:null,runs:[]});
  assert.equal(libraryG8([],real.run_id).code,'QL4C_VALIDATION_NOT_AVAILABLE');
  const v2=runOf({scenario:'PENDING',version:'v2',owner:OWNER,bot:BOT,deployment:DEPLOY,importId:IMPORT});
  assert.equal(v2.contract.version,'ql3a-research-job-v2');
  assert.equal(ownerRecommendationGate(v2).code,'OWNER_RECOMMENDATION_NOT_READY');
  for(const version of ['ql3a-research-job-v1','ql3a-research-job-v2']){
    const legacy=golden({contract:c=>{c.version=version;}});
    expectCodes(B0(legacy),['OWNER_RECOMMENDATION_NOT_READY'],'candidate-only blockers do not rescue '+version);
  }
});

test('a multi-Pine fixture passing C1 to C4 ends EXPORT_INTERNAL and is never READY (11.1 item 14)',()=>{
  const second={...SECOND};
  const multi=internalGolden();
  assert.equal(multi.binding.mode,'MULTI_PINE');assert.equal(multi.binding.pine_count,2);
  const result=ALL(multi);
  assert.equal(result.pass,true);
  assert.equal(result.status,STATUS.EXPORT_INTERNAL);
  assert.equal(result.ready,false);
  assert.equal(result.record.fixture,true);
  // R13: at build, multi-Pine without the internal path has its own code; the research admission code is not reused.
  const external=golden({contract:c=>{c.snapshot.membership.push(second);}});
  expectCodes(B0(external),['BI_MULTI_PINE_INTERNAL_ONLY']);
  assert.equal(isRetryable('BI_MULTI_PINE_INTERNAL_ONLY'),false);
  assert.equal(B0(multi).pass,true,'the internal path builds');
  assert.equal(transition(null,{kind:'BUILD',b0_pass:B0(external).pass}).to,null,'no export row without the internal path');
  for(const fresh of [true,false]){
    const view=readState({status:STATUS.EXPORT_INTERNAL,binding:{...multi.binding,fixture:false},current:multi.current,replay_mismatch:!fresh,requester_owner_id:OWNER});
    assert.equal(view.ready,false,'EXPORT_INTERNAL is never READY');
  }
  assert.equal(isReady({status:STATUS.EXPORT_VALIDATED,fresh:true,mode:'MULTI_PINE',fixture:false,owns_bot:true}),false);
  assert.equal(libraryG8([{run_id:RUN_ID,mode:'MULTI_PINE',record:{...result.record,fixture:false}}],RUN_ID).state,'FAIL','a multi-Pine record is never a G8 source');
  const mismatch=golden({binding:b=>{b.mode='ONE_PINE';b.pine_count=1;},contract:c=>{c.snapshot.membership.push(second);}});
  expectCodes(C3(mismatch),['BI_BINDING_MISMATCH'],'a multi-Pine run cannot be labelled ONE_PINE');
});

test('RC-11: the EXPORT_INTERNAL path tolerates MULTI_PINE_REQUIRES_APP_3B and a G7 FAIL for the multi-Pine version only (11.1 item 20)',()=>{
  assert.equal(MULTI_PINE_CONTRACT_VERSION,'ql3a-research-job-multi-v1');
  assert.equal(MULTI_PINE_BLOCKER,'MULTI_PINE_REQUIRES_APP_3B');
  // M6: the multi-Pine version is never one of the versions whose G7 derives PASS, and the blocker is no listed capability or candidate blocker
  assert.ok(!OWNER_RECOMMENDATION_CONTRACT_VERSIONS.includes(MULTI_PINE_CONTRACT_VERSION));
  assert.ok(!CAPABILITY_BLOCKERS.includes(MULTI_PINE_BLOCKER)&&!CANDIDATE_BLOCKERS.includes(MULTI_PINE_BLOCKER));
  assert.equal(ownerRecommendationGate({result:{completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'},contract:{version:MULTI_PINE_CONTRACT_VERSION}}).state,'FAIL');
  const INTERNAL_BLOCKED=['BI_CAPABILITY_BLOCKER_PRESENT'];
  // the F17-like fixture: M2, M4, M5, M7 and M8
  const f17=internalGolden();
  assert.equal(f17.run.contract.version,MULTI_PINE_CONTRACT_VERSION);
  assert.deepEqual(f17.run.contract.acceptance_blockers,[...CANDIDATE_BLOCKERS,MULTI_PINE_BLOCKER]);
  assert.equal(f17.run.result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  assert.equal(f17.binding.mode,'MULTI_PINE');
  const build=B0(f17);
  expectCodes(build,[],'B0 passes: the blocker and the G7 FAIL are tolerated');
  assert.equal(build.pass,true);
  assert.deepEqual({...build.g7},{gate:'G7',state:'FAIL',code:'OWNER_RECOMMENDATION_NOT_READY'},'the gate report still shows G7 FAIL, never PASS');
  assert.deepEqual({...ownerRecommendationGate(f17.run)},{gate:'G7',state:'FAIL',code:'OWNER_RECOMMENDATION_NOT_READY'});
  assert.equal(C4(f17).pass,true,'C4 does not fail G6 for the blocker');
  const attempt=ALL(f17);
  assert.equal(attempt.pass,true);
  assert.equal(attempt.status,STATUS.EXPORT_INTERNAL,'the internal path ends EXPORT_INTERNAL');
  assert.equal(attempt.ready,false,'never READY');
  assert.equal(readState({status:attempt.status,binding:{...f17.binding,fixture:false},current:f17.current,replay_mismatch:false,requester_owner_id:OWNER}).ready,false);
  assert.equal(libraryG8([{run_id:RUN_ID,mode:'MULTI_PINE',record:{...attempt.record,fixture:false}}],RUN_ID).state,'FAIL','never a G8 source');
  assert.equal(qualifiedFromRecords([{run_id:RUN_ID,mode:'MULTI_PINE',record:{...attempt.record,fixture:false}}]).total,0,'QUALIFIED_TOTAL stays 0');
  assert.equal(QUALIFIED_TOTAL,0);
  // supplied flags never set G7, with or without the internal path
  const flagged=internalGolden({result:r=>{r.owner_recommendation_ready=true;},subject:s=>{s.run.owner_recommendation_ready=true;s.g7='PASS';}});
  assert.equal(B0(flagged).g7.state,'FAIL');expectCodes(B0(flagged),[]);

  // M3: off the internal path the blocker is a capability blocker, and a multi-Pine run without it has its own code
  const off=internalGolden({subject:s=>{s.internal=false;}});
  expectCodes(B0(off),['BI_CAPABILITY_BLOCKER_PRESENT','BI_MULTI_PINE_INTERNAL_ONLY','OWNER_RECOMMENDATION_NOT_READY']);
  expectCodes(C4(off),['ACCEPTANCE_BLOCKERS_PRESENT'],'C4 off the internal path: the blocker fails G6');
  for(const flag of ['true',1,undefined,null,{}]){
    const subject=internalGolden({subject:s=>{if(flag===undefined)delete s.internal;else s.internal=flag;}});
    assert.ok(B0(subject).codes.includes('BI_CAPABILITY_BLOCKER_PRESENT'),'only an explicit true opens the path: '+String(flag));
    assert.ok(B0(subject).codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'));
    expectCodes(C4(subject),['ACCEPTANCE_BLOCKERS_PRESENT']);
  }
  const oneRun=golden({contract:c=>{c.acceptance_blockers=[...CANDIDATE_BLOCKERS,MULTI_PINE_BLOCKER];},subject:s=>{s.internal=true;}});
  expectCodes(B0(oneRun),[...INTERNAL_BLOCKED,'BI_BINDING_MISMATCH'],'a one-Pine run gets no tolerance, and the internal flag on it is a binding mismatch');
  expectCodes(C4(oneRun),['ACCEPTANCE_BLOCKERS_PRESENT']);

  // M2: any other capability blocker, and any unknown blocker, still refuses on the internal path
  const otherCapability=internalGolden({contract:c=>{c.acceptance_blockers.push(...CAPABILITY_BLOCKERS);}});
  expectCodes(B0(otherCapability),INTERNAL_BLOCKED);expectCodes(C4(otherCapability),['ACCEPTANCE_BLOCKERS_PRESENT']);
  const unknown=internalGolden({contract:c=>{c.acceptance_blockers.push('MULTI_PINE_REQUIRES_APP_3C');}});
  expectCodes(B0(unknown),INTERNAL_BLOCKED,'an unknown blocker is never tolerated');expectCodes(C4(unknown),['ACCEPTANCE_BLOCKERS_PRESENT']);
  const lower=internalGolden({contract:c=>{c.acceptance_blockers=[...CANDIDATE_BLOCKERS,'multi_pine_requires_app_3b'];}});
  expectCodes(B0(lower),INTERNAL_BLOCKED,'the blocker name is exact');
  const noList=internalGolden({contract:c=>{c.acceptance_blockers=null;}});
  assert.ok(B0(noList).codes.includes('BLOCKERS_UNKNOWN')&&!B0(noList).codes.includes('BI_CAPABILITY_BLOCKER_PRESENT'),'a non-array list is unknown');
  expectCodes(C4(noList),['BLOCKERS_UNKNOWN']);
  // candidate evidence blockers still need their clearance records at C4 on the internal path
  const uncleared=internalGolden({subject:s=>{s.clearances=[];}});
  assert.equal(B0(uncleared).pass,true);expectCodes(C4(uncleared),['ACCEPTANCE_BLOCKERS_PRESENT']);
  assert.equal(ALL(uncleared).status,STATUS.EXPORT_CANDIDATE,'the retryable blocker keeps the candidate');
  // the blocker alone (no candidate blockers) is also tolerated
  const only=internalGolden({contract:c=>{c.acceptance_blockers=[MULTI_PINE_BLOCKER];},subject:s=>{s.clearances=[];}});
  assert.equal(B0(only).pass,true);assert.equal(C4(only).pass,true);

  // M5 and M7: the G7 tolerance needs the completion reason that derives PASS and the multi-Pine version
  const failedChecks=internalGolden({result:r=>{r.completion_reason='CANDIDATE_FAILED_CHECKS';r.owner_recommendation_ready=true;}});
  assert.ok(B0(failedChecks).codes.includes('OWNER_RECOMMENDATION_NOT_READY'),'another completion reason refuses B0');
  assert.ok(B0(failedChecks).codes.includes('BI_RUN_NOT_QUALIFIABLE'));assert.equal(B0(failedChecks).pass,false);
  for(const reason of ['NO_VALID_TRAIN_VALIDATION_CANDIDATE',undefined,null,'',5]){
    const subject=internalGolden({result:r=>{if(reason===undefined)delete r.completion_reason;else r.completion_reason=reason;}});
    assert.ok(B0(subject).codes.includes('OWNER_RECOMMENDATION_NOT_READY'),'reason '+String(reason));
  }
  for(const version of ['ql3a-research-job-v1','ql3a-research-job-v2','ql3a-research-job-v3','ql3a-research-job-multi-v2',undefined,null,'']){
    const subject=internalGolden({contract:c=>{if(version===undefined)delete c.version;else c.version=version;}});
    const result=B0(subject);
    assert.equal(result.pass,false,'version '+String(version)+' on a created-internal multi-Pine package');
    assert.ok(result.codes.includes('BI_BINDING_MISMATCH'),'mode and version mismatch: BI_BINDING_MISMATCH');
    assert.ok(result.codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'),'U2: off the internal path: '+String(version));
    assert.ok(result.codes.includes('BI_CAPABILITY_BLOCKER_PRESENT'),'no blocker tolerance for the mismatch');
    if(version!=='ql3a-research-job-v3')assert.ok(result.codes.includes('OWNER_RECOMMENDATION_NOT_READY'),'no G7 tolerance for '+String(version));
    assert.ok(C4(subject).codes.includes('ACCEPTANCE_BLOCKERS_PRESENT'),'no C4 tolerance for '+String(version));
  }
  // a one-Pine run with the multi-Pine version and a created-internal package is a mismatch too
  const oneWithMulti=golden({contract:c=>{c.version=MULTI_PINE_CONTRACT_VERSION;c.acceptance_blockers=[...CANDIDATE_BLOCKERS,MULTI_PINE_BLOCKER];},subject:s=>{s.internal=true;}});
  const oneResult=B0(oneWithMulti);
  assert.equal(oneResult.pass,false);
  for(const code of ['BI_BINDING_MISMATCH','BI_CAPABILITY_BLOCKER_PRESENT','OWNER_RECOMMENDATION_NOT_READY'])assert.ok(oneResult.codes.includes(code),code);
  // the claimed mode of the packaged binding must be multi-Pine as well
  const claimedOne=internalGolden({binding:b=>{b.mode='ONE_PINE';b.pine_count=1;}});
  assert.ok(B0(claimedOne).codes.includes('BI_BINDING_MISMATCH'));assert.equal(B0(claimedOne).pass,false);
  assert.ok(B0(claimedOne).codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'),'U2: a claimed ONE_PINE multi-Pine run is off the internal path');
  assert.ok(B0(claimedOne).codes.includes('BI_CAPABILITY_BLOCKER_PRESENT'),'no tolerance for a mismatch');
  // the multi-Pine version without the internal flag derives G7 FAIL like any unlisted version
  assert.ok(B0(off).codes.includes('OWNER_RECOMMENDATION_NOT_READY'));
  // other B0 checks still apply on the internal path
  const holdoutMissing=internalGolden({result:r=>{r.holdout_evaluated=false;}});
  assert.ok(B0(holdoutMissing).codes.includes('HOLDOUT_NOT_EVALUATED')&&!B0(holdoutMissing).pass);
  assert.ok(B0(internalGolden({binding:b=>{b.fixture=false;}})).codes.includes('BI_EPISODE_GATE_UNAVAILABLE'));
  // the internal flag opens nothing for a package that is not multi-Pine and does not carry the version
  // U4: the internal flag on a run that is not multi-Pine with the multi-Pine version is a binding mismatch, never a pass
  const flaggedOne=B0(golden({subject:s=>{s.internal=true;}}));
  assert.equal(flaggedOne.pass,false);assert.ok(flaggedOne.codes.includes('BI_BINDING_MISMATCH'));
  assert.equal(B0(golden()).pass,true,'a one-Pine run without the flag builds');
  // U1: a malformed membership gives no mode and a binding mismatch
  const junk=golden({contract:c=>{c.snapshot.membership.push('junk');}});
  assert.ok(B0(junk).codes.includes('BI_BINDING_MISMATCH'));assert.equal(B0(junk).pass,false);
  const junkInternal=internalGolden({contract:c=>{c.snapshot.membership.push('junk');}});
  assert.equal(B0(junkInternal).pass,false);assert.ok(B0(junkInternal).codes.includes('BI_BINDING_MISMATCH'));
  // U1: an empty membership gives no mode, a binding mismatch and never the multi-Pine code
  const empty=B0(golden({contract:c=>{c.snapshot.membership=[];}}));
  assert.equal(empty.pass,false);assert.ok(empty.codes.includes('BI_BINDING_MISMATCH'));
  assert.ok(!empty.codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'));
  // U2: a multi-Pine run off the internal path always carries BI_MULTI_PINE_INTERNAL_ONLY
});

/* ---- 11.1 items 16 to 18 ---- */

test('a NO_VALID_CANDIDATE run creates no package and only a DIAGNOSTIC_ONLY bundle without a recommendation block (11.1 item 16)',()=>{
  const none=golden({result:r=>{r.selected=null;r.holdout_evaluated=false;r.completion_reason='NO_VALID_TRAIN_VALIDATION_CANDIDATE';
    r.candidates=[{parameters:parameters(0),result:{validation:metricsOf('0',0)},screen_reasons:['INSUFFICIENT_VALIDATION_TRADES']}];},subject:s=>{s.run.status='NO_VALID_CANDIDATE';}});
  const result=B0(none);
  assert.equal(result.pass,false);assert.equal(result.state,'FAIL');
  assert.equal(transition(null,{kind:'BUILD',b0_pass:result.pass}).to,null,'no package is built');
  assert.ok(result.codes.includes('BI_RUN_NOT_QUALIFIABLE')&&result.codes.includes('NO_SCREENED_CANDIDATE'));
  assert.equal(ALL(none).record,null);assert.equal(ALL(none).ready,false);
  const bundle=diagnosticBundle(none.run);
  assert.equal(bundle.label,'DIAGNOSTIC_ONLY');assert.equal(bundle.actionable,false);assert.equal(bundle.package,null);
  assert.equal(bundle.library_class,'NO_VALID_CANDIDATE');assert.equal(bundle.library_group,'COMPLETED');
  assert.deepEqual({...bundle.reason_counts},{INSUFFICIENT_VALIDATION_TRADES:1});
  for(const forbidden of ['inputs','recommendation','recommended','parameters','selected','indicator','best','winner','top'])assert.ok(!(forbidden in bundle),'no '+forbidden+' key');
  assert.ok(!JSON.stringify(bundle).includes('emaFastInput'),'no parameter name leaks');
  assert.equal(diagnosticBundle(null).label,'DIAGNOSTIC_ONLY');
  assert.equal(diagnosticBundle({run_id:'r',status:'FAILED',diagnostic:'VERIFIED_MARKET_DATA_REQUIRED'}).library_class,'INSUFFICIENT_DATA');
  assert.equal(diagnosticBundle(golden().run).actionable,false);
  assert.equal(Object.isFrozen(bundle),true);
});

test('G7 is derived from the completion reason and the contract version; no flag sets it (11.1 item 17)',()=>{
  const run=golden().run;
  assert.deepEqual({...ownerRecommendationGate(run)},{gate:'G7',state:'PASS',code:null});
  assert.equal(run.result.owner_recommendation_ready,false,'the supplied flag is false and is ignored');
  const flagged=clone(run);
  flagged.result.owner_recommendation_ready=true;
  assert.equal(ownerRecommendationGate(flagged).state,'PASS');
  for(const version of ['ql3a-research-job-v1','ql3a-research-job-v2','ql3a-research-job-v9',undefined,null,5,'']){
    const legacy=clone(run);
    legacy.contract.version=version;legacy.result.owner_recommendation_ready=true;legacy.owner_recommendation_ready=true;legacy.contract.owner_recommendation_ready=true;
    assert.equal(ownerRecommendationGate(legacy).state,'FAIL','flag true does not rescue version '+String(version));
    assert.equal(ownerRecommendationGate(legacy).code,'OWNER_RECOMMENDATION_NOT_READY');
  }
  for(const reason of ['CANDIDATE_FAILED_CHECKS','NO_VALID_TRAIN_VALIDATION_CANDIDATE',undefined,null,'',5]){
    const other=clone(run);
    other.result.completion_reason=reason;other.result.owner_recommendation_ready=true;
    assert.equal(ownerRecommendationGate(other).state,'FAIL','flag true does not rescue reason '+String(reason));
  }
  for(const source of [null,undefined,{},{result:{}},{contract:{}},{result:{completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'}},[],'x'])
    assert.equal(ownerRecommendationGate(source).state,'FAIL');
  for(const field of ['owner_recommendation_ready','g7','G7','override','force'])
    for(const target of ['subject','run','result','contract','binding']){
      const subject=golden({contract:c=>{c.version='ql3a-research-job-v1';}});
      const holder=target==='subject'?subject:target==='run'?subject.run:target==='result'?subject.run.result:target==='contract'?subject.run.contract:subject.binding;
      holder[field]=true;
      assert.ok(B0(subject).codes.includes('OWNER_RECOMMENDATION_NOT_READY'),field+' on '+target+' is ignored');
    }
  assert.ok(Object.isFrozen(ownerRecommendationGate(run)));
  assert.deepEqual([...OWNER_RECOMMENDATION_CONTRACT_VERSIONS].filter(version=>version==='ql3a-research-job-v1'||version==='ql3a-research-job-v2'),[]);
});

test('the episode gate is unavailable: a non-fixture package gives BI_EPISODE_GATE_UNAVAILABLE and never PASS (11.1 item 18)',()=>{
  assert.equal(EPISODE_GATE_VERSION,null);
  const real=golden({binding:b=>{b.fixture=false;},manifest:m=>{m.fixture=false;}});
  const b0=B0(real);
  expectCodes(b0,['BI_EPISODE_GATE_UNAVAILABLE']);
  assert.equal(b0.pass,false);
  assert.equal(transition(null,{kind:'BUILD',b0_pass:b0.pass}).to,null,'no export row for a non-fixture package');
  const noLabel=golden({binding:b=>{delete b.fixture;}});
  assert.ok(B0(noLabel).codes.includes('BI_EPISODE_GATE_UNAVAILABLE'),'an unknown fixture label is not a fixture');
});

/* ---- 6.1 stored status transitions ---- */

test('stored transitions: every listed transition and BI_TRANSITION_INVALID for every other (section 6.1)',()=>{
  const move=(from,event)=>{const result=transition(from,event);for(const code of result.codes)seen.add(code);return result;};
  const attempt=(pass,codes,mode='ONE_PINE',attemptNo=1)=>({kind:'ATTEMPT',pass,codes,mode,attempt_no:attemptNo});
  assert.deepEqual({...move(null,{kind:'BUILD',b0_pass:true})},{ok:true,to:'EXPORT_CANDIDATE',codes:[]});
  assert.deepEqual({...move(null,{kind:'BUILD',b0_pass:false})},{ok:true,to:null,codes:[]},'B0 fail leaves no export row');
  assert.equal(move('EXPORT_CANDIDATE',attempt(true,[])).to,'EXPORT_VALIDATED');
  assert.equal(move('EXPORT_CANDIDATE',attempt(true,[],'MULTI_PINE')).to,'EXPORT_INTERNAL');
  for(const code of RETRYABLE_CODES){
    const retry=move('EXPORT_CANDIDATE',attempt(false,[code]));
    assert.deepEqual({ok:retry.ok,to:retry.to,codes:[...retry.codes]},{ok:true,to:'EXPORT_CANDIDATE',codes:[code]},code);
  }
  assert.deepEqual([...RETRYABLE_CODES],['BI_COMPILE_EVIDENCE_MISSING','BI_COMPILE_WARNINGS_UNREVIEWED','BI_NATIVE_ALERT_ISOLATION_UNPROVEN','BI_DATASET_ALIGNMENT_MISSING',
    'BI_PARITY_EVIDENCE_MISSING','BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']);
  assert.equal(move('EXPORT_CANDIDATE',attempt(false,['BI_NATIVE_SIGNAL_PARITY_FAILED'])).to,'EXPORT_REFUSED');
  assert.deepEqual([...move('EXPORT_CANDIDATE',attempt(false,['BI_NATIVE_SIGNAL_PARITY_FAILED'])).codes],['BI_NATIVE_SIGNAL_PARITY_FAILED']);
  assert.equal(move('EXPORT_CANDIDATE',attempt(false,['BI_COMPILE_EVIDENCE_MISSING','BI_REPAINT_FLAGS_CHANGED'])).to,'EXPORT_REFUSED','one non-retryable code refuses');
  for(const attemptNo of [1,2,3,4])assert.equal(move('EXPORT_CANDIDATE',attempt(false,['BI_REPAINT_EVIDENCE_MISSING'],'ONE_PINE',attemptNo)).to,'EXPORT_CANDIDATE');
  const exhausted=move('EXPORT_CANDIDATE',attempt(false,['BI_REPAINT_EVIDENCE_MISSING'],'ONE_PINE',5));
  assert.deepEqual({ok:exhausted.ok,to:exhausted.to,codes:[...exhausted.codes]},{ok:true,to:'EXPORT_REFUSED',codes:['BI_ATTEMPTS_EXHAUSTED']});
  assert.equal(move('EXPORT_CANDIDATE',attempt(true,[],'ONE_PINE',5)).to,'EXPORT_VALIDATED','a passing fifth attempt still validates');
  assert.equal(MAX_VALIDATION_ATTEMPTS,5);
  const invalid=result=>{assert.deepEqual({ok:result.ok,to:result.to,codes:[...result.codes]},{ok:false,to:null,codes:['BI_TRANSITION_INVALID']});};
  invalid(move('EXPORT_CANDIDATE',attempt(false,['BI_REPAINT_EVIDENCE_MISSING'],'ONE_PINE',6)));
  invalid(move('EXPORT_CANDIDATE',attempt(true,[],'ONE_PINE',6)));
  for(const terminal of ['EXPORT_VALIDATED','EXPORT_INTERNAL','EXPORT_REFUSED','NO_VALID_CANDIDATE']){
    invalid(move(terminal,attempt(true,[])));invalid(move(terminal,attempt(false,['BI_REPAINT_EVIDENCE_MISSING'])));invalid(move(terminal,{kind:'BUILD',b0_pass:true}));
  }
  invalid(move(null,attempt(true,[])));invalid(move('EXPORT_CANDIDATE',{kind:'BUILD',b0_pass:true}));
  invalid(move('EXPORT_CANDIDATE',{kind:'ARCHIVE'}));invalid(move('EXPORT_CANDIDATE',{kind:'APPLY'}));
  invalid(move(undefined,{kind:'BUILD',b0_pass:true}));invalid(move('NEW_STATUS',attempt(true,[])));
  invalid(move(null,{kind:'BUILD'}));invalid(move(null,{kind:'BUILD',b0_pass:'yes'}));invalid(move('EXPORT_CANDIDATE',null));invalid(move('EXPORT_CANDIDATE','ATTEMPT'));
  invalid(move('EXPORT_CANDIDATE',attempt(true,['BI_REPAINT_EVIDENCE_MISSING'])));
  invalid(move('EXPORT_CANDIDATE',attempt(false,[])));
  invalid(move('EXPORT_CANDIDATE',attempt(false,['not a code'])));
  invalid(move('EXPORT_CANDIDATE',attempt(false,'BI_X')));
  invalid(move('EXPORT_CANDIDATE',attempt('no',[])));
  invalid(move('EXPORT_CANDIDATE',attempt(true,[],'TRIPLE_PINE')));
  for(const bad of [0,-1,1.5,'1',null,undefined,NaN])invalid(move('EXPORT_CANDIDATE',{kind:'ATTEMPT',pass:true,codes:[],mode:'ONE_PINE',attempt_no:bad}));
  assert.deepEqual([...MODES],['ONE_PINE','MULTI_PINE']);
  assert.deepEqual(Object.keys(STATUS),['NO_VALID_CANDIDATE','EXPORT_CANDIDATE','EXPORT_INTERNAL','EXPORT_VALIDATED','EXPORT_REFUSED']);
  assert.ok(Object.isFrozen(move(null,{kind:'BUILD',b0_pass:true})));
});

test('five failing attempts through the gates end in EXPORT_REFUSED with BI_ATTEMPTS_EXHAUSTED (OD-7)',()=>{
  let status=STATUS.EXPORT_CANDIDATE;
  for(let attemptNo=1;attemptNo<=5;attemptNo++){
    const subject=golden({subject:s=>{s.compile=null;s.attempt_no=attemptNo;}});
    const result=ALL(subject);
    if(attemptNo<5){assert.equal(result.status,STATUS.EXPORT_CANDIDATE,'attempt '+attemptNo);assert.equal(result.record,null,'a failing attempt has no record');}
    else{assert.equal(result.status,STATUS.EXPORT_REFUSED);assert.deepEqual([...result.next.codes],['BI_ATTEMPTS_EXHAUSTED']);}
    status=result.status;
  }
  assert.equal(status,STATUS.EXPORT_REFUSED);
  // S1: attempt_no must be a safe integer from 1 to 5. Anything else refuses the call: no gates, no status, no transition and no
  // record, whether the gates would pass or fail. A pass with a bad number must never hand out a ql4c_validation record.
  for(const bad of [undefined,null,0,6,7,-1,1.5,'1','5',NaN,Infinity,2**53,[],{},true]){
    for(const failing of [false,true]){
      const subject=golden({subject:s=>{if(failing)s.compile=null;if(bad===undefined)delete s.attempt_no;else s.attempt_no=bad;}});
      const result=ALL(subject);
      assert.equal(result.refused,INPUT_INVALID,String(bad));assert.deepEqual([...result.fields],['attempt_no']);
      assert.equal(result.pass,false);assert.deepEqual([...result.gates],[]);assert.deepEqual([...result.codes],[]);
      assert.equal(result.status,null);assert.equal(result.next,null);assert.equal(result.record,null,'no record for a refused transition: '+String(bad));assert.equal(result.ready,false);
    }
  }
  const good=ALL(golden());
  assert.equal(good.pass,true);assert.equal(good.next.ok,true);assert.notEqual(good.record,null,'a passing attempt with a valid number carries the record');
  assert.equal(ALL(golden({subject:s=>{s.attempt_no=5;}})).status,STATUS.EXPORT_VALIDATED,'the fifth attempt may still validate');
});

/* ---- 6.2 / 6.3 freshness and READY ---- */

test('freshness is derived and each field of F changes it; REPLAY_MISMATCH forces STALE (section 6.2)',()=>{
  const subject=golden(),binding=subject.binding,current=subject.current;
  const view=(change,replay=false)=>{const next=clone(current);change?.(next);const result=freshness({binding,current:next,replay_mismatch:replay});for(const code of result.codes)seen.add(code);return result;};
  assert.deepEqual({...view()},{fresh:true,state:'FRESH',code:null,codes:[]});
  assert.deepEqual([...FRESHNESS_ORDER],['BI_SOURCE_VERSION_STALE','BI_MEMBERSHIP_CHANGED','BI_POLICY_SNAPSHOT_MISMATCH','BI_DEPLOYMENT_CHANGED','BI_SELECTION_CHANGED','BI_DATASET_UNAVAILABLE']);
  const stale=[[c=>{c.membership[0].source_version=2;},'BI_SOURCE_VERSION_STALE'],[c=>{c.membership[0].source_hash=hex('new');},'BI_SOURCE_VERSION_STALE'],
    [c=>{c.membership.push({pine_import_id:'import-2',source_version:1,source_hash:hex('s')});},'BI_MEMBERSHIP_CHANGED'],
    [c=>{c.policy_version='policy-v2';},'BI_POLICY_SNAPSHOT_MISMATCH'],[c=>{c.policy_hash=hex('p');},'BI_POLICY_SNAPSHOT_MISMATCH'],
    [c=>{c.deployment_id='deploy-2';},'BI_DEPLOYMENT_CHANGED'],[c=>{c.input_lock_hash=hex('l');},'BI_SELECTION_CHANGED'],[c=>{c.dataset_available=false;},'BI_DATASET_UNAVAILABLE']];
  for(const [change,code] of stale){const result=view(change);assert.equal(result.fresh,false);assert.equal(result.state,'STALE');assert.equal(result.code,code);assert.deepEqual([...result.codes],[code]);}
  const several=view(c=>{c.deployment_id='x';c.membership[0].source_version=7;c.dataset_available=false;});
  assert.deepEqual([...several.codes],['BI_SOURCE_VERSION_STALE','BI_DEPLOYMENT_CHANGED','BI_DATASET_UNAVAILABLE']);
  assert.equal(several.code,'BI_SOURCE_VERSION_STALE','the first differing code in the C4 order');
  assert.equal(view(c=>{c.bot_owner_id='someone-else';}).fresh,true,'Bot ownership is not part of F');
  const reverted=view(c=>{c.deployment_id='deploy-2';});
  assert.equal(reverted.fresh,false);
  assert.equal(view().fresh,true,'a reverted change shows fresh again');
  const replay=view(null,true);
  assert.deepEqual({fresh:replay.fresh,state:replay.state,code:replay.code,codes:[...replay.codes]},{fresh:false,state:'STALE',code:'REPLAY_MISMATCH',codes:['REPLAY_MISMATCH']});
  assert.equal(view(c=>{c.deployment_id='deploy-2';c.deployment_id='deploy-1';},true).code,'REPLAY_MISMATCH','reverting freshness changes does not clear a replay mismatch');
  // RC-8 (R1 to R7): an unreadable or non-boolean replay state refuses the read with BI_REPLAY_STATE_UNAVAILABLE. It is no fresh, no
  // STALE, no READY true, never labelled REPLAY_MISMATCH, never treated as false and never a C4 freshness code.
  assert.equal(REPLAY_STATE_UNAVAILABLE,'BI_REPLAY_STATE_UNAVAILABLE');assert.match(REPLAY_STATE_UNAVAILABLE,CODE_PATTERN);
  assert.ok(!FRESHNESS_ORDER.includes(REPLAY_STATE_UNAVAILABLE)&&!RETRYABLE_CODES.includes(REPLAY_STATE_UNAVAILABLE));
  for(const unknown of [undefined,null,'false',0,'true',1,{},[],NaN,'',-1,()=>true]){
    const refused=freshness({binding,current,replay_mismatch:unknown});
    assert.equal(refused.fresh,false,'unknown replay state '+String(unknown));
    assert.equal(isRefused(refused),true);assert.equal(refused.refused,REPLAY_STATE_UNAVAILABLE);assert.deepEqual([...refused.fields],['replay_mismatch']);
    assert.ok(!refused.codes.includes('REPLAY_MISMATCH'));assert.equal(refused.code,null);assert.equal(refused.state,null);assert.deepEqual([...refused.codes],[]);
    const read=readState({status:'EXPORT_VALIDATED',binding:{...binding,fixture:false},current,replay_mismatch:unknown,requester_owner_id:OWNER});
    assert.equal(read.ready,false);assert.equal(read.refused,REPLAY_STATE_UNAVAILABLE);assert.equal(read.fresh,false);assert.equal(read.state,null);assert.ok(!read.codes.includes('REPLAY_MISMATCH'));
    assert.deepEqual([...read.fields],['replay_mismatch']);assert.equal(read.status,'EXPORT_VALIDATED','the stored status is carried and unchanged');
  }
  // the read needs the replay state even when nothing else is given; the input object itself may be absent
  assert.equal(freshness().refused,REPLAY_STATE_UNAVAILABLE);assert.equal(freshness(null).refused,REPLAY_STATE_UNAVAILABLE);assert.equal(readState().refused,REPLAY_STATE_UNAVAILABLE);
  // R4: C4 never emits the refusal code, whatever the freshness state
  for(const change of [null,c=>{c.deployment_id='x';},c=>{c.membership=[];}]){
    const c4=golden({subject:s=>{if(change===null)s.current=null;else change(s.current);}});
    assert.ok(!C4(c4).codes.includes(REPLAY_STATE_UNAVAILABLE));
  }
  assert.ok(!C4(golden()).codes.includes(REPLAY_STATE_UNAVAILABLE));
  // R5: replay state true forces STALE with REPLAY_MISMATCH first and every differing F code after it in the C4 order; R6: false judges F only
  const every=freshness({binding,current:null,replay_mismatch:true});
  assert.deepEqual([...every.codes],['REPLAY_MISMATCH',...FRESHNESS_ORDER]);assert.equal(every.fresh,false);assert.equal(every.state,'STALE');assert.equal(every.code,'REPLAY_MISMATCH');
  assert.deepEqual([...freshness({binding,current:null,replay_mismatch:false}).codes],[...FRESHNESS_ORDER]);
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:{...binding,fixture:false},current:null,replay_mismatch:true,requester_owner_id:OWNER}).ready,false);
  assert.deepEqual([...freshness({binding:null,current:null,replay_mismatch:false}).codes],[...FRESHNESS_ORDER]);
  assert.equal(freshness().fresh,false);
  assert.ok(Object.isFrozen(view()));
  const noMembers=freshnessCodes({...binding,membership:[]},current);
  assert.ok(noMembers.includes('BI_MEMBERSHIP_CHANGED')&&noMembers.includes('BI_SOURCE_VERSION_STALE'));
  const wrongPrimary=freshnessCodes({...binding,source_version:2},current);
  assert.deepEqual(wrongPrimary,['BI_SOURCE_VERSION_STALE']);
});

test('READY = EXPORT_VALIDATED and fresh and ONE_PINE and not fixture and owned (section 6.3)',()=>{
  const all={status:'EXPORT_VALIDATED',fresh:true,mode:'ONE_PINE',fixture:false,owns_bot:true};
  assert.equal(isReady(all),true);
  for(const [key,value] of [['status','EXPORT_CANDIDATE'],['status','EXPORT_INTERNAL'],['status','EXPORT_REFUSED'],['status','NO_VALID_CANDIDATE'],['status',undefined],['fresh',false],['fresh','true'],['fresh',undefined],
    ['mode','MULTI_PINE'],['mode',undefined],['fixture',true],['fixture',undefined],['fixture','false'],['owns_bot',false],['owns_bot',undefined],['owns_bot',1]])
    assert.equal(isReady({...all,[key]:value}),false,key+'='+String(value));
  assert.equal(isReady(),false);assert.equal(isReady({}),false);
  const realBinding={...golden().binding,fixture:false};
  const current=golden().current;
  const ready=readState({status:'EXPORT_VALIDATED',binding:realBinding,current,replay_mismatch:false,requester_owner_id:OWNER});
  assert.equal(ready.ready,true);assert.equal(ready.fresh,true);assert.equal(ready.state,'FRESH');assert.equal(ready.status,'EXPORT_VALIDATED');
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:realBinding,current,replay_mismatch:false,requester_owner_id:'owner-b'}).ready,false,'another owner');
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:realBinding,current,replay_mismatch:false}).ready,false,'no requester');
  // R18: neither a requester nor a Bot owner (undefined === undefined) can never read as owned.
  const ownerless={...current};
  delete ownerless.bot_owner_id;
  for(const requester of [undefined,null,'']){
    for(const botOwner of [undefined,null,'']){
      const view=readState({status:'EXPORT_VALIDATED',binding:realBinding,current:{...ownerless,...(botOwner===undefined?{}:{bot_owner_id:botOwner})},replay_mismatch:false,requester_owner_id:requester});
      assert.equal(view.ready,false,'requester '+JSON.stringify(requester)+' and Bot owner '+JSON.stringify(botOwner));
      assert.equal(view.fresh,true,'ownership is not part of F');
    }
  }
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:realBinding,current:ownerless,replay_mismatch:false,requester_owner_id:OWNER}).ready,false,'a Bot with no owner on record');
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:realBinding,current:null,replay_mismatch:false}).ready,false);
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:realBinding,current:{...current,bot_owner_id:'owner-b'},replay_mismatch:false,requester_owner_id:OWNER}).ready,false,'Bot owned by someone else');
  const stale=readState({status:'EXPORT_VALIDATED',binding:realBinding,current:{...current,deployment_id:'deploy-9'},replay_mismatch:false,requester_owner_id:OWNER});
  assert.deepEqual({ready:stale.ready,state:stale.state,code:stale.code},{ready:false,state:'STALE',code:'BI_DEPLOYMENT_CHANGED'});
  const replay=readState({status:'EXPORT_VALIDATED',binding:realBinding,current,replay_mismatch:true,requester_owner_id:OWNER});
  assert.deepEqual({ready:replay.ready,state:replay.state,code:replay.code},{ready:false,state:'STALE',code:'REPLAY_MISMATCH'});
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:{...realBinding,fixture:true},current,replay_mismatch:false,requester_owner_id:OWNER}).ready,false,'fixture');
  assert.equal(readState({status:'EXPORT_VALIDATED',binding:{...realBinding,mode:'MULTI_PINE'},current,replay_mismatch:false,requester_owner_id:OWNER}).ready,false,'multi-Pine');
  assert.equal(readState({status:'EXPORT_CANDIDATE',binding:realBinding,current,replay_mismatch:false,requester_owner_id:OWNER}).ready,false,'candidate');
  assert.equal(readState().ready,false);
  assert.ok(Object.isFrozen(ready));
});

/* ---- 5.5 library G8 ---- */

test('library G8 passes only with a PASS record of a non-fixture one-Pine package (section 5.5)',()=>{
  const record=(extra={})=>({export_id:EXPORT_ID,package_hash:hex('package'),binding_hash:hex('binding'),attempt_id:'a1',fixture:false,validated_at_utc:NOW,validator_engine_hash:hex('v'),
    gate_results:['B0','C1','C2','C3','C4'].map(gate=>({gate,state:'PASS',codes:[]})),...extra});
  const item=(extra={},recordExtra={})=>({run_id:RUN_ID,mode:'ONE_PINE',record:record(recordExtra),...extra});
  assert.deepEqual({...libraryG8([item()],RUN_ID)},{gate:'G8',state:'PASS',code:null});
  assert.deepEqual({...qualifiedFromRecords([item(),item({run_id:'run-2'}),item({run_id:'run-3',mode:'MULTI_PINE'})])},{total:2,winner:null,runs:['run-2',RUN_ID]});
  for(const [label,value] of [['fixture',item({},{fixture:true})],['multi-Pine',item({mode:'MULTI_PINE'})],['another run',item({run_id:'run-9'})],['no mode',item({mode:undefined})],
    ['failed gate',item({},{gate_results:record().gate_results.map(g=>g.gate==='C3'?{...g,state:'FAIL'}:g)})],['missing gate',item({},{gate_results:record().gate_results.filter(g=>g.gate!=='C2')})],
    ['no export id',item({},{export_id:''})],['bad package hash',item({},{package_hash:'x'})],['no record',item({record:null})],['fixture unknown',item({},{fixture:undefined})]]){
    const result=libraryG8([value],RUN_ID);
    assert.deepEqual({...result},{gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'},label);
    seen.add(result.code);
    assert.equal(qualifiedFromRecords([value]).total,label==='another run'?1:0,label+': a valid record counts for its own run only');
  }
  assert.equal(libraryG8([item()],'').state,'FAIL');assert.equal(libraryG8(null,RUN_ID).state,'FAIL');
  assert.equal(qualifiedFromRecords([item()]).winner,null);
  assert.deepEqual({...qualifiedFromRecords([])},{total:0,winner:null,runs:[]});
});

/* ---- 11.1 item 15, coverage and constants ---- */

test('every contract code is reachable and every emitted code matches ^[A-Z][A-Z0-9_]{1,63}$ (11.1 item 15)',()=>{
  const contractCodes=['NOT_FOUND','STATUS_NOT_COMPLETED','NO_RESULT','INTEGRITY_CHECK_FAILED','BI_RUN_NOT_QUALIFIABLE','NO_SCREENED_CANDIDATE','SENSITIVITY_FAILED','COST_STRESS_FAILED',
    'HOLDOUT_NOT_EVALUATED','INSUFFICIENT_TEST_TRADES','NEGATIVE_HOLDOUT_RETURN','TEST_DRAWDOWN_EXCEEDED','HOLDOUT_INDEPENDENCE_NOT_CHECKED','HOLDOUT_WINDOW_REUSED',
    'BI_HOLDOUT_OVERLAPS_SEARCHED_DATA','BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY','BI_SEARCH_RECORD_MISSING','BI_DIMENSION_COVERAGE','BI_CAPABILITY_BLOCKER_PRESENT','BLOCKERS_UNKNOWN',
    'BI_BINDING_INCOMPLETE','BI_MULTI_PINE_INTERNAL_ONLY','OWNER_RECOMMENDATION_NOT_READY','BI_EPISODE_GATE_UNAVAILABLE',
    'BI_HOLDOUT_EXPOSED_BY_SELECTION','BI_EXPOSURE_REGISTER_UNAVAILABLE',
    'BI_ARTIFACT_MISSING','BI_ARTIFACT_UNEXPECTED','BI_MANIFEST_SCHEMA_INVALID','BI_CHECKSUM_MISMATCH','BI_SECRET_DETECTED','BI_MACHINE_PATH_DETECTED','BI_NUMERIC_FORMAT_INVALID',
    'BI_METRIC_FABRICATED','BI_ALERT_SOURCE_INVALID','INDICATOR_REQUIRED','BI_MARKET_SCOPE_INVALID',
    'BI_COMPILE_EVIDENCE_MISSING','BI_COMPILE_SOURCE_MISMATCH','BI_COMPILE_ERRORS','BI_SLOT_BINDING_MISMATCH','BI_COMPILE_WARNINGS_UNREVIEWED','BI_SOURCE_HASH_MISMATCH',
    'BI_SOURCE_LOGIC_CHANGED','BI_NATIVE_ALERT_ISOLATION_UNPROVEN',
    'BI_PROVENANCE_UNRESOLVED','BI_BINDING_MISMATCH','BI_INPUTS_MISMATCH','BI_SLOT_LIMIT','BI_INPUT_OUT_OF_DOMAIN','BI_FIXED_INPUT_CHANGED','BI_POLICY_SNAPSHOT_MISMATCH',
    'BI_RISK_RELAXATION','BI_RESULT_MISMATCH','HOLDOUT_MISMATCH','BI_DATASET_UNAVAILABLE','BI_DATASET_HASH_MISMATCH','BI_ENGINE_HASH_MISMATCH','BI_COST_MODEL_UNSUPPORTED',
    'BI_EXIT_VERSION_UNSUPPORTED','BI_FIXTURE_LABEL_MISSING',
    'BI_DATASET_ALIGNMENT_MISSING','BI_DATASET_ALIGNMENT_FAILED','BI_PARITY_SAMPLE_FLOOR_NOT_MET','BI_PARITY_EVIDENCE_MISSING','BI_NATIVE_SIGNAL_PARITY_FAILED','BI_BRIDGE_PARITY_FAILED',
    'BI_REPAINT_EVIDENCE_MISSING','BI_REPAINT_FLAGS_CHANGED','BI_QUANT_BASELINE_FAILED','BI_PARITY_SCOPE_MISMATCH','BI_SOURCE_VERSION_STALE','BI_MEMBERSHIP_CHANGED',
    'BI_DEPLOYMENT_CHANGED','BI_SELECTION_CHANGED','BI_BRIDGE_PAIR_OUT_OF_BOUNDS','ACCEPTANCE_BLOCKERS_PRESENT',
    'BI_TRANSITION_INVALID','BI_ATTEMPTS_EXHAUSTED','REPLAY_MISMATCH','QL4C_VALIDATION_NOT_AVAILABLE'];
  for(const code of contractCodes)assert.ok(seen.has(code),code+' was never produced by a test');
  for(const code of seen)assert.match(code,CODE_PATTERN,code);
  for(const code of [...contractCodes,...RETRYABLE_CODES,...FRESHNESS_ORDER])assert.match(code,CODE_PATTERN,code);
  assert.ok(seen.size>=contractCodes.length);
  assert.ok(RETRYABLE_CODES.every(code=>contractCodes.includes(code)));
  assert.ok(RETRYABLE_CODES.every(code=>Object.isFrozen(RETRYABLE_CODES)&&isRetryable(code)));
  assert.equal(isRetryable('BI_NATIVE_SIGNAL_PARITY_FAILED'),false);assert.equal(isRetryable(undefined),false);
});

test('the gate module reads no clock, no file, no network and no database',()=>{
  const source=fs.readFileSync(new URL('../src/quant-library/package-gates.js',import.meta.url),'utf8');
  for(const forbidden of ['Date.now','new Date(','process.','node:fs','node:net','node:http','fetch(','import(','require(','Math.random','randomUUID','setTimeout','setInterval'])
    assert.ok(!source.includes(forbidden),'no '+forbidden);
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match=>match[1]),['../pine-bridge/source.js','../pine-bridge/template.js','./derive.js']);
  assert.ok(!/\bimport\s*\(/.test(source)&&!/\bexport\s+\*\s+from/.test(source));
});

/* ---- OD-19: the exposure register (R1, R20) ---- */

test('exposure register: same owner and market overlap refuses; other owner, other market, a later entry and an empty register pass (OD-19, 11.1 item 19)',()=>{
  const own=holdoutWindow(golden().run.contract);
  const entry=(extra={})=>({owner_id:OWNER,market:{...MARKET_OBJECT},source_hash:hex('source'),window:{...own},comparison_id:'cmp-1',at_utc:'2026-10-19T11:00:00Z',...extra});
  const qr4=(extra={})=>{const {source_hash:_s,comparison_id:_c,...rest}=entry();return {...rest,selection_id:'sel-1',...extra};};
  const register=entries=>golden({subject:s=>{s.holdout.exposure_register=entries;}});
  const EXPOSED=['BI_HOLDOUT_EXPOSED_BY_SELECTION'];
  // same owner and same market
  expectCodes(B0(register([entry()])),EXPOSED,'QR-3 event');
  expectCodes(B0(register([qr4()])),EXPOSED,'QR-4 record');
  expectCodes(B0(register([entry({window:{start_time:own.end_time,end_time:own.end_time+MINUTE}})])),EXPOSED,'sharing one bar is an overlap');
  expectCodes(B0(register([entry({window:{start_time:own.start_time-5*MINUTE,end_time:own.start_time}})])),EXPOSED,'overlap at the first holdout bar');
  expectCodes(B0(register([entry({window:{start_time:own.start_time+MINUTE,end_time:own.end_time-MINUTE}})])),EXPOSED,'a window inside the holdout');
  expectCodes(B0(register([entry({window:{start_time:own.start_time-9*MINUTE,end_time:own.end_time+9*MINUTE}})])),EXPOSED,'a window around the holdout');
  expectCodes(B0(register([entry(),qr4(),entry({comparison_id:'cmp-2'})])),EXPOSED,'several entries give one code');
  // disjoint windows never refuse
  assert.equal(B0(register([entry({window:{start_time:own.end_time+MINUTE,end_time:own.end_time+2*MINUTE}})])).pass,true,'a later disjoint window');
  assert.equal(B0(register([entry({window:{start_time:own.start_time-2*MINUTE,end_time:own.start_time-MINUTE}})])).pass,true,'an earlier disjoint window');
  // another owner and another market
  assert.equal(B0(register([entry({owner_id:'owner-b'})])).pass,true,'another owner');
  assert.equal(B0(register([qr4({owner_id:'owner-b'})])).pass,true,'another owner, QR-4');
  for(const field of ['broker','symbol','timeframe'])
    assert.equal(B0(register([entry({market:{...MARKET_OBJECT,[field]:'other'}})])).pass,true,'another market '+field);
  assert.equal(B0(register([entry({market:{...MARKET_OBJECT,symbol:'ETHUSDT'}}),qr4({owner_id:'owner-b'})])).pass,true);
  // the entry counts only when at_utc is at or before the run's durable creation time
  expectCodes(B0(register([entry({at_utc:CREATED})])),EXPOSED,'equal time counts');
  expectCodes(B0(register([entry({at_utc:'2026-10-19T11:29:59Z'})])),EXPOSED,'one second before counts');
  expectCodes(B0(register([entry({at_utc:'2026-10-19T11:29:59.999Z'})])),EXPOSED,'a millisecond before counts');
  assert.equal(B0(register([entry({at_utc:'2026-10-19T11:30:01Z'})])).pass,true,'one second after does not count');
  assert.equal(B0(register([entry({at_utc:'2026-10-19T11:30:00.001Z'})])).pass,true,'a millisecond after does not count');
  assert.equal(B0(register([qr4({at_utc:'2026-10-20T00:00:00Z'})])).pass,true,'a later QR-4 record does not count');
  // an empty register passes
  assert.equal(B0(register([])).pass,true);
  expectCodes(B0(register([])),[],'an empty register is valid');
  // the entry is filtered by this module: a mixed register reports once and only for the matching entry
  expectCodes(B0(register([entry({owner_id:'owner-b'}),entry({market:{...MARKET_OBJECT,symbol:'ETHUSDT'}}),entry({at_utc:'2026-10-20T00:00:00Z'}),entry()])),EXPOSED);
  // S9: at_utc accepts at most three fraction digits; more is malformed
  for(const value of ['2026-10-19T11:00:00.0001Z','2026-10-19T11:00:00.123456Z','2026-10-19T11:30:00.0000001Z','2026-10-19T11:00:00.123456789Z'])
    expectCodes(B0(register([entry({at_utc:value})])),['BI_EXPOSURE_REGISTER_UNAVAILABLE'],value);
  for(const value of ['2026-10-19T11:00:00.1Z','2026-10-19T11:00:00.12Z','2026-10-19T11:00:00.123Z'])expectCodes(B0(register([entry({at_utc:value})])),EXPOSED,'one to three fraction digits: '+value);
  assert.equal(B0(register([entry({owner_id:'owner-b',at_utc:'2026-10-19T11:00:00.123Z'})])).pass,true,'three fraction digits are accepted');
  // the other independence lookups are unchanged and report next to the exposure code
  expectCodes(B0(golden({subject:s=>{s.holdout.exposure_register=[entry()];s.holdout.earlier_holdouts=[{...own}];}})),['HOLDOUT_WINDOW_REUSED','BI_HOLDOUT_EXPOSED_BY_SELECTION']);
  // neither code is retryable, and a refusal on either is a hard failure
  assert.equal(isRetryable('BI_HOLDOUT_EXPOSED_BY_SELECTION'),false);assert.equal(isRetryable('BI_EXPOSURE_REGISTER_UNAVAILABLE'),false);
  assert.equal(isHardFailure(B0(register([entry()]))),true);
  // the attempt never re-reads the register (B0 is a build-time gate)
  assert.equal(ALL(register([entry()])).status,STATUS.EXPORT_VALIDATED);
});

test('exposure register: an absent, non-array or malformed register gives BI_EXPOSURE_REGISTER_UNAVAILABLE on its own',()=>{
  const own=holdoutWindow(golden().run.contract);
  const entry=(extra={})=>({owner_id:OWNER,market:{...MARKET_OBJECT},source_hash:hex('source'),window:{...own},comparison_id:'cmp-1',at_utc:'2026-10-19T11:00:00Z',...extra});
  const benign=(extra={})=>entry({owner_id:'owner-b',...extra});
  const register=value=>golden({subject:s=>{if(value===undefined)delete s.holdout.exposure_register;else s.holdout.exposure_register=value;}});
  const UNAVAILABLE=['BI_EXPOSURE_REGISTER_UNAVAILABLE'];
  for(const value of [undefined,null,'[]','x',5,true,{},{entries:[]}])expectCodes(B0(register(value)),UNAVAILABLE,'register '+JSON.stringify(value));
  const omit=(object,key)=>{const copy={...object};delete copy[key];return copy;};
  const malformed=[
    ['null entry',null],['entry not an object',5],['array entry',[]],['empty entry',{}],
    ['no owner',omit(benign(),'owner_id')],['empty owner',benign({owner_id:''})],['numeric owner',benign({owner_id:7})],
    ['no market',omit(benign(),'market')],['market as a string',benign({market:'binance-global:BTCUSDT:1'})],['market without a symbol',benign({market:{broker:'binance-global',timeframe:'1'}})],
    ['market with an empty field',benign({market:{...MARKET_OBJECT,timeframe:''}})],
    ['no window',omit(benign(),'window')],['window not an object',benign({window:5})],['window without an end',benign({window:{start_time:1}})],
    ['window reversed',benign({window:{start_time:5,end_time:1}})],['window with a fraction',benign({window:{start_time:1.5,end_time:3}})],['window with a string time',benign({window:{start_time:'1',end_time:3}})],
    ['no time',omit(benign(),'at_utc')],['time not UTC',benign({at_utc:'2026-10-19 11:00:00'})],['time with an offset',benign({at_utc:'2026-10-19T11:00:00+07:00'})],['time not a date',benign({at_utc:'2026-13-45T99:00:00Z'})],
    ['neither a comparison nor a selection id',omit(benign(),'comparison_id')],['both ids',benign({selection_id:'sel-1'})],
    ['empty comparison id',benign({comparison_id:''})],['QR-3 event without a source hash',omit(benign(),'source_hash')],['QR-3 event with a short source hash',benign({source_hash:'abc'})],
    ['empty selection id',{...omit(omit(benign(),'comparison_id'),'source_hash'),selection_id:''}]];
  for(const [label,bad] of malformed){
    expectCodes(B0(register([benign(),bad])),UNAVAILABLE,'one malformed entry: '+label);
    expectCodes(B0(register([bad])),UNAVAILABLE,'only a malformed entry: '+label);
  }
  // a malformed entry is reported even when an entry of the same register matches, and still not folded into the other code
  expectCodes(B0(register([entry(),omit(benign(),'at_utc')])),UNAVAILABLE);
  expectCodes(B0(register([omit(benign(),'at_utc'),entry()])),UNAVAILABLE);
  // run creation time: absent or unreadable
  for(const created of [undefined,null,'','2026-10-19 11:30:00','2026-10-19T11:30:00+07:00',1760873400000,{},'2026-10-19T11:30:00.0001Z','2026-10-19T11:29:59.999999999Z']){
    const subject=golden({subject:s=>{if(created===undefined)delete s.run.created_at_utc;else s.run.created_at_utc=created;}});
    expectCodes(B0(subject),UNAVAILABLE,'run.created_at_utc '+JSON.stringify(created));
  }
  // reported on its own: not folded into HOLDOUT_INDEPENDENCE_NOT_CHECKED, and the other lookups still report
  assert.ok(!B0(register(undefined)).codes.includes('HOLDOUT_INDEPENDENCE_NOT_CHECKED'));
  expectCodes(B0(golden({subject:s=>{delete s.holdout.exposure_register;s.holdout.earlier_holdouts=[{...own}];}})),['HOLDOUT_WINDOW_REUSED','BI_EXPOSURE_REGISTER_UNAVAILABLE']);
  expectCodes(B0(golden({subject:s=>{s.holdout.earlier_searched=null;}})),['HOLDOUT_INDEPENDENCE_NOT_CHECKED'],'a valid register is not reported when another lookup is missing');
  // the result is a hard failure and not retryable
  assert.equal(isHardFailure(B0(register(undefined))),true);
  assert.equal(transition(null,{kind:'BUILD',b0_pass:B0(register(undefined)).pass}).to,null);
});

/* ---- decisions the contract leaves open: root rulings of 2026-10-19, each pinned by a real assertion ---- */

test('R13: MULTI_PINE without the internal path has its own code and never reuses the research admission code',()=>{
  const subject=golden({contract:c=>{c.snapshot.membership.push({...SECOND});}});
  const result=B0(subject);
  expectCodes(result,['BI_MULTI_PINE_INTERNAL_ONLY']);
  assert.ok(!result.codes.includes('MULTI_PINE_RESEARCH_NOT_SUPPORTED'));
  const internal=internalGolden();
  assert.equal(B0(internal).codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'),false);
  assert.equal(B0(internal).pass,true,'the internal path builds');
  assert.equal(B0({...internal,internal:'true'}).codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'),true,'only an explicit true opens the internal path');
});

test('R17 todo 2: the G7 version is a placeholder and no research-contract builder emits it yet',()=>{
  assert.deepEqual([...OWNER_RECOMMENDATION_CONTRACT_VERSIONS],['ql3a-research-job-v3']);
  const directory=new URL('../src/quant-research/',import.meta.url);
  const sources=fs.readdirSync(directory).filter(name=>name.endsWith('.js'));
  assert.ok(sources.length>5,'the research contract sources were found');
  for(const name of sources){
    const body=fs.readFileSync(new URL(name,directory),'utf8');
    assert.ok(!body.includes(OWNER_RECOMMENDATION_CONTRACT_VERSIONS[0]),name+' must not emit the placeholder contract version before the root names it');
  }
  const emitted=sources.flatMap(name=>[...fs.readFileSync(new URL(name,directory),'utf8').matchAll(/ql3a-research-job-v\d+/g)].map(match=>match[0]));
  assert.ok(emitted.length>0&&emitted.every(version=>['ql3a-research-job-v1','ql3a-research-job-v2'].includes(version)),'builders emit v1 and v2 only: '+[...new Set(emitted)].join(','));
  for(const version of emitted)assert.equal(ownerRecommendationGate({contract:{version},result:{completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'}}).state,'FAIL');
  // RC-11: the multi-Pine version is a placeholder too, and no builder emits it before the root names it
  for(const name of sources)assert.ok(!fs.readFileSync(new URL(name,directory),'utf8').includes(MULTI_PINE_CONTRACT_VERSION),name+' must not emit the placeholder multi-Pine contract version');
});

test('R17 todo 3: a hard failure is a FAIL with at least one non-retryable code',()=>{
  assert.equal(isHardFailure({state:'FAIL',codes:['BI_COMPILE_EVIDENCE_MISSING']}),false);
  assert.equal(isHardFailure({state:'FAIL',codes:['BI_COMPILE_ERRORS']}),true);
  assert.equal(isHardFailure({state:'FAIL',codes:['BI_COMPILE_EVIDENCE_MISSING','BI_COMPILE_ERRORS']}),true);
  assert.equal(isHardFailure({state:'PASS',codes:[]}),false);
  assert.equal(isHardFailure({state:'NOT_REACHED',codes:[]}),false);
  assert.equal(isHardFailure(null),false);
  for(const code of RETRYABLE_CODES)assert.equal(isHardFailure({state:'FAIL',codes:[code]}),false,code);
});

test('R17 todo 4: the episode gate blocks only a non-fixture package; a fixture is never READY and never a G8 source',()=>{
  assert.equal(EPISODE_GATE_VERSION,null);
  const fixture=golden();
  assert.equal(B0(fixture).pass,true,'a labelled fixture passes B0');
  assert.deepEqual(codesOf(B0(golden({binding:b=>{b.fixture=false;}}))),['BI_EPISODE_GATE_UNAVAILABLE']);
  const result=ALL(fixture);
  assert.equal(result.status,STATUS.EXPORT_VALIDATED);
  assert.equal(result.ready,false,'never READY');
  assert.equal(result.record.fixture,true);
  assert.equal(libraryG8([{run_id:RUN_ID,mode:'ONE_PINE',record:result.record}],RUN_ID).state,'FAIL','never a G8 source');
  const view=readState({status:result.status,binding:fixture.binding,current:fixture.current,replay_mismatch:false,requester_owner_id:OWNER});
  assert.equal(view.fresh,true);assert.equal(view.ready,false);
  const real={...fixture.binding,fixture:false};
  assert.equal(readState({status:result.status,binding:real,current:fixture.current,replay_mismatch:false,requester_owner_id:OWNER}).ready,true,'only the fixture label stops READY here');
});

test('R14: Win Rate follows the fabrication rule: absent in the run stays absent or null, never derived',()=>{
  const withoutRate=golden({result:r=>{for(const part of [r.selected.result.train,r.selected.result.validation,r.selected.test])delete part.win_rate;}});
  const metricsFile=JSON.parse(withoutRate.files['quant-data/metrics.json']);
  assert.ok(!('win_rate' in metricsFile.train)&&!('win_rate' in metricsFile.validation)&&!('win_rate' in metricsFile.test),'the package carries no Win Rate where the run has none');
  assert.equal(C1(withoutRate).pass,true,'absent stays absent');
  assert.equal(ALL(withoutRate).pass,true);
  const asNull=golden({result:r=>{delete r.selected.test.win_rate;},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.test.win_rate=null;})});
  assert.equal(C1(asNull).pass,true,'null marks an absent Win Rate');
  for(const invented of ['66.67','0','0.00',66.67,0]){
    const derived=golden({result:r=>{delete r.selected.test.win_rate;},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.test.win_rate=invented;})});
    assert.ok(C1(derived).codes.includes('BI_METRIC_FABRICATED'),'a Win Rate derived for a run without one: '+JSON.stringify(invented));
  }
  const oneMissing=golden({result:r=>{delete r.selected.result.validation.win_rate;},files:files=>editJson(files,'quant-data/metrics.json',m=>{m.validation.win_rate='62.50';})});
  expectCodes(C1(oneMissing),['BI_METRIC_FABRICATED'],'each partition is judged on its own');
  assert.equal(C1(golden()).pass,true,'a stored Win Rate may ship');
  const badFormat=golden({files:files=>editJson(files,'quant-data/metrics.json',m=>{m.test.win_rate='not a number';})});
  expectCodes(C1(badFormat),['BI_NUMERIC_FORMAT_INVALID']);
});

test('S3: the shipped Win Rate must equal the stored Win Rate of the run (5.3)',()=>{
  const shipped=(part,value)=>golden({files:files=>editJson(files,'quant-data/metrics.json',m=>{if(value===undefined)delete m[part].win_rate;else m[part].win_rate=value;})});
  assert.equal(C3(golden()).pass,true,'the stored value ships unchanged');
  for(const part of ['train','validation','test']){
    expectCodes(C3(shipped(part,'99.99')),['BI_RESULT_MISMATCH'],part+': a different value');
    expectCodes(C3(shipped(part,null)),['BI_RESULT_MISMATCH'],part+': null for a stored value');
    expectCodes(C3(shipped(part,undefined)),['BI_RESULT_MISMATCH'],part+': absent for a stored value');
  }
  assert.equal(ALL(shipped('test','99.99')).status,STATUS.EXPORT_REFUSED,'a hard failure');
  // where the run has none, absent and null are equal
  const none=(stored,value)=>golden({result:r=>{for(const part of [r.selected.result.train,r.selected.result.validation,r.selected.test]){if(stored===undefined)delete part.win_rate;else part.win_rate=stored;}},
    files:files=>editJson(files,'quant-data/metrics.json',m=>{for(const part of ['train','validation','test']){if(value===undefined)delete m[part].win_rate;else m[part].win_rate=value;}})});
  assert.equal(C3(none(undefined,undefined)).pass,true,'absent and absent');
  assert.equal(C3(none(undefined,null)).pass,true,'absent and null');
  assert.equal(C3(none(null,undefined)).pass,true,'null and absent');
  assert.equal(C3(none(null,null)).pass,true,'null and null');
  expectCodes(C3(none(null,'5.00')),['BI_RESULT_MISMATCH'],'a value shipped for a stored null');
  expectCodes(C3(none('5.00','5.00')),[],'equal values');
  expectCodes(C3(none('5.00','5.01')),['BI_RESULT_MISMATCH']);
});

test('R4: indicator.pine must equal the deterministic Bridge output for the edited source and the package Bridge values (5.2)',()=>{
  const base=golden(),original=base.run.contract.source;
  const expected=bridgeIndicator(original.slice(0,LITERAL_START)+'30'+original.slice(LITERAL_START+2),'1.5','1');
  assert.equal(base.files['indicator.pine'],expected,'the golden file is the assemble() output');
  assert.equal(C2(base).pass,true);
  const edit=change=>golden({files:files=>{files['indicator.pine']=change(files['indicator.pine']);}});
  const diffs=[['a changed appended block',text=>text.replace('Bridge ATR Multiplier for SL','Bridge ATR Multiplier')],
    ['a Bridge default changed inside the block',text=>text.replace('input.float(1.5,','input.float(1.6,')],
    ['the Bridge RR default changed',text=>text.replace('input.float(1,','input.float(2,')],
    ['a changed protection line',text=>text.replace('math.floor(','math.ceil(')],
    ['an added line at the end',text=>text+'alert("extra")\n'],
    ['a removed final newline',text=>text.replace(/\n$/,'')],
    ['a block that is missing',text=>text.slice(0,text.indexOf('\n\n// Robot Trade bridge-exit-v2'))],
    ['another block that is appended',text=>text.replace('// Robot Trade bridge-exit-v2. DRAFT','// Robot Trade bridge-exit-v2. FINAL')],
    ['a changed original line',text=>text.replace('plot(emaFast)','plot(emaSlow)')],
    ['one more space in the original',text=>text.replace('//@version=6','//@version=6 ')]];
  for(const [label,change] of diffs){
    const subject=edit(change);
    assert.notEqual(subject.files['indicator.pine'],base.files['indicator.pine'],label+' changes the file');
    expectCodes(C2(subject),['BI_SOURCE_LOGIC_CHANGED'],label);
  }
  // package Bridge values and defaults
  const bridge=golden({files:files=>editJson(files,'inputs.json',i=>{i.bridge.atr_multiplier.after='2';})});
  expectCodes(C2(bridge),['BI_SOURCE_LOGIC_CHANGED'],'the Bridge value in inputs.json differs from the Bridge default in the block');
  const consistent=golden({result:r=>{r.selected.parameters.atr_multiplier=2;}});
  assert.equal(C2(consistent).pass,true,'a different Bridge value is fine when the block carries the same value');
  assert.match(consistent.files['indicator.pine'],/input\.float\(2, "Bridge ATR Multiplier/);
  // deployment and market of the binding come from the manifest binding
  const otherDeployment=golden({manifest:m=>{m.binding.deployment_id='11111111-2222-4333-8444-555555555555';}});
  expectCodes(C2(otherDeployment),['BI_SOURCE_LOGIC_CHANGED'],'the identifier prefix of the block follows the deployment');
  const otherSymbol=golden({manifest:m=>{m.binding.market={...m.binding.market,symbol:'ETHUSDT'};}});
  expectCodes(C2(otherSymbol),['BI_SOURCE_LOGIC_CHANGED'],'the symbol guard of the block follows the market');
  // inputs that cannot be assembled fail closed and never throw
  for(const [label,change] of [['no Bridge values',i=>{delete i.bridge;}],['unreadable Bridge value',i=>{i.bridge.rr.after='abc';}],['no Bridge entry',i=>{i.bridge.rr=null;}]]){
    const subject=golden({files:files=>editJson(files,'inputs.json',change)});
    assert.doesNotThrow(()=>C2(subject),label);
    assert.ok(C2(subject).codes.includes('BI_SOURCE_LOGIC_CHANGED'),label);
  }
  const noSignals=golden({contract:c=>{delete c.input_lock.selection.signals;}});
  assert.ok(C2(noSignals).codes.includes('BI_SOURCE_LOGIC_CHANGED'),'no mapped signals');
  const badId=golden({binding:b=>{b.deployment_id='deploy-1';},manifest:m=>{m.binding.deployment_id='deploy-1';}});
  assert.doesNotThrow(()=>C2(badId));
  assert.ok(C2(badId).codes.includes('BI_SOURCE_LOGIC_CHANGED'),'a deployment id the template refuses');
  const collision=golden({contract:c=>{c.source=c.source+'rt_'+hash(DEPLOY).slice(0,12)+'_x = 1\n';c.source_hash=hash(c.source);}});
  assert.doesNotThrow(()=>C2(collision));
  assert.ok(C2(collision).codes.includes('BI_SOURCE_LOGIC_CHANGED'),'an identifier collision makes the block unassemblable');
  // the check is a pure comparison: C2 neither reads the clock nor writes anything, and the original edits are still enforced
  const editedBlockOnly=golden({files:files=>editJson(files,'indicator.json',i=>{i.edits[0].after='40';})});
  expectCodes(C2(editedBlockOnly),['BI_SOURCE_LOGIC_CHANGED']);
});

test('R5: trace files must be reproduced by the evaluator; the gate compares the recomputed steps digest with the stored one (5.3)',()=>{
  assert.deepEqual([...TRACE_FILES],['quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv']);
  const base=golden();
  assert.equal(base.trace_reproduction.length,3);
  assert.equal(C3(base).pass,true);
  // S6: an absent record gives BI_RESULT_MISMATCH and also HOLDOUT_MISMATCH (the holdout trace has no record either)
  const ABSENT=['BI_RESULT_MISMATCH','HOLDOUT_MISMATCH'];
  expectCodes(C3(golden({subject:s=>{delete s.trace_reproduction;}})),ABSENT,'no reproduction record');
  expectCodes(C3(golden({subject:s=>{s.trace_reproduction=[];}})),ABSENT,'an empty record');
  expectCodes(C3(golden({subject:s=>{s.trace_reproduction=null;}})),ABSENT);
  expectCodes(C3(golden({subject:s=>{s.trace_reproduction='x';}})),ABSENT);
  for(const path of TRACE_FILES){
    const missing=golden({subject:s=>{s.trace_reproduction=s.trace_reproduction.filter(item=>item.path!==path);}});
    expectCodes(C3(missing),ABSENT,'no record for '+path);
    const duplicate=golden({subject:s=>{s.trace_reproduction.push({...s.trace_reproduction.find(item=>item.path===path)});}});
    expectCodes(C3(duplicate),ABSENT,'two records for '+path+' are no usable record');
    const differs=golden({subject:s=>{s.trace_reproduction.find(item=>item.path===path).steps_digest=hex('other-steps');}});
    expectCodes(C3(differs),['BI_RESULT_MISMATCH'],'a steps digest that differs for '+path);
    const noDigest=golden({subject:s=>{delete s.trace_reproduction.find(item=>item.path===path).steps_digest;}});
    expectCodes(C3(noDigest),['BI_RESULT_MISMATCH'],'no steps digest for '+path);
    const otherBytes=golden({subject:s=>{s.trace_reproduction.find(item=>item.path===path).sha256=hex('other-bytes');}});
    expectCodes(C3(otherBytes),['BI_RESULT_MISMATCH'],'a record for other bytes of '+path);
    const holdout=golden({subject:s=>{s.trace_reproduction.find(item=>item.path===path).holdout_digest=hex('other-holdout');}});
    expectCodes(C3(holdout),['HOLDOUT_MISMATCH'],'a holdout digest that differs for '+path);
    const noHoldout=golden({subject:s=>{delete s.trace_reproduction.find(item=>item.path===path).holdout_digest;}});
    expectCodes(C3(noHoldout),['HOLDOUT_MISMATCH'],'no holdout digest for '+path);
  }
  // a changed trace body: the record was computed for the original bytes
  const changed=golden();
  changed.files['quant-data/trades.csv']+='2026-10-19T01:00:00Z,2026-10-19T01:30:00Z,99\n';
  expectCodes(C3(changed),['BI_RESULT_MISMATCH'],'a changed trace body no longer matches the record');
  const unreadable=golden();
  delete unreadable.files['quant-data/decisions.csv'];
  expectCodes(C3(unreadable),['BI_RESULT_MISMATCH']);
  // a record for the wrong stored steps: another candidate
  const otherSteps=golden({result:r=>{r.selected.sensitivity[0].result.validation.net_return_percent='3.1';}});
  otherSteps.trace_reproduction=base.trace_reproduction;
  assert.ok(C3(otherSteps).codes.includes('BI_RESULT_MISMATCH'),'the digest follows the stored steps, not the package');
  // both at once
  const both=golden({subject:s=>{delete s.trace_reproduction;}});
  both.trace_reproduction=base.trace_reproduction.map(item=>({...item,steps_digest:hex('x'),holdout_digest:hex('y')}));
  expectCodes(C3(both),['BI_RESULT_MISMATCH','HOLDOUT_MISMATCH']);
  // neither code is retryable: the attempt ends EXPORT_REFUSED
  assert.equal(isRetryable('BI_RESULT_MISMATCH'),false);assert.equal(isRetryable('HOLDOUT_MISMATCH'),false);
  assert.equal(ALL(golden({subject:s=>{delete s.trace_reproduction;}})).status,STATUS.EXPORT_REFUSED);
  assert.equal(ALL(base).status,STATUS.EXPORT_VALIDATED);
});

test('R9: data window metadata: spot-dataset-v1, Spot market, closed bars only, no gaps (4.3)',()=>{
  const base=golden();
  assert.equal(C3(base).pass,true);
  const meta=change=>golden({subject:s=>{change(s.dataset.metadata);}});
  const gap=(n=1)=>m=>{m.total_bars+=n;};
  // market: the row names BI_MARKET_SCOPE_INVALID
  for(const [label,change] of [['market type not SPOT',m=>{m.market='FUTURES';}],['market type lower case',m=>{m.market='spot';}],['venue',m=>{m.venue='binance-us';}],
    ['symbol',m=>{m.symbol='ETHUSDT';}],['timeframe',m=>{m.timeframe='5';}]])
    expectCodes(C3(meta(change)),['BI_MARKET_SCOPE_INVALID'],label);
  // data window: the row names no code for a gap, a duplicate or an open bar, so BI_DATASET_UNAVAILABLE is used
  for(const [label,change] of [['another dataset kind',m=>{m.version='spot-dataset-v0';}],['no dataset kind',m=>{delete m.version;}],
    ['a gap (fewer bars than minutes)',m=>{m.total_bars-=1;}],['duplicates (more bars than minutes)',gap()],['an open bar after the cutoff',m=>{m.cutoff=m.end_time-MINUTE;}],
    ['end moved',m=>{m.end_time+=MINUTE;m.cutoff+=MINUTE;}],['start moved',m=>{m.start_time+=MINUTE;}],['warm-up differs',m=>{m.warmup_bars+=1;}],
    ['warm-up above the total',m=>{m.warmup_bars=m.total_bars+1;}],['a fractional bar count',m=>{m.total_bars+=0.5;}],['a string time',m=>{m.start_time=String(m.start_time);}],
    ['no cutoff',m=>{delete m.cutoff;}]])
    expectCodes(C3(meta(change)),['BI_DATASET_UNAVAILABLE'],label);
  expectCodes(C3(golden({subject:s=>{delete s.dataset.metadata;}})),['BI_DATASET_UNAVAILABLE'],'no metadata');
  expectCodes(C3(golden({subject:s=>{s.dataset.metadata=[];}})),['BI_DATASET_UNAVAILABLE'],'metadata not an object');
  expectCodes(C3(meta(m=>{m.market='FUTURES';m.total_bars-=1;})),['BI_MARKET_SCOPE_INVALID','BI_DATASET_UNAVAILABLE'],'both checks report');
  // S7: the source must be binance-spot-klines-v1 and the window must be minute aligned
  for(const [label,change] of [['another source',m=>{m.source='other-source';}],['no source',m=>{delete m.source;}],['source of another case',m=>{m.source='Binance-Spot-Klines-V1';}]])
    expectCodes(C3(meta(change)),['BI_DATASET_UNAVAILABLE'],label);
  // metadata and the run's dataset reference agree here, so only the alignment check can fail
  const misaligned=golden({contract:c=>{c.dataset.start_time+=1;c.dataset.end_time+=1;}});
  assert.equal(misaligned.dataset.metadata.start_time%MINUTE,1);
  expectCodes(C3(misaligned),['BI_DATASET_UNAVAILABLE'],'start and end not on a minute');
  const endOnly=golden({contract:c=>{c.dataset.end_time+=1;c.dataset.bar_count+=0;}});
  assert.ok(codesOf(C3(endOnly)).includes('BI_DATASET_UNAVAILABLE'),'an end time off the minute grid');
  // M20: metadata and the run reference agree on start, end, bar count and warm-up, but the span is not total_bars minutes
  const gapped=golden({contract:c=>{c.dataset.bar_count-=1;}});
  const gm=gapped.dataset.metadata,gref=gapped.run.contract.dataset;
  assert.equal(gm.start_time,gref.start_time);assert.equal(gm.end_time,gref.end_time+MINUTE);assert.equal(gm.total_bars,gref.bar_count);assert.equal(gm.warmup_bars,gref.warmup_bars);
  assert.notEqual(gm.end_time-gm.start_time,gm.total_bars*MINUTE,'the span is one bar longer than the bar count');
  expectCodes(C3(gapped),['BI_DATASET_UNAVAILABLE'],'a gap that the dataset reference itself hides');
  assert.equal(C3(golden()).pass,true);
  // metadata is read only for a dataset that resolves; an unreadable dataset is reported once
  expectCodes(C3(golden({subject:s=>{s.dataset.readable=false;delete s.dataset.metadata;}})),['BI_DATASET_UNAVAILABLE']);
  // the metadata of the run's own dataset reference, not a constant window
});

test('R8: the derived binding includes library_versions and library_record_ref; holdout_boundary_ref is checked in B0',()=>{
  assert.ok(BINDING_FIELDS.includes('library_versions')&&BINDING_FIELDS.includes('library_record_ref'));
  const base=golden();
  assert.deepEqual(base.binding.library_versions,LIBRARY_VERSIONS);
  assert.deepEqual(base.binding.library_record_ref,{run_id:RUN_ID,result_sha256:hash(canonical(base.run.result))});
  for(const [label,change] of [['library version added',b=>{b.library_versions={...LIBRARY_VERSIONS,extra:'x'};}],['library version changed',b=>{b.library_versions={...LIBRARY_VERSIONS,list:'quant-library-v0'};}],
    ['library versions as a string',b=>{b.library_versions='x';}],
    ['record of another run',b=>{b.library_record_ref={...b.library_record_ref,run_id:'other-run'};}],['record of other bytes',b=>{b.library_record_ref={...b.library_record_ref,result_sha256:hex('other')};}],
    ['record without a hash',b=>{b.library_record_ref={run_id:RUN_ID};}]]){
    const subject=golden({binding:change});
    expectCodes(C3(subject),['BI_BINDING_MISMATCH'],label);
  }
  const changedResult=golden();
  changedResult.run.result={...changedResult.run.result,candidate_count:7};
  assert.ok(C3(changedResult).codes.includes('BI_BINDING_MISMATCH'),'the frozen record must still hash to the packaged reference');
  // S5: library_versions is compared with the value frozen in the export row at build, never with the current constant
  const frozen={...LIBRARY_VERSIONS,list:'quant-library-list-v0'};
  const bumped=golden({binding:b=>{b.library_versions=frozen;},subject:s=>{s.export.library_versions=clone(frozen);}});
  assert.notDeepEqual(bumped.binding.library_versions,LIBRARY_VERSIONS);
  assert.equal(C3(bumped).pass,true,'a package built under older library versions still matches its frozen value');
  assert.equal(ALL(bumped).status,STATUS.EXPORT_VALIDATED);
  expectCodes(C3(golden({subject:s=>{s.export.library_versions=clone(frozen);}})),['BI_BINDING_MISMATCH'],'the packaged value differs from the frozen value');
  expectCodes(C3(golden({binding:b=>{b.library_versions=frozen;}})),['BI_BINDING_MISMATCH'],'the current constant is not the comparison value');
  for(const [label,change] of [['no export row',s=>{delete s.export;}],['export row without the value',s=>{s.export={};}],['null value',s=>{s.export.library_versions=null;}],
    ['string value',s=>{s.export.library_versions='x';}],['array value',s=>{s.export.library_versions=[];}]])
    expectCodes(C3(golden({subject:change})),['BI_BINDING_MISMATCH'],'frozen value missing: '+label);
  // a missing field is an incomplete binding at B0
  for(const field of ['library_versions','library_record_ref']){
    const subject=golden();
    delete subject.binding[field];
    expectCodes(B0(subject),['BI_BINDING_INCOMPLETE'],field);
  }
});

test('R12: C4 without a run or a packaged binding is BI_PROVENANCE_UNRESOLVED and not retryable',()=>{
  for(const [label,change] of [['no run',s=>{s.run=null;}],['run without a contract',s=>{s.run.contract=null;}],['no manifest',s=>{delete s.files[MANIFEST_PATH];}],['unreadable manifest',s=>{s.files[MANIFEST_PATH]='{no';}],
    ['manifest without a binding',s=>{editJson(s.files,MANIFEST_PATH,m=>{delete m.binding;});}]]){
    const subject=golden({subject:change}),result=C4(subject);
    expectCodes(result,['BI_PROVENANCE_UNRESOLVED'],label);
    assert.equal(isRetryable('BI_PROVENANCE_UNRESOLVED'),false);assert.equal(isHardFailure(result),true);
  }
});

test('R3: the READY view of an attempt passes the real replay state; REPLAY_MISMATCH forces STALE and READY false',()=>{
  const real=golden({contract:c=>{c.scope='NON_ENGINEERING_TEST_SCOPE';},binding:b=>{b.fixture=false;},manifest:m=>{m.fixture=false;},subject:s=>{s.replay_mismatch=false;}});
  // the real (non-fixture) package cannot pass B0 yet (episode gate), but the attempt view can be asked for it
  const view=ALL(real);
  assert.equal(view.status,STATUS.EXPORT_VALIDATED);
  assert.equal(view.ready,true,'validated, fresh, one Pine, not a fixture and owned');
  const replay=ALL(golden({contract:c=>{c.scope='NON_ENGINEERING_TEST_SCOPE';},binding:b=>{b.fixture=false;},manifest:m=>{m.fixture=false;},subject:s=>{s.replay_mismatch=true;}}));
  assert.equal(replay.status,STATUS.EXPORT_VALIDATED,'the stored status is untouched by a replay mismatch');
  assert.equal(replay.ready,false,'a REPLAY_MISMATCH event forces STALE, so never READY');
  assert.equal(replay.pass,true);
  const stale=ALL(golden({contract:c=>{c.scope='NON_ENGINEERING_TEST_SCOPE';},binding:b=>{b.fixture=false;},manifest:m=>{m.fixture=false;},subject:s=>{s.current.deployment_id='deploy-9';s.replay_mismatch=false;}}));
  assert.equal(stale.ready,false);
  // an unknown replay state refuses the call with BI_REPLAY_STATE_UNAVAILABLE (RC-8)
  for(const unknown of [undefined,null,'false',0,1,{}]){
    const subject=golden({subject:s=>{if(unknown===undefined)delete s.replay_mismatch;else s.replay_mismatch=unknown;}});
    const result=ALL(subject);
    assert.equal(result.refused,REPLAY_STATE_UNAVAILABLE);assert.deepEqual([...result.fields],['replay_mismatch']);
    assert.equal(result.ready,false);assert.equal(result.status,null);assert.equal(result.next,null);assert.equal(result.record,null);assert.deepEqual([...result.gates],[]);assert.deepEqual([...result.codes],[]);
  }
  // the replay refusal wins when replay_mismatch is among several bad fields; every bad field is still listed
  const several=ALL(golden({subject:s=>{delete s.current_rules;s.replay_mismatch='x';s.attempt=null;s.attempt_no=0;}}));
  assert.equal(several.refused,REPLAY_STATE_UNAVAILABLE);
  assert.deepEqual([...several.fields],['current_rules','replay_mismatch','attempt.attempt_id','attempt.validator_engine_hash','attempt.validated_at_utc','attempt_no']);
  const others=ALL(golden({subject:s=>{delete s.current_rules;s.attempt=null;s.attempt_no=0;}}));
  assert.equal(others.refused,INPUT_INVALID,'without a bad replay state the refusal stays INPUT_INVALID');
  assert.deepEqual([...others.fields],['current_rules','attempt.attempt_id','attempt.validator_engine_hash','attempt.validated_at_utc','attempt_no']);
});

test('R16: REPLAY_MISMATCH is listed first among the freshness codes and every code is kept',()=>{
  const subject=golden(),stale=freshness({binding:subject.binding,current:{...subject.current,deployment_id:'x',dataset_available:false},replay_mismatch:true});
  assert.deepEqual([...stale.codes],['REPLAY_MISMATCH','BI_DEPLOYMENT_CHANGED','BI_DATASET_UNAVAILABLE']);
  assert.equal(stale.code,'REPLAY_MISMATCH');
  assert.equal(stale.state,'STALE');assert.equal(stale.fresh,false);
  const only=freshness({binding:subject.binding,current:subject.current,replay_mismatch:true});
  assert.deepEqual([...only.codes],['REPLAY_MISMATCH']);
  const none=freshness({binding:subject.binding,current:{...subject.current,deployment_id:'x'},replay_mismatch:false});
  assert.deepEqual([...none.codes],['BI_DEPLOYMENT_CHANGED']);assert.equal(none.code,'BI_DEPLOYMENT_CHANGED');
  const view=readState({status:'EXPORT_VALIDATED',binding:{...subject.binding,fixture:false},current:{...subject.current,deployment_id:'x'},replay_mismatch:true,requester_owner_id:OWNER});
  assert.equal(view.code,'REPLAY_MISMATCH');assert.deepEqual([...view.codes],['REPLAY_MISMATCH','BI_DEPLOYMENT_CHANGED']);assert.equal(view.ready,false);
});

test('R17 todo 9: QUALIFIED_WINNER stays null; a validation record never names a winner',()=>{
  assert.equal(QUALIFIED_WINNER,null);
  assert.equal(qualifiedFromRecords([]).winner,null);
  const record=(runId,extra={})=>({run_id:runId,mode:'ONE_PINE',record:{export_id:EXPORT_ID,package_hash:hex('package'),binding_hash:hex('binding'),attempt_id:'a1',fixture:false,
    validated_at_utc:NOW,validator_engine_hash:hex('v'),gate_results:QUALIFYING_GATES.map(gate=>({gate,state:'PASS',codes:[]})),...extra}});
  const several=qualifiedFromRecords([record('run-1'),record('run-2'),record('run-3')]);
  assert.equal(several.total,3);assert.equal(several.winner,null,'cross-run ranking belongs to QR-4, not to this module');
  assert.deepEqual([...several.runs],['run-1','run-2','run-3']);
  assert.equal(qualifiedFromRecords([record('run-1')]).winner,null);
  assert.deepEqual(Object.keys(qualifiedFromRecords([record('run-1')])).sort(),['runs','total','winner']);
});

test('R17 todo 11: the binding field names are fixed by the module until best-inputs-manifest-v1 freezes them',()=>{
  assert.equal(BINDING_FIELDS.length,35);
  assert.equal(new Set(BINDING_FIELDS).size,BINDING_FIELDS.length);
  assert.ok(!BINDING_FIELDS.includes('holdout_boundary_ref'),'holdout_boundary_ref is optional and checked on its own');
  assert.equal(bindingComplete(golden().binding),true);
  assert.equal(MANIFEST_SCHEMA,'best-inputs-manifest-v1');
});
