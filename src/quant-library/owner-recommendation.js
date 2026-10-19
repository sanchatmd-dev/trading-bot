/**
 * The G7 owner-recommendation derivation (OD-18), kept in its own pure module so that derive.js and package-gates.js can both
 * use it without importing each other. It reads no database, no file, no network, no clock and no random source.
 * package-gates.js re-exports every name below, so its public API is unchanged.
 */
export const RECOMMENDATION_COMPLETION_REASON='RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';
/**
 * Contract versions whose runs may derive G7 PASS (OD-18, with OD-3 and OD-12). The contract names no version for the next
 * research contract, so the single entry below is a placeholder that must be replaced when that version is named. The two
 * contract versions in use today (ql3a-research-job-v1 and ql3a-research-job-v2) are absent on purpose: no run of either can
 * pass G7.
 */
export const OWNER_RECOMMENDATION_CONTRACT_VERSIONS=Object.freeze(['ql3a-research-job-v3']);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** G7 is derived from the completion reason and the contract version only. result.owner_recommendation_ready is ignored. */
export function ownerRecommendationGate(run){
  const ok=isObject(run)&&isObject(run.result)&&run.result.completion_reason===RECOMMENDATION_COMPLETION_REASON&&isObject(run.contract)&&
    OWNER_RECOMMENDATION_CONTRACT_VERSIONS.includes(run.contract.version);
  return Object.freeze(ok?{gate:'G7',state:'PASS',code:null}:{gate:'G7',state:'FAIL',code:'OWNER_RECOMMENDATION_NOT_READY'});
}
