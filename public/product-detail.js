let detailProduct = null;
let detailCart = [];
let detailWishlist = [];

try {
  detailCart = JSON.parse(
    localStorage.getItem('pp_cart') || '[]'
  );
  if (!Array.isArray(detailCart)) {
    detailCart = [];
  }
} catch {
  detailCart = [];
}

try {
  detailWishlist = JSON.parse(
    localStorage.getItem('pp_wishlist') || '[]'
  );
  if (!Array.isArray(detailWishlist)) {
    detailWishlist = [];
  }
} catch {
  detailWishlist = [];
}

function detailRupiah(value) {
  return new Intl.NumberFormat(
    'id-ID',
    {
      style:'currency',
      currency:'IDR',
      maximumFractionDigits:0
    }
  ).format(Number(value || 0));
}

function getProductId() {
  return new URLSearchParams(
    location.search
  ).get('id');
}

function detailQty() {
  if (!detailProduct) return 0;

  const item = detailCart.find(
    x =>
      String(x.id) ===
      String(detailProduct.id)
  );

  return item
    ? Number(item.quantity || 0)
    : 0;
}

function saveDetailCart() {
  localStorage.setItem(
    'pp_cart',
    JSON.stringify(detailCart)
  );

  renderDetailAction();
  renderDetailCartBadge();
}

function renderDetailCartBadge() {
  const badge =
    document.getElementById(
      'detailCartBadge'
    );

  if (!badge) return;

  const count =
    detailCart.reduce(
      (sum,item) =>
        sum +
        Number(item.quantity || 0),
      0
    );

  badge.textContent = count;
  badge.style.display =
    count > 0 ? 'flex' : 'none';
}

function addDetailProduct() {
  if (!detailProduct) return;

  const stock =
    Number(detailProduct.stock || 0);

  if (stock <= 0) return;

  const existing =
    detailCart.find(
      x =>
        String(x.id) ===
        String(detailProduct.id)
    );

  if (existing) {
    if (
      Number(existing.quantity || 0) >=
      stock
    ) {
      return;
    }

    existing.quantity =
      Number(existing.quantity || 0) + 1;
  } else {
    detailCart.push({
      ...detailProduct,
      quantity:1
    });
  }

  saveDetailCart();
}

function changeDetailQty(delta) {
  if (!detailProduct) return;

  const item =
    detailCart.find(
      x =>
        String(x.id) ===
        String(detailProduct.id)
    );

  if (!item) {
    if (delta > 0) {
      addDetailProduct();
    }
    return;
  }

  const next =
    Number(item.quantity || 0) +
    Number(delta || 0);

  if (next <= 0) {
    detailCart =
      detailCart.filter(
        x =>
          String(x.id) !==
          String(detailProduct.id)
      );

    saveDetailCart();
    return;
  }

  const stock =
    Number(detailProduct.stock || 0);

  if (next > stock) return;

  item.quantity = next;
  saveDetailCart();
}

function renderDetailAction() {
  const box =
    document.getElementById(
      'detailAction'
    );

  if (!box || !detailProduct) return;

  const stock =
    Number(detailProduct.stock || 0);

  const qty = detailQty();

  if (stock <= 0) {
    box.innerHTML = `
      <button
        class="detail-add-button"
        type="button"
        disabled>
        Stok Habis
      </button>
    `;
    return;
  }

  if (qty <= 0) {
    box.innerHTML = `
      <button
        class="detail-add-button"
        type="button"
        onclick="addDetailProduct()">
        Tambah ke Keranjang
      </button>
    `;
    return;
  }

  box.innerHTML = `
    <div class="detail-qty">

      <button
        type="button"
        onclick="changeDetailQty(-1)">
        −
      </button>

      <strong>${qty}</strong>

      <button
        type="button"
        onclick="changeDetailQty(1)">
        +
      </button>

    </div>
  `;
}

function isDetailWishlisted() {
  if (!detailProduct) return false;

  return detailWishlist.some(
    id =>
      String(id) ===
      String(detailProduct.id)
  );
}

function renderDetailWishlist() {
  const button =
    document.getElementById(
      'detailWishlistButton'
    );

  if (!button) return;

  button.classList.toggle(
    'active',
    isDetailWishlisted()
  );
}

function toggleDetailWishlist() {
  if (!detailProduct) return;

  const id =
    String(detailProduct.id);

  if (isDetailWishlisted()) {
    detailWishlist =
      detailWishlist.filter(
        x => String(x) !== id
      );
  } else {
    detailWishlist.push(id);
  }

  localStorage.setItem(
    'pp_wishlist',
    JSON.stringify(detailWishlist)
  );

  renderDetailWishlist();
}

function renderDetail(product) {
  detailProduct = product;

  const image =
    product.image_url ||
    product.parent_product_image_url ||
    '/logo-pasar-pintar.jpg';

  const imageEl =
    document.getElementById(
      'detailImage'
    );

  imageEl.src = image;
  imageEl.alt = product.name || 'Produk';

  imageEl.onerror = () => {
    imageEl.src =
      '/logo-pasar-pintar.jpg';
  };

  document.getElementById(
    'detailMarket'
  ).textContent =
    product.market_name ||
    'Pasar Pintar';

  document.getElementById(
    'detailName'
  ).textContent =
    product.name || 'Produk';

  document.getElementById(
    'detailPrice'
  ).textContent =
    detailRupiah(product.price);

  const stock =
    Number(product.stock || 0);

  const status =
    document.getElementById(
      'detailStockStatus'
    );

  status.textContent =
    stock > 0
      ? 'TERSEDIA'
      : 'HABIS';

  status.classList.toggle(
    'empty',
    stock <= 0
  );

  document.getElementById(
    'detailStock'
  ).textContent =
    stock > 0
      ? `Stok ${stock}`
      : 'Stok tidak tersedia';

  const pack =
    product.pack_size_value &&
    product.pack_size_unit
      ? `${Number(
          product.pack_size_value
        )} ${product.pack_size_unit}`
      : '';

  document.getElementById(
    'detailUnit'
  ).textContent =
    pack
      ? `${product.selling_unit || ''} • Isi ${pack}`
      : (product.selling_unit || '');

  document.getElementById(
    'detailCategory'
  ).textContent =
    product.category_name ||
    product.parent_category_name ||
    '-';

  document.getElementById(
    'detailSellingUnit'
  ).textContent =
    product.selling_unit || '-';

  const packRow =
    document.getElementById(
      'detailPackRow'
    );

  if (pack) {
    document.getElementById(
      'detailPack'
    ).textContent = pack;

    packRow.hidden = false;
  } else {
    packRow.hidden = true;
  }

  document.getElementById(
    'detailDescription'
  ).textContent =
    product.description ||
    'Belum ada deskripsi produk.';

  document.getElementById(
    'detailStore'
  ).textContent =
    product.store_name ||
    'Merchant Pasar Pintar';

  const stall =
    [
      product.stall_name,
      product.stall_number
        ? `No. ${product.stall_number}`
        : ''
    ]
      .filter(Boolean)
      .join(' • ');

  document.getElementById(
    'detailStall'
  ).textContent =
    stall ||
    product.market_name ||
    '';

  document.getElementById(
    'detailAddress'
  ).textContent =
    product.merchant_address || '';

  document.title =
    `${product.name} - Pasar Pintar`;

  document.getElementById(
    'productLoading'
  ).hidden = true;

  document.getElementById(
    'productDetail'
  ).hidden = false;

  document.getElementById(
    'detailCartBar'
  ).hidden = false;

  renderDetailWishlist();
  renderDetailAction();
  renderDetailCartBadge();
}

async function loadProductDetail() {
  const id = getProductId();

  if (!id) {
    showDetailError(
      'Produk tidak ditemukan.'
    );
    return;
  }

  try {
    const response =
      await fetch(
        '/api/public/catalog/products/' +
        encodeURIComponent(id)
      );

    const result =
      await response.json();

    if (!response.ok) {
      throw new Error(
        result.error ||
        'Gagal memuat produk'
      );
    }

    renderDetail(result.data);

  } catch (err) {
    showDetailError(err.message);
  }
}

function showDetailError(message) {
  document.getElementById(
    'productLoading'
  ).hidden = true;

  const error =
    document.getElementById(
      'productError'
    );

  error.textContent = message;
  error.hidden = false;
}

function goBack() {
  if (history.length > 1) {
    history.back();
  } else {
    location.href = '/';
  }
}

function goToCart() {
  location.href = '/?open=cart';
}

renderDetailCartBadge();
loadProductDetail();
