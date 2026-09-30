import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {blockedReport,runRecovery} from '../src/postgres/quant-foundation-recovery-cli.js';

const cli=fileURLToPath(new URL('../scripts/recover-quant-foundation.mjs',import.meta.url));
const secret='postgres://operator:hunter2@db.internal:5432/robot';
const unitA='robot-quant-'+'a'.repeat(64)+'.service',unitB='robot-quant-'+'b'.repeat(64)+'.service';
const database=mode=>({query:async()=>({rows:mode===undefined?[]:[{mode}]})});
const capture=()=>{const lines=[];return {lines,log:line=>lines.push(line)};};
const recovered=[{job_id:'job-1',status:'CANCELLED',io:[{operation_id:'op-1',proof:'UNKNOWN_FINAL_CHARGED'}]}];
const blockedFailure=(extra={})=>Object.assign(Error('rows blocked '+secret),{code:'RECOVERY_IO_ROW_BLOCKED',
 recovered,maskedUnits:[unitA,unitB],
 blocked:[{job_id:'job-2',operation_id:'op-2',code:'RECOVERY_UNIT_ACTIVE',message:secret,stack:'at '+secret,detail:{url:secret}},
  {job_id:'job-3',operation_id:null,code:'RECOVERY_CGROUP_POPULATED'}],...extra});

test('success prints the result JSON and exits 0',async()=>{
 const out=capture(),result={recovered,maskedUnits:[unitA]};
 assert.equal(await runRecovery({db:database('FOUNDATION'),policy:{},recover:async()=>result,log:out.log}),0);
 assert.deepEqual(out.lines,[JSON.stringify(result)]);
});

test('blocked rows print recovered, maskedUnits and blocked as JSON, code and ids only, and exit 2',async()=>{
 const out=capture();
 const code=await runRecovery({db:database('FOUNDATION'),policy:{},recover:async()=>{throw blockedFailure();},log:out.log});
 assert.equal(code,2);
 assert.equal(out.lines.length,1);
 assert.deepEqual(JSON.parse(out.lines[0]),{recovered,maskedUnits:[unitA,unitB],
  blocked:[{job_id:'job-2',operation_id:'op-2',code:'RECOVERY_UNIT_ACTIVE'},
   {job_id:'job-3',operation_id:null,code:'RECOVERY_CGROUP_POPULATED'}]});
 for(const leak of ['hunter2','postgres://','stack','message','detail','Error'])assert.equal(out.lines[0].includes(leak),false,leak);
});

test('blocked report tolerates missing arrays and unusable codes',()=>{
 assert.deepEqual(blockedReport({code:'RECOVERY_IO_ROW_BLOCKED'}),{recovered:[],maskedUnits:[],blocked:[]});
 assert.deepEqual(blockedReport({recovered:[],maskedUnits:[unitA,{},7],blocked:[{job_id:'job-4',code:{secret}},null]}),
  {recovered:[],maskedUnits:[unitA],blocked:[{job_id:'job-4',operation_id:null,code:'RECOVERY_IO_ROW_FAILED'},
   {job_id:null,operation_id:null,code:'RECOVERY_IO_ROW_FAILED'}]});
});

test('other recovery failures still throw unchanged and print nothing',async()=>{
 const out=capture(),failure=Object.assign(Error('lost'),{code:'RECOVERY_MAINTENANCE_LOCK_LOST'});
 await assert.rejects(runRecovery({db:database('FOUNDATION'),policy:{},recover:async()=>{throw failure;},log:out.log}),error=>error===failure);
 assert.deepEqual(out.lines,[]);
});

test('executor mode other than FOUNDATION throws before recovery runs',async()=>{
 for(const mode of ['LEGACY',undefined]){
  const out=capture();let called=false;
  await assert.rejects(runRecovery({db:database(mode),policy:{},recover:async()=>{called=true;},log:out.log}),
   /Foundation executor mode required/);
  assert.equal(called,false);assert.deepEqual(out.lines,[]);
 }
});

test('script entry still validates arguments and Paper staging before any database work',()=>{
 const env={...process.env,PAPER_TRADING:'false'};
 delete env.DATABASE_URL;
 const usage=spawnSync(process.execPath,[cli],{encoding:'utf8',timeout:20000,windowsHide:true,env});
 assert.notEqual(usage.status,0);assert.equal(usage.stdout,'');
 assert.match(usage.stderr,/Usage: node scripts\/recover-quant-foundation\.mjs --apply/);
 const staging=spawnSync(process.execPath,[cli,'--apply'],{encoding:'utf8',timeout:20000,windowsHide:true,env});
 assert.notEqual(staging.status,0);assert.equal(staging.stdout,'');
 assert.match(staging.stderr,/Foundation recovery requires Paper staging/);
});
