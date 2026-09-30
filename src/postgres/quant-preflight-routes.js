import {fail,keys} from '../pine-bridge/source.js';
import {readJson} from './http.js';

function botQuery(url){
  const entries=[...url.searchParams.entries()];
  if(entries.length>1||entries.some(([key,value])=>key!=='bot_id'||!value))throw fail('INVALID_FIELDS');
  return entries[0]?.[1]??null;
}
function sameBot(bot,body){if(bot!==null&&bot!==body?.bot_id)throw fail('INVALID_FIELDS');}

/** Called only inside the application's authenticated transaction handler. */
export async function quantPreflightRoutes(req,res,url,actor,service,json,{enabled=false}={}){
  const prefix='/api/quant/data/preflights',holdout='/api/quant/data/holdout-boundaries';
  if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/')&&
    url.pathname!==holdout&&!url.pathname.startsWith(holdout+'/'))return false;
  const bot=botQuery(url);
  if(!enabled)throw fail('PREFLIGHT_DISABLED',503);
  if(url.pathname===prefix){
    if(req.method==='POST'){
      const body=await readJson(req);sameBot(bot,body);
      json(res,202,await service.enqueue(actor.id,body,req.headers['idempotency-key']));return true;
    }
    if(req.method==='GET'){
      if(bot===null)throw fail('INVALID_FIELDS');
      json(res,200,await service.list(actor.id,bot));return true;
    }
  }
  if(url.pathname===holdout){
    if(req.method==='GET'){
      if(bot===null)throw fail('INVALID_FIELDS');
      json(res,200,await service.getHoldoutBoundary(actor.id,bot));return true;
    }
    if(req.method==='POST'){
      const body=await readJson(req);sameBot(bot,body);
      json(res,200,await service.registerHoldoutBoundary(actor.id,body));return true;
    }
  }
  const match=url.pathname.startsWith(prefix+'/')&&url.pathname.slice(prefix.length)
    .match(/^\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\/cancel)?$/);
  if(match&&((req.method==='GET'&&!match[2])||(req.method==='POST'&&match[2]))){
    if(match[2])keys(await readJson(req),[]);
    json(res,200,await service.get(actor.id,match[1],!!match[2],bot));return true;
  }
  throw fail('NOT_FOUND',404);
}

/** Enrollment accepts identifiers only; the service builds all evidence. */
export async function quantProfileEnrollmentRoutes(req,res,url,actor,service,json,{enabled=false}={}){
  const prefix='/api/quant/data/profile-enrollments';
  if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
  const bot=botQuery(url);
  if(!enabled)throw fail('QUANT_PROFILE_ENROLLMENT_DISABLED',503);
  if(url.pathname!==prefix||req.method!=='POST')throw fail('NOT_FOUND',404);
  const body=await readJson(req);sameBot(bot,body);
  json(res,202,await service.enqueueEnrollment(actor.id,body,req.headers['idempotency-key']));return true;
}
