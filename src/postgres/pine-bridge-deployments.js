import {fail} from '../pine-bridge/source.js';

/**
 * Read-only, owner-scoped list of one Bot's Bridge deployments for the Build Pine Bridge panel. It lets the owner
 * activate a stored DRAFT for Paper after the page that generated it is gone. Only identifiers, state, timestamps,
 * the market and the owner's own source label leave this module. The snapshot, evidence, Pine source, job results,
 * capture tokens and webhook secrets stay in the database. No write, no row lock.
 */
export const DEPLOYMENT_LIST_LIMIT=20;
const MAX_TEXT=120;

const text=(value,cap=MAX_TEXT)=>typeof value==='string'?value.slice(0,cap):null;

// bot_id is the only parameter and it must appear exactly once. The shared api() helper of the web UI always sends it.
export function deploymentListBot(url){
  for(const key of url.searchParams.keys())if(key!=='bot_id')throw fail('INVALID_FIELDS');
  const bots=url.searchParams.getAll('bot_id');
  if(bots.length!==1||bots[0]==='')throw fail('INVALID_FIELDS');
  return bots[0];
}

// Newest first. authorize() answers NOT_FOUND for a Bot the owner does not own, before any deployment is read.
export async function listDeployments(service,owner,bot){
  await service.authorize(owner,bot);
  const {rows}=await service.db.query(`SELECT d.deployment_id,d.state,d.created_at,d.source_version,s.source_name,
      d.snapshot->'market'->>'broker' AS broker,d.snapshot->'market'->>'symbol' AS symbol,d.snapshot->'market'->>'timeframe' AS timeframe
    FROM pine_deployments d JOIN pine_sources s ON s.pine_import_id=d.pine_import_id
    WHERE d.owner_id=$1 AND d.bot_id=$2 ORDER BY d.created_at DESC,d.deployment_id DESC LIMIT ${DEPLOYMENT_LIST_LIMIT}`,[owner,bot]);
  return {bot_id:bot,deployments:rows.map(row=>({deployment_id:row.deployment_id,state:row.state,created_at:row.created_at,
    source_version:row.source_version,source_name:text(row.source_name),
    market:{broker:text(row.broker,32),symbol:text(row.symbol,32),timeframe:text(row.timeframe,16)}}))};
}
