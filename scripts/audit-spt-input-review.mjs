// Isolated, read-only check of the owner-private SPT bundle. Prints no source or values.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {inspectSource} from '../src/pine-bridge/source.js';
import {reviewFields,reviewedInputs} from '../src/pine-bridge/input-review.js';
import {providerMessages} from '../src/pine-bridge/provider.js';

const path=process.argv[2];
if(!path)throw new Error('Usage: node scripts/audit-spt-input-review.mjs PRIVATE_BUNDLE_JSON');
const bundle=JSON.parse(fs.readFileSync(path,'utf8'));
const source=bundle.revision.source,analysis=inspectSource(source),fields=reviewFields(analysis);
assert.equal(analysis.source_hash,'0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a');
assert.equal(fields.length,58);
assert.equal(fields.filter(row=>row.default_hint===null).length,0);
const custom={preset:'Custom',stFactorInput:3.2,zoneAtrMultInput:1.15,setupExpiryInput:48,cooldownInput:8,slAtrBufferInput:0.6,notifyEnabled:false};
const values=Object.fromEntries(fields.map(row=>[row.input_id,Object.hasOwn(custom,row.pine_variable)?custom[row.pine_variable]:row.default_hint]));
const reviewed=reviewedInputs(analysis,values,{source_hash:analysis.source_hash,confirmed:true},'isolated-staging-review');
const effective=Object.fromEntries(reviewed.inputs.map(row=>[row.pine_variable,row.effective_value]));
for(const [name,value] of Object.entries(custom))assert.equal(effective[name],value);
assert.equal(reviewed.effective_input_review.input_count,58);
assert.equal(reviewed.effective_input_review.effective_inputs_hash,reviewed.effective_inputs_hash);
const metadata=providerMessages({operation:'analyze',analysis:reviewed,selection:null},source)[1].content.split('\n\nUNTRUSTED PINE SOURCE')[0];
assert.ok(metadata.includes('"effective_value":"Custom"'));
assert.ok(!metadata.includes('"effective_value":"STP PRO"'));
console.log(JSON.stringify({status:'PASS',source_hash:analysis.source_hash,input_count:fields.length,preset:'Custom',review_hash:reviewed.effective_inputs_hash,ai_metadata_excludes_owner_strings:true}));
