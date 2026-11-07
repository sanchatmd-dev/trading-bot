import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {FIXED_EVAL_ENGINE_FILES} from '../src/postgres/quant-fixed-eval-engine.js';
import {finalizeSelection,readSelectionEvaluations,FINALIZER_STATES} from '../src/selection-eval/selection-finalizer.js';
import {selectionEvaluationOf} from '../src/selection-eval/evaluation-adapter.js';
import {CODES} from '../src/selection/codes.js';

// QR-4 slice Q4-A, static and no-database checks of the unwired adapter (src/selection-eval/evaluation-adapter.js) and finalizer (src/selection-eval/selection-finalizer.js).
// The behaviour on PostgreSQL is proven by test/postgres/qr4-finalizer.test.mjs and the pure behaviour by test/qr4-evaluation-adapter.test.js. Nothing here opens a database.
const root=fileURLToPath(new URL('..',import.meta.url));
const ADAPTER='src/selection-eval/evaluation-adapter.js',FINALIZER='src/selection-eval/selection-finalizer.js';
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const GUARD=/fixed-eval-contract|quant-fixed-eval-engine|quant-fixed-eval-worker|quant-fixed-eval\.js/; // test/fixed-eval-engine.test.js, importer guard
const IMPORTS=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;
const specifiers=text=>[...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match=>match[1]);

function walk(dir){
  const found=[];
  for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
    const child=path.posix.join(dir,entry.name);
    if(entry.isDirectory())found.push(...walk(child));
    else if(/\.(js|mjs)$/.test(entry.name))found.push(child);
  }
  return found;
}
function closure(roots){
  const visited=new Set();
  const visit=file=>{
    if(visited.has(file)||!fs.existsSync(path.join(root,file)))return;
    visited.add(file);
    for(const match of read(file).matchAll(IMPORTS))visit(path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1])));
  };
  roots.forEach(visit);
  return visited;
}

test('the directory holds exactly the adapter and the finalizer',()=>{
  assert.deepEqual(walk('src/selection-eval').sort(),[ADAPTER,FINALIZER]);
});

test('the adapter and the finalizer text name none of the guarded evaluation modules (comments included) and read no clock, random source, file, network or process',()=>{
  for(const file of [ADAPTER,FINALIZER]){
    const source=read(file);
    assert.equal(GUARD.test(source),false,file);
    for(const forbidden of [/\bDate\.now\b/,/\bnew Date\b/,/\bMath\.random\b/,/\brandomUUID\b/,/node:/,/from\s+['"](?:fs|net|child_process|http|https)['"]/,/\brequire\s*\(/,/\bimport\s*\(/,
      /\bprocess\./,/\bfetch\s*\(/,/\bsetTimeout\b/,/\bsetInterval\b/,/\bperformance\./])assert.equal(forbidden.test(source),false,file+' '+String(forbidden));
  }
  assert.equal(GUARD.test(read('src/postgres/selection-store.js')),false,'the store stays outside the importer guard too');
});

test('the import lists are pinned: the adapter does not import the QR-3 evaluation record, and the finalizer reaches the store only through its writers',()=>{
  assert.deepEqual([...specifiers(read(ADAPTER))].sort(),['../comparison/common.js','../comparison/valuation.js','../selection/codes.js']);
  assert.deepEqual([...specifiers(read(FINALIZER))].sort(),['../postgres/selection-store.js','../selection/codes.js','./evaluation-adapter.js']);
  assert.equal(closure([ADAPTER]).has('src/comparison/evaluation-record.js'),false);
  for(const file of [ADAPTER,FINALIZER])assert.equal(closure([file]).has('src/postgres/quant-fixed-eval.js'),false,file+' does not reach the fixed-evaluation service');
});

test('the finalizer takes no scheduler lock and no row lock, and never writes a table itself (the store writer does)',()=>{
  const source=read(FINALIZER);
  assert.equal(/quant_foundation_scheduler|FOR UPDATE|FOR SHARE|LOCK TABLE|pg_advisory/i.test(source),false);
  assert.equal(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b\s+(?:INTO|public|FROM)/i.test(source),false);
  assert.equal(/SET TRANSACTION READ ONLY/.test(source),true,'its own reads are READ ONLY');
  assert.equal(/writeOutcome/.test(source),true);
  assert.equal(/INSERT INTO public\.quant_selection_outcomes/.test(read('src/postgres/selection-store.js')),true,'the outcome writer lives in the store');
  assert.equal(/QR4_SELECTION_ENABLED|QUANT_FIXED_EVAL_ENABLED|process\.env/.test(read(FINALIZER)+read(ADAPTER)),false,'no flag or environment switch');
});

test('the adapter and the finalizer are imported by no file of src and sit outside the runtime and evaluation manifests (unwired)',()=>{
  const importers=walk('src').filter(file=>![ADAPTER,FINALIZER].includes(file)&&specifiers(read(file)).some(name=>/selection-eval\/|selection-finalizer|evaluation-adapter/.test(name)));
  assert.deepEqual(importers,[]);
  assert.deepEqual(walk('src').filter(file=>![ADAPTER,FINALIZER].includes(file)&&/selection-finalizer|evaluation-adapter|selection-eval\//.test(read(file))),[]);
  assert.equal(/selection-finalizer|evaluation-adapter|selection-eval/.test(read('src/selection/index.js')),false);
  for(const file of [ADAPTER,FINALIZER]){
    assert.equal(QUANT_RUNTIME_ENGINE_FILES.includes(file),false,file+' is not in the runtime manifest yet');
    assert.equal(FIXED_EVAL_ENGINE_FILES.includes(file),false,file+' is not hashed by the evaluation closure yet');
    for(const entry of ['src/postgres/quant-research-main.js','src/postgres/server.js','src/server.js','src/worker.js','src/postgres/worker-main.js'])
      assert.equal(closure([entry]).has(file),false,entry+' must not reach '+file);
  }
  assert.equal(closure([FINALIZER]).has(ADAPTER),true,'control: the closure walker follows the imports');
  assert.equal(closure([FINALIZER]).has('src/postgres/selection-store.js'),true);
});

test('the engine closure members that the finalizer reads are untouched by this slice: the store, the selection modules and the valuation are only imported',()=>{
  // The manifest names them (the fixed-evaluation service imports the selection store); this slice must not edit them. The text pins below fail if a writer is added here.
  for(const file of ['src/postgres/selection-store.js','src/selection/ranking.js','src/comparison/valuation.js'])assert.equal(QUANT_RUNTIME_ENGINE_FILES.includes(file),true,file);
  assert.equal(/export async function writeOutcome\(db,\{owner_id:owner,selection_id:selectionId,evaluations=null,readEvaluations=null/.test(read('src/postgres/selection-store.js')),true);
});

/** A handle that fails the test on any use: a refused request must not touch the database. */
const untouchable={isTransaction:false,query(){throw Error('query on a refused request');},transaction(){throw Error('transaction on a refused request');}};
const validators={validateFixedEvalContract:()=>({}),validateFixedEvalResult:()=>({})};
const deps={validators,readEvaluation:()=>null,readRows:()=>null};
const input={owner_id:'owner',selection_id:'2d7f0b7e-5b8a-4f0e-9c52-1b3f6b5a2e11'};

test('finalizeSelection: a missing validator or dependency refuses before any read; a malformed id is NOT_FOUND; a transaction handle throws',async()=>{
  for(const bad of [undefined,null,{},{validators:{}},{...deps,validators:{validateFixedEvalContract:validators.validateFixedEvalContract}},
    {...deps,validators:{validateFixedEvalResult:validators.validateFixedEvalResult}},{...deps,validators:{...validators,validateFixedEvalResult:'x'}}]){
    assert.deepEqual(await finalizeSelection(untouchable,input,bad),{ok:false,code:CODES.INTEGRITY_CHECK_FAILED,detail:'VALIDATOR_MISSING'});
    assert.deepEqual(await readSelectionEvaluations(untouchable,input,bad),{ok:false,code:CODES.INTEGRITY_CHECK_FAILED,detail:'VALIDATOR_MISSING'});
  }
  for(const name of ['readEvaluation','readRows']){
    assert.deepEqual(await finalizeSelection(untouchable,input,{...deps,[name]:undefined}),{ok:false,code:CODES.INTEGRITY_CHECK_FAILED,detail:'DEPENDENCY_MISSING'},name);
  }
  for(const bad of [undefined,null,{},{owner_id:'owner'},{selection_id:input.selection_id},{owner_id:'',selection_id:input.selection_id},{owner_id:'owner',selection_id:'bad id; DROP TABLE'},
    {owner_id:'owner',selection_id:'2D7F0B7E-5B8A-4F0E-9C52-1B3F6B5A2E11'},{owner_id:'owner',selection_id:7},{owner_id:7,selection_id:input.selection_id}]){
    assert.deepEqual(await finalizeSelection(untouchable,bad,deps),{ok:false,code:CODES.NOT_FOUND,detail:null});
  }
  await assert.rejects(finalizeSelection({isTransaction:true,query(){},transaction(){}},input,deps),/own transaction/);
  await assert.rejects(finalizeSelection(null,input,deps),/own transaction/);
  await assert.rejects(finalizeSelection({isTransaction:false},input,deps),/own transaction/);
});

test('the states and the module constants are frozen, and the adapter refuses a call without validators before it reads the input',()=>{
  assert.equal(Object.isFrozen(FINALIZER_STATES),true);
  assert.deepEqual([...FINALIZER_STATES],['WAITING','COMPLETED','INCOMPLETE','ALREADY_TERMINAL']);
  assert.deepEqual(selectionEvaluationOf(undefined,undefined),{ok:false,code:CODES.INTEGRITY_CHECK_FAILED,detail:'VALIDATOR_MISSING'});
});
