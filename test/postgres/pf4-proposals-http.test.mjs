import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp} from 'node:fs/promises';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createWorld,fixtureEnvelope} from '../helpers/preflight-pg-fixture.mjs';
import {HEALTHY,insertBridgeEvidence,withResult} from '../helpers/pf3-envelope-fixture.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {ReadinessService} from '../../src/postgres/pf3-readiness-service.js';
import {ProposalService} from '../../src/postgres/pf4-proposal-service.js';
import {Store} from '../../src/postgres/store.js';
import {trustedSources} from '../../src/postgres/quant-preflight.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';

// PF-4 over the actual application, auth and SERIALIZABLE response buffering. Isolated local PostgreSQL only.
const PREVIEW='/api/risk/proposals/preview',APPLY='/api/risk/proposals/apply',CONFIRM='SAVE_RISK_PROPOSAL';
const policy=(overrides={})=>({...structuredClone(config.defaultRisk),blockDuringNews:false,capPercentEquitySize:false,maxRiskPercent:5,
  maxOrderNotional:'2000',maxDailyNotional:'20000',equities:{'binance-global':'1000'},balances:{'binance-global':'800'},...overrides});
async function fixture(t,options){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,options);t.after(()=>f.close());return f;
}
// Whole-table digests: any insert, update or delete changes the digest. A refused request writes only its own request.error
// audit row (server error handling, outside the PF-4 path), which the digest leaves out.
const TABLES=['risk_profiles','paper_funding','paper_snapshots','paper_cash_journal','ledger_streak','ledger_daily','ledger_positions',
  'ledger_position_allocations','signals','bot_sessions','audit','pine_deployments','pine_bridge_evidence','pine_memberships',
  'quant_foundation_jobs','quant_preflight_jobs','quant_holdout_boundaries','users','licenses','system_settings'];
async function digests(db,tables=TABLES){
  const out={};
  for(const table of tables){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    const where=table==='audit'?" WHERE x.event<>'request.error'":'';
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM ${table} x${where}`)).rows[0].d:null;
  }
  return out;
}
const preview=(f,session,body={},query='')=>f.request(PREVIEW+query,'POST',body,session);
const apply=(f,session,body,query='')=>f.request(APPLY+query,'POST',body,session);
const applyBody=(answer,declared,extra={})=>({base_policy_hash:answer.body.proposal.base_policy_hash,proposal_hash:answer.body.proposal.proposal_hash,declared,confirm:CONFIRM,...extra});
const refuse=(answer,status,code)=>{assert.equal(answer.status,status,JSON.stringify(answer.body));if(code)assert.equal(answer.body.code,code);};
const saved=(f,id)=>f.store.risk(id,config.defaultRisk);
const savedHash=async(f,id)=>hash(canonical(await saved(f,id)));
const auditCounts=async(db,id)=>Object.fromEntries((await db.query(`SELECT event,count(*)::int n FROM audit WHERE user_id=$1
  AND event IN ('risk.updated','risk.proposal.applied') GROUP BY event`,[id])).rows.map(row=>[row.event,row.n]));
const count=async(db,table,id)=>(await db.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`,[id])).rows[0].n;
const LIMITS={loss_per_trade_percent:'1',order_notional_ceiling:'500',daily_notional_ceiling:'30000',allow_repeated_entries:false};

test('preview: a read-only proposal with before/after, provenance and the news advisory; nothing is written',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy({blockDuringNews:true}));
  assert.equal((await f.request(PREVIEW,'POST',{})).status,401);
  const before=await digests(f.db);
  const answer=await preview(f,owner,{declared:LIMITS});
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body,p=body.proposal;
  assert.equal(body.version,'pf4-preview-v1');assert.deepEqual(body.flags,{saves_nothing:true,deterministic:true,ai_used:false});
  assert.equal(body.report_verdict,'CONFIGURATION_FAILURE','the news block is a PF-3 configuration blocker');
  assert.equal(p.version,'pf4-proposal-v1');assert.equal(p.bot_id,id);assert.equal(p.base_policy_hash,await savedHash(f,id));
  assert.deepEqual(p.declared,{loss_per_trade_percent:'1',order_notional_ceiling:'500',daily_notional_ceiling:'30000',allow_repeated_entries:false});
  assert.deepEqual(p.changes.map(item=>item.field),['maxRiskPercent','maxOrderNotional','maxDailyNotional','onePositionPerSymbol','capPercentEquitySize','defaults.orderNotional']);
  const order=p.changes.find(item=>item.field==='maxOrderNotional');
  assert.deepEqual([order.before,order.after,order.rule,order.direction],['2000','500','ORDER_NOTIONAL','LOWER']);
  assert.deepEqual(order.provenance.map(entry=>entry.source),['SAVED_POLICY','OWNER_DECLARED']);
  const daily=p.changes.find(item=>item.field==='maxDailyNotional');assert.deepEqual([daily.before,daily.after,daily.direction],['20000','30000','RAISE']);
  assert.deepEqual(p.policy_input,{maxRiskPercent:1,maxOrderNotional:'500',maxDailyNotional:'30000',onePositionPerSymbol:true,capPercentEquitySize:true,defaults:{orderNotional:'500'}});
  assert.match(p.proposal_hash,/^[a-f0-9]{64}$/);assert.match(p.after_policy_hash,/^[a-f0-9]{64}$/);
  assert.equal(p.refusal,null);assert.equal(p.evidence,null);assert.equal(p.bridge_risk,null);
  const news=p.advisories.find(item=>item.code==='NEWS_BLOCK_WITHOUT_NEWS_DATA');
  assert.equal(news.explanation,'Bridge alerts carry no news data; turn off Block during news yourself in the Risk form, then save and generate again.');
  assert.ok(p.advisories.some(item=>item.code==='LOSS_GUARDS_LOCKED')&&p.advisories.some(item=>item.code==='CAPITAL_NEVER_CHANGED'));
  assert.ok(!('blockDuringNews' in p.policy_input),'the news block is only advised, never proposed');
  assert.equal(body.static.consistency.before.status,'CONSISTENT');assert.equal(body.static.consistency.after.status,'CONSISTENT');
  assert.equal(body.static.capacity.before.remainingDailyNotional,'20000');assert.equal(body.static.capacity.after.remainingDailyNotional,'30000');
  assert.deepEqual(body.sizing,{status:'NOT_REQUESTED',code:null,detail:null,before:null,after:null,capital:null});
  assert.deepEqual(body.save,{allowed:true,refusal_code:null,confirm:CONFIRM,consequences:[]});
  assert.deepEqual(await digests(f.db),before,'a preview writes nothing');
  assert.deepEqual((await preview(f,owner,{declared:LIMITS})).body.proposal,p,'the same request gives the same proposal');
  assert.deepEqual(await digests(f.db),before);
});

test('preview and apply: auth, owner isolation, one bot, strict body, query and methods',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),foreign=await f.login(f.foreign),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const before=await digests(f.db),p=await preview(f,owner,{declared:LIMITS});
  assert.equal((await f.request(APPLY,'POST',applyBody(p,LIMITS))).status,401);
  // The shared api() helper sends bot_id: the same bot answers; an owner's sibling bot has its own policy.
  assert.deepEqual((await preview(f,owner,{declared:LIMITS},'?bot_id='+id)).body.proposal,p.body.proposal);
  const sibling=await preview(f,owner,{declared:LIMITS},'?bot_id='+f.sibling.id);
  assert.equal(sibling.status,200);assert.equal(sibling.body.proposal.bot_id,f.sibling.id);
  assert.notEqual(sibling.body.proposal.base_policy_hash,p.body.proposal.base_policy_hash);
  for(const call of [(query)=>preview(f,foreign,{declared:LIMITS},query),(query)=>apply(f,foreign,applyBody(p,LIMITS),query)]){
    refuse(await call('?bot_id='+id),403);refuse(await call('?bot_id='+f.sibling.id),403);
  }
  refuse(await preview(f,owner,{},'?bot_id=all'),400);refuse(await apply(f,owner,applyBody(p,LIMITS),'?bot_id=all'),400);
  assert.equal((await preview(f,foreign,{declared:LIMITS})).body.proposal.bot_id,f.foreign.id,'another owner only ever sees its own bot');
  for(const query of ['?limit=5','?bot_id=','?bot_id='+id+'&bot_id='+id,'?bot_id='+id+'&extra=1']){
    refuse(await preview(f,owner,{},query),400,'INVALID_FIELDS');refuse(await apply(f,owner,applyBody(p,LIMITS),query),400,'INVALID_FIELDS');
  }
  for(const body of [{extra:1},{declared:{extra:1}},{declared:[]},{declared:'x'},{intent:{}},{intent:{signal:{},bridge:{}}},{intent:[]}])
    refuse(await preview(f,owner,body),400,'INVALID_FIELDS');
  for(const body of [null,[]])refuse(await preview(f,owner,body),400);
  refuse(await apply(f,owner,[]),400);
  for(const declared of [{loss_per_trade_percent:'abc'},{loss_per_trade_percent:'0'},{order_notional_ceiling:'-1'},{allow_repeated_entries:'false'},{daily_notional_ceiling:'10000000000001'}])
    refuse(await preview(f,owner,{declared}),400,'PF4_DECLARED_INVALID');
  for(const method of ['GET','PUT','PATCH','DELETE'])for(const path of [PREVIEW,APPLY])
    refuse(await f.request(path,method,method==='GET'?undefined:{},owner),405,'METHOD_NOT_ALLOWED');
  // Missing CSRF and a foreign origin never reach the proposal code.
  assert.equal((await f.request(PREVIEW,'POST',{},{cookie:owner.cookie,csrf:''})).status,403);
  assert.equal((await f.request(APPLY,'POST',applyBody(p,LIMITS),{cookie:owner.cookie,csrf:''})).status,403);
  assert.deepEqual(await digests(f.db),before,'no refused request wrote a business row');
});

test('apply: a confirmed proposal saves exactly the proposed policy through the PUT path, with zero funding change and two audit rows',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy({blockDuringNews:true}));
  const before=await saved(f,id),accounts=await f.store.paperAccounts(id),audits0=await auditCounts(f.db,id);
  const funding0=[await count(f.db,'paper_funding',id),await count(f.db,'paper_snapshots',id),await count(f.db,'paper_cash_journal',id)];
  const p=await preview(f,owner,{declared:LIMITS}),hashes=await digests(f.db);
  // Confirmation and exact keys come first; none of these refusals saves anything.
  for(const confirm of ['yes','save_risk_proposal',true,null,CONFIRM+' '])refuse(await apply(f,owner,applyBody(p,LIMITS,{confirm})),400,'CONFIRMATION_REQUIRED');
  refuse(await apply(f,owner,applyBody(p,LIMITS,{confirm:undefined})),400,'CONFIRMATION_REQUIRED');
  for(const extra of [{policy:{}},{bot_id:id},{intent:{}}])refuse(await apply(f,owner,applyBody(p,LIMITS,extra)),400,'INVALID_FIELDS');
  for(const key of ['base_policy_hash','proposal_hash','declared']){const body=applyBody(p,LIMITS);delete body[key];refuse(await apply(f,owner,body),400,'INVALID_FIELDS');}
  for(const bad of [{base_policy_hash:'x'},{proposal_hash:'A'.repeat(64)},{proposal_hash:5},{declared:null},{declared:[]},{declared:'x'}])
    refuse(await apply(f,owner,applyBody(p,LIMITS,bad)),400,'INVALID_FIELDS');
  // S-2: only strings are hashes; an array that stringifies to a hash is a 400, not a stale 409.
  for(const key of ['base_policy_hash','proposal_hash'])refuse(await apply(f,owner,applyBody(p,LIMITS,{[key]:[p.body.proposal[key]]})),400,'INVALID_FIELDS');
  refuse(await apply(f,owner,applyBody(p,{loss_per_trade_percent:'zero'})),400,'PF4_DECLARED_INVALID');
  assert.deepEqual(await digests(f.db),hashes,'refused applies save nothing');
  const answer=await apply(f,owner,applyBody(p,LIMITS));
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const result=answer.body,after=await saved(f,id);
  assert.equal(result.version,'pf4-apply-v1');assert.equal(result.saved,true);assert.deepEqual(result.consequences,[]);
  assert.equal(result.policy_hash_before,p.body.proposal.base_policy_hash);assert.equal(result.policy_hash_after,p.body.proposal.after_policy_hash);
  assert.equal(result.policy_hash_after,await savedHash(f,id),'the hash the preview promised is the hash that was saved');
  assert.deepEqual(result.changed_fields,p.body.proposal.changes.map(item=>item.field));assert.deepEqual(result.policy,after);
  assert.deepEqual([after.maxRiskPercent,after.maxOrderNotional,after.maxDailyNotional,after.onePositionPerSymbol,after.capPercentEquitySize,after.defaults.orderNotional],
    [1,'500','30000',true,true,'500']);
  for(const key of Object.keys(before)){
    if(['maxRiskPercent','maxOrderNotional','maxDailyNotional','onePositionPerSymbol','capPercentEquitySize'].includes(key))continue;
    if(key==='defaults')assert.deepEqual({...after.defaults,orderNotional:before.defaults.orderNotional},before.defaults);
    else assert.equal(canonical(after[key]),canonical(before[key]),key+' stays as saved');
  }
  assert.equal(after.blockDuringNews,true,'the news block is never changed by a proposal');
  assert.deepEqual([await count(f.db,'paper_funding',id),await count(f.db,'paper_snapshots',id),await count(f.db,'paper_cash_journal',id)],funding0,'zero funding delta');
  assert.deepEqual(await f.store.paperAccounts(id),accounts);assert.deepEqual([after.equities,after.balances],[before.equities,before.balances]);
  const audits=await auditCounts(f.db,id);
  assert.deepEqual([audits['risk.updated']-(audits0['risk.updated']??0),audits['risk.proposal.applied']-(audits0['risk.proposal.applied']??0)],[1,1]);
  const row=async event=>{const details=(await f.db.query('SELECT details FROM audit WHERE user_id=$1 AND event=$2 ORDER BY id DESC LIMIT 1',[id,event])).rows[0].details;return typeof details==='string'?JSON.parse(details):details;};
  assert.deepEqual((await row('risk.updated')).policy,after);
  assert.deepEqual(await row('risk.proposal.applied'),{owner_id:id,base_policy_hash:result.policy_hash_before,policy_hash:result.policy_hash_after,
    proposal_hash:p.body.proposal.proposal_hash,changed_fields:result.changed_fields,evidence_job_id:null,
    declared:{loss_per_trade_percent:'1',order_notional_ceiling:'500',daily_notional_ceiling:'30000',allow_repeated_entries:false}});
  // The same body again is stale: the saved policy moved on.
  const replay=await digests(f.db);
  refuse(await apply(f,owner,applyBody(p,LIMITS)),409,'STALE_POLICY_STATE');assert.deepEqual(await digests(f.db),replay);
});

test('stale detection: a changed policy, a tampered hash and a changed declaration are 409 and save nothing; a new preview recovers',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const p=await preview(f,owner,{declared:LIMITS}),flip=value=>(value[0]==='a'?'b':'a')+value.slice(1);
  const hashes=await digests(f.db);
  refuse(await apply(f,owner,applyBody(p,LIMITS,{proposal_hash:flip(p.body.proposal.proposal_hash)})),409,'PROPOSAL_STALE');
  refuse(await apply(f,owner,applyBody(p,LIMITS,{base_policy_hash:flip(p.body.proposal.base_policy_hash)})),409,'STALE_POLICY_STATE');
  refuse(await apply(f,owner,applyBody(p,{...LIMITS,order_notional_ceiling:'501'})),409,'PROPOSAL_STALE');
  refuse(await apply(f,owner,applyBody(p,{loss_per_trade_percent:'1'})),409,'PROPOSAL_STALE');
  assert.deepEqual(await digests(f.db),hashes,'nothing was saved');
  // The saved policy changes after the preview (the owner used the Risk form): the old proposal is stale, the saved policy is theirs.
  const put=await f.request('/api/risk','PUT',{maxTradesPerDay:11},owner);
  assert.equal(put.status,200,JSON.stringify(put.body));
  const afterPut=await digests(f.db);
  refuse(await apply(f,owner,applyBody(p,LIMITS)),409,'STALE_POLICY_STATE');
  assert.deepEqual(await digests(f.db),afterPut);
  assert.equal((await saved(f,id)).maxTradesPerDay,11);assert.equal((await saved(f,id)).maxOrderNotional,'2000');
  assert.equal((await auditCounts(f.db,id))['risk.proposal.applied']??0,0);
  // A new preview sees the new policy and its save works; the stale body does not.
  const again=await preview(f,owner,{declared:LIMITS});
  assert.notEqual(again.body.proposal.base_policy_hash,p.body.proposal.base_policy_hash);
  assert.notEqual(again.body.proposal.proposal_hash,p.body.proposal.proposal_hash);
  assert.equal((await apply(f,owner,applyBody(again,LIMITS))).status,200);
  const final=await saved(f,id);
  assert.deepEqual([final.maxTradesPerDay,final.maxOrderNotional],[11,'500'],'the owner change and the proposal both stand');
  refuse(await apply(f,owner,applyBody(again,LIMITS)),409,'STALE_POLICY_STATE');
});

test('refusals: empty, conflicting saved policy, RUNNING or PAUSED session and capital drift are shown in the preview and are 409 on apply',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const funding=()=>count(f.db,'paper_funding',id),funding0=await funding();
  const set=value=>f.db.query('UPDATE risk_profiles SET policy=$2 WHERE user_id=$1',[id,JSON.stringify(value)]);
  const check=async(declared,code)=>{
    const p=await preview(f,owner,{declared});
    assert.equal(p.status,200,JSON.stringify(p.body));assert.deepEqual([p.body.save.allowed,p.body.save.refusal_code],[false,code]);
    const hashes=await digests(f.db);
    refuse(await apply(f,owner,applyBody(p,declared)),409,code);
    assert.deepEqual(await digests(f.db),hashes,code+' saves nothing');return p;
  };
  const empty=await check({},'PROPOSAL_EMPTY');assert.deepEqual(empty.body.save.consequences,[]);
  await check({loss_per_trade_percent:'5',order_notional_ceiling:'2000'},'PROPOSAL_EMPTY');
  await f.db.query("INSERT INTO bot_sessions(user_id,state,run_id,locked_policy,initial_capital,started_at,stopped_at,updated_at) VALUES($1,'RUNNING','run-1',$2,'{}',1,NULL,1)",
    [id,JSON.stringify(policy())]);
  await check(LIMITS,'RISK_POLICY_FROZEN');
  await f.db.query("UPDATE bot_sessions SET state='PAUSED' WHERE user_id=$1",[id]);await check(LIMITS,'RISK_POLICY_FROZEN');
  await f.db.query("UPDATE bot_sessions SET state='STOPPED' WHERE user_id=$1",[id]);
  const open=await preview(f,owner,{declared:LIMITS});assert.deepEqual([open.body.save.allowed,open.body.save.refusal_code],[true,null],'a STOPPED session may be edited like PUT allows');
  await f.db.query('DELETE FROM bot_sessions WHERE user_id=$1',[id]);
  await set(policy({maxTradesPerDay:0}));
  const broken=await check(LIMITS,'BASE_POLICY_CONFLICT');
  assert.deepEqual(broken.body.proposal.changes,[]);assert.equal(broken.body.proposal.refusal.code,'BASE_POLICY_CONFLICT');
  assert.equal(broken.body.proposal.advisories[0].code,'BASE_POLICY_CONFLICT');assert.equal(broken.body.static.consistency.before.status,'CONFLICT');
  await set(policy({equities:{'binance-global':'1500'}}));
  await check(LIMITS,'CAPITAL_DRIFT');
  assert.equal(await funding(),funding0,'no funding row was added by any refusal');
  await set(policy());
  assert.equal((await apply(f,owner,applyBody(await preview(f,owner,{declared:LIMITS}),LIMITS))).status,200,'a consistent saved policy saves again');
});

test('PUT /api/risk is unchanged: no hashes, no confirmation, no stale check, same audit row, same validation',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const put=body=>f.request('/api/risk','PUT',body,owner);
  const first=await put({maxRiskPercent:3,maxOrderNotional:'9999'});
  assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.maxRiskPercent,3);assert.equal(first.body.maxOrderNotional,'9999');
  assert.deepEqual(await saved(f,id),first.body);
  const p=await preview(f,owner,{declared:LIMITS});
  assert.equal((await put({maxRiskPercent:4})).status,200,'a PUT after a preview is not stale-checked');
  assert.equal((await put({maxRiskPercent:101})).status,400,'the validator is the same');
  assert.equal((await put({maxRiskPercent:4,maxOrderNotional:'9999',maxDailyNotional:'99999'})).status,200,'a PUT may raise anything the validator allows, with no declared ceiling');
  const audits=await auditCounts(f.db,id);assert.equal(audits['risk.updated'],3);assert.equal(audits['risk.proposal.applied']??0,0);
  refuse(await apply(f,owner,applyBody(p,LIMITS)),409,'STALE_POLICY_STATE');
  await f.db.query("INSERT INTO bot_sessions(user_id,state,run_id,locked_policy,initial_capital,started_at,stopped_at,updated_at) VALUES($1,'RUNNING','run-1',$2,'{}',1,NULL,1)",[id,JSON.stringify(policy())]);
  const frozen=await put({maxRiskPercent:2});assert.equal(frozen.status,409);assert.match(frozen.body.error,/frozen while bot is running/);
});

const sizingSignal=(overrides={})=>({account_type:'SPOT',trade_id:'pf4-sizing',broker:'binance-global',symbol:'BTCUSDT',event:'BUY',order_type:'MARKET',
  risk_mode:'PERCENT_EQUITY',risk_value:'1',entry:'50000',sl:'49500',timestamp:Date.now(),reduce_only:false,...overrides});

test('sizing preview: the existing Risk readiness calculation before and after with the actual capital; refusals are coded; nothing is written',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy({blockHighVolatility:false}));
  const hashes=await digests(f.db),accounts=await f.store.paperAccounts(id);
  const answer=await preview(f,owner,{declared:{order_notional_ceiling:'400'},intent:{signal:sizingSignal()}});
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const {sizing,proposal}=answer.body;
  assert.equal(sizing.status,'COMPUTED');assert.deepEqual(sizing.capital,{source:'ACTUAL_UNCHANGED',cash:'800',book_equity:'1000'});
  assert.equal(sizing.before.calculation.status,'REJECTED');assert.match(sizing.before.calculation.reason,/available configured Spot balance/);
  assert.equal(sizing.after.calculation.status,'CAPPED','the proposal turns capping on and lowers the order ceiling');
  assert.deepEqual([sizing.after.calculation.order.quantity,sizing.after.calculation.order.notional],['0.008','400']);
  assert.equal(sizing.before.policy_hash,proposal.base_policy_hash);assert.equal(sizing.after.policy_hash,proposal.after_policy_hash);
  assert.deepEqual([sizing.before.policy_source,sizing.after.policy_source],['SAVED_POLICY','HYPOTHETICAL_DRAFT']);
  assert.ok(Array.isArray(sizing.limitations)&&sizing.limitations.includes('HYPOTHETICAL_POLICY_AND_CAPITAL'));
  assert.deepEqual(answer.body.save,{allowed:true,refusal_code:null,confirm:CONFIRM,consequences:[]});
  const tighter=await preview(f,owner,{declared:{loss_per_trade_percent:'0.1'},intent:{signal:sizingSignal({timestamp:Date.now()})}});
  assert.equal(tighter.body.sizing.after.calculation.status,'REJECTED');assert.match(tighter.body.sizing.after.calculation.reason,/Risk percent exceeds policy/,'the tighter ceiling rejects the 1% signal');
  // A proposal without changes sizes the same on both sides.
  const same=await preview(f,owner,{intent:{signal:sizingSignal()}});
  assert.equal(same.body.sizing.status,'COMPUTED');assert.deepEqual(same.body.sizing.before.calculation,same.body.sizing.after.calculation);
  assert.equal(same.body.sizing.after.policy_hash,same.body.sizing.before.policy_hash);
  assert.deepEqual(await digests(f.db),hashes,'a sizing preview writes nothing');assert.deepEqual(await f.store.paperAccounts(id),accounts);
  // Unsupported or refused intents.
  refuse(await preview(f,owner,{intent:{signal:sizingSignal({broker:'binance-th'})}}),400,'PF4_INTENT_UNSUPPORTED');
  refuse(await preview(f,owner,{intent:{signal:{...sizingSignal(),broker:'Binance TH'}}}),400,'PF4_INTENT_UNSUPPORTED');
  const unknown=await preview(f,owner,{intent:{bridge:{deployment_id:'no-such-deployment',bar_time:1700000000000,event_type:'BUY'}}});
  assert.equal(unknown.status,200);assert.equal(unknown.body.sizing.status,'REFUSED');assert.equal(unknown.body.sizing.code,'NOT_FOUND');
  assert.deepEqual([unknown.body.sizing.before,unknown.body.sizing.after],[null,null]);
  const bad=await preview(f,owner,{intent:{signal:{...sizingSignal(),unknown_field:1}}});
  assert.equal(bad.body.sizing.status,'REFUSED');assert.equal(bad.body.sizing.code,'SIZING_PREVIEW_REFUSED');assert.match(bad.body.sizing.detail,/Unsupported readiness signal field: unknown_field/);
  // A locked session policy is not the saved policy: the two sizes would describe a policy nobody saves, so they are refused.
  await f.db.query("INSERT INTO bot_sessions(user_id,state,run_id,locked_policy,initial_capital,started_at,stopped_at,updated_at) VALUES($1,'RUNNING','run-1',$2,'{}',1,NULL,1)",
    [id,JSON.stringify(policy({blockHighVolatility:false,sideMode:'BUY_ONLY'}))]);
  const locked=await preview(f,owner,{declared:{order_notional_ceiling:'400'},intent:{signal:sizingSignal()}});
  assert.equal(locked.body.sizing.status,'REFUSED');assert.equal(locked.body.sizing.code,'PF4_SIZING_POLICY_SOURCE');
  assert.deepEqual([locked.body.save.allowed,locked.body.save.refusal_code],[false,'RISK_POLICY_FROZEN']);
});

test('two parallel applies of one proposal: exactly one saves and the other is a 409',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const p=await preview(f,owner,{declared:LIMITS}),body=applyBody(p,LIMITS);
  const answers=await Promise.all([apply(f,owner,body),apply(f,owner,body)]);
  assert.deepEqual(answers.map(answer=>answer.status).sort(),[200,409],JSON.stringify(answers.map(answer=>answer.body)));
  const loser=answers.find(answer=>answer.status===409);assert.ok(['STALE_POLICY_STATE','RETRY_TRANSACTION'].includes(loser.body.code),loser.body.code);
  assert.equal(await savedHash(f,id),p.body.proposal.after_policy_hash);
  assert.equal((await auditCounts(f.db,id))['risk.proposal.applied'],1);
});

/** One PF-2 world: the actual app with the test policy loader, a bot of the owner, a READY deployment and its enrollment. */
async function stagedWorld(t){
  const base=await createPf2Base(t),scenario=base.defaultScenario;
  const f=await fixture(t,{mode:'test-policy',capacityPolicy:scenario.enrollment.capacity_policy,syntheticSourceHash:scenario.supportedSourceHash});
  await cp(base.root,f.root,{recursive:true});
  const bot=f.sibling.id;
  const world=await createWorld({...f,base},{accounts:{owner:f.owner.id,bot,bots:[bot]},risk:{blockDuringNews:false,capPercentEquitySize:false}});
  await insertBridgeEvidence(f.db,world.deploymentId);
  const owner=await f.login(f.owner),pine=new PineBridgeService(f.store,{defaultRisk:config.defaultRisk});
  /** Enqueue one PF-2 job over HTTP, resolve its envelope like the worker would, and store `spec` as its terminal result. */
  async function succeed(spec){
    const queued=await f.request('/api/quant/data/preflights','POST',world.request,owner,{'Idempotency-Key':'pf4-'+randomUUID()});
    assert.equal(queued.status,202,JSON.stringify(queued.body));
    const bound=(await f.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[queued.body.job_id])).rows[0];
    const sources=trustedSources({db:f.db,pine,job_id:bound.job_id,owner_id:world.owner,bot_id:world.bot,capacityPolicy:f.policy,
      stores:{raw:new DatasetStore({root:f.root}),research:new ResearchDatasetStore({root:f.root})}});
    const resolved=await resolveHistoricalPreflight(JSON.parse(bound.plan_json),sources,{now:world.now,supportedSourceHash:world.supportedSourceHash});
    const envelope=withResult(fixtureEnvelope({resolved,planHash:bound.plan_hash}),spec,{deploymentId:world.deploymentId});
    await f.db.query('UPDATE quant_foundation_jobs SET status=$2,result=$3 WHERE job_id=$1',[bound.job_id,'SUCCEEDED',JSON.stringify(envelope)]);
    return {jobId:bound.job_id,planHash:bound.plan_hash};
  }
  return {f,world,bot,owner,succeed,query:'?bot_id='+bot};
}
// A healthy window whose two BUY rejections are the order notional limit that capping would turn into smaller fills.
const CAPPABLE={...HEALTHY,intents:{buy:14,exit_sl:6,exit_tp:4},rejected_by_reason:{'Maximum trades per day reached':2,'Maximum order notional exceeded':2}};

test('PF-2 evidence and the READY deployment: provenance, consequences, a save makes both stale, a newer job makes the proposal stale',async t=>{
  const {f,world,bot,owner,succeed,query}=await stagedWorld(t);
  const first=await succeed(CAPPABLE);
  const stored=(await f.db.query('SELECT evidence_hash FROM pine_bridge_evidence WHERE deployment_id=$1',[world.deploymentId])).rows[0].evidence_hash;
  const hashes=await digests(f.db),declared={loss_per_trade_percent:'2',daily_notional_ceiling:'60000'};
  const p=await preview(f,owner,{declared},query);
  assert.equal(p.status,200,JSON.stringify(p.body));
  assert.equal(p.body.report_verdict,'READY_TO_START_PAPER');assert.deepEqual(await digests(f.db),hashes,'the preview with PF-2 evidence writes nothing');
  const proposal=p.body.proposal;
  assert.deepEqual(proposal.evidence,{job_id:first.jobId,plan_hash:first.planHash,policy_current:true,capital_current:true,cappable_buy_rejections:2,
    reasons:[{code:'ORDER_NOTIONAL_LIMIT',count:2}]});
  assert.deepEqual(proposal.bridge_risk,{deployment_id:world.deploymentId,evidence_hash:stored,risk_percent:1});
  assert.deepEqual(proposal.changes.map(item=>item.field),['maxRiskPercent','maxDailyNotional','capPercentEquitySize']);
  const risk=proposal.changes[0],cap=proposal.changes[2];
  assert.deepEqual([risk.before,risk.after,risk.direction],['100','2','LOWER']);
  assert.deepEqual(risk.provenance.map(entry=>entry.source),['SAVED_POLICY','OWNER_DECLARED','DEPLOYMENT_EVIDENCE']);
  assert.deepEqual(cap.provenance.map(entry=>entry.source),['SAVED_POLICY','PF2_EVIDENCE','OWNER_DECLARED'],'both the evidence and the lowered daily ceiling call for capping');
  assert.deepEqual(cap.provenance[1],{source:'PF2_EVIDENCE',job_id:first.jobId,plan_hash:first.planHash,reasons:[{code:'ORDER_NOTIONAL_LIMIT',count:2}]});
  assert.match(cap.explanation,/^2 historical BUY intents were rejected because the risk-sized order exceeded ORDER_NOTIONAL_LIMIT 2\./);
  assert.deepEqual(p.body.save.consequences,[{code:'DEPLOYMENT_SNAPSHOT_STALE',deployment_id:world.deploymentId},{code:'PF2_EVIDENCE_STALE',job_id:first.jobId}]);
  const stales=proposal.advisories.find(item=>item.code==='SAVE_STALES_DEPLOYMENT');
  assert.ok(stales.explanation.includes('Deployment '+world.deploymentId+' then refuses BUY events (STALE_POLICY)'));
  // The Bridge risk is 1%: a declared loss below it would reject every Bridge BUY, so the risk ceiling is left alone.
  const below=await preview(f,owner,{declared:{loss_per_trade_percent:'0.5'}},query);
  assert.ok(!below.body.proposal.changes.some(item=>item.field==='maxRiskPercent'));
  assert.ok(below.body.proposal.advisories.some(item=>item.code==='DECLARED_LOSS_BELOW_BRIDGE_RISK'));
  // A newer successful job changes the evidence the proposal rests on: the old proposal is stale and nothing is saved.
  const second=await succeed(CAPPABLE);
  refuse(await apply(f,owner,applyBody(p,declared),query),409,'PROPOSAL_STALE');
  assert.equal((await auditCounts(f.db,bot))['risk.proposal.applied']??0,0);
  const fresh=await preview(f,owner,{declared},query);
  assert.equal(fresh.body.proposal.evidence.job_id,second.jobId);assert.notEqual(fresh.body.proposal.proposal_hash,proposal.proposal_hash);
  const funding=[await count(f.db,'paper_funding',bot),await count(f.db,'paper_snapshots',bot)];
  const done=await apply(f,owner,applyBody(fresh,declared),query);
  assert.equal(done.status,200,JSON.stringify(done.body));
  assert.deepEqual(done.body.consequences,[{code:'DEPLOYMENT_SNAPSHOT_STALE',deployment_id:world.deploymentId},{code:'PF2_EVIDENCE_STALE',job_id:second.jobId}]);
  assert.deepEqual([await count(f.db,'paper_funding',bot),await count(f.db,'paper_snapshots',bot)],funding,'zero funding delta with a READY deployment');
  const audit=(await f.db.query("SELECT details FROM audit WHERE user_id=$1 AND event='risk.proposal.applied'",[bot])).rows[0].details;
  assert.equal((typeof audit==='string'?JSON.parse(audit):audit).evidence_job_id,second.jobId);
  // The consequences are real: the PF-3 report now names both as stale, and the policy is the proposed one.
  const report=(await f.request('/api/risk/readiness-report'+query,'GET',undefined,owner)).body;
  assert.ok(report.blockers.some(item=>item.code==='DEPLOYMENT_SNAPSHOT_STALE'&&item.detail==='STALE_POLICY'));
  assert.ok(report.blockers.some(item=>item.code==='HISTORICAL_POLICY_STALE'));
  const after=await saved(f,bot);assert.deepEqual([after.maxRiskPercent,after.maxDailyNotional,after.capPercentEquitySize],[2,'60000',true]);
});

test('service invariants: a funding change during the save rolls the whole save back; the preview is one read-only transaction of SELECT statements',async t=>{
  const f=await fixture(t,{mode:'disabled'}),id=f.owner.id;
  await f.store.setRisk(id,policy({blockHighVolatility:false}));
  const readiness=new ReadinessService({store:f.store,defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true});
  const meddling=new Proxy(f.store,{get(target,prop,receiver){
    if(prop==='setRisk')return async(userId,next)=>{
      await target.setRisk(userId,next);
      await target.db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,'1','1','CONFIGURATION')",[userId,Date.now()]);
    };
    const value=Reflect.get(target,prop,receiver);return typeof value==='function'?value.bind(target):value;}});
  const service=new ProposalService({store:meddling,defaultRisk:config.defaultRisk,readinessService:readiness,pineBridgeEnabled:true});
  const shown=await service.preview(id,id,{declared:LIMITS}),proposal=shown.proposal;
  const before=await digests(f.db);
  await assert.rejects(()=>service.apply(id,id,{base_policy_hash:proposal.base_policy_hash,proposal_hash:proposal.proposal_hash,declared:LIMITS,confirm:CONFIRM}),
    error=>error.code==='PF4_FUNDING_INVARIANT'&&error.status===500);
  assert.deepEqual(await digests(f.db),before,'the saved policy, the funding rows and the audit rows are exactly as before');
  assert.equal(await savedHash(f,id),proposal.base_policy_hash);
  // Constructor and argument checks.
  assert.throws(()=>new ProposalService({}),error=>error.code==='PF4_CONFIGURATION_INVALID'&&error.status===500);
  assert.throws(()=>new ProposalService({store:f.store,defaultRisk:config.defaultRisk,readinessService:{}}),error=>error.code==='PF4_CONFIGURATION_INVALID');
  const plain=new ProposalService({store:f.store,defaultRisk:config.defaultRisk,readinessService:readiness,pineBridgeEnabled:false});
  await assert.rejects(()=>plain.preview(id,f.foreign.id,{}),error=>error.code==='BOT_ACCESS_DENIED'&&error.status===403);
  await assert.rejects(()=>plain.apply(id,f.foreign.id,{base_policy_hash:'a'.repeat(64),proposal_hash:'b'.repeat(64),declared:{},confirm:CONFIRM}),error=>error.code==='BOT_ACCESS_DENIED');
  await assert.rejects(()=>plain.preview(7,'x',{}),error=>error.code==='INVALID_FIELDS');
  await assert.rejects(()=>plain.preview(id,id,{intent:{bridge:{}}}),error=>error.code==='PF4_INTENT_UNSUPPORTED','Bridge intents need the Bridge');
  // Inside one transaction the preview is followed by a write: the transaction is read-only after the preview.
  let written=null;
  await f.db.transaction(async()=>{
    await plain.preview(id,id,{declared:LIMITS});
    written=await f.db.query("INSERT INTO system_settings(key,value) VALUES('pf4-probe','1')").catch(error=>error);
  },{isolation:'SERIALIZABLE'});
  assert.equal(written.code,'25006',String(written.message));assert.equal((await f.db.query("SELECT count(*)::int n FROM system_settings WHERE key='pf4-probe'")).rows[0].n,0);
  // Every statement of a preview, with a sizing intent, is the READ ONLY switch and then SELECT statements without locks.
  const statements=[];
  const recorded=new Proxy(f.db,{get(target,prop,receiver){
    if(prop==='query')return (sql,params)=>{statements.push(String(sql));return target.query(sql,params);};
    const value=Reflect.get(target,prop,receiver);return typeof value==='function'?value.bind(receiver):value;}});
  const store=new Store(recorded);
  const observed=new ProposalService({store,defaultRisk:config.defaultRisk,pineBridgeEnabled:true,
    readinessService:new ReadinessService({store,defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true})});
  const answer=await observed.preview(id,id,{declared:LIMITS,intent:{signal:sizingSignal()}});
  assert.equal(answer.sizing.status,'COMPUTED');assert.ok(statements.length>20,'a preview reads many rows: '+statements.length);
  assert.match(statements[0],/^\s*SET TRANSACTION READ ONLY\s*$/);
  for(const sql of statements.slice(1)){
    assert.match(sql,/^\s*(SELECT|WITH)\b/i,sql.slice(0,80));
    assert.doesNotMatch(sql,/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i,'a row lock: '+sql.slice(0,80));
    assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|MERGE|LOCK|TRUNCATE|CREATE|ALTER|DROP|NEXTVAL|PG_ADVISORY\w*)\b/i,'a write or lock: '+sql.slice(0,80));
  }
});

test('apply error mapping: an unreadable saved decimal is a fixed 400 code, any other failure a fixed 503, database and fixed errors pass through, nothing leaks',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const set=value=>f.db.query('UPDATE risk_profiles SET policy=$2 WHERE user_id=$1',[id,JSON.stringify(value)]);
  await set(policy({equities:{'binance-global':'oops'}}));
  const corrupt={base_policy_hash:await savedHash(f,id),proposal_hash:'a'.repeat(64),declared:LIMITS,confirm:CONFIRM},before=await digests(f.db);
  const refused=await apply(f,owner,corrupt);
  assert.equal(refused.status,400,JSON.stringify(refused.body));
  assert.deepEqual(refused.body,{error:'PF4_SAVED_POLICY_INVALID',code:'PF4_SAVED_POLICY_INVALID'},'a fixed code and no text of the validator');
  assert.ok(!JSON.stringify(refused.body).includes('Invalid decimal'));
  const shown=await preview(f,owner,{declared:LIMITS});
  assert.deepEqual([shown.status,shown.body.code],[503,'PF4_PREVIEW_UNAVAILABLE'],'the preview maps the same failure its own way');
  assert.deepEqual(await digests(f.db),before,'neither call writes');
  // Service level: what the mapping does with each kind of error thrown inside the save.
  await set(policy());
  const readiness=new ReadinessService({store:f.store,defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true});
  const failing=error=>new ProposalService({defaultRisk:config.defaultRisk,readinessService:readiness,pineBridgeEnabled:true,
    store:new Proxy(f.store,{get(target,prop,receiver){
      if(prop==='paperAccounts')return async()=>{throw error;};
      const value=Reflect.get(target,prop,receiver);return typeof value==='function'?value.bind(target):value;}})});
  const good={base_policy_hash:await savedHash(f,id),proposal_hash:'a'.repeat(64),declared:LIMITS,confirm:CONFIRM};
  for(const [error,status,code] of [[new Error('Invalid decimal'),400,'PF4_SAVED_POLICY_INVALID'],[new Error('Decimal outside supported range'),400,'PF4_SAVED_POLICY_INVALID'],
    [new TypeError('x is not a function'),503,'PF4_APPLY_UNAVAILABLE'],[new RangeError('too big'),503,'PF4_APPLY_UNAVAILABLE'],
    [Object.assign(new Error('socket hang up'),{code:'ECONNRESET'}),503,'PF4_APPLY_UNAVAILABLE'],[Object.assign(new Error('teapot'),{status:418}),503,'PF4_APPLY_UNAVAILABLE'],
    ['a thrown string',503,'PF4_APPLY_UNAVAILABLE']])
    await assert.rejects(()=>failing(error).apply(id,id,good),thrown=>thrown.status===status&&thrown.code===code&&thrown.message===code,String(error));
  const database=Object.assign(new Error('could not serialize access due to read/write dependencies'),{code:'40001'});
  await assert.rejects(()=>failing(database).apply(id,id,good),thrown=>thrown===database,'a database error passes through for the server to map');
  const fixed=Object.assign(new Error('CAPITAL_DRIFT'),{code:'CAPITAL_DRIFT',status:409});
  await assert.rejects(()=>failing(fixed).apply(id,id,good),thrown=>thrown===fixed,'a fixed code of ours passes through');
  assert.equal(await savedHash(f,id),good.base_policy_hash);assert.equal((await auditCounts(f.db,id))['risk.proposal.applied']??0,0);
});
