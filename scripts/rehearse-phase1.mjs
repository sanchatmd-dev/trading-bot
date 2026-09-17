import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {backupDatabase} from './backup.mjs';
import {Store} from '../src/database.js';

function inventory(db){
  const result={};
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='sessions' ORDER BY name").all()){
    if(!/^[a-z_]+$/.test(name))throw new Error('Unexpected table name');
    let count=0;const hash=createHash('sha256');
    for(const row of db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).iterate()){count++;hash.update(JSON.stringify(row)+'\n');}
    result[name]={count,digest:hash.digest('hex')};
  }
  return result;
}
export function rehearsePhase1(source,target){
  // Read the source only. Migrate a verified, newly created snapshot, never the original.
  backupDatabase(source,target);
  const before=new DatabaseSync(target,{readOnly:true});let tables,legacySessions;
  try{
    assert.equal(before.prepare('PRAGMA user_version').get().user_version,9,'Phase 1 rehearsal requires a schema 9 source');
    tables=inventory(before);legacySessions=before.prepare('SELECT count(*) n FROM sessions').get().n;
  }finally{before.close();}
  const store=new Store(target);
  try{
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,10);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    const after=inventory(store.db);
    for(const [table,expected] of Object.entries(tables))assert.deepEqual(after[table],expected,`${table} changed during migration`);
    assert.equal(store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
    return {schema:10,integrity:'ok',preservedTables:Object.fromEntries(Object.entries(tables).map(([name,row])=>[name,row.count])),legacySessionsRevoked:legacySessions,sourceUnmodified:true,rehearsal:path.resolve(target)};
  }finally{store.close();}
}
if(process.argv[1]&&path.basename(process.argv[1])==='rehearse-phase1.mjs'){
  const [source,target]=process.argv.slice(2);
  if(!source||!target)throw new Error('Usage: node scripts/rehearse-phase1.mjs /source/astra-v2.db /new-directory/rehearsal.db');
  console.log(JSON.stringify(rehearsePhase1(source,target),null,2));
}
