// BEGIN reads the monotonic clock inside beginProfileCompletion, right after authorizeLocked('BEGIN') starts, and every charge
// counts from that reading. The marks are that authority call and the last charge statement. No honest charge exceeds the time
// between them, while a doubled charge does once the terminal has run for a while.
export function markCharge(f){const marks={},push=f.authorityCalls.push.bind(f.authorityCalls),query=f.db.query.bind(f.db);
 f.authorityCalls.push=phase=>{if(phase==='BEGIN')marks.begin=performance.now();return push(phase);};
 f.db.query=async(sql,params)=>{if(sql.startsWith('UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST'))marks.charge=performance.now();
  return query(sql,params);};
 return marks;}
