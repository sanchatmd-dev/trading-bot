const unknown=()=>({ok:false,reason:'UNKNOWN_HEALTH'});

/** Bound the caller's wait and request cooperative cancellation. An uncooperative
 * probe remains latched until settlement, so timeouts cannot multiply work.
 * This cannot interrupt synchronous JavaScript or terminate external DB work.
 */
export function createBoundedHealthProbe({probe,maximumProbeMs}={}) {
  if(typeof probe!=='function'||!Number.isSafeInteger(maximumProbeMs)||maximumProbeMs<1||maximumProbeMs>10000)
    throw Object.assign(new Error('QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED'),{code:'QUANT_HEALTH_RECOVERY_CONFIGURATION_REQUIRED'});
  let active=null;
  return function boundedProbe() {
    if(active)return active.timedOut?Promise.resolve(unknown()):active.result;
    const controller=new AbortController();
    const started=performance.now();
    let resolveResult;
    const slot={timedOut:false,result:new Promise(resolve=>{resolveResult=resolve;})};
    active=slot;
    const timer=setTimeout(()=>{
      slot.timedOut=true;
      resolveResult(unknown());
      controller.abort();
    },maximumProbeMs);
    const settled=value=>{
      clearTimeout(timer);if(active===slot)active=null;
      const elapsed=performance.now()-started;
      if(!slot.timedOut){
        if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=maximumProbeMs){
          slot.timedOut=true;resolveResult(unknown());controller.abort();
        }else resolveResult(value);
      }
    };
    // Keep rejection handling attached after timeout. Late success is discarded.
    Promise.resolve().then(()=>probe({signal:controller.signal})).then(
      settled,()=>settled(unknown())
    );
    return slot.result;
  };
}
