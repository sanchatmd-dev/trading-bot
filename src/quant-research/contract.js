import {D} from '../money.js';
import {canonical,hash,keys,number,fail,validateSelection} from '../pine-bridge/source.js';

export const SOURCE_HASH='0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a';
export const CATALOG={emaFastInput:[1,500,true],emaSlowInput:[1,1000,true],atrLenInput:[1,500,true],stFactorInput:[.1,100,false],zoneAtrMultInput:[.1,100,false],setupExpiryInput:[1,100,true],cooldownInput:[0,100,true],confirmLookback:[2,50,true],slAtrBufferInput:[0,100,false],minRiskATRInput:[.05,100,false]};
export const RULES={minimum_closed_trades_train:5,minimum_closed_trades_validation:5,minimum_closed_trades_test:5,maximum_drawdown_percent:20,sensitivity_max_drop_percentage_points:2};

function domain(raw,baseline,limits){
  keys(raw,['min','max','step']);
  for(const key of ['min','max','step'])number(raw[key],{integer:limits[2]});
  const {min,max,step}=raw;
  if(min<limits[0]||max>limits[1]||min>=max||step<=0||baseline<min||baseline>max||!D(max).minus(min).mod(step).isZero()||!D(baseline).minus(min).mod(step).isZero())throw fail('INVALID_RESEARCH_GRID');
  const count=D(max).minus(min).div(step).plus(1).toNumber();
  if(count>1000)throw fail('RESEARCH_GRID_TOO_LARGE');
  return Array.from({length:count},(_,i)=>D(min).plus(D(step).mul(i)).toNumber());
}

export function lockInputs(analysis,selection,slots,bridgeDomains){
  keys(bridgeDomains,['atr_multiplier','rr']);
  const locked=validateSelection(analysis,selection.signals,slots,selection.bridge);
  const baseline=Object.fromEntries(locked.bindings.map(i=>[i.pine_variable,i.effective_value]));
  Object.assign(baseline,locked.bridge);
  const domains={atr_multiplier:domain(bridgeDomains.atr_multiplier,baseline.atr_multiplier,[.01,1000,false]),rr:domain(bridgeDomains.rr,baseline.rr,[.01,1000,false])};
  for(const input of locked.bindings){
    const limits=CATALOG[input.pine_variable];
    if(!limits)throw fail('UNSUPPORTED_CUSTOM_BINDING');
    if(input.type!==(limits[2]?'int':'float'))throw fail('INVALID_CUSTOM_INPUT_TYPE');
    number(input.effective_value,{integer:limits[2]});
    domains[input.pine_variable]=domain(input.search_domain,input.effective_value,limits);
  }
  return {selection:locked,baseline,domains,lock_hash:hash(canonical({selection:locked,domains}))};
}

export function validParameters(values,fixed){
  const fast=values.emaFastInput??fixed.emaFastInput,slow=values.emaSlowInput??fixed.emaSlowInput;
  return fast<slow;
}

export function candidatePlan(lock,budget,seed){
  const names=Object.keys(lock.domains).sort();
  number(budget,{min:1,max:100,integer:true});number(seed,{min:0,max:2147483647,integer:true});
  const fixed=Object.fromEntries([...lock.selection.fixed_inputs,...lock.selection.bindings].map(i=>[i.pine_variable,i.effective_value]));
  const rows=[],seen=new Set();
  const add=p=>{const key=canonical(p);if(validParameters(p,fixed)&&!seen.has(key)){seen.add(key);rows.push(p);}};
  add({...lock.baseline});
  // Adjacent values ensure every selected dimension actually participates.
  for(const name of names){
    const grid=lock.domains[name],at=grid.indexOf(lock.baseline[name]);
    for(const i of [at-1,at+1])if(i>=0&&i<grid.length)add({...lock.baseline,[name]:grid[i]});
  }
  if(rows.length>budget||names.some(n=>new Set(rows.map(p=>p[n])).size<2))throw fail('INSUFFICIENT_DIMENSION_BUDGET');
  const combinations=names.reduce((total,n)=>total*lock.domains[n].length,1);
  if(combinations<=budget){
    const walk=(i,p)=>{if(i===names.length){add(p);return;}for(const value of lock.domains[names[i]])walk(i+1,{...p,[names[i]]:value});};walk(0,{});
  }else{
    // Versioned deterministic PRNG: retries and recovery keep the identical plan.
    let state=seed>>>0;
    const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    for(let tries=0;rows.length<budget&&tries<budget*100;tries++)add(Object.fromEntries(names.map(n=>[n,lock.domains[n][Math.floor(next()*lock.domains[n].length)]])));
  }
  return {candidates:rows,algorithm:combinations<=budget?'exhaustive-grid-v1':'axis-covered-seeded-grid-v1',seed,requested_budget:budget,planned_candidates:rows.length,grid_combinations:combinations};
}

export function coverage(rows,domains){
  const names=Object.keys(domains),covered=names.filter(n=>new Set(rows.map(r=>r.parameters[n])).size>=2);
  return {selected_dimensions:names.length,covered_dimensions:covered.length,dimension_coverage_percent:Math.floor(100*covered.length/names.length)};
}
export function screen(result,baselineValidation){
  const errors=[];
  if(result.train.closed_trades<RULES.minimum_closed_trades_train)errors.push('INSUFFICIENT_TRAIN_TRADES');
  if(result.validation.closed_trades<RULES.minimum_closed_trades_validation)errors.push('INSUFFICIENT_VALIDATION_TRADES');
  if(D(result.validation.net_return_percent).lt(D(baselineValidation).gt(0)?baselineValidation:0))errors.push('VALIDATION_BELOW_BASELINE_OR_ZERO');
  if(D(result.validation.max_drawdown_percent).gt(RULES.maximum_drawdown_percent))errors.push('VALIDATION_DRAWDOWN_EXCEEDED');
  return errors;
}
