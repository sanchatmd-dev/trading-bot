import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

// Paper activation of a Bridge draft: the drafts and deployments list of the Build Pine Bridge panel, its confirmation
// dialog and the outcome messages. The API is a stub; the real scripts, markup and i18n run in JSDOM.
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const BOT='bot-1',OTHER='bot-2',LIST='/api/quant/pine-bridge/deployments';
const ID={draft:'aaaaaaaa-1111-4111-8111-111111111111',newer:'bbbbbbbb-2222-4222-8222-222222222222',ready:'cccccccc-3333-4333-8333-333333333333',
  exit:'dddddddd-4444-4444-8444-444444444444',revoked:'eeeeeeee-5555-4555-8555-555555555555'};
const NOW=Date.UTC(2026,9,3,4,5,6);
const row=(id,state,extra={})=>({deployment_id:id,state,created_at:NOW,source_version:1,source_name:'My indicator',
  market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},...extra});
// Newest first, as the server answers.
const fixtureList=()=>[row(ID.newer,'DRAFT',{created_at:NOW+3000,source_version:2}),row(ID.draft,'DRAFT',{created_at:NOW+2000}),
  row(ID.ready,'READY',{created_at:NOW+1000}),row(ID.exit,'EXIT_ONLY',{created_at:NOW}),row(ID.revoked,'REVOKED',{created_at:NOW-1000})];
const activatePath=id=>LIST+'/'+id+'/activate';
const apiError=(code,status=409,message=code)=>Object.assign(new Error(message),{code,status});
const flush=()=>new Promise(resolve=>setTimeout(resolve,5));
// Objects made inside JSDOM have another Object prototype; strict deep equality needs plain objects.
const plain=value=>JSON.parse(JSON.stringify(value));

// The stub answers like the server: the list is its own state, and a successful activation turns the old READY row into EXIT_ONLY.
function setup({language,bots=[{id:BOT,label:'Staging Bot'}],list=fixtureList(),overrides={},modal=true}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[],server={list},dialogs={show:0,close:0};
  const callsTo=path=>calls.filter(call=>call.path===path);
  w.api=async(path,options)=>{
    calls.push({path,options});
    if(overrides[path])return overrides[path](options,callsTo(path).length);
    if(path==='/api/bots')return {bots};
    if(path===LIST)return {bot_id:options.botId,deployments:structuredClone(server.list)};
    const activate=path.match(/^\/api\/quant\/pine-bridge\/deployments\/([a-f0-9-]{36})\/activate$/);
    if(activate){
      const target=server.list.find(item=>item.deployment_id===activate[1]);
      if(!target)throw apiError('NOT_FOUND',404);
      for(const item of server.list)if(item.state==='READY')item.state='EXIT_ONLY';
      target.state='READY';
      return {deployment_id:target.deployment_id,state:'READY',execution_mode:'PAPER',quant_capability:'UNSUPPORTED'};
    }
    throw new Error('Unexpected '+path);
  };
  w.matchMedia=query=>({matches:false,addEventListener(){},removeEventListener(){}});
  w.HTMLElement.prototype.scrollIntoView=function(){};w.URL.createObjectURL=()=>'blob:fixture';w.URL.revokeObjectURL=()=>{};
  if(modal){
    // JSDOM has no modal dialog. These stand-ins behave like the browser: close() also fires the close event.
    w.HTMLDialogElement.prototype.showModal=function(){dialogs.show++;this.setAttribute('open','');};
    w.HTMLDialogElement.prototype.close=function(){dialogs.close++;if(this.hasAttribute('open')){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));}};
  }
  const errors=[];w.addEventListener('error',event=>errors.push(event.message));
  w.eval(publicFile('bridge-wizard.js'));w.eval(publicFile('pine-bridge.js'));
  const el=id=>d.getElementById(id),panel=el('pbPanel'),dialog=el('pbActivateDialog');
  const until=async(check,label='condition',limit=3000)=>{const end=Date.now()+limit;while(!check()){if(Date.now()>end)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,5));}};
  const rows=()=>[...el('pbDeployList').children];
  const buttons=()=>[...el('pbDeployList').querySelectorAll('.pbw-activate')];
  const posts=()=>calls.filter(call=>call.options?.method==='POST');
  const openPanel=async()=>{panel.open=true;await until(()=>callsTo(LIST).length>0,'list requested');await until(()=>rows().length>0||el('pbDeployStatus').textContent!==''&&!/Loading|กำลังโหลด/.test(el('pbDeployStatus').textContent),'list shown');};
  const clickRow=id=>{const button=buttons().find(item=>item.dataset.deploymentId===id);assert.ok(button,'a button for '+id);button.click();return button;};
  const confirm=()=>el('pbActivateConfirm').click();
  return {dom,w,d,el,panel,dialog,calls,callsTo,server,dialogs,errors,until,rows,buttons,posts,openPanel,clickRow,confirm,close:()=>w.close()};
}
const states=p=>p.rows().map(item=>item.dataset.state);

test('markup: the list sits in the panel outside the six steps; the dialog has the four points and two plain buttons; no inline style',()=>{
  const p=setup();
  try{
    const section=p.el('pbDeploy'),steps=[...p.d.querySelectorAll('.pbw-step')];
    assert.ok(p.panel.contains(section)&&steps.length===6&&steps.every(step=>!step.contains(section)),'outside the steps, so a locked step never hides it');
    assert.equal(p.el('pbDeployTitle').textContent,'Drafts and deployments of this Bot');
    assert.equal(p.el('pbDeployRefresh').type,'button');
    assert.equal(p.dialog.tagName,'DIALOG');assert.equal(p.dialog.open,false);
    assert.equal(p.el('pbActivateTitle').textContent,'Activate this draft for Paper?');
    assert.deepEqual([...p.dialog.querySelectorAll('.pbw-points li')].map(item=>item.textContent),[
      'This draft becomes the READY Bridge of this Bot for Paper trading. No real orders are sent.',
      'The READY Bridge of this Bot now, if there is one, becomes EXIT_ONLY. It only closes open positions.',
      'The Bot must be in SETUP, RUNNING or PAUSED. A stopped Bot cannot be activated.',
      'After activation, in TradingView, point the alert of this script to the Bridge webhook URL: https://robot.test/webhooks/pine-bridge/v2/ followed by the webhook secret of this Bot (Account and License → Current webhook, the part after /webhooks/tradingview/). Do not use the capture URL.']);
    assert.deepEqual([...p.dialog.querySelectorAll('button')].map(button=>[button.type,button.textContent]),[['button','Cancel'],['button','Activate for Paper']]);
    assert.equal(p.dialog.querySelector('form'),null,'no form: nothing can submit by Enter');
    assert.equal(p.el('pbDeployStatus').textContent,'Select a Bot to see its drafts and deployments.');
    assert.equal(p.panel.querySelector('[style]'),null,'the CSP forbids inline styles');
    assert.equal(p.el('pbDeployDone').hidden,true);assert.equal(p.el('pbDeployFail').hidden,true);
    // The outcome cards sit above the list, so a long list never pushes the result out of sight.
    const before=(first,second)=>Boolean(first.compareDocumentPosition(second)&p.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(before(p.el('pbDeployStatus'),p.el('pbDeployDone'))&&before(p.el('pbDeployDone'),p.el('pbDeployFail'))&&before(p.el('pbDeployFail'),p.el('pbDeployList')));
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('the list loads for the selected Bot only; a button shows on DRAFT rows only; READY, EXIT_ONLY and REVOKED have none',async()=>{
  const p=setup();
  try{
    await p.openPanel();
    assert.equal(p.callsTo(LIST).length,1);
    assert.deepEqual(plain(p.callsTo(LIST)[0].options),{botId:BOT,silent:true},'a GET scoped to the selected Bot, read-only');
    assert.deepEqual(states(p),['DRAFT','DRAFT','READY','EXIT_ONLY','REVOKED']);
    assert.deepEqual(p.buttons().map(button=>button.dataset.deploymentId),[ID.newer,ID.draft]);
    for(const item of p.rows())assert.equal(item.querySelectorAll('button').length,item.dataset.state==='DRAFT'?1:0,item.dataset.state);
    assert.deepEqual(p.buttons().map(button=>button.textContent),['Activate for Paper','Activate for Paper']);
    assert.deepEqual(p.rows().map(item=>item.querySelector('.pbw-state').textContent),['Draft','Draft','Ready','Exit only','Revoked']);
    assert.equal(p.rows()[1].querySelector('.pbw-deploy-id').textContent,'aaaaaaaa');
    assert.equal(p.rows()[0].querySelector('.pbw-deploy-meta').textContent,'My indicator · v2 · binance-global BTCUSDT 1 · 2026-10-03 04:05:09 UTC');
    assert.equal(p.el('pbDeployStatus').textContent,'');
    assert.equal(p.posts().length,0,'loading the list never writes');
    assert.equal(p.dialog.open,false,'and never opens the confirmation by itself');
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('a row button only opens the confirmation: no request is sent until Confirm; Cancel and Escape send nothing either',async()=>{
  const p=setup();
  try{
    await p.openPanel();
    p.clickRow(ID.draft);
    assert.equal(p.dialog.open,true);assert.equal(p.dialogs.show,1,'a modal dialog');
    assert.equal(p.el('pbActivateWhich').textContent,'Draft aaaaaaaa · My indicator · v1 · binance-global BTCUSDT 1 · 2026-10-03 04:05:08 UTC');
    assert.equal(p.posts().length,0);
    assert.equal(p.el('pbActivateConfirm').textContent,'Activate for Paper');assert.equal(p.el('pbActivateConfirm').disabled,false);
    // Cancel closes it and sends nothing.
    p.el('pbActivateCancel').click();
    assert.equal(p.dialog.open,false);assert.equal(p.posts().length,0);
    // Opening again, Escape is the browser cancel event: it is not blocked while idle, and the close that follows sends nothing.
    p.clickRow(ID.newer);assert.equal(p.dialog.open,true);
    assert.match(p.el('pbActivateWhich').textContent,/^Draft bbbbbbbb · My indicator · v2 /);
    const escape=new p.w.Event('cancel',{cancelable:true});p.dialog.dispatchEvent(escape);assert.equal(escape.defaultPrevented,false);
    p.dialog.close();
    assert.equal(p.posts().length,0);
    // After a close nothing is pending: a stray Confirm click does nothing.
    p.confirm();await flush();assert.equal(p.posts().length,0);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('without showModal and close (older browsers, JSDOM) the confirmation still opens and closes through the open attribute',async()=>{
  const p=setup({modal:false});
  try{
    await p.openPanel();
    p.clickRow(ID.draft);assert.equal(p.dialog.hasAttribute('open'),true);assert.equal(p.posts().length,0);
    p.el('pbActivateCancel').click();assert.equal(p.dialog.hasAttribute('open'),false);assert.equal(p.posts().length,0);
    p.clickRow(ID.draft);p.confirm();await p.until(()=>!p.el('pbDeployDone').hidden,'activated');
    assert.equal(p.dialog.hasAttribute('open'),false);assert.equal(p.posts().length,1);
  }finally{p.close();}
});

test('Confirm posts an empty JSON object once, scoped to the Bot; then Activated, the alert reminder and the refreshed list show',async()=>{
  const p=setup();
  try{
    await p.openPanel();
    p.clickRow(ID.draft);p.confirm();
    await p.until(()=>!p.el('pbDeployDone').hidden&&p.rows().some(item=>item.dataset.state==='READY'),'activated and refreshed');
    assert.equal(p.callsTo(LIST).length,2);
    const sent=p.posts();assert.equal(sent.length,1);
    assert.equal(sent[0].path,activatePath(ID.draft));
    assert.deepEqual(plain(sent[0].options),{method:'POST',botId:BOT,silent:true,body:'{}'});
    assert.equal(p.callsTo(LIST)[1].options.botId,BOT);
    // The list shows the new truth: the draft is READY, the old READY only exits, the other draft is still a draft.
    assert.deepEqual(states(p),['DRAFT','READY','EXIT_ONLY','EXIT_ONLY','REVOKED']);
    assert.deepEqual(p.buttons().map(button=>button.dataset.deploymentId),[ID.newer]);
    const done=p.el('pbDeployDone');
    assert.deepEqual([...done.querySelectorAll('p')].map(item=>item.textContent),['Activated','Draft aaaaaaaa is now the READY Bridge of this Bot for Paper trading.',
      'Next, in TradingView, point the alert of this script to the Bridge webhook URL: https://robot.test/webhooks/pine-bridge/v2/ followed by the webhook secret of this Bot (Account and License → Current webhook, the part after /webhooks/tradingview/). Do not use the capture URL.']);
    assert.equal(p.el('pbDeployFail').hidden,true);assert.equal(p.dialog.open,false);
    assert.equal(p.d.activeElement,done,'focus moves to the outcome');
    // The reminder names the path only: no secret is ever put on the page.
    assert.doesNotMatch(p.panel.textContent,/pine-bridge\/v2\/[A-Za-z0-9]/);
    // Close dismisses the card.
    done.querySelector('button').click();assert.equal(done.hidden,true);assert.equal(done.children.length,0);
    assert.equal(p.posts().length,1,'nothing else was sent');
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('a double click on Confirm, or a click on another row while it runs, sends one request; the dialog cannot be dismissed meanwhile',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const p=setup();
  const original=p.w.api;
  p.w.api=async(path,options)=>{if(path===activatePath(ID.draft)){p.calls.push({path,options});await held;return {deployment_id:ID.draft,state:'READY'};}return original(path,options);};
  try{
    await p.openPanel();
    p.clickRow(ID.draft);p.confirm();p.confirm();p.confirm();
    assert.equal(p.posts().length,1,'one request for three clicks');
    assert.equal(p.el('pbActivateConfirm').disabled,true);assert.equal(p.el('pbActivateCancel').disabled,true);
    assert.equal(p.el('pbActivateConfirm').textContent,'Activating…');
    assert.ok(p.buttons().every(button=>button.disabled),'no other row can start while one runs');
    assert.equal(p.el('pbDeployRefresh').disabled,true);
    p.buttons()[0].click();p.el('pbActivateCancel').click();
    const escape=new p.w.Event('cancel',{cancelable:true});p.dialog.dispatchEvent(escape);assert.equal(escape.defaultPrevented,true,'Escape is blocked while the request runs');
    assert.equal(p.dialog.open,true);assert.equal(p.posts().length,1);
    release();
    await p.until(()=>!p.el('pbDeployDone').hidden,'done');
    assert.equal(p.dialog.open,false);assert.equal(p.posts().length,1);
    assert.equal(p.el('pbActivateConfirm').textContent,'Activate for Paper');assert.equal(p.el('pbActivateConfirm').disabled,false);
  }finally{p.close();}
});

// Every code that activating can end with, with the plain text for it and the status of the answer.
const CHANGED='Risk settings, capital or the Pine source changed after this draft was generated. Generate a new draft and activate that one.';
const BAD_EVIDENCE='The recorded evidence for this draft is failed or incomplete. Ask your administrator to review it.';
const CASES=[
  ['NOT_FOUND',404,'This deployment was not found for this Bot. Refresh the list.'],
  ['DEPLOYMENT_REPLACED',409,'This deployment was already replaced or revoked, so it cannot be activated. Generate a new draft if you need one.'],
  ['MULTI_PINE_REQUIRES_APP_3B',409,'Activation needs exactly one connected Pine source on this Bot. Several Pine sources on one Bot are not supported yet.'],
  ['BOT_STOPPED',409,'Start the Bot (Run) first. A stopped Bot must be reset in Bot Manager before it can run. Then try again.'],
  ['RISK_EXCEEDS_POLICY',400,'The Bridge risk exceeds the Risk policy of this Bot (Max risk / trade). Adjust the Risk settings, then generate a new draft.'],
  ['STALE_MEMBERSHIP',409,CHANGED],['STALE_POLICY',409,CHANGED],['STALE_CAPITAL',409,CHANGED],['STALE_EVIDENCE',409,CHANGED],
  ['BRIDGE_EXECUTION_EVIDENCE_REQUIRED',409,'No Paper evidence is recorded for this draft yet. An administrator records it after the checks. Ask your administrator, then try again.'],
  ['BRIDGE_EVIDENCE_FAILED',409,BAD_EVIDENCE],['BRIDGE_EVIDENCE_INCOMPLETE',409,BAD_EVIDENCE],
  ['RETRY_TRANSACTION',409,'Another update was running at the same time. Nothing was changed. Try again.']];

for(const language of [undefined,'th'])
  test('each activation error shows its code and a clear message, closes the dialog and refreshes the list'+(language?' (Thai)':''),async()=>{
    const failure={};
    const p=setup({language,overrides:{[activatePath(ID.draft)]:()=>{throw failure.error;}}});
    try{
      await p.openPanel();
      const fail=p.el('pbDeployFail');
      for(const [code,status,english] of CASES){
        failure.error=apiError(code,status);
        const before=p.callsTo(LIST).length;
        p.clickRow(ID.draft);p.confirm();
        await p.until(()=>!fail.hidden&&p.callsTo(LIST).length===before+1,code);
        const expected=p.w.translate(english);
        if(language)assert.notEqual(expected,english,'Thai text for '+code);
        assert.equal(fail.querySelector('.pbw-fail-title').textContent,p.w.translate('Activation did not complete'));
        assert.equal(fail.querySelector('code').textContent,code);
        assert.equal(fail.querySelector('.pbw-fail-why').textContent,expected,code);
        assert.equal(p.el('pbDeployDone').hidden,true);assert.equal(p.dialog.open,false,'the owner can go and fix the cause');
        assert.equal(p.d.activeElement,fail);
        // The next attempt clears the old outcome as soon as the dialog opens.
        p.clickRow(ID.draft);assert.equal(fail.hidden,true);p.el('pbActivateCancel').click();
      }
      assert.equal(new Set(CASES.map(item=>item[2])).size,CASES.length-4,'the four stale codes share one text and the two failed-evidence codes share one; the others have their own');
      assert.equal(p.posts().length,CASES.length,'one request per confirmation');
      assert.deepEqual(p.errors,[]);
    }finally{p.close();}
  });

test('an unknown code, an inherited object key and a dropped connection get the generic text; a 401 clears the panel like a logout',async()=>{
  const failure={};
  const p=setup({overrides:{[activatePath(ID.draft)]:()=>{throw failure.error;}}});
  try{
    await p.openPanel();
    const fail=p.el('pbDeployFail'),attempt=async()=>{p.clickRow(ID.draft);p.confirm();await p.until(()=>!fail.hidden,'failure card');};
    failure.error=apiError('SOMETHING_NEW',409,'Server says no');await attempt();
    assert.equal(fail.querySelector('code').textContent,'SOMETHING_NEW');
    assert.equal(fail.querySelector('.pbw-fail-why').textContent,'The deployment was not activated. Refresh the list to see its current state. Server says no');
    failure.error=apiError('constructor',409,'constructor');await attempt();
    assert.equal(fail.querySelector('.pbw-fail-why').textContent,'The deployment was not activated. Refresh the list to see its current state.');
    failure.error=new TypeError('Failed to fetch');await attempt();
    assert.equal(fail.querySelector('code').textContent,'REQUEST_FAILED');
    assert.equal(fail.querySelector('.pbw-fail-why').textContent,'The deployment was not activated. Refresh the list to see its current state. Failed to fetch');
    failure.error=apiError('UNAUTHORIZED',401,'Authentication required');
    p.clickRow(ID.draft);p.confirm();
    await p.until(()=>p.rows().length===0&&p.el('pbBot').options.length===0,'cleared');
    assert.equal(fail.hidden,true);assert.equal(p.dialog.open,false);assert.equal(p.el('pbDeployDone').hidden,true);
    assert.equal(p.el('pbDeployStatus').textContent,'Select a Bot to see its drafts and deployments.');
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('hostile API text is shown as text only; rows with a bad id or state are dropped; unknown states and extra fields get no button and no output',async()=>{
  const hostile=[
    row(ID.draft,'DRAFT',{source_name:'<img src=x onerror=alert(1)>',market:{broker:'<b>x</b>',symbol:'<script>boom()</script>',timeframe:'1'},snapshot:'SECRET_SNAPSHOT',token:'SECRET_TOKEN'}),
    row('not-a-uuid','DRAFT'),row(ID.exit,'DRAFT',{deployment_id:'../../x'}),{deployment_id:ID.revoked,state:42},null,'text',
    row(ID.ready,'constructor')];
  const p=setup({list:hostile});
  try{
    await p.openPanel();
    assert.equal(p.rows().length,2);
    assert.equal(p.panel.querySelectorAll('img,script,b,svg,iframe,a').length,0);
    assert.equal(p.panel.querySelector('[onerror],[onload],[onclick],[style]'),null);
    assert.ok(p.panel.textContent.includes('<img src=x onerror=alert(1)>')&&p.panel.textContent.includes('<script>boom()</script>'));
    assert.doesNotMatch(p.panel.textContent,/SECRET_/);
    assert.deepEqual(p.buttons().map(button=>button.dataset.deploymentId),[ID.draft]);
    const unknown=p.rows()[1];
    assert.equal(unknown.querySelector('.pbw-state').textContent,'constructor');assert.equal(unknown.querySelectorAll('button').length,0);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('a failed or malformed list shows its code and no stale rows; Refresh list tries again and recovers',async()=>{
  const mode={value:'down'};
  const p=setup({overrides:{[LIST]:options=>{
    if(mode.value==='down')throw apiError('PINE_BRIDGE_DISABLED',503);
    if(mode.value==='shape')return {deployments:'nope'};
    return {bot_id:options.botId,deployments:fixtureList()};
  }}});
  try{
    p.panel.open=true;
    await p.until(()=>/Code: PINE_BRIDGE_DISABLED/.test(p.el('pbDeployStatus').textContent),'failure shown');
    assert.equal(p.el('pbDeployStatus').textContent,'The list could not be loaded. Use Refresh list to try again. Code: PINE_BRIDGE_DISABLED');
    assert.equal(p.rows().length,0);
    mode.value='shape';p.el('pbDeployRefresh').click();
    await p.until(()=>/UNEXPECTED_ANSWER/.test(p.el('pbDeployStatus').textContent),'malformed answer');
    assert.equal(p.rows().length,0);
    mode.value='ok';p.el('pbDeployRefresh').click();
    await p.until(()=>p.rows().length===5,'recovered');
    assert.equal(p.el('pbDeployStatus').textContent,'');assert.equal(p.callsTo(LIST).length,3);
    // An empty list says so and points to the steps above.
    p.server.list=[];mode.value='empty';
    p.w.api=async(path,options)=>path===LIST?{bot_id:options.botId,deployments:[]}:{bots:[{id:BOT,label:'Staging Bot'}]};
    p.el('pbDeployRefresh').click();
    await p.until(()=>p.rows().length===0&&/No drafts or deployments/.test(p.el('pbDeployStatus').textContent),'empty');
    assert.equal(p.el('pbDeployStatus').textContent,'No drafts or deployments for this Bot yet. Generate a draft in the steps above.');
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

const defer=()=>{const entry={};entry.promise=new Promise((resolve,reject)=>{entry.resolve=resolve;entry.reject=reject;});return entry;};

test('with several Bots nothing is requested until one is chosen; an older answer never replaces a newer one or the list of another Bot',async()=>{
  const waits=[defer(),defer()];
  const p=setup({bots:[{id:BOT,label:'First'},{id:OTHER,label:'Second'}],overrides:{[LIST]:(options,count)=>waits[count-1]?waits[count-1].promise:{bot_id:options.botId,deployments:[row(ID.newer,'READY')]}}});
  try{
    p.panel.open=true;
    await p.until(()=>p.el('pbBot').options.length===3,'Bots loaded');
    assert.equal(p.callsTo(LIST).length,0,'no Bot chosen: no request');
    assert.equal(p.el('pbDeployStatus').textContent,'Select a Bot to see its drafts and deployments.');assert.equal(p.el('pbDeployRefresh').disabled,true);
    const choose=bot=>{p.el('pbBot').value=bot;p.el('pbBot').dispatchEvent(new p.w.Event('change',{bubbles:true}));};
    choose(BOT);choose(OTHER);
    assert.deepEqual(p.callsTo(LIST).map(call=>call.options.botId),[BOT,OTHER]);
    assert.equal(p.el('pbDeployStatus').textContent,'Loading…');
    waits[1].resolve({bot_id:OTHER,deployments:[row(ID.newer,'DRAFT',{source_name:'Second Bot source'})]});
    await p.until(()=>p.rows().length===1,'second answer');
    waits[0].resolve({bot_id:BOT,deployments:[row(ID.draft,'DRAFT',{source_name:'First Bot source'}),row(ID.ready,'READY')]});
    await flush();await flush();
    assert.deepEqual(p.rows().map(item=>item.dataset.deploymentId),[ID.newer],'the late answer of the first Bot is dropped');
    assert.match(p.rows()[0].textContent,/Second Bot source/);
    // Activation uses the Bot the list belongs to.
    p.clickRow(ID.newer);
    assert.equal(p.el('pbActivateWhich').textContent.includes('Second Bot source'),true);
    p.confirm();await p.until(()=>!p.el('pbDeployDone').hidden&&p.rows().some(item=>item.dataset.state==='READY'),'activated and refreshed');
    assert.equal(p.posts().length,1);assert.equal(p.posts()[0].options.botId,OTHER);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('changing the Bot clears the old rows at once and the old outcome; logout clears rows, dialog and outcome and drops a late answer',async()=>{
  const wait=defer();
  const p=setup({bots:[{id:BOT,label:'First'},{id:OTHER,label:'Second'}],overrides:{}});
  const original=p.w.api;let slow=false;
  p.w.api=async(path,options)=>{if(path===LIST&&slow){p.calls.push({path,options});return wait.promise;}return original(path,options);};
  try{
    p.panel.open=true;await p.until(()=>p.el('pbBot').options.length===3,'Bots loaded');
    const choose=bot=>{p.el('pbBot').value=bot;p.el('pbBot').dispatchEvent(new p.w.Event('change',{bubbles:true}));};
    choose(BOT);await p.until(()=>p.rows().length===5,'rows');
    p.clickRow(ID.draft);p.confirm();await p.until(()=>!p.el('pbDeployDone').hidden,'outcome');
    slow=true;choose(OTHER);
    assert.equal(p.rows().length,0,'the rows of the first Bot are gone while the second loads');
    assert.equal(p.el('pbDeployDone').hidden,true,'the outcome belonged to the first Bot');
    // Logout while a list is loading and while the confirmation is open.
    slow=false;choose(BOT);await p.until(()=>p.rows().length>0,'rows again');
    p.clickRow(ID.newer);assert.equal(p.dialog.open,true);
    slow=true;p.el('pbDeployRefresh').click();
    p.d.getElementById('logout').click();
    assert.equal(p.dialog.open,false);assert.equal(p.rows().length,0);assert.equal(p.el('pbBot').options.length,0);
    wait.resolve({bot_id:BOT,deployments:fixtureList()});await flush();await flush();
    assert.equal(p.rows().length,0,'a late answer after logout is ignored');
    assert.equal(p.el('pbDeployStatus').textContent,'Select a Bot to see its drafts and deployments.');
    assert.equal(p.el('pbDeployFail').hidden,true);assert.equal(p.el('pbDeployDone').hidden,true);
    assert.deepEqual(p.errors,[]);
  }finally{p.close();}
});

test('Thai: the list, the dialog, the outcome and the reminder follow the language; the switch re-renders them both ways',async()=>{
  const p=setup({language:'th'});
  try{
    const asked=new Set(),real=p.w.translate;p.w.translate=text=>{asked.add(text);return real(text);};
    await p.openPanel();
    assert.equal(p.el('pbDeployTitle').textContent,'ฉบับร่างและ Deployment ของ Bot นี้');
    assert.deepEqual(p.rows().map(item=>item.querySelector('.pbw-state').textContent),['ฉบับร่าง','ฉบับร่าง','พร้อมใช้งาน','ปิดสถานะเท่านั้น','ถูกเพิกถอน']);
    assert.equal(p.buttons()[0].textContent,'เปิดใช้งานสำหรับ Paper');assert.equal(p.buttons()[0].getAttribute('aria-label'),'เปิดใช้งานสำหรับ Paper bbbbbbbb');
    p.clickRow(ID.draft);
    assert.equal(p.el('pbActivateTitle').textContent,'เปิดใช้งานฉบับร่างนี้สำหรับ Paper หรือไม่?');
    assert.match(p.el('pbActivateWhich').textContent,/^ฉบับร่าง aaaaaaaa · My indicator/);
    const points=[...p.dialog.querySelectorAll('.pbw-points li')].map(item=>item.textContent);
    assert.equal(points.length,4);
    assert.match(points[0],/^ฉบับร่างนี้จะกลายเป็น Bridge ที่ READY/);assert.match(points[1],/EXIT_ONLY/);assert.match(points[2],/SETUP, RUNNING หรือ PAUSED/);
    assert.match(points[3],/https:\/\/robot\.test\/webhooks\/pine-bridge\/v2\/ ตามด้วยรหัสลับ Webhook ของ Bot นี้ \(บัญชีและ License → Webhook ปัจจุบัน/);
    assert.ok(!points[3].includes('{url}'));
    assert.deepEqual([...p.dialog.querySelectorAll('button')].map(button=>button.textContent),['ยกเลิก','เปิดใช้งานสำหรับ Paper']);
    p.confirm();await p.until(()=>!p.el('pbDeployDone').hidden,'done');
    const done=p.el('pbDeployDone');
    assert.equal(done.querySelector('.pbw-done-title').textContent,'เปิดใช้งานแล้ว');
    assert.equal(done.querySelectorAll('p')[1].textContent,'ฉบับร่าง aaaaaaaa เป็น Bridge ที่ READY ของ Bot นี้สำหรับการเทรดแบบ Paper แล้ว');
    assert.match(done.querySelectorAll('p')[2].textContent,/^ถัดไป ให้ตั้ง Alert ของสคริปต์นี้ใน TradingView/);
    assert.equal(done.querySelector('button').textContent,'ปิด');
    for(const text of asked)assert.notEqual(real(text),text,'a text of the run has no Thai: '+text);
    // Back to English and again to Thai: the templated texts and the data rows are rebuilt.
    const language=p.d.getElementById('language');
    language.value='en';language.dispatchEvent(new p.w.Event('change'));
    assert.equal(p.el('pbDeployTitle').textContent,'Drafts and deployments of this Bot');
    // The activation above made the first draft READY and turned the old READY row into EXIT_ONLY.
    assert.deepEqual(p.rows().map(item=>item.querySelector('.pbw-state').textContent),['Draft','Ready','Exit only','Exit only','Revoked']);
    assert.equal(p.buttons()[0].textContent,'Activate for Paper');
    assert.equal(done.querySelector('.pbw-done-title').textContent,'Activated');
    assert.equal(done.querySelectorAll('p')[1].textContent,'Draft aaaaaaaa is now the READY Bridge of this Bot for Paper trading.');
    assert.match(done.querySelectorAll('p')[2].textContent,/^Next, in TradingView, point the alert/);
    assert.equal(p.el('pbActivateConfirm').textContent,'Activate for Paper');
    language.value='th';language.dispatchEvent(new p.w.Event('change'));
    assert.equal(done.querySelectorAll('p')[1].textContent,'ฉบับร่าง aaaaaaaa เป็น Bridge ที่ READY ของ Bot นี้สำหรับการเทรดแบบ Paper แล้ว');
  }finally{p.close();}
});

test('the Bridge webhook reminder points at the Bridge path, shows no secret and never offers a capture path',async()=>{
  const p=setup();
  try{
    await p.openPanel();p.clickRow(ID.draft);
    const text=p.dialog.querySelector('.pbw-points').textContent;
    assert.match(text,/webhook URL: https:\/\/robot\.test\/webhooks\/pine-bridge\/v2\/ followed by/);
    assert.match(text,/Do not use the capture URL/);
    assert.doesNotMatch(text,/pine-capture|capture_path|capture_url/);
    p.confirm();await p.until(()=>!p.el('pbDeployDone').hidden,'done');
    assert.doesNotMatch(p.el('pbDeployDone').textContent,/pine-capture|capture_path|capture_url/);
  }finally{p.close();}
});

const placeholders=text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();

test('activation pairs are complete, unique, collision-free, keep their placeholders and are all used; every label of the section has Thai',()=>{
  const p=setup({language:'th'}),pairs=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}).window;
  try{
    pairs.localStorage.setItem('robotLanguage','th');
    pairs.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=bridgeActivatePairs;');
    const mine=[...pairs.__mine],others=pairs.__pairs.filter(pair=>!pairs.__mine.includes(pair));
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.ok(mine.length>25);assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){assert.notEqual(en,th);assert.deepEqual(placeholders(en),placeholders(th),'placeholders differ: '+en);}
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
    const source=publicFile('pine-bridge.js');
    for(const text of english)assert.ok(source.includes(text),'pair for a text that is no longer shown: '+text);
    for(const node of p.panel.querySelectorAll('#pbDeploy [data-ui-label],#pbActivateDialog [data-ui-label]'))assert.notEqual(node.textContent,node.dataset.uiLabel,'no Thai: '+node.dataset.uiLabel);
    // The journey pair lost its dollar part with the screen text.
    assert.equal(pairs.translate('{input} in / {output} out tokens'),'Token เข้า {input} / ออก {output}');
    assert.equal(pairs.translate('{input} in / {output} out tokens · USD {cost}'),'{input} in / {output} out tokens · USD {cost}');
  }finally{p.close();pairs.close();}
});

test('the activation code has one POST, only inside the Confirm handler; the list call is a plain GET; nothing activates on load',()=>{
  const source=publicFile('pine-bridge.js');
  assert.equal(source.split("'/activate'").length-1,1,'one call site of the activate endpoint');
  const handlerAt=source.indexOf("el('pbActivateConfirm').addEventListener('click'"),callAt=source.indexOf("'/activate'");
  assert.ok(handlerAt>0&&callAt>handlerAt&&callAt-handlerAt<700,'the call sits inside the Confirm handler');
  assert.equal(source.split("'/api/quant/pine-bridge/deployments',{botId:bot,silent:true}").length-1,1,'the list is read with a plain scoped GET');
  assert.ok(source.includes("method:'POST',botId:target.bot,silent:true,body:'{}'"),'an empty JSON object, scoped to the Bot of the list');
  for(const banned of ['revoke','deactivate','/activate?','auto'])assert.ok(!source.includes('pine-bridge/deployments/'+banned),banned);
});

test('the styles keep the list, the outcome cards and the dialog inside a phone screen: wrapping text, no fixed widths, no inline style',()=>{
  const css=publicFile('styles-v2.css'),at=css.indexOf('/* Drafts and deployments of the selected Bot'),end=css.indexOf('/* Reduced motion:');
  assert.ok(at>css.indexOf('/* Guided Build Pine Bridge panel')&&end>at,'the block sits inside the Guided Build Pine Bridge block');
  const block=css.slice(at,end);
  for(const selector of ['.pbw-deploy-id','.pbw-deploy-meta','.pbw-state','.pbw-done p','.pbw-points li'])
    assert.ok(new RegExp('#pbPanel '+selector.replace('.','\.')+'\{[^}]*overflow-wrap:anywhere').test(block),selector+' wraps long text');
  assert.ok(/#pbPanel \.pbw-deploy-list\{[^}]*list-style:none/.test(block)&&/#pbPanel \.pbw-actions\{[^}]*flex-wrap:wrap/.test(block));
  assert.ok(block.includes('@media(max-width:600px){#pbPanel .pbw-dialog{padding:16px}'),'a phone gets a narrower dialog padding');
  assert.ok(!block.includes('nowrap')&&!/(^|[^-])width:\d{3,}px/.test(block)&&!/min-width:\d+px/.test(block));
});
