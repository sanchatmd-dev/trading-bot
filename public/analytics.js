const analyticsState={period:'monthly',summary:null,equity:null,breakdown:null,loading:false};
const analyticsBrokerCurrency={'binance-global':'USDT','binance-th':'THB','innovestx':'THB','settrade':'THB'};

function analyticsParams(){
  const params=new URLSearchParams({broker:$('#analyticsBroker').value,period:analyticsState.period});
  if($('#analyticsSymbol').value)params.set('symbol',$('#analyticsSymbol').value);
  if(!selectedBot&&me?.user?.role==='ADMIN'&&$('#analyticsUser').value)params.set('user_id',$('#analyticsUser').value);
  if(analyticsState.period==='custom'){params.set('from',$('#analyticsFrom').value);params.set('to',$('#analyticsTo').value);}
  return params;
}
function money(value,currency=analyticsState.summary?.currency||'USDT'){
  if(value===null||value===undefined)return '—';
  const formatted=new Intl.NumberFormat(uiLanguage==='th'?'th-TH':'en-US',{maximumFractionDigits:2}).format(Number(value||0));
  return currency==='THB'?`฿${formatted}`:`${formatted} USDT`;
}
function number(value,digits=2){return value===null||value===undefined?'—':new Intl.NumberFormat(uiLanguage==='th'?'th-TH':'en-US',{maximumFractionDigits:digits}).format(value);}
function duration(ms){if(!ms)return '0m';const minutes=Math.round(ms/60000);if(minutes<60)return `${minutes}m`;const hours=minutes/60;if(hours<24)return `${number(hours,1)}h`;return `${number(hours/24,1)}d`;}
function analyticsError(error){$('#analyticsStatus').textContent=error.message;$('#analyticsStatus').className='error';}

async function loadAnalytics(){
  if(!token||analyticsState.loading)return;
  if(analyticsState.period==='custom'&&(!$('#analyticsFrom').value||!$('#analyticsTo').value))return;
  analyticsState.loading=true;$('#analyticsStatus').textContent=translate('Loading analytics…');$('#analyticsStatus').className='';
  try{
    const query=analyticsParams().toString();
    [analyticsState.summary,analyticsState.equity,analyticsState.breakdown]=await Promise.all([
      api('/api/analytics/summary?'+query),api('/api/analytics/equity-curve?'+query),api('/api/analytics/breakdown?'+query)
    ]);
    $('#analyticsFee').value=analyticsState.summary.feeBps;
    $('#analyticsCurrency').textContent=analyticsState.summary.currency;
    renderAnalytics();$('#analyticsStatus').textContent=`${analyticsState.summary.from} → ${analyticsState.summary.to} · ${analyticsState.summary.currency}`;
  }catch(error){analyticsError(error);}finally{analyticsState.loading=false;}
}

function renderAnalyticsUsers(){
  const wrap=$('#analyticsUserWrap'),select=$('#analyticsUser');if(!me)return;
  if(me.user.role!=='ADMIN'||selectedBot){wrap.hidden=true;return;}
  wrap.hidden=false;const current=select.value||me.user.id;
  select.innerHTML=users.map(user=>`<option value="${esc(user.id)}">${esc(user.email)}</option>`).join('');
  select.value=users.some(user=>user.id===current)?current:me.user.id;
}
function metricCard(label,value,note=''){return `<article class="metric analytics-metric"><span>${esc(translate(label))}</span><strong>${esc(value)}</strong>${note?`<small>${esc(note)}</small>`:''}</article>`;}
function renderAnalytics(){
  const s=analyticsState.summary,b=analyticsState.breakdown;if(!s||!b)return;
  const ratio=s.avgWinLossRatio===null?'—':`${number(s.avgWinLossRatio)} ×`;
  const basisLabels=['Trades count completed flat-to-flat cycles. PnL and drawdown include partial exits and exclude unrealized moves. Custom fees affect analytics only.'];
  if(s.percentagesAvailable===false)basisLabels.push('Percentages unavailable: funding changed in this period or legacy funding history is incomplete.');
  $('#analyticsBasis').innerHTML=basisLabels.map(label=>`<span data-ui-label="${esc(label)}">${esc(translate(label))}</span>`).join(' ');
  $('#analyticsMetrics').innerHTML=[
    metricCard('Closed round trips',number(s.totalTrades,0),`${s.wins} W / ${s.losses} L`),metricCard('Win rate',`${number(s.winRate)}%`),
    metricCard('Realized net profit',money(s.netProfit),s.netProfitPercent===null?'—':`${number(s.netProfitPercent)}%`),metricCard('Profit factor',number(s.profitFactor)),
    metricCard('Realized max drawdown',money(Math.abs(s.maxDrawdown)),s.maxDrawdownPercent===null?'—':`${number(Math.abs(s.maxDrawdownPercent))}%`),metricCard('Expectancy',money(s.expectancy)),
    metricCard('Avg win / loss',ratio,`${money(s.avgWin)} / ${money(s.avgLoss)}`),metricCard('Max win streak',number(s.maxConsecutiveWins,0)),
    metricCard('Max loss streak',number(s.maxConsecutiveLosses,0)),metricCard('Average holding',duration(s.averageHoldingMs)),
    metricCard('Fee impact',money(s.feeImpact),`${number(s.feeBps)} bps`),metricCard('Starting equity',money(s.startingEquity))
  ].join('');
  const current=$('#analyticsSymbol').value,options=['<option value="">'+esc(translate('All assets'))+'</option>',...b.assets.map(a=>`<option value="${esc(a.symbol)}">${esc(a.symbol)}</option>`)];
  $('#analyticsSymbol').innerHTML=options.join('');if(b.assets.some(a=>a.symbol===current))$('#analyticsSymbol').value=current;
  renderEquityChart();renderDonut();renderAssetBars();renderClosedTrades();translateUI();
}
function renderEquityChart(){
  const svg=$('#equityChart'),series=analyticsState.equity?.series||[],W=760,H=300,pad=42;
  if(!series.length){svg.innerHTML=`<text x="380" y="150" text-anchor="middle" class="chart-empty">${esc(translate('No closed positions in this period'))}</text>`;return;}
  const values=series.flatMap(x=>[x.cumulativePnl,x.drawdown]),min=Math.min(0,...values),max=Math.max(0,...values),range=max-min||1;
  const x=i=>pad+(W-pad*2)*(series.length===1?.5:i/(series.length-1)),y=v=>H-pad-(H-pad*2)*(v-min)/range;
  const pnl=series.map((row,i)=>`${x(i)},${y(row.cumulativePnl)}`).join(' '),dd=series.map((row,i)=>`${x(i)},${y(row.drawdown)}`).join(' '),zero=y(0);
  svg.innerHTML=`<line x1="${pad}" y1="${zero}" x2="${W-pad}" y2="${zero}" class="chart-zero"/><polyline points="${dd}" class="drawdown-line"/><polyline points="${pnl}" class="equity-line"/><text x="${pad}" y="20" class="chart-label">${esc(money(max))}</text><text x="${pad}" y="${H-10}" class="chart-label">${esc(money(min))}</text>`;
}
function renderDonut(){
  const s=analyticsState.summary,total=s.totalTrades||1,win=s.wins/total*100,loss=s.losses/total*100;
  $('#winLossDonut').style.background=`conic-gradient(#35e0b1 0 ${win}%,#ff7187 ${win}% ${win+loss}%,#60748f ${win+loss}% 100%)`;
  $('#winLossDonut').innerHTML=`<span><strong>${number(s.winRate)}%</strong><small>${esc(translate('Win rate'))}</small></span>`;
  $('#winLossLegend').innerHTML=`<span class="win">${esc(translate('Wins'))} ${s.wins}</span><span class="loss">${esc(translate('Losses'))} ${s.losses}</span><span>${esc(translate('Breakeven'))} ${s.breakeven}</span>`;
}
function renderAssetBars(){
  const assets=analyticsState.breakdown.assets,max=Math.max(1,...assets.map(a=>Math.abs(a.netProfit)));
  $('#assetBars').innerHTML=assets.length?assets.map(a=>`<button type="button" data-symbol="${esc(a.symbol)}"><span>${esc(a.symbol)}</span><i><b class="${a.netProfit>=0?'positive':'negative'}" style="width:${Math.max(2,Math.abs(a.netProfit)/max*100)}%"></b></i><strong class="${a.netProfit>=0?'positive-text':'negative-text'}">${esc(money(a.netProfit))}</strong></button>`).join(''):`<p>${esc(translate('No closed positions in this period'))}</p>`;
  document.querySelectorAll('#assetBars button').forEach(button=>button.onclick=()=>{$('#analyticsSymbol').value=button.dataset.symbol;loadAnalytics();});
}
function renderClosedTrades(){
  const rows=analyticsState.summary.closedPositions||[];
  $('#closedTradeRows').innerHTML=rows.length?rows.map(row=>`<tr><td data-label="${esc(translate('Closed'))}">${new Date(row.exitAt).toLocaleString()}</td><td data-label="${esc(translate('Asset'))}"><strong>${esc(row.symbol)}</strong><small>${esc(row.tradeId)}</small></td><td data-label="${esc(translate('Entry / Exit'))}">${number(row.entryPrice,8)}<br>${number(row.exitPrice,8)}</td><td data-label="PnL" class="${row.netPnl>=0?'positive-text':'negative-text'}">${esc(money(row.netPnl))}<small>${number(row.returnPercent)}%</small></td><td data-label="${esc(translate('Fees'))}">${esc(money(row.fees))}</td><td data-label="${esc(translate('Holding'))}">${duration(row.holdingMs)}</td></tr>`).join(''):`<tr><td colspan="6">${esc(translate('No closed positions in this period'))}</td></tr>`;
}

document.querySelectorAll('.analytics-periods button').forEach(button=>button.onclick=()=>{
  document.querySelectorAll('.analytics-periods button').forEach(item=>item.classList.toggle('active',item===button));analyticsState.period=button.dataset.period;
  $('#analyticsDates').hidden=analyticsState.period!=='custom';loadAnalytics();
});
for(const id of ['analyticsBroker','analyticsSymbol','analyticsUser','analyticsFrom','analyticsTo'])$(id.startsWith('#')?id:'#'+id)?.addEventListener('change',event=>{
  if(event.target.id==='analyticsBroker'){$('#analyticsCurrency').textContent=analyticsBrokerCurrency[event.target.value];$('#analyticsSymbol').value='';}
  loadAnalytics();
});
$('#saveAnalyticsFee').onclick=async()=>{try{await api('/api/analytics/settings?'+analyticsParams().toString(),{method:'PUT',body:JSON.stringify({broker:$('#analyticsBroker').value,feeBps:Number($('#analyticsFee').value)})});loadAnalytics();}catch(error){analyticsError(error);}};
const today=new Date(),monthStart=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),1));$('#analyticsTo').value=today.toISOString().slice(0,10);$('#analyticsFrom').value=monthStart.toISOString().slice(0,10);
