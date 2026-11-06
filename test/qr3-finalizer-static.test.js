import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {FIXED_EVAL_ENGINE_FILES} from '../src/postgres/quant-fixed-eval-engine.js';
import {finalizeComparison,RUN_FAILURE_REASONS,FINALIZER_STATES} from '../src/postgres/comparison-finalizer.js';
import {cancelComparison,failComparison,STORE_CODES} from '../src/postgres/comparison-store.js';
import {CODES} from '../src/comparison/common.js';

// QR-3 S3b, static and no-database checks of the unwired finalizer (src/postgres/comparison-finalizer.js) and of the cancel and fail writers.
// The PostgreSQL behaviour is proven by test/postgres/qr3-finalizer.test.mjs. Nothing here opens a database or starts a process.
const root=fileURLToPath(new URL('..',import.meta.url));
const FINALIZER='src/postgres/comparison-finalizer.js';
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const source=read(FINALIZER);
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

test('the finalizer text names none of the guarded evaluation modules (comments included) and reads no clock, random source, file, network or process',()=>{
  assert.equal(GUARD.test(source),false);
  assert.equal(GUARD.test(read('src/postgres/comparison-store.js')),false,'the store stays outside the importer guard too');
  for(const forbidden of [/\bDate\.now\b/,/\bnew Date\b/,/\bMath\.random\b/,/\brandomUUID\b/,/node:/,/from\s+['"](?:fs|net|child_process|http|https)['"]/,/\brequire\s*\(/,/\bimport\s*\(/,
    /\bprocess\./,/\bfetch\s*\(/,/\bsetTimeout\b/,/\bsetInterval\b/,/\bperformance\./])assert.equal(forbidden.test(source),false,String(forbidden));
  assert.deepEqual([...specifiers(source)].sort(),['../comparison/common.js','../comparison/evaluation-record.js','./comparison-store.js']);
});

test('the finalizer takes no scheduler lock and no row lock, and never writes a table itself (the store writers do)',()=>{
  assert.equal(/quant_foundation_scheduler|FOR UPDATE|FOR SHARE|LOCK TABLE|pg_advisory/i.test(source),false);
  assert.equal(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b\s+(?:INTO|public|FROM)/i.test(source),false);
  assert.equal(/SET TRANSACTION READ ONLY/.test(source),true,'its own run lookup is READ ONLY');
  assert.equal(/INSERT INTO public\.quant_comparison_status_events/.test(read('src/postgres/comparison-store.js')),true,'the status writers live in the store');
});

test('nothing imports the finalizer: not the S1 index, not any src file, not the worker root, the server root or the evaluation closure manifest',()=>{
  assert.equal(/comparison-finalizer|evaluation-record/.test(read('src/comparison/index.js')),false);
  const importers=walk('src').filter(file=>file!==FINALIZER&&/comparison-finalizer/.test(read(file)));
  assert.deepEqual(importers,[]);
  for(const entry of ['src/postgres/quant-research-main.js','src/postgres/server.js','src/server.js','src/worker.js','src/postgres/worker-main.js']){
    assert.equal(closure([entry]).has(FINALIZER),false,entry+' must not reach the finalizer');
  }
  assert.equal(QUANT_RUNTIME_ENGINE_FILES.includes(FINALIZER),false);
  assert.equal(FIXED_EVAL_ENGINE_FILES.includes(FINALIZER),false);
  assert.equal(closure([FINALIZER]).has('src/postgres/comparison-store.js'),true,'control: the closure walker follows the imports');
});

test('no QR-3 route, flag or environment switch exists for the finalizer',()=>{
  assert.equal(/QR3_COMPARISON_ENABLED|process\.env/.test(source),false);
  assert.equal(Object.isFrozen(RUN_FAILURE_REASONS),true);
  assert.equal(Object.isFrozen(FINALIZER_STATES),true);
  for(const reason of Object.values(RUN_FAILURE_REASONS))assert.match(reason,/^[A-Z][A-Z0-9_]{1,63}$/,'a reason code the database accepts');
  assert.deepEqual([...FINALIZER_STATES],['WAITING','COMPLETE','FAILED','CANCELLED','ALREADY_TERMINAL']);
});

/** A handle that fails the test on any use: a refused request must not touch the database. */
const untouchable={isTransaction:false,query(){throw Error('query on a refused request');},transaction(){throw Error('transaction on a refused request');}};
const validators={validateFixedEvalContract:()=>({}),validateFixedEvalResult:()=>({})};
const deps={validators,readEvaluation:()=>null,readRows:()=>null,participantInputs:()=>null};
const input={owner_id:'owner',comparison_id:'cmp-1'};

test('finalizeComparison: a missing validator or dependency refuses before any read; a malformed id is NOT_FOUND; a transaction handle throws',async()=>{
  for(const bad of [undefined,null,{},{validators:{}},{...deps,validators:{validateFixedEvalContract:validators.validateFixedEvalContract}},
    {...deps,validators:{validateFixedEvalResult:validators.validateFixedEvalResult}},{...deps,validators:{...validators,validateFixedEvalResult:'x'}}]){
    assert.deepEqual(await finalizeComparison(untouchable,input,bad),{ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'VALIDATOR_MISSING'});
  }
  for(const name of ['readEvaluation','readRows','participantInputs']){
    assert.deepEqual(await finalizeComparison(untouchable,input,{...deps,[name]:undefined}),{ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'DEPENDENCY_MISSING'},name);
  }
  for(const bad of [undefined,null,{},{owner_id:'owner'},{comparison_id:'cmp-1'},{owner_id:'',comparison_id:'cmp-1'},{owner_id:'owner',comparison_id:'bad id; DROP TABLE'},
    {owner_id:'owner',comparison_id:7},{owner_id:7,comparison_id:'cmp-1'}]){
    assert.deepEqual(await finalizeComparison(untouchable,bad,deps),{ok:false,code:STORE_CODES.NOT_FOUND,detail:null});
  }
  await assert.rejects(finalizeComparison({isTransaction:true,query(){},transaction(){}},input,deps),/own transaction/);
  await assert.rejects(finalizeComparison(null,input,deps),/own transaction/);
});

test('cancelComparison and failComparison: pure refusals touch no database, and a transaction handle throws',async()=>{
  for(const writer of [cancelComparison,failComparison]){
    for(const bad of [undefined,null,{},{owner_id:'owner'},{owner_id:'owner',comparison_id:'bad id'},{owner_id:'',comparison_id:'cmp-1'},{owner_id:'owner',comparison_id:7}]){
      assert.deepEqual(await writer(untouchable,{...bad,reason_code:'SOME_REASON'}),{ok:false,code:STORE_CODES.NOT_FOUND,detail:null});
    }
    await assert.rejects(writer({isTransaction:true,query(){},transaction(){}},{...input,reason_code:'SOME_REASON'}),/own transaction/);
  }
  for(const reason of [undefined,null,'',7,'lower','1ABC','A','X'.repeat(65),'HAS SPACE','HAS-DASH']){
    assert.deepEqual(await failComparison(untouchable,{...input,reason_code:reason}),{ok:false,code:CODES.INVALID_FIELDS,detail:'REASON_CODE'},String(reason));
  }
});
