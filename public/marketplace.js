let products = [];
let selectedCategory = 'SEMUA';
let guestCart = [];

try {
  guestCart = JSON.parse(
    localStorage.getItem('pp_cart') || '[]'
  );

  if (!Array.isArray(guestCart)) {
    guestCart = [];
  }
} catch {
  guestCart = [];
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function rupiah(v) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(Number(v || 0));
}

function categoryMatch(product, key) {
  if (key === 'SEMUA') return true;

  const text = [
    product.category_name,
    product.parent_category_name
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  const map = {
    SAYUR: [
      'SAYUR',
      'BUAH'
    ],

    PROTEIN: [
      'DAGING',
      'IKAN',
      'PROTEIN',
      'AYAM',
      'SEAFOOD',
      'TAHU',
      'TEMPE'
    ],

    SEMBAKO: [
      'SEMBAKO',
      'BAHAN POKOK',
      'BERAS',
      'GULA',
      'MIE INSTAN',
      'MINYAK',
      'TELUR',
      'TEPUNG'
    ],

    FROZEN: [
      'FROZEN',
      'BAKSO',
      'BASO',
      'SOSIS',
      'NUGGET',
      'DUMPLING',
      'CHIKUWA',
      'FISH ROLL'
    ],

    KWETIAU: [
      'KWETIAU',
      'BIHUN',
      'SOHUN',
      'MIE'
    ],

    JAJANAN: [
      'JAJANAN',
      'CEMILAN',
      'CIMOL',
      'CILOK',
      'CIRENG',
      'CIPUK',
      'BASRENG'
    ],

    MINUMAN: [
      'MINUMAN',
      'AIR MINUM',
      'SUSU',
      'TEH',
      'KOPI'
    ],

    BUMBU: [
      'BUMBU',
      'PENYEDAP',
      'REMPAH',
      'CABAI',
      'SAUS',
      'KECAP',
      'GARAM',
      'MSG'
    ]
  };

  return (map[key] || []).some(
    keyword => text.includes(keyword)
  );
}

function renderProducts() {
  const q = document
    .getElementById('searchInput')
    .value
    .trim()
    .toLowerCase();

  const filtered = products.filter(product => {
    const searchable = [
      product.name,
      product.description,
      product.category_name,
      product.parent_category_name,
      product.store_name
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return (
      categoryMatch(product, selectedCategory) &&
      (!q || searchable.includes(q))
    );
  });

  document.getElementById('resultCount').textContent =
    filtered.length + ' produk';

  const grid = document.getElementById('productGrid');

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty">
        Produk belum tersedia untuk kategori atau pencarian ini.
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(product => {
    const image =
      product.image_url ||
      product.parent_product_image_url ||
      '/logo-pasar-pintar.jpg';

    const unit =
      product.pack_size_value &&
      product.pack_size_unit
        ? product.pack_size_value + ' ' +
          product.pack_size_unit
        : (product.selling_unit || '');

    return `
      <article class="product-card">

        <img
          class="product-image"
          src="${esc(image)}"
          alt="${esc(product.name)}"
          onerror="this.src='/logo-pasar-pintar.jpg'">

        <div class="product-body">

          <div class="store">
            ${esc(
              product.store_name ||
              'Merchant Pasar Pintar'
            )}
          </div>

          <div class="product-name">
            ${esc(product.name)}
          </div>

          <div class="meta">
            ${esc(product.category_name || '')}
            ${unit ? ' · ' + esc(unit) : ''}
          </div>

          <div class="price">
            ${rupiah(product.price)}
          </div>

          <div class="stock">
            Stok tersedia:
            ${Number(product.stock || 0)}
          </div>

          <button
            class="product-button"
            onclick="addGuestProduct('${esc(product.id)}')">
            Tambah
          </button>

        </div>

      </article>
    `;
  }).join('');
}

async function loadProducts() {
  try {
    const response =
      await fetch('/api/public/catalog/products');

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || 'Gagal memuat katalog'
      );
    }

    products =
      Array.isArray(data.data)
        ? data.data
        : [];

    renderProducts();

  } catch (err) {
    console.error(err);

    document.getElementById('resultCount')
      .textContent = '';

    document.getElementById('productGrid')
      .innerHTML = `
        <div class="empty">
          Katalog sedang tidak dapat dimuat.
        </div>
      `;
  }
}

document
  .querySelectorAll('.category')
  .forEach(button => {

    button.addEventListener('click', () => {

      document
        .querySelectorAll('.category')
        .forEach(el =>
          el.classList.remove('active')
        );

      button.classList.add('active');

      selectedCategory =
        button.dataset.category;

      renderProducts();

      document
        .getElementById('products')
        .scrollIntoView({
          behavior: 'smooth'
        });
    });
  });

document
  .getElementById('searchForm')
  .addEventListener('submit', event => {

    event.preventDefault();

    renderProducts();

    document
      .getElementById('products')
      .scrollIntoView({
        behavior: 'smooth'
      });
  });

document
  .getElementById('searchInput')
  .addEventListener(
    'input',
    renderProducts
  );

function getToken() {
  return localStorage.getItem('token');
}

function saveGuestCart() {
  localStorage.setItem(
    'pp_cart',
    JSON.stringify(guestCart)
  );

  renderGuestCart();
  updateGuestCartBadge();
}

function addGuestProduct(productId) {
  const product = products.find(
    p => String(p.id) === String(productId)
  );

  if (!product) return;

  const stock = Number(product.stock || 0);

  if (stock <= 0) {
    alert('Stok produk sedang habis.');
    return;
  }

  const existing = guestCart.find(
    item => String(item.id) === String(productId)
  );

  if (existing) {
    const nextQty =
      Number(existing.quantity || 0) + 1;

    if (nextQty > stock) {
      alert('Jumlah sudah mencapai stok tersedia.');
      return;
    }

    existing.quantity = nextQty;

  } else {
    guestCart.push({
      ...product,
      quantity: 1
    });
  }

  saveGuestCart();
  openGuestCart();
}

function updateGuestCartBadge() {
  const badge =
    document.getElementById('guestCartBadge');

  if (!badge) return;

  const count = guestCart.reduce(
    (sum, item) =>
      sum + Number(item.quantity || 0),
    0
  );

  badge.textContent = count;
  badge.style.display =
    count > 0 ? 'flex' : 'none';
}

function guestCartAmount() {
  return guestCart.reduce(
    (sum, item) =>
      sum +
      Number(item.price || 0) *
      Number(item.quantity || 0),
    0
  );
}

function renderGuestCart() {
  const box =
    document.getElementById('guestCartContent');

  if (!box) return;

  const total =
    document.getElementById('guestCartTotal');

  const checkout =
    document.getElementById(
      'guestCheckoutButton'
    );

  if (total) {
    total.textContent =
      rupiah(guestCartAmount());
  }

  if (checkout) {
    checkout.disabled =
      guestCart.length === 0;
  }

  if (!guestCart.length) {
    box.innerHTML = `
      <div class="guest-cart-empty">
        Keranjang masih kosong.<br><br>
        Pilih produk yang ingin kamu beli.
      </div>
    `;
    return;
  }

  box.innerHTML = guestCart.map(item => {

    const image =
      item.image_url ||
      item.parent_product_image_url ||
      '/logo-pasar-pintar.jpg';

    return `
      <div class="guest-cart-item">

        <img
          src="${esc(image)}"
          alt="${esc(item.name)}"
          onerror="this.src='/logo-pasar-pintar.jpg'">

        <div class="guest-cart-info">

          <div class="guest-cart-store">
            ${esc(
              item.store_name ||
              'Merchant Pasar Pintar'
            )}
          </div>

          <div class="guest-cart-name">
            ${esc(item.name)}
          </div>

          <div class="guest-cart-price">
            ${rupiah(item.price)}
          </div>

          <div class="guest-cart-actions">

            <div class="guest-qty">

              <button
                type="button"
                onclick="changeGuestQty(
                  '${esc(item.id)}',
                  -1
                )">
                −
              </button>

              <span>
                ${Number(item.quantity || 0)}
              </span>

              <button
                type="button"
                onclick="changeGuestQty(
                  '${esc(item.id)}',
                  1
                )">
                +
              </button>

            </div>

            <button
              type="button"
              class="guest-remove"
              onclick="removeGuestItem(
                '${esc(item.id)}'
              )">
              Hapus
            </button>

          </div>

        </div>

      </div>
    `;
  }).join('');
}

function changeGuestQty(id, delta) {
  const item = guestCart.find(
    x => String(x.id) === String(id)
  );

  if (!item) return;

  const next =
    Number(item.quantity || 0) +
    Number(delta || 0);

  if (next <= 0) {
    removeGuestItem(id);
    return;
  }

  const stock =
    Number(item.stock || 0);

  if (stock > 0 && next > stock) {
    alert('Jumlah melebihi stok tersedia.');
    return;
  }

  item.quantity = next;
  saveGuestCart();
}

function removeGuestItem(id) {
  guestCart = guestCart.filter(
    item => String(item.id) !== String(id)
  );

  saveGuestCart();
}

function openGuestCart() {
  renderGuestCart();

  const overlay =
    document.getElementById(
      'guestCartOverlay'
    );

  if (!overlay) return;

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeGuestCart() {
  const overlay =
    document.getElementById(
      'guestCartOverlay'
    );

  if (!overlay) return;

  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

function guestCartOverlayClick(event) {
  if (
    event.target &&
    event.target.id === 'guestCartOverlay'
  ) {
    closeGuestCart();
  }
}

function continueCheckout() {
  if (!guestCart.length) return;

  if (getToken()) {
    location.href =
      '/customer.html?open=cart';
  } else {
    location.href =
      '/login.html?next=checkout';
  }
}

function goCustomer() {
  if (getToken()) {
    location.href = '/customer.html';
  } else {
    location.href = '/login.html';
  }
}

function goOrders() {
  if (getToken()) {
    location.href = '/orders.html';
  } else {
    location.href = '/login.html?next=orders';
  }
}

function goAccount() {
  if (getToken()) {
    location.href = '/profile.html';
  } else {
    location.href = '/login.html';
  }
}

function updateHeader() {
  if (!getToken()) return;

  document.getElementById(
    'headerActions'
  ).innerHTML = `
    <a href="/orders.html"
       class="btn btn-outline">
       Pesanan
    </a>

    <a href="/profile.html"
       class="btn btn-primary">
       Akun Saya
    </a>
  `;
}

updateGuestCartBadge();
renderGuestCart();
loadProducts();

if(
  new URLSearchParams(
    window.location.search
  ).get('open')==='cart'
){
  window.setTimeout(()=>{
    openGuestCart();
  },100);
}
