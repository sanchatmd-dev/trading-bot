import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A fresh context per load: the module is a classic browser script that sets one global, so no process global is touched.
const source=fs.readFileSync(new URL('../public/chart-indicators.js',import.meta.url),'utf8');
const load=()=>vm.runInNewContext(source+'\n;ChartIndicators',{});
const C=load();
// Objects made inside the vm context have another Object prototype; plain() copies them into this realm for deep comparisons.
const plain=value=>JSON.parse(JSON.stringify(value));

const close=(got,want,label='')=>{
  if(want===null){assert.equal(got,null,label+' expected null, got '+got);return;}
  assert.ok(typeof got==='number'&&Math.abs(got-want)<=1e-9*Math.max(1,Math.abs(want)),label+' got '+got+' want '+want);
};
const series=(got,want,label='')=>{
  assert.equal(got.length,want.length,label+' length');
  want.forEach((value,at)=>close(got[at],value,label+'['+at+']'));
};
const lead=(count,list)=>[...Array(count).fill(null),...list];

test('EMA: SMA seed, alpha 2/(N+1), nulls before the seed, a short series stays null, leading nulls are skipped',()=>{
  series(C.ema([1,2,3,4,5,6],3),[null,null,2,3,4,5]);
  series(C.ema([10,11,12,13,12,11],3),[null,null,11,12,12,11.5]);
  series(C.ema([1,2],3),[null,null]);
  series(C.ema([null,null,1,2,3,4],3),[null,null,null,null,2,3]);
  series(C.ema([1,2,3,Number.NaN,5],2),[null,1.5,2.5,null,null],'a non-finite value ends the series');
  series(C.ema([1,2,3],0),[null,null,null]);series(C.ema([1,2,3],2.5),[null,null,null]);
  series(C.ema([],3),[]);
});

test('Wilder RMA, true range, ATR and the ATR stop',()=>{
  series(C.rma([1,2,3,4,5,6],3),[null,null,2,8/3,31/9,116/27]);
  const high=[10,11,12,13,12],low=[8,9,9,10,10],closeSeries=[9,10,11,12,11];
  series(C.trueRange(high,low,closeSeries),[2,2,3,3,2]);
  const atr=C.atr(high,low,closeSeries,3);
  series(atr,[null,null,7/3,23/9,64/27]);
  series(C.atrStop(closeSeries,atr,2),[null,null,19/3,62/9,169/27]);
  series(C.atr([12,12,12,12,12],[10,10,10,10,10],[11,11,11,11,11],3),[null,null,2,2,2]);
});

test('RSI: Wilder smoothing, a flat window reads 100, a falling series reads 0, an SMA-RSI mistake is caught',()=>{
  series(C.rsi([1,2,3,2,3,4],3),[null,null,null,200/3,700/9,2300/27]);
  series(C.rsi([5,4,3,2,1],3),[null,null,null,0,0]);
  series(C.rsi([5,5,5,5,5],3),[null,null,null,100,100]);
  const rising=Array.from({length:20},(_,at)=>100+at);
  close(C.rsi(rising,14)[19],100,'rising');
  const alternating=Array.from({length:30},(_,at)=>at%2?101:100),rsi=C.rsi(alternating,14);
  assert.equal(rsi[13],null);close(rsi[14],50,'index 14');close(rsi[29],52.4611586022,'index 29');
});

test('MACD: line, signal and histogram on a small vector and on constant closes',()=>{
  const result=C.macd([1,3,2,5,4,7,6],2,3,2);
  series(result.line,[null,null,0,0.5,0.25,0.625,0.3125]);
  series(result.signal,[null,null,null,0.25,0.25,0.5,0.375]);
  series(result.histogram,[null,null,null,0.25,0,0.125,-0.0625]);
  const flat=Array(40).fill(7);
  const smooth=C.ema(flat,12);
  assert.equal(smooth[10],null);
  for(let at=11;at<40;at++)close(smooth[at],7,'constant EMA '+at);
  const constant=C.macd(flat,12,26,9);
  for(const [name,first] of [['line',25],['signal',33],['histogram',33]]){
    assert.equal(constant[name][first-1],null,name+' before');
    for(let at=first;at<40;at++)close(constant[name][at],0,name+'['+at+']');
  }
  for(const [fast,slow,signal] of [[26,26,9],[30,26,9],[0,26,9],[12,26,0],[2.5,26,9]]){
    const bad=C.macd(flat,fast,slow,signal);
    for(const name of ['line','signal','histogram'])assert.ok(bad[name].length===40&&bad[name].every(value=>value===null),fast+'/'+slow+'/'+signal);
  }
});

test('first defined indices with the defaults on 300 bars',()=>{
  const bars=Array.from({length:300},(_,at)=>{const base=100+10*Math.sin(at/9);return {high:String(base+2),low:String(base-2),close:String(base)};});
  const out=C.compute(bars,C.DEFAULTS),first=values=>values.findIndex(value=>value!==null);
  assert.equal(first(out.ema1),49);assert.equal(first(out.ema2),199);assert.equal(first(out.atrStop),13);
  assert.equal(first(C.compute(bars,{...C.DEFAULTS,rsi:{on:true,period:14}}).rsi),14);
  const macd=C.compute(bars,{...C.DEFAULTS,macd:{on:true,fast:12,slow:26,signal:9}}).macd;
  assert.equal(first(macd.line),25);assert.equal(first(macd.signal),33);assert.equal(first(macd.histogram),33);
});

// 40 bars as the server sends them: decimal strings.
const CLOSES=['100.93','103.91','101.95','103.92','105.68','104.08','106.31','106.13','104.81','107.03','108.95','107.86','110.70','109.05','110.96','113.04','113.58','112.98','112.27','114.93','113.44','110.47','109.98','109.86','110.54','110.86','111.84','114.57','117.01','117.85','119.68','121.44','119.58','121.75','119.27','117.73','116.59','118.42','115.47','117.43'];
const HIGHS=['101.54','105.27','105.68','105.40','106.06','106.10','108.00','107.77','106.87','107.87','109.30','109.70','111.64','111.57','111.58','114.44','113.76','114.98','113.78','115.79','115.20','114.01','110.91','111.06','111.94','111.76','112.42','114.97','118.23','119.15','121.05','123.43','122.58','122.89','123.62','120.18','119.45','119.24','119.07','119.02'];
const LOWS=['98.74','99.58','100.54','101.27','102.76','102.50','103.86','105.40','102.97','103.95','106.71','106.85','106.35','107.30','107.98','110.74','111.66','112.47','111.43','112.22','112.11','109.91','108.37','108.16','109.82','109.52','109.88','110.80','114.54','116.21','117.28','118.69','118.23','118.19','119.10','116.12','116.12','115.73','114.05','113.48'];
const EMA5=[103.278,103.5453333333,104.4668888889,105.0212592593,104.9508395062,105.6438930041,106.7459286694,107.1172857796,108.3115238531,108.5576825687,109.3584550458,110.5856366972,111.5837577981,112.0491718654,112.1227812436,113.0585208291,113.1856805527,112.2804537018,111.5136358012,110.9624238675,110.8216159116,110.8344106078,111.1696070718,112.3030713812,113.8720475875,115.198031725,116.69202115,118.2746807667,118.7097871778,119.7231914519,119.5721276346,118.9580850897,118.1687233931,118.2524822621,117.3249881747,117.3599921165];
const RSI14=[69.5669137729,72.0129171152,72.6279986794,70.7669917736,68.5292415226,72.0900448694,67.4839727263,59.3445905292,58.0995376663,57.7798302106,59.151557993,59.8132510565,61.8513311818,66.8890233478,70.6229995861,71.8019428057,74.2284545086,76.3374293024,69.8334468077,72.750424131,65.0131943058,60.6963511039,57.6449796863,61.0316679987,53.5924158522,57.315185597];
const ATR14=[3.8564285714,3.8381122449,3.8282470845,3.7048008642,3.6194579454,3.5287823778,3.5317264937,3.5001746013,3.5430192726,3.4713750389,3.4305625361,3.3369509264,3.2585972888,3.207268911,3.2760354174,3.3056043161,3.2794897221,3.3145261705,3.4163457298,3.4830353205,3.569961369,3.6378212713,3.6679768947,3.643835688,3.634275996,3.733256282,3.8623094047];
const MACD=[2.092263537,2.0269361202,2.1704324618,2.452767972,2.7130277823,3.0320002516,3.3877536078,3.4794948002,3.6848248535,3.605868914,3.3800673214,3.073697785,2.9446196835,2.574605562,2.4117215003];
const SIGNAL=[2.7821668207,2.9469072394,3.0335392558,3.0415709616,3.022180706,2.9326656772,2.8284768418];
const HIST=[0.9026580328,0.6589616747,0.3465280656,0.0321268234,-0.0775610225,-0.3580601152,-0.4167553415];

test('40-bar fixture of decimal strings matches the reference values to 1e-9',()=>{
  const bars=CLOSES.map((value,at)=>({high:HIGHS[at],low:LOWS[at],close:value}));
  const numbers=list=>list.map(Number);
  series(C.ema(numbers(CLOSES),5),lead(4,EMA5),'EMA5');
  series(C.rsi(numbers(CLOSES),14),lead(14,RSI14),'RSI14');
  const atr=C.atr(numbers(HIGHS),numbers(LOWS),numbers(CLOSES),14);
  series(atr,lead(13,ATR14),'ATR14');
  const macd=C.macd(numbers(CLOSES),12,26,9);
  series(macd.line,lead(25,MACD),'MACD');series(macd.signal,lead(33,SIGNAL),'SIGNAL');series(macd.histogram,lead(33,HIST),'HIST');
  close(C.atrStop(numbers(CLOSES),atr,2)[39],109.7053811906,'ATR stop');
  // compute() converts the strings itself and gives the same series.
  const out=C.compute(bars,{...C.DEFAULTS,ema1:{on:true,period:5},rsi:{on:true,period:14},macd:{on:true,fast:12,slow:26,signal:9}});
  series(out.ema1,lead(4,EMA5),'compute EMA5');series(out.rsi,lead(14,RSI14),'compute RSI');series(out.atrStop,C.atrStop(numbers(CLOSES),atr,2),'compute ATR stop');
  series(out.macd.histogram,lead(33,HIST),'compute HIST');
});

test('parseField: bounded integers and a one-decimal multiplier; everything else is null',()=>{
  for(const [text,want] of [['50',50],[' 50 ',50],['1',null],['501',null],['2.5',null],['',null],['abc',null],['1e2',null],['-5',null],['0x10',null],['500',500],['2',2]])
    assert.equal(C.parseField('ema1.period',text),want,'ema1.period '+JSON.stringify(text));
  for(const [text,want] of [['2.35',2.4],['2.05',2.1],['0.5',0.5],['.5',0.5],['10',10],['9.96',10],['0.45',null],['0.4',null],['10.04',null],['1e1',null],['2',2],['abc',null]])
    assert.equal(C.parseField('atr.multiplier',text),want,'atr.multiplier '+JSON.stringify(text));
  assert.equal(C.parseField('macd.slow','3'),3);assert.equal(C.parseField('macd.slow','2'),null);
  assert.equal(C.parseField('nope.period','5'),null);assert.equal(C.parseField('__proto__','5'),null);assert.equal(C.parseField(undefined,'5'),null);
  assert.equal(C.parseField('rsi.period',14),14,'a number is read through its text');
});

test('sanitize: always a new, unfrozen, complete object; bad fields fall back one by one',()=>{
  for(const raw of [null,undefined,[],'x',5,{v:2},{},{v:'1'}]){
    const out=C.sanitize(raw);
    assert.deepEqual(plain(out),plain(C.DEFAULTS));assert.notEqual(out,C.DEFAULTS);assert.ok(!Object.isFrozen(out)&&!Object.isFrozen(out.ema1));
  }
  assert.deepEqual(plain(C.sanitize({v:1,ema1:{on:'yes',period:7}}).ema1),{on:true,period:7});
  assert.deepEqual(plain(C.sanitize({v:1,ema2:{on:false,period:9999}}).ema2),{on:false,period:200});
  assert.equal(C.sanitize({v:1,atr:{on:true,period:14,multiplier:2.04}}).atr.multiplier,2);
  assert.equal(C.sanitize({v:1,atr:{on:true,period:14,multiplier:10.04}}).atr.multiplier,2);
  assert.deepEqual(plain(C.sanitize({v:1,macd:{on:true,fast:30,slow:26,signal:9}}).macd),{on:true,fast:12,slow:26,signal:9});
  assert.equal(C.sanitize({v:1,rsi:{on:true,period:14.5}}).rsi.period,14);
  assert.equal(C.sanitize({v:1,rsi:{on:true,period:'20'}}).rsi.period,14,'a string is not a number');
  assert.equal(C.sanitize({v:1,ema1:'x',atr:null,rsi:[],macd:5}).ema1.period,50);
  assert.deepEqual(plain(C.sanitize({v:1,bogus:{on:true}})),plain(C.DEFAULTS));
  const once=C.sanitize({v:1,ema1:{on:false,period:20},macd:{on:true,fast:5,slow:10,signal:3}});
  assert.deepEqual(plain(C.sanitize(plain(once))),plain(once),'a settings object survives the storage round trip');
});

test('constants are deep-frozen; minBars names the bars each indicator needs',()=>{
  assert.ok(Object.isFrozen(C)&&Object.isFrozen(C.DEFAULTS)&&Object.isFrozen(C.DEFAULTS.macd)&&Object.isFrozen(C.LIMITS)&&Object.isFrozen(C.LIMITS['atr.multiplier']));
  assert.deepEqual(plain(C.minBars(C.DEFAULTS)),{ema1:50,ema2:200,atr:14,rsi:15,macd:34});
  assert.deepEqual(plain(C.DEFAULTS),{v:1,ema1:{on:true,period:50},ema2:{on:true,period:200},atr:{on:true,period:14,multiplier:2},rsi:{on:false,period:14},macd:{on:false,fast:12,slow:26,signal:9}});
});

test('compute: off keys are null, on keys keep the input length, inputs are untouched, results are deterministic, RSI stays in range, 1000 bars are fast',()=>{
  let seed=12345;
  const random=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296;};
  let price=100;
  const bars=Array.from({length:1000},()=>{
    const open=price;price=Math.max(1,price+(random()-0.5)*4);
    return {open:open.toFixed(2),high:(Math.max(open,price)+random()).toFixed(2),low:(Math.min(open,price)-random()).toFixed(2),close:price.toFixed(2),volume:'1'};
  });
  const settings={v:1,ema1:{on:true,period:50},ema2:{on:false,period:200},atr:{on:true,period:14,multiplier:2},rsi:{on:true,period:14},macd:{on:true,fast:12,slow:26,signal:9}};
  const barsBefore=structuredClone(bars),settingsBefore=structuredClone(settings);
  const out=C.compute(bars,settings);
  assert.equal(out.ema2,null);assert.equal(out.ema1.length,1000);assert.equal(out.atrStop.length,1000);assert.equal(out.rsi.length,1000);assert.equal(out.macd.histogram.length,1000);
  assert.deepEqual(bars,barsBefore);assert.deepEqual(settings,settingsBefore);
  assert.deepEqual(C.compute(bars,settings),out);assert.deepEqual(plain(C.compute(bars,settings)),plain(out));
  for(const value of out.rsi)assert.ok(value===null||(value>=0&&value<=100));
  const allOn={...C.DEFAULTS,rsi:{on:true,period:14},macd:{on:true,fast:12,slow:26,signal:9}};
  const started=performance.now();C.compute(bars,allOn);
  assert.ok(performance.now()-started<200,'1000 bars, all five on');
  const off=C.compute(bars,{...C.DEFAULTS,ema1:{on:false,period:50},ema2:{on:false,period:200},atr:{on:false,period:14,multiplier:2}});
  assert.deepEqual(plain(off),{ema1:null,ema2:null,atrStop:null,rsi:null,macd:null});
  assert.doesNotThrow(()=>C.compute([],C.DEFAULTS));
  assert.deepEqual(plain(C.compute([],C.DEFAULTS).ema1),[]);
  assert.doesNotThrow(()=>C.compute([{high:'x',low:null,close:undefined}],allOn));
});

test('source bans: no DOM, storage, network, timers, clock or randomness; the global is assigned once',()=>{
  assert.doesNotMatch(source,/\b(document|window|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|Date|require|import|eval|Function|setTimeout|setInterval)\b/);
  for(const banned of ['Math.random','api(','innerHTML'])assert.ok(!source.includes(banned),banned);
  assert.equal(source.split('globalThis').length-1,1,'globalThis appears once, on the export line');
  // A Windows checkout may turn LF into CRLF; either way there is no stray CR and the file ends with a newline.
  const lines=source.replace(/\r\n/g,'\n');
  assert.ok(lines.endsWith('\n')&&!lines.includes('\r'),'one line-ending style with a trailing newline');
});

test('isolation: visual aids never reach trading code (only the chart script and its page load the module)',()=>{
  const root=new URL('../',import.meta.url),found=[];
  const walk=(url,extensions)=>{
    for(const entry of fs.readdirSync(url,{withFileTypes:true})){
      const child=new URL(entry.name+(entry.isDirectory()?'/':''),url);
      if(entry.isDirectory()){walk(child,extensions);continue;}
      if(!extensions.some(extension=>entry.name.endsWith(extension)))continue;
      const text=fs.readFileSync(child,'utf8');
      if(text.includes('ChartIndicators')||text.includes('chart-indicators'))found.push(child.pathname.slice(root.pathname.length));
    }
  };
  walk(new URL('src/',root),['.js','.mjs']);
  walk(new URL('scripts/',root),['.js','.mjs']);
  walk(new URL('public/',root),['.js','.mjs','.html','.css','.json','.webmanifest','.svg']);
  assert.deepEqual(found.sort(),['public/chart-indicators.js','public/index.html','public/interactive-chart.js']);
  const html=fs.readFileSync(new URL('public/index.html',root),'utf8');
  assert.equal(html.split('chart-indicators').length-1,1,'index.html names the module once');
  assert.ok(!html.includes('ChartIndicators'));
  assert.equal(html.match(/<script src="\/chart-indicators\.js\?v=mc3"><\/script>/)?.length,1);
});
