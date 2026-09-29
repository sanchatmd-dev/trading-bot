import {createHealthRecoveryGate} from './health-recovery-gate.js';
import {createBoundedHealthProbe} from './bounded-health-probe.js';

const fail=code=>Object.assign(new Error(code),{code});
const fields=['version','minimumHealthyMs','minimumHealthySamples','minimumSampleSpacingMs',
  'maximumSampleGapMs','maximumProbeMs','maximumObservationAgeMs'];

/** Process-local recovery policy. Restart always requires fresh recovery.
 * This is a temporal gate; it does not claim calibrated pressure thresholds or
 * persistent I/O accounting. Timed-out probes stay latched until settlement.
 */
export function createSchedulerHealth({probe,policy,clock,wallClock}={}) {
  if(typeof probe!=='function'||!policy||Array.isArray(policy)||
    Object.keys(policy).length!==fields.length||fields.some(key=>!Object.hasOwn(policy,key))||
    policy.version!=='quant-health-recovery-v1')throw fail('QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED');
  const {version,...limits}=policy;
  const boundedProbe=createBoundedHealthProbe({probe,maximumProbeMs:policy.maximumProbeMs});
  const admission=createHealthRecoveryGate({probe:boundedProbe,...limits,...(clock?{clock}:{}),...(wallClock?{wallClock}:{})});
  return async function health({action='CLAIM'}={}) {
    if(action==='CLAIM')return admission();
    if(action!=='HEARTBEAT')return {ok:false,reason:'UNKNOWN_HEALTH_ACTION'};
    // Active jobs use the immediate stop gate, not the admission recovery timer.
    try {
      const current=await boundedProbe();
      if(!current||typeof current!=='object'||Array.isArray(current)||typeof current.ok!=='boolean'){
        admission.reset();return {ok:false,reason:'UNKNOWN_HEALTH'};
      }
      if(!current.ok)admission.reset();
      return current;
    }catch{admission.reset();return {ok:false,reason:'UNKNOWN_HEALTH'};}
  };
}
