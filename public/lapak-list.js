let stores = [];

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function openStore(merchantId) {
  location.href =
    '/lapak.html?id=' +
    encodeURIComponent(merchantId);
}

function renderStores() {
  const grid =
    document.getElementById(
      'storeDirectoryGrid'
    );

  const count =
    document.getElementById(
      'storeResultCount'
    );

  const input =
    document.getElementById(
      'storeSearchInput'
    );

  if (!grid) return;

  const q =
    String(input?.value || '')
      .trim()
      .toLowerCase();

  const filtered =
    stores.filter(store => {
      const searchable = [
        store.store_name,
        store.stall_name,
        store.stall_number,
        store.market_name,
        store.address
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return !q || searchable.includes(q);
    });

  if (count) {
    count.textContent =
      filtered.length + ' lapak';
  }

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="directory-empty">
        ${
          q
            ? 'Lapak yang dicari belum ditemukan.'
            : 'Belum ada lapak aktif.'
        }
      </div>
    `;
    return;
  }

  grid.innerHTML =
    filtered.map(store => `
      <article class="directory-card">

        <div class="directory-card-logo">
          <img
            src="${esc(
              store.logo_url ||
              "/logo-pasar-pintar.jpg"
            )}"
            alt="${esc(store.store_name || "Lapak")}"
            loading="lazy"
            onerror="this.src='/logo-pasar-pintar.jpg'">
        </div>

        <div class="directory-card-body">

          <div class="directory-card-market">
            ${esc(
              store.market_name ||
              'Pasar Sederhana'
            )}
          </div>

          <h3>
            ${esc(
              store.store_name ||
              store.stall_name ||
              'Lapak Pasar'
            )}
          </h3>

          <div class="directory-card-meta">

            <span>
              ${Number(
                store.product_count || 0
              )} produk
            </span>

            <span>
              ${esc(
                store.stall_number
                  ? 'Jongko ' +
                    store.stall_number
                  : 'Lapak Pasar'
              )}
            </span>

          </div>

          <button
            type="button"
            class="directory-open-button"
            onclick="openStore(
              '${esc(store.merchant_id)}'
            )">
            Lihat Lapak
          </button>

        </div>

      </article>
    `).join('');
}

async function loadStores() {
  const grid =
    document.getElementById(
      'storeDirectoryGrid'
    );

  try {
    const response =
      await fetch(
        '/api/public/market/stores'
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        'Gagal memuat daftar lapak'
      );
    }

    stores =
      Array.isArray(data.data)
        ? data.data
        : [];

    renderStores();

  } catch (err) {
    console.error(err);

    if (grid) {
      grid.innerHTML = `
        <div class="directory-empty">
          Daftar lapak sedang tidak dapat dimuat.
        </div>
      `;
    }

    const count =
      document.getElementById(
        'storeResultCount'
      );

    if (count) {
      count.textContent = '';
    }
  }
}

document
  .getElementById('storeSearchForm')
  ?.addEventListener(
    'submit',
    event => {
      event.preventDefault();
      renderStores();
    }
  );

document
  .getElementById('storeSearchInput')
  ?.addEventListener(
    'input',
    renderStores
  );

loadStores();
