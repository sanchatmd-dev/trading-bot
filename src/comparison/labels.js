import {CODES,QR3_VERSIONS,isObject,isInt,text,dec,deepFreeze,refuse,neutralCompare,nullMetric} from './common.js';

/**
 * Label text, label validator (test plan 13.1 item 16, sections 6.6 and 11.2) and the stored-result view (M4, OD-C5).
 * The validator takes a comparison view as plain data and returns every violation with the contract rule it breaks
 * (X1 to X7, R1, R3, R5, F8, 11.2). It judges text and structure only; it never decides a rank.
 */
export const BEST_LABEL='best within the selected scope';
export const TIED_BEST_LABEL='tied best within the selected scope';
export const ONLY_QUALIFIED_LABEL='only qualified participant within the selected scope';
export const ALLOWED_LABELS=Object.freeze([BEST_LABEL,TIED_BEST_LABEL,ONLY_QUALIFIED_LABEL]);
export const NO_WINNER_TEXT='Qualified recommendations: none. No qualified winner.';
/** Fixed notices of 11.1 item 9; they may contain the word profitability in a negation and are exempt from the claim scan. */
export const FIXED_NOTICES=Object.freeze(['Simulated research on historical data. Not actual Paper execution, not a profitability claim and not a recommendation.',
  'Development results are never qualified recommendations. No qualified winner is a valid result. Viewing this report changes nothing.',NO_WINNER_TEXT]);

/** R3 scope string: asset, resolved period, risk profile, cost model and context key. */
export function scopeString({market,period,risk_policy:riskPolicy,cost_model:cost,context_key:contextKey}={}){
  if(!isObject(market)||!isObject(period)||!isObject(cost)||!text(riskPolicy)||!text(contextKey)||!isInt(period.start_ms)||!isInt(period.end_ms))return null;
  return [market.broker+':'+market.symbol+' '+market.timeframe+'m',new Date(period.start_ms).toISOString()+'/'+new Date(period.end_ms).toISOString(),
    'risk '+riskPolicy,'cost '+cost.version+' fee_bps '+cost.fee_bps+' slippage_bps '+cost.slippage_bps,'context '+contextKey].join('; ');
}

const RANK_WORDS=/(?:\b(?:best|top|winner|winning|champion|leader|first place|number one|outperform\w*|beats?)\b|#\s?1\b)/i;
const CLAIM_WORDS=/\b(universal\w*|global(?:ly)? (?:best|optimum|optimal)|exhaustive|guarantee\w*|will (?:be )?profit\w*|profitable|best overall)\b/i;
const HIDDEN_METRIC_STATUSES=new Set(['EXCLUDED_INCOMPATIBLE','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','UNAVAILABLE','NOT_EVALUATED']);
const collapseVariant=value=>value.toLowerCase().replace(/\s+/g,' ').trim();
const zeroLike=value=>value===0||(dec(value)!==null&&dec(value).isZero());

/**
 * Validate a comparison view.
 * Label text must match an allowed label exactly; any case or spacing variant is R3 LABEL_WITHOUT_SELECTED_SCOPE. Any other non-null label is refused
 * (X1 LABEL for a participant that is not eligible, else R3 LABEL_NOT_ALLOWED); on an ACTUAL_BOT row any label, even '' or whitespace, is X4 LABEL. Participant metrics are
 * allowed only when lifecycle is COMPLETE (F8); an undefined, FAILED, CANCELLED, SPEC_FROZEN or EVALUATING lifecycle shows none.
 * view: {mode, lifecycle, outcome, participants:[{id, created_at_ms, mode, status, rank, label, highlight, metrics:{name:{value,reason}}|null}],
 *   context_keys:[..], claim_texts:[..]}
 * Returns {ok, violations:[{rule, participant_id, detail}]}. An unreadable view is itself a violation.
 */
export function validateComparisonView(view){
  const violations=[];
  const add=(rule,participantId,detail)=>violations.push({rule,participant_id:participantId,detail});
  if(!isObject(view)||!Array.isArray(view.participants))return deepFreeze({ok:false,violations:[{rule:'VIEW_UNREADABLE',participant_id:null,detail:null}]});
  const actual=view.mode==='ACTUAL_BOT';
  const eligible=view.participants.filter(item=>isObject(item)&&item.status==='ELIGIBLE_QUALIFIED');
  if(Array.isArray(view.context_keys)&&new Set(view.context_keys).size>1)add('X2',null,'MIXED_CONTEXT_KEYS');
  if(view.participants.some(item=>isObject(item)&&item.mode!==undefined&&item.mode!==view.mode))add('X2',null,'MIXED_MODES');
  for(const item of view.participants){
    if(!isObject(item)){add('VIEW_UNREADABLE',null,'PARTICIPANT');continue;}
    const id=item.id??null,labelText=item.label;
    const isEligible=item.status==='ELIGIBLE_QUALIFIED';
    const hasRankWord=typeof labelText==='string'&&RANK_WORDS.test(labelText);
    if(item.rank!==null&&item.rank!==undefined){
      if(actual)add('X4',id,'RANK');
      else if(!isEligible)add('X1',id,'RANK');
      else if(!['QUALIFIED_RANKING','QUALIFIED_TIE'].includes(view.outcome)||eligible.length<2)add('R5',id,'RANK');
    }
    if(item.highlight===true&&(actual||!isEligible))add(actual?'X4':'X1',id,'HIGHLIGHT');
    if(labelText!==null&&labelText!==undefined){
      if(typeof labelText!=='string')add('R3',id,'LABEL_TYPE');
      else if(actual)add('X4',id,'LABEL');
      else{
        if(!isEligible)add('X1',id,'LABEL');
        else if(!ALLOWED_LABELS.includes(labelText))add('R3',id,hasRankWord||ALLOWED_LABELS.includes(collapseVariant(labelText))?'LABEL_WITHOUT_SELECTED_SCOPE':'LABEL_NOT_ALLOWED');
        else if(labelText===BEST_LABEL&&!(view.outcome==='QUALIFIED_RANKING'&&item.rank===1))add('R3',id,'BEST_WITHOUT_SINGLE_TOP');
        else if(labelText===TIED_BEST_LABEL&&!(view.outcome==='QUALIFIED_TIE'&&item.rank===1))add('T3',id,'TIED_LABEL_WITHOUT_TIE');
        else if(labelText===ONLY_QUALIFIED_LABEL&&eligible.length!==1)add('R5',id,'ONLY_LABEL_WITH_OTHERS');
      }
      if(CLAIM_WORDS.test(labelText))add('X6',id,'CLAIM');
    }
    const metrics=item.metrics;
    if(metrics!==null&&metrics!==undefined){
      if(!isObject(metrics))add('METRIC_UNREADABLE',id,'METRICS');
      else{
        if(HIDDEN_METRIC_STATUSES.has(item.status))add('11.2',id,'METRICS_OF_EXCLUDED');
        if(view.lifecycle!=='COMPLETE')add('F8',id,'METRICS_BEFORE_COMPLETE');
        for(const [name,entry] of Object.entries(metrics)){
          if(!isObject(entry)||!('value' in entry)){add('METRIC_UNREADABLE',id,name);continue;}
          if(entry.value===null||entry.value===undefined){if(!text(entry.reason))add('NULL_WITHOUT_REASON',id,name);}
          else if(text(entry.reason)&&zeroLike(entry.value))add('NULL_SHOWN_AS_ZERO',id,name);
        }
      }
    }
  }
  if(!actual){
    const neutral=view.participants.filter(item=>isObject(item)&&(item.rank===null||item.rank===undefined));
    const sorted=[...neutral].sort((a,b)=>neutralCompare({id:a.id,created_at_ms:a.created_at_ms},{id:b.id,created_at_ms:b.created_at_ms}));
    if(neutral.some((item,index)=>item!==sorted[index]))add('X7',null,'NOT_NEUTRAL_ORDER');
  }
  const claims=[...(Array.isArray(view.claim_texts)?view.claim_texts:[])];
  for(const claim of claims){
    if(typeof claim!=='string'){add('X6',null,'CLAIM_TYPE');continue;}
    let rest=claim;
    for(const notice of FIXED_NOTICES)rest=rest.split(notice).join('');
    if(CLAIM_WORDS.test(rest))add('X6',null,'CLAIM');
    if(RANK_WORDS.test(rest)&&!ALLOWED_LABELS.some(label=>rest.includes(label)))add('R3',null,'CLAIM_WITHOUT_SELECTED_SCOPE');
  }
  return deepFreeze({ok:violations.length===0,violations});
}

const PARTITION_NAMES=Object.freeze(['validation','test']);
const STORED_METRICS=Object.freeze(['bars','closed_trades','start_equity','end_equity','net_return_percent','max_drawdown_percent','profit_factor','gross_profit','gross_loss']);
/**
 * Stored-result view (M4, OD-C5, qr3-period-partition-aligned-v1): the period must equal one stored `validation` or `test` window of
 * every participant, half-open to the bar. The block is always DEVELOPMENT_EVIDENCE, never ranked, and lists participants in
 * neutral order. Anything else refuses QR3_PERIOD_NOT_PARTITION_ALIGNED with the stored windows.
 * input: {period:{start_ms,end_ms}, participants:[{id, created_at_ms, partitions:{validation:{start_ms,end_ms,metrics}, test:{...}}}]}
 */
export function storedResultView(input){
  const request=isObject(input)?input:{};
  const period=request.period;
  if(!isObject(period)||!isInt(period.start_ms)||!isInt(period.end_ms)||period.end_ms<=period.start_ms||!Array.isArray(request.participants)||request.participants.length===0)
    return refuse(CODES.QR3_PERIOD_INVALID,'STORED_VIEW_INPUT');
  const windows=[],rows=[];
  let aligned=true;
  for(const participant of request.participants){
    if(!isObject(participant)||!text(participant.id)||!isInt(participant.created_at_ms)||!isObject(participant.partitions))return refuse(CODES.QR3_PERIOD_INVALID,'STORED_VIEW_PARTICIPANT');
    let match=null;
    for(const name of PARTITION_NAMES){
      const part=participant.partitions[name];
      if(!isObject(part)||!isInt(part.start_ms)||!isInt(part.end_ms))continue;
      windows.push({participant_id:participant.id,partition:name,start_ms:part.start_ms,end_ms:part.end_ms});
      if(match===null&&part.start_ms===period.start_ms&&part.end_ms===period.end_ms)match={name,part};
    }
    if(match===null){aligned=false;continue;}
    const stored=isObject(match.part.metrics)?match.part.metrics:{};
    const metrics={};
    for(const name of STORED_METRICS)metrics[name]=stored[name]===null||stored[name]===undefined?nullMetric(CODES.METRIC_NOT_RECORDED):{value:stored[name],reason:null};
    rows.push({id:participant.id,created_at_ms:participant.created_at_ms,partition:match.name,evidence_class:'DEVELOPMENT_EVIDENCE',rank:null,metrics});
  }
  if(!aligned)return refuse(CODES.QR3_PERIOD_NOT_PARTITION_ALIGNED,null,{windows});
  rows.sort(neutralCompare);
  return deepFreeze({ok:true,code:null,detail:null,view:QR3_VERSIONS.stored_view,label:'STORED_PARTITION_METRICS',evidence_class:'DEVELOPMENT_EVIDENCE',
    ranked:false,full_comparison:false,period:{start_ms:period.start_ms,end_ms:period.end_ms},participants:rows});
}
