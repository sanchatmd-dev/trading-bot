// Private evidence preparation only. No AI, database, alerts or activation.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {inspectSource,executable,hash,canonical} from '../src/pine-bridge/source.js';
import {SOURCE_HASH} from '../src/quant-research/contract.js';

const [bundlePath,lockPath,tracePath,outputRoot]=process.argv.slice(2);
const privateRoot=path.resolve('.qa-local')+path.sep;
assert.ok([bundlePath,lockPath,tracePath,outputRoot].every(p=>p&&path.resolve(p).startsWith(privateRoot)),'Private paths required');
const bundle=JSON.parse(await fs.readFile(bundlePath,'utf8'));
const approved=JSON.parse(await fs.readFile(lockPath,'utf8'));
const source=bundle.revision.source;
assert.equal(hash(source),SOURCE_HASH);
assert.equal(approved.baseline.source_hash,SOURCE_HASH);
const inspected=inspectSource(source),review=approved.baseline.snapshot.membership[0].analysis.inputs;
assert.equal(inspected.inputs.length,58);
assert.equal(review.length,58);
assert.equal(approved.lock.selection.bindings.length,8);
const referenceTrace=await fs.readFile(tracePath,'utf8');
assert.ok(referenceTrace.startsWith(source),'State trace must contain exact approved source');
const suffixStart=referenceTrace.indexOf('// QL-2A state evidence only.',source.length);
assert.ok(suffixStart>0);
let states=referenceTrace.slice(suffixStart).replace('input.float(2, "Evidence Bridge ATR Multiplier"','input.float(60, "Evidence Bridge ATR Multiplier"');
assert.ok(states.includes('input.float(60, "Evidence Bridge ATR Multiplier"'));
const cases=[{id:'baseline',changes:{}}];
for(const row of approved.lock.selection.bindings)for(const bound of ['min','max'])cases.push({id:row.pine_variable+'-'+bound,changes:{[row.pine_variable]:row.search_domain[bound]}});
const manifest={schema_version:'ql3a-varied-input-parity-preparation-v1',status:'PREPARED_NOT_VERIFIED',source_hash:SOURCE_HASH,baseline_snapshot_hash:approved.baseline.snapshot_hash,input_lock_hash:approved.lock.lock_hash,market:{symbol:'BINANCE:BTCUSDT',timeframe:'1',standard_chart:true},baseline_source_input_count:58,fixed_source_inputs:50,bridge:{atr_multiplier:60,rr:1.5},criteria:{measured_closed_bars_min:2000,warmup_bars_min:1250,signal_mismatches_max:0,state_absolute_tolerance:1e-7,independent_spot_ohlcv_mismatches_max:0},limitations:['Min/max axis cases cover each selected source input; they do not certify every mixed candidate.','Changed inputs start a new source state; never restore the baseline checkpoint into a variant.','A checkpoint comparison must use the same variant and be labeled separately from cold-start convergence.','Custom 100-observation repaint evidence remains a separate gate.','No execution Bridge, webhook URL, token or new alert is included.'],cases:[]};
await fs.mkdir(outputRoot,{recursive:true});
for(const c of cases){
 const values=Object.fromEntries(review.map(r=>[r.pine_variable,r.effective_value]));
 Object.assign(values,c.changes);
 const edits=inspected.inputs.map(r=>{
  const reviewed=review.find(i=>i.pine_variable===r.pine_variable);
  assert.ok(reviewed&&reviewed.input_id===r.input_id);
  const original=source.slice(r.source_span.start,r.source_span.end),masked=executable(original);
  const start=masked.indexOf('(')+1;
  let depth=0,end=start;
  for(;end<masked.length;end++){
   const ch=masked[end];
   if('([{'.includes(ch))depth++;
   if(')]}'.includes(ch)){if(depth===0)break;depth--;}
   if(ch===','&&depth===0)break;
  }
  const raw=original.slice(start,end),named=raw.match(/^(\s*defval\s*=\s*)/);
  const value=values[r.pine_variable];
  assert.ok(['number','boolean','string'].includes(typeof value));
  const literal=JSON.stringify(value);
  return {start:r.source_span.start+start,end:r.source_span.start+end,raw,replacement:(named?.[1]??'')+literal};
 });
 let varied=source;
 for(const e of [...edits].reverse())varied=varied.slice(0,e.start)+e.replacement+varied.slice(e.end);
 const changed=inspectSource(varied);
 assert.equal(changed.inputs.length,58);
 for(const r of changed.inputs){
  const expected=values[r.pine_variable];
  const actual=['int','float'].includes(r.type)?r.default:JSON.parse(r.default);
  assert.equal(actual,expected,'Default binding mismatch: '+r.pine_variable);
 }
 // Reconstruct the original using only the reviewed default spans. Any other
 // byte change is rejected, including a change to the original signal logic.
 let restored=varied,offset=0;
 const located=edits.map(e=>{const x={...e,start:e.start+offset,end:e.start+offset+e.replacement.length};offset+=e.replacement.length-(e.end-e.start);return x;});
 for(const e of located.reverse())restored=restored.slice(0,e.start)+e.raw+restored.slice(e.end);
 assert.equal(restored,source);
 const annotation='\n\n// QL-3A PRIVATE VARIED-INPUT EVIDENCE: '+c.id+'\n// Defaults match the reviewed Custom snapshot plus this case. Do not create a Paper alert.\n';
 const prefix='QL3A '+c.id;
 const flags=`plot(buySignal ? 1 : 0, title="${prefix} Native BUY flag", display=display.data_window)\nplot(sellSignal ? 1 : 0, title="${prefix} Native EXIT flag", display=display.data_window)\n`;
 const variantStates=states.replaceAll('QL2A State',prefix+' State').replaceAll('QL2A Shadow ST Mismatch',prefix+' Shadow ST Mismatch');
 const artifact=varied+annotation+flags+variantStates;
 const output=path.join(outputRoot,c.id+'.pine');
 await fs.writeFile(output,artifact,{flag:'wx',mode:0o600});
 manifest.cases.push({id:c.id,plot_prefix:prefix,changes:c.changes,effective_inputs_hash:hash(canonical(values)),artifact_hash:hash(artifact),default_only_source_hash:hash(varied),original_logic_unchanged:true,lines:artifact.split('\n').length,file:path.basename(output),status:'AWAITING_TRADINGVIEW_COMPILE_EXPORT'});
}
await fs.writeFile(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({prepared_cases:manifest.cases.length,input_lock_hash:manifest.input_lock_hash,status:manifest.status,first_variant:path.join(outputRoot,'emaFastInput-min.pine')}));
