import {hashPassword,verifyPassword,randomToken,hashToken,encryptJson,decryptJson} from './security.js';
import {newTotpSecret,verifyTotp} from './mfa.js';
import {readJson,clientIp} from './http-safety.js';
import {transaction} from './ledger.js';
import {permissionsFor,privileged} from './permissions.js';

const unsafe=method=>!['GET','HEAD','OPTIONS'].includes(method);
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const resetMessage='If this account is eligible, a recovery link will be sent. Check your email or contact your administrator.';
const emailOf=body=>typeof body.email==='string'&&body.email.length<=254?body.email.trim().toLowerCase():'';
const cookieValue=(req,name)=>{
  const matches=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  const value=matches.length===1?matches[0].slice(name.length+1):'';
  return /^[a-f0-9]{64}$/.test(value)?value:'';
};
export class Auth {
  constructor(store,config,json){
    Object.assign(this,{store,config,json});this.db=store.db;
    this.cookieName=config.secureCookies?'__Host-robot_session':'robot_session';
    this.challengeName=config.secureCookies?'__Host-robot_challenge':'robot_challenge';
    this.dummyHash=hashPassword(randomToken());
  }
  writeCookie(res,name,value,seconds){
    const cookie=`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.config.secureCookies?'; Secure':''}`;
    res.setHeader('set-cookie',[...(res.getHeader('set-cookie')||[]),cookie]);
  }
  checkOrigin(req){
    if(!unsafe(req.method))return;
    if(req.headers.origin!==this.config.publicOrigin||req.headers['sec-fetch-site']==='cross-site')throw fail(403,'Origin is not allowed');
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'JSON content type required');
  }
  session(req){
    if(req.authUser)return req.authUser;
    const token=cookieValue(req,this.cookieName);if(!token)return null;
    const row=this.db.prepare(`SELECT u.id,u.email,u.role,u.status,u.parent_user_id,s.expires_at,s.last_seen,s.elevated_until,s.mfa_verified
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token));
    const now=Date.now();
    if(!row||row.status!=='ACTIVE'||row.parent_user_id||row.expires_at<=now||row.last_seen<=now-this.config.sessionIdleMinutes*60000){
      this.store.deleteSession(token);return null;
    }
    if(unsafe(req.method)&&req.headers['x-csrf-token']!==hashToken('csrf:'+token))throw fail(403,'Invalid CSRF token');
    this.db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now,hashToken(token));
    req.authToken=token;req.authUser=row;return row;
  }
  require(req){
    const user=this.session(req);if(!user)throw fail(401,'Unauthorized');
    req.validateAuth=()=>{req.authUser=null;this.require(req);if(req.sensitiveChecked)this.sensitive(req);};
    return user;
  }
  state(user){
    const enabled=!!this.db.prepare('SELECT mfa_secret FROM user_security WHERE user_id=?').get(user.id)?.mfa_secret;
    return {mfaEnabled:enabled,mfaRequired:privileged(user),mfaEnrollmentRequired:privileged(user)&&!enabled,
      recoveryCodesRemaining:this.db.prepare('SELECT count(*) n FROM mfa_recovery WHERE user_id=?').get(user.id).n,
      permissions:permissionsFor(user.role),elevatedUntil:user.elevated_until||0};
  }
  sensitive(req){
    const user=this.require(req),state=this.state(user);
    if(state.mfaEnrollmentRequired)throw fail(403,'Set up two-factor authentication first','MFA_ENROLLMENT_REQUIRED');
    if(state.mfaEnabled&&!user.mfa_verified)throw fail(403,'Two-factor verification required','STEP_UP_REQUIRED');
    if(user.elevated_until<=Date.now())throw fail(403,'Confirm your identity to continue','STEP_UP_REQUIRED');
    req.sensitiveChecked=true;return user;
  }
  limit(key,limit=10,window=900000){
    const now=Date.now(),hashed=hashToken(key);
    this.db.prepare('DELETE FROM security_limits WHERE expires_at<=?').run(now);
    const existing=this.db.prepare('SELECT 1 FROM security_limits WHERE key_hash=?').get(hashed);
    if(!existing&&this.db.prepare('SELECT count(*) n FROM security_limits').get().n>=10000)return false;
    const row=this.db.prepare(`INSERT INTO security_limits(key_hash,attempts,expires_at) VALUES(?,1,?)
      ON CONFLICT(key_hash) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).get(hashed,now+window);
    return row.attempts<=limit;
  }
  issue(req,res,user,verified=false){
    const token=randomToken(),expires=Date.now()+this.config.sessionTtlHours*3600000;
    this.store.deleteSession(cookieValue(req,this.cookieName));
    this.store.createSession(user.id,token,expires);
    this.db.prepare('UPDATE sessions SET elevated_until=?,mfa_verified=? WHERE token_hash=?').run(Date.now()+600000,verified?1:0,hashToken(token));
    this.writeCookie(res,this.cookieName,token,Math.floor((expires-Date.now())/1000));
    this.writeCookie(res,this.challengeName,'',0);
    this.store.audit(user.id,'auth.login',null,{mfa:verified});
    return {csrfToken:hashToken('csrf:'+token),expiresAt:expires,user:this.store.userById(user.id),security:this.state({...user,elevated_until:Date.now()+600000})};
  }
  consumeFactor(userId,code){
    if(typeof code!=='string'||code.length>100)return false;
    const row=this.db.prepare('SELECT * FROM user_security WHERE user_id=?').get(userId);
    if(!row?.mfa_secret)return false;
    const secret=decryptJson(row.mfa_secret,this.config.keyring,`mfa:${userId}`).secret;
    const step=verifyTotp(secret,code,row.last_step);
    if(step!==null)return this.db.prepare('UPDATE user_security SET last_step=? WHERE user_id=? AND last_step<?').run(step,userId,step).changes===1;
    return this.db.prepare('DELETE FROM mfa_recovery WHERE user_id=? AND code_hash=?').run(userId,hashToken(userId+':'+code.toUpperCase())).changes===1;
  }
  async routes(req,res,url){
    const route=url.pathname,method=req.method,ip=clientIp(req,this.config.trustLoopbackProxy);
    if(method==='GET'&&route==='/api/auth/session'){
      const user=this.session(req);
      return this.json(res,200,user?{authenticated:true,csrfToken:hashToken('csrf:'+req.authToken),user:this.store.userById(user.id),security:this.state(user)}:{authenticated:false});
    }
    if(method==='GET'&&route==='/api/auth/config')return this.json(res,200,{emailRecovery:!!this.config.smtp.host});
    if(method==='POST'&&route==='/api/auth/login'){
      if(!this.limit('login-ip:'+ip,20))throw fail(429,'Too many login attempts. Try again later');
      const body=await readJson(req),email=emailOf(body);
      if(!this.limit('login-email:'+email,20))throw fail(429,'Too many login attempts. Try again later');
      let user=this.store.userByEmail(email);const checkedHash=user?.password_hash;
      const valid=await verifyPassword(body.password,checkedHash||await this.dummyHash);
      user=this.store.userByEmail(email);
      if(!valid||!user||user.password_hash!==checkedHash||user.parent_user_id||user.status!=='ACTIVE'){
        this.store.audit(null,'auth.login.failed',null,{});throw fail(401,'Invalid email or password');
      }
      if(this.state(user).mfaEnabled){
        const challenge=randomToken();
        this.db.prepare('DELETE FROM auth_challenges WHERE user_id=? OR expires_at<=?').run(user.id,Date.now());
        this.db.prepare('INSERT INTO auth_challenges(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(challenge),user.id,Date.now()+300000);
        this.writeCookie(res,this.challengeName,challenge,300);
        return this.json(res,200,{mfaRequired:true});
      }
      return this.json(res,200,this.issue(req,res,user));
    }
    if(method==='POST'&&route==='/api/auth/mfa/login'){
      const token=cookieValue(req,this.challengeName),key=hashToken(token),row=this.db.prepare('SELECT * FROM auth_challenges WHERE token_hash=?').get(key);
      if(!this.limit('mfa-ip:'+ip,30)||!row||row.expires_at<=Date.now()||row.attempts>=5)throw fail(401,'Verification expired. Sign in again');
      this.db.prepare('UPDATE auth_challenges SET attempts=attempts+1 WHERE token_hash=?').run(key);
      const body=await readJson(req),user=this.store.userById(row.user_id);
      // A slow request must not revive a challenge revoked by reset, logout or another login.
      if(!this.db.prepare('SELECT 1 FROM auth_challenges WHERE token_hash=? AND expires_at>?').get(key,Date.now()))throw fail(401,'Verification expired. Sign in again');
      if(!user||user.status!=='ACTIVE'||!this.consumeFactor(user.id,body.code))throw fail(401,'Invalid verification code');
      this.db.prepare('DELETE FROM auth_challenges WHERE user_id=?').run(user.id);
      return this.json(res,200,this.issue(req,res,user,true));
    }
    if(method==='POST'&&route==='/api/auth/forgot-password'){
      if(!this.limit('reset-ip:'+ip,10))throw fail(429,'Too many recovery requests. Try again later');
      const body=await readJson(req),email=emailOf(body);
      const allowed=this.limit('reset-email:'+email,3),user=this.store.userByEmail(email);
      if(allowed&&this.config.smtp.host&&user&&!user.parent_user_id&&user.status==='ACTIVE'){
        const token=randomToken(),expires=Date.now()+900000;
        transaction(this.store,()=>{
          this.db.prepare('DELETE FROM password_resets WHERE user_id=? OR expires_at<=?').run(user.id,Date.now());
          this.db.prepare('DELETE FROM security_mail WHERE user_id=?').run(user.id);
          this.db.prepare('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token),user.id,expires);
          const link=this.config.publicOrigin+'/#reset='+token;
          const encrypted=encryptJson({subject:'Robot trade password recovery',body:`Reset your password within 15 minutes: ${link}\nIf you did not request this, ignore this email. Two-factor authentication remains required when enabled.`},this.config.keyring,`security-mail:${user.id}`);
          this.db.prepare('INSERT INTO security_mail(user_id,encrypted_body,expires_at) VALUES(?,?,?)').run(user.id,encrypted,expires);
          this.store.audit(user.id,'auth.recovery.requested',null,{});
        });
      }
      return this.json(res,200,{message:resetMessage});
    }
    if(method==='POST'&&route==='/api/auth/reset-password'){
      if(!this.limit('reset-use:'+ip,15))throw fail(429,'Too many verification attempts');
      const body=await readJson(req);
      if(typeof body.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token))throw fail(400,'Invalid or expired recovery link');
      const row=this.db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires_at>?').get(hashToken(body.token),Date.now());
      const user=row&&this.store.userById(row.user_id);
      if(!user||user.parent_user_id||user.status!=='ACTIVE')throw fail(400,'Invalid or expired recovery link');
      if(!this.limit('reset-token:'+body.token,5))throw fail(429,'Request a new recovery link');
      const passwordHash=await hashPassword(body.newPassword);
      transaction(this.store,()=>{
        if(!this.db.prepare('SELECT 1 FROM password_resets WHERE token_hash=? AND expires_at>?').get(hashToken(body.token),Date.now()))throw fail(400,'Invalid or expired recovery link');
        if(this.state(user).mfaEnabled&&!this.consumeFactor(user.id,body.code))throw fail(400,'Authenticator or recovery code required','MFA_REQUIRED');
        this.store.setPassword(user.id,passwordHash);
        this.store.audit(user.id,'auth.recovery.completed',null,{sessionsRevoked:true});
      });
      this.writeCookie(res,this.cookieName,'',0);return this.json(res,200,{ok:true});
    }
    const user=this.require(req);
    if(method==='POST'&&route==='/api/auth/logout'){
      this.db.prepare('DELETE FROM auth_challenges WHERE token_hash=?').run(hashToken(cookieValue(req,this.challengeName)));
      this.store.deleteSession(req.authToken);this.writeCookie(res,this.cookieName,'',0);this.writeCookie(res,this.challengeName,'',0);
      return this.json(res,200,{ok:true});
    }
    if(method==='POST'&&route==='/api/auth/step-up'){
      if(!this.limit('step-up:'+user.id,10))throw fail(429,'Too many verification attempts');
      const body=await readJson(req),full=this.store.userByEmail(user.email);
      if(!await verifyPassword(body.password,full.password_hash))throw fail(401,'Invalid verification');
      // Password may have changed while scrypt was running.
      req.validateAuth();
      const enabled=this.state(user).mfaEnabled;
      if(enabled&&!this.consumeFactor(user.id,body.code))throw fail(401,'Invalid verification code');
      return this.json(res,200,this.issue(req,res,user,enabled));
    }
    if(method==='POST'&&route==='/api/auth/mfa/setup'){
      if(!this.limit('mfa-setup:'+user.id,10))throw fail(429,'Too many setup attempts');
      const body=await readJson(req),full=this.store.userByEmail(user.email);
      if(!await verifyPassword(body.password,full.password_hash))throw fail(401,'Invalid verification');
      req.validateAuth();
      if(this.state(user).mfaEnabled)throw fail(409,'Two-factor authentication is already enabled');
      const secret=newTotpSecret(),encrypted=encryptJson({secret},this.config.keyring,`mfa:${user.id}`);
      this.db.prepare(`INSERT INTO user_security(user_id,pending_secret,pending_expires) VALUES(?,?,?) ON CONFLICT(user_id)
        DO UPDATE SET pending_secret=excluded.pending_secret,pending_expires=excluded.pending_expires`).run(user.id,encrypted,Date.now()+600000);
      return this.json(res,200,{secret,uri:`otpauth://totp/${encodeURIComponent('Robot trade:'+user.email)}?secret=${secret}&issuer=Robot%20trade&algorithm=SHA1&digits=6&period=30`});
    }
    if(method==='POST'&&route==='/api/auth/mfa/enable'){
      if(!this.limit('mfa-enable:'+user.id,10))throw fail(429,'Too many verification attempts');
      const body=await readJson(req),row=this.db.prepare('SELECT * FROM user_security WHERE user_id=?').get(user.id);
      if(!row?.pending_secret||row.mfa_secret||row.pending_expires<=Date.now())throw fail(400,'Start two-factor setup again');
      const step=verifyTotp(decryptJson(row.pending_secret,this.config.keyring,`mfa:${user.id}`).secret,body.code);
      if(step===null)throw fail(400,'Invalid verification code');
      const recoveryCodes=Array.from({length:10},()=>randomToken(8).toUpperCase());
      transaction(this.store,()=>{
        this.db.prepare('UPDATE user_security SET mfa_secret=pending_secret,pending_secret=NULL,pending_expires=0,last_step=? WHERE user_id=?').run(step,user.id);
        this.db.prepare('DELETE FROM mfa_recovery WHERE user_id=?').run(user.id);
        for(const code of recoveryCodes)this.db.prepare('INSERT INTO mfa_recovery VALUES(?,?)').run(user.id,hashToken(user.id+':'+code));
        this.store.revokeSessions(user.id);
        this.store.audit(user.id,'auth.mfa.enabled',null,{});
      });
      return this.json(res,200,{...this.issue(req,res,user,true),recoveryCodes});
    }
    if(method==='POST'&&route==='/api/auth/mfa/disable'){
      const body=await readJson(req);
      if(privileged(user))throw fail(403,'Two-factor authentication is required for this role');
      if(!this.limit('mfa-disable:'+user.id,10))throw fail(429,'Too many verification attempts');
      const full=this.store.userByEmail(user.email);
      if(!await verifyPassword(body.password,full.password_hash))throw fail(401,'Invalid verification');
      req.validateAuth();
      transaction(this.store,()=>{
        if(!this.consumeFactor(user.id,body.code))throw fail(401,'Invalid verification code');
        this.db.prepare('DELETE FROM user_security WHERE user_id=?').run(user.id);
        this.db.prepare('DELETE FROM mfa_recovery WHERE user_id=?').run(user.id);
        this.store.revokeSessions(user.id);this.store.audit(user.id,'auth.mfa.disabled',null,{});
      });
      return this.json(res,200,this.issue(req,res,user));
    }
    return this.json(res,404,{error:'Not found'});
  }
}

export class SecurityMailWorker {
  constructor(store,config,notifier){Object.assign(this,{store,config,notifier});}
  start(){this.timer=setInterval(()=>this.run(),1000);this.timer.unref();}
  run(){if(this.active||this.stopping)return;this.active=this.tick().catch(()=>this.store.audit(null,'auth.recovery.delivery_error',null,{})).finally(()=>{this.active=null;});}
  async tick(){
    const db=this.store.db,now=Date.now();
    db.prepare('DELETE FROM security_mail WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM password_resets WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM sessions WHERE expires_at<=? OR last_seen<=?').run(now,now-(this.config.sessionIdleMinutes||30)*60000);
    db.prepare('UPDATE user_security SET pending_secret=NULL,pending_expires=0 WHERE pending_secret IS NOT NULL AND pending_expires<=?').run(now);
    const row=db.prepare("SELECT * FROM security_mail WHERE status='PENDING' AND next_attempt<=? ORDER BY id LIMIT 1").get(now);
    if(!row)return;
    const user=this.store.userById(row.user_id);
    if(!user||user.status!=='ACTIVE'){db.prepare('DELETE FROM security_mail WHERE id=?').run(row.id);return;}
    const message=decryptJson(row.encrypted_body,this.config.keyring,`security-mail:${user.id}`);
    const sent=await this.notifier.send(user.email,message.subject,message.body);
    if(sent||row.attempts>=4){db.prepare('DELETE FROM security_mail WHERE id=?').run(row.id);this.store.audit(user.id,sent?'auth.recovery.sent':'auth.recovery.delivery_failed',null,{});}
    else db.prepare('UPDATE security_mail SET attempts=attempts+1,next_attempt=? WHERE id=?').run(now+1000*2**(row.attempts+1),row.id);
  }
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;}
}
