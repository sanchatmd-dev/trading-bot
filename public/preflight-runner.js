/* Historical Preflight (PF-2) runner in Risk manager: the three owner writes that R7 needs, each sent only from its own button.
   1. Holdout boundary: read first; register once, permanently, after the exact value is shown and confirmed.
   2. Profile enrollment: raw dataset job + READY deployment -> POST profile-enrollments, then watch GET /profiles/{id}.
   3. Preflight: profile job + deployment -> POST preflights, then watch GET /preflights/{id}; Cancel behind a second click.
   Each enroll or Preflight request carries an Idempotency-Key per exact inputs: the same inputs always reuse their key, so a
   lost answer cannot start a second job; only the inputs that succeed retire their key. Keys and jobs are kept per bot for
   the page's life and, per signed-in user and bot, in session storage, so a bot switch or a reload adopts the job again.
   A refusal after an unknown outcome holds those inputs until the owner types CLEAR. An active Preflight on the server is
   adopted too. Watching uses GET only, while the Risk page and the tab are visible, with back-off.
   Nothing writes by itself. Text is set with textContent only; ids, codes and statuses are data and never translated. */
(() => {
  const anchor=document.getElementById('pf3Panel'),page=document.querySelector('[data-page="risk"]');
  if(!anchor||!page)return;
  const JOB_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,MINUTE=60000,BANGKOK=7*3600000,MAX_FAILURES=5;
  const POLL=[3000,5000,10000,20000,30000],ACTIVE=['QUEUED','PAUSED','RUNNING','STOPPING'];
  const CLOSED=['PREFLIGHT_DISABLED','PROFILE_ENROLLMENT_DISABLED','QUANT_PROFILE_ENROLLMENT_DISABLED','QUANT_PROFILE_DISABLED'];
  const KNOWN={
    HOLDOUT_BOUNDARY_EXISTS:'A different holdout boundary is already registered for this bot. It cannot be changed.',
    HOLDOUT_BOUNDARY_CONFLICT:'This time is later than an earlier holdout boundary of this account. Use that time or an earlier one.',
    HOLDOUT_BOUNDARY_INVALID:'The time must be a whole minute and not in the future.',
    IDEMPOTENCY_CONFLICT:'The server holds a different request under this key. Press the button again to send it with a new key.',
    IDEMPOTENCY_KEY_REQUIRED:'The request key is missing. Reload the page, then try again.',
    PREFLIGHT_ALREADY_ACTIVE:'A Preflight is already active for this bot. Watch it or cancel it first.',
    PREFLIGHT_ENROLLMENT_REQUIRED:'Enroll a verified profile for this bot and deployment first.',
    PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED:'Register the holdout boundary first.',
    PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED:'The profile has no development range before the holdout boundary.',
    PREFLIGHT_DEPLOYMENT_UNSUPPORTED:'Preflight does not support this deployment.',
    RESEARCH_DEPLOYMENT_NOT_READY:'The deployment is not READY.',
    SNAPSHOT_HASH_MISMATCH:'The deployment snapshot no longer matches. Generate and activate a new deployment.',
    STALE_POLICY:'The saved risk policy changed after this deployment. Generate and activate a new deployment.',
    STALE_CAPITAL:'The Paper capital changed after this deployment. Generate and activate a new deployment.',
    STALE_MEMBERSHIP:'The deployment membership changed. Generate and activate a new deployment.',
    PF2_EVALUATOR_HASH_MISMATCH:'The Preflight evaluator does not match this deployment. Report it to the operator; do not retry.',
    CAPACITY_POLICY_EVALUATOR_MISMATCH:'The capacity policy evaluator does not match. Report it to the operator; do not retry.',
    FOUNDATION_QUEUE_FULL:'The research queue is full. Try again later.',
    INVALID_FIELDS:'The server refused these fields. Check the ids.',
    NOT_FOUND:'Not found for this bot.',
    STEP_UP_REQUIRED:'Confirm your identity, then press the button again.'};
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(_,key)=>String(values[key]??''));
  const make=(tag,cls,...children)=>{const node=document.createElement(tag);if(cls)node.className=cls;for(const child of children)if(child!==null&&child!==undefined&&child!==false)node.append(child);return node;};
  const label=(text,tag='span',cls)=>{const node=make(tag,cls);node.dataset.uiLabel=text;node.textContent=T(text);return node;};
  // Server data (ids, codes, statuses, numbers) sits in no-i18n nodes, which the language switch never rewrites.
  const data=(text,tag='code')=>make(tag,'no-i18n',String(text));
  const button=(text,cls='ghost')=>{const node=label(text,'button',cls);node.type='button';return node;};
  const field=(text,input)=>make('label','pfr-field',label(text),input);
  const minuteText=ms=>new Date(ms).toISOString().slice(0,16).replace('T',' ');
  const botId=()=>{try{const value=typeof selectedBot==='string'?selectedBot:'';return value||(typeof me!=='undefined'&&me?.user?.id)||'';}catch{return '';}};
  const visible=()=>!page.hidden&&document.visibilityState!=='hidden';
  const newKey=()=>{try{return crypto.randomUUID();}catch{return 'k'+Date.now().toString(36)+Math.random().toString(36).slice(2,12);}};
  const codeOf=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');
  const closedError=error=>CLOSED.includes(codeOf(error))||error?.status===503&&!KNOWN[codeOf(error)];
  // Outcome classes of a failed POST. A 4xx proves only that this attempt rolled back, not that no job exists for its key.
  // unknown: no answer, timeout or 5xx: the request may have been accepted. retryable: sign-in, step-up, a retried
  // transaction or a rate limit: keep the key and send the same request again. Anything else is a refusal.
  const unknownOutcome=error=>!Number.isInteger(error?.status)||error.status>=500||error.status===408;
  const retryable=error=>error?.status===401||error?.status===403&&(!error.code||error.code==='STEP_UP_REQUIRED')||error?.status===429||
    codeOf(error)==='RETRY_TRANSACTION';

  // Static frame
  const panel=make('section','panel pfr');panel.id='pfrPanel';panel.setAttribute('aria-labelledby','pfrTitle');
  const title=label('Historical Preflight (PF-2)','h2');title.id='pfrTitle';
  const scope=label('Select one bot for this operation','p','pfr-note');scope.hidden=true;
  const card=(heading,...children)=>make('section','pfr-card',label(heading,'h3'),...children);
  const hStatus=make('p','pfr-status');hStatus.setAttribute('role','status');
  const hValue=make('p','pfr-value');
  const hInput=make('input');hInput.type='datetime-local';hInput.step='60';
  const hPreview=make('p','pfr-preview');hPreview.setAttribute('aria-live','polite');
  const hConfirm=make('input');hConfirm.type='checkbox';
  const hRegister=button('Register holdout boundary','primary');
  const hForm=make('div','pfr-form',field('Holdout start (UTC, whole minute)',hInput),hPreview,
    make('label','pfr-check',hConfirm,label('I understand the boundary is permanent and cannot be moved.')),hRegister);
  const eStatus=make('p','pfr-status');eStatus.setAttribute('role','status');
  const eRaw=make('input');eRaw.type='text';eRaw.autocomplete='off';eRaw.spellcheck=false;eRaw.placeholder='00000000-0000-0000-0000-000000000000';
  const eDeploy=make('select');
  const eButton=button('Enroll profile','primary');
  const eJob=make('div','pfr-job');
  const pStatus=make('p','pfr-status');pStatus.setAttribute('role','status');
  const pProfile=make('input');pProfile.type='text';pProfile.autocomplete='off';pProfile.spellcheck=false;pProfile.placeholder='00000000-0000-0000-0000-000000000000';
  const pButton=button('Start Preflight','primary');
  const pCancel=button('Cancel Preflight');pCancel.hidden=true;
  const pCancelYes=button('Yes, cancel it','ghost pfr-danger');pCancelYes.hidden=true;
  const pJob=make('div','pfr-job');
  panel.append(make('div','panel-title',make('div',null,title,
      label('Three owner steps for R7. Each button sends one request; nothing runs by itself. Paper only: no orders, the holdout stays unread.','p'))),scope,
    card('1. Holdout boundary',hStatus,hValue,hForm),
    card('2. Profile enrollment',field('Raw dataset job',eRaw),field('READY deployment',eDeploy),eButton,eStatus,eJob),
    card('3. Preflight',field('Profile job',pProfile),label('Uses the READY deployment chosen above.','p','pfr-note'),make('div','pfr-actions',pButton,pCancel,pCancelYes),pStatus,pJob));
  anchor.after(panel);

  // Per-bot memory for the page's life: a job and its request key survive a bot switch, so a late answer is never lost.
  // keys: inputs -> key; unknown: keys with an earlier unknown outcome; blocked: inputs held until a typed CLEAR.
  const slotOf=()=>({job:null,keys:new Map(),unknown:new Set(),blocked:new Set(),busy:false,timer:0,step:0,failures:0,stopped:false,cancelling:false});
  const memory=new Map();
  const slots=bot=>{if(!memory.has(bot))memory.set(bot,{enroll:slotOf(),preflight:slotOf()});return memory.get(bot);};
  const view={bot:'',seq:0,holdout:null,holdoutLoaded:false,holdoutBusy:false,deployments:[]};
  // The enroll request also lives in session storage (never the persistent store), one entry per signed-in user and bot:
  // {inputs, key, job_id}. The server has no enrollment list and no one-active guard, so after a reload this entry is what
  // lets the panel find the running job and reuse the key for the same inputs. Every access is guarded; without storage
  // the panel keeps working from memory. Idempotency keys are not secrets.
  const STORE='pfr.';
  const ownerId=()=>{try{return typeof me!=='undefined'&&me?.user?.id?String(me.user.id):'';}catch{return '';}};
  // pfr.enroll.<owner>.<bot> and pfr.preflight.<owner>.<bot>; callers capture the name once per request.
  const entryName=(kind,bot)=>STORE+kind+'.'+ownerId()+'.'+bot;
  const stored={
    read(name){try{const value=JSON.parse(sessionStorage.getItem(name)||'null');
      return value&&typeof value.inputs==='string'&&typeof value.key==='string'?value:null;}catch{return null;}},
    write(name,value){try{sessionStorage.setItem(name,JSON.stringify(value));}catch{}},
    clear(name){try{sessionStorage.removeItem(name);}catch{}},
    clearAll(){try{for(let index=sessionStorage.length-1;index>=0;index--){const name=sessionStorage.key(index);if(name&&name.startsWith(STORE))sessionStorage.removeItem(name);}}catch{}}};
  // Clear an entry only when it still records this job (another request may have replaced it meanwhile).
  const clearFor=(name,job)=>{const entry=stored.read(name);if(entry&&entry.job_id&&entry.job_id===job?.job_id)stored.clear(name);};

  // A status line: a known code reads as plain text plus the raw code; a closed feature is a neutral note, not an error.
  function say(line,error,ok){
    line.className='pfr-status';line.replaceChildren();
    if(!error){if(ok){line.classList.add('pfr-ok');line.append(label(ok));}return;}
    const code=codeOf(error);
    if(closedError(error)){line.classList.add('pfr-closed');line.append(label('This step is closed on this server.'),' ',data(code));return;}
    line.classList.add('pfr-bad');
    line.append(KNOWN[code]?label(KNOWN[code]):label(/_REQUIRED$/.test(code)?'A required earlier step is missing.':'The request failed.'),' ',data(code));
  }
  const summary=result=>make('dl','pfr-summary',...Object.entries(result&&typeof result==='object'?result:{})
    .filter(([,value])=>['string','number','boolean'].includes(typeof value)).slice(0,8)
    .flatMap(([key,value])=>[data(key,'dt'),data(value,'dd')]));
  function showJob(box,slot,retry){
    box.replaceChildren();const job=slot.job;if(!job)return;
    const diagnostic=typeof job.diagnostic==='string'?job.diagnostic:job.diagnostic?.code??null;
    box.append(make('p','pfr-line',label('Job ID'),' ',data(job.job_id??'\u2014'),' \u00b7 ',data(job.status??'\u2014','strong'),
      Number.isFinite(job.total_bars)?' \u00b7 ':'',Number.isFinite(job.total_bars)?make('span','no-i18n',tpl('{n} / {total} bars',{n:Number(job.next_bar)||0,total:job.total_bars})):''));
    if(diagnostic)box.append(make('p','pfr-line',KNOWN[diagnostic]?label(KNOWN[diagnostic]):'',' ',data(diagnostic)));
    if(job.status==='SUCCEEDED'&&job.result)box.append(summary(job.result));
    if(job.status==='SUCCEEDED'&&job.envelope)box.append(label('Evidence stored. The Readiness report above now reads it.','p','pfr-ok'));
    if(slot.stopped&&ACTIVE.includes(job.status)){const again=button('Check status');again.addEventListener('click',retry);
      box.append(make('p','pfr-line',label('Watching stopped after repeated failures.'),' ',again));}
  }

  // 1. Holdout boundary
  const parseUtc=value=>{const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value||'');
    if(!match)return null;if(match[6]&&match[6]!=='00'||match[7]&&/[1-9]/.test(match[7]))return NaN;
    return Date.UTC(+match[1],+match[2]-1,+match[3],+match[4],+match[5]);};
  function holdoutProblem(){
    const ms=parseUtc(hInput.value);
    if(ms===null)return 'Enter a UTC date and time.';
    if(!Number.isFinite(ms)||ms%MINUTE!==0)return 'Use a whole minute.';
    if(ms>Math.floor(Date.now()/MINUTE)*MINUTE)return 'The time is in the future.';
    return null;
  }
  function renderHoldout(){
    const value=view.holdout?.holdout_start_time;
    hValue.replaceChildren();
    if(view.holdoutLoaded&&Number.isFinite(value))hValue.append(label('Holdout starts'),': ',data(minuteText(value)+' UTC','strong'),' ',label('(registered, read only)','span','pfr-muted'));
    hForm.hidden=!view.holdoutLoaded||Number.isFinite(value);
    const ms=parseUtc(hInput.value),problem=holdoutProblem();
    hPreview.replaceChildren();
    // The exact value the server will store, repeated in UTC, Bangkok time and epoch ms before the permanent write.
    if(!problem)hPreview.append(make('span','no-i18n',tpl('Will register {utc} UTC (Bangkok local {local}) \u00b7 {ms} ms',{utc:minuteText(ms),local:minuteText(ms+BANGKOK),ms})));
    hRegister.disabled=hForm.hidden||!!problem||!hConfirm.checked||view.holdoutBusy;
  }
  function holdoutEdited(){
    // A new value needs a new confirmation; an old message no longer applies.
    hConfirm.checked=false;say(hStatus,null);
    const problem=hInput.value?holdoutProblem():null;if(problem)hStatus.append(label(problem));
    renderHoldout();
  }
  async function loadHoldout(bot,seq){
    try{const answer=await api('/api/quant/data/holdout-boundaries',{botId:bot,silent:true});if(seq!==view.seq)return;
      view.holdout=answer;view.holdoutLoaded=true;say(hStatus,null);}
    catch(error){if(seq!==view.seq)return;view.holdout=null;view.holdoutLoaded=false;say(hStatus,error);}
    renderHoldout();
  }
  async function registerHoldout(){
    const bot=botId(),ms=parseUtc(hInput.value),seq=view.seq;
    if(hRegister.disabled||!bot||bot==='all')return;
    view.holdoutBusy=true;renderHoldout();
    try{const answer=await api('/api/quant/data/holdout-boundaries',{method:'POST',silent:true,botId:bot,body:JSON.stringify({bot_id:bot,holdout_start_time:ms})});
      if(seq!==view.seq)return;hConfirm.checked=false;hInput.value='';await loadHoldout(bot,seq);
      say(hStatus,null,answer?.registered===false?'This boundary was already registered.':'Holdout boundary registered.');}
    catch(error){if(seq===view.seq)say(hStatus,error);}
    finally{view.holdoutBusy=false;renderHoldout();}
  }

  // Deployments and inputs
  async function loadDeployments(bot,seq){
    try{const answer=await api('/api/quant/pine-bridge/deployments',{botId:bot,silent:true});if(seq!==view.seq)return;
      view.deployments=(Array.isArray(answer?.deployments)?answer.deployments:[]).filter(item=>item?.state==='READY'&&typeof item.deployment_id==='string');}
    catch{if(seq===view.seq)view.deployments=[];}
    const current=eDeploy.value;
    eDeploy.replaceChildren(label('Choose a READY deployment','option'),...view.deployments.map(item=>{
      const option=make('option','no-i18n',item.deployment_id.slice(0,8)+(item.source_version?' \u00b7 v'+item.source_version:''));option.value=item.deployment_id;return option;}));
    eDeploy.firstChild.value='';
    eDeploy.value=view.deployments.some(item=>item.deployment_id===current)?current:view.deployments.length===1?view.deployments[0].deployment_id:'';
    renderButtons();
  }
  function prefillRaw(bot){
    try{if(!eRaw.value&&typeof qDataJob!=='undefined'&&qDataJob?.status==='SUCCEEDED'&&qDataJobBotId===bot&&JOB_ID.test(qDataJob.job_id))eRaw.value=qDataJob.job_id;}catch{}
  }
  const inputsOf=kind=>JSON.stringify(kind==='enroll'?{bot_id:botId(),raw_job_id:eRaw.value.trim(),deployment_id:eDeploy.value}:
    {bot_id:botId(),deployment_id:eDeploy.value,profile_job_id:pProfile.value.trim()});
  const blockBoxes={enroll:make('div','pfr-blocked'),preflight:make('div','pfr-blocked')};
  eJob.before(blockBoxes.enroll);pJob.before(blockBoxes.preflight);
  function renderBlocked(bot,kind){
    const box=blockBoxes[kind],slot=slots(bot)[kind],inputs=inputsOf(kind);
    if(!slot.blocked.has(inputs)){box.replaceChildren();box.hidden=true;box.dataset.inputs='';return;}
    if(!box.hidden&&box.dataset.inputs===inputs)return;
    box.hidden=false;box.dataset.inputs=inputs;
    const typed=make('input');typed.type='text';typed.autocomplete='off';typed.spellcheck=false;typed.placeholder='CLEAR';
    const forget=button('Forget this request');forget.disabled=true;
    typed.addEventListener('input',()=>{forget.disabled=typed.value!=='CLEAR';});
    forget.addEventListener('click',()=>{if(typed.value!=='CLEAR')return;
      const key=slot.keys.get(inputs);slot.blocked.delete(inputs);slot.keys.delete(inputs);if(key)slot.unknown.delete(key);
      const name=entryName(kind,bot),entry=stored.read(name);
      if(entry?.inputs===inputs){if(entry.job_id)stored.write(name,{...entry,unknown:false,blocked:false});else stored.clear(name);}
      renderButtons();});
    box.replaceChildren(label('An earlier request may already have started a job. Check with the operator before you send it again.','p','pfr-bad'),
      field('Type CLEAR to forget this request. Sending it again after that may create a second job.',typed),forget);
  }
  function renderButtons(){
    const bot=botId(),single=!!bot&&bot!=='all',{enroll,preflight}=slots(bot);
    eButton.disabled=!single||enroll.busy||!JOB_ID.test(eRaw.value.trim())||!eDeploy.value||ACTIVE.includes(enroll.job?.status)||enroll.blocked.has(inputsOf('enroll'))||enroll.adopting===true;
    pButton.disabled=!single||preflight.busy||!JOB_ID.test(pProfile.value.trim())||!eDeploy.value||ACTIVE.includes(preflight.job?.status)||preflight.blocked.has(inputsOf('preflight'))||preflight.adopting===true;
    renderBlocked(bot,'enroll');renderBlocked(bot,'preflight');
    const cancellable=['QUEUED','PAUSED','RUNNING'].includes(preflight.job?.status)&&!preflight.cancelling;
    if(!cancellable)pCancelYes.hidden=true;
    pCancel.hidden=!cancellable||!pCancelYes.hidden;
  }
  // One key per exact input set: the same inputs always reuse their key (a safe retry, even after trying other inputs),
  // different inputs get their own key, and a success retires only the key of the inputs that succeeded.
  function keyFor(slot,inputs){if(!slot.keys.has(inputs))slot.keys.set(inputs,newKey());return slot.keys.get(inputs);}

  // Watching jobs: GET only, for the bot on screen, while visible; stops on a terminal status, a refusal, a closed
  // feature or five failures in a row.
  const PROFILE_PATH='/api/quant/data/profiles/',PREFLIGHT_PATH='/api/quant/data/preflights/';
  function stopWatch(slot){clearTimeout(slot.timer);slot.timer=0;}
  const parts={enroll:{path:PROFILE_PATH,box:eJob,line:eStatus},preflight:{path:PREFLIGHT_PATH,box:pJob,line:pStatus}};
  const onScreen=bot=>bot===botId()&&bot===view.bot;
  function draw(bot,kind){if(!onScreen(bot))return;const slot=slots(bot)[kind];showJob(parts[kind].box,slot,()=>{slot.stopped=false;slot.failures=0;watch(bot,kind,true);});renderButtons();}
  function finished(bot,kind,job){
    if(!ACTIVE.includes(job?.status))clearFor(entryName(kind,bot),job);
    if(!onScreen(bot)||job.status!=='SUCCEEDED')return;
    if(kind==='enroll'){if(!pProfile.value)pProfile.value=job.job_id;say(eStatus,null,'Profile enrolled and verified.');}
    else{say(pStatus,null,'Preflight finished.');document.getElementById('pf3Refresh')?.click();}
    renderButtons();
  }
  function watch(bot,kind,now=false){
    const slot=slots(bot)[kind],{path,line}=parts[kind];
    stopWatch(slot);
    if(!slot.job||!ACTIVE.includes(slot.job.status)||slot.stopped||!onScreen(bot)||!visible())return;
    slot.timer=setTimeout(async()=>{
      slot.timer=0;if(!onScreen(bot)||!visible())return;
      const before=slot.job;
      try{const next=await api(path+encodeURIComponent(before.job_id),{botId:bot,silent:true});
        slot.job=next;slot.failures=0;slot.step=next.status===before.status?slot.step+1:0;if(onScreen(bot))say(line,null);}
      catch(error){
        slot.step++;slot.failures++;if(onScreen(bot))say(line,error);
        // A refusal or a closed feature will not change by waiting; network errors and 5xx retry up to five times in a row.
        const refused=Number.isInteger(error?.status)&&error.status<500&&error.status!==429;
        if(refused||closedError(error)||slot.failures>=MAX_FAILURES){slot.stopped=true;draw(bot,kind);return;}
      }
      draw(bot,kind);
      if(ACTIVE.includes(slot.job.status))watch(bot,kind);else finished(bot,kind,slot.job);
    },now?0:POLL[Math.min(slot.step,POLL.length-1)]);
  }

  async function submit(kind){
    const bot=botId(),slot=slots(bot)[kind],enroll=kind==='enroll',{line,box}=parts[kind];
    if((enroll?eButton:pButton).disabled)return;
    const body=enroll?{bot_id:bot,raw_job_id:eRaw.value.trim(),deployment_id:eDeploy.value}:{bot_id:bot,deployment_id:eDeploy.value,profile_job_id:pProfile.value.trim()};
    const inputs=JSON.stringify(body),key=keyFor(slot,inputs);slot.busy=true;renderButtons();
    // Written before the request leaves, so a reload during an unanswered POST still retries with the same key.
    // Never downgrade: a job id already stored for this very key stays; another key starts without one.
    const name=entryName(kind,bot),before=stored.read(name);
    stored.write(name,{inputs,key,job_id:before?.key===key?before.job_id??null:null,unknown:slot.unknown.has(key),blocked:false});
    try{const job=await api(enroll?'/api/quant/data/profile-enrollments':'/api/quant/data/preflights',
        {method:'POST',silent:true,botId:bot,headers:{'idempotency-key':key},body:JSON.stringify(body)});
      // Stored under the bot it was sent for, even if the owner switched bots meanwhile.
      slot.keys.delete(inputs);slot.unknown.delete(key);Object.assign(slot,{job,step:0,failures:0,stopped:false});
      stored.write(name,{inputs,key,job_id:typeof job?.job_id==='string'?job.job_id:null});
      // A replayed key may answer with a job that already ended: show its real status, not 'queued'.
      if(onScreen(bot)){if(ACTIVE.includes(job?.status))say(line,null,enroll?'Enrollment queued.':'Preflight queued.');else say(line,null);showJob(box,slot);}
      // A replayed key can answer with a job that already ended: settle it now instead of watching.
      if(ACTIVE.includes(job?.status))watch(bot,kind);else finished(bot,kind,job);
    }catch(error){
      const mark=flags=>stored.write(name,{...(stored.read(name)||{inputs,key,job_id:null}),...flags});
      if(codeOf(error)==='IDEMPOTENCY_CONFLICT'){
        // The server holds other inputs under this key, so no job exists for these inputs under it: retire the key, no block.
        slot.keys.delete(inputs);slot.unknown.delete(key);if(stored.read(name)?.key===key)stored.clear(name);if(onScreen(bot))say(line,error);
      }else if(unknownOutcome(error)){slot.unknown.add(key);mark({unknown:true});if(onScreen(bot))say(line,error);}
      else if(retryable(error)){if(onScreen(bot)){say(line,error);line.append(' ',label('This attempt started nothing. Sign in again if asked, then press the button again.'));}}
      else if(slot.unknown.has(key)){
        // An earlier attempt with this key may have created the job: hold these inputs until the owner clears them by hand.
        slot.blocked.add(inputs);mark({unknown:true,blocked:true});if(onScreen(bot))say(line,error);
      }else{
        // A refusal on the first and only attempt of this key: nothing was created, so the key and its entry go.
        slot.keys.delete(inputs);const entry=stored.read(name);if(entry?.key===key&&!entry.job_id)stored.clear(name);if(onScreen(bot))say(line,error);
      }
      if(!enroll&&codeOf(error)==='PREFLIGHT_ALREADY_ACTIVE')adoptPreflight(bot,view.seq);
    }finally{slot.busy=false;if(onScreen(bot))renderButtons();}
  }
  // A reload keeps the stored entries: reuse their key for the same inputs and read their job (GET only) so it can be watched.
  // The buttons of that kind wait until the read answers.
  async function adoptStored(bot,kind,seq){
    const name=entryName(kind,bot),entry=stored.read(name),slot=slots(bot)[kind];if(!entry)return;
    if(!slot.keys.has(entry.inputs))slot.keys.set(entry.inputs,entry.key);
    // An entry without a job id was written before a request whose answer never arrived: its outcome is unknown.
    // A request of this tab still in flight wrote that entry itself; its outcome is not unknown yet.
    if(entry.unknown||!entry.job_id&&!slot.busy)slot.unknown.add(entry.key);if(entry.blocked)slot.blocked.add(entry.inputs);
    if(!entry.job_id||!JOB_ID.test(entry.job_id)||slot.job?.job_id===entry.job_id)return;
    slot.adopting=true;if(onScreen(bot))renderButtons();
    try{const job=await api(parts[kind].path+encodeURIComponent(entry.job_id),{botId:bot,silent:true});
      if(slot.job?.job_id&&slot.job.job_id!==entry.job_id&&ACTIVE.includes(slot.job.status))return;
      Object.assign(slot,{job,step:0,failures:0,stopped:false});
      if(ACTIVE.includes(job.status)){if(seq===view.seq){draw(bot,kind);watch(bot,kind);}}else{clearFor(name,job);if(seq===view.seq)draw(bot,kind);}
    }catch(error){if(seq===view.seq&&onScreen(bot))say(parts[kind].line,error);}
    finally{slot.adopting=false;if(onScreen(bot))renderButtons();}
  }  // The newest active Preflight of this bot, from the server's own list (GET), so a reload or another tab can watch or cancel it.
  async function adoptPreflight(bot,seq){
    try{const list=await api('/api/quant/data/preflights',{botId:bot,silent:true});if(seq!==view.seq||!onScreen(bot))return;
      const active=(Array.isArray(list)?list:[]).find(job=>ACTIVE.includes(job?.status)&&typeof job.job_id==='string'&&job.bot_id===bot);
      const slot=slots(bot).preflight;
      if(active&&!(slot.job&&slot.job.job_id===active.job_id&&ACTIVE.includes(slot.job.status))){Object.assign(slot,{job:active,step:0,failures:0,stopped:false});}
      draw(bot,'preflight');watch(bot,'preflight');
    }catch(error){if(seq===view.seq&&onScreen(bot)&&!closedError(error))say(pStatus,error);}
  }
  async function cancelPreflight(){
    const bot=botId(),slot=slots(bot).preflight,job=slot.job;pCancelYes.hidden=true;
    if(!job||!['QUEUED','PAUSED','RUNNING'].includes(job.status)||slot.cancelling)return renderButtons();
    slot.cancelling=true;renderButtons();
    try{const next=await api(PREFLIGHT_PATH+encodeURIComponent(job.job_id)+'/cancel',{method:'POST',silent:true,botId:bot,body:'{}'});
      slot.job=next;slot.step=0;if(onScreen(bot))say(pStatus,null,'Cancel requested.');draw(bot,'preflight');watch(bot,'preflight');}
    catch(error){if(onScreen(bot))say(pStatus,error);}
    finally{slot.cancelling=false;if(onScreen(bot))renderButtons();}
  }

  // Lifecycle: the view follows the selected bot; jobs and keys stay in memory under their bot.
  function stopAll(){for(const {enroll,preflight} of memory.values()){stopWatch(enroll);stopWatch(preflight);}}
  function showBot(bot){
    view.seq++;stopAll();view.bot=bot;view.holdout=null;view.holdoutLoaded=false;view.deployments=[];
    eRaw.value='';pProfile.value='';hInput.value='';hConfirm.checked=false;pCancelYes.hidden=true;
    for(const node of [hStatus,eStatus,pStatus])say(node,null);hValue.replaceChildren();hPreview.replaceChildren();
    const {enroll,preflight}=slots(bot);
    if(enroll.job?.status==='SUCCEEDED'&&preflight.job===null)pProfile.value=enroll.job.job_id;
    if(preflight.job?.profile_job_id)pProfile.value=preflight.job.profile_job_id;
  }
  function open(){
    const bot=botId(),all=!bot||bot==='all';
    scope.hidden=!all;for(const node of panel.querySelectorAll('.pfr-card'))node.hidden=all;
    if(all||!visible()){stopAll();return renderButtons();}
    if(view.bot!==bot)showBot(bot);
    const seq=view.seq;prefillRaw(bot);
    if(!view.holdoutLoaded)loadHoldout(bot,seq);
    loadDeployments(bot,seq);
    draw(bot,'enroll');draw(bot,'preflight');
    watch(bot,'enroll');adoptStored(bot,'enroll',seq);adoptStored(bot,'preflight',seq);adoptPreflight(bot,seq);
    renderHoldout();renderButtons();
  }
  hInput.addEventListener('input',holdoutEdited);hInput.addEventListener('change',holdoutEdited);hConfirm.addEventListener('change',renderHoldout);
  hRegister.addEventListener('click',registerHoldout);
  for(const input of [eRaw,pProfile])input.addEventListener('input',renderButtons);
  eDeploy.addEventListener('change',renderButtons);
  eButton.addEventListener('click',()=>submit('enroll'));pButton.addEventListener('click',()=>submit('preflight'));
  pCancel.addEventListener('click',()=>{pCancelYes.hidden=false;renderButtons();});
  pCancelYes.addEventListener('click',cancelPreflight);
  document.querySelector('nav button[data-view="risk"]')?.addEventListener('click',()=>setTimeout(open,0));
  document.getElementById('botSwitcher')?.addEventListener('change',()=>setTimeout(()=>{stopAll();view.bot='';if(!page.hidden)open();else renderButtons();},0));
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')stopAll();else if(!page.hidden)open();});
  document.querySelectorAll('nav button').forEach(item=>{if(item.dataset.view!=='risk')item.addEventListener('click',stopAll);});
  document.getElementById('logout')?.addEventListener('click',()=>{stopAll();memory.clear();stored.clearAll();view.bot='';});
  document.getElementById('language')?.addEventListener('change',()=>{const bot=botId();renderHoldout();if(bot&&bot!=='all'){draw(bot,'enroll');draw(bot,'preflight');}});
  renderHoldout();renderButtons();
})();