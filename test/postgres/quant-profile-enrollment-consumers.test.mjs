import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,utimes,stat} from 'node:fs/promises';
import path from 'node:path';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantProfileService} from '../../src/postgres/quant-profile.js';
import {maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createHarness,createWorld} from '../helpers/preflight-pg-fixture.mjs';

const offline={policy:{workerUnit:'qdqs-storage-test.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},
  inventory:async()=>{},settleMs:0};
test('historical V2 exposure and retention use immutable receipt policy; new PF2 admission uses current policy',async t=>{
  const base=await createPf2Base(t),admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const h=await createHarness({admin,base});
  t.after(async()=>{await h.dispose();await admin.close();});
  const world=await createWorld(h),rotated=structuredClone(h.capacityPolicy);
  rotated.evidence.parity_sha256='9'.repeat(64);
  const profiles=new QuantProfileService({pineService:h.pine,dataService:h.data,researchStore:h.stores.research,
    enabled:true,capacityPolicy:rotated});
  const detail=await h.tx(()=>profiles.get(world.owner,world.profileJobId));
  assert.equal(detail.status,'SUCCEEDED');assert.equal(detail.data_profile_verified,true);
  assert.deepEqual(detail.result,world.scenario.enrollment.result);
  await assert.rejects(h.tx(()=>h.serviceWith({capacityPolicy:rotated}).enqueue(world.owner,world.request,'rotated-policy-fixture')),
    {code:'PREFLIGHT_ENROLLMENT_REQUIRED'});
  const result=world.scenario.enrollment.result;
  const kept=[result.raw.dataset_id,result.references.raw.dataset_id,'atr14-v2-'+result.references.sidecar.sha256];
  const old=new Date(Date.now()-8*24*60*60*1000);
  async function age(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const filename=path.join(directory,entry.name);
      assert.equal(entry.isSymbolicLink(),false);
      if(entry.isDirectory())await age(filename);else await utimes(filename,old,old);
    }
    await utimes(directory,old,old);
  }
  for(const name of kept)await age(path.join(h.root,name));
  const before=await readFile(path.join(h.root,result.references.raw.dataset_id,'manifest.json'),'utf8');
  const budget=h.stores.research.storageBudget;
  let retained;
  await maintainQuantStorage({db:h.db,budget:{root:h.root,maintenance:async options=>{
    retained=new Set(options.retainedNames);await options.assertExclusive();return {applied:false};}},...offline});
  for(const name of kept)assert.ok(retained.has(name),name);
  await maintainQuantStorage({db:h.db,budget,...offline});
  await maintainQuantStorage({db:h.db,budget,...offline,apply:true});
  for(const name of kept)assert.ok((await stat(path.join(h.root,name))).isDirectory());
  assert.equal(await readFile(path.join(h.root,result.references.raw.dataset_id,'manifest.json'),'utf8'),before);
  const corrupt=await h.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[world.profileJobId]);
  const original=corrupt.rows[0].result;
  await h.db.query("UPDATE quant_foundation_jobs SET result=jsonb_set(result,'{data_profile_verified}','false') WHERE job_id=$1",[world.profileJobId]);
  await assert.rejects(h.tx(()=>profiles.get(world.owner,world.profileJobId)),{code:'PROFILE_ENROLLMENT_RECEIPT_INVALID'});
  await assert.rejects(maintainQuantStorage({db:h.db,budget,...offline,apply:true}),{code:'STORAGE_REFERENCE_INVALID'});
  await h.db.query('UPDATE quant_foundation_jobs SET result=$2 WHERE job_id=$1',[world.profileJobId,JSON.stringify(original)]);
});
