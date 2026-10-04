/* Chart indicators (Overview market chart): EMA, ATR stop line, RSI and MACD as visual aids only. Nothing here feeds a bot, the
   Risk Manager, Preflight or any order. All inputs are plain numbers; a null in a result means "not enough bars yet, not drawn".
   Definitions: EMA seeds with the simple average of the first N values (alpha 2/(N+1)); ATR and RSI use Wilder smoothing seeded the
   same way; MACD is EMA(fast) minus EMA(slow) with an EMA signal line of that result. The first true range is high minus low. A flat
   RSI period with no gains and no losses reads 100. Every series has the input length and is computed in one pass. */
(() => {
  'use strict';
  const freeze=value=>{
    if(value!==null&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
    return value;
  };
  const DEFAULTS=freeze({v:1,ema1:{on:true,period:50},ema2:{on:true,period:200},atr:{on:true,period:14,multiplier:2},
    rsi:{on:false,period:14},macd:{on:false,fast:12,slow:26,signal:9}});
  const LIMITS=freeze({'ema1.period':{min:2,max:500,step:1},'ema2.period':{min:2,max:500,step:1},'atr.period':{min:2,max:100,step:1},
    'atr.multiplier':{min:0.5,max:10,step:0.1},'rsi.period':{min:2,max:100,step:1},'macd.fast':{min:2,max:100,step:1},
    'macd.slow':{min:3,max:200,step:1},'macd.signal':{min:2,max:100,step:1}});

  const isNumber=value=>typeof value==='number'&&Number.isFinite(value);
  const blank=length=>new Array(length).fill(null);
  const firstDefined=values=>{
    for(let at=0;at<values.length;at++)if(values[at]!==null&&values[at]!==undefined)return at;
    return -1;
  };
  /** Seeds at the first N defined values with their mean, then applies next(previous, value). A non-finite value ends the series. */
  function smooth(values,period,next){
    const out=blank(values.length);
    if(!Number.isInteger(period)||period<1)return out;
    const start=firstDefined(values);
    if(start<0)return out;
    let sum=0;
    for(let at=start;at<values.length;at++){
      const value=values[at];
      if(!isNumber(value))break;
      if(at<start+period-1){sum+=value;continue;}
      out[at]=at===start+period-1?(sum+value)/period:next(out[at-1],value);
    }
    return out;
  }
  const ema=(values,period)=>{const alpha=2/(period+1);return smooth(values,period,(previous,value)=>previous+alpha*(value-previous));};
  const rma=(values,period)=>smooth(values,period,(previous,value)=>(previous*(period-1)+value)/period);

  function trueRange(high,low,close){
    const out=blank(high.length);
    for(let at=0;at<high.length;at++){
      if(!isNumber(high[at])||!isNumber(low[at]))continue;
      if(at===0){out[at]=high[at]-low[at];continue;}
      if(!isNumber(close[at-1]))continue;
      out[at]=Math.max(high[at]-low[at],Math.abs(high[at]-close[at-1]),Math.abs(low[at]-close[at-1]));
    }
    return out;
  }
  const atr=(high,low,close,period)=>rma(trueRange(high,low,close),period);
  const atrStop=(close,atrSeries,multiplier)=>close.map((value,at)=>isNumber(atrSeries[at])&&isNumber(value)?value-multiplier*atrSeries[at]:null);

  function rsi(close,period){
    const gain=blank(close.length),loss=blank(close.length);
    for(let at=1;at<close.length;at++){
      if(!isNumber(close[at])||!isNumber(close[at-1]))continue;
      gain[at]=Math.max(close[at]-close[at-1],0);loss[at]=Math.max(close[at-1]-close[at],0);
    }
    const up=rma(gain,period),down=rma(loss,period);
    return close.map((_,at)=>!isNumber(up[at])||!isNumber(down[at])?null:down[at]===0?100:up[at]===0?0:100-100/(1+up[at]/down[at]));
  }

  function macd(close,fast,slow,signal){
    const empty=()=>({line:blank(close.length),signal:blank(close.length),histogram:blank(close.length)});
    if(![fast,slow,signal].every(Number.isInteger)||fast<1||fast>=slow||signal<1)return empty();
    const quick=ema(close,fast),late=ema(close,slow);
    const line=close.map((_,at)=>isNumber(quick[at])&&isNumber(late[at])?quick[at]-late[at]:null);
    const signalLine=ema(line,signal);
    const histogram=line.map((value,at)=>isNumber(value)&&isNumber(signalLine[at])?value-signalLine[at]:null);
    return {line,signal:signalLine,histogram};
  }

  /** Bars needed before the first value of each indicator (MACD counts the histogram). */
  const minBars=settings=>({ema1:settings.ema1.period,ema2:settings.ema2.period,atr:settings.atr.period,rsi:settings.rsi.period+1,
    macd:settings.macd.slow+settings.macd.signal-1});

  /** Typed text of one settings field to a valid number, or null. The multiplier keeps one decimal. */
  function parseField(key,text){
    if(typeof key!=='string'||!Object.hasOwn(LIMITS,key))return null;
    const limit=LIMITS[key],clean=String(text).trim();
    const shape=limit.step===1?/^\d{1,4}$/:/^(?:\d{1,2}(?:\.\d{1,3})?|\.\d{1,3})$/;
    if(!shape.test(clean))return null;
    const value=Number(clean);
    if(!(value>=limit.min&&value<=limit.max))return null;
    return limit.step===1?value:Math.round(value*10)/10;
  }

  const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const copy=value=>plain(value)?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])):value;
  /** Any saved value to a complete, valid settings object (always a new object, never DEFAULTS itself). */
  function sanitize(raw){
    const out=copy(DEFAULTS);
    if(!plain(raw)||raw.v!==1)return out;
    for(const group of Object.keys(DEFAULTS)){
      if(group==='v'||!plain(raw[group]))continue;
      const saved=raw[group];
      if(typeof saved.on==='boolean')out[group].on=saved.on;
      for(const name of Object.keys(DEFAULTS[group])){
        if(name==='on')continue;
        const limit=LIMITS[group+'.'+name],value=saved[name];
        if(!isNumber(value)||value<limit.min||value>limit.max||(limit.step===1&&!Number.isInteger(value)))continue;
        out[group][name]=limit.step===1?value:Math.round(value*10)/10;
      }
    }
    if(out.macd.fast>=out.macd.slow){out.macd.fast=DEFAULTS.macd.fast;out.macd.slow=DEFAULTS.macd.slow;}
    return out;
  }

  const toNumber=value=>value===null||value===undefined||value===''?NaN:Number(value);
  /** One pass over the bars (decimal strings or numbers). A key is null when that indicator is off. Inputs are never changed. */
  function compute(bars,settings){
    const high=bars.map(bar=>toNumber(bar.high)),low=bars.map(bar=>toNumber(bar.low)),close=bars.map(bar=>toNumber(bar.close));
    const on=key=>!!settings&&!!settings[key]&&settings[key].on===true;
    const out={ema1:null,ema2:null,atrStop:null,rsi:null,macd:null};
    if(on('ema1'))out.ema1=ema(close,settings.ema1.period);
    if(on('ema2'))out.ema2=ema(close,settings.ema2.period);
    if(on('atr'))out.atrStop=atrStop(close,atr(high,low,close,settings.atr.period),settings.atr.multiplier);
    if(on('rsi'))out.rsi=rsi(close,settings.rsi.period);
    if(on('macd'))out.macd=macd(close,settings.macd.fast,settings.macd.slow,settings.macd.signal);
    return out;
  }

  globalThis.ChartIndicators=Object.freeze({DEFAULTS,LIMITS,ema,rma,trueRange,atr,atrStop,rsi,macd,minBars,parseField,sanitize,compute});
})();
