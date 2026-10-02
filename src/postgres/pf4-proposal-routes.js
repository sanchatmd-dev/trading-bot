import {fail} from '../pine-bridge/source.js';
import {readJson} from './http.js';

/**
 * PF-4 routes: POST /api/risk/proposals/preview (read only) and POST /api/risk/proposals/apply (the confirmed save).
 * Dispatched inside userRoutes after the session, the own:write permission, the CSRF and origin checks and the bot
 * selection (one bot owned by the actor, never All). Same permission as PUT /api/risk and, like it, no step-up. The one
 * accepted query key is bot_id, sent by the shared api() helper.
 */
export const PF4_PREVIEW_PATH='/api/risk/proposals/preview';
export const PF4_APPLY_PATH='/api/risk/proposals/apply';

function singleBotQuery(url){
  const entries=[...url.searchParams.entries()];
  if(entries.length>1||entries.some(([key,value])=>key!=='bot_id'||!value))throw fail('INVALID_FIELDS');
}

export async function pf4ProposalRoutes(req,res,url,{actor,user},service,json){
  if(url.pathname!==PF4_PREVIEW_PATH&&url.pathname!==PF4_APPLY_PATH)return false;
  if(req.method!=='POST')throw fail('METHOD_NOT_ALLOWED',405);
  singleBotQuery(url);
  const body=await readJson(req);
  json(res,200,url.pathname===PF4_PREVIEW_PATH?await service.preview(actor.id,user.id,body):await service.apply(actor.id,user.id,body));
  return true;
}
