import test from 'node:test';
import assert from 'node:assert/strict';
import {barsFromKlines,fetchBinanceBars} from '../src/pine-bridge/market-data.js';
import {validateBar} from '../src/postgres/pine-bridge-market.js';

const metadata={price_tick:'0.01',quantity_step:'0.001'};
const klines=()=>Array.from({length:520},(_,i)=>[60000*(i+1),'100','102','98','101','10',60000*(i+2)-1]);
test('market collector computes ATR14 after warmup and includes closed bars only',()=>{
  const result=barsFromKlines(klines(),metadata,60000*520);
  assert.equal(result.bars.length,19);assert.equal(result.warmup,500);
  for(const bar of result.bars){assert.equal(bar.atr14,'4');validateBar(bar);}
  assert.equal(result.bars.at(-1).time,60000*520);
  assert.match(result.seed_hash,/^[a-f0-9]{64}$/);
});
test('market collector refuses gaps, invalid candles, short history and unsupported intervals',async()=>{
  const gap=klines();gap[20][0]++;
  assert.throws(()=>barsFromKlines(gap,metadata),{code:'MARKET_DATA_GAP'});
  const invalid=klines();invalid[1][1]='103';
  assert.throws(()=>barsFromKlines(invalid,metadata),{code:'INVALID_MARKET_BAR'});
  assert.throws(()=>barsFromKlines(klines().slice(0,100),metadata),{code:'MARKET_WARMUP_REQUIRED'});
  await assert.rejects(fetchBinanceBars('BTCUSDT','1S',{fetcher:()=>{throw Error('must not fetch');}}),{code:'UNSUPPORTED_MARKET'});
});
