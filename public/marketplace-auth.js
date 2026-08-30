let authMode='login';
let authIntent=null;

function decodeToken(token){
 try{
  let part=token.split('.')[1]
   .replace(/-/g,'+')
   .replace(/_/g,'/');

  while(part.length%4){
   part+='=';
  }

  return JSON.parse(atob(part));
 }catch{
  return null;
 }
}

function customerToken(){
 const token=localStorage.getItem('token');
 if(!token)return null;

 const payload=decodeToken(token);

 /*
  * Marketplace dan halaman customer menggunakan
  * localStorage.token sebagai sumber sesi yang sama.
  *
  * Jika JWT berhasil dibaca dan ternyata bukan
  * CUSTOMER, jangan perlakukan sebagai sesi customer.
  *
  * Jika browser gagal decode base64url lokal,
  * jangan membuang sesi yang sebenarnya masih valid.
  * API tetap menjadi otoritas final atas token.
  */
 if(
  payload &&
  Number(payload.role_id)!==1
 ){
  return null;
 }

 return token;
}

function ensureAuthModal(){
 if(document.getElementById('authOverlay'))return;

 document.body.insertAdjacentHTML('beforeend',`
 <div id="authOverlay" class="auth-overlay"
      onclick="authOverlayClick(event)">
  <section class="auth-card">
   <div class="auth-head">
    <div class="auth-brand">
     <img src="/logo-pasar-pintar.jpg" alt="">
     <div>
      <strong>Pasar Pintar</strong>
      <small>Belanja kebutuhan pasar</small>
     </div>
    </div>
    <button class="auth-close" type="button"
            onclick="closeAuthModal()">×</button>
   </div>

   <div class="auth-tabs">
    <button id="authTabLogin" class="auth-tab active"
            onclick="showAuthMode('login')">Masuk</button>
    <button id="authTabRegister" class="auth-tab"
            onclick="showAuthMode('register')">Daftar</button>
   </div>

   <div class="auth-body">
    <div id="authLogin">
     <h2 class="auth-title">Masuk</h2>
     <p class="auth-subtitle">
      Masuk tanpa meninggalkan halaman belanja.
     </p>
     <div class="auth-field">
      <label>Username</label>
      <input id="authUsername" autocomplete="username">
     </div>
     <div class="auth-field">
      <label>Password</label>
      <input id="authPassword" type="password"
             autocomplete="current-password">
     </div>
     <button id="authLoginButton" class="auth-submit"
             onclick="submitCustomerLogin()">
      Masuk ke Pasar Pintar
     </button>
     <div id="authLoginMessage" class="auth-message"></div>
     <div class="auth-switch">
      Belum punya akun?
      <button onclick="showAuthMode('register')">Daftar</button>
     </div>
    </div>

    <div id="authRegister" hidden>
     <h2 class="auth-title">Buat akun</h2>
     <p class="auth-subtitle">
      Daftar sebagai pelanggan Pasar Pintar.
     </p>
     <div class="auth-field">
      <label>Nama lengkap</label>
      <input id="regName" autocomplete="name">
     </div>
     <div class="auth-field">
      <label>Nomor WhatsApp</label>
      <input id="regPhone" inputmode="tel" autocomplete="tel">
     </div>
     <div class="auth-field">
      <label>Email</label>
      <input id="regEmail" type="email" autocomplete="email">
     </div>
     <div class="auth-field">
      <label>Username</label>
      <input id="regUsername" autocomplete="username">
     </div>
     <div class="auth-field">
      <label>Password</label>
      <input id="regPassword" type="password"
             minlength="8" autocomplete="new-password">
     </div>
     <button id="authRegisterButton" class="auth-submit"
             onclick="submitCustomerRegister()">
      Daftar
     </button>
     <div id="authRegisterMessage" class="auth-message"></div>
     <div class="auth-switch">
      Sudah punya akun?
      <button onclick="showAuthMode('login')">Masuk</button>
     </div>
    </div>
   </div>
  </section>
 </div>`);
}

function showAuthMode(mode){
 authMode=mode;
 document.getElementById('authLogin').hidden=mode!=='login';
 document.getElementById('authRegister').hidden=mode!=='register';
 document.getElementById('authTabLogin')
  .classList.toggle('active',mode==='login');
 document.getElementById('authTabRegister')
  .classList.toggle('active',mode==='register');
}

function openAuthModal(mode='login',intent=null){
 ensureAuthModal();
 authIntent=intent;
 showAuthMode(mode);
 document.getElementById('authOverlay').classList.add('open');
 document.body.style.overflow='hidden';
}

function closeAuthModal(){
 const overlay=document.getElementById('authOverlay');
 if(overlay)overlay.classList.remove('open');
 document.body.style.overflow='';
}

function authOverlayClick(e){
 if(e.target.id==='authOverlay')closeAuthModal();
}

async function submitCustomerLogin(){
 const username=document.getElementById('authUsername').value.trim();
 const password=document.getElementById('authPassword').value;
 const msg=document.getElementById('authLoginMessage');
 const btn=document.getElementById('authLoginButton');
 msg.textContent='';

 if(!username||!password){
  msg.textContent='Username dan password wajib diisi.';
  return;
 }

 btn.disabled=true;
 btn.textContent='Memproses...';

 try{
  const res=await fetch('/api/login',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({username,password})
  });
  const data=await res.json();

  if(!res.ok||data.status!=='success'){
   throw new Error(data.error||'Login gagal.');
  }

  const payload=decodeToken(data.token);
  if(!payload||Number(payload.role_id)!==1){
   throw new Error(
    'Akun ini bukan akun pelanggan. Gunakan halaman login workspace.'
   );
  }

  localStorage.setItem('token',data.token);
  closeAuthModal();
  updateMarketplaceAuth();

  if(authIntent==='checkout'){
   authIntent=null;
   if(
    typeof openMarketplaceCheckout==='function'
   ){
    openMarketplaceCheckout();
   }else{
    openGuestCart();
   }
  }
 }catch(err){
  msg.textContent=err.message||'Tidak dapat terhubung ke server.';
 }finally{
  btn.disabled=false;
  btn.textContent='Masuk ke Pasar Pintar';
 }
}

async function submitCustomerRegister(){
 const body={
  full_name:document.getElementById('regName').value.trim(),
  phone:document.getElementById('regPhone').value.trim(),
  email:document.getElementById('regEmail').value.trim(),
  username:document.getElementById('regUsername').value.trim(),
  password:document.getElementById('regPassword').value
 };
 const msg=document.getElementById('authRegisterMessage');
 const btn=document.getElementById('authRegisterButton');
 msg.textContent='';

 if(!body.full_name||!body.email||!body.username||!body.password){
  msg.textContent='Nama, email, username dan password wajib diisi.';
  return;
 }
 if(body.password.length<8){
  msg.textContent='Password minimal 8 karakter.';
  return;
 }

 btn.disabled=true;
 btn.textContent='Mendaftarkan...';

 try{
  const res=await fetch('/api/onboarding/register/customer',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify(body)
  });
  const data=await res.json();

  if(!res.ok){
   throw new Error(data.error||'Pendaftaran gagal.');
  }

  document.getElementById('authUsername').value=body.username;
  document.getElementById('authPassword').value='';
  showAuthMode('login');
  document.getElementById('authLoginMessage').textContent=
   'Pendaftaran berhasil. Silakan masuk.';
 }catch(err){
  msg.textContent=err.message||'Tidak dapat terhubung ke server.';
 }finally{
  btn.disabled=false;
  btn.textContent='Daftar';
 }
}

function updateMarketplaceAuth(){
 const actions=document.getElementById('headerActions');
 if(!actions)return;

 if(customerToken()){
  actions.innerHTML=`
   <button class="btn btn-outline" onclick="goOrders()">Pesanan</button>
   <button class="btn btn-primary" onclick="goAccount()">Akun Saya</button>
  `;
 }else{
  actions.innerHTML=`
   <button class="btn btn-outline"
           onclick="openAuthModal('login')">Masuk</button>
   <button class="btn btn-primary"
           onclick="openAuthModal('register')">Daftar</button>
  `;
 }
}

window.continueCheckout=function(){
 if(!guestCart.length)return;
 if(!customerToken()){
  closeGuestCart();
  openAuthModal('login','checkout');
  return;
 }
 if(typeof openMarketplaceCheckout==='function'){
  openMarketplaceCheckout();
 }
};

window.goCustomer=function(){
 if(customerToken())return;
 openAuthModal('login');
};

window.goOrders=function(){
 if(customerToken()){
  location.href='/orders.html';
 }else{
  openAuthModal('login','orders');
 }
};

window.goAccount=function(){
 if(customerToken()){
  location.href='/profile.html';
 }else{
  openAuthModal('login','account');
 }
};

document.addEventListener('DOMContentLoaded',()=>{
 ensureAuthModal();
 updateMarketplaceAuth();
});
