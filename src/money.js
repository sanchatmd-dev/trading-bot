import Decimal from 'decimal.js';

// Products of two NUMERIC(38,18) values fit in this precision without losing digits.
export const Money = Decimal.clone({precision:80,rounding:Decimal.ROUND_HALF_EVEN,toExpNeg:-80,toExpPos:80});
export const D = value => {
  if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid decimal');
  if(!['number','string'].includes(typeof value)&&!(value instanceof Money))throw new Error('Invalid decimal');
  if(typeof value==='string'&&(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)||value.length>120))throw new Error('Invalid decimal');
  const result=new Money(value);
  if(!result.isFinite()||result.abs().gte('1e20'))throw new Error('Decimal outside supported range');
  return result;
};
export const exact = value => {
  const result=D(value);
  if(result.decimalPlaces()>18)throw new Error('Maximum decimal scale is 18');
  return result.toFixed();
};
export const amount = value => D(value).toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed();
export const down = value => D(value).toDecimalPlaces(18,Money.ROUND_DOWN).toFixed();
export const sum = values => values.reduce((total,value)=>total.plus(D(value)),new Money(0));
