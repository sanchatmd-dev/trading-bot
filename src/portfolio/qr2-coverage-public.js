import {buildBarCoverage,validateBarCoverage} from './qr2-coverage.js';
import {coverageError,planCoverage,validateCoverageSnapshot} from './qr2-coverage-snapshot.js';
import {assembleGaps} from '../market-gap-intervals.js';
import {QR2_COVERAGE_LIMITS} from './qr2-coverage-limits.js';

export const OWNER_COVERAGE_VERSION='qr2-owner-bar-coverage-v1';
export const OWNER_COVERAGE_INVALID='QR2_OWNER_COVERAGE_INVALID';
const M=60000;
const fail=code=>{throw coverageError(code);};
const input=condition=>{if(!condition)fail('QR2_INPUT_INVALID');};
const report=condition=>{if(!condition)fail('QR2_REPORT_FAILED');};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,names)=>plain(value)&&Reflect.ownKeys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const sameMarket=(a,b)=>a===null?b===null:b!==null&&a.broker===b.broker&&a.symbol===b.symbol&&a.timeframe===b.timeframe;
const sameRange=(a,b)=>a===null?b===null:b!==null&&a.from===b.from&&a.to===b.to;
const bytes=value=>Buffer.byteLength(JSON.stringify(value));

/** Size gate for one serialized public object. The estimate comes first: above the estimator bound is an
 * estimator defect and fails closed whatever the limit is. Only a size within the estimate that is above
 * the effective limit (a lowered limit) refuses the whole request.
 */
export function admitSerializedBytes(actual,estimate,limit){
  report(actual<=estimate);
  if(actual>limit)fail('QR2_RANGE_ADMISSION_REFUSED');
}

// Outputs are immutable: entries are shared by the owner envelope and by every member bound to the same window.
function lock(value){
  if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))lock(item);}
  return value;
}

/** Intervals come from the union array between the registry indexes. Nothing is sliced, copied or sorted. */
function windowCoverage(registry,w){
  const {market,resolved_range}=w;
  if(w.union_id===null)return buildBarCoverage({resolved_range,market,fact:{state:'NOT_NEEDED'}});
  const fact=registry.unions[w.union_id].fact;
  // The absent-table build is the exact Stage 1 head for a window that has an inspected range.
  const coverage=buildBarCoverage({resolved_range,market,fact:{state:'TABLE_ABSENT'}});
  if(fact.state==='TABLE_ABSENT')return coverage;
  const values=fact.timestamps,{start_index:start,end_index:stop}=w,{from:lower,to:end}=coverage.inspected_window,internal=[];
  let previous=lower;
  for(let i=start;i<stop;i++){
    const time=values[i];
    if(i>start&&time-previous>M)internal.push({prev:previous,bar_time:time});
    previous=time;
  }
  const n=stop-start;
  const gaps=assembleGaps({lower,end,n,first:n?values[start]:null,last:n?previous:null,internal,internalTotal:internal.length},internal.length+2);
  report(!gaps.truncated);
  const intervals=gaps.ranges.map(gap=>({from:gap.from_open_time,to:gap.to_open_time+M,missing_minutes:gap.missing_minutes}));
  return Object.assign(coverage,{state:'COMPLETE',reason:null,complete:true,expected_minutes:(end-lower)/M,stored_minutes:n,missing_minutes:gaps.missing_minutes,interval_count:intervals.length,intervals});
}

/**
 * Pure projection of a Stage 2 registry into the public coverage shapes. Unwired: no worker, route or UI imports it.
 * registry: qr2-coverage-snapshot-v1 object. context: {accounts,budgets}, the independently authorized Stage 2C input.
 * outputByteLimit: optional, lowering only. It never raises coverage_output_bytes.
 * Returns {owner:{market_coverage},accounts:[{bot_id,broker,market_data:{coverage}}]}. Any failure throws and returns nothing.
 */
export function projectPublicCoverage(registry,context,outputByteLimit){
  const outcome=projectOutcome(registry,context,outputByteLimit);
  if(outcome.refused)fail('QR2_RANGE_ADMISSION_REFUSED');
  return outcome.projection;
}

/**
 * Same projection as projectPublicCoverage, sharing one implementation. Returns {refused:false,projection} on success and
 * {refused:true} only for the post-build admitSerializedBytes refusal (the lowered-limit refusal). Every other failure throws
 * exactly as projectPublicCoverage does, including a QR2_RANGE_ADMISSION_REFUSED raised before the entries are built.
 */
export function projectPublicCoverageOutcome(registry,context,outputByteLimit){
  return projectOutcome(registry,context,outputByteLimit);
}

function projectOutcome(registry,context,outputByteLimit){
  input(closed(context,['accounts','budgets']));
  input(outputByteLimit===undefined||(Number.isSafeInteger(outputByteLimit)&&outputByteLimit>0));
  validateCoverageSnapshot(registry,context);
  const {budgets}=context,{charges}=registry,upper=charges.output_bytes_upper_bound;
  // Bound first: nothing is allocated for an envelope the registry already says is over budget.
  report(upper<=budgets.coverage_output_bytes);
  const limit=outputByteLimit===undefined?budgets.coverage_output_bytes:Math.min(outputByteLimit,budgets.coverage_output_bytes);
  const entries=[];
  let intervals=0;
  for(const w of registry.windows){
    const coverage=windowCoverage(registry,w);
    report(coverage.expected_minutes===w.expected_minutes&&coverage.stored_minutes===w.stored_minutes&&coverage.missing_minutes===w.missing_minutes&&coverage.interval_count===w.interval_count);
    intervals+=coverage.interval_count??0;
    entries.push({id:'coverage:'+w.id,coverage});
  }
  report(intervals===charges.output_intervals);
  const owner={market_coverage:{version:OWNER_COVERAGE_VERSION,entries,accounts:registry.bindings.map(b=>({bot_id:b.bot_id,broker:b.broker,coverage_ids:['coverage:'+b.window_id]}))}};
  report(validateOwnerCoverage(owner,context).ok);
  // Only this block can report the lowered-limit refusal: every earlier step has already succeeded or thrown.
  try{
    admitSerializedBytes(bytes(owner),upper,limit);
    for(const entry of entries)admitSerializedBytes(bytes({market_data:{coverage:entry.coverage}}),upper,limit);
  }catch(error){
    if(error?.code==='QR2_RANGE_ADMISSION_REFUSED')return {refused:true};
    throw error;
  }
  return {refused:false,projection:lock({owner,accounts:registry.bindings.map(b=>({bot_id:b.bot_id,broker:b.broker,market_data:{coverage:entries[b.window_id].coverage}}))})};
}

function need(condition,path){
  if(condition)return;
  const error=new TypeError('Invalid QR-2 owner coverage: '+path);error.code=OWNER_COVERAGE_INVALID;error.path=path;throw error;
}
function keys(value,names,path){need(closed(value,names),path);}
const isData=(value,key)=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value');
function dense(value,path){
  need(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&Reflect.ownKeys(value).length===value.length+1,path);
  for(let i=0;i<value.length;i++)need(Object.hasOwn(value,i)&&isData(value,i),path);
}
// Every reachable object is a plain data object or a real dense array. No accessor runs, no symbol key, no deep chain.
function data(value,path,depth=0){
  if(value===null)return;
  if(typeof value!=='object'){need(['string','number','boolean'].includes(typeof value),path);return;}
  need(depth<=8,path);
  if(Array.isArray(value)){dense(value,path);for(let i=0;i<value.length;i++)data(value[i],path+'.'+i,depth+1);return;}
  need(plain(value),path);
  for(const key of Reflect.ownKeys(value)){need(typeof key==='string'&&isData(value,key),path);data(value[key],path+'.'+key,depth+1);}
}

/** Closed validator for the owner envelope against the independently authorized context. Returns {ok,errors}. */
export function validateOwnerCoverage(value,context){
  input(closed(context,['accounts','budgets']));
  const plan=planCoverage({accounts:context.accounts,budgets:context.budgets});
  try{
    data(value,'envelope');
    keys(value,['market_coverage'],'envelope');
    const section=value.market_coverage;
    keys(section,['version','entries','accounts'],'market_coverage');
    need(section.version===OWNER_COVERAGE_VERSION,'version');
    const {entries,accounts}=section;
    dense(entries,'entries');dense(accounts,'accounts');
    need(entries.length===plan.windows.length,'entries.length');
    for(let i=0;i<entries.length;i++){
      const entry=entries[i],w=plan.windows[i];
      keys(entry,['id','coverage'],'entries.'+i);
      need(entry.id==='coverage:'+i,'entries.'+i+'.id');
      need(validateBarCoverage(entry.coverage).ok,'entries.'+i+'.coverage');
      need(sameMarket(entry.coverage.market,w.market)&&sameRange(entry.coverage.resolved_range,w.resolved_range),'entries.'+i+'.window');
    }
    const referenced=entries.map(()=>false),seen=new Set(),targets=[];
    for(let j=0;j<accounts.length;j++){
      const account=accounts[j];
      keys(account,['bot_id','broker','coverage_ids'],'accounts.'+j);
      need(typeof account.bot_id==='string'&&typeof account.broker==='string','accounts.'+j);
      const pair=JSON.stringify([account.bot_id,account.broker]);
      need(!seen.has(pair),'accounts.'+j+'.duplicate');seen.add(pair);
      dense(account.coverage_ids,'accounts.'+j+'.coverage_ids');
      need(account.coverage_ids.length===1,'accounts.'+j+'.coverage_ids');
      const id=account.coverage_ids[0],match=typeof id==='string'?/^coverage:(0|[1-9][0-9]*)$/.exec(id):null,index=match?Number(match[1]):-1;
      need(index>=0&&index<entries.length,'accounts.'+j+'.coverage_ids.unresolved');
      referenced[index]=true;targets.push(index);
    }
    need(referenced.every(Boolean),'entries.orphan');
    need(accounts.length===plan.bindings.length,'accounts.set');
    for(let j=0;j<accounts.length;j++){
      const binding=plan.bindings[j];
      need(accounts[j].bot_id===binding.bot_id&&accounts[j].broker===binding.broker,'accounts.'+j+'.set');
      need(targets[j]===binding.window_id,'accounts.'+j+'.mapping');
    }
    return {ok:true,errors:[]};
  }catch(error){
    // Context errors are thrown above. Anything unexpected about the envelope itself is a fixed-code rejection.
    if(error?.code===OWNER_COVERAGE_INVALID)return {ok:false,errors:[{code:error.code,path:error.path}]};
    return {ok:false,errors:[{code:OWNER_COVERAGE_INVALID,path:'envelope'}]};
  }
}

const shapeMarketKey=market=>market===null?'':market.broker+'\u0000'+market.symbol+'\u0000'+market.timeframe;
const shapeRangeCompare=(a,b)=>a===null?(b===null?0:-1):b===null?1:a.from-b.from||a.to-b.to;
const shapeCompare=(a,b)=>a<b?-1:a>b?1:0;

/**
 * Context-free closed validator for the market_coverage envelope object (not the {market_coverage} wrapper). Returns {ok,errors}.
 * It proves shape, order, mapping and sums only. It cannot prove the entries match the authorized accounts; validateOwnerCoverage does.
 */
export function validateOwnerCoverageShape(value){
  try{
    data(value,'market_coverage');
    keys(value,['version','entries','accounts'],'market_coverage');
    need(value.version===OWNER_COVERAGE_VERSION,'version');
    const {entries,accounts}=value;
    dense(entries,'entries');dense(accounts,'accounts');
    need(entries.length<=QR2_COVERAGE_LIMITS.unique_windows,'entries.length');
    need(accounts.length<=20,'accounts.length');
    let intervals=0;
    for(let i=0;i<entries.length;i++){
      const entry=entries[i];
      keys(entry,['id','coverage'],'entries.'+i);
      need(entry.id==='coverage:'+i,'entries.'+i+'.id');
      need(validateBarCoverage(entry.coverage).ok,'entries.'+i+'.coverage');
      if(i>0){
        const before=entries[i-1].coverage,now=entry.coverage;
        const order=shapeCompare(shapeMarketKey(before.market),shapeMarketKey(now.market))||shapeRangeCompare(before.resolved_range,now.resolved_range);
        need(order<0,'entries.'+i+'.order');
      }
      intervals+=entry.coverage.interval_count??0;
    }
    need(intervals<=QR2_COVERAGE_LIMITS.output_intervals,'entries.intervals');
    const referenced=entries.map(()=>false);
    for(let j=0;j<accounts.length;j++){
      const account=accounts[j];
      keys(account,['bot_id','broker','coverage_ids'],'accounts.'+j);
      need(typeof account.bot_id==='string'&&typeof account.broker==='string','accounts.'+j);
      if(j>0){
        const before=accounts[j-1];
        need((shapeCompare(before.bot_id,account.bot_id)||shapeCompare(before.broker,account.broker))<0,'accounts.'+j+'.order');
      }
      dense(account.coverage_ids,'accounts.'+j+'.coverage_ids');
      need(account.coverage_ids.length===1,'accounts.'+j+'.coverage_ids');
      const id=account.coverage_ids[0],match=typeof id==='string'?/^coverage:(0|[1-9][0-9]*)$/.exec(id):null,index=match?Number(match[1]):-1;
      need(index>=0&&index<entries.length,'accounts.'+j+'.coverage_ids.unresolved');
      referenced[index]=true;
      need((entries[index].coverage.market===null)===(account.broker!=='binance-global'),'accounts.'+j+'.market');
    }
    need(referenced.every(Boolean),'entries.orphan');
    return {ok:true,errors:[]};
  }catch(error){
    if(error?.code===OWNER_COVERAGE_INVALID)return {ok:false,errors:[{code:error.code,path:error.path}]};
    return {ok:false,errors:[{code:OWNER_COVERAGE_INVALID,path:'market_coverage'}]};
  }
}
