const botText=(en,th)=>uiLanguage==='th'?th:en;
async function refreshBots(){
  if(!authenticated)return;
  try{const result=await api('/api/bots');botProfiles=result.bots;renderBots();}catch(error){$('#botMessage').textContent=error.message;}
}
function renderBots(){
  const current=selectedBot||me?.user?.id||botProfiles[0]?.id;
  $('#botSwitcher').innerHTML=botProfiles.map(bot=>`<option value="${esc(bot.id)}">${bot.bot_slot_index}. ${esc(bot.label)}</option>`).join('')+`<option value="all">${botText('All Bots','ทุก Bot')}</option>`;
  $('#botSwitcher').value=current;
  $('#botSlots').innerHTML=[1,2,3,4,5].map(slot=>{
    const bot=botProfiles.find(row=>row.bot_slot_index===slot);
    return bot?`<article class="panel bot-card"><small>Bot ${slot} · ${esc(bot.status)}</small><label>${botText('Label','ชื่อ Bot')}<input data-bot-label="${esc(bot.id)}" maxlength="80" value="${esc(bot.label)}"></label><div class="bot-actions"><button type="button" class="mini" data-bot-save="${esc(bot.id)}">${translate('Save')}</button><button type="button" class="mini" data-bot-copy="${esc(bot.id)}">${translate('Copy webhook')}</button><button type="button" class="mini" data-bot-open="${esc(bot.id)}">${botText('Open','เปิด')}</button></div></article>`:`<article class="panel bot-card"><small>Bot ${slot} · ${botText('Empty','ว่าง')}</small><p>${botText('Independent risk, balance and webhook','Risk, Balance และ Webhook แยกอิสระ')}</p><button type="button" class="primary" data-bot-create="${slot}">${botText('Create Sub-Bot','สร้าง Sub-Bot')}</button></article>`;
  }).join('');
  $('#botScopeNotice').textContent=selectedBot==='all'?botText('All Bots: overview and trade log only. Select a bot to edit settings.','ทุก Bot: ดูภาพรวมและประวัติ เลือก Bot ก่อนแก้การตั้งค่า'):botText('Settings and webhook apply to the selected bot.','การตั้งค่าและ Webhook เป็นของ Bot ที่เลือก');
}
async function switchBot(id){
  $('#app').inert=true;
  try{
    selectedBot=id;renderBots();await load();
    if(selectedBot==='all')document.querySelector('[data-view="overview"]').click();
    else if(!document.querySelector('[data-page="analytics"]').hidden)await loadAnalytics();
  }finally{$('#app').inert=false;}
}
$('#botSwitcher').onchange=event=>switchBot(event.target.value);
$('#botSlots').onclick=async event=>{
  const button=event.target.closest('button');if(!button)return;
  button.disabled=true;$('#botMessage').textContent='';
  try{
    if(button.dataset.botCreate){await api('/api/bots',{method:'POST',body:JSON.stringify({label:`Bot ${button.dataset.botCreate}`})});await refreshBots();}
    if(button.dataset.botSave){const id=button.dataset.botSave,label=document.querySelector(`[data-bot-label="${id}"]`).value;await api('/api/bots/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({label})});await refreshBots();}
    if(button.dataset.botOpen)await switchBot(button.dataset.botOpen);
    if(button.dataset.botCopy){
      const result=await api('/api/me/webhook-secret',{botId:button.dataset.botCopy});
      if(!result.urlPath)throw new Error(botText('Open this bot and create or recover its webhook in Account and License.','เปิด Bot แล้วสร้างหรือกู้คืน Webhook ในหน้าบัญชีและ License'));
      const url=location.origin+result.urlPath;
      try{await navigator.clipboard.writeText(url);$('#botMessage').textContent=translate('Copied');}
      catch{$('#botCopyFallback').hidden=false;$('#botCopyFallback').value=url;$('#botCopyFallback').select();}
    }
  }catch(error){$('#botMessage').textContent=error.message;}finally{button.disabled=false;}
};
document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',()=>{
  if(button.dataset.view==='bots')refreshBots();
  if(selectedBot==='all'&&!['bots','overview','signals'].includes(button.dataset.view)){
    $('#botMessage').textContent=translate('Select one bot for this operation');document.querySelector('[data-view="bots"]').click();
  }
}));
$('#language').addEventListener('change',renderBots);
const originalLoad=load;load=async function(){await originalLoad();if(authenticated)await refreshBots();};
if(authenticated)refreshBots();
