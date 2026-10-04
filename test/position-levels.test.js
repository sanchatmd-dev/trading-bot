import test from 'node:test';
import assert from 'node:assert/strict';
import {POSITION_LEVELS_PATH,MAX_POSITIONS,MAX_LOTS,SQL,chartSymbol,shapePositionLevels,readPositionLevels} from '../src/postgres/position-levels.js';

const NOW=Date.parse('2026-10-04T05:07:30Z');
const bots=[{id:'bot-1',label:'Main bot'},{id:'bot-2',label:'Second bot'}];
const position=(over={})=>({user_id:'bot-1',account_id:'acc-1',execution_mode:'PAPER',broker:'binance-global',symbol:'ETHUSDT',quantity:'1.50000000',
  avg_price:'2000.00000000',stop_loss:'1900.00000000',take_profit:'2200.00000000',updated_at:1000,...over});
const lot=(over={})=>({user_id:'bot-1',account_id:'acc-1',execution_mode:'PAPER',symbol:'ETHUSDT',quantity:'1.50000000',cost_price:'2001.50000000',
  fill_price:'1999.00000000',stop_loss:'1900.00000000',take_profit:'2200.00000000',opened_at:500,...over});
const shape=(positions,lots=[],extra={})=>shapePositionLevels({now:NOW,scope:'bot',bots,positions,lots,...extra});

test('constants: path, caps and frozen constant SELECT statements with a bound owner array',()=>{
  assert.equal(POSITION_LEVELS_PATH,'/api/positions/levels');assert.equal(MAX_POSITIONS,200);assert.equal(MAX_LOTS,500);
  assert.ok(Object.isFrozen(SQL));
  assert.deepEqual(Object.keys(SQL),['POSITIONS','LOTS']);
  const forbidden=/\b(INSERT|UPDATE|DELETE|MERGE|LOCK|TRUNCATE|CREATE|ALTER|DROP|NEXTVAL|PG_ADVISORY\w*)\b/i,lockClause=/\bFOR\s+(UPDATE|SHARE|NO\s+KEY|KEY\s+SHARE)\b/i;
  for(const [name,sql] of Object.entries(SQL)){
    assert.match(sql,/^\s*SELECT\b/,name);assert.doesNotMatch(sql,forbidden,name);assert.doesNotMatch(sql,lockClause,name);
    assert.ok(sql.includes('ANY($1::text[])'),name);assert.doesNotMatch(sql,/binance|ETHUSDT|BTCUSDT|bot-/i,name);
  }
  assert.match(SQL.POSITIONS,/FROM ledger_positions WHERE user_id = ANY\(\$1::text\[\]\) AND quantity > 0/);assert.match(SQL.POSITIONS,/LIMIT 201\s*$/);
  assert.match(SQL.LOTS,/FROM ledger_position_allocations a LEFT JOIN signals s ON s\.id = a\.entry_signal_id AND s\.user_id = a\.user_id/);
  assert.match(SQL.LOTS,/a\.status = 'OPEN' AND a\.remaining_quantity > 0/);assert.match(SQL.LOTS,/LIMIT 501\s*$/);
  assert.match(SQL.LOTS,/ORDER BY a\.user_id, a\.symbol, a\.opened_at, a\.position_id/);
});

test('chartSymbol: only binance-global positions with a clean Binance name',()=>{
  const ok=[['binance-global','ETHUSDT','ETHUSDT'],['binance-global','BINANCE:ETHUSDT','ETHUSDT'],['binance-global','binance:ethusdt','ETHUSDT'],
    ['binance-global','eth/usdt','ETHUSDT'],['binance-global','ETH-USDT','ETHUSDT'],['binance-global','eth_usdt','ETHUSDT'],['binance-global','ETH.USDT','ETHUSDT'],
    ['binance-global',' BTC USDT ','BTCUSDT'],['binance-global','BINANCE:BTC/USDT','BTCUSDT']];
  for(const [broker,symbol,expected] of ok)assert.equal(chartSymbol(broker,symbol),expected,symbol);
  for(const [broker,symbol] of [['binance-th','ETHUSDT'],['alpaca','AAPL'],['','ETHUSDT'],[undefined,'ETHUSDT'],['binance-global','ABCD'],
    ['binance-global','ETH$USDT'],['binance-global','ETH+USDT'],['binance-global','A'.repeat(21)],['binance-global',''],['binance-global',null],
    ['binance-global',5],['binance-global','\u00c9THUSDT'],['binance-global','BINANCE:'],['binance-global','..%2Fx']])
    assert.equal(chartSymbol(broker,symbol),null,String(broker)+' '+String(symbol));
});

test('shape: one position with per-lot lines, fill price basis and exact decimals',()=>{
  const out=shape([position()],[lot()]);
  assert.deepEqual(Object.keys(out),['version','generated_at','scope','truncated','positions']);
  assert.deepEqual([out.version,out.generated_at,out.scope,out.truncated],['position-levels-v1',new Date(NOW).toISOString(),'bot',false]);
  assert.equal(out.positions.length,1);
  assert.deepEqual(out.positions[0],{bot_id:'bot-1',bot_label:'Main bot',broker:'binance-global',symbol:'ETHUSDT',chart_symbol:'ETHUSDT',execution_mode:'PAPER',
    side:'LONG',quantity:'1.5',avg_price:'2000',stop_loss:'1900',take_profit:'2200',updated_at:1000,lots_match_position:true,
    lots:[{lot:1,opened_at:500,quantity:'1.5',entry_price:'1999',entry_basis:'fill',stop_loss:'1900',take_profit:'2200'}]});
  assert.equal(shape([position()],[lot()],{scope:'all'}).scope,'all');
});

test('shape: entry price falls back to the lot cost (including fee) when the fill price is null or not positive',()=>{
  for(const fill of [null,undefined,'0.00000000','-1.00000000']){
    const out=shape([position()],[lot({fill_price:fill})]);
    assert.deepEqual([out.positions[0].lots[0].entry_price,out.positions[0].lots[0].entry_basis],['2001.5','cost'],String(fill));
  }
});

test('shape: null and non-positive stop loss and take profit become null on lots and on the position',()=>{
  const out=shape([position({stop_loss:'0.00000000',take_profit:null})],[lot({stop_loss:null,take_profit:'-5.00000000'}),lot({stop_loss:'0.00000000',take_profit:'2300.10000000',opened_at:600,quantity:'0'})]);
  assert.deepEqual([out.positions[0].stop_loss,out.positions[0].take_profit],[null,null]);
  assert.deepEqual(out.positions[0].lots.map(item=>[item.stop_loss,item.take_profit]),[[null,null],[null,'2300.1']]);
});

test('shape: lots are numbered 1.. by opened_at and quantities that add up match the position',()=>{
  const out=shape([position({quantity:'3.00000000'})],[lot({opened_at:900,quantity:'1.00000000',fill_price:'2100.00000000'}),
    lot({opened_at:100,quantity:'2.00000000',fill_price:'1900.00000000'})]);
  const lots=out.positions[0].lots;
  assert.deepEqual(lots.map(item=>[item.lot,item.opened_at,item.quantity,item.entry_price]),[[1,100,'2','1900'],[2,900,'1','2100']]);
  assert.equal(out.positions[0].lots_match_position,true);
  const off=shape([position({quantity:'3.00000000'})],[lot({quantity:'1.00000000'}),lot({quantity:'1.50000000',opened_at:600})]);
  assert.equal(off.positions[0].lots_match_position,false,'2.5 of 3 held in lots');
  const decimal=shape([position({quantity:'0.30000000'})],[lot({quantity:'0.10000000'}),lot({quantity:'0.20000000',opened_at:600})]);
  assert.equal(decimal.positions[0].lots_match_position,true,'decimal compare, not float');
});

test('shape: a legacy position without lots keeps its own levels and does not report a mismatch',()=>{
  const out=shape([position()],[]);
  assert.deepEqual(out.positions[0].lots,[]);assert.equal(out.positions[0].lots_match_position,true);
  assert.deepEqual([out.positions[0].avg_price,out.positions[0].stop_loss,out.positions[0].take_profit],['2000','1900','2200']);
});

test('shape: lots match a position by user, account, mode and symbol; orphan lots are dropped',()=>{
  const out=shape([position()],[lot(),lot({symbol:'BTCUSDT'}),lot({account_id:'acc-2'}),lot({execution_mode:'LIVE'}),lot({user_id:'bot-2'})]);
  assert.equal(out.positions.length,1);assert.equal(out.positions[0].lots.length,1,'only the matching lot');
  const orphan=shape([],[lot()]);
  assert.deepEqual(orphan.positions,[],'a closed position means no lines');
});

test('shape: several bots, several symbols, other brokers and unlisted owners',()=>{
  const out=shape([position(),position({symbol:'BTCUSDT',quantity:'0.10000000'}),position({user_id:'bot-2',symbol:'ETHUSDT'}),
      position({broker:'binance-th',symbol:'ETHUSDT'}),position({user_id:'foreign',symbol:'ETHUSDT'})],
    [lot(),lot({user_id:'bot-2'})]);
  assert.deepEqual(out.positions.map(item=>[item.bot_id,item.symbol,item.chart_symbol]),
    [['bot-1','ETHUSDT','ETHUSDT'],['bot-1','BTCUSDT','BTCUSDT'],['bot-2','ETHUSDT','ETHUSDT'],['bot-1','ETHUSDT',null]],'foreign owners are never listed');
  assert.equal(out.positions.find(item=>item.bot_id==='bot-2').bot_label,'Second bot');
});

test('shape: a lot read cut at 500 marks positions without lots as not matching',()=>{
  const bots=[{id:'bot-1',label:'Alpha'}];
  const position=symbol=>({user_id:'bot-1',account_id:'a',execution_mode:'PAPER',broker:'binance-global',symbol,quantity:'1',avg_price:'10',
    stop_loss:null,take_profit:null,updated_at:1});
  const lot=index=>({user_id:'bot-1',account_id:'a',execution_mode:'PAPER',symbol:'AAAUSDT',quantity:'0.003',cost_price:'10',fill_price:null,
    stop_loss:null,take_profit:null,opened_at:index});
  const positions=[position('AAAUSDT'),position('BBBUSDT')];
  const cut=shapePositionLevels({now:NOW,scope:'bot',bots,positions,lots:Array.from({length:501},(_,index)=>lot(index))});
  assert.equal(cut.truncated,true);
  const [first,second]=cut.positions;
  assert.equal(first.lots_match_position,false,'partial lots');
  assert.deepEqual(second.lots,[]);assert.equal(second.lots_match_position,false,'lots missing because of the cut');
  const whole=shapePositionLevels({now:NOW,scope:'bot',bots,positions,lots:[]});
  assert.equal(whole.positions[1].lots_match_position,true,'legacy position without lots and no cut');
});
test('shape: truncation at 200 positions or 500 lots sets truncated',()=>{
  const many=count=>Array.from({length:count},(_,index)=>position({symbol:'T'+String(index).padStart(4,'0')+'USDT'}));
  const exactly=shape(many(200));
  assert.deepEqual([exactly.positions.length,exactly.truncated],[200,false]);
  const over=shape(many(201));
  assert.deepEqual([over.positions.length,over.truncated],[200,true]);
  const lots=count=>Array.from({length:count},(_,index)=>lot({opened_at:index+1,quantity:'0.01000000'}));
  const fine=shape([position({quantity:'5.00000000'})],lots(500));
  assert.deepEqual([fine.truncated,fine.positions[0].lots.length],[false,500]);
  const cut=shape([position({quantity:'5.01000000'})],lots(501));
  assert.equal(cut.truncated,true);assert.equal(cut.positions[0].lots.length,500);assert.equal(cut.positions[0].lots_match_position,false);
});

test('shape: no internal id, signal id, trade id or raw position id is exposed',()=>{
  const out=shape([position()],[{...lot(),position_id:'pos_1_1',entry_signal_id:77,entry_trade_id:'T-1',signal_id:5}]);
  const text=JSON.stringify(out);
  for(const banned of ['pos_1_1','T-1','position_id','signal','trade_id','account_id','acc-1','user_id'])assert.ok(!text.includes(banned),banned);
});

test('readPositionLevels: two constant SELECTs with the owned bot ids; no lot read without positions; no SQL without bots',async()=>{
  const statements=[];
  const db={async query(sql,params){statements.push({sql,params});return {rows:sql===SQL.POSITIONS?[position()]:[lot()]};}};
  const out=await readPositionLevels(db,bots,{scope:'all',now:NOW});
  assert.deepEqual(statements.map(item=>item.sql),[SQL.POSITIONS,SQL.LOTS]);
  assert.deepEqual(statements.map(item=>item.params),[[['bot-1','bot-2']],[['bot-1','bot-2']]]);
  assert.deepEqual([out.scope,out.positions.length,out.positions[0].lots.length],['all',1,1]);
  statements.length=0;
  const empty={async query(sql,params){statements.push({sql,params});return {rows:[]};}};
  const none=await readPositionLevels(empty,[bots[0]],{scope:'bot',now:NOW});
  assert.deepEqual(statements.map(item=>item.sql),[SQL.POSITIONS]);assert.deepEqual(none.positions,[]);assert.equal(none.generated_at,new Date(NOW).toISOString());
  statements.length=0;
  assert.deepEqual((await readPositionLevels(empty,[],{scope:'bot',now:NOW})).positions,[]);assert.equal(statements.length,0);
});

test('readPositionLevels: the extra row of the limit is what reveals a cut',async()=>{
  const db={async query(sql){return {rows:sql===SQL.POSITIONS?Array.from({length:201},(_,i)=>position({symbol:'T'+i+'USDT'})):[]};}};
  const out=await readPositionLevels(db,bots,{scope:'bot',now:NOW});
  assert.deepEqual([out.positions.length,out.truncated],[200,true]);
});