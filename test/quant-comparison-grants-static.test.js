import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {TARGET_PRIVILEGES,GROUPS,ALL_TABLES,EXTENSION_FUNCTION_SIGNATURES,classifyAcl,validRuntimeRole,QuantComparisonGrantRefusal,sameServerTarget} from '../src/postgres/quant-comparison-grant-state.js';
import {STATEMENTS,GRANT_SETTING,grantQuantComparisonRuntime,revokeQuantComparisonRuntime} from '../src/postgres/quant-comparison-grants.js';
import {MARKER_TABLE as COMPARISON_MARKER,COMPARISON_TABLES} from '../src/postgres/quant-comparison-migration.js';
import {MARKER_TABLE as REGISTER_MARKER,REGISTER_TABLE} from '../src/postgres/quant-exposure-register-migration.js';

// Static and fake-driver tests of the QR-3 set C targeted grant (SC-7): no PostgreSQL, no network. The real catalog behavior is covered by
// test/postgres/quant-comparison-grants.test.mjs.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8').replaceAll('\r\n','\n');
const FILES=['src/postgres/quant-comparison-grants.js','src/postgres/quant-comparison-grant-state.js','scripts/grant-quant-comparison-runtime.mjs'];

/** The three categories of the repository grant script, parsed from its text. */
function scriptCategories(){
  const text=read('scripts/grant-postgres-runtime.sql');
  const list=name=>{
    const match=new RegExp('\\b'+name+' CONSTANT TEXT\\[\\] := ARRAY\\[([\\s\\S]*?)\\];').exec(text);
    assert.ok(match,name+' list found');
    return [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map(item=>item[1]);
  };
  return {protectedTables:list('protected'),readOnly:list('read_only'),insertOnly:list('insert_only'),text};
}

test('the target privileges equal what the repository grant script leaves on these ten tables, derived from its categories and statements',()=>{
  const {protectedTables,readOnly,insertOnly,text}=scriptCategories();
  // The script grants SELECT, INSERT, UPDATE on all tables and then revokes per category; the statements it uses are the ones assumed below.
  assert.match(text,/GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO %I/);
  assert.match(text,/FOREACH item IN ARRAY protected LOOP[\s\S]*?REVOKE DELETE ON TABLE public\.%I FROM %I/);
  assert.match(text,/FOREACH item IN ARRAY read_only LOOP[\s\S]*?REVOKE INSERT,UPDATE,DELETE ON TABLE public\.%I FROM %I/);
  assert.match(text,/FOREACH item IN ARRAY insert_only LOOP[\s\S]*?REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON TABLE public\.%I FROM %I/);
  const base=['SELECT','INSERT','UPDATE'];
  const afterScript=table=>{
    const categories=[protectedTables.includes(table),readOnly.includes(table),insertOnly.includes(table)].filter(Boolean);
    assert.equal(categories.length,1,table+' is in exactly one category');
    if(protectedTables.includes(table))return base.filter(item=>item!=='DELETE').sort();
    if(readOnly.includes(table))return base.filter(item=>!['INSERT','UPDATE','DELETE'].includes(item)).sort();
    return base.filter(item=>!['UPDATE','DELETE','TRUNCATE','TRIGGER'].includes(item)).sort();
  };
  for(const table of ALL_TABLES)assert.deepEqual([...TARGET_PRIVILEGES[table]],afterScript(table),table);
  // Category membership of each group.
  assert.deepEqual(protectedTables.filter(table=>ALL_TABLES.includes(table)),[REGISTER_TABLE]);
  assert.deepEqual(readOnly.filter(table=>ALL_TABLES.includes(table)).sort(),[COMPARISON_MARKER,REGISTER_MARKER].sort());
  assert.deepEqual(insertOnly.filter(table=>ALL_TABLES.includes(table)),[...COMPARISON_TABLES]);
  assert.equal(ALL_TABLES.length,10);assert.equal(new Set(ALL_TABLES).size,10);
  assert.deepEqual([...GROUPS.register,...GROUPS.comparison],[...ALL_TABLES]);
  // No target privilege is DELETE, TRUNCATE or TRIGGER, and the register is the only table with UPDATE.
  for(const [table,privileges] of Object.entries(TARGET_PRIVILEGES)){
    assert.equal(privileges.some(item=>['DELETE','TRUNCATE','TRIGGER','REFERENCES'].includes(item)),false,table);
    assert.deepEqual([...privileges],[...privileges].sort(),table+' is sorted');
    assert.equal(privileges.includes('UPDATE'),table===REGISTER_TABLE,table);
  }
});

test('the ten tables and sixteen functions equal the CREATE statements of the two SQL files; neither file creates a sequence',()=>{
  const files=['src/postgres/quant-exposure-register.sql','src/postgres/quant-comparison.sql'].map(read);
  const code=files.map(text=>text.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n'));
  const tables=code.flatMap(text=>[...text.matchAll(/CREATE TABLE public\.([a-z0-9_]+)/g)].map(item=>item[1]));
  assert.deepEqual([...tables].sort(),[...ALL_TABLES].sort());
  const functions=code.flatMap(text=>[...text.matchAll(/CREATE FUNCTION public\.([a-z0-9_]+\([^)]*\))/g)].map(item=>item[1]));
  assert.deepEqual([...functions].sort(),[...EXTENSION_FUNCTION_SIGNATURES].sort());
  for(const text of code){
    assert.equal(/CREATE SEQUENCE|\bSERIAL\b|\bBIGSERIAL\b|GENERATED [A-Z ]*AS IDENTITY|\bGRANT\b|\bREVOKE\b/i.test(text),false,'no sequence, identity column or ACL statement in the SQL files');
  }
});

test('the statements carry exactly the target privileges on exactly the ten tables and name the role only through the bound setting',()=>{
  const all=[...STATEMENTS.GRANT,...STATEMENTS.REVOKE];
  assert.equal(STATEMENTS.GRANT.length,3);assert.equal(STATEMENTS.REVOKE.length,3);
  for(const text of all){
    assert.match(text,/^DO \$qcg\$ BEGIN EXECUTE pg_catalog\.format\('(GRANT|REVOKE) [A-Z, ]+ ON TABLE [a-z0-9_., ]+ (TO|FROM) %I',pg_catalog\.current_setting\('robot\.qcg_grant_role'\)\); END \$qcg\$$/);
    assert.equal(/\b(DELETE|TRUNCATE|TRIGGER|REFERENCES|SEQUENCE|ALL)\b|WITH GRANT OPTION|(TO|FROM) PUBLIC|\bFUNCTION\b|\bSCHEMA\b|DEFAULT PRIVILEGES/.test(text),false,text);
  }
  // Rebuild the effect of the grant statements from their text: privilege set per table must equal TARGET_PRIVILEGES.
  const built={};
  for(const text of STATEMENTS.GRANT){
    const [, privileges, tables]=/format\('GRANT ([A-Z, ]+) ON TABLE ([a-z0-9_., ]+) TO %I'/.exec(text);
    for(const table of tables.split(', '))built[table.replace('public.','')]=privileges.split(', ').sort();
  }
  assert.deepEqual(built,Object.fromEntries(ALL_TABLES.map(table=>[table,[...TARGET_PRIVILEGES[table]]])));
  // The revoke statements are the exact reverse: same privileges, same tables.
  assert.deepEqual(STATEMENTS.REVOKE.map(text=>text.replace('REVOKE','GRANT').replace(' FROM %I',' TO %I')),[...STATEMENTS.GRANT]);
  assert.equal(GRANT_SETTING,'robot.qcg_grant_role');
  assert.match(STATEMENTS.SET_ROLE,/set_config\('robot\.qcg_grant_role',\$1::text,true\)/);
  assert.match(STATEMENTS.LOCK_TABLES,/^LOCK TABLE (public\.[a-z0-9_]+(, )?){10} IN ACCESS EXCLUSIVE MODE$/);
});

test('the sources never read the role from argv, never print it, never call the repository grant script and name no host, address or user',()=>{
  for(const path of FILES){
    const text=read(path);
    assert.equal(/ON ALL TABLES|grant-postgres-runtime/.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g,'')),false,path+' code does not use the repository grant script');
    assert.equal(/\b(\d{1,3}\.){3}\d{1,3}\b|@[a-z0-9-]+\.[a-z]{2,}|\bssh\b|C:\\|C:\/|\/home\/|\/root\/|password\s*=/i.test(text),false,path+' names no address, email, path, ssh or secret');
  }
  const cli=read(FILES[2]);
  assert.equal(/runtime-role|--role|ROLE_NAME/i.test(cli.replace(/\/\/.*/g,'')),false,'no role argument');
  assert.match(cli,/args\.length!==1\|\|!\['--grant','--revoke','--inspect'\]\.includes\(args\[0\]\)/);
  assert.match(cli,/process\.env\.RUNTIME_DATABASE_URL/);
  // Nothing in the CLI prints the role name variable.
  assert.equal(/console\.(log|error)\([^)]*runtimeRole/.test(cli),false);
});

test('the CLI rejects every argument list but exactly one mode before it connects',async()=>{
  for(const args of [[],['--grant','--revoke'],['--grant','--grant'],['--grant','--runtime-role=x'],['--runtime-role=x'],['--bogus'],['--inspect','--include-execute']]){
    const env={...process.env};delete env.DATABASE_URL;delete env.RUNTIME_DATABASE_URL;
    const result=await run(process.execPath,['scripts/grant-quant-comparison-runtime.mjs',...args],{cwd:repoRoot,env}).then(out=>({code:0,...out}),error=>({code:error.code,stdout:error.stdout,stderr:error.stderr}));
    assert.equal(result.code,1,args.join(' '));
    assert.match(result.stderr,/^Usage: node scripts\/grant-quant-comparison-runtime\.mjs \(--grant \| --revoke \| --inspect\)/);assert.equal(result.stdout,'');
  }
});

test('classifyAcl: NONE, EXACT and every OTHER reason, with owner entries ignored',()=>{
  const OWNER=10,RT=20,ELSE=30;
  const own=[[OWNER,OWNER,'INSERT',true],[OWNER,OWNER,'SELECT',true],[OWNER,OWNER,'UPDATE',true]];
  const mine=(...privileges)=>privileges.map(item=>[OWNER,RT,item,false]);
  const classify=(entries,extra={},wanted=['INSERT','SELECT'])=>classifyAcl({entries,ownerOid:OWNER,runtimeOid:RT,wanted,...extra});
  assert.deepEqual(classify(own),{state:'NONE',reason:null});
  assert.deepEqual(classify([...own,...mine('SELECT','INSERT')]),{state:'EXACT',reason:null});
  assert.deepEqual(classify([...own,...mine('SELECT','INSERT','UPDATE')],{},['INSERT','SELECT','UPDATE']),{state:'EXACT',reason:null});
  assert.deepEqual(classify([...own,...mine('SELECT')]),{state:'OTHER',reason:'PRIVILEGE_SET'});
  assert.deepEqual(classify([...own,...mine('SELECT','INSERT','DELETE')]),{state:'OTHER',reason:'PRIVILEGE_SET'});
  assert.deepEqual(classify([...own,...mine('SELECT','INSERT','TRUNCATE')]),{state:'OTHER',reason:'PRIVILEGE_SET'});
  assert.deepEqual(classify([...own,[OWNER,0,'SELECT',false]]),{state:'OTHER',reason:'PUBLIC_ENTRY'});
  assert.deepEqual(classify([...own,[OWNER,ELSE,'SELECT',false]]),{state:'OTHER',reason:'FOREIGN_GRANTEE'});
  assert.deepEqual(classify([...own,[OWNER,RT,'SELECT',true],...mine('INSERT')]),{state:'OTHER',reason:'GRANT_OPTION'});
  assert.deepEqual(classify([...own,[ELSE,RT,'SELECT',false],...mine('INSERT')]),{state:'OTHER',reason:'FOREIGN_GRANTOR'});
  assert.deepEqual(classify([...own,...mine('SELECT','SELECT','INSERT')]),{state:'OTHER',reason:'DUPLICATE_ENTRY'});
  assert.deepEqual(classify([...own,...mine('SELECT','INSERT')],{columnAcl:true}),{state:'OTHER',reason:'COLUMN_ACL'});
});

test('role text, server target and refusal shape',()=>{
  for(const bad of ['',null,undefined,7,'x'.repeat(64),'a\u0000b','\u00e9'.repeat(32)])assert.equal(validRuntimeRole(bad),false,String(bad));
  for(const good of ['robot_rt','Robot "Q" role','x'.repeat(63),'\u00e9'.repeat(31)])assert.equal(validRuntimeRole(good),true,good);
  assert.equal(sameServerTarget({database:'a',port:'1',started:'2'},{database:'a',port:'1',started:'2'}),true);
  assert.equal(sameServerTarget({database:'a',port:'1',started:'2'},{database:'b',port:'1',started:'2'}),false);
  assert.equal(sameServerTarget({database:'a',port:'1',started:''},{database:'a',port:'1',started:''}),false);
  const error=new QuantComparisonGrantRefusal('ACL_STATE_OTHER',['quant_comparison_specs:PRIVILEGE_SET']);
  assert.deepEqual([error.name,error.code,error.details],['QuantComparisonGrantRefusal','ACL_STATE_OTHER',['quant_comparison_specs:PRIVILEGE_SET']]);
  assert.match(error.message,/\(no change made\)$/);
});

test('a driver error leaves only its SQLSTATE: no role name, host or message reaches the refusal',async()=>{
  const ROLE='Robot_Runtime "Secret" Role';
  const fake=(error)=>({isTransaction:false,query:async()=>{throw error;},
    async transaction(fn){this.isTransaction=true;try{return await fn();}finally{this.isTransaction=false;}},
    async maintenanceLock(){},async verifySchema(){}});
  for(const action of [grantQuantComparisonRuntime,revokeQuantComparisonRuntime]){
    const withCode=await action(fake(Object.assign(new Error('permission denied for role "'+ROLE+'" at host HOSTMARK'),{code:'42501'})),{runtimeRole:ROLE}).then(()=>null,reason=>reason);
    assert.ok(withCode instanceof QuantComparisonGrantRefusal);assert.deepEqual([withCode.code,withCode.details],['DATABASE_ERROR',['42501']]);
    assert.equal(withCode.message.includes('Secret')||withCode.message.includes('HOSTMARK'),false);
    const without=await action(fake(new Error('connect to HOSTMARK as '+ROLE)),{runtimeRole:ROLE}).then(()=>null,reason=>reason);
    assert.deepEqual([without.code,without.details],['DATABASE_ERROR',['UNKNOWN']]);assert.equal(without.message.includes(ROLE),false);
    const invalid=await action(fake(new Error('x')),{runtimeRole:'x'.repeat(64)}).then(()=>null,reason=>reason);
    assert.equal(invalid.code,'RUNTIME_ROLE_INVALID');
    const nested=await action({isTransaction:true},{runtimeRole:ROLE}).then(()=>null,reason=>reason);
    assert.equal(nested.code,'NOT_OWN_TRANSACTION');
  }
});
