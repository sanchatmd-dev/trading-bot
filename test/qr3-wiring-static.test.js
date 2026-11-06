import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from '../src/pine-bridge/source.js';
import {Qr3EvaluationDriver,DRIVER_LIMITS,FINALIZE_RETRY_BOUND,ADMISSION_RETRY,ADMISSION_NOOP,FINALIZE_TRANSIENT,ADMISSION_REFUSED_REASON,REPLAY_CODES,
  admissionKey,classifyAdmission,classifyFinalize,createFinalizerDeps,replayComparison} from '../src/postgres/qr3-comparison-wiring.js';
import {CODES} from '../src/comparison/common.js';

// L8-W (owner GO OG-1; Root rulings SB184): static and no-database checks of the QR-3 wiring module, the worker main flag gate, the server flag gate and the
// replay route. The real behaviour runs on PostgreSQL in test/postgres/qr3-end-to-end.test.mjs. Nothing here opens a database or starts a process.
const root=fileURLToPath(new URL('..',import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const WIRING='src/postgres/qr3-comparison-wiring.js',MAIN='src/postgres/quant-research-main.js',SERVER='src/postgres/server.js',ROUTES='src/postgres/qr3-routes.js';
const code=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"])\/\/.*$/gm,'$1');
const wiring=read(WIRING),main=read(MAIN),server=read(SERVER),routes=read(ROUTES);
const lf=file=>hash(Buffer.from(fs.readFileSync(path.join(root,file)).toString('latin1').replace(/\r\n/g,'\n'),'latin1'));
function walk(dir){
  const found=[];
  for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
    const child=path.posix.join(dir,entry.name);
    if(entry.isDirectory())found.push(...walk(child));else if(/\.(js|mjs)$/.test(entry.name))found.push(child);
  }
  return found;
}

test('flags: the worker main builds the driver only when QUANT_FIXED_EVAL_ENABLED and QR3_COMPARISON_ENABLED are exactly 1, and stops it first',()=>{
  const text=code(main);
  assert.match(text,/const fixedEvalEnabled=process\.env\.QUANT_FIXED_EVAL_ENABLED==='1';/);
  assert.match(text,/const qr3DriverEnabled=fixedEvalEnabled&&process\.env\.QR3_COMPARISON_ENABLED==='1';/);
  assert.equal((text.match(/new Qr3EvaluationDriver\(/g)??[]).length,1);
  assert.match(text,/if\(qr3DriverEnabled\)qr3Driver=new Qr3EvaluationDriver\(\{fixedEvalService\}\);/);
  assert.equal((text.match(/QR3_COMPARISON_ENABLED/g)??[]).length,1,'one read of the flag');
  // the driver starts after the worker and stops before the worker and before the database closes
  assert.match(text,/worker\.start\(\);qr3Driver\?\.start\(\);/);
  assert.match(text,/async function stop\(\)\{if\(stopping\)return;stopping=true;await qr3Driver\?\.stop\(\);await worker\.stop\(\);await healthDb\?\.close\(\);await db\.close\(\);\}/);
  // only the worker main constructs a driver
  assert.deepEqual(walk('src').filter(file=>file!==WIRING&&/new Qr3EvaluationDriver\(/.test(read(file))),[MAIN]);
});

test('flags: the server builds the API dependencies only when QR3_COMPARISON_ENABLED is exactly 1 and names no other closure module than the wiring',()=>{
  const text=code(server);
  assert.match(text,/const qr3ComparisonEnabled=process\.env\.QR3_COMPARISON_ENABLED==='1';/);
  assert.match(text,/const qr3Deps=qr3ComparisonEnabled\?createQr3ApiDeps\(\{pineService:pineBridgeService\}\):undefined;/);
  assert.match(text,/enabled: qr3ComparisonEnabled, deps: qr3Deps\}/);
  assert.equal((text.match(/createQr3ApiDeps\(/g)??[]).length,1);
  assert.equal(/fixed-eval-contract|quant-fixed-eval-engine|quant-fixed-eval-worker|quant-fixed-eval\.js|comparison-finalizer/.test(server),false);
  assert.deepEqual(walk('src').filter(file=>file!==WIRING&&/createQr3ApiDeps\(/.test(read(file))),[SERVER]);
});

test('the driver takes no lock, writes no table itself and reads no clock or random source; the finalizer runs outside any transaction',()=>{
  const text=code(wiring);
  assert.equal(/quant_foundation_scheduler|FOR UPDATE|FOR SHARE|FOR NO KEY|LOCK TABLE|pg_advisory|SERIALIZABLE/i.test(text),false);
  assert.equal(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b\s+(?:INTO|public|FROM)/i.test(text),false,'every write goes through the store writers or the fixed-evaluation service');
  for(const forbidden of [/\bDate\.now\b/,/\bnew Date\b/,/\bMath\.random\b/,/\brandomUUID\b/,/\bprocess\./,/\bfetch\s*\(/,/\brequire\s*\(/,/\bimport\s*\(/,/node:/,/\bsetInterval\b/])
    assert.equal(forbidden.test(text),false,String(forbidden));
  // finalizeComparison and replayComparison throw inside a transaction; the driver calls the finalizer from its own loop only
  assert.equal((text.match(/finalizeComparison\(/g)??[]).length,1);
  assert.equal(/scheduler/i.test(text),false);
  assert.equal(/QR3_COMPARISON_ENABLED|QUANT_FIXED_EVAL_ENABLED/.test(text),false,'the module reads no flag; its callers gate it');
});

test('no apply, import, start-Bot or rerun action: the only new POST is replay, and the wiring starts only the fixed runs of a comparison',()=>{
  const text=code(wiring);
  assert.equal(/apply|optimi[sz]e|start-bot|startBot|bestInputs|best_inputs|activate|live/i.test(text),false);
  assert.equal((text.match(/\.enqueue\(/g)??[]).length,1);
  assert.match(text,/purpose:'QR3_COMPARISON'/);
  assert.equal(/QR4_SELECTION'\}/.test(text),false);
  const routeCode=code(routes);
  assert.deepEqual([...routeCode.matchAll(/parts\[1\]==='([a-z]+)'/g)].map(match=>match[1]),['cancel','replay']);
  assert.equal(/'(?:PUT|PATCH|DELETE)'/.test(routeCode),false);
  assert.equal(/apply|optimi[sz]e|start-bot/i.test(routeCode),false);
});

test('accepted code is unchanged: the finalizer and the store at 0d51ed3, the S3a module, the fixed-evaluation modules and the comparison SQL (LF bytes)',()=>{
  const pins={'src/postgres/comparison-finalizer.js':'17d3b22efc334e2d9698b7a09c2b2bc9880c514cd9e54c8a7b9808926e5d6aa2',
    'src/postgres/comparison-store.js':'542427b335fde7990d7fe39e5f08f0d080271e7162117a5411904120133ad0c8',
    'src/comparison/evaluation-record.js':'60c3b66e90b31000bdb92ad578acf38fa767b42724bc34b4528ea3a59a7ba9b7',
    'src/postgres/quant-fixed-eval.js':'ff479352f609aff4618a041016d9943eb3c5448250c742bf29a5e933f66842c4',
    'src/postgres/quant-fixed-eval-worker.js':'5c6360482e8368b2198e15fb8bab795f9fc0b6b591bae9ec4c39a29c7554518f',
    'src/postgres/quant-research-foundation.js':'4b904690731b929b06aac386fdd6cfd6c026cf72a77c0da6500f5c79c361edcb',
    'src/quant-research/fixed-eval-contract.js':'5cb0978f0555e0f8cad824a162b87905d140ad4ed95e585d4b3b6f385487ac76',
    'src/postgres/quant-fixed-eval-engine.js':'9ead56bbaea0d0e510342601cc0c6cf45f1ff74472d1896b8f0fd54926cb4672',
    'src/postgres/quant-comparison.sql':'0d02aae7f04751027c0b45528a4b6770e3f0dfceca4867f67cc5988a2aa26a8b',
    'src/postgres/bi-package-store.js':'4bc7969090041fcbc81736ac3ac4a03e164085809348f3a441ec565d65febe84'};
  for(const [file,digest] of Object.entries(pins))assert.equal(lf(file),digest,file);
});

test('driver numbers and classification tables are the Root rulings (SB184 items 2 to 5)',()=>{
  assert.deepEqual({...DRIVER_LIMITS},{tick_ms:15000,comparisons_per_tick:8});
  assert.equal(FINALIZE_RETRY_BOUND,5);
  assert.deepEqual([...ADMISSION_RETRY],['FOUNDATION_QUEUE_FULL','RESEARCH_EXECUTOR_MODE_MISMATCH','FIXED_EVAL_IMMUTABLE_AUTHORITY_REQUIRED','FIXED_EVAL_AUTHORITY_UNAVAILABLE']);
  assert.deepEqual([...ADMISSION_NOOP],['FIXED_EVAL_ALREADY_STARTED','FIXED_EVAL_OBJECT_NOT_EVALUATING']);
  assert.deepEqual([...FINALIZE_TRANSIENT],['READ_EVALUATION','READ_ROWS','PARTICIPANT_INPUTS']);
  assert.equal(ADMISSION_REFUSED_REASON,'PARTICIPANT_ADMISSION_REFUSED');
  assert.deepEqual({...REPLAY_CODES},{CLOSED:'QR3_ADMISSION_CLOSED',NOT_COMPLETE:'REPLAY_NOT_COMPLETE',BUSY:'REPLAY_BUSY'});
  for(const frozen of [DRIVER_LIMITS,ADMISSION_RETRY,ADMISSION_NOOP,FINALIZE_TRANSIENT,REPLAY_CODES])assert.equal(Object.isFrozen(frozen),true);
});

test('RR-10 admission classification: retry, no-op and fail classes, one input change each',()=>{
  const refusal=(code,status=409)=>Object.assign(new Error(code),{code,status});
  for(const code of ADMISSION_RETRY)assert.equal(classifyAdmission(refusal(code)),'RETRY',code);
  for(const code of ADMISSION_NOOP)assert.equal(classifyAdmission(refusal(code)),'NOOP',code);
  for(const code of ['FIXED_EVAL_PARENT_INELIGIBLE','FIXED_EVAL_CONTEXT_MISMATCH','VERIFIED_MARKET_DATA_REQUIRED','UNSUPPORTED_SOURCE_HASH','IDEMPOTENCY_CONFLICT','NOT_FOUND',
    'FIXED_EVAL_AUTHORITY_INVALID','FOUNDATION_CAPABILITY_LIMIT'])assert.equal(classifyAdmission(refusal(code)),'FAIL',code);
  // database errors keep their identity: SQLSTATE, no status, not an Error
  for(const error of [Object.assign(new Error('serialization'),{code:'40001'}),Object.assign(new Error('deadlock'),{code:'40P01',status:409}),Object.assign(new Error('grant'),{code:'42501'}),
    Object.assign(new Error('connection'),{code:'08006'}),new TypeError('bug'),{code:'FIXED_EVAL_CONTEXT_MISMATCH',status:409},refusal('FIXED_EVAL_CONTEXT_MISMATCH','409'),null,undefined])
    assert.equal(classifyAdmission(error),'RETRY',String(error?.code));
});

test('RR-11 finalizer classification: answers are DONE, the three dependency reads are TRANSIENT, every other refusal fails the comparison',()=>{
  for(const state of ['WAITING','COMPLETE','FAILED','CANCELLED','ALREADY_TERMINAL'])assert.equal(classifyFinalize({ok:true,state}),'DONE');
  for(const detail of FINALIZE_TRANSIENT)assert.equal(classifyFinalize({ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail}),'TRANSIENT');
  for(const answer of [{ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'EVALUATION_MISMATCH'},{ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'BENCHMARK_MISMATCH'},
    {ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'RUN_AMBIGUOUS'},{ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'OUTCOME_NOT_ALLOWED'},{ok:false,code:CODES.QR3_INTEGRITY_FAILED,detail:'VALIDATOR_MISSING'},
    {ok:false,code:'INVALID_FIELDS',detail:'READ_ROWS'},{ok:false,code:CODES.QR3_SPEC_IMMUTABLE,detail:null},null])assert.equal(classifyFinalize(answer),'FAIL',JSON.stringify(answer));
});

test('admission key: deterministic per comparison and participant, inside the fixed-evaluation key pattern, and distinct across pairs',()=>{
  const key=admissionKey('cmp-1','run-a');
  assert.match(key,/^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(key,admissionKey('cmp-1','run-a'));
  assert.notEqual(key,admissionKey('cmp-1','run-b'));assert.notEqual(key,admissionKey('cmp-2','run-a'));
  assert.notEqual(admissionKey('a','bc'),admissionKey('ab','c'));
});

test('constructors and the replay entry refuse a missing service, invalid limits or a transaction handle',async()=>{
  assert.throws(()=>new Qr3EvaluationDriver({}),/fixed-evaluation service/);
  assert.throws(()=>createFinalizerDeps({fixedEvalService:{db:{}}}),/fixed-evaluation service/);
  const service={db:{isTransaction:false,query(){throw Error('no query');},transaction(){throw Error('no transaction');}},enqueue(){},read(){},storedRun(){}};
  for(const limits of [{tickMs:0},{perTick:0},{retryBound:0},{tickMs:1.5}])assert.throws(()=>new Qr3EvaluationDriver({fixedEvalService:service,...limits}),/limits/);
  const driver=new Qr3EvaluationDriver({fixedEvalService:service});
  assert.deepEqual([driver.tickMs,driver.perTick,driver.retryBound],[15000,8,5]);
  await driver.stop();
  await assert.rejects(replayComparison({isTransaction:true,transaction(){},query(){}},{owner_id:'o',comparison_id:'c'},{}),/own transaction/);
});
