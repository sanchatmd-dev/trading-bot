import {readJson} from './http.js';
import {hasPermission} from '../permissions.js';

// QR-2 S4-4: append-only owner declarations. The dispatcher owns the short SERIALIZABLE transaction and rollback/retry.
export const QR2_CAPITAL_MODEL_PATH='/api/paper-capital-model';
export const QR2_CAPITAL_MODEL_EVENT='qr2.capital_model_declared';
const DAY=86400000,MAX_TIME=253402300799999;
const CURRENCIES=['USDT','THB'],MODELS=['INDEPENDENT_ACCOUNTS','SHARED_HYPOTHETICAL'];

class DeclarationError extends Error{
  constructor(code,status=503){super('Paper capital model declaration could not be completed');this.code=code;this.status=status;}
}
const unavailable=()=>new DeclarationError('QR2_CAPITAL_MODEL_UNAVAILABLE');
const refused=()=>new DeclarationError('QR2_CAPITAL_MODEL_DECLARATION_REFUSED');
const nextMidnight=at=>Math.floor(at/DAY)*DAY+DAY;
const validTime=at=>Number.isSafeInteger(at)&&at>=0&&at<=MAX_TIME;

/** Maps only known declaration constraints. Transaction errors must reach the dispatcher's fresh-attempt loop unchanged. */
export function mapCapitalModelFailure(error){
  if(error instanceof DeclarationError)return error;
  if(['40001','40P01'].includes(error?.code))return null;
  if(['42P01','42883','42501'].includes(error?.code))return unavailable();
  if(error?.code==='QR004'){
    const known={paper_capital_models_owner:()=>new DeclarationError('QR2_NOT_OWNER',404),paper_capital_models_version:refused,
      paper_capital_models_clock:refused,paper_capital_models_bot_set:()=>new DeclarationError('QR2_CAPITAL_MODEL_BOT_SET_INVALID',400)};
    if(Object.hasOwn(known,error.constraint))return known[error.constraint]();
  }
  if(error?.code==='23514'){
    if(['paper_capital_models_currency_check','paper_capital_models_capital_model_check','paper_capital_models_bot_set_check'].includes(error.constraint))return new DeclarationError('QR2_INPUT_INVALID',400);
    if(['paper_capital_models_effective_from_check','paper_capital_models_declared_at_check','paper_capital_models_version_check'].includes(error.constraint))return refused();
  }
  return refused();
}

/** Server-only writer. The actor and Bot set are resolved under the same owner lock createBot uses; no caller clock or Bot list exists. */
export async function appendCapitalModelDeclaration(store,{ownerId,currency,capitalModel}){
  const db=store.db;
  if(!CURRENCIES.includes(currency)||!MODELS.includes(capitalModel))throw new DeclarationError('QR2_INPUT_INVALID',400);
  if(!db.isTransaction)throw refused();
  try{
    const isolation=(await db.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
    if(isolation!=='serializable')throw refused();
    // Both this writer and createBot touch the owner tuple. A stale SERIALIZABLE snapshot then retries after a wait.
    const owner=(await db.query('UPDATE public.users SET label=label WHERE id=$1 RETURNING id,parent_user_id,role,status',[ownerId])).rows[0];
    if(!owner||owner.parent_user_id!==null||owner.status!=='ACTIVE'||!hasPermission(owner,'own:write'))throw new DeclarationError('QR2_NOT_OWNER',404);
    const extension=(await db.query("SELECT to_regclass('public.paper_capital_model_schema') IS NOT NULL AND to_regclass('public.paper_capital_models') IS NOT NULL AND to_regprocedure('public.paper_capital_model_now_ms()') IS NOT NULL AS present")).rows[0];
    if(!extension.present)throw unavailable();
    const marker=(await db.query('SELECT version FROM public.paper_capital_model_schema')).rows;
    if(marker.length!==1||Number(marker[0].version)!==1)throw unavailable();
    const botSet=(await db.query('SELECT id FROM public.users WHERE id=$1 OR parent_user_id=$1 ORDER BY id COLLATE "C"',[ownerId])).rows.map(row=>row.id);
    if(botSet.length<1||botSet.length>5)throw new DeclarationError('QR2_CAPITAL_MODEL_BOT_SET_INVALID',400);
    const previous=(await db.query('SELECT version FROM public.paper_capital_models WHERE owner_id=$1 AND currency=$2 ORDER BY version DESC LIMIT 1',[ownerId,currency])).rows[0];
    const version=previous?Number(previous.version)+1:1;
    if(version>1000)throw new DeclarationError('QR2_CAPITAL_MODEL_LIMIT_REACHED',422);
    const sampled=Number((await db.query('SELECT public.paper_capital_model_now_ms() AS at')).rows[0].at),effective=nextMidnight(sampled);
    if(!validTime(sampled)||!validTime(effective))throw refused();
    const row=(await db.query(`INSERT INTO public.paper_capital_models(owner_id,currency,version,capital_model,bot_set,effective_from,declared_at,declared_by)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,0,$1) RETURNING owner_id,currency,version,capital_model,bot_set,effective_from,declared_at,declared_by`,
      [ownerId,currency,version,capitalModel,JSON.stringify(botSet),effective])).rows[0];
    if(!row)throw refused();
    const stamped=Number(row.declared_at),storedEffective=Number(row.effective_from);
    // The schema permits equality at midnight. The API requires the NEXT midnight, so a returned boundary stamp proves a rollover.
    if(validTime(stamped)&&stamped>=sampled&&stamped===effective&&storedEffective===effective){
      throw Object.assign(new Error('Declaration clock crossed UTC midnight'),{code:'40001'});
    }
    if(!validTime(stamped)||storedEffective!==nextMidnight(stamped)||storedEffective!==effective||row.owner_id!==ownerId||row.declared_by!==ownerId||
      row.currency!==currency||row.capital_model!==capitalModel||Number(row.version)!==version||JSON.stringify(row.bot_set)!==JSON.stringify(botSet))throw refused();
    await store.audit(ownerId,QR2_CAPITAL_MODEL_EVENT,null,{currency,capital_model:capitalModel,version,effective_from:storedEffective,bot_count:botSet.length});
    return {owner_id:ownerId,currency,version,capital_model:capitalModel,bot_set:[...botSet],effective_from:storedEffective,declared_at:stamped,declared_by:ownerId};
  }catch(error){
    const mapped=mapCapitalModelFailure(error);
    throw mapped??error;
  }
}

export async function qr2CapitalModelRoute(req,res,url,actor,{store,auth,json,enabled}){
  if(url.pathname!==QR2_CAPITAL_MODEL_PATH||enabled!==true)return false;
  if(req.method!=='PUT'){json(res,405,{error:'Method not allowed'});return true;}
  // Authentication and unsafe-method CSRF are canonical auth.require checks, never a second declaration-specific token.
  const session=await auth.require(req);
  if(!session||session.id!==actor.id)throw new DeclarationError('QR2_NOT_OWNER',404);
  await auth.sensitive(req);
  const body=await readJson(req);
  if([...url.searchParams].length||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||
    Object.keys(body).some(key=>!['currency','capital_model'].includes(key))||!CURRENCIES.includes(body.currency)||!MODELS.includes(body.capital_model))throw new DeclarationError('QR2_INPUT_INVALID',400);
  const declaration=await appendCapitalModelDeclaration(store,{ownerId:session.id,currency:body.currency,capitalModel:body.capital_model});
  json(res,200,{ok:true,declaration});
  return true;
}
