import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
const HOSTILE='<img src=x onerror="alert(1)"> & "q"';

// quant-lab.js keeps qIndicators in a script-level binding; the helper reaches it from inside the same evaluation.
function page(handler=()=>({})){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  const calls=[];
  w.api=async(path,options={})=>{calls.push(path);return handler(path,options);};
  w.eval(publicFile('quant-lab.js')+'\nwindow.__indicators=value=>{if(value)qIndicators=value;qRenderIndicators();return qIndicators;};');
  const list=d.getElementById('qlIndicatorsList');
  return {dom,w,d,calls,list};
}

test('Indicator remove and Min/Max edits work through delegated listeners, with no inline handler attributes',()=>{
  const p=page();
  try{
    assert.equal(p.list.querySelectorAll('[onclick],[onchange],[oninput]').length,0);
    assert.equal(p.list.querySelectorAll('fieldset').length,1);
    assert.equal(p.list.querySelector('legend').textContent,'Indicator 1: SyntheticEma X');
    const min=p.list.querySelector('input[data-ql-param="0:0:min"]');
    assert.equal(min.value,'5');assert.equal(min.disabled,false);assert.equal(min.parentElement.textContent,'ema_fast Min ');
    min.value='7';min.dispatchEvent(new p.w.Event('change',{bubbles:true}));
    p.d.getElementById('qlAddIndicator').click();
    assert.equal(p.list.querySelectorAll('fieldset').length,2);
    assert.equal(p.list.querySelector('input[data-ql-param="0:0:min"]').value,'7','the edit reached qIndicators and survives a redraw');
    assert.equal(p.list.querySelector('input[data-ql-param="0:0:min"]').disabled,true,'two indicators lock the bounds as before');
    assert.equal(p.d.getElementById('qlOptModeLabel').textContent,'Multi-Indicator (Locked)');
    p.list.querySelectorAll('[data-ql-remove]')[1].click();
    assert.equal(p.list.querySelectorAll('fieldset').length,1);
    assert.equal(p.d.getElementById('qlOptModeLabel').textContent,'Single Indicator (Optimizable)');
  }finally{p.w.close();}
});

test('Indicator and parameter names with <, " and & render as text',()=>{
  const p=page();
  try{
    p.w.__indicators([{name:HOSTILE,params:[{name:HOSTILE,min:1,max:2}]}]);
    assert.equal(p.list.querySelectorAll('img').length,0);
    assert.equal(p.list.querySelector('legend').firstChild.textContent,'Indicator 1: '+HOSTILE+' ');
    assert.equal(p.list.querySelector('label').firstChild.textContent,HOSTILE+' Min ');
  }finally{p.w.close();}
});

test('Bot labels, optimizer results and risk rules from the server render as text',async()=>{
  const p=page(path=>{
    if(path==='/api/quant/health')return {mode:'synthetic'};
    if(path==='/api/bots')return {bots:[{id:'bot-1',label:HOSTILE}]};
    if(path.startsWith('/api/quant/runs'))return {runs:[]};
    return {};
  });
  try{
    p.d.querySelector('nav button[data-view="quant"]').click();await settle();
    const option=p.d.querySelector('#qlOptBotId option');
    assert.equal(option.textContent,HOSTILE);assert.equal(option.value,'bot-1');assert.equal(p.d.querySelectorAll('#qlOptBotId img').length,0);
    p.w.qShowOptimizer({best:{params:{[HOSTILE]:1},train_score:1,validation_score:1,test_score:1},
      candidates:[{params:{[HOSTILE]:2},status:'<b>bad</b>',train_score:1,validation_score:1,test_score:1}],dataset_split:{train_end:'<u>1</u>',validation_end:2,test_end:3}});
    const results=p.d.getElementById('qlOptResults');
    assert.equal(results.querySelectorAll('img,b,u').length,0);
    assert.ok(results.querySelector('.ql-best-params pre').textContent.includes(HOSTILE.replaceAll('"','\\"')));
    assert.equal(results.querySelector('tbody .ql-candidate-status').textContent,'<b>bad</b>');
    assert.equal(results.querySelector('.ql-split-info strong').textContent,'<u>1</u>');
    p.w.qShowRisk({active_limiting_rules:['<i>MAX_ORDER</i>']});
    const rules=p.d.getElementById('qlRiskConstraints');
    assert.equal(rules.querySelectorAll('i').length,0);assert.equal(rules.querySelector('.ql-pill').textContent,'<i>MAX_ORDER</i>');
  }finally{p.w.close();}
});

test('No page ships an inline event handler attribute the production CSP would block',()=>{
  for(const name of fs.readdirSync(new URL('../public/',import.meta.url)).filter(file=>/\.(js|html)$/.test(file)))
    assert.doesNotMatch(publicFile(name),/<[a-z][^<>]*\son[a-z]+\s*=/i,name+' has an inline on* attribute; script-src \'self\' blocks it');
  assert.ok(publicFile('bots.js').includes('<span class="state-badge ${stateClass}">${esc(stateLabel)}</span>'),'the session state label is escaped');
});