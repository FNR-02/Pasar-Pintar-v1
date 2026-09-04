let marketplaceTempoAccounts=[];

function closeMarketplaceSourceCart(){
 if(typeof closeLapakCart==='function'){
  closeLapakCart();
  return;
 }
 if(typeof closeGuestCart==='function'){
  closeGuestCart();
 }
}

function renderMarketplaceSourceCart(){
 if(typeof renderLapakCart==='function'){
  renderLapakCart();
 }else if(typeof renderGuestCart==='function'){
  renderGuestCart();
 }

 if(typeof updateLapakCartBadge==='function'){
  updateLapakCartBadge();
 }else if(typeof updateGuestCartBadge==='function'){
  updateGuestCartBadge();
 }
}


function marketplaceCartTotal(){
 return guestCart.reduce(
  (sum,item)=>
   sum+
   Number(item.price||0)*
   Number(item.quantity||0),
  0
 );
}

function marketplaceMerchantIds(){
 return [
  ...new Set(
   guestCart
    .map(x=>x.merchant_id)
    .filter(Boolean)
    .map(String)
  )
 ];
}

function marketplaceIsMultiMerchant(){
 return marketplaceMerchantIds().length>1;
}

function marketplaceCurrentMerchant(){
 if(!guestCart.length)return null;
 const id=guestCart[0].merchant_id;
 return products.find(
  p=>String(p.merchant_id)===String(id)
 )||guestCart[0];
}

function marketplaceEligibleTempo(){
 const ids=marketplaceMerchantIds();
 if(ids.length!==1)return null;

 const total=marketplaceCartTotal();

 return marketplaceTempoAccounts.find(a=>
  String(a.merchant_id)===ids[0] &&
  a.status==='ACTIVE' &&
  Number(a.available_credit||0)>=total
 )||null;
}

function ensureMarketplaceCheckout(){
 if(document.getElementById('marketplaceCheckoutOverlay')){
  return;
 }

 document.body.insertAdjacentHTML('beforeend',`
 <div id="marketplaceCheckoutOverlay"
      class="checkout-overlay"
      onclick="marketplaceCheckoutOverlayClick(event)">
  <aside class="checkout-sheet">
   <div class="checkout-head">
    <strong>Checkout</strong>
    <button type="button"
            class="checkout-close"
            onclick="closeMarketplaceCheckout()">×</button>
   </div>

   <div class="checkout-body">

    <div class="checkout-box">
     <span class="checkout-box-title">
      Cara menerima barang
     </span>

     <label class="checkout-option">
      <input type="radio"
             name="marketplaceFulfillment"
             value="DELIVERY"
             checked
             onchange="changeMarketplaceFulfillment()">
      <span>Diantar ke alamat saya</span>
     </label>

     <label class="checkout-option">
      <input type="radio"
             name="marketplaceFulfillment"
             value="PICKUP"
             onchange="changeMarketplaceFulfillment()">
      <span>Ambil sendiri di outlet</span>
     </label>
    </div>

    <div id="marketplaceDeliveryBox"
         class="checkout-box">
     <span class="checkout-box-title">
      Alamat pengiriman
     </span>
     <textarea id="marketplaceShippingAddress"
               class="checkout-address"
               placeholder="Masukkan alamat pengiriman lengkap..."></textarea>

     <div style="
       margin-top:8px;
       font-size:13px;
       line-height:1.45;
       color:#64748b;
     ">
      Pengiriman gratis saat ini hanya tersedia di Kota Bandung.
     </div>
    </div>

    <div id="marketplacePickupBox"
         class="checkout-box"
         style="display:none">
     <span class="checkout-box-title">
      Lokasi pengambilan
     </span>
     <div id="marketplacePickupLocation"
          class="checkout-pickup">
      Lokasi outlet akan ditampilkan di sini.
     </div>
    </div>

    <div id="marketplacePickupPaymentBox"
         class="checkout-box"
         style="display:none">
     <span class="checkout-box-title">
      Cara bayar
     </span>

     <label class="checkout-option">
      <input type="radio"
             name="marketplacePickupPayment"
             value="ONLINE"
             checked
             onchange="refreshMarketplaceTempo()">
      <span>Bayar online sekarang</span>
     </label>

     <label class="checkout-option">
      <input type="radio"
             name="marketplacePickupPayment"
             value="OUTLET"
             onchange="marketplaceOutletSelected()">
      <span>Bayar saat ambil di outlet</span>
     </label>
    </div>

    <div id="marketplaceTempoBox"
         class="checkout-box"
         style="display:none">
     <span class="checkout-box-title">
      Fasilitas Tempo
     </span>

     <label class="checkout-option">
      <input type="checkbox"
             id="marketplaceUseTempo"
             onchange="changeMarketplaceTempo()">
      <span>
       <strong>Bayar Tempo</strong>
       <small id="marketplaceTempoInfo"
              class="checkout-tempo-info"></small>
      </span>
     </label>
    </div>

    <div class="checkout-box">
     <span class="checkout-box-title">
      Ringkasan pesanan
     </span>
      <div id="marketplaceCheckoutSummary"></div>

      <div class="checkout-summary-row">
       <span>Subtotal Produk</span>
       <strong id="marketplaceCheckoutSubtotal">Rp 0</strong>
      </div>

      <div id="marketplaceShippingFeeRow"
           class="checkout-summary-row">
       <span>Ongkir</span>
       <strong>Gratis - Kota Bandung</strong>
      </div>

      <div class="checkout-summary-row checkout-total">
       <span>Total Pembayaran</span>
       <strong id="marketplaceCheckoutTotal">Rp 0</strong>
      </div>
    </div>

   </div>

   <div class="checkout-footer">
    <button id="marketplaceCheckoutButton"
            class="checkout-submit"
            type="button"
            onclick="submitMarketplaceCheckout()">
     Buat Pesanan
    </button>
    <div id="marketplaceCheckoutMessage"
         class="checkout-message"></div>
   </div>
  </aside>
 </div>`);
}

function marketplaceFulfillment(){
 const el=document.querySelector(
  'input[name=marketplaceFulfillment]:checked'
 );
 return el?el.value:'DELIVERY';
}

function marketplacePickupPayment(){
 const el=document.querySelector(
  'input[name=marketplacePickupPayment]:checked'
 );
 return el?el.value:'ONLINE';
}

function refreshMarketplaceTempo(){
 const box=document.getElementById(
  'marketplaceTempoBox'
 );
 const input=document.getElementById(
  'marketplaceUseTempo'
 );
 const info=document.getElementById(
  'marketplaceTempoInfo'
 );

 if(!box||!input||!info)return;

 const account=marketplaceEligibleTempo();

 if(!account){
  input.checked=false;
  box.style.display='none';
  info.textContent='';
  return;
 }

 box.style.display='block';
 info.textContent=
  'Sisa limit '+
  rupiah(account.available_credit)+
  ' · '+
  Number(account.default_term_days||0)+
  ' hari';
}

function marketplaceOutletSelected(){
 const tempo=document.getElementById(
  'marketplaceUseTempo'
 );
 if(tempo)tempo.checked=false;
 refreshMarketplaceTempo();
}

function changeMarketplaceTempo(){
 const useTempo=document.getElementById(
  'marketplaceUseTempo'
 );
 if(!useTempo||!useTempo.checked)return;

 const account=marketplaceEligibleTempo();
 if(!account){
  useTempo.checked=false;
  refreshMarketplaceTempo();
  return;
 }

 const online=document.querySelector(
  'input[name=marketplacePickupPayment][value=ONLINE]'
 );

 if(online)online.checked=true;
}

function changeMarketplaceFulfillment(){
 const type=marketplaceFulfillment();

 const delivery=document.getElementById(
  'marketplaceDeliveryBox'
 );
 const pickup=document.getElementById(
  'marketplacePickupBox'
 );
 const payment=document.getElementById(
  'marketplacePickupPaymentBox'
 );

 delivery.style.display=
  type==='DELIVERY'?'block':'none';

 pickup.style.display=
  type==='PICKUP'?'block':'none';

 payment.style.display=
  type==='PICKUP'?'block':'none';

 if(type==='PICKUP'){
  const merchant=marketplaceCurrentMerchant();

  const store=
   merchant?.store_name||
   'Outlet Pasar Pintar';

  const address=
   merchant?.merchant_address||
   'Alamat outlet belum tersedia';

  document.getElementById(
   'marketplacePickupLocation'
  ).innerHTML=
   '<strong>'+esc(store)+'</strong><br>'+
   esc(address);
 }

 refreshMarketplaceTempo();
 renderMarketplaceCheckout();
}

async function loadMarketplaceAddress(){
 const token=customerToken();
 if(!token)return;

 try{
  const r=await fetch(
   '/api/customer/profile/me',
   {
    headers:{
     Authorization:'Bearer '+token
    }
   }
  );

  if(r.status===401||r.status===403){
   return;
  }

  const d=await r.json();
  if(!r.ok)return;

  const address=String(
   d.user?.default_address||''
  ).trim();

  const input=document.getElementById(
   'marketplaceShippingAddress'
  );

  if(input&&!input.value.trim()&&address){
   input.value=address;
  }
 }catch(err){
  console.error(
   '[MARKETPLACE ADDRESS]',
   err
  );
 }
}

async function loadMarketplaceTempo(){
 const token=customerToken();

 marketplaceTempoAccounts=[];

 if(!token){
  refreshMarketplaceTempo();
  return;
 }

 try{
  const r=await fetch(
   '/api/customer/credit-accounts-v1',
   {
    headers:{
     Authorization:'Bearer '+token
    }
   }
  );

  if(r.status===401||r.status===403){
   refreshMarketplaceTempo();
   return;
  }

  const d=await r.json();

  if(r.ok){
   marketplaceTempoAccounts=
    Array.isArray(d.accounts)
     ? d.accounts
     : [];
  }
 }catch(err){
  console.error(
   '[MARKETPLACE TEMPO]',
   err
  );
 }

 refreshMarketplaceTempo();
}

function renderMarketplaceCheckout(){
 const box=document.getElementById(
  'marketplaceCheckoutSummary'
 );
 const subtotal=document.getElementById(
  'marketplaceCheckoutSubtotal'
 );
 const total=document.getElementById(
  'marketplaceCheckoutTotal'
 );
 const shippingRow=document.getElementById(
  'marketplaceShippingFeeRow'
 );

 if(!box||!subtotal||!total)return;

 box.innerHTML=guestCart.map(item=>`
  <div class="checkout-summary-row">
   <span>
    ${esc(item.name||'Produk')}
    × ${Number(item.quantity||0)}
   </span>
   <strong>
    ${rupiah(
     Number(item.price||0)*
     Number(item.quantity||0)
    )}
   </strong>
  </div>
 `).join('');

 const amount=marketplaceCartTotal();

 subtotal.textContent=rupiah(amount);
 total.textContent=rupiah(amount);

 if(shippingRow){
  shippingRow.style.display=
   marketplaceFulfillment()==='DELIVERY'
    ? 'flex'
    : 'none';
 }
}

async function openMarketplaceCheckout(){
 if(!guestCart.length)return;

 if(!customerToken()){
  closeMarketplaceSourceCart();
  openAuthModal('login','checkout');
  return;
 }

 const multiMerchant=
  marketplaceIsMultiMerchant();

 closeMarketplaceSourceCart();
 ensureMarketplaceCheckout();
 renderMarketplaceCheckout();

 document.getElementById(
  'marketplaceCheckoutMessage'
 ).textContent='';

 document.getElementById(
  'marketplaceCheckoutOverlay'
 ).classList.add('open');

 document.body.style.overflow='hidden';

 const pickup=document.querySelector(
  'input[name=marketplaceFulfillment][value=PICKUP]'
 );

 const delivery=document.querySelector(
  'input[name=marketplaceFulfillment][value=DELIVERY]'
 );

 if(multiMerchant){
  if(delivery)delivery.checked=true;

  if(pickup){
   pickup.checked=false;
   pickup.disabled=true;

   const label=pickup.closest('label');
   if(label)label.style.display='none';
  }
 }else if(pickup){
  pickup.disabled=false;

  const label=pickup.closest('label');
  if(label)label.style.display='';
 }

 changeMarketplaceFulfillment();

 await Promise.all([
  loadMarketplaceAddress(),
  loadMarketplaceTempo()
 ]);
}

function closeMarketplaceCheckout(){
 const overlay=document.getElementById(
  'marketplaceCheckoutOverlay'
 );
 if(overlay){
  overlay.classList.remove('open');
 }
 document.body.style.overflow='';
}

function marketplaceCheckoutOverlayClick(event){
 if(
  event.target &&
  event.target.id==='marketplaceCheckoutOverlay'
 ){
  closeMarketplaceCheckout();
 }
}

async function submitMarketplaceCheckout(){
 const token=customerToken();
 const msg=document.getElementById(
  'marketplaceCheckoutMessage'
 );
 const btn=document.getElementById(
  'marketplaceCheckoutButton'
 );

 if(!token){
  closeMarketplaceCheckout();
  openAuthModal('login','checkout');
  return;
 }

 if(!guestCart.length){
  msg.textContent='Keranjang masih kosong.';
  return;
 }

 const merchants=marketplaceMerchantIds();

 const multiMerchant=
  merchants.length>1;

 const type=marketplaceFulfillment();

 if(
  multiMerchant &&
  type!=='DELIVERY'
 ){
  msg.textContent=
   'Pesanan dari beberapa jongko hanya dapat dikirim.';
  return;
 }

 const address=document.getElementById(
  'marketplaceShippingAddress'
 ).value.trim();

 if(type==='DELIVERY'&&!address){
  msg.textContent=
   'Alamat pengiriman wajib diisi.';
  return;
 }

 const tempoInput=document.getElementById(
  'marketplaceUseTempo'
 );

 const tempoRequested=
  Boolean(tempoInput?.checked);

 const tempoAccount=
  tempoRequested
   ? marketplaceEligibleTempo()
   : null;

 if(tempoRequested&&!tempoAccount){
  msg.textContent=
   'Fasilitas tempo tidak tersedia untuk transaksi ini.';
  refreshMarketplaceTempo();
  return;
 }

 btn.disabled=true;
 btn.textContent='Membuat pesanan...';
 msg.textContent='';

 try{
  const checkoutUrl=
   multiMerchant
    ? '/api/market/checkout-with-payment-v1'
    : '/api/orders/checkout-v2';

  const r=await fetch(
   checkoutUrl,
   {
    method:'POST',
    headers:{
     'Content-Type':'application/json',
     Authorization:'Bearer '+token
    },
     body:JSON.stringify(
      multiMerchant
       ? {
          items:guestCart.map(x=>({
           product_id:x.id,
           quantity:Number(x.quantity)
          })),
          shipping_address:address,
          market_code:'PASAR-SEDERHANA'
         }
       : {
          items:guestCart.map(x=>({
           product_id:x.id,
           quantity:Number(x.quantity)
          })),
          fulfillment_type:type,
          shipping_address:
           type==='DELIVERY'
            ? address
            : null,
          payment_mode:
           tempoRequested
            ? 'TEMPO'
            : 'DIRECT',
          credit_account_id:
           tempoRequested
            ? tempoAccount.id
            : null,
          pickup_payment:
           !tempoRequested&&type==='PICKUP'
            ? marketplacePickupPayment()
            : null
         }
     )
   }
  );

  if(r.status===401||r.status===403){
   localStorage.removeItem('token');
   updateMarketplaceAuth();
   throw new Error(
    'Sesi login berakhir. Silakan masuk kembali.'
   );
  }

  const d=await r.json();

  if(!r.ok){
   throw new Error(
    d.error||
    'Gagal membuat pesanan.'
   );
  }

  msg.style.color='#17663e';
  msg.textContent=
   'Pesanan berhasil dibuat.';

  guestCart=[];
  localStorage.removeItem('pp_cart');
  renderMarketplaceSourceCart();

  if(multiMerchant){
   if(d.market_order?.id){
    localStorage.setItem(
     'pp_last_market_order_id',
     d.market_order.id
    );
   }

   if(d.payment?.id){
    localStorage.setItem(
     'pp_last_market_payment_id',
     d.payment.id
    );
   }

   msg.textContent=
    'Pesanan gabungan berhasil dibuat. Pembayaran masih menunggu proses.';

   setTimeout(()=>{
    closeMarketplaceCheckout();
    location.href='/market-payment.html?payment='+encodeURIComponent(d.payment.id);
   },1200);

   return;
  }

  const orderId=d.order.id;

  setTimeout(()=>{
   if(
    tempoRequested ||
    (
     type==='PICKUP' &&
     marketplacePickupPayment()==='OUTLET'
    )
   ){
    location.href='/orders.html';
   }else{
    location.href=
     '/payment.html?order='+
     encodeURIComponent(orderId);
   }
  },700);

 }catch(err){
  msg.style.color='#b42318';
  msg.textContent=
   err.message||
   'Gagal membuat pesanan.';
 }finally{
  btn.disabled=false;
  btn.textContent='Buat Pesanan';
 }
}

window.continueCheckout=function(){
 openMarketplaceCheckout();
};

document.addEventListener(
 'DOMContentLoaded',
 ()=>{
  ensureMarketplaceCheckout();
 }
);
