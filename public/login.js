const loginPassword=document.querySelector('#password');
const showLoginPassword=document.querySelector('#showLoginPassword');
showLoginPassword.addEventListener('change',()=>{
  loginPassword.type=showLoginPassword.checked?'text':'password';
  loginPassword.focus();
});
