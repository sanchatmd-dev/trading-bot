/**
 * Optional per-plan quota for AI jobs (Pine Bridge analyze and generate).
 *
 * The quota is off unless the operator sets PINE_BRIDGE_AI_QUOTA, a JSON object such as
 *   {"default":{"analyze_per_day":20,"generate_per_day":10},"plans":{"pro":{"analyze_per_day":100}}}
 * An absent or blank variable, or a config without any limit, disables the quota completely: no query runs.
 * A config that is set but wrong is never ignored; parseAiQuota throws so startup fails with a clear message.
 *
 * Plan source: the active license plan of the owner (store.activePlan, "FREE" without a license), compared without
 * regard to case. A plan entry overrides the default for the fields it names and inherits the rest. A kind without
 * any configured limit stays unlimited. A limit of 0 means the plan has none of that kind.
 *
 * Usage is the number of the owner's own jobs of that kind created in the trailing 24 hours, read from
 * pine_bridge_jobs (no new table). Every status counts: the table does not record whether the provider was reached,
 * and a rejected or cancelled job is still a request against the plan.
 */
const DAY_MS=86_400_000;
const MAX_LIMIT=1_000_000;
const OPERATIONS=Object.freeze({
  analyze:Object.freeze({field:'analyze_per_day',noun:'analyses'}),
  generate:Object.freeze({field:'generate_per_day',noun:'generations'})
});
const LIMIT_FIELDS=Object.freeze(Object.values(OPERATIONS).map(item=>item.field));
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>new Error('Invalid PINE_BRIDGE_AI_QUOTA: '+message);
const shown=value=>JSON.stringify(String(value)).slice(0,60);
const planKey=value=>String(value??'').trim().toUpperCase();

function parseLimits(value,where){
  if(value===undefined)return Object.freeze({});
  if(!isObject(value))throw invalid(where+' must be an object');
  const limits={};
  for(const [field,limit] of Object.entries(value)){
    if(!LIMIT_FIELDS.includes(field))throw invalid(where+' has the unknown field '+shown(field)+' (allowed: '+LIMIT_FIELDS.join(', ')+')');
    if(!Number.isSafeInteger(limit)||limit<0||limit>MAX_LIMIT)throw invalid(where+'.'+field+' must be a whole number from 0 to '+MAX_LIMIT);
    limits[field]=limit;
  }
  return Object.freeze(limits);
}

/**
 * Parses the PINE_BRIDGE_AI_QUOTA value. Returns null when the quota is disabled, otherwise a frozen config.
 * Throws an Error with a clear message for anything that is not a valid config.
 */
export function parseAiQuota(raw){
  if(raw===undefined||raw===null)return null;
  if(typeof raw!=='string')throw invalid('the value must be a JSON string');
  if(raw.trim()==='')return null;
  let value;
  try{value=JSON.parse(raw);}catch{throw invalid('the value is not valid JSON');}
  if(!isObject(value))throw invalid('the value must be a JSON object');
  for(const key of Object.keys(value))if(!['default','plans'].includes(key))throw invalid('unknown top-level key '+shown(key)+' (allowed: default, plans)');
  const defaults=parseLimits(value.default,'default'),plans=new Map();
  if(value.plans!==undefined){
    if(!isObject(value.plans))throw invalid('plans must be an object');
    for(const [name,limits] of Object.entries(value.plans)){
      const key=planKey(name);
      if(key===''||key.length>64||/[\u0000-\u001f\u007f]/.test(key))throw invalid('plan name '+shown(name)+' must be 1 to 64 printable characters');
      if(plans.has(key))throw invalid('plan '+shown(name)+' is listed twice (plan names ignore case)');
      plans.set(key,parseLimits(limits,'plans.'+name));
    }
  }
  const limited=[defaults,...plans.values()].some(item=>Object.keys(item).length>0);
  return limited?Object.freeze({default:defaults,plans}):null;
}

/** The limit that applies to a plan and a kind of job, or null when that kind is unlimited for the plan. */
export function aiLimitFor(config,plan,operation){
  const kind=OPERATIONS[operation];
  if(!config||!kind)return null;
  const limit=config.plans.get(planKey(plan))?.[kind.field]??config.default[kind.field];
  return limit===undefined?null:limit;
}

/**
 * Throws a 429 AI_QUOTA_EXCEEDED error when the owner has used the limit of the plan. A no-op without a config.
 * Call it inside the enqueue transaction after the owner locks, so concurrent requests are counted one by one.
 */
export async function enforceAiQuota({db,store,config,owner,operation,now=Date.now()}){
  if(!config)return;
  const kind=OPERATIONS[operation];
  if(!kind)return;
  const plan=await store.activePlan(owner);
  const limit=aiLimitFor(config,plan,operation);
  if(limit===null)return;
  const used=await db.prepare('SELECT count(*) AS used FROM pine_bridge_jobs WHERE owner_id=? AND operation=? AND created_at>?').get(owner,operation,now-DAY_MS);
  if(Number(used?.used??0)<limit)return;
  const message=limit===0?`Your ${plan} plan does not include AI ${kind.noun}.`
    :`You reached the limit of ${limit} AI ${kind.noun} per 24 hours on your ${plan} plan. Try again later.`;
  throw Object.assign(new Error(message),{code:'AI_QUOTA_EXCEEDED',status:429});
}

/** One line for the startup log; it names no values beyond counts. */
export const describeAiQuota=config=>config?`AI quota enabled (${Object.keys(config.default).length>0?'default limits':'no default limits'}, ${config.plans.size} plan entries)`:'AI quota disabled';
