import {D,Money} from '../money.js';

// QR-2 constants (docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md, S1 pure library). Nothing here reads a database, the clock
// or the network. A change of any constant is a new method id and a new golden-fixture set (contract 7.4).

export const QR2_BASIS='ACTUAL_PAPER_LEDGER';
export const QR2_EXECUTION='PAPER_SIMULATED_FILLS';
export const QR2_MARKET=Object.freeze({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
// O1: fresh up to 180 s, stale (value still used) up to 900 s, unavailable beyond. 900 s is a hard cutoff.
export const QR2_PRICE_POLICY=Object.freeze({fresh_ms:180000,carry_ms:900000});
export const QR2_DAY_MS=86400000;
// 7.4: every response carries these ids.
export const QR2_METHODS=Object.freeze({
  valuation_method:'btcusdt-1m-close-asof-market-v1',
  valuation_method_option_r:'btcusdt-1m-close-asof-retrieved-v1',
  return_method:Object.freeze({twr:'twr-flow-split-v1',mwr:'mwr-modified-dietz-v1',money_pnl:'money-pnl-flow-v1'}),
  lot_method:Object.freeze({E0:'ledger-stored-lots-target-fifo-fallback-v1',E1:'paper-exit-cost-o3-v1',E2:'paper-exit-cost-v2'}),
  legacy_method:'legacy-two-seed-v1',
  order_method:'commit-order-snapshot-id-v1',
  period_method:'utc-exclusive-isoweek-v1',
  drawdown_grid:'qr2-grid-daily-events-v1',
  alloc_method:'qr2-alloc-v1',
  rounding:Object.freeze({market_value:'market-value-18-half-even',return:'return-12-half-even'})
});
export const QR2_EPOCHS=Object.freeze(['E0','E1','E2']);
// The ledgerRule marker written into signals.broker_response by complete() (corroboration only, contract 6.2 and section 5).
export const QR2_MARKER_EPOCH=Object.freeze({'paper-exit-cost-o3-v1':'E1','paper-exit-cost-v2':'E2'});
// Fee source label of every view (contract 1.3): fees are fills.fee_quote only.
export const QR2_FEE_SOURCE='RECORDED_ONLY';
export const QR2_STATUS=Object.freeze({REFUSED:'REFUSED',COMPLETE:'COMPLETE',PARTIAL:'PARTIAL',UNAVAILABLE:'UNAVAILABLE'});
export const QR2_OVERLAYS=Object.freeze(['LEDGER_INVARIANT_VIOLATED','RECONCILIATION_UNAVAILABLE_LEGACY']);
export const QR2_WEEK_LABEL='Week (Mon-Sun, UTC)';

// Decimal helpers. Money precision is 80 digits half-even (src/money.js). Market value is rounded once per position per
// instant to 18 places; each return is rounded once at output to 12 places (contract 2.5, 3).
export const dec=value=>D(value);
export const round18=value=>D(value).toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed();
export const round12=value=>D(value).toDecimalPlaces(12,Money.ROUND_HALF_EVEN).toFixed();
export const isZeroDec=value=>D(value).isZero();
// Internal identity, no rounding: a Decimal as a plain decimal string.
export const str=value=>D(value).toFixed();

export class Qr2Error extends Error{
  constructor(code,message){super(message||code);this.name='Qr2Error';this.code=code;}
}
