import {QR2_DAY_MS,QR2_METHODS,QR2_WEEK_LABEL,Qr2Error} from './qr2-constants.js';

// QR-2 period windows (contract 3.5, O9): UTC, half-open [from, to) with the end exclusive at 00:00:00.000Z. These are QR-2's
// own window functions; the analytics rolling 7 days must not share the label. Pure; the request time is an argument.

const ms=value=>{
  if(!Number.isSafeInteger(value))throw new Qr2Error('QR2_RANGE_INVALID','instant must be an integer epoch ms');
  return value;
};
export const utcMidnight=instant=>Math.floor(ms(instant)/QR2_DAY_MS)*QR2_DAY_MS;
// 1970-01-01 was a Thursday, so Monday = day number minus ((day + 3) mod 7).
export const isoWeekStart=instant=>{const day=Math.floor(ms(instant)/QR2_DAY_MS);return (day-((day+3)%7))*QR2_DAY_MS;};

export function periodWindow(kind,anchor){
  const d=new Date(ms(anchor));
  const base={period_method:QR2_METHODS.period_method,kind};
  if(kind==='DAY'){const from=utcMidnight(anchor);return {...base,label:'Day (UTC)',from,to:from+QR2_DAY_MS};}
  if(kind==='WEEK'){const from=isoWeekStart(anchor);return {...base,label:QR2_WEEK_LABEL,from,to:from+7*QR2_DAY_MS};}
  if(kind==='MONTH')return {...base,label:'Month (UTC)',from:Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1),to:Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)};
  if(kind==='YEAR')return {...base,label:'Year (UTC)',from:Date.UTC(d.getUTCFullYear(),0,1),to:Date.UTC(d.getUTCFullYear()+1,0,1)};
  throw new Qr2Error('QR2_RANGE_INVALID','unknown period kind');
}
// Custom window: calendar days fromDay to toDay inclusive, i.e. [from 00:00Z, toDay + 1 day 00:00Z).
export function customWindow(fromDay,toDay){
  const from=utcMidnight(fromDay),to=utcMidnight(toDay)+QR2_DAY_MS;
  return {period_method:QR2_METHODS.period_method,kind:'CUSTOM',label:'Custom (UTC)',from,to};
}

/**
 * Resolves a requested [from, to) against the request time and the coverage start (users.created_at):
 * - to <= from is refused QR2_RANGE_INVALID. A `to` later than the request time (the current Day, Week, Month, Year or a custom
 *   range that ends today) is resolved to the request time (owner decision, 2026-10-19): the flag RANGE_END_AT_REQUEST_TIME is
 *   set and `requested` keeps the range as asked beside `resolved`. A range that starts later than the request time is
 *   refused QR2_RANGE_INVALID; a range that starts exactly at the request time (a current period requested at its exact start)
 *   is empty: resolved null, status UNAVAILABLE, reason RANGE_EMPTY_AT_REQUEST_TIME, no exception (RC-Q22);
 * - the resolved start is max(from, coverageStart); a from before coverage start keeps both intervals and flags
 *   COVERAGE_STARTS_AFTER_REQUEST; shorter history never becomes a longer report;
 * - when the coverage starts at or after `to`, resolved is null, the flag COVERAGE_STARTS_AFTER_REQUEST is set and the view is
 *   UNAVAILABLE with the same reason (RC-Q17); no synthetic row is made.
 */
export function resolveRange({from,to,requestTime,coverageStart}){
  ms(from);ms(to);ms(requestTime);ms(coverageStart);
  if(to<=from)throw new Qr2Error('QR2_RANGE_INVALID','to must be later than from');
  if(from>requestTime)throw new Qr2Error('QR2_RANGE_INVALID','from must not be later than the request time');
  const end=Math.min(to,requestTime);
  const flags=[];
  if(from<coverageStart)flags.push('COVERAGE_STARTS_AFTER_REQUEST');
  if(to>requestTime)flags.push('RANGE_END_AT_REQUEST_TIME');
  if(from===requestTime)return {requested:{from,to},resolved:null,flags,status:'UNAVAILABLE',reasons:['RANGE_EMPTY_AT_REQUEST_TIME']};
  const resolvedFrom=Math.max(from,coverageStart);
  const resolved=resolvedFrom<end?{from:resolvedFrom,to:end}:null;
  return {requested:{from,to},resolved,flags,...(resolved?{}:{status:'UNAVAILABLE',reasons:['COVERAGE_STARTS_AFTER_REQUEST']})};
}
// All Time Registered begins at registration with actual coverage (OD-Q1: users.created_at).
export function allTimeWindow({coverageStart,requestTime}){
  ms(coverageStart);ms(requestTime);
  if(requestTime<=coverageStart)throw new Qr2Error('QR2_RANGE_INVALID','request time must be later than registration');
  return {period_method:QR2_METHODS.period_method,kind:'ALL_TIME',label:'All Time Registered',from:coverageStart,to:requestTime};
}
// first_funding_at is reported beside the coverage start (OD-Q1): the earliest funding row of either kind, else null.
export const firstFundingAt=fundings=>fundings.length?Math.min(...fundings.map(f=>Number(f.at))):null;
