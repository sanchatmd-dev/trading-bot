import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {quantLibraryRoutes} from '../src/postgres/quant-library.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {developmentRowViolations} from '../src/selection/lifecycle.js';
import {runOf} from './helpers/quant-library-fixture.mjs';

// QR-4 slice Q4-D (contract 3.3 D1 and D2, 16.3 item 1; OD-S20; RC-S12, RC-S19; ruling SB203 item 6): the development view is the Quant Research Library
// (list, detail, compare). A rank-like query key gives QR4_DEVELOPMENT_SCORE_NOT_RANKABLE before any read; the keys each route accepts today stay accepted;
// every other unknown key keeps INVALID_FIELDS. No database is opened: a fake handle counts every statement and answers the library reads from labelled fixtures.
const root=fileURLToPath(new URL('..',import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const PATH='/api/quant/library';
const NOT_RANKABLE='QR4_DEVELOPMENT_SCORE_NOT_RANKABLE';
const OWNER={id:'owner-q4d'};

const RUNS=[runOf({id:'11111111-1111-4111-8111-111111111111',scenario:'PENDING',owner:OWNER.id,deployment:'dep-a',importId:'imp-a',at:1_790_000_000_000}),
  runOf({id:'22222222-2222-4222-8222-222222222222',scenario:'NO_VALID',owner:OWNER.id,deployment:'dep-a',importId:'imp-a',at:1_790_000_100_000})];

/** A database handle whose every statement is counted. An unknown statement fails the test, so a new read cannot hide behind the fake. */
function fakeDatabase(){
  const calls=[];
  const runRow=run=>({run_id:run.run_id,bot_id:OWNER.id,deployment_id:'dep-a',status:run.status,phase:run.phase,created_at:run.created_at,updated_at:run.updated_at,deadline:run.created_at+900000,
    attempt:1,evaluations_started:run.steps.length,contract_hash:run.contract_hash,contract:run.contract,result:run.result,diagnostic:run.diagnostic});
  const db={calls,
    async query(sql,params=[]){
      calls.push(String(sql).slice(0,60));
      if(/^SET TRANSACTION READ ONLY/.test(sql))return {rows:[]};
      if(sql.includes("to_regclass('quant_jobs') IS NOT NULL"))return {rows:[{present:true,foundation:false,frozen:false}]};
      if(sql.startsWith('SELECT status,diagnostic'))return {rows:RUNS.map(run=>({status:run.status,diagnostic:run.diagnostic,few:false,n:1}))};
      if(sql.startsWith('WITH page AS MATERIALIZED'))return {rows:RUNS.map(run=>({...runRow(run),r:run.result,c:run.contract,evaluated:run.steps.length,passed:run.status==='SUCCEEDED'?1:0}))};
      if(sql.startsWith('SELECT run_id,bot_id,deployment_id')){
        const run=RUNS.find(item=>item.run_id===params[0]);
        return {rows:run?[runRow(run)]:[]};
      }
      if(sql.includes('FROM quant_job_steps WHERE run_id'))return {rows:RUNS.find(item=>item.run_id===params[0])?.steps??[]};
      if(sql.includes("to_regclass('public.quant_exposure_register')"))return {rows:[{register:null,marker:null}]};
      if(sql.startsWith('WITH earlier'))return {rows:[]};
      throw new Error('unexpected statement: '+String(sql).slice(0,80));
    },
    async transaction(callback){return callback();}};
  return db;
}
async function ask(query,{path:route=PATH,method='GET',db=fakeDatabase()}={}){
  let sent=null;
  const json=(res,status,body)=>{sent={status,body};};
  try{
    const handled=await quantLibraryRoutes({method},{},new URL('http://127.0.0.1'+route+query),OWNER,db,json);
    return {handled,sent,error:null,db};
  }catch(error){return {handled:null,sent,error:{code:error.code,status:error.status},db};}
}
const [ONE,TWO]=RUNS.map(run=>run.run_id);
const ROUTES={list:PATH,compare:PATH+'/compare',detail:PATH+'/runs/'+ONE};
const withRuns=query=>'?run_id='+ONE+'&run_id='+TWO+(query?'&'+query:'');

test('rank-like keys give QR4_DEVELOPMENT_SCORE_NOT_RANKABLE (400) on every library route before any statement runs',async()=>{
  const keys=['sort','order_by','rank','top','best','SORT','Sort_By','orderBy','orderby','order','sortby','sort_order','sorted','rankby','rank_by','top10','top_n','topN','best3','bestscore',
    'best_value','tops','topology','leader','leaderboard','leader_id','winner','winnerid','Top10','RANK'];
  for(const [name,route] of Object.entries(ROUTES))for(const key of keys){
    const query=name==='compare'?withRuns(key+'=x'):'?'+key+'=x';
    const answer=await ask(query,{path:route});
    assert.deepEqual(answer.error,{code:NOT_RANKABLE,status:400},name+' '+key);
    assert.equal(answer.sent,null,name+' '+key+': no body');
    assert.deepEqual(answer.db.calls,[],name+' '+key+': no statement ran');
  }
  // a value-less key and a percent-encoded key are the same refusal
  for(const query of ['?sort','?sort=','?%73ort=1','?top10','?best3=1&best3=2'])assert.equal((await ask(query)).error.code,NOT_RANKABLE,query);
});

test('a rank-like key wins over every other refusal and is refused beside accepted keys, before any statement runs',async()=>{
  const cases=[['?limit=5&sort=x',PATH],['?sort=x&limit=5',PATH],['?limit=0&sort=x',PATH],['?limit=5&limit=6&sort=x',PATH],['?offset=1&top10=1',PATH],['?before=bad&rank=1',PATH],
    ['?bot_id=a&bot_id=b&sortby=1',PATH],['?owner_id=x&best=1',PATH],[withRuns('sort=net_return'),PATH+'/compare'],[withRuns('bot_id=a&rankby=1'),PATH+'/compare'],
    ['?run_id=bad&run_id=bad&top=1',PATH+'/compare'],['?run_id='+ONE+'&run_id='+ONE+'&best=1',PATH+'/compare'],['?run_id='+ONE+'&winner=1',PATH+'/compare'],
    ['?sort=x',PATH+'/runs/'+ONE],['?limit=5&leader=1',PATH+'/runs/'+ONE],['?bot_id=a&bot_id=b&order_by=x',PATH+'/runs/'+ONE]];
  for(const [query,route] of cases){
    const answer=await ask(query,{path:route});
    assert.equal(answer.error?.code,NOT_RANKABLE,route+query);
    assert.equal(answer.error.status,400,route+query);
    assert.deepEqual(answer.db.calls,[],route+query);
  }
});

test('other unknown keys keep INVALID_FIELDS (400), the pinned offset case among them, before any statement runs',async()=>{
  const unknown=['offset','owner_id','other','page_size','include_gates','stop_loss','desktop','bottom','ordinal','order_id','restop','reorder','bot','filter','q','limit_x'];
  for(const key of unknown){
    for(const [route,query] of [[PATH,'?'+key+'=1'],[PATH+'/compare',withRuns(key+'=1')],[PATH+'/runs/'+ONE,'?'+key+'=1']]){
      const answer=await ask(query,{path:route});
      assert.deepEqual(answer.error,{code:'INVALID_FIELDS',status:400},route+' '+key);
      assert.deepEqual(answer.db.calls,[],route+' '+key);
    }
  }
  // the repeated-key rules are unchanged: only run_id repeats, and only on compare
  for(const [route,query] of [[PATH,'?limit=5&limit=6'],[PATH,'?before=1:x&before=2:y'],[PATH,'?bot_id=a&bot_id=b'],[PATH+'/compare',withRuns('bot_id=a&bot_id=b')],[PATH+'/runs/'+ONE,'?bot_id=a&bot_id=b']]){
    const answer=await ask(query,{path:route});
    assert.deepEqual(answer.error,{code:'INVALID_FIELDS',status:400},route+query);
    assert.deepEqual(answer.db.calls,[],route+query);
  }
  // the detail route accepts bot_id only: limit stays INVALID_FIELDS there (pinned by test/postgres/quant-library-http.test.mjs)
  assert.equal((await ask('?limit=5',{path:PATH+'/runs/'+ONE})).error.code,'INVALID_FIELDS');
});

test('the keys each route accepts today stay accepted and reach the read',async()=>{
  const list=await ask('?limit=5&bot_id=all');
  assert.equal(list.error,null);assert.equal(list.sent.status,200);assert.equal(list.handled,true);assert.ok(list.db.calls.length>0,'the list read ran');
  const cursor=await ask('?before=1790000100000:'+TWO+'&limit=1&bot_id=x');
  assert.equal(cursor.error,null);assert.equal(cursor.sent.status,200);
  const compare=await ask(withRuns('bot_id=a'),{path:PATH+'/compare'});
  assert.equal(compare.error,null);assert.equal(compare.sent.status,200);assert.ok(compare.db.calls.length>0);
  const detail=await ask('?bot_id=a',{path:PATH+'/runs/'+ONE});
  assert.equal(detail.error,null);assert.equal(detail.sent.status,200);assert.ok(detail.db.calls.length>0);
  // value errors keep their own codes; they are not rank refusals
  assert.equal((await ask('?limit=0')).error.code,'INVALID_LIMIT');
  assert.equal((await ask('?before=x')).error.code,'INVALID_CURSOR');
  assert.equal((await ask('?run_id='+ONE,{path:PATH+'/compare'})).error.code,'COMPARE_RUN_COUNT');
  assert.equal((await ask('?run_id='+ONE+'&run_id='+ONE,{path:PATH+'/compare'})).error.code,'DUPLICATE_RUN_ID');
  // the method gate and the path gate still come first
  assert.equal((await ask('?sort=x',{method:'POST'})).error.code,'METHOD_NOT_ALLOWED');
  assert.equal((await ask('?sort=x',{path:PATH+'/other'})).error.code,'NOT_FOUND');
  assert.equal((await ask('?sort=x',{path:'/api/other'})).handled,false);
});

test('rows keep creation order and no response field name is rank-like (D1, D2), on the list, detail and compare views',async()=>{
  const list=await ask('');
  assert.equal(list.sent.status,200);
  assert.equal(list.sent.body.runs.length,2);
  assert.deepEqual(list.sent.body.runs.map(run=>run.run_id),[ONE,TWO],'rows keep the order of the read (created_at, then run_id), no sort is applied');
  assert.deepEqual(developmentRowViolations(list.sent.body,'list'),[],'list field names');
  assert.equal(list.sent.body.qualified_winner,null);
  for(const run of list.sent.body.runs)assert.equal(typeof run.development_score.basis,'string','the score names its basis (D3 score_kind is not an API field; see the slice report)');
  for(const id of [ONE,TWO]){
    const detail=await ask('',{path:PATH+'/runs/'+id});
    assert.equal(detail.sent.status,200);
    assert.deepEqual(developmentRowViolations(detail.sent.body,'detail'),[],'detail field names '+id);
  }
  const compare=await ask(withRuns(''),{path:PATH+'/compare'});
  assert.equal(compare.sent.status,200);
  assert.equal(compare.sent.body.verdict,'COMPATIBLE');
  assert.deepEqual(compare.sent.body.runs.map(run=>run.run_id),[ONE,TWO],'compare keeps creation order');
  assert.deepEqual(developmentRowViolations(compare.sent.body,'compare'),[],'compare field names');
  assert.equal(compare.sent.body.qualified_winner,null);
  // the check can fail: a rank-like field name in a row is flagged, the fixed qualified_winner echo is not
  assert.deepEqual(developmentRowViolations({runs:[{rank:1}],qualified_winner:null}),['row.runs[0].rank']);
});

test('the change stays inside quant-library.js: no lifecycle allow-list import, and no engine closure file imports the library or is edited by this slice',()=>{
  const source=read('src/postgres/quant-library.js');
  const specifiers=[...source.matchAll(/^import\s[^;]*?from\s*'([^']+)'/gm)].map(match=>match[1]).sort();
  assert.deepEqual(specifiers,['../pine-bridge/source.js','../quant-library/derive.js','../selection/codes.js','./exposure-register.js']);
  assert.ok(!/lifecycle\.js|DEVELOPMENT_VIEW_PARAMS|checkDevelopmentViewRequest/.test(source),'the lifecycle allow-list is not imported (SB203 item 6)');
  assert.ok(!QUANT_RUNTIME_ENGINE_FILES.includes('src/postgres/quant-library.js'),'quant-library.js is not a runtime manifest member');
  for(const file of QUANT_RUNTIME_ENGINE_FILES.filter(item=>/\.(js|mjs)$/.test(item))){
    assert.ok(!/from\s*['"][^'"]*\/quant-library\.js['"]|import\s*\(\s*['"][^'"]*\/quant-library\.js['"]/.test(read(file)),file+' must not import src/postgres/quant-library.js (an edit would rotate engine identities)');
  }
});
