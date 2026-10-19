import {hash,canonical} from '../../src/pine-bridge/source.js';

/**
 * PM-1 F02-02 gate tests: synthetic Pine sources, a counting provider stub and a deployment evidence builder.
 * Synthetic engineering fixtures only. They say nothing about the owner-private supported SPT source or strategy performance.
 */

// ---- 58-input source: same input names and effective values as test/helpers/quant-research-fixture.mjs, as real Pine lines ----
// [pine_variable, type, default, min, max, step] of the eight Quant Lab CATALOG inputs, the baseline value and the slot domain.
export const CATALOG_SLOTS=Object.freeze([
  ['emaFastInput','int',50,30,70,10],
  ['emaSlowInput','int',200,150,250,25],
  ['atrLenInput','int',14,10,20,2],
  ['stFactorInput','float',3.2,2.4,4,0.4],
  ['zoneAtrMultInput','float',1.15,0.75,1.55,0.2],
  ['setupExpiryInput','int',48,24,72,12],
  ['cooldownInput','int',8,4,12,2],
  ['confirmLookback','int',5,3,7,1]
]);
const EXTRA_NUMERIC=[['slAtrBufferInput','float',0.6],['minRiskATRInput','float',0.5]];
// The eleven reviewed Custom settings that QuantResearchService.enqueue checks by name.
const SETTINGS=[
  ['preset','string','Custom'],['tradeDirectionectionection','string','Long + Exit'],['useSlowFilter','bool',true],['useMTF','bool',false],
  ['useRSIFilter','bool',false],['requireBOS','bool',false],['requireSweep','bool',false],['slMode','string','Zone + ATR'],
  ['useSession','bool',false],['confirmMode','string','Any'],['notifyEnabled','bool',false]
];
const line=(name,type,value)=>{
  if(type==='string')return name+' = input.string("'+value+'", "'+name+'")';
  if(type==='bool')return name+' = input.bool('+value+', "'+name+'")';
  return name+' = input.'+type+'('+value+', "'+name+'", minval=0, maxval=1000)';
};
const declared=[
  ...CATALOG_SLOTS.map(([name,type,value])=>[name,type,value]),
  ...EXTRA_NUMERIC,
  ...SETTINGS
];
while(declared.length<58)declared.push(['fixed_'+declared.length,'bool',false]);
export const BIG_INPUT_COUNT=declared.length;
export const bigSource=['//@version=6','indicator("PM1 gate fixture 58")',...declared.map(([name,type,value])=>line(name,type,value)),'buySignal = close > open','sellSignal = close < open'].join('\n');
export const BIG_SIGNALS=Object.freeze({buy:'buySignal',exit:'sellSignal',timing:'bar_close'});

// ---- small source: ten numeric inputs, for the refusal and immutability tests ----
export const smallSource=['//@version=6','indicator("PM1 gate fixture small")',...Array.from({length:10},(_,i)=>'p'+(i+1)+'=input.'+(i%2?'float':'int')+'('+(10+i)+(i%2?'.5':'')+', minval=1, maxval=100)'),'buy=close>open','sell=close<open'].join('\n');
export const SMALL_SIGNALS=Object.freeze({buy:'buy',exit:'sell',timing:'bar_close'});

export const PROVIDER_CONFIG=Object.freeze({provider:'fixture',model:'fixture',inputRate:.1,outputRate:.2,rateVersion:'fixture-v1'});

/**
 * Counting provider stub. `calls` records the operation of every provider.run call, so a test can assert zero calls.
 * `eligible(request)` picks the ids returned by an analysis; the default returns every eligible numeric input.
 */
export function countingProvider({buy,exit,eligible=request=>request.analysis.inputs.filter(i=>i.eligible).map(i=>i.input_id),invalid=false}){
  const calls=[];
  return {calls,run:async request=>{
    calls.push(request.operation);
    const value=invalid?{buy:'injected()'}:{buy,exit,diagnostics:[],...(request.operation==='analyze'?{eligible_inputs:eligible(request)}:{})};
    return {value,usage:{input_tokens:50,output_tokens:30,cost_usd:.000011},request_id:'fixture'};
  }};
}

/** Slot request list for the eight CATALOG inputs, slot numbers 3..10, in lock order. */
export const catalogSlots=analysis=>CATALOG_SLOTS.map(([name,,,min,max,step],i)=>{
  const input=analysis.inputs.find(candidate=>candidate.pine_variable===name);
  if(!input)throw new Error('fixture input missing '+name);
  return {slot:i+3,input_id:input.input_id,min,max,step};
});
export const BRIDGE_DOMAINS=Object.freeze({atr_multiplier:{min:40,max:80,step:10},rr:{min:1,max:2,step:.25}});

/** Passing Bridge/Paper evidence for one stored deployment (same shape as test/postgres/pine-bridge.test.mjs). */
export function evidenceFor(d){
  return {snapshot_hash:d.snapshot_hash,artifact_hash:d.snapshot.artifact_hash,source_hash:d.snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
}

/** Verified synthetic one-minute bars as research enqueue reads them (decimal strings, content hash per bar). */
export function syntheticBar(time){
  const bar={time,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
  return {bar,provenance:{profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'},content_hash:hash(canonical(bar))};
}
