import {createHash,timingSafeEqual} from 'node:crypto';
import {readJson} from '../http-safety.js';

/**
 * News windows: the independent news source of the news block.
 *
 * A window is {start_ms,end_ms,source,label}: a half-open period [start_ms,end_ms) in which a bot whose news block is
 * on rejects new entries (BUY). EXIT is never blocked and trading resumes by itself when the window ends. A signal is
 * marked newsRisk=true only when a window covers its own time (the Bridge bar_time, else the time of receipt);
 * newsRisk is otherwise a real false. Nothing here invents a news fact: no window means no block, so missing news
 * data never rejects an entry (fail-open).
 *
 * Windows reach the server only through the machine port below (a future AI news feed); nothing else writes them.
 * They are kept in the existing system_settings table (key news_windows), which the runtime role may already write,
 * so there is no migration and no grant change. The set is bounded (see NEWS_WINDOW_LIMITS) and a restart keeps it.
 * An unreadable stored value counts as no window.
 */
export const NEWS_WINDOWS_PATH='/api/system/news-windows';
export const NEWS_WINDOW_LIMITS=Object.freeze({maxWindows:50,maxDurationMs:86_400_000,maxFutureMs:7*86_400_000,pruneAfterMs:86_400_000});
const SETTING_KEY='news_windows';
const MAX_BODY_BYTES=32768;
const WINDOW_FIELDS=['start_ms','end_ms','source','label'];
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const printable=(value,min,max)=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_NEWS_WINDOWS',status:400});

/** One window from untrusted input. now===null skips the check against the future (used when reading stored windows). */
function parseWindow(item,at,now){
  const {maxDurationMs,maxFutureMs}=NEWS_WINDOW_LIMITS;
  if(!isObject(item)||Object.keys(item).some(key=>!WINDOW_FIELDS.includes(key)))throw invalid(at+' must be an object with start_ms, end_ms, source and an optional label');
  const {start_ms:start,end_ms:end,source,label=''}=item;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<=0||end<=0)throw invalid(at+' start_ms and end_ms must be positive whole milliseconds since the Unix epoch');
  if(end<=start)throw invalid(at+' end_ms must be after start_ms');
  if(end-start>maxDurationMs)throw invalid(at+' lasts longer than 24 hours');
  if(now!==null&&end>now+maxFutureMs)throw invalid(at+' ends more than 7 days from now');
  if(!printable(source,1,64))throw invalid(at+' source must be 1 to 64 printable characters');
  if(!printable(label,0,120))throw invalid(at+' label must be at most 120 printable characters');
  return {start_ms:start,end_ms:end,source,label};
}

const order=(a,b)=>a.start_ms-b.start_ms||a.end_ms-b.end_ms||(a.source<b.source?-1:a.source>b.source?1:0);
/** Entries more than one day past their end are dropped. */
export const pruneWindows=(windows,now=Date.now())=>windows.filter(item=>item.end_ms>=now-NEWS_WINDOW_LIMITS.pruneAfterMs);

/**
 * Validates a POST body {windows:[...]}. Strict: any bad entry rejects the whole set, so a replacement is all or nothing.
 * Returns {windows,pruned}: the sorted, pruned set to store and how many valid entries were dropped as expired.
 */
export function validateWindows(body,now=Date.now()){
  if(!isObject(body)||Object.keys(body).some(key=>key!=='windows')||!Array.isArray(body.windows))throw invalid('The body must be {"windows":[...]}');
  if(body.windows.length>NEWS_WINDOW_LIMITS.maxWindows)throw invalid('At most '+NEWS_WINDOW_LIMITS.maxWindows+' windows are accepted');
  const parsed=body.windows.map((item,index)=>parseWindow(item,'windows['+index+']',now)).sort(order);
  const windows=pruneWindows(parsed,now);
  return {windows,pruned:parsed.length-windows.length};
}

function readStored(stored){
  if(!isObject(stored)||!Array.isArray(stored.windows))return [];
  const windows=[];
  for(const item of stored.windows.slice(0,NEWS_WINDOW_LIMITS.maxWindows)){
    try{windows.push(parseWindow(item,'stored window',null));}catch{/* an unreadable entry is no window */}
  }
  return windows.sort(order);
}

/** The current windows (expired entries left out). Reads one settings row. */
export async function loadWindows(store,now=Date.now()){
  return pruneWindows(readStored(await store.getSetting(SETTING_KEY,null)),now);
}
/** Replaces the whole set in one write. */
export const saveWindows=(store,windows,now=Date.now())=>store.setSetting(SETTING_KEY,{version:1,updated_at:now,windows});

export const windowsCover=(windows,at)=>Number.isFinite(at)&&windows.some(item=>item.start_ms<=at&&at<item.end_ms);

/**
 * The newsRisk fact of a signal: true only when a window covers the signal time, else false. barTime is the Bridge
 * bar_time (or the signal timestamp); receivedAt is the fallback when there is none. Always a real boolean.
 */
export async function newsRiskFor(store,{barTime,receivedAt=Date.now(),now=Date.now()}={}){
  const at=Number.isFinite(barTime)?barTime:receivedAt;
  return windowsCover(await loadWindows(store,now),at);
}

/** NEWS_FEED_TOKEN_SHA256: absent or blank means the port is off; anything else must be 64 hex characters. */
export function parseNewsFeedToken(raw){
  if(raw===undefined||raw===null||String(raw).trim()==='')return null;
  const value=String(raw).trim();
  if(!/^[0-9a-fA-F]{64}$/.test(value))throw new Error('Invalid NEWS_FEED_TOKEN_SHA256: expected 64 hexadecimal characters (the SHA-256 of the feed token)');
  return Buffer.from(value,'hex');
}

/** Bearer token check: sha256 of the presented token against the configured digest, in constant time. No cookie or session. */
export function bearerMatches(req,digest){
  const match=/^Bearer ([^\s]{1,512})$/i.exec(String(req.headers?.authorization??''));
  const presented=createHash('sha256').update(match?match[1]:'').digest();
  return timingSafeEqual(presented,digest)&&match!==null;
}

const reply=(res,status,body,headers={})=>{
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});
  res.end(JSON.stringify(body));
  return true;
};
const view=(windows,updatedAt=null)=>({windows,count:windows.length,updated_at:updatedAt});

/**
 * The machine port for a future AI news feed: GET and POST /api/system/news-windows.
 * Disabled unless a token digest (parseNewsFeedToken of NEWS_FEED_TOKEN_SHA256) is given. While disabled, handle()
 * answers nothing and returns false, so the request runs through the normal pipeline exactly like any unknown route.
 * While enabled it answers only its own path, ignores cookies and sessions, and accepts only
 * `Authorization: Bearer <token>` whose sha256 matches. POST replaces the whole set in one transaction and audits
 * news_windows.updated with counts only. limit(req) is an optional per-client rate check that returns true to continue.
 */
export function createNewsWindowsPort({store,digest=null,limit=null,now=Date.now}={}){
  if(!digest)return {enabled:false,handle:async()=>false};
  const snapshot=async()=>{
    const stored=await store.getSetting(SETTING_KEY,null);
    return view(pruneWindows(readStored(stored),now()),Number.isSafeInteger(stored?.updated_at)?stored.updated_at:null);
  };
  return {enabled:true,async handle(req,res){
    // A malformed request target (for example `//` or `//[`) makes new URL throw. It is not this port's path, so the
    // normal pipeline answers it; the parse must never reject, because an unhandled rejection stops the API process.
    let pathname;
    try{pathname=new URL(req.url,'http://localhost').pathname;}catch{return false;}
    if(pathname!==NEWS_WINDOWS_PATH)return false;
    try{
      if(limit&&!await limit(req))return reply(res,429,{error:'Request limit reached'});
      if(!bearerMatches(req,digest))return reply(res,401,{error:'Unauthorized'},{'www-authenticate':'Bearer'});
      if(req.method==='GET')return reply(res,200,await snapshot());
      if(req.method!=='POST')return reply(res,405,{error:'Method not allowed'},{allow:'GET, POST'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(res,415,{error:'JSON content type required'});
      let body;
      try{body=await readJson(req,{maxBytes:MAX_BODY_BYTES});}
      catch(error){
        if(error.message==='Payload too large')return reply(res,413,{error:'Payload too large',code:'PAYLOAD_TOO_LARGE'});
        return reply(res,400,{error:'The body must be a JSON object',code:'INVALID_JSON'});
      }
      const at=now(),{windows,pruned}=validateWindows(body,at);
      await store.db.transaction(async()=>{
        await saveWindows(store,windows,at);
        await store.audit(null,'news_windows.updated',null,{received:body.windows.length,stored:windows.length,pruned});
      });
      return reply(res,200,view(windows,at));
    }catch(error){
      if(error?.code==='INVALID_NEWS_WINDOWS')return reply(res,400,{error:error.message,code:error.code});
      return reply(res,503,{error:'Request could not be completed'});
    }
  }};
}
