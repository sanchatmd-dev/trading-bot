/* Research jump bar: one row at the top of Quant Lab that opens each research workspace in place.
   It only opens details panels and scrolls; it makes no request and changes no setting. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const T=text=>typeof translate==='function'?translate(text):text;
  const make=(tag,cls,...children)=>{const node=document.createElement(tag);if(cls)node.className=cls;node.append(...children);return node;};
  const label=(text,tag='span',cls)=>{const node=make(tag,cls);node.dataset.uiLabel=text;node.textContent=T(text);return node;};
  // Each target opens with the reveal event its own panel handles; without a handler the panel scrolls into view.
  const TARGETS=[['pbPanel','pb:reveal','Build Pine Bridge'],['qrjPanel','qrj:reveal','Research job'],['qrlPanel','qrl:reveal','Research Library'],[null,null,'Backtest and legacy tools']];
  const bar=make('nav','rnav');bar.id='researchNav';bar.setAttribute('aria-label',T('Research sections'));
  bar.append(label('Go to','span','rnav-label'));
  for(const [id,event,text] of TARGETS){
    const button=label(text,'button','ghost rnav-go');button.type='button';button.dataset.target=id||'legacy';
    bar.append(button);
  }
  host.prepend(bar);
  bar.addEventListener('click',clickEvent=>{
    const button=clickEvent.target.closest('.rnav-go');if(!button)return;
    const entry=TARGETS.find(([id])=>(id||'legacy')===button.dataset.target);
    if(!entry[0]){host.querySelector('.ql-shell')?.scrollIntoView?.({block:'start'});return;}
    const panel=document.getElementById(entry[0]);if(!panel)return;
    panel.open=true;
    const handled=!panel.dispatchEvent(new CustomEvent(entry[1],{cancelable:true}));
    if(!handled)panel.scrollIntoView?.({block:'start'});
  });
  document.getElementById('language')?.addEventListener('change',()=>bar.setAttribute('aria-label',T('Research sections')));
})();