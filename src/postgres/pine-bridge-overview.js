import {fail} from '../pine-bridge/source.js';

/**
 * Read-only, owner-scoped Bridge status for the staging journey view. It runs before pineBridgeRoutes, which
 * rejects every Bridge path while the Bridge is disabled, so a closed Bridge still answers with a plain status.
 * Only counts, identifiers, hashes, timestamps and totals leave this module: Pine source, requests, job results
 * (draft Pine, guide), provider request ids, idempotency keys, provider credentials and capture paths stay in the
 * database or the process. No write, no row lock.
 */
const PATH='/api/quant/pine-bridge/overview';
const MAX_TEXT=500;

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,cap=MAX_TEXT)=>typeof value==='string'?value.slice(0,cap):null;

// bot_id is sent by the shared api() helper. The overview is owner-scoped, so the value is ignored.
function knownQuery(url){
  for(const key of url.searchParams.keys())if(key!=='bot_id')throw fail('INVALID_FIELDS');
}

// Same configuration the Bridge AI jobs use. Names and values of credentials, rates and endpoints are never returned.
function aiStatus(service){
  try{
    const config=service.getProvider();
    if(isObject(config)&&typeof config.provider==='string'&&typeof config.model==='string')
      return {provider:text(config.provider,64),model:text(config.model,64),configured:true};
  }catch{/* not configured */}
  return {provider:null,model:null,configured:false};
}

function usageSummary(usage){
  if(!Array.isArray(usage))return null;
  const total={input_tokens:0,output_tokens:0,cost_usd:0};
  let recorded=false;
  for(const item of usage){
    if(!isObject(item))continue;
    for(const key of Object.keys(total)){
      const value=item[key];
      if(typeof value==='number'&&Number.isFinite(value)&&value>=0){total[key]+=value;recorded=true;}
    }
  }
  return recorded?{...total,cost_usd:Number(total.cost_usd.toFixed(8))}:null;
}

// Counts come from the stored analysis and input review; anything not recorded stays null instead of a guess.
function numericInputs(analysis,sourceHash,selectedSlots){
  if(!isObject(analysis)||!Array.isArray(analysis.inputs))return null;
  const numeric=analysis.inputs.filter(input=>isObject(input)&&['int','float'].includes(input.type));
  const review=analysis.effective_input_review;
  return {total:numeric.length,eligible:numeric.filter(input=>input.eligible===true).length,
    reviewed:isObject(review)&&review.source_hash===sourceHash&&review.effective_inputs_hash===analysis.effective_inputs_hash&&
      Number.isSafeInteger(review.reviewed_at),
    selected_slots:selectedSlots};
}

const tally=(rows,key)=>Object.fromEntries(rows.map(row=>[row[key],row.n]));

export async function bridgeOverview(service,owner,{captureEnabled=false}={}){
  const db=service.db;
  const one=async(sql,params)=>(await db.query(sql,params)).rows[0]??null;
  const sourceCount=(await one('SELECT count(*)::int AS n FROM pine_sources WHERE owner_id=$1',[owner])).n;
  const revision=await one(`SELECT s.pine_import_id,s.source_name,r.source_version,r.source_hash,r.created_at,r.analysis
    FROM pine_source_revisions r JOIN pine_sources s ON s.pine_import_id=r.pine_import_id WHERE s.owner_id=$1
    ORDER BY r.created_at DESC,r.source_version DESC,s.pine_import_id DESC LIMIT 1`,[owner]);
  let latestSource=null;
  if(revision){
    // Slots of the newest generated deployment for this source version; null while no draft was generated.
    const deployment=await one(`SELECT CASE WHEN jsonb_typeof(snapshot->'selection'->'bindings')='array'
      THEN jsonb_array_length(snapshot->'selection'->'bindings') END AS slots FROM pine_deployments
      WHERE owner_id=$1 AND pine_import_id=$2 AND source_version=$3 ORDER BY created_at DESC,deployment_id DESC LIMIT 1`,
    [owner,revision.pine_import_id,revision.source_version]);
    latestSource={pine_import_id:revision.pine_import_id,source_name:text(revision.source_name,120),source_version:revision.source_version,
      source_hash:revision.source_hash,created_at:revision.created_at,
      numeric_inputs:numericInputs(revision.analysis,revision.source_hash,deployment?.slots??null)};
  }
  const jobStatus=(await db.query('SELECT status,count(*)::int AS n FROM pine_bridge_jobs WHERE owner_id=$1 GROUP BY status ORDER BY status',[owner])).rows;
  const job=await one(`SELECT job_id,operation,status,created_at,updated_at,attempt,usage,diagnostic,
    COALESCE(jsonb_typeof(result->'integrated_pine')='string',false) AS has_draft
    FROM pine_bridge_jobs WHERE owner_id=$1 ORDER BY created_at DESC,job_id DESC LIMIT 1`,[owner]);
  const states=(await db.query('SELECT state,count(*)::int AS n FROM pine_deployments WHERE owner_id=$1 GROUP BY state ORDER BY state',[owner])).rows;
  const ready=await one(`SELECT deployment_id,source_version,snapshot_hash,created_at FROM pine_deployments
    WHERE owner_id=$1 AND state='READY' ORDER BY created_at DESC,deployment_id DESC LIMIT 1`,[owner]);
  return {bridge_enabled:true,capture_enabled:captureEnabled===true,ai:aiStatus(service),
    sources:{count:sourceCount,latest:latestSource},
    jobs:{by_status:tally(jobStatus,'status'),
      latest:job&&{job_id:job.job_id,operation:job.operation,job_status:job.status,created_at:job.created_at,updated_at:job.updated_at,
        attempts:job.attempt,usage_summary:usageSummary(job.usage),diagnostic:text(job.diagnostic),has_draft:job.has_draft===true}},
    deployments:{by_state:tally(states,'state'),
      latest_ready:ready&&{deployment_id:ready.deployment_id,source_version:ready.source_version,snapshot_hash:ready.snapshot_hash,created_at:ready.created_at}}};
}

export async function pineBridgeOverviewRoutes(req,res,url,actor,service,json,{enabled=false,captureEnabled=false}={}){
  if(url.pathname!==PATH)return false;
  if(req.method!=='GET')throw fail('METHOD_NOT_ALLOWED',405);
  knownQuery(url);
  json(res,200,enabled?await bridgeOverview(service,actor.id,{captureEnabled}):{bridge_enabled:false});
  return true;
}
