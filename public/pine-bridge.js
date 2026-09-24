/* Private draft builder. Uses the existing authenticated api() and CSRF boundary. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const panel=document.createElement('details');panel.className='panel';
  panel.innerHTML=`<summary>Build Pine Bridge — draft preview</summary>
    <p>Submit an authorized Pine v5/v6 indicator. Convert strategies before uploading. Generated drafts need compilation and Paper checks.</p>
    <form id="pbAnalyze"><label>Bot<select id="pbBot" required></select></label><button id="pbLoadBots" type="button">Load my Bots</button>
    <label>Source name<input id="pbName" maxlength="120" value="My indicator" required></label>
    <label>Original indicator<textarea id="pbSource" rows="8" required spellcheck="false"></textarea></label>
    <p>Submitting sends source code to the configured AI provider. Remove credentials from source before submitting.</p>
    <button id="pbAnalyzeButton" type="submit">Analyze indicator</button></form>
    <p id="pbStatus" role="status" aria-live="polite"></p><button id="pbCancel" type="button" hidden>Cancel job</button>
    <form id="pbGenerate" hidden><div class="form-grid">
    <label>BUY variable<select id="pbBuy" required></select></label><label>Native exit variable<select id="pbExit" required></select></label>
    <label>Bridge ATR Multiplier for SL<input id="pbAtr" type="number" min="0.000001" max="1000" step="any" value="2.0" required></label>
    <label>Bridge RR<input id="pbRR" type="number" min="0.000001" max="1000" step="any" value="1.5" required></label>
    <label>Broker<select id="pbBroker"><option value="binance-global">Binance Global</option><option value="binance-th">Binance TH</option><option value="innovestx">InnovestX</option><option value="settrade">Settrade</option></select></label>
    <label>Symbol<input id="pbSymbol" value="BTCUSDT" pattern="[A-Z0-9]{3,30}" required></label>
    <label>Pine chart timeframe<input id="pbTimeframe" value="1D" required></label></div>
    <p>Select up to eight numeric inputs. Empty slots stay unused. Other inputs stay at source defaults; review effective inputs before execution.</p>
    <div id="pbSlots"></div><button id="pbGenerateButton" type="submit">Generate draft and setup guide</button></form>
    <pre id="pbDiagnostics"></pre><div id="pbDownloads"></div>`;
  host.append(panel);
  const el=id=>document.getElementById(id),state={source:null,job:null,timer:null,busy:false,requests:new Map(),urls:[],bot:null,epoch:0};
  const status=text=>{el('pbStatus').textContent=text;};
  const setBusy=value=>{state.busy=value;el('pbAnalyzeButton').disabled=value;el('pbGenerateButton').disabled=value;el('pbBot').disabled=value;el('pbCancel').hidden=!value;};
  const option=(value,label)=>{const node=document.createElement('option');node.value=value;node.textContent=label;return node;};
  function clearPrivateState(){state.epoch++;clearTimeout(state.timer);state.source=null;state.job=null;state.bot=null;state.requests.clear();state.urls.forEach(URL.revokeObjectURL);state.urls=[];el('pbSource').value='';el('pbBot').replaceChildren();el('pbGenerate').hidden=true;el('pbDownloads').replaceChildren();el('pbDiagnostics').textContent='';setBusy(false);status('');}
  document.getElementById('logout')?.addEventListener('click',clearPrivateState);
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
    for(const [name,text] of [['bridge-draft.pine',result.integrated_pine],['setup-guide.txt',result.webhook_setup],['bindings.json',JSON.stringify({bindings:result.bindings,fixed_inputs:result.fixed_inputs,source_hash:result.source_hash,instruction_versions:result.instruction_versions},null,2)]]){
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));state.urls.push(a.href);a.download=name;a.textContent='Download '+name;const p=document.createElement('p');p.append(a);el('pbDownloads').append(p);
    }
    el('pbDiagnostics').textContent=JSON.stringify({status:result.artifact_status,bridge:result.bridge_capability,quant:result.quant_capability,diagnostics:result.diagnostics},null,2);
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
  el('pbAnalyze').addEventListener('submit',event=>{event.preventDefault();if(state.busy)return;el('pbGenerate').hidden=true;submit('analyze',{bot_id:el('pbBot').value,pine_source:el('pbSource').value,source_name:el('pbName').value});});
  el('pbGenerate').addEventListener('submit',event=>{
    event.preventDefault();if(state.busy||!state.source)return;
    if(el('pbBot').value!==state.bot){status('Bot changed. Analyze source for the selected Bot.');return;}
    const slots=[...el('pbSlots').querySelectorAll('fieldset')].filter(row=>row.querySelector('select').value).map(row=>({slot:Number(row.querySelector('select').dataset.slot),input_id:row.querySelector('select').value,...Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.field,Number(i.value)]))}));
    submit('generate',{bot_id:state.bot,pine_import_id:state.source.id,source_version:state.source.version,selected_signals:{buy:el('pbBuy').value,exit:el('pbExit').value,timing:'bar_close'},parameter_slots:slots,bridge_options:{atr_multiplier:Number(el('pbAtr').value),rr:Number(el('pbRR').value)},market:{broker:el('pbBroker').value,symbol:el('pbSymbol').value,timeframe:el('pbTimeframe').value}});
  });
  el('pbCancel').addEventListener('click',async()=>{if(!state.job)return;try{await api('/api/quant/pine-bridge/jobs/'+state.job+'/cancel',{method:'POST',botId:el('pbBot').value,silent:true,body:'{}'});clearTimeout(state.timer);await poll();}catch(e){status(e.message);}});
})();
