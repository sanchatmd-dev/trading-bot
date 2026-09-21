import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeSignal} from '../src/postgres/domain.js';
import {evaluateRisk} from '../src/postgres/risk.js';

const source=readFileSync(new URL('../tradingview/spt_pro_v4_robot_trade.pine',import.meta.url),'utf8').replace(/\r\n/g,'\n');
test('SPT original logic remains byte-identical after removing transport additions',()=>{
  const original=source.split('// ROBOT TRADE BRIDGE BEGIN')[0].trimEnd()
    .replace('          "Webhook",\n          "Robot Trade (Spot)"','          "Webhook"')
    .replace('if notifyEnabled and notifyExtra != "Robot Trade (Spot)"','if notifyEnabled');
  assert.equal(createHash('sha256').update(original).digest('hex'),'89fe4074af8b8d29fd88694e12d816da4ef87d7ff40d187ceb95f375c5f0518a');
});

// Evaluate the actual Pine string expressions with small JS stand-ins.
// This verifies wire JSON, NOT Pine compilation or its bar-by-bar runtime.
const expression=name=>source.match(new RegExp('    string '+name+' = (.+)'))[1];
test('actual Pine BUY gate permits a new signal after a prior emitted or rejected BUY',()=>{
  const pine=source.match(/f_rtCanBuy\([^\n]+\) =>\n    ([^\n]+)/)[1];
  const js=pine.replace(/\band\b/g,'&&').replace(/\bor\b/g,'||').replace(/\bnot\b/g,'!');
  const canBuy=Function('signalBuy','trackingLong','repeatBuy','news','exitSent','return '+js);
  assert.equal(canBuy(true,false,true,false,false),true);
  assert.equal(canBuy(true,true,true,false,false),true);
  assert.equal(canBuy(true,true,false,false,false),false);
  assert.equal(canBuy(true,false,true,true,false),false);
  assert.equal(canBuy(true,false,true,false,true),false);
  assert.equal(canBuy(false,false,true,false,false),false);
});
function payload(ev,broker='Binance Global',symbol='BTCUSD'){
  const str={tostring:value=>String(value)};
  const args=['str','syminfo','timeframe','format','f_jsonEscape','rtTag','rtBroker','rtRisk','rtNews','ev','px','stop','target','vol','stamp'];
  const values=[str,{ticker:symbol},{period:'60'},{mintick:0.01},s=>JSON.stringify(s).slice(1,-1),'spt1',broker,0.5,false,ev,100,95,115,2,1900000000000];
  const id=Function(...args,'return '+expression('id'))(...values);
  const riskPart=Function(...args,'return '+expression('riskPart'))(...values);
  return JSON.parse(Function(...args,'id','riskPart','return '+expression('payload'))(...values,id,riskPart));
}
test('actual Pine exit selector forwards SELL without BUY state and emits only one protective exit',()=>{
  const pine=source.match(/f_rtExitEvent\([^\n]+\) =>\n    ([^\n]+)/)[1];
  const selectExit=Function('protectiveExit','signalSell','sendSell','return '+pine.replace(/\band\b/g,'&&'));
  assert.equal(selectExit('',true,true),'SELL');
  assert.equal(selectExit('',true,false),'');
  assert.equal(selectExit('',false,true),'');
  for(const event of ['TP','SL']){
    assert.equal(selectExit(event,true,true),event);
    assert.equal(selectExit(event,true,false),event);
    assert.equal(selectExit(event,false,true),event);
  }
  // Same indentation as the tracking block: selector/emitter must run even when flat.
  assert.match(source,/\n    rtEvent := f_rtExitEvent\(rtEvent, sellSignal, rtExitOnSell\)\n    if rtEvent != ""\n/);
});
test('SELL wire payload closes server holdings and rejects an empty or reserved Spot position',()=>{
  const body=payload('SELL');
  const signal=normalizeSignal(body,body.timestamp);
  const context={now:body.timestamp,policy:{maxSignalAgeSeconds:60},daily:{},
    position:{quantity:'0.25'},equity:'1000',balance:'1000',hasPendingOrder:false};
  const accepted=evaluateRisk(signal,context);
  assert.equal(accepted.ok,true);
  assert.equal(accepted.order.quantity,'0.25');
  assert.equal(accepted.order.reduceOnly,true);
  assert.equal(accepted.order.side,'SELL');
  assert.equal(evaluateRisk(signal,{...context,position:{quantity:'0'}}).reason,'No Spot position available to sell');
  assert.equal(evaluateRisk(signal,{...context,hasPendingOrder:true}).reason,'Pending order already reserves this symbol');
});
for(const event of ['BUY','SELL','TP','SL']){
  test('SPT '+event+' payload accepted by PostgreSQL signal normalizer',()=>{
    const body=payload(event);
    const s=normalizeSignal(body,body.timestamp);
    assert.equal(s.symbol,'BTCUSDT');
    assert.equal(s.event,event);
    assert.equal(s.referencePrice,'100');
    assert.equal(s.reduceOnly,event!=='BUY');
    assert.equal(s.riskMode,event==='BUY'?'PERCENT_EQUITY':'QUANTITY');
    assert.equal(s.quantity,undefined);
    assert.equal(s.limitPrice,undefined);
    assert.ok(s.tradeId.length<=80);
    if(event==='BUY'){assert.equal(s.stopLoss,'95');assert.equal(s.takeProfit,'115');}
    else assert.equal(s.stopLoss,undefined);
  });
}
test('SPT IDs deterministic and distinct by event; THB is not converted',()=>{
  assert.equal(payload('BUY').trade_id,payload('BUY').trade_id);
  assert.notEqual(payload('BUY').trade_id,payload('SL').trade_id);
  const body=payload('BUY','Binance TH','BTCTHB');
  assert.equal(normalizeSignal(body,body.timestamp).symbol,'BTCTHB');
});
