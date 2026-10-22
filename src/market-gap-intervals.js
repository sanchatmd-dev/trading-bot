// Shared pure gap assembly. Callers own validation and coverage policy.
const MINUTE=60000;
export const GAP_RANGE_CAP=50;

/**
 * Gap ranges of one window. lower/end bound the gap window (bar_time in (lower,end]); n, first and last come from the EDGE
 * read; internal rows are {prev,bar_time} pairs with bar_time-prev>60000 and internalTotal is the exact number of them.
 * All range times are candle OPEN times.
 */
export function assembleGaps({lower,end,n,first,last,internal=[],internalTotal=0},cap=GAP_RANGE_CAP){
  const expected=Math.max(0,(end-lower)/MINUTE);
  const all=[];
  let count=0;
  if(n===0){
    if(expected>0){all.push({from_open_time:lower,to_open_time:end-MINUTE,missing_minutes:expected});count=1;}
  }else{
    if(first>lower+MINUTE){
      all.push({from_open_time:lower,to_open_time:first-2*MINUTE,missing_minutes:(first-lower)/MINUTE-1});count++;
    }
    for(const row of internal)all.push({from_open_time:row.prev,to_open_time:row.bar_time-2*MINUTE,missing_minutes:(row.bar_time-row.prev)/MINUTE-1});
    count+=internalTotal;
    if(last<end){all.push({from_open_time:last,to_open_time:end-MINUTE,missing_minutes:(end-last)/MINUTE});count++;}
  }
  const ranges=all.slice(0,cap);
  return {count,missing_minutes:Math.max(0,expected-n),ranges,truncated:count>ranges.length};
}

