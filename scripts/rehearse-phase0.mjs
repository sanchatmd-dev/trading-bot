import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {backupDatabase} from './backup.mjs';
import {Store} from '../src/database.js';

// The source is opened read-only by backupDatabase. Only a new snapshot is migrated.
const [source,target]=process.argv.slice(2);
if(!source||!target)throw new Error('Usage: node scripts/rehearse-phase0.mjs /source/astra-v2.db /new-directory/rehearsal.db');
if(path.resolve(source)===path.resolve(target)||fs.existsSync(target))throw new Error('Rehearsal target must be a new file');
backupDatabase(source,target);
const snapshot=new DatabaseSync(target,{readOnly:true});
const counts=Object.fromEntries(['users','signals','fills','ledger_positions','risk_profiles'].map(table=>[table,snapshot.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const owners=snapshot.prepare('SELECT id,webhook_secret_hash,webhook_secret_encrypted FROM users ORDER BY id').all();
snapshot.close();
const store=new Store(target);
try{
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,10);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  for(const [table,count] of Object.entries(counts))assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,count);
  assert.deepEqual(store.db.prepare('SELECT id,webhook_secret_hash,webhook_secret_encrypted FROM users ORDER BY id').all(),owners);
  const expected=store.db.prepare("SELECT count(*) n FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.execution_mode='PAPER'").get().n;
  assert.equal(store.db.prepare('SELECT count(*) n FROM paper_cash_journal').get().n,expected);
  const accounts=store.db.prepare('SELECT DISTINCT user_id,broker FROM paper_funding').all().map(row=>store.paperAccount(row.user_id,row.broker));
  console.log(JSON.stringify({schema:10,integrity:'ok',counts,journalEntries:expected,
    negativeCashAccounts:accounts.filter(row=>row.cash<0).length,
    unresolvedPaper:store.db.prepare("SELECT count(*) n FROM signals WHERE execution_mode='PAPER' AND status='UNKNOWN'").get().n,
    sourceUnmodified:true,rehearsal:path.resolve(target)},null,2));
}finally{store.close();}
