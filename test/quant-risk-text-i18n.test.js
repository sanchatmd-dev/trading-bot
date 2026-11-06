import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const serverSource=fs.readFileSync(new URL('../src/postgres/server.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
const thaiLetters=/[ก-๛]/;
// English duplicates that were already in uiPairs before this block. The last pair wins, so they are harmless; no new one may join them.
const KNOWN_DUPLICATE_ENGLISH=['Cash','Open positions','Order notional','User'];
// Kept in English on purpose; the block must not translate them.
const LEFT_ENGLISH=['Quant Lab','Total Equity','Stop Loss','InnovestX (THB)','Settrade (THB)'];
// Texts the server or quant-lab.js builds at run time; the exact-match translator sees them after they reach the page.
const DYNAMIC={
  'Historical analytics is unavailable while managed Quant execution is enabled.':[serverSource,"error:'Historical analytics is unavailable while managed Quant execution is enabled.'"],
  'Ready · OFFLINE_RESEARCH_ONLY':[publicFile('quant-lab.js'),'`Ready · ${health.mode}`'],
  'Synthetic research engine ready · OFFLINE_RESEARCH_ONLY. Data capability is checked separately.':[publicFile('quant-lab.js'),'Synthetic research engine ready · ${health.mode}. Data capability is checked separately.']
};
function setup(language){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'});
  if(language)dom.window.localStorage.setItem('robotLanguage',language);
  dom.window.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=quantRiskTextPairs;');
  return dom;
}
function staticTexts(dom){
  const found=new Set(),walker=dom.window.document.createTreeWalker(dom.window.document.body,4);
  let node;while((node=walker.nextNode())){const text=node.textContent.trim();if(text)found.add(text);}
  return found;
}

test('Quant Lab and Risk manager text pairs are complete, unique, collision-free and all used',()=>{
  const dom=setup();
  try{
    const mine=[...dom.window.__mine],all=[...dom.window.__pairs],others=all.filter(pair=>!mine.includes(pair));
    assert.ok(mine.length>=48);
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){
      assert.equal(typeof en,'string');assert.equal(typeof th,'string');
      assert.ok(en.trim()&&th.trim(),'empty pair: '+en);
      assert.ok(thaiLetters.test(th),'no Thai letters: '+en);
      assert.notEqual(en,th);
    }
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
    for(const text of LEFT_ENGLISH)assert.ok(!english.has(text),'must stay English: '+text);
    // Codes keep their Latin form inside the Thai text.
    for(const [en,th] of mine)if(en.includes('OFFLINE_RESEARCH_ONLY'))assert.ok(th.includes('OFFLINE_RESEARCH_ONLY'));
    // No new duplicate English key anywhere in uiPairs.
    const count=new Map();for(const [en] of all)count.set(en,(count.get(en)||0)+1);
    assert.deepEqual([...count].filter(entry=>entry[1]>1).map(entry=>entry[0]).sort(),KNOWN_DUPLICATE_ENGLISH);
    // Every pair still matches text the page or its scripts show.
    const shown=staticTexts(dom);
    for(const text of english){
      if(DYNAMIC[text])assert.ok(DYNAMIC[text][0].includes(DYNAMIC[text][1]),'dynamic text is no longer built: '+text);
      else assert.ok(shown.has(text),'pair for a text that is no longer shown: '+text);
    }
  }finally{dom.window.close();}
});

test('Thai mode translates the Quant Lab backtest and Risk manager labels and keeps the deliberate English terms',async()=>{
  const dom=setup('th'),d=dom.window.document;
  try{
    await settle();
    const quant=[...d.querySelectorAll('[data-page=quant] *')].flatMap(el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()));
    const risk=[...d.querySelectorAll('[data-page=risk] *')].flatMap(el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()));
    const mine=new Map(dom.window.__mine);
    for(const text of mine.keys()){
      if(DYNAMIC[text])continue;
      assert.ok(!quant.includes(text)&&!risk.includes(text),'still English in Thai mode: '+text);
    }
    for(const text of ['ดูตัวอย่าง Risk','ตัวกรองแนวโน้ม','รัน Backtest','ผล Backtest','รอการรัน','นโยบาย Risk ของ Bot','ตัวอย่างคำสั่ง (Order Preview)','เปอร์เซ็นต์ของ Equity','มูลค่าคำสั่งคงที่','ความเสี่ยงจากข่าว','โควตาการทำรายการรายวัน'])
      assert.ok(quant.includes(text)||risk.includes(text),'missing Thai text: '+text);
    assert.equal(d.querySelector('[data-page=quant] h2').textContent,'Quant Lab');
    for(const text of ['Total Equity','InnovestX (THB)','Settrade (THB)','Stop Loss'])assert.ok(risk.includes(text),'must stay English: '+text);
    // Back to English restores the original labels.
    const language=d.querySelector('#language');language.value='en';language.dispatchEvent(new dom.window.Event('change'));await settle();
    assert.equal(d.querySelector('[data-page=quant] h2').textContent,'Quant Lab');
    assert.ok([...d.querySelectorAll('[data-page=quant] button')].some(el=>el.textContent.trim()==='Run backtest'));
  }finally{dom.window.close();}
});

test('Run-time texts reach the page in English and the translator turns them into Thai',async()=>{
  const dom=setup('th'),d=dom.window.document;
  try{
    await settle();
    d.querySelector('#qlEngineStatus').textContent='Ready · OFFLINE_RESEARCH_ONLY';
    await settle();
    assert.equal(d.querySelector('#qlEngineStatus').textContent,'พร้อมใช้งาน · OFFLINE_RESEARCH_ONLY');
    const probe=d.createElement('p');probe.textContent='Synthetic research engine ready · OFFLINE_RESEARCH_ONLY. Data capability is checked separately.';
    d.querySelector('[data-page=quant]').append(probe);await settle();
    assert.ok(thaiLetters.test(probe.textContent)&&probe.textContent.includes('OFFLINE_RESEARCH_ONLY'));
    const notice=d.createElement('p');notice.textContent='Historical analytics is unavailable while managed Quant execution is enabled.';
    d.querySelector('[data-page=analytics]').append(notice);await settle();
    assert.ok(thaiLetters.test(notice.textContent));
  }finally{dom.window.close();}
});
