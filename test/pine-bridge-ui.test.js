import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {inspectSource} from '../src/pine-bridge/source.js';

test('Bridge dropdown binds up to eight unique numeric slots, preserves errors as text, clears source on logout',async()=>{
  const dom=new JSDOM('<button id="logout"></button><section data-page="quant"></section>',{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window,source='//@version=6\nindicator("Fixture")\na=input.int(2)\nb=input.float(3)\nbuy=close>open\nsell=close<open';
  const analysis=inspectSource(source);const requests=[];
  w.URL.revokeObjectURL=()=>{};
  w.api=async(path,options)=>{
    requests.push({path,options});
    if(path==='/api/bots')return {bots:[{id:'mine',label:'<img src=x onerror=alert(1)>'}]};
    if(path.endsWith('/analyze'))return {job_id:'fixture'};
    return {job_status:'SUCCEEDED',pine_import_id:'source',result:{...analysis,proposal:{buy:'buy',exit:'sell',eligible_inputs:analysis.inputs.map(i=>i.input_id),diagnostics:['<script>injection</script>']}}};
  };
  w.eval(await fs.readFile(new URL('../public/pine-bridge.js',import.meta.url),'utf8'));
  const el=id=>w.document.getElementById(id),flush=()=>new Promise(resolve=>setImmediate(resolve));
  el('pbLoadBots').click();await flush();assert.equal(el('pbBot').value,'mine');assert.equal(w.document.querySelectorAll('img').length,0);
  el('pbSource').value=source;el('pbAnalyze').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();
  const selects=[...el('pbSlots').querySelectorAll('select')];assert.equal(selects.length,8);
  selects[0].value=analysis.inputs[0].input_id;selects[0].dispatchEvent(new w.Event('change'));
  assert.equal([...selects[1].options].find(o=>o.value===analysis.inputs[0].input_id).disabled,true);
  assert.equal(w.document.querySelectorAll('script').length,0);assert.match(el('pbDiagnostics').textContent,/injection/);
  assert.ok(requests.find(r=>r.path.endsWith('/analyze')).options.headers['Idempotency-Key']);
  el('logout').click();assert.equal(el('pbSource').value,'');assert.equal(el('pbDiagnostics').textContent,'');assert.equal(el('pbGenerate').hidden,true);
  w.close();
});
