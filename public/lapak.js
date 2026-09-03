let products = [];
let selectedCategory = 'SEMUA';
let guestCart = [];
let currentStore = null;

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

function getToken() {
  return localStorage.getItem('token');
}

function merchantIdFromUrl() {
  return new URLSearchParams(
    location.search
  ).get('id');
}

function cartQty(productId) {
  const item = guestCart.find(
    x => String(x.id) === String(productId)
  );
  return item
    ? Number(item.quantity || 0)
    : 0;
}

function saveGuestCart() {
  localStorage.setItem(
    'pp_cart',
    JSON.stringify(guestCart)
  );
  updateLapakCartBadge();
  renderLapakCart();
  renderProducts();
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
    item =>
      String(item.id) === String(productId)
  );

  if (existing) {
    const next =
      Number(existing.quantity || 0) + 1;

    if (next > stock) {
      alert(
        'Jumlah sudah mencapai stok tersedia.'
      );
      return;
    }

    existing.quantity = next;
  } else {
    guestCart.push({
      ...product,
      quantity: 1
    });
  }

  saveGuestCart();
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

  const stock = Number(item.stock || 0);

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

function productActionHtml(product) {
  const qty = cartQty(product.id);

  if (qty > 0) {
    return `
      <div class="card-qty-control">
        <button
          type="button"
          onclick="changeGuestQty(
            '${esc(product.id)}',
            -1
          )">
          −
        </button>

        <span>${qty}</span>

        <button
          type="button"
          onclick="changeGuestQty(
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
      onclick="addGuestProduct(
        '${esc(product.id)}'
      )">
      Tambah
    </button>
  `;
}

function openProductDetail(productId) {
  location.href =
    '/product.html?id=' +
    encodeURIComponent(productId);
}

function renderCategories() {
  const box =
    document.getElementById(
      'lapakCategoryGrid'
    );

  const categories =
    Array.isArray(currentStore?.categories)
      ? currentStore.categories
      : [];

  box.innerHTML = `
    <button
      type="button"
      class="lapak-category ${
        selectedCategory === 'SEMUA'
          ? 'active'
          : ''
      }"
      data-category="SEMUA">
      Semua
      <span>${products.length}</span>
    </button>

    ${categories.map(category => `
      <button
        type="button"
        class="lapak-category ${
          selectedCategory ===
          String(category.id)
            ? 'active'
            : ''
        }"
        data-category="${esc(category.id)}">
        ${esc(category.name)}
        <span>
          ${Number(category.product_count || 0)}
        </span>
      </button>
    `).join('')}
  `;

  box
    .querySelectorAll('.lapak-category')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          selectedCategory =
            button.dataset.category;
          renderCategories();
          renderProducts();
        }
      );
    });
}

function renderProducts() {
  const input =
    document.getElementById(
      'lapakSearchInput'
    );

  const q =
    String(input?.value || '')
      .trim()
      .toLowerCase();

  const filtered =
    products.filter(product => {
      const categoryOk =
        selectedCategory === 'SEMUA' ||
        String(product.category_id) ===
          String(selectedCategory);

      const searchable = [
        product.name,
        product.description,
        product.category_name,
        product.parent_category_name
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return (
        categoryOk &&
        (!q || searchable.includes(q))
      );
    });

  document.getElementById(
    'lapakResultCount'
  ).textContent =
    filtered.length + ' produk';

  document.getElementById(
    'lapakProductSubtitle'
  ).textContent =
    currentStore
      ? 'Produk dari ' +
        currentStore.store_name
      : '';

  const grid =
    document.getElementById(
      'lapakProductGrid'
    );

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty">
        Produk tidak ditemukan.
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
          ? Number(product.pack_size_value) +
            ' ' +
            product.pack_size_unit
          : (product.selling_unit || '');

      return `
        <article class="product-card">
          <div
            class="product-image-frame"
            role="link"
            tabindex="0"
            onclick="openProductDetail(
              '${esc(product.id)}'
            )">

            <img
              src="${esc(image)}"
              alt="${esc(product.name)}"
              loading="lazy"
              onerror="
                this.src='/logo-pasar-pintar.jpg'
              ">
          </div>

          <div class="product-body">
            <div class="store">
              ${esc(product.store_name)}
            </div>

            <div
              class="product-name"
              onclick="openProductDetail(
                '${esc(product.id)}'
              )">
              ${esc(product.name)}
            </div>

            <div class="meta">
              ${esc(
                product.category_name || ''
              )}
              ${
                unit
                  ? ' · ' + esc(unit)
                  : ''
              }
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

function updateLapakCartBadge() {
  const count = guestCart.reduce(
    (sum, item) =>
      sum + Number(item.quantity || 0),
    0
  );

  document.getElementById(
    'lapakCartCount'
  ).textContent = count;
}

function lapakCartAmount() {
  return guestCart.reduce(
    (sum, item) =>
      sum +
      Number(item.price || 0) *
      Number(item.quantity || 0),
    0
  );
}

function renderLapakCart() {
  const box =
    document.getElementById(
      'lapakCartContent'
    );

  document.getElementById(
    'lapakCartTotal'
  ).textContent =
    rupiah(lapakCartAmount());

  if (!guestCart.length) {
    box.innerHTML = `
      <div class="empty">
        Keranjang masih kosong.
      </div>
    `;
    return;
  }

  const groups = new Map();

  guestCart.forEach(item => {
    const merchantId =
      String(item.merchant_id || 'unknown');

    if (!groups.has(merchantId)) {
      groups.set(merchantId, {
        store_name:
          item.store_name ||
          'Merchant Pasar Pintar',
        items: []
      });
    }

    groups.get(merchantId)
      .items.push(item);
  });

  box.innerHTML =
    Array.from(groups.values())
      .map(group => `
        <section class="lapak-cart-group">

          <strong>
            ${esc(group.store_name)}
          </strong>

          ${group.items.map(item => `
            <div class="lapak-cart-item">
              <div>
                <div>
                  ${esc(item.name)}
                </div>

                <small>
                  ${rupiah(item.price)}
                </small>
              </div>

              <div class="lapak-cart-qty">
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
            </div>
          `).join('')}

        </section>
      `).join('');
}

function openLapakCart() {
  renderLapakCart();

  document.getElementById(
    'lapakCartOverlay'
  ).classList.add('open');

  document.body.style.overflow =
    'hidden';
}

function closeLapakCart() {
  document.getElementById(
    'lapakCartOverlay'
  ).classList.remove('open');

  document.body.style.overflow = '';
}

function lapakCartOverlayClick(event) {
  if (
    event.target?.id ===
    'lapakCartOverlay'
  ) {
    closeLapakCart();
  }
}

function continueLapakCheckout() {
  if (!guestCart.length) return;

  if (!getToken()) {
    location.href =
      '/login.html?next=checkout';
    return;
  }

  closeLapakCart();

  if (
    typeof openMarketplaceCheckout ===
    'function'
  ) {
    openMarketplaceCheckout();
    return;
  }

  location.href = '/';
}

async function loadStorefront() {
  const merchantId = merchantIdFromUrl();

  if (!merchantId) {
    document.getElementById(
      'lapakName'
    ).textContent =
      'Lapak tidak ditemukan';

    return;
  }

  try {
    const [
      storeResponse,
      productsResponse
    ] = await Promise.all([
      fetch(
        '/api/public/market/stores/' +
        encodeURIComponent(merchantId)
      ),
      fetch('/api/public/catalog/products')
    ]);

    const storeData =
      await storeResponse.json();

    const productsData =
      await productsResponse.json();

    if (!storeResponse.ok) {
      throw new Error(
        storeData.error ||
        'Lapak tidak ditemukan'
      );
    }

    if (!productsResponse.ok) {
      throw new Error(
        productsData.error ||
        'Gagal memuat produk'
      );
    }

    currentStore = storeData.data;

    const catalog =
      Array.isArray(productsData.data)
        ? productsData.data
        : [];

    products = catalog.filter(
      product =>
        String(product.merchant_id) ===
        String(merchantId)
    );

    document.title =
      currentStore.store_name +
      ' - Pasar Pintar';

    document.getElementById(
      'lapakMarket'
    ).textContent =
      currentStore.market_name ||
      'Pasar Sederhana';

    document.getElementById(
      'lapakName'
    ).textContent =
      currentStore.store_name;

    document.getElementById(
      'lapakMeta'
    ).textContent =
      Number(
        currentStore.product_count || 0
      ) +
      ' produk' +
      (
        currentStore.stall_number
          ? ' · Jongko ' +
            currentStore.stall_number
          : ''
      );

    document.getElementById(
      'lapakAddress'
    ).textContent =
      currentStore.address || '';

    renderCategories();
    renderProducts();

  } catch (err) {
    console.error(err);

    document.getElementById(
      'lapakName'
    ).textContent =
      'Lapak tidak dapat dimuat';

    document.getElementById(
      'lapakProductGrid'
    ).innerHTML = `
      <div class="empty">
        ${esc(err.message)}
      </div>
    `;
  }
}

document.getElementById(
  'lapakSearchForm'
).addEventListener(
  'submit',
  event => {
    event.preventDefault();
    renderProducts();
  }
);

document.getElementById(
  'lapakSearchInput'
).addEventListener(
  'input',
  renderProducts
);

updateLapakCartBadge();
renderLapakCart();
loadStorefront();
