import {fail} from '../pine-bridge/source.js';
import {QuantProfileService} from './quant-profile.js';
import {QuantPreflightService,assertQuantPreflightSchema} from './quant-preflight.js';
import {loadQuantCapacityPolicy,validateQuantCapacityPolicy} from './quant-capacity-policy.js';
import {assertQuantProfileEnrollmentSchema} from './quant-profile-enrollment-migration.js';

/** Trusted startup dependencies only. HTTP input never supplies policy or constructors. */
export async function createQuantPreflightApi({pineService,dataService,researchStore,dataEnabled=false,
  paperTrading=false,environment=process.env,loadPolicy=loadQuantCapacityPolicy,
  assertEnrollmentSchema=assertQuantProfileEnrollmentSchema}={}){
  const profileV2Enabled=environment.QUANT_PROFILE_V2_ENABLED==='1';
  const enrollmentRequested=environment.QUANT_PROFILE_V2_ENROLLMENT_ENABLED==='1';
  const preflightRequested=environment.QUANT_PREFLIGHT_ENABLED==='1';
  if((enrollmentRequested||preflightRequested)&&(!dataEnabled||!paperTrading||
    environment.PINE_BRIDGE_ENV!=='staging'||environment.QUANT_RESEARCH_FOUNDATION_ENABLED!=='1'))
    throw fail('QUANT_PREFLIGHT_STAGING_REQUIRED',503);
  if(enrollmentRequested&&!profileV2Enabled)throw fail('QUANT_PROFILE_V2_REQUIRED',503);
  const enrollmentEnabled=dataEnabled&&enrollmentRequested,preflightEnabled=dataEnabled&&preflightRequested;
  let capacityPolicy;
  if(enrollmentEnabled||preflightEnabled){
    capacityPolicy=validateQuantCapacityPolicy(await loadPolicy(environment.QUANT_CAPACITY_POLICY_FILE));
    await dataService.ready();
    await assertEnrollmentSchema(pineService.db);
  }
  const profileService=new QuantProfileService({pineService,dataService,researchStore,enabled:dataEnabled,
    capacityPolicy,profileV2Enabled,enrollmentEnabled});
  if(enrollmentEnabled)await profileService.ready();
  // Only an enabled PF-2 reads dataset stores. With the data capability off there are none, and the server must still start.
  const preflightService=new QuantPreflightService({pineService,dataService,
    stores:preflightEnabled?{raw:dataService.datasetStore,research:researchStore}:undefined,capacityPolicy,enabled:preflightEnabled});
  if(preflightEnabled)await assertQuantPreflightSchema(pineService.db);
  return {profileService,preflightService,enrollmentEnabled,preflightEnabled,capacityPolicy};
}
