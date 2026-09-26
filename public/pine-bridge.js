/* Private draft builder. Uses the existing authenticated api() and CSRF boundary. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const panel=document.createElement('details');panel.className='panel';
  panel.innerHTML=`<summary>Build Pine Bridge — draft preview</summary>
    <p>Submit an authorized Pine v5/v6 indicator. Convert strategies before uploading. Generated drafts need compilation and Paper checks.</p>
    <form id="pbAnalyze"><label>Bot<select id="pbBot" required></select></label><button id="pbLoadBots" type="button">Load my Bots</button>
    <label>Source name<input id="pbName" maxlength="120" value="My indicator" required></label>
    <label>Original indicator<textarea id="pbSource" rows="8" required spellcheck="false"></textarea></label>
    <p>Inspect inputs locally first. Set every value to the value shown in TradingView; changing Pine or the Bot requires a new review. Inspect does not call AI. Analyze sends the authorized source to the configured AI provider.</p>
    <button id="pbInspect" type="button">Inspect inputs (no AI)</button>
    <section id="pbInputReview" hidden aria-label="Effective Pine input review">
      <p id="pbInputReviewStatus"></p>
      <button id="pbSptCustom" type="button" hidden>Fill SPT Custom reference values</button>
      <details open><summary>Review every Pine input</summary><div id="pbInputFields"></div></details>
      <label><input id="pbInputsConfirmed" type="checkbox">I checked every value against the TradingView indicator settings for this source and Bot.</label>
    </section>
    <button id="pbAnalyzeButton" type="submit" disabled>Analyze indicator with AI</button></form>
    <p id="pbStatus" role="status" aria-live="polite"></p><button id="pbCancel" type="button" hidden>Cancel job</button>
    <form id="pbGenerate" hidden><div class="form-grid">
    <label>BUY variable<select id="pbBuy" required></select></label><label>Native exit variable<select id="pbExit" required></select></label>
    <label>Bridge ATR Multiplier for SL<input id="pbAtr" type="number" min="0.000001" max="1000" step="any" value="2.0" required></label>
    <label>Bridge RR<input id="pbRR" type="number" min="0.000001" max="1000" step="any" value="1.5" required></label>
    <label>Broker<select id="pbBroker"><option value="binance-global">Binance Global</option><option value="binance-th">Binance TH</option><option value="innovestx">InnovestX</option><option value="settrade">Settrade</option></select></label>
    <label>Symbol<input id="pbSymbol" value="BTCUSDT" pattern="[A-Z0-9]{3,30}" required></label>
    <label>Pine chart timeframe<input id="pbTimeframe" value="1D" required></label></div>
    <p>Select up to eight numeric inputs. Empty slots stay unused. Other inputs stay at the reviewed TradingView values recorded above. The Pine draft preserves the original source; set its TradingView inputs to those reviewed values.</p>
    <div id="pbSlots"></div><button id="pbGenerateButton" type="submit">Generate draft and setup guide</button></form>
    <pre id="pbDiagnostics"></pre><div id="pbDownloads"></div>`;
  host.append(panel);
  const el=id=>document.getElementById(id),state={source:null,inspection:null,inspectedSource:null,inspectedBot:null,job:null,timer:null,busy:false,requests:new Map(),urls:[],bot:null,epoch:0};
  const status=text=>{el('pbStatus').textContent=text;};
  const setBusy=value=>{state.busy=value;el('pbAnalyzeButton').disabled=value||!el('pbInputsConfirmed').checked;el('pbInspect').disabled=value;el('pbGenerateButton').disabled=value;el('pbBot').disabled=value;el('pbSource').disabled=value;el('pbName').disabled=value;el('pbInputsConfirmed').disabled=value;for(const input of el('pbInputFields').querySelectorAll('input,select'))input.disabled=value;el('pbCancel').hidden=!value;};
  const option=(value,label)=>{const node=document.createElement('option');node.value=value;node.textContent=label;return node;};
  function invalidateInspection(){state.inspection=null;state.inspectedSource=null;state.inspectedBot=null;state.source=null;el('pbInputsConfirmed').checked=false;el('pbInputReview').hidden=true;el('pbInputFields').replaceChildren();el('pbGenerate').hidden=true;el('pbDownloads').replaceChildren();el('pbAnalyzeButton').disabled=true;}
  function clearPrivateState(){state.epoch++;clearTimeout(state.timer);invalidateInspection();state.job=null;state.bot=null;state.requests.clear();state.urls.forEach(URL.revokeObjectURL);state.urls=[];el('pbSource').value='';el('pbBot').replaceChildren();el('pbDiagnostics').textContent='';setBusy(false);status('');}
  document.getElementById('logout')?.addEventListener('click',clearPrivateState);
  el('pbSource').addEventListener('input',invalidateInspection);
  el('pbBot').addEventListener('change',invalidateInspection);
  el('pbInputsConfirmed').addEventListener('change',()=>{el('pbAnalyzeButton').disabled=state.busy||!el('pbInputsConfirmed').checked;});
  function inputEdited(){state.source=null;el('pbGenerate').hidden=true;el('pbDownloads').replaceChildren();el('pbInputsConfirmed').checked=false;el('pbAnalyzeButton').disabled=true;}
  el('pbInputFields').addEventListener('input',inputEdited);
  el('pbInputFields').addEventListener('change',inputEdited);
  const sptHash='0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a';
  function showInspection(inspection){
    state.inspection=inspection;state.inspectedSource=el('pbSource').value;state.inspectedBot=el('pbBot').value;
    el('pbInputFields').replaceChildren();
    for(const item of inspection.inputs){
      const label=document.createElement('label');label.textContent=`${item.pine_variable} — ${item.input_title} (${item.type})`;
      let input;
      if(item.type==='bool'){
        input=document.createElement('select');input.append(option('','Select'),option('true','On'),option('false','Off'));
        input.value=item.default_hint===null?'':String(item.default_hint);
      }else{
        input=document.createElement('input');input.type=['int','float','time'].includes(item.type)?'number':'text';
        if(input.type==='number'){
          input.step=item.type==='float'?'any':'1';
          if(item.type!=='time'){if(item.declared_domain.min!==null)input.min=String(item.declared_domain.min);if(item.declared_domain.max!==null)input.max=String(item.declared_domain.max);}
        }
        input.value=item.default_hint===null?'':String(item.default_hint);
        input.placeholder=item.default_hint===null?'Enter actual TradingView value':'';
      }
      input.dataset.inputId=item.input_id;input.dataset.inputType=item.type;
      if(item.default_hint===null)input.dataset.manualRequired='1';
      label.append(input);
      if(item.type==='time'){
        const note=document.createElement('small');note.textContent=item.default_hint===null?'Unix milliseconds UTC':`Unix milliseconds UTC · ${new Date(item.default_hint).toISOString()}`;label.append(note);
      }
      el('pbInputFields').append(label);
    }
    el('pbInputReviewStatus').textContent=`${inspection.input_count} inputs · source SHA-256 ${inspection.source_hash}. Defaults below are suggestions; verify all values in TradingView before AI analysis.`;
    el('pbSptCustom').hidden=inspection.source_hash!==sptHash;
    el('pbInputReview').hidden=false;el('pbInputsConfirmed').checked=false;el('pbAnalyzeButton').disabled=true;
  }
  el('pbSptCustom').addEventListener('click',()=>{
    if(state.inspection?.source_hash!==sptHash)return;
    const values={preset:'Custom',stFactorInput:3.2,zoneAtrMultInput:1.15,setupExpiryInput:48,cooldownInput:8,slAtrBufferInput:0.6,notifyEnabled:false};
    for(const item of state.inspection.inputs){
      if(!Object.hasOwn(values,item.pine_variable))continue;
      const input=[...el('pbInputFields').querySelectorAll('[data-input-id]')].find(node=>node.dataset.inputId===item.input_id);
      input.value=String(values[item.pine_variable]);
    }
    inputEdited();
    status('SPT Custom reference values filled. Set the same values in TradingView, review all inputs, then confirm.');
  });
  el('pbInspect').addEventListener('click',async()=>{
    if(state.busy)return;
    const source=el('pbSource').value,bot=el('pbBot').value,epoch=state.epoch;
    if(!source||!bot){status('Select a Bot and paste a Pine indicator first.');return;}
    invalidateInspection();el('pbInspect').disabled=true;status('Inspecting Pine inputs locally…');
    try{
      const inspection=await api('/api/quant/pine-bridge/inspect',{method:'POST',botId:bot,silent:true,body:JSON.stringify({bot_id:bot,pine_source:source})});
      if(epoch!==state.epoch||source!==el('pbSource').value||bot!==el('pbBot').value)return;
      showInspection(inspection);status('Review the effective input values below. No AI request has been sent.');
    }catch(error){if(epoch===state.epoch)status(error.message);}
    finally{el('pbInspect').disabled=state.busy;}
  });
  function reviewedValues(){
    if(!state.inspection||state.inspectedSource!==el('pbSource').value||state.inspectedBot!==el('pbBot').value||!el('pbInputsConfirmed').checked)throw new Error('Inspect and confirm the current source, Bot and TradingView inputs first.');
    const values={};
    for(const input of el('pbInputFields').querySelectorAll('[data-input-id]')){
      const {inputId,inputType,manualRequired}=input.dataset;
      if((manualRequired&&input.value==='')||(['int','float','time','bool'].includes(inputType)&&input.value===''))throw new Error('Every input needs its reviewed TradingView value.');
      const value=inputType==='bool'?input.value==='true':['int','float','time'].includes(inputType)?Number(input.value):input.value;
      if(typeof value==='number'&&(!Number.isFinite(value)||(['int','time'].includes(inputType)&&!Number.isSafeInteger(value))))throw new Error('Invalid numeric TradingView input.');
      values[inputId]=value;
    }
    if(Object.keys(values).length!==state.inspection.input_count)throw new Error('Input review is incomplete.');
    return values;
  }
  async function loadBots(){const epoch=state.epoch;try{const response=await api('/api/bots');if(epoch!==state.epoch)return;el('pbBot').replaceChildren(...response.bots.map(b=>option(b.id,b.label)));}catch(e){if(epoch===state.epoch)status(e.message);}}
  el('pbLoadBots').addEventListener('click',()=>{if(!state.busy)loadBots();});
  function duplicates(){const selects=[...el('pbSlots').querySelectorAll('select')],used=new Set(selects.map(s=>s.value).filter(Boolean));for(const select of selects)for(const o of select.options)o.disabled=!!o.value&&o.value!==select.value&&used.has(o.value);}
  function showAnalysis(result,job) {
    state.source={id:job.pine_import_id,version:job.source_version,result};state.bot=el('pbBot').value;
    for(const id of ['pbBuy','pbExit'])el(id).replaceChildren(option('','Select a boolean variable'),...result.declarations.map(v=>option(v,v)));
    el('pbBuy').value=result.proposal.buy??'';el('pbExit').value=result.proposal.exit??'';
    const candidates=result.inputs.filter(i=>i.eligible&&result.proposal.eligible_inputs.includes(i.input_id));
    el('pbSlots').replaceChildren();
    for(let i=3;i<=10;i++) {
      const row=document.createElement('fieldset');row.className='form-grid';const label=document.createElement('label');label.textContent='Slot '+i;
      const select=document.createElement('select');select.dataset.slot=i;select.append(option('','Unused'),...candidates.map(c=>option(c.input_id,`${c.pine_variable} (${c.type}, ${c.effective_value}) — Quant pending`)));label.append(select);row.append(label);
      for(const field of ['min','max','step']){const l=document.createElement('label');l.textContent=field;const input=document.createElement('input');input.type='number';input.step='any';input.dataset.field=field;input.disabled=true;l.append(input);row.append(l);}
      select.addEventListener('change',()=>{const c=candidates.find(c=>c.input_id===select.value);for(const input of row.querySelectorAll('input')){input.disabled=!c;input.required=!!c;input.value=c?(c.declared_domain[input.dataset.field]??(input.dataset.field==='step'?(c.type==='int'?1:.1):c.effective_value)):'';}duplicates();});
      el('pbSlots').append(row);
    }
    el('pbGenerate').hidden=false;
    el('pbDiagnostics').textContent=JSON.stringify({bridge:result.bridge_capability,quant:result.quant_capability,diagnostics:result.proposal.diagnostics},null,2);
  }
  function showDraft(result){
    state.urls.forEach(URL.revokeObjectURL);state.urls=[];el('pbDownloads').replaceChildren();
    for(const [name,text] of [['bridge-draft.pine',result.integrated_pine],['setup-guide.txt',result.webhook_setup],['bindings.json',JSON.stringify({bindings:result.bindings,fixed_inputs:result.fixed_inputs,source_hash:result.source_hash,effective_inputs_hash:state.source?.result?.effective_inputs_hash,effective_input_review:state.source?.result?.effective_input_review,instruction_versions:result.instruction_versions},null,2)]]){
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));state.urls.push(a.href);a.download=name;a.textContent='Download '+name;const p=document.createElement('p');p.append(a);el('pbDownloads').append(p);
    }
    el('pbDiagnostics').textContent=JSON.stringify({status:result.artifact_status,bridge:result.bridge_capability,quant:result.quant_capability,diagnostics:result.diagnostics},null,2);
    const capture=document.createElement('button');capture.type='button';capture.textContent='Create staging capture URL';
    const note=document.createElement('p');note.textContent='Capture records webhook evidence only. It does not execute trades or make the draft ready.';
    el('pbDownloads').append(note,capture);
    capture.addEventListener('click',async()=>{
      const epoch=state.epoch;capture.disabled=true;
      try{
        const session=await api('/api/quant/pine-bridge/deployments/'+result.deployment_id+'/capture',{method:'POST',botId:state.bot,silent:true,body:JSON.stringify({ttl_seconds:604800})});
        if(epoch!==state.epoch)return;
        const url=document.createElement('input');url.readOnly=true;url.value=session.capture_url??session.capture_path;url.setAttribute('aria-label',session.capture_url?'Private staging capture URL':'Capture path; public staging origin is not configured');
        const resultBox=document.createElement('pre'),refresh=document.createElement('button'),close=document.createElement('button');refresh.type=close.type='button';refresh.textContent='Refresh capture evidence';close.textContent='Close capture';
        const check=async(stop=false)=>{
          try{
            const record=await api('/api/quant/pine-bridge/captures/'+session.capture_id+(stop?'/close':''),stop?{method:'POST',botId:state.bot,silent:true,body:'{}'}:undefined);
            if(epoch!==state.epoch)return;
            resultBox.textContent=JSON.stringify(record,null,2);if(stop){url.value='';refresh.disabled=close.disabled=true;}
          }catch(error){if(epoch===state.epoch)status(error.message);}
        };
        refresh.addEventListener('click',()=>check());close.addEventListener('click',()=>check(true));
        el('pbDownloads').append(url,refresh,close,resultBox);await check();
      }catch(error){if(epoch===state.epoch){status(error.message);capture.disabled=false;}}
    });
  }
  async function poll(){
    const epoch=state.epoch;
    try{
      const job=await api('/api/quant/pine-bridge/jobs/'+state.job);if(epoch!==state.epoch)return;status(job.job_status+(job.diagnostic?' — '+job.diagnostic:''));
      if(['QUEUED','RUNNING','VALIDATING','RETRY_WAIT'].includes(job.job_status)){state.timer=setTimeout(poll,2000);return;}
      setBusy(false);if(job.job_status==='SUCCEEDED'){if(job.result.integrated_pine)showDraft(job.result);else showAnalysis(job.result,job);}
    }catch(e){if(epoch!==state.epoch)return;if(e.status===401){clearPrivateState();return;}setBusy(false);status(e.message+' — refresh status with the same job ID: '+state.job);}
  }
  async function submit(operation,body){
    const epoch=state.epoch;
    const fingerprint=operation+JSON.stringify(body);
    let key=state.requests.get(fingerprint);if(!key){key=crypto.randomUUID();state.requests.set(fingerprint,key);}
    setBusy(true);status('Submitting…');
    try{const job=await api('/api/quant/pine-bridge/'+operation,{method:'POST',botId:body.bot_id,silent:true,headers:{'Idempotency-Key':key},body:JSON.stringify(body)});if(epoch!==state.epoch)return;state.job=job.job_id;clearTimeout(state.timer);await poll();}
    catch(e){if(epoch===state.epoch){setBusy(false);status(e.message);}}
  }
  el('pbAnalyze').addEventListener('submit',event=>{
    event.preventDefault();if(state.busy)return;
    try{
      const values=reviewedValues();el('pbGenerate').hidden=true;
      submit('analyze',{bot_id:el('pbBot').value,pine_source:el('pbSource').value,source_name:el('pbName').value,effective_inputs:values,input_review:{source_hash:state.inspection.source_hash,confirmed:true}});
    }catch(error){status(error.message);}
  });
  el('pbGenerate').addEventListener('submit',event=>{
    event.preventDefault();if(state.busy||!state.source)return;
    if(el('pbBot').value!==state.bot){status('Bot changed. Analyze source for the selected Bot.');return;}
    const slots=[...el('pbSlots').querySelectorAll('fieldset')].filter(row=>row.querySelector('select').value).map(row=>({slot:Number(row.querySelector('select').dataset.slot),input_id:row.querySelector('select').value,...Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.field,Number(i.value)]))}));
    submit('generate',{bot_id:state.bot,pine_import_id:state.source.id,source_version:state.source.version,selected_signals:{buy:el('pbBuy').value,exit:el('pbExit').value,timing:'bar_close'},parameter_slots:slots,bridge_options:{atr_multiplier:Number(el('pbAtr').value),rr:Number(el('pbRR').value)},market:{broker:el('pbBroker').value,symbol:el('pbSymbol').value,timeframe:el('pbTimeframe').value}});
  });
  el('pbCancel').addEventListener('click',async()=>{if(!state.job)return;try{await api('/api/quant/pine-bridge/jobs/'+state.job+'/cancel',{method:'POST',botId:el('pbBot').value,silent:true,body:'{}'});clearTimeout(state.timer);await poll();}catch(e){status(e.message);}});
})();
