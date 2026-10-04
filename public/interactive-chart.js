/* Market chart (Overview): Binance Spot public market data for any listed symbol, view only. The server answers from its own
   stored bars or from its keyless public proxy; this page never talks to another host (three same-origin reads through the
   page helper), loads no external script, sets no inline style and injects no markup. Candles are SVG nodes made with
   createElementNS and painted by market-chart.css; every value is set with textContent or a geometry attribute. Prices shown
   come from the server as exact decimal strings. The chart cannot place, change or close orders.
   Indicators (two EMAs, an ATR stop line, RSI, MACD) come from chart-indicators.js. They are visual aids computed in this
   browser from the bars already on screen: they are never sent anywhere and never reach a bot, risk check or order. */
(() => {
  const SVG_NS='http://www.w3.org/2000/svg';
  const panel=document.getElementById('interactiveChartPanel'),root=document.getElementById('interactiveChart'),
    svg=document.getElementById('marketChartSvg'),status=document.getElementById('marketChartStatus'),meta=document.getElementById('marketChartMeta'),
    input=document.getElementById('mcSymbolInput'),list=document.getElementById('mcSymbolList'),select=document.getElementById('mcInterval'),
    held=document.getElementById('mcHeld'),chips=document.getElementById('mcHeldChips'),symbolBadge=document.getElementById('mcSymbolBadge'),
    sourceBadge=document.getElementById('marketChartSource'),legend=document.getElementById('marketChartLevels'),legendTitle=document.getElementById('marketChartLevelsTitle');
  if(!panel||!root||!svg||!status||!meta||!input||!list||!select||!held||!chips||!symbolBadge||!sourceBadge||!legend||!legendTitle)return;
  const picker=input.closest('.mc-picker'),page=panel.closest('[data-page]'),app=document.getElementById('app');
  if(!picker)return;
  // Indicators are optional: without the module or any of its nodes the plain chart keeps working.
  const IND=typeof ChartIndicators==='object'&&ChartIndicators!==null?ChartIndicators:null;
  const indBox=document.getElementById('mcIndicators'),indValues=document.getElementById('mcIndValues'),indNote=document.getElementById('mcIndNote'),
    indReset=document.getElementById('mcIndReset'),rsiPane=document.getElementById('mcRsiPane'),rsiSvg=document.getElementById('mcRsiSvg'),
    macdPane=document.getElementById('mcMacdPane'),macdSvg=document.getElementById('mcMacdSvg');
  const indicatorsOn=IND!==null&&!!(indBox&&indValues&&indNote&&indReset&&rsiPane&&rsiSvg&&macdPane&&macdSvg);
  if(!indicatorsOn){
    if(indBox)indBox.hidden=true;
    if(rsiPane)rsiPane.hidden=true;
    if(macdPane)macdPane.hidden=true;
  }
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  const errorCode=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');
  const pad=value=>String(value).padStart(2,'0');
  const date=ms=>{const d=new Date(ms);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());};
  const clock=ms=>{const d=new Date(ms);return pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());};
  const stamp=ms=>Number.isFinite(ms)?date(ms)+' '+clock(ms)+' UTC':'—';
  const DAILY=new Set(['1d','3d','1w']),INTRADAY=new Set(['1h','2h','4h','6h','8h','12h']);
  const axisTime=(ms,interval)=>DAILY.has(interval)?date(ms):INTRADAY.has(interval)?date(ms).slice(5)+' '+clock(ms):clock(ms);

  // The 14 Binance Spot intervals the server accepts, with the quiet refresh cadence in seconds while the chart is visible.
  const POLL_SECONDS=Object.freeze({'1m':15,'3m':30,'5m':30,'15m':60,'30m':60,'1h':120,'2h':120,'4h':300,'6h':300,'8h':300,'12h':300,'1d':300,'3d':600,'1w':600});
  const SYMBOL_RE=/^[A-Z0-9]{5,20}$/,DEFAULT_SYMBOL='BTCUSDT',DEFAULT_INTERVAL='1d',PREFS_KEY='robotMarketChart.v1';
  const LEVELS_HELD_MS=15000,LEVELS_IDLE_MS=60000,HUNG_MS=60000,MAX_OPTIONS=50,MAX_LINES=30,LABEL_GAP=12;
  // The request asks for the server cap so the indicators get warm-up bars before the visible ones; only the last DISPLAY_BARS are
  // drawn. BTCUSDT 1h and 2h ask for the stored cap, so the bot-feed source is kept when stored coverage spans the window. One
  // limit per symbol and interval keeps one shared proxy cache entry. The tables mirror INTERVALS in src/postgres/market-ohlcv.js
  // (a test pins them).
  const FETCH_LIMIT=1000,BTC_STORED_LIMIT=Object.freeze({'1h':720,'2h':360});
  const DISPLAY_BARS=Object.freeze({'1m':360,'3m':320,'5m':288,'15m':288,'30m':336,'1h':336,'2h':360,'4h':360,'6h':360,'8h':360,'12h':360,'1d':365,'3d':243,'1w':260});

  // Layout in the 900 x 380 viewBox: plot, price labels on the right, volume under the price area.
  const X0=8,X1=820,LABEL_X=824,PRICE_TOP=10,PRICE_BOTTOM=300,VOLUME_TOP=310,VOLUME_BOTTOM=370,TIME_Y=378;
  const GEOMETRY=new Set(['height','points','width','x','x1','x2','y','y1','y2']);
  const round=value=>Math.round(value*100)/100;
  // A polyline is a list of [x, y] pairs computed here; a pair with a non-finite coordinate is dropped.
  const pointsText=pairs=>pairs.filter(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)).map(([x,y])=>round(x)+','+round(y)).join(' ');
  const node=(tag,className,attributes,text)=>{
    const element=document.createElementNS(SVG_NS,tag);
    if(className)element.setAttribute('class',className);
    if(attributes)for(const [name,value] of Object.entries(attributes))if(GEOMETRY.has(name))element.setAttribute(name,name==='points'?pointsText(value):String(round(value)));
    if(text!==undefined)element.textContent=text;
    return element;
  };
  // Plain HTML nodes. The only attributes written by name are the fixed ARIA, id and role set below.
  const ARIA=new Set(['aria-expanded','aria-selected','aria-activedescendant','aria-pressed','id','role']);
  const aria=(element,name,value)=>{if(ARIA.has(name))element.setAttribute(name,String(value));};
  const html=(tag,className,text)=>{
    const element=document.createElement(tag);
    if(className)element.className=className;
    if(text!==undefined)element.textContent=text;
    return element;
  };

  const state={symbol:DEFAULT_SYMBOL,interval:DEFAULT_INTERVAL,data:null,error:null,loading:false,seq:0,dataAt:0,retryIn:0,
    levels:null,levelsError:null,levelsLoading:false,levelsSeq:0,
    symbols:null,symbolsError:null,symbolsLoading:false,symbolsSeq:0,
    due:{chart:0,levels:0,symbols:0},started:{chart:0,levels:0,symbols:0},fails:{chart:0,levels:0,symbols:0},stopped:false,chipsKey:'',
    picker:{open:false,dirty:false,rows:[],active:-1},indicators:null,indNote:null};
  const show=(name,text)=>{root.dataset.state=name;status.textContent=text;};
  const clearSvg=()=>svg.replaceChildren();
  const scopeAll=()=>typeof selectedBot!=='undefined'&&selectedBot==='all';
  const visible=()=>!!page&&!page.hidden&&(!app||!app.hidden)&&!document.hidden;
  const limited=code=>code==='MARKET_RATE_LIMITED'||code==='HTTP_429';
  const fetchLimit=()=>state.symbol===DEFAULT_SYMBOL&&Object.hasOwn(BTC_STORED_LIMIT,state.interval)?BTC_STORED_LIMIT[state.interval]:FETCH_LIMIT;

  // Per-viewer convenience only: the last symbol and interval. Every read and write may fail (private window, blocked data).
  function readPrefs(){
    let saved=null;
    try{saved=JSON.parse(localStorage.getItem(PREFS_KEY));}catch{}
    const symbol=typeof saved?.symbol==='string'&&SYMBOL_RE.test(saved.symbol)?saved.symbol:DEFAULT_SYMBOL;
    const interval=typeof saved?.interval==='string'&&Object.hasOwn(POLL_SECONDS,saved.interval)?saved.interval:DEFAULT_INTERVAL;
    return {symbol,interval,indicators:saved?.indicators};
  }
  function writePrefs(){
    const entry={symbol:state.symbol,interval:state.interval};
    if(state.indicators!==null)entry.indicators=state.indicators;
    try{localStorage.setItem(PREFS_KEY,JSON.stringify(entry));}catch{}
  }

  // Server answers are checked here; unexpected shapes become an error code instead of a crash.
  const text=value=>value===null||value===undefined?null:String(value);
  const invalid=code=>Object.assign(new Error(code),{code});
  function cleanLevels(data){
    if(!Array.isArray(data?.positions))throw invalid('LEVELS_INVALID');
    return data.positions.filter(row=>row&&typeof row==='object').map(row=>({
      bot_id:text(row.bot_id)??'',bot_label:text(row.bot_label)??text(row.bot_id)??'',
      chart_symbol:typeof row.chart_symbol==='string'&&SYMBOL_RE.test(row.chart_symbol)?row.chart_symbol:null,
      quantity:text(row.quantity)??'',avg_price:text(row.avg_price),stop_loss:text(row.stop_loss),take_profit:text(row.take_profit),
      lots_match_position:row.lots_match_position!==false,
      lots:(Array.isArray(row.lots)?row.lots:[]).filter(lot=>lot&&typeof lot==='object').map(lot=>({
        lot:Number.isInteger(lot.lot)?lot.lot:null,quantity:text(lot.quantity)??'',entry_price:text(lot.entry_price),
        entry_basis:lot.entry_basis==='cost'?'cost':'fill',stop_loss:text(lot.stop_loss),take_profit:text(lot.take_profit)}))}));
  }
  function cleanSymbols(data){
    if(!Array.isArray(data?.symbols))throw invalid('SYMBOLS_INVALID');
    return data.symbols.filter(row=>Array.isArray(row)&&typeof row[0]==='string'&&SYMBOL_RE.test(row[0])&&typeof row[1]==='string'&&typeof row[2]==='string')
      .map(row=>[row[0],row[1],row[2],text(row[3])]);
  }

  // ---- Open position lines (per lot, from the positions levels answer) ------------------------------------------------------
  const KINDS={entry:'ENTRY',sl:'SL',tp:'TP',avg:'AVG'};
  const positive=value=>value!==null&&Number.isFinite(Number(value))&&Number(value)>0;
  function rawLines(){
    const found=[];
    for(const position of state.levels||[]){
      if(position.chart_symbol!==state.symbol)continue;
      const bot=position.bot_label,many=position.lots.length>1,add=(kind,price,label)=>{if(positive(price))found.push({kind,price:Number(price),text:price,bot,label});};
      if(position.lots.length===0){
        add('entry',position.avg_price,bot+' · LONG '+position.quantity+' · ENTRY '+position.avg_price);
        add('sl',position.stop_loss,bot+' · SL '+position.stop_loss);add('tp',position.take_profit,bot+' · TP '+position.take_profit);
        continue;
      }
      for(const lot of position.lots){
        const number=many&&lot.lot!==null?' #'+lot.lot:'';
        add('entry',lot.entry_price,bot+' · LONG '+lot.quantity+' · ENTRY '+lot.entry_price+number+(lot.entry_basis==='cost'?' '+T('cost incl. fee'):''));
        add('sl',lot.stop_loss,bot+' · SL '+lot.stop_loss+number);add('tp',lot.take_profit,bot+' · TP '+lot.take_profit+number);
      }
      if(many||!position.lots_match_position)add('avg',position.avg_price,bot+' · AVG '+position.avg_price);
    }
    return found;
  }
  // Lines of the same kind at the identical price string become one line that names up to three bots.
  function mergedLines(){
    const groups=new Map();
    for(const line of rawLines()){
      const key=line.kind+'|'+line.text;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(line);
    }
    return [...groups.values()].map(group=>{
      if(group.length===1)return group[0];
      const names=[...new Set(group.map(line=>line.bot))],shown=names.slice(0,3).join(', ')+(names.length>3?' +'+(names.length-3):'');
      return {...group[0],label:shown+' · '+KINDS[group[0].kind]+' '+group[0].text};
    });
  }
  const mismatch=()=>(state.levels||[]).some(position=>position.chart_symbol===state.symbol&&position.lots.length>0&&!position.lots_match_position);
  // ---- Drawing ------------------------------------------------------------------------------------------------------------
  const tickDecimals=tick=>{
    if(typeof tick!=='string'||!/^\d+(\.\d+)?$/.test(tick))return null;
    return Math.min(8,(tick.split('.')[1]||'').replace(/0+$/,'').length);
  };
  const decimalsFor=(tick,price)=>tickDecimals(tick)??(price>=1000?2:price>=1?4:8);
  const tip=bar=>stamp(bar.time)+' · O '+bar.open+' · H '+bar.high+' · L '+bar.low+' · C '+bar.close+' · V '+bar.volume+
    (Number.isFinite(bar.minutes)?' · '+bar.minutes+' min':'')+(bar.forming===true?' · '+T('Forming bar'):'');
  const ticks=(count,wanted)=>{
    const step=Math.max(1,Math.ceil(count/wanted)),picks=[];
    for(let at=0;at<count;at+=step)picks.push(at);
    return picks;
  };
  /** Keeps the label baselines at least LABEL_GAP apart inside the plot; the lines themselves stay at the exact price. */
  function spread(items){
    items.sort((a,b)=>a.y-b.y);
    let previous=PRICE_TOP+8-LABEL_GAP;
    for(const item of items){item.y=Math.max(item.y,previous+LABEL_GAP);previous=item.y;}
    let next=PRICE_BOTTOM-2+LABEL_GAP;
    for(let at=items.length-1;at>=0;at--){items[at].y=Math.min(items[at].y,next-LABEL_GAP);next=items[at].y;}
  }

  // ---- Indicators (visual aids from chart-indicators.js; the series never leave this page) -----------------------------------
  const isNum=value=>typeof value==='number'&&Number.isFinite(value);
  const OVERLAYS=[{kind:'ema1',key:'ema1'},{kind:'ema2',key:'ema2'},{kind:'atr',key:'atrStop'}];
  // The valid bars and the series are recomputed only when the data object or the indicator settings change.
  let prepared=null;
  function prepare(data,bars){
    const key=state.indicators===null?'':JSON.stringify(state.indicators);
    if(prepared!==null&&prepared.data===data&&prepared.key===key)return prepared;
    const valid=bars.filter(bar=>[bar.open,bar.high,bar.low,bar.close,bar.volume].every(value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))));
    let series=null;
    if(state.indicators!==null&&valid.length>0){try{series=IND.compute(valid,state.indicators);}catch{series=null;}}
    prepared={data,key,valid,series};
    return prepared;
  }
  /** Consecutive drawable points make one polyline (a single point is skipped). On a forming bar the last segment is its own dashed line. */
  function appendLines(target,className,points,forming){
    const runs=[];
    let run=[];
    for(const point of points){
      if(point===null){if(run.length>0)runs.push(run);run=[];}
      else run.push(point);
    }
    if(run.length>0)runs.push(run);
    let tail=null;
    if(forming&&points.length>=2&&points[points.length-1]!==null&&points[points.length-2]!==null){tail=runs[runs.length-1].slice(-2);runs[runs.length-1].pop();}
    for(const part of runs)if(part.length>=2)target.append(node('polyline',className,{points:part}));
    if(tail!==null)target.append(node('polyline',className+' mc-ind-forming',{points:tail}));
  }
  /** Indicator values at one bar for the candle tooltip; empty when nothing is defined there. */
  function tipSuffix(series,at,places){
    if(series===null)return '';
    const s=state.indicators,digits=Math.min(10,places+2),parts=[];
    const fixed=(values,count)=>values&&isNum(values[at])?values[at].toFixed(count):null;
    const first=fixed(series.ema1,places),second=fixed(series.ema2,places),stop=fixed(series.atrStop,places),strength=fixed(series.rsi,2);
    if(first!==null)parts.push('EMA '+s.ema1.period+' '+first);
    if(second!==null)parts.push('EMA '+s.ema2.period+' '+second);
    if(stop!==null)parts.push('ATR SL '+stop);
    if(strength!==null)parts.push('RSI '+strength);
    const histogram=fixed(series.macd?.histogram,digits);
    if(histogram!==null)parts.push('MACD '+fixed(series.macd.line,digits)+'/'+fixed(series.macd.signal,digits)+'/'+histogram);
    return parts.map(part=>' · '+part).join('');
  }
  /** Draws candles, grid, labels, indicator overlays and the position lines. Number() is used for pixel geometry only.
      Returns null without bars, else the count of lines not drawn and the frame that the sub-panes align to. */
  function draw(valid,found,interval,intervalMs,tick,series){
    clearSvg();
    if(valid.length===0)return null;
    // A visible-bar budget keeps candles at least about 4 px apart on a narrow screen. Bars before the visible ones only warm the indicators up.
    const width=svg.getBoundingClientRect?svg.getBoundingClientRect().width:0,budget=width>0?Math.max(40,Math.floor(width/4)):Infinity;
    const cap=Math.min(Object.hasOwn(DISPLAY_BARS,interval)?DISPLAY_BARS[interval]:valid.length,budget);
    const usable=valid.length>cap?valid.slice(valid.length-cap):valid,offset=valid.length-usable.length;
    const last=usable[usable.length-1],lastClose=Number(last.close);
    let lo=Math.min(...usable.map(bar=>Number(bar.low))),hi=Math.max(...usable.map(bar=>Number(bar.high)));
    if(hi===lo){const flat=Math.abs(hi)*0.01||1;lo-=flat;hi+=flat;}
    const span=hi-lo;
    // The nearest lines to the last price are drawn; the rest only appear in the legend.
    const ranked=[...found].sort((a,b)=>Math.abs(a.price-lastClose)-Math.abs(b.price-lastClose));
    ranked.forEach((line,index)=>{line.drawn=index<MAX_LINES;line.edge=null;});
    const drawn=ranked.slice(0,MAX_LINES);
    // Indicator overlays: only the visible part of each series counts for the range.
    const overlays=[],extremes=[];
    if(series!==null)for(const {kind,key} of OVERLAYS){
      const values=series[key];
      if(!Array.isArray(values))continue;
      const shown=usable.map((_,index)=>values[offset+index]),defined=shown.filter(isNum);
      overlays.push({kind,shown});
      if(defined.length>0)extremes.push(Math.min(...defined),Math.max(...defined));
    }
    // The price range grows to include a line only while the candles keep at least half of the plot height; position lines come
    // first, then the indicator extremes under the same rule.
    let min=lo,max=hi;
    const outside=price=>price<lo?lo-price:price>hi?price-hi:0;
    const grow=prices=>{
      for(const price of [...prices].sort((a,b)=>outside(a)-outside(b))){
        if(outside(price)===0)continue;
        const nextMin=Math.min(min,price),nextMax=Math.max(max,price);
        if(nextMax-nextMin<=2*span){min=nextMin;max=nextMax;}
      }
    };
    grow(drawn.map(line=>line.price));grow(extremes);
    const margin=(max-min)*0.04;min-=margin;max+=margin;
    const y=price=>PRICE_TOP+(max-price)/(max-min)*(PRICE_BOTTOM-PRICE_TOP);
    const peak=Math.max(...usable.map(bar=>Number(bar.volume)),0);
    // Candles sit on the time axis: a bucket with no stored minutes leaves an empty slot instead of the neighbors closing the gap.
    const step=Number.isFinite(intervalMs)&&intervalMs>0?intervalMs:null,t0=usable[0].time;
    const place=(bar,index)=>step===null?index:Math.round((bar.time-t0)/step);
    const slots=Math.max(usable.length,step===null?0:place(last,usable.length-1)+1);
    const slot=(X1-X0)/slots,candleWidth=Math.max(1,slot*0.7),places=decimalsFor(tick,Math.max(Math.abs(max),Math.abs(min)));
    const xOf=index=>X0+slot*(place(usable[index],index)+0.5),forming=last.forming===true;
    const grid=node('g','mc-grid-group');
    for(let line=0;line<5;line++){
      const price=max-(max-min)*line/4,at=y(price);
      grid.append(node('line','mc-grid',{x1:X0,x2:X1,y1:at,y2:at}),node('text','mc-axis',{x:LABEL_X,y:at+4},price.toFixed(places)));
    }
    svg.append(grid);
    usable.forEach((bar,index)=>{
      const x=xOf(index),open=Number(bar.open),close=Number(bar.close),direction=close>=open?'mc-up':'mc-down';
      const incomplete=bar.complete===false||bar.forming===true;
      const group=node('g','mc-bar'+(incomplete?' mc-incomplete':'')+(bar.forming===true?' mc-forming':''));
      const volume=peak>0?Number(bar.volume)/peak*(VOLUME_BOTTOM-VOLUME_TOP):0;
      group.append(node('title',null,null,tip(bar)+tipSuffix(series,offset+index,places)),
        node('line','mc-wick '+direction,{x1:x,x2:x,y1:y(Number(bar.high)),y2:y(Number(bar.low))}),
        node('rect','mc-candle '+direction,{x:x-candleWidth/2,y:Math.min(y(open),y(close)),width:candleWidth,height:Math.max(1,Math.abs(y(open)-y(close)))}),
        node('rect','mc-vol '+direction,{x:x-candleWidth/2,y:VOLUME_BOTTOM-volume,width:candleWidth,height:volume}));
      svg.append(group);
    });
    // A value outside the final range is not drawn: the line breaks there instead of squeezing the candles.
    for(const {kind,shown} of overlays)
      appendLines(svg,'mc-ind-line mc-ind-'+kind,shown.map((value,index)=>isNum(value)&&value>=min&&value<=max?[xOf(index),y(value)]:null),forming);
    for(const at of ticks(usable.length,5))
      svg.append(node('text','mc-axis mc-axis-mid',{x:xOf(at),y:TIME_Y},axisTime(usable[at].time,interval)));
    const lastY=y(lastClose);
    svg.append(node('line','mc-last',{x1:X0,x2:X1,y1:lastY,y2:lastY}),node('text','mc-axis mc-last-label',{x:LABEL_X,y:lastY+4},last.close));
    const labels=[];
    for(const line of drawn){
      const aboveRange=line.price>max,belowRange=line.price<min;
      if(aboveRange||belowRange){
        line.edge=aboveRange?'above':'below';
        const at=aboveRange?PRICE_TOP+2:PRICE_BOTTOM-2,element=node('line','mc-level mc-edge mc-'+line.kind,{x1:X0,x2:X0+28,y1:at,y2:at});
        element.append(node('title',null,null,line.label));svg.append(element);
        labels.push({y:at+(aboveRange?10:-3),x:X0+32,text:(aboveRange?'▲ ':'▼ ')+line.label+' · '+T(aboveRange?'above range':'below range')});
        continue;
      }
      const at=y(line.price),element=node('line','mc-level mc-'+line.kind,{x1:X0,x2:X1,y1:at,y2:at});
      element.append(node('title',null,null,line.label));svg.append(element);
      labels.push({y:at-3,x:X0+4,text:line.label});
    }
    spread(labels);
    for(const label of labels)svg.append(node('text','mc-level-label',{x:label.x,y:label.y},label.text));
    return {more:found.length-drawn.length,frame:{usable,offset,xOf,candleWidth,places,forming}};
  }

  // ---- Sub-panes (RSI, MACD) and the value list; same x scale as the main chart so the bars line up --------------------------
  function clearIndicators(){
    if(!indicatorsOn)return;
    rsiPane.hidden=true;macdPane.hidden=true;rsiSvg.replaceChildren();macdSvg.replaceChildren();indValues.replaceChildren();
  }
  const shownOf=(frame,values)=>frame.usable.map((_,index)=>values[frame.offset+index]);
  const pointsOf=(frame,values,y)=>values.map((value,index)=>isNum(value)?[frame.xOf(index),y(value)]:null);
  const needs=(kind,at)=>node('text','mc-ind-needs',{x:450,y:at},tpl('needs {bars} bars',{bars:IND.minBars(state.indicators)[kind]}));
  function renderRsi(frame,series){
    const active=series!==null&&Array.isArray(series.rsi);
    rsiPane.hidden=!active;rsiSvg.replaceChildren();
    if(!active)return;
    const values=shownOf(frame,series.rsi),y=value=>8+(100-value)/100*134;
    rsiSvg.append(node('line','mc-ind-mid',{x1:X0,x2:X1,y1:y(50),y2:y(50)}),
      node('line','mc-ind-guide',{x1:X0,x2:X1,y1:y(70),y2:y(70)}),node('line','mc-ind-guide',{x1:X0,x2:X1,y1:y(30),y2:y(30)}));
    for(const level of [70,50,30])rsiSvg.append(node('text','mc-axis',{x:LABEL_X,y:y(level)+4},String(level)));
    rsiSvg.append(node('text','mc-ind-title',{x:X0+4,y:20},'RSI '+state.indicators.rsi.period));
    if(!values.some(isNum)){rsiSvg.append(needs('rsi',y(50)));return;}
    appendLines(rsiSvg,'mc-ind-line mc-ind-rsi',pointsOf(frame,values,y),frame.forming);
  }
  function renderMacd(frame,series){
    const active=series!==null&&series.macd!==null&&typeof series.macd==='object';
    macdPane.hidden=!active;macdSvg.replaceChildren();
    if(!active)return;
    const config=state.indicators.macd,mid=85,line=shownOf(frame,series.macd.line),signal=shownOf(frame,series.macd.signal),histogram=shownOf(frame,series.macd.histogram);
    const defined=[...line,...signal,...histogram].filter(isNum),amp=defined.length===0?1:Math.max(...defined.map(value=>Math.abs(value)))||1;
    const y=value=>mid-value/amp*77*0.95,digits=Math.min(10,frame.places+2);
    macdSvg.append(node('line','mc-ind-zero',{x1:X0,x2:X1,y1:mid,y2:mid}),
      node('text','mc-ind-title',{x:X0+4,y:20},'MACD '+config.fast+' '+config.slow+' '+config.signal));
    if(defined.length===0){macdSvg.append(needs('macd',mid));return;}
    for(const level of [amp,0,-amp])macdSvg.append(node('text','mc-axis',{x:LABEL_X,y:y(level)+4},level.toFixed(digits)));
    const lastIndex=frame.usable.length-1;
    histogram.forEach((value,index)=>{
      if(!isNum(value))return;
      const top=y(value),partial=frame.forming&&index===lastIndex?' mc-incomplete':'';
      macdSvg.append(node('rect','mc-ind-hist '+(value>=0?'mc-ind-hist-up':'mc-ind-hist-down')+partial,
        {x:frame.xOf(index)-frame.candleWidth/2,y:Math.min(top,mid),width:frame.candleWidth,height:Math.abs(top-mid)}));
    });
    appendLines(macdSvg,'mc-ind-line mc-ind-macd',pointsOf(frame,line,y),frame.forming);
    appendLines(macdSvg,'mc-ind-line mc-ind-signal',pointsOf(frame,signal,y),frame.forming);
  }
  function renderPanes(frame,series){
    if(!indicatorsOn)return;
    renderRsi(frame,series);renderMacd(frame,series);
  }
  /** One row per indicator that is on, with its value at the last visible bar (technical names are not translated). */
  function renderValues(frame,series){
    if(!indicatorsOn)return;
    indValues.replaceChildren();
    if(series===null)return;
    const at=frame.offset+frame.usable.length-1,s=state.indicators,bars=IND.minBars(s),digits=Math.min(10,frame.places+2);
    const fixed=(values,count)=>Array.isArray(values)&&isNum(values[at])?values[at].toFixed(count):null;
    const rows=[];
    if(series.ema1)rows.push(['ema1','EMA '+s.ema1.period,fixed(series.ema1,frame.places)]);
    if(series.ema2)rows.push(['ema2','EMA '+s.ema2.period,fixed(series.ema2,frame.places)]);
    if(series.atrStop)rows.push(['atr','ATR SL '+s.atr.multiplier.toFixed(1)+'×ATR'+s.atr.period,fixed(series.atrStop,frame.places)]);
    if(series.rsi)rows.push(['rsi','RSI '+s.rsi.period,fixed(series.rsi,2)]);
    if(series.macd){
      const histogram=fixed(series.macd.histogram,digits);
      rows.push(['macd','MACD '+s.macd.fast+' '+s.macd.slow+' '+s.macd.signal,
        histogram===null?null:fixed(series.macd.line,digits)+' / '+fixed(series.macd.signal,digits)+' / '+histogram]);
    }
    for(const [kind,name,value] of rows){
      const body=name+' · '+(value===null?'— · '+tpl('needs {bars} bars',{bars:bars[kind]}):value)+(frame.forming?' · '+T('Forming bar'):'');
      indValues.append(html('li','mc-iv mc-iv-'+kind+(frame.forming?' mc-iv-forming':''),body));
    }
  }
  function renderNote(){
    if(!indicatorsOn)return;
    const note=state.indNote;
    indNote.textContent=note===null?'':note.kind==='range'?tpl('Allowed range {min}–{max}; kept {value}',{min:note.min,max:note.max,value:note.value}):T('Fast length must be below slow length');
  }

  // ---- Texts and badges ---------------------------------------------------------------------------------------------------
  const isRest=data=>data?.source==='binance-spot-public-rest';
  function metaText(data,bars){
    let line=tpl('{bars} bars · {interval} · generated {time}',{bars:bars.length,interval:data.interval||state.interval,time:stamp(Date.parse(data.generated_at))});
    if(data.gaps?.count>0)line+=' · '+tpl('{count} gaps · {missing} missing 1m bars in this window',{count:data.gaps.count,missing:data.gaps.missing_minutes});
    if(data.history_partial===true)line+=' · '+tpl('Partial history: stored bars start {time}',{time:stamp(data.window?.history_start_open_time??bars[0].time)});
    return line;
  }
  function readyText(data){
    if(isRest(data))return tpl('Updated {time} · cache age {age} s',{time:stamp(Date.parse(data.generated_at)),age:data.cache_age_seconds??0});
    if(data.stale===true)return tpl('Stale: latest closed bar is {age} s old (limit {limit} s)',{age:data.age_seconds,limit:data.stale_after_seconds??180});
    return tpl('Latest closed bar {time} · age {age} s',{time:stamp(data.latest_closed_bar?.close_time),age:data.age_seconds});
  }
  const copyAge=data=>Math.max(0,Math.round((data.cache_age_seconds??data.age_seconds??0)+(Date.now()-state.dataAt)/1000));
  function renderBadges(){
    symbolBadge.textContent='BINANCE:'+state.symbol;
    const data=state.data;
    if(data===null||!Array.isArray(data.bars)||data.bars.length===0){delete sourceBadge.dataset.source;sourceBadge.textContent='';return;}
    let kind='stored',label;
    if(state.error!==null){kind='stale';label=tpl('Stale copy: {age} s old, Binance REST unavailable ({code})',{age:copyAge(data),code:state.error});}
    else if(isRest(data)&&data.stale===true){kind='stale';label=tpl('Stale copy: {age} s old, Binance REST unavailable ({code})',{age:data.cache_age_seconds??0,code:data.stale_reason??'UPSTREAM_UNAVAILABLE'});}
    else if(isRest(data)){kind='rest';label=tpl('Source: Binance public REST (cached {age} s)',{age:data.cache_age_seconds??0});}
    else if(data.fallback){kind='fallback';label=tpl('Fallback: stored bars, Binance REST unavailable ({code})',{code:data.fallback.reason});}
    else label=T('Source: stored Binance bars (bot feed)');
    sourceBadge.dataset.source=kind;sourceBadge.textContent=label;
  }

  function renderChips(){
    const groups=new Map();
    for(const position of state.levels||[]){
      if(position.chart_symbol===null)continue;
      if(!groups.has(position.chart_symbol))groups.set(position.chart_symbol,new Map());
      groups.get(position.chart_symbol).set(position.bot_id||position.bot_label,position.bot_label);
    }
    const symbols=[...groups.keys()].sort();
    const labels=symbols.map(symbol=>{
      const bots=groups.get(symbol);
      return bots.size>1?symbol+' · '+tpl('{count} bots',{count:bots.size}):scopeAll()?symbol+' · '+[...bots.values()][0]:symbol;
    });
    // The buttons are rebuilt only when something changed, so keyboard focus survives the quiet refresh.
    const key=JSON.stringify([symbols,labels,state.symbol]);
    held.hidden=symbols.length===0;
    if(key===state.chipsKey)return;
    state.chipsKey=key;
    chips.replaceChildren();
    symbols.forEach((symbol,index)=>{
      const button=html('button','mini mc-chip',labels[index]);
      button.type='button';button.dataset.mcSymbol=symbol;aria(button,'aria-pressed',symbol===state.symbol);
      chips.append(button);
    });
  }

  let lastLines=[];
  function renderLegend(result){
    legend.replaceChildren();
    if(result===null){legendTitle.hidden=true;return;}
    const rows=[...lastLines].sort((a,b)=>b.price-a.price);
    for(const line of rows){
      const suffix=line.edge?' · '+T(line.edge==='above'?'above range':'below range'):'';
      legend.append(html('li','mc-levels-item mc-row-'+line.kind,line.label+suffix));
    }
    const notes=[];
    if(state.levelsError!==null)notes.push(tpl('Position lines unavailable ({code})',{code:state.levelsError}));
    if(mismatch())notes.push(T('Lot quantities do not match the position; average line shown'));
    if((state.levels||[]).some(position=>position.chart_symbol===null))notes.push(T('Positions on other brokers have no Binance chart'));
    if(result.more>0)notes.push(tpl('more lines not drawn: {count}',{count:result.more}));
    for(const note of notes)legend.append(html('li','mc-levels-note muted',note));
    legendTitle.hidden=rows.length===0&&notes.length===0;
    if(!legendTitle.hidden)legendTitle.textContent=T('Open position lines');
  }

  const retryText=()=>tpl('Too many chart requests; retrying in {seconds} s',{seconds:Math.round(state.retryIn/1000)});
  function render(){
    renderBadges();renderChips();renderNote();
    const data=state.data,bars=data!==null&&Array.isArray(data.bars)?data.bars:[];
    const empty=()=>{clearSvg();meta.textContent='';lastLines=[];renderLegend(null);clearIndicators();};
    if(bars.length===0){
      empty();
      if(state.error!==null)show(limited(state.error)?'limited':'unavailable',limited(state.error)?retryText():tpl('Market data unavailable ({code})',{code:state.error}));
      else if(data!==null)show('empty',T('No bars for this symbol and timeframe'));
      else if(state.loading)show('loading',T('Loading market data…'));
      else show('idle','');
      return;
    }
    lastLines=state.levelsError===null?mergedLines():[];
    const prep=prepare(data,bars);
    const result=draw(prep.valid,lastLines,data.interval||state.interval,Number(data.interval_ms),data.price_tick,prep.series);
    if(result===null){empty();show('empty',T('No bars for this symbol and timeframe'));return;}
    meta.textContent=metaText(data,result.frame.usable);
    renderLegend(result);renderPanes(result.frame,prep.series);renderValues(result.frame,prep.series);
    if(state.error!==null)show(limited(state.error)?'limited':'stale',limited(state.error)?retryText():readyText(data));
    else show(data.stale===true?'stale':'ready',readyText(data));
    if(state.picker.open)renderList();
  }
  // ---- Requests: late answers are dropped by one sequence counter per kind -----------------------------------------------
  function backoff(code,base,fails){
    if(limited(code))return 60000;
    if(code==='MARKET_UPSTREAM_COOLDOWN')return 120000;
    return Math.max(base,Math.min(300000,base*2**fails));
  }
  async function loadChart(){
    if(state.stopped)return;
    const seq=++state.seq,base=POLL_SECONDS[state.interval]*1000;
    state.loading=true;state.started.chart=Date.now();
    if(state.data===null&&state.error===null)render();
    try{
      const data=await api('/api/market/ohlcv?symbol='+encodeURIComponent(state.symbol)+'&interval='+state.interval+'&limit='+fetchLimit(),{silent:true});
      if(seq!==state.seq)return;
      state.loading=false;state.error=null;state.data=data;state.dataAt=Date.now();state.fails.chart=0;state.due.chart=Date.now()+base;render();
    }catch(error){
      if(seq!==state.seq)return;
      const code=errorCode(error);
      state.loading=false;state.error=code;state.fails.chart++;
      state.retryIn=backoff(code,base,state.fails.chart);state.due.chart=Date.now()+state.retryIn;render();
    }
  }
  async function loadLevels(){
    if(state.stopped)return;
    const seq=++state.levelsSeq;
    state.levelsLoading=true;state.started.levels=Date.now();
    try{
      const data=await api('/api/positions/levels',{silent:true,botId:scopeAll()?'all':undefined});
      if(seq!==state.levelsSeq)return;
      const rows=cleanLevels(data);
      state.levelsLoading=false;state.levels=rows;state.levelsError=null;state.fails.levels=0;
      state.due.levels=Date.now()+(rows.length>0?LEVELS_HELD_MS:LEVELS_IDLE_MS);render();
    }catch(error){
      if(seq!==state.levelsSeq)return;
      const code=errorCode(error);
      state.levelsLoading=false;state.levelsError=code;state.fails.levels++;
      state.due.levels=Date.now()+backoff(code,LEVELS_IDLE_MS,state.fails.levels);render();
    }
  }
  async function loadSymbols(){
    if(state.stopped)return;
    const seq=++state.symbolsSeq;
    state.symbolsLoading=true;state.started.symbols=Date.now();
    try{
      const data=await api('/api/market/symbols',{silent:true});
      if(seq!==state.symbolsSeq)return;
      const rows=cleanSymbols(data);
      state.symbolsLoading=false;state.symbols=rows;state.symbolsError=null;state.fails.symbols=0;state.due.symbols=Infinity;
    }catch(error){
      if(seq!==state.symbolsSeq)return;
      state.symbolsLoading=false;state.symbolsError=errorCode(error);state.fails.symbols++;
      state.due.symbols=Date.now()+Math.min(600000,60000*2**(state.fails.symbols-1));
    }
    if(state.picker.open)renderList();
  }
  // One scheduler: a 5 s tick starts whatever is due, and only while the chart is on screen.
  function tick(){
    if(state.stopped||!visible())return;
    const now=Date.now();
    // A read that has not answered for a minute no longer blocks the next one.
    const free=(busy,kind)=>!busy||now-state.started[kind]>HUNG_MS;
    if(now>=state.due.chart&&free(state.loading,'chart'))loadChart();
    if(now>=state.due.levels&&free(state.levelsLoading,'levels'))loadLevels();
    if(state.symbols===null&&now>=state.due.symbols&&free(state.symbolsLoading,'symbols'))loadSymbols();
  }
  function refreshAll(){
    if(state.stopped)return;
    loadChart();loadLevels();
    if(state.symbols===null&&!state.symbolsLoading)loadSymbols();
  }
  // Nothing of the old symbol or interval stays on screen while the new one loads.
  function resetChart(){
    state.data=null;state.error=null;state.fails.chart=0;
    loadChart();
  }
  function clear(){
    state.stopped=true;state.seq++;state.levelsSeq++;state.symbolsSeq++;
    state.loading=false;state.levelsLoading=false;state.symbolsLoading=false;
    state.data=null;state.error=null;state.levels=null;state.levelsError=null;
    closeList(true);render();
  }

  // ---- Timeframe ----------------------------------------------------------------------------------------------------------
  const buttons=[...panel.querySelectorAll('[data-mc-interval]')];
  function syncInterval(){
    select.value=state.interval;
    for(const button of buttons){const on=button.dataset.mcInterval===state.interval;button.classList.toggle('active',on);aria(button,'aria-pressed',on);}
  }
  function setTimeframe(value){
    if(!Object.hasOwn(POLL_SECONDS,value))return;
    const changed=value!==state.interval;
    state.interval=value;syncInterval();
    if(changed){writePrefs();resetChart();}
  }
  select.addEventListener('change',()=>setTimeframe(select.value));
  for(const button of buttons)button.addEventListener('click',()=>setTimeframe(button.dataset.mcInterval));

  // ---- Symbol picker (WAI-ARIA combobox with a listbox; the list is filtered in the browser) ------------------------------
  const QUOTES=['USDT','FDUSD','USDC','BTC','ETH','BNB'],QUOTE_SUFFIXES=[...QUOTES,'TRY','EUR','USD'];
  const quoteRank=quote=>{const at=QUOTES.indexOf(quote);return at<0?QUOTES.length:at;};
  const normalize=value=>String(value).toUpperCase().trim().replace(/^BINANCE:/,'').replace(/[/\-_\s]/g,'');
  function split(symbol){
    for(const quote of QUOTE_SUFFIXES)if(symbol.length>quote.length&&symbol.endsWith(quote))return [symbol,symbol.slice(0,-quote.length),quote,null];
    return [symbol,symbol,'',null];
  }
  const heldSymbols=()=>[...new Set((state.levels||[]).map(position=>position.chart_symbol).filter(Boolean))];
  function candidates(){
    if(Array.isArray(state.symbols))return state.symbols;
    // Without the list only BTCUSDT, the held assets and the symbol on screen can be chosen.
    const known=new Map([[DEFAULT_SYMBOL,split(DEFAULT_SYMBOL)]]);
    for(const symbol of [...heldSymbols(),state.symbol])if(!known.has(symbol))known.set(symbol,split(symbol));
    return [...known.values()];
  }
  /** Exact symbol, symbol prefix, base-asset prefix, substring; ties by quote asset then name. An empty query lists held assets first. */
  function search(query){
    const wanted=normalize(query),heldSet=new Set(heldSymbols()),scored=[];
    for(const tuple of candidates()){
      const [symbol,base]=tuple;
      let tier;
      if(wanted==='')tier=heldSet.has(symbol)?0:1;
      else if(symbol===wanted)tier=0;
      else if(symbol.startsWith(wanted))tier=1;
      else if(base.startsWith(wanted))tier=2;
      else if(symbol.includes(wanted))tier=3;
      else continue;
      scored.push({tuple,tier});
    }
    scored.sort((a,b)=>a.tier-b.tier||quoteRank(a.tuple[2])-quoteRank(b.tuple[2])||(a.tuple[0]<b.tuple[0]?-1:a.tuple[0]>b.tuple[0]?1:0));
    return scored.slice(0,MAX_OPTIONS).map(item=>item.tuple);
  }
  const optionNodes=()=>[...list.querySelectorAll('[role="option"]')];
  function setActive(index){
    state.picker.active=index;
    const options=optionNodes();
    options.forEach((option,at)=>aria(option,'aria-selected',at===index));
    if(index>=0&&options[index]){aria(input,'aria-activedescendant',options[index].id);options[index].scrollIntoView?.({block:'nearest'});}
    else input.removeAttribute('aria-activedescendant');
  }
  function renderList(){
    list.replaceChildren();
    state.picker.rows.forEach((tuple,index)=>{
      const option=html('li','mc-option');
      aria(option,'role','option');aria(option,'id','mcOpt-'+index);aria(option,'aria-selected',index===state.picker.active);
      option.tabIndex=-1;option.dataset.symbol=tuple[0];
      option.append(html('span','mc-opt-symbol',tuple[0]),html('span','mc-opt-pair',' '+tuple[1]+(tuple[2]?' / '+tuple[2]:'')));
      list.append(option);
    });
    const notes=[];
    if(state.picker.rows.length===0)notes.push(T('No matching symbol'));
    if(state.symbols===null)notes.push(state.symbolsError!==null?tpl('Symbol list unavailable ({code}); BTCUSDT and held assets only',{code:state.symbolsError}):T('Loading symbol list…'));
    for(const note of notes){const row=html('li','mc-opt-note',note);aria(row,'role','presentation');list.append(row);}
    list.hidden=!state.picker.open;aria(input,'aria-expanded',state.picker.open);
  }
  function openList(){
    const rows=search(state.picker.dirty?input.value:'');
    state.picker.rows=rows;state.picker.open=true;
    const current=state.picker.dirty?-1:rows.findIndex(tuple=>tuple[0]===state.symbol);
    state.picker.active=rows.length===0?-1:Math.max(0,current);
    renderList();setActive(state.picker.active);
  }
  function closeList(restore){
    state.picker.open=false;state.picker.rows=[];state.picker.active=-1;
    list.hidden=true;list.replaceChildren();aria(input,'aria-expanded',false);input.removeAttribute('aria-activedescendant');
    if(restore){input.value=state.symbol;state.picker.dirty=false;}
  }
  function selectSymbol(symbol){
    closeList(false);state.picker.dirty=false;input.value=symbol;
    if(symbol===state.symbol)return;
    state.symbol=symbol;writePrefs();resetChart();
  }
  function commit(){
    const {rows,active,open}=state.picker;
    let symbol=null;
    if(open&&active>=0&&rows[active])symbol=rows[active][0];
    else symbol=candidates().find(tuple=>tuple[0]===normalize(input.value))?.[0]??null;
    if(symbol)selectSymbol(symbol);
  }
  const move=index=>{const count=state.picker.rows.length;if(count>0)setActive(Math.max(0,Math.min(count-1,index)));};
  picker.addEventListener('keydown',event=>{
    const {open,rows,active}=state.picker,count=rows.length;
    switch(event.key){
      case 'ArrowDown':
        event.preventDefault();
        if(!open)openList();else if(count>0)setActive((active+1)%count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if(!open)openList();else if(count>0)setActive(active<=0?count-1:active-1);
        break;
      case 'PageDown':if(open){event.preventDefault();move(active+10);}break;
      case 'PageUp':if(open){event.preventDefault();move(active-10);}break;
      case 'Home':if(open){event.preventDefault();move(0);}break;
      case 'End':if(open){event.preventDefault();move(count-1);}break;
      case 'Enter':event.preventDefault();commit();break;
      case 'Escape':if(open||state.picker.dirty)event.preventDefault();closeList(true);break;
      case 'Tab':closeList(true);break;
    }
  });
  input.addEventListener('input',()=>{state.picker.dirty=true;openList();});
  input.addEventListener('click',()=>{if(!state.picker.open)openList();});
  picker.addEventListener('focusout',event=>{if(!picker.contains(event.relatedTarget))closeList(true);});
  list.addEventListener('click',event=>{
    const option=event.target.closest?.('[role="option"]');
    if(!option)return;
    selectSymbol(option.dataset.symbol);input.focus();
  });
  chips.addEventListener('click',event=>{
    const chip=event.target.closest?.('button[data-mc-symbol]');
    if(chip)selectSymbol(chip.dataset.mcSymbol);
  });

  // ---- Indicator controls (static markup; never rebuilt by render, so focus survives a quiet refresh; no request on a change) ----
  function syncControls(){
    if(!indicatorsOn)return;
    for(const box of indBox.querySelectorAll('[data-mc-ind-on]'))box.checked=state.indicators[box.dataset.mcIndOn]?.on===true;
    for(const field of indBox.querySelectorAll('[data-mc-ind-field]')){
      const [group,name]=field.dataset.mcIndField.split('.');
      field.value=String(state.indicators[group]?.[name]);
    }
  }
  if(indicatorsOn){
    indBox.addEventListener('change',event=>{
      const target=event.target,settings=state.indicators;
      if(!target||!target.dataset)return;
      if(target.dataset.mcIndOn!==undefined){
        const group=settings[target.dataset.mcIndOn];
        if(group===null||typeof group!=='object')return;
        group.on=target.checked===true;state.indNote=null;
      }else if(target.dataset.mcIndField!==undefined){
        const key=target.dataset.mcIndField,[group,name]=key.split('.'),current=settings[group]?.[name],value=IND.parseField(key,target.value);
        if(current===undefined)return;
        if(value===null){
          target.value=String(current);
          const limit=IND.LIMITS[key];
          state.indNote=limit?{kind:'range',min:limit.min,max:limit.max,value:current}:null;
        }else if(group==='macd'&&((name==='fast'&&value>=settings.macd.slow)||(name==='slow'&&settings.macd.fast>=value))){
          target.value=String(current);state.indNote={kind:'order'};
        }else{
          settings[group][name]=value;state.indNote=null;
          if(String(value)!==target.value)target.value=String(value);
        }
      }else return;
      writePrefs();render();
    });
    indReset.addEventListener('click',()=>{
      state.indicators=IND.sanitize(null);state.indNote=null;syncControls();writePrefs();render();
    });
  }
  // ---- Page events --------------------------------------------------------------------------------------------------------
  document.getElementById('marketChartRefresh')?.addEventListener('click',refreshAll);
  document.querySelector('nav button[data-view="overview"]')?.addEventListener('click',()=>{if(visible())refreshAll();});
  document.getElementById('refresh')?.addEventListener('click',()=>{if(visible())refreshAll();});
  document.getElementById('language')?.addEventListener('change',render);
  document.getElementById('logout')?.addEventListener('click',clear);
  // The bot changes in the bot script before this listener runs: drop the lines now and read the new scope on the next turn.
  document.getElementById('botSwitcher')?.addEventListener('change',()=>{
    state.levelsSeq++;state.levels=null;state.levelsError=null;state.levelsLoading=false;state.due.levels=0;state.fails.levels=0;
    render();
    if(visible()&&!state.stopped)setTimeout(loadLevels,0);
  });
  document.addEventListener('visibilitychange',()=>{if(visible())refreshAll();});

  const prefs=readPrefs();
  state.symbol=prefs.symbol;state.interval=prefs.interval;
  state.indicators=indicatorsOn?IND.sanitize(prefs.indicators):null;
  input.value=state.symbol;syncInterval();syncControls();render();
  setInterval(tick,5000);
})();