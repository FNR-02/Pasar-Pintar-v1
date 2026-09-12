const token =
  localStorage.getItem('token');

if(!token){
  location.href='/login.html';
}

let catalogProducts=[];
let quantities={};
let warehouses=[];
let b2bOrders=[];

function rupiah(value){
  return 'Rp '+
    new Intl.NumberFormat(
      'id-ID'
    ).format(
      Number(value||0)
    );
}

function esc(value){
  return String(value??'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function shortId(id){
  const value=String(id||'');
  if(value.length<12){
    return value;
  }
  return value.slice(0,8).toUpperCase();
}

function formatDate(value){
  if(!value){
    return '-';
  }

  const date=new Date(value);

  return date.toLocaleString(
    'id-ID',
    {
      day:'2-digit',
      month:'short',
      year:'numeric',
      hour:'2-digit',
      minute:'2-digit'
    }
  );
}

async function apiFetch(
  url,
  options={}
){
  const headers={
    Authorization:
      'Bearer '+token,
    ...(options.headers||{})
  };

  if(
    options.body &&
    !headers['Content-Type']
  ){
    headers['Content-Type']=
      'application/json';
  }

  const res=await fetch(
    url,
    {
      ...options,
      headers
    }
  );

  let data={};

  try{
    data=await res.json();
  }catch(_){}

  if(
    res.status===401 ||
    res.status===403
  ){
    localStorage.removeItem(
      'token'
    );
    location.href='/login.html';
    throw new Error(
      'Sesi login berakhir'
    );
  }

  if(!res.ok){
    throw new Error(
      data.error ||
      data.message ||
      'Permintaan gagal'
    );
  }

  return data;
}

function showAlert(message){
  const box=
    document.getElementById(
      'alertBox'
    );

  if(!message){
    box.style.display='none';
    box.textContent='';
    return;
  }

  box.textContent=message;
  box.style.display='block';
}

function showTab(tab){
  const shop=
    document.getElementById(
      'shopSection'
    );

  const orders=
    document.getElementById(
      'ordersSection'
    );

  const cart=
    document.getElementById(
      'cartBar'
    );

  const shopTab=
    document.getElementById(
      'tabShop'
    );

  const orderTab=
    document.getElementById(
      'tabOrders'
    );

  if(tab==='orders'){
    shop.classList.add(
      'hidden'
    );

    orders.classList.remove(
      'hidden'
    );

    cart.classList.add(
      'hidden'
    );

    shopTab.classList.remove(
      'active'
    );

    orderTab.classList.add(
      'active'
    );

    loadOrders();
    return;
  }

  orders.classList.add(
    'hidden'
  );

  shop.classList.remove(
    'hidden'
  );

  cart.classList.remove(
    'hidden'
  );

  orderTab.classList.remove(
    'active'
  );

  shopTab.classList.add(
    'active'
  );
}

function packLabel(product){
  if(
    product.pack_size_value &&
    product.pack_size_unit
  ){
    return (
      product.pack_size_value+
      ' '+
      product.pack_size_unit
    );
  }

  return (
    product.selling_unit ||
    'PCS'
  );
}

function renderCatalog(){
  const root=
    document.getElementById(
      'catalog'
    );

  if(!catalogProducts.length){
    root.innerHTML=
      '<div class="b2b-empty">'+
      'Belum ada produk grosir yang tersedia.'+
      '</div>';

    updateCart();
    return;
  }

  root.innerHTML=
    catalogProducts.map(
      product=>{
        const qty=
          Number(
            quantities[product.id]||0
          );

        const stock=
          Number(product.stock||0);

        const image=
          product.image_url ||
          '/logo-pasar-pintar.jpg';

        return `
          <article class="b2b-product">

            <div class="b2b-photo">
              <img
                src="${esc(image)}"
                alt="${esc(product.name)}"
                onerror="
                  this.src='/logo-pasar-pintar.jpg'
                ">
            </div>

            <div class="b2b-product-body">

              <div class="b2b-product-name">
                ${esc(product.name)}
              </div>

              <div class="b2b-product-meta">
                ${esc(packLabel(product))}
              </div>

              <strong class="b2b-price">
                ${rupiah(product.wholesale_price)}
              </strong>

              <div class="b2b-stock">
                Stok tersedia: ${stock}
              </div>

              <div class="b2b-qty">

                <button
                  type="button"
                  onclick="
                    changeQty(
                      '${esc(product.id)}',
                      -1
                    )
                  ">
                  −
                </button>

                <strong>
                  ${qty}
                </strong>

                <button
                  type="button"
                  ${stock<=0?'disabled':''}
                  onclick="
                    changeQty(
                      '${esc(product.id)}',
                      1
                    )
                  ">
                  +
                </button>

              </div>

            </div>
          </article>
        `;
      }
    ).join('');

  updateCart();
}

function changeQty(
  productId,
  delta
){
  const product=
    catalogProducts.find(
      p=>p.id===productId
    );

  if(!product){
    return;
  }

  const stock=
    Number(product.stock||0);

  let next=
    Number(
      quantities[productId]||0
    )+delta;

  next=Math.max(
    0,
    Math.min(
      next,
      stock
    )
  );

  quantities[productId]=next;

  renderCatalog();
}

function selectedItems(){
  return catalogProducts
    .filter(
      product=>
        Number(
          quantities[product.id]||0
        )>0
    )
    .map(
      product=>({
        product,
        quantity:
          Number(
            quantities[product.id]
          )
      })
    );
}

function updateCart(){
  const items=
    selectedItems();

  const itemCount=
    items.reduce(
      (sum,item)=>
        sum+item.quantity,
      0
    );

  const total=
    items.reduce(
      (sum,item)=>
        sum+
        (
          Number(
            item.product
              .wholesale_price||0
          )*
          item.quantity
        ),
      0
    );

  document.getElementById(
    'cartCount'
  ).textContent=
    itemCount
      ? itemCount+' barang dipilih'
      : 'Belum ada barang';

  document.getElementById(
    'cartTotal'
  ).textContent=
    rupiah(total);

  document.getElementById(
    'createPoButton'
  ).disabled=
    !items.length;
}

async function loadCatalog(){
  const root=
    document.getElementById(
      'catalog'
    );

  root.innerHTML=
    '<div class="b2b-empty">'+
    'Memuat katalog grosir...'+
    '</div>';

  const data=
    await apiFetch(
      '/api/merchant/b2b/catalog'
    );

  catalogProducts=
    Array.isArray(data.products)
      ? data.products
      : [];

  document.getElementById(
    'buyerName'
  ).textContent=
    data.buyer?.store_name ||
    'Merchant';

  document.getElementById(
    'sellerName'
  ).textContent=
    data.seller?.store_name ||
    'Pasar Pintar Merchant';

  renderCatalog();
}

async function loadWarehouses(){
  const data=
    await apiFetch(
      '/api/warehouses'
    );

  warehouses=
    Array.isArray(data.data)
      ? data.data
      : [];

  const select=
    document.getElementById(
      'warehouseSelect'
    );

  if(!warehouses.length){
    select.innerHTML=
      '<option value="">'+
      'Gudang merchant belum tersedia'+
      '</option>';
    return;
  }

  select.innerHTML=
    warehouses.map(
      warehouse=>`
        <option
          value="${esc(warehouse.id)}">
          ${esc(warehouse.warehouse_name)}
        </option>
      `
    ).join('');
}

async function createPO(){
  showAlert('');

  const items=
    selectedItems();

  if(!items.length){
    showAlert(
      'Pilih minimal satu produk.'
    );
    return;
  }

  const warehouseId=
    document.getElementById(
      'warehouseSelect'
    ).value;

  if(!warehouseId){
    showAlert(
      'Gudang tujuan belum tersedia.'
    );
    return;
  }

  const button=
    document.getElementById(
      'createPoButton'
    );

  button.disabled=true;
  button.textContent=
    'Membuat PO...';

  try{
    await apiFetch(
      '/api/merchant/b2b/orders',
      {
        method:'POST',
        body:JSON.stringify({
          destination_warehouse_id:
            warehouseId,
          items:
            items.map(
              item=>({
                product_id:
                  item.product.id,
                quantity:
                  item.quantity
              })
            ),
          notes:''
        })
      }
    );

    quantities={};

    await Promise.all([
      loadCatalog(),
      loadOrders()
    ]);

    showTab('orders');
  }catch(err){
    showAlert(err.message);
  }finally{
    button.textContent=
      'Buat PO';
    updateCart();
  }
}

function statusLabel(status){
  const labels={
    DRAFT:
      'Belum dikirim',
    SUBMITTED:
      'Menunggu persetujuan',
    APPROVED:
      'Siap diterima',
    RECEIVED:
      'Selesai',
    REJECTED:
      'Ditolak',
    CANCELLED:
      'Dibatalkan'
  };

  return labels[status] ||
    status ||
    '-';
}

function orderAction(order){
  if(order.status==='DRAFT'){
    return `
      <button
        class="b2b-primary"
        type="button"
        onclick="
          submitPO('${esc(order.id)}')
        ">
        Kirim PO
      </button>
    `;
  }

  if(order.status==='APPROVED'){
    return `
      <button
        class="b2b-primary"
        type="button"
        onclick="
          receivePO('${esc(order.id)}')
        ">
        Terima Barang
      </button>
    `;
  }

  return '';
}

function renderOrders(){
  const root=
    document.getElementById(
      'ordersList'
    );

  if(!b2bOrders.length){
    root.innerHTML=
      '<div class="b2b-empty">'+
      'Belum ada PO usaha.'+
      '</div>';
    return;
  }

  root.innerHTML=
    b2bOrders.map(
      order=>`
        <article class="b2b-order">

          <div class="b2b-order-top">

            <div>
              <div class="b2b-order-id">
                PO ${esc(shortId(order.id))}
              </div>

              <div class="b2b-order-date">
                ${esc(formatDate(order.created_at))}
              </div>
            </div>

            <span
              class="b2b-status ${esc(order.status)}">
              ${esc(statusLabel(order.status))}
            </span>

          </div>

          <div class="b2b-order-total">
            <span>
              ${Number(order.item_count||0)}
              jenis barang
            </span>

            <strong>
              ${rupiah(order.total_amount)}
            </strong>
          </div>

          <div class="b2b-order-meta">
            Supplier:
            ${esc(order.seller_store_name)}
            <br>

            Tujuan:
            ${esc(order.destination_warehouse_name)}
            <br>

            Pembayaran:
            ${esc(order.payment_mode)}
          </div>

          ${
            order.status==='RECEIVED'
            ? `
              <div class="b2b-note">
                Barang sudah masuk stok.
                Atur harga jual dan publikasi
                dari menu Produk bila ingin
                dijual ke pelanggan.
              </div>
            `
            : ''
          }

          <div class="b2b-order-actions">
            ${orderAction(order)}
          </div>

        </article>
      `
    ).join('');
}

async function loadOrders(){
  const root=
    document.getElementById(
      'ordersList'
    );

  root.innerHTML=
    '<div class="b2b-empty">'+
    'Memuat PO usaha...'+
    '</div>';

  try{
    const data=
      await apiFetch(
        '/api/merchant/b2b/orders'
      );

    b2bOrders=
      Array.isArray(data.orders)
        ? data.orders
        : [];

    renderOrders();
  }catch(err){
    root.innerHTML=
      '<div class="b2b-empty">'+
      esc(err.message)+
      '</div>';
  }
}

async function submitPO(orderId){
  if(
    !confirm(
      'Kirim PO ini ke Pasar Pintar?'
    )
  ){
    return;
  }

  try{
    await apiFetch(
      '/api/merchant/b2b/orders/'+
      encodeURIComponent(orderId)+
      '/submit',
      {
        method:'POST'
      }
    );

    await loadOrders();
  }catch(err){
    alert(err.message);
  }
}

async function receivePO(orderId){
  if(
    !confirm(
      'Pastikan barang fisik sudah diterima. Masukkan barang ke stok sekarang?'
    )
  ){
    return;
  }

  try{
    await apiFetch(
      '/api/merchant/b2b/orders/'+
      encodeURIComponent(orderId)+
      '/receive',
      {
        method:'POST'
      }
    );

    await Promise.all([
      loadCatalog(),
      loadOrders()
    ]);
  }catch(err){
    alert(err.message);
  }
}

async function init(){
  try{
    await Promise.all([
      loadWarehouses(),
      loadCatalog(),
      loadOrders()
    ]);
  }catch(err){
    showAlert(err.message);
  }
}

init();
