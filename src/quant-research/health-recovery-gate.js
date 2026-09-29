const fail=code=>Object.assign(new Error(code),{code});
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;

/** Require fresh, separated healthy observations after startup or failure.
 * Duration uses a monotonic clock; observed_at uses the separate wall clock.
 * The caller must bound probe execution and calibrate policy before admission wiring.
 */
export function createHealthRecoveryGate({probe,clock=()=>Math.floor(performance.now()),wallClock=Date.now,
  minimumHealthyMs=5000,minimumHealthySamples=3,minimumSampleSpacingMs=1000,
  maximumSampleGapMs=5000,maximumProbeMs=2000,maximumObservationAgeMs=2000}={}) {
  if(typeof probe!=='function'||typeof clock!=='function'||typeof wallClock!=='function'||
    !Number.isSafeInteger(minimumHealthyMs)||minimumHealthyMs<1000||minimumHealthyMs>60000||
    !Number.isSafeInteger(minimumHealthySamples)||minimumHealthySamples<2||minimumHealthySamples>10||
    !Number.isSafeInteger(minimumSampleSpacingMs)||minimumSampleSpacingMs<100||minimumSampleSpacingMs>minimumHealthyMs||
    !Number.isSafeInteger(maximumSampleGapMs)||maximumSampleGapMs<minimumSampleSpacingMs||maximumSampleGapMs>60000||
    !Number.isSafeInteger(maximumProbeMs)||maximumProbeMs<1||maximumProbeMs>10000||
    !Number.isSafeInteger(maximumObservationAgeMs)||maximumObservationAgeMs<1||maximumObservationAgeMs>10000)
    throw fail('QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED');
  let healthySince=null,lastSampleAt=null,lastCountedAt=null,lastWallAt=null,samples=0,inFlight=null,generation=0;
  const reset=()=>{healthySince=null;lastSampleAt=null;lastCountedAt=null;lastWallAt=null;samples=0;};
  const unknown=()=>{reset();return {ok:false,reason:'UNKNOWN_HEALTH'};};
  async function sample() {
    const startedGeneration=generation;
    try {
      const began=clock(),wallBegan=wallClock();
      if(!timestamp(began)||!timestamp(wallBegan)||(lastSampleAt!==null&&began<lastSampleAt)||
        (lastWallAt!==null&&wallBegan<lastWallAt))return unknown();
      const health=await probe(),now=clock(),wallNow=wallClock();
      if(startedGeneration!==generation)return unknown();
      if(!timestamp(now)||now<began||now-began>maximumProbeMs||!timestamp(wallNow)||wallNow<wallBegan||
        (lastSampleAt!==null&&now<lastSampleAt))return unknown();
      if(!health||typeof health!=='object'||Array.isArray(health)||typeof health.ok!=='boolean')return unknown();
      if(!health.ok){reset();return {...health,ok:false};}
      if(!timestamp(health.observed_at)||health.observed_at<wallBegan||health.observed_at>wallNow||
        wallNow-health.observed_at>maximumObservationAgeMs)return unknown();
      if(lastSampleAt!==null&&now-lastSampleAt>maximumSampleGapMs)reset();
      if(healthySince===null)healthySince=now;
      if(lastCountedAt===null||now-lastCountedAt>=minimumSampleSpacingMs){
        samples=Math.min(minimumHealthySamples,samples+1);lastCountedAt=now;
      }
      lastSampleAt=now;lastWallAt=wallNow;
      const healthyMs=now-healthySince;
      const ready=samples>=minimumHealthySamples&&healthyMs>=minimumHealthyMs;
      const recovery={ready,healthySamples:samples,healthyMs,minimumHealthySamples,minimumHealthyMs};
      return ready?{...health,ok:true,recovery}:{...health,ok:false,reason:'HEALTH_RECOVERY_PENDING',recovery};
    } catch {return unknown();}
  }
  function check() {
    if(!inFlight)inFlight=sample().finally(()=>{inFlight=null;});
    return inFlight;
  }
  // A concurrent failure invalidates any admission probe already in flight.
  check.reset=()=>{generation++;reset();};
  return check;
}
