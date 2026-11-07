import {canonical,hash} from '../pine-bridge/source.js';
import {readJson} from './http.js';
import {CODES,QR3_VERSIONS,QR4_VERSIONS,OBJECTIVE_IDS,WEIGHT_KEYS,DEVELOPMENT_NAME_PREFIXES,STATUSES,OUTCOMES,isObject,keyTokens,validateObjective,checkRouteAction,metricsVisible,
  deriveOverlays} from '../selection/index.js';
import {registerSelection,cancelSelection,readSelection,REGISTRATION_TOO_SLOW,EVALUATIONS_UNAVAILABLE} from './selection-store.js';
import {readSelectionInputs,readPackageState} from './selection-inputs.js';

/**
 * QR-4 slice Q4-B owner API (contract 12.2, root rulings SB203 and RR-Q4-14), behind QR4_SELECTION_ENABLED, off by default. Six actions, an exact-case allow-list
 * (RC-S11: register, cancel, replay_outcome, open_package, list, detail):
 *   POST /api/quant/selections                                 register: confirm token, the owner-declared scope, W, objective id and filters. Starts nothing.
 *   GET  /api/quant/selections                                 list: every selection of the owner in creation order with counts per status and outcome. Read only.
 *   GET  /api/quant/selections/:id                             detail: the registration and, only once SELECTION_COMPLETED, the stored outcome (overlays at read time).
 *   POST /api/quant/selections/:id/cancel                      cancel: confirm token, SELECTION_REGISTERED or SELECTION_EVALUATING to SELECTION_CANCELLED.
 *   POST /api/quant/selections/:id/replay                      replay_outcome: recompute the pure ranking (13.2). Refuses until the evaluation wiring supplies deps.replay.
 *   GET  /api/quant/selections/:id/package/:export_id          open_package: the export id and its READY state only. No link (no package review view exists, SB203 item 5).
 * Nothing else is mounted. Any POST that names apply, import, start, email, alert, a Bot or a session answers 403 QR4_APPLY_REFUSED. When the flag is off the module
 * answers false before it reads anything, so every path falls through to the router's own 404.
 *
 * The caller (the user router) has already required a session with own:read or own:write; for a POST the module asks the auth object again (the canonical CSRF check)
 * and refuses a session that is not the routed actor. The owner is always the session user: no body or query field selects an owner. A foreign, absent or malformed
 * selection id answers the same 404. A query key is refused (rank-like keys with QR4_DEVELOPMENT_SCORE_NOT_RANKABLE) before any read.
 *
 * Fail closed until the evaluation wiring (slice Q4-W): register needs deps.engineHash (the engine hash of scope.engine comes only from the closure) and replay needs
 * deps.replay. Without them each answers QR4_EVALUATION_MODE_UNAVAILABLE (details REGISTER_NOT_WIRED, REPLAY_NOT_WIRED) before any read. The production dependency facts
 * (RR-Q4-2, RR-Q4-3) are fixed here: qr3_context is false while the V8 hold stands, so a registration with an eligible participant ends QR4_QR3_CONTEXT_UNAVAILABLE.
 * The route passes no objective registry (RC-S11): the product registry holds null tie tolerances until the owner sets them (OD-S3), so every registration also refuses
 * QR4_OBJECTIVE_UNKNOWN (TIE_TOLERANCES_NOT_SET) after the earlier refusals. The admission deadline is set here, never by the request: W end plus 24 hours (RR-Q4-8).
 *
 * Transactions. The request transaction of the dispatcher is SERIALIZABLE and the store writers own their transaction, so every database step runs in the deferred phase
 * after COMMIT (res.phase2Deferred, the QR-2 and QR-3 pattern). Phase one is pure. Read phases run in their own REPEATABLE READ READ ONLY transaction. The audit row of a
 * register, a cancel and a replay is written with store.audit after the action committed (QR-3 RR-9); a failed audit write is counted and never changes the answer.
 */
export const QR4_PATH='/api/quant/selections';
export const QR4_REGISTER_EVENT='qr4.selection_registered';
export const QR4_CANCEL_EVENT='qr4.selection_cancelled';
export const QR4_REPLAY_EVENT='qr4.selection_replayed';
/** RR-Q4-8: the admission deadline is W end plus this allowance, computed by the server. */
export const ADMISSION_DEADLINE_ALLOWANCE_MS=24*60*60*1000;
export const LIST_LIMIT=500;
const ROUTE_CODES=Object.freeze({METHOD_NOT_ALLOWED:'METHOD_NOT_ALLOWED',QR4_SCHEMA_ABSENT:'QR4_SCHEMA_ABSENT',QR4_UNAVAILABLE:'QR4_UNAVAILABLE',RETRY_TRANSACTION:'RETRY_TRANSACTION'});
const STATUS=Object.freeze({NOT_FOUND:404,METHOD_NOT_ALLOWED:405,QR4_APPLY_REFUSED:403,QR4_TRANSITION_INVALID:409,QR4_REGISTRATION_IMMUTABLE:409,INTEGRITY_CHECK_FAILED:409,
  QR4_EXPOSURE_REGISTRY_UNAVAILABLE:503,QR4_SCHEMA_ABSENT:503,QR4_UNAVAILABLE:503,QR4_EVALUATION_MODE_UNAVAILABLE:409,QR4_QR3_CONTEXT_UNAVAILABLE:409,
  QR4_EPISODE_GATE_UNAVAILABLE:409,QR4_NO_ELIGIBLE_PARTICIPANT:409,QR4_PARTICIPANT_NOT_READY:409,QR4_UNIVERSE_TOO_LARGE:409,RETRY_TRANSACTION:409});
const CREATE_KEYS=Object.freeze(['confirmed','fixture','ranking_basis','scope','window','objective','filters']);
/** The scope fields the owner declares. valuation and engine are set by the server (the engine hash only the closure supplies). */
const SCOPE_KEYS=Object.freeze(['market','data_model','cost_model','capital','policy']);
const APPLY_PREFIXES=Object.freeze(['apply','import','start','email','alert','session','optimi','bot']);
const SAFE_DETAIL=/^[A-Za-z0-9_:,.-]{1,120}$/;
const SHA256=/^[a-f0-9]{64}$/;
let auditFailures=0;
/** Audit writes that failed after their action committed, since process start (for tests and health). No identifier is kept. */
export const qr4AuditFailureCount=()=>auditFailures;

const safe=detail=>typeof detail==='string'&&SAFE_DETAIL.test(detail)?detail:null;
export const refusal=(code,detail=null,extra={})=>({...extra,ok:false,code,detail:safe(detail)});
const fromStore=result=>({...result,detail:typeof result.detail==='string'&&/^[A-Z0-9_:,.-]{1,120}$/.test(result.detail)?result.detail:null});
const clean=result=>refusal(result.code,result.detail,Object.fromEntries(Object.entries(result).filter(([name])=>!['ok','code','detail'].includes(name))));
const answer=result=>({status:STATUS[result.code]??400,body:clean(result)});
const notFound=()=>answer(refusal(CODES.NOT_FOUND));
const iso=ms=>Number.isSafeInteger(ms)?new Date(ms).toISOString():null;

/** The dependency facts of the production context (RR-Q4-2, RR-Q4-3). qr3_context never comes from a dependency object: the V8 hold needs its own reviewed ruling. */
export function productionDependencies(deps){
  return Object.freeze({qr3_context:false,evaluation_mode:isObject(deps)&&deps.evaluation_mode===true,
    episode_gate_version:isObject(deps)&&typeof deps.episode_gate_version==='string'?deps.episode_gate_version:''});
}

/** The Bot policy hash reader (the same effective policy as the Bot snapshot of the Pine service): {policy_hash} for freshness. Built only when the flag is on. */
export function botPolicyReader({store,defaultRisk}){
  return async({bot_id:botId})=>{
    const session=await store.getBotSession(botId);
    const policy=session.locked_policy?JSON.parse(session.locked_policy):await store.risk(botId,defaultRisk);
    return {policy_hash:hash(canonical(policy))};
  };
}

const rankLike=name=>{
  const lower=String(name).toLowerCase();
  return WEIGHT_KEYS.includes(lower)||/^(sort|order)/.test(lower)||keyTokens(name).some(token=>DEVELOPMENT_NAME_PREFIXES.some(prefix=>token.startsWith(prefix))||/^(sort|order)/.test(token));
};
const applyLike=name=>keyTokens(name).some(token=>APPLY_PREFIXES.some(prefix=>token.startsWith(prefix)));

/**
 * The pure part of register (no database): body shape, confirm token, scope keys and W shape, objective id and filters shape. Check order: forbidden words (apply, weights,
 * tolerance), unknown key, confirm token, field types, objective shape. Returns a refusal or {ok:true, plan}. The tie tolerances, the registry, the dependency facts, the
 * prior selections and the admission deadline are not request fields; a request that carries one is refused.
 */
export function planRegister(body){
  if(!isObject(body))return refusal(CODES.INVALID_FIELDS,'BODY');
  const names=Object.keys(body);
  if(names.some(applyLike))return refusal(CODES.QR4_APPLY_REFUSED,'ACTION_NOT_ALLOWED');
  const weight=names.find(name=>WEIGHT_KEYS.includes(name.toLowerCase()));
  if(weight!==undefined)return refusal(CODES.QR4_CUSTOM_WEIGHTS_REFUSED,weight.slice(0,40));
  if(names.some(name=>keyTokens(name).some(token=>token.startsWith('toler'))))return refusal(CODES.INVALID_FIELDS,'TOLERANCE_IN_REQUEST');
  if(names.some(name=>!CREATE_KEYS.includes(name)))return refusal(CODES.INVALID_FIELDS,'BODY');
  if(body.confirmed!==true)return refusal(CODES.CONFIRMATION_REQUIRED);
  if(body.fixture!==undefined&&typeof body.fixture!=='boolean')return refusal(CODES.INVALID_FIELDS,'FIXTURE');
  if(body.ranking_basis!==undefined&&typeof body.ranking_basis!=='string')return refusal(CODES.INVALID_FIELDS,'RANKING_BASIS');
  const scope=body.scope;
  if(!isObject(scope)||Object.keys(scope).some(name=>!SCOPE_KEYS.includes(name)))return refusal(CODES.INVALID_FIELDS,'SCOPE_KEYS');
  const window=body.window;
  if(!isObject(window)||!Number.isSafeInteger(window.end_ms)||window.end_ms<=0)return refusal(CODES.QR4_WINDOW_INVALID,'WINDOW_SHAPE');
  // The same shape check as the first step of the registration (no tolerance is required here), so a refused request reads nothing.
  const shape=validateObjective(body.objective,body.filters,{require_tolerances:false});
  if(!shape.ok)return clean(shape);
  return {ok:true,plan:{fixture:body.fixture===true,ranking_basis:body.ranking_basis,scope:structuredClone(scope),window:structuredClone(window),
    objective:structuredClone(body.objective),filters:structuredClone(body.filters)}};
}

/* ---- database phases ---- */

const GATE=`SELECT to_regclass('public.quant_selection_registrations') IS NOT NULL AND to_regclass('public.quant_selection_universe') IS NOT NULL
 AND to_regclass('public.quant_selection_participants') IS NOT NULL AND to_regclass('public.quant_selection_status_events') IS NOT NULL
 AND to_regclass('public.quant_selection_window_freezes') IS NOT NULL AND to_regclass('public.quant_selection_evaluation_starts') IS NOT NULL
 AND to_regclass('public.quant_selection_outcomes') IS NOT NULL AND to_regclass('public.quant_selection_replay_events') IS NOT NULL AS selection`;
// The list reader is its own SQL (no store change): the last status event of each selection, in creation order. No metric is read.
const LIST=`SELECT r.selection_id,r.fixture,r.window_kind,r.start_ms,r.end_ms,r.evaluation_bars,r.warmup_bars,r.total_bars,r.participant_count,r.registered_at_ms,r.frozen_at_ms,r.admission_deadline_ms,
 e.status,e.code,e.outcome FROM public.quant_selection_registrations r
 JOIN LATERAL (SELECT x.status,x.code,x.outcome FROM public.quant_selection_status_events x WHERE x.selection_id=r.selection_id ORDER BY x.seq DESC LIMIT 1) e ON true
 WHERE r.owner_id=$1 ORDER BY r.frozen_at_ms,r.selection_id LIMIT $2`;
const num=value=>value===null||value===undefined?null:Number(value);

class Stop extends Error{constructor(result){super(result.code);this.result=result;}}
const stop=(code,detail=null,extra={})=>{throw new Stop(refusal(code,detail,extra));};

/** Runs work in its own REPEATABLE READ READ ONLY transaction. A Stop thrown inside becomes the returned refusal. */
async function readOnly(db,work){
  try{
    return await db.transaction(async()=>{
      await db.query('SET TRANSACTION READ ONLY');
      return work();
    },{isolation:'REPEATABLE READ'});
  }catch(error){
    if(error instanceof Stop)return error.result;
    throw error;
  }
}
async function requireSchema(db){
  const present=await readOnly(db,async()=>{
    if((await db.query(GATE)).rows[0].selection!==true)stop(ROUTE_CODES.QR4_SCHEMA_ABSENT);
    return {ok:true};
  });
  return present.ok===true?null:present;
}

const unexpected=error=>{
  if(error?.code==='40001'||error?.code==='40P01')return {status:409,body:refusal(ROUTE_CODES.RETRY_TRANSACTION)};
  if(error?.code===REGISTRATION_TOO_SLOW||error?.code===EVALUATIONS_UNAVAILABLE)return {status:503,body:refusal(error.code,null,{retryable:true})};
  return answer(refusal(ROUTE_CODES.QR4_UNAVAILABLE));
};
async function audit(store,owner,event,payload){
  try{await store.audit(owner,event,null,payload);}
  catch{auditFailures+=1;}
}

/**
 * The request the store registers: the owner's declared fields plus the server's (valuation method ids, the engine hash of the closure, the admission deadline = W end plus 24 hours,
 * RR-Q4-8). The universe is not here; the inputs reader supplies it inside the registration transaction.
 */
export const registrationRequestOf=(owner,plan,engine)=>({owner_id:owner,confirmed:true,fixture:plan.fixture,...(plan.ranking_basis===undefined?{}:{ranking_basis:plan.ranking_basis}),
  scope:{...plan.scope,valuation:{valuation:QR3_VERSIONS.valuation,benchmark:QR3_VERSIONS.benchmark},engine},window:plan.window,objective:plan.objective,filters:plan.filters,
  admission_deadline_ms:plan.window.end_ms+ADMISSION_DEADLINE_ALLOWANCE_MS});
/** The server context of a registration. Exactly these keys: no objective registry (RC-S11), no universe, policy snapshot or cap (the reader), no prior selections (the store). */
export const registrationContextOf=(owner,options)=>({requester_owner_id:owner,dependencies:productionDependencies(options.deps),fixture_selections_allowed:options.fixtureSelectionsAllowed===true});

async function runRegister(store,options,owner,plan){
  const deps=options.deps;
  if(typeof deps?.engineHash!=='function')return answer(refusal(CODES.QR4_EVALUATION_MODE_UNAVAILABLE,'REGISTER_NOT_WIRED'));
  const engine=await deps.engineHash();
  if(typeof engine!=='string'||!SHA256.test(engine))return answer(refusal(CODES.QR4_EVALUATION_MODE_UNAVAILABLE,'ENGINE_HASH'));
  const missing=await requireSchema(store.db);
  if(missing!==null)return answer(missing);
  const request=registrationRequestOf(owner,plan,engine),context=registrationContextOf(owner,options);
  const policyHash=isObject(plan.scope.policy)?plan.scope.policy.policy_hash:null;
  const readInputs=(tx,args)=>readSelectionInputs(tx,{...args,fixture:plan.fixture,policy_hash:policyHash},{readBotState:options.readBotState});
  const made=await registerSelection(store.db,{request,context,readInputs});
  if(made.ok===true){
    const registration=made.registration;
    await audit(store,owner,QR4_REGISTER_EVENT,{selection_id:made.selection_id,status:'SELECTION_REGISTERED',participant_count:registration.participant_count,fixture:registration.fixture,
      registration_hash:made.registration_hash,outcome:'REGISTERED'});
    return {status:201,body:{ok:true,existing:false,selection_id:made.selection_id,status:'SELECTION_REGISTERED',registration_hash:made.registration_hash,frozen_at_ms:made.frozen_at_ms,
      frozen_at_utc:iso(made.frozen_at_ms),window:registration.window,admission_deadline_ms:registration.admission_deadline_ms,participant_count:registration.participant_count,
      universe_count:registration.universe.length,prior_selection_count:registration.prior_selection_count,evaluation_started:false}};
  }
  if(made.code===CODES.QR4_SELECTION_EXISTS&&typeof made.selection_id==='string')
    return {status:200,body:{ok:true,existing:true,selection_id:made.selection_id,evaluation_started:false}};
  return answer(fromStore(made));
}

async function runCancel(store,owner,id){
  const missing=await requireSchema(store.db);
  if(missing!==null)return answer(missing);
  const cancelled=await cancelSelection(store.db,{owner_id:owner,selection_id:id,confirmed:true});
  if(!cancelled.ok)return answer(fromStore(cancelled));
  await audit(store,owner,QR4_CANCEL_EVENT,{selection_id:id,status:'SELECTION_CANCELLED',seq:cancelled.seq,outcome:'CANCELLED'});
  return {status:200,body:{ok:true,selection_id:id,status:'SELECTION_CANCELLED',seq:cancelled.seq,exposure_records:'KEPT'}};
}

async function runReplay(store,options,owner,id){
  const db=store.db;
  const missing=await requireSchema(db);
  if(missing!==null)return answer(missing);
  // An absent or foreign id answers the same 404 whether or not replay is wired.
  const found=await readOnly(db,async()=>{
    const read=await readSelection(db,{owner_id:owner,selection_id:id});
    if(!read.ok)stop(read.code,fromStore(read).detail);
    return {ok:true,status:read.selection.status};
  });
  if(!found.ok)return answer(found);
  if(found.status!=='SELECTION_COMPLETED')return answer(refusal(CODES.QR4_TRANSITION_INVALID,'NOT_COMPLETED'));
  if(typeof options.deps?.replay!=='function')return answer(refusal(CODES.QR4_EVALUATION_MODE_UNAVAILABLE,'REPLAY_NOT_WIRED'));
  const replayed=await options.deps.replay({owner_id:owner,selection_id:id});
  if(!replayed.ok)return answer(fromStore(replayed));
  await audit(store,owner,QR4_REPLAY_EVENT,{selection_id:id,status:'SELECTION_COMPLETED',match:replayed.match===true,outcome:replayed.match===true?'REPLAY_MATCH':'REPLAY_MISMATCH'});
  return {status:200,body:{ok:true,selection_id:id,match:replayed.match===true,stored_outcome_hash:replayed.stored_outcome_hash??null,
    recomputed_outcome_hash:replayed.recomputed_outcome_hash??null,replay_event_id:replayed.replay_event_id??null,at_ms:replayed.at_ms??null,outcome_unchanged:true}};
}

/* ---- the views ---- */

async function runList(store,owner){
  const db=store.db;
  const found=await readOnly(db,async()=>{
    if((await db.query(GATE)).rows[0].selection!==true)stop(ROUTE_CODES.QR4_SCHEMA_ABSENT);
    return {ok:true,rows:(await db.query(LIST,[owner,LIST_LIMIT+1])).rows};
  });
  if(!found.ok)return answer(found);
  const rows=found.rows.slice(0,LIST_LIMIT);
  const byStatus=Object.fromEntries(STATUSES.map(name=>[name,0])),byOutcome=Object.fromEntries(OUTCOMES.map(name=>[name,0]));
  const selections=rows.map(row=>{
    byStatus[row.status]=(byStatus[row.status]??0)+1;
    const outcome=metricsVisible(row.status)&&typeof row.outcome==='string'?row.outcome:null;
    if(outcome!==null)byOutcome[outcome]=(byOutcome[outcome]??0)+1;
    return {selection_id:row.selection_id,fixture:row.fixture,internal_view:row.fixture,status:row.status,code:row.code??null,outcome,
      window:{kind:row.window_kind,start_ms:num(row.start_ms),end_ms:num(row.end_ms),evaluation_bars:row.evaluation_bars,warmup_bars:row.warmup_bars,total_bars:row.total_bars},
      participant_count:row.participant_count,registered_at_ms:num(row.registered_at_ms),frozen_at_ms:num(row.frozen_at_ms),frozen_at_utc:iso(num(row.frozen_at_ms)),
      admission_deadline_ms:num(row.admission_deadline_ms)};
  });
  return {status:200,body:{ok:true,selections,total:selections.length,truncated:found.rows.length>LIST_LIMIT,counts:{by_status:byStatus,by_outcome:byOutcome},order:'CREATION'}};
}

const hideValues=(body,winners)=>({...body,
  ranking:(Array.isArray(body.ranking)?body.ranking:[]).map(item=>winners.has(item.export_id)?{...item,net_return_percent:null,max_drawdown_percent:null}:item),
  evaluations:(Array.isArray(body.evaluations)?body.evaluations:[]).map(item=>winners.has(item.export_id)?{...item,values:null}:item)});

/** The outcome part of a completed selection: the stored body (hash verified), the overlays at read time, and the label only while no overlay suppresses it. */
async function outcomeView(db,options,owner,selection){
  const stored=selection.outcome_row;
  if(!stored||typeof stored.body_canonical!=='string'||hash(stored.body_canonical)!==stored.outcome_hash)stop(CODES.INTEGRITY_CHECK_FAILED,'OUTCOME_HASH');
  let body;
  try{body=JSON.parse(stored.body_canonical);}catch{stop(CODES.INTEGRITY_CHECK_FAILED,'OUTCOME_UNREADABLE');}
  if(!isObject(body))stop(CODES.INTEGRITY_CHECK_FAILED,'OUTCOME_UNREADABLE');
  const registration=selection.registration;
  const winners=new Set((Array.isArray(body.ranking)?body.ranking:[]).filter(item=>item.rank===1).map(item=>item.export_id));
  const labelled=(body.outcome==='BEST_IN_SCOPE'||body.outcome==='TIED_IN_SCOPE')&&registration.fixture!==true;
  let packagesReady=null;
  if(labelled){
    packagesReady={};
    for(const id of winners){
      const read=await readPackageState(db,{owner_id:owner,export_id:id},{readBotState:options.readBotState});
      packagesReady[id]=read.ok===true&&read.state.ready===true;
    }
  }
  const derived=deriveOverlays(registration,body,{packages_ready:packagesReady,replay_mismatch:selection.replay_mismatch,
    current_versions:{objective:OBJECTIVE_IDS[OBJECTIVE_IDS.length-1],scope:QR4_VERSIONS.scope}});
  // A fixture selection has no label to suppress and no READY package by definition (a fixture package is never READY), so WINNER_NOT_READY does not apply to it; the replay
  // mismatch overlay does. The pure overlay function is unchanged: this only drops the one overlay that cannot mean anything here.
  const overlays=registration.fixture===true?(()=>{
    const list=derived.overlays.filter(code=>code!=='WINNER_NOT_READY');
    return {overlays:list,label_visible:false,hide_recommended_values:list.includes('SELECTION_REPLAY_MISMATCH'),hide_package_links:false};
  })():{overlays:[...derived.overlays],label_visible:derived.label_visible,hide_recommended_values:derived.hide_recommended_values,hide_package_links:derived.hide_package_links};
  const shown=overlays.hide_recommended_values?hideValues(body,winners):body;
  const {label,...rest}=shown;
  return {outcome:{...rest,outcome_hash:stored.outcome_hash,created_at_ms:num(stored.created_at_ms),label:overlays.label_visible?label??null:null},
    overlays:overlays.overlays,label_visible:overlays.label_visible,hide_recommended_values:overlays.hide_recommended_values,hide_package_links:overlays.hide_package_links};
}

async function runDetail(store,options,owner,id){
  const db=store.db;
  const found=await readOnly(db,async()=>{
    if((await db.query(GATE)).rows[0].selection!==true)stop(ROUTE_CODES.QR4_SCHEMA_ABSENT);
    const read=await readSelection(db,{owner_id:owner,selection_id:id});
    if(!read.ok)stop(read.code,fromStore(read).detail);
    const selection=read.selection;
    const completed=metricsVisible(selection.status)?await outcomeView(db,options,owner,selection):null;
    return {ok:true,selection,completed};
  });
  if(!found.ok)return answer(found);
  const {selection,completed}=found,registration=selection.registration;
  return {status:200,body:{ok:true,selection_id:selection.selection_id,status:selection.status,code:selection.code??null,seq:selection.seq,fixture:selection.fixture,internal_view:selection.fixture,
    registration:{registration_hash:selection.registration_hash,registration_key:selection.registration_key,registered_at_ms:selection.registered_at_ms,frozen_at_ms:selection.frozen_at_ms,
      admission_deadline_ms:selection.admission_deadline_ms,window:registration.window,scope:registration.scope,objective:registration.objective,filters:registration.filters,
      prior_selection_count:registration.prior_selection_count,prior_selection_ids:registration.prior_selection_ids,participant_count:registration.participant_count,
      universe:registration.universe,participants:registration.participants.map(item=>({export_id:item.export_id,run_id:item.run_id,package_hash:item.package_hash,
        source_hash:item.source_hash,rules_hash:item.rules_hash,validation_binding:item.validation_binding}))},
    events:selection.events.map(item=>({seq:item.seq,event:item.event,status:item.status,code:item.code,at_ms:item.at_ms})),
    // Progress counts only: no metric of W is shown before SELECTION_COMPLETED (8.1), and a partial result is never shown.
    progress:{participants:registration.participant_count,started:selection.starts.length,window_frozen:selection.freeze!==null},
    metrics_visible:metricsVisible(selection.status),replay_mismatch:selection.replay_mismatch,
    outcome:completed===null?null:completed.outcome,overlays:completed===null?[]:completed.overlays,label_visible:completed===null?false:completed.label_visible,
    hide_recommended_values:completed===null?false:completed.hide_recommended_values,hide_package_links:completed===null?false:completed.hide_package_links}};
}

async function runPackage(store,options,owner,id,exportId){
  const db=store.db;
  const found=await readOnly(db,async()=>{
    if((await db.query(GATE)).rows[0].selection!==true)stop(ROUTE_CODES.QR4_SCHEMA_ABSENT);
    const read=await readSelection(db,{owner_id:owner,selection_id:id});
    if(!read.ok)stop(read.code,fromStore(read).detail);
    if(!read.selection.registration.participants.some(item=>item.export_id===exportId))stop(CODES.NOT_FOUND);
    const state=await readPackageState(db,{owner_id:owner,export_id:exportId},{readBotState:options.readBotState});
    if(!state.ok)stop(CODES.NOT_FOUND);
    return {ok:true,state};
  });
  if(!found.ok)return answer(found);
  const {state}=found.state;
  if(state.ready===true)return {status:200,body:{ok:true,selection_id:id,export_id:exportId,state:'READY'}};
  const view=found.state.package;
  const reason=view.status!=='EXPORT_VALIDATED'?view.status:state.fresh!==true?(state.code??'STALE'):view.binding?.fixture!==false?'FIXTURE':'BOT_NOT_OWNED';
  return answer(refusal(CODES.QR4_PARTICIPANT_NOT_READY,reason));
}

/* ---- the route ---- */

function parseTarget(path){
  const rest=path.slice(QR4_PATH.length);
  if(rest==='')return {kind:'collection',id:null};
  const parts=rest.slice(1).split('/');
  if(parts[0]==='')return null;
  if(parts.length===1)return {kind:'item',id:parts[0]};
  if(parts.length===2)return parts[1]==='cancel'?{kind:'cancel',id:parts[0]}:parts[1]==='replay'?{kind:'replay',id:parts[0]}:{kind:'action',id:parts[0],name:parts[1]};
  if(parts.length===3&&parts[1]==='package'&&parts[2]!=='')return {kind:'package',id:parts[0],exportId:parts[2]};
  return null;
}
const METHODS=Object.freeze({collection:['GET','POST'],item:['GET'],cancel:['POST'],replay:['POST'],package:['GET'],action:['POST']});

/**
 * options: {store, auth, json, enabled, deps, readBotState, fixtureSelectionsAllowed}. deps is the evaluation wiring of slice Q4-W ({engineHash, replay, evaluation_mode,
 * episode_gate_version}); it is absent here, so register and replay fail closed. readBotState is the Bot policy reader (botPolicyReader). Both are server values.
 */
export async function qr4Routes(req,res,url,actor,options={}){
  const {store,auth,json,enabled}=options;
  if(enabled!==true)return false;
  const path=url.pathname;
  if(path!==QR4_PATH&&!path.startsWith(QR4_PATH+'/'))return false;
  const send=result=>{json(res,result.status,result.body);return true;};
  const target=parseTarget(path);
  if(target===null)return send(notFound());
  const allowed=METHODS[target.kind];
  // A route-action name outside the allow-list is only ever a POST that tries to do something else: it is refused 403 below, any other method is not a route.
  if(!allowed.includes(req.method))return send(target.kind==='action'?notFound():answer(refusal(ROUTE_CODES.METHOD_NOT_ALLOWED)));
  // No query key selects anything; a rank-like key is the development-view refusal (3.3 D1), refused before any read.
  const keys=[...url.searchParams.keys()];
  if(keys.length>0)return send(keys.some(rankLike)?answer(refusal(CODES.QR4_DEVELOPMENT_SCORE_NOT_RANKABLE,'QUERY')):answer(refusal(CODES.INVALID_FIELDS,'QUERY')));
  if(req.method==='POST'){
    // Authentication and the unsafe-method CSRF check are the canonical auth.require; no second token exists.
    const session=await auth.require(req);
    if(!session||session.id!==actor.id)return send(notFound());
  }
  if(target.kind==='action'){
    // A POST to an action name that is not in the allow-list (RC-S11). A name that is on the list but is not a POST sub-route is not a route.
    const mapped=checkRouteAction(target.name);
    return send(mapped.ok===true?notFound():answer(refusal(CODES.QR4_APPLY_REFUSED,'ACTION_NOT_ALLOWED')));
  }
  const owner=actor.id;
  const defer=work=>{
    res.phase2Deferred=async()=>{try{return await work();}catch(error){return unexpected(error);}};
    return true;
  };
  if(target.kind==='collection'&&req.method==='GET')return defer(()=>runList(store,owner));
  if(target.kind==='item')return defer(()=>runDetail(store,options,owner,target.id));
  if(target.kind==='package')return defer(()=>runPackage(store,options,owner,target.id,target.exportId));
  const body=await readJson(req);
  if(target.kind==='cancel'){
    if(isObject(body)&&Object.keys(body).some(applyLike))return send(answer(refusal(CODES.QR4_APPLY_REFUSED,'ACTION_NOT_ALLOWED')));
    if(!isObject(body)||Object.keys(body).some(name=>name!=='confirmed'))return send(answer(refusal(CODES.INVALID_FIELDS,'BODY')));
    if(body.confirmed!==true)return send(answer(refusal(CODES.CONFIRMATION_REQUIRED)));
    return defer(()=>runCancel(store,owner,target.id));
  }
  if(target.kind==='replay'){
    if(isObject(body)&&Object.keys(body).some(applyLike))return send(answer(refusal(CODES.QR4_APPLY_REFUSED,'ACTION_NOT_ALLOWED')));
    if(!isObject(body)||Object.keys(body).length>0)return send(answer(refusal(CODES.INVALID_FIELDS,'BODY')));
    return defer(()=>runReplay(store,options,owner,target.id));
  }
  const planned=planRegister(body);
  if(!planned.ok)return send(answer(planned));
  return defer(()=>runRegister(store,options,owner,planned.plan));
}
