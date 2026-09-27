import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {reviewRiskPolicy,readinessCapacity} from '../src/postgres/risk-policy-review.js';

test('policy review preserves policy and reports conflicting defaults and funding',()=>{
  const policy=structuredClone(config.defaultRisk);
  assert.equal(reviewRiskPolicy(policy).status,'CONSISTENT');
  policy.defaults.riskPercent=101;policy.equities={fixture:'100'};policy.balances={fixture:'101'};
  const before=structuredClone(policy),result=reviewRiskPolicy(policy);
  assert.deepEqual(policy,before);assert.equal(result.status,'CONFLICT');
  assert.ok(result.issues.some(x=>x.code==='DEFAULT_OUTSIDE_POLICY'));
  assert.ok(result.issues.some(x=>x.code==='CAPITAL_CONFIGURATION_INVALID'));
});

test('invalid or disabled guards remain explicit conflicts',()=>{
  for(const update of [{maxRiskPercent:'NaN'},{maxTradesPerDay:1.5},{paperTrading:false},{requireReduceOnlySell:false},{blockDuringNews:undefined}]){
    assert.equal(reviewRiskPolicy({...config.defaultRisk,...update}).status,'CONFLICT');
  }
});

test('capacity preserves decimal reservations and labels execution rather than BUY counts',()=>{
  const result=readinessCapacity({...config.defaultRisk,maxDailyNotional:'100.000000000000000001'},
    {trades:3,notional:'20.000000000000000002'},
    {reservedTrades:2,reservedNotional:'30',openPositions:2});
  assert.equal(result.remainingDailyExecutions,5);
  assert.equal(result.remainingDailyNotional,'49.999999999999999999');
  assert.equal(result.remainingUniqueSymbols,1);assert.equal(result.allocationLimitEnforced,false);
});
