import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectSource,validateSelection,hash,canonical} from '../src/pine-bridge/source.js';
import {assemble} from '../src/pine-bridge/template.js';
import {CATALOG,lockInputs} from '../src/quant-research/contract.js';

// PROXY evidence only. The tracked file is a different Pine source than the
// owner-private supported SPT bytes; its defaults are not the reviewed Custom
// values. These tests prove structure (slots, domains, bridge literals), not
// supported-source values or real-data effect.
const source=fs.readFileSync(new URL('../tradingview/spt_pro_v4_robot_trade.pine',import.meta.url),'utf8');
const analysis=inspectSource(source);
const signals={buy:'buySignal',exit:'sellSignal',timing:'bar_close'};
const bridge={atr_multiplier:60,rr:1.5};
const bridgeDomains={atr_multiplier:{min:40,max:80,step:10},rr:{min:1,max:2,step:.25}};
const deployment={deployment_id:'12345678-1234-1234-1234-123456789abc',pine_import_id:'12345678-1234-1234-1234-123456789def',source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};

// Domains surround each proxy effective value, stay inside the declared min/max
// and are step-aligned to both the span and the baseline.
const domains={
  emaFastInput:{min:30,max:70,step:10},
  emaSlowInput:{min:150,max:250,step:25},
  atrLenInput:{min:10,max:20,step:2},
  stFactorInput:{min:2.6,max:3.4,step:.4},
  zoneAtrMultInput:{min:.6,max:1.4,step:.2},
  setupExpiryInput:{min:4,max:12,step:2},
  cooldownInput:{min:1,max:5,step:2},
  confirmLookback:{min:3,max:7,step:1},
  slAtrBufferInput:{min:.3,max:.7,step:.1},
  minRiskATRInput:{min:.3,max:.7,step:.1},
  rsiLen:{min:10,max:18,step:4},
};
const LOCK_ORDER=['emaFastInput','emaSlowInput','atrLenInput','stFactorInput','zoneAtrMultInput','setupExpiryInput','cooldownInput','confirmLookback'];
const SUBSET_B=['emaFastInput','emaSlowInput','atrLenInput','stFactorInput','zoneAtrMultInput','setupExpiryInput','slAtrBufferInput','minRiskATRInput'];
const inputOf=name=>{const found=analysis.inputs.find(i=>i.pine_variable===name);assert.ok(found,'proxy input '+name);return found;};
const slotsFor=names=>names.map((name,i)=>({slot:3+i,input_id:inputOf(name).input_id,...domains[name]}));
const reversedSlotsFor=names=>slotsFor(names).map((slot,i,all)=>({...slot,slot:all.length+2-i}));
const SUBSETS={
  'A owner lock order':{names:LOCK_ORDER,slots:slotsFor(LOCK_ORDER)},
  'B with slAtrBuffer and minRiskATR (reversed slots)':{names:SUBSET_B,slots:reversedSlotsFor(SUBSET_B)},
};
const readback=value=>JSON.parse(JSON.stringify(value));
const pineDefault=(pine,variable)=>{
  const match=pine.match(new RegExp('^'+variable+'[ ]*=[ ]*input[.]float[(][ ]*([^, )]+)[ ]*,','m'));
  assert.ok(match,'generated Pine input '+variable);
  return Number(match[1]);
};
const bridgeBindings=artifact=>[artifact.bindings.find(b=>b.slot===1),artifact.bindings.find(b=>b.slot===2)];
const declarationCount=(pine,name)=>pine.split(String.fromCharCode(10)).filter(line=>new RegExp('^'+name+'[ ]*=[ ]*input[.]').test(line)).length;

test('proxy source: every CATALOG name is an eligible numeric input and the proxy keeps the SPT signal mapping',()=>{
  assert.equal(Object.keys(CATALOG).length,10);
  for(const name of Object.keys(CATALOG)){
    const input=inputOf(name);
    assert.equal(input.eligible,true,name);
    assert.equal(input.type,CATALOG[name][2]?'int':'float',name);
  }
  assert.ok(analysis.declarations.includes('buySignal')&&analysis.declarations.includes('sellSignal'));
  assert.ok(analysis.inputs.filter(i=>i.eligible).length>Object.keys(CATALOG).length);
});

for(const [label,{names,slots}] of Object.entries(SUBSETS)){
  test('proxy roundtrip, subset '+label+': 8 source slots + ATR multiplier + RR survive assemble and JSON readback',()=>{
    assert.equal(names.length,8);
    const selection=validateSelection(analysis,signals,slots,bridge);
    assert.equal(selection.bindings.length,8);
    const artifact=readback(assemble(source,selection,deployment));
    assert.equal(canonical(artifact),canonical(readback(assemble(source,selection,deployment))));
    assert.equal(artifact.bindings.length,10);
    const slotNumbers=artifact.bindings.map(b=>b.slot);
    assert.equal(new Set(slotNumbers).size,10);
    assert.deepEqual([...slotNumbers].sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10]);
    assert.equal(artifact.source_diff.changed_original_bytes,0);
    assert.equal(artifact.source_hash,hash(source));
    assert.equal(artifact.integrated_pine.slice(0,source.length),source);
    assert.equal(artifact.fixed_inputs.length,analysis.inputs.length-8);
    // Source bindings: identity, slot, domain and effective value are unchanged after readback.
    const sourceBindings=artifact.bindings.filter(b=>b.origin==='source');
    assert.equal(sourceBindings.length,8);
    for(const [index,name] of names.entries()){
      const wanted=slots[index],found=sourceBindings.find(b=>b.pine_variable===name);
      assert.ok(found,name+' present after readback');
      assert.equal(found.slot,wanted.slot,name);
      assert.equal(found.input_id,wanted.input_id,name);
      assert.deepEqual(found.search_domain,{min:wanted.min,max:wanted.max,step:wanted.step},name);
      assert.equal(found.effective_value,inputOf(name).effective_value,name);
      assert.equal(found.optimization_status,'optimized',name);
    }
    // Bridge bindings: slots 1 and 2, and the literals really written into the Pine text.
    const [atr,rr]=bridgeBindings(artifact);
    assert.equal(atr.origin,'bridge');assert.equal(rr.origin,'bridge');
    assert.match(atr.pine_variable,/^rt_[0-9a-f]{12}_atrMult$/);
    assert.match(rr.pine_variable,/^rt_[0-9a-f]{12}_rr$/);
    assert.equal(atr.effective_value,bridge.atr_multiplier);
    assert.equal(rr.effective_value,bridge.rr);
    assert.equal(pineDefault(artifact.integrated_pine,atr.pine_variable),bridge.atr_multiplier);
    assert.equal(pineDefault(artifact.integrated_pine,rr.pine_variable),bridge.rr);
    // Each selected source declaration stays in the original bytes exactly once.
    for(const name of names)assert.equal(declarationCount(artifact.integrated_pine,name),1,name);
  });

  test('proxy lockInputs, subset '+label+': accepted, no UNSUPPORTED_CUSTOM_BINDING, 8 source bindings and ten domains',()=>{
    const lock=lockInputs(analysis,{signals,bridge},slots,bridgeDomains);
    assert.equal(lock.selection.bindings.length,8);
    assert.deepEqual(Object.keys(lock.domains).sort(),[...names,'atr_multiplier','rr'].sort());
    assert.equal(Object.keys(lock.domains).length,10);
    for(const name of names){
      const wanted=domains[name],grid=lock.domains[name];
      assert.equal(grid[0],wanted.min,name);assert.equal(grid.at(-1),wanted.max,name);
      assert.ok(grid.includes(inputOf(name).effective_value),name+' baseline on grid');
      assert.equal(lock.baseline[name],inputOf(name).effective_value,name);
    }
    assert.equal(lock.baseline.atr_multiplier,bridge.atr_multiplier);
    assert.equal(lock.baseline.rr,bridge.rr);
    assert.deepEqual(lock.domains.atr_multiplier,[40,50,60,70,80]);
    assert.deepEqual(lock.domains.rr,[1,1.25,1.5,1.75,2]);
    assert.match(lock.lock_hash,/^[0-9a-f]{64}$/);
    // The lock hash is stable across a JSON readback of the same inputs.
    assert.equal(lock.lock_hash,lockInputs(analysis,readback({signals,bridge}),readback(slots),readback(bridgeDomains)).lock_hash);
  });
}

test('proxy roundtrip: fractional Bridge ATR multiplier and RR are not truncated or rounded in Pine or bindings',()=>{
  const fractional={atr_multiplier:62.5,rr:1.75};
  const {slots}=SUBSETS['A owner lock order'];
  const artifact=readback(assemble(source,validateSelection(analysis,signals,slots,fractional),deployment));
  const [atr,rr]=bridgeBindings(artifact);
  assert.equal(atr.effective_value,62.5);assert.equal(rr.effective_value,1.75);
  assert.equal(pineDefault(artifact.integrated_pine,atr.pine_variable),62.5);
  assert.equal(pineDefault(artifact.integrated_pine,rr.pine_variable),1.75);
});

test('proxy slot contract: a ninth source slot fails INVALID_SLOT_COUNT',()=>{
  const {slots}=SUBSETS['A owner lock order'];
  const ninth={slot:10,input_id:inputOf('slAtrBufferInput').input_id,...domains.slAtrBufferInput};
  assert.equal(slots.length,8);
  assert.throws(()=>validateSelection(analysis,signals,[...slots,ninth],bridge),{code:'INVALID_SLOT_COUNT'});
  assert.throws(()=>lockInputs(analysis,{signals,bridge},[...slots,ninth],bridgeDomains),{code:'INVALID_SLOT_COUNT'});
  // Slots 1 and 2 belong to the Bridge: a source binding cannot take them.
  for(const slot of [1,2])assert.throws(()=>validateSelection(analysis,signals,[{...slots[0],slot}],bridge),{code:'INVALID_NUMERIC_VALUE'});
});

test('proxy CATALOG gate: an eligible non-CATALOG input is a valid Bridge selection but lockInputs rejects it',()=>{
  const {slots}=SUBSETS['A owner lock order'];
  const foreign=inputOf('rsiLen');
  assert.equal(foreign.eligible,true);
  assert.equal(Object.hasOwn(CATALOG,'rsiLen'),false);
  const swapped=[...slots.slice(0,7),{slot:10,input_id:foreign.input_id,...domains.rsiLen}];
  assert.equal(swapped.length,8);
  // The Bridge itself accepts it, so the optimizer gate is what blocks it.
  assert.equal(validateSelection(analysis,signals,swapped,bridge).bindings.length,8);
  assert.throws(()=>lockInputs(analysis,{signals,bridge},swapped,bridgeDomains),{code:'UNSUPPORTED_CUSTOM_BINDING'});
});

test('proxy slot contract: two source bindings on one slot number fail DUPLICATE_BINDING',()=>{
  const {slots}=SUBSETS['A owner lock order'];
  const clash=[...slots.slice(0,7),{...slots[7],slot:slots[0].slot}];
  assert.equal(clash.length,8);
  assert.throws(()=>validateSelection(analysis,signals,clash,bridge),{code:'DUPLICATE_BINDING'});
});
