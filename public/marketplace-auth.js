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

     <div id="authVerify" hidden>
      <h2 class="auth-title">Verifikasi WhatsApp</h2>
      <p class="auth-subtitle" id="authVerifyText">
       Masukkan kode 6 digit yang dikirim ke WhatsApp Anda.
      </p>
      <div class="auth-field">
       <label>Kode verifikasi</label>
       <input id="authOtpCode"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="000000">
      </div>
      <button id="authVerifyButton" class="auth-submit"
              onclick="submitCustomerOtp()">
       Verifikasi WhatsApp
      </button>
      <div id="authVerifyMessage" class="auth-message"></div>
      <div class="auth-switch">
       Belum menerima kode?
       <button id="authResendButton"
               onclick="resendCustomerOtp()">Kirim ulang</button>
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
 document.getElementById('authVerify').hidden=mode!=='verify';
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

   localStorage.setItem("token",data.token);
   updateMarketplaceAuth();

   const profileRes=await fetch(
    "/api/customer/profile/me",
    {
     headers:{
      "Authorization":"Bearer "+data.token
     }
    }
   );
   const profileData=await profileRes.json();

   if(!profileRes.ok){
    throw new Error(
     profileData.error||
     profileData.message||
     "Profil pelanggan tidak dapat diperiksa."
    );
   }

   if(!profileData.user?.phone_verified_at){
    const otpRes=await fetch(
     "/api/customer/phone-verification/request",
     {
      method:"POST",
      headers:{
       "Authorization":"Bearer "+data.token,
       "Content-Type":"application/json"
      }
     }
    );
    const otpData=await otpRes.json();

    if(!otpRes.ok && otpRes.status!==429){
     throw new Error(
      otpData.message||
      otpData.error||
      "Kode WhatsApp belum dapat dikirim."
     );
    }

    document.getElementById("authOtpCode").value="";
    document.getElementById("authVerifyMessage").textContent=
     otpRes.status===429
      ?"Gunakan kode WhatsApp yang baru saja dikirim."
      :"Kode 6 digit telah dikirim ke WhatsApp Anda.";
    showAuthMode("verify");
    return;
   }

   closeAuthModal();
   updateMarketplaceAuth();

   if(authIntent==="checkout"){
    authIntent=null;
    if(typeof openMarketplaceCheckout==="function"){
     openMarketplaceCheckout();
    }else{
     openGuestCart();
    }
   }else if(authIntent==="orders"){
    authIntent=null;
    location.href="/orders.html";
   }else if(authIntent==="account"){
    authIntent=null;
    location.href="/profile.html";
   }else{
    authIntent=null;
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
  full_name:document.getElementById("regName").value.trim(),
  phone:document.getElementById("regPhone").value.trim(),
  email:document.getElementById("regEmail").value.trim(),
  username:document.getElementById("regUsername").value.trim(),
  password:document.getElementById("regPassword").value
 };
 const msg=document.getElementById("authRegisterMessage");
 const btn=document.getElementById("authRegisterButton");
 msg.textContent="";

 const digits=body.phone.replace(/\D/g,"");
 const normalizedPhone=digits.startsWith("0")
  ?"62"+digits.slice(1)
  :digits;

 if(!body.full_name||!body.phone||!body.email||
    !body.username||!body.password){
  msg.textContent=
   "Nama, WhatsApp, email, username dan password wajib diisi.";
  return;
 }

 if(!/^62\d{8,13}$/.test(normalizedPhone)){
  msg.textContent=
   "Masukkan nomor WhatsApp yang valid, contoh 08xxxxxxxxxx.";
  return;
 }

 if(body.password.length<8){
  msg.textContent="Password minimal 8 karakter.";
  return;
 }

 btn.disabled=true;
 btn.textContent="Mendaftarkan...";

 try{
  const registerRes=await fetch(
   "/api/onboarding/register/customer",
   {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body)
   }
  );
  const registerData=await registerRes.json();

  if(!registerRes.ok){
   throw new Error(
    registerData.error||
    registerData.message||
    "Pendaftaran gagal."
   );
  }

  btn.textContent="Menyiapkan verifikasi...";

  const loginRes=await fetch("/api/login",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({
    username:body.username,
    password:body.password
   })
  });
  const loginData=await loginRes.json();

  if(!loginRes.ok||loginData.status!=="success"||
     !loginData.token){
   throw new Error(
    "Akun berhasil dibuat, tetapi sesi verifikasi gagal dibuat."
   );
  }

  const payload=decodeToken(loginData.token);
  if(!payload||Number(payload.role_id)!==1){
   throw new Error("Akun customer tidak valid.");
  }

  localStorage.setItem("token",loginData.token);
  updateMarketplaceAuth();

  const otpRes=await fetch(
   "/api/customer/phone-verification/request",
   {
    method:"POST",
    headers:{
     "Authorization":"Bearer "+loginData.token,
     "Content-Type":"application/json"
    }
   }
  );
  const otpData=await otpRes.json();

   document.getElementById("authOtpCode").value="";

   if(otpRes.ok){
    document.getElementById("authVerifyMessage").textContent=
     "Kode 6 digit telah dikirim ke WhatsApp Anda.";
   }else if(otpRes.status===429){
    document.getElementById("authVerifyMessage").textContent=
     "Gunakan kode WhatsApp yang baru saja dikirim.";
   }else{
    document.getElementById("authVerifyMessage").textContent=
     "Akun berhasil dibuat, tetapi kode WhatsApp belum dapat dikirim. Klik Kirim ulang.";
   }

   showAuthMode("verify");
 }catch(err){
  msg.textContent=
   err.message||"Tidak dapat terhubung ke server.";
 }finally{
  btn.disabled=false;
  btn.textContent="Daftar";
 }
}

async function submitCustomerOtp(){
 const code=document.getElementById("authOtpCode").value.trim();
 const msg=document.getElementById("authVerifyMessage");
 const btn=document.getElementById("authVerifyButton");
 const token=customerToken();

 msg.textContent="";

 if(!/^\d{6}$/.test(code)){
  msg.textContent="Masukkan kode verifikasi 6 digit.";
  return;
 }

 if(!token){
  msg.textContent="Sesi verifikasi berakhir. Silakan masuk kembali.";
  showAuthMode("login");
  return;
 }

 btn.disabled=true;
 btn.textContent="Memverifikasi...";

 try{
  const res=await fetch(
   "/api/customer/phone-verification/verify",
   {
    method:"POST",
    headers:{
     "Authorization":"Bearer "+token,
     "Content-Type":"application/json"
    },
    body:JSON.stringify({code})
   }
  );

  const data=await res.json();

  if(!res.ok){
   throw new Error(
    data.message||
    data.error||
    "Kode verifikasi tidak valid."
   );
  }

  msg.textContent="WhatsApp berhasil diverifikasi.";
  updateMarketplaceAuth();

  setTimeout(()=>{
   closeAuthModal();

   if(authIntent==="checkout"){
    authIntent=null;
    if(typeof openMarketplaceCheckout==="function"){
     openMarketplaceCheckout();
    }else if(typeof openGuestCart==="function"){
     openGuestCart();
    }
   }else if(authIntent==="orders"){
    authIntent=null;
    location.href="/orders.html";
   }else if(authIntent==="account"){
    authIntent=null;
    location.href="/profile.html";
   }else{
    authIntent=null;
   }
  },700);
 }catch(err){
  msg.textContent=
   err.message||"Tidak dapat terhubung ke server.";
 }finally{
  btn.disabled=false;
  btn.textContent="Verifikasi WhatsApp";
 }
}

async function resendCustomerOtp(){
 const msg=document.getElementById("authVerifyMessage");
 const btn=document.getElementById("authResendButton");
 const token=customerToken();

 msg.textContent="";

 if(!token){
  msg.textContent="Sesi verifikasi berakhir. Silakan masuk kembali.";
  showAuthMode("login");
  return;
 }

 btn.disabled=true;
 btn.textContent="Mengirim...";

 try{
  const res=await fetch(
   "/api/customer/phone-verification/request",
   {
    method:"POST",
    headers:{
     "Authorization":"Bearer "+token,
     "Content-Type":"application/json"
    }
   }
  );

  const data=await res.json();

  if(!res.ok){
   throw new Error(
    data.message||
    data.error||
    "Kode WhatsApp belum dapat dikirim."
   );
  }

  document.getElementById("authOtpCode").value="";
  msg.textContent="Kode baru telah dikirim ke WhatsApp Anda.";
 }catch(err){
  msg.textContent=
   err.message||"Tidak dapat terhubung ke server.";
 }finally{
  btn.disabled=false;
  btn.textContent="Kirim ulang";
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
