import {Qr2Error} from './qr2-constants.js';

// Provisional local/off qualification envelope. Production selection remains gated.
export const QR2_COVERAGE_LIMITS=Object.freeze({union_minutes:43200,timestamp_rows:21600,unique_windows:20,derivation_visits:100000,output_intervals:4096,coverage_input_bytes:524288,coverage_output_bytes:1048576});
export function coverageReadBudgets(given={}){
  if(!given||typeof given!=='object'||Array.isArray(given)||![Object.prototype,null].includes(Object.getPrototypeOf(given)))throw new Qr2Error('QR2_INPUT_INVALID');
  const budgets={...QR2_COVERAGE_LIMITS};
  for(const key of Reflect.ownKeys(given)){
    const descriptor=Object.getOwnPropertyDescriptor(given,key);
    if(!Object.hasOwn(QR2_COVERAGE_LIMITS,key)||!Object.hasOwn(descriptor,'value')||!Number.isSafeInteger(descriptor.value)||descriptor.value<1||descriptor.value>QR2_COVERAGE_LIMITS[key])throw new Qr2Error('QR2_INPUT_INVALID');
    budgets[key]=descriptor.value;
  }
  return Object.freeze(budgets);
}
