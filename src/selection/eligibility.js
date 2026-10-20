import {STATUS,readState,libraryG8} from '../quant-library/package-gates.js';
import {CODES,CODE_PATTERN,isObject,isInt,isSha,text,canonical,deepFreeze,marketIsRequired,hasOwn} from './codes.js';

/**
 * Participant eligibility (contract section 4): checks E1 to E6 and the never-participants. Each check is PASS, FAIL or
 * NOT_REACHED. Missing, unreadable or unknown input is FAIL. Library and package facts come from package-gates.js by import
 * (readState, libraryG8, STATUS); this module adds no gate of its own.
 *
 * member: {kind, owner_id, run_id, created_at_ms, run_status, source_hash, market, qualification, integrity_checked, package,
 *   validation_records, scope, rules_hash, data_windows, registered_boundary_ms}
 *   qualification is the library-qualification-v2 result (label, gates G1 to G8); integrity_checked is true only for a detail
 *   read, never for a list row. package: {export_id, package_hash, status, binding, current, replay_mismatch}.
 *   validation_records: [{run_id, mode, record}] (the ql4c_validation records of the owner).
 * context: {owner_id, requester_owner_id, scope, fixture} where scope is the registered scope (qr4-scope-v1) and fixture is true for a
 *   fixture selection (OD-S15). A customer selection (fixture false) refuses every fixture package. A fixture selection admits only
 *   fixture packages: E6 requires binding.fixture true, E2 applies the READY predicate with fixture true, E3 reads the fixture
 *   validation record through the same G8 predicate, and E1 needs only a succeeded, integrity-checked run (a fixture run never
 *   qualifies in the library). Such a selection never gets a label and shows only in the internal view.
 */
export const QUALIFICATION_VERSION='library-qualification-v2';
export const GATE_ORDER=Object.freeze(['G1','G2','G3','G4','G5','G6','G7','G8']);
export const CHECKS=Object.freeze(['E1','E2','E3','E4','E5','E6']);
/** Evaluation priority of the first failing code. The specific fixture and multi-Pine codes come before the general package codes. */
export const CODE_PRIORITY=Object.freeze(['E6','E1','E2','E3','E4','E5']);
export const MEMBER_KINDS=Object.freeze(['RESEARCH_RUN','ACTUAL_HISTORY','IMPORTED_BUNDLE','EVALUATION_RUN']);
/** Library labels that make a run development-only (section 3.2). */
export const DEVELOPMENT_LABELS=Object.freeze(['NOT_EVALUATED','NO_SCREENED_CANDIDATE','DEVELOPMENT_ONLY']);
/**
 * Scope fields a participant carries and must equal (section 5.2). Market is E4, valuation is a registration check, rules is uniformity.
 * The engine is not here: the engine rule of 5.2 is about evaluation runs only (ranking.js pins one engine at registration and every
 * evaluation must equal it), and a participant's own research-run engine is never compared.
 */
export const SCOPE_FIELDS=Object.freeze(['data_model','cost_model','capital','policy']);

const codeLike=value=>typeof value==='string'&&CODE_PATTERN.test(value)?value:null;
const same=(a,b)=>{try{return canonical(a)===canonical(b);}catch{return false;}};
const pass=()=>({state:'PASS'});
const fail=(code,detail=null,extra={})=>({state:'FAIL',code,detail:detail===null?null:String(detail).slice(0,120),...extra});
const notReached=()=>({state:'NOT_REACHED'});

function firstFailingGate(gates){
  if(!Array.isArray(gates))return 'GATES_UNREADABLE';
  for(const name of GATE_ORDER){
    const gate=gates.find(item=>isObject(item)&&item.gate===name);
    if(!gate)return name;
    if(gate.state!=='PASS')return codeLike(gate.code)??name;
  }
  return null;
}

/**
 * E1: library gates. A development-only label is never rankable (section 4.2); a QUALIFIED label needs all eight gates PASS and a
 * detail-level integrity check. A fixture selection needs a succeeded run, a readable qualification and the integrity check only.
 */
export function checkLibrary(member,fixture=false){
  const status=member.run_status;
  if(status!=='SUCCEEDED')return fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,codeLike(status)??'RUN_STATUS_UNREADABLE');
  const q=member.qualification;
  if(!isObject(q)||q.version!==QUALIFICATION_VERSION||typeof q.label!=='string')return fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,'QUALIFICATION_UNREADABLE');
  if(fixture)return member.integrity_checked===true?pass():fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,'INTEGRITY_NOT_CHECKED');
  if(DEVELOPMENT_LABELS.includes(q.label))return fail(CODES.QR4_DEVELOPMENT_SCORE_NOT_RANKABLE,firstFailingGate(q.gates)??q.label);
  if(q.label!=='QUALIFIED'||q.qualified!==true)return fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,'QUALIFICATION_LABEL_UNKNOWN');
  if(member.integrity_checked!==true)return fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,'INTEGRITY_NOT_CHECKED');
  const gate=firstFailingGate(q.gates);
  return gate===null?pass():fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,gate);
}

/** E2: package READY (QL4 6.3 and OD-15), through readState. stale is true when only freshness fails on a validated package. */
export function checkPackage(member,requester,fixture=false){
  const pkg=member.package;
  if(!isObject(pkg)||!text(pkg.export_id)||pkg.export_id!==member.export_id||!isSha(pkg.package_hash))return {...fail(CODES.QR4_PARTICIPANT_NOT_READY,'PACKAGE_MISSING'),stale:false};
  if(!text(requester))return {...fail(CODES.QR4_PARTICIPANT_NOT_READY,'REQUESTER_UNREADABLE'),stale:false};
  const view=readState({status:pkg.status,binding:pkg.binding,current:pkg.current,replay_mismatch:pkg.replay_mismatch,requester_owner_id:requester});
  if(typeof view.refused==='string')return {...fail(CODES.QR4_PARTICIPANT_NOT_READY,codeLike(view.refused)??'READ_REFUSED'),stale:false};
  const own=isObject(pkg.binding)?pkg.binding:{},current=isObject(pkg.current)?pkg.current:{};
  // READY needs a non-fixture package. A fixture selection applies the same predicate with the fixture flag true.
  const ready=fixture?pkg.status===STATUS.EXPORT_VALIDATED&&view.fresh===true&&own.mode==='ONE_PINE'&&own.fixture===true&&current.bot_owner_id===requester:view.ready===true;
  if(ready)return {...pass(),stale:false};
  const validated=pkg.status===STATUS.EXPORT_VALIDATED;
  if(!validated)return {...fail(CODES.QR4_PARTICIPANT_NOT_READY,Object.values(STATUS).includes(pkg.status)?pkg.status:'STATUS_UNKNOWN'),stale:false};
  if(view.fresh!==true)return {...fail(CODES.QR4_PARTICIPANT_NOT_READY,codeLike(view.code)??'STALE'),stale:true};
  const binding=isObject(pkg.binding)?pkg.binding:{};
  const reason=binding.mode!=='ONE_PINE'?'MODE_NOT_ONE_PINE':fixture?(binding.fixture!==true?'NOT_FIXTURE':'BOT_NOT_OWNED'):binding.fixture!==false?'FIXTURE':'BOT_NOT_OWNED';
  return {...fail(CODES.QR4_PARTICIPANT_NOT_READY,reason),stale:false};
}

/** E3: the ql4c_validation record that makes G8 PASS names this export_id and package_hash and carries validated_at_utc. */
export function checkValidationBinding(member,fixture=false){
  const pkg=member.package,records=Array.isArray(member.validation_records)?member.validation_records:[];
  // A fixture selection reads the fixture record through the same G8 predicate: only its fixture flag is flipped, nothing else is relaxed.
  const asG8=item=>fixture?(isObject(item.record)&&item.record.fixture===true?{...item,record:{...item.record,fixture:false}}:null):item;
  const passing=records.filter(item=>isObject(item)&&item.run_id===member.run_id&&asG8(item)!==null&&libraryG8([asG8(item)],member.run_id).state==='PASS').map(item=>item.record);
  const bound=passing.find(record=>record.export_id===pkg.export_id&&record.package_hash===pkg.package_hash);
  if(!bound)return fail(CODES.QR4_VALIDATION_BINDING_MISMATCH,passing.length===0?'G8_RECORD_MISSING':'PACKAGE_HASH_OR_EXPORT_DIFFERS');
  if(!text(bound.validated_at_utc))return fail(CODES.QR4_VALIDATION_BINDING_MISMATCH,'VALIDATED_AT_MISSING');
  return {...pass(),binding:{export_id:bound.export_id,package_hash:bound.package_hash,validated_at_utc:bound.validated_at_utc}};
}

/** E5: every scope field equals the registered scope. The mismatch list follows the order of SCOPE_FIELDS. */
export function scopeMismatches(member,scope){
  const own=isObject(member.scope)?member.scope:{};
  return SCOPE_FIELDS.filter(field=>!hasOwn(own,field)||!hasOwn(scope,field)||!same(own[field],scope[field]));
}

/**
 * E6: fixture and multi-Pine packages are never participants of a customer selection (reported on its own for clarity). In a fixture
 * selection (OD-S15) the rule flips for the fixture flag only: a non-fixture package is not a participant, and multi-Pine stays excluded.
 */
export function checkExclusions(member,fixture=false){
  const binding=isObject(member.package)&&isObject(member.package.binding)?member.package.binding:null;
  if(binding===null)return fail(CODES.QR4_FIXTURE_PARTICIPANT,'BINDING_UNREADABLE');
  if(typeof binding.fixture!=='boolean')return fail(CODES.QR4_FIXTURE_PARTICIPANT,'FIXTURE_FLAG_UNREADABLE');
  if(fixture&&binding.fixture!==true)return fail(CODES.QR4_FIXTURE_PARTICIPANT,'NOT_FIXTURE_IN_FIXTURE_SELECTION');
  if(!fixture&&binding.fixture===true)return fail(CODES.QR4_FIXTURE_PARTICIPANT,'FIXTURE');
  if(binding.mode==='MULTI_PINE')return fail(CODES.QR4_MULTI_PINE_PARTICIPANT,'MULTI_PINE');
  if(binding.mode!=='ONE_PINE')return fail(CODES.QR4_MULTI_PINE_PARTICIPANT,'MODE_UNREADABLE');
  return pass();
}

/** Kinds that are never participants (section 4.2). Returns a failure or null. */
export function neverParticipant(member){
  switch(member.kind){
    case 'RESEARCH_RUN':return null;
    case 'ACTUAL_HISTORY':return fail(CODES.QR4_ACTUAL_HISTORY_NOT_RANKABLE,'ACTUAL_HISTORY');
    case 'IMPORTED_BUNDLE':return fail(CODES.QR4_PARTICIPANT_NOT_READY,'IMPORTED_BUNDLE');
    case 'EVALUATION_RUN':return fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,'EVALUATION_RUN_NOT_RESEARCH_RUN');
    default:return fail(CODES.QR4_PARTICIPANT_NOT_QUALIFIED,'KIND_UNKNOWN');
  }
}

const idOf=member=>text(member.run_id)?member.run_id:'UNKNOWN';
/**
 * Evaluate one universe member. Returns a frozen result:
 * {run_id, export_id, created_at_ms, kind, library_class, qualification_label, package_status (the universe snapshot fields of 3.4),
 *  eligible, status (PARTICIPANT, QUALIFIED_STALE, EXCLUDED), code (first failing, or null),
 *  detail, checks:{E1..E6}, failures:[{check,code,detail}], mismatched_fields, validation_binding}
 */
export function evaluateEligibility(input,context){
  try{return evaluate(input,context);}
  catch{return deepFreeze({run_id:'UNKNOWN',export_id:null,created_at_ms:0,kind:null,library_class:null,qualification_label:null,package_status:null,eligible:false,status:'EXCLUDED',code:CODES.QR4_PARTICIPANT_NOT_QUALIFIED,detail:'UNEXPECTED_INPUT',
    checks:Object.fromEntries(CHECKS.map(name=>[name,'NOT_REACHED'])),failures:[],mismatched_fields:[],validation_binding:null});}
}
function evaluate(input,context){
  const member=isObject(input)?input:{},ctx=isObject(context)?context:{};
  const result={run_id:idOf(member),export_id:text(member.export_id)?member.export_id:null,created_at_ms:isInt(member.created_at_ms)?member.created_at_ms:0,
    kind:typeof member.kind==='string'?member.kind.slice(0,40):null,
    library_class:text(member.library_class)?member.library_class.slice(0,40):null,
    qualification_label:isObject(member.qualification)&&text(member.qualification.label)?member.qualification.label.slice(0,40):null,
    package_status:isObject(member.package)&&text(member.package.status)?member.package.status.slice(0,40):null};
  const fixture=ctx.fixture===true;
  const checks=Object.fromEntries(CHECKS.map(name=>[name,'NOT_REACHED']));
  const finish=(status,failures,extra={})=>{
    const ordered=[...failures].sort((a,b)=>CODE_PRIORITY.indexOf(a.check)-CODE_PRIORITY.indexOf(b.check));
    return deepFreeze({...result,eligible:status==='PARTICIPANT',status,code:ordered[0]?.code??null,detail:ordered[0]?.detail??null,checks,
      failures:ordered.map(({check,code,detail})=>({check,code,detail})),mismatched_fields:[],validation_binding:null,...extra});
  };
  const outsider=neverParticipant(member);
  // A never-participant kind and a foreign or unreadable run are reported under E1, so E1 is FAIL and not NOT_REACHED.
  if(outsider){checks.E1='FAIL';return finish('EXCLUDED',[{check:'E1',...outsider}]);}
  if(!text(member.run_id)||!text(ctx.owner_id)||member.owner_id!==ctx.owner_id){checks.E1='FAIL';return finish('EXCLUDED',[{check:'E1',...fail(CODES.NOT_FOUND,'OWNER_OR_RUN_UNREADABLE')}]);}
  const failures=[];
  const record=(name,outcome)=>{checks[name]=outcome.state;if(outcome.state==='FAIL')failures.push({check:name,code:outcome.code,detail:outcome.detail});};
  record('E1',checkLibrary(member,fixture));
  const pkg=checkPackage(member,ctx.requester_owner_id,fixture);
  record('E2',pkg);
  const packaged=isObject(member.package)&&isSha(member.package.package_hash)&&text(member.package.export_id);
  let binding=null;
  if(packaged){
    const bound=checkValidationBinding(member,fixture);
    record('E3',bound);
    binding=bound.binding??null;
    record('E6',checkExclusions(member,fixture));
  }
  record('E4',marketIsRequired(member.market)?pass():fail(CODES.BI_MARKET_SCOPE_INVALID,'MARKET'));
  const scope=isObject(ctx.scope)?ctx.scope:null;
  const mismatched=scope===null?[...SCOPE_FIELDS]:scopeMismatches(member,scope);
  record('E5',mismatched.length===0?pass():fail(CODES.QR4_SCOPE_INCOMPATIBLE,mismatched.join(',')));
  const stale=checks.E1==='PASS'&&pkg.stale===true&&failures.every(item=>item.check==='E2');
  const status=failures.length===0?'PARTICIPANT':stale?'QUALIFIED_STALE':'EXCLUDED';
  return finish(status,failures,{mismatched_fields:mismatched,validation_binding:failures.length===0?binding:null});
}
