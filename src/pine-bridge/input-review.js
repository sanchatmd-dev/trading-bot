import {fail,keys,number,hash,canonical} from './source.js';

// This module is separate from source.js so the accepted QL-2A parser hash stays frozen.
export function defaultHint(input) {
  if (['int','float'].includes(input.type)) return input.default;
  const raw=String(input.default??'').trim();
  if (input.type==='bool') return raw==='true'?true:raw==='false'?false:null;
  if (input.type==='time') {
    const match=raw.match(/^timestamp\("([^"\r\n]+)"\)$/);
    const dateText=match?.[1];
    const value=match?Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(dateText)?dateText:dateText+'Z'):Number(raw);
    return Number.isSafeInteger(value)?value:null;
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try{return JSON.parse(raw);}catch{return null;}
  }
  return null;
}

export function reviewFields(analysis) {
  return analysis.inputs.map(input=>({
    input_id:input.input_id,pine_variable:input.pine_variable,input_title:input.input_title,
    type:input.type,default_hint:defaultHint(input),declared_domain:input.declared_domain,
    eligible:input.eligible,excluded_reason:input.excluded_reason
  }));
}

export function reviewedInputs(analysis,values,attestation,owner) {
  keys(attestation,['source_hash','confirmed']);
  if(attestation.source_hash!==analysis.source_hash||attestation.confirmed!==true)throw fail('EFFECTIVE_INPUT_REVIEW_REQUIRED');
  keys(values,analysis.inputs.map(input=>input.input_id),analysis.inputs.map(input=>input.input_id));
  const result=structuredClone(analysis),normalized={};
  for(const input of result.inputs) {
    const value=values[input.input_id];
    if(['int','float'].includes(input.type)) {
      number(value,{integer:input.type==='int',min:input.declared_domain.min??-1e12,max:input.declared_domain.max??1e12});
    } else if(input.type==='bool') {
      if(typeof value!=='boolean')throw fail('INVALID_EFFECTIVE_INPUT_TYPE');
    } else if(input.type==='time') {
      number(value,{min:-Number.MAX_SAFE_INTEGER,max:Number.MAX_SAFE_INTEGER,integer:true});
    } else if(typeof value!=='string'||value.length>2000)throw fail('INVALID_EFFECTIVE_INPUT_TYPE');
    input.effective_value=value;
    normalized[input.input_id]=value;
  }
  const effectiveHash=hash(canonical(normalized));
  result.effective_inputs_hash=effectiveHash;
  result.effective_input_review={source_hash:analysis.source_hash,effective_inputs_hash:effectiveHash,reviewed_by:owner,reviewed_at:Date.now(),input_count:result.inputs.length};
  return result;
}
