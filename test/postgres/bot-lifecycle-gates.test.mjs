import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ownerIsolationFixture} from '../helpers/owner-isolation-http-fixture.mjs';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {D} from '../../src/money.js';
import {config} from '../../src/config.js';

/**
 * F01-02 Bot creation and lifecycle gates on the real PostgreSQL server path (src/postgres/server.js behind
 * request-dispatch.js), real HTTP, plus the real ExecutionWorker on the same database. Acceptance (inventory F01-02): an
 * authenticated owner creates a Bot and uses its supported lifecycle without bypassing capacity or readiness gates.
 * Clauses (Context.md APP-3 and APP-4, docs/PINE_BRIDGE_ADAPTER_API.md activate):
 *   C2  POST /api/bots answers 201: a child BOT row in the first free slot, Paper defaults, webhook secret set, audit bot.created;
 *   C3  plan capacity: the owner counts as one Bot; FREE (no license) allows 1, PERSONAL allows 3; at capacity 403 and no insert;
 *   C5  concurrent creates at the plan limit never exceed the plan (SERIALIZABLE request, retry re-runs the quota check);
 *   C7b PUT /api/risk answers 409 while the Bot is RUNNING or PAUSED (policy frozen) and works again when STOPPED;
 *   C9b a transition outside SETUP->RUNNING->PAUSED->RUNNING->STOPPED->SETUP answers 400, with no state change and no audit row;
 *   C10 run needs funded Paper capital: otherwise 409 and no transition;
 *   C12 worker: STOPPED rejects every signal, PAUSED rejects BUY and a SELL that is not reduce-only;
 *   C13b Paper activation for a STOPPED Bot answers 409 BOT_STOPPED.
 * Every refusal is judged by the exact literal status and body (copied from the contract, not read from the code) and by a
 * before/after snapshot of the rows the route could write. Each refusal has a control on the same fixture that shows the
 * route is real. Synthetic fixtures only; nothing here says anything about strategy performance.
 */
let f;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  f=await ownerIsolationFixture(process.env.TEST_DATABASE_URL);
});
after(async()=>{await f?.close();});

const BROKER='binance-global';
const DAY=86400000;
/** Redeems a license of the plan for the owner; without one the plan is FREE. */
async function license(owner,plan) {
  const key='lifecycle-'+randomUUID();
  await f.store.createLicense({key,plan,expiresAt:Date.now()+30*DAY});
  assert.equal(await f.store.redeemLicense(owner.id,key),true);
}
const run=(bot,session,action,botId)=>f.request('/api/bot/session/'+action+(botId?'?bot_id='+botId:''),'POST',{},session);
const rows=async(sql,params)=>(await f.db.query(sql,params)).rows;
const sessionRow=async id=>(await rows('SELECT user_id,state,run_id,locked_policy,initial_capital,started_at,stopped_at,updated_at FROM bot_sessions WHERE user_id=$1',[id]))[0]??null;
const archiveCount=async id=>(await rows('SELECT count(*)::int n FROM bot_session_archive WHERE user_id=$1',[id]))[0].n;
const riskRow=async id=>(await rows('SELECT policy,updated_at FROM risk_profiles WHERE user_id=$1',[id]))[0]??null;
/** Counts of every event a route of this file can write; request.error rows come from the dispatcher and are not a route effect. */
const auditCounts=async()=>rows("SELECT event,count(*)::int n FROM audit WHERE event LIKE 'bot.%' OR event LIKE 'pine_bridge.%' OR event LIKE 'risk.%' GROUP BY event ORDER BY event");
const children=async owner=>rows('SELECT id,bot_slot_index,label FROM users WHERE parent_user_id=$1 ORDER BY bot_slot_index',[owner]);
const botCount=async()=>(await rows("SELECT count(*)::int n FROM users WHERE role='BOT'"))[0].n;
/** Everything one owner-scoped lifecycle or risk route could write for this Bot. */
async function state(bot) {
  return {session:await sessionRow(bot),archive:await archiveCount(bot),risk:await riskRow(bot),audit:await auditCounts(),bots:await botCount()};
}
/** The request must answer exactly `expected` and change nothing in the snapshot above. */
async function refused(label,bot,expected,call) {
  const before=await state(bot),answer=await call();
  assert.equal(answer.status,expected.status,label+' '+JSON.stringify(answer.body));
  assert.deepEqual(answer.body,expected.body,label);
  assert.deepEqual(await state(bot),before,label+': no state change, no audit row, no risk change');
  return answer;
}
const auditOf=async(event,user)=>rows('SELECT user_id,event,trade_id,details FROM audit WHERE event=$1 AND user_id=$2 ORDER BY id',[event,user]);

// ---- C3: FREE plan, no license ---------------------------------------------------------------------------------------------------
test('C3: an owner without license is on the FREE plan: the owner is the one Bot, POST /api/bots answers 403 and inserts nothing',async()=>{
  const owner=await f.newOwner('free'),V=await owner.login();
  const listed=await f.request('/api/bots','GET',undefined,V);
  assert.equal(listed.status,200,JSON.stringify(listed.body));
  assert.equal(listed.body.maxBots,1,'FREE allows 1 Bot');
  assert.deepEqual(listed.body.bots.map(bot=>bot.id),[owner.id],'the main account counts as the one Bot');
  const answer=await refused('POST /api/bots on FREE',owner.id,
    {status:403,body:{error:'Bot limit reached. Your FREE plan allows up to 1 bots.'}},
    ()=>f.request('/api/bots','POST',{label:'Over the FREE limit'},V));
  assert.equal(answer.status,403);
  assert.deepEqual(await children(owner.id),[],'no child Bot row inserted');
  assert.deepEqual(await auditOf('bot.created',owner.id),[],'no bot.created audit row');
});

// ---- C2 and C3: PERSONAL plan ------------------------------------------------------------------------------------------------
test('C2/C3: POST /api/bots answers 201 with the documented child BOT; the third Bot of PERSONAL (3) answers 403 and inserts nothing',async()=>{
  const owner=await f.newOwner('personal'),V=await owner.login();
  await license(owner,'PERSONAL');
  const listed=await f.request('/api/bots','GET',undefined,V);
  assert.equal(listed.body.maxBots,3,'PERSONAL allows 3 Bots');
  const auditBefore=await auditCounts();
  const made=await f.request('/api/bots','POST',{label:'  First Bot  '},V);
  assert.equal(made.status,201,JSON.stringify(made.body));
  const bot=made.body;
  assert.deepEqual(Object.keys(bot).sort(),['bot_slot_index','created_at','email','id','label','parent_user_id','role','status','webhook_hint']);
  assert.equal(bot.role,'BOT');assert.equal(bot.status,'ACTIVE');
  assert.equal(bot.parent_user_id,owner.id);
  assert.equal(bot.bot_slot_index,2,'first free slot after the main account');
  assert.equal(bot.label,'First Bot','the label is trimmed');
  assert.equal(bot.email,bot.id+'@bot.invalid');
  assert.match(String(bot.webhook_hint),/^.{6}$/,'the webhook hint is the last 6 characters of the secret');
  assert.ok(Number(bot.created_at)>0);
  assert.ok(!JSON.stringify(made.body).includes('NO_LOGIN'),'no password hash in the answer');
  // Stored row: no login, webhook secret set (hash and encrypted copy), Paper defaults, audit.
  const stored=(await rows('SELECT password_hash,webhook_secret_hash,webhook_secret_encrypted,webhook_hint,role,parent_user_id,bot_slot_index FROM users WHERE id=$1',[bot.id]))[0];
  assert.equal(stored.password_hash,'NO_LOGIN');
  assert.ok(stored.webhook_secret_hash&&stored.webhook_secret_hash.length>0,'webhook secret hash set');
  assert.ok(stored.webhook_secret_encrypted,'encrypted webhook secret stored');
  assert.equal(stored.webhook_hint,bot.webhook_hint);
  const risk=JSON.parse((await riskRow(bot.id)).policy);
  assert.equal(risk.paperTrading,true,'Paper trading is on for a new Bot');
  assert.deepEqual(risk,JSON.parse(JSON.stringify({...config.defaultRisk,paperTrading:true})),'default policy plus paperTrading');
  assert.equal((await sessionRow(bot.id)),null,'no session row yet: the Bot is in SETUP');
  assert.equal((await f.request('/api/bot/session?bot_id='+bot.id,'GET',undefined,V)).body.state,'SETUP');
  const audit=await auditOf('bot.created',owner.id);
  assert.equal(audit.length,1);assert.deepEqual(JSON.parse(audit[0].details),{botId:bot.id});
  const created=(await auditCounts()).find(row=>row.event==='bot.created').n-(auditBefore.find(row=>row.event==='bot.created')?.n??0);
  assert.equal(created,1,'exactly one bot.created row');
  // The second Bot takes the next slot; the owner plus two children reach the plan of 3.
  const second=await f.request('/api/bots','POST',{label:'Second Bot'},V);
  assert.equal(second.status,201,JSON.stringify(second.body));assert.equal(second.body.bot_slot_index,3);
  assert.equal((await f.request('/api/bots','GET',undefined,V)).body.bots.length,3);
  // Third Bot: over the plan. Exact refusal, no insert, no audit.
  await refused('POST /api/bots at 3 of 3',owner.id,
    {status:403,body:{error:'Bot limit reached. Your PERSONAL plan allows up to 3 bots.'}},
    ()=>f.request('/api/bots','POST',{label:'Third Bot'},V));
  assert.deepEqual((await children(owner.id)).map(row=>[row.bot_slot_index,row.label]),[[2,'First Bot'],[3,'Second Bot']]);
  assert.equal((await auditOf('bot.created',owner.id)).length,2);
});

// ---- C5: concurrent creates at the plan limit ----------------------------------------------------------------------------------
test('C5: concurrent creates with one slot left under the plan never exceed it',async t=>{
  const owner=await f.newOwner('race'),V=await owner.login();
  await license(owner,'PERSONAL');
  await f.store.createBot(owner.id,'Race first',{...config.defaultRisk,paperTrading:true});
  // Deterministic overlap: the test holds the owner row lock, so all four requests pass the plan check on a snapshot that
  // shows 2 of 3 Bots, then wait together for the lock createBot takes. Only then is the lock released. No sleep orders anything.
  let release,held;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>held=resolve);
  const holder=f.db.transaction(async()=>{await f.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner.id);held();await gate;});
  await entered;
  const sent=[1,2,3,4].map(n=>f.request('/api/bots','POST',{label:'Race '+n},V));
  try{
    let waiting=0;
    for(let i=0;i<400&&waiting<4;i++){
      waiting=(await rows("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"))[0].n;
      if(waiting<4)await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(waiting,4,'all four creates wait for the owner row lock');
  }finally{release();}
  await holder;
  const answers=await Promise.all(sent);
  const outcome=answers.map(answer=>answer.status+':'+(answer.body.code??answer.body.error)).sort();
  t.diagnostic('C5 answers '+outcome.join(' | '));
  const created=answers.filter(answer=>answer.status===201);
  assert.equal(created.length,1,'exactly one create wins the last slot: '+JSON.stringify(outcome));
  for(const answer of answers.filter(answer=>answer.status!==201)){
    const limit=answer.status===403&&answer.body.error==='Bot limit reached. Your PERSONAL plan allows up to 3 bots.';
    const retry=answer.status===409&&answer.body.code==='RETRY_TRANSACTION';
    assert.ok(limit||retry,'a losing create is refused by the plan limit (or reports a retry): '+JSON.stringify(answer.body));
  }
  const bots=await children(owner.id);
  assert.equal(bots.length,2,'owner plus two children is the plan of 3');
  assert.equal((await auditOf('bot.created',owner.id)).length,1,'one bot.created row for the one HTTP create');
});

// ---- C7b, C9b: lifecycle walk --------------------------------------------------------------------------------------------------
test('C7b/C9b: PUT /api/risk is frozen in RUNNING and PAUSED; unsupported transitions answer 400 with no state change and no audit row',async()=>{
  const owner=await f.newOwner('walk'),V=await owner.login(),id=owner.id;
  const current=await f.request('/api/risk','GET',undefined,V);
  assert.equal(current.status,200,JSON.stringify(current.body));
  const change={...current.body,maxTradesPerDay:current.body.maxTradesPerDay+1};
  const bad=(from,action)=>({status:400,body:{error:`Cannot ${action} from state ${from}`}});
  const frozen=state=>({status:409,body:{error:`Risk profile is frozen while bot is ${state}. Stop the bot first.`}});
  // SETUP -> RUNNING.
  const started=await run(owner,V,'run');
  assert.equal(started.status,200,JSON.stringify(started.body));assert.equal(started.body.state,'RUNNING');
  assert.match(started.body.run_id,/^[0-9a-f-]{36}$/);
  const runId=started.body.run_id;
  assert.equal((await sessionRow(id)).state,'RUNNING');
  assert.equal((await auditOf('bot.lifecycle.run',id)).length,1);
  // C7b RUNNING.
  await refused('PUT /api/risk while RUNNING',id,frozen('running'),()=>f.request('/api/risk','PUT',change,V));
  // C9b RUNNING -> reset.
  await refused('RUNNING -> reset',id,bad('RUNNING','reset'),()=>run(owner,V,'reset'));
  // RUNNING -> PAUSED.
  const paused=await run(owner,V,'pause');
  assert.equal(paused.status,200,JSON.stringify(paused.body));assert.deepEqual(paused.body,{state:'PAUSED',run_id:runId});
  // C7b PAUSED.
  await refused('PUT /api/risk while PAUSED',id,frozen('paused'),()=>f.request('/api/risk','PUT',change,V));
  // C9b PAUSED -> pause, PAUSED -> reset.
  await refused('PAUSED -> pause',id,bad('PAUSED','pause'),()=>run(owner,V,'pause'));
  await refused('PAUSED -> reset',id,bad('PAUSED','reset'),()=>run(owner,V,'reset'));
  assert.equal((await sessionRow(id)).run_id,runId);
  // PAUSED -> STOPPED.
  const stopped=await run(owner,V,'stop');
  assert.equal(stopped.status,200,JSON.stringify(stopped.body));assert.deepEqual(stopped.body,{state:'STOPPED',run_id:runId});
  // C9b STOPPED -> run, pause, stop.
  await refused('STOPPED -> run',id,bad('STOPPED','run'),()=>run(owner,V,'run'));
  await refused('STOPPED -> pause',id,bad('STOPPED','pause'),()=>run(owner,V,'pause'));
  await refused('STOPPED -> stop',id,bad('STOPPED','stop'),()=>run(owner,V,'stop'));
  const stoppedRow=await sessionRow(id);
  assert.equal(stoppedRow.state,'STOPPED');assert.equal(stoppedRow.run_id,runId);assert.equal(await archiveCount(id),0);
  // Control for C7b: the policy is not frozen once STOPPED, and the change is stored and audited.
  const saved=await f.request('/api/risk','PUT',change,V);
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.maxTradesPerDay,change.maxTradesPerDay);
  assert.equal(JSON.parse((await riskRow(id)).policy).maxTradesPerDay,change.maxTradesPerDay);
  assert.equal((await auditOf('risk.updated',id)).length,1);
  // Control for C9b: the supported transition STOPPED -> reset is the only one left, and it archives the run.
  const reset=await run(owner,V,'reset');
  assert.equal(reset.status,200,JSON.stringify(reset.body));assert.deepEqual(reset.body,{state:'SETUP',run_id:null});
  assert.equal(await archiveCount(id),1);assert.equal((await sessionRow(id)).state,'SETUP');
  // Audit rows of the supported transitions only: one each, none for the refused ones.
  const lifecycle=(await auditCounts()).filter(row=>row.event.startsWith('bot.lifecycle.')).map(row=>row.event);
  for(const action of ['run','pause','stop','reset'])assert.equal((await auditOf('bot.lifecycle.'+action,id)).length,1,action);
  assert.ok(lifecycle.length>=4);
});

// ---- C10: run needs funded Paper capital ----------------------------------------------------------------------------------------
test('C10: run with unfunded Paper capital answers 409 and no transition; a funded Bot runs',async()=>{
  const owner=await f.newOwner('unfunded'),V=await owner.login(),id=owner.id;
  const refusal={status:409,body:{error:'Cannot run a bot without funded Paper capital'}};
  // A Bot created through the API starts with the default policy, which holds no Paper capital.
  await license(owner,'PERSONAL');
  const made=await f.request('/api/bots','POST',{label:'Unfunded child'},V);
  assert.equal(made.status,201,JSON.stringify(made.body));
  const child=made.body.id;
  assert.deepEqual(Object.values(JSON.parse((await riskRow(child)).policy).equities??{}).filter(value=>D(String(value)).gt(0)),[],'the default policy is unfunded');
  await refused('run on a new unfunded child Bot',child,refusal,()=>run(owner,V,'run',child));
  assert.equal(await sessionRow(child),null,'no session row written');
  // The main account with equity set to 0 for every broker.
  await f.store.setRisk(id,{...owner.policy,equities:{[BROKER]:0},balances:{[BROKER]:0}});
  await refused('run with equity 0',id,refusal,()=>run(owner,V,'run'));
  assert.equal(await sessionRow(id),null);
  // No equity entry at all.
  await f.store.setRisk(id,{...owner.policy,equities:{},balances:{}});
  await refused('run with no equity entry',id,refusal,()=>run(owner,V,'run'));
  assert.equal(await sessionRow(id),null);
  assert.deepEqual(await auditOf('bot.lifecycle.run',id),[],'no run audit row for a refused run');
  // Control: once funded, the same route runs the Bot.
  await f.store.setRisk(id,{...owner.policy});
  const funded=await run(owner,V,'run');
  assert.equal(funded.status,200,JSON.stringify(funded.body));assert.equal(funded.body.state,'RUNNING');
  assert.equal((await sessionRow(id)).state,'RUNNING');
});

// ---- C12: worker honours the Bot state ----------------------------------------------------------------------------------------
test('C12: the worker rejects every signal while STOPPED, and BUY and a SELL without reduce-only while PAUSED; RUNNING and a reduce-only exit while PAUSED fill',async()=>{
  const owner=await f.newOwner('worker'),V=await owner.login(),id=owner.id;
  await license(owner,'PERSONAL');
  await f.store.setRisk(id,{...owner.policy,maxTradesPerDay:100,maxOpenPositions:10,blockHighVolatility:false,blockDuringNews:false});
  const worker=new ExecutionWorker({store:f.store,config});
  // BUY 400 at 0.1 is a notional of 40: the funded cash of 1000 becomes 960 after the fill.
  const signal=(trade,overrides={})=>normalizeSignal({trade_id:trade,broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'400',entry:'0.1',sl:'0.09',timestamp:Date.now(),...overrides});
  const exit=(trade,overrides={})=>signal(trade,{event:'SELL',reduce_only:true,quantity:undefined,...overrides});
  const plainSell=trade=>signal(trade,{event:'SELL'});
  const outcome=async trade=>(await rows('SELECT status,error_message FROM signals WHERE user_id=$1 AND trade_id=$2',[id,trade]))[0];
  const cash=async()=>D(String((await f.store.paperAccount(id,BROKER)).cash)).toFixed();
  const position=async()=>D(String((await rows('SELECT COALESCE(sum(quantity),0) q FROM ledger_positions WHERE user_id=$1 AND execution_mode=\'PAPER\'',[id]))[0].q)).toFixed();
  /** Enqueues the signals and lets the real worker process exactly them. */
  async function process(...signals) {
    for(const item of signals)assert.equal(await f.store.enqueue(id,item),true);
    for(const item of signals)assert.equal(await worker.tick(),true,'the worker took '+item.tradeId);
    assert.equal(await worker.tick(),false,'nothing is left in the queue');
  }
  const STOPPED='Bot is stopped: no signals accepted',PAUSED='Bot is paused: only reduce-only exits are accepted';
  assert.equal((await run(owner,V,'run')).status,200);
  // Control: RUNNING accepts the BUY.
  await process(signal('c12-buy-1'));
  assert.equal((await outcome('c12-buy-1')).status,'FILLED');assert.equal(await cash(),'960');assert.equal(await position(),'400');
  assert.equal((await run(owner,V,'pause')).status,200);
  // PAUSED: a BUY (also one flagged reduce_only: only a SELL can reduce) and a SELL without reduce-only are rejected; no ledger effect.
  await process(signal('c12-paused-buy'),signal('c12-paused-buy-flagged',{reduce_only:true}),plainSell('c12-paused-sell'));
  for(const trade of ['c12-paused-buy','c12-paused-buy-flagged','c12-paused-sell']){
    const row=await outcome(trade);
    assert.equal(row.status,'REJECTED',trade);assert.equal(row.error_message,PAUSED,trade);
  }
  assert.equal(await cash(),'960','a rejected signal moves no cash');assert.equal(await position(),'400','a rejected signal moves no position');
  // Control: PAUSED accepts a reduce-only exit, so the two refusals above are the reduce-only rule and not a dead worker.
  await process(exit('c12-paused-exit'));
  assert.equal((await outcome('c12-paused-exit')).status,'FILLED');assert.equal(await cash(),'1000');assert.equal(await position(),'0');
  // Resume, hold a position again, then stop.
  assert.equal((await run(owner,V,'run')).status,200);
  await process(signal('c12-buy-2'));
  assert.equal((await outcome('c12-buy-2')).status,'FILLED');assert.equal(await cash(),'960');assert.equal(await position(),'400');
  assert.equal((await run(owner,V,'stop')).status,200);
  // STOPPED: every signal is rejected, including the reduce-only exit of an open position.
  await process(signal('c12-stopped-buy'),exit('c12-stopped-exit'),plainSell('c12-stopped-sell'));
  for(const trade of ['c12-stopped-buy','c12-stopped-exit','c12-stopped-sell']){
    const row=await outcome(trade);
    assert.equal(row.status,'REJECTED',trade);assert.equal(row.error_message,STOPPED,trade);
  }
  assert.equal(await cash(),'960','a STOPPED Bot moves no cash');assert.equal(await position(),'400','a STOPPED Bot keeps its position');
});

// ---- C13b: Paper activation for a STOPPED Bot ----------------------------------------------------------------------------------
test('C13b: Paper activation for a STOPPED Bot answers 409 BOT_STOPPED with no state change; for a RUNNING Bot it activates and does not start the Bot',async()=>{
  const owner=await f.newOwner('activate'),V=await owner.login(),id=owner.id;
  const route='/api/quant/pine-bridge/deployments/'+owner.deploymentId+'/activate';
  const deployment=async()=>(await rows('SELECT state FROM pine_deployments WHERE deployment_id=$1',[owner.deploymentId]))[0].state;
  assert.equal((await run(owner,V,'run')).status,200);
  // Control: a RUNNING Bot passes every readiness gate (fresh snapshot, evidence, risk), so BOT_STOPPED below is the only difference.
  const activated=await f.request(route,'POST',{},V);
  assert.equal(activated.status,200,JSON.stringify(activated.body));
  assert.deepEqual(activated.body,{deployment_id:owner.deploymentId,state:'READY',execution_mode:'PAPER',quant_capability:'UNSUPPORTED'});
  assert.equal((await auditOf('pine_bridge.activated',id)).length,1);
  assert.equal((await sessionRow(id)).state,'RUNNING','activation does not start or stop the Bot');
  assert.equal((await run(owner,V,'stop')).status,200);
  const before=await auditOf('pine_bridge.activated',id);
  await refused('activate for a STOPPED Bot',id,{status:409,body:{error:'BOT_STOPPED',code:'BOT_STOPPED'}},()=>f.request(route,'POST',{},V));
  assert.deepEqual(await auditOf('pine_bridge.activated',id),before,'no pine_bridge.activated audit row');
  assert.equal(await deployment(),'READY');assert.equal((await sessionRow(id)).state,'STOPPED','activation does not restart the Bot');
});

// ---- budget -------------------------------------------------------------------------------------------------------------------
test('the file stays inside the API request budget of the server (240 per minute and source address)',()=>{
  // Every request above comes from one loopback address. A 429 from the shared bucket would look like a broken route, so a
  // new case that pushes the file near the bucket fails here first and must be split into another file.
  assert.ok(f.requestCount()<=200,'requests sent through the fixture: '+f.requestCount());
});
