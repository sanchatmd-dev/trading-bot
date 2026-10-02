/* Owner-triggered bounded research jobs. All execution and readiness decisions remain server-side. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const T=text=>typeof translate==='function'?translate(text):text;
  const terminal=status=>['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT'].includes(status);
  const make=(tag,text,id)=>{const e=document.createElement(tag);if(text){e.dataset.uiLabel=text;e.textContent=T(text);}if(id)e.id=id;return e;};
  const panel=make('details',null,'qrjPanel');panel.className='panel qrj';
  panel.append(make('summary','Research job'));
  panel.append(make('p','Bounded Spot/Paper research. Results require independent acceptance; they are not recommendations.'));
  const status=make('p',null,'qrjStatus');status.append(make('span','Open this panel to check research admission.'));status.setAttribute('role','status');status.setAttribute('aria-live','polite');panel.append(status);
  const form=make('fieldset',null,'qrjForm');panel.append(form);
  const field=(name,id,type='number',value='')=>{const label=make('label'),input=make('input',null,id);label.append(make('span',name));input.type=type;input.value=value;input.step='any';label.append(input);form.append(label);return input;};
  const seedLabel=make('label');seedLabel.append(make('span','Seed from Research Library'));
  const select=make('select',null,'qrjSeedRun');seedLabel.append(select);form.append(seedLabel);
  const load=make('button','Load selected run','qrjLoad');load.type='button';form.append(load);
  const identity=make('p',null,'qrjIdentity');form.append(identity);
  const domains=make('div',null,'qrjDomains');form.append(domains);
  const start=field('Dataset start (UTC, inclusive)','qrjStart','datetime-local');start.step='60';
  const end=field('Dataset end (UTC, inclusive)','qrjEnd','datetime-local');end.step='60';
  const warmup=field('Warm-up bars (inside dataset)','qrjWarmup','number','1250');
  const budget=field('Candidate budget (1–100)','qrjBudget','number','21');
  const seed=field('Random seed (0–2147483647)','qrjSeed','number','20261002');
  const deadline=field('Deadline from submission (60–900 seconds)','qrjDeadline','number','900');
  form.append(make('p','UTC only. At most 10,000 total bars, including warm-up; at least 2,000 measured bars. Dataset availability and readiness are checked on submission.'));
  const review=make('button','Review submission','qrjReview');review.type='button';form.append(review);
  const summary=make('pre',null,'qrjSummary');summary.hidden=true;panel.append(summary);
  const confirm=make('button','Confirm and submit frozen request','qrjSubmit');confirm.type='button';confirm.hidden=true;panel.append(confirm);
  const edit=make('button','Edit request','qrjEdit');edit.type='button';edit.hidden=true;panel.append(edit);
  const progress=make('p',null,'qrjProgress');progress.setAttribute('aria-live','polite');panel.append(progress);
  const check=make('button','Check job status','qrjCheck');check.type='button';check.hidden=true;panel.append(check);
  const cancel=make('button','Cancel research job','qrjCancel');cancel.type='button';cancel.hidden=true;panel.append(cancel);
  const library=make('button','Open Research Library','qrjLibrary');library.type='button';library.hidden=true;panel.append(library);
  const another=make('button','Prepare another job','qrjAnother');another.type='button';another.hidden=true;panel.append(another);
  const refresh=make('button','Check admission again','qrjRefresh');refresh.type='button';panel.append(refresh);
  host.insertBefore(panel,document.getElementById('qrlPanel'));
  let epoch=0,loading=false,admission=false,source=null,rows=[],frozen=null,frozenDimensions=[],key=null,busy=false,uncertain=false,job=null,timer=null,polls=0,scope='',submissionPending=false,pollVersion=0,pollLoading=false;
  const unresolved=new Map();
  const owner=()=>typeof me==='undefined'?'unknown-session':String(me?.user?.id??'unknown-session');
  const botScope=()=>typeof selectedBot==='undefined'?'':selectedBot;
  const loggedIn=()=>typeof authenticated==='undefined'||authenticated;
  const message=text=>status.replaceChildren(make('span',text));
  const diagnostic=error=>{const code=make('code');code.textContent=String(error.code||error.message||error.status||'');status.append(document.createTextNode(' '),code);};
  const validContext=token=>token===epoch&&scope===botScope()&&loggedIn()&&!document.getElementById('app')?.hidden;
  const stop=()=>{clearTimeout(timer);timer=null;pollVersion++;pollLoading=false;};
  function reset(){if(frozen&&(uncertain||submissionPending))unresolved.set(owner(),{body:frozen,key,dimensions:frozenDimensions});epoch++;stop();loading=busy=uncertain=admission=submissionPending=false;source=frozen=job=null;frozenDimensions=[];key=null;rows=[];select.replaceChildren();domains.replaceChildren();identity.textContent=progress.textContent='';summary.textContent='';summary.hidden=confirm.hidden=edit.hidden=cancel.hidden=library.hidden=check.hidden=another.hidden=true;form.disabled=false;load.disabled=false;refresh.disabled=false;review.disabled=true;message('Open this panel to check research admission.');}
  function error(error){if(error.status===401||error.status===403){reset();message('Sign in again or check owner permissions.');diagnostic(error);return;}
    if(error.code==='QUANT_RESEARCH_DISABLED'){admission=false;review.disabled=confirm.disabled=true;message('Research admission is closed. No new job was submitted.');}
    else message('Request failed. Check the error before continuing.');diagnostic(error);}
  async function get(path,options={}){return api(path,{silent:true,botId:'',...options});}
  async function open(){if(loading||busy||job||frozen)return;scope=botScope();const token=++epoch;loading=true;review.disabled=true;message('Checking research admission…');
    try {const list=await get('/api/quant/library?limit=20');if(!validContext(token))return;admission=list.admission_enabled===true;select.replaceChildren();
      select.append(new Option(T('Choose a preserved run'),''));for(const run of list.runs||[]){const id=String(run.run_id),date=Number.isFinite(run.created_at)?new Date(run.created_at).toISOString().slice(0,16).replace('T',' ')+' UTC · ':'';const option=new Option(date+String(run.status)+' · '+id.slice(0,8),run.run_id);option.title=id;select.append(option);}
      message(admission?'Admission is reported open. The server checks execution readiness on submission.':'Research admission is closed. You can inspect and prepare inputs.');
      const pending=unresolved.get(owner());if(pending){frozen=pending.body;key=pending.key;frozenDimensions=pending.dimensions;uncertain=true;form.disabled=true;renderSummary();summary.hidden=confirm.hidden=edit.hidden=library.hidden=false;confirm.disabled=!admission;edit.disabled=true;confirm.dataset.uiLabel='Retry unchanged submission';confirm.textContent=T('Retry unchanged submission');message('Submission outcome is unknown. Retry only this unchanged request with the same key.');}
    }catch(e){if(validContext(token))error(e);}finally{if(token===epoch)loading=false;}}
  function domainRow(name,baseline,domain,input){const row=make('div');row.className='qrj-domain';row.append(make('strong',null),make('span',null));row.children[0].textContent=name;row.children[1].textContent=T('Baseline')+': '+String(baseline);
    const controls={};for(const part of ['min','max','step']){const label=make('label');label.append(make('span',({min:'Minimum',max:'Maximum',step:'Step'})[part]));const control=make('input');control.type='number';control.step='any';control.value=domain?.[part]??'';label.append(control);row.append(label);controls[part]=control;}
    domains.append(row);rows.push({name,baseline,input,controls});}
  load.addEventListener('click',async()=>{if(!select.value||loading||frozen)return;const token=++epoch;loading=true;scope=botScope();load.disabled=true;
    try{const detail=await get('/api/quant/library/runs/'+encodeURIComponent(select.value));if(!validContext(token))return;
      const input=detail.provenance?.input,bindings=input?.bindings;
      if(detail.integrity?.contract_hash_verified!==true||detail.integrity?.warnings?.length||!Array.isArray(bindings)||bindings.length!==8)throw new Error(T('A verified run with eight source bindings is required.'));
      source={bot_id:detail.run.bot_id,deployment_id:detail.run.deployment_id};rows=[];domains.replaceChildren();identity.textContent=T('Bot')+': '+source.bot_id+' · '+T('Deployment')+': '+source.deployment_id;
      for(const binding of bindings)domainRow(binding.pine_variable,binding.effective_value,binding.search_domain,binding);
      for(const name of ['atr_multiplier','rr']){const d=input.domains?.find(d=>d.dimension===name);const domain=d?{min:d.min,max:d.max,step:Number.isInteger(d.count)&&d.count>=2?(d.max-d.min)/(d.count-1):null}:null;domainRow(name,input.bridge?.[name],domain,null);}
      warmup.value=detail.provenance.dataset?.warmup_bars??1250;review.disabled=!admission;message(admission?'Inputs loaded. Choose the dataset explicitly, then review.':'Research admission is closed. You can inspect and prepare inputs.');
    }catch(e){if(validContext(token)){source=null;rows=[];domains.replaceChildren();review.disabled=true;error(e);}}finally{if(token===epoch){loading=false;load.disabled=false;}}});
  const integer=(value,min,max)=>{const n=Number(value);if(String(value).trim()===''||!Number.isSafeInteger(n)||n<min||n>max)throw new Error(T('Check integer limits.'));return n;};
  const utc=value=>{if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error(T('Enter a whole-minute UTC date.'));const n=Date.parse(value+':00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,16)!==value||n<=0||n>Date.now())throw new Error(T('Enter a valid past UTC date.'));return n;};
  function payload(){if(!source||rows.length!==10)throw new Error(T('Load a verified run first.'));
    const body={...source,parameter_slots:[],bridge_domains:{},dataset:{start_time:utc(start.value),end_time:utc(end.value),warmup_bars:integer(warmup.value,1006,5000)},budget:integer(budget.value,1,100),seed:integer(seed.value,0,2147483647),deadline_seconds:integer(deadline.value,60,900)};
    for(const row of rows){const domain=Object.fromEntries(Object.entries(row.controls).map(([part,c])=>[part,c.value.trim()===''?NaN:Number(c.value)]));const count=(domain.max-domain.min)/domain.step;
      if(!Object.values(domain).every(Number.isFinite)||domain.min>=domain.max||domain.step<=0||count>999||Math.abs(count-Math.round(count))>1e-7||!Number.isFinite(row.baseline)||row.baseline<domain.min||row.baseline>domain.max||Math.abs((row.baseline-domain.min)/domain.step-Math.round((row.baseline-domain.min)/domain.step))>1e-7)throw new Error(T('Check each grid and its baseline alignment.'));
      if(row.input)body.parameter_slots.push({slot:row.input.slot,input_id:row.input.input_id,...domain});else body.bridge_domains[row.name]=domain;
    }
    const total=1+(body.dataset.end_time-body.dataset.start_time)/60000,slow=rows.find(row=>row.name==='emaSlowInput');
    if(body.dataset.start_time>=body.dataset.end_time||total>10000||total-body.dataset.warmup_bars<2000||body.dataset.warmup_bars<Math.max(1006,(slow?Number(slow.controls.max.value):0)*5))throw new Error(T('Check dataset length and warm-up limits.'));
    return body;
  }
  function renderSummary(){if(!frozen)return;
    const body=JSON.parse(frozen),total=1+(body.dataset.end_time-body.dataset.start_time)/60000,measured=total-body.dataset.warmup_bars,train=Math.floor(measured*.6),validation=Math.floor(measured*.8)-train,holdout=measured-Math.floor(measured*.8);
    const evaluations=body.budget+25,chunks=Math.ceil((body.dataset.warmup_bars+Math.floor(measured*.8))/1000),launches=(body.budget+1)*chunks,maxLaunches=evaluations*Math.ceil(total/1000);
    const line=(label,value)=>T(label)+': '+value;
    const dimensions=frozenDimensions.map(d=>{const domain=d.slot?body.parameter_slots.find(s=>s.slot===d.slot):body.bridge_domains[d.name];return (d.slot?T('Source slot')+' '+d.slot+' · '+d.name:T(d.name==='atr_multiplier'?'ATR Multiplier':'RR'))+' · '+line('Baseline',d.baseline)+' · '+line('Minimum',domain.min)+' · '+line('Maximum',domain.max)+' · '+line('Step',domain.step);});
    summary.textContent=[T('Frozen request'),line('Bot',body.bot_id),line('Deployment',body.deployment_id),line('Dataset start (UTC, inclusive)',new Date(body.dataset.start_time).toISOString()),line('Dataset end (UTC, inclusive)',new Date(body.dataset.end_time).toISOString()),line('Total bars including warm-up',total),line('Warm-up bars (inside dataset)',body.dataset.warmup_bars),line('Estimated split (train / validation / holdout)',train+' / '+validation+' / '+holdout),line('Candidate budget (1–100)',body.budget),line('Random seed (0–2147483647)',body.seed),line('Deadline from submission (60–900 seconds)',body.deadline_seconds),T('Ten research dimensions'),...dimensions,line('Estimated maximum evaluations / chunk launches',evaluations+' / '+maxLaunches),line('Estimated runtime (seconds, plus preparation)',Math.ceil(launches*2.5)+'–'+Math.ceil(maxLaunches*3)),T('Estimated runtime: 2.5–3 seconds per launch, plus preparation. Not a guarantee; the deadline can expire.'),T('Estimated output cap: 8 MiB; state cap: 1 MiB. Server resource limits remain authoritative.')].join('\n');
  }
  review.addEventListener('click',()=>{if(busy||!admission)return;try{frozen=JSON.stringify(payload());frozenDimensions=rows.map(row=>({name:row.name,baseline:row.baseline,slot:row.input?.slot}));key='research_'+crypto.randomUUID();uncertain=false;form.disabled=true;summary.hidden=confirm.hidden=edit.hidden=false;renderSummary();
    confirm.disabled=false;edit.disabled=false;confirm.dataset.uiLabel='Confirm and submit frozen request';confirm.textContent=T('Confirm and submit frozen request');message('Review the immutable request. Submit only after confirming all inputs.');}catch(e){error(e);}});
  edit.addEventListener('click',()=>{if(busy||uncertain)return;frozen=null;key=null;form.disabled=false;summary.hidden=confirm.hidden=edit.hidden=true;});
  function showJob(value){job=value;const p=job.progress||{};progress.textContent=[T('Status')+': '+String(job.status),T('Phase')+': '+String(job.phase??'—'),T('Candidates')+': '+(p.candidates_completed??0)+' / '+(p.candidates_planned??'—'),T('Checks completed')+': '+(p.checks_completed??0),T('Dimension coverage')+': '+(p.covered_dimensions??0)+' / '+(p.selected_dimensions??10),T('Elapsed seconds')+': '+Math.max(0,Math.floor((Date.now()-job.created_at)/1000)),T('Deadline (UTC)')+': '+(Number.isFinite(job.deadline)?new Date(job.deadline).toISOString():'—'),job.diagnostic?T('Diagnostic')+': '+String(job.diagnostic):''].filter(Boolean).join(' · ');
    const done=terminal(job.status);another.hidden=!done;cancel.hidden=done;cancel.disabled=busy;check.hidden=done;library.hidden=false;confirm.hidden=edit.hidden=true;refresh.disabled=true;if(done){stop();message(job.status==='CANCELLED'?'Cancellation recorded. Worker cleanup may still be in progress. Inspect Research Library.':'Job finished. Inspect the preserved result in Research Library.');} }
  async function poll(manual=false){if(!job||terminal(job.status)||busy||pollLoading)return;stop();if(!loggedIn()||scope!==botScope()){reset();return;}if(host.hidden||document.hidden){message('Polling paused. Use Check job status to resume.');return;}
    if(!manual&&(++polls>240||Date.now()>job.deadline+30000)){message('Polling limit reached. Check status manually or inspect Research Library.');return;}
    const token=epoch,id=job.run_id,version=pollVersion;pollLoading=true;try{const value=await get('/api/quant/research/jobs/'+encodeURIComponent(id));if(!validContext(token)||job?.run_id!==id||version!==pollVersion)return;showJob(value);if(!terminal(value.status)&&polls<240&&Date.now()<=value.deadline+30000)timer=setTimeout(poll,4000);}catch(e){if(validContext(token)&&version===pollVersion){error(e);message(e.status===401||e.status===403?'Sign in again or check owner permissions.':'Polling stopped after an error. Check status manually.');diagnostic(e);}}finally{if(version===pollVersion)pollLoading=false;}}
  confirm.addEventListener('click',async()=>{if(busy||!frozen||job||!admission)return;const token=epoch;busy=submissionPending=true;const requestOwner=owner();unresolved.set(requestOwner,{body:frozen,key,dimensions:frozenDimensions});confirm.disabled=edit.disabled=true;message('Submitting the frozen request…');
    try{const value=await get('/api/quant/research/jobs',{method:'POST',headers:{'Idempotency-Key':key},body:frozen});if(!validContext(token))return;uncertain=false;unresolved.delete(requestOwner);showJob(value);}
    catch(e){if(validContext(token)){uncertain=!(Number.isInteger(e.status)&&e.status>=400&&e.status<500)&&e.code!=='QUANT_RESEARCH_DISABLED';error(e);if(uncertain){message('Submission outcome is unknown. Retry only this unchanged request with the same key.');diagnostic(e);confirm.dataset.uiLabel='Retry unchanged submission';confirm.textContent=T('Retry unchanged submission');}edit.disabled=uncertain;}}
    finally{if(token===epoch){busy=submissionPending=false;if(!uncertain)unresolved.delete(requestOwner);confirm.disabled=!admission;if(!job)edit.disabled=uncertain;else{cancel.disabled=false;polls=0;poll();}}}});
  cancel.addEventListener('click',async()=>{if(busy||!job||terminal(job.status)||!window.confirm(T('Cancel this research job? The preserved result will remain in Research Library.')))return;
    stop();const token=epoch,id=job.run_id;let failure=null;busy=true;cancel.disabled=check.disabled=true;
    try{const value=await get('/api/quant/research/jobs/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:'{}'});if(validContext(token)&&job?.run_id===id)showJob(value);}catch(e){failure=e;if(validContext(token))error(e);}finally{if(token===epoch){busy=false;cancel.disabled=check.disabled=false;if(job&&!terminal(job.status)){message('Check job status before continuing.');if(failure)diagnostic(failure);}}}});
  check.addEventListener('click',()=>{polls=0;poll(true);});
  library.addEventListener('click',()=>document.getElementById('qrlPanel')?.dispatchEvent(new CustomEvent('qrl:reveal',{cancelable:true})));
  another.addEventListener('click',()=>{if(!job||!terminal(job.status)||busy)return;reset();start.value=end.value='';budget.value='21';seed.value='20261002';deadline.value='900';warmup.value='1250';open();});
  refresh.addEventListener('click',open);panel.addEventListener('toggle',()=>{if(panel.open&&!select.options.length)open();else if(!panel.open)stop();});
  document.getElementById('logout')?.addEventListener('click',reset);
  document.getElementById('botSwitcher')?.addEventListener('change',reset);
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{epoch++;stop();if(loading){loading=false;load.disabled=false;select.replaceChildren();}if(submissionPending){uncertain=true;busy=submissionPending=false;edit.disabled=true;confirm.disabled=!admission;confirm.dataset.uiLabel='Retry unchanged submission';confirm.textContent=T('Retry unchanged submission');library.hidden=false;message('A request may be pending. Inspect Research Library before submitting again.');}else if(busy){busy=false;cancel.disabled=check.disabled=false;message('Check job status before continuing.');}}));
  panel.addEventListener('qrj:reveal',event=>{event.preventDefault();panel.open=true;if(!select.options.length&&!loading&&!frozen&&!job)open();panel.scrollIntoView?.({block:'start'});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  const app=document.getElementById('app');if(app)new MutationObserver(()=>{if(app.hidden)reset();}).observe(app,{attributes:true,attributeFilter:['hidden']});
  document.getElementById('language')?.addEventListener('change',()=>{renderSummary();if(job)showJob(job);});
  review.disabled=true;
})();
