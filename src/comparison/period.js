import {MINUTE,DAY,MAX_TOTAL_BARS,QR3_VERSIONS,CODES,isObject,isInt,isAligned,deepFreeze,refuse,utc} from './common.js';

/**
 * Period resolver, admission, dataset gap check and coverage check (contract section 4, test plan 13.1 items 4 to 6).
 * All times are epoch milliseconds in UTC; the report timezone of STANDARDIZED v1 is UTC (P1). Intervals are half-open
 * [start, end) over completed bars. Nothing here shortens, shifts or fills a period (OD-C13, G2, G4).
 */
export const PERIOD_CHOICES=Object.freeze(['1W','1M','3M','6M','1Y','2Y','3Y','YTD','ALL','CUSTOM']);
const MONTHS=Object.freeze({'1M':1,'3M':3,'6M':6,'1Y':12,'2Y':24,'3Y':36});

/** Calendar month arithmetic in UTC with month-end clamping (31 January plus one month is the last day of February). */
export function addMonths(ms,months){
  const date=new Date(ms);
  const total=date.getUTCFullYear()*12+date.getUTCMonth()+months;
  const year=Math.floor(total/12),month=total-year*12;
  const days=new Date(Date.UTC(year,month+1,0)).getUTCDate();
  return Date.UTC(year,month,Math.min(date.getUTCDate(),days),date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds(),date.getUTCMilliseconds());
}
const shift=(ms,choice,sign)=>choice==='1W'?ms+sign*7*DAY:addMonths(ms,sign*MONTHS[choice]);

/**
 * Resolve one declared period (4.1, 4.2).
 * input: {choice, start_ms, end_ms, last_completed_end_ms, available_start_ms, warmup_bars, max_total_bars}
 * - last_completed_end_ms: the exclusive end of the last completed bar when the spec is frozen (required; P2).
 * - warmup_bars: W_max, the largest warm-up of any participant (required, integer, 0 or more).
 * - Relative choices (1W to 3Y) end at last_completed_end_ms and look back, unless start_ms is given, then they start there
 *   and look forward (the 31 January plus one month case). YTD starts January 1 UTC of the year of the end. ALL starts at
 *   available_start_ms plus warm-up so the whole warm-up lies in available history. CUSTOM takes start_ms and end_ms.
 * Check order: malformed input (PERIOD_INVALID), future end (PERIOD_IN_FUTURE), total bars over the limit
 * (RANGE_ADMISSION_REFUSED, with the refused candidate interval). Never truncates. max_total_bars is the caller's admitted stage
 * limit; the default is the current 10,000 bar profile, and a larger value is the caller's QD-1 expanded admission.
 */
export function resolvePeriod(input){
  const request=isObject(input)?input:{};
  const {choice}=request;
  const limit=request.max_total_bars===undefined?MAX_TOTAL_BARS:request.max_total_bars;
  if(!PERIOD_CHOICES.includes(choice))return refuse(CODES.QR3_PERIOD_INVALID,'CHOICE_UNKNOWN');
  if(!isInt(request.warmup_bars)||request.warmup_bars<0)return refuse(CODES.QR3_PERIOD_INVALID,'WARMUP_INVALID');
  if(!isInt(limit)||limit<1)return refuse(CODES.QR3_PERIOD_INVALID,'LIMIT_INVALID');
  const lastEnd=request.last_completed_end_ms;
  if(!isAligned(lastEnd))return refuse(CODES.QR3_PERIOD_INVALID,'LAST_COMPLETED_END_INVALID');
  const availableStart=request.available_start_ms;
  if(availableStart!==undefined&&availableStart!==null&&!isAligned(availableStart))return refuse(CODES.QR3_PERIOD_INVALID,'AVAILABLE_START_INVALID');
  let start,end,anchor;
  if(choice==='CUSTOM'){
    start=request.start_ms;end=request.end_ms;anchor='CUSTOM';
  }else if(choice==='ALL'){
    if(!isAligned(availableStart))return refuse(CODES.QR3_PERIOD_INVALID,'AVAILABLE_START_REQUIRED');
    start=availableStart+request.warmup_bars*MINUTE;end=lastEnd;anchor='ALL';
  }else if(choice==='YTD'){
    if(request.start_ms!==undefined&&request.start_ms!==null)return refuse(CODES.QR3_PERIOD_INVALID,'YTD_START_FIXED');
    end=lastEnd;start=Date.UTC(new Date(end).getUTCFullYear(),0,1);anchor='YTD';
  }else if(request.start_ms!==undefined&&request.start_ms!==null){
    if(!isAligned(request.start_ms))return refuse(CODES.QR3_PERIOD_INVALID,'START_NOT_ALIGNED');
    start=request.start_ms;end=shift(start,choice,1);anchor='START';
  }else{
    end=lastEnd;start=shift(end,choice,-1);anchor='END';
  }
  if(!isAligned(start)||!isAligned(end))return refuse(CODES.QR3_PERIOD_INVALID,'BOUND_NOT_ALIGNED');
  if(end<=start)return refuse(CODES.QR3_PERIOD_INVALID,'END_NOT_AFTER_START');
  if(end>lastEnd)return refuse(CODES.QR3_PERIOD_IN_FUTURE,null,{end_ms:end,last_completed_end_ms:lastEnd});
  const evaluationBars=(end-start)/MINUTE,total=evaluationBars+request.warmup_bars;
  if(total>limit)return refuse(CODES.QR3_RANGE_ADMISSION_REFUSED,null,{evaluation_bars:evaluationBars,warmup_bars:request.warmup_bars,total_bars:total,limit,candidate:{start_ms:start,end_ms:end}});
  return deepFreeze({ok:true,code:null,detail:null,period:{version:QR3_VERSIONS.period,choice,anchor,start_ms:start,end_ms:end,start_utc:utc(start),end_utc:utc(end),
    evaluation_bars:evaluationBars,warmup_bars:request.warmup_bars,total_bars:total,limit,
    available_history:isAligned(availableStart)?{start_ms:availableStart,end_ms:lastEnd}:null,admission:'ADMITTED'}});
}

/**
 * Gap check of the shared dataset over [start - W_max, end) (G1, G2). bars: [{time_ms, complete}]. Anything outside the
 * interval is ignored, so a gap before start - W_max never refuses. A duplicate, an unaligned time inside the interval or a
 * bar that is not complete === true is also a refusal (a missing flag does not count as complete). Missing minutes are reported as half-open gap intervals; nothing is
 * interpolated, forward filled or shortened.
 */
export function checkDatasetGaps({bars,start_ms:start,end_ms:end,warmup_bars:warmup}){
  if(!Array.isArray(bars)||!isAligned(start)||!isAligned(end)||end<=start||!isInt(warmup)||warmup<0)return refuse(CODES.QR3_DATASET_UNAVAILABLE);
  const from=start-warmup*MINUTE;
  const present=new Set(),duplicates=[],unaligned=[],incomplete=[];
  for(const bar of bars){
    if(!isObject(bar)||!isInt(bar.time_ms))return refuse(CODES.QR3_DATASET_UNAVAILABLE,'BAR_UNREADABLE');
    const time=bar.time_ms;
    if(time<from||time>=end)continue;
    if(time%MINUTE!==0){unaligned.push(time);continue;}
    if(bar.complete!==true){incomplete.push(time);continue;}
    if(present.has(time))duplicates.push(time);else present.add(time);
  }
  const sorted=[...present].sort((a,b)=>a-b);
  const gaps=[];
  let cursor=from;
  for(const time of sorted){
    if(time>cursor)gaps.push({start_ms:cursor,end_ms:time});
    cursor=time+MINUTE;
  }
  if(cursor<end)gaps.push({start_ms:cursor,end_ms:end});
  if(gaps.length===0&&duplicates.length===0&&unaligned.length===0&&incomplete.length===0)return deepFreeze({ok:true,code:null,detail:null,expected_bars:(end-from)/MINUTE});
  return refuse(CODES.QR3_DATASET_GAPPED,null,{gaps,duplicates,unaligned,incomplete});
}

/**
 * Coverage of one participant against the resolved period (G4, OD-C13). The period is never shrunk: a participant that does
 * not cover all of it is EXCLUDED_COVERAGE with its covered interval. An unreadable interval is a failure, never a pass.
 */
export function checkCoverage({period,covered}){
  const fail=(coveredInterval)=>deepFreeze({state:'FAIL',participant_status:'EXCLUDED_COVERAGE',code:CODES.QR3_COVERAGE_INCOMPLETE,covered_interval:coveredInterval,
    period:{start_ms:period?.start_ms??null,end_ms:period?.end_ms??null}});
  if(!isObject(period)||!isAligned(period.start_ms)||!isAligned(period.end_ms)||period.end_ms<=period.start_ms)return fail(null);
  if(!isObject(covered)||!isAligned(covered.start_ms)||!isAligned(covered.end_ms)||covered.end_ms<covered.start_ms)return fail(null);
  if(covered.start_ms>period.start_ms||covered.end_ms<period.end_ms)return fail({start_ms:covered.start_ms,end_ms:covered.end_ms});
  return deepFreeze({state:'PASS',participant_status:null,code:null,covered_interval:{start_ms:covered.start_ms,end_ms:covered.end_ms},
    period:{start_ms:period.start_ms,end_ms:period.end_ms}});
}
