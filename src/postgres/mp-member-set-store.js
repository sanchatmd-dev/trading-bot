import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../pine-bridge/source.js';
import {deploymentExitVersion} from '../pine-bridge/exit-version.js';
import {buildMemberSet,decideFreeze} from '../multi-pine/member-set.js';
import {MP_CODES} from '../multi-pine/codes.js';

/*
 * F11-01 member-set store: freeze-or-load of one multi-Pine member set (docs/MULTI_PINE_CONTRACT.md RD-MP-11 to RD-MP-16).
 * One function, freezeOrLoadMemberSet(db, input). No route, worker or view calls it yet.
 *
 * One call is one SERIALIZABLE transaction (the member-set tables refuse any other level with QR003):
 *   1. FOR SHARE on every membership row of the Bot and on the named member deployments. A row that a concurrent transaction changes after
 *      the snapshot then fails with 40001 and the attempt restarts from the beginning (RD-MP-15).
 *   2. Read the server rows. The artifact of a member is the integrated Pine of the one SUCCEEDED generate job of the same owner, Bot and
 *      deployment; its exit version is derived from it by deploymentExitVersion (RD-MP-12). Analysis comes from pine_source_revisions at the
 *      source version of the membership. The caller supplies only the owner, the Bot and the names of the deployments.
 *   3. Build the record with the S1 builder, then SELECT by content digest: an equal stored set is LOADED (S1 decideFreeze re-checks the stored
 *      record with the S1 record check); otherwise INSERT the parent ON CONFLICT DO NOTHING on the content key. The snapshot of a SERIALIZABLE
 *      transaction never shows a set that committed after it was taken, so a lost race cannot be loaded in the same attempt: the database
 *      reports it as 40001 (or 23505 on the content key), and an empty ON CONFLICT result is treated the same way. All of them restart the
 *      attempt, and the new snapshot finds the winner and LOADS it. Otherwise INSERT the members and COMMIT (the deferred completeness guard
 *      runs at commit).
 * Return value: {ok:true, action:'FREEZE'|'LOAD', member_set} or {ok:false, code, diagnostic} (a refusal; nothing was written).
 * A database error that is not mapped below is rethrown (after rollback). 40001 and 40P01 are retried wherever they surface, COMMIT included.
 * Guarantee boundary: the Bot state is read inside the freeze transaction only when input.readBotState uses the same database handle as `db`
 * (storeBotState over a Store that wraps `db` does). A caller that builds the reader on another database handle reads outside the SERIALIZABLE
 * snapshot; that is outside this function's guarantee and nothing here detects it.
 */

/** One first attempt plus at most three retries from the start (40001, 40P01 or a lost content-key race). */
export const MP_STORE_MAX_RETRIES=3;
/** Name of the content key of RD-MP-11 (src/postgres/mp-member-set.sql). Any other unique violation is a storage defect. */
const CONTENT_KEY='mp_member_sets_content_key';
const SERIALIZATION_FAILURE='40001',DEADLOCK_DETECTED='40P01',INSERT_GUARD='QR004',UNIQUE_VIOLATION='23505',CHECK_VIOLATION='23514';
const EXIT_FIELD='deployment.exit_version',PROBE_EXIT_VERSION='bridge-exit-v2';

const KEYS=['owner_id','bot_id','fixture','member_deployments','readBotState','member_set_id','created_at'];
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>=1&&value.length<=200;

const refusal=(code,diagnostic)=>({ok:false,code,diagnostic});
const invalid=field=>refusal(MP_CODES.INPUT_INVALID,{stage:'store',field});
/** Internal: the attempt must restart from the beginning (a lost content-key race: the winner is visible only to a new snapshot). */
class Restart extends Error {}

const BOT_ROWS=`SELECT m.pine_import_id,m.owner_id,m.bot_id,m.source_version,r.source_hash,m.connected,r.analysis
  FROM pine_memberships m JOIN pine_source_revisions r ON r.pine_import_id=m.pine_import_id AND r.source_version=m.source_version
  WHERE m.owner_id=$1 AND m.bot_id=$2 ORDER BY m.pine_import_id`;
const DEPLOYMENT_ROWS=`SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash FROM pine_deployments
  WHERE owner_id=$1 AND bot_id=$2 AND deployment_id=ANY($3::text[]) ORDER BY deployment_id`;
const EVIDENCE_ROWS=`SELECT deployment_id,snapshot_hash,evidence,evidence_hash FROM pine_bridge_evidence WHERE deployment_id=ANY($1::text[]) ORDER BY deployment_id`;
const JOB_ROWS=`SELECT result->>'deployment_id' AS deployment_id,CASE WHEN jsonb_typeof(result->'integrated_pine')='string' THEN result->>'integrated_pine' END AS artifact
  FROM pine_bridge_jobs WHERE owner_id=$1 AND bot_id=$2 AND operation='generate' AND status='SUCCEEDED'
  AND jsonb_typeof(result->'deployment_id')='string' AND result->>'deployment_id'=ANY($3::text[]) ORDER BY job_id`;
const FIND_SET=`SELECT record FROM mp_member_sets WHERE owner_id=$1 AND bot_id=$2 AND content_digest=$3`;
const INSERT_PARENT=`INSERT INTO mp_member_sets(member_set_id,owner_id,bot_id,version,pine_count,membership_hash,content_digest,set_hash,execution_model_hash,policy_hash,
  capital_basis_hash,funding_cutoff,bridge_atr_multiplier,bridge_rr,exit_version,same_bar_order,fixture,record,created_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
  ON CONFLICT ON CONSTRAINT ${CONTENT_KEY} DO NOTHING RETURNING member_set_id`;

/**
 * Bot state reader for the Bot of a member set, the same effective policy, capital basis and funding cutoff as freshSnapshot
 * (src/postgres/pine-bridge-readiness.js). `store` is the Store that wraps the same database as the db passed to freezeOrLoadMemberSet,
 * so every read runs inside the freeze transaction.
 */
export function storeBotState({store,defaultRisk}) {
  return async({bot_id})=>{
    const session=await store.getBotSession(bot_id);
    const policy=session.locked_policy?JSON.parse(session.locked_policy):await store.risk(bot_id,defaultRisk);
    const capital=await store.paperAccounts(bot_id);
    const funding=await store.db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(bot_id);
    return {policy_hash:hash(canonical(policy)),capital_basis_hash:hash(canonical(capital.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance})))),funding_cutoff:funding.cutoff};
  };
}

function readInput(input) {
  if(!isObject(input))return invalid('input');
  for(const key of Object.keys(input))if(!KEYS.includes(key))return invalid('input.'+key);
  if(!text(input.owner_id))return invalid('owner_id');
  if(!text(input.bot_id))return invalid('bot_id');
  if(typeof input.readBotState!=='function')return invalid('readBotState');
  const names=input.member_deployments;
  if(!Array.isArray(names)||names.length>1000||!names.every(row=>isObject(row)&&text(row.deployment_id)))return invalid('member_deployments');
  return null;
}

/**
 * Exit version of each named deployment, derived from the artifact of its one SUCCEEDED generate job. Returns a Map of deployment_id to
 * {exit_version} or {reason}: a refusal is kept per deployment and only reported when the S1 builder reaches that member (S1 check order wins).
 */
async function deriveExitVersions(db,input,deployments) {
  const found=new Map(),ids=deployments.map(row=>row.deployment_id);
  if(ids.length>0)
    for(const row of (await db.query(JOB_ROWS,[input.owner_id,input.bot_id,ids])).rows)found.set(row.deployment_id,[...(found.get(row.deployment_id)??[]),row.artifact]);
  const derived=new Map();
  for(const deployment of deployments) {
    const jobs=found.get(deployment.deployment_id)??[];
    if(jobs.length===0){derived.set(deployment.deployment_id,{reason:'GENERATE_JOB_MISSING'});continue;}
    if(jobs.length>1){derived.set(deployment.deployment_id,{reason:'GENERATE_JOB_DUPLICATE'});continue;}
    const out=deploymentExitVersion(jobs[0],deployment.snapshot,deployment.deployment_id);
    derived.set(deployment.deployment_id,out.ok?{exit_version:out.exit_version}:{reason:out.reason});
  }
  return derived;
}

/**
 * S1 refuses a deployment without an exit version with field 'deployment N.exit_version', N being its own member ordinal. The member is named from
 * S1 itself: build once more with a placeholder exit version on every deployment; that member set says which pine_import_id and deployment_id sit at
 * ordinal N. If that build does not complete (another defect sits behind this one), the member cannot be named from S1: when exactly one deployment has
 * a derived reason, the S1 refusal gets that reason and its deployment_id; otherwise it is returned as it is (no pine_import_id, no ordinal).
 */
function exitRefusal(built,base,deployments,derived) {
  const at=/^deployment (\d+)\.exit_version$/.exec(built.diagnostic?.field??'');
  if(built.code!==MP_CODES.INPUT_INVALID||!at)return built;
  const probe=buildMemberSet({...base,deployments:deployments.map(row=>({...row,exit_version:PROBE_EXIT_VERSION}))});
  if(!probe.ok) {
    const failed=[...derived].filter(([,out])=>out.reason!==undefined);
    return failed.length===1?refusal(MP_CODES.INPUT_INVALID,{...built.diagnostic,deployment_id:failed[0][0],reason:failed[0][1].reason}):built;
  }
  const member=probe.member_set.members[Number(at[1])-1],failure=member===undefined?undefined:derived.get(member.deployment_id);
  if(failure?.reason===undefined)return built;
  return refusal(MP_CODES.INPUT_INVALID,{stage:'member',ordinal:member.ordinal,pine_import_id:member.pine_import_id,deployment_id:member.deployment_id,field:EXIT_FIELD,reason:failure.reason});
}

/** One attempt, inside the SERIALIZABLE transaction. loadOnly: read-only, no lock and no insert (the last resort after the retries). */
async function attempt(db,input,identity,loadOnly) {
  if(loadOnly)await db.query('SET TRANSACTION READ ONLY');
  const lock=loadOnly?'':' FOR SHARE';
  // 1. Lock and read the Bot's memberships (all of them, connected or not), then the named deployments of this owner and Bot only.
  const memberships=(await db.query(BOT_ROWS+(loadOnly?'':' FOR SHARE OF m'),[input.owner_id,input.bot_id])).rows;
  const names=input.member_deployments;
  const deployments=(await db.query(DEPLOYMENT_ROWS+lock,[input.owner_id,input.bot_id,names.map(row=>row.deployment_id)])).rows;
  const ids=deployments.map(row=>row.deployment_id);
  const evidence=ids.length>0?(await db.query(EVIDENCE_ROWS,[ids])).rows:[];
  const bot_state=await input.readBotState({bot_id:input.bot_id});
  const derived=await deriveExitVersions(db,input,deployments);
  // 2. Build. member_deployments go to S1 as the caller sent them, so its closed-key check refuses an extra key. A deployment whose exit version
  // could not be derived carries none, so S1 refuses it at its member (after the S1 checks before it).
  const base={owner_id:input.owner_id,bot_id:input.bot_id,memberships,bot_state,evidence,fixture:input.fixture,member_set_id:identity.member_set_id,created_at:identity.created_at,member_deployments:names};
  const built=buildMemberSet({...base,deployments:deployments.map(row=>({...row,...(derived.get(row.deployment_id)?.exit_version!==undefined?{exit_version:derived.get(row.deployment_id).exit_version}:{})}))});
  if(!built.ok)return exitRefusal(built,base,deployments,derived);
  const candidate=built.member_set;
  // 3. Load by content digest (S1 decideFreeze re-checks every stored record), else freeze.
  const select=async()=>(await db.query(FIND_SET,[candidate.owner_id,candidate.bot_id,candidate.content_digest])).rows.map(row=>row.record);
  const decide=async()=>{
    const stored=await select();
    if(stored.length===0)return null;
    const decision=decideFreeze(candidate,stored);
    return decision.ok?{ok:true,action:decision.action,member_set:decision.member_set}:decision;
  };
  const loaded=await decide();
  if(loaded!==null||loadOnly)return loaded;
  const parent=await db.query(INSERT_PARENT,[candidate.member_set_id,candidate.owner_id,candidate.bot_id,candidate.version,candidate.pine_count,candidate.membership_hash,candidate.content_digest,
    candidate.set_hash,candidate.execution_model_hash,candidate.policy_hash,candidate.capital_basis_hash,candidate.funding_cutoff,candidate.bridge_pair.atr_multiplier,candidate.bridge_pair.rr,
    candidate.exit_version,candidate.same_bar_order,candidate.fixture,JSON.stringify(candidate),candidate.created_at]);
  // No row back: an equal set won the race. This snapshot cannot show it, so restart; the new snapshot finds the winner and loads it.
  if(parent.rows.length===0)throw new Restart();
  const columns=['member_set_id','ordinal','owner_id','bot_id','pine_import_id','source_version','source_hash','effective_inputs_hash','deployment_id','deployment_snapshot_hash','exit_version','evidence_hash'];
  const values=[],rows=candidate.members.map((member,i)=>{
    const row=[candidate.member_set_id,member.ordinal,candidate.owner_id,candidate.bot_id,member.pine_import_id,member.source_version,member.source_hash,member.effective_inputs_hash,
      member.deployment_id,member.deployment_snapshot_hash,member.exit_version,member.evidence_hash];
    values.push(...row);
    return '('+row.map((_,j)=>'$'+(i*columns.length+j+1)).join(',')+')';
  });
  await db.query(`INSERT INTO mp_member_set_members(${columns.join(',')}) VALUES ${rows.join(',')}`,values);
  return {ok:true,action:'FREEZE',member_set:candidate};
}

/** Map a database error to a refusal, to 'retry' or to null (not ours: rethrow). */
function classify(error) {
  const code=error?.code;
  if(code===INSERT_GUARD)return refusal(MP_CODES.MEMBER_SET_STALE,{stage:'store',field:'insert_guard',guard:error.constraint??null});
  if(code===SERIALIZATION_FAILURE||code===DEADLOCK_DETECTED||error instanceof Restart||(code===UNIQUE_VIOLATION&&error.constraint===CONTENT_KEY))return 'retry';
  if(code===CHECK_VIOLATION||code===UNIQUE_VIOLATION)return refusal(MP_CODES.INPUT_INVALID,{stage:'store',field:'storage',sqlstate:code,constraint:error.constraint??null});
  return null;
}

/**
 * Freeze the member set of a Bot, or load the equal set that was already frozen. `db` is a PostgresDatabase that is not inside a transaction.
 * input: {owner_id, bot_id, fixture:true, member_deployments:[{pine_import_id,deployment_id}], readBotState({bot_id}), member_set_id?, created_at?}.
 * member_set_id and created_at default to a server-generated UUID and the current UTC time; they sit outside the content digest.
 */
export async function freezeOrLoadMemberSet(db,input) {
  const bad=readInput(input);
  if(bad!==null)return bad;
  if(db.isTransaction)return invalid('db.transaction');
  const identity={member_set_id:input.member_set_id??randomUUID(),created_at:input.created_at??new Date().toISOString()};
  let last;
  for(let tries=0;tries<=MP_STORE_MAX_RETRIES;tries++) {
    try {return await db.transaction(()=>attempt(db,input,identity,false),{isolation:'SERIALIZABLE'});}
    catch(error) {
      const mapped=classify(error);
      if(mapped===null)throw error;
      if(mapped!=='retry')return mapped;
      last=error;
    }
  }
  // RD-MP-15: after the bounded retries, load. The last resort is a read-only transaction that takes no lock and writes nothing.
  try {
    const loaded=await db.transaction(()=>attempt(db,input,identity,true),{isolation:'SERIALIZABLE'});
    if(loaded!==null)return loaded;
  } catch(error) {
    if(classify(error)===null)throw error;
  }
  throw last instanceof Restart?Object.assign(new Error('Member set freeze could not settle'),{code:SERIALIZATION_FAILURE}):last;
}
