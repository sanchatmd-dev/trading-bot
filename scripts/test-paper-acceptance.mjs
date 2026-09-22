#!/usr/bin/env node
/**
 * Automated Paper Forward Acceptance Test Script
 * 
 * Usage:
 *   node scripts/test-paper-acceptance.mjs https://www.robottrade.io/webhooks/tradingview/<SECRET>
 */

const webhookUrl = process.argv[2] || process.env.WEBHOOK_URL;

if (!webhookUrl || !webhookUrl.includes('/webhooks/tradingview/')) {
  console.error('Usage: node scripts/test-paper-acceptance.mjs <WEBHOOK_URL>');
  console.error('Example: node scripts/test-paper-acceptance.mjs https://www.robottrade.io/webhooks/tradingview/abc123...');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendSignal(name, payload) {
  console.log(`\n==================================================`);
  console.log(`[TEST STEP] ${name}`);
  console.log(`Payload:`, JSON.stringify(payload, null, 2));
  
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    
    console.log(`HTTP Status: ${res.status}`);
    console.log(`Response:`, data);
    return { status: res.status, data };
  } catch (err) {
    console.error(`Request Failed:`, err.message);
    return { status: 0, error: err.message };
  }
}

async function runAcceptance() {
  console.log(`Starting Paper Forward Acceptance Test against: ${webhookUrl}`);
  const ts = Date.now();
  const tradeP1 = `test-p1-${ts}`;
  const tradeP2 = `test-p2-${ts}`;
  const symbol = 'BTCUSDT';
  const broker = 'binance-global';

  // 1. BUY 1 (Lot P1)
  const buyP1 = await sendSignal('1. First BUY (Allocation P1)', {
    trade_id: tradeP1,
    broker,
    symbol,
    event: 'BUY',
    side: 'BUY',
    order_type: 'MARKET',
    timestamp: Date.now(),
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 1,
    reference_price: 64000,
    sl: 62000,
    tp: 68000
  });

  console.log('Waiting 3s for worker to process P1 fill...');
  await sleep(3000);

  // 2. Repeated BUY (Lot P2 - Scale-in)
  const buyP2 = await sendSignal('2. Repeated BUY / Scale-in (Allocation P2)', {
    trade_id: tradeP2,
    broker,
    symbol,
    event: 'BUY',
    side: 'BUY',
    order_type: 'MARKET',
    timestamp: Date.now(),
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 1,
    reference_price: 64500,
    sl: 62500,
    tp: 69000
  });

  console.log('Waiting 3s for worker to process P2 fill...');
  await sleep(3000);

  // 3. Duplicate Webhook Check
  console.log('\nTesting duplicate webhook rejection...');
  const dupResult = await sendSignal('3. Duplicate Webhook (Re-send BUY P1)', {
    trade_id: tradeP1,
    broker,
    symbol,
    event: 'BUY',
    side: 'BUY',
    order_type: 'MARKET',
    timestamp: Date.now(),
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 1,
    reference_price: 64000,
    sl: 62000,
    tp: 68000
  });

  // 4. Stale Webhook Check (1 hour old)
  console.log('\nTesting stale webhook rejection...');
  const staleResult = await sendSignal('4. Stale Webhook (Timestamp 1 hour ago)', {
    trade_id: `test-stale-${ts}`,
    broker,
    symbol,
    event: 'BUY',
    side: 'BUY',
    order_type: 'MARKET',
    timestamp: Date.now() - 3600000,
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 1,
    reference_price: 64000,
    sl: 62000
  });

  // 5. Targeted TP 1 (Close P1 allocation only)
  console.log('\nTesting Targeted TP for P1 only...');
  const tpP1 = await sendSignal('5. Targeted TP1 (Targeting Allocation P1 only)', {
    trade_id: `test-tp1-${ts}`,
    target_trade_id: tradeP1,
    broker,
    symbol,
    event: 'TP',
    side: 'SELL',
    order_type: 'MARKET',
    timestamp: Date.now(),
    reference_price: 68000,
    reduce_only: true
  });

  console.log('Waiting 3s for worker to close P1...');
  await sleep(3000);

  // 6. Targeted TP 2 (Close P2 allocation)
  console.log('\nTesting Targeted TP for P2...');
  const tpP2 = await sendSignal('6. Targeted TP2 (Targeting Allocation P2)', {
    trade_id: `test-tp2-${ts}`,
    target_trade_id: tradeP2,
    broker,
    symbol,
    event: 'TP',
    side: 'SELL',
    order_type: 'MARKET',
    timestamp: Date.now(),
    reference_price: 69000,
    reduce_only: true
  });

  console.log('Waiting 3s for worker to close P2...');
  await sleep(3000);

  // 7. Reduce-Only / No Position Rejection
  console.log('\nTesting Reduce-Only SELL when net flat...');
  const excessSell = await sendSignal('7. Reduce-Only Exit after Flat', {
    trade_id: `test-excess-${ts}`,
    broker,
    symbol,
    event: 'SL',
    side: 'SELL',
    order_type: 'MARKET',
    timestamp: Date.now(),
    reference_price: 60000,
    reduce_only: true
  });

  console.log('\n==================================================');
  console.log('SUMMARY OF TEST SEQUENCE COMPLETED');
  console.log('Check Web UI (https://www.robottrade.io):');
  console.log('1. Positions: P1 opened, P2 opened alongside, P1 closed independently, P2 closed.');
  console.log('2. Trade Log: Signals and REJECTED reasons for duplicate/stale/excess.');
  console.log('3. Analytics: Closed round trips recorded.');
  console.log('==================================================\n');
}

runAcceptance().catch(console.error);
