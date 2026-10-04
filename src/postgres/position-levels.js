import {D,exact} from '../money.js';
import {SYMBOL_RE} from './market-proxy.js';

/**
 * Read-only open-position levels for the chart overlay: one entry per held position, with one row per OPEN lot (allocation).
 * Per-lot stop loss and take profit are what the Pine bridge exit decision enforces (ledger_position_allocations); the position row
 * keeps only the newest levels, so it is used only for a legacy position that has no open lot. Plain SELECTs: no write, no lock, no
 * internal id in the answer. Runs inside the request transaction on the pinned request client.
 */
export const POSITION_LEVELS_PATH='/api/positions/levels';
export const MAX_POSITIONS=200;
export const MAX_LOTS=500;
const BROKER='binance-global';
const PREFIX='BINANCE:';

// Constant statements. $1 is a text array of owned bot ids. One extra row is read so a cut is detected.
export const SQL=Object.freeze({
  POSITIONS:`SELECT user_id, account_id, execution_mode, broker, symbol, quantity::text AS quantity, avg_price::text AS avg_price,
      stop_loss::text AS stop_loss, take_profit::text AS take_profit, updated_at
    FROM ledger_positions WHERE user_id = ANY($1::text[]) AND quantity > 0
    ORDER BY user_id, symbol LIMIT ${MAX_POSITIONS+1}`,
  LOTS:`SELECT a.user_id, a.account_id, a.execution_mode, a.symbol, a.remaining_quantity::text AS quantity,
      a.entry_price::text AS cost_price, s.fill_price::text AS fill_price, a.stop_loss::text AS stop_loss,
      a.take_profit::text AS take_profit, a.opened_at
    FROM ledger_position_allocations a LEFT JOIN signals s ON s.id = a.entry_signal_id AND s.user_id = a.user_id
    WHERE a.user_id = ANY($1::text[]) AND a.status = 'OPEN' AND a.remaining_quantity > 0
    ORDER BY a.user_id, a.symbol, a.opened_at, a.position_id LIMIT ${MAX_LOTS+1}`});

/** The Binance chart symbol of a held position, or null (other brokers, odd names). 'BINANCE:ETHUSDT' and 'eth/usdt' give ETHUSDT. */
export function chartSymbol(broker,symbol){
  if(broker!==BROKER||typeof symbol!=='string')return null;
  let name=symbol.trim().toUpperCase();
  if(name.startsWith(PREFIX))name=name.slice(PREFIX.length);
  name=name.replace(/[\/\-_. ]/g,'');
  return SYMBOL_RE.test(name)?name:null;
}

// A level is a positive decimal or null; zero and negative values mean "not set".
function level(value){
  if(value===null||value===undefined)return null;
  try{return D(value).gt(0)?exact(value):null;}catch{return null;}
}

const lotKey=row=>[row.user_id,row.account_id,row.execution_mode,row.symbol].join('\u0000');

/** The answer body; pure. bots are the ownership-filtered {id,label} rows; positions and lots are the SQL rows. */
export function shapePositionLevels({now,scope,bots,positions,lots}){
  const labels=new Map(bots.map(bot=>[bot.id,bot.label]));
  const positionsCut=positions.length>MAX_POSITIONS,lotsCut=lots.length>MAX_LOTS;
  const lotsByPosition=new Map();
  for(const row of lotsCut?lots.slice(0,MAX_LOTS):lots){
    const key=lotKey(row);
    if(!lotsByPosition.has(key))lotsByPosition.set(key,[]);
    lotsByPosition.get(key).push(row);
  }
  const shaped=[];
  for(const position of positionsCut?positions.slice(0,MAX_POSITIONS):positions){
    if(!labels.has(position.user_id))continue;
    // Lots without a live position row are never read here: a closed position means no lines.
    const rows=(lotsByPosition.get(lotKey(position))??[]).slice().sort((a,b)=>a.opened_at-b.opened_at);
    const detail=rows.map((row,index)=>{
      const fill=level(row.fill_price);
      return {lot:index+1,opened_at:row.opened_at,quantity:exact(row.quantity),entry_price:fill??exact(row.cost_price),
        entry_basis:fill===null?'cost':'fill',stop_loss:level(row.stop_loss),take_profit:level(row.take_profit)};
    });
    // No lots at all (legacy position): nothing contradicts the position row, unless the lot read was cut and the lots are missing.
    const match=rows.length===0?!lotsCut:rows.reduce((total,row)=>total.plus(D(row.quantity)),D(0)).eq(D(position.quantity));
    shaped.push({bot_id:position.user_id,bot_label:labels.get(position.user_id),broker:position.broker,symbol:position.symbol,
      chart_symbol:chartSymbol(position.broker,position.symbol),execution_mode:position.execution_mode,side:'LONG',
      quantity:exact(position.quantity),avg_price:exact(position.avg_price),stop_loss:level(position.stop_loss),
      take_profit:level(position.take_profit),updated_at:position.updated_at,lots_match_position:match,lots:detail});
  }
  return {version:'position-levels-v1',generated_at:new Date(now).toISOString(),scope,truncated:positionsCut||lotsCut,positions:shaped};
}

/** Reads and shapes the levels of the given owned bots. db.query uses the pinned request client inside the request transaction. */
export async function readPositionLevels(db,bots,{scope,now=Date.now()}){
  const ids=bots.map(bot=>bot.id);
  const positions=ids.length===0?[]:(await db.query(SQL.POSITIONS,[ids])).rows;
  const lots=positions.length===0?[]:(await db.query(SQL.LOTS,[ids])).rows;
  return shapePositionLevels({now,scope,bots,positions,lots});
}