import {D,exact} from '../money.js';
import {validateRisk} from './risk-policy-validation.js';
import {reviewRiskPolicy} from './risk-policy-review.js';
import {keys,fail} from '../pine-bridge/source.js';

// A scenario changes only local calculation inputs. It retains actual orders,
// positions, daily counters, session guards and owner authorization.
export function riskScenario(scenario,savedPolicy,actualAccount,defaultRisk,exposure){
  keys(scenario,['policy','capital']);
  keys(scenario.policy,Object.keys(defaultRisk),[]);
  if(scenario.policy.defaults!==undefined)keys(scenario.policy.defaults,Object.keys(defaultRisk.defaults),[]);
  const policy=validateRisk(scenario.policy,savedPolicy,defaultRisk);
  if(reviewRiskPolicy(policy).status!=='CONSISTENT')throw fail('SCENARIO_POLICY_INVALID');
  keys(scenario.capital,['cash','bookEquity']);
  const cash=exact(scenario.capital.cash),bookEquity=exact(scenario.capital.bookEquity);
  if(D(cash).lt(0)||D(bookEquity).lt(0)||D(cash).gt('1e12')||D(bookEquity).gt('1e12')||D(cash).gt(bookEquity))throw fail('SCENARIO_CAPITAL_INVALID');
  const reservedCash=D(exposure.reservedNotional||0).plus(exposure.reservedFees||0);
  if(D(cash).lt(reservedCash)||D(bookEquity).lt(D(actualAccount.positionCost||0).plus(reservedCash))||D(bookEquity).lt(D(cash).plus(actualAccount.positionCost||0)))throw fail('SCENARIO_CAPITAL_BELOW_COMMITMENTS');
  return {policy,account:{...actualAccount,cash,bookEquity,hypothetical:true},
    scenario:{hypothetical:true,actualCash:actualAccount.cash,actualBookEquity:actualAccount.bookEquity,
      note:'Hypothetical current cash and book equity, with actual positions, reservations, daily counters and session guards. No policy or capital is saved.'}};
}
