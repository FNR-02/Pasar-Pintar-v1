let products = [];
let selectedCategory = 'SEMUA';
let guestCart = [];
let wishlist = [];

try {
  wishlist = JSON.parse(
    localStorage.getItem('pp_wishlist') || '[]'
  );

  if (!Array.isArray(wishlist)) {
    wishlist = [];
  }
} catch {
  wishlist = [];
}

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

  const grid =
    document.getElementById('productGrid');

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty">
        Produk belum tersedia untuk kategori
        atau pencarian ini.
      </div>
    `;
    return;
  }

  grid.innerHTML =
    filtered.map(product => {
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

      const wished =
        isWishlisted(product.id);

      return `
        <article class="product-card">

          <div
            class="product-image-frame product-detail-link"
            role="link"
            tabindex="0"
            onclick="openProductDetail('${esc(product.id)}')"
            onkeydown="if(event.key==='Enter'){
              openProductDetail('${esc(product.id)}');
            }">
            <img
              src="${esc(image)}"
              alt="${esc(product.name)}"
              loading="lazy"
              onerror="this.src='/logo-pasar-pintar.jpg'">

            <button
              type="button"
              class="wishlist-button ${
                wished ? 'active' : ''
              }"
              aria-label="Wishlist"
              onclick="event.stopPropagation();
                toggleWishlist('${esc(product.id)}')">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true">
                <path
                  d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z">
                </path>
              </svg>
            </button>
          </div>

          <div class="product-body">
            <div class="store">
              ${esc(
                product.store_name ||
                'Merchant Pasar Pintar'
              )}
            </div>

            <div
              class="product-name product-detail-link"
              role="link"
              tabindex="0"
              onclick="openProductDetail('${esc(product.id)}')"
              onkeydown="if(event.key==='Enter'){
                openProductDetail('${esc(product.id)}');
              }">
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
              ${
                Number(product.stock || 0) > 0
                  ? 'Tersedia'
                  : 'Stok habis'
              }
            </div>

            ${productActionHtml(product)}
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
    renderHomePromoProducts();

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
  renderProducts();
  renderHomePromoProducts();
  if (
    document.getElementById(
      'wishlistOverlay'
    )?.classList.contains('open')
  ) {
    renderWishlist();
  }
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

  const groups = new Map();

  guestCart.forEach(item => {
    const merchantId =
      String(
        item.merchant_id ||
        'unknown'
      );

    if (!groups.has(merchantId)) {
      groups.set(merchantId, {
        merchant_id: merchantId,
        store_name:
          item.store_name ||
          'Merchant Pasar Pintar',
        items: []
      });
    }

    groups.get(merchantId).items.push(item);
  });

  box.innerHTML =
    Array.from(groups.values())
      .map(group => {
        const subtotal =
          group.items.reduce(
            (sum, item) =>
              sum +
              Number(item.price || 0) *
              Number(item.quantity || 0),
            0
          );

        const itemsHtml =
          group.items.map(item => {
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

        return `
          <section class="guest-merchant-group">
            <div class="guest-merchant-head">
              <div>
                <div class="guest-merchant-label">
                  Toko
                </div>
                <strong>
                  ${esc(group.store_name)}
                </strong>
              </div>

              <span>
                ${group.items.length} produk
              </span>
            </div>

            <div class="guest-merchant-items">
              ${itemsHtml}
            </div>

            <div class="guest-merchant-subtotal">
              <span>Subtotal toko</span>
              <strong>${rupiah(subtotal)}</strong>
            </div>
          </section>
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
  renderProducts();
  renderHomePromoProducts();
  if (
    document.getElementById(
      'wishlistOverlay'
    )?.classList.contains('open')
  ) {
    renderWishlist();
  }
}

function removeGuestItem(id) {
  guestCart = guestCart.filter(
    item => String(item.id) !== String(id)
  );

  saveGuestCart();
  renderProducts();
  renderHomePromoProducts();
  if (
    document.getElementById(
      'wishlistOverlay'
    )?.classList.contains('open')
  ) {
    renderWishlist();
  }
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
    if (
      typeof openMarketplaceCheckout ===
      'function'
    ) {
      openMarketplaceCheckout();
    }
  } else {
    location.href =
      '/login.html?next=checkout';
  }
}

function goCustomer() {
  if (getToken()) {
    location.href = '/';
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
updateWishlistBadge();
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

function renderHomePromoProducts() {
  const box =
    document.getElementById('promoGrid');

  if (!box) return;

  const featured =
    products
      .filter(product =>
        Number(product.stock || 0) > 0
      )
      .slice(0, 8);

  if (!featured.length) {
    box.innerHTML = `
      <div class="empty">
        Produk pilihan belum tersedia.
      </div>
    `;
    return;
  }

  box.innerHTML =
    featured.map(product => {
      const image =
        product.image_url ||
        product.parent_product_image_url ||
        '/logo-pasar-pintar.jpg';

      const wished =
        isWishlisted(product.id);

      return `
        <article class="promo-card">

          <div
            class="product-image-frame product-detail-link"
            role="link"
            tabindex="0"
            onclick="openProductDetail('${esc(product.id)}')"
            onkeydown="if(event.key==='Enter'){
              openProductDetail('${esc(product.id)}');
            }">
            <img
              src="${esc(image)}"
              alt="${esc(product.name)}"
              loading="lazy"
              onerror="this.src='/logo-pasar-pintar.jpg'">

            <button
              type="button"
              class="wishlist-button ${
                wished ? 'active' : ''
              }"
              aria-label="Wishlist"
              onclick="event.stopPropagation();
                toggleWishlist('${esc(product.id)}')">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true">
                <path
                  d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z">
                </path>
              </svg>
            </button>
          </div>

          <div class="promo-body">
            <div class="promo-store">
              ${esc(
                product.store_name ||
                'Merchant Pasar Pintar'
              )}
            </div>

            <div
              class="promo-name product-detail-link"
              role="link"
              tabindex="0"
              onclick="openProductDetail('${esc(product.id)}')"
              onkeydown="if(event.key==='Enter'){
                openProductDetail('${esc(product.id)}');
              }">
              ${esc(product.name)}
            </div>

            <div class="promo-price">
              ${rupiah(product.price)}
            </div>

            ${productActionHtml(product)}
          </div>
        </article>
      `;
    }).join('');
}
function initMarketSlider() {
  const slides =
    Array.from(
      document.querySelectorAll(
        '.market-slide'
      )
    );

  const dots =
    Array.from(
      document.querySelectorAll(
        '.market-slider-dot'
      )
    );

  if (!slides.length) return;

  let current = 0;

  function show(index) {
    current =
      (index + slides.length) %
      slides.length;

    slides.forEach(
      (slide, i) =>
        slide.classList.toggle(
          'active',
          i === current
        )
    );

    dots.forEach(
      (dot, i) =>
        dot.classList.toggle(
          'active',
          i === current
        )
    );
  }

  dots.forEach((dot, index) => {
    dot.addEventListener(
      'click',
      () => show(index)
    );
  });

  window.setInterval(
    () => show(current + 1),
    5000
  );
}

window.addEventListener(
  'load',
  initMarketSlider
);

function cartQty(productId) {
  const item = guestCart.find(
    x => String(x.id) === String(productId)
  );

  return item
    ? Number(item.quantity || 0)
    : 0;
}

function isWishlisted(productId) {
  return wishlist.some(
    id => String(id) === String(productId)
  );
}

function saveWishlist() {
  localStorage.setItem(
    'pp_wishlist',
    JSON.stringify(wishlist)
  );

  updateWishlistBadge();
}

function toggleWishlist(productId) {
  const id = String(productId);

  if (isWishlisted(id)) {
    wishlist = wishlist.filter(
      x => String(x) !== id
    );
  } else {
    wishlist.push(id);
  }

  saveWishlist();
  renderProducts();
  renderHomePromoProducts();

  if (
    document.getElementById(
      'wishlistOverlay'
    )?.classList.contains('open')
  ) {
    renderWishlist();
  }
}

function updateWishlistBadge() {
  const badge =
    document.getElementById(
      'wishlistBadge'
    );

  if (!badge) return;

  badge.textContent =
    wishlist.length;

  badge.style.display =
    wishlist.length
      ? 'flex'
      : 'none';
}

function productActionHtml(product) {
  const qty =
    cartQty(product.id);

  if (qty > 0) {
    return `
      <div class="card-qty-control">
        <button
          type="button"
          onclick="event.stopPropagation();changeGuestQty(
            '${esc(product.id)}',
            -1
          )">
          −
        </button>

        <span>${qty}</span>

        <button
          type="button"
          onclick="event.stopPropagation();changeGuestQty(
            '${esc(product.id)}',
            1
          )">
          +
        </button>
      </div>
    `;
  }

  return `
    <button
      type="button"
      class="product-button"
      onclick="event.stopPropagation();addGuestProduct(
        '${esc(product.id)}'
      )">
      Tambah
    </button>
  `;
}

function renderWishlist() {
  const box =
    document.getElementById(
      'wishlistContent'
    );

  if (!box) return;

  const items =
    wishlist
      .map(id =>
        products.find(
          product =>
            String(product.id) ===
            String(id)
        )
      )
      .filter(Boolean);

  if (!items.length) {
    box.innerHTML = `
      <div class="wishlist-empty">
        <strong>
          Wishlist masih kosong
        </strong>
        <p>
          Tekan ikon hati pada produk
          yang ingin kamu simpan.
        </p>
      </div>
    `;
    return;
  }

  box.innerHTML =
    items.map(product => {
      const image =
        product.image_url ||
        product.parent_product_image_url ||
        '/logo-pasar-pintar.jpg';

      return `
        <article class="wishlist-item">

          <div class="wishlist-item-image">
            <img
              src="${esc(image)}"
              alt="${esc(product.name)}"
              loading="lazy"
              onerror="this.src='/logo-pasar-pintar.jpg'">
          </div>

          <div class="wishlist-item-info">

            <div class="wishlist-item-store">
              ${esc(
                product.store_name ||
                'Merchant Pasar Pintar'
              )}
            </div>

            <div class="wishlist-item-name">
              ${esc(product.name)}
            </div>

            <div class="wishlist-item-price">
              ${rupiah(product.price)}
            </div>

            <div class="wishlist-item-actions">

              <button
                type="button"
                class="wishlist-remove"
                onclick="toggleWishlist(
                  '${esc(product.id)}'
                )">
                Hapus
              </button>

              <div class="wishlist-cart-action">
                ${productActionHtml(product)}
              </div>

            </div>
          </div>
        </article>
      `;
    }).join('');
}

function openWishlist() {
  renderWishlist();

  const overlay =
    document.getElementById(
      'wishlistOverlay'
    );

  if (!overlay) return;

  overlay.classList.add('open');
  document.body.style.overflow =
    'hidden';
}

function closeWishlist() {
  const overlay =
    document.getElementById(
      'wishlistOverlay'
    );

  if (!overlay) return;

  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

function wishlistOverlayClick(event) {
  if (
    event.target &&
    event.target.id ===
      'wishlistOverlay'
  ) {
    closeWishlist();
  }
}

function openProductDetail(productId) {
  if (!productId) return;

  window.location.href =
    '/product.html?id=' +
    encodeURIComponent(productId);
}

function syncMarketplaceLocalState() {
  try {
    const storedCart = JSON.parse(
      localStorage.getItem('pp_cart') || '[]'
    );

    guestCart =
      Array.isArray(storedCart)
        ? storedCart
        : [];
  } catch {
    guestCart = [];
  }

  try {
    const storedWishlist = JSON.parse(
      localStorage.getItem('pp_wishlist') || '[]'
    );

    wishlist =
      Array.isArray(storedWishlist)
        ? storedWishlist
        : [];
  } catch {
    wishlist = [];
  }

  updateGuestCartBadge();
  updateWishlistBadge();

  renderProducts();
  renderHomePromoProducts();
  renderGuestCart();

  if (
    document.getElementById(
      'wishlistOverlay'
    )?.classList.contains('open')
  ) {
    renderWishlist();
  }
}

window.addEventListener(
  'pageshow',
  () => {
    syncMarketplaceLocalState();
  }
);
