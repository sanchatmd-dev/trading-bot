import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {validateResponse} from '../src/portfolio/qr2-labels.js';
import {validateOwnerResponse} from '../src/portfolio/qr2-owner-response.js';
import {refusalAnswer} from '../src/portfolio/qr2-response.js';

const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/qr2-performance-ui/responses.json',import.meta.url),'utf8'));
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const ok=body=>({status:200,body});
const bookFixture=()=>({user:{id:'owner-1'},bot:{id:'bot-1'},allBots:false,moneyFormat:'decimal-string',paperAccounts:[{bot_id:'bot-1',userId:'bot-1',broker:'binance-global',currency:'USDT',valuation:'COST_BASIS_NOT_MARK_TO_MARKET',bookEquity:'9007199254740994.123456789123456789'}]});
function setup({authenticated=true,language='en',answer=()=>ok(fixture.bot),bookAnswer=()=>ok(bookFixture()),sessionLoad=()=>{}}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
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
  w.eval(publicFile('paper-performance.js'));
  const get=id=>d.getElementById(id);
  const change=(id,value)=>{const node=get(id);const option=[...node.options??[]].find(o=>o.value.toLowerCase()===String(value).toLowerCase());node.value=option?.value??value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const boot=async()=>{await w.load();await settle();if(get('ppBot')?.options.length>1)change('ppBot','bot-1');};
  const load=async()=>{get('ppLoad').click();await settle();};
  const financial=()=>requests.filter(r=>r.path.startsWith('/api/paper-performance'));
  return {w,d,get,change,boot,load,requests,financial,text:()=>get('ppResult').textContent,close:()=>w.close()};
}

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
    try{await p.boot();p.change('ppScope',scope);await p.load();assert.ok(p.text().includes(expected));assert.ok(p.text().includes('—'));assert.ok((p.text()+p.get('ppStatus').textContent).includes(body.status.status));
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
