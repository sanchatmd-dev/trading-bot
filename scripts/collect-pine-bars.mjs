import {PostgresDatabase} from '../src/postgres/db.js';
import {fetchBinanceBars} from '../src/pine-bridge/market-data.js';
import {hash,canonical} from '../src/pine-bridge/source.js';
import {validateBar} from '../src/postgres/pine-bridge-market.js';

const [symbol,timeframe]=process.argv.slice(2);
if(!symbol||!timeframe)throw new Error('Usage: collect-pine-bars.mjs SYMBOL PINE_TIMEFRAME');
// Run as a dedicated market-data writer, never as the HTTP/AI runtime role.
const data=await fetchBinanceBars(symbol,timeframe),db=new PostgresDatabase();
try{
  await db.transaction(async()=>{
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
    }
  });
  console.log(JSON.stringify({broker:'binance-global',symbol,timeframe,closed_bars:data.bars.length,seed_hash:data.seed_hash}));
}finally{await db.close();}
