import {createHash} from 'node:crypto';

// Read-only account overview: what public/overview.js gathers with GET /api/bots, one GET /api/me per
// Bot and GET /api/positions?bot_id=all, in one request and one database snapshot. It always covers
// every Bot of the signed-in account and ignores bot_id and user_id, so it cannot address another account.
export const OVERVIEW_PATH='/api/overview';

// Per-Bot fields mirror GET /api/me?bot_id=<id>; positions mirror GET /api/positions?bot_id=all.
// Inside the request transaction this joins it and makes it READ ONLY before the first overview read,
// so neither these reads nor anything later in the same request can write. Standalone it opens its own.
export async function accountOverview(store,ownerId,defaultRisk) {
  const {db}=store;
  return db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');return readOverview(store,ownerId,defaultRisk);},{isolation:'REPEATABLE READ'});
}

async function readOverview(store,ownerId,defaultRisk) {
  const bots=await store.listBots(ownerId),globalKill=await store.getSetting('globalKill',false);
  const entries=[],positions=[];
  for(const bot of bots){
    const dailyAccounts=(await store.dailyAccounts(bot.id)).map(row=>({...row,bot_id:bot.id}));
    const paperAccounts=(await store.paperAccounts(bot.id)).map(row=>({...row,bot_id:bot.id}));
    const {state,run_id,started_at,stopped_at}=await store.getBotSession(bot.id);
    entries.push({
      ...bot,
      risk:{...(await store.risk(bot.id,defaultRisk)),paperTrading:true},
      botSession:{state,run_id,started_at,stopped_at},
      paperAccounts,
      dailyAccounts,
      daily:{trades:dailyAccounts.reduce((sum,x)=>sum+x.trades,0)}
    });
    for(const row of await store.listPositions(bot.id))positions.push({...row,bot_id:bot.id,bot_label:bot.label});
  }
  return {moneyFormat:'decimal-string',globalKill,bots:entries,positions};
}

// Strong validator over the exact JSON bytes the 200 answer carries. The body holds no clock value,
// so an unchanged account yields the same tag.
export const overviewTag=body=>'"'+createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0,32)+'"';

// If-None-Match uses weak comparison: W/ prefixes are ignored and * matches any current answer.
export function notModified(header,tag) {
  if(typeof header!=='string'||!header)return false;
  return header.split(',').some(item=>{const value=item.trim().replace(/^W\//,'');return value==='*'||value===tag;});
}

export async function overviewRoute(req,res,url,actor,{store,json,defaultRisk}) {
  if(req.method!=='GET'||url.pathname!==OVERVIEW_PATH)return false;
  const body=await accountOverview(store,actor.id,defaultRisk),tag=overviewTag(body);
  res.setHeader('etag',tag);
  if(notModified(req.headers['if-none-match'],tag))json(res,304,null);
  else json(res,200,body);
  return true;
}