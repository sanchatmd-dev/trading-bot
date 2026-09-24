import {PostgresDatabase} from '../src/postgres/db.js';
import {fetchBinanceBars,fetchBinanceNextBars} from '../src/pine-bridge/market-data.js';
import {hash,canonical} from '../src/pine-bridge/source.js';
import {validateBar} from '../src/postgres/pine-bridge-market.js';

const [symbol,timeframe]=process.argv.slice(2);
if(!symbol||!timeframe)throw new Error('Usage: collect-pine-bars.mjs SYMBOL PINE_TIMEFRAME');
// Run as a dedicated market-data writer, never as the HTTP/AI runtime role.
const db=new PostgresDatabase();
try{
  let previous=(await db.prepare('SELECT bar,provenance FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? ORDER BY bar_time DESC LIMIT 1').get('binance-global',symbol,timeframe));
  let written=0,firstTime=null,lastTime=null,seedHash=null;
  for(let page=0;page<100;page++){
    const data=previous?await fetchBinanceNextBars(symbol,timeframe,previous.bar,previous.provenance):await fetchBinanceBars(symbol,timeframe);
    if(!previous)seedHash=data.seed_hash;
    if(data.bars.length===0)break;
    await db.transaction(async()=>{
    await db.lock('pine-market:'+symbol+':'+timeframe);
    for(const bar of data.bars){
      validateBar(bar);const digest=hash(canonical(bar));
      const old=await db.prepare('SELECT bar FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? AND bar_time=?').get('binance-global',symbol,timeframe,bar.time);
      if(old){
        // A rolling ATR seed can differ microscopically. Keep the first frozen
        // record; any actual OHLCV revision must be reconciled explicitly.
        for(const key of ['open','high','low','close','volume','price_tick','quantity_step'])if(old.bar[key]!==bar[key])throw new Error('Market record changed; reconciliation required');
        continue;
      }
      await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?)').run('binance-global',symbol,timeframe,bar.time,JSON.stringify(bar),JSON.stringify(data.provenance),digest);
      written++;firstTime??=bar.time;lastTime=bar.time;
    }
    });
    previous={bar:data.bars.at(-1),provenance:data.provenance};
    if(data.bars.length<1000)break;
    if(page===99)throw new Error('Market backlog exceeds 100 pages; resume collection explicitly');
  }
  const total=await db.prepare('SELECT count(*) AS n FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=?').get('binance-global',symbol,timeframe);
  console.log(JSON.stringify({broker:'binance-global',symbol,timeframe,written,first_time:firstTime,last_time:lastTime,total_frozen_bars:Number(total.n),seed_hash:seedHash}));
}finally{await db.close();}
