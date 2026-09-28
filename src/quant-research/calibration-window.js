const fail=()=>Object.assign(new Error('INVALID_CALIBRATION_WINDOW'),{code:'INVALID_CALIBRATION_WINDOW'});

export function createCalibrationWindow(now,limitMs=300000){
  if(!Number.isSafeInteger(now)||now<=0||!Number.isSafeInteger(limitMs)||limitMs<1000||limitMs>300000)throw fail();
  return {issued_at_ms:now,deadline_ms:now+limitMs};
}

export function validateCalibrationWindow(marker,now){
  if(!marker||marker.baseline_ok!==true||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(marker.issued_at_ms)||!Number.isSafeInteger(marker.deadline_ms)||
    marker.issued_at_ms<=0||marker.deadline_ms<=now||
    marker.deadline_ms-marker.issued_at_ms<1000||marker.deadline_ms-marker.issued_at_ms>300000||
    now<marker.issued_at_ms)throw fail();
  return marker.deadline_ms;
}

const sessionFail=()=>Object.assign(new Error('INVALID_CALIBRATION_SESSION'),{code:'INVALID_CALIBRATION_SESSION'});
export function calibrationWorkDeadline(marker,now){
  const end=validateCalibrationWindow(marker,now);
  if(!/^[a-zA-Z0-9-]{16,80}$/.test(marker.run_id??'')||
    !Number.isSafeInteger(marker.cleanup_reserve_ms)||marker.cleanup_reserve_ms<100||
    marker.cleanup_reserve_ms>=end-marker.issued_at_ms)throw sessionFail();
  return end-marker.cleanup_reserve_ms;
}

/** A result must belong to this window and arrive before its absolute deadline. */
export function inspectCalibrationCompletion(marker,completion,now){
  try{calibrationWorkDeadline(marker,now);}catch{return 'INVALID_OR_EXPIRED_SESSION';}
  if(!completion||completion.run_id!==marker.run_id||
    completion.issued_at_ms!==marker.issued_at_ms||completion.deadline_ms!==marker.deadline_ms||
    !Number.isSafeInteger(completion.completed_at_ms)||completion.completed_at_ms<marker.issued_at_ms||
    completion.completed_at_ms>now||completion.completed_at_ms>=marker.deadline_ms)return 'INVALID_COMPLETION';
  if(completion.cleanup_confirmed!==true)return 'STOP_UNCONFIRMED';
  return completion.status==='SUCCEEDED'?'DRIVER_DONE':'DRIVER_FAILED';
}

/** Driver owns completion publication, including failed work. Work must honor its
 * abort signal; the host still needs an independent process-tree wall-time limit.
 * Cleanup must prove physical stop before returning true. Never publish success
 * merely because a command was launched or a done file exists.
 */
export async function runCalibrationDriver({marker,work,cleanup,publish,clock=Date.now}){
  if(typeof work!=='function'||typeof cleanup!=='function'||typeof publish!=='function')throw sessionFail();
  const workEnd=calibrationWorkDeadline(marker,clock()),controller=new AbortController();
  let reason=null,cleanupConfirmed=false;
  const timer=setTimeout(()=>controller.abort(),Math.max(0,workEnd-clock()));
  try{
    if(clock()>=workEnd)throw Error('No work budget');
    const verified=await work({signal:controller.signal,deadline_ms:workEnd});
    if(clock()>=workEnd||controller.signal.aborted)reason='WORK_DEADLINE';
    else if(verified!==true)reason='WORK_UNVERIFIED';
  }catch{reason=clock()>=workEnd||controller.signal.aborted?'WORK_DEADLINE':'WORK_FAILED';}
  finally{
    clearTimeout(timer);
    try{cleanupConfirmed=await cleanup()===true;}catch{cleanupConfirmed=false;}
  }
  if(!cleanupConfirmed)reason='STOP_UNCONFIRMED';
  const finished=clock();
  if(finished>=marker.deadline_ms)reason='COMPLETION_DEADLINE';
  const completion={run_id:marker.run_id,issued_at_ms:marker.issued_at_ms,deadline_ms:marker.deadline_ms,
    completed_at_ms:finished,status:reason?'FAILED':'SUCCEEDED',cleanup_confirmed:cleanupConfirmed,reason};
  await publish(completion);
  return completion;
}
