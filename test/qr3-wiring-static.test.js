import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from '../src/pine-bridge/source.js';
import {Qr3EvaluationDriver,DRIVER_LIMITS,FINALIZE_RETRY_BOUND,ADMISSION_RETRY,ADMISSION_NOOP,FINALIZE_TRANSIENT,ADMISSION_REFUSED_REASON,REPLAY_CODES,
  admissionKey,classifyAdmission,classifyFinalize,createFinalizerDeps,replayComparison,ADMISSION_HOLD_BOUND,ADMISSION_BACKOFF_MAX_EXPONENT,REPLAY_DISABLED_CODES,replayDisables,
  independenceInputs,INDEPENDENCE_VERSION} from '../src/postgres/qr3-comparison-wiring.js';
import {INDEPENDENCE_VERSION as CREATE_INDEPENDENCE_VERSION} from '../src/postgres/qr3-independence.js';
import {LIBRARY_VERSIONS} from '../src/quant-library/derive.js';
import {classifyEvidence} from '../src/comparison/evidence.js';
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
  // Hardening slice B (owner GO OG-2, SB187 item 3 e) corrected the finalizer header comments only. LF bytes old to new: 17d3b22efc334e2d... to bfd1a920d7e3f5d2....
  // The comment-stripped text is unchanged (b1e3c31cfbc04d88... before and after), so no code token changed.
  assert.equal(hash(code(fs.readFileSync(path.join(root,'src/postgres/comparison-finalizer.js')).toString('latin1').replace(/\r\n/g,'\n'))),
    'b1e3c31cfbc04d8823e2e130646d67eecab96d9c6c33dfdd68fbabf8cfb14e9c','finalizer code tokens');
  const pins={'src/postgres/comparison-finalizer.js':'bfd1a920d7e3f5d2a456c433c6ec50ae753fffcd96c6b36988342772bc234e11',
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
  assert.deepEqual({...DRIVER_LIMITS},{tick_ms:15000,comparisons_per_tick:8,stop_grace_ms:10000});
  assert.equal(FINALIZE_RETRY_BOUND,5);
  // hardening slice B (SB187 item 3 d, packet RR-10a proposal): bound and backoff cap
  assert.deepEqual([ADMISSION_HOLD_BOUND,ADMISSION_BACKOFF_MAX_EXPONENT],[20,5]);
  assert.deepEqual([...REPLAY_DISABLED_CODES],['NOT_FOUND','FIXED_EVAL_RUN_NOT_SUCCEEDED','FIXED_EVAL_RESULT_INVALID','FIXED_EVAL_AUTHORITY_INVALID',
    'FIXED_EVAL_DATASET_SHA_MISMATCH','FIXED_EVAL_DATASET_BINDING_INVALID','FIXED_EVAL_DATASET_CHANGED','VERIFIED_MARKET_DATA_REQUIRED','MARKET_METADATA_MISMATCH',
    'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET','FIXED_EVAL_RECORDS_INVALID','INVALID_MARKET_BAR']);
  assert.equal(Object.isFrozen(REPLAY_DISABLED_CODES),true);
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
  for(const limits of [{tickMs:0},{perTick:0},{retryBound:0},{tickMs:1.5},{admissionBound:0},{stopGraceMs:-1},{stopGraceMs:0.5}])assert.throws(()=>new Qr3EvaluationDriver({fixedEvalService:service,...limits}),/limits/);
  const driver=new Qr3EvaluationDriver({fixedEvalService:service});
  assert.deepEqual([driver.tickMs,driver.perTick,driver.retryBound],[15000,8,5]);
  await driver.stop();
  await assert.rejects(replayComparison({isTransaction:true,transaction(){},query(){}},{owner_id:'o',comparison_id:'c'},{}),/own transaction/);
});

/* ---- hardening slice B (owner GO OG-2; SB187 item 3, SB194 item 3): independence inputs, replay classes, admission bound, bounded stop ---- */

const MIN=60000,OWNER='owner-1',MARKET_KEY='binance-global:BTCUSDT:1',SOURCE='a'.repeat(64);
const PERIOD={start_ms:1000*MIN,end_ms:2000*MIN};
const inside={start_ms:1500*MIN,end_ms:1600*MIN},outside={start_ms:100*MIN,end_ms:200*MIN};
const gates=(states={})=>({version:LIBRARY_VERSIONS.qualification,gates:['G1','G2','G3','G4','G5','G6','G7','G8'].map(gate=>({gate,state:states[gate]??'PASS',code:states[gate]&&states[gate]!=='PASS'?'CODE_'+gate:null}))});
const block=(over={})=>({version:INDEPENDENCE_VERSION,earlier_holdouts:[],searched_windows:[],registered_boundary:{state:'NONE'},source_holdout_state:'NONE',
  source_holdout_window:null,source_holdout_register:[],scanned:{holdout_rows:0,searched_rows:0},library_gates:gates(),...over});
const participantWith=(independence,{prior=[],origin='FIXTURE'}={})=>({participant_id:'run-p',source_hash:SOURCE,origin,
  freeze:{context:{},prior_exposed_by:prior,...(independence===undefined?{}:{independence})}});
/** The classifier exactly as participantInputs calls it, with a stored record created after the freeze. */
function classify(participant){
  const facts=independenceInputs({owner_id:OWNER,market_key:MARKET_KEY,participant});
  const classified=classifyEvidence({participant_id:'run-p',owner_id:OWNER,market_key:MARKET_KEY,source_hash:SOURCE,window:PERIOD,record_created_at_ms:20,record_comparison_id:'cmp-1',
    record_spec_hash:'s'.repeat(64),spec_hash:'s'.repeat(64),frozen_at_ms:10,as_of_ms:10,comparison_id:'cmp-1',viewable_before_freeze:false,from_stored_view:false,...facts.classifier});
  return {facts,classified};
}

test('slice B: the restated independence version equals the create module, and the closure module never imports the create-time module',()=>{
  assert.equal(INDEPENDENCE_VERSION,CREATE_INDEPENDENCE_VERSION);
  const imports=[...wiring.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match=>match[1]);
  assert.equal(imports.some(name=>/qr3-independence|qr3-routes|quant-library\.js/.test(name)),false,'SB194 item 3: no import of src/postgres/qr3-independence.js');
  assert.equal(/qr3-independence\.js|qr3-routes|quant-library\.js/.test(code(wiring)),false);
});

test('slice B (a, g): a clean block is INDEPENDENT; every frozen list, boundary and gate reaches the classifier (no [] or null default)',()=>{
  const clean=classify(participantWith(block()));
  assert.equal(clean.facts.integrity_ok,true);
  assert.deepEqual([clean.classified.evidence_class,clean.classified.reasons],['INDEPENDENT',[]]);
  const holdout=classify(participantWith(block({earlier_holdouts:[{run_id:'r1',window:inside}]})));
  assert.deepEqual(holdout.classified.reasons,[CODES.QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT]);
  assert.deepEqual(holdout.facts.classifier.earlier_holdouts,[{owner_id:OWNER,market_key:MARKET_KEY,window:inside}]);
  const searched=classify(participantWith(block({searched_windows:[{run_id:'r2',window:inside}]})));
  assert.deepEqual(searched.classified.reasons,[CODES.QR3_WINDOW_OVERLAPS_SEARCHED_DATA]);
  assert.deepEqual(searched.facts.classifier.searched_windows,[{owner_id:OWNER,source_hash:SOURCE,window:inside}]);
  // a touching window does not overlap (half-open)
  assert.deepEqual(classify(participantWith(block({earlier_holdouts:[{run_id:'r1',window:{start_ms:900*MIN,end_ms:1000*MIN}}]}))).classified.reasons,[]);
  // registered boundary: NONE no reason; SET at or before the start no reason; SET after the start, UNAVAILABLE, a non-integer start or an unknown state fail closed
  for(const [boundary,reasons] of [[{state:'NONE'},[]],[{state:'SET',start_ms:1000*MIN},[]],[{state:'SET',start_ms:1000*MIN+MIN},[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]],
    [{state:'UNAVAILABLE'},[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]],[{state:'SET',start_ms:'60000000'},[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]],
    [{state:'SET'},[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]],[{state:'OTHER'},[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]],[null,[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]]])
    assert.deepEqual(classify(participantWith(block({registered_boundary:boundary}))).classified.reasons,reasons,JSON.stringify(boundary));
  // imported origin is never qualified
  assert.deepEqual(classify(participantWith(block(),{origin:'IMPORTED'})).classified.reasons,[CODES.QR3_NOT_QUALIFIED]);
  // gates: G8 FAIL with its code; NOT_REACHED counts as FAIL; a null or other-version snapshot fails every gate
  const g8=classify(participantWith(block({library_gates:gates({G8:'FAIL'})}))).classified;
  assert.deepEqual([g8.failing_gates,g8.gate_codes,g8.reasons],[['G8'],['CODE_G8'],[CODES.QR3_NOT_QUALIFIED]]);
  const real=classify(participantWith(block({library_gates:{version:LIBRARY_VERSIONS.qualification,gates:[...gates().gates.slice(0,7),{gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'}]}}))).classified;
  assert.deepEqual([real.failing_gates,real.gate_codes],[['G8'],['QL4C_VALIDATION_NOT_AVAILABLE']]);
  assert.deepEqual(classify(participantWith(block({library_gates:gates({G3:'NOT_REACHED'})}))).classified.failing_gates,['G3']);
  for(const snapshot of [null,{...gates(),version:'library-qualification-v1'},{version:LIBRARY_VERSIONS.qualification,gates:null},'x']){
    const none=classify(participantWith(block({library_gates:snapshot}))).classified;
    assert.deepEqual([none.failing_gates.length,none.gate_codes,none.reasons],[8,[],[CODES.QR3_NOT_QUALIFIED]],JSON.stringify(snapshot));
  }
});

test('slice B (a): every explicit unavailable state fails closed; integrity false for a missing block, a source holdout that is UNAVAILABLE or SET without a register',()=>{
  for(const over of [{earlier_holdouts:null},{searched_windows:null},{earlier_holdouts:'x'},{earlier_holdouts:[{run_id:'r1'}]},{searched_windows:[null]}]){
    const {facts,classified}=classify(participantWith(block(over)));
    assert.equal(facts.integrity_ok,true,JSON.stringify(over));
    assert.ok(classified.reasons.includes(CODES.QR3_INTEGRITY_FAILED),JSON.stringify(over));
    assert.equal(classified.evidence_class,'DEVELOPMENT_EVIDENCE');
  }
  for(const independence of [undefined,null,{},block({version:'qr3-independence-v0'}),'x']){
    const {facts,classified}=classify(participantWith(independence));
    assert.equal(facts.integrity_ok,false,JSON.stringify(independence));
    assert.ok(classified.reasons.includes(CODES.QR3_INTEGRITY_FAILED));
    assert.equal(facts.classifier.library_gates,null);
  }
  for(const over of [{source_holdout_state:'UNAVAILABLE',source_holdout_register:null},{source_holdout_state:'UNAVAILABLE',source_holdout_register:[]},
    {source_holdout_state:'SET',source_holdout_window:inside,source_holdout_register:null},{source_holdout_state:'SET',source_holdout_window:null,source_holdout_register:[]},
    {source_holdout_state:'SET',source_holdout_window:{start_ms:5,end_ms:5},source_holdout_register:[]},{source_holdout_state:'NONE',source_holdout_register:null},
    {source_holdout_state:'OTHER'},{source_holdout_state:undefined}])
    assert.equal(classify(participantWith(block(over))).facts.integrity_ok,false,JSON.stringify(over));
  assert.equal(classify(participantWith(block({source_holdout_state:'SET',source_holdout_window:outside,source_holdout_register:[]}))).facts.integrity_ok,true);
});

test('slice B (a, b): prior_exposed_by and source_holdout_register merge into one register with owner and market; an unreadable register refuses (integrity false upstream)',()=>{
  const exposure={kind:'QR3_COMPARISON',id:'cmp-0',window:outside,at_ms:5};
  // the parent's holdout window is outside the period; the exposure overlaps it only, so only the merged register can find it
  const merged=classify(participantWith(block({source_holdout_state:'SET',source_holdout_window:outside,source_holdout_register:[exposure]})));
  assert.equal(merged.facts.integrity_ok,true);
  assert.deepEqual(merged.facts.classifier.exposure_register,[{owner_id:OWNER,market_key:MARKET_KEY,window:outside,kind:'QR3_COMPARISON',at_ms:5,comparison_id:'cmp-0'}]);
  assert.deepEqual([merged.classified.reasons,merged.classified.exposed_by],[[CODES.HOLDOUT_EXPOSED_BY_COMPARISON],['cmp-0']]);
  const prior=classify(participantWith(block(),{prior:[{kind:'QR4_SELECTION',id:'sel-1',window:inside,at_ms:5}]}));
  assert.deepEqual(prior.classified.reasons,[CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED]);
  assert.equal(prior.facts.classifier.exposure_register[0].selection_id,'sel-1');
  // (b) an unreadable stored register: the classifier refuses; participantInputs then sets integrity false (pinned below and on PostgreSQL)
  for(const options of [{prior:[{kind:'QR3_COMPARISON',id:'x'}]},{prior:null},{prior:[null]}]){
    const {classified}=classify(participantWith(block(),options));
    assert.deepEqual([classified.ok,classified.code],[false,CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE],JSON.stringify(options));
  }
  assert.match(code(wiring),/integrity_ok:integrity&&facts\.integrity_ok&&classified\.ok!==false/);
});

test('slice B (c): only an application refusal with a data-gone code disables reproduction; database, transport and guard errors are thrown',()=>{
  const refusal=(code,status=409)=>Object.assign(new Error(code),{code,status});
  for(const code of REPLAY_DISABLED_CODES)assert.equal(replayDisables(refusal(code)),true,code);
  // fix round: the evaluator-records and stored-bar codes as their throwers raise them (need status 409, fail default status 400)
  assert.equal(replayDisables(refusal('FIXED_EVAL_RECORDS_INVALID')),true);
  assert.equal(replayDisables(refusal('INVALID_MARKET_BAR',400)),true);
  for(const error of [Object.assign(new Error('timeout'),{code:'57014'}),Object.assign(new Error('serialization'),{code:'40001',status:409}),Object.assign(new Error('lost'),{code:'08006'}),
    new TypeError('bug'),refusal('QR3_READ_ONLY_REQUIRED'),refusal('FIXED_EVAL_READ_ONLY_REQUIRED'),refusal('FIXED_EVAL_TRANSACTION_REQUIRED'),refusal('QR3_COMPARISON_UNREADABLE'),
    {code:'NOT_FOUND',status:404},Object.assign(new Error('x'),{code:'NOT_FOUND'}),null,undefined])
    assert.equal(replayDisables(error),false,String(error?.code));
  assert.equal((code(wiring).match(/catch\(error\)\{if\(!replayDisables\(error\)\)throw error;return record\('REPRODUCTION_DISABLED',null,null\);\}/g)??[]).length,2);
  assert.equal(/catch\{return record\(/.test(code(wiring)),false);
});

/** A database stub for pending(): a READ ONLY handle that lists the given open comparisons minus the excluded ids, at most perTick. */
function stubService(ids){
  const db={isTransaction:true,async query(sql,params){
    if(/current_setting/.test(sql))return {rows:[{mode:'on'}]};
    return {rows:ids.filter(id=>!params[0].includes(id)).slice(0,params[1]).map(id=>({comparison_id:id,owner_id:OWNER,status:'EVALUATING'}))};
  },transaction(){throw Error('no transaction');}};
  return {db,enqueue(){},read(){},storedRun(){}};
}

test('slice B (d): a repeatedly failing comparison backs off, never holds a slot, is held after the bound, and the one behind it is driven (head-of-line)',async()=>{
  const logs=[],driven=[];
  const driver=new Qr3EvaluationDriver({fixedEvalService:stubService(['bad','good']),perTick:1,admissionBound:3,log:event=>logs.push(event)});
  driver.drive=async item=>{driven.push(driver.ticks+':'+item.comparison_id);if(item.comparison_id==='bad')throw Object.assign(new Error('bad input'),{code:'22P02'});return {comparison_id:item.comparison_id,result:'WAITING'};};
  const results=[];
  for(let tick=0;tick<16;tick++)results.push(...await driver.tick());
  // tick 1 fails (skip 2), tick 3 fails (skip 4), tick 7 fails: third consecutive failure, held; every other tick drives the comparison behind it
  assert.deepEqual(driven.filter(entry=>entry.endsWith(':bad')),['1:bad','3:bad','7:bad']);
  assert.deepEqual(driven.filter(entry=>entry.endsWith(':good')).length,13);
  assert.deepEqual(results.filter(entry=>entry.comparison_id==='bad').map(entry=>[entry.result,entry.attempts,entry.held]),[['ERROR',1,false],['ERROR',2,false],['ERROR',3,true]]);
  assert.equal(driver.held.has('bad'),true);
  assert.equal(driver.backoff.has('bad'),false);
  assert.deepEqual(logs.filter(event=>event.event==='qr3.admission_held'),[{event:'qr3.admission_held',comparison_id:'bad',code:'22P02',attempts:3}]);
  // the backoff is capped at 2^5 ticks
  const capped=new Qr3EvaluationDriver({fixedEvalService:stubService([]),log:()=>{}});
  for(let n=0;n<9;n++)capped.counted('x','08006');
  assert.equal(capped.backoff.get('x').resume_tick-capped.ticks,32);
  assert.equal(capped.counted('y','08006').attempts,1);
});

test('slice B (d): a pass that reaches the finalizer resets the count; a terminal or failed admission clears it; global back-pressure never counts',async()=>{
  const driver=new Qr3EvaluationDriver({fixedEvalService:stubService([]),log:()=>{}});
  driver.counted('c1','08006');driver.counted('c1','08006');
  driver.admit=async()=>null;driver.finalize=async item=>({comparison_id:item.comparison_id,result:'WAITING'});
  await driver.drive({comparison_id:'c1',owner_id:OWNER});
  assert.equal(driver.backoff.has('c1'),false);
  driver.counted('c2','08006');
  driver.admit=async item=>({comparison_id:item.comparison_id,result:'TERMINAL'});
  await driver.drive({comparison_id:'c2',owner_id:OWNER});
  assert.equal(driver.backoff.has('c2'),false);
  // admit(): the global back-pressure codes return before the counter (static pin of the order)
  assert.match(code(wiring),/if\(ADMISSION_RETRY\.includes\(code\)\)return \{comparison_id:item\.comparison_id,result:'ADMISSION_RETRY',code,enqueued\};\s*const bound=this\.counted\(item\.comparison_id,code\);/);
});

test('slice B (f): stop() starts nothing new, returns within the grace while a pass is slow, and leaves no timer',async()=>{
  const started=[];let release;
  const driver=new Qr3EvaluationDriver({fixedEvalService:stubService(['a','b','c']),tickMs:5,log:()=>{}});
  driver.drive=item=>{started.push(item.comparison_id);return new Promise(resolve=>{release=()=>resolve({comparison_id:item.comparison_id,result:'WAITING'});});};
  driver.start();
  while(started.length===0)await new Promise(resolve=>setImmediate(resolve));
  const begin=performance.now();
  await driver.stop({graceMs:50});
  const took=performance.now()-begin;
  assert.ok(took>=40&&took<1000,String(took));
  assert.equal(driver.timer,null);
  release();
  await driver.running;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(started,['a'],'no comparison starts after stop');
  assert.equal(driver.timer,null,'the loop does not re-arm after a stop');
  // a pass that ends inside the grace returns at once
  const quick=new Qr3EvaluationDriver({fixedEvalService:stubService([]),log:()=>{}});
  quick.start();
  await quick.stop({graceMs:60000});
  assert.equal(quick.timer,null);
});
