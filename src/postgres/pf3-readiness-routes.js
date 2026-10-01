import {fail} from '../pine-bridge/source.js';

/**
 * PF-3 route: GET /api/risk/readiness-report. Dispatched inside userRoutes, after the session, the own:read
 * permission and the bot selection (the bot is owned by the actor and is exactly one bot). Read only: any other
 * method is refused, nothing is saved and no job starts. The one accepted query key is bot_id, sent by the shared
 * api() helper, and it must appear once with a value.
 */
export const PF3_REPORT_PATH='/api/risk/readiness-report';

function singleBotQuery(url){
  const entries=[...url.searchParams.entries()];
  if(entries.length>1||entries.some(([key,value])=>key!=='bot_id'||!value))throw fail('INVALID_FIELDS');
}

export async function pf3ReadinessRoutes(req,res,url,{actor,user},service,json){
  if(url.pathname!==PF3_REPORT_PATH)return false;
  if(req.method!=='GET')throw fail('METHOD_NOT_ALLOWED',405);
  singleBotQuery(url);
  json(res,200,await service.report(actor.id,user.id));
  return true;
}
