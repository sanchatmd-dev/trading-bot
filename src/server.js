import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config,assertProductionConfig} from './config.js';
import {Store} from './database.js';
import {hashPassword,verifyPassword,randomToken,encryptJson} from './security.js';
import {normalizeSignal} from './domain.js';
import {supportedBrokers} from './adapters/registry.js';
import {EmailNotifier} from './notifier.js';
import {Worker} from './worker.js';

assertProductionConfig();const store=new Store(config.dbPath);const notifier=new EmailNotifier(config.smtp);const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
if(!store.userCount()){if(process.env.NODE_ENV==='production'&&config.adminPassword==='change-this-immediately')throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be changed for first boot');const admin=store.createUser({email:config.adminEmail,passwordHash:await hashPassword(config.adminPassword),role:'ADMIN'});store.setRisk(admin.id,{...config.defaultRisk,paperTrading:true});console.log(`Bootstrap admin created: ${admin.email}`);}
const worker=new Worker({store,config,notifier});
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
const readJson=req=>new Promise((resolve,reject)=>{let raw='';req.setEncoding('utf8');req.on('data',c=>{raw+=c;if(raw.length>65536)reject(new Error('Payload too large'));});req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});
const tokenOf=req=>String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
const session=req=>store.session(tokenOf(req));
const requireSession=(req,res)=>{const user=session(req);if(!user||user.status!=='ACTIVE'){json(res,401,{error:'Unauthorized'});return null;}return user;};
const requireAdmin=(req,res)=>{const user=requireSession(req,res);if(!user)return null;if(user.role!=='ADMIN'){json(res,403,{error:'Admin permission required'});return null;}return user;};
const safeLimit=url=>Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||100)));
const loginAttempts=new Map();const loginKey=(req,email)=>`${String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0]}:${String(email).toLowerCase()}`;

function validateRisk(input,current){const next={...current,equities:{...(current.equities||{})}};const ranges={maxRiskPercent:[.01,100],maxOrderNotional:[.01,1e12],maxDailyNotional:[.01,1e13],maxTradesPerDay:[1,10000],maxDailyLossR:[.01,1000],maxOpenPositions:[1,1000],pauseAfterLossStreak:[1,100],maxSignalAgeSeconds:[1,3600],maxVolatilityPercent:[0,1000]};for(const[k,[min,max]]of Object.entries(ranges)){if(input[k]===undefined)continue;const n=Number(input[k]);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid ${k}`);next[k]=n;}for(const key of ['paperTrading','killSwitch','onePositionPerSymbol','blockHighVolatility','blockDuringNews','requireReduceOnlySell'])if(input[key]!==undefined)next[key]=Boolean(input[key]);if(input.sideMode!==undefined){const mode=String(input.sideMode).toUpperCase();if(!['BOTH','BUY_ONLY','SELL_ONLY'].includes(mode))throw new Error('Invalid sideMode');next.sideMode=mode;}if(input.allowedSymbols!==undefined){if(!Array.isArray(input.allowedSymbols))throw new Error('allowedSymbols must be an array');next.allowedSymbols=[...new Set(input.allowedSymbols.map(x=>String(x).toUpperCase().replace(/[^A-Z0-9._-]/g,'')).filter(Boolean))].slice(0,500);}if(input.equities){for(const[broker,value]of Object.entries(input.equities)){if(!supportedBrokers.includes(broker))continue;const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error(`Invalid equity for ${broker}`);next.equities[broker]=n;}}return next;}

async function authRoutes(req,res,url){
  if(req.method==='POST'&&url.pathname==='/api/auth/login'){const body=await readJson(req),key=loginKey(req,body.email),attempt=loginAttempts.get(key)||{count:0,blockedUntil:0};if(attempt.blockedUntil>Date.now())return json(res,429,{error:'Too many login attempts. Try again later'});const user=store.userByEmail(body.email);if(!user||user.status!=='ACTIVE'||!await verifyPassword(body.password,user.password_hash)){attempt.count++;if(attempt.count>=10){attempt.blockedUntil=Date.now()+15*60000;attempt.count=0;}loginAttempts.set(key,attempt);return json(res,401,{error:'Invalid email or password'});}loginAttempts.delete(key);const token=randomToken(),expires=Date.now()+config.sessionTtlHours*3600000;store.createSession(user.id,token,expires);store.audit(user.id,'auth.login',null,{});return json(res,200,{token,expiresAt:expires,user:store.userById(user.id)});}
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const user=requireSession(req,res);if(!user)return;store.deleteSession(tokenOf(req));return json(res,200,{ok:true});}
  return false;
}

async function userRoutes(req,res,url){const user=requireSession(req,res);if(!user)return;
  const admin=user.role==='ADMIN';
  if(req.method==='GET'&&url.pathname==='/api/me')return json(res,200,{user:store.userById(user.id),license:admin?{plan:'ADMIN',status:'ACTIVE',expires_at:null}:store.licenseForUser(user.id),risk:store.risk(user.id,config.defaultRisk),brokers:store.credentialSummary(user.id),globalKill:store.getSetting('globalKill',false),daily:store.today(user.id)});
  if(req.method==='POST'&&url.pathname==='/api/me/webhook-secret'){const secret=randomToken();store.setWebhookSecret(user.id,secret);store.audit(user.id,'webhook.secret.rotated',null,{});return json(res,200,{secret,urlPath:`/webhooks/tradingview/${secret}`});}
  if(req.method==='POST'&&url.pathname==='/api/me/license/redeem'){const body=await readJson(req);if(!store.redeemLicense(user.id,String(body.licenseKey||'')))return json(res,400,{error:'License is invalid, assigned, or expired'});store.audit(user.id,'license.redeemed',null,{});return json(res,200,{license:store.licenseForUser(user.id)});}
  if(req.method==='POST'&&url.pathname==='/api/me/password'){const body=await readJson(req),full=store.userByEmail(user.email);if(!await verifyPassword(body.currentPassword,full.password_hash))return json(res,400,{error:'Current password is incorrect'});store.setPassword(user.id,await hashPassword(body.newPassword));store.audit(user.id,'account.password.changed',null,{});return json(res,200,{ok:true});}
  if(req.method==='GET'&&url.pathname==='/api/risk')return json(res,200,store.risk(user.id,config.defaultRisk));
  if(req.method==='PUT'&&url.pathname==='/api/risk'){const policy=validateRisk(await readJson(req),store.risk(user.id,config.defaultRisk));store.setRisk(user.id,policy);store.audit(user.id,'risk.updated',null,{policy});return json(res,200,policy);}
  if(req.method==='GET'&&url.pathname==='/api/brokers')return json(res,200,{supported:supportedBrokers,configured:store.credentialSummary(user.id)});
  if(req.method==='PUT'&&url.pathname.startsWith('/api/brokers/')){const broker=decodeURIComponent(url.pathname.slice('/api/brokers/'.length));if(!supportedBrokers.includes(broker))return json(res,400,{error:'Unsupported broker'});const body=await readJson(req);if(!body.credentials||typeof body.credentials!=='object')return json(res,400,{error:'credentials object is required'});store.setCredential(user.id,broker,encryptJson(body.credentials,config.masterKey),body.enabled!==false);store.audit(user.id,'broker.credentials.updated',null,{broker,enabled:body.enabled!==false});return json(res,200,{broker,configured:true,enabled:body.enabled!==false});}
  if(req.method==='GET'&&url.pathname==='/api/signals')return json(res,200,store.listSignals(user.id,admin,safeLimit(url)));
  if(req.method==='GET'&&url.pathname==='/api/audit')return json(res,200,store.listAudit(user.id,admin,safeLimit(url)));
  if(req.method==='GET'&&url.pathname==='/api/positions')return json(res,200,store.listPositions(user.id,admin));
  return json(res,404,{error:'Not found'});
}

async function adminRoutes(req,res,url){const admin=requireAdmin(req,res);if(!admin)return;
  if(req.method==='GET'&&url.pathname==='/api/admin/users')return json(res,200,store.listUsers());
  if(req.method==='POST'&&url.pathname==='/api/admin/users'){const body=await readJson(req),email=String(body.email||'').trim().toLowerCase();if(!email.includes('@'))return json(res,400,{error:'Valid email required'});const user=store.createUser({email,passwordHash:await hashPassword(body.password),role:body.role==='ADMIN'?'ADMIN':'USER'});store.setRisk(user.id,{...config.defaultRisk,paperTrading:true});store.audit(admin.id,'admin.user.created',null,{userId:user.id,email});return json(res,201,user);}
  if(req.method==='PUT'&&/^\/api\/admin\/users\/[^/]+\/status$/.test(url.pathname)){const id=url.pathname.split('/')[4],body=await readJson(req),status=String(body.status).toUpperCase();if(!['ACTIVE','SUSPENDED'].includes(status))return json(res,400,{error:'Invalid status'});if(id===admin.id&&status!=='ACTIVE')return json(res,400,{error:'Cannot suspend current admin'});store.setUserStatus(id,status);return json(res,200,{id,status});}
  if(req.method==='GET'&&url.pathname==='/api/admin/licenses')return json(res,200,store.listLicenses());
  if(req.method==='POST'&&url.pathname==='/api/admin/licenses'){const body=await readJson(req),days=Math.min(3650,Math.max(1,Number(body.days||30))),key=`ASTRA-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}`,license=store.createLicense({key,plan:String(body.plan||'PERSONAL').toUpperCase(),expiresAt:Date.now()+days*86400000});store.audit(admin.id,'admin.license.created',null,{licenseId:license.id,plan:license.plan,days});return json(res,201,license);}
  if(req.method==='PUT'&&/^\/api\/admin\/licenses\/[^/]+\/status$/.test(url.pathname)){const id=url.pathname.split('/')[4],body=await readJson(req),status=String(body.status).toUpperCase();if(!['ACTIVE','SUSPENDED','REVOKED'].includes(status))return json(res,400,{error:'Invalid status'});store.setLicenseStatus(id,status);return json(res,200,{id,status});}
  if(req.method==='POST'&&url.pathname==='/api/admin/global-kill'){const body=await readJson(req);store.setSetting('globalKill',Boolean(body.enabled));store.audit(admin.id,'admin.global_kill',null,{enabled:Boolean(body.enabled)});return json(res,200,{globalKill:store.getSetting('globalKill',false)});}
  return json(res,404,{error:'Not found'});
}

function serve(res,pathname){const requested=pathname==='/'?'index.html':pathname.slice(1),file=path.resolve(publicDir,requested);if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return false;const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'content-type':type,'cache-control':type.startsWith('text/html')?'no-cache':'public,max-age=3600'});fs.createReadStream(file).pipe(res);return true;}
const server=http.createServer(async(req,res)=>{res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'");const url=new URL(req.url,'http://localhost');try{
  if(req.method==='GET'&&url.pathname==='/healthz')return json(res,200,{ok:true,version:'2.0.0'});
  if(url.pathname.startsWith('/api/auth/')){const handled=await authRoutes(req,res,url);if(handled!==false)return;}
  if(req.method==='POST'&&url.pathname.startsWith('/webhooks/tradingview/')){const secret=decodeURIComponent(url.pathname.slice('/webhooks/tradingview/'.length)),user=store.userByWebhook(secret);if(!user||user.status!=='ACTIVE')return json(res,404,{error:'Not found'});if(user.role!=='ADMIN'&&!store.hasActiveLicense(user.id))return json(res,403,{error:'License inactive or expired'});const signal=normalizeSignal(await readJson(req));if(!store.enqueue(user.id,signal))return json(res,409,{accepted:false,error:'Duplicate trade_id'});return json(res,202,{accepted:true,trade_id:signal.tradeId});}
  if(url.pathname.startsWith('/api/admin/'))return await adminRoutes(req,res,url);
  if(url.pathname.startsWith('/api/'))return await userRoutes(req,res,url);
  if(!serve(res,url.pathname))json(res,404,{error:'Not found'});
}catch(error){store.audit(null,'request.error',null,{message:error.message,path:url.pathname.replace(/\/webhooks\/tradingview\/.+/,'/webhooks/tradingview/[redacted]')});if(!res.headersSent)json(res,400,{error:error.message});}});
worker.start();server.listen(config.port,'0.0.0.0',()=>console.log(`Astra Trade v2 listening on :${config.port}`));const shutdown=()=>{worker.stop();server.close(()=>{store.close();process.exit(0);});};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
