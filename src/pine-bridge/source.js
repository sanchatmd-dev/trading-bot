import {createHash} from 'node:crypto';

export const versions = Object.freeze({prompt:'bridge-prompt-v1', guide:'bridge-guide-v1', template:'bridge-exit-v1', parser:'pine-static-v1', bridge:'indicator-bridge-v1', quant:'quant-evaluator-v1'});
export const fail = (code, status=400) => Object.assign(new Error(code), {code,status});
export const hash = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function keys(value, allowed, required=allowed) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) throw fail('INVALID_FIELDS');
}
export function number(value, {min=-1e12,max=1e12,integer=false}={}) {
  if (typeof value!=='number' || !Number.isFinite(value) || value<min || value>max || (integer&&!Number.isSafeInteger(value))) throw fail('INVALID_NUMERIC_VALUE');
  return value;
}

// Mask strings/comments without shifting offsets or line boundaries. This is a
// conservative structural scanner, not a Pine compiler or semantic evaluator.
export function executable(source) {
  let result='', quote=null;
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(quote) {
      if(c==='\\') {result+='  ';i++;continue;}
      if(c===quote) quote=null;
      result+=c==='\n'?'\n':' '; continue;
    }
    if(c==='"'||c==="'") {quote=c;result+=' ';continue;}
    if(c==='/'&&source[i+1]==='/') {while(i<source.length&&source[i]!=='\n'){result+=' ';i++;} if(i<source.length)result+='\n';continue;}
    result+=c;
  }
  if(quote) throw fail('UNTERMINATED_STRING');
  return result;
}

function argumentsOf(source, masked, start) {
  const values=[];let depth=1,from=start;
  for(let i=start;i<masked.length;i++) {
    if('([{'.includes(masked[i]))depth++;
    if(')]}'.includes(masked[i]))depth--;
    if(depth===0){values.push(source.slice(from,i).trim());return {values,end:i+1};}
    if(masked[i]===','&&depth===1){values.push(source.slice(from,i).trim());from=i+1;}
  }
  throw fail('UNBALANCED_INPUT');
}
const literal = text => {
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text||''))return null;
  const n=Number(text);return Number.isFinite(n)&&Math.abs(n)<=1e12?n:null;
};
export function inspectSource(source) {
  if(typeof source!=='string'||!source.length)throw fail('SOURCE_REQUIRED');
  if(Buffer.byteLength(source,'utf8')>256*1024||source.split('\n').length>10000)throw fail('SOURCE_TOO_LARGE',413);
  const code=executable(source);
  if(/\bstrategy\s*(?:\(|\.)/.test(code))throw fail('INDICATOR_REQUIRED');
  const directives=[...source.matchAll(/^\s*\/\/@version=(\d+)\s*$/gm)];
  if(directives.length!==1||!['5','6'].includes(directives[0][1])||[...code.matchAll(/\bindicator\s*\(/g)].length!==1)throw fail('UNSUPPORTED_BRIDGE_SOURCE');
  const source_hash=hash(source), inputs=[];
  for(const m of code.matchAll(/^(?:(?:var|varip|const|simple|series)\s+)?(?:(?:int|float|bool|string|color)\s+)?([A-Za-z_]\w*)\s*=\s*input\.(\w+)\s*\(/gm)) {
    const {values,end}=argumentsOf(source,code,m.index+m[0].length);
    const positional=[],named={};
    for(const value of values){const pair=value.match(/^(\w+)\s*=\s*([\s\S]*)$/);if(pair)named[pair[1]]=pair[2];else positional.push(value);}
    const raw=named.defval??positional[0],type=m[2],numeric=['int','float'].includes(type),value=literal(raw);
    const reassigned=new RegExp('\\b'+m[1]+'\\s*:=').test(code);
    const reason=!numeric?'NON_NUMERIC':value===null?'NON_LITERAL_DEFAULT':reassigned?'REASSIGNED_INPUT':null;
    inputs.push({input_id:hash(source_hash+':'+m.index).slice(0,24),pine_variable:m[1],input_title:named.title??positional[1]??m[1],type,unit:null,default:numeric?value:raw,effective_value:numeric?value:raw,origin:'source',source_span:{start:m.index,end},optimization_status:'fixed',eligible:!reason,excluded_reason:reason,declared_domain:{min:literal(named.minval),max:literal(named.maxval),step:literal(named.step)},quant_capability:'PENDING'});
  }
  const declarations=[...code.matchAll(/^(?:(?:var|varip|const|simple|series)\s+)?(?:(?:int|float|bool|string|color)\s+)?([A-Za-z_]\w*)\s*=(?!>)/gm)].map(m=>m[1]);
  const dependencies=['request.security','ta.pivothigh','ta.pivotlow','array.','matrix.','varip','import'].filter(name=>code.includes(name));
  const scanComplete=[...code.matchAll(/\binput(?:\.\w+)?\s*\(/g)].length===inputs.length;
  return {source_hash,pine_version:Number(directives[0][1]),inputs,declarations,dependencies,native_alerts:/\balert\s*\(/.test(code),bridge_capability:{status:'DRAFT',blockers:['TRADINGVIEW_COMPILE_REQUIRED','SIGNAL_MAPPING_REVIEW_REQUIRED','EFFECTIVE_INPUT_SNAPSHOT_REVIEW_REQUIRED','NATIVE_ALERT_ISOLATION_REQUIRED','PAPER_EVIDENCE_REQUIRED',...(!scanComplete?['INPUT_SCAN_INCOMPLETE']:[])]},quant_capability:{status:'UNSUPPORTED',blockers:['QUANT_UNSUPPORTED',...dependencies.map(d=>'EVALUATOR_REQUIRED:'+d)]}};
}

export function validateSelection(analysis, signals, slots, bridge={atr_multiplier:2,rr:1.5}) {
  keys(signals,['buy','exit','timing']);
  if(signals.timing!=='bar_close'||![signals.buy,signals.exit].every(s=>typeof s==='string'&&/^[A-Za-z_]\w*$/.test(s)&&analysis.declarations.includes(s)))throw fail('UNRESOLVED_SIGNAL_MAPPING');
  if(!Array.isArray(slots)||slots.length>8)throw fail('INVALID_SLOT_COUNT');
  const ids=new Set(),indexes=new Set();
  const bindings=slots.map(slot=>{
    keys(slot,['slot','input_id','min','max','step']);
    number(slot.slot,{min:3,max:10,integer:true});
    if(ids.has(slot.input_id)||indexes.has(slot.slot))throw fail('DUPLICATE_BINDING');
    ids.add(slot.input_id);indexes.add(slot.slot);
    const input=analysis.inputs.find(i=>i.input_id===slot.input_id);
    if(!input?.eligible)throw fail('INELIGIBLE_INPUT');
    const integer=input.type==='int';
    for(const k of ['min','max','step'])number(slot[k],{integer});
    const {min,max,step}=slot,d=input.declared_domain;
    if(step<=0||min>input.effective_value||max<input.effective_value||min>max||(d.min!==null&&min<d.min)||(d.max!==null&&max>d.max))throw fail('INVALID_SEARCH_DOMAIN');
    return {...input,slot:slot.slot,search_domain:{min,max,step},optimization_status:'optimized'};
  });
  keys(bridge,['atr_multiplier','rr']);number(bridge.atr_multiplier,{min:Number.MIN_VALUE,max:1000});number(bridge.rr,{min:Number.MIN_VALUE,max:1000});
  return {signals,bindings,bridge,fixed_inputs:analysis.inputs.filter(i=>!ids.has(i.input_id))};
}
