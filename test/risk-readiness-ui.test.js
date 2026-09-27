import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const file=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
function setup(){
  const dom=new JSDOM(file('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  w.eval(file('i18n.js')+'\n'+file('app.js')+`\nauthenticated=true;selectedBot='bot-a';me={moneyFormat:'decimal-string',bot:{id:'bot-a'},user:{id:'owner'},risk:{},botSession:{state:'SETUP'}};window.setPreviewBot=id=>{selectedBot=id;};window.setPreviewState=state=>{me.botSession.state=state;};`);
  const f=w.document.querySelector('#riskForm').elements;
  f.previewEntry.value='50000';f.previewStopLoss.value='49000';f.previewRiskPercent.value='1';
  w._riskDirty=false;
  return {dom,w,f,d:w.document};
}
const result={version:'pf1-readiness-v1',botId:'bot-a',asOf:'2026-09-28T00:00:00.000Z',policySource:'LOCKED_SESSION',policy:{source:'LOCKED_SESSION',hash:'policy-fixture',effective:{},hypothetical:false},capacity:{dailyExecutionCount:2,reservedExecutions:1,remainingDailyExecutions:7,uniqueSymbolsCommitted:1,remainingUniqueSymbols:3,allocationLimitEnforced:false},consistency:{status:'CONFLICT',issues:[{field:'defaults.riskPercent',code:'DEFAULT_OUTSIDE_POLICY',severity:'ERROR'}]},session:{state:'RUNNING',runId:'fixture'},account:{cash:'1000',cashAvailable:'900',bookEquity:'1200',positionCost:'200'},calculation:{status:'ACCEPTED',order:{quantity:'0.01',price:'50000',stopLoss:'49000',notional:'500'}},readiness:{status:'UNKNOWN',reasons:['VENUE_FILTERS_UNVERIFIED']},limitations:['BRIDGE_PREFLIGHT_UNSUPPORTED']};
test('preview edits do not mark policy dirty; policy and funding edits do',()=>{
  const {w,f}=setup();try{
    for(const control of [...f].filter(el=>el.name.startsWith('preview'))){control.dispatchEvent(new w.Event('input',{bubbles:true}));control.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w._riskDirty,false);}
    f.balanceGlobal.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(w._riskDirty,true);
    w._riskDirty=false;f.maxRiskPercent.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w._riskDirty,true);
  }finally{w.close();}
});
test('RUNNING and PAUSED lock policy and capital while preview stays enabled',()=>{
  const {w,f}=setup();try{
    for(const state of ['RUNNING','PAUSED']){w.setPreviewState(state);w.lockRiskForm(true);assert.equal(f.maxRiskPercent.disabled,true);assert.equal(f.balanceGlobal.disabled,true);for(const control of [...f].filter(el=>el.name.startsWith('preview')))assert.equal(control.disabled,false);}
    w.lockRiskForm(false);assert.equal(f.maxRiskPercent.disabled,false);
  }finally{w.close();}
});

test('Enter in preview requests a diagnostic and cannot submit the policy form',async()=>{
  const {w,f,d}=setup();const requests=[];
  try{
    w.fetch=async(path)=>{requests.push(path);return {ok:true,json:async()=>result};};
    const event=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
    f.previewEntry.dispatchEvent(event);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(event.defaultPrevented,true);assert.equal(w._riskDirty,false);
    assert.ok(requests.every(path=>path.startsWith('/api/risk/readiness')));
    assert.equal(d.querySelector('#riskForm button[type=submit], #riskForm button.primary').formNoValidate,true);
  }finally{w.close();}
});
test('saved preview sends only generic signal, omits unknown guards and shows unverified provenance/capital',async()=>{
  const {w,f,d}=setup();let request;try{
    w.fetch=async(path,options)=>{request={path,body:JSON.parse(options.body)};return{ok:true,json:async()=>result};};
    await w.previewRisk();assert.equal(request.path,'/api/risk/readiness?bot_id=bot-a');assert.deepEqual(Object.keys(request.body),['signal']);
    assert.equal('news_risk' in request.body.signal,false);assert.equal('volatility_percent' in request.body.signal,false);
    assert.match(d.querySelector('#riskPreviewStatus').textContent,/Not verified.*ACCEPTED/);assert.doesNotMatch(d.querySelector('#riskForm').textContent,/All current checks passed/);
    assert.match(d.querySelector('#riskPreviewProvenance').textContent,/Locked session policy.*2026-09-28.*Hash: policy-fixture.*Unsaved/);assert.match(d.querySelector('#riskPreviewCapital').textContent,/Reserved: 100/);assert.equal(d.querySelector('#previewSlots').textContent,'1 / 3');assert.equal(d.querySelector('#previewCapacity').textContent,'7');assert.match(d.querySelector('#riskPreviewReason').textContent,/Policy conflict \(defaults.riskPercent\): Default value/);assert.match(d.querySelector('#riskPreviewReason').textContent,/Venue quantity and price filters/);assert.doesNotMatch(d.querySelector('#riskPreviewReason').textContent,/VENUE_FILTERS_UNVERIFIED/);assert.match(d.querySelector('#riskPreviewReason').textContent,/entries and exits/);
    f.previewNewsRisk.value='false';f.previewVolatilityPercent.value='0';f.previewSide.value='SELL';f.previewSizeMode.value='QUANTITY';f.previewTargetTradeId.value='opened-trade';await w.previewRisk();
    assert.equal(request.body.signal.news_risk,false);assert.equal(request.body.signal.volatility_percent,0);assert.equal(request.body.signal.reduce_only,true);assert.equal(request.body.signal.quantity,'1');assert.equal(request.body.signal.target_trade_id,'opened-trade');
  }finally{w.close();}
});
test('input and Bot changes invalidate delayed preview immediately',async()=>{
  const {w,f,d}=setup();try{
    let resolve;w.fetch=()=>new Promise(r=>{resolve=r;});
    let pending=w.previewRisk();f.previewEntry.dispatchEvent(new w.Event('input',{bubbles:true}));resolve({ok:true,json:async()=>result});await pending;assert.equal(d.querySelector('#previewQuantity').textContent,'—');assert.match(d.querySelector('#riskPreviewStatus').textContent,/needs checking/);
    w.invalidateRiskPreview();pending=w.previewRisk();d.querySelector('#botSwitcher').dispatchEvent(new w.Event('change',{bubbles:true}));w.setPreviewBot('bot-b');resolve({ok:true,json:async()=>result});await pending;assert.equal(d.querySelector('#previewQuantity').textContent,'—');assert.equal(d.querySelector('#riskPreviewProvenance').textContent,'');
  }finally{w.close();}
});

test('stale error response cannot replace invalidated preview',async()=>{
  const {w,f,d}=setup();try{
    let resolve;w.fetch=()=>new Promise(r=>{resolve=r;});
    const pending=w.previewRisk();f.previewEntry.dispatchEvent(new w.Event('input',{bubbles:true}));
    resolve({ok:false,json:async()=>({error:'Old bot failure'})});await pending;
    assert.match(d.querySelector('#riskPreviewStatus').textContent,/needs checking/);
    assert.equal(d.querySelector('#riskPreviewReason').textContent,'');
  }finally{w.close();}
});

test('draft scenario carries current policy and capital without saving; edits invalidate pending results',async()=>{
  const {w,f,d}=setup();try{
    f.previewAuthority.value='DRAFT';f.previewCash.value='123.000000000000000001';f.previewBookEquity.value='250';f.maxRiskPercent.value='2';
    let request,resolve;w.fetch=(path,options)=>{request={path,options,body:JSON.parse(options.body)};return new Promise(r=>{resolve=r;});};
    let pending=w.previewRisk();assert.equal(request.path,'/api/risk/readiness?bot_id=bot-a');assert.equal(request.options.method,'POST');
    assert.equal(request.body.scenario.policy.maxRiskPercent,2);assert.ok(request.body.scenario.policy.defaults);assert.ok(request.body.scenario.policy.balances);assert.equal(request.body.scenario.capital.cash,'123.000000000000000001');assert.equal(request.body.scenario.capital.bookEquity,'250');
    f.previewCash.value='150';f.previewCash.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(w._riskDirty,false);
    resolve({ok:true,json:async()=>({...result,scenario:{hypothetical:true}})});await pending;assert.equal(d.querySelector('#previewQuantity').textContent,'—');
    pending=w.previewRisk();f.maxRiskPercent.value='3';f.maxRiskPercent.dispatchEvent(new w.Event('input',{bubbles:true}));resolve({ok:true,json:async()=>({...result,scenario:{hypothetical:true}})});await pending;assert.equal(d.querySelector('#previewQuantity').textContent,'—');assert.equal(w._riskDirty,true);
    w.invalidateRiskPreview();w.fetch=async()=>({ok:true,json:async()=>({...result,scenario:{hypothetical:true}})});await w.previewRisk();assert.match(d.querySelector('#riskPreviewStatus').textContent,/Hypothetical draft/);assert.match(d.querySelector('#riskPreviewProvenance').textContent,/Policy, funding and orders are not saved/);
    d.querySelector('#botSwitcher').dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(f.previewAuthority.value,'SAVED');assert.equal(f.previewCash.value,'');
  }finally{w.close();}
});
test('Bridge BUY/EXIT requests use deployment authority and render costs, market and venue evidence',async()=>{
  const {w,f,d}=setup();let request;try{
    f.previewSource.value='BRIDGE';f.previewDeploymentId.value='deployment-a';f.previewBarTime.value='1790553600000';f.previewEntry.value='';f.previewStopLoss.value='';
    w.fetch=async(path,options)=>{request={path,body:JSON.parse(options.body)};return{ok:true,json:async()=>({...result,deployment:{id:'deployment-a',state:'READY',snapshotHash:'snapshot-a',evidenceHash:'evidence-a'},market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1m',barTime:1790553600000,contentHash:'bar-a'},venue:{status:'PASSED',reasons:[],snapshotHash:'venue-a',retrievedAt:'2026-09-28',checks:[]},costs:{fee:'0.5',cashDebit:'500.5',cashAfterOrder:'499.5',estimatedLossAtStop:'11',estimatedProfitAtTarget:'18',assumption:'Gaps can increase losses.'}})};};
    await w.previewRisk();assert.equal(request.path,'/api/risk/readiness?bot_id=bot-a');assert.deepEqual(Object.keys(request.body),['bridge']);assert.equal(request.body.bridge.event_type,'BUY');assert.equal(request.body.bridge.bar_time,1790553600000);assert.equal('entry_ref' in request.body.bridge,false);
    assert.match(d.querySelector('#riskPreviewCosts').textContent,/Fee: 0.5.*Cash debit: 500.5.*Loss at stop: 11/);assert.match(d.querySelector('#riskPreviewVenue').textContent,/deployment-a.*BTCUSDT.*venue-a/);assert.match(d.querySelector('#riskPreviewVenue').textContent,/execution rechecks filters/);
    f.previewBridgeEvent.value='EXIT';f.previewEntryRef.value='deployment-a:1790553540000:0';f.previewExitReason.value='NATIVE';f.previewAuthority.value='DRAFT';f.previewCash.value='100';f.previewBookEquity.value='200';await w.previewRisk();assert.equal(request.body.bridge.event_type,'EXIT');assert.equal(request.body.bridge.reason,'NATIVE');assert.equal(request.body.bridge.entry_ref,'deployment-a:1790553540000:0');assert.ok(request.body.scenario);assert.equal('signal' in request.body,false);
    d.querySelector('#botSwitcher').dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(f.previewDeploymentId.value,'');assert.equal(f.previewEntryRef.value,'');
  }finally{w.close();}
});
test('venue refresh uses scoped CSRF helper and does not save policy or create an order',async()=>{
  const {w,f,d}=setup();let request;try{
    w.fetch=async(path,options)=>{request={path,options,body:JSON.parse(options.body)};return{ok:true,json:async()=>({venue:{status:'UNKNOWN',reasons:['VENUE_FILTERS_UNVERIFIED'],snapshotHash:'refreshed',checks:[]}})};};
    await d.querySelector('#previewRefreshVenue').onclick();assert.equal(request.path,'/api/risk/venue-refresh?bot_id=bot-a');assert.equal(request.options.method,'POST');assert.deepEqual(request.body,{symbol:'BTCUSDT'});assert.equal(request.options.credentials,'same-origin');assert.equal(w._riskDirty,false);assert.match(d.querySelector('#riskPreviewVenue').textContent,/refreshed.*Preview needs checking again/);
    f.previewSource.value='BRIDGE';f.previewBridgeSymbol.value='ETHUSDT';await d.querySelector('#previewRefreshVenue').onclick();assert.equal(request.body.symbol,'ETHUSDT');
  }finally{w.close();}
});
