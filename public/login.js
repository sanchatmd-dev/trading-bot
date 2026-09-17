const loginPassword=document.querySelector('#password');
const showLoginPassword=document.querySelector('#showLoginPassword');
showLoginPassword.addEventListener('change',()=>{
  loginPassword.type=showLoginPassword.checked?'text':'password';
  loginPassword.focus();
});
const mobileNavToggle=document.querySelector('#mobileNavToggle');
const primaryNav=document.querySelector('#primaryNav');
function setMobileNav(open){
  primaryNav.classList.toggle('mobile-open',open);
  mobileNavToggle.setAttribute('aria-expanded',String(open));
  mobileNavToggle.textContent=translate(open?'Close menu':'Menu');
}
mobileNavToggle.addEventListener('click',()=>setMobileNav(mobileNavToggle.getAttribute('aria-expanded')!=='true'));
primaryNav.addEventListener('click',event=>{if(event.target.closest('button'))setMobileNav(false);});
