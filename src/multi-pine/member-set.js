import {canonical,hash} from '../pine-bridge/source.js';
import {validateEvidence} from '../postgres/pine-bridge-readiness.js';
import {MP_CODES,MP_MAX_MEMBERS,MP_MIN_MEMBERS,MP_MEMBER_SET_VERSION,MP_SAME_BAR_ORDER,MP_BRIDGE_ATR_PERIOD,MP_MODE} from './codes.js';

/*
 * F11-01 S1: pure, fixture-only builder of the multi-Pine member set (docs/MULTI_PINE_CONTRACT.md section 3).
 * No database, clock, randomness, network or file. The caller (a later internal service) reads server rows and passes them in,
 * with a server-generated member_set_id and created_at, the server-read bot_state, and one named deployment_id per member
 * (member_deployments). Nothing the client says (mode, count, member list) is accepted:
 * the top-level key list is closed, so a client field refuses with MP_INPUT_INVALID.
 *
 * Every function returns a result object and never throws:
 *   {ok:true, ...}                     success
 *   {ok:false, code, diagnostic}       refusal; code is one of MP_CODES, diagnostic names the stage, ordinal and field
 * Anything unknown or malformed fails closed with MP_INPUT_INVALID. First failing check wins (fixed order, below).
 */

class Refusal extends Error {
  constructor(code,diagnostic={}) {super(code);this.code=code;this.diagnostic=diagnostic;}
}
const refuse=(code,diagnostic={})=>{throw new Refusal(code,diagnostic);};
const invalid=field=>refuse(MP_CODES.INPUT_INVALID,{field});
const result=run=>{
  try {return {ok:true,...run()};}
  catch(error) {
    if(error instanceof Refusal)return {ok:false,code:error.code,diagnostic:error.diagnostic};
    return {ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{field:'unexpected'}};
  }
};

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>=1&&value.length<=200;
const HEX64=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const hex64=value=>typeof value==='string'&&HEX64.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const version=value=>Number.isSafeInteger(value)&&value>=1;
const isoUtc=value=>typeof value==='string'&&ISO_UTC.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(Date.parse(value)).toISOString().slice(0,19)===value.slice(0,19);
const sameKeys=(value,keys)=>isObject(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const need=(condition,field)=>{if(!condition)invalid(field);};
const byText=(a,b)=>a<b?-1:a>b?1:0;

/**
 * Decimal-string form of a Bridge value (section 4): a finite JS number or a plain decimal string, positive and at most 1000,
 * rendered without exponent, leading or trailing zeros. 2, "2", "2.0" and "2.00" all give "2"; 1.5 and "1.50" give "1.5".
 * Returns null for anything else (never throws).
 */
export function decimalString(value) {
  let source;
  if(typeof value==='number'&&Number.isFinite(value))source=String(value);
  else if(typeof value==='string')source=value;
  else return null;
  const match=/^(\d{1,40})(?:\.(\d{1,40}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(source);
  if(!match)return null;
  const fraction=match[2]??'';
  let digits=(match[1]+fraction).replace(/^0+/,'');
  let exponent=(match[3]?Number(match[3]):0)-fraction.length;
  if(digits==='')return null;
  while(digits.endsWith('0')){digits=digits.slice(0,-1);exponent++;}
  if(Math.abs(exponent)>30)return null;
  let rendered;
  if(exponent>=0)rendered=digits+'0'.repeat(exponent);
  else {
    const point=digits.length+exponent;
    rendered=point>0?digits.slice(0,point)+'.'+digits.slice(point):'0.'+'0'.repeat(-point)+digits;
  }
  const numeric=Number(rendered);
  return numeric>0&&numeric<=1000?rendered:null;
}
const bridgePair=(bridge,field)=>{
  need(isObject(bridge)&&Object.keys(bridge).length===2&&Object.hasOwn(bridge,'atr_multiplier')&&Object.hasOwn(bridge,'rr'),field);
  const atr_multiplier=decimalString(bridge.atr_multiplier),rr=decimalString(bridge.rr);
  need(atr_multiplier!==null,field+'.atr_multiplier');
  need(rr!==null,field+'.rr');
  return {atr_multiplier,rr};
};

/* ---------- server rows ---------- */

/*
 * bot_state is the current Bot state read on the server, like freshSnapshot (src/postgres/pine-bridge-readiness.js): the hash of the
 * locked or default risk policy, the hash of the paper capital basis (broker, configuredEquity, configuredBalance) and the paper_funding cutoff.
 * It is required on both calls, so a Bot change after a member snapshot was frozen is stale and never read from a member snapshot alone.
 */
const BOT_STATE_KEYS=['policy_hash','capital_basis_hash','funding_cutoff'];
const ROW_KEYS=['owner_id','bot_id','memberships','deployments','evidence','bot_state'];
/** member_deployments: the caller names exactly one deployment per connected member (OD-MP-7, root ruling M3). Build only. */
const BUILD_KEYS=[...ROW_KEYS,'member_deployments','fixture','member_set_id','created_at'];
const NAME_KEYS=['pine_import_id','deployment_id'];
const STATES=['DRAFT','READY','EXIT_ONLY','REVOKED'];

function readBotState(value) {
  need(sameKeys(value,BOT_STATE_KEYS),'bot_state');
  need(hex64(value.policy_hash),'bot_state.policy_hash');
  need(hex64(value.capital_basis_hash),'bot_state.capital_basis_hash');
  need(count(value.funding_cutoff),'bot_state.funding_cutoff');
  return {policy_hash:value.policy_hash,capital_basis_hash:value.capital_basis_hash,funding_cutoff:value.funding_cutoff};
}

function readNames(input) {
  need(Array.isArray(input.member_deployments)&&input.member_deployments.length<=1000,'member_deployments');
  const seen=new Set();
  return input.member_deployments.map((row,i)=>{
    const f=`member_deployments[${i}]`;
    need(sameKeys(row,NAME_KEYS)&&text(row.pine_import_id)&&text(row.deployment_id),f);
    const key=JSON.stringify([row.pine_import_id,row.deployment_id]);
    need(!seen.has(key),f);
    seen.add(key);
    return {pine_import_id:row.pine_import_id,deployment_id:row.deployment_id};
  });
}

function readRows(input,allowed) {
  need(isObject(input),'input');
  for(const key of Object.keys(input))need(allowed.includes(key),'input.'+key);
  need(text(input.owner_id),'owner_id');
  need(text(input.bot_id),'bot_id');
  const bot_state=readBotState(input.bot_state);
  for(const key of ['memberships','deployments','evidence'])need(Array.isArray(input[key])&&input[key].length<=1000,key);
  const seen=new Set();
  const memberships=input.memberships.map((row,i)=>{
    const f=`memberships[${i}]`;
    need(isObject(row)&&text(row.pine_import_id)&&text(row.owner_id)&&text(row.bot_id)&&version(row.source_version)&&hex64(row.source_hash)&&typeof row.connected==='boolean',f);
    need(isObject(row.analysis)&&hex64(row.analysis.effective_inputs_hash),f+'.analysis.effective_inputs_hash');
    need(!seen.has(row.pine_import_id),f+'.pine_import_id');
    seen.add(row.pine_import_id);
    return row;
  });
  const ids=new Set();
  const deployments=input.deployments.map((row,i)=>{
    const f=`deployments[${i}]`;
    need(isObject(row)&&text(row.deployment_id)&&text(row.owner_id)&&text(row.bot_id)&&text(row.pine_import_id)&&version(row.source_version)&&STATES.includes(row.state)&&hex64(row.snapshot_hash),f);
    need(isObject(row.snapshot),f+'.snapshot');
    need(!ids.has(row.deployment_id),f+'.deployment_id');
    ids.add(row.deployment_id);
    return row;
  });
  const evidenceIds=new Set();
  const evidence=input.evidence.map((row,i)=>{
    const f=`evidence[${i}]`;
    need(isObject(row)&&text(row.deployment_id)&&hex64(row.snapshot_hash)&&hex64(row.evidence_hash)&&isObject(row.evidence),f);
    need(!evidenceIds.has(row.deployment_id),f+'.deployment_id');
    // M6: evidence of a deployment the caller did not hand in is a caller defect, never ignored.
    need(ids.has(row.deployment_id),f+'.deployment_id');
    evidenceIds.add(row.deployment_id);
    return row;
  });
  return {owner_id:input.owner_id,bot_id:input.bot_id,bot_state,memberships,deployments,evidence};
}

/** I2: a row of another owner or Bot is a caller defect, never ignored. */
function assertSameBot(rows) {
  rows.memberships.forEach((row,i)=>{if(row.owner_id!==rows.owner_id||row.bot_id!==rows.bot_id)refuse(MP_CODES.MEMBER_FOREIGN_BOT,{stage:'membership',row:i,pine_import_id:row.pine_import_id});});
  rows.deployments.forEach((row,i)=>{if(row.owner_id!==rows.owner_id||row.bot_id!==rows.bot_id)refuse(MP_CODES.MEMBER_FOREIGN_BOT,{stage:'deployment',row:i,deployment_id:row.deployment_id});});
}

/** Connected members in ascending pine_import_id (the membershipSnapshot order), with their dense ordinal 1..N. */
const connectedMembers=rows=>rows.memberships.filter(row=>row.connected).sort((a,b)=>byText(a.pine_import_id,b.pine_import_id)).map((row,i)=>({...row,ordinal:i+1}));
const membershipProjection=members=>members.map(m=>({pine_import_id:m.pine_import_id,source_version:m.source_version,source_hash:m.source_hash,analysis:m.analysis}));
const membershipOf=members=>hash(canonical(members.map(m=>({pine_import_id:m.pine_import_id,source_version:m.source_version,source_hash:m.source_hash}))));
const where=member=>({ordinal:member.ordinal,pine_import_id:member.pine_import_id});

/** A named deployment belongs to the member when it has the member's pine_import_id and current source_version (section 3.4). */
const belongsTo=(deployment,member)=>deployment!==undefined&&deployment.pine_import_id===member.pine_import_id&&deployment.source_version===member.source_version;

/** AGENTS scope: Spot/Paper only, BINANCE:BTCUSDT Spot 1m. Any other market is an invalid input, never a different member set. */
const SUPPORTED_MARKET=Object.freeze({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
const marketSupported=market=>isObject(market)&&Object.keys(SUPPORTED_MARKET).every(key=>market[key]===SUPPORTED_MARKET[key]);

/** Facts a member deployment snapshot contributes. Structure and internal hashes are checked; anything off fails closed. */
function snapshotFacts(deployment,member) {
  const f=`deployment ${member.ordinal}`;
  const s=deployment.snapshot;
  need(hash(canonical(s))===deployment.snapshot_hash,f+'.snapshot_hash');
  need(isObject(s.market)&&s.market.deployment_id===deployment.deployment_id&&s.market.pine_import_id===deployment.pine_import_id&&s.market.source_version===deployment.source_version,f+'.snapshot.market.identity');
  need(text(s.market.broker)&&text(s.market.symbol)&&text(s.market.timeframe),f+'.snapshot.market');
  need(marketSupported(s.market),'market.unsupported');
  need(isObject(s.selection),f+'.snapshot.selection');
  need(isObject(s.policy)&&hex64(s.policy_hash)&&hash(canonical(s.policy))===s.policy_hash,f+'.snapshot.policy_hash');
  need(Array.isArray(s.capital)&&s.capital.every(a=>isObject(a)&&a.broker!==undefined&&a.configuredEquity!==undefined&&a.configuredBalance!==undefined),f+'.snapshot.capital');
  need(count(s.funding_cutoff),f+'.snapshot.funding_cutoff');
  need(Array.isArray(s.membership),f+'.snapshot.membership');
  need(s.source_hash===member.source_hash,f+'.snapshot.source_hash');
  need(hex64(s.artifact_hash),f+'.snapshot.artifact_hash');
  need(text(deployment.exit_version),f+'.exit_version');
  return {
    pair:bridgePair(s.selection.bridge,f+'.snapshot.selection.bridge'),
    market:{broker:s.market.broker,symbol:s.market.symbol,timeframe:s.market.timeframe},
    policy_hash:s.policy_hash,
    capital_basis_hash:hash(canonical(s.capital.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance})))),
    funding_cutoff:s.funding_cutoff,
    exit_version:deployment.exit_version
  };
}

/** Bridge evidence of one member deployment: bound to its own snapshot and artifact, valid under validateEvidence (section 3.4). */
function evidenceOf(rows,deployment,member) {
  const missing=reason=>refuse(MP_CODES.MEMBER_EVIDENCE_MISSING,{...where(member),deployment_id:deployment.deployment_id,reason});
  const record=rows.evidence.find(e=>e.deployment_id===deployment.deployment_id);
  if(!record)missing('absent');
  if(record.snapshot_hash!==deployment.snapshot_hash)missing('snapshot_hash');
  if(hash(canonical(record.evidence))!==record.evidence_hash)missing('evidence_hash');
  let checked;
  try {checked=validateEvidence(record.evidence,deployment.snapshot_hash);}
  catch(error) {missing(typeof error?.code==='string'?error.code:'invalid');}
  if(checked.artifact_hash!==deployment.snapshot.artifact_hash||checked.source_hash!==deployment.snapshot.source_hash)missing('binding');
  return {evidence_hash:record.evidence_hash,execution_model_hash:hash(canonical(checked.execution_model))};
}

/* ---------- record ---------- */

const MEMBER_KEYS=['ordinal','pine_import_id','source_version','source_hash','effective_inputs_hash','deployment_id','deployment_snapshot_hash','exit_version','evidence_hash'];
const CONTENT_KEYS=['version','owner_id','bot_id','mode','pine_count','members','membership_hash','bridge_pair','bridge_atr_period','market','exit_version','execution_model_hash','policy_hash','funding_cutoff','capital_basis_hash','same_bar_order','fixture'];
const RECORD_KEYS=[...CONTENT_KEYS,'member_set_id','content_digest','set_hash','created_at'];
/** RC-MP-1: digest of everything material, without member_set_id, created_at and the two hashes that contain them. */
const contentOf=record=>Object.fromEntries(CONTENT_KEYS.map(key=>[key,record[key]]));
const contentDigest=record=>hash(canonical(contentOf(record)));
/** Section 3.3: SHA-256 of the canonical record without set_hash and created_at. */
const setHashOf=record=>hash(canonical(Object.fromEntries(RECORD_KEYS.filter(key=>key!=='set_hash'&&key!=='created_at').map(key=>[key,record[key]]))));

/** Strict shape and hash check of a stored or built member set. Throws a Refusal; used by build, decide and freshness. */
function checkRecord(record,field) {
  need(sameKeys(record,RECORD_KEYS),field);
  need(record.version===MP_MEMBER_SET_VERSION&&record.mode===MP_MODE&&record.fixture===true&&record.same_bar_order===MP_SAME_BAR_ORDER&&record.bridge_atr_period===MP_BRIDGE_ATR_PERIOD,field+'.constants');
  need(text(record.owner_id)&&text(record.bot_id)&&UUID.test(record.member_set_id)&&isoUtc(record.created_at),field+'.identity');
  need(Array.isArray(record.members)&&record.members.length>=MP_MIN_MEMBERS&&record.members.length<=MP_MAX_MEMBERS&&record.pine_count===record.members.length,field+'.members');
  let previous='';
  record.members.forEach((m,i)=>{
    need(sameKeys(m,MEMBER_KEYS)&&m.ordinal===i+1&&text(m.pine_import_id)&&m.pine_import_id>previous&&version(m.source_version)&&hex64(m.source_hash)&&hex64(m.effective_inputs_hash)&&text(m.deployment_id)&&hex64(m.deployment_snapshot_hash)&&text(m.exit_version)&&hex64(m.evidence_hash),`${field}.members[${i}]`);
    previous=m.pine_import_id;
  });
  need(isObject(record.bridge_pair)&&sameKeys(record.bridge_pair,['atr_multiplier','rr'])&&decimalString(record.bridge_pair.atr_multiplier)===record.bridge_pair.atr_multiplier&&decimalString(record.bridge_pair.rr)===record.bridge_pair.rr,field+'.bridge_pair');
  need(sameKeys(record.market,['broker','symbol','timeframe'])&&text(record.market.broker)&&text(record.market.symbol)&&text(record.market.timeframe)&&marketSupported(record.market),field+'.market');
  need(text(record.exit_version)&&record.members.every(m=>m.exit_version===record.exit_version),field+'.exit_version');
  need(hex64(record.execution_model_hash)&&hex64(record.policy_hash)&&hex64(record.capital_basis_hash)&&count(record.funding_cutoff),field+'.hashes');
  need(record.membership_hash===membershipOf(record.members),field+'.membership_hash');
  need(record.content_digest===contentDigest(record),field+'.content_digest');
  need(record.set_hash===setHashOf(record),field+'.set_hash');
  return record;
}

/* ---------- build ---------- */

function build(input) {
  need(isObject(input),'input');
  for(const key of Object.keys(input))need(BUILD_KEYS.includes(key),'input.'+key);
  if(input.fixture!==true)refuse(MP_CODES.FIXTURE_ONLY,{stage:'set'});
  need(typeof input.member_set_id==='string'&&UUID.test(input.member_set_id),'member_set_id');
  need(isoUtc(input.created_at),'created_at');
  const rows=readRows(input,BUILD_KEYS);
  const names=readNames(input);
  assertSameBot(rows);

  const connected=connectedMembers(rows);
  if(connected.length===0)refuse(MP_CODES.MEMBERSHIP_EMPTY,{stage:'set'});
  if(connected.length>MP_MAX_MEMBERS)refuse(MP_CODES.MEMBER_COUNT_EXCEEDED,{stage:'set',pine_count:connected.length,limit:MP_MAX_MEMBERS});
  if(connected.length<MP_MIN_MEMBERS)refuse(MP_CODES.NOT_MULTI_PINE,{stage:'set',pine_count:connected.length});
  for(let i=0;i<connected.length;i++)for(let j=i+1;j<connected.length;j++) {
    if(connected[i].source_hash===connected[j].source_hash&&connected[i].analysis.effective_inputs_hash===connected[j].analysis.effective_inputs_hash)
      refuse(MP_CODES.MEMBER_DUPLICATE_LOGIC,{stage:'set',ordinals:[connected[i].ordinal,connected[j].ordinal]});
  }

  // A name for a pine_import_id that is not a connected member is a caller defect (checked after the count checks above).
  names.forEach((name,i)=>need(connected.some(m=>m.pine_import_id===name.pine_import_id),`member_deployments[${i}].pine_import_id`));

  // freshSnapshot compares the snapshot membership as stored, in registry order (ORDER BY pine_import_id), never re-sorted.
  const projection=canonical(membershipProjection(connected));
  const facts=connected.map(member=>{
    // Root ruling M3: the caller names one deployment per member. Other rows of the same member, DRAFT or not, are ignored.
    const named=names.filter(name=>name.pine_import_id===member.pine_import_id);
    if(named.length===0)refuse(MP_CODES.MEMBER_DEPLOYMENT_MISSING,{stage:'member',...where(member)});
    if(named.length>1)refuse(MP_CODES.MEMBER_DEPLOYMENT_AMBIGUOUS,{stage:'member',...where(member),deployment_ids:named.map(name=>name.deployment_id).sort()});
    const deployment=rows.deployments.find(d=>d.deployment_id===named[0].deployment_id);
    // Owner and Bot of every row were checked by assertSameBot. A named deployment of another import or version is no deployment of this member.
    if(!belongsTo(deployment,member))refuse(MP_CODES.MEMBER_DEPLOYMENT_MISSING,{stage:'member',...where(member)});
    // OD-MP-7: members stay DRAFT. READY would contradict MULTI_PINE_REQUIRES_APP_3B, so only DRAFT is eligible.
    if(deployment.state!=='DRAFT')refuse(MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,{stage:'member',...where(member),deployment_id:deployment.deployment_id,state:deployment.state});
    const snapshot=snapshotFacts(deployment,member);
    const proof=evidenceOf(rows,deployment,member);
    if(canonical(deployment.snapshot.membership)!==projection)
      refuse(MP_CODES.MEMBER_SET_STALE,{stage:'member',...where(member),field:'snapshot.membership'});
    return {member,deployment,snapshot,proof};
  });

  // Cross-member checks against ordinal 1; the diagnostic names the first divergent ordinal.
  const first=facts[0];
  const divergent=(code,pick,field)=>{
    const other=facts.find(f=>canonical(pick(f))!==canonical(pick(first)));
    if(other)refuse(code,{stage:'set',field,ordinal:other.member.ordinal,pine_import_id:other.member.pine_import_id,against_ordinal:1});
  };
  divergent(MP_CODES.BRIDGE_PAIR_DIVERGENT,f=>f.snapshot.pair,'bridge_pair');
  // Defence in depth: snapshotFacts already refuses every market except the single supported one, so this cannot fire today.
  divergent(MP_CODES.MARKET_MIXED,f=>f.snapshot.market,'market');
  divergent(MP_CODES.EXIT_VERSION_MIXED,f=>f.snapshot.exit_version,'exit_version');
  divergent(MP_CODES.EXECUTION_MODEL_MIXED,f=>f.proof.execution_model_hash,'execution_model_hash');
  // Members frozen from different policy, capital or funding captures are not one Bot state: stale at birth.
  divergent(MP_CODES.MEMBER_SET_STALE,f=>f.snapshot.policy_hash,'policy_hash');
  divergent(MP_CODES.MEMBER_SET_STALE,f=>f.snapshot.capital_basis_hash,'capital_basis_hash');
  divergent(MP_CODES.MEMBER_SET_STALE,f=>f.snapshot.funding_cutoff,'funding_cutoff');
  // Root ruling M1: all members now agree, so the first one stands for them. A Bot that moved after the snapshots were frozen is stale at birth.
  for(const field of BOT_STATE_KEYS)
    if(canonical(first.snapshot[field])!==canonical(rows.bot_state[field]))refuse(MP_CODES.MEMBER_SET_STALE,{stage:'set',field,against:'bot_state'});

  const members=facts.map(({member,deployment,snapshot,proof})=>({
    ordinal:member.ordinal,pine_import_id:member.pine_import_id,source_version:member.source_version,source_hash:member.source_hash,
    effective_inputs_hash:member.analysis.effective_inputs_hash,deployment_id:deployment.deployment_id,deployment_snapshot_hash:deployment.snapshot_hash,
    exit_version:snapshot.exit_version,evidence_hash:proof.evidence_hash
  }));
  const content={
    version:MP_MEMBER_SET_VERSION,owner_id:rows.owner_id,bot_id:rows.bot_id,mode:MP_MODE,pine_count:members.length,members,
    membership_hash:membershipOf(members),bridge_pair:first.snapshot.pair,bridge_atr_period:MP_BRIDGE_ATR_PERIOD,market:first.snapshot.market,
    exit_version:first.snapshot.exit_version,execution_model_hash:first.proof.execution_model_hash,policy_hash:first.snapshot.policy_hash,
    funding_cutoff:first.snapshot.funding_cutoff,capital_basis_hash:first.snapshot.capital_basis_hash,same_bar_order:MP_SAME_BAR_ORDER,fixture:true
  };
  const record={...content,member_set_id:input.member_set_id,content_digest:contentDigest(content)};
  record.set_hash=setHashOf({...record,created_at:input.created_at});
  record.created_at=input.created_at;
  return {member_set:checkRecord(record,'member_set')};
}

/** Section 3.3 and 3.1: build a frozen-shape member set from server rows. Returns {ok:true,member_set} or {ok:false,code,diagnostic}. */
export const buildMemberSet=input=>result(()=>build(input));

/* ---------- freeze or load (RC-MP-1) ---------- */

/**
 * Idempotent re-freeze decision (pure). `candidate` is a built member set; `existing` are the stored sets of the same Bot.
 * An existing set with an equal content_digest is returned (action LOAD); otherwise the candidate is frozen (action FREEZE).
 * A stored set of another owner or Bot, a malformed or tampered stored set, or a member_set_id reused for different content
 * refuses. With several equal-digest sets the earliest created_at (then lowest member_set_id) wins.
 */
export function decideFreeze(candidate,existing) {
  return result(()=>{
    checkRecord(candidate,'candidate');
    need(Array.isArray(existing)&&existing.length<=1000,'existing');
    const stored=existing.map((record,i)=>checkRecord(record,`existing[${i}]`));
    for(const record of stored)if(record.owner_id!==candidate.owner_id||record.bot_id!==candidate.bot_id)refuse(MP_CODES.MEMBER_FOREIGN_BOT,{stage:'existing',member_set_id:record.member_set_id});
    const reused=stored.find(record=>record.member_set_id===candidate.member_set_id&&record.content_digest!==candidate.content_digest);
    if(reused)invalid('candidate.member_set_id');
    // M2: created_at may carry 0 to 3 fraction digits, so text order is wrong ("...00Z" sorts after "...00.100Z"). Compare the instants.
    const same=stored.filter(record=>record.content_digest===candidate.content_digest).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||byText(a.member_set_id,b.member_set_id));
    return same.length>0?{action:'LOAD',member_set:same[0]}:{action:'FREEZE',member_set:candidate};
  });
}

/* ---------- freshness (pure part of MP_MEMBER_SET_STALE, section 9.2) ---------- */

/** Per member in ordinal order, these fields in this order, then the set-level fields from bridge_pair on. First difference wins. */
export const FRESHNESS_FIELD_ORDER=Object.freeze(['membership_hash','effective_inputs_hash','deployment_id','deployment_state','deployment_snapshot_hash','exit_version','evidence_hash','snapshot_membership','bridge_pair','market','execution_model_hash','policy_hash','capital_basis_hash','funding_cutoff']);

/**
 * Compare a stored member set with current server rows (same row shape as the builder, including bot_state, without fixture,
 * member_set_id, created_at and member_deployments: the deployment of each member is the one the stored set names).
 * Fresh: {ok:true,fresh:true}. Stale: {ok:true,fresh:false,code:'MP_MEMBER_SET_STALE',diagnostic:{field,ordinal?}}.
 * A set of another owner or Bot, malformed rows or a tampered stored set refuse with {ok:false,...}. Nothing is re-bound silently.
 */
export function memberSetFreshness(memberSet,input) {
  return result(()=>{
    checkRecord(memberSet,'member_set');
    const rows=readRows(input,ROW_KEYS);
    if(memberSet.owner_id!==rows.owner_id||memberSet.bot_id!==rows.bot_id)refuse(MP_CODES.MEMBER_FOREIGN_BOT,{stage:'freshness'});
    assertSameBot(rows);
    const stale=(field,extra={})=>({fresh:false,code:MP_CODES.MEMBER_SET_STALE,diagnostic:{field,...extra}});

    const connected=connectedMembers(rows);
    if(membershipOf(connected)!==memberSet.membership_hash)return stale('membership_hash');
    const projection=canonical(membershipProjection(connected));
    const current=[];
    for(const stored of memberSet.members) {
      const member=connected[stored.ordinal-1];
      const at={ordinal:stored.ordinal,pine_import_id:stored.pine_import_id};
      if(member.analysis.effective_inputs_hash!==stored.effective_inputs_hash)return stale('effective_inputs_hash',at);
      // The frozen set names its deployment. Other rows of the same member are ignored, as at build.
      const deployment=rows.deployments.find(d=>d.deployment_id===stored.deployment_id);
      if(!belongsTo(deployment,member))return stale('deployment_id',at);
      if(deployment.state!=='DRAFT')return stale('deployment_state',at);
      if(deployment.snapshot_hash!==stored.deployment_snapshot_hash)return stale('deployment_snapshot_hash',at);
      if(deployment.exit_version!==stored.exit_version)return stale('exit_version',at);
      const record=rows.evidence.find(e=>e.deployment_id===deployment.deployment_id);
      if(!record||record.snapshot_hash!==deployment.snapshot_hash||record.evidence_hash!==stored.evidence_hash||hash(canonical(record.evidence))!==record.evidence_hash)return stale('evidence_hash',at);
      const snapshot=snapshotFacts(deployment,member);
      if(canonical(deployment.snapshot.membership)!==projection)return stale('snapshot_membership',at);
      let model;
      try {model=hash(canonical(validateEvidence(record.evidence,deployment.snapshot_hash).execution_model));}
      catch {return stale('evidence_hash',at);}
      current.push({at,snapshot,model});
    }
    const checks=[
      ['bridge_pair',c=>c.snapshot.pair,memberSet.bridge_pair],['market',c=>c.snapshot.market,memberSet.market],
      ['execution_model_hash',c=>c.model,memberSet.execution_model_hash],['policy_hash',c=>c.snapshot.policy_hash,memberSet.policy_hash],
      ['capital_basis_hash',c=>c.snapshot.capital_basis_hash,memberSet.capital_basis_hash],['funding_cutoff',c=>c.snapshot.funding_cutoff,memberSet.funding_cutoff]
    ];
    for(const [field,pick,expected] of checks) {
      const other=current.find(c=>canonical(pick(c))!==canonical(expected));
      if(other)return stale(field,other.at);
      // Root ruling M1: the Bot state read now must still equal the frozen value (a Bot policy, capital or funding change after freeze).
      if(BOT_STATE_KEYS.includes(field)&&canonical(rows.bot_state[field])!==canonical(expected))return stale(field,{against:'bot_state'});
    }
    return {fresh:true};
  });
}
