import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const file=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
async function fixture({authenticated=true,hash=''}={}){
  const dom=new JSDOM(file('index.html'),{url:'https://robot.test/'+hash,runScripts:'outside-only'}),w=dom.window,calls=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.sessionStorage.setItem('astraV2Token','obsolete-bearer-token');
  w.testAccount={user:{id:'owner',role:'USER'},security:{mfaEnabled:false,mfaRequired:false,mfaEnrollmentRequired:false,permissions:['own:read','own:write'],recoveryCodesRemaining:0}};
  let respond=()=>({ok:true});
  w.fetch=async(path,options={})=>{
    calls.push({path,options});
    const body=path==='/api/auth/config'?{emailRecovery:true}:path==='/api/auth/session'?{authenticated,csrfToken:'csrf-fixture'}:respond(path,options);
    return {ok:true,json:async()=>body};
  };
  // Exercise the real auth UI and API wrapper; unrelated trading renderers use a fixture.
  w.eval(file('i18n.js')+'\n'+file('app.js')+'\nload=async()=>{me=window.testAccount;renderSecurity();};\n'+file('security-ui.js'));
  await settle();
  return {w,d:w.document,calls,respond:fn=>respond=fn,close:()=>w.close()};
}

test('login password permits typing, deletion, shortcuts and IME without cancelling native input',async()=>{
  const f=await fixture({authenticated:false}),{w,d,calls}=f;
  try{
    const password=d.querySelector('#password');
    const before=calls.length;
    for(const options of [
      {key:'a'},{key:'A',shiftKey:true},{key:'Backspace'},{key:'Delete'},
      {key:'ArrowLeft'},{key:'ArrowRight'},{key:'Tab'},
      {key:'v',ctrlKey:true},{key:'a',metaKey:true},
      {key:'Unidentified',keyCode:229},{key:'Enter',isComposing:true},
      {key:'Enter',keyCode:229},{key:'Enter',repeat:true}
    ]){
      const event=new w.KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options});
      assert.equal(password.dispatchEvent(event),true,JSON.stringify(options));
      assert.equal(event.defaultPrevented,false,JSON.stringify(options));
    }
    assert.equal(calls.length,before,'Editing and composition must not submit login');
    d.querySelector('#email').value='owner@example.test';
    password.value='test-password';
    f.respond(()=>({mfaRequired:true}));
    const enter=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
    password.dispatchEvent(enter);
    await settle();
    assert.equal(enter.defaultPrevented,true);
    const logins=calls.filter(call=>call.path==='/api/auth/login');
    assert.equal(logins.length,1);
    assert.equal(JSON.parse(logins[0].options.body).password,'test-password');
    assert.equal(d.querySelector('#mfaLoginForm').hidden,false);
  }finally{f.close();}
});

test('security UI restores cookie session, enrolls MFA, shows recovery codes once and sends CSRF without bearer storage',async()=>{
  const f=await fixture(),{w,d,calls}=f;
  try{
    assert.equal(w.sessionStorage.getItem('astraV2Token'),null);
    assert.match(d.querySelector('#securityPanel').textContent,/Account security/);
    f.respond(path=>{
      if(path==='/api/auth/mfa/setup')return {secret:'TESTKEYFORAUTHENTICATOR'};
      if(path==='/api/auth/mfa/enable'){
        w.testAccount.security={...w.testAccount.security,mfaEnabled:true,recoveryCodesRemaining:10};
        return {csrfToken:'rotated-csrf',security:w.testAccount.security,recoveryCodes:['TEST-RECOVERY-ONE','TEST-RECOVERY-TWO']};
      }
      return {ok:true};
    });
    d.querySelector('#mfaSetupPassword').value='test-password';
    d.querySelector('#mfaSetupForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
    assert.equal(d.querySelector('#mfaSetupPassword').value,'');
    assert.equal(d.querySelector('#mfaSetupSecret').value,'TESTKEYFORAUTHENTICATOR');
    d.querySelector('#mfaEnableCode').value='123456';
    d.querySelector('#mfaEnableForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
    assert.match(d.querySelector('#mfaRecoveryCodes').textContent,/TEST-RECOVERY-ONE/);
    assert.equal(d.querySelector('#recoveryCodesPanel').hidden,false);
    d.querySelector('#dismissRecoveryCodes').click();
    assert.equal(d.querySelector('#mfaRecoveryCodes').textContent,'');
    const language=d.querySelector('#language');language.value='th';language.dispatchEvent(new w.Event('change'));await settle();
    assert.match(d.querySelector('#securityPanel').textContent,/ความปลอดภัยบัญชี/);
    await w.api('/api/risk',{method:'PUT',body:'{}'});
    assert.equal(calls.at(-1).options.headers['x-csrf-token'],'rotated-csrf');
    for(const call of calls){assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.headers.authorization,undefined);}
    for(const storage of [w.sessionStorage,w.localStorage])for(let i=0;i<storage.length;i++)assert.doesNotMatch(storage.getItem(storage.key(i)),/TEST-RECOVERY|csrf|bearer|test-password/);
  }finally{f.close();}
});

test('security UI completes MFA login and step-up without replaying a write or discarding unsaved input',async()=>{
  const f=await fixture({authenticated:false}),{w,d,calls}=f;
  try{
    f.respond(path=>path==='/api/auth/login'?{mfaRequired:true}:path==='/api/auth/mfa/login'||path==='/api/auth/step-up'?{csrfToken:'verified-csrf',security:w.testAccount.security}:{ok:true});
    d.querySelector('#email').value='owner@example.test';d.querySelector('#password').value='test-password';
    await w.login();assert.equal(d.querySelector('#mfaLoginForm').hidden,false);assert.equal(d.querySelector('#password').value,'');
    const count=calls.length;await w.login();assert.equal(calls.length,count,'Enter must not resend a password during MFA');
    d.querySelector('#mfaLoginCode').value='RECOVERY-CODE';await d.querySelector('#mfaLoginForm').onsubmit({preventDefault(){}});
    assert.equal(d.querySelector('#mfaLoginForm').hidden,true);assert.equal(d.querySelector('#mfaLoginCode').value,'');
    d.querySelector('[name=maxRiskPercent]').value='37';w.openStepUp();
    d.querySelector('#stepPassword').value='test-password';d.querySelector('#stepCode').value='123456';
    await d.querySelector('#stepUpForm').onsubmit({preventDefault(){}});
    assert.equal(d.querySelector('#stepUpDialog').open,false);assert.equal(d.querySelector('#stepPassword').value,'');
    assert.equal(d.querySelector('[name=maxRiskPercent]').value,'37');
    assert.match(d.querySelector('#securityMessage').textContent,/Retry your action/);
    assert.equal(calls.filter(c=>c.path==='/api/risk').length,0);
  }finally{f.close();}
});

test('recovery UI removes reset token from URL, submits it only to reset API and clears sensitive inputs',async()=>{
  const token='b'.repeat(64),f=await fixture({authenticated:false,hash:'#reset='+token}),{w,d,calls}=f;
  try{
    assert.equal(w.location.hash,'');assert.equal(d.querySelector('#recoveryDialog').open,true);
    assert.equal(d.querySelector('#forgotForm').hidden,true);assert.equal(d.querySelector('#resetForm').hidden,false);
    assert.equal(calls.some(c=>c.path.includes(token)),false);
    d.querySelector('#resetNewPassword').value='new-test-password';d.querySelector('#resetCode').value='RECOVERY-CODE';
    await d.querySelector('#resetForm').onsubmit({preventDefault(){}});
    const call=calls.at(-1);assert.equal(call.path,'/api/auth/reset-password');assert.equal(JSON.parse(call.options.body).token,token);
    assert.equal(d.querySelector('#resetNewPassword').value,'');assert.equal(d.querySelector('#resetForm').hidden,true);
    assert.match(d.querySelector('#recoveryMessage').textContent,/Password reset/);
    assert.equal(w.sessionStorage.length,0);
  }finally{f.close();}
});

test('Support UI hides administrative write and license controls',async()=>{
  const f=await fixture(),{w,d}=f;
  try{
    w.testAccount.security.permissions=['own:read','own:write','users:read','operations:read'];
    d.querySelector('#userRows').innerHTML='<tr><td>user@example.test</td><td>USER</td><td><button class="user-status">Toggle</button></td></tr>';
    w.applyAdminPermissions();
    for(const id of ['createUserForm','createLicenseForm','globalKillToggle'])assert.equal(d.querySelector('#'+id).hidden,true,id);
    assert.equal(d.querySelector('.user-status').hidden,true);
    assert.equal(d.querySelector('#licenseRows').closest('article').hidden,true);
  }finally{f.close();}
});
