import test from 'node:test';
import assert from 'node:assert/strict';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';

/**
 * F04-05 PF-4 clause C6b (PM-1 reconciliation): an Apply (POST /api/risk/proposals/apply) racing a concurrent Run
 * (POST /api/bot/session/run) never leaves the session RUNNING on the old policy while the new PF-4 policy is saved.
 * Either Apply wins and Run then freezes the new policy, or Run wins and Apply is refused with 409 RISK_POLICY_FROZEN
 * and saves nothing; never both. Real application, real HTTP, SERIALIZABLE request pipeline. Isolated local PostgreSQL only.
 *
 * Deterministic overlap, no sleep orders anything: the test holds the users row lock of the Bot. Run (policy read, then
 * transitionBotState) and Apply (policy and session read, then setRisk) both read on a snapshot that shows the old policy
 * and no session, then wait for that lock. The test starts the two requests one at a time and waits (bounded poll of
 * pg_stat_activity) until each is waiting, so the lock queue order is the order the test chose. Only then is the lock released.
 * Expected values are literal from the contract (Roadmap PF-4 rows, commit 68a6268 message), not read back from the code.
 */
const APPLY='/api/risk/proposals/apply',PREVIEW='/api/risk/proposals/preview',RUN='/api/bot/session/run',CONFIRM='SAVE_RISK_PROPOSAL';
const LIMITS={loss_per_trade_percent:'1',order_notional_ceiling:'500',daily_notional_ceiling:'30000',allow_repeated_entries:false};
const policy=(overrides={})=>({...structuredClone(config.defaultRisk),blockDuringNews:false,capPercentEquitySize:false,maxRiskPercent:5,
  maxOrderNotional:'2000',maxDailyNotional:'20000',equities:{'binance-global':'1000'},balances:{'binance-global':'800'},...overrides});
async function fixture(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled'});t.after(()=>f.close());return f;
}
const rows=async(f,sql,params)=>(await f.db.query(sql,params)).rows;
const savedPolicy=(f,id)=>f.store.risk(id,config.defaultRisk);
const policyHash=value=>hash(canonical(value));
const sessionRow=async(f,id)=>(await rows(f,'SELECT state,run_id,locked_policy FROM bot_sessions WHERE user_id=$1',[id]))[0]??null;
const auditCount=async(f,id,event)=>(await rows(f,'SELECT count(*)::int n FROM audit WHERE user_id=$1 AND event=$2',[id,event]))[0].n;
const fundingCount=async(f,id)=>(await rows(f,'SELECT count(*)::int n FROM paper_funding WHERE user_id=$1',[id]))[0].n;

/** Holds the users row lock of the Bot in a transaction of its own until release() is called. */
async function holdUsersRow(f,userId){
  let release,held;
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>held=resolve);
  const done=f.db.transaction(async()=>{await f.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(userId);held();await gate;});
  await Promise.race([entered,done]);
  return {release,done};
}
/** Bounded poll (400 x 25 ms) until exactly n backends of this database wait for a row lock. */
async function waitForLockWaiters(f,n,label){
  let waiting=0;
  for(let i=0;i<400&&waiting<n;i++){
    waiting=(await rows(f,`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='active'
      AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'`))[0].n;
    if(waiting<n)await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(waiting,n,label);
}
/**
 * The safety invariant of C6b, judged on the stored rows: when the session is RUNNING, the policy it locked is the saved
 * policy. A RUNNING session on one policy with another saved is exactly the forbidden outcome.
 */
async function assertNotRunningOnOldPolicy(f,id){
  const session=await sessionRow(f,id),saved=await savedPolicy(f,id);
  if(session?.state==='RUNNING')
    assert.equal(canonical(JSON.parse(session.locked_policy)),canonical(saved),'RUNNING session locked the policy that is saved now');
}

/** One race: the same owner, a fresh preview, SETUP session; `order` is the order of the two requests in the lock queue. */
async function race(t,order){
  const f=await fixture(t),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const preview=await f.request(PREVIEW,'POST',{declared:LIMITS},owner);
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  const proposal=preview.body.proposal;
  assert.deepEqual([preview.body.save.allowed,preview.body.save.refusal_code],[true,null],'SETUP session: a save is allowed before the race');
  assert.notEqual(proposal.after_policy_hash,proposal.base_policy_hash);
  const oldPolicy=await savedPolicy(f,id),oldHash=policyHash(oldPolicy);
  assert.equal(oldHash,proposal.base_policy_hash);
  assert.equal(await sessionRow(f,id),null,'SETUP: no session row yet');
  const funding0=await fundingCount(f,id);
  const body={base_policy_hash:proposal.base_policy_hash,proposal_hash:proposal.proposal_hash,declared:LIMITS,confirm:CONFIRM};
  const start={apply:()=>f.request(APPLY,'POST',body,owner),run:()=>f.request(RUN,'POST',{},owner)};
  const lock=await holdUsersRow(f,id),sent={};
  try{
    for(const [index,name] of order.entries()){
      sent[name]=start[name]();
      await waitForLockWaiters(f,index+1,name+' waits for the Bot row lock (position '+(index+1)+' in the queue)');
    }
  }finally{lock.release();}
  await lock.done;
  const [applied,ran]=await Promise.all([sent.apply,sent.run]);
  return {f,id,proposal,oldPolicy,oldHash,funding0,applied,ran};
}

test('C6b: Run first, Apply second in the lock queue: Run wins, Apply is 409 RISK_POLICY_FROZEN and saves nothing',async t=>{
  const {f,id,proposal,oldPolicy,oldHash,funding0,applied,ran}=await race(t,['run','apply']);
  assert.equal(ran.status,200,JSON.stringify(ran.body));
  assert.equal(ran.body.state,'RUNNING');assert.match(ran.body.run_id,/^[0-9a-f-]{36}$/);
  assert.equal(applied.status,409,JSON.stringify(applied.body));
  assert.equal(applied.body.code,'RISK_POLICY_FROZEN','the running-state code, not a generic retry');
  const session=await sessionRow(f,id);
  assert.equal(session.state,'RUNNING');assert.equal(session.run_id,ran.body.run_id);
  assert.equal(canonical(JSON.parse(session.locked_policy)),canonical(oldPolicy),'Run froze the policy that was saved when it won');
  assert.equal(policyHash(await savedPolicy(f,id)),oldHash,'the refused Apply saved nothing: the saved policy is still the old one');
  assert.notEqual(policyHash(await savedPolicy(f,id)),proposal.after_policy_hash);
  assert.equal(await auditCount(f,id,'risk.proposal.applied'),0,'no proposal audit row for a refused Apply');
  assert.equal(await auditCount(f,id,'risk.updated'),0,'no risk.updated audit row for a refused Apply');
  assert.equal(await auditCount(f,id,'bot.lifecycle.run'),1,'one run audit row');
  assert.equal(await fundingCount(f,id),funding0,'no funding row written by the refused Apply');
  await assertNotRunningOnOldPolicy(f,id);
});

test('C6b: Apply first, Run second in the lock queue: Apply wins, Run then freezes the NEW policy',async t=>{
  const {f,id,proposal,oldPolicy,oldHash,funding0,applied,ran}=await race(t,['apply','run']);
  assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(applied.body.saved,true);assert.equal(applied.body.policy_hash_before,oldHash);
  assert.equal(applied.body.policy_hash_after,proposal.after_policy_hash);
  assert.equal(ran.status,200,JSON.stringify(ran.body));
  assert.equal(ran.body.state,'RUNNING');
  const saved=await savedPolicy(f,id),session=await sessionRow(f,id);
  assert.equal(policyHash(saved),proposal.after_policy_hash,'the new PF-4 policy is saved');
  assert.notEqual(policyHash(saved),oldHash);
  assert.equal(session.state,'RUNNING');assert.equal(session.run_id,ran.body.run_id);
  assert.equal(canonical(JSON.parse(session.locked_policy)),canonical(saved),'Run (rerun on a fresh snapshot) froze the new policy, not the old one');
  assert.notEqual(canonical(JSON.parse(session.locked_policy)),canonical(oldPolicy),'the locked policy is not the pre-Apply policy');
  assert.deepEqual(JSON.parse(session.locked_policy).defaults.orderNotional,'500');
  assert.equal(JSON.parse(session.locked_policy).maxOrderNotional,'500');
  assert.equal(await auditCount(f,id,'risk.proposal.applied'),1);
  assert.equal(await auditCount(f,id,'risk.updated'),1);
  assert.equal(await auditCount(f,id,'bot.lifecycle.run'),1);
  assert.equal(await fundingCount(f,id),funding0,'zero funding change by the Apply');
  await assertNotRunningOnOldPolicy(f,id);
});

test('C6b: both requests wait together, release in any order: exactly one of the two permitted outcomes, never RUNNING on the old policy with the new one saved',async t=>{
  const f=await fixture(t),owner=await f.login(f.owner),id=f.owner.id;
  await f.store.setRisk(id,policy());
  const preview=await f.request(PREVIEW,'POST',{declared:LIMITS},owner),proposal=preview.body.proposal;
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  const oldHash=policyHash(await savedPolicy(f,id));
  const body={base_policy_hash:proposal.base_policy_hash,proposal_hash:proposal.proposal_hash,declared:LIMITS,confirm:CONFIRM};
  const lock=await holdUsersRow(f,id);let sent;
  try{
    sent=[f.request(APPLY,'POST',body,owner),f.request(RUN,'POST',{},owner)];
    await waitForLockWaiters(f,2,'Apply and Run both wait for the Bot row lock');
  }finally{lock.release();}
  await lock.done;
  const [applied,ran]=await Promise.all(sent);
  const session=await sessionRow(f,id),saved=await savedPolicy(f,id);
  t.diagnostic('apply '+applied.status+':'+(applied.body.code??'saved')+' | run '+ran.status+':'+(ran.body.state??ran.body.error)+' | saved '+(policyHash(saved)===oldHash?'old':'new'));
  assert.equal(ran.status,200,JSON.stringify(ran.body));assert.equal(session.state,'RUNNING');
  const locked=canonical(JSON.parse(session.locked_policy));
  if(applied.status===200){
    assert.equal(policyHash(saved),proposal.after_policy_hash,'Apply won: the new policy is saved');
    assert.equal(locked,canonical(saved),'Apply won: Run froze the new policy');
    assert.equal(await auditCount(f,id,'risk.proposal.applied'),1);
  }else{
    assert.equal(applied.status,409,JSON.stringify(applied.body));assert.equal(applied.body.code,'RISK_POLICY_FROZEN','Run won: Apply is refused with the running-state code');
    assert.equal(policyHash(saved),oldHash,'Run won: nothing was saved');assert.equal(locked,canonical(saved),'Run won: it froze the old, still saved policy');
    assert.equal(await auditCount(f,id,'risk.proposal.applied'),0);
  }
  await assertNotRunningOnOldPolicy(f,id);
});
