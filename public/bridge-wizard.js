/* Presentation layer of the guided Build Pine Bridge panel: step states, step motion and coach marks.
   It holds no data and makes no request; pine-bridge.js owns every value and works without this file
   (every step then simply stays readable). Text is set with textContent only. */
(() => {
  const T=text=>typeof translate==='function'?translate(text):text;
  const SEEN='pbCoachSeen',CHIP={locked:'Locked',current:'Current',done:'Done ✓'};
  const media=query=>{try{return typeof matchMedia==='function'&&matchMedia(query).matches===true;}catch{return false;}};
  // Dismissed coach marks are remembered per mark. Storage may be missing or blocked; the panel works without it.
  const readSeen=()=>{try{const list=JSON.parse(localStorage.getItem(SEEN)||'[]');return Array.isArray(list)?list.filter(item=>typeof item==='string').slice(0,40):[];}catch{return [];}};
  const writeSeen=seen=>{try{localStorage.setItem(SEEN,JSON.stringify([...seen].slice(-40)));}catch{}};

  function create(panel){
    const cards=[...panel.querySelectorAll('.pbw-step')],banner=panel.querySelector('#pbwNotice'),seen=new Set(readSeen());
    let openNo=0,bubble=null,current=null,bannerTimer=0,scrollTimer=0;
    const reduced=()=>media('(prefers-reduced-motion: reduce)');
    const part=(card,name)=>card.querySelector('.pbw-'+name);

    function showCard(card){
      if(card&&typeof card.scrollIntoView==='function')card.scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});
    }
    // Touch screens would open the keyboard for a text field; the step title takes focus there instead.
    function focusTo(target,card){
      const typing=!!target&&target.matches('input:not([type=checkbox]):not([type=radio]),textarea');
      const node=target&&!target.disabled&&!(typing&&media('(pointer: coarse)'))?target:card&&part(card,'title');
      try{node?.focus({preventScroll:true});}catch{}
    }

    function apply(view,{focus=true,scroll=true,force=false}={}){
      const before=openNo;
      panel.dataset.motion=reduced()?'reduced':'full';
      panel.classList.add('pbw-on');
      view.steps.forEach((info,index)=>{
        const card=cards[index];if(!card)return;
        const open=index+1===view.open,chip=part(card,'chip'),edit=part(card,'edit'),summary=part(card,'summary');
        card.dataset.state=info.state;card.classList.toggle('is-open',open);
        if(open)card.setAttribute('aria-current','step');else card.removeAttribute('aria-current');
        if(info.state==='locked')card.setAttribute('aria-disabled','true');else card.removeAttribute('aria-disabled');
        chip.dataset.uiLabel=CHIP[info.state];chip.textContent=T(CHIP[info.state]);
        part(card,'collapse').toggleAttribute('inert',!open);
        edit.hidden=!(info.state==='done'&&!open);
        if(info.edit)edit.setAttribute('aria-label',info.edit);
        summary.textContent=info.summary||'';summary.hidden=!(info.state==='done'&&!open&&info.summary);
        part(card,'help').hidden=info.state==='done'&&!open;
        part(card,'back').hidden=!(open&&view.open!==view.frontier);
      });
      openNo=view.open;
      if(panel.open&&((before!==0&&view.open!==before)||force)){
        const card=cards[view.open-1];
        if(focus)focusTo(view.focusEl,card);
        // The previous step needs about 180 ms to fold away; scrolling earlier would aim at a moving card.
        clearTimeout(scrollTimer);
        if(scroll){if(reduced())showCard(card);else scrollTimer=setTimeout(()=>showCard(card),300);}
      }
    }

    function reveal(card,target){clearTimeout(scrollTimer);showCard(card);focusTo(target,card);}

    function hide(){if(bubble)bubble.hidden=true;current=null;}
    function dismiss(){if(current){seen.add(current.id);writeSeen(seen);}hide();}
    function makeBubble(){
      const node=document.createElement('div'),text=document.createElement('span'),ok=document.createElement('button');
      node.className='pbw-coach';node.id='pbwCoach';node.hidden=true;node.setAttribute('aria-live','polite');
      text.className='pbw-coach-text';
      ok.type='button';ok.className='pbw-coach-ok ghost';ok.dataset.uiLabel='Got it';ok.textContent=T('Got it');
      ok.addEventListener('click',dismiss);
      node.append(text,ok);return node;
    }
    // One bubble is moved below the control the owner should use next. A remembered mark is never shown again.
    function coach(id,target,message,host){
      if(!target||!target.isConnected||seen.has(id)){hide();return false;}
      bubble??=makeBubble();
      const same=!!current&&current.id===id&&current.target===target;
      current={id,target};
      if(!same){
        (host||target.closest('label')||target).insertAdjacentElement('afterend',bubble);
        bubble.classList.remove('is-in');bubble.hidden=false;void bubble.offsetWidth;bubble.classList.add('is-in');
      }
      bubble.querySelector('.pbw-coach-text').textContent=message;bubble.hidden=false;
      return true;
    }
    // Capture phase: the mark is dismissed before the panel handlers react and move the next mark in.
    for(const type of ['input','change','click'])panel.addEventListener(type,event=>{if(current&&event.target===current.target)dismiss();},true);

    function pulse(node){
      if(!node||reduced())return;
      node.classList.remove('pbw-pulse');void node.offsetWidth;node.classList.add('pbw-pulse');
      setTimeout(()=>node.classList.remove('pbw-pulse'),1800);
    }

    function notice(text){
      if(!banner)return;
      banner.textContent=text;banner.hidden=false;
      clearTimeout(bannerTimer);bannerTimer=setTimeout(clearNotice,12000);
    }
    function clearNotice(){if(!banner)return;clearTimeout(bannerTimer);banner.hidden=true;banner.textContent='';}
    function resetTips(){seen.clear();writeSeen(seen);hide();}

    return {apply,reveal,focus:focusTo,coach,hideCoach:hide,coachId:()=>current?.id??null,pulse,notice,clearNotice,resetTips,reduced};
  }
  window.PbWizard={create};
})();
