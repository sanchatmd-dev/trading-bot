import {fail} from '../pine-bridge/source.js';

/**
 * Read-only, owner-scoped list of preserved Quant research runs for the staging journey view.
 * It runs before the research routes so history stays readable while new-job admission is closed.
 * Only whitelisted summary fields leave this module: contracts (Pine source, market bars), step
 * payloads and full results stay in the database. No write, no row lock, no executor-mode check.
 */
const PATH='/api/quant/research/history';
const DEFAULT_LIMIT=10,MAX_LIMIT=20,MAX_SLOTS=10,MAX_GRID=1000,MAX_SUMMARY_KEYS=20,MAX_TEXT=500;

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const text=(value,cap=MAX_TEXT)=>typeof value==='string'?value.slice(0,cap):null;
const scalar=value=>typeof value==='string'?value.slice(0,200):typeof value==='boolean'?value:finite(value);
const count=value=>typeof value==='string'&&/^\d{1,9}$/.test(value)?Number(value):null;

function limitOf(url){
  const values=url.searchParams.getAll('limit');
  if(!values.length)return DEFAULT_LIMIT;
  if(values.length!==1||!/^\d{1,3}$/.test(values[0]))throw fail('INVALID_LIMIT');
  const limit=Number(values[0]);
  if(limit<1||limit>MAX_LIMIT)throw fail('INVALID_LIMIT');
  return limit;
}
// bot_id is sent by the shared api() helper. History is owner-scoped, so the value is ignored.
function knownQuery(url){
  for(const key of url.searchParams.keys())if(!['limit','bot_id'].includes(key))throw fail('INVALID_FIELDS');
}

const domain=value=>isObject(value)?{min:finite(value.min),max:finite(value.max),step:finite(value.step)}:null;
const slots=value=>Array.isArray(value)?value.slice(0,MAX_SLOTS).filter(isObject).map(slot=>({
  slot:finite(slot.slot),input_id:text(slot.input_id,64),pine_variable:text(slot.pine_variable,100),
  effective_value:scalar(slot.effective_value),search_domain:domain(slot.search_domain)})):null;
const grid=value=>Array.isArray(value)?value.filter(item=>finite(item)!==null).slice(0,MAX_GRID):null;
function bridgeDomains(row){
  const atr=grid(row.atr_multiplier),rr=grid(row.rr);
  return atr===null&&rr===null?null:{atr_multiplier:atr,rr};
}
// Same top-level scalars the result carries (reason, counts, hashes); nested candidates never leave the database.
function resultSummary(value){
  if(!isObject(value))return null;
  const summary={};
  for(const [key,item] of Object.entries(value)){
    if(Object.keys(summary).length>=MAX_SUMMARY_KEYS)break;
    if(typeof item==='string')summary[key]=item.slice(0,MAX_TEXT);
    else if(typeof item==='boolean'||finite(item)!==null)summary[key]=item;
  }
  return summary;
}

// Field derivations mirror QuantResearchService.summary(); contract values are read through JSON paths, never in full.
const LIST=`SELECT j.run_id,j.bot_id,j.deployment_id,j.status,j.phase,j.created_at,j.updated_at,j.attempt,
 j.evaluations_started,j.contract_hash,j.diagnostic,
 j.contract->>'source_hash' AS source_hash,
 j.contract->>'baseline_snapshot_hash' AS baseline_snapshot_hash,
 j.contract->'input_lock'->>'lock_hash' AS input_lock_hash,
 j.contract->'dataset'->>'sha256' AS dataset_sha256,
 j.contract->'dataset'->>'content_digest' AS dataset_content_digest,
 j.contract->'plan'->>'planned_candidates' AS planned_candidates,
 j.contract->'input_lock'->'selection'->'bindings' AS bindings,
 j.contract->'input_lock'->'domains'->'atr_multiplier' AS atr_multiplier,
 j.contract->'input_lock'->'domains'->'rr' AS rr,
 (SELECT count(*)::int FROM quant_job_steps s WHERE s.run_id=j.run_id AND s.kind='CANDIDATE') AS candidates_completed,
 CASE WHEN j.result IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM
  (SELECT key,value FROM jsonb_each(CASE WHEN jsonb_typeof(j.result)='object' THEN j.result ELSE '{}'::jsonb END)
   WHERE jsonb_typeof(value) IN ('string','number','boolean') ORDER BY key LIMIT ${MAX_SUMMARY_KEYS}) e),'{}'::jsonb) END AS result_summary
 FROM quant_jobs j WHERE j.owner_id=$1 ORDER BY j.created_at DESC,j.run_id DESC LIMIT $2`;

function shape(row){
  return {run_id:row.run_id,bot_id:row.bot_id,deployment_id:row.deployment_id,status:row.status,phase:row.phase,
    created_at:row.created_at,updated_at:row.updated_at,attempts:row.attempt,evaluations_started:row.evaluations_started,
    contract_hash:row.contract_hash,source_hash:text(row.source_hash,128),baseline_snapshot_hash:text(row.baseline_snapshot_hash,128),
    input_lock_hash:text(row.input_lock_hash,128),dataset_hash:text(row.dataset_sha256,128)??text(row.dataset_content_digest,128),
    source_slots:slots(row.bindings),bridge_domains:bridgeDomains(row),
    candidates_completed:row.candidates_completed,candidates_planned:count(row.planned_candidates),
    result_summary:resultSummary(row.result_summary),diagnostic:text(row.diagnostic),owner_recommendation_ready:false};
}

export async function researchHistory(db,owner,limit,{admissionEnabled=false}={}){
  const present=(await db.query('SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS present',['quant_jobs','quant_job_steps'])).rows[0].present;
  const body={admission_enabled:admissionEnabled===true,total_runs:0,runs:[]};
  if(!present)return body;
  body.total_runs=(await db.query('SELECT count(*)::int AS total FROM quant_jobs WHERE owner_id=$1',[owner])).rows[0].total;
  body.runs=(await db.query(LIST,[owner,limit])).rows.map(shape);
  return body;
}

export async function quantResearchHistoryRoutes(req,res,url,actor,db,json,{admissionEnabled=false}={}){
  if(url.pathname!==PATH)return false;
  if(req.method!=='GET')throw fail('METHOD_NOT_ALLOWED',405);
  knownQuery(url);
  json(res,200,await researchHistory(db,actor.id,limitOf(url),{admissionEnabled}));
  return true;
}
