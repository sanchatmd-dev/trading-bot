import {PostgresDatabase} from '../src/postgres/db.js';
import {extendBarsFromKlines,fetchBinanceBars,fetchBinanceNextBars,intervals} from '../src/pine-bridge/market-data.js';
import {hash,canonical} from '../src/pine-bridge/source.js';
import {validateBar} from '../src/postgres/pine-bridge-market.js';

const [symbol,timeframe]=process.argv.slice(2);
if(!/^[A-Z0-9]{3,30}$/.test(symbol||'')||!intervals[timeframe])throw new Error('Usage: stream-pine-bars.mjs SYMBOL PINE_TIMEFRAME');
if(typeof WebSocket!=='function')throw new Error('Node WebSocket support is required');
// This process requires the dedicated market-data writer, not the API runtime role.
const db=new PostgresDatabase(),broker='binance-global';
let previous,connection,stopping=false,retry,chain=Promise.resolve();
const log=(kind,detail={})=>console.log(JSON.stringify({kind,broker,symbol,timeframe,...detail}));

async function latest(){return db.prepare('SELECT bar,provenance FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? ORDER BY bar_time DESC LIMIT 1').get(broker,symbol,timeframe);}
async function freeze(data){
  for(const bar of data.bars){
    validateBar(bar);
    await db.transaction(async()=>{
      await db.lock('pine-market:'+symbol+':'+timeframe);
      const old=await db.prepare('SELECT bar FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? AND bar_time=?').get(broker,symbol,timeframe,bar.time);
      if(old){
        for(const key of ['open','high','low','close','volume','price_tick','quantity_step'])if(old.bar[key]!==bar[key])throw new Error('Market record changed; reconciliation required');
      }else await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?)').run(broker,symbol,timeframe,bar.time,JSON.stringify(bar),JSON.stringify(data.provenance),hash(canonical(bar)));
    });
    previous=await latest();
  }
}
async function catchUp(){
  previous=await latest();
  for(let page=0;page<100;page++){
    const data=previous?await fetchBinanceNextBars(symbol,timeframe,previous.bar,previous.provenance):await fetchBinanceBars(symbol,timeframe);
    if(!data.bars.length)return;
    await freeze(data);
    if(data.bars.length<1000)return;
  }
  throw new Error('Market backlog exceeds 100 pages');
}
async function closedKline(payload){
  const k=payload?.k;
  if(payload?.s!==symbol||!k||k.s!==symbol||k.i!==intervals[timeframe]||k.x!==true)return;
  if(!Number.isSafeInteger(k.t)||!Number.isSafeInteger(k.T)||k.T+1> Date.now())throw new Error('Invalid closed kline time');
  if(!previous||k.t>previous.bar.time)await catchUp();
  if(k.T+1<=previous.bar.time)return;
  const now=Date.now(),row=[k.t,k.o,k.h,k.l,k.c,k.v,k.T];
  const bars=extendBarsFromKlines([row],previous.bar,{price_tick:previous.bar.price_tick,quantity_step:previous.bar.quantity_step},now);
  if(!bars.length)return;
  await freeze({bars,provenance:{...previous.provenance,source:'wss://stream.binance.com/ws/'+symbol.toLowerCase()+'@kline_'+intervals[timeframe],continuation_from:previous.bar.time,retrieved_at:now}});
  log('closed_bar_frozen',{bar_time:bars[0].time,retrieved_at:now});
}
function connect(){
  if(stopping)return;
  connection=new WebSocket('wss://stream.binance.com:443/ws/'+symbol.toLowerCase()+'@kline_'+intervals[timeframe]);
  connection.onopen=()=>{log('connected');chain=chain.then(catchUp).catch(error=>{log('catchup_failed',{error:error.code??error.message});connection.close();});};
  connection.onmessage=event=>{chain=chain.then(()=>closedKline(JSON.parse(event.data))).catch(error=>{log('stream_failed',{error:error.code??error.message});connection.close();});};
  connection.onerror=()=>log('socket_error');
  connection.onclose=()=>{log('disconnected');if(!stopping)retry=setTimeout(connect,2000);};
}
async function stop(){stopping=true;clearTimeout(retry);connection?.close();await chain;await db.close();}
process.once('SIGINT',()=>stop().then(()=>process.exit(0)).catch(()=>process.exit(1)));
process.once('SIGTERM',()=>stop().then(()=>process.exit(0)).catch(()=>process.exit(1)));
await catchUp();connect();
