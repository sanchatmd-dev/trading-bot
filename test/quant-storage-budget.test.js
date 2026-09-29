import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir,utimes,unlink,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StorageBudget} from '../src/quant-research/storage-budget.js';
import {DatasetStore} from '../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {lstat} from 'node:fs/promises';

const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:60000,end_time:120000,warmup_bars:0,total_bars:1,cutoff:120000,source:'binance-spot-klines-v1'};
const bars=[{time:60000,open:'100',high:'101',low:'99',close:'100',volume:'1'}];
async function fixture(t,overrides={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-budget-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,budget:new StorageBudget({root,diskQuotaBytes:3*1024*1024,tempQuotaBytes:3*1024*1024,freeFloorBytes:0,...overrides})};
}
async function ageTree(filename,date) {
  const stat=await lstat(filename);
  if(stat.isDirectory())for(const name of await readdir(filename))await ageTree(path.join(filename,name),date);
  await utimes(filename,date,date);
}

test('quota denies publication before staging and retains prior immutable data',async t=>{
  const {root,budget}=await fixture(t,{diskQuotaBytes:2*1024*1024});
  const store=new DatasetStore({root,storageBudget:budget});
  await assert.rejects(store.publish(metadata,bars),{code:'STORAGE_CAPACITY_EXCEEDED'});
  assert.deepEqual((await readdir(root)).sort(),['.storage-reservations']);
});

test('V2 sidecar directories count against quota and remain protected pending reference integration',async t=>{
  const {root,budget}=await fixture(t,{diskQuotaBytes:100,tempQuotaBytes:100});
  const artifact='atr14-v2-'+'a'.repeat(64),directory=path.join(root,artifact);
  await mkdir(directory);await writeFile(path.join(directory,'chunk-00000.jsonl'),'x'.repeat(40));
  await ageTree(directory,new Date(Date.now()-25*60*60*1000));
  assert.equal((await budget.inspect()).committedBytes,40);
  await assert.rejects(budget.reserve({diskBytes:61,tempBytes:61,pendingName:'.pending-abc'}),
    {code:'STORAGE_CAPACITY_EXCEEDED'});
  const result=await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,assertExclusive:async()=>true});
  assert.deepEqual(result.candidates,[]);
  assert.equal((await readFile(path.join(directory,'chunk-00000.jsonl'))).length,40);
  assert.deepEqual((await budget.maintenance({retainedNames:[artifact],exclusiveOffline:true})).candidates,[]);
});

test('concurrent reservations across instances admit only capacity and account pending once',async t=>{
  const {root,budget}=await fixture(t,{diskQuotaBytes:100,tempQuotaBytes:100});
  const other=new StorageBudget({root,diskQuotaBytes:100,tempQuotaBytes:100,freeFloorBytes:0});
  const names=['.pending-a','.pending-b'];
  const results=await Promise.allSettled([budget.reserve({diskBytes:80,tempBytes:80,pendingName:names[0]}),other.reserve({diskBytes:80,tempBytes:80,pendingName:names[1]})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  const winner=results.find(result=>result.status==='fulfilled').value;
  const name=results[0].status==='fulfilled'?names[0]:names[1];
  await assert.rejects(other.reserve({diskBytes:1,tempBytes:1,pendingName:name}),{code:'STORAGE_ACCOUNTING_FAILED'});
  await writeFile(path.join(root,name),'x'.repeat(30));
  const state=await budget.inspect();
  assert.equal(state.pendingBytes,30);
  assert.equal(state.reservedDiskBytes,50);
  await winner.release();
});

test('orphan reservation and stale lock fail closed; offline maintenance requires age and proof',async t=>{
  const {root,budget}=await fixture(t,{diskQuotaBytes:100,tempQuotaBytes:100});
  await budget.reserve({diskBytes:80,tempBytes:80,pendingName:'.pending-abc'});
  await assert.rejects(budget.reserve({diskBytes:30,tempBytes:30,pendingName:'.pending-def'}),{code:'STORAGE_CAPACITY_EXCEEDED'});
  await assert.rejects(budget.maintenance({retainedNames:[],exclusiveOffline:true}),{code:'STORAGE_MAINTENANCE_GUARD'});
  const ledger=path.join(root,'.storage-reservations');
  const [name]=await readdir(ledger),filename=path.join(ledger,name);
  const record=JSON.parse(await readFile(filename,'utf8'));
  record.createdAt=Date.now()-25*60*60*1000;
  await writeFile(filename,JSON.stringify(record));
  const pending=path.join(root,'.pending-abc');
  await mkdir(pending);
  await writeFile(path.join(pending,'chunk-00000.jsonl'),'partial');
  const old=new Date(Date.now()-25*60*60*1000);
  await ageTree(pending,old);
  const preview=await budget.maintenance({retainedNames:[],exclusiveOffline:true});
  assert.deepEqual(preview.candidates.map(item=>item.name),['.pending-abc']);
  assert.equal(preview.staleReservations,1);
  assert.equal((await readdir(ledger)).length,1);
  await assert.rejects(budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true}),{code:'STORAGE_MAINTENANCE_GUARD'});
  let proofs=0;
  await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,assertExclusive:async()=>{proofs++;return true;}});
  assert.ok(proofs>=2);
  assert.equal((await readdir(ledger)).length,0);
  await mkdir(path.join(root,'.storage-lock'));
  await assert.rejects(budget.inspect(),{code:'STORAGE_LOCKED'});
  await assert.rejects(budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,recoverStaleLock:true,assertExclusive:async()=>false}),{code:'STORAGE_MAINTENANCE_GUARD'});
  assert.equal((await readdir(root)).includes('.storage-lock'),true);
  await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,recoverStaleLock:true,assertExclusive:async()=>true});
  assert.equal((await readdir(root)).includes('.storage-lock'),false);
});

test('aged owned readiness file and reservation are reclaimed together',async t=>{
  const {root,budget}=await fixture(t);
  const name='.pending-123e4567-e89b-42d3-a456-426614174000';
  await budget.reserve({diskBytes:4096,tempBytes:4096,pendingName:name,purpose:'quant-io-readiness-v1'});
  const ledger=path.join(root,'.storage-reservations');
  const [recordName]=await readdir(ledger);
  const recordFile=path.join(ledger,recordName);
  const record=JSON.parse(await readFile(recordFile,'utf8'));
  assert.equal(record.purpose,'quant-io-readiness-v1');
  await writeFile(path.join(root,name),Buffer.alloc(4096));
  await assert.rejects(budget.maintenance({retainedNames:[],exclusiveOffline:true}),{code:'STORAGE_MAINTENANCE_GUARD'});
  record.createdAt=Date.now()-25*60*60*1000;
  await writeFile(recordFile,JSON.stringify(record));
  const pending=path.join(root,name);
  await ageTree(pending,new Date(Date.now()-25*60*60*1000));
  const preview=await budget.maintenance({retainedNames:[],exclusiveOffline:true});
  assert.deepEqual(preview.candidates.map(item=>item.name),[name]);
  await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,assertExclusive:async()=>true});
  assert.equal((await readdir(root)).includes(name),false);
  assert.deepEqual(await readdir(ledger),[]);
});

test('aged readiness partial files and missing-file retry keep paired evidence until safe cleanup',async t=>{
  const {root,budget}=await fixture(t);
  const ledger=path.join(root,'.storage-reservations');
  const old=new Date(Date.now()-25*60*60*1000);
  for(const [index,size] of [0,2048,4096].entries()){
    const name=`.pending-123e4567-e89b-42d3-a456-42661417400${index}`;
    await budget.reserve({diskBytes:4096,tempBytes:4096,pendingName:name,purpose:'quant-io-readiness-v1'});
    const [recordName]=await readdir(ledger);
    const recordFile=path.join(ledger,recordName);
    const record=JSON.parse(await readFile(recordFile,'utf8'));
    record.createdAt=old.getTime();
    await writeFile(recordFile,JSON.stringify(record));
    await writeFile(path.join(root,name),Buffer.alloc(size));
    await ageTree(path.join(root,name),old);
    let proofs=0;
    await assert.rejects(budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,
      assertExclusive:async()=>++proofs===1}),{code:'STORAGE_MAINTENANCE_GUARD'});
    assert.equal((await readdir(root)).includes(name),false);
    assert.deepEqual(await readdir(ledger),[recordName]);
    // Exclusive proof failed after file removal. Retry removes the paired reservation.
    await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,assertExclusive:async()=>true});
    assert.deepEqual(await readdir(ledger),[]);
  }
});

test('typed readiness refuses invalid ownership and preserves untyped regular files',async t=>{
  const {root,budget}=await fixture(t);
  const ledger=path.join(root,'.storage-reservations');
  const old=new Date(Date.now()-25*60*60*1000);
  const name='.pending-123e4567-e89b-42d3-a456-426614174010';
  await assert.rejects(budget.reserve({diskBytes:4095,tempBytes:4096,pendingName:name,purpose:'quant-io-readiness-v1'}),
    {code:'STORAGE_BUDGET_CONFIGURATION_REQUIRED'});
  await budget.reserve({diskBytes:4096,tempBytes:4096,pendingName:name,purpose:'quant-io-readiness-v1'});
  const [recordName]=await readdir(ledger);
  const recordFile=path.join(ledger,recordName);
  const record=JSON.parse(await readFile(recordFile,'utf8'));
  record.createdAt=old.getTime();
  await writeFile(recordFile,JSON.stringify(record));
  const pending=path.join(root,name);
  await writeFile(pending,Buffer.alloc(4097));
  await ageTree(pending,old);
  let preview=await budget.maintenance({retainedNames:[],exclusiveOffline:true});
  assert.deepEqual(preview.candidates,[]);
  assert.equal(preview.staleReservations,0);
  await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,assertExclusive:async()=>true});
  assert.deepEqual(await readdir(ledger),[recordName]);
  await unlink(pending);
  await writeFile(pending,Buffer.alloc(4096));
  await ageTree(pending,old);
  preview=await budget.maintenance({retainedNames:[name],exclusiveOffline:true});
  assert.deepEqual(preview.candidates,[]);
  assert.equal(preview.staleReservations,0);
  await unlink(pending);
  try{await symlink(recordFile,pending);}catch(error){if(error.code!=='EPERM')throw error;}
  if((await readdir(root)).includes(name)){
    preview=await budget.maintenance({retainedNames:[],exclusiveOffline:true});
    assert.deepEqual(preview.candidates,[]);
    assert.equal(preview.staleReservations,0);
    await unlink(pending);
  }
  const untyped='.pending-123e4567-e89b-42d3-a456-426614174011';
  await writeFile(path.join(root,untyped),Buffer.alloc(4096));
  await ageTree(path.join(root,untyped),old);
  preview=await budget.maintenance({retainedNames:[],exclusiveOffline:true});
  assert.deepEqual(preview.candidates,[]);
  assert.equal(preview.staleReservations,1); // Typed reservation is now missing its file.
  await budget.maintenance({retainedNames:[],exclusiveOffline:true,apply:true,assertExclusive:async()=>true});
  assert.equal((await readdir(root)).includes(untyped),true);
});

test('maintenance dry run retains references and unknown artifacts; apply removes only verified old orphan',async t=>{
  const {root,budget}=await fixture(t,{diskQuotaBytes:8*1024*1024,tempQuotaBytes:3*1024*1024});
  const store=new DatasetStore({root,storageBudget:budget});
  const kept=await store.publish(metadata,bars);
  const orphan=await store.publish({...metadata,cutoff:180000},bars);
  const old=new Date(Date.now()-25*60*60*1000);
  await ageTree(path.join(root,kept.dataset_id),old);
  await ageTree(path.join(root,orphan.dataset_id),old);
  await writeFile(path.join(root,'unknown-provenance'),'keep');
  const options={retainedNames:[kept.dataset_id],exclusiveOffline:true};
  await writeFile(path.join(root,orphan.dataset_id,'untracked-evidence'),'preserve');
  assert.deepEqual((await budget.maintenance(options)).candidates,[]);
  await rm(path.join(root,orphan.dataset_id,'untracked-evidence'));
  await ageTree(path.join(root,orphan.dataset_id),old);
  const preview=await budget.maintenance(options);
  assert.deepEqual(preview.candidates.map(item=>item.name),[orphan.dataset_id]);
  assert.equal((await readdir(root)).includes(orphan.dataset_id),true);
  await budget.maintenance({...options,apply:true,assertExclusive:async()=>true});
  const names=await readdir(root);
  assert.equal(names.includes(kept.dataset_id),true);
  assert.equal(names.includes(orphan.dataset_id),false);
  assert.equal(names.includes('unknown-provenance'),true);
});

test('research sidecar shares budget and database marker counts toward quota',async t=>{
  const {root,budget}=await fixture(t,{diskQuotaBytes:6*1024*1024,tempQuotaBytes:3*1024*1024});
  await writeFile(path.join(root,'.database-owner.json'),'{}');
  const store=new ResearchDatasetStore({root,storageBudget:budget});
  const model={data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'};
  const input=bars.map(bar=>({...bar,atr14:'2',price_tick:'0.01',quantity_step:'0.001'}));
  const refs=await store.publish(metadata,input,{model});
  assert.equal((await store.sidecar(refs.sidecar)).atr14[0],'2');
  const state=await budget.inspect();
  assert.equal(state.reservations,0);
  assert.equal(state.pendingBytes,0);
  assert.ok(state.committedBytes>2);
});

test('deep artifact tree fails closed during accounting',async t=>{
  const {root,budget}=await fixture(t);
  let current=path.join(root,'.pending-deed');
  for(let index=0;index<10;index++){await mkdir(current);current=path.join(current,'nested');}
  await assert.rejects(budget.inspect(),{code:'STORAGE_ACCOUNTING_FAILED'});
});

test('lock release does not unlink a replaced owner',async t=>{
  const {root,budget}=await fixture(t);
  await assert.rejects(budget.locked(async()=>{
    const owner=path.join(root,'.storage-lock','owner.json');
    const record=JSON.parse(await readFile(owner,'utf8'));
    await writeFile(owner,JSON.stringify({...record,token:'different-owner'}));
  }),{code:'STORAGE_LOCK_LOST'});
  assert.equal((await readdir(root)).includes('.storage-lock'),true);
});
