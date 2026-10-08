import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {assertNoActiveProfileEnrollment} from '../src/postgres/quant-profile.js';
import {PROFILE_ENROLLMENT_MODE} from '../src/quant-research/foundation-contract-v2.js';

function recorder(rows){
  const calls=[];
  return {calls,db:{query:async(sql,params)=>{calls.push({sql,params});return {rows};}}};
}

test('an active enrollment of the same owner and bot is refused with a fixed 409 code',async()=>{
  const {db,calls}=recorder([{job_id:'job-1'}]);
  await assert.rejects(assertNoActiveProfileEnrollment(db,'owner-1','bot-1'),
    error=>error.code==='PROFILE_ENROLLMENT_ALREADY_ACTIVE'&&error.status===409&&error.message===error.code);
  assert.equal(calls.length,1);
});

test('no active enrollment passes after one read bound to owner, active statuses, enrollment mode and bot',async()=>{
  const {db,calls}=recorder([]);
  assert.equal(await assertNoActiveProfileEnrollment(db,'owner-1','bot-1'),undefined);
  assert.equal(calls.length,1);
  const {sql,params}=calls[0];
  assert.equal(PROFILE_ENROLLMENT_MODE,'pf2-enrollment-v1');
  assert.match(sql,/^\s*SELECT\b/);
  assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|LOCK)\b|FOR\s+UPDATE/i);
  for(const fragment of ['owner_id=$1','status=ANY($2::text[])',"contract->>'kind'='PROFILE'",
    "contract->>'completion_mode'=$3","contract->>'bot_id'=$4"])assert.ok(sql.includes(fragment),fragment);
  assert.deepEqual([params[0],[...params[1]].sort(),params[2],params[3]],
    ['owner-1',['PAUSED','QUEUED','RUNNING','STOPPING'],PROFILE_ENROLLMENT_MODE,'bot-1']);
});

test('admission checks after the scheduler lock and the idempotent replay and before any evidence read or insert',async()=>{
  const source=await fs.readFile(new URL('../src/postgres/quant-profile.js',import.meta.url),'utf8');
  const start=source.indexOf('async enqueueEnrollment('),end=source.indexOf('async authorizeV2(');
  assert.ok(start>0&&end>start);
  const body=source.slice(start,end);
  const order=['SELECT singleton FROM quant_foundation_scheduler FOR UPDATE','return this.expose(previous);',
    'assertNoActiveProfileEnrollment(this.db,owner,body.bot_id)','this.raw(owner','INSERT INTO quant_foundation_jobs']
    .map(marker=>{const at=body.indexOf(marker);assert.ok(at>=0,marker);return at;});
  assert.deepEqual(order,[...order].sort((a,b)=>a-b));
});