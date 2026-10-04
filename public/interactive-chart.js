/* Market chart (Analytics): closed BINANCE:BTCUSDT Spot bars that the server already stored from the public Binance feed.
   Read-only and CSP-safe: no external script, no request to any other host (one authenticated GET of the same origin through
   the page helper), no inline style, no markup injection. Candles are SVG nodes made with createElementNS and painted by market-chart.css;
   every value is set with textContent or a geometry attribute. Prices shown come from the server as exact decimal strings. */
(() => {
  const SVG_NS='http://www.w3.org/2000/svg';
  const panel=document.getElementById('interactiveChartPanel'),root=document.getElementById('interactiveChart'),
    svg=document.getElementById('marketChartSvg'),status=document.getElementById('marketChartStatus'),meta=document.getElementById('marketChartMeta');
  if(!panel||!root||!svg||!status||!meta)return;
  const page=document.querySelector('[data-page="analytics"]'),app=document.getElementById('app');
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  const errorCode=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');
  const pad=value=>String(value).padStart(2,'0');
  const date=ms=>{const d=new Date(ms);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());};
  const clock=ms=>{const d=new Date(ms);return pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());};
  const stamp=ms=>Number.isFinite(ms)?date(ms)+' '+clock(ms)+' UTC':'—';
  const axisTime=(ms,interval)=>interval==='1d'?date(ms):interval==='1h'||interval==='4h'?date(ms).slice(5)+' '+clock(ms):clock(ms);

  // Layout in the 900 x 380 viewBox: plot, price labels on the right, volume under the price area.
  const X0=8,X1=820,LABEL_X=824,PRICE_TOP=10,PRICE_BOTTOM=300,VOLUME_TOP=310,VOLUME_BOTTOM=370,TIME_Y=378;
  const GEOMETRY=new Set(['x','y','x1','y1','x2','y2','width','height']);
  const round=value=>Math.round(value*100)/100;
  const node=(tag,className,attributes,text)=>{
    const element=document.createElementNS(SVG_NS,tag);
    if(className)element.setAttribute('class',className);
    if(attributes)for(const [name,value] of Object.entries(attributes))if(GEOMETRY.has(name))element.setAttribute(name,String(round(value)));
    if(text!==undefined)element.textContent=text;
    return element;
  };

  const state={interval:'1h',seq:0,loading:false,data:null,error:null};
  const show=(name,text)=>{root.dataset.state=name;status.textContent=text;};
  const clearSvg=()=>svg.replaceChildren();

  // Paper position levels from the page's own positions list (loaded by app.js). Rows of other symbols or invalid prices are skipped.
  const LEVELS=[['avg_price','ENTRY','mc-entry'],['stop_loss','SL','mc-sl'],['take_profit','TP','mc-tp']];
  function levels(){
    if(typeof positions==='undefined'||!Array.isArray(positions))return [];
    const found=[];
    for(const row of positions){
      if(!row||row.broker!=='binance-global'||row.symbol!=='BTCUSDT'||!(Number(row.quantity)>0))continue;
      for(const [key,tag,className] of LEVELS){
        const price=Number(row[key]);
        if(Number.isFinite(price)&&price>0)found.push({tag,className,price,text:String(row[key])});
      }
    }
    return found;
  }

  const tip=bar=>stamp(bar.time)+' · O '+bar.open+' · H '+bar.high+' · L '+bar.low+' · C '+bar.close+' · V '+bar.volume+' · '+bar.minutes+' min';
  const ticks=(count,wanted)=>{
    const step=Math.max(1,Math.ceil(count/wanted)),picks=[];
    for(let at=0;at<count;at+=step)picks.push(at);
    return picks;
  };

  /** Draws the candles, grid, labels and position levels. Number() is used for pixel geometry only. */
  function draw(bars,found,interval,intervalMs){
    clearSvg();
    const usable=bars.filter(bar=>[bar.open,bar.high,bar.low,bar.close,bar.volume].every(value=>Number.isFinite(Number(value))));
    if(usable.length===0)return;
    let min=Math.min(...usable.map(bar=>Number(bar.low)),...found.map(level=>level.price));
    let max=Math.max(...usable.map(bar=>Number(bar.high)),...found.map(level=>level.price));
    if(max===min){min-=1;max+=1;}
    const margin=(max-min)*0.04;min-=margin;max+=margin;
    const y=price=>PRICE_TOP+(max-price)/(max-min)*(PRICE_BOTTOM-PRICE_TOP);
    const peak=Math.max(...usable.map(bar=>Number(bar.volume)),0);
    // Candles sit on the time axis: a bucket with no stored minutes leaves an empty slot instead of the neighbors closing the gap.
    const step=Number.isFinite(intervalMs)&&intervalMs>0?intervalMs:null,t0=usable[0].time;
    const place=(bar,index)=>step===null?index:Math.round((bar.time-t0)/step);
    const slots=Math.max(usable.length,step===null?0:place(usable[usable.length-1],usable.length-1)+1);
    const slot=(X1-X0)/slots,width=Math.max(1,slot*0.7);
    const grid=node('g','mc-grid-group');
    for(let line=0;line<5;line++){
      const price=max-(max-min)*line/4,at=y(price);
      grid.append(node('line','mc-grid',{x1:X0,x2:X1,y1:at,y2:at}),node('text','mc-axis',{x:LABEL_X,y:at+4},price.toFixed(2)));
    }
    svg.append(grid);
    usable.forEach((bar,index)=>{
      const x=X0+slot*(place(bar,index)+0.5),open=Number(bar.open),close=Number(bar.close),direction=close>=open?'mc-up':'mc-down';
      const group=node('g','mc-bar'+(bar.complete===false?' mc-incomplete':''));
      const volume=peak>0?Number(bar.volume)/peak*(VOLUME_BOTTOM-VOLUME_TOP):0;
      group.append(node('title',null,null,tip(bar)),
        node('line','mc-wick '+direction,{x1:x,x2:x,y1:y(Number(bar.high)),y2:y(Number(bar.low))}),
        node('rect','mc-candle '+direction,{x:x-width/2,y:Math.min(y(open),y(close)),width,height:Math.max(1,Math.abs(y(open)-y(close)))}),
        node('rect','mc-vol '+direction,{x:x-width/2,y:VOLUME_BOTTOM-volume,width,height:volume}));
      svg.append(group);
    });
    for(const at of ticks(usable.length,5))
      svg.append(node('text','mc-axis mc-axis-mid',{x:X0+slot*(place(usable[at],at)+0.5),y:TIME_Y},axisTime(usable[at].time,interval)));
    const last=usable[usable.length-1],lastY=y(Number(last.close));
    svg.append(node('line','mc-last',{x1:X0,x2:X1,y1:lastY,y2:lastY}),node('text','mc-axis mc-last-label',{x:LABEL_X,y:lastY+4},last.close));
    for(const level of found){
      const at=y(level.price);
      svg.append(node('line','mc-level '+level.className,{x1:X0,x2:X1,y1:at,y2:at}),node('text','mc-level-label',{x:X0+4,y:at-3},level.tag+' '+level.text));
    }
  }

  const metaText=(data,bars)=>{
    let text=tpl('{bars} bars · interval {interval} · stored Binance Spot public data · generated {time}',
      {bars:bars.length,interval:data.interval,time:stamp(Date.parse(data.generated_at))});
    if(data.gaps?.count>0)text+=' · '+tpl('{count} gaps · {missing} missing 1m bars in this window',{count:data.gaps.count,missing:data.gaps.missing_minutes});
    return text;
  };

  function render(){
    if(state.error!==null){clearSvg();meta.textContent='';show('unavailable',tpl('Market data unavailable ({code})',{code:state.error}));return;}
    const data=state.data;
    if(data===null){
      clearSvg();meta.textContent='';
      if(state.loading)show('loading',T('Loading market data…'));else show('idle','');
      return;
    }
    const bars=Array.isArray(data.bars)?data.bars:[];
    if(bars.length===0){clearSvg();meta.textContent='';show('empty',T('No stored bars for this interval yet'));return;}
    draw(bars,levels(),data.interval||state.interval,Number(data.interval_ms));
    meta.textContent=metaText(data,bars);
    if(data.stale===true)show('stale',tpl('Stale: latest closed bar is {age} s old (limit {limit} s)',
      {age:data.age_seconds,limit:data.stale_after_seconds??180}));
    else show('ready',tpl('Latest closed bar {time} · age {age} s',{time:stamp(data.latest_closed_bar?.close_time),age:data.age_seconds}));
  }

  async function load(){
    const interval=state.interval,seq=++state.seq;
    state.loading=true;
    if(state.data===null&&state.error===null)render();
    try{
      const data=await api('/api/market/ohlcv?interval='+interval,{silent:true});
      if(seq!==state.seq)return;
      state.loading=false;state.error=null;state.data=data;render();
    }catch(error){
      if(seq!==state.seq)return;
      state.loading=false;state.data=null;state.error=errorCode(error);render();
    }
  }
  function clear(){state.seq++;state.loading=false;state.data=null;state.error=null;clearSvg();meta.textContent='';show('idle','');}
  const visible=()=>!!page&&!page.hidden&&(!app||!app.hidden);

  const buttons=[...panel.querySelectorAll('[data-mc-interval]')];
  for(const button of buttons)button.addEventListener('click',()=>{
    state.interval=button.dataset.mcInterval;
    for(const other of buttons){const on=other===button;other.classList.toggle('active',on);other.ariaPressed=String(on);}
    // Nothing of the old interval stays on screen while the new one loads.
    state.data=null;state.error=null;load();
  });
  document.getElementById('marketChartRefresh')?.addEventListener('click',load);
  document.querySelector('nav button[data-view="analytics"]')?.addEventListener('click',load);
  document.getElementById('refresh')?.addEventListener('click',()=>{if(visible())load();});
  document.getElementById('language')?.addEventListener('change',render);
  document.getElementById('logout')?.addEventListener('click',clear);
  // A quiet refresh while the chart is on screen: the stored feed adds a bar every minute.
  setInterval(()=>{if(visible()&&!document.hidden)load();},60000);
})();
