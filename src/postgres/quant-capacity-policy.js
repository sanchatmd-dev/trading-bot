import fs from 'node:fs/promises';
import path from 'node:path';
import {fail} from '../pine-bridge/source.js';
import {validateCapacityPolicy} from '../quant-research/capacity-contract.js';

/** Load the reviewed staging policy with the same file trust rules as recovery. */
export async function loadQuantCapacityPolicy(filename=process.env.QUANT_CAPACITY_POLICY_FILE){
 if(process.platform!=='linux')throw fail('QUANT_CAPACITY_POLICY_LINUX_REQUIRED');
 if(typeof filename!=='string'||!path.isAbsolute(filename))throw fail('QUANT_CAPACITY_POLICY_REQUIRED');
 const info=await fs.lstat(filename);
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o022))
  throw fail('QUANT_CAPACITY_POLICY_UNTRUSTED');
 return validateQuantCapacityPolicy(JSON.parse(await fs.readFile(filename,'utf8')));
}

export function validateQuantCapacityPolicy(value){
 const policy=validateCapacityPolicy(value);
 if(policy.environment!=='staging'||!policy.terminal)throw fail('QUANT_CAPACITY_POLICY_INVALID');
 return policy;
}

/** The runtime has two actions; unknown actions never reach the health probe. */
export function createProfileRuntimeHealth(health){
 if(typeof health!=='function')throw fail('QUANT_PROFILE_HEALTH_CALLBACK_REQUIRED');
 return context=>{
  const action=context?.action==='PROFILE_RELEASE'?'CLAIM':context?.action==='PROFILE_OBSERVE'?'HEARTBEAT':null;
  if(!action)throw fail('QUANT_PROFILE_HEALTH_ACTION_INVALID');
  return health({...context,action});
 };
}
