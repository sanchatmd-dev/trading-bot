import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fail} from '../pine-bridge/source.js';
import {validateIoControls} from '../quant-research/io-controls.js';
import {createIoRuntimeLauncher} from '../quant-research/io-runtime-launcher.js';
import {QuantIoLedger} from './quant-io-ledger.js';
import {QuantProfileRuntimeV2} from './quant-profile-runtime-v2.js';
import {validateQuantCapacityPolicy,createProfileRuntimeHealth} from './quant-capacity-policy.js';
import {ingestionEngineHash} from './quant-data.js';
import {createProfileEnrollmentTicketAuthority} from './quant-profile-enrollment-ticket.js';
import {loadQuantProfileEnrollmentSchemaAssertion} from './quant-profile-enrollment-migration.js';

const releaseRootDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

/** Validate configuration before the worker obtains runtime or database ownership. */
export function assertProfileV2Configuration({environment=process.env,platform=process.platform}={}){
 if(environment.QUANT_PROFILE_V2_ENABLED!=='1')return false;
 if(platform!=='linux'||environment.QUANT_RESEARCH_FOUNDATION_ENABLED!=='1')throw fail('QUANT_PROFILE_FOUNDATION_REQUIRED');
 if(!environment.QUANT_HEALTH_RECOVERY_FILE)throw fail('QUANT_PROFILE_RECOVERY_HEALTH_REQUIRED');
 if(!environment.QUANT_IO_CONTROLS_FILE)throw fail('QUANT_PROFILE_IO_CONTROLS_REQUIRED');
 if(!environment.QUANT_RECOVERY_POLICY_FILE)throw fail('QUANT_PROFILE_RECOVERY_POLICY_REQUIRED');
 if(!environment.QUANT_CAPACITY_POLICY_FILE)throw fail('QUANT_CAPACITY_POLICY_REQUIRED');
 return true;
}

/** Construct once after configuration and worker-unit verification. Test seams perform no launch. */
export async function wireQuantProfileV2({worker,db,capacityPolicy,recoveryPolicy,ioControls,health,
 releaseRoot=releaseRootDefault,fileSystem=fs,launcherFactory=createIoRuntimeLauncher}={}){
 const policy=validateQuantCapacityPolicy(capacityPolicy),controls=validateIoControls(ioControls);
 if(worker?.profileV2Enabled!==true||!recoveryPolicy?.releaseRoot||!db?.query||!db?.transaction)
  throw fail('QUANT_PROFILE_WIRING_REQUIRED');
 let enrollment;
 if(worker.profileService?.enrollmentEnabled===true){
  if(!db.runtimeClient||db.isTransaction||worker.profileService.db!==db||
    worker.profileService.profileV2Enabled!==true)throw fail('QUANT_PROFILE_ENROLLMENT_RUNTIME_REQUIRED');
  const tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:()=>ingestionEngineHash(),
   releaseGuard:()=>db.runtimeClient,isTransaction:()=>db.isTransaction});
  const assertSchemaLocked=await loadQuantProfileEnrollmentSchemaAssertion();
  worker.profileService.enrollmentTicketVerifier=tickets.assert;
  enrollment=Object.freeze({enabled:true,tickets,assertSchemaLocked,
   authorizeLocked:(owner,contract,context)=>worker.profileService.authorizeEnrollmentLocked(owner,contract,context)});
 }
 for(const table of ['quant_io_ledgers','quant_io_launches']){
  if(!(await db.query('SELECT to_regclass($1) present',[table])).rows[0]?.present)
   throw fail('QUANT_PROFILE_IO_SCHEMA_REQUIRED');
 }
 const trigger=(await db.query("SELECT 1 FROM pg_trigger WHERE tgname='quant_io_foundation_release_guard' AND tgrelid='quant_foundation_jobs'::regclass AND NOT tgisinternal AND tgenabled IN ('O','A')")).rowCount;
 if(trigger!==1)throw fail('QUANT_PROFILE_RELEASE_GUARD_REQUIRED');
 if(await fileSystem.realpath(releaseRoot)!==recoveryPolicy.releaseRoot)throw fail('QUANT_PROFILE_RELEASE_ROOT_MISMATCH');
 const device=await fileSystem.stat(controls.devicePath);
 if(!device.isBlockDevice()||!Number.isSafeInteger(device.ino)||device.ino<=0)throw fail('QUANT_PROFILE_DEVICE_IDENTITY_REQUIRED');
 const ledger=new QuantIoLedger({db,policy,devices:[{device_id:controls.device,device_inode:device.ino}],
  authorizeTerminal:async({job,action,input})=>{
   const own=worker.profileOperations.get(job.job_id);
   return {ok:db.isTransaction&&['settle','crash','acknowledgeCrashStop'].includes(action)&&
    !!own&&own.leaseToken===job.lease_token&&own.operationId===input?.operation_id};
  }});
 const launcher=launcherFactory({ioControls:controls,storageBudget:worker.service.storageBudget,
  terminalPolicy:policy.terminal,protocol:'profile-v2-provisional'});
 const runtime=new QuantProfileRuntimeV2({db,ledger,scheduler:worker.scheduler,launcher,
  storageBudget:worker.service.storageBudget,health:createProfileRuntimeHealth(health),enrollment,
  authorizeRelease:(_identity,job)=>worker.authorize(job.owner_id,job.contract,'CHECKPOINT',
   {job_id:job.job_id,lease_token:job.lease_token})});
 worker.profileRuntimeV2=runtime;
 return runtime;
}
