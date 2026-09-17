let mfaChallenge=false;
const securityText=(en,th)=>uiLanguage==='th'?th:en;
const securityPanel=document.createElement('article');
securityPanel.className='panel';securityPanel.id='securityPanel';
document.querySelector('[data-page="account"]').prepend(securityPanel);
function renderSecurity(){
  const state=me?.security;if(!state)return;
  if($('#mfaSetupSecret')?.value||$('#mfaRecoveryCodes')?.textContent)return;
  securityPanel.innerHTML=`<h2>${securityText('Account security','ความปลอดภัยบัญชี')}</h2>
    <p>${state.mfaEnabled?securityText('Two-factor authentication is enabled.','เปิดใช้การยืนยันตัวตนสองขั้นตอนแล้ว'):state.mfaEnrollmentRequired?securityText('Set up two-factor authentication to use administrator controls.','ตั้งค่าการยืนยันตัวตนสองขั้นตอนก่อนใช้คำสั่งผู้ดูแล'):securityText('Protect your account with an authenticator app.','ปกป้องบัญชีด้วยแอป Authenticator')}</p>
    <button type="button" id="verifyIdentity" class="ghost">${securityText('Confirm identity','ยืนยันตัวตน')}</button>
    ${!state.mfaEnabled?`<form id="mfaSetupForm"><label>${translate('Current password')}<input id="mfaSetupPassword" type="password" autocomplete="current-password" required></label><button class="primary">${securityText('Set up authenticator','ตั้งค่า Authenticator')}</button></form><div id="mfaSetupDetails" hidden><label>${securityText('Enter this key in your authenticator app','เพิ่มรหัสนี้ในแอป Authenticator')}<input id="mfaSetupSecret" readonly autocomplete="off"></label><form id="mfaEnableForm"><label>${securityText('6-digit code','รหัส 6 หลัก')}<input id="mfaEnableCode" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required></label><button class="primary">${securityText('Enable two-factor authentication','เปิดใช้การยืนยันสองขั้นตอน')}</button></form></div>`:`<p>${securityText('Recovery codes remaining','รหัสกู้คืนคงเหลือ')}: ${state.recoveryCodesRemaining}</p>${!state.mfaRequired?`<form id="mfaDisableForm"><label>${translate('Current password')}<input id="mfaDisablePassword" type="password" autocomplete="current-password" required></label><label>${securityText('Authenticator or recovery code','รหัส Authenticator หรือรหัสกู้คืน')}<input id="mfaDisableCode" autocomplete="one-time-code" required></label><button class="ghost">${securityText('Disable two-factor authentication','ปิดการยืนยันสองขั้นตอน')}</button></form>`:''}`}
    <div id="recoveryCodesPanel" hidden><p>${securityText('Save these recovery codes securely. Each works once. They will not be shown again.','เก็บรหัสกู้คืนในที่ปลอดภัย แต่ละรหัสใช้ได้ครั้งเดียว ระบบจะไม่แสดงซ้ำ')}</p><pre id="mfaRecoveryCodes"></pre><button type="button" id="dismissRecoveryCodes" class="ghost">${securityText('I saved the codes','เก็บรหัสแล้ว')}</button></div><p id="securityMessage" role="status"></p>`;
  $('#verifyIdentity').onclick=()=>openStepUp();
  $('#mfaSetupForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/auth/mfa/setup',{method:'POST',body:JSON.stringify({password:$('#mfaSetupPassword').value})});$('#mfaSetupPassword').value='';$('#mfaSetupSecret').value=d.secret;$('#mfaSetupDetails').hidden=false;}catch(error){$('#securityMessage').textContent=error.message;}});
  $('#mfaEnableForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/auth/mfa/enable',{method:'POST',body:JSON.stringify({code:$('#mfaEnableCode').value})});csrfToken=d.csrfToken;me.security=d.security;$('#mfaSetupSecret').value='';renderSecurity();$('#recoveryCodesPanel').hidden=false;$('#mfaRecoveryCodes').textContent=d.recoveryCodes.join('\n');await load();}catch(error){$('#securityMessage').textContent=error.message;}});
  $('#dismissRecoveryCodes').onclick=()=>{$('#mfaRecoveryCodes').textContent='';renderSecurity();};
  $('#mfaDisableForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/auth/mfa/disable',{method:'POST',body:JSON.stringify({password:$('#mfaDisablePassword').value,code:$('#mfaDisableCode').value})});csrfToken=d.csrfToken;await load();}catch(error){$('#securityMessage').textContent=error.message;}});
}
const stepDialog=document.createElement('dialog');stepDialog.id='stepUpDialog';
stepDialog.setAttribute('aria-labelledby','stepHeading');
stepDialog.innerHTML='<h2 id="stepHeading">Confirm identity</h2><p>After confirmation, retry your action.</p><form id="stepUpForm"><label>Password<input id="stepPassword" type="password" autocomplete="current-password" required></label><label>Authenticator or recovery code<input id="stepCode" autocomplete="one-time-code"></label><button class="primary">Confirm</button><p id="stepMessage" role="alert"></p></form><form method="dialog"><button class="ghost">Close</button></form>';
document.body.append(stepDialog);
function openStepUp(){if(!stepDialog.open){$('#stepMessage').textContent='';stepDialog.showModal();}}
stepDialog.addEventListener('close',()=>{$('#stepPassword').value='';$('#stepCode').value='';});
$('#stepUpForm').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/auth/step-up',{method:'POST',body:JSON.stringify({password:$('#stepPassword').value,code:$('#stepCode').value})});csrfToken=d.csrfToken;stepDialog.close();me.security=d.security;$('#securityMessage').textContent=securityText('Identity confirmed. Retry your action.','ยืนยันตัวตนแล้ว กรุณาทำรายการอีกครั้ง');}catch(error){$('#stepMessage').textContent=error.message;}};
$('#login').insertAdjacentHTML('beforeend','<form id="mfaLoginForm" hidden><label>Authenticator or recovery code<input id="mfaLoginCode" autocomplete="one-time-code" required></label><button class="primary">Verify</button><button id="restartLogin" class="ghost" type="button">Back to sign in</button></form>');
function showMfaLogin(){mfaChallenge=true;$('#mfaLoginForm').hidden=false;$('#loginBtn').hidden=true;$('#password').value='';$('#mfaLoginCode').focus();}
$('#restartLogin').onclick=()=>{mfaChallenge=false;$('#mfaLoginForm').hidden=true;$('#loginBtn').hidden=false;$('#mfaLoginCode').value='';};
$('#mfaLoginForm').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/auth/mfa/login',{method:'POST',body:JSON.stringify({code:$('#mfaLoginCode').value})});csrfToken=d.csrfToken;authenticated=true;$('#mfaLoginCode').value='';$('#restartLogin').click();await load();}catch(error){$('#loginError').textContent=error.message;}};

const recoveryDialog=$('#recoveryDialog');
recoveryDialog.insertAdjacentHTML('beforeend','<form id="forgotForm" hidden><label>Email<input id="recoveryEmail" type="email" autocomplete="email" required></label><button class="primary">Send recovery link</button></form><form id="resetForm" hidden><label>New password (10+ characters)<input id="resetNewPassword" type="password" autocomplete="new-password" minlength="10" maxlength="256" required></label><label>Authenticator or recovery code<input id="resetCode" autocomplete="one-time-code"></label><button class="primary">Reset password</button></form><p id="recoveryMessage" role="status"></p>');
let resetToken='';
const resetMatch=location.hash.match(/^#reset=([a-f0-9]{64})$/);
if(resetMatch){resetToken=resetMatch[1];history.replaceState(null,'',location.pathname+location.search);$('#resetForm').hidden=false;recoveryDialog.showModal();}
recoveryDialog.addEventListener('close',()=>{$('#resetNewPassword').value='';$('#resetCode').value='';});
$('#forgotForm').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/auth/forgot-password',{method:'POST',body:JSON.stringify({email:$('#recoveryEmail').value})});$('#recoveryMessage').textContent=translate(d.message);}catch(error){$('#recoveryMessage').textContent=error.message;}};
$('#resetForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/auth/reset-password',{method:'POST',body:JSON.stringify({token:resetToken,newPassword:$('#resetNewPassword').value,code:$('#resetCode').value})});resetToken='';$('#resetForm').reset();$('#resetForm').hidden=true;$('#recoveryMessage').textContent=translate('Password reset. Sign in with your new password.');authenticated=false;csrfToken='';$('#app').hidden=true;$('#login').hidden=false;$('#logout').hidden=true;}catch(error){$('#recoveryMessage').textContent=error.message;}};
$('#language').addEventListener('change',renderSecurity);
async function initializeAuth(){
  // Remove credentials left by older clients; the new session exists only in HttpOnly cookies.
  try{sessionStorage.removeItem('astraV2Token');}catch{}
  try{
    const options=await api('/api/auth/config');$('#forgotForm').hidden=!options.emailRecovery||!!resetToken;
    if(options.emailRecovery){recoveryDialog.querySelectorAll('p:not(#recoveryMessage)').forEach(p=>p.hidden=true);}
    const d=await api('/api/auth/session');
    if(d.authenticated){csrfToken=d.csrfToken;authenticated=true;await load();}
  }catch(error){$('#loginError').textContent=error.message;}
}
initializeAuth();

function applyAdminPermissions(){
  const granted=new Set(me?.security?.permissions||[]),write=granted.has('users:write');
  $('#createUserForm').hidden=!write;$('#createLicenseForm').hidden=!granted.has('licenses:write');
  $('#globalKillToggle').hidden=!granted.has('trading:pause');
  $('#licenseRows').closest('article').hidden=!granted.has('licenses:read');
  $('#licenseCount').closest('article').hidden=!granted.has('licenses:read');
  document.querySelectorAll('.user-status').forEach(button=>button.hidden=!write);
  if(write)document.querySelectorAll('#userRows tr').forEach((row,index)=>{
    const user=users[index];if(user.id===me.user.id)return;
    const select=document.createElement('select');select.setAttribute('aria-label',securityText('Role','สิทธิ์'));
    for(const role of ['USER','SUPPORT','ADMIN']){const option=document.createElement('option');option.value=role;option.textContent=role;select.append(option);}select.value=user.role;
    select.onchange=async()=>{try{await api('/api/admin/users/'+encodeURIComponent(user.id)+'/role',{method:'PUT',body:JSON.stringify({role:select.value})});await load();}catch(error){$('#userMessage').textContent=error.message;select.value=user.role;}};
    row.children[1].replaceChildren(select);
  });
}

const adminStatus=document.createElement('p');adminStatus.id='adminStatus';adminStatus.setAttribute('role','status');
document.querySelector('[data-page="admin"]').prepend(adminStatus);
$('#adminNav').addEventListener('click',async()=>{try{await loadAdmin();adminStatus.textContent='';}catch(error){$('#userRows').replaceChildren();$('#licenseRows').replaceChildren();adminStatus.textContent=error.message;}});
