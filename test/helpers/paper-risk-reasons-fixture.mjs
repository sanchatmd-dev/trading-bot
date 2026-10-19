import {randomUUID} from 'node:crypto';
import {canonical,hash,validateSelection} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';

/**
 * PM-1 F03-01 fixture: one READY Bridge deployment per Bot, written straight into the isolated database (no AI job, no
 * activation), plus verified market bars and BUY events. Synthetic engineering fixture only; it says nothing about strategy
 * performance. The execution model is the recorded `paper-close-v1` shape with 0 bps slippage, so the BUY price equals the bar
 * close and every expected number in the test can be derived by hand.
 */
export const MODEL={version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};

/** Policy that admits a plain BUY and caps nothing; every test overrides only the limit it pins. */
export const BASE_POLICY={...structuredClone(config.defaultRisk),
 paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2,maxDailyLossR:1000,pauseAfterLossStreak:100,maxOrderNotional:10000,maxDailyNotional:1e7,
 maxTradesPerDay:10000,maxOpenPositions:10,onePositionPerSymbol:false,blockHighVolatility:false,blockDuringNews:false,maxSignalAgeSeconds:3600,
 capPercentEquitySize:true,sideMode:'BOTH',killSwitch:false,allowedSymbols:[]};

const SOURCE='//@version=6\nindicator("Synthetic paper risk fixture")\nbuySignal=false\nsellSignal=false';
const ANALYSIS={inputs:[],declarations:['buySignal','sellSignal'],effective_inputs_hash:hash('synthetic-paper-risk')};
const BRIDGE={atr_multiplier:2,rr:1.5};

/**
 * Creates one ADMIN Bot with funded Paper capital, a READY deployment on BINANCE:BTCUSDT 1D with evidence for `model`, and a
 * webhook secret. `equity` and `cash` are the configured Paper capital in USDT.
 */
export async function createBot({db,store,policy={},model=MODEL,equity=1000,cash=equity,now=Date.now()}){
 const a=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
 await store.setRisk(a,{...structuredClone(BASE_POLICY),...policy,equities:{'binance-global':equity},balances:{'binance-global':cash}});
 const saved=await store.risk(a,{});
 const importId=randomUUID(),deploymentId=randomUUID();
 await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,a,a,1,hash(SOURCE),'Synthetic only',SOURCE,JSON.stringify(ANALYSIS),now);
 await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,hash(SOURCE),SOURCE,JSON.stringify(ANALYSIS),now);
 await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,a,a,1);
 const membership=await db.prepare('SELECT m.pine_import_id,m.source_version,r.source_hash,r.analysis FROM pine_memberships m JOIN pine_source_revisions r USING(pine_import_id,source_version) WHERE m.owner_id=? AND m.bot_id=? AND m.connected=TRUE ORDER BY m.pine_import_id').all(a,a);
 const market={deployment_id:deploymentId,pine_import_id:importId,source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'};
 const funding=await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(a);
 const snapshot={source_hash:hash(SOURCE),artifact_hash:hash('synthetic-paper-risk-artifact'),market,policy:saved,policy_hash:hash(canonical(saved)),capital:await store.paperAccounts(a),
  funding_cutoff:funding.cutoff,membership,selection:validateSelection(ANALYSIS,{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},[],BRIDGE)};
 await db.prepare("INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,'READY',?)").run(deploymentId,a,a,importId,1,JSON.stringify(snapshot),hash(canonical(snapshot)),now);
 const evidence={snapshot_hash:hash(canonical(snapshot)),artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:model,references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
 await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,evidence.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),now);
 const secret=randomUUID();await store.setWebhookSecret(a,secret);
 return {a,secret,market,deploymentId};
}

/** Writes one verified closed bar (high 101, low 99 around `close`); the same facts at the same time are one bar. */
export async function writeBar(db,time,{close=100,atr=5}={}){
 const bar={time,open:String(close),high:String(close+1),low:String(close-1),close:String(close),volume:'100',atr14:String(atr),price_tick:'0.01',quantity_step:'0.001'};
 await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run('binance-global','BTCUSDT','1D',time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'}),hash(canonical(bar)));
}

export function buyEvent(market,time,{close=100,atr=5}={}){
 const ref=market.deployment_id+':'+time+':0';
 return {schema_version:'bridge-exit-v1',...market,event_id:ref+':BUY',event_type:'BUY',entry_ref:ref,bar_time:time,sequence:0,close,atr};
}
