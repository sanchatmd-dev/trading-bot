import test from 'node:test';
import assert from 'node:assert/strict';
import {lockInputs,assertSelectionCoherence,candidatePlan,coverage,screen} from '../src/quant-research/contract.js';
import {fixture} from './helpers/quant-research-fixture.mjs';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {QuantResearchService} from '../src/postgres/quant-research.js';
const lock=()=>{const f=fixture();return lockInputs(f.analysis,f.selection,f.slots,f.bridge_domains);};
test('approved eight source slots and two Bridge grids bind 1:1 and cover all dimensions',()=>{
 const locked=lock(),plan=candidatePlan(locked,100,27);
 assert.equal(locked.selection.bindings.length,8);assert.equal(locked.selection.fixed_inputs.length,50);
 assert.equal(plan.planned_candidates,100);assert.deepEqual(plan,candidatePlan(locked,100,27));
 assert.equal(coverage(plan.candidates.map(parameters=>({parameters})),locked.domains).dimension_coverage_percent,100);
 assert.equal(locked.selection.fixed_inputs.find(i=>i.pine_variable==='slAtrBufferInput').effective_value,.6);
 assert.notDeepEqual(plan.candidates,candidatePlan(locked,100,28).candidates);
});
test('slot limit, duplicate mapping, boolean values and baseline off grid fail closed',()=>{
 const f=fixture();
 assert.throws(()=>lockInputs(f.analysis,f.selection,[...f.slots,f.slots[0]],f.bridge_domains),{code:'INVALID_SLOT_COUNT'});
 assert.throws(()=>lockInputs(f.analysis,f.selection,[f.slots[0],{...f.slots[0],slot:4}],f.bridge_domains),{code:'DUPLICATE_BINDING'});
 assert.throws(()=>lockInputs(f.analysis,f.selection,[{...f.slots[0],step:true}],f.bridge_domains));
 assert.throws(()=>lockInputs(f.analysis,f.selection,f.slots,{...f.bridge_domains,rr:{min:1,max:2,step:.2}}),{code:'INVALID_RESEARCH_GRID'});
 assert.throws(()=>candidatePlan(lock(),10,27),{code:'INSUFFICIENT_DIMENSION_BUDGET'});
});
test('zero validation trades remains NO_VALID_CANDIDATE screening',()=>{
 const result={train:{closed_trades:5},validation:{closed_trades:0,net_return_percent:'0',max_drawdown_percent:'0'}};
 assert.deepEqual(screen(result,'0'),['INSUFFICIENT_VALIDATION_TRADES']);
});


test('selection coherence ignores order and presentation metadata without mutation',()=>{
 const selected=lock().selection,deployed=structuredClone(selected);
 deployed.bindings.reverse();deployed.fixed_inputs.reverse();
 deployed.bindings[0].input_title='Display only';deployed.bindings[0].origin='reviewed';
 deployed.bindings[0].optimization_status='fixed';
 const before=structuredClone({deployed,selected});
 assert.doesNotThrow(()=>assertSelectionCoherence(deployed,selected));
 assert.deepEqual({deployed,selected},before);
 const f=fixture(),other=lockInputs(f.analysis,f.selection,f.slots,{...f.bridge_domains,rr:{min:.5,max:2.5,step:.5}});
 assert.doesNotThrow(()=>assertSelectionCoherence(selected,other.selection));
});

test('selection coherence rejects binding, effective map, signal and bridge drift',()=>{
 const selected=lock().selection;
 const changes=[
  s=>s.bindings.pop(),s=>s.bindings.push(s.bindings[0]),
  s=>{[s.bindings[0].slot,s.bindings[1].slot]=[s.bindings[1].slot,s.bindings[0].slot];},
  s=>{s.bindings[0].slot=10;},s=>{s.bindings[0].input_id='alternative';},
  s=>{s.bindings[0].pine_variable='alternative';},s=>{s.bindings[0].type='float';},
  s=>{s.bindings[0].effective_value+=10;},
  ...['min','max','step'].map(name=>s=>{s.bindings[0].search_domain[name]+=10;}),
  s=>{s.fixed_inputs[0].effective_value=.7;},s=>{delete s.fixed_inputs[0].effective_value;},s=>s.fixed_inputs.pop(),
  s=>{s.signals.buy='otherSignal';},s=>{s.bridge.rr=2;},
  s=>{delete s.bindings;},s=>{s.bindings=[];},s=>{s.fixed_inputs=null;},
  s=>{delete s.bindings[0].search_domain.step;},
  s=>{s.bindings[0].effective_value=NaN;},s=>{s.fixed_inputs.push(s.fixed_inputs[0]);}
 ];
 for(const change of changes){const deployed=structuredClone(selected);change(deployed);
  assert.throws(()=>assertSelectionCoherence(deployed,selected),{code:'RESEARCH_SELECTION_MISMATCH',status:409});
 }
 assert.throws(()=>assertSelectionCoherence(null,selected),{code:'RESEARCH_SELECTION_MISMATCH',status:409});
});

test('valid alternative source selection fails coherence; generic zero-to-eight selection stays supported',()=>{
 const f=fixture(),selected=lockInputs(f.analysis,f.selection,f.slots,f.bridge_domains).selection;
 const analysis=structuredClone(f.analysis),alternative=analysis.inputs.find(i=>i.pine_variable==='minRiskATRInput');
 alternative.eligible=true;
 const slots=[{slot:3,input_id:alternative.input_id,min:.25,max:.75,step:.25},...f.slots.slice(1)];
 const other=lockInputs(analysis,f.selection,slots,f.bridge_domains);
 assert.throws(()=>assertSelectionCoherence(selected,other.selection),{code:'RESEARCH_SELECTION_MISMATCH'});
 for(let count=0;count<=8;count++){
  const selection=lockInputs(f.analysis,f.selection,f.slots.slice(0,count),f.bridge_domains).selection;
  assert.doesNotThrow(()=>assertSelectionCoherence(selection,selection));
 }
});

test('exact historical retries return persisted jobs before selection or data validation in both modes',async()=>{
 const body={bot_id:'bot',deployment_id:'old-deployment',parameter_slots:[],bridge_domains:{},dataset:{},budget:1,seed:1};
 for(const foundation of [false,true]){
  const statements=[],old={run_id:'historical-job',submission_hash:hash(canonical(body)),contract:{snapshot:{selection:{bindings:[]}}}};
  const before=structuredClone(old);
  const db={lock:async()=>{},query:async sql=>{statements.push(sql);return {rows:[]};},
   prepare:sql=>{statements.push(sql);assert.match(sql,/FROM quant_jobs WHERE owner_id/);return {get:async()=>old};}};
  const service=new QuantResearchService({pineService:{db,store:{},authorize:async()=>{}},foundation,datasetStore:{}});
  service.executorMode=async()=>{};
  service.summary=async row=>{assert.equal(row,old);return {run_id:row.run_id};};
  assert.deepEqual(await service.enqueue('owner',body,'historical-key'),{run_id:old.run_id});
  assert.deepEqual(old,before);
  assert.equal(statements.some(sql=>sql.includes('pine_deployments')||sql.includes('pine_market_bars')),false);
  await assert.rejects(service.enqueue('owner',{...body,seed:2},'historical-key'),{code:'IDEMPOTENCY_CONFLICT',status:409});
 }
});
