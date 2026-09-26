import test from 'node:test';
import assert from 'node:assert/strict';
import {lockInputs,candidatePlan,coverage,screen} from '../src/quant-research/contract.js';
import {fixture} from './helpers/quant-research-fixture.mjs';
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
