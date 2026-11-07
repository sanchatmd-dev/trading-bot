import {canonical,hash} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {classify,MINUTE} from '../quant-library/derive.js';
import {readState} from '../quant-library/package-gates.js';
import {QUALIFICATION_VERSION} from '../selection/eligibility.js';
import {REQUIRED_MARKET,isObject,text,digest} from '../selection/codes.js';
import {gateSnapshot} from './quant-library.js';

/**
 * QR-4 slice Q4-B: the selection inputs reader. readSelectionInputs(tx, {owner_id, registered_at_ms, fixture, policy_hash}, ports) reads, on the caller's
 * handle (the registration transaction of registerSelection, SERIALIZABLE, so every row is read under the one snapshot that the clock read took), the
 * universe of the owner and the context facts that only the database can supply, and returns {universe, context} for the readInputs hook of registerSelection.
 * It writes nothing and holds no clock, random source or file.
 *
 * Universe (contract 3.4, 4.1, 4.3; RC-S16, RC-S18, RC-S20): every terminal research run of the owner on BINANCE:BTCUSDT Spot 1m, one member per run, in creation
 * order. FIXED_INPUT_EVAL rows are never members (they are not research runs). A customer selection leaves out labelled synthetic runs (fixture runs); a fixture
 * selection reads every run and lets the eligibility checks exclude a non-fixture package (E6 flipped). Per member:
 *   E1  library gates G1 to G8 from gateSnapshot (the detail-level read of the library, integrity recomputed from the stored rows); the label is derived from the
 *       gate states with the rule of library-qualification-v2 and pinned against the library detail view by a test;
 *   E2  the package of the run (RR-Q4-13: the latest ONE_PINE export, its last status event, and the live state the freshness rules compare against);
 *   E3  the ql4c_validation records of the run's exports, validated_at_utc copied verbatim (RC-S28);
 *   E5  the scope fields derived from the parent contract exactly as the fixed evaluation admission compares them: data_model, cost_model with risk_percent,
 *       capital as decimal strings, policy with the snapshot policy hash (RR-Q4-21);
 *   rules and rules_hash = SHA-256 of the canonical rules (RC-S5); the data windows of the run; the registered holdout boundary of its Bot.
 * The universe cap (RR-Q4-12, provisional 50) is checked before any member is built: a universe above it returns cap+1 bare members, so registration refuses
 * QR4_UNIVERSE_TOO_LARGE and nothing is truncated.
 *
 * Context (RR-Q4-20): policy_snapshot is {policy_hash, max_drawdown_percent}. The policy hash is the one the owner declared in the scope, accepted only when a
 * parent run of the owner carries it and its stored policy object hashes to it. The Risk Manager policy schema has no percent drawdown limit field (the
 * validated fields are the ranges in src/postgres/risk-policy-validation.js lines 20-30 and the defaults in src/config.js lines 33-49; maxDailyLossR is a daily loss
 * in R and is not a drawdown percentage), so a verified policy gives max_drawdown_percent null. A policy that cannot be verified gives policy_snapshot null, which
 * registration refuses as QR4_FILTER_INVALID with detail POLICY_SNAPSHOT_UNREADABLE. universe_cap is returned too. The reader never returns an objective registry,
 * a tolerance or a dependency fact (RC-S11).
 *
 * Freshness (the live state of E2) restates the reads of the one-Pine package service: connected memberships, the deployment tie, the input lock, the Bot policy
 * hash (from ports.readBotState; without it the policy hash is unknown and the package is not fresh) and the bars of the package dataset (bounded by the contract).
 * The live state is read only for a validated ONE_PINE export, the only package that can be READY. There is no replay event source in the package tables, so
 * replay_mismatch is false (the same fact the package service states); a source that appears later must feed it here.
 */
/** RR-Q4-12: provisional universe cap, measured in this slice (read p95 on a cap-sized universe) and fixed by Root. */
export const UNIVERSE_CAP=50;
export const TERMINAL_RUN_STATUSES=Object.freeze(['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
/** The policy fields of the Risk Manager that name a percent drawdown limit: none (see above). Kept as data so a future schema change is one reviewed edit. */
export const POLICY_DRAWDOWN_FIELDS=Object.freeze([]);
export const POLICY_SNAPSHOT_FIELDS=Object.freeze(['policy_hash','max_drawdown_percent']);
const MARKET_JSON=JSON.stringify(REQUIRED_MARKET);
const BOUNDARY_SCOPE=Object.freeze(['binance-global','SPOT','BTCUSDT','1']);
const GATE_ORDER=Object.freeze(['G1','G2','G3','G4','G5','G6','G7','G8']);

const PRESENT=`SELECT to_regclass('public.bi_exports') IS NOT NULL AND to_regclass('public.bi_status_events') IS NOT NULL AND to_regclass('public.ql4c_validation') IS NOT NULL AS packages,
 to_regclass('public.quant_holdout_boundaries') IS NOT NULL AS boundaries`;
// The market filter compares the three picked fields only (the marketKey rule): a real research contract copies the deployment snapshot, whose market also carries
// deployment_id, pine_import_id and source_version, so whole-object equality would drop every real run from the universe.
// A labelled synthetic run (its source or its label names a fixture) is a fixture run.
const LABELLED_SQL="((COALESCE(contract->>'source','') ~ 'LABELLED (SYNTHETIC|TEST FIXTURE)') OR (COALESCE(contract->>'label','') ~ 'LABELLED'))";
const RUN_IDS=`SELECT run_id FROM public.quant_jobs WHERE owner_id=$1 AND (contract->>'mode') IS DISTINCT FROM 'FIXED_INPUT_EVAL' AND status=ANY($2::text[])
 AND jsonb_build_object('broker',contract#>'{snapshot,market,broker}','symbol',contract#>'{snapshot,market,symbol}','timeframe',contract#>'{snapshot,market,timeframe}')=$3::jsonb AND ($4::boolean OR NOT ${LABELLED_SQL}) ORDER BY created_at,run_id LIMIT $5`;
// The slim contract drops the Pine source, the inline bars and the candidate plan (the library list projection); few is derived in SQL.
const RUNS=`SELECT j.run_id,j.bot_id,j.status,j.created_at,j.diagnostic,
 CASE WHEN jsonb_typeof(j.contract)='object' THEN j.contract - 'source' #- '{dataset,bars}' #- '{plan,candidates}' END AS k,
 COALESCE(CASE WHEN jsonb_typeof(j.result#>'{selected,screen_reasons}')='array' THEN (j.result#>'{selected,screen_reasons}') ? 'INSUFFICIENT_TEST_TRADES' END,false) AS few
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND j.run_id=ANY($2::text[]) ORDER BY j.created_at,j.run_id`;
const EXPORTS=`SELECT export_id,run_id,mode,fixture,package_hash,binding,created_at FROM public.bi_exports WHERE owner_id=$1 AND run_id=ANY($2::text[])
 ORDER BY run_id,(mode='ONE_PINE') DESC,created_at DESC,export_id`;
const EXPORT_BY_ID='SELECT export_id,run_id,mode,fixture,package_hash,binding,created_at FROM public.bi_exports WHERE owner_id=$1 AND export_id=$2';
const LAST_STATUS=`SELECT DISTINCT ON (export_id) export_id,status FROM public.bi_status_events WHERE export_id=ANY($1::uuid[]) ORDER BY export_id,seq DESC`;
const VALIDATIONS=`SELECT export_id,package_hash,binding_hash,fixture,validated_at_utc,gate_results FROM public.ql4c_validation WHERE export_id=ANY($1::uuid[])`;
const DEPLOYMENT_SQL='SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash FROM public.pine_deployments WHERE owner_id=$1 AND bot_id=$2 AND deployment_id=$3';
const MEMBERSHIP_SQL=`SELECT m.pine_import_id,m.source_version,r.source_hash FROM public.pine_memberships m
 JOIN public.pine_source_revisions r ON r.pine_import_id=m.pine_import_id AND r.source_version=m.source_version WHERE m.owner_id=$1 AND m.bot_id=$2 AND m.connected=true ORDER BY m.pine_import_id`;
const BAR_SQL=`SELECT bar_time,bar,provenance,content_hash FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=$1 AND bar_time<=$2 ORDER BY bar_time LIMIT $3`;
const BOUNDARY_SQL=`SELECT (SELECT min(sibling.holdout_start_time) FROM public.quant_holdout_boundaries sibling WHERE sibling.owner_id=own.owner_id
 AND sibling.venue=own.venue AND sibling.market=own.market AND sibling.symbol=own.symbol AND sibling.timeframe=own.timeframe) holdout_start_time
 FROM public.quant_holdout_boundaries own WHERE own.owner_id=$1 AND own.bot_id=$2 AND own.venue=$3 AND own.market=$4 AND own.symbol=$5 AND own.timeframe=$6`;
const MAX_BARS=10000;

const num=value=>{const parsed=typeof value==='number'?value:Number(value);return Number.isSafeInteger(parsed)?parsed:null;};
const decimal=value=>D(value).toFixed();
const object=value=>isObject(value)?value:{};

/** The library label from the gate states (library-qualification-v2): NOT_EVALUATED, NO_SCREENED_CANDIDATE, QUALIFIED or DEVELOPMENT_ONLY. Pinned against the library detail view. */
export function labelOfGates(gates){
  const states=GATE_ORDER.map(name=>(Array.isArray(gates)?gates.find(item=>isObject(item)&&item.gate===name):null)?.state);
  if(states[0]!=='PASS')return 'NOT_EVALUATED';
  if(states[1]!=='PASS')return 'NO_SCREENED_CANDIDATE';
  return states.every(state=>state==='PASS')?'QUALIFIED':'DEVELOPMENT_ONLY';
}

/** E5: the scope fields of a parent contract in the exact form the fixed evaluation admission compares (decimal strings, risk_percent in the cost model). Null when unreadable. */
export function scopeOfContract(contract,bindingPolicyVersion=null){
  try{
    const c=object(contract),model=object(c.model),capital=object(c.capital),snapshot=object(c.snapshot);
    const version=text(c.policy_version)?c.policy_version:text(bindingPolicyVersion)?bindingPolicyVersion:null;
    return {data_model:{data_profile:model.data_profile,price_tick:decimal(model.price_tick),quantity_step:decimal(model.quantity_step)},
      cost_model:{version:model.version,fee_bps:decimal(model.fee_bps),slippage_bps:decimal(model.slippage_bps),risk_percent:decimal(model.risk_percent)},
      capital:{equity:decimal(capital.equity),cash:decimal(capital.cash)},policy:{policy_version:version,policy_hash:snapshot.policy_hash}};
  }catch{return null;}
}

/** Half-open windows of a run in epoch ms (warm-up included, the convention of readSearchedWindows): dataset, train, validation, holdout. Null when unreadable. */
export function dataWindowsOf(contract){
  const c=object(contract),start=c.dataset?.start_time,split=c.split;
  if(!Number.isSafeInteger(start)||start<0||!isObject(split))return null;
  const {train_end:train,validation_end:validation,test_end:test}=split;
  if(![train,validation,test].every(Number.isSafeInteger)||!(train>0&&validation>train&&test>validation))return null;
  const at=index=>start+index*MINUTE;
  const end=Number.isSafeInteger(c.dataset.end_time)&&c.dataset.end_time>=start?c.dataset.end_time+MINUTE:at(test);
  return {dataset:{start_ms:start,end_ms:end},train:{start_ms:at(0),end_ms:at(train)},validation:{start_ms:at(train),end_ms:at(validation)},holdout:{start_ms:at(validation),end_ms:at(test)}};
}

/** The policy snapshot of RR-Q4-20 for the declared policy hash, or null (POLICY_SNAPSHOT_UNREADABLE). */
export function policySnapshotOf(rows,declaredHash){
  if(!/^[a-f0-9]{64}$/.test(typeof declaredHash==='string'?declaredHash:''))return null;
  for(const row of rows){
    const snapshot=object(object(row.k).snapshot);
    if(snapshot.policy_hash!==declaredHash||!isObject(snapshot.policy))continue;
    let verified=false;
    try{verified=hash(canonical(snapshot.policy))===declaredHash;}catch{verified=false;}
    if(!verified)continue;
    // A drawdown limit exists only in a field the schema names; the schema names none, so a verified policy defines no limit.
    const field=POLICY_DRAWDOWN_FIELDS.find(name=>Object.hasOwn(snapshot.policy,name));
    if(field!==undefined)return null;
    return {policy_hash:declaredHash,max_drawdown_percent:null};
  }
  return null;
}

/** The live state a package is compared with (freshness), restated from the package service. */
async function liveCurrent(tx,owner,row,exportRow,ports){
  const k=object(row.k),binding=object(exportRow.binding);
  const deployed=(await tx.query(DEPLOYMENT_SQL,[owner,row.bot_id,k.deployment_id])).rows[0]??null;
  const tied=deployed!==null&&deployed.pine_import_id===k.pine_import_id&&deployed.source_version===k.source_version&&deployed.snapshot_hash===k.baseline_snapshot_hash;
  const connected=(await tx.query(MEMBERSHIP_SQL,[owner,row.bot_id])).rows.map(item=>({pine_import_id:item.pine_import_id,source_version:item.source_version,source_hash:item.source_hash}));
  let policyHash;
  if(typeof ports.readBotState==='function'){
    const state=await ports.readBotState({bot_id:row.bot_id});
    policyHash=state?.policy_hash;
  }
  const own=connected.find(item=>item.pine_import_id===binding.pine_import_id);
  const sourceCurrent=own!==undefined&&own.source_version===binding.source_version&&own.source_hash===binding.source_hash;
  const dataset=await datasetDigest(tx,k.dataset);
  return {membership:connected,policy_version:binding.policy_version,policy_hash:policyHash,deployment_id:tied?deployed.deployment_id:null,
    input_lock_hash:tied&&sourceCurrent?binding.input_lock_hash:null,dataset_available:dataset!==null&&dataset===binding.dataset_ref?.sha256,bot_owner_id:deployed?.owner_id??null};
}
/** The digest of the contract bars as stored (the way the package was built), or null for a gap, a short range or a changed row. Bounded by the contract. */
async function datasetDigest(tx,dataset){
  const d=object(dataset);
  if(!Number.isSafeInteger(d.start_time)||!Number.isSafeInteger(d.end_time)||!Number.isSafeInteger(d.bar_count)||d.bar_count<1||d.bar_count>MAX_BARS)return null;
  const rows=(await tx.query(BAR_SQL,[d.start_time,d.end_time,d.bar_count+1])).rows;
  if(rows.length!==d.bar_count)return null;
  for(let index=0;index<rows.length;index++){
    const bar=rows[index];
    if(num(bar.bar_time)!==d.start_time+index*MINUTE||!isObject(bar.bar)||bar.bar.time!==num(bar.bar_time)||hash(canonical(bar.bar))!==bar.content_hash)return null;
  }
  return hash(canonical(rows.map(item=>({bar:item.bar,content_hash:item.content_hash,provenance:item.provenance}))));
}

const packageObject=(exportRow,status,current)=>({export_id:exportRow.export_id,package_hash:exportRow.package_hash,status,binding:structuredClone(exportRow.binding),current,replay_mismatch:false});
const validationRecord=item=>({run_id:item.run_id,mode:item.mode,record:{fixture:item.fixture,export_id:item.export_id,package_hash:item.package_hash,binding_hash:item.binding_hash,
  validated_at_utc:item.validated_at_utc,gate_results:item.gate_results}});

/** The state of one owner export for the read views: {ok, package, state:readState(...)}; NOT_FOUND (absent or foreign) is {ok:false}. READY is the same predicate as E2. */
export async function readPackageState(tx,{owner_id:owner,export_id:exportId},ports={}){
  if(!text(owner)||typeof exportId!=='string'||!/^[0-9a-f-]{36}$/.test(exportId))return {ok:false};
  const present=(await tx.query(PRESENT)).rows[0];
  if(present.packages!==true)return {ok:false};
  const exportRow=(await tx.query(EXPORT_BY_ID,[owner,exportId])).rows[0];
  if(!exportRow)return {ok:false};
  const status=(await tx.query(LAST_STATUS,[[exportId]])).rows[0]?.status??null;
  const row=(await tx.query(RUNS,[owner,[exportRow.run_id]])).rows[0];
  const current=row&&status==='EXPORT_VALIDATED'&&exportRow.mode==='ONE_PINE'?await liveCurrent(tx,owner,row,exportRow,ports):null;
  const view=packageObject(exportRow,status,current);
  return {ok:true,package:view,state:readState({status,binding:view.binding,current,replay_mismatch:false,requester_owner_id:owner})};
}

const bareUniverse=(rows,owner)=>rows.map(item=>({kind:'RESEARCH_RUN',owner_id:owner,run_id:item.run_id}));

export async function readSelectionInputs(tx,{owner_id:owner,registered_at_ms:registeredAt,fixture=false,policy_hash:declaredPolicy=null}={},ports={}){
  if(!tx||typeof tx.query!=='function'||!text(owner)||!Number.isSafeInteger(registeredAt))return {universe:null,context:{policy_snapshot:null,universe_cap:UNIVERSE_CAP}};
  const cap=Number.isSafeInteger(ports.universeCap)&&ports.universeCap>=1?ports.universeCap:UNIVERSE_CAP;
  const ids=(await tx.query(RUN_IDS,[owner,TERMINAL_RUN_STATUSES,MARKET_JSON,fixture===true,cap+1])).rows;
  const runs=ids.length===0?[]:(await tx.query(RUNS,[owner,ids.map(item=>item.run_id)])).rows;
  // Above the cap the members are bare (registration refuses on the count), but the scope check comes first, so the policy snapshot is still read from the slim contracts.
  if(ids.length>cap)return {universe:bareUniverse(ids,owner),context:{policy_snapshot:policySnapshotOf(runs,declaredPolicy),universe_cap:cap}};
  const present=(await tx.query(PRESENT)).rows[0];
  const runIds=runs.map(item=>item.run_id);
  const exportRows=present.packages===true&&runIds.length>0?(await tx.query(EXPORTS,[owner,runIds])).rows:[];
  const exportIds=exportRows.map(item=>item.export_id);
  const statuses=new Map(exportIds.length>0?(await tx.query(LAST_STATUS,[exportIds])).rows.map(item=>[item.export_id,item.status]):[]);
  const validations=exportIds.length>0?(await tx.query(VALIDATIONS,[exportIds])).rows:[];
  const exportsOfRun=new Map();
  for(const item of exportRows){
    const list=exportsOfRun.get(item.run_id)??[];
    list.push(item);exportsOfRun.set(item.run_id,list);
  }
  const boundaries=new Map();
  const boundaryOf=async botId=>{
    if(boundaries.has(botId))return boundaries.get(botId);
    let value;
    // The table is absent: nothing can prove that no boundary exists, so the value is unreadable (undefined) and a participant with it is refused at the window step.
    if(present.boundaries!==true)value=undefined;
    else{
      const rows=(await tx.query(BOUNDARY_SQL,[owner,botId,...BOUNDARY_SCOPE])).rows;
      value=rows.length===0?null:(num(rows[0].holdout_start_time)??undefined);
    }
    boundaries.set(botId,value);
    return value;
  };
  const universe=[];
  for(const row of runs){
    const k=object(row.k);
    let gates=null;
    try{gates=await gateSnapshot(tx,owner,row.run_id);}
    catch(error){if(error?.status!==404)throw error;}
    const qualification=gates===null?null:{version:QUALIFICATION_VERSION,label:labelOfGates(gates.gates),qualified:GATE_ORDER.every(name=>gates.gates.find(item=>item.gate===name)?.state==='PASS'),
      gates:gates.gates.map(item=>({...item}))};
    // The detail-level read is the integrity check; G1 passes only when the stored contract, result and checkpoints agree.
    const integrityChecked=gates!==null&&gates.gates.find(item=>item.gate==='G1')?.state==='PASS';
    const list=exportsOfRun.get(row.run_id)??[];
    const chosen=list[0]??null;
    const status=chosen?statuses.get(chosen.export_id)??null:null;
    const current=chosen&&status==='EXPORT_VALIDATED'&&chosen.mode==='ONE_PINE'?await liveCurrent(tx,owner,row,chosen,ports):null;
    const rules=isObject(k.rules)?k.rules:null;
    const library=classify({status:row.status,diagnostic:row.diagnostic,holdoutTooFewTrades:row.few===true});
    universe.push({kind:'RESEARCH_RUN',owner_id:owner,run_id:row.run_id,created_at_ms:num(row.created_at)??0,run_status:row.status,source_hash:k.source_hash,
      market:object(object(k.snapshot).market),library_class:library.library_class,export_id:chosen?chosen.export_id:null,qualification,integrity_checked:integrityChecked,
      package:chosen?packageObject(chosen,status,current):null,
      validation_records:validations.filter(item=>list.some(entry=>entry.export_id===item.export_id)).map(item=>validationRecord({...item,run_id:row.run_id,mode:list.find(entry=>entry.export_id===item.export_id).mode})),
      scope:scopeOfContract(k,chosen?.binding?.policy_version??null)??{},rules,rules_hash:rules===null?null:digest(rules),data_windows:dataWindowsOf(k),
      registered_boundary_ms:await boundaryOf(row.bot_id)});
  }
  return {universe,context:{policy_snapshot:policySnapshotOf(runs,declaredPolicy),universe_cap:cap}};
}
