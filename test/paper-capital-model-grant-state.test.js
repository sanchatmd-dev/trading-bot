import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {QUERIES,PaperCapitalModelGrantRefusal} from '../src/postgres/paper-capital-model-grants.js';
import {readPaperCapitalModelGrantState as readState,preM6AclDigest,READ_ONLY_STATEMENTS,GRANT_STATE_QUERIES,M6_FUNCTION_SIGNATURES,M6_TABLES,
  EXECUTE_ENTRY_REASON,OBJECTS_DIFFER_REASON} from '../src/postgres/paper-capital-model-grant-state.js';

// Unit tests of the read-only capital-model grant-state read and the pre-M6 ACL digest with a FAKE database driver: no PostgreSQL, no network.
// The fake dispatches on the exported query texts, keeps a small ACL model and records every statement. The real catalog behavior is covered by
// test/postgres/paper-capital-model-grant-state.test.mjs.
const ROLE='Robot_Runtime "Secret" Role',OWNER=10,RT=20,OTHER=30;
const MARKER='paper_capital_model_schema',DECL='paper_capital_models';
const ownerEntries=[[OWNER,OWNER,'INSERT',true],[OWNER,OWNER,'SELECT',true],[OWNER,OWNER,'UPDATE',true]];
const FUNCTION_OWNER=[[OWNER,OWNER,'EXECUTE',true]];
const PUBLIC_EXECUTE=[OWNER,0,'EXECUTE',false];
const EXACT_MARKER=[[OWNER,RT,'SELECT',false]],EXACT_DECL=[[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false]],EXACT_FN=[[OWNER,RT,'EXECUTE',false]];

/** Fake database. world.* is the model; null for an object means it does not exist. */
function fakeDb(overrides={}){
  const world={
    role:{oid:RT,superuser:false,bypass_rls:false},
    marker:[...ownerEntries],declarations:[...ownerEntries],column:{},fn:[...FUNCTION_OWNER,PUBLIC_EXECUTE],
    runtimeMember:false,ownerOf:{},readOnlyValue:'on',stringOids:false,throwOn:null,digest:'0123456789abcdef0123456789abcdef',...overrides};
  const log=[],options=[];
  const db={
    isTransaction:false,log,world,options,transactions:0,
    async transaction(fn,option){
      db.transactions++;options.push(option);db.isTransaction=true;
      try{return await fn();}finally{db.isTransaction=false;}
    },
    async query(sql,params=[]){
      log.push({sql,params});
      if(world.throwOn&&sql.includes(world.throwOn))throw Object.assign(new Error('permission denied for role "'+ROLE+'" at host HOSTMARK'),{code:'42501'});
      return {rows:rowsFor(sql)};
    }};
  const view=entries=>structuredClone(entries).map(entry=>world.stringOids?[String(entry[0]),String(entry[1]),entry[2],entry[3]]:entry);
  function rowsFor(sql){
    if(sql===READ_ONLY_STATEMENTS.SET_READ_ONLY)return [];
    if(sql===READ_ONLY_STATEMENTS.CHECK_READ_ONLY)return [{value:world.readOnlyValue}];
    if(sql===QUERIES.ROLE)return world.role?[world.role]:[];
    const present=[[DECL,world.declarations],[MARKER,world.marker]].filter(([,entries])=>entries!==null);
    if(sql===QUERIES.TABLES)return present.map(([name])=>({name,owner_oid:world.ownerOf[name]??OWNER,session_owns:true,runtime_member:world.runtimeMember}));
    if(sql===QUERIES.TABLE_ACL)return present.map(([name,entries])=>({name,owner_oid:world.ownerOf[name]??OWNER,entries:view(entries),column_acl:world.column[name]===true}));
    if(sql===QUERIES.FUNCTION_ACL)return world.fn===null?[]:[{owner_oid:world.ownerOf.fn??OWNER,entries:view(world.fn)}];
    if(sql===GRANT_STATE_QUERIES.PRE_M6_DIGEST)return [{digest:world.digest}];
    throw new Error('unexpected statement in the fake driver: '+sql.slice(0,70));
  }
  return db;
}
const refused=async(promise,code,details)=>{
  const error=await promise.then(()=>null,reason=>reason);
  assert.ok(error instanceof PaperCapitalModelGrantRefusal,'refusal expected, got '+(error&&error.message));
  assert.equal(error.code,code,error.message);
  if(details)assert.deepEqual(error.details,details);
  assert.equal(JSON.stringify([error.message,error.code,error.details]).includes('Secret'),false,'the refusal never names the role');
  assert.equal(error.message.includes(ROLE),false);
  return error;
};
const read=(overrides,options={})=>{const db=fakeDb(overrides);return readState(db,{runtimeRole:ROLE,...options}).then(result=>({db,result}));};
const OWNER_ONLY=[...ownerEntries];
const withRuntime=(base,extra)=>[...base,...extra];
const ALLOWED=/^(?:\/\*[^*]*\*\/\s*)?(SELECT|WITH)\b|^SET TRANSACTION READ ONLY$|^(BEGIN|COMMIT|ROLLBACK)\b/;
// The fake driver never sees BEGIN/COMMIT/ROLLBACK (db.transaction issues them), so a statement here is a SELECT or the one SET TRANSACTION.
const FORBIDDEN=/\b(INSERT|UPDATE|DELETE|GRANT|REVOKE|LOCK|CREATE|DROP|ALTER|TRUNCATE|set_config|pg_advisory\w*)\b|SET (ROLE|SESSION|LOCAL)|DO \$/i;

test('NONE: owner entries only; a PUBLIC EXECUTE entry on the function is not judged without includeExecute',async()=>{
  const {result}=await read({});
  assert.deepEqual(result,{state:'NONE',objects:{marker:'NONE',declarations:'NONE',function:'NOT_IN_SCOPE'},reasons:[],executeInScope:false});
  const withExecute=await read({fn:[...FUNCTION_OWNER]},{includeExecute:true});
  assert.deepEqual(withExecute.result,{state:'NONE',objects:{marker:'NONE',declarations:'NONE',function:'NONE'},reasons:[],executeInScope:true});
});

test('EXACT: the target entries on both tables; with includeExecute the function too',async()=>{
  const plain=await read({marker:withRuntime(OWNER_ONLY,EXACT_MARKER),declarations:withRuntime(OWNER_ONLY,EXACT_DECL)});
  assert.deepEqual(plain.result,{state:'EXACT',objects:{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'},reasons:[],executeInScope:false});
  const full=await read({marker:withRuntime(OWNER_ONLY,EXACT_MARKER),declarations:withRuntime(OWNER_ONLY,EXACT_DECL),fn:[...FUNCTION_OWNER,...EXACT_FN]},{includeExecute:true});
  assert.deepEqual(full.result,{state:'EXACT',objects:{marker:'EXACT',declarations:'EXACT',function:'EXACT'},reasons:[],executeInScope:true});
});

test('OTHER: every reason of the grant module classification names the object and keeps the reason label',async()=>{
  const cases=[
    ['PRIVILEGE_SET',{declarations:withRuntime(OWNER_ONLY,[[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false],[OWNER,RT,'UPDATE',false]])},DECL],
    ['PRIVILEGE_SET',{marker:withRuntime(OWNER_ONLY,[[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false]])},MARKER],
    ['PUBLIC_ENTRY',{declarations:withRuntime(OWNER_ONLY,[[OWNER,0,'SELECT',false]])},DECL],
    ['FOREIGN_GRANTEE',{declarations:withRuntime(OWNER_ONLY,[[OWNER,OTHER,'SELECT',false]])},DECL],
    ['GRANT_OPTION',{marker:withRuntime(OWNER_ONLY,[[OWNER,RT,'SELECT',true]])},MARKER],
    ['FOREIGN_GRANTOR',{marker:withRuntime(OWNER_ONLY,[[OTHER,RT,'SELECT',false]])},MARKER],
    ['DUPLICATE_ENTRY',{marker:withRuntime(OWNER_ONLY,[[OWNER,RT,"SELECT",false],[OWNER,RT,"SELECT",false]])},MARKER],
    ['COLUMN_ACL',{column:{[DECL]:true}},DECL]];
  for(const [reason,overrides,name] of cases){
    const {result}=await read(overrides);
    assert.equal(result.state,'OTHER',reason+' '+name);
    assert.deepEqual(result.reasons,[name+':'+reason]);
    assert.equal(result.executeInScope,false);
  }
  // The function is judged only with includeExecute: a PUBLIC EXECUTE entry (the PostgreSQL default) is then OTHER.
  const open=await read({},{includeExecute:true});
  assert.equal(open.result.state,'OTHER');assert.deepEqual(open.result.reasons,['paper_capital_model_now_ms:PUBLIC_ENTRY']);
  assert.deepEqual(open.result.objects,{marker:'NONE',declarations:'NONE',function:'OTHER'});
  // OTHER wins over a half state and over an EXECUTE entry.
  const worst=await read({marker:withRuntime(OWNER_ONLY,EXACT_MARKER),declarations:withRuntime(OWNER_ONLY,[[OWNER,OTHER,'SELECT',false]]),fn:[...FUNCTION_OWNER,...EXACT_FN]});
  assert.equal(worst.result.state,'OTHER');
});

test('MIXED by objects: one table EXACT and the other NONE; or the function differs under includeExecute',async()=>{
  const half=await read({marker:withRuntime(OWNER_ONLY,EXACT_MARKER)});
  assert.deepEqual(half.result,{state:'MIXED',objects:{marker:'EXACT',declarations:'NONE',function:'NOT_IN_SCOPE'},reasons:[OBJECTS_DIFFER_REASON],executeInScope:false});
  const tables=withRuntime(OWNER_ONLY,EXACT_DECL);
  const fn=await read({marker:withRuntime(OWNER_ONLY,EXACT_MARKER),declarations:tables,fn:[...FUNCTION_OWNER]},{includeExecute:true});
  assert.deepEqual([fn.result.state,fn.result.objects.function,fn.result.reasons],['MIXED','NONE',[OBJECTS_DIFFER_REASON]]);
});

test('MIXED by the EXECUTE rule: without includeExecute an explicit runtime EXECUTE entry is MIXED, never NONE and never EXACT',async()=>{
  const none=await read({fn:[...FUNCTION_OWNER,PUBLIC_EXECUTE,...EXACT_FN]});
  assert.deepEqual(none.result,{state:'MIXED',objects:{marker:'NONE',declarations:'NONE',function:'NOT_IN_SCOPE'},reasons:[EXECUTE_ENTRY_REASON],executeInScope:false});
  const exact=await read({marker:withRuntime(OWNER_ONLY,EXACT_MARKER),declarations:withRuntime(OWNER_ONLY,EXACT_DECL),fn:[...FUNCTION_OWNER,...EXACT_FN]});
  assert.equal(exact.result.state,'MIXED');
  // Any entry of the role counts, including a grant option; the same entry under includeExecute is classified by the module (OTHER for the grant option).
  const option=await read({fn:[...FUNCTION_OWNER,[OWNER,RT,'EXECUTE',true]]});
  assert.equal(option.result.state,'MIXED');
  const judged=await read({fn:[...FUNCTION_OWNER,[OWNER,RT,'EXECUTE',true]]},{includeExecute:true});
  assert.deepEqual([judged.result.state,judged.result.reasons],['OTHER',['paper_capital_model_now_ms:GRANT_OPTION']]);
  // Another role's EXECUTE entry is not the runtime role's entry.
  const foreign=await read({fn:[...FUNCTION_OWNER,[OWNER,OTHER,'EXECUTE',false]]});
  assert.equal(foreign.result.state,'NONE');
});

test('ABSENT: no M6 object, a missing table or a missing function is a state, not a throw',async()=>{
  const none=await read({marker:null,declarations:null,fn:null});
  assert.deepEqual(none.result,{state:'ABSENT',objects:{marker:'ABSENT',declarations:'ABSENT',function:'ABSENT'},reasons:['M6_ABSENT'],executeInScope:false});
  const noTable=await read({declarations:null});
  assert.deepEqual(noTable.result,{state:'ABSENT',objects:{marker:'NONE',declarations:'ABSENT',function:'NOT_IN_SCOPE'},reasons:['M6_PARTIAL'],executeInScope:false});
  const noFunction=await read({fn:null},{includeExecute:true});
  assert.deepEqual([noFunction.result.state,noFunction.result.objects.function,noFunction.result.reasons],['ABSENT','ABSENT',['M6_PARTIAL']]);
  // A partial M6 that already holds a foreign grant keeps the reason and the object state: the reader does not call it clean.
  const dirty=await read({declarations:null,marker:withRuntime(OWNER_ONLY,[[OWNER,0,'SELECT',false]])});
  assert.deepEqual([dirty.result.state,dirty.result.objects.marker,dirty.result.reasons],['ABSENT','OTHER',['M6_PARTIAL',MARKER+':PUBLIC_ENTRY']]);
});

test('oid type: a string oid in the ACL entries, the owner or the role refuses ACL_OID_TYPE instead of comparing wrongly',async()=>{
  await refused(read({stringOids:true,marker:withRuntime(OWNER_ONLY,EXACT_MARKER)}).then(x=>x.result),'ACL_OID_TYPE');
  await refused(read({role:{oid:'20',superuser:false,bypass_rls:false}}).then(x=>x.result),'ACL_OID_TYPE');
  await refused(read({ownerOf:{[MARKER]:'10'}}).then(x=>x.result),'ACL_OID_TYPE');
  await refused(read({ownerOf:{fn:'10'}}).then(x=>x.result),'ACL_OID_TYPE');
  await refused(read({role:{oid:-1}}).then(x=>x.result),'ACL_OID_TYPE');
});

test('role refusals: missing, owner of an object, member of the owner; nothing names the role',async()=>{
  await refused(read({role:null}).then(x=>x.result),'RUNTIME_ROLE_MISSING');
  await refused(read({ownerOf:{[DECL]:RT}}).then(x=>x.result),'RUNTIME_ROLE_IS_OWNER');
  await refused(read({ownerOf:{fn:RT}}).then(x=>x.result),'RUNTIME_ROLE_IS_OWNER');
  await refused(read({runtimeMember:true}).then(x=>x.result),'RUNTIME_ROLE_IS_OWNER');
  // Parity with the grant module (grants.js:147-148): a superuser or BYPASSRLS runtime role is refused before any classification.
  await refused(read({role:{oid:RT,superuser:true,bypass_rls:false}}).then(x=>x.result),'RUNTIME_ROLE_SUPERUSER');
  await refused(read({role:{oid:RT,superuser:false,bypass_rls:true}}).then(x=>x.result),'RUNTIME_ROLE_BYPASSRLS');
});

test('option and database refusals leave before any statement',async()=>{
  const db=fakeDb();
  for(const options of [{},{runtimeRole:''},{runtimeRole:7},{runtimeRole:'a\u0000b'},{runtimeRole:'x'.repeat(64)},{runtimeRole:'é'.repeat(32)}])
    await refused(readState(db,options),'RUNTIME_ROLE_INVALID');
  for(const includeExecute of ['true',1,null])await refused(readState(db,{runtimeRole:ROLE,includeExecute}),'OPTION_INVALID');
  await refused(readState({},{runtimeRole:ROLE}),'DATABASE_INVALID');
  assert.equal(db.log.length,0);assert.equal(db.transactions,0);
  const inside=fakeDb();inside.isTransaction=true;
  await refused(readState(inside,{runtimeRole:ROLE}),'NOT_OWN_TRANSACTION');
  await refused(preM6AclDigest(inside),'NOT_OWN_TRANSACTION');
  assert.equal(inside.log.length,0);
});

test('one READ ONLY transaction: read-only mode is the first statement and is read back; a database that does not enforce it refuses',async()=>{
  const {db}=await read({});
  assert.equal(db.transactions,1);
  assert.deepEqual(db.options,[{isolation:'REPEATABLE READ'}]);
  assert.equal(db.log[0].sql,'SET TRANSACTION READ ONLY');
  assert.equal(db.log[1].sql,READ_ONLY_STATEMENTS.CHECK_READ_ONLY);
  assert.deepEqual(db.log.slice(2).map(item=>item.sql),[QUERIES.ROLE,QUERIES.TABLES,QUERIES.TABLE_ACL,QUERIES.FUNCTION_ACL]);
  const off=fakeDb({readOnlyValue:'off'});
  await refused(readState(off,{runtimeRole:ROLE}),'READ_ONLY_NOT_ENFORCED');
  assert.equal(off.log.length,2,'nothing is read once read-only mode is not confirmed');
  const digestOff=fakeDb({readOnlyValue:'off'});
  await refused(preM6AclDigest(digestOff),'READ_ONLY_NOT_ENFORCED');
});

test('no write statement is ever issued, no lock, no role change; the role is a bound parameter of the role and table queries only',async()=>{
  const dbs=[];
  for(const [overrides,options] of [[{},{}],[{marker:null,declarations:null,fn:null},{}],[{fn:[...FUNCTION_OWNER]},{includeExecute:true}],[{fn:[...FUNCTION_OWNER,...EXACT_FN]},{}]]){
    const {db}=await read(overrides,options);dbs.push(db);
  }
  const digestDb=fakeDb();await preM6AclDigest(digestDb);dbs.push(digestDb);
  for(const db of dbs){
    for(const {sql,params} of db.log){
      assert.match(sql,ALLOWED,sql.slice(0,60));
      assert.doesNotMatch(sql.replace(/^\/\*.*?\*\/\s*/,''),FORBIDDEN,sql.slice(0,60));
      assert.equal(sql.includes(ROLE),false,'the role is never in a statement text');
      if(params.length&&!sql.includes('pcm-grant:role')&&!sql.includes('pcm-grant:tables'))assert.equal(JSON.stringify(params).includes('Secret'),false,'the role is bound only where it is needed');
    }
  }
  const bound=dbs[0].log.filter(item=>item.params.includes(ROLE)).map(item=>item.sql);
  assert.deepEqual(bound,[QUERIES.ROLE,QUERIES.TABLES]);
});

test('the role name is in no returned value and in no error',async()=>{
  for(const [overrides,options] of [[{},{}],[{marker:null,declarations:null,fn:null},{}],[{declarations:withRuntime(OWNER_ONLY,[[OWNER,0,'SELECT',false]])},{includeExecute:true}],[{fn:[...FUNCTION_OWNER,...EXACT_FN]},{}]]){
    const {result}=await read(overrides,options);
    assert.equal(JSON.stringify(result).includes('Secret'),false);assert.equal(JSON.stringify(result).includes(ROLE),false);
  }
  // A driver error leaves only its SQLSTATE: the fake message names the role and a host.
  for(const marker of ['pcm-grant:table-acl','pcm-grant:role','pcm-grant:function-acl','pcm-grant:tables','pcm-grant-state:digest']){
    const db=fakeDb({throwOn:marker});
    const call=marker==='pcm-grant-state:digest'?preM6AclDigest(db):readState(db,{runtimeRole:ROLE});
    const error=await refused(call,'DATABASE_ERROR',['42501']);
    assert.equal(JSON.stringify([error.message,error.details,Object.keys(error)]).includes('HOSTMARK'),false);
  }
  const unknown=fakeDb();unknown.query=async()=>{throw new Error('boom '+ROLE);};
  await refused(readState(unknown,{runtimeRole:ROLE}),'DATABASE_ERROR',['UNKNOWN']);
});

test('the grant-state read reuses the accepted module queries without a changed text and the exported M6 sets match the install SQL',()=>{
  const sql=fs.readFileSync(new URL('../src/postgres/paper-capital-model.sql',import.meta.url),'utf8');
  const functions=[...sql.matchAll(/CREATE FUNCTION public\.(\w+)\(([^)]*)\)/g)];
  assert.equal(functions.length,6);
  assert.deepEqual(functions.map(match=>match[1]+'('+match[2]+')').sort(),[...M6_FUNCTION_SIGNATURES].sort());
  const tables=[...sql.matchAll(/CREATE TABLE public\.(\w+)\(/g)].map(match=>match[1]);
  assert.deepEqual(tables.sort(),[...M6_TABLES].sort());
  assert.equal(/CREATE SEQUENCE/i.test(sql),false,'M6 creates no sequence');
  // M6 adds no object class the digest exclusion list does not name: no replaced function, implicit sequence, identity column or view.
  const code=sql.replace(/--.*$/gm,'');
  for(const pattern of [/CREATE OR REPLACE/i,/\bserial\b/i,/\bbigserial\b/i,/\bIDENTITY\b/i,/CREATE (OR REPLACE )?(MATERIALIZED )?VIEW/i])
    assert.equal(pattern.test(code),false,'M6 SQL has no '+pattern);
});

test('preM6AclDigest: one read, the two table names and six function signatures bound, result is {digest}',async()=>{
  const db=fakeDb();
  const result=await preM6AclDigest(db);
  assert.deepEqual(result,{digest:'0123456789abcdef0123456789abcdef'});
  assert.deepEqual(db.log.map(item=>item.sql),['SET TRANSACTION READ ONLY',READ_ONLY_STATEMENTS.CHECK_READ_ONLY,GRANT_STATE_QUERIES.PRE_M6_DIGEST]);
  assert.deepEqual(db.log[2].params,[[MARKER,DECL],[...M6_FUNCTION_SIGNATURES]]);
  assert.equal(M6_FUNCTION_SIGNATURES.length,6);
  const query=GRANT_STATE_QUERIES.PRE_M6_DIGEST;
  assert.match(query,/^\/\* pcm-grant-state:digest \*\/ SELECT /);
  assert.equal(query.includes('<>ALL($1::text[])'),true);assert.equal(query.includes('<>ALL($2::text[])'),true);
  // Same object classes as the accepted digest: relations, column ACLs, schema, database, public functions, default ACLs.
  for(const part of ['pg_class','pg_attribute','pg_namespace','pg_database','pg_proc','pg_default_acl'])assert.equal(query.includes('pg_catalog.'+part),true,part);
  assert.equal(query.includes(ROLE),false);
  for(const bad of [{digest:'short'},{digest:null},{}]){
    await refused(preM6AclDigest(fakeDb({digest:bad.digest})),'DIGEST_TYPE');
  }
});
