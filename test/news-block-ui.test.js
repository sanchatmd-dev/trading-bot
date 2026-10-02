import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {config} from '../src/config.js';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
function setup(){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'});
  dom.window.eval(publicFile('i18n.js'));
  dom.window.eval(publicFile('app.js')+'\nme={moneyFormat:"decimal-string",paperAccounts:[],botSession:{state:"SETUP"},user:{id:"u"},bot:{id:"u"}};');
  return dom;
}
const risk=blockDuringNews=>({paperTrading:true,killSwitch:false,capPercentEquitySize:true,maxRiskPercent:100,maxTradesPerDay:10,maxDailyLossR:3,pauseAfterLossStreak:3,
  maxOpenPositions:4,maxSignalAgeSeconds:60,maxOrderNotional:'10000',maxDailyNotional:'100000',maxVolatilityPercent:5,sideMode:'BOTH',onePositionPerSymbol:false,
  requireReduceOnlySell:true,blockHighVolatility:true,blockDuringNews,allowedSymbols:['BTCUSDT'],equities:{'binance-global':'10000'},balances:{'binance-global':'2500'},
  defaults:{riskPercent:1,tradesPerDay:5,dailyLossR:2,lossStreak:2,openPositions:2,signalAgeSeconds:30,orderNotional:'1000',dailyNotional:'5000',volatilityPercent:3}});

test('the Risk manager hides Block during news: the control stays in the form but nobody can see or reach it',()=>{
  const w=setup().window,d=w.document;
  try{
    const input=d.querySelector('#riskForm [name=blockDuringNews]');
    assert.ok(input,'the field stays so the saved value can be read and sent back');
    const label=input.closest('label');
    assert.equal(label.hidden,true);
    // The stylesheet turns the hidden attribute into display:none inside the Risk form, whatever other rules say.
    assert.match(publicFile('styles-v2.css'),/#riskForm \[hidden\]\{display:none!important\}/);
    for(const node of d.querySelectorAll('#riskForm label,#riskForm span,#riskForm legend'))
      if(/Block during news/i.test(node.textContent))assert.ok(node.closest('[hidden]'),'visible news control: '+node.outerHTML.slice(0,80));
    // Other switches of the same row are still visible.
    assert.equal(d.querySelector('#riskForm [name=blockHighVolatility]').closest('label').hidden,false);
    assert.equal(d.querySelector('#riskForm [name=killSwitch]').closest('label').hidden,false);
  }finally{w.close();}
});

test('the hidden news switch keeps the saved value: fill then save sends it back unchanged, edits elsewhere do not reset it',()=>{
  const w=setup().window;
  try{
    for(const saved of [true,false]){
      w.fillRisk(risk(saved));
      assert.equal(w.collectRiskPolicy().blockDuringNews,saved,'what the server saved is what a save sends');
      const f=w.document.querySelector('#riskForm').elements;
      f.maxRiskPercent.value='50';f.killSwitch.checked=true;f.blockHighVolatility.checked=false;
      assert.equal(w.collectRiskPolicy().blockDuringNews,saved,'an unrelated edit does not touch the hidden switch');
      assert.equal(w.collectRiskPolicy().maxRiskPercent,50);
    }
    // A stored policy without the field (an old profile) is sent as false: nothing here invents or rewrites it to true.
    const old=risk(true);delete old.blockDuringNews;w.fillRisk(old);
    assert.equal(w.collectRiskPolicy().blockDuringNews,false);
  }finally{w.close();}
});

test('new risk profiles start with the news block on; existing saved profiles are never rewritten by this change',()=>{
  if(process.env.BLOCK_DURING_NEWS===undefined)assert.equal(config.defaultRisk.blockDuringNews,true);
  assert.match(fs.readFileSync(new URL('../.env.example',import.meta.url),'utf8'),/^BLOCK_DURING_NEWS=true\s*$/m);
  // The setting is only a default for new profiles: there is no migration or rewrite of saved rows.
  for(const file of ['src/postgres/schema.sql','src/postgres/pine-bridge-schema.sql'])
    assert.ok(!/block_?during_?news/i.test(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8')),file);
});

test('no screen still tells the owner to turn the news block off',()=>{
  for(const file of ['index.html','app.js','pine-bridge.js','readiness.js','journey.js','i18n.js','bots.js']){
    const text=publicFile(file);
    assert.ok(!/turn off ["']?Block during news/i.test(text),file+' still advises turning the news block off');
    assert.ok(!/carry no news data/i.test(text),file+' still says Bridge alerts carry no news data');
    assert.ok(!/NEWS_BLOCK_WITHOUT_NEWS_DATA/.test(text),file+' still knows the retired news code');
  }
});
