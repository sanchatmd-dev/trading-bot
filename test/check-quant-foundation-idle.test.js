import test from 'node:test';
import assert from 'node:assert/strict';
import {checkQuantFoundationIdle} from '../scripts/check-quant-foundation-idle.mjs';

function fixture({counts={},policies=[],missing=false,error=false}={}){
  const calls=[];
  const db={transaction:async(callback,options)=>{assert.equal(options.isolation,'REPEATABLE READ');return callback();},
    query:async sql=>{
      calls.push(sql);
      if(error)throw Error('private database detail');
      if(sql.startsWith('SET TRANSACTION'))return {rows:[]};
      if(sql.includes('to_regclass'))return {rows:[missing?{}:{foundation:'f',launches:'l',ledgers:'io'}]};
      if(sql.includes('active_jobs'))return {rows:[{active_jobs:0,unresolved_launches:0,unresolved_operations:0,invalid_ledgers:0,...counts}]};
      return {rows:policies};
    }};
  return {db,calls};
}
test('idle snapshot allows clean state and reports queued policy counts without mutating',async()=>{
  const policies=[{policy_hash:'a'.repeat(64),queued:2,paused:1}];
  const f=fixture({policies});assert.deepEqual(await checkQuantFoundationIdle(f.db),{ok:true,codes:[],queuedPolicies:policies});
  assert.equal(f.calls[0],'SET TRANSACTION READ ONLY');
  assert.ok(f.calls.every(sql=>/^(SELECT|SET TRANSACTION READ ONLY)/.test(sql)));
  for(const sql of f.calls)assert.doesNotMatch(sql,/\bFROM quant_(foundation_jobs|io_launches|io_ledgers)\b/);
});
test('each active executor, unresolved launch, unresolved operation and invalid ledger blocks',async()=>{
  for(const [field,code] of [['active_jobs','QUANT_IDLE_EXECUTOR_ACTIVE'],['unresolved_launches','QUANT_IDLE_LAUNCH_UNRESOLVED'],
    ['unresolved_operations','QUANT_IDLE_OPERATION_UNRESOLVED'],['invalid_ledgers','QUANT_IDLE_LEDGER_INVALID']]){
    const f=fixture({counts:{[field]:1}}),result=await checkQuantFoundationIdle(f.db);
    assert.equal(result.ok,false);assert.deepEqual(result.codes,[code]);
  }
});
test('missing schema and malformed or failed reads return only fixed codes',async()=>{
  assert.deepEqual((await checkQuantFoundationIdle(fixture({missing:true}).db)).codes,['QUANT_IDLE_SCHEMA_REQUIRED']);
  for(const options of [{error:true},{counts:{active_jobs:NaN}},{policies:[{policy_hash:'private/path',queued:1,paused:0}]}]){
    const result=await checkQuantFoundationIdle(fixture(options).db);
    assert.deepEqual(result,{ok:false,codes:['QUANT_IDLE_CHECK_FAILED'],queuedPolicies:[]});
  }
});
