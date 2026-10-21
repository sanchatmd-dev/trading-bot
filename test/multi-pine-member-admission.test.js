import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PineBridgeService} from '../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../src/postgres/quant-research.js';
import {MP_CODES,MP_CODE_PATTERN} from '../src/multi-pine/codes.js';
import {checkMemberAdmission,checkDatasetAdmission,checkMemberSetAdmission,MEMBER_CHECK_ORDER,SPT_CUSTOM_SETTINGS,SPT_SIGNAL_MAPPING} from '../src/multi-pine/member-admission.js';

/*
 * F11 RS-4. Every object below is a LABELLED ENGINEERING FIXTURE (synthetic rows, never a research result).
 * Part 1 (parity): the one-Pine admission block of QuantResearchService.enqueue (the real class, real PineBridgeService, an in-memory
 * stub store and database) and the pure mirror run on the same fixtures and must refuse with the same code. Part 2 tests the mirror
 * alone: check order, first failure wins, ordinal and import id in the diagnostic, DRAFT in place of READY, the whole-set refusals,
 * fail-closed input, purity. No PostgreSQL is needed: the one-Pine block only reads through the injected database object.
 */
const OWNER='owner-a',BOT='bot-a';
const sha=text=>createHash('sha256').update(text).digest('hex');
// Independent canonical JSON writer (the modules use their own).
const ref=value=>Array.isArray(value)?'['+value.map(ref).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+ref(value[k])).join(',')+'}':JSON.stringify(value);
const clone=value=>structuredClone(value);
const SOURCE_TEXT='synthetic spt source text for the admission fixtures';
const SUPPORTED=sha(SOURCE_TEXT);
const SIGNALS=clone(SPT_SIGNAL_MAPPING);
const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const EVIDENCE_CASES={sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1};
const pineId=n=>`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
const START=1699999980000,BARS=4200,END=START+(BARS-1)*60000,NOW=END+3600000;
const DIGEST=sha('fixture dataset digest');
const SPAN={n:BARS,first_time:START,last_time:END,bad:0,digest:DIGEST};
const DATASET={start_time:START,end_time:END,warmup_bars:1200};
const BRIDGE_DOMAINS={atr_multiplier:{min:1,max:3,step:0.5},rr:{min:1,max:2,step:0.5}};

function analysisFor(slow,edit) {
  const settings=Object.entries(SPT_CUSTOM_SETTINGS).map(([name,value])=>({pine_variable:name,type:typeof value==='boolean'?'bool':'string',effective_value:value}));
  const numbers=[['emaFastInput',20],['emaSlowInput',slow]];
  const inputs=[...settings,...numbers.map(([name,value])=>({pine_variable:name,type:'int',effective_value:value}))];
  for(let i=inputs.length;i<58;i++)inputs.push({pine_variable:`fixtureInput${i}`,type:'int',effective_value:i});
  inputs.forEach((input,i)=>Object.assign(input,{input_id:`in-${i}`,eligible:true,declared_domain:{min:null,max:null}}));
  if(edit)edit(inputs);
  const effective_inputs_hash=sha(ref(inputs));
  return {inputs,declarations:['buySignal','sellSignal'],effective_inputs_hash,
    effective_input_review:{source_hash:SUPPORTED,effective_inputs_hash,input_count:inputs.length,reviewed_by:'fixture-reviewer',reviewed_at:1700000000000}};
}

/**
 * One member with all of its rows. spec edits happen BEFORE hashing (so the row stays internally consistent); spec.after edits the rows
 * after hashing (so a hash breaks on purpose). Returns {member, world}: member is the mirror input, world feeds the one-Pine stub.
 */
function build(n,spec={}) {
  const slow=spec.slow??200+10*n;
  const analysis=analysisFor(slow,spec.editInputs);
  if(spec.editAnalysis)spec.editAnalysis(analysis);
  const source={owner_id:spec.sourceOwner??OWNER,bot_id:spec.sourceBot??BOT,pine_import_id:spec.sourceImport??pineId(n),source_version:spec.sourceVersion??2,source:spec.sourceText??SOURCE_TEXT,source_hash:spec.sourceHash??SUPPORTED,analysis};
  const selection={signals:clone(spec.signals??SIGNALS),bridge:{atr_multiplier:2,rr:1.5},bindings:[],fixed_inputs:analysis.inputs.map(i=>({...i}))};
  const entry={pine_import_id:pineId(n),source_version:2,source_hash:SUPPORTED,analysis};
  const snapshot={policy:clone(spec.policy??POLICY),capital:clone(spec.capital??CAPITAL),funding_cutoff:7,membership:clone(spec.membership??[entry]),
    market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',deployment_id:`dep-${n}`,pine_import_id:pineId(n),source_version:2,...spec.market},
    selection,source_hash:SUPPORTED,artifact_hash:sha('artifact-'+n)};
  snapshot.policy_hash=sha(ref(snapshot.policy));
  const world={policy:clone(snapshot.policy),capital:clone(snapshot.capital),funding:snapshot.funding_cutoff,membership:clone(snapshot.membership)};
  const snapshot_hash=sha(ref(snapshot));
  const deployment={deployment_id:`dep-${n}`,owner_id:spec.deploymentOwner??OWNER,bot_id:spec.deploymentBot??BOT,pine_import_id:pineId(n),source_version:2,state:spec.state??'DRAFT',
    snapshot,snapshot_hash,exit_version:spec.exit??'bridge-exit-v2'};
  const evidence={snapshot_hash:spec.evidenceSnapshotHash??snapshot_hash,artifact_hash:spec.evidenceArtifact??snapshot.artifact_hash,source_hash:snapshot.source_hash,
    compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,
    native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{...EVIDENCE_CASES},decision_match_percent:100,duplicate_ledger_effects:0,
    unrelated_payloads:0,level_difference_ticks:0,execution_model:{...MODEL,...spec.model},references:{tradingview:`fixture-tv-${n}`,source_review:`fixture-sr-${n}`,paper_fixture:`fixture-pf-${n}`}};
  if(spec.editEvidence)spec.editEvidence(evidence);
  const row={deployment_id:spec.evidenceDeployment??`dep-${n}`,snapshot_hash,evidence,evidence_hash:sha(ref(evidence))};
  const rows={deployment,evidence:row,source};
  if(spec.after)spec.after(rows);
  const member={ordinal:n,pine_import_id:rows.deployment?.pine_import_id??pineId(n),source_version:rows.deployment?.source_version??2,deployment:rows.deployment,evidence:rows.evidence,source:rows.source,
    quant_capability:{state:'SUPPORTED',source_hash:rows.source?.source_hash,effective_inputs_hash:rows.source?.analysis?.effective_inputs_hash}};
  return {member,world};
}
const ctx={owner_id:OWNER,bot_id:BOT,supported_source_hash:SUPPORTED};
const mirror=member=>checkMemberAdmission(member,ctx);

/* ---------- the one-Pine side: the real enqueue against an in-memory database ---------- */

const SENTINEL='PARITY_PAST_ADMISSION';
function oneStore(m,world,{span,capital}) {
  const rows=m;
  const sql=text=>text.replace(/\s+/g,' ');
  const prepare=text=>{
    const s=sql(text);
    return {
      get:async(...args)=>{
        if(s.includes('FROM pine_source_revisions')) {
          const [owner,bot,id,version]=args;
          return rows.source&&rows.source.owner_id===owner&&rows.source.bot_id===bot&&rows.source.pine_import_id===id&&rows.source.source_version===version?rows.source:undefined;
        }
        if(s.includes('FROM quant_jobs WHERE owner_id')&&s.includes('idempotency_key'))return undefined;
        if(s.includes('FROM pine_deployments')) {
          const [owner,bot,id]=args;
          return rows.deployment&&rows.deployment.owner_id===owner&&rows.deployment.bot_id===bot&&rows.deployment.deployment_id===id?rows.deployment:undefined;
        }
        if(s.includes('FROM pine_bridge_evidence'))return rows.evidence&&rows.evidence.deployment_id===args[0]?rows.evidence:undefined;
        if(s.includes('FROM paper_funding'))return {cutoff:world.funding};
        if(s.includes('count(*) total'))return {total:0,own:0};
        throw new Error('unexpected get: '+s);
      },
      all:async()=>{
        if(s.includes('FROM pine_memberships'))return world.membership;
        throw new Error('unexpected all: '+s);
      },
      run:async()=>{
        if(s.includes('INSERT INTO quant_jobs'))throw new Error(SENTINEL);
        throw new Error('unexpected run: '+s);
      }
    };
  };
  const db={
    prepare,
    lock:async()=>{},
    query:async(text)=>{
      const s=sql(text);
      if(s.includes('to_regclass'))return {rows:[{present:true}]};
      if(s.includes('FROM quant_research_executor_mode'))return {rows:[{mode:'FOUNDATION'}]};
      if(s.includes('FROM quant_foundation_scheduler'))return {rows:[]};
      if(s.includes('FROM quant_foundation_jobs'))return {rows:[{total:0,owned:0}]};
      if(s.includes('FROM pine_market_bars'))return {rows:[span]};
      throw new Error('unexpected query: '+s);
    }
  };
  return {
    db,
    ownsBot:async(owner,bot)=>owner===OWNER&&bot===BOT,
    userById:async()=>({status:'ACTIVE'}),
    getBotSession:async()=>({locked_policy:JSON.stringify(world.policy)}),
    risk:async()=>world.policy,
    paperAccounts:async()=>capital??world.capital,
    audit:async()=>{}
  };
}
/** Runs the one-Pine enqueue on the rows of a member. DRAFT is mapped to READY: the READY check is the one rule the mirror replaces. */
async function onePine({member,world},{dataset=DATASET,span=SPAN,now=NOW}={}) {
  const rows={deployment:member.deployment?{...member.deployment,state:member.deployment.state==='DRAFT'?'READY':member.deployment.state}:member.deployment,evidence:member.evidence,source:member.source};
  const store=oneStore(rows,world,{span});
  const pine=new PineBridgeService(store,{defaultRisk:POLICY});
  const service=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:SUPPORTED,foundation:true,datasetStore:{}});
  const body={bot_id:BOT,deployment_id:`dep-${member.ordinal}`,parameter_slots:[],bridge_domains:clone(BRIDGE_DOMAINS),dataset:clone(dataset),budget:10,seed:1};
  try {
    await service.enqueue(OWNER,body,'fixture-key-0001');
    return 'RETURNED';
  } catch(error) {
    if(error.message===SENTINEL)return 'PAST';
    return typeof error.code==='string'?error.code:'ERROR:'+error.message;
  }
}
const mirrorOutcome=(member,world,{dataset=DATASET,span=SPAN,now=NOW}={})=>{
  const checked=mirror(member);
  if(!checked.ok)return checked.code;
  const outcome=checkDatasetAdmission({dataset,dataset_span:span,capital_accounts:world.capital,now,min_warmup_bars:checked.min_warmup_bars});
  return outcome.ok?'PAST':outcome.code;
};

const seen=new Set();
const parity=[];
function expectParity(name,expected,make,options) {
  parity.push(name);
  test(`parity: ${name} -> ${expected}`,async()=>{
    const built=make();
    const one=await onePine(built,options);
    const pure=mirrorOutcome(built.member,built.world,options);
    assert.equal(one,expected,'one-Pine outcome');
    assert.equal(pure,expected,'mirror outcome');
    if(pure!=='PAST')seen.add(pure);
  });
}
const spec=(n,over)=>()=>build(n,over);

/* ---------- Part 1: parity, per-member checks in one-Pine order ---------- */

expectParity('a clean member is past every admission check','PAST',spec(1));
expectParity('deployment of another owner','NOT_FOUND',spec(1,{deploymentOwner:'owner-b'}));
expectParity('no deployment row','NOT_FOUND',()=>{const b=build(1);b.member.deployment=null;return b;});
expectParity('snapshot tampered after its hash','SNAPSHOT_HASH_MISMATCH',spec(1,{after:rows=>{rows.deployment.snapshot.funding_cutoff=8;}}));
expectParity('no evidence row','BRIDGE_EXECUTION_EVIDENCE_REQUIRED',()=>{const b=build(1);b.member.evidence=null;return b;});
expectParity('evidence row bound to another snapshot hash','BRIDGE_EXECUTION_EVIDENCE_REQUIRED',spec(1,{after:rows=>{rows.evidence.snapshot_hash=sha('other');}}));
expectParity('evidence tampered after its hash','BRIDGE_EXECUTION_EVIDENCE_REQUIRED',spec(1,{after:rows=>{rows.evidence.evidence.warnings=3;}}));
expectParity('evidence names another snapshot hash inside','STALE_EVIDENCE',spec(1,{evidenceSnapshotHash:sha('other')}));
expectParity('evidence names another artifact','STALE_EVIDENCE',spec(1,{evidenceArtifact:sha('other artifact')}));
expectParity('evidence with a compilation error','BRIDGE_EVIDENCE_FAILED',spec(1,{editEvidence:e=>{e.compilation_errors=1;}}));
expectParity('evidence with an unreviewed warning','BRIDGE_EVIDENCE_INCOMPLETE',spec(1,{editEvidence:e=>{e.warnings=2;}}));
expectParity('evidence with an unsupported execution model id','UNSUPPORTED_EXECUTION_MODEL',spec(1,{model:{version:'paper-close-v9'}}));
expectParity('execution model is not paper-close-v1','RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED',spec(1,{model:{version:'paper-close-cost-v2'}}));
expectParity('Paper trading off in the policy','SPOT_PAPER_POLICY_REQUIRED',spec(1,{policy:{...POLICY,paperTrading:false}}));
expectParity('reduce-only SELL off in the policy','SPOT_PAPER_POLICY_REQUIRED',spec(1,{policy:{...POLICY,requireReduceOnlySell:false}}));
expectParity('market symbol other than BTCUSDT','UNSUPPORTED_CUSTOM_MARKET',spec(1,{market:{symbol:'ETHUSDT'}}));
expectParity('market timeframe other than 1m','UNSUPPORTED_CUSTOM_MARKET',spec(1,{market:{timeframe:'5'}}));
expectParity('market broker other than binance-global','UNSUPPORTED_CUSTOM_MARKET',spec(1,{market:{broker:'other'}}));
expectParity('no source revision row','NOT_FOUND',()=>{const b=build(1);b.member.source=null;return b;});
expectParity('source revision of another owner','NOT_FOUND',spec(1,{sourceOwner:'owner-b'}));
expectParity('source hash is not the supported hash','UNSUPPORTED_SOURCE_HASH',spec(1,{sourceHash:sha('other source')}));
expectParity('source text does not hash to its source hash','UNSUPPORTED_SOURCE_HASH',spec(1,{sourceText:'different text'}));
expectParity('effective input review missing','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{delete a.effective_input_review;}}));
expectParity('effective input review bound to another input hash','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{a.effective_input_review.effective_inputs_hash=sha('x');}}));
expectParity('effective input review without a reviewer','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{a.effective_input_review.reviewed_by='';}}));
expectParity('input count other than 58','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{a.inputs.pop();}}));
expectParity('trade direction setting changed','UNSUPPORTED_CUSTOM_SETTING',spec(1,{editInputs:inputs=>{inputs.find(i=>i.pine_variable==='tradeDirectionectionection').effective_value='Both Long & Short';}}));
expectParity('slow filter setting changed','UNSUPPORTED_CUSTOM_SETTING',spec(1,{editInputs:inputs=>{inputs.find(i=>i.pine_variable==='useSlowFilter').effective_value=false;}}));
expectParity('notify setting changed','UNSUPPORTED_CUSTOM_SETTING',spec(1,{editInputs:inputs=>{inputs.find(i=>i.pine_variable==='notifyEnabled').effective_value=true;}}));
expectParity('signal mapping buy changed','UNSUPPORTED_SIGNAL_MAPPING',spec(1,{signals:{...SIGNALS,buy:'otherSignal'}}));
expectParity('signal mapping timing changed','UNSUPPORTED_SIGNAL_MAPPING',spec(1,{signals:{...SIGNALS,timing:'intrabar'}}));

// Round 2 (L1): rules the first review found unguarded.
expectParity('deployment of another Bot','NOT_FOUND',spec(1,{deploymentBot:'bot-b'}));
expectParity('evidence row of another deployment','BRIDGE_EXECUTION_EVIDENCE_REQUIRED',spec(1,{evidenceDeployment:'dep-9'}));
expectParity('evidence names another source hash','STALE_EVIDENCE',spec(1,{editEvidence:e=>{e.source_hash=sha('other source hash');}}));
expectParity('source revision of another Bot','NOT_FOUND',spec(1,{sourceBot:'bot-b'}));
expectParity('source revision of another import','NOT_FOUND',spec(1,{sourceImport:pineId(8)}));
expectParity('source revision of another version','NOT_FOUND',spec(1,{sourceVersion:3}));
expectParity('source version not an integer','INVALID_NUMERIC_VALUE',spec(1,{after:rows=>{rows.deployment.source_version=1.5;}}));
expectParity('source version below 1','INVALID_NUMERIC_VALUE',spec(1,{after:rows=>{rows.deployment.source_version=0;}}));
expectParity('import id of the deployment is malformed','NOT_FOUND',spec(1,{after:rows=>{rows.deployment.pine_import_id='not-an-import-id';}}));
expectParity('effective input review bound to another source hash','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{a.effective_input_review.source_hash=sha('x');}}));
expectParity('effective input review with another input count','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{a.effective_input_review.input_count=57;}}));
expectParity('effective input review without a review time','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{delete a.effective_input_review.reviewed_at;}}));
expectParity('effective input review with a fractional review time','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',spec(1,{editAnalysis:a=>{a.effective_input_review.reviewed_at=1.5;}}));

/* ---------- Part 1: parity, dataset rules ---------- */

const withDataset=(dataset,span,over)=>{const options={dataset:{...DATASET,...dataset},span:{...SPAN,...span}};if(over)Object.assign(options,over);return options;};
function datasetParity(name,expected,make,options) {expectParity(`dataset: ${name}`,expected,make,options);}
datasetParity('a clean dataset','PAST',spec(1),withDataset());
datasetParity('an unknown dataset key','INVALID_FIELDS',spec(1),{dataset:{...DATASET,extra:1},span:SPAN});
datasetParity('a missing dataset key','INVALID_FIELDS',spec(1),{dataset:{start_time:START,end_time:END},span:SPAN});
datasetParity('start before 1','INVALID_NUMERIC_VALUE',spec(1),withDataset({start_time:0}));
datasetParity('end after the clock','INVALID_NUMERIC_VALUE',spec(1),withDataset({end_time:END+1000*60000},undefined,{now:END}));
datasetParity('fractional start','INVALID_NUMERIC_VALUE',spec(1),withDataset({start_time:START+0.5}));
datasetParity('warm-up below the 1006 floor','INVALID_NUMERIC_VALUE',spec(1,{slow:100}),withDataset({warmup_bars:1005}));
datasetParity('warm-up at the 1006 floor','PAST',spec(1,{slow:100}),withDataset({warmup_bars:1006}));
datasetParity('warm-up below five slow EMA lengths of the member','INVALID_NUMERIC_VALUE',spec(1),withDataset({warmup_bars:1049}));
datasetParity('warm-up below five slow EMA lengths','INVALID_NUMERIC_VALUE',spec(1,{slow:300}),withDataset({warmup_bars:1499}));
datasetParity('warm-up above 5000','INVALID_NUMERIC_VALUE',spec(1),withDataset({warmup_bars:5001}));
datasetParity('start not before end','INVALID_RESEARCH_DATASET',spec(1),withDataset({start_time:END,end_time:END-60000}));
datasetParity('start not minute aligned','INVALID_RESEARCH_DATASET',spec(1),withDataset({start_time:START+1000}));
datasetParity('end not minute aligned','INVALID_RESEARCH_DATASET',spec(1),withDataset({end_time:END+1000}));
datasetParity('more than 10000 bars','INVALID_RESEARCH_DATASET',spec(1),withDataset({end_time:START+10000*60000},undefined,{now:START+20000*60000}));
datasetParity('stored bar count differs','INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET',spec(1),withDataset({},{n:BARS-1}));
datasetParity('exactly 2000 compared bars','PAST',spec(1),withDataset({warmup_bars:2200}));
datasetParity('compared bars one short of 2000','INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET',spec(1),withDataset({warmup_bars:2201}));
datasetParity('first stored bar is not the start','VERIFIED_MARKET_DATA_REQUIRED',spec(1),withDataset({},{first_time:START+60000}));
datasetParity('last stored bar is not the end','VERIFIED_MARKET_DATA_REQUIRED',spec(1),withDataset({},{last_time:END-60000}));
datasetParity('a bad stored bar','VERIFIED_MARKET_DATA_REQUIRED',spec(1),withDataset({},{bad:1}));
datasetParity('digest not 64 hex characters','VERIFIED_MARKET_DATA_REQUIRED',spec(1),withDataset({},{digest:'abc'}));
datasetParity('digest missing','VERIFIED_MARKET_DATA_REQUIRED',spec(1),withDataset({},{digest:null}));
datasetParity('configured equity zero','RESEARCH_CAPITAL_REQUIRED',spec(1,{capital:[{broker:'binance-global',configuredEquity:0,configuredBalance:1000}]}),withDataset());
datasetParity('configured balance zero','RESEARCH_CAPITAL_REQUIRED',spec(1,{capital:[{broker:'binance-global',configuredEquity:1000,configuredBalance:0}]}),withDataset());
datasetParity('no account for the market broker','RESEARCH_CAPITAL_REQUIRED',spec(1,{capital:[{broker:'other',configuredEquity:1000,configuredBalance:1000}]}),withDataset());
datasetParity('dataset order: bar count before verified data','INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET',spec(1),withDataset({},{n:BARS+1,bad:1}));
datasetParity('dataset order: verified data before capital','VERIFIED_MARKET_DATA_REQUIRED',spec(1,{capital:[]}),withDataset({},{bad:1}));

test('the parity table has at least 50 cases',()=>{
  assert.ok(parity.length>=50,String(parity.length));
});

/* ---------- Part 2: the replaced and not mirrored rules, shown both ways ---------- */

test('DRAFT replaces READY: the mirror admits DRAFT and refuses READY, EXIT_ONLY and REVOKED; one-Pine does the reverse for READY-only',async()=>{
  const draft=build(1);
  assert.equal(mirror(draft.member).ok,true);
  assert.equal(await onePine(draft),'PAST'); // onePine maps DRAFT to READY
  for(const state of ['READY','EXIT_ONLY','REVOKED']) {
    const b=build(1,{state});
    const out=mirror(b.member);
    assert.equal(out.ok,false,state);
    assert.equal(out.code,MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,state);
    assert.deepEqual(out.diagnostic,{ordinal:1,pine_import_id:pineId(1),field:'deployment.state'});
    seen.add(out.code);
  }
  // The one-Pine path keeps its own READY rule: a DRAFT row (no mapping) is RESEARCH_DEPLOYMENT_NOT_READY there.
  const raw=build(1);
  const store=oneStore({deployment:raw.member.deployment,evidence:raw.member.evidence,source:raw.member.source},raw.world,{span:SPAN});
  const service=new QuantResearchService({pineService:new PineBridgeService(store,{defaultRisk:POLICY}),clock:()=>NOW,supportedSourceHash:SUPPORTED,foundation:true,datasetStore:{}});
  await assert.rejects(()=>service.enqueue(OWNER,{bot_id:BOT,deployment_id:'dep-1',parameter_slots:[],bridge_domains:BRIDGE_DOMAINS,dataset:DATASET,budget:10,seed:1},'fixture-key-0002'),{code:'RESEARCH_DEPLOYMENT_NOT_READY'});
});
test('a deployment of another import or source version is MP_MEMBER_DEPLOYMENT_MISSING in the mirror only',()=>{
  const wrongImport=build(1);wrongImport.member.deployment.pine_import_id=pineId(2);
  assert.equal(mirror(wrongImport.member).code,MP_CODES.MEMBER_DEPLOYMENT_MISSING);
  const wrongVersion=build(1);wrongVersion.member.source_version=3;
  const out=mirror(wrongVersion.member);
  assert.equal(out.code,MP_CODES.MEMBER_DEPLOYMENT_MISSING);
  assert.deepEqual(out.diagnostic,{ordinal:1,pine_import_id:pineId(1),field:'deployment.identity'});
  seen.add(out.code);
});
test('a member snapshot with a multi-Pine membership passes the mirror; the one-Pine path refuses it (rule not mirrored on purpose)',async()=>{
  const b=build(1,{membership:[build(1).member.deployment.snapshot.membership[0],build(2).member.deployment.snapshot.membership[0]]});
  assert.equal(mirror(b.member).ok,true);
  assert.equal(await onePine(b),'MULTI_PINE_RESEARCH_NOT_SUPPORTED');
});

/* ---------- Part 2: diagnostics, order, first failure wins ---------- */

test('the documented member check order matches the implementation: the first rule broken is the one reported',()=>{
  const breakers=[
    ['NOT_FOUND','deployment',spec(1,{deploymentOwner:'owner-b'})],
    [MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,'deployment.state',spec(1,{state:'READY'})],
    ['SNAPSHOT_HASH_MISMATCH','deployment.snapshot_hash',spec(1,{after:r=>{r.deployment.snapshot.funding_cutoff=9;}})],
    ['BRIDGE_EXECUTION_EVIDENCE_REQUIRED','evidence',()=>{const b=build(1);b.member.evidence=null;return b;}],
    ['RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED','evidence.execution_model.version',spec(1,{model:{version:'paper-close-cost-v2'}})],
    ['SPOT_PAPER_POLICY_REQUIRED','snapshot.policy',spec(1,{policy:{...POLICY,paperTrading:false}})],
    ['UNSUPPORTED_CUSTOM_MARKET','snapshot.market',spec(1,{market:{symbol:'ETHUSDT'}})],
    ['NOT_FOUND','source',spec(1,{sourceOwner:'owner-b'})],
    ['UNSUPPORTED_SOURCE_HASH','source.source_hash',spec(1,{sourceHash:sha('o')})],
    ['CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED','source.analysis.effective_input_review',spec(1,{editAnalysis:a=>{delete a.effective_input_review;}})],
    ['UNSUPPORTED_CUSTOM_SETTING','source.analysis.inputs.useMTF',spec(1,{editInputs:i=>{i.find(x=>x.pine_variable==='useMTF').effective_value=true;}})],
    ['UNSUPPORTED_SIGNAL_MAPPING','snapshot.selection.signals',spec(1,{signals:{...SIGNALS,exit:'x'}})]
  ];
  // Every breaker alone gives its own code and field.
  for(const [code,field,make] of breakers) {
    const out=mirror(make().member);
    assert.deepEqual([out.code,out.diagnostic.field],[code,field],code);
  }
  const order=MEMBER_CHECK_ORDER.map(([code,field])=>[code,field]);
  assert.equal(order.length,13);
  assert.deepEqual(order.map(r=>r[0]),['NOT_FOUND',MP_CODES.MEMBER_DEPLOYMENT_MISSING,MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,'SNAPSHOT_HASH_MISMATCH','BRIDGE_EXECUTION_EVIDENCE_REQUIRED','RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED','SPOT_PAPER_POLICY_REQUIRED','UNSUPPORTED_CUSTOM_MARKET','NOT_FOUND','UNSUPPORTED_SOURCE_HASH','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED','UNSUPPORTED_CUSTOM_SETTING','UNSUPPORTED_SIGNAL_MAPPING']);
  assert.ok(Object.isFrozen(MEMBER_CHECK_ORDER));
});
test('cumulative breakers: each fix exposes the next check in order',()=>{
  // One member broken in every way that does not stop an earlier check from being reached; drop breakers one at a time from the front.
  const apply=count=>{
    const edits={};
    const list=[
      ['state',()=>{edits.state='READY';}],
      ['policy',()=>{edits.policy={...POLICY,paperTrading:false};}],
      ['market',()=>{edits.market={symbol:'ETHUSDT'};}],
      ['sourceHash',()=>{edits.sourceHash=sha('o');}],
      ['signals',()=>{edits.signals={...SIGNALS,exit:'x'};}]
    ];
    list.slice(count).forEach(([,fn])=>fn());
    return build(1,edits);
  };
  assert.equal(mirror(apply(0).member).code,MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE);
  assert.equal(mirror(apply(1).member).code,'SPOT_PAPER_POLICY_REQUIRED');
  assert.equal(mirror(apply(2).member).code,'UNSUPPORTED_CUSTOM_MARKET');
  assert.equal(mirror(apply(3).member).code,'UNSUPPORTED_SOURCE_HASH');
  assert.equal(mirror(apply(4).member).code,'UNSUPPORTED_SIGNAL_MAPPING');
  assert.equal(mirror(apply(5).member).ok,true);
});
test('a success result carries the exit version, execution model and warm-up floor of the member',()=>{
  const out=mirror(build(3).member); // slow EMA 230 -> 5 * 230 = 1150 above the 1006 floor
  assert.deepEqual(out,{ok:true,exit_version:'bridge-exit-v2',execution_model:MODEL,min_warmup_bars:1150});
  assert.equal(mirror(build(1).member).min_warmup_bars,1050); // slow EMA 210 -> 1050
  assert.equal(mirror(build(1,{slow:100}).member).min_warmup_bars,1006); // 5 * 100 = 500 below the 1006 floor
});

function setInput(members,over={}) {
  return {owner_id:OWNER,bot_id:BOT,supported_source_hash:SUPPORTED,members:members.map(b=>clone(b.member)),dataset:clone(DATASET),dataset_span:clone(SPAN),capital_accounts:clone(CAPITAL),now:NOW,...over};
}
const trio=(specs=[{},{},{}])=>specs.map((s,i)=>build(i+1,s));
const note=out=>{if(out.ok===false)seen.add(out.code);return out;};
const admit=input=>note(checkMemberSetAdmission(input));

test('a clean set of three members is admitted and reports the combined warm-up floor',()=>{
  const out=admit(setInput(trio()));
  assert.deepEqual(out,{ok:true,members:3,exit_version:'bridge-exit-v2',min_warmup_bars:1150});
  assert.deepEqual(admit(setInput(trio().slice(0,2))),{ok:true,members:2,exit_version:'bridge-exit-v2',min_warmup_bars:1100});
});
test('members are checked in ordinal order and the first failing member ends admission with its ordinal and import id',()=>{
  const specs=[{},{policy:{...POLICY,paperTrading:false}},{market:{symbol:'ETHUSDT'}}];
  const out=admit(setInput(trio(specs)));
  assert.equal(out.ok,false);
  assert.equal(out.code,'SPOT_PAPER_POLICY_REQUIRED');
  assert.deepEqual(out.diagnostic,{ordinal:2,pine_import_id:pineId(2),field:'snapshot.policy'});
  const first=admit(setInput(trio([{sourceHash:sha('o')},{policy:{...POLICY,paperTrading:false}},{market:{symbol:'ETHUSDT'}}])));
  assert.deepEqual([first.code,first.diagnostic.ordinal],['UNSUPPORTED_SOURCE_HASH',1]);
  const last=admit(setInput(trio([{},{},{signals:{...SIGNALS,buy:'z'}}])));
  assert.deepEqual([last.code,last.diagnostic.ordinal,last.diagnostic.pine_import_id],['UNSUPPORTED_SIGNAL_MAPPING',3,pineId(3)]);
});
test('a later member with an earlier rule broken does not win over an earlier member: ordinal beats rule order',()=>{
  const out=admit(setInput(trio([{signals:{...SIGNALS,buy:'z'}},{deploymentOwner:'owner-b'},{}])));
  assert.deepEqual([out.code,out.diagnostic.ordinal],['UNSUPPORTED_SIGNAL_MAPPING',1]);
});
test('members out of ascending pine_import_id order are MP_INPUT_INVALID on the first member out of order',()=>{
  const [a,b,c]=trio();
  // Ordinals stay 1..N; only the import ids move.
  const swap=(x,y)=>{const input=setInput([a,b,c]);const first=input.members[x].pine_import_id;input.members[x].pine_import_id=input.members[y].pine_import_id;input.members[y].pine_import_id=first;return input;};
  for(const [x,y,field] of [[0,1,'members[1]'],[1,2,'members[2]'],[0,2,'members[1]']]) {
    const out=admit(swap(x,y));
    assert.equal(out.code,MP_CODES.INPUT_INVALID,field);
    assert.equal(out.diagnostic.field,field);
  }
  const equal=setInput([a,b,c]);equal.members[2].pine_import_id=equal.members[1].pine_import_id;
  assert.equal(admit(equal).diagnostic.field,'members[2]');
  assert.equal(admit(setInput([a,b,c])).ok,true);
});
test('checkDatasetAdmission applies max(1006, caller floor): a low caller floor does not lower the minimum',()=>{
  const args=warmup_bars=>({dataset:{...DATASET,warmup_bars},dataset_span:SPAN,capital_accounts:CAPITAL,now:NOW});
  for(const floor of [1,0,-5,500]) {
    const low=checkDatasetAdmission({...args(1005),min_warmup_bars:floor});
    assert.deepEqual([low.ok,low.code],[false,'INVALID_NUMERIC_VALUE'],String(floor));
    assert.equal(checkDatasetAdmission({...args(1006),min_warmup_bars:floor}).ok,true,String(floor));
  }
  assert.equal(checkDatasetAdmission({...args(1100),min_warmup_bars:1150}).code,'INVALID_NUMERIC_VALUE');
  assert.equal(checkDatasetAdmission({...args(1150),min_warmup_bars:1150}).ok,true);
});
test('every refusal has exactly the diagnostic keys ordinal, pine_import_id and field',()=>{
  const outs=[
    admit(setInput(trio([{},{state:'REVOKED'},{}]))),
    admit(setInput(trio(),{members:[]})),
    admit(setInput(trio(),{dataset:{...DATASET,warmup_bars:10}}))
  ];
  for(const out of outs) {
    assert.equal(out.ok,false);
    assert.deepEqual(Object.keys(out).sort(),['code','diagnostic','ok']);
    assert.deepEqual(Object.keys(out.diagnostic),['ordinal','pine_import_id','field']);
    assert.match(out.code,MP_CODE_PATTERN);
  }
});

/* ---------- Part 2: whole-set refusals ---------- */

const capability=member=>({state:'SUPPORTED',source_hash:member.source.source_hash,effective_inputs_hash:member.source.analysis.effective_inputs_hash});
test('one member without quant capability refuses the whole set with MP_MEMBER_QUANT_UNSUPPORTED naming that member',()=>{
  const wrong=member=>[
    undefined,null,true,'SUPPORTED','supported',[],{},
    {...capability(member),state:'UNSUPPORTED'},{...capability(member),state:'supported'},{...capability(member),state:undefined},
    {...capability(member),source_hash:sha('another source')},{...capability(member),source_hash:undefined},{...capability(member),source_hash:5},
    {...capability(member),effective_inputs_hash:sha('another inputs')},{...capability(member),effective_inputs_hash:undefined},{...capability(member),effective_inputs_hash:null}
  ];
  const values=wrong(setInput(trio()).members[1]);
  assert.equal(values.length,16);
  for(const [i,value] of values.entries()) {
    const input=setInput(trio());
    if(value===undefined)delete input.members[1].quant_capability;else input.members[1].quant_capability=value;
    const out=admit(input);
    assert.equal(out.code,MP_CODES.MEMBER_QUANT_UNSUPPORTED,String(i));
    assert.deepEqual(out.diagnostic,{ordinal:2,pine_import_id:pineId(2),field:'quant_capability'});
  }
  // The capability record of another member does not prove this member: the hashes differ per member.
  const swapped=setInput(trio());
  assert.notEqual(swapped.members[0].quant_capability.effective_inputs_hash,swapped.members[1].quant_capability.effective_inputs_hash);
  swapped.members[1].quant_capability=clone(swapped.members[0].quant_capability);
  assert.equal(admit(swapped).diagnostic.ordinal,2);
  const input=setInput(trio());
  input.members[2].quant_capability={...capability(input.members[2]),state:'UNSUPPORTED'};
  input.members[1].quant_capability={...capability(input.members[1]),state:'UNSUPPORTED'};
  assert.equal(admit(input).diagnostic.ordinal,2);
  // An extra key on an otherwise matching record does not matter.
  const ok=setInput(trio());
  ok.members[0].quant_capability={...capability(ok.members[0]),note:'x'};
  assert.equal(admit(ok).ok,true);
});
test('step 3 runs for every member before step 4: a one-Pine failure of member 3 wins over unsupported capability of member 1',()=>{
  const input=setInput(trio([{},{},{market:{symbol:'ETHUSDT'}}]));
  input.members[0].quant_capability={...input.members[0].quant_capability,state:'UNSUPPORTED'};
  const out=admit(input);
  assert.deepEqual([out.code,out.diagnostic.ordinal],['UNSUPPORTED_CUSTOM_MARKET',3]);
});
test('step 4 runs before the dataset rules and the dataset rules before the uniformity rules',()=>{
  const input=setInput(trio([{},{exit:'bridge-exit-v3'},{}]),{dataset:{...DATASET,warmup_bars:10}});
  const good=clone(input.members[2].quant_capability);
  input.members[2].quant_capability={...good,state:'UNSUPPORTED'};
  assert.equal(admit(input).code,MP_CODES.MEMBER_QUANT_UNSUPPORTED);
  input.members[2].quant_capability=good;
  assert.equal(admit(input).code,'INVALID_NUMERIC_VALUE');
  input.dataset=clone(DATASET);
  assert.equal(admit(input).code,MP_CODES.EXIT_VERSION_MIXED);
});
test('dataset refusals of a set carry ordinal null and pine_import_id null',()=>{
  const cases=[
    [{dataset:{...DATASET,warmup_bars:1000}},'INVALID_NUMERIC_VALUE','dataset.warmup_bars'],
    [{dataset_span:{...SPAN,bad:2}},'VERIFIED_MARKET_DATA_REQUIRED','dataset_span'],
    [{dataset_span:{...SPAN,n:5}},'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET','dataset_span'],
    [{capital_accounts:[]},'RESEARCH_CAPITAL_REQUIRED','capital_accounts'],
    [{dataset:{...DATASET,start_time:START+5}},'INVALID_RESEARCH_DATASET','dataset']
  ];
  for(const [over,code,field] of cases) {
    const out=admit(setInput(trio(),over));
    assert.deepEqual([out.code,out.diagnostic],[code,{ordinal:null,pine_import_id:null,field}],code);
  }
});
test('combined warm-up is the maximum of the member floors',()=>{
  // Member 3 has slow EMA 230 -> floor 1150; a warm-up of 1100 clears members 1 and 2 but not the set.
  assert.equal(admit(setInput(trio(),{dataset:{...DATASET,warmup_bars:1100}})).code,'INVALID_NUMERIC_VALUE');
  assert.equal(admit(setInput(trio(),{dataset:{...DATASET,warmup_bars:1150}})).ok,true);
  assert.equal(admit(setInput(trio().slice(0,2),{dataset:{...DATASET,warmup_bars:1100}})).ok,true);
  const slowest=trio([{slow:400},{},{}]);
  assert.equal(admit(setInput(slowest,{dataset:{...DATASET,warmup_bars:1999}})).code,'INVALID_NUMERIC_VALUE');
  assert.equal(admit(setInput(slowest,{dataset:{...DATASET,warmup_bars:2000}})).ok,true);
});
test('exit versions must be one and supported; execution models must be one',()=>{
  const mixed=admit(setInput(trio([{},{},{exit:'bridge-exit-v3'}])));
  assert.deepEqual([mixed.code,mixed.diagnostic],[MP_CODES.EXIT_VERSION_MIXED,{ordinal:3,pine_import_id:pineId(3),field:'deployment.exit_version'}]);
  const unsupported=admit(setInput(trio([{exit:'bridge-exit-v3'},{exit:'bridge-exit-v3'},{exit:'bridge-exit-v3'}])));
  assert.deepEqual([unsupported.code,unsupported.diagnostic.ordinal],['BI_EXIT_VERSION_UNSUPPORTED',1]);
  const model=admit(setInput(trio([{},{model:{fee_bps:5}},{}])));
  assert.deepEqual([model.code,model.diagnostic],[MP_CODES.EXECUTION_MODEL_MIXED,{ordinal:2,pine_import_id:pineId(2),field:'evidence.execution_model'}]);
  const risk=admit(setInput(trio([{},{},{model:{risk_percent:2}}])));
  assert.deepEqual([risk.code,risk.diagnostic.ordinal],[MP_CODES.EXECUTION_MODEL_MIXED,3]);
  // Mixed exit versions are reported before an unsupported one, and both before a mixed model.
  const both=admit(setInput(trio([{exit:'bridge-exit-v3',model:{fee_bps:5}},{},{}])));
  assert.equal(both.code,MP_CODES.EXIT_VERSION_MIXED);
});
test('a set of one member, of four members, and an empty set refuse before any member is read',()=>{
  const [a,b,c]=trio();
  const four=build(4);
  assert.deepEqual([admit(setInput([a],{})).code,admit(setInput([a],{})).diagnostic],[MP_CODES.NOT_MULTI_PINE,{ordinal:null,pine_import_id:null,field:'members'}]);
  assert.equal(admit(setInput([a,b,c,four])).code,MP_CODES.MEMBER_COUNT_EXCEEDED);
  assert.equal(admit(setInput([a],{members:[]})).code,MP_CODES.MEMBERSHIP_EMPTY);
  void b;void c;
});

/* ---------- Part 2: fail closed on malformed input; purity ---------- */

test('malformed input is MP_INPUT_INVALID with a field, never a throw',()=>{
  const good=()=>setInput(trio());
  const cases=[
    [null,'input'],[[],'input'],['x','input'],
    [{...good(),extra:1},'input.extra'],
    [{...good(),owner_id:''},'owner_id'],
    [{...good(),bot_id:5},'bot_id'],
    [{...good(),members:'x'},'members'],
    [(()=>{const i=good();i.members[0].ordinal=2;return i;})(),'members[0]'],
    [(()=>{const i=good();i.members[1].ordinal=3;return i;})(),'members[1]'],
    [(()=>{const i=good();i.members[2].pine_import_id=i.members[1].pine_import_id;return i;})(),'members[2]'],
    [(()=>{const i=good();i.members[1]=null;return i;})(),'members[1]'],
    [{...good(),now:'x'},'dataset_inputs'],
    [{...good(),dataset_span:null},'dataset_span'],
    [{...good(),capital_accounts:null},'capital_accounts']
  ];
  for(const [input,field] of cases) {
    const out=admit(input);
    assert.equal(out.ok,false,field);
    assert.equal(out.code,MP_CODES.INPUT_INVALID,field);
    assert.equal(out.diagnostic.field,field);
  }
  // A malformed row inside a member names the member and the step.
  const input=good();
  input.members[1].source.analysis=null;
  const out=admit(input);
  assert.equal(out.code,MP_CODES.INPUT_INVALID);
  assert.deepEqual(out.diagnostic,{ordinal:2,pine_import_id:pineId(2),field:'source.analysis.effective_input_review'});
  const noSlow=build(1,{editInputs:inputs=>{inputs.find(i=>i.pine_variable==='emaSlowInput').effective_value='200';}});
  assert.deepEqual(mirror(noSlow.member).diagnostic.field,'source.analysis.inputs.emaSlowInput');
  assert.equal(mirror(noSlow.member).code,MP_CODES.INPUT_INVALID);
  assert.equal(checkMemberAdmission(null,ctx).code,MP_CODES.INPUT_INVALID);
  assert.equal(checkDatasetAdmission().code,MP_CODES.INPUT_INVALID);
});
test('the inputs are never mutated and the results are plain data',()=>{
  const input=setInput(trio());
  const before=ref(input);
  const out=admit(input);
  assert.equal(ref(input),before);
  assert.deepEqual(JSON.parse(JSON.stringify(out)),out);
  const failing=setInput(trio([{},{state:'READY'},{}]));
  const failingBefore=ref(failing);
  const refusal=admit(failing);
  assert.equal(ref(failing),failingBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(refusal)),refusal);
  assert.equal(admit(input).ok,true); // deterministic
  assert.deepEqual(admit(clone(input)),out);
});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const IMPORT_SPECIFIER=/^[ \t]*(?:import|export)\b[^'";]*?\bfrom\s*'([^']+)'|^[ \t]*import\s*'([^']+)'/gm;
/** Relative-import closure of a module: every file reached through relative specifiers, and the external specifiers they name. */
function importClosure(entry) {
  const files=new Set(),external=new Set(),dynamic=[];
  const walk=file=>{
    if(files.has(file))return;
    files.add(file);
    const code=stripComments(readFileSync(file,'utf8'));
    if(/\bimport\s*\(|\brequire\s*\(/.test(code))dynamic.push(path.relative(root,file));
    for(const match of code.matchAll(IMPORT_SPECIFIER)) {
      const specifier=match[1]??match[2];
      if(specifier.startsWith('.'))walk(path.resolve(path.dirname(file),specifier));
      else external.add(specifier);
    }
  };
  walk(entry);
  return {files:[...files].map(file=>path.relative(root,file).split(path.sep).join('/')).sort(),external:[...external].sort(),dynamic};
}
test('purity: the transitive import closure reaches no database, file, timer, worker or process module and pins its external specifiers',()=>{
  const closure=importClosure(path.join(root,'src','multi-pine','member-admission.js'));
  for(const needed of ['src/multi-pine/codes.js','src/pine-bridge/source.js','src/postgres/pine-bridge-readiness.js','src/quant-research/contract.js','src/quant-library/package-gates.js','src/money.js'])
    assert.ok(closure.files.includes(needed),needed);
  assert.deepEqual(closure.dynamic,[],'no dynamic import or require anywhere in the closure');
  assert.deepEqual(closure.external,['decimal.js','node:crypto']);
  for(const forbidden of ['pg','node:fs','fs','node:timers','timers','worker_threads','node:worker_threads','child_process','node:child_process','node:net','node:http','node:https','node:process'])
    assert.ok(!closure.external.includes(forbidden),forbidden);
  assert.ok(!closure.files.some(file=>/^src\/postgres\/(?:db|pool|client)/.test(file)));
});
test('the module stays pure: the import list is closed and no I/O, clock, randomness or process access appears',()=>{
  const text=readFileSync(new URL('../src/multi-pine/member-admission.js',import.meta.url),'utf8');
  const imports=[...text.matchAll(/^import .* from '([^']+)';$/gm)].map(m=>m[1]).sort();
  assert.deepEqual(imports,['../money.js','../pine-bridge/source.js','../postgres/pine-bridge-readiness.js','../quant-library/package-gates.js','../quant-research/contract.js','./codes.js']);
  const code=text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  for(const banned of ['Date.now','new Date','Math.random','process.','require(','await ','async ','fetch(','setTimeout','readFile','writeFile','import(','randomUUID','Pool','.query(','.prepare(']) {
    assert.equal(code.includes(banned),false,banned);
  }
});
test('the module never throws, whatever the member rows hold',()=>{
  const junk=[undefined,null,0,'x',[],{},{deployment:{}},{deployment:{owner_id:OWNER,bot_id:BOT,snapshot:null}},{deployment:{owner_id:OWNER,bot_id:BOT,state:'DRAFT',snapshot:{},snapshot_hash:sha('x')}}];
  for(const member of junk)for(const context of [ctx,{},null,undefined])assert.doesNotThrow(()=>checkMemberAdmission(member,context));
  for(const input of [undefined,null,{},{members:[null,null]},{members:[{},{}]}])assert.doesNotThrow(()=>checkMemberSetAdmission(input));
  assert.doesNotThrow(()=>checkDatasetAdmission({dataset:null,dataset_span:null,capital_accounts:null,now:1,min_warmup_bars:1}));
  assert.doesNotThrow(()=>checkDatasetAdmission({dataset:DATASET,dataset_span:SPAN,capital_accounts:[null],now:NOW,min_warmup_bars:1006}));
});

/* ---------- code coverage ---------- */

test('every code the mirror returned in this file is a one-Pine code or a code of src/multi-pine/codes.js, and matches the code pattern',()=>{
  const oneCodes=new Set(['NOT_FOUND','SNAPSHOT_HASH_MISMATCH','BRIDGE_EXECUTION_EVIDENCE_REQUIRED','STALE_EVIDENCE','BRIDGE_EVIDENCE_FAILED','BRIDGE_EVIDENCE_INCOMPLETE','UNSUPPORTED_EXECUTION_MODEL',
    'RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED','SPOT_PAPER_POLICY_REQUIRED','UNSUPPORTED_CUSTOM_MARKET','UNSUPPORTED_SOURCE_HASH','CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED',
    'UNSUPPORTED_CUSTOM_SETTING','UNSUPPORTED_SIGNAL_MAPPING','INVALID_FIELDS','INVALID_NUMERIC_VALUE','INVALID_RESEARCH_DATASET','INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET',
    'VERIFIED_MARKET_DATA_REQUIRED','RESEARCH_CAPITAL_REQUIRED','BI_EXIT_VERSION_UNSUPPORTED']);
  const mp=new Set(Object.values(MP_CODES));
  assert.ok(seen.size>=20,String(seen.size));
  for(const code of seen) {
    assert.match(code,MP_CODE_PATTERN);
    assert.ok(oneCodes.has(code)||mp.has(code),code);
  }
  // Contract 5.1 step 3 codes, step 4, step 5 and step 6 codes all fired at least once above.
  for(const code of ['NOT_FOUND','SNAPSHOT_HASH_MISMATCH','BRIDGE_EXECUTION_EVIDENCE_REQUIRED','RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED','UNSUPPORTED_CUSTOM_MARKET','UNSUPPORTED_SOURCE_HASH',
    'CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED','UNSUPPORTED_CUSTOM_SETTING','UNSUPPORTED_SIGNAL_MAPPING',MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,MP_CODES.MEMBER_QUANT_UNSUPPORTED,
    'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET','RESEARCH_CAPITAL_REQUIRED',MP_CODES.EXIT_VERSION_MIXED,MP_CODES.EXECUTION_MODEL_MIXED,'BI_EXIT_VERSION_UNSUPPORTED'])assert.ok(seen.has(code),code);
});
