import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {inspectSource,validateSelection} from '../src/pine-bridge/source.js';
import {CATALOG,SOURCE_HASH} from '../src/quant-research/contract.js';
import {reviewFields} from '../src/pine-bridge/input-review.js';

test('Bridge dropdown binds up to eight unique numeric slots, preserves errors as text, clears source on logout',async()=>{
  const dom=new JSDOM('<button id="logout"></button><section data-page="quant"></section>',{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window,source='//@version=6\nindicator("Fixture")\na=input.int(2)\nb=input.float(3)\nbuy=close>open\nsell=close<open';
  const analysis=inspectSource(source);const requests=[];
  w.URL.revokeObjectURL=()=>{};
  w.api=async(path,options)=>{
    requests.push({path,options});
    if(path==='/api/bots')return {bots:[{id:'mine',label:'<img src=x onerror=alert(1)>'}]};
    if(path.endsWith('/inspect'))return {source_hash:analysis.source_hash,input_count:analysis.inputs.length,inputs:reviewFields(analysis)};
    if(path.endsWith('/analyze'))return {job_id:'fixture'};
    return {job_status:'SUCCEEDED',pine_import_id:'source',result:{...analysis,proposal:{buy:'buy',exit:'sell',eligible_inputs:analysis.inputs.map(i=>i.input_id),diagnostics:['<script>injection</script>']}}};
  };
  w.eval(await fs.readFile(new URL('../public/pine-bridge.js',import.meta.url),'utf8'));
  const el=id=>w.document.getElementById(id),flush=()=>new Promise(resolve=>setImmediate(resolve));
  el('pbLoadBots').click();await flush();assert.equal(el('pbBot').value,'mine');assert.equal(w.document.querySelectorAll('img').length,0);
  el('pbSource').value=source;el('pbInspect').click();await flush();
  assert.equal(requests.some(r=>r.path.endsWith('/analyze')),false);
  assert.equal(el('pbInputFields').querySelectorAll('[data-input-id]').length,2);
  el('pbInputsConfirmed').click();el('pbAnalyze').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();
  const selects=[...el('pbSlots').querySelectorAll('select')];assert.equal(selects.length,8);
  selects[0].value=analysis.inputs[0].input_id;selects[0].dispatchEvent(new w.Event('change'));
  assert.equal([...selects[1].options].find(o=>o.value===analysis.inputs[0].input_id).disabled,true);
  assert.equal(w.document.querySelectorAll('script').length,0);assert.match(el('pbDiagnostics').textContent,/injection/);
  assert.ok(requests.find(r=>r.path.endsWith('/analyze')).options.headers['Idempotency-Key']);
  const submitted=JSON.parse(requests.find(r=>r.path.endsWith('/analyze')).options.body);
  assert.equal(submitted.input_review.source_hash,analysis.source_hash);
  assert.equal(Object.keys(submitted.effective_inputs).length,2);
  el('pbInputFields').querySelector('[data-input-id]').value='4';
  el('pbInputFields').querySelector('[data-input-id]').dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(el('pbGenerate').hidden,true);
  assert.equal(el('pbInputsConfirmed').checked,false);
  el('logout').click();assert.equal(el('pbSource').value,'');assert.equal(el('pbDiagnostics').textContent,'');assert.equal(el('pbGenerate').hidden,true);
  w.close();
});

// Step 2 UI proof (S2): ten numeric inputs, so eight slot selects can all be filled and the pick list can be reduced.
// Fixture source only; product behavior is unchanged.
const wideSource=['//@version=6','indicator("Wide")',...Array.from({length:10},(_,i)=>'p'+(i+1)+'=input.'+(i%2?'float':'int')+'('+(10+i)+(i%2?'.5':'')+', minval=1, maxval=100)'),'buy=close>open','sell=close<open'].join('\n');
async function mountWide(eligible,{source=wideSource,sourceHash,i18n=false}={}){
  const dom=new JSDOM('<button id="logout"></button><section data-page="quant"></section>',{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window,analysis=inspectSource(source),requests=[];
  if(sourceHash)analysis.source_hash=sourceHash;
  if(i18n){
    w.document.body.insertAdjacentHTML('afterbegin','<select id="language"><option value="en">English</option><option value="th">ไทย</option></select><button id="forgotPassword"></button><dialog id="recoveryDialog"></dialog>');
    w.eval(await fs.readFile(new URL('../public/i18n.js',import.meta.url),'utf8'));
  }
  w.URL.revokeObjectURL=()=>{};
  w.api=async(path,options)=>{
    requests.push({path,options});
    if(path==='/api/bots')return {bots:[{id:'mine',label:'Mine'}]};
    if(path.endsWith('/inspect'))return {source_hash:analysis.source_hash,input_count:analysis.inputs.length,inputs:reviewFields(analysis)};
    if(path.endsWith('/analyze'))return {job_id:'analyze-job'};
    if(path.endsWith('/generate'))return {job_id:'generate-job'};
    // The generate job ends here. These tests inspect the POST, not the finished draft.
    if(path.endsWith('/generate-job'))return {job_status:'FAILED',diagnostic:'FIXTURE_STOP'};
    return {job_status:'SUCCEEDED',pine_import_id:'source',source_version:1,result:{...analysis,proposal:{buy:'buy',exit:'sell',eligible_inputs:eligible(analysis),diagnostics:[]}}};
  };
  w.eval(await fs.readFile(new URL('../public/pine-bridge.js',import.meta.url),'utf8'));
  const el=id=>w.document.getElementById(id),flush=()=>new Promise(resolve=>setImmediate(resolve));
  el('pbLoadBots').click();await flush();
  el('pbSource').value=source;el('pbInspect').click();await flush();
  el('pbInputsConfirmed').click();el('pbAnalyze').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();
  return {w,el,flush,requests,analysis,selects:[...el('pbSlots').querySelectorAll('select')]};
}
function pick(w,selects,ids){selects.forEach((select,i)=>{if(ids[i]===undefined)return;select.value=ids[i];select.dispatchEvent(new w.Event('change'));});}
async function generate({w,el,flush,requests}){
  el('pbGenerate').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();
  const posts=requests.filter(r=>r.path.endsWith('/generate'));assert.equal(posts.length,1);
  assert.ok(posts[0].options.headers['Idempotency-Key']);
  return JSON.parse(posts[0].options.body);
}

test('Step 2 UI: filling all eight slot selects plus ATR 60 and RR 1.5 sends one generate POST that the server validator accepts',async()=>{
  const ctx=await mountWide(a=>a.inputs.map(i=>i.input_id)),{w,el,analysis,selects}=ctx;
  assert.equal(analysis.inputs.filter(i=>i.eligible).length,10);
  assert.equal(selects.length,8);
  assert.deepEqual(selects.map(s=>Number(s.dataset.slot)),[3,4,5,6,7,8,9,10]);
  for(const select of selects)assert.equal(select.options.length,11,'Unused plus all ten inputs');
  const ids=analysis.inputs.slice(0,8).map(i=>i.input_id);
  pick(w,selects,ids);
  for(const select of selects){
    for(const id of ids)assert.equal([...select.options].find(o=>o.value===id).disabled,id!==select.value);
    for(const id of analysis.inputs.slice(8).map(i=>i.input_id))assert.equal([...select.options].find(o=>o.value===id).disabled,false);
  }
  for(const input of el('pbSlots').querySelectorAll('input'))assert.equal(input.disabled,false);
  el('pbAtr').value='60';el('pbRR').value='1.5';
  const body=await generate(ctx);
  assert.equal(body.parameter_slots.length,8);
  assert.deepEqual(body.parameter_slots.map(s=>s.slot),[3,4,5,6,7,8,9,10]);
  assert.deepEqual(body.parameter_slots.map(s=>s.input_id),ids);
  analysis.inputs.slice(0,8).forEach((input,i)=>assert.deepEqual(body.parameter_slots[i],{slot:3+i,input_id:input.input_id,min:1,max:100,step:input.type==='int'?1:.1}));
  assert.deepEqual(body.bridge_options,{atr_multiplier:60,rr:1.5});
  assert.deepEqual(body.selected_signals,{buy:'buy',exit:'sell',timing:'bar_close'});
  const selection=validateSelection(analysis,body.selected_signals,body.parameter_slots,body.bridge_options);
  assert.equal(selection.bindings.length,8);assert.deepEqual(selection.bridge,{atr_multiplier:60,rr:1.5});
  w.close();
});

test('Step 2 UI: when the AI proposal omits eligible inputs, every slot pick list is reduced to the proposed ones and the omitted inputs stay fixed',async()=>{
  const kept=a=>a.inputs.slice(0,5).map(i=>i.input_id);
  const ctx=await mountWide(kept),{w,el,analysis,selects}=ctx;
  const keep=kept(analysis),omitted=analysis.inputs.slice(5).map(i=>i.input_id);
  assert.equal(analysis.inputs.filter(i=>i.eligible).length,10,'all ten inputs are eligible; the proposal alone reduces the list');
  assert.equal(selects.length,8);
  for(const select of selects){
    assert.deepEqual([...select.options].map(o=>o.value),['',...keep]);
    for(const id of omitted)assert.equal([...select.options].some(o=>o.value===id),false);
  }
  assert.equal(el('pbInputFields').querySelectorAll('[data-input-id]').length,10,'omitted inputs are still reviewed as fixed values');
  pick(w,selects,keep);
  const body=await generate(ctx);
  assert.deepEqual(body.parameter_slots.map(s=>s.slot),[3,4,5,6,7]);
  assert.deepEqual(body.parameter_slots.map(s=>s.input_id),keep);
  assert.equal(validateSelection(analysis,body.selected_signals,body.parameter_slots,body.bridge_options).bindings.length,5);
  w.close();
});


test('S4b browser label catalog stays equal to the production research catalog',async()=>{
 const script=await fs.readFile(new URL('../public/pine-bridge.js',import.meta.url),'utf8');
 const list=script.match(/const researchDimensions=new Set\((\[[^\]]+\])\)/)[1];
 const names=[...list.matchAll(/'([^']+)'/g)].map(match=>match[1]);
 assert.deepEqual(names.sort(),Object.keys(CATALOG).sort());
});

test('S4b supported source labels research dimensions and keeps other Bridge inputs selectable through language changes',async()=>{
 const source=['//@version=6','indicator("Catalog fixture")',...Object.entries(CATALOG).map(([name,limits])=>name+'=input.'+(limits[2]?'int':'float')+'('+(limits[2]?'10':'1.5')+', minval=1, maxval=100)'),
  'outside=input.int(10,minval=1,maxval=100)','buy=close>open','sell=close<open'].join('\n');
 const ctx=await mountWide(a=>a.inputs.map(i=>i.input_id),{source,sourceHash:SOURCE_HASH,i18n:true});
 const {w,el,analysis,selects,flush,requests}=ctx;
 try{
  for(const select of selects)for(const item of [...select.options].slice(1)){
   const input=analysis.inputs.find(i=>i.input_id===item.value);
   assert.match(item.textContent,input.pine_variable==='outside'?/Bridge only — research unsupported$/:/Research dimension supported$/);
  }
  assert.equal(el('pbSlotOmissions').hidden,true);
  const outside=analysis.inputs.find(i=>i.pine_variable==='outside');
  pick(w,selects,[outside.input_id]);assert.equal(selects[0].value,outside.input_id);
  const fields=[...el('pbSlots').querySelectorAll('input')];fields[0].value='2';
  const before={picks:selects.map(s=>s.value),values:fields.map(i=>i.value),disabled:fields.map(i=>i.disabled),requests:requests.length};
  el('language').value='th';el('language').dispatchEvent(new w.Event('change'));await flush();
  assert.match(selects[0].selectedOptions[0].textContent,/ใช้ได้เฉพาะ Bridge — ยังไม่รองรับการวิจัย$/);
  assert.match(selects[0].options[1].textContent,/รองรับมิติสำหรับวิจัย$/);
  el('language').value='en';el('language').dispatchEvent(new w.Event('change'));await flush();
  assert.match(selects[0].selectedOptions[0].textContent,/Bridge only — research unsupported$/);
  assert.deepEqual({picks:selects.map(s=>s.value),values:fields.map(i=>i.value),disabled:fields.map(i=>i.disabled),requests:requests.length},before);
 }finally{w.close();}
});

test('S4b unknown source retains Quant pending and reports omitted eligible inputs without adding them back',async()=>{
 const ctx=await mountWide(a=>a.inputs.slice(0,5).map(i=>i.input_id),{i18n:true});
 const {w,el,analysis,selects,flush}=ctx;
 try{
  assert.equal(el('pbSlotOmissions').hidden,false);
  assert.match(el('pbSlotOmissions').textContent,/AI proposal omitted 5 eligible numeric inputs/);
  for(const select of selects){
   assert.equal(select.options.length,6);
   for(const item of [...select.options].slice(1))assert.match(item.textContent,/Quant pending$/);
   for(const omitted of analysis.inputs.slice(5))assert.equal([...select.options].some(o=>o.value===omitted.input_id),false);
  }
  pick(w,selects,analysis.inputs.slice(0,5).map(i=>i.input_id));
  const before=selects.map(s=>s.value);
  el('language').value='th';el('language').dispatchEvent(new w.Event('change'));await flush();
  assert.match(el('pbSlotOmissions').textContent,/Input ตัวเลขที่เลือกได้ 5 รายการ/);
  assert.match(selects[0].selectedOptions[0].textContent,/Quant รอตรวจสอบ$/);
  assert.deepEqual(selects.map(s=>s.value),before);
  const body=await generate(ctx);assert.equal(body.parameter_slots.length,5);
 }finally{w.close();}
});
