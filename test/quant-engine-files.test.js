import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {INGESTION_ENGINE_FILES,ingestionEngineHash} from '../src/postgres/quant-data.js';
import {FOUNDATION_ENGINE_FILES,LEGACY_ENGINE_FILES,engineHash} from '../src/postgres/quant-research.js';
import {PF2_ENGINE_FILES,PF2_EVALUATOR_FILES,pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {SHARED_APPLICATION_FILES} from './helpers/runtime-shared-boundary.js';

const shared=new Set(SHARED_APPLICATION_FILES);
const roots=['src/postgres/quant-research-main.js','src/quant-research/io-profile-worker.js',
 'src/postgres/quant-preflight-wiring.js','src/postgres/quant-preflight-routes.js'];
async function closure(){
 const visited=new Set();
 async function visit(file){
  if(visited.has(file))return;visited.add(file);
  const source=await fs.readFile(file,'utf8');
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g))
   await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1])));
 }
 for(const file of roots)await visit(file);
 return visited;
}
test('reviewed worker and API import closure is hashed by every runtime engine',async()=>{
 const imports=await closure();
 for(const files of [INGESTION_ENGINE_FILES,FOUNDATION_ENGINE_FILES,PF2_ENGINE_FILES]){
  assert.equal(files.length,new Set(files).size);
  for(const file of imports)assert.ok(files.includes(file)||shared.has(file),'unhashed dependency '+file);
  for(const file of QUANT_RUNTIME_ENGINE_FILES)assert.ok(files.includes(file),'missing runtime entry '+file);
  for(const file of files)await fs.access(file);
 }
 for(const file of ['src/quant-research/runtime-engine-files.js','src/postgres/quant-profile-enrollment-schema.sql',
  'quant_lab/src/robot_quant/io_runtime_probe.py','quant_lab/src/robot_quant/research_engine.py',
  'quant_lab/src/robot_quant/research_chunk.py','quant_lab/src/robot_quant/pf2_replay.py'])
  assert.ok(QUANT_RUNTIME_ENGINE_FILES.includes(file));
});
test('missing runtime file and changed enrollment semantics invalidate ingestion identity',async()=>{
 const target=new URL('../src/postgres/quant-profile-enrollment-schema.sql',import.meta.url).href;
 const baseline=await ingestionEngineHash();
 await assert.rejects(ingestionEngineHash(file=>{
  if(file.href===target)throw Error('missing trusted schema');
  return fs.readFile(file);
 }),/missing trusted schema/);
 const changed=await ingestionEngineHash(async file=>{
  const bytes=await fs.readFile(file);
  return file.href===target?Buffer.concat([bytes,Buffer.from('\n-- changed enrollment semantics\n')]):bytes;
 });
 assert.notEqual(changed,baseline);
});
test('Python subprocess module dependencies stay inside the reviewed runtime manifest',async()=>{
 const visited=new Set();
 async function visit(name){
  if(visited.has(name))return;visited.add(name);
  const file='quant_lab/src/robot_quant/'+name+'.py';
  assert.ok(QUANT_RUNTIME_ENGINE_FILES.includes(file),'unhashed subprocess dependency '+file);
  const source=await fs.readFile(file,'utf8');
  for(const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant\.)([A-Za-z_][A-Za-z_0-9]*)\s+import\b/gm))
   await visit(match[1]);
 }
 for(const name of ['__init__','research_engine','research_chunk','pf2_replay','io_runtime_probe'])await visit(name);
 assert.ok(visited.size>10,'subprocess dependency traversal must reach the evaluator modules');
});
test('W4 preserves legacy and evaluator byte identities from the reviewed base revision',async()=>{
 // Original lists at 7d7aacd5. Hash checkout bytes, preserving LF/CRLF identity on each host.
 const legacy=["src/quant-research/contract.js","src/postgres/quant-research-worker.js","quant_lab/src/robot_quant/research_engine.py","quant_lab/src/robot_quant/spt_custom_evaluator.py","quant_lab/src/robot_quant/spt_evaluator.py","quant_lab/src/robot_quant/bridge_paper.py","quant_lab/src/robot_quant/bridge_replay.py","quant_lab/src/robot_quant/risk_evaluator.py","quant_lab/src/robot_quant/ql3a.py","quant_lab/src/robot_quant/analytics.py"];
 const evaluator=["quant_lab/src/robot_quant/__init__.py","quant_lab/src/robot_quant/analytics.py","quant_lab/src/robot_quant/backtest.py","quant_lab/src/robot_quant/bridge_replay.py","quant_lab/src/robot_quant/contracts.py","quant_lab/src/robot_quant/market_data.py","quant_lab/src/robot_quant/optimizer.py","quant_lab/src/robot_quant/records.py","quant_lab/src/robot_quant/risk_evaluator.py","quant_lab/src/robot_quant/risk_preview.py","quant_lab/src/robot_quant/spt_custom_evaluator.py","quant_lab/src/robot_quant/spt_evaluator.py","quant_lab/src/robot_quant/strategy.py","quant_lab/src/robot_quant/validation.py"];
 const originalHash=async files=>hash(canonical(Object.fromEntries(await Promise.all(
  files.map(async file=>[file,hash(await fs.readFile(file))])))));
 assert.deepEqual(LEGACY_ENGINE_FILES,legacy);assert.deepEqual(PF2_EVALUATOR_FILES,evaluator);
 assert.equal(await engineHash(false),await originalHash(legacy));
 assert.equal((await pf2ExecutableHashes()).evaluator_hash,await originalHash(evaluator));
});

