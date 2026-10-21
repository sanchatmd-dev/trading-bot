import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSource} from '../src/pine-bridge/source.js';
import {reviewedInputs} from '../src/pine-bridge/input-review.js';
import {effectiveInputsHash} from '../src/multi-pine/fixture-service.js';

// F11 RS-5 (N1): the fixture service proves a member's effective inputs hash with its own copy of the recipe of reviewedInputs. This pure test ties that copy to the real
// producer: the analyses come from inspectSource and reviewedInputs (int, float, bool, time and string inputs), travel through JSON as a stored analysis does, and the hash
// of the service must equal the producer's effective_inputs_hash. A drift of either recipe fails here, not only in a database test.
const SOURCE=[
  '//@version=6','indicator("recipe")',
  'a = input.int(14, "A", minval=1, maxval=100)','b = input.float(1.5, "B")','c = input.bool(true, "C")',
  'd = input.time(timestamp("2024-01-01"), "D")','e = input.string("Any", "E", options=["Any","All"])','plot(close)',''].join('\n');
const OWNER='fixture-reviewer';

function review(values) {
  const analysis=inspectSource(SOURCE);
  const byVariable=Object.fromEntries(analysis.inputs.map(input=>[input.pine_variable,input.input_id]));
  const map=Object.fromEntries(Object.entries(values).map(([variable,value])=>[byVariable[variable],value]));
  return reviewedInputs(analysis,map,{source_hash:analysis.source_hash,confirmed:true},OWNER);
}
const roundTrip=value=>JSON.parse(JSON.stringify(value));

test('effectiveInputsHash equals the effective_inputs_hash of the real producer for int, float, bool, time and string inputs, after a JSON round trip',()=>{
  const cases=[
    {a:21,b:2.25,c:false,d:1700000000000,e:'All'},
    {a:14,b:1.5,c:true,d:1704067200000,e:'Any'},
    {a:1,b:0.1,c:true,d:0,e:'Any'},
    {a:100,b:-3.5e-7,c:false,d:-86400000,e:'All'},
    {a:50,b:123456.789,c:true,d:Number.MAX_SAFE_INTEGER,e:''}];
  const seen=new Set();
  for(const values of cases) {
    const produced=review(values);
    assert.deepEqual(new Set(produced.inputs.map(input=>input.type)),new Set(['int','float','bool','time','string']),'every input type is covered');
    assert.match(produced.effective_inputs_hash,/^[0-9a-f]{64}$/);
    const stored=roundTrip(produced);
    assert.equal(effectiveInputsHash(stored),stored.effective_inputs_hash,JSON.stringify(values));
    assert.equal(effectiveInputsHash(produced),produced.effective_inputs_hash);
    assert.equal(stored.effective_input_review.effective_inputs_hash,stored.effective_inputs_hash,'the review record carries the same hash');
    seen.add(stored.effective_inputs_hash);
  }
  assert.equal(seen.size,cases.length,'different effective inputs give different hashes');
});

test('effectiveInputsHash names the inputs it hashes: a changed value, a changed type of value or a hash that names other inputs no longer matches',()=>{
  const stored=roundTrip(review({a:21,b:2.25,c:false,d:1700000000000,e:'All'}));
  for(const [index,value] of [[0,22],[1,2.5],[2,true],[3,1700000000001],[4,'Any'],[0,'21']]) {
    const changed=roundTrip(stored);
    changed.inputs[index].effective_value=value;
    assert.notEqual(effectiveInputsHash(changed),stored.effective_inputs_hash,'input '+index+' = '+JSON.stringify(value));
  }
  // the declared default is not the effective value: only effective_value enters the recipe
  const other=roundTrip(stored);
  other.inputs[0].default=99;
  assert.equal(effectiveInputsHash(other),stored.effective_inputs_hash);
  // an analysis without inputs is not a hashable analysis
  assert.throws(()=>effectiveInputsHash({}),TypeError);
});
