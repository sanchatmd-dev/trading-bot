import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSource,hash} from '../src/pine-bridge/source.js';
import {reviewFields,reviewedInputs} from '../src/pine-bridge/input-review.js';
import {providerMessages} from '../src/pine-bridge/provider.js';

const source='//@version=6\nindicator("Review")\npreset=input.string("Daily/Swing")\nfast=input.int(10,minval=1,maxval=30)\nenabled=input.bool(true)\nnotice=input.string("")\nstart=input.time(timestamp("2020-01-01T00:00:00"))\nbuy=close>open\nexit=close<open';
const analysis=inspectSource(source);
const byName=Object.fromEntries(analysis.inputs.map(input=>[input.pine_variable,input.input_id]));

test('local inspection provides typed default hints without AI dispatch',()=>{
  const hints=Object.fromEntries(reviewFields(analysis).map(input=>[input.pine_variable,input.default_hint]));
  assert.equal(hints.preset,'Daily/Swing');
  assert.equal(hints.fast,10);
  assert.equal(hints.enabled,true);
  assert.equal(hints.notice,'');
  assert.equal(hints.start,1577836800000);
  assert.equal(analysis.source_hash,hash(source));
});

test('complete reviewed map binds effective values and rejects changed source or missing input',()=>{
  const values={[byName.preset]:'Custom',[byName.fast]:12,[byName.enabled]:false,[byName.notice]:'private text',[byName.start]:1577836800000};
  const confirmed={source_hash:analysis.source_hash,confirmed:true};
  const reviewed=reviewedInputs(analysis,values,confirmed,'owner');
  assert.equal(reviewed.inputs.find(input=>input.pine_variable==='preset').effective_value,'Custom');
  assert.equal(reviewed.inputs.find(input=>input.pine_variable==='fast').effective_value,12);
  assert.equal(reviewed.effective_input_review.effective_inputs_hash,reviewed.effective_inputs_hash);
  assert.equal(reviewed.effective_input_review.reviewed_by,'owner');
  assert.equal(reviewed.effective_input_review.input_count,5);
  assert.throws(()=>reviewedInputs(analysis,{...values,[byName.fast]:undefined},confirmed,'owner'));
  const incomplete={...values};delete incomplete[byName.fast];
  assert.throws(()=>reviewedInputs(analysis,incomplete,confirmed,'owner'),{code:'INVALID_FIELDS'});
  assert.throws(()=>reviewedInputs(analysis,values,{...confirmed,source_hash:'changed'},'owner'),{code:'EFFECTIVE_INPUT_REVIEW_REQUIRED'});
  assert.throws(()=>reviewedInputs(analysis,{...values,[byName.fast]:31},confirmed,'owner'));
  assert.throws(()=>reviewedInputs(analysis,{...values,[byName.enabled]:'false'},confirmed,'owner'));
});

test('AI metadata receives Custom mode but excludes reviewed owner text',()=>{
  const values={[byName.preset]:'Custom',[byName.fast]:12,[byName.enabled]:false,[byName.notice]:'private text',[byName.start]:1577836800000};
  const reviewed=reviewedInputs(analysis,values,{source_hash:analysis.source_hash,confirmed:true},'owner');
  const message=providerMessages({operation:'analyze',analysis:reviewed,selection:null},source)[1].content;
  assert.match(message,/"effective_value":"Custom"/);
  assert.doesNotMatch(message,/private text/);
  assert.doesNotMatch(message,/1577836800000/);
});
