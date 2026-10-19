import {Money,canonical,hash,QR3_VERSIONS,CODES,MODES,REGISTRY_DEFAULTS,isObject,isInt,isNumber,text,dec,decString,norm,out,round12,deepFreeze,refuse,numberRefusal,neutralCompare} from './common.js';
import {BEST_LABEL,TIED_BEST_LABEL,ONLY_QUALIFIED_LABEL} from './labels.js';

/**
 * Frozen spec (section 6.1, 6.2, F1 to F8), uncertainty (6.4), ties (6.5), ranking rules (6.6) and the outcome (8.1) of the
 * pure QR-3 module. The spec is validated and hashed before any metric exists; thresholds are read from the spec, never from a
 * current code constant (F6). Ranking compares exact decimals, so 1.50 equals 1.5. There is no weighted score, no random or
 * creation-time tie-break, and nothing here ranks an ACTUAL_BOT participant or a participant that is not ELIGIBLE_QUALIFIED.
 * Every *_exact output is the unrounded value at 80 digits (src/money.js), not a rational (RC-C14).
 */
export const OBJECTIVES=Object.freeze({[QR3_VERSIONS.objective]:Object.freeze({id:QR3_VERSIONS.objective,metric:'net_return_percent',direction:'HIGHER_IS_BETTER',
  risk_filter:'MAX_DRAWDOWN_PERCENT_ON_GRID_V4',tie_break:null,weights:null,
  rule_text:'Net return percent over the evaluation window after costs, higher is better; participants above the drawdown limit are filtered; no composite score and no tie-break.'})});
export const APPROVED_UNCERTAINTY=Object.freeze([QR3_VERSIONS.uncertainty]);
const MAX_RESAMPLES=20000;
const MAX_BLOCK=3650;

const incomplete=(detail)=>refuse(CODES.QR3_SPEC_INCOMPLETE,detail);
const loosened=(detail)=>refuse(CODES.QR3_FILTER_LOOSENED,detail);

/**
 * Spec hash (C15): hash of objective, filters, adequacy, tie and uncertainty for STANDARDIZED, so a changed seed changes the hash;
 * hash of the whole frozen spec for ACTUAL_BOT. Recomputed from a frozen spec by decideOutcome. Null when the spec is unreadable.
 */
export function specHashOf(frozen){
  if(!isObject(frozen))return null;
  if(frozen.mode==='ACTUAL_BOT')return hash(canonical(frozen));
  return hash(canonical({version:QR3_VERSIONS.spec,objective:frozen.objective,risk_filter:frozen.risk_filter,adequacy:frozen.adequacy,tie:frozen.tie,uncertainty:frozen.uncertainty}));
}
/**
 * Validate and normalise a spec; returns the normalised spec with spec_hash (C15: hash of objective, filters, adequacy, tie and
 * uncertainty, so a changed seed changes the hash). Check order: mode, ACTUAL_BOT purity, objective, risk filter, adequacy, tie,
 * benchmark, uncertainty, then tightening against the registry (F7). The first failing check refuses.
 * spec: {mode, participants:[ids], period, objective, risk_filter:{max_drawdown_percent}, adequacy:{min_episodes_floor,min_episodes_ranking},
 *   tie:{band_pp}, benchmark, uncertainty:{method, seed, resamples, block_length, confidence}, owner_max_drawdown_percent?}
 * Section 6.2 default: the drawdown limit may not exceed the lower of the registry default (20) and the owner's own limit, which a caller passes
 * as owner_max_drawdown_percent (a decimal string). The owner limit is a check input and does not enter the spec hash.
 * F7 (OWNER, open): a tie band below the registry band is QR3_FILTER_LOOSENED; a wider band is refused QR3_SPEC_INCOMPLETE with detail
 * TIE_BAND_FIXED until the owner decides whether a wider band is an allowed tightening.
 */
export function validateSpec(spec,registry=REGISTRY_DEFAULTS){
  const input=isObject(spec)?spec:{};
  if(!MODES.includes(input.mode))return refuse(CODES.QR3_MODE_REQUIRED);
  if(input.mode==='ACTUAL_BOT'){
    for(const name of ['objective','risk_filter','adequacy','tie','benchmark','uncertainty'])if(input[name]!==undefined&&input[name]!==null)return refuse(CODES.QR3_OBJECTIVE_NOT_ALLOWED,name);
    const frozen={version:QR3_VERSIONS.spec,mode:'ACTUAL_BOT',participants:Array.isArray(input.participants)?[...input.participants].sort():[],period:input.period??null};
    return deepFreeze({ok:true,code:null,detail:null,spec:frozen,spec_hash:specHashOf(frozen),limitations:[]});
  }
  if(!text(input.objective))return incomplete('objective');
  if(!Object.hasOwn(OBJECTIVES,input.objective))return refuse(CODES.QR3_OBJECTIVE_UNKNOWN);
  const filter=input.risk_filter,sample=input.adequacy,tie=input.tie,uncertainty=input.uncertainty;
  if(isObject(filter)&&isNumber(filter.max_drawdown_percent))return numberRefusal();
  const limit=isObject(filter)?decString(filter.max_drawdown_percent):null;
  if(!limit||limit.lt(0)||limit.gt(100))return incomplete('risk_filter');
  let maxDrawdown=dec(registry.max_drawdown_percent);
  if(input.owner_max_drawdown_percent!==undefined&&input.owner_max_drawdown_percent!==null){
    if(isNumber(input.owner_max_drawdown_percent))return numberRefusal();
    const ownerLimit=decString(input.owner_max_drawdown_percent);
    if(!ownerLimit||ownerLimit.lt(0)||ownerLimit.gt(100))return incomplete('owner_max_drawdown_percent');
    if(ownerLimit.lt(maxDrawdown))maxDrawdown=ownerLimit;
  }
  if(!isObject(sample)||!isInt(sample.min_episodes_floor)||!isInt(sample.min_episodes_ranking)||sample.min_episodes_floor<1||sample.min_episodes_ranking<sample.min_episodes_floor)return incomplete('adequacy');
  if(isObject(tie)&&isNumber(tie.band_pp))return numberRefusal();
  const band=isObject(tie)?decString(tie.band_pp):null;
  if(!band||band.lt(0))return incomplete('tie');
  if(!text(input.benchmark)||input.benchmark!==QR3_VERSIONS.benchmark)return incomplete('benchmark');
  if(!isObject(uncertainty)||!Object.hasOwn(uncertainty,'method'))return incomplete('uncertainty');
  const approved=APPROVED_UNCERTAINTY.includes(uncertainty.method);
  let normalizedUncertainty={method:uncertainty.method===undefined?null:uncertainty.method};
  if(approved){
    if(isNumber(uncertainty.confidence))return numberRefusal();
    const confidence=decString(uncertainty.confidence);
    const seed=typeof uncertainty.seed==='number'&&isInt(uncertainty.seed)?String(uncertainty.seed):text(uncertainty.seed);
    if(!seed||!isInt(uncertainty.resamples)||uncertainty.resamples<1||uncertainty.resamples>MAX_RESAMPLES||!isInt(uncertainty.block_length)||uncertainty.block_length<1||
      uncertainty.block_length>MAX_BLOCK||!confidence||!confidence.gt(0)||!confidence.lt(1))return incomplete('uncertainty');
    normalizedUncertainty={method:uncertainty.method,seed,resamples:uncertainty.resamples,block_length:uncertainty.block_length,confidence:norm(uncertainty.confidence)};
  }else if(uncertainty.method!==null&&uncertainty.method!==undefined&&typeof uncertainty.method!=='string')return incomplete('uncertainty');
  if(limit.gt(maxDrawdown))return loosened('max_drawdown_percent');
  if(sample.min_episodes_floor<registry.min_episodes_floor||sample.min_episodes_ranking<registry.min_episodes_ranking)return loosened('min_episodes');
  const registryBand=dec(registry.tie_band_pp);
  if(band.lt(registryBand))return loosened('tie_band_pp');
  if(band.gt(registryBand))return incomplete('TIE_BAND_FIXED');
  const core={objective:input.objective,risk_filter:{max_drawdown_percent:norm(filter.max_drawdown_percent)},
    adequacy:{min_episodes_floor:sample.min_episodes_floor,min_episodes_ranking:sample.min_episodes_ranking},tie:{band_pp:norm(tie.band_pp)},uncertainty:normalizedUncertainty};
  const frozen={version:QR3_VERSIONS.spec,mode:'STANDARDIZED',participants:Array.isArray(input.participants)?[...input.participants].sort():[],period:input.period??null,
    benchmark:input.benchmark,...core};
  return deepFreeze({ok:true,code:null,detail:null,spec:frozen,spec_hash:specHashOf(frozen),
    limitations:approved?[]:[CODES.UNCERTAINTY_METHOD_NOT_APPROVED]});
}
/** F4: a frozen spec never changes; every change request is refused. */
export const specChangeRefusal=()=>refuse(CODES.QR3_SPEC_IMMUTABLE);

/** Seeded integer-only generator sfc32; the four state words come from sha256 of the seed text. */
export function seededRandom(seed){
  const digest=hash(String(seed));
  let a=parseInt(digest.slice(0,8),16)>>>0,b=parseInt(digest.slice(8,16),16)>>>0,c=parseInt(digest.slice(16,24),16)>>>0,d=parseInt(digest.slice(24,32),16)>>>0;
  const next=()=>{
    const t0=(a+b)|0;
    a=b^(b>>>9);b=(c+(c<<3))|0;c=(c<<21)|(c>>>11);d=(d+1)|0;
    const t=(t0+d)|0;c=(c+t)|0;
    return t>>>0;
  };
  for(let i=0;i<15;i+=1)next();
  const below=n=>{const limit=Math.floor(4294967296/n)*n;let v;do{v=next();}while(v>=limit);return v%n;};
  return {next,below};
}

const compound=(growth,indices)=>indices.reduce((product,index)=>product.mul(growth[index]),new Money(1)).minus(1);
/**
 * Paired daily stationary block bootstrap (6.4, qr3-unc-paired-daily-block-bootstrap-v1) of the difference of compounded returns
 * of participant A minus participant B. Both series are resampled with the same indices (paired). Resample count, mean block
 * length, confidence and seed come from the spec only. Percentile bounds use integer tail counts. The report states this is an
 * approximation, not a guarantee. Fewer than two days refuses QR3_METRIC_UNAVAILABLE.
 * Method as built (RC-C23): the stationary bootstrap restarts a block with probability 1/block_length (else the next day, circular), both
 * series use the same indices, the statistic is the difference of compounded returns, the tails are floor(R*(1-confidence)/2) sorted
 * resamples from each end, and the first day is measured against the initial NAV (see dailyReturns).
 * The module itself refuses a confidence outside (0,1), more than 20000 resamples and a block length over 3650 (QR3_SPEC_INCOMPLETE).
 * input: {daily_a:[decimal string], daily_b:[decimal string], spec:{seed,resamples,block_length,confidence}}
 */
export function pairedBootstrapInterval({daily_a:a,daily_b:b,spec}){
  if((Array.isArray(a)&&a.some(isNumber))||(Array.isArray(b)&&b.some(isNumber)))return numberRefusal();
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||a.length<2)return refuse(CODES.QR3_METRIC_UNAVAILABLE,'DAILY_SERIES');
  const ga=a.map(v=>dec(v)),gb=b.map(v=>dec(v));
  if(ga.some(v=>v===null)||gb.some(v=>v===null))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'DAILY_VALUE');
  const growthA=ga.map(v=>v.plus(1)),growthB=gb.map(v=>v.plus(1));
  if(isObject(spec)&&isNumber(spec.confidence))return numberRefusal();
  const confidence=isObject(spec)?decString(spec.confidence):null;
  if(!isObject(spec)||!text(String(spec.seed??''))||!isInt(spec.resamples)||spec.resamples<1||spec.resamples>MAX_RESAMPLES||!isInt(spec.block_length)||spec.block_length<1||
    spec.block_length>MAX_BLOCK||!confidence||!confidence.gt(0)||!confidence.lt(1))return refuse(CODES.QR3_SPEC_INCOMPLETE,'uncertainty');
  const days=a.length,random=seededRandom(spec.seed);
  const all=Array.from({length:days},(_,i)=>i);
  const observed=compound(growthA,all).minus(compound(growthB,all));
  const diffs=[];
  for(let r=0;r<spec.resamples;r+=1){
    const indices=[];
    let index=random.below(days);
    for(let i=0;i<days;i+=1){
      indices.push(index);
      index=random.below(spec.block_length)===0?random.below(days):(index+1)%days;
    }
    diffs.push(compound(growthA,indices).minus(compound(growthB,indices)));
  }
  diffs.sort((x,y)=>x.cmp(y));
  const tail=new Money(spec.resamples).mul(new Money(1).minus(confidence)).div(2).toDecimalPlaces(0,Money.ROUND_FLOOR).toNumber();
  const lower=diffs[tail],upper=diffs[spec.resamples-1-tail];
  const hundred=new Money(100);
  return deepFreeze({ok:true,code:null,detail:null,method:QR3_VERSIONS.uncertainty,approximation:true,days,resamples:spec.resamples,block_length:spec.block_length,
    confidence:norm(spec.confidence),seed:String(spec.seed),observed_difference_pp:out(round12(observed.mul(hundred))),lower_pp:out(round12(lower.mul(hundred))),
    upper_pp:out(round12(upper.mul(hundred))),lower_exact:out(lower.mul(hundred)),upper_exact:out(upper.mul(hundred)),
    includes_zero:lower.lte(0)&&upper.gte(0),separates_positive:lower.gt(0)});
}

const compareMetric=(a,b)=>dec(b.primary_metric).cmp(dec(a.primary_metric));
/**
 * Decide the outcome (8.1) and the ranks (6.5, 6.6).
 * input: {mode, spec (validateSpec().spec), spec_hash, context_key, participants:[{id, created_at_ms, status, reasons, primary_metric}],
 *   daily_returns_by_id:{id:[decimal]}, limitations:[codes]}
 * The request must carry the frozen spec; spec_hash must equal the hash recomputed from it (QR3_SPEC_IMMUTABLE otherwise), and a duplicate
 * participant id refuses DUPLICATE_RUN_ID. Rules: ACTUAL_BOT never ranks. Only ELIGIBLE_QUALIFIED participants rank, by primary_metric (exact decimal, higher first).
 * Adjacent participants closer than the tie band share a rank group (chained, the conservative reading). The top two also tie when
 * the paired bootstrap interval of their difference does not lie strictly above zero. A sole best label needs an approved method
 * and an interval. Rank numbers are competition ranks (1, 1, 3). One eligible participant gets only the R5 label and no winner;
 * the outcome is then NO_QUALIFIED_RESULT with only_qualified_participant_id set. OWNER (open): whether a new outcome value such as
 * SINGLE_QUALIFIED_RESULT is added is the owner's decision; the value stays as built and fails closed (no rank, no winner).
 * Without an approved uncertainty method no sole best label exists: the top two groups merge exactly as when the interval is unavailable.
 */
export function decideOutcome(input){
  const request=isObject(input)?input:{};
  if(!MODES.includes(request.mode))return refuse(CODES.QR3_MODE_REQUIRED);
  if(!Array.isArray(request.participants)||request.participants.some(item=>!isObject(item)||!text(item.id)||!isInt(item.created_at_ms)))return refuse(CODES.INVALID_FIELDS,'PARTICIPANTS');
  if(new Set(request.participants.map(item=>item.id)).size!==request.participants.length)return refuse(CODES.DUPLICATE_RUN_ID);
  if(request.participants.some(item=>isNumber(item.primary_metric)))return numberRefusal();
  if(request.mode==='STANDARDIZED'||(request.spec!==undefined&&request.spec!==null)||(request.spec_hash!==undefined&&request.spec_hash!==null)){
    const recomputed=specHashOf(request.spec);
    if(recomputed===null)return refuse(CODES.QR3_SPEC_INCOMPLETE,'SPEC');
    if(request.spec_hash!==recomputed)return refuse(CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH');
    if(request.mode==='STANDARDIZED'){
      /* Re-validated against REGISTRY_DEFAULTS (validateSpec default), so a spec frozen under another registry is refused here.
         The normalised spec must equal the request spec, so version, participants and period are checked too, not only the hashed fields. */
      const valid=request.spec.mode==='STANDARDIZED'?validateSpec(request.spec):null;
      if(valid===null||!valid.ok||valid.spec_hash!==request.spec_hash||canonical(valid.spec)!==canonical(request.spec))return refuse(CODES.QR3_SPEC_INCOMPLETE,'SPEC');
    }
  }
  if(request.participants.some(item=>Array.isArray(item.reasons)&&item.reasons.includes(CODES.QR3_SPEC_INCOMPLETE)))return refuse(CODES.QR3_SPEC_INCOMPLETE,'PARTICIPANT_REASON');
  const limitations=new Set(Array.isArray(request.limitations)?request.limitations:[]);
  const base=item=>({id:item.id,created_at_ms:item.created_at_ms,status:request.mode==='ACTUAL_BOT'?(item.status??null):item.status,rank:null,label:null,primary_metric:dec(item.primary_metric)===null?null:norm(item.primary_metric),
    reasons:Array.isArray(item.reasons)?[...item.reasons]:[]});
  const finish=(outcome,ranked,others,extra={})=>{
    const record={version:QR3_VERSIONS.outcome,mode:request.mode,spec_hash:request.spec_hash??null,context_key:request.context_key??null,outcome,
      participants:[...ranked,...[...others].sort(neutralCompare)],uncertainty:extra.uncertainty??null,only_qualified_participant_id:extra.only??null,
      limitations:[...limitations].sort()};
    return deepFreeze({ok:true,code:null,detail:null,...record,outcome_hash:hash(canonical(record))});
  };
  if(request.mode==='ACTUAL_BOT')return finish('ACTUAL_HISTORY_SIDE_BY_SIDE',[],request.participants.map(base));
  const eligible=request.participants.filter(item=>item.status==='ELIGIBLE_QUALIFIED');
  const others=request.participants.filter(item=>item.status!=='ELIGIBLE_QUALIFIED').map(base);
  if(eligible.some(item=>dec(item.primary_metric)===null))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'PRIMARY_METRIC');
  if(eligible.length===0){
    const evaluated=request.participants.filter(item=>['DEVELOPMENT_EVIDENCE','INADEQUATE_SAMPLE','FILTERED_RISK'].includes(item.status));
    return finish(evaluated.length>0&&evaluated.every(item=>item.status==='INADEQUATE_SAMPLE')?'INADEQUATE_EVIDENCE':'NO_QUALIFIED_RESULT',[],others);
  }
  if(eligible.length===1){
    const only={...base(eligible[0]),label:ONLY_QUALIFIED_LABEL};
    return finish('NO_QUALIFIED_RESULT',[],[...others,only],{only:only.id});
  }
  const sorted=[...eligible].sort((a,b)=>compareMetric(a,b)||neutralCompare(a,b));
  const band=decString(request.spec?.tie?.band_pp);
  if(band===null)return refuse(CODES.QR3_SPEC_INCOMPLETE,'tie');
  const groups=[[sorted[0]]];
  for(let i=1;i<sorted.length;i+=1){
    const gap=dec(sorted[i-1].primary_metric).minus(dec(sorted[i].primary_metric));
    if(gap.lt(band))groups[groups.length-1].push(sorted[i]);else groups.push([sorted[i]]);
  }
  let uncertainty=null;
  const spec=request.spec?.uncertainty;
  const approved=isObject(spec)&&APPROVED_UNCERTAINTY.includes(spec.method);
  if(!approved)limitations.add(CODES.UNCERTAINTY_METHOD_NOT_APPROVED);
  if(groups[0].length===1&&!approved){groups[0].push(...groups[1]);groups.splice(1,1);}
  else if(groups[0].length===1){
    const daily=request.daily_returns_by_id;
    const interval=pairedBootstrapInterval({daily_a:daily?.[sorted[0].id],daily_b:daily?.[sorted[1].id],spec});
    if(interval.ok){
      uncertainty=interval;
      if(!interval.separates_positive){groups[0].push(...groups[1]);groups.splice(1,1);}
    }else{
      uncertainty={method:QR3_VERSIONS.uncertainty,unavailable:true,code:interval.code,detail:interval.detail};
      groups[0].push(...groups[1]);groups.splice(1,1);
    }
  }
  const topSole=groups[0].length===1&&approved&&uncertainty!==null&&uncertainty.unavailable!==true;
  const outcome=topSole?'QUALIFIED_RANKING':'QUALIFIED_TIE';
  const ranked=[];
  let position=1;
  for(const [index,group] of groups.entries()){
    for(const item of group)ranked.push({...base(item),rank:position,label:index===0?(topSole?BEST_LABEL:TIED_BEST_LABEL):null});
    position+=group.length;
  }
  return finish(outcome,ranked,others,{uncertainty});
}

/** Flat thresholds that participantStatus reads, taken from the frozen spec only (F6), never from a code constant. */
export function specThresholds(frozenSpec){
  const spec=isObject(frozenSpec)?frozenSpec:{};
  return deepFreeze({min_episodes_floor:spec.adequacy?.min_episodes_floor??null,min_episodes_ranking:spec.adequacy?.min_episodes_ranking??null,
    max_drawdown_percent:spec.risk_filter?.max_drawdown_percent??null,tie_band_pp:spec.tie?.band_pp??null});
}
