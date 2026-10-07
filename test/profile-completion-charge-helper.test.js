import test from 'node:test';
import assert from 'node:assert/strict';
import {markCharge} from './helpers/profile-completion-charge.mjs';

test('shared charge marks bracket BEGIN and the latest charge without changing the recorded calls',async()=>{
 const calls=[],answer={rowCount:1},f={authorityCalls:[],db:{query:async(sql,params)=>{calls.push([sql,params]);return answer;}}};
 const marks=markCharge(f),start=performance.now();
 assert.equal(f.authorityCalls.push('PREPARE'),1);assert.deepEqual(marks,{});
 assert.equal(f.authorityCalls.push('BEGIN'),2);assert.ok(marks.begin>=start&&marks.begin<=performance.now());
 const begin=marks.begin;
 assert.equal(f.authorityCalls.push('FINALIZE'),3);assert.equal(marks.begin,begin);
 const charge='UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST(runtime_used_ms,$3) WHERE job_id=$1 AND lease_token=$2';
 const params=['job','lease',123];assert.equal(await f.db.query(charge,params),answer);
 const first=marks.charge;assert.ok(first>=begin&&first<=performance.now());
 await f.db.query('SELECT 1');assert.equal(marks.charge,first);
 await f.db.query(charge,params);assert.ok(marks.charge>=first);
 assert.deepEqual([...f.authorityCalls],['PREPARE','BEGIN','FINALIZE']);
 assert.deepEqual(calls,[[charge,params],['SELECT 1',undefined],[charge,params]]);
});

test('shared charge marks retain the attempted charge time when the query fails',async()=>{
 const failure=Error('write failed'),f={authorityCalls:[],db:{query:async()=>{throw failure;}}};
 const marks=markCharge(f);f.authorityCalls.push('BEGIN');
 await assert.rejects(f.db.query('UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST(runtime_used_ms,$3)'),error=>error===failure);
 assert.ok(marks.charge>=marks.begin);
});
