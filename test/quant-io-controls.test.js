import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIoControls, inspectCgroupIo,readCgroupIo,prepareCgroupIo,systemdIoProperties} from '../src/quant-research/io-controls.js';
import {StorageBudget} from '../src/quant-research/storage-budget.js';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const controls={version:'quant-io-v1',device:'8:0',devicePath:'/dev/test-block',main:{readBytesPerSecond:1048576,writeBytesPerSecond:524288},evaluator:{readBytesPerSecond:524288,writeBytesPerSecond:262144}};

test('versioned I/O controls require reviewed absolute device and positive ceilings',()=>{
  assert.deepEqual(validateIoControls(controls),controls);
  for(const change of [
    value=>delete value.version,
    value=>value.version='quant-io-v2',
    value=>value.device='unknown',
    value=>value.devicePath='relative/path',
    value=>value.main.readBytesPerSecond=0,
    value=>value.evaluator.writeBytesPerSecond=Infinity,
  ]){
    const invalid=structuredClone(controls);change(invalid);
    assert.throws(()=>validateIoControls(invalid),{code:'QUANT_IO_CONTROLS_REQUIRED'});
  }
});

test('I/O readback fails closed on empty statistics or missing absolute kernel ceilings',()=>{
  const max='8:0 rbps=1048576 wbps=524288';
  const stat='8:0 rbytes=123 wbytes=456 rios=1 wios=1';
  assert.deepEqual(inspectCgroupIo({max,stat,device:'8:0',limits:controls.main}),{readBytes:123,writeBytes:456});
  for(const bad of [
    {max,stat:''},
    {max:'',stat},
    {max:'8:0 rbps=max wbps=524288',stat},
    {max:'8:0 rbps=1048577 wbps=524288',stat},
    {max,stat:'8:1 rbytes=0 wbytes=0'},
  ])assert.throws(()=>inspectCgroupIo({...bad,device:'8:0',limits:controls.main}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('cgroup readback includes inode and refuses absent delegated files',async()=>{
  const files=new Map([
    ['/sys/fs/cgroup/user.slice/test.service/io.max','8:0 rbps=1048576 wbps=524288'],
    ['/sys/fs/cgroup/user.slice/test.service/io.stat','8:0 rbytes=123 wbytes=456'],
  ]);
  const reader=async file=>{if(!files.has(file))throw Error('missing');return files.get(file);};
  const statter=async()=>({ino:987});
  assert.deepEqual(await readCgroupIo('/user.slice/test.service',controls,'main',{reader,statter}),{inode:987,readBytes:123,writeBytes:456});
  files.delete('/sys/fs/cgroup/user.slice/test.service/io.stat');
  await assert.rejects(readCgroupIo('/user.slice/test.service',controls,'main',{reader,statter}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  await assert.rejects(readCgroupIo('/../../escape',controls,'main',{reader,statter}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('systemd properties use reviewed evaluator device and absolute rates',()=>{
  assert.deepEqual(systemdIoProperties(controls),[
    '--property=IOAccounting=yes',
    '--property=IOReadBandwidthMax=/dev/test-block 524288',
    '--property=IOWriteBandwidthMax=/dev/test-block 262144',
  ]);
});

test('bounded readiness waits for real byte fields and cleans its owned reservation',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-io-ready-'));
  try{
    const budget=new StorageBudget({root,diskQuotaBytes:8192,tempQuotaBytes:8192,freeFloorBytes:0});
    const reserve=budget.reserve.bind(budget);
    let readinessPurpose;
    budget.reserve=async options=>{readinessPurpose=options.purpose;return reserve(options);};
    let reads=0;
    const reader=async file=>file.endsWith('io.max')?'8:0 rbps=1048576 wbps=524288':
      file.endsWith('io.stat')?(++reads<2?'8:0 \n':'8:0 rbytes=0 wbytes=4096'):'0::/test.service';
    const statter=async file=>file===root?{dev:2049}:{ino:123};
    const resolver=async file=>file.endsWith('/8:0')?'/sys/devices/block/sda':'/sys/devices/block/sda/sda1';
    // The deadline is wall time from before the storage reservation and the fsync'd 4 KiB probe; a loaded Windows
    // runner once spent more than 500 ms there. The product ceiling (3000 ms) keeps the bound and gives headroom;
    // the wait itself is proven by the read count, not by timing.
    assert.deepEqual(await prepareCgroupIo('/test.service',controls,'main',budget,{reader,statter,resolver,timeoutMs:3000}),
      {group:'/test.service',inode:123,readBytes:0,writeBytes:4096});
    assert.equal(reads,2,'the empty counter line was read and refused before the real byte fields');
    assert.equal(readinessPurpose,'quant-io-readiness-v1');
    assert.deepEqual(await readdir(root),['.storage-reservations']);
    assert.equal((await budget.inspect()).reservations,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('readiness refuses wrong limits before any storage mutation',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-io-wrong-'));
  try{
    const budget=new StorageBudget({root,diskQuotaBytes:8192,tempQuotaBytes:8192,freeFloorBytes:0});
    await assert.rejects(prepareCgroupIo('/test.service',controls,'main',budget,{
      reader:async()=> '8:0 rbps=1048576 wbps=524289',statter:async()=>({ino:123})
    }),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
    assert.deepEqual(await readdir(root),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('readiness times out on missing counters and removes exact pending file',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-io-timeout-'));
  try{
    const budget=new StorageBudget({root,diskQuotaBytes:8192,tempQuotaBytes:8192,freeFloorBytes:0});
    const reader=async file=>file.endsWith('io.max')?'8:0 rbps=1048576 wbps=524288':'8:0 \n';
    const statter=async file=>file===root?{dev:2049}:{ino:123};
    const resolver=async file=>file.endsWith('/8:0')?'/sys/devices/block/sda':'/sys/devices/block/sda/sda1';
    await assert.rejects(prepareCgroupIo('/test.service',controls,'main',budget,{reader,statter,resolver,timeoutMs:100}),
      {code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
    assert.deepEqual(await readdir(root),['.storage-reservations']);
    assert.equal((await budget.inspect()).reservations,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('readiness rejects valid counters returned after deadline',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-io-late-'));
  try{
    const budget=new StorageBudget({root,diskQuotaBytes:8192,tempQuotaBytes:8192,freeFloorBytes:0});
    let delayed=false;
    const reader=async file=>{
      if(file.endsWith('io.max'))return '8:0 rbps=1048576 wbps=524288';
      delayed=true;
      // Longer than the whole 3000 ms budget, so the counters are late however long the reservation took.
      await new Promise(resolve=>setTimeout(resolve,3300));
      return '8:0 rbytes=0 wbytes=4096';
    };
    const statter=async file=>file===root?{dev:2049}:{ino:123};
    const resolver=async file=>file.endsWith('/8:0')?'/sys/devices/block/sda':'/sys/devices/block/sda/sda1';
    // A 500 ms budget could expire during the reservation on a loaded runner, before any counter read (delayed false).
    await assert.rejects(prepareCgroupIo('/test.service',controls,'main',budget,{reader,statter,resolver,timeoutMs:3000}),
      {code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
    assert.equal(delayed,true);
    assert.deepEqual(await readdir(root),['.storage-reservations']);
    assert.equal((await budget.inspect()).reservations,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
