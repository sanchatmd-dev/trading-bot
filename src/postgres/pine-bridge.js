import {randomUUID} from 'node:crypto';
import {inspectSource,validateSelection,canonical,hash,keys,number,fail,versions} from '../pine-bridge/source.js';
import {providerConfig,budgetFor} from '../pine-bridge/provider.js';
import {readJson} from './http.js';
import {membershipSnapshot,effectiveInputs,invalidateEntries,setMembership} from './pine-bridge-registry.js';
import {reviewFields,reviewedInputs} from '../pine-bridge/input-review.js';
import {activateDeployment} from './pine-bridge-readiness.js';
import {createCapture,captureStatus} from './pine-capture.js';

const terminal=new Set(['SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','OUTCOME_UNKNOWN']);
export class PineBridgeService {
  constructor(store,{defaultRisk={},getProvider=providerConfig}={}){this.store=store;this.db=store.db;this.defaultRisk=defaultRisk;this.getProvider=getProvider;}
  async authorize(owner,bot) {
    if(typeof bot!=='string'||!await this.store.ownsBot(owner,bot))throw fail('NOT_FOUND',404);
    if((await this.store.userById(bot))?.status!=='ACTIVE'||(await this.store.userById(owner))?.status!=='ACTIVE')throw fail('NOT_FOUND',404);
  }
  async source(owner,bot,id,version) {
    await this.authorize(owner,bot);
    number(version,{min:1,max:2147483647,integer:true});
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw fail('NOT_FOUND',404);
    const row=await this.db.prepare('SELECT r.*,s.owner_id,s.bot_id FROM pine_source_revisions r JOIN pine_sources s USING(pine_import_id) WHERE s.owner_id=? AND s.bot_id=? AND r.pine_import_id=? AND r.source_version=?').get(owner,bot,id,version);
    if(!row)throw fail('NOT_FOUND',404);return row;
  }
  async inspect(owner,body) {
    keys(body,['bot_id','pine_source']);
    await this.authorize(owner,body.bot_id);
    const analysis=inspectSource(body.pine_source);
    if(analysis.bridge_capability.blockers.includes('INPUT_SCAN_INCOMPLETE'))throw fail('INPUT_SCAN_INCOMPLETE');
    return {source_hash:analysis.source_hash,input_count:analysis.inputs.length,inputs:reviewFields(analysis)};
  }
  async enqueue(owner,operation,body,key) {
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
    if(operation==='analyze')keys(body,['bot_id','pine_source','source_name','pine_import_id','source_version','effective_inputs','input_review'],['bot_id','pine_source','source_name']);
    else keys(body,['bot_id','pine_import_id','source_version','selected_signals','parameter_slots','bridge_options','market']);
    await this.authorize(owner,body.bot_id);
    const preflight=operation==='analyze'?inspectSource(body.pine_source):null;
    await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner);
    if(body.bot_id!==owner)await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(body.bot_id);
    // Serialize queue capacity and repeated clicks across API replicas.
    await this.db.lock('pine-bridge:jobs');
    const requestHash=hash(canonical({operation,body,versions,provider:this.getProvider()}));
    const old=await this.db.prepare('SELECT * FROM pine_bridge_jobs WHERE owner_id=? AND bot_id=? AND operation=? AND idempotency_key=?').get(owner,body.bot_id,operation,key);
    if(old){if(old.request_hash!==requestHash)throw fail('IDEMPOTENCY_CONFLICT',409);return this.summary(old);}
    let source,analysis,selection;
    if(operation==='analyze') {
      if(body.input_review!==undefined&&!body.effective_inputs)throw fail('EFFECTIVE_INPUT_REVIEW_REQUIRED');
      analysis=body.input_review===undefined?effectiveInputs(preflight,body.effective_inputs):reviewedInputs(preflight,body.effective_inputs,body.input_review,owner);
      if(typeof body.source_name!=='string'||body.source_name.length<1||body.source_name.length>120)throw fail('INVALID_SOURCE_NAME');
      if(body.pine_import_id!==undefined){
        number(body.source_version,{min:2,max:2147483647,integer:true});
        const member=await this.db.prepare('SELECT * FROM pine_memberships WHERE pine_import_id=? AND owner_id=? AND bot_id=? FOR UPDATE').get(body.pine_import_id,owner,body.bot_id);
        if(!member)throw fail('NOT_FOUND',404);
        if(body.source_version!==member.source_version+1)throw fail('SOURCE_VERSION_CONFLICT',409);
      }else if(body.source_version!==undefined)throw fail('INVALID_SOURCE_VERSION');
      source={pine_import_id:body.pine_import_id??randomUUID(),source_version:body.source_version??1,source_hash:analysis.source_hash,source:body.pine_source};
    } else {
      source=await this.source(owner,body.bot_id,body.pine_import_id,body.source_version);analysis=source.analysis;
      const member=await this.db.prepare('SELECT * FROM pine_memberships WHERE pine_import_id=?').get(source.pine_import_id);
      if(!member?.connected||member.source_version!==source.source_version)throw fail('STALE_SOURCE',409);
      selection=validateSelection(analysis,body.selected_signals,body.parameter_slots,body.bridge_options);
      const analyzed=await this.db.prepare("SELECT result FROM pine_bridge_jobs WHERE owner_id=? AND bot_id=? AND pine_import_id=? AND request->>'source_version'=? AND operation='analyze' AND status='SUCCEEDED' ORDER BY created_at DESC LIMIT 1").get(owner,body.bot_id,body.pine_import_id,String(source.source_version));
      if(!analyzed)throw fail('ANALYSIS_REQUIRED',409);
      if(selection.bindings.some(b=>!analyzed.result.proposal.eligible_inputs.includes(b.input_id)))throw fail('INPUT_REVIEW_REQUIRED');
      keys(body.market,['broker','symbol','timeframe']);
      if(!['binance-global','binance-th','innovestx','settrade'].includes(body.market.broker)||!/^[A-Z0-9]{3,30}$/.test(body.market.symbol)||!/^\d{1,4}[SDWM]?$/.test(body.market.timeframe))throw fail('INVALID_MARKET');
    }
    const counts=await this.db.prepare("SELECT count(*) total,count(*) FILTER(WHERE owner_id=?) own FROM pine_bridge_jobs WHERE status IN ('QUEUED','RETRY_WAIT') AND deadline>?").get(owner,Date.now());
    if(counts.total>=20||counts.own>=2)throw fail('AI_QUEUE_FULL',429);
    const session=await this.store.getBotSession(body.bot_id);
    const policy=session.locked_policy?JSON.parse(session.locked_policy):await this.store.risk(body.bot_id,this.defaultRisk);
    const capital=await this.store.paperAccounts(body.bot_id);
    let membership=await membershipSnapshot(this,owner,body.bot_id);
    if(operation==='analyze')membership=[...membership.filter(m=>m.pine_import_id!==source.pine_import_id),{pine_import_id:source.pine_import_id,source_version:source.source_version,source_hash:source.source_hash,analysis}].sort((a,b)=>a.pine_import_id.localeCompare(b.pine_import_id));
    const funding=await this.db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(body.bot_id);
    const snapshot={policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:funding.cutoff,membership,session:{state:session.state,run_id:session.run_id??null},captured_at:Date.now()};
    const request={operation,source_version:source.source_version,analysis,selection,provider:this.getProvider(),versions,snapshot,...(operation==='generate'?{deployment:{deployment_id:randomUUID(),pine_import_id:source.pine_import_id,source_version:source.source_version,...body.market}}:{})};
    request.budget=budgetFor(request,source.source);
    if(operation==='analyze'){
      if(!body.pine_import_id)await this.db.prepare('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(source.pine_import_id,owner,body.bot_id,1,source.source_hash,body.source_name,source.source,JSON.stringify(analysis),Date.now());
      await this.db.prepare('INSERT INTO pine_source_revisions(pine_import_id,source_version,source_hash,source,analysis,created_at) VALUES(?,?,?,?,?,?)').run(source.pine_import_id,source.source_version,source.source_hash,source.source,JSON.stringify(analysis),Date.now());
      await this.db.prepare('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version) VALUES(?,?,?,?) ON CONFLICT(pine_import_id) DO UPDATE SET source_version=excluded.source_version').run(source.pine_import_id,owner,body.bot_id,source.source_version);
      await invalidateEntries(this,body.bot_id);
    }
    const now=Date.now(),id=randomUUID();
    await this.db.prepare("INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?,?)").run(id,owner,body.bot_id,operation,key,requestHash,JSON.stringify(request),source.pine_import_id,now,now,now+300000);
    await this.store.audit(owner,'pine_bridge.'+operation+'.queued',id,{bot_id:body.bot_id});
    return {job_id:id,job_status:'QUEUED',pine_import_id:source.pine_import_id,source_version:source.source_version,source_hash:source.source_hash};
  }
  summary(row){return {job_id:row.job_id,job_status:row.status,pine_import_id:row.pine_import_id,source_version:row.request.source_version,source_hash:row.request.analysis.source_hash,deadline:row.deadline,attempts:row.attempt,usage:row.usage,result:row.result,diagnostic:row.diagnostic};}
  async get(owner,id,cancel=false) {
    const row=await this.db.prepare('SELECT * FROM pine_bridge_jobs WHERE job_id=? AND owner_id=? FOR UPDATE').get(id,owner);
    if(!row)throw fail('NOT_FOUND',404);await this.authorize(owner,row.bot_id);
    if(cancel&&!terminal.has(row.status)) {
      await this.db.prepare("UPDATE pine_bridge_jobs SET status='CANCELLED',updated_at=?,lease_until=0 WHERE job_id=?").run(Date.now(),id);
      await this.store.audit(owner,'pine_bridge.cancelled',id,{});row.status='CANCELLED';
    }
    const attempts=await this.db.prepare('SELECT attempt_id,dispatched_at,finished_at,outcome,usage,provider_request_id FROM pine_bridge_attempts WHERE job_id=? ORDER BY dispatched_at,attempt_id').all(id);
    return {...this.summary(row),attempt_details:attempts};
  }
}

export async function pineBridgeRoutes(req,res,url,actor,service,json,{enabled=false,captureEnabled=false,capturePublicOrigin=''}={}) {
  if(!url.pathname.startsWith('/api/quant/pine-bridge/'))return false;
  if(!enabled)throw fail('PINE_BRIDGE_DISABLED',503);
  const base='/api/quant/pine-bridge/';
  const operation=url.pathname.slice(base.length);
  if(operation==='inspect'&&req.method==='POST'){
    json(res,200,await service.inspect(actor.id,await readJson(req)));return true;
  }
  const capture=operation.match(/^deployments\/([a-f0-9-]{36})\/capture$/);
  const session=operation.match(/^captures\/([a-f0-9-]{36})(\/close)?$/);
  if(capture||session){
    if(!captureEnabled)throw fail('PINE_CAPTURE_DISABLED',503);
    if(capture&&req.method==='POST'){
      const created=await createCapture(service,actor.id,capture[1],await readJson(req));
      json(res,201,{...created,...(capturePublicOrigin?{capture_url:capturePublicOrigin+created.capture_path}:{})});return true;
    }
    if(session&&((req.method==='GET'&&!session[2])||(req.method==='POST'&&session[2]))){
      if(session[2])keys(await readJson(req),[]);
      json(res,200,await captureStatus(service,actor.id,session[1],!!session[2]));return true;
    }
    throw fail('NOT_FOUND',404);
  }
  const member=operation.match(/^sources\/([a-f0-9-]{36})\/membership$/);
  if(req.method==='POST'&&member){json(res,200,await setMembership(service,actor.id,member[1],await readJson(req)));return true;}
  const deployment=operation.match(/^deployments\/([a-f0-9-]{36})\/activate$/);
  if(req.method==='POST'&&deployment){keys(await readJson(req),[]);json(res,200,await activateDeployment(service,actor.id,deployment[1]));return true;}
  if(req.method==='POST'&&['analyze','generate'].includes(operation)) {
    json(res,202,await service.enqueue(actor.id,operation,await readJson(req),req.headers['idempotency-key']));return true;
  }
  const job=operation.match(/^jobs\/([a-f0-9-]{36})(\/cancel)?$/);
  if(job&&((req.method==='GET'&&!job[2])||(req.method==='POST'&&job[2]))) {
    if(job[2])keys(await readJson(req),[]);
    json(res,200,await service.get(actor.id,job[1],!!job[2]));return true;
  }
  throw fail('NOT_FOUND',404);
}
