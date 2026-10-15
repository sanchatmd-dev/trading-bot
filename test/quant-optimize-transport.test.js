import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createQuantOptimizeTransport,QUANT_OPTIMIZE_DEADLINE_MS} from '../src/postgres/quant-optimize-transport.js';

function fixture({constructThrows=false,endThrows=false,deadlineMs}={}){
  let now=0,callback,timerCallback,clears=0,calls=0,ends=0,delay;
  const upstream=new EventEmitter(),response=new EventEmitter();
  upstream.destroy=()=>{upstream.destroyed=true;upstream.emit('error',new Error('Late destroy error'));};
  response.destroy=()=>{response.destroyed=true;response.emit('error',new Error('Late response destroy error'));};
  response.setEncoding=encoding=>assert.equal(encoding,'utf8');response.statusCode=200;
  upstream.end=()=>{ends++;if(endThrows)throw new Error('end failed');};
  const transport=createQuantOptimizeTransport({
    request(options,receive){calls++;callback=receive;if(constructThrows)throw new Error('construction failed');return upstream;},
    clock:()=>now,setTimer(fn,ms){timerCallback=fn;delay=ms;return 17;},clearTimer(timer){assert.equal(timer,17);clears++;},
    ...(deadlineMs===undefined?{}:{deadlineMs})
  });
  const promise=transport({hostname:'fixture.invalid'},'{}');
  // Attach rejection handling before test-controlled events fire.
  const outcome=promise.then(value=>({value}),error=>({error}));
  return {upstream,response,outcome,headers:()=>callback(response),timeout:()=>timerCallback(),
    time:value=>{now=value;},get calls(){return calls;},get ends(){return ends;},get clears(){return clears;},get delay(){return delay;}};
}
function late(f){
  f.timeout();f.upstream.emit('error',new Error('late request'));f.response.emit('error',new Error('late response'));
  f.response.emit('aborted');f.response.emit('close');f.response.emit('data','{}');f.response.emit('end');
  assert.equal(f.calls,1);assert.equal(f.clears,1);
}

test('production deadline is fixed at 10000ms; success settles once and clears timer',async()=>{
  assert.equal(QUANT_OPTIMIZE_DEADLINE_MS,10000);
  const f=fixture();assert.equal(f.delay,10000);f.headers();f.response.emit('data','{"best":{}}');f.response.emit('end');
  assert.deepEqual((await f.outcome).value,{status:200,body:{best:{}}});late(f);
});

for(const kind of ['no headers','stalled body','trickle'])test(`absolute deadline bounds ${kind}`,async()=>{
  const f=fixture({deadlineMs:50});assert.equal(f.delay,50);
  if(kind!=='no headers')f.headers();
  if(kind==='trickle')for(let n=1;n<50;n++){f.time(n);f.response.emit('data',' ');}
  f.time(50);f.timeout();assert.match((await f.outcome).error.message,/timed out/);
  if(kind==='no headers')f.headers(); // A response arriving after timeout must also absorb late errors.
  late(f);
});

for(const event of ['error','aborted','close'])test(`response ${event} settles without waiting for deadline`,async()=>{
  const f=fixture();f.headers();f.response.emit('data','{"partial":');
  f.response.emit(event,new Error('response broke'));assert.ok((await f.outcome).error);late(f);
});

test('response overflow settles before destroying streams',async()=>{
  const f=fixture();f.headers();f.response.emit('data','x'.repeat(1024*1024+1));
  assert.match((await f.outcome).error.message,/too large/);assert.equal(f.response.destroyed,true);late(f);
});
test('malformed JSON is an unknown transport result',async()=>{
  const f=fixture();f.headers();f.response.emit('data','{');f.response.emit('end');
  assert.match((await f.outcome).error.message,/Invalid Quant response/);late(f);
});
for(const flag of ['constructThrows','endThrows'])test(`synchronous ${flag} clears deadline`,async()=>{
  const f=fixture({[flag]:true});assert.ok((await f.outcome).error);assert.equal(f.calls,1);assert.equal(f.clears,1);
  f.upstream.on('error',()=>{});f.response.on('error',()=>{});late(f);
});
for(const first of ['error','timeout'])test(`${first} wins error/deadline race, late events do not resettle`,async()=>{
  const f=fixture();f.headers();
  if(first==='error'){f.upstream.emit('error',new Error('first error'));f.timeout();}
  else{f.timeout();f.upstream.emit('error',new Error('second error'));}
  assert.match((await f.outcome).error.message,first==='error'?/first error/:/timed out/);late(f);
});
for(const at of ['headers','data','end'])test(`monotonic expiry at ${at} rejects despite delayed timer callback`,async()=>{
  const f=fixture({deadlineMs:50});
  if(at==='headers'){f.time(50);f.headers();}
  else{
    f.headers();
    if(at==='data'){f.time(50);f.response.emit('data','{}');}
    else{f.response.emit('data','{}');f.time(50);f.response.emit('end');}
  }
  assert.match((await f.outcome).error.message,/timed out/);late(f);
});
test('deadline is checked after synchronous JSON parsing too',async()=>{
  let tick=0,callback;
  const upstream=new EventEmitter(),response=new EventEmitter();upstream.end=()=>{};upstream.destroy=()=>{};
  response.setEncoding=()=>{};response.destroy=()=>{};
  const transport=createQuantOptimizeTransport({request(options,cb){callback=cb;return upstream;},
    clock:()=>++tick===6?10000:0,setTimer:()=>1,clearTimer:()=>{}});
  const result=transport({}).then(()=>null,error=>error);callback(response);response.emit('data','{}');response.emit('end');
  assert.match((await result).message,/timed out/);
  assert.equal(tick,6,'expiry was observed after JSON.parse, not before it');
});
for(const body of [null,false,42,'known rejection'])test(`valid JSON ${JSON.stringify(body)} remains a complete response`,async()=>{
  const f=fixture();f.response.statusCode=422;f.headers();f.response.emit('data',JSON.stringify(body));f.response.emit('end');f.response.emit('close');
  assert.deepEqual((await f.outcome).value,{status:422,body});late(f);
});
test('request error before headers settles, then late headers are safely discarded',async()=>{
  const f=fixture();f.upstream.emit('error',new Error('connection failed'));
  assert.match((await f.outcome).error.message,/connection failed/);f.headers();late(f);
});

const cap=1024*1024;
for(const multibyte of [false,true])for(const overflow of [false,true])test(`${multibyte?'UTF-8 multibyte':'ASCII'} response ${overflow?'one byte over':'exactly at'} 1MiB cap`,async()=>{
  let callback,clears=0;
  const request=new EventEmitter(),response=new EventEmitter();
  request.end=()=>{};request.destroy=()=>request.emit('error',new Error('late request error'));
  response.setEncoding=()=>{};response.destroy=()=>response.emit('error',new Error('late response error'));response.statusCode=200;
  const transport=createQuantOptimizeTransport({request(options,receive){callback=receive;return request;},clock:()=>0,
    setTimer:()=>23,clearTimer:timer=>{assert.equal(timer,23);clears++;}});
  const payloadBytes=cap-2+(overflow?1:0);
  const payload=multibyte?'€'.repeat(Math.floor(payloadBytes/3))+'x'.repeat(payloadBytes%3):'x'.repeat(payloadBytes);
  const raw=JSON.stringify(payload);
  assert.equal(Buffer.byteLength(raw),cap+(overflow?1:0));
  if(multibyte)assert.ok(raw.length<cap,'multibyte case distinguishes bytes from the old character-count cap');
  const outcome=transport({}).then(value=>({value}),error=>({error}));callback(response);
  response.emit('data',raw);response.emit('end');
  const answer=await outcome;
  if(overflow)assert.match(answer.error.message,/Quant response too large/);
  else assert.deepEqual(answer.value,{status:200,body:payload});
  response.emit('error',new Error('late response'));request.emit('error',new Error('late request'));
  assert.equal(clears,1);
});
