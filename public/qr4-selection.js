/* QR-4 qualified selection (contract sections 11 and 12): the owner view of the registered selections of this account. It uses the authenticated api()
   boundary with the owner routes of /api/quant/selections only: the universe and eligibility preview (a read-only POST that carries the optional declared
   scope), register, list, detail, cancel, replay and the package state. It never sends a Bot identifier, and it has no apply, import, start-Bot, email or alert control.
   Every value is placed with textContent. The API is behind a default-off flag, so a 404 without a code is shown as an unavailable release, not as an error.
   Rules that hold in this file:
   - the label text is the server label_text, placed exactly and never composed. A Thai line beside it is a translation of the fixed template only;
   - the scope statement, the exposure sentence, the no-significance sentence and the no-profitability sentence sit in the same block as every label;
   - no metric is built unless the stored status is SELECTION_COMPLETED and the answer says metrics_visible;
   - a null metric shows an em dash, never 0; the universe, the passing list and the cards follow the order the server sends, and this file sorts nothing;
   - development scores are not on this page; the library panel shows them unordered. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const PATH='/api/quant/selections';
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  // Null, undefined and false children are skipped everywhere: append and replaceChildren would print them as text.
  const keep=child=>child!==null&&child!==undefined&&child!==false;
  const make=(tag,className,...children)=>{
    const element=document.createElement(tag);if(className)element.className=className;
    element.append(...children.filter(keep));
    return element;
  };
  const fill=(element,children)=>element.replaceChildren(...children.filter(keep));
  const label=(text,tag='span',className)=>{const element=make(tag,className);element.dataset.uiLabel=text;element.textContent=T(text);return element;};
  const utc=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC':'—';
  const short=id=>typeof id==='string'&&id?id.slice(0,8):'—';
  const dash=value=>value===null||value===undefined||value===''||(typeof value==='number'&&!Number.isFinite(value))?'—':typeof value==='object'?JSON.stringify(value):String(value);
  const errorCode=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');
  const code=text=>make('code','qrl-code',dash(text));
  const hash=value=>make('span','qrl-hash',dash(value));
  const known=(table,value)=>typeof value==='string'&&Object.hasOwn(table,value)?label(table[value]):code(value);
  // The route answers 404 without a code only when the flag is off (the router's own fallback); an absent selection answers the code NOT_FOUND.
  const isUnavailable=error=>error?.status===404&&!error?.code;
  const request=(path,options={})=>api(path,{silent:true,botId:'',...options});
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

  // Fixed texts. test/qr4-selection-ui.test.js pins each of them against the module that owns it.
  const OBJECTIVE_ID='qr4-objective-lexi-v1';
  const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
  const NO_WINNER='Qualified recommendations: none. No qualified winner.';
  const EXPOSURE='This selection used the period W. That period is now development evidence. A claim about another period needs new independent data.';
  const NO_SIGNIFICANCE='No statistical significance is claimed.';
  const NO_PROFIT='This is not a profitability claim or a forecast.';
  const HOLDOUT_NOTE='Their holdout periods differ. They are not compared here.';
  const NO_QUALIFYING='No qualifying strategy within the selected scope.';
  const NO_EVIDENCE='Evidence is not adequate to rank within the selected scope.';
  // The label text of the server is generated from these two templates (OD-S17). They are only used to put a translation beside the exact text.
  const LABEL_TEMPLATES=[[/^Best of (\d+) compared strategies within the selected scope$/,'Best of {n} compared strategies within the selected scope'],
    [/^Tied for best of (\d+) compared strategies within the selected scope$/,'Tied for best of {n} compared strategies within the selected scope']];
  const STATUSES={SELECTION_REGISTERED:'Registered',SELECTION_EVALUATING:'Evaluating',SELECTION_COMPLETED:'Completed',SELECTION_INCOMPLETE:'Incomplete',SELECTION_CANCELLED:'Cancelled'};
  const STATUS_ORDER=Object.keys(STATUSES);
  const OUTCOMES={BEST_IN_SCOPE:'One strategy ranked first within the selected scope',TIED_IN_SCOPE:'Tie for first place within the selected scope',
    NO_QUALIFYING_STRATEGY:'No qualifying strategy',INADEQUATE_EVIDENCE:'Evidence not adequate'};
  const OUTCOME_ORDER=Object.keys(OUTCOMES);
  const OUTCOME_TEXT={NO_QUALIFYING_STRATEGY:NO_QUALIFYING,INADEQUATE_EVIDENCE:NO_EVIDENCE};
  const PARTICIPANT_RESULTS={PASSED:'Passed',EVIDENCE_INADEQUATE:'Evidence not adequate',NOT_QUALIFYING_IN_SCOPE:'Did not qualify within the scope'};
  const DECIDED_BY={PRIMARY:'Net return decided',SECONDARY:'Drawdown decided inside the tie tolerance',TIE:'Tied inside both tolerances'};
  const OVERLAYS={WINNER_NOT_READY:'A recommended package is not ready now. The label and the recommended values are hidden.',
    SELECTION_REPLAY_MISMATCH:'A replay did not reproduce the stored outcome. The label and the recommended values are hidden.',
    RULESET_SUPERSEDED:'A newer ruleset exists. This selection keeps the ruleset it was registered with.'};
  const ELIGIBILITY={PARTICIPANT:'Participant',QUALIFIED_STALE:'Qualified, package not fresh',EXCLUDED:'Excluded'};
  const ELIGIBILITY_TONE={PARTICIPANT:'ok',QUALIFIED_STALE:'warn',EXCLUDED:'bad'};
  const CHECK_STATES={PASS:'Pass',FAIL:'Fail',NOT_REACHED:'Not reached'};
  const CHECKS=['E1','E2','E3','E4','E5','E6'];
  const WINDOW_KINDS={PROSPECTIVE:'Prospective: starts after registration',FORWARD_PAST:'Forward past: ended before registration'};
  // Every code the owner can meet: the eligibility codes, the filter codes, the ending codes and the refusal codes of the contract (section 9 and 10) and of the route.
  const CODE_TEXT={
    NOT_FOUND:'Selection or run not found for this account.',CONFIRMATION_REQUIRED:'Confirm the request before sending it.',INVALID_FIELDS:'The request has a field that is not allowed or not readable.',
    QR4_NO_ELIGIBLE_PARTICIPANT:'No run of this account is eligible to take part.',QR4_PARTICIPANT_NOT_READY:'The package of the run is not ready.',
    QR4_PARTICIPANT_NOT_QUALIFIED:'The run is not qualified.',QR4_VALIDATION_BINDING_MISMATCH:'The validation record does not match the package.',
    QR4_FIXTURE_PARTICIPANT:'A fixture package cannot take part in a customer selection.',QR4_MULTI_PINE_PARTICIPANT:'A multi-Pine package cannot take part.',
    QR4_DEVELOPMENT_SCORE_NOT_RANKABLE:'Development scores cannot be ranked.',QR4_OWN_HOLDOUT_NOT_COMPARABLE:'The own holdout results cannot be compared.',
    QR4_ACTUAL_HISTORY_NOT_RANKABLE:'Actual Paper history cannot be ranked.',QR4_MIXED_BASIS:'Simulated and actual results cannot be mixed.',
    QR4_TOO_FEW_PARTICIPANTS:'Fewer than 2 eligible participants.',QR4_TOO_MANY_PARTICIPANTS:'More than 4 eligible participants.',QR4_DUPLICATE_PARTICIPANT:'A run or package appears twice.',
    QR4_UNIVERSE_TOO_LARGE:'The universe is larger than the limit of this release.',QR4_SCOPE_INCOMPATIBLE:'The scope of the run differs from the declared scope.',
    QR4_RULES_VERSION_MIXED:'The participants use different validation rules.',BI_MARKET_SCOPE_INVALID:'The market is not BINANCE:BTCUSDT Spot 1m.',
    QR4_OBJECTIVE_UNKNOWN:'The objective is not available.',QR4_CUSTOM_WEIGHTS_REFUSED:'Weights and custom formulas are not allowed.',QR4_FILTER_INVALID:'A filter value is not allowed.',
    QR4_REGISTRATION_IMMUTABLE:'A registered selection cannot be changed.',QR4_WINDOW_INVALID:'The window is not valid.',QR4_WINDOW_OVER_CAPACITY:'The window is larger than the capacity of this release.',
    QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA:'The window overlaps data of a participant.',QR4_WINDOW_OVERLAPS_SEARCHED_DATA:'The window overlaps data that an earlier search used.',
    QR4_WINDOW_EXPOSED:'The window was already used by an earlier selection or comparison.',QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY:'The window starts before the registered holdout boundary.',
    QR4_QR3_CONTEXT_UNAVAILABLE:'The valuation basis is not confirmed on this release.',QR4_EVALUATION_MODE_UNAVAILABLE:'Selection evaluation is not available on this release.',
    QR4_EPISODE_GATE_UNAVAILABLE:'The episode gate is not available on this release.',QR4_EXPOSURE_REGISTRY_UNAVAILABLE:'The exposure register cannot be read now.',
    QR4_EVALUATION_SEARCH_REFUSED:'An evaluation has no search dimension.',QR4_SELECTION_EXISTS:'This registration already exists.',
    QR4_APPLY_REFUSED:'A selection cannot apply, import, start or send anything.',QR4_TRANSITION_INVALID:'This step is not allowed in the current status.',
    QR4_WINDOW_DATA_UNAVAILABLE:'The data of the window is not available.',QR4_WINDOW_DATA_GAP:'The data of the window has a gap.',BI_DATASET_HASH_MISMATCH:'The dataset does not match the frozen window.',
    QR4_EVALUATION_FAILED:'An evaluation did not finish.',QR4_METRIC_MISSING:'An evaluation result misses a metric.',INTEGRITY_CHECK_FAILED:'The integrity check failed.',
    QR4_ENGINE_MISMATCH:'An evaluation used a different engine.',QR4_BENCHMARK_UNAVAILABLE:'The Buy & Hold benchmark is not available.',
    QR4_PARTICIPANT_STALE:'A participant package is no longer fresh.',QR4_ADMISSION_REFUSED:'An evaluation was not admitted before the deadline.',
    FILTER_DRAWDOWN_LIMIT:'Drawdown above the limit',FILTER_EPISODE_FLOOR:'Too few completed episodes',FILTER_COST_STRESS:'Negative under the cost stress',
    FILTER_NET_RETURN_POSITIVE:'Net return not above zero',FILTER_BEATS_BUY_AND_HOLD:'Did not beat Buy & Hold',
    QR4_SCHEMA_ABSENT:'The selection tables are not installed on this release.',QR4_UNAVAILABLE:'Selections are not available right now.',
    RETRY_TRANSACTION:'The database was busy. Try again.',METHOD_NOT_ALLOWED:'This request is not allowed.'};
  const METRICS=[['net_return_percent','Net return (%)'],['benchmark_net_return_percent','Buy & Hold return (%)'],['max_drawdown_percent','Maximum drawdown (%)'],['episodes','Completed episodes'],
    ['closed_trades','Closed trades'],['rejected_intents','Rejected intents'],['fees','Total fees'],['slippage','Total modeled slippage'],['exposure_percent','Time in market (%)'],
    ['cost_stress_net_return_percent','Net return under the cost stress (%)'],['evaluation_bars','Evaluation bars']];

  const state={availability:'unknown',probeSeq:0,list:null,listError:null,listBusy:false,previewSeq:0,preview:null,previewError:null,previewBusy:false,scope:null,
    viewSeq:0,view:null,viewId:null,viewError:null,busy:false,confirming:null,message:null,packages:{},registerMessage:null};

  // Static markup. Every label comes from the i18n pairs; API data is only ever placed with textContent.
  const panel=make('details','panel qrl qr4');panel.id='qr4Panel';
  const banner=label('Qualified selection is simulated research on historical data. Applying settings or starting a Bot is a separate owner action.','p','qrl-banner qr4-banner');banner.setAttribute('role','note');
  const status=make('p','qrl-status qr4-status');status.setAttribute('role','status');
  const refresh=label('Check again','button','ghost qrl-refresh qr4-refresh');refresh.type='button';refresh.hidden=true;
  const tools=make('div','qr4-tools');tools.hidden=true;
  const previewBox=make('div','qr4-preview-box');
  const registerBox=make('div','qr4-register-box');
  const listBox=make('div','qr4-list-box');
  const viewBox=make('section','qrl-view qr4-view');viewBox.hidden=true;

  const note=text=>make('p','qrl-note',label(text));
  const row=(key,...value)=>make('div','qrl-ev',label(key,'span','qrl-k'),make('span','qrl-v',...value));
  const chip=(text,tone)=>label(text,'span','qrl-chip qrl-'+tone);
  const badge=(table,value,tone)=>typeof value==='string'&&Object.hasOwn(table,value)?chip(table[value],tone):make('span','qrl-chip qrl-muted',code(value));
  const section=(title,open,className,...children)=>{const element=make('details','qrl-sec '+className,make('summary','qrl-sec-title',label(title,'span')),...children);element.open=open;return element;};
  function table(heads,rows){
    const head=make('tr',null,...heads.map(text=>typeof text==='string'?label(text,'th'):make('th',null,text))),body=rows.map(cells=>make('tr',null,...cells.map(cell=>make('td',null,cell))));
    return make('div','qrl-scroll',make('table','qrl-table',make('thead',null,head),make('tbody',null,...body)));
  }
  const pairs=value=>isObject(value)?Object.entries(value).map(([key,item])=>key+'='+dash(item)).join(', ')||'—':'—';
  // A code with its translated meaning when the page knows it; an unknown code is shown as it is, never with an invented meaning.
  const coded=value=>typeof value==='string'&&Object.hasOwn(CODE_TEXT,value)?make('span',null,label(CODE_TEXT[value]),' (',code(value),')'):code(value);
  const refusalLine=error=>make('p','qrl-error qr4-error',label('The request was refused.'),' ',coded(errorCode(error)));
  // A fixed sentence the server sends equal to the known one is translated; one that differs is shown exactly as sent; one that is missing is shown from the known text.
  const fixed=(text,known_,className)=>typeof text==='string'&&text!==known_?make('p',(className?className+' ':'')+'no-i18n',text):label(known_,'p',className);

  /* ---- decimals: the page sends the canonical form of D(x).toFixed() (no exponent, no leading or trailing zero) ---- */
  const DECIMAL_TEXT=/^(-?)(\d+)(?:\.(\d+))?$/;
  function canonicalDecimal(value){
    if(typeof value!=='string')return null;
    const match=DECIMAL_TEXT.exec(value.trim());if(!match)return null;
    const whole=match[2].replace(/^0+(?=\d)/,''),fraction=(match[3]||'').replace(/0+$/,'');
    const text=fraction?whole+'.'+fraction:whole;
    return text==='0'?'0':(match[1]||'')+text;
  }
  /** The scope body of a member scope: the four fields eligibility compares, with every decimal in canonical form. Null when a field cannot be read. */
  function scopeBody(scope){
    if(!isObject(scope))return null;
    const model=scope.data_model,cost=scope.cost_model,capital=scope.capital,policy=scope.policy;
    if(!isObject(model)||!isObject(cost)||!isObject(capital)||!isObject(policy))return null;
    const tick=canonicalDecimal(model.price_tick),step=canonicalDecimal(model.quantity_step),fee=canonicalDecimal(cost.fee_bps),slip=canonicalDecimal(cost.slippage_bps),
      risk=canonicalDecimal(cost.risk_percent),equity=canonicalDecimal(capital.equity),cash=canonicalDecimal(capital.cash);
    if([tick,step,fee,slip,risk,equity,cash].includes(null)||typeof model.data_profile!=='string'||typeof cost.version!=='string'||typeof policy.policy_version!=='string'||typeof policy.policy_hash!=='string')return null;
    return {market:{...MARKET},data_model:{data_profile:model.data_profile,price_tick:tick,quantity_step:step},
      cost_model:{version:cost.version,fee_bps:fee,slippage_bps:slip,risk_percent:risk},capital:{equity,cash},policy:{policy_version:policy.policy_version,policy_hash:policy.policy_hash}};
  }

  /* ---- universe and eligibility preview (12.1) ---- */
  function memberCard(member,position){
    const scope=isObject(member.scope)?member.scope:{};
    const usable=scopeBody(scope)!==null;
    const use=label('Use this scope','button','ghost qr4-use-scope');use.type='button';use.dataset.run=member.run_id;use.disabled=!usable||state.previewBusy;
    const failures=Array.isArray(member.failures)?member.failures:[];
    const article=make('article','qrl-card qr4-member',
      make('div','qrl-card-head',make('span','qrl-id',String(position)),hash(short(member.run_id)),badge(ELIGIBILITY,member.status,ELIGIBILITY_TONE[member.status]??'muted')),
      row('Run ID',hash(member.run_id)),row('Created (UTC)',utc(member.created_at_ms)),row('Run status',code(member.run_status)),
      row('Library class',code(member.library_class)),row('Qualification',code(member.qualification_label)),row('Package status',code(member.package_status)),
      row('Checks',make('span','qrl-codes',...CHECKS.map(name=>make('span','qr4-check',name+' ',known(CHECK_STATES,member.checks?.[name]))))),
      row('First failing code',member.code?coded(member.code):'—'),
      failures.length>1?row('All failing codes',make('span','qrl-codes',...failures.map(item=>make('span',null,item.check+' ',code(item.code),item.detail?' '+item.detail:'')))):null,
      Array.isArray(member.mismatched_fields)&&member.mismatched_fields.length?row('Scope fields that differ',make('span','qrl-codes',...member.mismatched_fields.map(name=>code(name)))):null,
      row('Data model',pairs(scope.data_model)),row('Cost model',pairs(scope.cost_model)),row('Capital',pairs(scope.capital)),row('Policy',pairs(scope.policy)),
      make('div','qrl-card-actions',use));
    article.dataset.run=member.run_id;
    return article;
  }
  function scopeSummary(){
    if(state.scope===null)return note('No scope is chosen. Choose the scope of one run below. The scope check is then run for every run.');
    const clear=label('Clear scope','button','ghost qr4-clear-scope');clear.type='button';clear.disabled=state.previewBusy;
    return make('div','qrl-block qr4-declared',label('Declared scope','h4','qrl-sub'),row('Data model',pairs(state.scope.data_model)),row('Cost model',pairs(state.scope.cost_model)),
      row('Capital',pairs(state.scope.capital)),row('Policy',pairs(state.scope.policy)),make('div','qrl-card-actions',clear));
  }
  function renderPreview(){
    const run=label('Preview universe','button','primary qr4-preview-run');run.type='button';run.disabled=state.previewBusy;
    const nodes=[note('Every finished research run of this account on BINANCE:BTCUSDT Spot 1m is listed in creation order. Nothing is ranked here.'),scopeSummary(),make('div','qrl-card-actions',run)];
    const data=state.preview;
    if(state.previewError)nodes.push(state.previewError);
    else if(data){
      const members=Array.isArray(data.members)?data.members:[];
      nodes.push(label(HOLDOUT_NOTE,'p','qrl-note qr4-holdout-note'),
        row('Runs in the universe',dash(data.universe_count)),row('Participants',dash(data.participant_count)),row('Qualified, package not fresh',dash(data.stale_count)),row('Excluded',dash(data.excluded_count)),
        row('Participants needed',tpl('{min} to {max}',{min:dash(data.min_participants),max:dash(data.max_participants)})),
        data.scope_declared===true?null:note('The scope check is not run until a scope is chosen.'),
        data.registration_wired===true?null:note('Registration is not available on this release. This preview is for reading only.'),
        members.length?make('div','qrl-list qr4-members',...members.map((member,at)=>memberCard(member,at+1))):note('No finished research run of this account is in the universe.'));
    }
    fill(previewBox,nodes);
  }
  async function runPreview(){
    if(state.previewBusy)return;
    const body={};
    if(state.scope!==null){
      const scope=scopeBody(state.scope);
      if(scope===null){state.previewError=make('p','qrl-error',label('The chosen scope cannot be sent.'));renderPreview();return;}
      body.scope=scope;
    }
    const seq=++state.previewSeq;state.previewBusy=true;state.previewError=null;renderPreview();
    try{
      const data=await request(PATH+'/preview',{method:'POST',body:JSON.stringify(body)});
      if(seq!==state.previewSeq)return;
      if(!isObject(data)||data.ok!==true||!Array.isArray(data.members))throw Object.assign(new Error('unreadable'),{code:'ANSWER_UNREADABLE'});
      state.preview=data;
    }catch(error){
      if(seq!==state.previewSeq)return;
      state.preview=null;
      if(isUnavailable(error)){state.availability='unavailable';state.previewBusy=false;redraw();return;}
      state.previewError=refusalLine(error);
    }
    state.previewBusy=false;renderPreview();renderReview();
  }
  function useScope(runId){
    const member=(state.preview?.members||[]).find(item=>item.run_id===runId);
    if(!member||scopeBody(member.scope)===null)return;
    state.scope=JSON.parse(JSON.stringify(member.scope));
    renderRegister();runPreview();
  }

  /* ---- register (12.2): the confirm token shows W, objective, filters, tolerances, universe, participants, compute budget and the exposure warning ---- */
  const input=(name,value='',type='text')=>{const element=make('input','qr4-input');element.type=type;element.name=name;element.value=value;element.autocomplete='off';element.spellcheck=false;return element;};
  const field=(text,control,className)=>make('label','qr4-field'+(className?' '+className:''),label(text),control);
  const kindSelect=make('select','qr4-input');kindSelect.name='window_kind';
  for(const [value,text] of Object.entries(WINDOW_KINDS)){const option=make('option');option.value=value;option.dataset.uiLabel=text;option.textContent=T(text);kindSelect.append(option);}
  const startInput=input('window_begin'),endInput=input('window_end'),warmInput=input('warmup_bars','0');
  const drawdownInput=input('drawdown_limit_percent','20'),floorInput=input('episode_floor','5'),beatsBox=make('input','qrl-pick qr4-beats');beatsBox.type='checkbox';beatsBox.name='beats_buy_and_hold';
  const confirmBox=make('input','qrl-pick qr4-confirm');confirmBox.type='checkbox';confirmBox.name='confirmed';
  const registerButton=label('Register selection','button','primary qr4-register-button');registerButton.type='submit';
  const registerNote=make('p','qrl-note qr4-register-message');registerNote.setAttribute('role','status');
  const reviewBox=make('div','qr4-review');
  const registerForm=make('form','qr4-create');registerForm.noValidate=true;
  const scopeLine=make('div','qr4-scope-line');
  fill(registerForm,[note('Registration freezes the scope, the window W, the objective and the filters. It starts no evaluation by itself.'),scopeLine,
    field('Window kind',kindSelect),field('Window start (UTC, YYYY-MM-DD HH:MM)',startInput),field('Window end (UTC, YYYY-MM-DD HH:MM)',endInput),field('Warm-up bars',warmInput),
    make('div','qrl-ev',label('Objective','span','qrl-k'),make('span','qrl-v',code(OBJECTIVE_ID))),
    note('Net return decides first. Drawdown decides inside the tie tolerance. There are no weights and no custom formula.'),
    field('Maximum drawdown limit (%)',drawdownInput),field('Minimum completed episodes',floorInput),
    make('label','qrl-pick-label',beatsBox,label('Also require a net return above Buy & Hold')),
    reviewBox,
    make('label','qrl-pick-label',confirmBox,label('I confirm the registration cannot change after it is created and the period W becomes development evidence.')),
    make('div','qrl-card-actions',registerButton),registerNote]);
  function renderRegister(){
    fill(scopeLine,[state.scope===null?note('Choose a scope in the universe preview first.'):make('div','qrl-block',label('Declared scope','h4','qrl-sub'),row('Data model',pairs(state.scope.data_model)),
      row('Cost model',pairs(state.scope.cost_model)),row('Capital',pairs(state.scope.capital)),row('Policy',pairs(state.scope.policy)))]);
    renderReview();
    registerButton.disabled=state.busy;
  }
  const CUSTOM_TIME=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
  const parseTime=text=>{
    const match=CUSTOM_TIME.exec(text.trim());if(!match)return null;
    const [year,month,day,hour,minute]=match.slice(1).map(Number),ms=Date.UTC(year,month-1,day,hour,minute);
    const date=new Date(ms);
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day&&date.getUTCHours()===hour&&date.getUTCMinutes()===minute?ms:null;
  };
  const DECIMAL=/^\d+(?:\.\d+)?$/,INTEGER=/^\d+$/;
  /** The register body from the form, or {error:'text'} naming the first problem. Nothing is sent when there is one. */
  function buildBody(){
    if(state.scope===null)return {error:'Choose a scope in the universe preview first.'};
    const scope=scopeBody(state.scope);
    if(scope===null)return {error:'The chosen scope cannot be sent.'};
    const start=parseTime(startInput.value),end=parseTime(endInput.value);
    if(start===null||end===null)return {error:'Enter the window start and end as YYYY-MM-DD HH:MM in UTC.'};
    if(end<=start)return {error:'The window end must be after the window start.'};
    if(!INTEGER.test(warmInput.value.trim()))return {error:'Enter the warm-up bars as a whole number.'};
    const limit=canonicalDecimal(drawdownInput.value);
    if(!DECIMAL.test(drawdownInput.value.trim())||limit===null||!INTEGER.test(floorInput.value.trim()))return {error:'Enter the drawdown limit and the minimum episodes as numbers.'};
    if(!confirmBox.checked)return {error:'Confirm the registration before you create it.'};
    return {body:{confirmed:true,scope,window:{kind:kindSelect.value,start_ms:start,end_ms:end,warmup_bars:Number(warmInput.value.trim())},objective:{id:OBJECTIVE_ID},
      filters:{drawdown_limit_percent:limit,episode_floor:Number(floorInput.value.trim()),beats_buy_and_hold:beatsBox.checked}}};
  }
  function renderReview(){
    const start=parseTime(startInput.value),end=parseTime(endInput.value),warm=INTEGER.test(warmInput.value.trim())?Number(warmInput.value.trim()):null;
    const valid=start!==null&&end!==null&&end>start;
    const evaluation=valid?(end-start)/60000:null,total=evaluation!==null&&warm!==null?evaluation+warm:null;
    const data=state.preview;
    const participants=data&&data.scope_declared===true?data.participant_count:null;
    fill(reviewBox,[make('div','qrl-block qr4-review-block',label('Review before you register','h4','qrl-sub'),
      row('Window W (UTC)',valid?utc(start)+' → '+utc(end):'—'),row('Evaluation bars',dash(evaluation)),row('Warm-up bars',dash(warm)),row('Total bars',dash(total)),
      row('Objective',code(OBJECTIVE_ID)),row('Filters',pairs({drawdown_limit_percent:drawdownInput.value.trim(),episode_floor:floorInput.value.trim(),beats_buy_and_hold:beatsBox.checked})),
      row('Tie tolerances',label('Set by the server. They are not part of the request.')),
      row('Universe',dash(data?.universe_count)),row('Participants',dash(participants)),
      row('Compute budget',participants!==null&&total!==null?tpl('{n} evaluation runs of {bars} bars',{n:participants,bars:total}):'—'),
      label('Registering uses the period W. It becomes development evidence as soon as the first evaluation starts. A claim about another period needs new independent data.','p','qrl-note qr4-exposure-warning'))]);
  }
  async function register(){
    const built=buildBody();
    if(built.error){fill(registerNote,[make('span','qrl-error',label(built.error))]);return;}
    state.busy=true;registerNote.replaceChildren();renderStatus();
    try{
      const answer=await request(PATH,{method:'POST',body:JSON.stringify(built.body)});
      if(!isObject(answer)||typeof answer.selection_id!=='string')throw Object.assign(new Error('unreadable'),{code:'ANSWER_UNREADABLE'});
      state.busy=false;
      fill(registerNote,[label(answer.existing===true?'This registration already exists.':'Selection registered. No evaluation has started.')]);
      confirmBox.checked=false;
      await loadList();
      await open(answer.selection_id);
    }catch(error){
      state.busy=false;
      if(isUnavailable(error)){state.availability='unavailable';redraw();return;}
      fill(registerNote,[refusalLine(error)]);renderStatus();
    }
  }

  /* ---- the list ---- */
  function renderList(){
    const refreshButton=label('Refresh list','button','ghost qr4-refresh-list');refreshButton.type='button';refreshButton.disabled=state.listBusy;
    const nodes=[];
    if(state.listError)nodes.push(state.listError);
    else if(state.list===null)nodes.push(note('Checking…'));
    else{
      const data=state.list,list=Array.isArray(data.selections)?data.selections:[],counts=isObject(data.counts)?data.counts:{};
      nodes.push(row('Selections',dash(data.total)),
        row('Counts by outcome',make('span','qrl-codes',...OUTCOME_ORDER.map(name=>make('span','qr4-count',label(OUTCOMES[name]),': '+dash(counts.by_outcome?.[name]))))),
        row('Counts by status',make('span','qrl-codes',...STATUS_ORDER.map(name=>make('span','qr4-count',label(STATUSES[name]),': '+dash(counts.by_status?.[name]))))),
        data.truncated===true?note('Only the first selections are listed.'):null,
        list.length?make('div','qrl-list qr4-selections',...list.map(selectionCard)):note('No selection has been registered yet.'));
    }
    nodes.push(make('div','qrl-card-actions',refreshButton));
    fill(listBox,nodes);
  }
  function selectionCard(item){
    const view=label('View selection','button','ghost qr4-view-button');view.type='button';view.dataset.id=item.selection_id;view.disabled=state.busy;
    const w=isObject(item.window)?item.window:{};
    const article=make('article','qrl-card qr4-selection',
      make('div','qrl-card-head',hash(short(item.selection_id)),badge(STATUSES,item.status,'info'),item.outcome?badge(OUTCOMES,item.outcome,'ok'):null,item.fixture===true?chip('Internal view','warn'):null),
      row('Selection ID',hash(item.selection_id)),item.code?row('Reason',coded(item.code)):null,
      row('Window (UTC)',utc(w.start_ms)+' → '+utc(w.end_ms)),row('Evaluation bars',dash(w.evaluation_bars)),row('Participants',dash(item.participant_count)),row('Registered at (UTC)',utc(item.registered_at_ms)),
      make('div','qrl-card-actions',view));
    article.dataset.selection=item.selection_id;
    return article;
  }
  async function loadList(){
    const seq=++state.probeSeq;state.listBusy=true;
    if(state.availability==='unknown')state.availability='checking';
    renderStatus();renderList();
    try{
      const data=await request(PATH);
      if(seq!==state.probeSeq)return;
      if(!isObject(data)||data.ok!==true||!Array.isArray(data.selections))throw Object.assign(new Error('unreadable'),{code:'ANSWER_UNREADABLE'});
      state.availability='available';state.list=data;state.listError=null;
    }catch(error){
      if(seq!==state.probeSeq)return;
      const reason=errorCode(error);
      if(isUnavailable(error))state.availability='unavailable';
      else if(reason==='QR4_SCHEMA_ABSENT')state.availability='schema';
      else{state.availability=state.list===null?'error':'available';state.probeCode=reason;state.listError=refusalLine(error);}
    }
    state.listBusy=false;redraw();
  }

  /* ---- the detail ---- */
  /** The scope statement of 11.2 item 4: the server statement of the label when there is one, else the same fields from the registration. */
  function statementOf(registration,label_){
    if(isObject(label_)&&isObject(label_.scope_statement))return label_.scope_statement;
    const r=registration,w=isObject(r.window)?r.window:{},scope=isObject(r.scope)?r.scope:{},objective=isObject(r.objective)?r.objective:{},market=isObject(scope.market)?scope.market:null;
    return {asset:market?market.broker+':'+market.symbol+' '+market.timeframe+'m':null,
      window:{kind:w.kind??null,start_utc:Number.isFinite(w.start_ms)?new Date(w.start_ms).toISOString():null,end_utc:Number.isFinite(w.end_ms)?new Date(w.end_ms).toISOString():null,
        evaluation_bars:w.evaluation_bars??null,warmup_bars:w.warmup_bars??null,total_bars:w.total_bars??null},
      risk_profile:isObject(scope.policy)?scope.policy.policy_version:null,cost_model:scope.cost_model??null,capital:scope.capital??null,
      evaluation_basis:{valuation:isObject(scope.valuation)?scope.valuation.valuation:null,benchmark:isObject(scope.valuation)?scope.valuation.benchmark:null,evaluation_mode:'QR4_SELECTION_EVAL'},
      coverage:{participants_compared:r.participant_count??null,universe_runs:Array.isArray(r.universe)?r.universe.length:null,evaluation_bars_each:w.evaluation_bars??null},
      objective_id:objective.id??null,filters:r.filters??null,
      tie_tolerances:{return_pp:objective.tie_tolerance_return_pp??null,drawdown_pp:objective.tie_tolerance_drawdown_pp??null},
      participant_count:r.participant_count??null,universe:Array.isArray(r.universe)?r.universe.map(item=>({run_id:item.run_id,export_id:item.export_id,status:item.status,code:item.code})):[],
      prior_selection_count:r.prior_selection_count??null};
  }
  function scopeSection(statement,open=true){
    const s=isObject(statement)?statement:{},w=isObject(s.window)?s.window:{},basis=isObject(s.evaluation_basis)?s.evaluation_basis:{},coverage=isObject(s.coverage)?s.coverage:{},
      tolerances=isObject(s.tie_tolerances)?s.tie_tolerances:{},universe=Array.isArray(s.universe)?s.universe:[];
    return section('Scope statement',open,'qr4-scope',
      row('Asset',dash(s.asset)),row('Window (UTC)',dash(w.start_utc)+' → '+dash(w.end_utc)),row('Window kind',known(WINDOW_KINDS,w.kind)),
      row('Evaluation bars',dash(w.evaluation_bars)),row('Warm-up bars',dash(w.warmup_bars)),row('Total bars',dash(w.total_bars)),
      row('Risk profile',dash(s.risk_profile)),row('Cost model',pairs(s.cost_model)),row('Capital',pairs(s.capital)),
      row('Evaluation basis',code(basis.valuation),' ',code(basis.benchmark),' ',code(basis.evaluation_mode)),
      row('Coverage',tpl('{p} participants of {u} runs, {b} evaluation bars each',{p:dash(coverage.participants_compared),u:dash(coverage.universe_runs),b:dash(coverage.evaluation_bars_each)})),
      row('Objective',code(s.objective_id)),row('Filters',pairs(s.filters)),
      row('Tie tolerance: net return (percentage points)',dash(tolerances.return_pp)),row('Tie tolerance: drawdown (percentage points)',dash(tolerances.drawdown_pp)),
      row('Participants',dash(s.participant_count)),row('Selections before this one',dash(s.prior_selection_count)),
      universe.length?table(['Run ID','Status','First failing code'],universe.map(item=>[hash(short(item.run_id)),known(ELIGIBILITY,item.status),item.code?coded(item.code):'—'])):note('The universe is not available.'));
  }
  function labelBlock(outcomeLabel,registration){
    const text=outcomeLabel.label_text;
    const translated=LABEL_TEMPLATES.map(([pattern,template])=>{const match=pattern.exec(text);return match?tpl(template,{n:match[1]}):null;}).find(Boolean)??null;
    return make('div','qrl-block qr4-label-block',
      // The exact text of the server. no-i18n keeps the language switch from touching it.
      make('p','qrl-winner qr4-label-text no-i18n',text),
      translated!==null&&translated!==text?make('p','qrl-note qr4-label-translation',translated):null,
      scopeSection(statementOf(registration,outcomeLabel)),
      fixed(outcomeLabel.exposure_sentence,EXPOSURE,'qrl-note qr4-exposure'),
      fixed(outcomeLabel.no_significance_sentence,NO_SIGNIFICANCE,'qrl-note qr4-no-significance'),
      fixed(outcomeLabel.no_profitability_sentence,NO_PROFIT,'qrl-note qr4-no-profit'));
  }
  const valueRow=(values,key,text)=>{
    const value=isObject(values)?values[key]:null;
    const element=make('div','qrl-ev qr4-metric',label(text,'span','qrl-k'),make('span','qrl-v',value===null||value===undefined?make('span','qr4-null','—'):dash(value)));
    element.dataset.metric=key;
    if(value===null||value===undefined)element.dataset.null='true';
    return element;
  };
  function packageControl(body,item){
    if(body.hide_package_links===true)return null;
    const result=state.packages[item.export_id];
    const check=label('Check package state','button','ghost qr4-check-package');check.type='button';check.dataset.export=item.export_id;check.disabled=state.busy;
    return make('span','qr4-package',check,' ',result===undefined?null:result.ok?chip('Package is ready','ok'):make('span',null,chip('Package is not ready','warn'),' ',coded(result.code)));
  }
  function passingList(body,outcome){
    const ranking=Array.isArray(outcome.ranking)?outcome.ranking:[];
    if(!ranking.length)return null;
    return section('Participants that passed',true,'qr4-passing',
      body.hide_recommended_values===true?note('The recommended values are hidden while an overlay applies.'):null,
      table(['Rank','Participant','Run ID','Net return (%)','Maximum drawdown (%)','Decided by','Package'],
        ranking.map(item=>[dash(item.rank),hash(short(item.export_id)),hash(short(item.run_id)),dash(item.net_return_percent),dash(item.max_drawdown_percent),known(DECIDED_BY,item.decided_by),packageControl(body,item)||'—'])),
      outcome.passed_note?make('p','qrl-note no-i18n',outcome.passed_note):null);
  }
  function notPassedList(outcome){
    const list=Array.isArray(outcome.not_passed)?outcome.not_passed:[];
    return section('Participants that did not pass',true,'qr4-not-passed',
      list.length?table(['Participant','Run ID','Result','Filter codes'],list.map(item=>[hash(short(item.export_id)),hash(short(item.run_id)),known(PARTICIPANT_RESULTS,item.result),
        Array.isArray(item.filter_codes)&&item.filter_codes.length?make('span','qrl-codes',...item.filter_codes.map(name=>coded(name))):'—'])):note('Every participant passed the filters.'));
  }
  function valuesList(body,outcome){
    const evaluations=Array.isArray(outcome.evaluations)?outcome.evaluations:[];
    return section('Values of each participant on the window W',true,'qr4-values',
      note('Every participant ran the same fixed evaluation on the same window. The cards follow the order of the participant IDs.'),
      body.hide_recommended_values===true?note('The recommended values are hidden while an overlay applies.'):null,
      make('div','qrl-list',...evaluations.map(item=>{
        const flag=item.exact_replay_disabled;
        const article=make('article','qrl-card qr4-evaluation',
          make('div','qrl-card-head',hash(short(item.export_id)),badge(PARTICIPANT_RESULTS,item.result,item.result==='PASSED'?'ok':'warn')),
          row('Participant',hash(item.export_id)),row('Run ID',hash(item.run_id)),row('Evaluation run ID',hash(item.evaluation_run_id)),row('Result hash',hash(item.result_hash)),
          ...METRICS.map(([key,text])=>valueRow(item.values,key,text)),
          row('Exact replay disabled',flag===true?label('Yes'):flag===false?label('No'):'—'));
        article.dataset.participant=item.export_id;
        return article;
      })));
  }
  function hashesSection(body,outcome){
    return section('Hashes',false,'qr4-hashes',row('Registration hash',hash(body.registration?.registration_hash)),row('Outcome hash',hash(outcome?.outcome_hash)),
      row('Window dataset hash',hash(outcome?.window_dataset_hash)),row('Exact replay disabled',body.exact_replay_disabled===true?label('Yes'):body.exact_replay_disabled===false?label('No'):'—'));
  }
  function registrationSection(body){
    const r=isObject(body.registration)?body.registration:{},participants=Array.isArray(r.participants)?r.participants:[];
    return section('Registration',body.status!=='SELECTION_COMPLETED','qr4-registration',
      row('Registered at (UTC)',utc(r.registered_at_ms)),row('Window frozen at (UTC)',utc(r.frozen_at_ms)),row('Admission deadline (UTC)',utc(r.admission_deadline_ms)),
      row('Registration hash',hash(r.registration_hash)),row('Selections before this one',dash(r.prior_selection_count)),
      participants.length?table(['Participant','Run ID','Package hash'],participants.map(item=>[hash(short(item.export_id)),hash(short(item.run_id)),hash(short(item.package_hash))])):note('No participant is recorded.'));
  }
  function timeline(body){
    return section('Status history',false,'qr4-history',table(['Sequence','Status','Reason','Time'],(Array.isArray(body.events)?body.events:[]).map(item=>[dash(item.seq),known(STATUSES,item.status),item.code?coded(item.code):'—',utc(item.at_ms)])));
  }
  function qr2Link(){
    const open=label('Open actual Paper history','button','ghost qr4-qr2-link');open.type='button';
    return make('div','qrl-block qr4-qr2',label('Actual Paper history','h4','qrl-sub'),
      note('The actual Paper history of a Bot is on the Overview page. It is actual history, never ranked and never compared on this page.'),make('div','qrl-card-actions',open));
  }
  function actions(body){
    const cancellable=body.status==='SELECTION_REGISTERED'||body.status==='SELECTION_EVALUATING',completed=body.status==='SELECTION_COMPLETED';
    const nodes=[];
    const ask=(kind,askText,confirmText,question)=>{
      if(state.confirming===kind){
        const yes=label(confirmText,'button','ghost qr4-confirm-yes');yes.type='button';yes.dataset.action=kind;yes.disabled=state.busy;
        const no=label('Keep','button','ghost qr4-confirm-no');no.type='button';
        nodes.push(make('div','qr4-confirm-row',note(question),yes,no));
      }else{
        const openButton=label(askText,'button','ghost qr4-ask');openButton.type='button';openButton.dataset.ask=kind;openButton.disabled=state.busy;nodes.push(openButton);
      }
    };
    if(cancellable)ask('cancel','Cancel selection','Confirm cancel selection','Cancel this selection? The exposure records stay.');
    if(completed)ask('replay','Replay outcome','Confirm replay','Recompute the ranking from the stored evaluations? The stored outcome does not change.');
    return nodes.length?make('div','qrl-card-actions qr4-actions',...nodes):null;
  }
  // While WINNER_NOT_READY or SELECTION_REPLAY_MISMATCH suppresses the label, no chip or line may say that a strategy ranked first (contract 8.2).
  const rankedHidden=body=>Array.isArray(body.overlays)&&body.overlays.some(name=>name==='WINNER_NOT_READY'||name==='SELECTION_REPLAY_MISMATCH')
    &&isObject(body.outcome)&&(body.outcome.outcome==='BEST_IN_SCOPE'||body.outcome.outcome==='TIED_IN_SCOPE');
  function resultBlocks(body){
    const outcome=body.outcome,registration=body.registration;
    const overlays=Array.isArray(body.overlays)?body.overlays:[];
    const nodes=overlays.map(name=>Object.hasOwn(OVERLAYS,name)?make('p',name==='RULESET_SUPERSEDED'?'qrl-note qr4-overlay':'qrl-alert qr4-overlay',label(OVERLAYS[name]),' ',code(name)):make('p','qrl-alert qr4-overlay',code(name)));
    const shownLabel=body.label_visible===true&&isObject(outcome.label)&&typeof outcome.label.label_text==='string'?outcome.label:null;
    if(shownLabel!==null)nodes.push(labelBlock(shownLabel,registration));
    else{
      const text=OUTCOME_TEXT[outcome.outcome];
      nodes.push(rankedHidden(body)?null:make('p','qrl-note qr4-outcome-text',known(OUTCOMES,outcome.outcome)),text?fixed(typeof outcome.text==='string'?outcome.text:text,text,'qrl-note qr4-outcome-sentence'):null,
        label(NO_WINNER,'p','qrl-winner qr4-no-winner'),scopeSection(statementOf(registration,null)),
        label(EXPOSURE,'p','qrl-note qr4-exposure'),
        typeof outcome.no_significance_sentence==='string'?fixed(outcome.no_significance_sentence,NO_SIGNIFICANCE,'qrl-note qr4-no-significance'):null,
        label(NO_PROFIT,'p','qrl-note qr4-no-profit'));
    }
    nodes.push(passingList(body,outcome),notPassedList(outcome),valuesList(body,outcome),hashesSection(body,outcome));
    return nodes;
  }
  function renderView(){
    if(state.viewError){
      const heading=make('h3','qrl-title',label('Selection'));heading.tabIndex=-1;
      fill(viewBox,[heading,state.viewError]);viewBox.hidden=false;return;
    }
    const body=state.view;
    if(!body){viewBox.replaceChildren();viewBox.hidden=true;return;}
    const completed=body.status==='SELECTION_COMPLETED'&&body.metrics_visible===true&&isObject(body.outcome);
    const heading=make('h3','qrl-title',label('Selection'),' ',make('span','qrl-id',short(body.selection_id)),' ',badge(STATUSES,body.status,'info'),
      completed&&!rankedHidden(body)?badge(OUTCOMES,body.outcome.outcome,'ok'):null,body.fixture===true?chip('Internal view','warn'):null);
    heading.tabIndex=-1;
    const nodes=[heading,state.message,body.code?make('p','qrl-note qr4-ending',label('Reason'),': ',coded(body.code)):null];
    if(completed)nodes.push(...resultBlocks(body));
    else{
      // Progress counts only: no metric of W exists in this view before the selection is complete (8.1).
      const progress=isObject(body.progress)?body.progress:{};
      nodes.push(note('Results appear only after the selection is complete.'),
        row('Participants',dash(progress.participants)),row('Evaluations started',dash(progress.started)),row('Window frozen',progress.window_frozen===true?label('Yes'):label('No')),
        scopeSection(statementOf(body.registration||{},null),false),
        progress.started>0?label(EXPOSURE,'p','qrl-note qr4-exposure'):null);
    }
    nodes.push(registrationSection(body),timeline(body),qr2Link(),actions(body));
    fill(viewBox,nodes);viewBox.hidden=false;
  }
  async function open(id,message=null){
    const seq=++state.viewSeq;state.busy=true;state.viewId=id;state.confirming=null;state.viewError=null;state.message=message;state.packages={};renderStatus();
    try{
      const body=await request(PATH+'/'+encodeURIComponent(id));
      if(seq!==state.viewSeq)return;
      if(!isObject(body)||body.ok!==true||typeof body.status!=='string'||!isObject(body.registration))throw Object.assign(new Error('unreadable'),{code:'ANSWER_UNREADABLE'});
      state.view=body;
    }catch(error){
      if(seq!==state.viewSeq)return;
      state.view=null;
      if(isUnavailable(error)){state.availability='unavailable';state.viewError=null;}
      else state.viewError=refusalLine(error);
    }finally{if(seq===state.viewSeq){state.busy=false;redraw();viewBox.querySelector('.qrl-title')?.focus({preventScroll:true});}}
  }
  async function checkPackage(exportId){
    const id=state.viewId;if(!id||state.busy||typeof exportId!=='string')return;
    const seq=state.viewSeq;state.busy=true;renderView();renderStatus();
    try{
      const answer=await request(PATH+'/'+encodeURIComponent(id)+'/package/'+encodeURIComponent(exportId));
      state.packages[exportId]=answer?.state==='READY'?{ok:true}:{ok:false,code:'ANSWER_UNREADABLE'};
    }catch(error){state.packages[exportId]={ok:false,code:errorCode(error)};}
    if(seq===state.viewSeq){state.busy=false;renderView();renderStatus();}
  }
  async function act(kind){
    const id=state.viewId;if(!id||state.busy)return;
    state.busy=true;state.confirming=null;renderView();renderStatus();
    let message=null;
    try{
      const answer=await request(PATH+'/'+encodeURIComponent(id)+(kind==='cancel'?'/cancel':'/replay'),{method:'POST',body:kind==='cancel'?JSON.stringify({confirmed:true}):'{}'});
      message=kind==='cancel'?note('The selection was cancelled.'):note(answer?.match===true?'The replay reproduced the stored outcome.':'The replay did not reproduce the stored outcome.');
    }catch(error){
      if(isUnavailable(error)){state.busy=false;state.availability='unavailable';redraw();return;}
      message=refusalLine(error);
    }
    state.busy=false;
    await open(id,message);
    loadList();
  }

  /* ---- status and events ---- */
  function renderStatus(){
    status.replaceChildren();
    const mode=state.availability;
    if(mode==='checking'||mode==='unknown')status.append(label('Checking…'));
    else if(mode==='unavailable')status.append(label('Qualified selection is not available on this release.'));
    else if(mode==='schema')status.append(label('The selection tables are not installed on this release.'));
    else if(mode==='error')status.append(label('Not available'),' (',code(state.probeCode),')');
    refresh.hidden=!(mode==='error'||mode==='unavailable'||mode==='schema');
    tools.hidden=mode!=='available';
    registerButton.disabled=state.busy;
  }
  function redraw(){renderStatus();renderPreview();renderRegister();renderList();renderView();}

  fill(tools,[section('Universe and eligibility',false,'qr4-preview-section',previewBox),section('Register a selection',false,'qr4-register-section',registerForm),
    section('Your selections',true,'qr4-list-section',listBox)]);
  panel.append(label('Qualified selection','summary','qrl-summary'),banner,status,refresh,tools,viewBox);
  host.append(panel);

  registerForm.addEventListener('submit',event=>{event.preventDefault();if(!state.busy)register();});
  registerForm.addEventListener('input',()=>{renderReview();});
  registerForm.addEventListener('change',()=>{renderReview();});
  refresh.addEventListener('click',()=>{loadList();});
  panel.addEventListener('click',event=>{
    const target=event.target.closest?.('button');if(!target||!panel.contains(target))return;
    if(target.classList.contains('qr4-preview-run'))runPreview();
    else if(target.classList.contains('qr4-use-scope'))useScope(target.dataset.run);
    else if(target.classList.contains('qr4-clear-scope')){state.scope=null;renderRegister();runPreview();}
    else if(target.classList.contains('qr4-refresh-list')){loadList();}
    else if(target.classList.contains('qr4-view-button')){if(!state.busy)open(target.dataset.id);}
    else if(target.classList.contains('qr4-check-package'))checkPackage(target.dataset.export);
    else if(target.dataset.ask){state.confirming=target.dataset.ask;renderView();viewBox.querySelector('.qr4-confirm-yes')?.focus();}
    else if(target.classList.contains('qr4-confirm-no')){state.confirming=null;renderView();}
    else if(target.classList.contains('qr4-confirm-yes'))act(target.dataset.action);
    else if(target.classList.contains('qr4-qr2-link')){
      document.querySelector('nav button[data-view="overview"]')?.click();
      document.getElementById('paperPerformance')?.scrollIntoView?.({block:'start'});
    }
  });
  panel.addEventListener('toggle',()=>{if(panel.open&&(state.availability==='unknown'||state.availability==='error'))loadList();});
  function clear(){
    state.probeSeq++;state.previewSeq++;state.viewSeq++;state.availability='unknown';state.list=null;state.listError=null;state.listBusy=false;state.preview=null;state.previewError=null;state.previewBusy=false;
    state.scope=null;state.view=null;state.viewId=null;state.viewError=null;state.busy=false;state.confirming=null;state.message=null;state.packages={};
    for(const element of [startInput,endInput])element.value='';
    warmInput.value='0';drawdownInput.value='20';floorInput.value='5';beatsBox.checked=false;confirmBox.checked=false;registerNote.replaceChildren();
    viewBox.replaceChildren();viewBox.hidden=true;redraw();
  }
  document.getElementById('refresh')?.addEventListener('click',()=>{if(panel.open&&!host.hidden&&state.availability==='available'&&!state.busy){loadList();if(state.viewId)open(state.viewId);}});
  document.getElementById('logout')?.addEventListener('click',clear);
  document.getElementById('language')?.addEventListener('change',redraw);
  redraw();
})();
