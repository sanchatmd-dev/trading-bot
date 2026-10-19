import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {FIXED_EVAL_CLOSURE_VERSION,FIXED_EVAL_ENGINE_FILES,FIXED_EVAL_ONLY_FILES,fixedEvalClosure,fixedEvalEngineHash} from '../src/postgres/quant-fixed-eval-engine.js';
import {FIXED_EVAL_VERSIONS} from '../src/quant-research/fixed-eval-contract.js';
import {INGESTION_ENGINE_FILES} from '../src/postgres/quant-data.js';
import {FOUNDATION_ENGINE_FILES,LEGACY_ENGINE_FILES} from '../src/postgres/quant-research.js';
import {PF2_ENGINE_FILES,PF2_EVALUATOR_FILES} from '../src/quant-research/preflight-resolver.js';
import {SHARED_APPLICATION_FILES} from './helpers/runtime-shared-boundary.js';

/** FE-2a: the evaluation closure fixed-eval-closure-v1. Nothing here touches a research closure; the research
 * hashes stay what they are until FE-2b wires the evaluation into the shared worker.
 */
const shared=new Set(SHARED_APPLICATION_FILES);
const listed=new Set(FIXED_EVAL_ENGINE_FILES);
const NEW_NODE_FILES=FIXED_EVAL_ONLY_FILES.filter(file=>file.endsWith('.js'));
const nodeImports=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;

async function nodeClosure(roots){
 const visited=new Set();
 async function visit(file){
  if(visited.has(file))return;visited.add(file);
  const source=await fs.readFile(file,'utf8');
  for(const match of source.matchAll(nodeImports))await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1])));
 }
 for(const file of roots)await visit(file);
 return visited;
}
// Both import forms: "from robot_quant import a, b" (each name may be a module) and "from [.|robot_quant.]name import ...".
async function pythonClosure(roots){
 const visited=new Set();
 async function visit(name){
  if(visited.has(name))return;visited.add(name);
  const source=await fs.readFile('quant_lab/src/robot_quant/'+name+'.py','utf8');
  for(const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant\.)([A-Za-z_][A-Za-z_0-9]*)\s+import\b/gm))await visit(match[1]);
  for(const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant)\s+import\s+([A-Za-z_][A-Za-z_0-9, ]*)/gm)){
   for(const imported of match[1].split(',').map(item=>item.trim()).filter(Boolean)){
    const exists=await fs.access('quant_lab/src/robot_quant/'+imported+'.py').then(()=>true,()=>false);
    if(exists)await visit(imported);
   }
  }
  for(const match of source.matchAll(/^\s*import\s+robot_quant\.([A-Za-z_][A-Za-z_0-9]*)/gm))await visit(match[1]);
 }
 for(const name of roots)await visit(name);
 return visited;
}
async function walk(directory){
 const found=[];
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const full=path.posix.join(directory,entry.name);
  if(entry.isDirectory())found.push(...await walk(full));else found.push(full);
 }
 return found;
}

test('the closure is the runtime manifest plus four named files, sorted and present',async()=>{
 assert.equal(FIXED_EVAL_CLOSURE_VERSION,'fixed-eval-closure-v1');
 assert.equal(FIXED_EVAL_VERSIONS.closure,FIXED_EVAL_CLOSURE_VERSION);
 assert.deepEqual(FIXED_EVAL_ONLY_FILES,['quant_lab/src/robot_quant/fixed_eval.py','quant_lab/src/robot_quant/fixed_eval_job.py',
  'src/postgres/quant-fixed-eval-engine.js','src/quant-research/fixed-eval-contract.js']);
 assert.equal(FIXED_EVAL_ENGINE_FILES.length,new Set(FIXED_EVAL_ENGINE_FILES).size);
 assert.deepEqual([...FIXED_EVAL_ENGINE_FILES],[...FIXED_EVAL_ENGINE_FILES].sort());
 assert.equal(FIXED_EVAL_ENGINE_FILES.length,QUANT_RUNTIME_ENGINE_FILES.length+FIXED_EVAL_ONLY_FILES.length);
 for(const file of QUANT_RUNTIME_ENGINE_FILES)assert.ok(listed.has(file),'missing runtime entry '+file);
 for(const file of FIXED_EVAL_ONLY_FILES)assert.ok(listed.has(file),'missing eval file '+file);
 for(const file of FIXED_EVAL_ENGINE_FILES)await fs.access(file);
 assert.ok(Object.isFrozen(FIXED_EVAL_ENGINE_FILES)&&Object.isFrozen(FIXED_EVAL_ONLY_FILES));
});

test('the evaluation files stay outside every research closure and the runtime manifest until FE-2b',()=>{
 const research={LEGACY:LEGACY_ENGINE_FILES,FOUNDATION:FOUNDATION_ENGINE_FILES,INGESTION:INGESTION_ENGINE_FILES,PF2_engine:PF2_ENGINE_FILES,
  PF2_evaluator:PF2_EVALUATOR_FILES,runtime_manifest:QUANT_RUNTIME_ENGINE_FILES};
 for(const [name,files] of Object.entries(research))for(const file of FIXED_EVAL_ONLY_FILES)assert.ok(!files.includes(file),file+' is in '+name);
});

test('Python import closure of the job wrapper and the evaluator sits inside the evaluation closure',async()=>{
 const modules=await pythonClosure(['__init__','fixed_eval_job','fixed_eval']);
 assert.ok(modules.has('fixed_eval')&&modules.has('research_chunk')&&modules.has('bridge_paper')&&modules.has('ql3a')&&modules.has('spt_custom_evaluator'));
 assert.ok(modules.size>8,'traversal must reach the engine modules');
 for(const name of modules)assert.ok(listed.has('quant_lab/src/robot_quant/'+name+'.py'),'unhashed Python dependency '+name);
});

test('Node import closure of the new modules sits inside the evaluation closure or the shared boundary',async()=>{
 const imports=await nodeClosure(NEW_NODE_FILES);
 for(const file of NEW_NODE_FILES)assert.ok(imports.has(file));
 assert.ok(imports.size>5);
 for(const file of imports)assert.ok(listed.has(file)||shared.has(file),'unhashed dependency '+file);
});

test('nothing in a runtime root, and no other source file, imports the new Node modules yet',async()=>{
 const roots=['src/postgres/quant-research-main.js','src/quant-research/io-profile-worker.js','src/postgres/quant-preflight-wiring.js','src/postgres/quant-preflight-routes.js'];
 const reached=await nodeClosure(roots);
 for(const file of NEW_NODE_FILES)assert.ok(!reached.has(file),file+' is reachable from a runtime root');
 const importers=[];
 for(const file of (await walk('src')).filter(item=>item.endsWith('.js')||item.endsWith('.mjs'))){
  if(NEW_NODE_FILES.includes(file))continue;
  const source=await fs.readFile(file,'utf8');
  if(/fixed-eval-contract|quant-fixed-eval-engine/.test(source))importers.push(file);
 }
 assert.deepEqual(importers,[]);
 const supervisor=await fs.readFile('src/quant-research/process-supervisor.js','utf8');
 assert.ok(!/fixed_eval/.test(supervisor),'the I/O module allowlist must not list the job before FE-2b');
});

test('the hash is the version plus the sha256 of every listed file as checked out',async()=>{
 const files=Object.fromEntries(await Promise.all(FIXED_EVAL_ENGINE_FILES.map(async file=>[file,hash(await fs.readFile(file))])));
 const expected=hash(canonical({version:FIXED_EVAL_CLOSURE_VERSION,files}));
 assert.equal(await fixedEvalEngineHash(),expected);
 assert.match(expected,/^[a-f0-9]{64}$/);
 assert.deepEqual(await fixedEvalClosure(),{version:'fixed-eval-closure-v1',hash:expected});
 // The version is part of the hashed object: the same bytes under another version hash differently.
 assert.notEqual(hash(canonical({version:'fixed-eval-closure-v2',files})),expected);
 // The unversioned bare map (the older closures' formula) is not this hash.
 assert.notEqual(hash(canonical(files)),expected);
});

test('a changed byte in the evaluator, the wrapper, a Node module or a shared engine file rotates the hash',async()=>{
 const baseline=await fixedEvalEngineHash();
 for(const file of [...FIXED_EVAL_ONLY_FILES,'quant_lab/src/robot_quant/analytics.py','quant_lab/src/robot_quant/research_chunk.py',
  'src/quant-research/foundation-contract.js','quant_lab/src/robot_quant/ql3a.py']){
  const target=new URL('../'+file,import.meta.url).href;
  const changed=await fixedEvalEngineHash(async url=>{
   const bytes=await fs.readFile(url);
   return url.href===target?Buffer.concat([bytes,Buffer.from('\n# changed\n')]):bytes;
  });
  assert.notEqual(changed,baseline,file);
 }
});

test('a missing listed file fails closed instead of hashing a shorter list',async()=>{
 const target=new URL('../quant_lab/src/robot_quant/fixed_eval_job.py',import.meta.url).href;
 await assert.rejects(fixedEvalEngineHash(url=>{
  if(url.href===target)throw Object.assign(new Error('missing job'),{code:'ENOENT'});
  return fs.readFile(url);
 }),/missing job/);
});

test('the evaluation hash differs from every research engine hash value',async()=>{
 const {engineHash}=await import('../src/postgres/quant-research.js');
 const {ingestionEngineHash}=await import('../src/postgres/quant-data.js');
 const {pf2ExecutableHashes}=await import('../src/quant-research/preflight-resolver.js');
 const pf=await pf2ExecutableHashes();
 const research=[await engineHash(false),await engineHash(true),await ingestionEngineHash(),pf.engine_hash,pf.evaluator_hash];
 assert.ok(!research.includes(await fixedEvalEngineHash()));
});

test('the evaluator closure constant in Python is the closure version the Node side pins',async()=>{
 const source=await fs.readFile('quant_lab/src/robot_quant/fixed_eval.py','utf8');
 const match=source.match(/^EVALUATOR_CLOSURE = "([^"]+)"\r?$/m);
 assert.ok(match);
 assert.equal(match[1],FIXED_EVAL_CLOSURE_VERSION);
 assert.ok(!source.includes('NOT_IN_ENGINE_CLOSURE'));
});
