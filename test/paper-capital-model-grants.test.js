import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {grantPaperCapitalModelRuntime as grant,revokePaperCapitalModelRuntime as revoke,classifyAcl,STATEMENTS,QUERIES,GRANT_SETTING,
  SERVER_TARGET_QUERY,sameServerTarget,PaperCapitalModelGrantRefusal} from '../src/postgres/paper-capital-model-grants.js';

// Unit tests of the targeted capital-model grant with a FAKE database driver: no PostgreSQL, no network. The fake dispatches on the tag comment of each
// read-only query and on the fixed statement texts, keeps a small ACL model and applies the DO-block statements to it, so the module's own verification
// runs against the model. The real catalog behavior is covered by test/postgres/paper-capital-model-grants.test.mjs.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const ROLE='Robot_Runtime "Secret" Role',OWNER=10,RT=20,OTHER=30;
const MARKER='paper_capital_model_schema',DECL='paper_capital_models';
const ownerEntries=[[OWNER,OWNER,'INSERT',true],[OWNER,OWNER,'SELECT',true],[OWNER,OWNER,'UPDATE',true]];
const FUNCTION_OWNER=[[OWNER,OWNER,'EXECUTE',true]];
// The PostgreSQL default of a new function: PUBLIC holds EXECUTE. noPublicExecute models default privileges that removed it (the EXECUTE branch).
const PUBLIC_EXECUTE=[OWNER,0,'EXECUTE',false];
const CAST='x.grantor::pg_catalog.int8,x.grantee::pg_catalog.int8';
const privilegesOf=(entries,role)=>entries.filter(entry=>entry[1]===role).map(entry=>entry[2]);

/** Fake database. world.* is the model; hooks inject faults. */
function fakeDb(overrides={}){
  const world={
    schemaOk:true,lockHeld:false,role:{oid:RT,superuser:false,bypass_rls:false},
    tables:[{name:DECL,owner_oid:OWNER,session_owns:true,runtime_member:false},{name:MARKER,owner_oid:OWNER,session_owns:true,runtime_member:false}],
    acl:{[MARKER]:{entries:[...ownerEntries],column:false},[DECL]:{entries:[...ownerEntries],column:false},
      fn:{entries:[...FUNCTION_OWNER,...(overrides.noPublicExecute?[]:[PUBLIC_EXECUTE])]}},
    digest:{digest:'d0',relations:42},digestAfterApply:null,afterApply:null,throwOn:null,stringOids:false,lockTablesError:null,afterLock:null,...overrides};
  const log=[];let applied=false;
  const snapshot=()=>structuredClone({acl:world.acl,applied});
  const db={
    isTransaction:false,log,world,transactions:0,rolledBack:0,
    async transaction(fn){
      db.transactions++;const saved=snapshot();db.isTransaction=true;
      try{return await fn();}
      catch(error){db.rolledBack++;world.acl=saved.acl;applied=saved.applied;throw error;}
      finally{db.isTransaction=false;}
    },
    async maintenanceLock(){if(world.lockHeld)throw new Error('Stop every PostgreSQL API and worker before maintenance');},
    async verifySchema(){if(!world.schemaOk)throw new Error('Initialize/import schema 14 offline before starting PostgreSQL services');},
    async query(sql,params=[]){
      log.push({sql,params});
      if(world.throwOn&&sql.includes(world.throwOn))throw Object.assign(new Error('permission denied for role "'+ROLE+'" at host HOSTMARK'),{code:'42501'});
      const rows=rowsFor(sql,params);return {rows};
    }};
  const grantOf=(key,privileges,grantable=false)=>privileges.forEach(privilege=>world.acl[key].entries.push([OWNER,RT,privilege,grantable]));
  const dropOf=(key,privileges)=>{world.acl[key].entries=world.acl[key].entries.filter(entry=>!(entry[1]===RT&&privileges.includes(entry[2])));};
  function rowsFor(sql){
    if(sql.includes('pcm-grant:role'))return world.role?[world.role]:[];
    if(sql.includes('pcm-grant:tables'))return world.tables;
    // pg returns aclexplode oids inside json_build_array as strings unless the query casts them to int8; the fake does the same.
    const view=entries=>structuredClone(entries).map(entry=>world.stringOids&&!sql.includes(CAST)?[String(entry[0]),String(entry[1]),entry[2],entry[3]]:entry);
    if(sql.includes('pcm-grant:table-acl'))return [MARKER,DECL].map(name=>({name,owner_oid:OWNER,entries:view(world.acl[name].entries),column_acl:world.acl[name].column}));
    if(sql.includes('pcm-grant:function-acl'))return [{owner_oid:OWNER,entries:view(world.acl.fn.entries)}];
    if(sql.includes('pcm-grant:privileges')){
      const held=key=>privilegesOf(world.acl[key].entries,RT);
      return [{marker_select:held(MARKER).includes('SELECT'),marker_insert:held(MARKER).includes('INSERT'),declarations_select:held(DECL).includes('SELECT'),
        declarations_insert:held(DECL).includes('INSERT'),function_execute:held('fn').includes('EXECUTE')||world.acl.fn.entries.some(entry=>entry[1]===0)}];
    }
    if(sql.includes('pcm-grant:digest'))return [applied&&world.digestAfterApply?world.digestAfterApply:world.digest];
    if(sql===STATEMENTS.LOCK_TABLES){
      if(world.lockTablesError)throw Object.assign(new Error('canceling statement due to lock timeout at host HOSTMARK for "'+ROLE+'"'),{code:world.lockTablesError});
      world.afterLock?.(world);return [{applied:'x'}];
    }
    if(sql===STATEMENTS.SET_ROLE||sql===STATEMENTS.LOCK_TIMEOUT)return [{applied:'x'}];
    const apply={[STATEMENTS.GRANT_MARKER]:()=>grantOf(MARKER,['SELECT']),[STATEMENTS.GRANT_DECLARATIONS]:()=>grantOf(DECL,['INSERT','SELECT']),
      [STATEMENTS.GRANT_EXECUTE]:()=>grantOf('fn',['EXECUTE']),[STATEMENTS.REVOKE_MARKER]:()=>dropOf(MARKER,['SELECT','INSERT']),
      [STATEMENTS.REVOKE_DECLARATIONS]:()=>dropOf(DECL,['SELECT','INSERT']),[STATEMENTS.REVOKE_EXECUTE]:()=>dropOf('fn',['EXECUTE'])}[sql];
    if(apply){apply();applied=true;world.afterApply?.(world);return [];}
    throw new Error('unexpected statement in the fake driver: '+sql.slice(0,60));
  }
  return db;
}
const installed={ok:true,failures:[],facts:{state:'INSTALLED'}};
const inspectOk=()=>({inspect:async()=>installed});
const inspectCalls=[];
const inspectWith=reply=>({inspect:async(db,options)=>{inspectCalls.push(options);return typeof reply==='function'?reply(db,options):reply;}});
const refused=async(promise,code,details)=>{
  const error=await promise.then(()=>null,reason=>reason);
  assert.ok(error instanceof PaperCapitalModelGrantRefusal,'refusal expected, got '+(error&&error.message));
  assert.equal(error.code,code,error.message);
  if(details)assert.deepEqual(error.details,details);
  assert.equal(error.message.includes(ROLE),false,'the refusal never names the role');
  assert.equal(error.message.includes('Secret'),false);
  return error;
};
const ran=db=>db.log.map(item=>item.sql);
const writes=db=>ran(db).filter(sql=>sql.startsWith('DO $pcm$'));
const OPTIONS={runtimeRole:ROLE};

test('statements are fixed texts that grant or revoke exactly the capital-model privileges and never contain a role',()=>{
  const allowed=/^DO \$pcm\$ BEGIN EXECUTE pg_catalog\.format\('(GRANT|REVOKE) (SELECT|SELECT, INSERT|EXECUTE) ON (TABLE public\.paper_capital_model_schema|TABLE public\.paper_capital_models|FUNCTION public\.paper_capital_model_now_ms\(\)) (TO|FROM) %I',pg_catalog\.current_setting\('robot\.pcm_grant_role'\)\); END \$pcm\$$/;
  const doTexts=Object.entries(STATEMENTS).filter(([key])=>/^(GRANT|REVOKE)_/.test(key));
  assert.equal(doTexts.length,6);
  for(const [key,text] of doTexts)assert.match(text,allowed,key);
  assert.deepEqual(doTexts.map(([,text])=>text.match(/format\('([^']+)'/)[1]),[
    'GRANT SELECT ON TABLE public.paper_capital_model_schema TO %I','GRANT SELECT, INSERT ON TABLE public.paper_capital_models TO %I',
    'GRANT EXECUTE ON FUNCTION public.paper_capital_model_now_ms() TO %I','REVOKE SELECT ON TABLE public.paper_capital_model_schema FROM %I',
    'REVOKE SELECT, INSERT ON TABLE public.paper_capital_models FROM %I','REVOKE EXECUTE ON FUNCTION public.paper_capital_model_now_ms() FROM %I']);
  const all=[...Object.values(STATEMENTS),...Object.values(QUERIES)].join('\n');
  for(const forbidden of ['GRANT OPTION','PUBLIC','ALL PRIVILEGES','ON SCHEMA','DEFAULT PRIVILEGES','ALL TABLES','UPDATE ON','DELETE ON','TRUNCATE ON','TRIGGER ON','CASCADE'])
    assert.equal(STATEMENTS.GRANT_MARKER.includes(forbidden)||Object.values(STATEMENTS).some(text=>text.includes(forbidden)),false,forbidden);
  assert.equal(all.includes('GRANT SELECT ON TABLE public.users'),false);
  assert.equal(STATEMENTS.LOCK_TIMEOUT,"SET LOCAL lock_timeout = '5s'");
  assert.equal(STATEMENTS.LOCK_TABLES,'LOCK TABLE public.paper_capital_model_schema, public.paper_capital_models IN ACCESS EXCLUSIVE MODE');
  assert.equal(STATEMENTS.SET_ROLE,"SELECT pg_catalog.set_config('"+GRANT_SETTING+"',$1::text,true) AS applied");
});

test('classifyAcl: NONE, EXACT and every OTHER shape',()=>{
  const wanted=['INSERT','SELECT'];
  const c=(entries,extra={})=>classifyAcl({entries:[...ownerEntries,...entries],ownerOid:OWNER,runtimeOid:RT,wanted,...extra});
  assert.deepEqual(c([]),{state:'NONE',reason:null});
  assert.deepEqual(c([[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false]]),{state:'EXACT',reason:null});
  const other=(entries,reason,extra)=>assert.deepEqual(c(entries,extra),{state:'OTHER',reason});
  other([[OWNER,RT,'SELECT',false]],'PRIVILEGE_SET');
  other([[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false],[OWNER,RT,'UPDATE',false]],'PRIVILEGE_SET');
  other([[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',true]],'GRANT_OPTION');
  other([[OWNER,0,'SELECT',false]],'PUBLIC_ENTRY');
  other([[OWNER,OTHER,'SELECT',false]],'FOREIGN_GRANTEE');
  other([[OTHER,RT,'SELECT',false],[OWNER,RT,'INSERT',false]],'FOREIGN_GRANTOR');
  other([[OWNER,RT,'SELECT',false],[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false]],'DUPLICATE_ENTRY');
  other([[OWNER,RT,'SELECT',false],[OWNER,RT,'INSERT',false]],'COLUMN_ACL',{columnAcl:true});
  assert.deepEqual(classifyAcl({entries:[[OWNER,OWNER,'EXECUTE',true]],ownerOid:OWNER,runtimeOid:RT,wanted:['EXECUTE']}),{state:'NONE',reason:null});
  assert.equal(classifyAcl({entries:[[OWNER,OWNER,'EXECUTE',true],[OWNER,0,'EXECUTE',false]],ownerOid:OWNER,runtimeOid:RT,wanted:['EXECUTE']}).reason,'PUBLIC_ENTRY');
});

test('grant from NONE: lock tables, set the role once as a parameter, two statements, verified, role never in text or result',async()=>{
  const db=fakeDb();inspectCalls.length=0;
  const result=await grant(db,OPTIONS,inspectWith(installed));
  assert.deepEqual(result,{action:'grant',changed:true,statements:2,before:{marker:'NONE',declarations:'NONE',function:'NOT_IN_SCOPE'},
    after:{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'},execute_in_scope:false,inspection_ok:true,other_relations:42,other_acl_unchanged:true});
  assert.equal(db.transactions,1);assert.equal(db.rolledBack,0);
  const sql=ran(db);
  assert.ok(sql.indexOf(STATEMENTS.LOCK_TIMEOUT)>=0&&sql.indexOf(STATEMENTS.LOCK_TIMEOUT)<sql.indexOf(STATEMENTS.LOCK_TABLES),'lock_timeout is set before the table lock');
  assert.ok(sql.indexOf(STATEMENTS.LOCK_TABLES)>=0&&sql.indexOf(STATEMENTS.LOCK_TABLES)<sql.indexOf(STATEMENTS.SET_ROLE));
  const afterLock=sql.slice(sql.indexOf(STATEMENTS.LOCK_TABLES));
  assert.ok(afterLock.some(text=>text.includes('pcm-grant:role'))&&afterLock.some(text=>text.includes('pcm-grant:tables')),'role and ownership facts are read again with the lock held');
  assert.ok(sql.indexOf(STATEMENTS.SET_ROLE)<sql.indexOf(STATEMENTS.GRANT_MARKER));
  assert.deepEqual(writes(db),[STATEMENTS.GRANT_MARKER,STATEMENTS.GRANT_DECLARATIONS],'exactly the two table statements, no function statement');
  assert.equal(sql.filter(text=>text===STATEMENTS.SET_ROLE).length,1);
  for(const item of db.log){
    assert.equal(item.sql.includes(ROLE),false,'the role is never statement text');
    if(item.params.includes(ROLE))assert.match(item.sql,/pcm-grant:(role|tables|privileges)|set_config/);
  }
  assert.equal(JSON.stringify(result).includes('Secret'),false);
  assert.deepEqual(inspectCalls.map(options=>options.requireGrants),[false,true],'inspect before without, after with the grants required');
  assert.ok(inspectCalls.every(options=>options.runtimeRole===ROLE));
  assert.equal(privilegesOf(db.world.acl[DECL].entries,RT).sort().join(),'INSERT,SELECT');
  assert.equal(privilegesOf(db.world.acl[MARKER].entries,RT).join(),'SELECT');
});

test('grant over EXACT is a no-op pass: no set_config, no write statement',async()=>{
  const db=fakeDb();await grant(db,OPTIONS,inspectOk());
  const again=fakeDb({acl:structuredClone(db.world.acl)});
  const result=await grant(again,OPTIONS,inspectOk());
  assert.equal(result.changed,false);assert.equal(result.statements,0);
  assert.deepEqual(result.before,{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'});
  assert.deepEqual(writes(again),[]);assert.equal(ran(again).includes(STATEMENTS.SET_ROLE),false);
});

test('every OTHER state refuses with no write statement',async()=>{
  const cases={
    'extra privilege on declarations':w=>w.acl[DECL].entries.push([OWNER,RT,'UPDATE',false]),
    'extra privilege on marker':w=>w.acl[MARKER].entries.push([OWNER,RT,'INSERT',false]),
    'PUBLIC entry':w=>w.acl[DECL].entries.push([OWNER,0,'SELECT',false]),
    'grant option':w=>w.acl[MARKER].entries.push([OWNER,RT,'SELECT',true]),
    'column grant':w=>{w.acl[DECL].column=true;},
    'another grantee':w=>w.acl[DECL].entries.push([OWNER,OTHER,'SELECT',false]),
    'partial declarations':w=>w.acl[DECL].entries.push([OWNER,RT,'SELECT',false])};
  for(const [label,tamper] of Object.entries(cases)){
    for(const action of [grant,revoke]){
      const db=fakeDb();tamper(db.world);const before=structuredClone(db.world.acl);
      await refused(action(db,OPTIONS,inspectOk()),'ACL_STATE_OTHER');
      assert.deepEqual(writes(db),[],label);assert.deepEqual(db.world.acl,before,label+': ACL unchanged');
      assert.equal(ran(db).includes(STATEMENTS.SET_ROLE),false,label);
    }
  }
});

test('a half state (marker EXACT, declarations NONE) refuses as mixed',async()=>{
  const db=fakeDb();db.world.acl[MARKER].entries.push([OWNER,RT,'SELECT',false]);
  await refused(grant(db,OPTIONS,inspectOk()),'ACL_STATE_MIXED');await refused(revoke(db,OPTIONS,inspectOk()),'ACL_STATE_MIXED');
  assert.deepEqual(writes(db),[]);
});

test('revoke: EXACT to NONE with the exact reverse statements; repeat is a no-op',async()=>{
  const db=fakeDb();await grant(db,OPTIONS,inspectOk());
  const result=await revoke(db,OPTIONS,inspectOk());
  assert.equal(result.changed,true);assert.equal(result.statements,2);
  assert.deepEqual(result.before,{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'});
  assert.deepEqual(result.after,{marker:'NONE',declarations:'NONE',function:'NOT_IN_SCOPE'});
  assert.deepEqual(writes(db).slice(-2),[STATEMENTS.REVOKE_MARKER,STATEMENTS.REVOKE_DECLARATIONS]);
  assert.equal(privilegesOf(db.world.acl[DECL].entries,RT).length+privilegesOf(db.world.acl[MARKER].entries,RT).length,0);
  const again=await revoke(db,OPTIONS,inspectOk());
  assert.equal(again.changed,false);assert.equal(again.statements,0);
});

test('EXECUTE branch: only with the option; PUBLIC entry or a missing option with an explicit entry refuses',async()=>{
  const db=fakeDb({noPublicExecute:true});
  const withExecute=await grant(db,{...OPTIONS,includeExecute:true},inspectOk());
  assert.equal(withExecute.execute_in_scope,true);assert.equal(withExecute.statements,3);
  assert.deepEqual(withExecute.after,{marker:'EXACT',declarations:'EXACT',function:'EXACT'});
  assert.deepEqual(writes(db),[STATEMENTS.GRANT_MARKER,STATEMENTS.GRANT_DECLARATIONS,STATEMENTS.GRANT_EXECUTE]);
  // A grant without the option never touches the function.
  const plain=fakeDb();await grant(plain,OPTIONS,inspectOk());
  assert.equal(ran(plain).includes(STATEMENTS.GRANT_EXECUTE),false);
  // The default PUBLIC EXECUTE entry contradicts the claim that default privileges removed it.
  const open=fakeDb();
  await refused(grant(open,{...OPTIONS,includeExecute:true},inspectOk()),'ACL_STATE_OTHER',['paper_capital_model_now_ms:PUBLIC_ENTRY']);
  assert.deepEqual(writes(open),[]);
  // Revoke without the option while an explicit runtime entry exists refuses; with the option it reverses all three.
  const half=fakeDb({noPublicExecute:true});await grant(half,{...OPTIONS,includeExecute:true},inspectOk());
  await refused(revoke(half,OPTIONS,inspectOk()),'ACL_STATE_OTHER');
  const reversed=await revoke(half,{...OPTIONS,includeExecute:true},inspectOk());
  assert.deepEqual(reversed.after,{marker:'NONE',declarations:'NONE',function:'NONE'});assert.equal(reversed.statements,3);
  // An explicit runtime EXECUTE entry with a grant that leaves the option out is a half state, not a silent pass.
  const explicit=fakeDb({noPublicExecute:true});await grant(explicit,{...OPTIONS,includeExecute:true},inspectOk());
  await refused(grant(explicit,OPTIONS,inspectOk()),'ACL_STATE_MIXED',['paper_capital_model_now_ms:EXECUTE_ENTRY_NEEDS_INCLUDE_EXECUTE']);
  assert.deepEqual(writes(explicit).slice(3),[]);
  // Function EXACT but tables NONE is mixed.
  const mixed=fakeDb({noPublicExecute:true});mixed.world.acl.fn.entries.push([OWNER,RT,'EXECUTE',false]);
  await refused(grant(mixed,{...OPTIONS,includeExecute:true},inspectOk()),'ACL_STATE_MIXED');
});

test('preconditions refuse before any write statement',async()=>{
  const guard=async(label,world,code,details,deps=inspectOk())=>{
    const db=fakeDb(world);await refused(grant(db,OPTIONS,deps),code,details);
    assert.deepEqual(writes(db),[],label);assert.equal(ran(db).includes(STATEMENTS.SET_ROLE),false,label);assert.equal(db.rolledBack,1,label+': rolled back');
    return db;
  };
  const held=await guard('lock held',{lockHeld:true},'MAINTENANCE_LOCK_HELD');
  assert.equal(held.log.length,0,'nothing was read after the lock refusal');
  await guard('schema',{schemaOk:false},'SCHEMA_NOT_14');
  await guard('missing role',{role:null},'RUNTIME_ROLE_MISSING');
  await guard('superuser',{role:{oid:RT,superuser:true,bypass_rls:false}},'RUNTIME_ROLE_SUPERUSER');
  await guard('bypassrls',{role:{oid:RT,superuser:false,bypass_rls:true}},'RUNTIME_ROLE_BYPASSRLS');
  await guard('absent tables',{tables:[]},'M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  await guard('one table',{tables:[{name:DECL,owner_oid:OWNER,session_owns:true,runtime_member:false}]},'M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  await guard('non-owner session',{tables:[{name:DECL,owner_oid:OWNER,session_owns:false,runtime_member:false},{name:MARKER,owner_oid:OWNER,session_owns:true,runtime_member:false}]},'SESSION_NOT_OWNER');
  await guard('runtime owns',{tables:[{name:DECL,owner_oid:RT,session_owns:true,runtime_member:true},{name:MARKER,owner_oid:RT,session_owns:true,runtime_member:true}]},'RUNTIME_ROLE_IS_OWNER');
  await guard('runtime member of owner',{tables:[{name:DECL,owner_oid:OWNER,session_owns:true,runtime_member:true},{name:MARKER,owner_oid:OWNER,session_owns:true,runtime_member:false}]},'RUNTIME_ROLE_IS_OWNER');
  for(const state of ['OTHER','ABSENT'])await guard('M6 '+state,{},'M6_NOT_INSTALLED',[state],inspectWith({ok:false,failures:['TRIGGER_NOT_ALWAYS:x'],facts:{state}}));
  const privileged=await guard('inspection failure',{},'RUNTIME_ROLE_INSPECTION_FAILED',['RUNTIME_ROLE_PRIVILEGED_MEMBER','RUNTIME_ROLE_OWNS:paper_capital_models'],
    inspectWith({ok:false,failures:['RUNTIME_ROLE_PRIVILEGED_MEMBER:some_superuser_role','RUNTIME_ROLE_OWNS:paper_capital_models'],facts:{state:'INSTALLED'}}));
  assert.equal(privileged.log.some(item=>item.sql===STATEMENTS.LOCK_TABLES),true,'inspection runs after the table lock');
  // Facts that change while the table lock is acquired are judged by the second read.
  await guard('role turns superuser under the lock',{afterLock:w=>{w.role={...w.role,superuser:true};}},'RUNTIME_ROLE_SUPERUSER');
  await guard('ownership changes under the lock',{afterLock:w=>{w.tables=w.tables.map(table=>({...table,owner_oid:RT,runtime_member:true}));}},'RUNTIME_ROLE_IS_OWNER');
});

test('invalid options refuse before the database is touched',async()=>{
  for(const runtimeRole of [undefined,'',null,5,'a'.repeat(64),'é'.repeat(32),'bad\u0000role']){
    const db=fakeDb();await refused(grant(db,{runtimeRole},inspectOk()),'RUNTIME_ROLE_INVALID');assert.equal(db.transactions,0);
  }
  await refused(grant(fakeDb(),{...OPTIONS,includeExecute:'yes'},inspectOk()),'OPTION_INVALID');
  const nested=fakeDb();nested.isTransaction=true;
  await refused(grant(nested,OPTIONS,inspectOk()),'NOT_OWN_TRANSACTION');
  assert.equal((await grant(fakeDb(),{runtimeRole:'a'.repeat(63)},inspectOk())).changed,true,'63 bytes are allowed');
});

test('verification failures roll the transaction back and refuse',async()=>{
  const cases=[
    ['extra privilege appears',{afterApply:w=>w.acl[DECL].entries.push([OWNER,RT,'UPDATE',false])},'VERIFY_ACL_STATE'],
    ['PUBLIC appears',{afterApply:w=>w.acl[MARKER].entries.push([OWNER,0,'SELECT',false])},'VERIFY_ACL_STATE'],
    ['other relation ACL changes',{digestAfterApply:{digest:'changed',relations:42}},'VERIFY_OTHER_ACL_CHANGED'],
    ['relation count changes',{digestAfterApply:{digest:'d0',relations:43}},'VERIFY_OTHER_ACL_CHANGED']];
  for(const [label,world,code] of cases){
    const db=fakeDb(world);const before=structuredClone(db.world.acl);
    await refused(grant(db,OPTIONS,inspectOk()),code);
    assert.equal(db.rolledBack,1,label);assert.deepEqual(db.world.acl,before,label+': the model is back to the start');
  }
  const failing=fakeDb();
  await refused(grant(failing,OPTIONS,inspectWith((db,options)=>options.requireGrants?{ok:false,failures:['RUNTIME_ROLE_PRIVILEGE_MISSING:paper_capital_models:INSERT'],facts:{state:'INSTALLED'}}:installed)),
    'VERIFY_INSPECTION',['RUNTIME_ROLE_PRIVILEGE_MISSING:paper_capital_models:INSERT']);
  assert.equal(failing.rolledBack,1);assert.equal(privilegesOf(failing.world.acl[DECL].entries,RT).length,0,'nothing stays granted');
  // Revoke: a privilege that survives the revoke is caught by the effective-privilege probe.
  const survivor=fakeDb();await grant(survivor,OPTIONS,inspectOk());
  survivor.world.afterApply=w=>{w.acl[DECL].entries.push([OWNER,RT,'SELECT',false]);};
  await refused(revoke(survivor,OPTIONS,inspectOk()),'VERIFY_ACL_STATE');
  assert.equal(survivor.rolledBack,1);
});

test('a driver error leaves as its SQLSTATE only: no role, host or driver message',async()=>{
  for(const throwOn of ['pcm-grant:role','pcm-grant:table-acl',STATEMENTS.GRANT_DECLARATIONS]){
    const db=fakeDb({throwOn});
    const error=await refused(grant(db,OPTIONS,inspectOk()),'DATABASE_ERROR',['42501']);
    assert.equal(error.message.includes('HOSTMARK'),false);assert.equal(db.rolledBack,1);
  }
  const plain=fakeDb({throwOn:'pcm-grant:digest'});plain.query=async()=>{throw new TypeError('boom '+ROLE);};
  await refused(grant(plain,OPTIONS,inspectOk()),'DATABASE_ERROR',['UNKNOWN']);
});

test('aclexplode oids: both ACL queries cast grantor and grantee to int8; string oids fail closed without the cast and pass with it',async()=>{
  assert.ok(QUERIES.TABLE_ACL.includes(CAST)&&QUERIES.FUNCTION_ACL.includes(CAST));
  // The bug this guards: a JSON string oid never equals the numeric owner or role oid, so a granted state reads as FOREIGN_GRANTEE.
  assert.deepEqual(classifyAcl({entries:[[String(OWNER),String(OWNER),'SELECT',true],[String(OWNER),String(RT),'SELECT',false]],ownerOid:OWNER,runtimeOid:RT,wanted:['SELECT']}),
    {state:'OTHER',reason:'FOREIGN_GRANTEE'});
  // With the cast (the fake honors it, as PostgreSQL does) the whole grant passes on a database that returns string oids otherwise.
  const withCast=fakeDb({stringOids:true});
  const result=await grant(withCast,{...OPTIONS},inspectOk());
  assert.equal(result.changed,true);assert.deepEqual(result.after,{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'});
  assert.equal((await revoke(withCast,OPTIONS,inspectOk())).changed,true);
  // Strip the cast from the query text: the fake returns string oids and the module refuses before any statement.
  const without=fakeDb({stringOids:true});const query=without.query.bind(without);
  without.query=(sql,params)=>query(sql.replaceAll(CAST,'x.grantor,x.grantee'),params);
  await refused(grant(without,OPTIONS,inspectOk()),'ACL_OID_TYPE');
  assert.deepEqual(writes(without),[]);assert.equal(without.rolledBack,1);
});

test('every grant needs EXECUTE on the function afterwards, with or without the option',async()=>{
  const closed=fakeDb({noPublicExecute:true});const start=structuredClone(closed.world.acl);
  await refused(grant(closed,OPTIONS,inspectOk()),'VERIFY_EXECUTE',['GRANT']);
  assert.equal(closed.rolledBack,1);assert.deepEqual(closed.world.acl,start,'the table grants were rolled back');
  const closedOption=fakeDb({noPublicExecute:true});
  assert.equal((await grant(closedOption,{...OPTIONS,includeExecute:true},inspectOk())).changed,true);
  const open=fakeDb();assert.equal((await grant(open,OPTIONS,inspectOk())).changed,true,'PUBLIC EXECUTE is the PostgreSQL default');
});

test('a table lock timeout (55P03) and a table that vanished (42P01) leave as fixed labels with no driver text',async()=>{
  const timeout=fakeDb({lockTablesError:'55P03'});
  const error=await refused(grant(timeout,OPTIONS,inspectOk()),'LOCK_TABLES_TIMEOUT');
  assert.equal(error.message.includes('HOSTMARK'),false);assert.equal(timeout.rolledBack,1);assert.deepEqual(writes(timeout),[]);
  assert.ok(ran(timeout).indexOf(STATEMENTS.LOCK_TIMEOUT)<ran(timeout).indexOf(STATEMENTS.LOCK_TABLES));
  await refused(grant(fakeDb({lockTablesError:'42P01'}),OPTIONS,inspectOk()),'M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  await refused(revoke(fakeDb({lockTablesError:'55P03'}),OPTIONS,inspectOk()),'LOCK_TABLES_TIMEOUT');
  await refused(grant(fakeDb({lockTablesError:'42501'}),OPTIONS,inspectOk()),'DATABASE_ERROR',['42501']);
});

test('the CLI same-target comparison needs the database, the port setting and the postmaster start time to match',()=>{
  assert.ok(SERVER_TARGET_QUERY.includes("current_setting('port')")&&SERVER_TARGET_QUERY.includes('pg_postmaster_start_time()'));
  const target={database:'db1',port:'5432',started:'1760000000.5'};
  assert.equal(sameServerTarget(target,{...target}),true);
  for(const change of [{database:'db2'},{port:'5433'},{started:'1760000001.5'},{database:undefined},{port:''},{started:null}])
    assert.equal(sameServerTarget(target,{...target,...change}),false,JSON.stringify(change));
  assert.equal(sameServerTarget(target,undefined),false);assert.equal(sameServerTarget(undefined,undefined),false);
});

test('the CLI rejects bad flags and a missing connection with a label and no secret',async()=>{
  const cli=async(args,env={})=>{
    try{const out=await run(process.execPath,['scripts/grant-paper-capital-model-runtime.mjs',...args],{cwd:repoRoot,env:Object.fromEntries(Object.entries({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...env}).filter(([,value])=>value!==undefined))});return {code:0,...out};}
    catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
  };
  for(const args of [[],['--grant','--revoke'],['--bogus'],['--grant','--grant'],['--include-execute'],['--revoke','--runtime-role=x']]){
    const out=await cli(args);assert.equal(out.code,1,args.join(' '));assert.match(out.stderr,/^Usage: node scripts\/grant-paper-capital-model-runtime\.mjs/);assert.equal(out.stdout,'');
  }
  const noUrl=await cli(['--grant']);
  assert.equal(noUrl.code,1);assert.match(noUrl.stderr,/^Paper capital model grant failed: ERROR \(no change made\)\r?\n$/);
  const secretUrl='postgres://secret_user_zz:secret-pw-zz@db.invalid.example:5432/secretdb';
  const noRuntime=await cli(['--revoke'],{DATABASE_URL:'',RUNTIME_DATABASE_URL:secretUrl});
  assert.equal(noRuntime.code,1);
  for(const text of [noUrl.stderr,noUrl.stdout,noRuntime.stderr,noRuntime.stdout])for(const secret of ['secret_user_zz','secret-pw-zz','db.invalid.example','secretdb'])assert.equal(text.includes(secret),false);
});
