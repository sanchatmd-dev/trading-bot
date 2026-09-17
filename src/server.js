import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config,assertProductionConfig} from './config.js';
import {Store} from './database.js';
import {hashPassword,verifyPassword,randomToken,encryptJson,decryptJson,hashToken} from './security.js';
import {normalizeSignal,normalizeSymbol} from './domain.js';
import {evaluateRisk} from './risk.js';
import {analyticsWindow,fifoAnalytics,analyticsCapital,filterClosedPositions,summarizeClosedPositions,breakdownClosedPositions,groupClosedPositions,currencyForBroker} from './analytics.js';
import {supportedBrokers,capabilities,validateCredentials} from './adapters/registry.js';
import {EmailNotifier} from './notifier.js';
import {Worker,NotificationWorker} from './worker.js';
import {readJson,RateLimiter,booleanValue,clientIp} from './http-safety.js';
import {acquireProcessLock} from './process-lock.js';

assertProductionConfig();const releaseLock=acquireProcessLock(config.dbPath);const store=new Store(config.dbPath);const notifier=new EmailNotifier(config.smtp);const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
if(!store.userCount()){if(process.env.NODE_ENV==='production'&&config.adminPassword==='change-this-immediately')throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be changed for first boot');const admin=store.createUser({email:config.adminEmail,passwordHash:await hashPassword(config.adminPassword),role:'ADMIN'});store.setRisk(admin.id,{...config.defaultRisk,paperTrading:true});console.log(`Bootstrap admin created: ${admin.email}`);}
const worker=new Worker({store,config,notifier});
const notifications=new NotificationWorker({store,notifier});
const requestLimiter=new RateLimiter({limit:240});
const loginLimiter=new RateLimiter({limit:20,windowMs:900000});
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
const tokenOf=req=>String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
const session=req=>store.session(tokenOf(req));
const requireSession=(req,res)=>{const user=session(req);if(!user||user.status!=='ACTIVE'){json(res,401,{error:'Unauthorized'});return null;}return user;};
const requireAdmin=(req,res)=>{const user=requireSession(req,res);if(!user)return null;if(user.role!=='ADMIN'){json(res,403,{error:'Admin permission required'});return null;}return user;};
const safeLimit=url=>Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||100)));
// Trust only the right-most address from the explicitly configured loopback proxy.
const loginKey=req=>clientIp(req,config.trustLoopbackProxy);
const analyticsBrokers=['binance-global','binance-th','innovestx','settrade'];

function analyticsData(url,targetUserId){
  const broker=String(url.searchParams.get('broker')||'binance-global');
  if(!analyticsBrokers.includes(broker))throw new Error('Analytics requires a supported Spot broker');
  const period=String(url.searchParams.get('period')||'monthly').toLowerCase();
  const window=analyticsWindow(period,url.searchParams.get('from'),url.searchParams.get('to'));
  const rawSymbol=String(url.searchParams.get('symbol')||'').trim().toUpperCase();
  if(rawSymbol&&!/^[A-Z0-9._:/-]{1,40}$/.test(rawSymbol))throw new Error('Invalid analytics symbol');
  const symbol=rawSymbol?normalizeSymbol(rawSymbol,broker):'';
  const feeBps=store.analyticsFeeBps(targetUserId,broker),currency=currencyForBroker(broker);
  const fills=store.analyticsRows(targetUserId,broker),all=fifoAnalytics(fills,{feeBps});
  const basis=analyticsCapital(store.paperFunding(targetUserId,broker),all.realizations,fills,window);
  const closed=filterClosedPositions(all.closedPositions,{...window,symbol});
  const realizations=filterClosedPositions(all.realizations,{...window,symbol});
  const options={...basis,currency,realizations};
  return {targetUserId,broker,currency,symbol:symbol||null,feeBps,startingEquity:basis.startingEquity,basis,options,window,closed,summary:summarizeClosedPositions(closed,options)};
}

function validateRisk(input,current){
  const next={...current,paperTrading:true,equities:{...(current.equities||{})},balances:{...(current.balances||{})},defaults:{...config.defaultRisk.defaults,...(current.defaults||{})}};
  const ranges={maxRiskPercent:[.01,100],maxOrderNotional:[.01,1e12],maxDailyNotional:[.01,1e13],maxTradesPerDay:[1,10000],maxDailyLossR:[.01,1000],maxOpenPositions:[1,1000],pauseAfterLossStreak:[1,100],maxSignalAgeSeconds:[1,3600],maxVolatilityPercent:[0,1000]};
  for(const[k,[min,max]]of Object.entries(ranges)){
    if(input[k]===undefined)continue;
    const n=input[k];
    if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid ${k}`);
    if(['maxTradesPerDay','maxOpenPositions','pauseAfterLossStreak','maxSignalAgeSeconds'].includes(k)&&!Number.isInteger(n))throw new Error(`${k} must be an integer`);
    next[k]=n;
  }
  const defaultFields={
    riskPercent:['maxRiskPercent',.01],tradesPerDay:['maxTradesPerDay',1],
    dailyLossR:['maxDailyLossR',.01],lossStreak:['pauseAfterLossStreak',1],
    openPositions:['maxOpenPositions',1],signalAgeSeconds:['maxSignalAgeSeconds',1],
    orderNotional:['maxOrderNotional',.01],dailyNotional:['maxDailyNotional',.01],
    volatilityPercent:['maxVolatilityPercent',0]
  };
  if(input.defaults!==undefined){
    if(!input.defaults||typeof input.defaults!=='object'||Array.isArray(input.defaults))throw new Error('Invalid defaults');
    for(const[key,[maxKey,min]]of Object.entries(defaultFields)){
      if(input.defaults[key]===undefined)continue;
      const n=input.defaults[key];
      if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>next[maxKey])throw new Error(`Default ${key} must not exceed ${maxKey}`);
      if(['tradesPerDay','lossStreak','openPositions','signalAgeSeconds'].includes(key)&&!Number.isInteger(n))throw new Error(`Default ${key} must be an integer`);
      next.defaults[key]=n;
    }
  }
  for(const[key,[maxKey]]of Object.entries(defaultFields))
    if(next.defaults[key]>next[maxKey])throw new Error(`Default ${key} must not exceed ${maxKey}`);
  for(const key of ['paperTrading','killSwitch','onePositionPerSymbol','blockHighVolatility','blockDuringNews','requireReduceOnlySell','capPercentEquitySize'])
    if(input[key]!==undefined)next[key]=booleanValue(input[key],key);
  if(!next.paperTrading)throw new Error('Live is locked in this Paper staging release');
  if(!next.requireReduceOnlySell)throw new Error('Spot reduce-only protection cannot be disabled');
  if(input.sideMode!==undefined){if(!['BOTH','BUY_ONLY','SELL_ONLY'].includes(input.sideMode))throw new Error('Invalid sideMode');next.sideMode=input.sideMode;}
  if(input.allowedSymbols!==undefined){
    if(!Array.isArray(input.allowedSymbols)||input.allowedSymbols.length>500||input.allowedSymbols.some(x=>typeof x!=='string'||!/^[A-Z0-9._-]{1,30}$/.test(x)))throw new Error('Invalid allowedSymbols');
    next.allowedSymbols=[...new Set(input.allowedSymbols)];
  }
  if(input.equities!==undefined){
    if(!input.equities||typeof input.equities!=='object'||Array.isArray(input.equities))throw new Error('Invalid equities');
    for(const[broker,n]of Object.entries(input.equities)){
      if(!supportedBrokers.includes(broker)||typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e12)throw new Error('Invalid equity');
      next.equities[broker]=n;
    }
  }
  if(input.balances!==undefined){
    if(!input.balances||typeof input.balances!=='object'||Array.isArray(input.balances))throw new Error('Invalid balances');
    for(const[broker,n]of Object.entries(input.balances)){
      if(!supportedBrokers.includes(broker)||typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e12)throw new Error('Invalid balance');
      if(n>(next.equities[broker]??0))throw new Error('Balance cannot exceed Total Equity');
      next.balances[broker]=n;
    }
  }
  for(const[broker,balance]of Object.entries(next.balances))
    if(balance>(next.equities[broker]??0))throw new Error('Balance cannot exceed Total Equity');
  return next;
}

async function authRoutes(req,res,url){
  if(req.method==='POST'&&url.pathname==='/api/auth/login'){
    if(!loginLimiter.accept(loginKey(req)))return json(res,429,{error:'Too many login attempts. Try again later'});
    const body=await readJson(req);
    if(typeof body.email!=='string'||body.email.length>254)throw new Error('Invalid email');
    const user=store.userByEmail(body.email);
    if(!user||user.parent_user_id||user.status!=='ACTIVE'||!await verifyPassword(body.password,user.password_hash))return json(res,401,{error:'Invalid email or password'});
    const token=randomToken(),expires=Date.now()+config.sessionTtlHours*3600000;
    store.createSession(user.id,token,expires);store.audit(user.id,'auth.login',null,{});
    return json(res,200,{token,expiresAt:expires,user:store.userById(user.id)});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const user=requireSession(req,res);if(!user)return;store.deleteSession(tokenOf(req));return json(res,200,{ok:true});}
  return false;
}

async function userRoutes(req,res,url){const actor=requireSession(req,res);if(!actor)return;
  if(req.method==='GET'&&url.pathname==='/api/bots')return json(res,200,{bots:store.listBots(actor.id),maxBots:5});
  if(req.method==='POST'&&url.pathname==='/api/bots'){
    const body=await readJson(req),secret=randomToken();
    const bot=store.createBot(actor.id,body.label,{...config.defaultRisk,paperTrading:true},id=>store.setWebhookSecret(id,secret,encryptJson({secret},config.masterKey,`webhook:${id}`)));
    store.audit(actor.id,'bot.created',null,{botId:bot.id});return json(res,201,bot);
  }
  const botRoute=url.pathname.match(/^\/api\/bots\/([^/]+)$/);
  if(req.method==='PATCH'&&botRoute){
    const id=botRoute[1];if(!store.ownsBot(actor.id,id))return json(res,404,{error:'Bot not found'});
    const body=await readJson(req);
    if(typeof body.label!=='string'||!body.label.trim()||body.label.trim().length>80)throw new Error('Bot label must contain 1–80 characters');
    store.db.prepare('UPDATE users SET label=? WHERE id=?').run(body.label.trim(),id);
    store.audit(actor.id,'bot.renamed',null,{botId:id});return json(res,200,store.userById(id));
  }
  const requestedBot=String(url.searchParams.get('bot_id')||actor.id),allBots=requestedBot==='all';
  if(!allBots&&!store.ownsBot(actor.id,requestedBot))return json(res,403,{error:'Bot access denied'});
  if(allBots&&!['/api/signals','/api/positions','/api/me'].includes(url.pathname))return json(res,400,{error:'Select one bot for this operation'});
  const selected=allBots?actor.id:requestedBot;
  // Authentication and subscription operations always address the main account.
  const accountRoute=['/api/me/password','/api/me/license/redeem'].includes(url.pathname);
  const user={...actor,id:accountRoute?actor.id:selected},admin=actor.role==='ADMIN';
  if(url.pathname.startsWith('/api/analytics/')){
    const requested=String(url.searchParams.get('user_id')||user.id),targetUserId=requested;
    if(!admin&&!store.ownsBot(actor.id,requested))return json(res,403,{error:'Cannot access another user analytics'});
    if(!store.userById(targetUserId))return json(res,404,{error:'Analytics user not found'});
    if(req.method==='PUT'&&url.pathname==='/api/analytics/settings'){
      const body=await readJson(req),broker=String(body.broker||'');
      if(!analyticsBrokers.includes(broker))return json(res,400,{error:'Analytics requires a supported Spot broker'});
      const feeBps=body.feeBps;if(typeof feeBps!=='number'||!Number.isFinite(feeBps)||feeBps<0||feeBps>1000)return json(res,400,{error:'feeBps must be between 0 and 1000'});
      store.setAnalyticsFeeBps(targetUserId,broker,feeBps);store.audit(user.id,'analytics.settings.updated',null,{targetUserId,broker,feeBps});
      return json(res,200,{userId:targetUserId,broker,feeBps});
    }
    if(req.method==='GET'&&['/api/analytics/summary','/api/analytics/equity-curve','/api/analytics/breakdown'].includes(url.pathname)){
      const data=analyticsData(url,targetUserId),meta={userId:targetUserId,broker:data.broker,currency:data.currency,symbol:data.symbol,period:data.window.period,from:data.window.fromDate,to:data.window.toDate,feeBps:data.feeBps,...data.basis};
      if(url.pathname==='/api/analytics/summary'){
        const {equityCurve,...summary}=data.summary;
        const groups=groupClosedPositions(data.closed,data.window.period,data.options);
        return json(res,200,{...meta,...summary,groups,closedPositions:[...data.closed].sort((a,b)=>b.exitAt-a.exitAt).slice(0,50)});
      }
      if(url.pathname==='/api/analytics/equity-curve')return json(res,200,{...meta,startingEquity:data.startingEquity,series:data.summary.equityCurve});
      const assets=breakdownClosedPositions(data.closed,data.options).map(({equityCurve,...asset})=>asset);
      return json(res,200,{...meta,assets});
    }
  }
  if(req.method==='GET'&&url.pathname==='/api/me'){
    const dailyAccounts=(allBots?store.listBots(actor.id):[{id:user.id}]).flatMap(bot=>store.dailyAccounts(bot.id).map(row=>({...row,bot_id:bot.id})));
    const paperAccounts=(allBots?store.listBots(actor.id):[{id:user.id}]).flatMap(bot=>store.paperAccounts(bot.id).map(row=>({...row,bot_id:bot.id})));
    return json(res,200,{user:{...store.userById(actor.id)},bot:store.userById(user.id),allBots,license:admin?{plan:'ADMIN',status:'ACTIVE',expires_at:null}:store.licenseForUser(actor.id),risk:{...store.risk(user.id,config.defaultRisk),paperTrading:true},brokers:store.credentialSummary(user.id),globalKill:store.getSetting('globalKill',false),capabilities,paperAccounts,dailyAccounts,daily:{trades:dailyAccounts.reduce((sum,x)=>sum+x.trades,0)}});
  }
  if(req.method==='GET'&&url.pathname==='/api/me/webhook-secret'){
    const saved=store.webhookSecret(user.id);
    if(!saved?.webhook_secret_encrypted)return json(res,200,{urlPath:null,configured:!!saved?.webhook_secret_hash,recoveryRequired:!!saved?.webhook_secret_hash});
    const {secret}=decryptJson(saved.webhook_secret_encrypted,config.masterKey,`webhook:${user.id}`);
    if(hashToken(secret)!==saved.webhook_secret_hash)throw new Error('Saved webhook verification failed');
    return json(res,200,{urlPath:`/webhooks/tradingview/${secret}`,configured:true,recoveryRequired:false});
  }
  if(req.method==='PUT'&&url.pathname==='/api/me/webhook-secret'){
    const body=await readJson(req);
    if(typeof body.url!=='string'||body.url.length>2048)throw new Error('Invalid webhook URL');
    const match=body.url.trim().match(/(?:^|\/)webhooks\/tradingview\/([a-f0-9]{64})$/);
    const saved=store.webhookSecret(user.id),secret=match?.[1];
    if(!secret||hashToken(secret)!==saved?.webhook_secret_hash)return json(res,400,{error:'URL does not match your current webhook'});
    store.rememberWebhookSecret(user.id,secret,encryptJson({secret},config.masterKey,`webhook:${user.id}`));
    store.audit(user.id,'webhook.secret.recovered',null,{});
    return json(res,200,{urlPath:`/webhooks/tradingview/${secret}`});
  }
  if(req.method==='POST'&&url.pathname==='/api/me/webhook-secret'){const secret=randomToken();store.setWebhookSecret(user.id,secret,encryptJson({secret},config.masterKey,`webhook:${user.id}`));store.audit(user.id,'webhook.secret.rotated',null,{});return json(res,200,{secret,urlPath:`/webhooks/tradingview/${secret}`});}
  if(req.method==='POST'&&url.pathname==='/api/me/license/redeem'){const body=await readJson(req);if(!store.redeemLicense(user.id,String(body.licenseKey||'')))return json(res,400,{error:'License is invalid, assigned, or expired'});store.audit(user.id,'license.redeemed',null,{});return json(res,200,{license:store.licenseForUser(user.id)});}
  if(req.method==='POST'&&url.pathname==='/api/me/password'){const body=await readJson(req),full=store.userByEmail(user.email);if(!await verifyPassword(body.currentPassword,full.password_hash))return json(res,400,{error:'Current password is incorrect'});store.setPassword(user.id,await hashPassword(body.newPassword));store.audit(user.id,'account.password.changed',null,{});return json(res,200,{ok:true});}
  if(req.method==='GET'&&url.pathname==='/api/risk')return json(res,200,{...store.risk(user.id,config.defaultRisk),paperTrading:true});
  if(req.method==='PUT'&&url.pathname==='/api/risk'){const policy=validateRisk(await readJson(req),store.risk(user.id,config.defaultRisk));store.setRisk(user.id,policy);store.audit(user.id,'risk.updated',null,{policy});return json(res,200,policy);}
  if(req.method==='POST'&&url.pathname==='/api/risk/preview'){
    const body=await readJson(req),policy=validateRisk(body.policy||{},store.risk(user.id,config.defaultRisk));
    const calculator=body.calculator||{},broker=String(calculator.broker||'binance-global');
    const entry=Number(calculator.entry),stopLoss=Number(calculator.stopLoss),riskValue=Number(calculator.riskPercent);
    const signal=normalizeSignal({trade_id:'risk-preview',broker,symbol:String(calculator.symbol||''),event:'BUY',
      risk_mode:'PERCENT_EQUITY',risk_value:riskValue,entry,sl:stopLoss,tp:entry*1.01,
      volatility_percent:Number(calculator.volatilityPercent??0),news_risk:false,timestamp:Date.now()});
    const row={id:0,user_id:user.id,account_id:`${signal.broker}:primary`,execution_mode:'PAPER',symbol:signal.symbol,broker:signal.broker};
    const exposure=store.exposure(row),daily=store.ledgerDaily(row),position=store.ledgerPosition(row);
    const account=store.paperAccount(user.id,signal.broker,policy),equity=account.bookEquity,balance=account.cash;
    const cashAvailable=balance-(exposure.reservedNotional||0);
    const result=evaluateRisk(signal,{policy,daily,position,equity,balance,cashAvailable,
      licensed:actor.role==='ADMIN'||store.hasActiveLicense(actor.id),globalKill:store.getSetting('globalKill',false),...exposure});
    const positionsRemaining=Math.max(0,policy.maxOpenPositions-exposure.openPositions);
    const freeBalance=Math.max(0,Math.min(equity-(exposure.committedNotional||0),cashAvailable));
    const positionCapacity=result.ok&&result.order.notional>0?Math.min(positionsRemaining,Math.floor(freeBalance/result.order.notional)):0;
    return json(res,200,{...result,equity,balance,freeBalance,positionsOpen:exposure.openPositions,
      positionsRemaining,positionCapacity,dailyRemaining:Math.max(0,policy.maxDailyNotional-daily.notional-(exposure.reservedNotional||0))});
  }
  if(req.method==='GET'&&url.pathname==='/api/brokers')return json(res,200,{supported:supportedBrokers,capabilities,configured:store.credentialSummary(user.id)});
  if(req.method==='PUT'&&url.pathname.startsWith('/api/brokers/')){
    const broker=decodeURIComponent(url.pathname.slice('/api/brokers/'.length));
    if(!supportedBrokers.includes(broker))return json(res,400,{error:'Unsupported broker'});
    const body=await readJson(req),credentials=validateCredentials(broker,body.credentials);
    const enabled=body.enabled===undefined?true:booleanValue(body.enabled,'enabled');
    store.setCredential(user.id,broker,encryptJson(credentials,config.masterKey,`${user.id}:${broker}`),enabled);
    store.audit(user.id,'broker.credentials.updated',null,{broker,enabled});
    return json(res,200,{broker,configured:true,enabled,live:false});
  }
  if(req.method==='GET'&&url.pathname==='/api/signals'){
    const rows=(allBots?store.listBots(actor.id):store.listBots(actor.id).filter(bot=>bot.id===user.id)).flatMap(bot=>store.listSignals(bot.id,false,safeLimit(url)).map(row=>({...row,bot_id:bot.id,bot_label:bot.label})));
    return json(res,200,rows.sort((a,b)=>b.id-a.id).slice(0,safeLimit(url)));
  }
  const noteRoute=url.pathname.match(/^\/api\/signals\/(\d+)\/note$/);
  if(req.method==='PUT'&&noteRoute){
    const body=await readJson(req);
    if(!store.setRejectedNote({...user,role:'USER'},Number(noteRoute[1]),body.note))return json(res,404,{error:'Signal not found'});
    return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/audit')return json(res,200,store.listAudit(user.id,false,safeLimit(url)));
  if(req.method==='GET'&&url.pathname==='/api/positions')return json(res,200,(allBots?store.listBots(actor.id):store.listBots(actor.id).filter(bot=>bot.id===user.id)).flatMap(bot=>store.listPositions(bot.id).map(row=>({...row,bot_id:bot.id,bot_label:bot.label}))));
  return json(res,404,{error:'Not found'});
}

async function adminRoutes(req,res,url){const admin=requireAdmin(req,res);if(!admin)return;
  if(req.method==='GET'&&url.pathname==='/api/admin/health')return json(res,200,{
    ...store.health(),workerLastTick:worker.lastTick,workerError:worker.lastError||null,
    unknown:store.db.prepare("SELECT count(*) n FROM signals WHERE status='UNKNOWN'").get().n,
    notifications:store.db.prepare('SELECT status,count(*) count FROM notification_outbox GROUP BY status').all(),
    liveEnabled:false
  });
  if(req.method==='GET'&&url.pathname==='/api/admin/users')return json(res,200,store.listUsers());
  if(req.method==='POST'&&url.pathname==='/api/admin/users'){const body=await readJson(req),email=String(body.email||'').trim().toLowerCase();if(!email.includes('@'))return json(res,400,{error:'Valid email required'});const user=store.createUser({email,passwordHash:await hashPassword(body.password),role:body.role==='ADMIN'?'ADMIN':'USER'});store.setRisk(user.id,{...config.defaultRisk,paperTrading:true});store.audit(admin.id,'admin.user.created',null,{userId:user.id,email});return json(res,201,user);}
  if(req.method==='PUT'&&/^\/api\/admin\/users\/[^/]+\/status$/.test(url.pathname)){const id=url.pathname.split('/')[4],body=await readJson(req),status=String(body.status).toUpperCase();if(!['ACTIVE','SUSPENDED'].includes(status))return json(res,400,{error:'Invalid status'});if(id===admin.id&&status!=='ACTIVE')return json(res,400,{error:'Cannot suspend current admin'});store.setUserStatus(id,status);return json(res,200,{id,status});}
  if(req.method==='GET'&&url.pathname==='/api/admin/licenses')return json(res,200,store.listLicenses());
  if(req.method==='POST'&&url.pathname==='/api/admin/licenses'){const body=await readJson(req),days=Math.min(3650,Math.max(1,Number(body.days||30))),key=`ASTRA-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}`,license=store.createLicense({key,plan:String(body.plan||'PERSONAL').toUpperCase(),expiresAt:Date.now()+days*86400000});store.audit(admin.id,'admin.license.created',null,{licenseId:license.id,plan:license.plan,days});return json(res,201,license);}
  if(req.method==='PUT'&&/^\/api\/admin\/licenses\/[^/]+\/status$/.test(url.pathname)){const id=url.pathname.split('/')[4],body=await readJson(req),status=String(body.status).toUpperCase();if(!['ACTIVE','SUSPENDED','REVOKED'].includes(status))return json(res,400,{error:'Invalid status'});store.setLicenseStatus(id,status);return json(res,200,{id,status});}
  if(req.method==='POST'&&url.pathname==='/api/admin/global-kill'){const body=await readJson(req),enabled=booleanValue(body.enabled,'enabled');store.setSetting('globalKill',enabled);store.audit(admin.id,'admin.global_kill',null,{enabled});return json(res,200,{globalKill:enabled,semantics:'PAUSE_ENTRIES'});}
  return json(res,404,{error:'Not found'});
}

function serve(res,pathname){const requested=pathname==='/'?'index.html':pathname.slice(1),file=path.resolve(publicDir,requested);if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return false;const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'content-type':type,'cache-control':type.startsWith('text/html')?'no-cache':'public,max-age=3600'});fs.createReadStream(file).pipe(res);return true;}
const server=http.createServer(async(req,res)=>{res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'");const url=new URL(req.url,'http://localhost');try{
  if(req.method==='GET'&&url.pathname==='/healthz'){
    const health=store.health(),ok=!worker.stopping&&!worker.lastError&&Date.now()-worker.lastTick<30000&&(!health.oldest||Date.now()-health.oldest<300000);
    return json(res,ok?200:503,{ok,version:'2.1.0',mode:'PAPER_ONLY',queued:health.queued});
  }
  if(!requestLimiter.accept(loginKey(req)))return json(res,429,{error:'Request limit reached'});
  if(url.pathname.startsWith('/api/auth/')){const handled=await authRoutes(req,res,url);if(handled!==false)return;}
  if(req.method==='POST'&&url.pathname.startsWith('/webhooks/tradingview/')){
    const secret=decodeURIComponent(url.pathname.slice('/webhooks/tradingview/'.length)),user=store.userByWebhook(secret);
    if(!user||user.status!=='ACTIVE')return json(res,404,{error:'Not found'});
    const owner=store.botOwner(user.id);
    if(!owner||owner.status!=='ACTIVE')return json(res,404,{error:'Not found'});
    // Recover legacy hash-only secrets from authenticated requests without rotating URLs.
    if(!store.webhookSecret(user.id)?.webhook_secret_encrypted)
      store.rememberWebhookSecret(user.id,secret,encryptJson({secret},config.masterKey,`webhook:${user.id}`));
    const signal=normalizeSignal(await readJson(req));
    if(!capabilities[signal.broker]?.paper)throw new Error('Broker does not support Spot simulation');
    const isExit=signal.side==='SELL'&&signal.reduceOnly;
    if(!isExit&&owner.role!=='ADMIN'&&!store.hasActiveLicense(owner.id))return json(res,403,{error:'License inactive or expired'});
    const policy=store.risk(user.id,config.defaultRisk);
    if(Date.now()-signal.timestamp>policy.maxSignalAgeSeconds*1000)throw new Error('Signal is stale');
    if(!store.enqueue(user.id,signal,'PAPER'))return json(res,409,{accepted:false,error:'Duplicate trade_id'});
    return json(res,202,{accepted:true,trade_id:signal.tradeId,execution_mode:'PAPER'});
  }
  if(url.pathname.startsWith('/api/admin/'))return await adminRoutes(req,res,url);
  if(url.pathname.startsWith('/api/'))return await userRoutes(req,res,url);
  if(!serve(res,url.pathname))json(res,404,{error:'Not found'});
}catch(error){store.audit(null,'request.error',null,{message:error.message,path:url.pathname.replace(/\/webhooks\/tradingview\/.+/,'/webhooks/tradingview/[redacted]')});if(!res.headersSent)json(res,400,{error:error.message});}});
server.requestTimeout=15000;server.headersTimeout=10000;server.maxRequestsPerSocket=100;
worker.start();notifications.start();
server.listen(config.port,config.host,()=>console.log(`Robot trade v2.1 Paper staging listening on :${config.port}`));
let shuttingDown=false;
const shutdown=async()=>{
  if(shuttingDown)return;shuttingDown=true;
  const closed=new Promise(resolve=>server.close(resolve));
  server.closeIdleConnections();
  await Promise.all([worker.stop(),notifications.stop(),closed]);
  store.close();releaseLock();
};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
