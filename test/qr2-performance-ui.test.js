import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {validateResponse} from '../src/portfolio/qr2-labels.js';
import {validateOwnerResponse} from '../src/portfolio/qr2-owner-response.js';
import {refusalAnswer,composePerformanceResponse} from '../src/portfolio/qr2-response.js';
import {planCoverageUncapped,buildCoverageSnapshot,buildDegradedCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {projectPublicCoverage} from '../src/portfolio/qr2-coverage-public.js';
import {QR2_COVERAGE_LIMITS} from '../src/portfolio/qr2-coverage-limits.js';

const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/qr2-performance-ui/responses.json',import.meta.url),'utf8'));
const covFx=JSON.parse(fs.readFileSync(new URL('./fixtures/qr2-performance-ui/coverage-responses.json',import.meta.url),'utf8'));
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const ok=body=>({status:200,body});
const bookFixture=()=>({user:{id:'owner-1'},bot:{id:'bot-1'},allBots:false,moneyFormat:'decimal-string',paperAccounts:[{bot_id:'bot-1',userId:'bot-1',broker:'binance-global',currency:'USDT',valuation:'COST_BASIS_NOT_MARK_TO_MARKET',bookEquity:'9007199254740994.123456789123456789'}]});
function setup({authenticated=true,language='en',answer=()=>ok(fixture.bot),bookAnswer=()=>ok(bookFixture()),sessionLoad=()=>{},observe=true,panelSource=null}={}){
  const {problems}=staticI18n();
  if(problems.length)throw new Error('i18n pair collision, no page rendered: '+problems[0]);
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  // observe:false drops the translateUI MutationObserver for the long fail-closed table (A7); labels still translate through translate().
  if(!observe)w.MutationObserver=class{observe(){}disconnect(){}};
  w.localStorage.setItem('robotLanguage',language);w.eval(publicFile('i18n.js'));
  const requests=[];
  async function call(path,options={}){
    const url=new URL(path,w.location.origin);
    const request={path:url.pathname+url.search,method:options.method??'GET',options};requests.push(request);
    assert.equal(request.method,'GET','performance UI never mutates accounts or declarations');
    if(url.pathname==='/api/bots')return ok({bots:fixture.bots,maxBots:5});
    if(url.pathname==='/api/me')return bookAnswer(request);
    if(['/api/paper-performance','/api/paper-performance/owner'].includes(url.pathname))return answer(request);
    throw Error('Unexpected UI request '+url.pathname);
  }
  w.fetch=async(path,options={})=>{
    const result=await call(path,options);
    return {status:result.status,ok:result.status>=200&&result.status<300,headers:{get:name=>name.toLowerCase()==='retry-after'?result.retryAfter??null:null},json:async()=>structuredClone(result.body)};
  };
  w.api=async(path,options={})=>{
    const result=await call(path,options);
    if(result.status>=400)throw Object.assign(Error(result.body.error),{status:result.status,code:result.body.code});
    return structuredClone(result.body);
  };
  w.eval('var authenticated='+JSON.stringify(authenticated)+',selectedBot="bot-1",me={user:{id:"owner-1"}},csrfToken="fixture-csrf";var load=async function(){};');
  w.load=async()=>sessionLoad(w,d);
  d.querySelector('#app').hidden=!authenticated;
  w.eval(panelSource??publicFile('paper-performance.js'));
  const get=id=>d.getElementById(id);
  const change=(id,value)=>{const node=get(id);const option=[...node.options??[]].find(o=>o.value.toLowerCase()===String(value).toLowerCase());node.value=option?.value??value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const boot=async()=>{await w.load();await settle();if(get('ppBot')?.options.length>1)change('ppBot','bot-1');};
  const load=async()=>{get('ppLoad').click();await settle();};
  const financial=()=>requests.filter(r=>r.path.startsWith('/api/paper-performance'));
  return {w,d,get,change,boot,load,requests,financial,text:()=>get('ppResult').textContent,close:()=>w.close()};
}
// Report text outside the coverage section (O7): coverage blocks add em dashes and metric words of their own.
const outsideCoverage=p=>{const clone=p.get('ppResult').cloneNode(true);clone.querySelector('.pp-coverage')?.remove();return clone.textContent;};

// Static i18n tables, loaded once with no translateUI observer and no page render. A pair collision is reported here by assertion;
// setup() refuses to render a page while one exists, so a collision never reaches a translateUI cycle that never ends.
let i18nStatic;
function staticI18n(){
  if(i18nStatic)return i18nStatic;
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  w.MutationObserver=class{observe(){}disconnect(){}};
  let pairs;
  try{
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=qr2CoveragePairs;');
    const mine=new Set(w.__mine);
    pairs=[...w.__pairs].map(pair=>({en:pair[0],th:pair[1],mine:mine.has(pair)}));
  }finally{w.close();}
  const mine=pairs.filter(pair=>pair.mine),others=pairs.filter(pair=>!pair.mine),texts=new Set(others.flatMap(pair=>[pair.en,pair.th]));
  const problems=[];
  if(new Set(mine.map(pair=>pair.en)).size!==mine.length)problems.push('duplicate EN in qr2CoveragePairs');
  if(new Set(mine.map(pair=>pair.th)).size!==mine.length)problems.push('duplicate TH in qr2CoveragePairs');
  const flat=mine.flatMap(pair=>[pair.en,pair.th]);
  if(new Set(flat).size!==flat.length)problems.push('an EN equals a TH inside qr2CoveragePairs');
  for(const {en,th} of mine){
    if(en===th)problems.push('EN equals TH: '+en);
    if(texts.has(en))problems.push('EN collides with an existing text: '+en);
    if(texts.has(th))problems.push('TH collides with an existing text: '+th);
    if(/[—€$฿]|USDT|THB|BTCUSDT/.test(en+th))problems.push('em dash, currency or market token in: '+en);
  }
  i18nStatic={pairs,mine,others,problems};
  return i18nStatic;
}

test('A13 qr2CoveragePairs is collision-free (static, before any page render)',()=>{
  const {mine,problems}=staticI18n();
  assert.equal(mine.length,31,"32 pairs before OD-S5-D: the two named range hints go, the C7 label comes");
  assert.deepEqual(problems,[],'no duplicate, no EN/TH collision with an existing text, no em dash, currency or market token');
});

test('synthetic QR2 UI bodies retain actual Bot and strict owner response contracts',()=>{
  for(const name of ['bot','botPartial','botUnavailable'])assert.equal(validateResponse(fixture[name]).ok,true,name);
  for(const name of ['owner','ownerTHB','ownerUndeclared'])assert.equal(validateOwnerResponse(fixture[name]),true,name);
  assert.deepEqual(fixture.refused,refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'history_days',max:30}));
  assert.deepEqual({status:fixture.retry.status,body:fixture.retry.body},refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'concurrency',max:1}));
});

test('performance section belongs to Overview; auth and explicit Load gate financial GETs',async()=>{
  const p=setup();
  try{
    const root=p.get('paperPerformance');assert.ok(root);
    assert.equal(root.closest('[data-page]')?.dataset.page,'overview');
    assert.equal(p.financial().length,0);
    await p.boot();
    assert.ok(p.requests.some(r=>r.path==='/api/bots'),'owned Bot options come from GET /api/bots');
    assert.match(p.get('ppBot').textContent,/Synthetic BTC/);
    assert.equal(p.get('ppBot').querySelector('img'),null,'Bot label is text');
    for(const [id,value] of [['ppBroker','binance-th'],['ppPeriod','WEEK'],['ppScope','owner'],['ppCurrency','THB']])p.change(id,value);
    await settle();assert.equal(p.financial().length,0,'selection changes never auto-load financial data');
  }finally{p.close();}
  const unauth=setup({authenticated:false});
  try{await unauth.boot();await unauth.load();assert.equal(unauth.financial().length,0,'signed-out user cannot load financial data');}
  finally{unauth.close();}
});

test('initial signed-out to authenticated load refreshes the prompt without a selection change or financial GET',async()=>{
  for(const [language,signedOut,prompt] of [
    ['en','Sign in to view Paper history.','Choose a scope and press Load / Refresh.'],
    ['th','เข้าสู่ระบบเพื่อดูประวัติ Paper','เลือกขอบเขตแล้วกด โหลด / รีเฟรช']
  ]){
    const session=deferred();
    const p=setup({authenticated:false,language,sessionLoad:async(w,d)=>{
      await session.promise;w.eval('authenticated=true');d.querySelector('#app').hidden=false;
    }});
    try{
      assert.equal(p.get('ppStatus').textContent,signedOut);
      assert.equal(p.get('ppLoad').disabled,true);
      const loading=p.w.load();await settle();
      assert.equal(p.get('ppLoad').disabled,true,'still disabled before the session resolves');
      assert.equal(p.requests.length,0,'signed-out boot starts no Bot or financial GET');
      session.resolve();await loading;await settle();
      assert.equal(p.get('ppStatus').textContent,prompt);
      assert.equal(p.get('ppLoad').disabled,false);
      assert.equal(p.get('app').hidden,false);
      assert.equal(p.get('ppBot').value,'','no synthetic selection change masks the boot transition');
      assert.match(p.get('ppBot').textContent,/Synthetic BTC/);
      assert.equal(p.financial().length,0,'authentication loads only the Bot list');
    }finally{session.resolve();p.close();}
  }
});

test('same-session refresh preserves completed and pending reports without financial auto-load',async()=>{
  const pending=deferred();let next=ok(fixture.bot);
  const p=setup({answer:()=>next});
  try{
    await p.boot();await p.load();
    const completed=p.get('ppResult').innerHTML,received=p.get('ppStatus').textContent;
    await p.w.load();await settle();
    assert.equal(p.get('ppResult').innerHTML,completed);
    assert.equal(p.get('ppStatus').textContent,received);
    assert.equal(p.financial().length,1);
    next=pending.promise;p.get('ppLoad').click();await settle();
    const loading=p.get('ppStatus').textContent;
    await p.w.load();await settle();
    assert.equal(p.get('ppStatus').textContent,loading);
    assert.equal(p.text(),'');
    assert.equal(p.get('paperPerformance').getAttribute('aria-busy'),'true');
    assert.equal(p.get('ppLoad').disabled,true,'session refresh must retain the pending Load gate');
    assert.equal(p.financial().length,2,'refresh starts no replacement report');
    pending.resolve(ok(fixture.bot));await settle();
    assert.equal(p.get('ppResult').innerHTML,completed,'pending report remains valid across refresh');
    assert.equal(p.get('ppStatus').textContent,received);
    assert.equal(p.get('ppLoad').disabled,false);
  }finally{pending.resolve(ok(fixture.bot));p.close();}
});

test('Bot rendering keeps decimal strings, method/range labels and Paper/book notices without arithmetic',async()=>{
  const p=setup();
  try{
    await p.boot();p.change('ppBot','bot-1');await p.load();
    const query=new URL(p.financial()[0].path,'https://robot.test');
    assert.equal(query.pathname,'/api/paper-performance');assert.equal(query.searchParams.get('bot_id'),'bot-1');
    assert.ok(p.text().includes('9007199254740993.123456789'),'precision beyond Number safe integers remains exact');
    assert.ok(p.text().includes('58.74'));assert.ok(p.text().includes('1.26'));
    assert.ok(p.text().includes(fixture.bot.valuation_method));
    assert.ok(p.text().includes(fixture.bot.range_flags[0]));
    for(const timestamp of [fixture.bot.requested_range.from,fixture.bot.requested_range.to,fixture.bot.resolved_range.to])assert.ok(p.text().includes(String(timestamp)),'server range endpoints remain visible');
    assert.match(p.get('paperPerformance').textContent,/Paper/);
    assert.match(p.get('paperPerformance').textContent,/book equity/i);
  }finally{p.close();}
});

test('owner currency and CUSTOM dates use owner GET without Bot selectors; null returns remain explained',async()=>{
  const p=setup({answer:()=>ok(fixture.ownerTHB)});
  try{
    await p.boot();p.change('ppScope','owner');p.change('ppCurrency','THB');p.change('ppPeriod','CUSTOM');
    p.get('ppFrom').value='2026-10-01';p.get('ppTo').value='2026-10-02';await p.load();
    const url=new URL(p.financial()[0].path,'https://robot.test');
    assert.equal(url.pathname,'/api/paper-performance/owner');assert.equal(url.searchParams.get('currency'),'THB');
    assert.equal(url.searchParams.get('from'),'2026-10-01');assert.equal(url.searchParams.get('to'),'2026-10-02');
    assert.equal(url.searchParams.has('bot_id'),false);assert.equal(url.searchParams.has('broker'),false);
    assert.match(p.text(),/THB/);assert.ok(p.text().includes('SUM_OF_INDEPENDENT_PAPER_ACCOUNTS'));
    assert.ok(p.text().includes('NOT_AN_OWNER_PORTFOLIO'));
    assert.match(p.text(),/Owner TWR and MWR are unavailable/);
    assert.equal(p.text().includes('USDT'),false,'one selected currency only in response values');
  }finally{p.close();}
});

test('missing owner declaration, PARTIAL overlays and UNAVAILABLE numbers remain explicit',async()=>{
  for(const [body,scope,expected] of [[fixture.ownerUndeclared,'owner','CAPITAL_MODEL_NOT_DECLARED'],[fixture.botPartial,'bot','TWR_BOUNDARY_UNVALUED'],[fixture.botUnavailable,'bot','RECONCILIATION_FAILED']]){
    const p=setup({answer:()=>ok(body)});
    try{await p.boot();p.change('ppScope',scope);await p.load();assert.ok(p.text().includes(expected));assert.ok(outsideCoverage(p).includes('—'));assert.ok((p.text()+p.get('ppStatus').textContent).includes(body.status.status));
      for(const overlay of body.status.overlays)assert.ok(p.text().includes(overlay));
    }finally{p.close();}
  }
});

test('pending, endpoint 404, request refusal and Retry-After replace prior financial values',async()=>{
  const pending=deferred();let next=ok(fixture.bot);const p=setup({answer:()=>next});
  try{
    await p.boot();await p.load();assert.ok(p.text().includes('9007199254740993.123456789'));
    next=pending.promise;p.get('ppLoad').click();await settle();
    assert.equal(p.text().includes('9007199254740993.123456789'),false,'pending must clear stale financial values');
    assert.match(p.get('ppStatus').textContent,/loading|pending/i);
    pending.resolve(fixture.notFound);await settle();
    assert.match(p.get('ppStatus').textContent+p.text(),/404|not found|unavailable/i);
    for(const response of [fixture.refused,fixture.retry]){
      next=response;await p.load();
      assert.ok((p.text()+p.get('ppStatus').textContent).includes(response.body.code));
      assert.equal(p.text().includes('9007199254740993.123456789'),false);
    }
    assert.match(p.get('ppStatus').textContent+p.text(),/2/,'retry seconds are visible');
  }finally{pending.resolve(ok(fixture.bot));p.close();}
});

test('422 range admission refusal adds a plain range hint; other statuses and limits add none',async()=>{
  const refusal=(status,detail)=>({status,body:{code:'QR2_RANGE_ADMISSION_REFUSED',error:'The request is over a limit',detail}});
  const cases=[
    [refusal(422,{limit:'timestamp_rows',value:30000,max:21600}),/too long for the performance report/,/a report size limit/],
    [refusal(422,{limit:'union_minutes',value:50000,max:43200}),/too long for the performance report/,/a report size limit/],
    [refusal(422,{limit:'unique_windows',value:9,max:8}),/too long for the performance report/,/a report size limit/],
    [refusal(422,{limit:'coverage_output_bytes',max:1000}),/too long for the performance report/,/a report size limit/],
    [refusal(422,undefined),/too long for the performance report/,/a report size limit/]
  ];
  let next=ok(fixture.bot);
  for(const scope of ['bot','owner']){
    const p=setup({answer:()=>next});
    try{
      await p.boot();p.change('ppScope',scope);
      for(const [response,generic,named] of cases){
        next=response;await p.load();
        const status=p.get('ppStatus').textContent;
        assert.match(status,/Paper performance request refused\./);
        assert.ok(status.includes('HTTP 422')&&status.includes('QR2_RANGE_ADMISSION_REFUSED'),'status line keeps status and code');
        assert.match(p.text(),generic);assert.match(p.text(),named);
        assert.match(p.text(),/shorter range, for example Week or a Custom range/);
        if(response.body.detail)assert.ok(p.text().includes(response.body.detail.limit),'detail list stays');
      }
      for(const response of [fixture.refused,fixture.retry,refusal(500,{limit:'timestamp_rows',max:1}),{status:422,body:{code:'OTHER',detail:{limit:'timestamp_rows'}}}]){
        next=response;await p.load();
        assert.doesNotMatch(p.text(),/too long for the performance report/,'no hint for '+response.status+' '+response.body.code);
        assert.ok(p.get('ppStatus').textContent.includes('HTTP '+response.status));
      }
    }finally{p.close();}
  }
});

test('422 range admission hint is shown in Thai with the Thai pair for each limit and names no day count',async()=>{
  const refusal=detail=>({status:422,body:{code:'QR2_RANGE_ADMISSION_REFUSED',error:'The request is over a limit',detail}});
  const cases=[[{limit:'timestamp_rows',max:21600},RANGE_HINTS[0],'ขีดจำกัดขนาดรายงาน'],[{limit:'union_minutes',max:43200},RANGE_HINTS[0],'ขีดจำกัดขนาดรายงาน'],[{limit:'unique_windows',max:8},RANGE_HINTS[0],'ขีดจำกัดขนาดรายงาน'],[undefined,RANGE_HINTS[0],'ขีดจำกัดขนาดรายงาน']];
  let next=ok(fixture.bot);
  const p=setup({language:'th',answer:()=>next});
  try{
    await p.boot();
    for(const [detail,english,fragment] of cases){
      next=refusal(detail);await p.load();
      const text=p.text();
      assert.ok(text.includes(thOf(p,english)),'Thai hint shown for '+(detail?.limit??'no detail'));
      assert.ok(text.includes(fragment));
      assert.ok(text.includes('ขนาดรายงาน'));
      assert.equal(/15 วัน|30 วัน/.test(text),false,'no day count in the hint');
      assert.ok(!text.includes(english),'English hint is not left untranslated');
    }
  }finally{p.close();}
});

test('selection change immediately invalidates pending and completed responses; late response cannot reappear',async()=>{
  const old=deferred(),p=setup({answer:()=>old.promise});
  try{
    await p.boot();p.get('ppLoad').click();await settle();p.change('ppCurrency','THB');
    assert.equal(p.text().includes('9007199254740993.123456789'),false);
    old.resolve(ok(fixture.bot));await settle();
    assert.equal(p.text().includes('9007199254740993.123456789'),false,'outdated response after selection change remains suppressed');
    assert.equal(p.financial().length,1,'selection change does not start a replacement financial GET');
  }finally{old.resolve(ok(fixture.bot));p.close();}
  const loaded=setup();
  try{await loaded.boot();await loaded.load();loaded.change('ppPeriod','YEAR');assert.equal(loaded.text().includes('9007199254740993.123456789'),false,'completed values are invalidated immediately');}
  finally{loaded.close();}
});

test('response codes and reasons render as safe text in English and Thai',async()=>{
  const attack='<img src=x onerror="window.qr2Unsafe=true">';
  for(const language of ['en','th']){
    const body=structuredClone(fixture.botPartial);body.status.reasons=[attack];body.account.twr.reasons=[attack];
    const p=setup({language,answer:()=>ok(body)});
    try{await p.boot();await p.load();assert.ok(p.text().includes(attack));assert.equal(p.get('ppResult').querySelector('img'),null);assert.equal(p.w.qr2Unsafe,undefined);}
    finally{p.close();}
  }
});

test('foreign scope, currency and basis responses fail closed; malformed financial numbers never become browser totals',async()=>{
  const mismatchedBot=structuredClone(fixture.bot);mismatchedBot.scope.bot_id='foreign-bot';
  const foreignBasis=structuredClone(fixture.bot);foreignBasis.basis='HYPOTHETICAL';
  for(const [body,scope] of [[mismatchedBot,'bot'],[foreignBasis,'bot'],[fixture.ownerTHB,'owner']]){
    const p=setup({answer:()=>ok(body)});
    try{await p.boot();p.change('ppScope',scope);await p.load();assert.equal(p.text().includes('9007199254740993.123456789'),false);assert.match(p.get('ppStatus').textContent,/QR2_RESPONSE_INVALID/);}
    finally{p.close();}
  }
  const malformed=structuredClone(fixture.bot);malformed.account.nav.value=9007199254740992;
  const p=setup({answer:()=>ok(malformed)});
  try{await p.boot();await p.load();assert.ok((p.text()+p.get('ppStatus').textContent).includes('QR2_NUMBER_INVALID')||p.get('ppStatus').textContent.includes('QR2_RESPONSE_INVALID'));assert.equal(p.text().includes('9007199254740992'),false);}
  finally{p.close();}
});

test('undeclared owner aggregate suppresses adversarial numeric fields with explicit reasons; owner returns never offered',async()=>{
  const body=structuredClone(fixture.owner);
  body.declaration_version=null;body.allocation={capital_model:null,version:null,reason:'CAPITAL_MODEL_NOT_DECLARED',effective_from:null};
  body.total.nav_to.value='999999999999999999.987654321';body.total.twr={value:'777777777777.777',status:'COMPLETE',reasons:[]};
  const p=setup({answer:()=>ok(body)});
  try{
    await p.boot();p.change('ppScope','owner');await p.load();
    assert.equal(p.text().includes('999999999999999999.987654321'),false,'no ineligible owner sum even if a malformed server body supplies one');
    assert.equal(p.text().includes('777777777777.777'),false,'no owner return number');
    assert.ok(p.get('ppStatus').textContent.includes('QR2_RESPONSE_INVALID'),'ineligible numeric owner aggregate is rejected as a malformed response');
  }finally{p.close();}
});

test('numeric owner totals require eligible allocation and matching owner currency scope',async()=>{
  const shared=structuredClone(fixture.owner);shared.allocation.capital_model='SHARED_HYPOTHETICAL';
  const changed=structuredClone(fixture.owner);changed.allocation.reason='ALLOCATION_DECLARATION_CHANGED';
  const wrongScope=structuredClone(fixture.owner);wrongScope.scope.currency='THB';
  for(const body of [shared,changed,wrongScope]){
    const p=setup({answer:()=>ok(body)});
    try{
      await p.boot();p.change('ppScope','owner');await p.load();
      assert.ok(p.get('ppStatus').textContent.includes('QR2_RESPONSE_INVALID'),'ineligible or currency-inconsistent numeric owner total fails closed');
      assert.equal(p.text().includes('1058.74'),false,'invalid aggregate and member values never render as a report');
    }finally{p.close();}
  }
});

test('book snapshot uses exact owned tuple and fresh explicit GET; owner view never requests book',async()=>{
  const p=setup();
  try{
    await p.boot();await p.load();
    const calls=p.requests.filter(r=>r.path.startsWith('/api/me?'));assert.equal(calls.length,1);
    assert.equal(calls[0].path,'/api/me?bot_id=bot-1');assert.equal(calls[0].options.cache,'no-store');
    assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.signal,p.financial()[0].options.signal);
    assert.equal(p.get('ppResult').querySelector('.pp-book strong').textContent,bookFixture().paperAccounts[0].bookEquity);
    assert.match(p.text(),/BOOK_EQUITY_COST_BASIS/);
    const old=p.get('ppResult').innerHTML;await p.w.load();assert.equal(p.get('ppResult').innerHTML,old);
  }finally{p.close();}
  const owner=setup({answer:()=>ok(fixture.owner)});
  try{await owner.boot();owner.change('ppScope','owner');await owner.load();assert.equal(owner.requests.some(r=>r.path.startsWith('/api/me?')),false);assert.equal(owner.get('ppResult').querySelector('.pp-equity-comparison'),null);}
  finally{owner.close();}
});

test('missing, malformed, refused or mismatched book stays unavailable beside valid marked report',async()=>{
  const variants=[null,{},...[
    b=>b.paperAccounts=[],b=>b.paperAccounts.push({...b.paperAccounts[0]}),b=>b.bot.id='foreign',b=>b.allBots=true,
    b=>b.moneyFormat='number',b=>b.paperAccounts[0].userId='foreign',b=>b.paperAccounts[0].bot_id='foreign',
    b=>b.paperAccounts[0].broker='binance-th',b=>b.paperAccounts[0].currency='THB',
    b=>b.paperAccounts[0].valuation='MARK_TO_MARKET',
    ...[null,123,'NaN','Infinity','1e9',' 10','01.2','+1','1.','1.1234567890123456789','123456789012345678901'].map(value=>b=>b.paperAccounts[0].bookEquity=value)
  ].map(edit=>{const b=bookFixture();edit(b);return b;})];
  for(const body of variants){
    const p=setup({bookAnswer:()=>ok(body)});
    try{await p.boot();await p.load();assert.equal(p.get('ppResult').querySelector('.pp-book strong')?.textContent,'—');assert.match(p.text(),/BOOK_/);assert.match(p.text(),/9007199254740993.123456789/);}
    finally{p.close();}
  }
  for(const response of [{status:403,body:{}},{status:500,body:{}}]){
    const p=setup({bookAnswer:()=>response});
    try{await p.boot();await p.load();assert.match(p.text(),/BOOK_REQUEST_REFUSED/);assert.match(p.text(),/9007199254740993.123456789/);}
    finally{p.close();}
  }
});

test('book pending pair survives same-session refresh; selection, logout, owner changes suppress late data',async()=>{
  for(const action of ['refresh','selection','logout','owner']){
    const pending=deferred(),p=setup({bookAnswer:()=>pending.promise});
    try{
      await p.boot();p.get('ppLoad').click();await settle();assert.equal(p.text(),'');assert.equal(p.get('ppLoad').disabled,true);
      if(action==='refresh'){await p.w.load();assert.equal(p.get('ppLoad').disabled,true);}
      if(action==='selection')p.change('ppPeriod','YEAR');
      if(action==='logout')p.get('logout').dispatchEvent(new p.w.Event('click'));
      if(action==='owner')p.w.eval('me.user.id="another-owner"');
      pending.resolve(ok(bookFixture()));await settle();
      if(action==='refresh')assert.match(p.text(),/BOOK_EQUITY_COST_BASIS/);
      else assert.equal(p.text(),'');
    }finally{pending.resolve(ok(bookFixture()));p.close();}
  }
});

test('401 from either source and wrong owner clear pair; unknown owner makes no report or book request',async()=>{
  for(const options of [
    {answer:()=>({status:401,body:{}})},
    {bookAnswer:()=>({status:401,body:{}})},
    {bookAnswer:()=>ok({...bookFixture(),user:{id:'foreign'}})}
  ]){
    const p=setup(options);
    try{await p.boot();await p.load();assert.equal(p.text(),'');assert.match(p.get('ppStatus').textContent,/Sign in/);assert.equal(p.get('ppLoad').disabled,true);}
    finally{p.close();}
  }
  const p=setup();
  try{await p.boot();p.w.eval('me={user:{}}');await p.load();assert.equal(p.financial().length,0);assert.match(p.get('ppStatus').textContent,/BOOK_OWNER_UNKNOWN/);}
  finally{p.close();}
});

test('EN/TH comparison labels distinguish current fetched book with no valuation time from historical marked range',async()=>{
  for(const [language,current,time,history,separate] of [
    ['en','Current account snapshot fetched','Book valuation time unavailable.','Historical marked report','Separate reads and snapshots'],
    ['th','ภาพบัญชีปัจจุบันที่ดึง','ไม่มีเวลาประเมินมูลค่า Book equity','รายงานมูลค่าตลาดย้อนหลัง','อ่านข้อมูลและบันทึกภาพแยกกัน']
  ]){
    const p=setup({language});
    try{await p.boot();await p.load();const book=p.get('ppResult').querySelector('.pp-book').textContent,marked=p.get('ppResult').querySelector('.pp-marked').textContent;assert.ok(book.includes(current));assert.ok(book.includes(time));assert.ok(marked.includes(history));assert.ok(p.text().includes(separate));assert.ok(!book.includes(String(fixture.bot.resolved_range.to)));assert.ok(marked.includes(String(fixture.bot.resolved_range.to)));assert.ok(p.text().includes(language==='th'?'Book equity ที่ใช้กำหนดขนาดคำสั่งเป็นคนละตัวเลข':'Book equity used for sizing is a different number.'));}
    finally{p.close();}
  }
});

test('supported ledger broker/currency pairs use matched account only; invalid report never requests book',async()=>{
  for(const broker of ['binance-th','innovestx','settrade']){
    const body=structuredClone(fixture.bot);body.scope.broker=broker;body.currency='THB';
    const book=bookFixture();book.paperAccounts[0].broker=broker;book.paperAccounts[0].currency='THB';
    const p=setup({answer:()=>ok(body),bookAnswer:()=>ok(book)});
    try{await p.boot();p.change('ppBroker',broker);await p.load();assert.equal(p.get('ppResult').querySelector('.pp-book strong')?.textContent,book.paperAccounts[0].bookEquity);}
    finally{p.close();}
  }
  const p=setup({answer:()=>ok({...fixture.bot,basis:'HYPOTHETICAL'})});
  try{await p.boot();await p.load();assert.equal(p.requests.some(r=>r.path.startsWith('/api/me?')),false);}
  finally{p.close();}
});

test('deferred book JSON and session expiry cannot revive previous pair',async()=>{
  const pending=deferred(),p=setup();
  try{
    await p.boot();const original=p.w.fetch;p.w.fetch=async(path,options)=>{
      const response=await original(path,options);
      if(path.startsWith('/api/me?'))response.json=async()=>{await pending.promise;return bookFixture();};
      return response;
    };
    p.get('ppLoad').click();await settle();p.w.eval('authenticated=false');await p.w.load();
    pending.resolve();await settle();assert.equal(p.text(),'');assert.equal(p.get('ppLoad').disabled,true);
  }finally{pending.resolve();p.close();}
});

const symbolFixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/qr2-performance-ui/symbol-responses.json',import.meta.url),'utf8'));

test('S5-3 producer-backed symbol fixtures pin price boundaries, exact decimals and request versus valuation time',()=>{
  // Generated by pure replay/rangePerformance/accountStatus/composer. Expectations below are independent literals:
  // 0.006 * 62000.123456789 = 372.000740740734; cost 360 gives unrealized 12.000740740734.
  for(const [key,state,age,to,status] of [
    ['fresh','FRESH',180000,1790813040000,'COMPLETE'],
    ['stale','STALE',900000,1790813760000,'COMPLETE'],
    ['unavailableOld','UNAVAILABLE',900001,1790813760001,'PARTIAL'],
    ['unavailableGap','UNAVAILABLE',null,1790813040000,'UNAVAILABLE']
  ]){
    const body=symbolFixtures[key],s=body.symbols[0];
    assert.equal(validateResponse(body).ok,true,key);assert.equal(body.status.status,status);
    assert.equal(body.as_of,1790816400000);assert.equal(body.resolved_range.to,to);
    assert.equal(s.price_state,state);assert.equal(s.price_age_ms,age);
    assert.equal(s.price_bar_time,key==='unavailableGap'?null:1790812860000);
    assert.equal(s.quantity.value,'0.006');assert.equal(s.cost_basis.value,'360');assert.equal(body.account.cash.value,'640');
    assert.equal(body.market_data.gap,null,'no gap interval or internal resolver reason is invented');
    for(const field of ['available_cash','reserved_notional','reserved_fees'])assert.deepEqual(body.account[field],{value:null,status:'UNAVAILABLE',reasons:['RESERVATION_HISTORY_NOT_RECORDED']},'historical reservations are not recorded');
    if(state==='UNAVAILABLE'){
      for(const field of ['price','market_value','unrealized_pnl'])assert.deepEqual(s[field],{value:null,status:'UNAVAILABLE',reasons:['UNAVAILABLE']});
      assert.equal(s.price_retrieval,null);
    }else{
      assert.deepEqual(s.price,{value:'62000.123456789',status:'COMPLETE',reasons:key==='stale'?['PRICE_STALE']:[]});
      assert.equal(s.market_value.value,'372.000740740734');assert.equal(s.unrealized_pnl.value,'12.000740740734');
      assert.equal(s.price_retrieval,'RETRIEVED_AFTER_INSTANT');
    }
  }
});

test('S5-3 EN/TH symbol metadata preserves values, null reasons and a human-readable late price notice',async()=>{
  for(const [language,notice] of [['en','Price recorded later.'],['th','ราคาถูกบันทึกภายหลัง']]){
    let body=symbolFixtures.fresh;
    const p=setup({language,answer:()=>ok(body)});
    try{
      await p.boot();
      for(const key of ['fresh','stale','unavailableOld','unavailableGap']){
        body=symbolFixtures[key];await p.load();
        const result=p.get('ppResult');
        const terms=[...result.querySelectorAll('dt')];
        const cell=name=>terms.find(n=>n.textContent===name)?.nextElementSibling;
        assert.equal(cell('price_state').textContent,body.symbols[0].price_state);
        assert.equal(cell('price_age_ms').textContent,body.symbols[0].price_age_ms===null?'—':String(body.symbols[0].price_age_ms));
        assert.equal(cell('price_bar_time').textContent,body.symbols[0].price_bar_time===null?'—':String(body.symbols[0].price_bar_time));
        assert.ok(p.text().includes(String(body.as_of)));assert.ok(p.text().includes(String(body.resolved_range.to)));
        if(key==='fresh'||key==='stale'){
          assert.equal(cell('price').querySelector('strong').textContent,'62000.123456789');
          assert.ok(cell('price_retrieval').textContent.includes('RETRIEVED_AFTER_INSTANT'));
          assert.ok(cell('price_retrieval').textContent.includes(notice),'late retrieval needs human-readable notice');
          if(key==='stale')assert.ok(cell('price').textContent.includes('PRICE_STALE'));
        }else{
          assert.equal(cell('price').querySelector('strong').textContent,'—');
          assert.ok(cell('price').textContent.includes('UNAVAILABLE'));
          assert.equal(cell('price_retrieval').textContent,'—');
          assert.equal(p.text().includes('62000.123456789'),false,'previous numeric price never survives an unavailable response');
          assert.equal(p.text().includes(notice),false);
          assert.equal(p.text().includes('NO_PRICE_ROW'),false);assert.equal(p.text().includes('PRICE_OLDER_THAN_CARRY'),false);
        }
      }
      assert.equal(p.financial().length,4);assert.ok(p.requests.every(r=>r.method==='GET'));
    }finally{p.close();}
  }
});

test('O6 the generic metadata view shows no raw coverage and never mutates the body',async()=>{
  const bot=structuredClone(fixture.bot),owner=structuredClone(fixture.owner);
  const botBefore=JSON.stringify(bot),ownerBefore=JSON.stringify(owner);
  const notCovered=structuredClone(fixture.bot);delete notCovered.market_data.coverage;
  const sentinels=['qr2-owner-bar-coverage-v1','qr2-bar-coverage-v1','coverage:0','market_coverage','pine_market_bars'];
  const metadataKeys=p=>{
    const details=[...p.get('ppResult').querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Server status, methods and range evidence');
    assert.ok(details,'the server metadata details element exists');
    return [...details.querySelectorAll('dt')].map(node=>node.textContent);
  };
  const baseline=setup({answer:()=>ok(notCovered)});let baselineOutside;
  try{
    await baseline.boot();baseline.change('ppBot','bot-1');await baseline.load();baselineOutside=outsideCoverage(baseline);
    assert.ok(baseline.get('ppResult').querySelector('.pp-coverage').textContent.includes('Bar coverage not supplied by this response.'));
  }finally{baseline.close();}
  const p=setup({answer:()=>ok(bot)});
  try{
    await p.boot();p.change('ppBot','bot-1');await p.load();
    for(const sentinel of sentinels)assert.equal(p.text().includes(sentinel),false,'Bot view: '+sentinel);
    const keys=metadataKeys(p);
    for(const key of ['checked','table_present','instants','bars','gap','market_data'])assert.ok(keys.includes(key),'the existing market_data scalar still renders: '+key);
    assert.equal(keys.includes('coverage')||keys.includes('market_coverage'),false,'the details element holds no coverage key');
    assert.ok(p.get('ppResult').querySelector('.pp-coverage .pp-cov-block'),'the producer-built coverage renders as a coverage block');
    assert.equal(outsideCoverage(p),baselineOutside,'outside the coverage section the Bot view is the same with and without coverage');
    assert.equal(JSON.stringify(bot),botBefore,'the input body is unchanged by rendering');
  }finally{p.close();}
  const q=setup({answer:()=>ok(owner)});
  try{
    await q.boot();q.change('ppScope','owner');q.change('ppCurrency','USDT');await q.load();
    assert.ok(q.text().length>0);assert.ok(q.text().includes('SUM_OF_INDEPENDENT_PAPER_ACCOUNTS')||q.text().includes('allocation'));
    for(const sentinel of sentinels)assert.equal(q.text().includes(sentinel),false,'owner view: '+sentinel);
    const keys=metadataKeys(q);
    assert.equal(keys.includes('coverage')||keys.includes('market_coverage'),false,'the owner details element holds no coverage key');
    assert.ok(q.get('ppResult').querySelector('.pp-coverage .pp-cov-block'));
    assert.equal(JSON.stringify(owner),ownerBefore,'the owner body is unchanged by rendering');
  }finally{q.close();}
});

/* ------------------------------------------------------------------ O7 coverage rendering */

const M=60000;
// Label table of the O7 packet. EN texts come only from here, never from the implementation.
const EN={
  heading:'Market bar coverage',
  notices:[
    'Bar gaps are listed as the server reports them. No gap is filled or interpolated. Only a gap at a needed valuation point changes a number.',
    'The valuation check (market_data.checked and market_data.gap) covers only the bars needed at valuation points. Bar coverage covers every complete 1-minute candle in the range. The two can differ.',
    'Only complete 1-minute candles are inspected. Partial candles at the range edges are excluded.',
    'Inspection completed means every 1-minute slot in the inspected window was checked for a stored candle. Partial edge candles are outside this check.',
    'Each time is shown as UTC epoch milliseconds followed by the same instant in ISO 8601 UTC in parentheses.'
  ],
  owner:'Coverage is shown per market and range. Accounts with the same market and range share one coverage entry. Coverage is never summed across accounts.',
  absent:'Bar coverage not supplied by this response.',
  unresolved:'No bar coverage: the report range is unresolved.',
  klass:{
    C1:'Inspection completed; gaps found.',
    C2:'Inspection completed; no stored candle is missing from the inspected window.',
    C3:'No inspection: the range for this coverage is unresolved.',
    C4:'No inspection: the range holds no complete 1-minute candle.',
    C5:'Inspection unavailable: bar coverage is reported only for the one supported Binance Global spot 1-minute market.',
    C6:'Inspection unavailable: the market data table is absent. This is not stored history with no bars.',
    C7:'Inspection unavailable: this range is over the bar coverage check limit, so bar coverage was not checked. The financial figures and their price checks are not affected. Choose a shorter range, for example Week, to see bar coverage.'
  },
  rows:{result:'Inspection result',market:'Market',range:'Coverage range',window:'Inspected window',edges:'Excluded partial candles',expected:'Expected minutes',stored:'Stored minutes',missing:'Missing minutes',count:'Gap intervals',accounts:'Accounts using this coverage'},
  list:'Gap interval list, count:',
  caption:'Each row: start - end : missing minutes. Start inclusive, end exclusive.'
};
const RANGE_HINTS=["The chosen range is too long for the performance report (a report size limit was reached). A shorter range, for example Week or a Custom range, should work."];
const newEnglish=[EN.heading,...EN.notices,EN.owner,EN.absent,EN.unresolved,...Object.values(EN.klass),'Inspection result','State code','Reason code','Timeframe (minutes)','Coverage range','Inspected window','Excluded partial candles','Expected minutes','Stored minutes','Missing minutes','Gap intervals',EN.list,EN.caption,'Accounts using this coverage',...RANGE_HINTS];
const reusedEnglish=['Market','Broker','Symbol','From','To','Reason','None','Bot'];
const timeForm=value=>String(value)+' ('+new Date(value).toISOString()+')';
const intervalForm=item=>timeForm(item.from)+' - '+timeForm(item.to)+' : '+String(item.missing_minutes);
// TH text comes from public/i18n.js by EN text (last pair wins, as in uiTranslations), from the static table loaded once above.
let thTable;
function thOf(p,en){
  if(!thTable)thTable=new Map(staticI18n().pairs.map(pair=>[pair.en,pair.th]));
  assert.ok(thTable.has(en),'a Thai pair exists for: '+en);
  return thTable.get(en);
}
const shown=(p,language,en)=>language==='th'?thOf(p,en):en;
const sectionOf=p=>p.get('ppResult').querySelector('.pp-coverage');
const coveragesOf=body=>body.scope?.kind==='OWNER'?(body.market_coverage?.entries.map(e=>e.coverage)??[]):[body.market_data.coverage];
// One shared page per language keeps the file inside its time bound. view() loads one body and returns the page with only its own requests.
// fresh:true gives a private page that the caller closes (the language toggle and timing cases).
const sharedPages=new Map();
after(()=>{for(const page of sharedPages.values())page.p.close();});
async function view(body,{language='en',fresh=false}={}){
  const owner=body.scope?.kind==='OWNER';
  let page;
  if(fresh||!sharedPages.has(language)){
    page={next:body};
    // Shared pages run without the translateUI observer (labels still translate); private pages keep it.
    page.p=setup({language,answer:()=>ok(page.next),observe:fresh});
    await page.p.boot();
    if(!fresh)sharedPages.set(language,page);
  }else page=sharedPages.get(language);
  const p=page.p;
  page.next=body;
  if(owner){p.change('ppScope','owner');p.change('ppCurrency',body.currency);}
  else{p.change('ppScope','bot');p.change('ppBot','bot-1');p.change('ppBroker',body.scope.broker);}
  const mark=p.requests.length;
  await p.load();
  const lent={...p,close:fresh?()=>p.close():()=>{}};
  Object.defineProperty(lent,'requests',{get:()=>p.requests.slice(mark)});
  return lent;
}
// Stored candles of a union window from a fixture fact spec. Timestamps are close times; missing ranges are open times.
function timestampsOf(window,spec){
  if(spec.state!=='COMPLETE')return null;
  const gone=new Set();
  for(const range of spec.missing??[])for(let t=range.from;t<range.to;t+=M)gone.add(t);
  if(spec.missing_every_other)for(let k=0;k<spec.missing_every_other.count;k++)gone.add(spec.missing_every_other.first+2*k*M);
  const out=[];
  for(let t=window.from;t<window.to;t+=M)if(!gone.has(t))out.push(t+M);
  return out;
}
function projectFacts({context,unions}){
  const plan=planCoverageUncapped(context);
  assert.equal(plan.unions.length,unions.length,'one fact spec per union');
  if(unions.length&&unions.every(u=>u.state==='BUDGET_EXCEEDED')){
    const [{limit}]=unions;
    return projectPublicCoverage(buildDegradedCoverageSnapshot({accounts:context.accounts,budgets:context.budgets,limit}),context);
  }
  const facts=plan.unions.map((union,i)=>unions[i].state==='COMPLETE'?{state:'COMPLETE',timestamps:timestampsOf(union.window,unions[i])}:{state:'TABLE_ABSENT'});
  return projectPublicCoverage(buildCoverageSnapshot({accounts:context.accounts,budgets:context.budgets,facts}),context);
}
// Test-local form of the conditional presence rule (B1 is held): absent for REFUSED or a null range, present otherwise.
const presenceRule=body=>Object.hasOwn(body,'market_coverage')===(body.status.status!=='REFUSED'&&body.resolved_range!==null);
const allCases=()=>Object.entries(covFx.cases);
const botCases=()=>allCases().filter(([,c])=>c.scope==='bot');
const ownerCases=()=>allCases().filter(([,c])=>c.scope==='owner');

test('A1 coverage fixtures are producer-built from recorded facts and cover every class',()=>{
  assert.deepEqual(covFx.budgets,{...QR2_COVERAGE_LIMITS});
  const classes=new Set();
  const checkBot=(name,facts,body)=>{
    const coverage=projectFacts(facts).accounts[0].market_data.coverage;
    assert.deepEqual(body.market_data.coverage,coverage,name);
    const bare=structuredClone(body);delete bare.market_data.coverage;
    assert.deepEqual(composePerformanceResponse({},{requestTime:1,coverage,build:()=>structuredClone(bare)}),body,name+': the composer accepts the body with this coverage');
    assert.equal(validateResponse(body).ok,true,name);
    assert.deepEqual(coverage.resolved_range,body.resolved_range,name+': coverage range equals the header range');
    assert.equal(coverage.market===null,body.scope.broker!=='binance-global',name+': market is null exactly when the broker is not binance-global');
    classes.add(coverage.state+'/'+coverage.reason+'/'+(coverage.interval_count>0));
  };
  const checkOwner=(name,facts,body)=>{
    if(facts!==null)assert.deepEqual(body.market_coverage,projectFacts(facts).owner.market_coverage,name);
    else assert.equal(Object.hasOwn(body,'market_coverage'),false,name);
    assert.equal(validateOwnerResponse(body),true,name+': validateOwnerResponse as it stands');
    assert.equal(presenceRule(body),true,name+': conditional presence rule');
    for(const c of coveragesOf(body))classes.add(c.state+'/'+c.reason+'/'+(c.interval_count>0));
  };
  for(const name of ['bot','botPartial','botUnavailable'])checkBot(name,covFx.responsesFacts[name],fixture[name]);
  for(const name of ['owner','ownerTHB','ownerUndeclared'])checkOwner(name,covFx.responsesFacts[name],fixture[name]);
  for(const [name,c] of botCases())checkBot(name,c.facts,c.body);
  for(const [name,c] of ownerCases())checkOwner(name,c.facts,c.body);
  assert.deepEqual([...classes].sort(),['COMPLETE/null/false','COMPLETE/null/true','EMPTY/NO_FULL_CANDLES/false','EMPTY/RANGE_UNRESOLVED/false','UNAVAILABLE/COVERAGE_BUDGET_EXCEEDED/false','UNAVAILABLE/MARKET_DATA_TABLE_ABSENT/false','UNAVAILABLE/UNSUPPORTED_MARKET/false'],'C1 to C7 are all present');
  // C1 with leading, internal and trailing gaps and two excluded edges; the intervals equal the documented missing ranges.
  const c1=covFx.cases.botC1,cov=c1.body.market_data.coverage;
  assert.deepEqual(cov.intervals.map(i=>({from:i.from,to:i.to})),c1.facts.unions[0].missing);
  assert.equal(cov.intervals[0].from,cov.inspected_window.from);assert.equal(cov.intervals.at(-1).to,cov.inspected_window.to);
  assert.equal(cov.excluded_edges.length,2);assert.ok(cov.intervals.length>=3);
  // 4096-interval maximum.
  const max=covFx.cases.ownerMax.body.market_coverage.entries[0].coverage;
  assert.equal(max.interval_count,QR2_COVERAGE_LIMITS.output_intervals);assert.equal(max.intervals.length,4096);
  // Shared entry, unsupported entry, null range, differing member ranges, C3 under a resolved range, long markup bot id.
  const multi=covFx.cases.ownerMulti.body.market_coverage;
  assert.ok(multi.entries.some(e=>multi.accounts.filter(a=>a.coverage_ids[0]===e.id).length===2));
  assert.ok(Object.values(covFx.cases.ownerUnsupported.body.market_coverage.entries).every(e=>e.coverage.market===null));
  assert.equal(Object.hasOwn(covFx.cases.ownerNull.body,'market_coverage'),false);assert.equal(covFx.cases.ownerNull.body.resolved_range,null);
  const ranges=covFx.cases.ownerRanges;
  const sameMarket=ranges.body.market_coverage.entries.map(e=>e.coverage).filter(c=>c.market!==null&&c.resolved_range!==null);
  assert.ok(new Set(sameMarket.map(c=>JSON.stringify(c.resolved_range))).size>=2,'one market with different member ranges');
  assert.deepEqual(ranges.producer_only,['coverage:0']);assert.equal(ranges.body.market_coverage.entries[0].coverage.reason,'RANGE_UNRESOLVED');assert.notEqual(ranges.body.resolved_range,null);
  const markup=covFx.cases.ownerMarkup.body.market_coverage.accounts[0].bot_id;
  assert.ok(markup.length>=4096&&markup.includes('<img'));
  // Fixture bodies for the six existing responses differ from the earlier values only by the coverage keys.
  for(const name of ['bot','botPartial','botUnavailable']){const bare=structuredClone(fixture[name]);delete bare.market_data.coverage;assert.deepEqual(bare.market_data,{checked:true,table_present:true,instants:2,bars:1,gap:null});}
});

// Checks one rendered coverage block against its coverage object, EN or TH.
function checkBlock(p,language,block,coverage,cls){
  const L=en=>shown(p,language,en);
  assert.equal(block.dataset.covClass,cls);
  assert.equal(block.querySelector('.pp-cov-class').textContent,L(EN.klass[cls]));
  const row=key=>block.querySelector('[data-cov-row="'+key+'"]');
  for(const [key,en] of Object.entries(EN.rows)){
    if(key==='accounts')continue;
    assert.equal(row(key).querySelector('dt').textContent,L(en),key+' label');
  }
  const field=(key,name)=>row(key).querySelector('[data-cov-field="'+name+'"]').textContent;
  assert.equal(field('result','state'),coverage.state);
  assert.equal(field('result','reason'),coverage.reason===null?'—':coverage.reason);
  assert.deepEqual([...row('result').querySelectorAll('.pp-cov-pair > [data-ui-label]')].map(n=>n.textContent),[L('State code'),L('Reason code')]);
  const dd=key=>row(key).querySelector('dd').textContent;
  if(coverage.market===null)assert.equal(dd('market'),'—');
  else{
    assert.equal(field('market','broker'),coverage.market.broker);assert.equal(field('market','symbol'),coverage.market.symbol);assert.equal(field('market','timeframe'),coverage.market.timeframe);
    assert.deepEqual([...row('market').querySelectorAll('.pp-cov-pair > [data-ui-label]')].map(n=>n.textContent),[L('Broker'),L('Symbol'),L('Timeframe (minutes)')]);
  }
  for(const [key,range] of [['range',coverage.resolved_range],['window',coverage.inspected_window]]){
    if(range===null)assert.equal(dd(key),'—',key);
    else{
      assert.equal(field(key,'from'),timeForm(range.from));assert.equal(field(key,'to'),timeForm(range.to));
      assert.deepEqual([...row(key).querySelectorAll('.pp-cov-pair > [data-ui-label]')].map(n=>n.textContent),[L('From'),L('To')]);
    }
  }
  const items=[...row('edges').querySelectorAll('li')];
  if(coverage.excluded_edges.length===0){assert.equal(items.length,0);assert.equal(dd('edges'),L('None'));}
  else{
    assert.equal(items.length,coverage.excluded_edges.length);
    coverage.excluded_edges.forEach((edge,i)=>{
      const get=name=>items[i].querySelector('[data-cov-field="'+name+'"]').textContent;
      assert.equal(get('from'),timeForm(edge.from));assert.equal(get('to'),timeForm(edge.to));assert.equal(get('edge-reason'),edge.reason);
      assert.deepEqual([...items[i].querySelectorAll('.pp-cov-pair > [data-ui-label]')].map(n=>n.textContent),[L('From'),L('To'),L('Reason')]);
    });
  }
  for(const [key,value] of [['expected',coverage.expected_minutes],['stored',coverage.stored_minutes],['missing',coverage.missing_minutes],['count',coverage.interval_count]]){
    assert.equal(field(key,'value'),value===null?'—':String(value),key);
    assert.equal(dd(key),value===null?'— · '+coverage.reason:String(value),key+' text');
  }
  const details=block.querySelector('details');
  if(cls!=='C1'){assert.equal(details,null);return;}
  assert.equal(details.querySelector('summary').textContent,L(EN.list)+' '+String(coverage.interval_count));
  assert.equal(details.open,coverage.interval_count<=10);
  assert.equal(details.querySelector('p').textContent,L(EN.caption));
  const lines=[...details.querySelectorAll('ul > li')];
  assert.deepEqual(lines.map(li=>li.textContent),coverage.intervals.map(intervalForm));
  assert.ok(lines.every(li=>li.childNodes.length===1&&li.firstChild.nodeType===3),'one text node per interval');
}
const checkNotices=(p,language,section,{owner,extra})=>{
  const expected=[...EN.notices,...(owner?[EN.owner]:[]),...(extra?[extra]:[])].map(en=>shown(p,language,en));
  assert.deepEqual([...section.querySelectorAll(':scope > .pp-cov-notice')].map(n=>n.textContent),expected);
  assert.equal(section.querySelector(':scope > h4').textContent,shown(p,language,EN.heading));
};

test('A2 per-Bot classes C1 to C7 render labels, raw codes, ranges, counts and intervals in EN and TH',async()=>{
  const classOf={botC1:'C1',botC2:'C2',botC3:'C3',botC4:'C4',botC5:'C5',botC6:'C6',botC7:'C7'};
  for(const language of ['en','th'])for(const [name,cls] of Object.entries(classOf)){
    const body=covFx.cases[name].body,p=await view(body,{language});
    try{
      const section=sectionOf(p);assert.ok(section,name);
      checkNotices(p,language,section,{owner:false});
      const blocks=section.querySelectorAll('.pp-cov-block');assert.equal(blocks.length,1);
      checkBlock(p,language,blocks[0],body.market_data.coverage,cls);
      assert.equal(section.querySelector('[data-cov-row="accounts"]'),null,'no account row in the per-Bot section');
      for(const hidden of ['qr2-bar-coverage-v1','pine_market_bars','coverage:0'])assert.equal(p.text().includes(hidden),false,hidden);
    }finally{p.close();}
  }
  const placed=await view(covFx.cases.botC1.body);
  try{
    const children=[...placed.get('ppResult').children];
    const at=children.findIndex(n=>n.classList?.contains('pp-coverage'));
    assert.ok(at>0&&children[at-1].classList.contains('pp-metrics'),'the section follows the metrics grid');
    assert.equal(children[at+1].tagName,'DETAILS','the section precedes the server details element');
  }finally{placed.close();}
});

test('A3 owner coverage maps entries and accounts in server order with no sums',async()=>{
  for(const language of ['en','th'])for(const name of ['ownerMulti','ownerUnsupported','ownerRanges','ownerC7']){
    const body=covFx.cases[name].body,envelope=body.market_coverage,p=await view(body,{language});
    try{
      const section=sectionOf(p);
      checkNotices(p,language,section,{owner:true});
      const blocks=[...section.querySelectorAll(':scope > .pp-cov-block')];
      assert.equal(blocks.length,envelope.entries.length);
      envelope.entries.forEach((entry,i)=>{
        const cls={'COMPLETE/null':entry.coverage.interval_count>0?'C1':'C2','EMPTY/RANGE_UNRESOLVED':'C3','EMPTY/NO_FULL_CANDLES':'C4','UNAVAILABLE/UNSUPPORTED_MARKET':'C5','UNAVAILABLE/MARKET_DATA_TABLE_ABSENT':'C6','UNAVAILABLE/COVERAGE_BUDGET_EXCEEDED':'C7'}[entry.coverage.state+'/'+entry.coverage.reason];
        checkBlock(p,language,blocks[i],entry.coverage,cls);
        const expectedAccounts=envelope.accounts.filter(a=>a.coverage_ids[0]===entry.id);
        const rows=[...blocks[i].querySelectorAll('[data-cov-row="accounts"] li')];
        assert.equal(blocks[i].querySelector('[data-cov-row="accounts"] dt').textContent,shown(p,language,EN.rows.accounts));
        assert.deepEqual(rows.map(li=>[li.querySelector('[data-cov-field="bot"]').textContent,li.querySelector('[data-cov-field="account-broker"]').textContent]),expectedAccounts.map(a=>[a.bot_id,a.broker]));
        assert.deepEqual([...rows[0].querySelectorAll('.pp-cov-pair > [data-ui-label]')].map(n=>n.textContent),[shown(p,language,'Bot'),shown(p,language,'Broker')]);
      });
      const listed=[...section.querySelectorAll('[data-cov-field="bot"]')].map(n=>n.textContent);
      assert.deepEqual(listed,envelope.entries.flatMap(entry=>envelope.accounts.filter(a=>a.coverage_ids[0]===entry.id).map(a=>a.bot_id)),'every account listed once, under its own entry');
      assert.equal(section.textContent.includes('owner-1'),false,'NO_ACCOUNT rows get no coverage row');
      // No-sum rule: no total or sum label; every count element shows its own entry value.
      for(const node of section.querySelectorAll('dt,summary,h4'))assert.equal(/total|sum/i.test(node.textContent),false,node.textContent);
      const values=[...section.querySelectorAll('[data-cov-field="value"]')].map(n=>n.textContent);
      assert.deepEqual(values,envelope.entries.flatMap(e=>[e.coverage.expected_minutes,e.coverage.stored_minutes,e.coverage.missing_minutes,e.coverage.interval_count].map(v=>v===null?'—':String(v))));
    }finally{p.close();}
  }
  const shared=covFx.cases.ownerMulti.body.market_coverage,sharedId=shared.entries.find(e=>shared.accounts.filter(a=>a.coverage_ids[0]===e.id).length===2).id;
  const p=await view(covFx.cases.ownerMulti.body);
  try{
    const blocks=[...sectionOf(p).querySelectorAll(':scope > .pp-cov-block')];
    const at=blocks[Number(sharedId.slice(9))];
    assert.deepEqual([...at.querySelectorAll('[data-cov-field="bot"]')].map(n=>n.textContent),['bot-a','bot-b']);
    assert.equal(blocks.filter(b=>b.querySelector('[data-cov-field="bot"]').textContent==='bot-a').length,1,'a shared entry renders once');
  }finally{p.close();}
  const thb=await view(fixture.ownerTHB);
  try{
    assert.equal(sectionOf(thb).querySelector('.pp-cov-block').dataset.covClass,'C5');
    assert.equal(thb.text().includes('USDT'),false,'the THB view shows no market token');
  }finally{thb.close();}
});

test('A4 presence branches: not supplied, null range, refused bodies and symbol fixtures',async()=>{
  const bareBot=structuredClone(fixture.bot);delete bareBot.market_data.coverage;
  const bareOwner=structuredClone(fixture.owner);delete bareOwner.market_coverage;
  for(const language of ['en','th']){
    for(const [body,owner,extra] of [[bareBot,false,EN.absent],[bareOwner,true,EN.absent],[covFx.cases.ownerNull.body,true,EN.unresolved]]){
      const p=await view(body,{language});
      try{
        const section=sectionOf(p);checkNotices(p,language,section,{owner,extra});
        assert.equal(section.querySelector('.pp-cov-block'),null);
        assert.equal(section.children.length,1+EN.notices.length+(owner?1:0)+1,'heading, notices and the branch notice only');
      }finally{p.close();}
    }
  }
  const junk={version:'junk',state:'X'};
  const refusedBot=structuredClone(fixture.bot);refusedBot.status={status:'REFUSED',overlays:[],reasons:['QR2_RANGE_ADMISSION_REFUSED']};refusedBot.code='QR2_RANGE_ADMISSION_REFUSED';
  const refusedBotJunk=structuredClone(refusedBot);refusedBotJunk.market_data.coverage=junk;
  const refusedOwner=structuredClone(fixture.owner);refusedOwner.status={status:'REFUSED',overlays:[],reasons:['QR2_RANGE_ADMISSION_REFUSED']};refusedOwner.code='QR2_RANGE_ADMISSION_REFUSED';
  const refusedOwnerJunk=structuredClone(refusedOwner);refusedOwnerJunk.market_coverage=junk;
  for(const body of [refusedBot,refusedBotJunk,refusedOwner,refusedOwnerJunk]){
    const p=await view(body);
    try{
      assert.equal(sectionOf(p),null,'no coverage section');
      assert.match(p.get('ppStatus').textContent,/Paper performance request refused\./);
      assert.equal(p.get('ppStatus').textContent.includes('QR2_RESPONSE_INVALID'),false,'coverage keys on a REFUSED body are ignored');
    }finally{p.close();}
  }
  for(const language of ['en','th'])for(const key of Object.keys(symbolFixtures)){
    const p=await view(symbolFixtures[key],{language});
    try{
      const section=sectionOf(p);checkNotices(p,language,section,{owner:false,extra:EN.absent});
      assert.equal(section.querySelector('.pp-cov-block'),null);
      assert.equal(section.textContent.includes('ราคาถูกบันทึกภายหลัง'),false,'no late-price notice text in the coverage section');
    }finally{p.close();}
  }
});

test('A5 the 4096-interval list renders in full, closed, one text node per row; timing observed only',async t=>{
  const body=covFx.cases.ownerMax.body,coverage=body.market_coverage.entries[0].coverage;
  const started=performance.now();
  const p=await view(body,{fresh:true});
  const renderMs=performance.now()-started;
  try{
    const section=sectionOf(p),details=section.querySelector('details');
    assert.equal(details.open,false);
    const lines=[...details.querySelectorAll('ul > li')];
    assert.equal(lines.length,coverage.interval_count);assert.equal(lines.length,4096);
    assert.ok(lines.every(li=>li.childNodes.length===1&&li.firstChild.nodeType===3));
    assert.equal(lines[0].textContent,intervalForm(coverage.intervals[0]));assert.equal(lines.at(-1).textContent,intervalForm(coverage.intervals.at(-1)));
    assert.equal(/\bmore\b|truncat|omitted|sample/i.test(section.textContent),false);
    assert.equal(details.querySelector('summary').textContent,EN.list+' 4096');
    const before=performance.now();p.w.eval('translateUI()');const translateMs=performance.now()-before;
    t.diagnostic('A5 observation JSDOM load plus render of the 4096-interval owner body: '+renderMs.toFixed(1)+' ms; one translateUI call over the rendered page: '+translateMs.toFixed(1)+' ms (observation only, no bar)');
  }finally{p.close();}
});

test('A6 server strings in coverage render as text in EN and TH; no unsafe sink in the source',async()=>{
  const attack='<img src=x onerror="window.qr2Unsafe=true">';
  for(const language of ['en','th']){
    const body=structuredClone(covFx.cases.ownerMulti.body);
    body.market_coverage.accounts[0].bot_id=attack;body.market_coverage.accounts[0].broker=attack;
    const row=body.accounts.find(a=>a.bot_id==='bot-a');row.bot_id=attack;row.broker=attack;
    const p=await view(body,{language});
    try{
      assert.ok(sectionOf(p).textContent.includes(attack));
      assert.equal(p.get('ppResult').querySelector('img'),null);assert.equal(p.w.qr2Unsafe,undefined);
    }finally{p.close();}
    const long=await view(covFx.cases.ownerMarkup.body,{language});
    try{
      const id=covFx.cases.ownerMarkup.body.market_coverage.accounts[0].bot_id;
      assert.ok(sectionOf(long).textContent.includes(id));
      assert.equal(long.get('ppResult').querySelector('img'),null);assert.equal(long.w.qr2Unsafe,undefined);
    }finally{long.close();}
  }
  const source=publicFile('paper-performance.js');
  for(const sink of [/\binnerHTML\b/,/\bouterHTML\b/,/insertAdjacentHTML/,/document\s*\.\s*write/,/\beval\s*\(/,/\bFunction\b/,/setAttribute\s*\(\s*['"]on/,/\.srcdoc\b/])assert.equal(sink.test(source),false,String(sink));
});

test('A7 malformed coverage fails closed with no earlier report and no book request',async()=>{
  const bot=()=>structuredClone(covFx.cases.botC1.body),cov=body=>body.market_data.coverage;
  const botBy=(base,edit)=>()=>{const body=structuredClone(covFx.cases[base].body);edit(cov(body));return body;};
  const bad=[];
  const add=(name,make)=>bad.push({name,make,owner:false});
  const addOwner=(name,edit,base='ownerMulti')=>bad.push({name,owner:true,make:()=>{const body=structuredClone(covFx.cases[base].body);edit(body.market_coverage,body);return body;}});
  add('version',botBy('botC1',c=>{c.version='qr2-bar-coverage-v2';}));
  add('market two strings',botBy('botC1',c=>{delete c.market.timeframe;}));
  add('market string',botBy('botC1',c=>{c.market='binance-global';}));
  add('market number',botBy('botC1',c=>{c.market.timeframe=1;}));
  add('market array',botBy('botC1',c=>{c.market=[];}));
  for(const key of ['from','to']){
    add('resolved '+key+' fractional',botBy('botC1',c=>{c.resolved_range[key]=1.5;}));
    add('resolved '+key+' string',botBy('botC1',c=>{c.resolved_range[key]='1';}));
    add('window '+key+' fractional',botBy('botC1',c=>{c.inspected_window[key]=1.5;}));
    add('window '+key+' null',botBy('botC1',c=>{c.inspected_window[key]=null;}));
    add('window '+key+' beyond the date limit',botBy('botC1',c=>{c.inspected_window[key]=8640000000000001;}));
    add('window '+key+' below the date limit',botBy('botC1',c=>{c.inspected_window[key]=-8640000000000001;}));
    add('resolved '+key+' beyond the date limit',botBy('botC1',c=>{c.resolved_range[key]=8640000000000001;}));
    add('edge '+key+' fractional',botBy('botC1',c=>{c.excluded_edges[0][key]=0.5;}));
    add('edge '+key+' beyond the date limit',botBy('botC1',c=>{c.excluded_edges[0][key]=8640000000000001;}));
    add('interval '+key+' string',botBy('botC1',c=>{c.intervals[0][key]='1';}));
    add('interval '+key+' beyond the date limit',botBy('botC1',c=>{c.intervals[0][key]=8640000000000001;}));
  }
  add('resolved range not an object',botBy('botC1',c=>{c.resolved_range=5;}));
  add('excluded_edges not an array',botBy('botC1',c=>{c.excluded_edges={length:0};}));
  add('excluded_edges null',botBy('botC1',c=>{c.excluded_edges=null;}));
  add('edge without reason',botBy('botC1',c=>{delete c.excluded_edges[0].reason;}));
  add('edge reason number',botBy('botC1',c=>{c.excluded_edges[0].reason=1;}));
  add('edge null',botBy('botC1',c=>{c.excluded_edges[0]=null;}));
  add('state with a foreign reason',botBy('botC1',c=>{c.reason='X';}));
  add('COMPLETE with null interval count',botBy('botC1',c=>{c.interval_count=null;}));
  add('foreign state',botBy('botC1',c=>{c.state='PARTIAL';}));
  add('EMPTY foreign reason',botBy('botC3',c=>{c.reason='X';}));
  add('EMPTY null reason',botBy('botC4',c=>{c.reason=null;}));
  add('UNAVAILABLE foreign reason',botBy('botC5',c=>{c.reason='X';}));
  add('UNAVAILABLE null reason',botBy('botC6',c=>{c.reason=null;}));
  add('C7 null reason',botBy('botC7',c=>{c.reason=null;}));
  add('C7 foreign reason',botBy('botC7',c=>{c.reason='COVERAGE_BUDGET_EXCEEDED_X';}));
  add('C7 lower-case reason',botBy('botC7',c=>{c.reason='coverage_budget_exceeded';}));
  add('C1 interval_count mismatch',botBy('botC1',c=>{c.interval_count=c.intervals.length+1;}));
  add('C1 intervals not an array',botBy('botC1',c=>{c.intervals=null;}));
  add('C1 interval_count fractional',botBy('botC1',c=>{c.interval_count=1.5;}));
  add('C1 interval missing_minutes fractional',botBy('botC1',c=>{c.intervals[0].missing_minutes=1.5;}));
  add('C1 interval not an object',botBy('botC1',c=>{c.intervals[0]=1;}));
  add('C1 interval null',botBy('botC1',c=>{c.intervals[0]=null;}));
  add('C1 interval array',botBy('botC1',c=>{c.intervals[0]=[];}));
  add('C1 interval missing_minutes unsafe integer',botBy('botC1',c=>{c.intervals[0].missing_minutes=9007199254740992;}));
  add('C1 interval_count unsafe integer',botBy('botC1',c=>{c.interval_count=9007199254740992;}));
  add('C2 interval_count unsafe integer',botBy('botC2',c=>{c.interval_count=9007199254740992;}));
  add('market broker number',botBy('botC1',c=>{c.market.broker=1;}));
  add('market symbol number',botBy('botC1',c=>{c.market.symbol=1;}));
  add('market symbol missing',botBy('botC1',c=>{delete c.market.symbol;}));
  add('market broker missing',botBy('botC1',c=>{delete c.market.broker;}));
  add('resolved from below the date limit',botBy('botC1',c=>{c.resolved_range.from=-8640000000000001;}));
  add('edge from below the date limit',botBy('botC1',c=>{c.excluded_edges[0].from=-8640000000000001;}));
  add('interval from below the date limit',botBy('botC1',c=>{c.intervals[0].from=-8640000000000001;}));
  add('interval to below the date limit',botBy('botC1',c=>{c.intervals[0].to=-8640000000000001;}));
  for(const key of ['expected_minutes','stored_minutes','missing_minutes']){
    add('C1 '+key+' negative',botBy('botC1',c=>{c[key]=-1;}));
    add('C1 '+key+' fractional',botBy('botC1',c=>{c[key]=0.5;}));
    add('C1 '+key+' null',botBy('botC1',c=>{c[key]=null;}));
    add('C2 '+key+' string',botBy('botC2',c=>{c[key]='1';}));
    add('C1 '+key+' unsafe integer',botBy('botC1',c=>{c[key]=9007199254740992;}));
    add('C2 '+key+' unsafe integer',botBy('botC2',c=>{c[key]=9007199254740992;}));
    add('C3 '+key+' non-zero',botBy('botC3',c=>{c[key]=1;}));
    add('C4 '+key+' null',botBy('botC4',c=>{c[key]=null;}));
    add('C5 '+key+' zero',botBy('botC5',c=>{c[key]=0;}));
    add('C6 '+key+' zero',botBy('botC6',c=>{c[key]=0;}));
    add('C7 '+key+' zero',botBy('botC7',c=>{c[key]=0;}));
    add('C7 '+key+' number',botBy('botC7',c=>{c[key]=5;}));
  }
  add('C2 non-empty intervals',botBy('botC2',c=>{c.intervals=[{from:0,to:1,missing_minutes:1}];}));
  add('C2 intervals null',botBy('botC2',c=>{c.intervals=null;}));
  add('C3 interval_count one',botBy('botC3',c=>{c.interval_count=1;}));
  add('C3 intervals null',botBy('botC3',c=>{c.intervals=null;}));
  add('C4 non-empty intervals',botBy('botC4',c=>{c.intervals=[{from:0,to:1,missing_minutes:1}];}));
  add('C5 interval_count zero',botBy('botC5',c=>{c.interval_count=0;}));
  add('C5 empty intervals',botBy('botC5',c=>{c.intervals=[];}));
  add('C6 interval_count zero',botBy('botC6',c=>{c.interval_count=0;}));
  add('C6 empty intervals',botBy('botC6',c=>{c.intervals=[];}));
  add('C7 interval_count zero',botBy('botC7',c=>{c.interval_count=0;}));
  add('C7 interval_count number',botBy('botC7',c=>{c.interval_count=3;}));
  add('C7 empty intervals',botBy('botC7',c=>{c.intervals=[];}));
  add('C7 intervals with a gap list',botBy('botC7',c=>{c.intervals=[{from:0,to:1,missing_minutes:1}];}));
  addOwner('C7 entry with a count',e=>{e.entries[0].coverage.stored_minutes=0;},'ownerC7');
  add('coverage null',botBy('botC1',()=>{}));
  bad.at(-1).make=()=>{const body=bot();body.market_data.coverage=null;return body;};
  add('coverage array',botBy('botC1',()=>{}));
  bad.at(-1).make=()=>{const body=bot();body.market_data.coverage=[];return body;};
  addOwner('envelope version',e=>{e.version='qr2-owner-bar-coverage-v2';});
  addOwner('entries not an array',e=>{e.entries={};});
  addOwner('accounts not an array',e=>{e.accounts={};});
  addOwner('duplicate entry id',e=>{e.entries[1].id=e.entries[0].id;});
  addOwner('misnumbered entry id',e=>{e.entries[0].id='coverage:1';e.entries[1].id='coverage:0';});
  addOwner('entry id number',e=>{e.entries[0].id=0;});
  addOwner('entry coverage invalid',e=>{e.entries[1].coverage.version='x';});
  addOwner('entry not an object',e=>{e.entries[2]=null;});
  addOwner('account two coverage ids',e=>{e.accounts[0].coverage_ids=['coverage:0','coverage:1'];});
  addOwner('account no coverage ids',e=>{e.accounts[0].coverage_ids=[];});
  addOwner('account coverage id unknown',e=>{e.accounts[0].coverage_ids=['coverage:9'];});
  addOwner('account coverage id number',e=>{e.accounts[0].coverage_ids=[0];});
  addOwner('entry unreferenced',e=>{e.accounts=e.accounts.filter(a=>a.coverage_ids[0]!=='coverage:2');});
  addOwner('duplicate bot and broker pair',e=>{e.accounts[1].bot_id=e.accounts[0].bot_id;e.accounts[1].broker=e.accounts[0].broker;});
  addOwner('account bot_id number',e=>{e.accounts[0].bot_id=1;});
  addOwner('account not an object',e=>{e.accounts[0]=null;});
  addOwner('entries not an array with no accounts',e=>{e.entries={};e.accounts=[];});
  addOwner('entries null with no accounts',e=>{e.entries=null;e.accounts=[];});
  addOwner('account broker number',e=>{e.accounts[0].broker=1;});
  addOwner('account broker null',e=>{e.accounts[0].broker=null;});
  addOwner('account broker missing',e=>{delete e.accounts[0].broker;});
  addOwner('account bot_id null',e=>{e.accounts[0].bot_id=null;});
  addOwner('same bot_id and broker twice, other accounts unchanged',e=>{e.accounts[3].bot_id=e.accounts[2].bot_id;e.accounts[3].broker=e.accounts[2].broker;});
  addOwner('key present with a null resolved range',(e,body)=>{body.resolved_range=null;});
  bad.push({name:'key present with a null resolved range (ownerNull)',owner:true,make:()=>{const body=structuredClone(covFx.cases.ownerNull.body);body.market_coverage=structuredClone(covFx.cases.ownerMulti.body.market_coverage);return body;}});
  // The page first holds a valid report, then every malformed body replaces it.
  for(const owner of [false,true]){
    let next=owner?covFx.cases.ownerMulti.body:covFx.cases.botC1.body;
    const p=setup({answer:()=>ok(next),observe:false});
    try{
      await p.boot();
      if(owner){p.change('ppScope','owner');p.change('ppCurrency','USDT');}
      await p.load();
      assert.ok(sectionOf(p).querySelector('.pp-cov-block'),'valid report first');
      const books=()=>p.requests.filter(r=>r.path.startsWith('/api/me?')).length;
      for(const item of bad.filter(entry=>entry.owner===owner)){
        const booksBefore=books();
        next=item.make();await p.load();
        assert.match(p.get('ppStatus').textContent,/Paper performance response unavailable\./,item.name);
        assert.match(p.get('ppStatus').textContent,/QR2_RESPONSE_INVALID/,item.name);
        assert.equal(p.text(),'',item.name+': no earlier report value survives');
        assert.equal(books(),booksBefore,item.name+': no /api/me GET');
      }
      // A valid report afterwards renders again.
      next=owner?covFx.cases.ownerMulti.body:covFx.cases.botC1.body;await p.load();
      assert.ok(sectionOf(p).querySelector('.pp-cov-block'),'recovery after the malformed bodies');
    }finally{p.close();}
  }
  assert.ok(bad.length>=90,'fail-closed table size '+bad.length);
});

test('A8 stale responses never render coverage',async()=>{
  const late=deferred(),p=setup({answer:()=>late.promise});
  try{
    await p.boot();p.get('ppLoad').click();await settle();
    p.change('ppPeriod','YEAR');
    late.resolve(ok(covFx.cases.botC1.body));await settle();
    assert.equal(sectionOf(p),null);assert.equal(p.text(),'');
    assert.equal(p.financial().length,1);
  }finally{late.resolve(ok(covFx.cases.botC1.body));p.close();}
  const pending=deferred();let next=ok(covFx.cases.botC1.body);const q=setup({answer:()=>next});
  try{
    await q.boot();await q.load();assert.ok(sectionOf(q));
    next=pending.promise;q.get('ppLoad').click();await settle();
    assert.equal(sectionOf(q),null,'pending clears the coverage section');
    q.change('ppCurrency','THB');pending.resolve(ok(covFx.cases.botC2.body));await settle();
    assert.equal(sectionOf(q),null,'a late coverage response after a change never renders');
  }finally{pending.resolve(ok(covFx.cases.botC2.body));q.close();}
});

test('A9 language toggle swaps coverage labels, keeps raw values and starts no request',async()=>{
  // Private pages keep the translateUI observer: two owner bodies and one per-Bot body (C1 with intervals).
  for(const name of ['ownerMulti','ownerRanges','botC1']){
    const p=await view(covFx.cases[name].body,{fresh:true});
    try{
      const section=sectionOf(p),rawBefore=[...section.querySelectorAll('.no-i18n')].map(n=>n.textContent);
      const requests=p.requests.length,labelCount=section.querySelectorAll('[data-ui-label]').length;
      assert.ok(labelCount>(name.startsWith('owner')?20:10),'labels found: '+labelCount);
      for(const language of ['th','en','th']){
        p.get('language').value=language;p.get('language').dispatchEvent(new p.w.Event('change',{bubbles:true}));await settle();
        for(const node of section.querySelectorAll('[data-ui-label]'))assert.equal(node.textContent,shown(p,language,node.dataset.uiLabel),node.dataset.uiLabel);
        assert.deepEqual([...section.querySelectorAll('.no-i18n')].map(n=>n.textContent),rawBefore,'raw values are identical');
        assert.equal(p.requests.length,requests,'no request on a language change');
      }
      assert.equal(section.querySelectorAll('[data-ui-label]').length,labelCount);
    }finally{p.close();}
  }
});

test('A10 rendering never mutates the body, sends GET only and adds no request',async()=>{
  for(const [body,owner] of [[covFx.cases.botC1.body,false],[covFx.cases.ownerMulti.body,true],[fixture.bot,false]]){
    const before=JSON.stringify(body),bare=structuredClone(body);
    if(owner)delete bare.market_coverage;else delete bare.market_data.coverage;
    const withCoverage=await view(body),withList=[...withCoverage.requests];
    const without=await view(bare),withoutList=[...without.requests];
    try{
      assert.equal(JSON.stringify(body),before,'the input body is unchanged');
      assert.deepEqual(withList.map(r=>r.path),withoutList.map(r=>r.path),'the request list is the same without coverage');
      assert.ok(withList.every(r=>r.method==='GET'&&(r.options.method===undefined||r.options.method==='GET')));
    }finally{withCoverage.close();without.close();}
  }
  const bad=structuredClone(covFx.cases.botC1.body);bad.market_data.coverage.state='X';
  const p=await view(bad);
  try{assert.equal(p.requests.some(r=>r.path.startsWith('/api/me?')),false);assert.match(p.get('ppStatus').textContent,/QR2_RESPONSE_INVALID/);}
  finally{p.close();}
});

test('A11 counts and times are shown exactly as String(value) and the UTC time form',async()=>{
  for(const name of ['botC1','ownerRanges']){
    const body=covFx.cases[name].body,p=await view(body);
    try{
      const section=sectionOf(p);
      const times=[...section.querySelectorAll('[data-cov-field="from"],[data-cov-field="to"]')];
      assert.ok(times.length>0);
      for(const node of times){
        assert.match(node.textContent,/^-?\d+ \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/);
        const epoch=Number(node.textContent.split(' ')[0]);
        assert.equal(node.textContent,String(epoch)+' ('+new Date(epoch).toISOString()+')');
      }
      const rawText=[...section.querySelectorAll('.no-i18n')].map(n=>n.textContent).join('\n');
      assert.equal(/\d,\d{3}|%|\bago\b|GMT|[AP]M\b|\d{1,2}\/\d{1,2}\/\d{2,4}|\d+ (?:min|hour|day)s?\b/.test(rawText),false,'no thousands separator, locale date, non-UTC time, relative time or percentage');
      const expected=coveragesOf(body).flatMap(c=>[c.expected_minutes,c.stored_minutes,c.missing_minutes,c.interval_count].map(v=>v===null?'—':String(v)));
      assert.deepEqual([...section.querySelectorAll('[data-cov-field="value"]')].map(n=>n.textContent),expected);
      for(const c of coveragesOf(body))for(const item of c.intervals??[])assert.ok(section.textContent.includes(intervalForm(item)));
    }finally{p.close();}
  }
  // The interval list is open for 10 or fewer intervals and closed above; a closed list is complete in the DOM.
  const few=await view(covFx.cases.botC1.body);
  try{assert.equal(sectionOf(few).querySelector('details').open,true);}finally{few.close();}
});

// Producer-built per-Bot body with n gap intervals of one minute each, one stored minute between them (the range spans 2n minutes from start).
// tail:true makes the last gap two minutes long so that it ends exactly at the window end.
function gapBody(n,start=1790812800000,{tail=false}={}){
  const missing=Array.from({length:n},(_,k)=>({from:start+2*k*M,to:start+(2*k+1)*M+(tail&&k===n-1?M:0)}));
  const context={accounts:[{bot_id:'bot-1',broker:'binance-global',market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},resolved_range:{from:start,to:start+2*n*M}}],budgets:{...QR2_COVERAGE_LIMITS}};
  const coverage=structuredClone(projectFacts({context,unions:[{state:'COMPLETE',missing}]}).accounts[0].market_data.coverage);
  const body=structuredClone(covFx.cases.botC1.body);body.market_data.coverage=coverage;body.resolved_range=structuredClone(coverage.resolved_range);
  return {body,coverage};
}

test('A14 boundary values: open threshold at 10 and 11 intervals, exact epoch limits, one bot_id under two brokers, null market_data',async()=>{
  const LIMIT=8640000000000000;
  for(const [n,open] of [[10,true],[11,false]]){
    const {body,coverage}=gapBody(n);
    assert.equal(coverage.interval_count,n);assert.equal(coverage.intervals.length,n);assert.equal(validateResponse(body).ok,true,'header and body stay valid');
    const p=await view(body);
    try{
      const block=sectionOf(p).querySelector('.pp-cov-block');
      assert.equal(block.querySelector('details').open,open,n+' intervals');
      assert.equal(block.querySelectorAll('details li').length,n,'every interval is in the DOM');
      checkBlock(p,'en',block,coverage,'C1');
    }finally{p.close();}
  }
  // +LIMIT: the producer builds a body whose range, window and last interval end exactly at the largest Date epoch.
  const top=gapBody(10,LIMIT-20*M,{tail:true});
  assert.equal(top.coverage.resolved_range.to,LIMIT);assert.equal(top.coverage.inspected_window.to,LIMIT);assert.equal(top.coverage.intervals.at(-1).to,LIMIT);
  // -LIMIT: the producer refuses negative epochs (QR2_INPUT_INVALID), so one producer-built body is edited at the lower bound only.
  const low=gapBody(10);
  for(const object of [low.coverage.resolved_range,low.coverage.inspected_window,low.coverage.intervals[0],low.body.resolved_range])object.from=-LIMIT;
  low.coverage.excluded_edges=[{from:-LIMIT,to:-LIMIT+M,reason:'PARTIAL_CANDLE'}];
  for(const [name,{body,coverage}] of [['+limit',top],['-limit',low]]){
    const p=await view(body);
    try{
      assert.doesNotMatch(p.get('ppStatus').textContent,/QR2_RESPONSE_INVALID/,name+' is accepted');
      const block=sectionOf(p).querySelector('.pp-cov-block');assert.ok(block,name);
      checkBlock(p,'en',block,coverage,'C1');
      assert.ok(block.textContent.includes(timeForm(name==='+limit'?LIMIT:-LIMIT)),name+' shows the exact limit instant');
    }finally{p.close();}
  }
  // One bot_id under two brokers is two accounts of the envelope; only the same bot_id and broker twice is a duplicate (A7).
  const multi=structuredClone(covFx.cases.ownerMulti.body),accounts=multi.market_coverage.accounts;
  accounts[1].bot_id=accounts[0].bot_id;accounts[1].broker='binance-th';
  const p=await view(multi);
  try{
    assert.doesNotMatch(p.get('ppStatus').textContent,/QR2_RESPONSE_INVALID/);
    const first=sectionOf(p).querySelector(':scope > .pp-cov-block');
    assert.deepEqual([...first.querySelectorAll('[data-cov-row="accounts"] li')].map(li=>[li.querySelector('[data-cov-field="bot"]').textContent,li.querySelector('[data-cov-field="account-broker"]').textContent]),[[accounts[0].bot_id,'binance-global'],[accounts[0].bot_id,'binance-th']]);
  }finally{p.close();}
  // A per-Bot body without a market_data object is "not supplied", never a script error.
  for(const value of [null,[]]){
    const body=structuredClone(covFx.cases.botC1.body);body.market_data=value;
    const q=await view(body);
    try{
      assert.doesNotMatch(q.get('ppStatus').textContent,/unavailable|QR2_RESPONSE_INVALID/);
      const section=sectionOf(q);assert.ok(section,'the coverage section renders');
      checkNotices(q,'en',section,{owner:false,extra:EN.absent});assert.equal(section.querySelector('.pp-cov-block'),null);
    }finally{q.close();}
  }
});

test('A13 qr2CoveragePairs equals the label-table new entries, is Thai and matches the quoted literals in paper-performance.js',()=>{
  const {mine:pairs,others:otherPairs}=staticI18n(),mine=pairs.map(pair=>[pair.en,pair.th]),others=otherPairs.map(pair=>[pair.en,pair.th]);
  assert.deepEqual(mine.map(p=>p[0]).sort(),[...newEnglish].sort(),'EN texts equal the new entries of the label table');
  const source=publicFile('paper-performance.js');
  for(const [en] of mine)assert.ok(source.includes("'"+en+"'"),'quoted literal in paper-performance.js: '+en);
  for(const en of reusedEnglish){
    assert.equal(mine.some(p=>p[0]===en),false,'reused label is not in qr2CoveragePairs: '+en);
    assert.ok(others.some(p=>p[0]===en),'reused label already has an existing pair: '+en);
    assert.ok(source.includes("'"+en+"'"),'quoted literal: '+en);
  }
  for(const [en,th] of mine)assert.ok(/[฀-๿]/.test(th),'TH text is Thai: '+en);
});

test('T1 observation: whole validateOwnerResponse on a maximum owner body (20 accounts, 20 entries, 4096 intervals)',t=>{
  const S=1790812800000,context={accounts:[],budgets:{...QR2_COVERAGE_LIMITS}};
  for(let k=0;k<20;k++){
    const n=k<16?205:204;
    context.accounts.push({bot_id:'bot-'+String(k).padStart(2,'0'),broker:'binance-global',market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},resolved_range:{from:S,to:S+2*n*M+k*1000}});
  }
  const projected=projectFacts({context,unions:[{state:'COMPLETE',missing_every_other:{first:S,count:205}}]});
  const body=structuredClone(fixture.owner);
  const row=body.accounts[0];
  body.accounts=context.accounts.map(a=>({...structuredClone(row),bot_id:a.bot_id}));
  body.counts.accounts=20;body.total.member_count=20;
  body.market_coverage=projected.owner.market_coverage;
  assert.equal(body.market_coverage.entries.length,20);
  assert.equal(body.market_coverage.entries.reduce((n,e)=>n+e.coverage.interval_count,0),4096);
  assert.equal(validateOwnerResponse(body),true);
  const runs=[];
  for(let i=0;i<50;i++){const started=performance.now();assert.equal(validateOwnerResponse(body),true);runs.push(performance.now()-started);}
  runs.sort((a,b)=>a-b);
  t.diagnostic('T1 observation, 50 runs of the whole validateOwnerResponse on the maximum owner body: median '+runs[24].toFixed(2)+' ms, maximum '+runs[49].toFixed(2)+' ms (O6 reference: validateOwnerCoverageShape alone median 5.2 ms, maximum 9.5 ms). Observation only, no bar.');
});

// QR-2 option D (OD-S5-D), D2: class C7 in the panel.
const C7_EN="Inspection unavailable: this range is over the bar coverage check limit, so bar coverage was not checked. The financial figures and their price checks are not affected. Choose a shorter range, for example Week, to see bar coverage.";
const C7_TH="ตรวจไม่ได้: ช่วงนี้เกินขีดจำกัดของการตรวจความครอบคลุมแท่งราคา จึงไม่ได้ตรวจความครอบคลุมแท่งราคา ตัวเลขทางการเงินและการตรวจราคาของตัวเลขเหล่านั้นไม่ได้รับผลกระทบ เลือกช่วงที่สั้นลง เช่น สัปดาห์ เพื่อดูความครอบคลุมแท่งราคา";

test('D2 C7 shows the spec English and Thai text with no count, no gap list and no completeness label; the other classes keep their text',async()=>{
  assert.equal(EN.klass.C7,C7_EN,'the English label is the spec D text');
  for(const language of ['en','th'])for(const [name,body] of [['botC7',covFx.cases.botC7.body],['ownerC7',covFx.cases.ownerC7.body]]){
    const p=await view(body,{language});
    try{
      const section=sectionOf(p);assert.ok(section,name);
      const blocks=[...section.querySelectorAll('.pp-cov-block')];
      assert.equal(blocks.length,name==='botC7'?1:3);
      for(const [i,block] of blocks.entries()){
        assert.equal(block.dataset.covClass,'C7');
        assert.equal(block.querySelector('.pp-cov-class').textContent,language==='th'?C7_TH:C7_EN,name+' '+language);
        assert.equal(block.querySelector('.pp-cov-intervals'),null,'no gap list for C7');
        assert.equal(block.querySelector('details'),null);
        const values=[...block.querySelectorAll('[data-cov-field="value"]')].map(n=>n.textContent);
        assert.deepEqual(values,['—','—','—','—'],'every count is the em dash: nothing is counted');
        assert.equal(block.querySelector('[data-cov-field="state"]').textContent,'UNAVAILABLE');
        assert.equal(block.querySelector('[data-cov-field="reason"]').textContent,'COVERAGE_BUDGET_EXCEEDED');
        void i;
      }
      const text=blocks.map(block=>block.textContent).join(' ');   // the section notices explain the vocabulary for every class; the blocks hold the result
      assert.equal(/no gaps|ไม่มีช่องว่าง/i.test(text),false,'no "no gaps" label');
      assert.equal(/Inspection completed|ตรวจเสร็จสิ้น/.test(text),false,'no completion label');
      // The financial report above the coverage section is rendered as for any other body.
      assert.ok(p.get('ppResult').querySelector('.pp-metrics'),name+': the metrics grid is shown');
    }finally{p.close();}
  }
  assert.equal(C7_TH,thOf(await view(covFx.cases.botC7.body),C7_EN),'the Thai pair equals the spec D Thai text');
  // Every other class keeps its own text.
  for(const cls of ['C1','C2','C3','C4','C5','C6'])assert.notEqual(EN.klass[cls],C7_EN);
});

test('D2 a panel without the C7 branch fails closed on a C7 body; the real panel does not (mutant)',async()=>{
  const source=publicFile('paper-performance.js').replace(/\r\n/g,'\n');   // a Windows checkout has CRLF; match the branch line on LF text
  const branch="    else if (c.state === 'UNAVAILABLE' && c.reason === 'COVERAGE_BUDGET_EXCEEDED') cls = 'C7';\n";
  assert.ok(source.includes(branch),'the C7 branch exists in the panel');
  const mutant=source.replace(branch,'');
  assert.notEqual(mutant,source);
  for(const [name,body,owner] of [['bot',covFx.cases.botC7.body,false],['owner',covFx.cases.ownerC7.body,true]]){
    const p=setup({answer:()=>ok(body),observe:false,panelSource:mutant});
    try{
      await p.boot();
      if(owner){p.change('ppScope','owner');p.change('ppCurrency','USDT');}
      await p.load();
      assert.match(p.get('ppStatus').textContent,/Paper performance response unavailable\./,name);
      assert.match(p.get('ppStatus').textContent,/QR2_RESPONSE_INVALID/,name);
      assert.equal(p.text(),'',name+': no report value is shown');
    }finally{p.close();}
    const good=await view(body);
    try{assert.ok(sectionOf(good).querySelector('.pp-cov-block[data-cov-class="C7"]'),name+': the real panel shows C7');}finally{good.close();}
  }
});

test('D2 cache tokens: i18n.js and paper-performance.js load with qr2o10; the stylesheet token is unchanged',()=>{
  const html=publicFile('index.html');
  assert.ok(html.includes('/i18n.js?v=qr2o10'));assert.ok(html.includes('/paper-performance.js?v=qr2o10'));
  assert.ok(html.includes('/paper-performance.css?v=qr2o7'));
  assert.equal(html.includes('qr2o8'),false,'no asset keeps the previous token');
});

// QR-2 W3 (RC-Q47): the per-Bot reconciliation note. The English sentences are literals here, so a changed sentence in the panel fails this test.
const RECONCILE_EN={
  EPOCH_UNKNOWN:'Stopped by design: no ledger rule period is recorded for this fill time. Values from this fill on stay unavailable. Later ledger rows are not checked.',
  FILL_WITHOUT_JOURNAL:'A fill has no matching cash journal row.',
  JOURNAL_WITHOUT_FILL:'A cash journal row has no matching fill.',
  DUPLICATE_FILL_KEY:'Two fills share one fill key.',
  DUPLICATE_JOURNAL_KEY:'Two cash journal rows share one key.',
  FOREIGN_JOURNAL_ROW:'A cash journal row in this account names another account.'
};
const RECONCILE_GENERIC_EN='The first failed check is listed in the server details below.';
const RECONCILE_TH_EPOCH='หยุดตามการออกแบบ: ยังไม่มีการบันทึกช่วงกฎของ Ledger สำหรับเวลาของ Fill นี้ ค่าตั้งแต่ Fill นี้เป็นต้นไปจึงไม่แสดง และยังไม่ได้ตรวจแถว Ledger ที่ตามมา';
const failedBody=(state,firstFailure)=>{
  const body=structuredClone(fixture.botUnavailable);
  body.reconciliation={...body.reconciliation,state,failed_from:null,failed_whole_account:state==='RECONCILIATION_FAILED',first_failure:firstFailure};
  return body;
};
const failure=(reason,code='LEDGER_RULE_UNREPLAYABLE')=>({check:'RT',code,event_key:'1:1',reason});
const noteOf=p=>p.get('ppResult').querySelector('.pp-reconcile-note');

test('U1 RECONCILIATION_FAILED with EPOCH_UNKNOWN shows the note in English and Thai with the raw code',async()=>{
  for(const language of ['en','th']){
    const p=setup({language,answer:()=>ok(failedBody('RECONCILIATION_FAILED',failure('EPOCH_UNKNOWN')))});
    try{
      await p.boot();p.change('ppScope','bot');await p.load();
      const note=noteOf(p);
      assert.ok(note,language+': the note exists');
      assert.equal(p.get('ppResult').querySelectorAll('.pp-reconcile-note').length,1);
      const heading=note.querySelector('h4'),sentence=note.querySelector('p');
      assert.equal(heading.textContent,language==='en'?'Why reconciliation failed':'สาเหตุที่กระทบยอดไม่ผ่าน');
      assert.equal(sentence.textContent,language==='en'?RECONCILE_EN.EPOCH_UNKNOWN:RECONCILE_TH_EPOCH);
      assert.equal(/\d/.test(heading.textContent+sentence.textContent),false,'the note text holds no number');
      assert.ok(note.textContent.includes('EPOCH_UNKNOWN'),'the raw code is shown');
      assert.equal(/undamaged|not ledger damage|no damage|intact/i.test(note.textContent),false,'no claim that the ledger is undamaged');
    }finally{p.close();}
  }
});

test('U2 every listed reason, a null reason and an unknown reason; OK, ACCOUNT_UNAVAILABLE and owner views show no note',async()=>{
  const cases=[...Object.entries(RECONCILE_EN).map(([reason,sentence])=>[failure(reason),sentence,reason]),
    [failure(null,'SELL_EXCEEDS_POSITION'),RECONCILE_GENERIC_EN,'SELL_EXCEEDS_POSITION'],
    [failure('NEW_REASON'),RECONCILE_GENERIC_EN,'NEW_REASON'],
    [failure('constructor'),RECONCILE_GENERIC_EN,'constructor'],
    [{check:null,code:null,event_key:null,reason:null},RECONCILE_GENERIC_EN,null]];
  for(const [firstFailure,sentence,code] of cases){
    const p=setup({answer:()=>ok(failedBody('RECONCILIATION_FAILED',firstFailure))});
    try{
      await p.boot();p.change('ppScope','bot');await p.load();
      const note=noteOf(p);
      assert.ok(note,String(firstFailure.reason??firstFailure.code));
      assert.equal(note.querySelector('p').textContent,sentence);
      if(code!==null)assert.ok(note.textContent.includes(code));
      else assert.equal(note.querySelectorAll('p').length,1,'no code line without a code');
    }finally{p.close();}
  }
  const noFirst=setup({answer:()=>ok(failedBody('RECONCILIATION_FAILED',null))});
  try{await noFirst.boot();noFirst.change('ppScope','bot');await noFirst.load();assert.equal(noteOf(noFirst).querySelector('p').textContent,RECONCILE_GENERIC_EN);}finally{noFirst.close();}
  for(const state of ['OK','ACCOUNT_UNAVAILABLE']){
    const p=setup({answer:()=>ok(failedBody(state,failure('EPOCH_UNKNOWN')))});
    try{await p.boot();p.change('ppScope','bot');await p.load();assert.equal(noteOf(p),null,state+': no note');}finally{p.close();}
  }
  const owner=structuredClone(fixture.owner);owner.reconciliation={state:'RECONCILIATION_FAILED',first_failure:failure('EPOCH_UNKNOWN')};
  const o=setup({answer:()=>ok(owner)});
  try{await o.boot();o.change('ppScope','owner');await o.load();assert.equal(noteOf(o),null,'owner view: no note');assert.ok(o.text().includes('NOT_AN_OWNER_PORTFOLIO'),'the owner view still rendered');}finally{o.close();}
});

test('U3 a hostile reason stays text: generic sentence, raw text shown, no element created, no script flag set',async()=>{
  const hostile='<img src=x onerror="window.__pwned=1">';
  const p=setup({answer:()=>ok(failedBody('RECONCILIATION_FAILED',failure(hostile)))});
  try{
    await p.boot();p.change('ppScope','bot');await p.load();
    const note=noteOf(p);
    assert.ok(note);
    assert.equal(note.querySelector('p').textContent,RECONCILE_GENERIC_EN);
    assert.ok(note.textContent.includes(hostile),'the hostile string is shown as plain text');
    assert.equal(p.get('ppResult').querySelectorAll('img').length,0);
    assert.equal(note.querySelectorAll('[data-ui-label]').length,3,'only the heading, the sentence and the code caption are labels');
    await settle();
    assert.equal(p.w.__pwned,undefined);
  }finally{p.close();}
});

function reconcileI18n(){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  w.MutationObserver=class{observe(){}disconnect(){}};
  try{
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=qr2ReconcilePairs;');
    const mine=new Set(w.__mine);
    return [...w.__pairs].map(pair=>({en:pair[0],th:pair[1],mine:mine.has(pair)}));
  }finally{w.close();}
}

test('U4 qr2ReconcilePairs is collision-free: 8 pairs, no duplicate, no collision, no em dash, currency or market token',()=>{
  const pairs=reconcileI18n(),mine=pairs.filter(pair=>pair.mine),others=pairs.filter(pair=>!pair.mine),texts=new Set(others.flatMap(pair=>[pair.en,pair.th]));
  assert.equal(mine.length,8);
  assert.equal(new Set(mine.map(pair=>pair.en)).size,8,'no duplicate EN');
  assert.equal(new Set(mine.map(pair=>pair.th)).size,8,'no duplicate TH');
  const flat=mine.flatMap(pair=>[pair.en,pair.th]);
  assert.equal(new Set(flat).size,flat.length,'no EN equals a TH inside the array');
  for(const {en,th} of mine){
    assert.notEqual(en,th);
    assert.equal(texts.has(en),false,'EN collides with an existing text: '+en);
    assert.equal(texts.has(th),false,'TH collides with an existing text: '+th);
    assert.equal(/[—€$฿]|USDT|THB|BTCUSDT/.test(en+th),false,'em dash, currency or market token in: '+en);
  }
  const english=new Set(mine.map(pair=>pair.en));
  for(const sentence of [...Object.values(RECONCILE_EN),RECONCILE_GENERIC_EN,'Why reconciliation failed'])assert.ok(english.has(sentence),'pair for: '+sentence);
  assert.equal(mine.find(pair=>pair.en===RECONCILE_EN.EPOCH_UNKNOWN).th,RECONCILE_TH_EPOCH);
});
