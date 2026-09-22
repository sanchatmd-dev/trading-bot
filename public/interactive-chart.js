const CHART_COLORS = {
  up: '#35e0b1',
  down: '#ff7187',
  bg: '#040d17',
  grid: '#0a1a2a',
  text: '#8fa4ba',
  emaFast: '#2962FF',
  emaSlow: '#FF6D00',
  atrUpper: '#ff2edb',
  atrLower: '#ff2edb',
  entry: '#ffffff',
  sl: '#ff7187',
  tp: '#35e0b1'
};

let interactiveChart = null;
let candleSeries = null;
let volumeSeries = null;
let emaFastSeries = null;
let emaSlowSeries = null;
let atrUpperSeries = null;
let atrLowerSeries = null;

let currentChartSymbol = '';
let currentChartBroker = 'binance-global';
let cachedPositions = [];
let chartPriceLines = [];
let cachedOHLCV = [];

// Entry point: Initialize the chart component
async function initInteractiveChart() {
  const container = document.getElementById('interactiveChart');
  if (!container || !window.LightweightCharts) return;

  if (!interactiveChart) {
    interactiveChart = LightweightCharts.createChart(container, {
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text },
      grid: {
        vertLines: { color: CHART_COLORS.grid },
        horzLines: { color: CHART_COLORS.grid },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    });

    candleSeries = interactiveChart.addCandlestickSeries({
      upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, borderVisible: false,
      wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down
    });

    volumeSeries = interactiveChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.8, bottom: 0 }
    });

    emaFastSeries = interactiveChart.addLineSeries({ color: CHART_COLORS.emaFast, lineWidth: 2 });
    emaSlowSeries = interactiveChart.addLineSeries({ color: CHART_COLORS.emaSlow, lineWidth: 2 });
    
    // ATR Bands
    atrUpperSeries = interactiveChart.addLineSeries({ color: CHART_COLORS.atrUpper, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed });
    atrLowerSeries = interactiveChart.addLineSeries({ color: CHART_COLORS.atrLower, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed });

    new ResizeObserver(entries => {
      if (entries.length === 0 || entries[0].target !== container) return;
      const newRect = entries[0].contentRect;
      interactiveChart.applyOptions({ width: newRect.width, height: newRect.height });
    }).observe(container);
  }

  // Bind events
  document.getElementById('interactiveChartSymbol')?.addEventListener('change', async (e) => {
    const selected = e.target.value;
    if (selected) {
      const pos = cachedPositions.find(p => p.symbol === selected);
      currentChartBroker = pos ? pos.broker : document.getElementById('analyticsBroker')?.value || 'binance-global';
      await loadChartForSymbol(selected, currentChartBroker);
    } else {
      clearChart();
    }
  });

  document.getElementById('chartEmaPeriod')?.addEventListener('change', updateIndicators);
  document.getElementById('chartEma2Period')?.addEventListener('change', updateIndicators);
  document.getElementById('chartAtrPeriod')?.addEventListener('change', updateIndicators);
  document.getElementById('chartAtrMult')?.addEventListener('change', updateIndicators);

  await refreshChartData();
}

function clearChart() {
  candleSeries?.setData([]);
  volumeSeries?.setData([]);
  emaFastSeries?.setData([]);
  emaSlowSeries?.setData([]);
  atrUpperSeries?.setData([]);
  atrLowerSeries?.setData([]);
  clearPriceLines();
}

function clearPriceLines() {
  if (candleSeries && chartPriceLines.length > 0) {
    chartPriceLines.forEach(line => candleSeries.removePriceLine(line));
    chartPriceLines = [];
  }
}

async function refreshChartData() {
  try {
    cachedPositions = await api('/api/positions');
    const symbols = [...new Set(cachedPositions.map(p => p.symbol))];
    const select = document.getElementById('interactiveChartSymbol');
    
    if (select) {
      const currentVal = select.value;
      select.innerHTML = '<option value="">Select Asset</option>' + symbols.map(s => `<option value="${s}">${s}</option>`).join('');
      
      if (symbols.includes(currentVal)) {
        select.value = currentVal;
        const pos = cachedPositions.find(p => p.symbol === currentVal);
        await loadChartForSymbol(currentVal, pos ? pos.broker : 'binance-global');
      } else if (symbols.length > 0) {
        select.value = symbols[0];
        const pos = cachedPositions.find(p => p.symbol === symbols[0]);
        await loadChartForSymbol(symbols[0], pos.broker);
      } else {
        clearChart();
      }
    }
  } catch (err) {
    console.error('Failed to load positions:', err);
  }
}

async function loadChartForSymbol(symbol, broker) {
  currentChartSymbol = symbol;
  currentChartBroker = broker;
  if (!interactiveChart) return;
  
  try {
    cachedOHLCV = await fetchBrokerOHLCV(symbol, broker);
    if (!cachedOHLCV || cachedOHLCV.length === 0) return;

    const candleData = cachedOHLCV.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }));
    const volData = cachedOHLCV.map(d => ({ time: d.time, value: d.volume, color: d.close >= d.open ? '#35e0b188' : '#ff718788' }));
    
    candleSeries.setData(candleData);
    volumeSeries.setData(volData);

    updateIndicators();
    renderActivePositions(symbol);
  } catch (err) {
    console.error('Error rendering chart', err);
  }
}

function updateIndicators() {
  if (!cachedOHLCV.length) return;
  
  const emaPeriod = Number(document.getElementById('chartEmaPeriod')?.value || 9);
  const ema2Period = Number(document.getElementById('chartEma2Period')?.value || 21);
  const atrPeriod = Number(document.getElementById('chartAtrPeriod')?.value || 14);
  const atrMult = Number(document.getElementById('chartAtrMult')?.value || 2);
  
  const candles = cachedOHLCV;
  
  // EMA
  const ema = calculateEMA(candles, emaPeriod);
  const emaSlow = calculateEMA(candles, ema2Period); 
  emaFastSeries.setData(ema);
  emaSlowSeries.setData(emaSlow);

  // ATR Bands
  const atrVals = calculateATR(candles, atrPeriod);
  const upper = [];
  const lower = [];
  
  for (let i = 0; i < candles.length; i++) {
    const time = candles[i].time;
    const atrObj = atrVals.find(a => a.time === time);
    const emaObj = ema.find(e => e.time === time);
    if (atrObj && emaObj) {
      upper.push({ time, value: emaObj.value + (atrObj.value * atrMult) });
      lower.push({ time, value: emaObj.value - (atrObj.value * atrMult) });
    }
  }
  
  atrUpperSeries.setData(upper);
  atrLowerSeries.setData(lower);
}

function calculateEMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = data[0].close;
  for (let i = 0; i < data.length; i++) {
    if (i > 0) ema = (data[i].close * k) + (ema * (1 - k));
    if (i >= period - 1) result.push({ time: data[i].time, value: ema });
  }
  return result;
}

function calculateATR(data, period) {
  const result = [];
  let trSum = 0;
  for (let i = 0; i < data.length; i++) {
    let tr = 0;
    if (i === 0) {
      tr = data[i].high - data[i].low;
    } else {
      const hl = data[i].high - data[i].low;
      const hc = Math.abs(data[i].high - data[i - 1].close);
      const lc = Math.abs(data[i].low - data[i - 1].close);
      tr = Math.max(hl, hc, lc);
    }
    
    if (i < period) {
      trSum += tr;
      if (i === period - 1) {
        result.push({ time: data[i].time, value: trSum / period });
      }
    } else {
      const prevAtr = result[result.length - 1].value;
      const atr = ((prevAtr * (period - 1)) + tr) / period; // Smoothed Moving Average (RMA)
      result.push({ time: data[i].time, value: atr });
    }
  }
  return result;
}

function renderActivePositions(symbol) {
  if (!candleSeries) return;
  clearPriceLines();
  candleSeries.setMarkers([]);

  const active = cachedPositions.filter(p => p.symbol === symbol);
  active.forEach(pos => {
    const entry = Number(pos.entry_price || pos.entryPrice);
    if (entry) chartPriceLines.push(candleSeries.createPriceLine({ price: entry, color: CHART_COLORS.entry, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'ENTRY' }));
    const sl = Number(pos.stop_loss || pos.stopLoss);
    if (sl) chartPriceLines.push(candleSeries.createPriceLine({ price: sl, color: CHART_COLORS.sl, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'SL' }));
    const tp = Number(pos.take_profit || pos.takeProfit);
    if (tp) chartPriceLines.push(candleSeries.createPriceLine({ price: tp, color: CHART_COLORS.tp, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'TP' }));
  });
}

async function fetchBrokerOHLCV(symbol, broker) {
  const isBinance = broker.startsWith('binance');
  if (isBinance) {
    let fetchSymbol = symbol.replace(/THB$/, 'USDT').toUpperCase();
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${fetchSymbol}&interval=1h&limit=500`);
    if (!res.ok) throw new Error('Binance API error');
    const data = await res.json();
    return data.map(k => ({ time: Math.floor(k[0]/1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }
  
  let fetchSymbol = symbol.endsWith('USDT') || symbol.endsWith('THB') ? symbol.replace(/THB$/, 'USDT').toUpperCase() : 'BTCUSDT'; 
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${fetchSymbol}&interval=1h&limit=500`);
  const data = await res.json();
  return data.map(k => ({ time: Math.floor(k[0]/1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

document.addEventListener('DOMContentLoaded', () => {
  const targetNode = document.querySelector('[data-page="analytics"]');
  if (!targetNode) return;
  new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.attributeName === 'hidden' && !targetNode.hidden) {
        if (!interactiveChart) initInteractiveChart();
        else refreshChartData();
      }
    });
  }).observe(targetNode, { attributes: true });
});
