// Build a private, append-only evidence artifact from the approved SPT bundle.
// This script has no database, network, AI, order or activation operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {inspectSource,hash,canonical} from '../src/pine-bridge/source.js';
import {assembleNativeTrace} from '../src/pine-bridge/template.js';

const [input,output]=process.argv.slice(2);
const privateRoot=path.resolve('.qa-local')+path.sep;
if(!input||!output||![input,output].every(p=>path.resolve(p).startsWith(privateRoot))||!output.endsWith('.pine'))throw new Error('Use private bundle and .pine output under .qa-local');
const bundle=JSON.parse(await fs.readFile(input,'utf8'));
const source=bundle.revision.source,d=bundle.deployment,s=d.snapshot;
if(hash(source)!=='0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a'||hash(source)!==s.source_hash||hash(canonical(s))!==d.snapshot_hash||hash(bundle.artifact)!==s.artifact_hash)throw new Error('Approved source/snapshot/artifact hash mismatch');
const market={...s.market,deployment_id:d.deployment_id,pine_import_id:d.pine_import_id,source_version:d.source_version};
const trace=assembleNativeTrace(source,inspectSource(source),s.selection.signals,market);
const p='ql2a_state_';
if(source.includes(p))throw new Error('State identifier collision');
const append=`
// QL-2A state evidence only. Original source bytes above are unchanged.
// Copy the complete fixed input snapshot; disable original notifications.
// These Bridge fields record the snapshot pair, not executable orders.
${p}mult = input.float(${s.selection.bridge.atr_multiplier}, "Evidence Bridge ATR Multiplier", group="QL-2A Evidence")
${p}rr = input.float(${s.selection.bridge.rr}, "Evidence Bridge RR", group="QL-2A Evidence")
var float ${p}upper = na
var float ${p}lower = na
var float ${p}st = na
var int ${p}direction = 1
if not na(atr)
    float ${p}basicUpper = hl2 + stFactor * atr
    float ${p}basicLower = hl2 - stFactor * atr
    float ${p}prevUpper = nz(${p}upper[1])
    float ${p}prevLower = nz(${p}lower[1])
    ${p}upper := ${p}basicUpper < ${p}prevUpper or close[1] > ${p}prevUpper ? ${p}basicUpper : ${p}prevUpper
    ${p}lower := ${p}basicLower > ${p}prevLower or close[1] < ${p}prevLower ? ${p}basicLower : ${p}prevLower
    ${p}direction := na(atr[1]) ? 1 : ${p}st[1] == ${p}prevUpper ? (close > ${p}upper ? -1 : 1) : (close < ${p}lower ? 1 : -1)
    ${p}st := ${p}direction == -1 ? ${p}lower : ${p}upper
plot(emaFast, title="QL2A State EMA Fast", display=display.data_window)
plot(emaSlow, title="QL2A State EMA Slow", display=display.data_window)
plot(atr, title="QL2A State ATR", display=display.data_window)
plot(stLine, title="QL2A State Supertrend", display=display.data_window)
plot(stDir, title="QL2A State Direction", display=display.data_window)
plot(${p}upper, title="QL2A State Upper Band", display=display.data_window)
plot(${p}lower, title="QL2A State Lower Band", display=display.data_window)
plot(not na(atr) and (stLine != ${p}st or stDir != ${p}direction) ? 1 : 0, title="QL2A Shadow ST Mismatch", display=display.data_window)
plot(longSetupActive ? 1 : 0, title="QL2A State Long Active", display=display.data_window)
plot(shortSetupActive ? 1 : 0, title="QL2A State Exit Active", display=display.data_window)
plot(longSetupExpireBar - bar_index, title="QL2A State Long Expiry Remaining", display=display.data_window)
plot(shortSetupExpireBar - bar_index, title="QL2A State Exit Expiry Remaining", display=display.data_window)
plot(longSetupZoneLow, title="QL2A State Long Zone", display=display.data_window)
plot(shortSetupZoneHigh, title="QL2A State Exit Zone", display=display.data_window)
plot(bar_index - tradeStartBar, title="QL2A State Cooldown Elapsed", display=display.data_window)
// End QL-2A state evidence.
`;
const artifact=trace.integrated_pine+append;
await fs.writeFile(output,artifact,{mode:0o600,flag:'wx'});
const manifest={schema_version:'ql2a-state-trace-v1',artifact_status:'EVIDENCE_ONLY',deployment_id:d.deployment_id,source_hash:s.source_hash,execution_artifact_hash:s.artifact_hash,snapshot_hash:d.snapshot_hash,trace_artifact_hash:hash(artifact),changed_original_bytes:0,trace_schema:trace.trace_schema,market:s.market,selection:s.selection,scope:'Native flags and source-state checkpoint only; no executable Bridge events. Shadow bands must agree with source Supertrend before restoring state.'};
await fs.writeFile(output+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({trace_artifact_hash:manifest.trace_artifact_hash,changed_original_bytes:0,output,lines:artifact.split('\n').length}));
