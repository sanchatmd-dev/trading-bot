import {keys,number,fail,hash,canonical} from '../pine-bridge/source.js';
import {membershipSnapshot} from './pine-bridge-registry.js';

const minimum={sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1};
export function validateEvidence(evidence,snapshotHash) {
  keys(evidence,['snapshot_hash','artifact_hash','source_hash','compilation_errors','warnings','reviewed_warnings','binding_coverage','source_changed_bytes','unresolved_references','identifier_collisions','duplicate_bindings','native_alerts_isolated','effective_inputs_reviewed','signals_reviewed','cases','decision_match_percent','duplicate_ledger_effects','unrelated_payloads','level_difference_ticks','execution_model','references']);
  if(evidence.snapshot_hash!==snapshotHash)throw fail('STALE_EVIDENCE',409);
  for(const field of ['compilation_errors','warnings','reviewed_warnings','source_changed_bytes','unresolved_references','identifier_collisions','duplicate_bindings','duplicate_ledger_effects','unrelated_payloads','level_difference_ticks'])number(evidence[field],{min:0,integer:true});
  for(const field of ['compilation_errors','source_changed_bytes','unresolved_references','identifier_collisions','duplicate_bindings','duplicate_ledger_effects','unrelated_payloads','level_difference_ticks'])if(evidence[field]!==0)throw fail('BRIDGE_EVIDENCE_FAILED',409);
  if(evidence.binding_coverage!==100||evidence.decision_match_percent!==100||evidence.warnings!==evidence.reviewed_warnings||evidence.native_alerts_isolated!==true||evidence.effective_inputs_reviewed!==true||evidence.signals_reviewed!==true)throw fail('BRIDGE_EVIDENCE_INCOMPLETE',409);
  keys(evidence.cases,Object.keys(minimum));for(const [name,min]of Object.entries(minimum))number(evidence.cases[name],{min,integer:true});
  keys(evidence.execution_model,['version','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','data_profile']);
  const m=evidence.execution_model;
  if(m.version!=='paper-close-v1'||m.data_profile!=='closed-ohlcv-atr14-v1')throw fail('UNSUPPORTED_EXECUTION_MODEL');
  for(const field of ['price_tick','quantity_step','risk_percent'])number(m[field],{min:0.000000000000000001,max:field==='risk_percent'?100:1e12});
  number(m.fee_bps,{min:0,max:1000});number(m.slippage_bps,{min:0,max:1000});
  keys(evidence.references,['tradingview','source_review','paper_fixture']);
  for(const value of Object.values(evidence.references))if(typeof value!=='string'||value.length<8||value.length>1000)throw fail('EVIDENCE_REFERENCE_REQUIRED');
  return evidence;
}
export async function freshSnapshot(service,row) {
  const members=await membershipSnapshot(service,row.owner_id,row.bot_id);
  if(canonical(members)!==canonical(row.snapshot.membership))throw fail('STALE_MEMBERSHIP',409);
  const session=await service.store.getBotSession(row.bot_id);
  const policy=session.locked_policy?JSON.parse(session.locked_policy):await service.store.risk(row.bot_id,service.defaultRisk);
  if(hash(canonical(policy))!==row.snapshot.policy_hash)throw fail('STALE_POLICY',409);
  const capital=await service.store.paperAccounts(row.bot_id);
  const basis=accounts=>accounts.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance}));
  if(canonical(basis(capital))!==canonical(basis(row.snapshot.capital)))throw fail('STALE_CAPITAL',409);
  const funding=await service.db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(row.bot_id);
  if(funding.cutoff!==row.snapshot.funding_cutoff)throw fail('STALE_CAPITAL',409);
  return {policy,session,members};
}
export async function deploymentEvidence(db,row) {
  const record=await db.prepare('SELECT * FROM pine_bridge_evidence WHERE deployment_id=?').get(row.deployment_id);
  if(!record||record.snapshot_hash!==row.snapshot_hash||hash(canonical(record.evidence))!==record.evidence_hash)throw fail('BRIDGE_EXECUTION_EVIDENCE_REQUIRED',409);
  const e=validateEvidence(record.evidence,row.snapshot_hash);
  if(e.artifact_hash!==row.snapshot.artifact_hash||e.source_hash!==row.snapshot.source_hash)throw fail('STALE_EVIDENCE',409);
  return e;
}
export async function activateDeployment(service,owner,id) {
  let row=await service.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=?').get(id,owner);
  if(!row)throw fail('NOT_FOUND',404);await service.authorize(owner,row.bot_id);
  await service.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner);
  if(row.bot_id!==owner)await service.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(row.bot_id);
  row=await service.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=? FOR UPDATE').get(id,owner);
  if(!row)throw fail('NOT_FOUND',404);
  if(row.state==='REVOKED'||row.state==='EXIT_ONLY')throw fail('DEPLOYMENT_REPLACED',409);
  const {policy,session,members}=await freshSnapshot(service,row);
  if(members.length!==1)throw fail('MULTI_PINE_REQUIRES_APP_3B',409);
  if(!['SETUP','RUNNING','PAUSED'].includes(session.state))throw fail('BOT_STOPPED',409);
  const evidence=await deploymentEvidence(service.db,row);
  if(evidence.execution_model.risk_percent>policy.maxRiskPercent)throw fail('RISK_EXCEEDS_POLICY');
  await service.db.prepare("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE bot_id=? AND state='READY' AND deployment_id<>?").run(row.bot_id,id);
  await service.db.prepare("UPDATE pine_deployments SET state='READY' WHERE deployment_id=?").run(id);
  await service.store.audit(owner,'pine_bridge.activated',id,{snapshot_hash:row.snapshot_hash});
  return {deployment_id:id,state:'READY',execution_mode:'PAPER',quant_capability:'UNSUPPORTED'};
}
