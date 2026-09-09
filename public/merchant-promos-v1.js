const token =
  localStorage.getItem('token');

let membership = null;
let promoProducts = [];
let promotions = [];

function requireMerchantRole() {
  try {
    if (!token) {
      throw new Error('TOKEN_MISSING');
    }

    const part =
      token.split('.')[1];

    if (!part) {
      throw new Error('TOKEN_MALFORMED');
    }

    const payload =
      JSON.parse(
        window.atob(
          part
            .replace(/-/g, '+')
            .replace(/_/g, '/')
        )
      );

    if (
      payload.exp &&
      Number(payload.exp) * 1000 <=
        Date.now()
    ) {
      throw new Error('TOKEN_EXPIRED');
    }

    if (Number(payload.role_id) !== 2) {
      throw new Error('ROLE_FORBIDDEN');
    }

    return payload;
  } catch (err) {
    localStorage.removeItem('token');
    location.replace(
      '/login.html?reason=workspace_access'
    );
    return null;
  }
}

const sessionUser =
  requireMerchantRole();

if (!sessionUser) {
  throw new Error(
    'MERCHANT_WORKSPACE_ACCESS_BLOCKED'
  );
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function rupiah(value) {
  return 'Rp ' +
    Number(value || 0)
      .toLocaleString('id-ID');
}

function logout() {
  localStorage.removeItem('token');
  location.replace('/login.html');
}

async function apiFetch(
  url,
  options = {}
) {
  const headers = {
    Authorization:'Bearer ' + token,
    ...(options.headers || {})
  };

  if (
    options.body &&
    !headers['Content-Type']
  ) {
    headers['Content-Type'] =
      'application/json';
  }

  const res =
    await fetch(
      url,
      {
        ...options,
        headers
      }
    );

  if (res.status === 401) {
    logout();
    throw new Error(
      'Sesi telah berakhir'
    );
  }

  const data =
    await res.json()
      .catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data.error ||
      'Permintaan gagal'
    );
  }

  return data;
}

function membershipStatusLabel(status) {
  return ({
    PENDING:'Menunggu Persetujuan',
    APPROVED:'Terdaftar',
    REJECTED:'Perlu Daftar Ulang',
    SUSPENDED:'Ditangguhkan'
  })[status] || status || '-';
}

function promoStatusLabel(status) {
  return ({
    DRAFT:'Draft',
    SUBMITTED:'Menunggu Review',
    APPROVED:'Disetujui',
    ACTIVE:'Aktif',
    ENDED:'Selesai',
    REJECTED:'Ditolak',
    CANCELLED:'Dibatalkan'
  })[status] || status || '-';
}

function formatDate(value) {
  if (!value) return '-';

  return new Intl.DateTimeFormat(
    'id-ID',
    {
      day:'numeric',
      month:'short',
      year:'numeric',
      hour:'2-digit',
      minute:'2-digit'
    }
  ).format(new Date(value));
}

function renderMembership(data) {
  membership =
    data.membership || null;

  if (
    data.merchant &&
    data.merchant.store_name
  ) {
    document.getElementById(
      'storeName'
    ).textContent =
      data.merchant.store_name;
  }

  const title =
    document.getElementById(
      'membershipTitle'
    );

  const description =
    document.getElementById(
      'membershipDescription'
    );

  const action =
    document.getElementById(
      'membershipAction'
    );

  const workspace =
    document.getElementById(
      'approvedWorkspace'
    );

  if (!membership) {
    title.textContent =
      'Gabung Program Promo';

    description.textContent =
      'Daftarkan lapak untuk dapat membuat promo produk.';

    action.innerHTML = `
      <button
        class="promo-primary-button"
        type="button"
        onclick="applyMembership()">
        Gabung Program Promo
      </button>
    `;

    workspace.hidden = true;
    return;
  }

  const status =
    membership.status;

  title.innerHTML = `
    ${membershipStatusLabel(status)}
    <span class="promo-status ${esc(
      String(status).toLowerCase()
    )}">
      ${esc(status)}
    </span>
  `;

  if (status === 'PENDING') {
    description.textContent =
      'Pendaftaran sedang ditinjau oleh Pasar Pintar.';

    action.innerHTML = '';
    workspace.hidden = true;
    return;
  }

  if (status === 'REJECTED') {
    description.textContent =
      membership.rejection_reason
        ? 'Alasan: ' +
          membership.rejection_reason
        : 'Pendaftaran sebelumnya belum disetujui.';

    action.innerHTML = `
      <button
        class="promo-primary-button"
        type="button"
        onclick="applyMembership()">
        Daftar Ulang
      </button>
    `;

    workspace.hidden = true;
    return;
  }

  if (status === 'SUSPENDED') {
    description.textContent =
      membership.suspension_reason
        ? 'Program ditangguhkan: ' +
          membership.suspension_reason
        : 'Akses program promo sedang ditangguhkan.';

    action.innerHTML = '';
    workspace.hidden = true;
    return;
  }

  if (status === 'APPROVED') {
    description.textContent =
      'Lapak dapat membuat dan mengajukan promo produk.';

    action.innerHTML = '';
    workspace.hidden = false;

    loadPromoWorkspace();
  }
}

async function loadMembership() {
  try {
    const data =
      await apiFetch(
        '/api/merchant/promos/v1/membership'
      );

    renderMembership(data);
  } catch (err) {
    document.getElementById(
      'membershipTitle'
    ).textContent =
      'Program promo tidak dapat dimuat';

    document.getElementById(
      'membershipDescription'
    ).textContent =
      err.message;
  }
}

async function applyMembership() {
  const action =
    document.getElementById(
      'membershipAction'
    );

  action.innerHTML = `
    <button
      class="promo-primary-button"
      disabled>
      Mengirim...
    </button>
  `;

  try {
    await apiFetch(
      '/api/merchant/promos/v1/membership/apply',
      {
        method:'POST',
        body:JSON.stringify({})
      }
    );

    await loadMembership();
  } catch (err) {
    action.innerHTML = `
      <div class="promo-error">
        ${esc(err.message)}
      </div>
    `;
  }
}

async function loadPromoWorkspace() {
  await Promise.all([
    loadPromoProducts(),
    loadPromotions()
  ]);
}

async function loadPromoProducts() {
  try {
    const data =
      await apiFetch(
        '/api/merchant/promos/v1/products'
      );

    promoProducts =
      Array.isArray(data.data)
        ? data.data
        : [];

    renderPromoProducts();
  } catch (err) {
    document.getElementById(
      'promoProductList'
    ).innerHTML = `
      <div class="promo-empty">
        ${esc(err.message)}
      </div>
    `;
  }
}

function renderPromoProducts() {
  const box =
    document.getElementById(
      'promoProductList'
    );

  if (!promoProducts.length) {
    box.innerHTML = `
      <div class="promo-empty">
        Belum ada produk aktif yang dapat dipromosikan.
      </div>
    `;
    return;
  }

  box.innerHTML =
    promoProducts.map(product => `
      <label class="promo-product-option">
        <input
          type="checkbox"
          name="promoProduct"
          value="${esc(product.id)}"
          onchange="updateSelectedProductCount()">

        <span class="promo-product-copy">
          <strong>
            ${esc(product.name)}
          </strong>

          <small>
            ${rupiah(product.retail_price ?? product.price)}
            · Stok ${Number(product.stock || 0)}
          </small>
        </span>
      </label>
    `).join('');
}

function updateSelectedProductCount() {
  const count =
    document.querySelectorAll(
      'input[name="promoProduct"]:checked'
    ).length;

  document.getElementById(
    'selectedProductCount'
  ).textContent =
    count + ' dipilih';
}

async function loadPromotions() {
  try {
    const data =
      await apiFetch(
        '/api/merchant/promos/v1'
      );

    promotions =
      Array.isArray(data.data)
        ? data.data
        : [];

    renderPromotions();
    updatePromoStats();
  } catch (err) {
    document.getElementById(
      'promoList'
    ).innerHTML = `
      <div class="promo-empty">
        ${esc(err.message)}
      </div>
    `;
  }
}

function updatePromoStats() {
  const approved =
    promotions.filter(
      p =>
        p.status === 'APPROVED' ||
        p.status === 'ACTIVE'
    ).length;

  const submitted =
    promotions.filter(
      p => p.status === 'SUBMITTED'
    ).length;

  const drafts =
    promotions.filter(
      p => p.status === 'DRAFT'
    ).length;

  document.getElementById(
    'approvedCount'
  ).textContent = approved;

  document.getElementById(
    'submittedCount'
  ).textContent = submitted;

  document.getElementById(
    'draftCount'
  ).textContent = drafts;
}

function renderPromotions() {
  const box =
    document.getElementById(
      'promoList'
    );

  if (!promotions.length) {
    box.innerHTML = `
      <div class="promo-empty promo-empty-large">
        <strong>Belum ada promo</strong>
        <span>
          Buat promo pertama untuk produk lapak Anda.
        </span>
      </div>
    `;
    return;
  }

  box.innerHTML =
    promotions.map(promo => {
      const canSubmit =
        promo.status === 'DRAFT' ||
        promo.status === 'REJECTED';

      const discount =
        promo.promotion_type ===
        'PERCENT'
          ? Number(
              promo.discount_value || 0
            ) + '%'
          : rupiah(
              promo.discount_value
            );

      return `
        <article class="merchant-promo-card">

          <div class="merchant-promo-top">
            <div>
              <span class="promo-eyebrow">
                ${esc(discount)} OFF
              </span>

              <h3>
                ${esc(promo.name)}
              </h3>
            </div>

            <span class="promo-status ${
              esc(
                String(
                  promo.status
                ).toLowerCase()
              )
            }">
              ${esc(
                promoStatusLabel(
                  promo.status
                )
              )}
            </span>
          </div>

          <div class="merchant-promo-meta">
            <span>
              ${Number(
                promo.product_count || 0
              )} produk
            </span>

            <span>
              ${formatDate(
                promo.starts_at
              )}
              –
              ${formatDate(
                promo.ends_at
              )}
            </span>
          </div>

          ${
            promo.status === 'REJECTED' &&
            promo.rejection_reason
              ? `
                <div class="promo-rejection">
                  ${esc(
                    promo.rejection_reason
                  )}
                </div>
              `
              : ''
          }

          ${
            canSubmit
              ? `
                <button
                  class="promo-secondary-button"
                  type="button"
                  onclick="submitPromo(
                    '${esc(promo.id)}'
                  )">
                  Ajukan ke Pasar Pintar
                </button>
              `
              : ''
          }

        </article>
      `;
    }).join('');
}

function openPromoForm() {
  const form =
    document.getElementById(
      'promoFormCard'
    );

  form.hidden = false;

  form.scrollIntoView({
    behavior:'smooth',
    block:'start'
  });
}

function closePromoForm() {
  document.getElementById(
    'promoFormCard'
  ).hidden = true;
}

async function createPromo(event) {
  event.preventDefault();

  const selected =
    Array.from(
      document.querySelectorAll(
        'input[name="promoProduct"]:checked'
      )
    ).map(input => input.value);

  const message =
    document.getElementById(
      'promoFormMessage'
    );

  const button =
    document.getElementById(
      'savePromoButton'
    );

  if (!selected.length) {
    message.textContent =
      'Pilih minimal satu produk.';
    message.className =
      'promo-message error';
    return;
  }

  const start =
    document.getElementById(
      'promoStart'
    ).value;

  const end =
    document.getElementById(
      'promoEnd'
    ).value;

  if (
    !start ||
    !end ||
    new Date(end) <= new Date(start)
  ) {
    message.textContent =
      'Waktu selesai harus setelah waktu mulai.';
    message.className =
      'promo-message error';
    return;
  }

  const type =
    document.getElementById(
      'promoType'
    ).value;

  const discount =
    Number(
      document.getElementById(
        'promoDiscount'
      ).value
    );

  if (
    !Number.isFinite(discount) ||
    discount <= 0
  ) {
    message.textContent =
      'Nilai diskon harus lebih dari 0.';
    message.className =
      'promo-message error';
    return;
  }

  if (
    type === 'PERCENT' &&
    discount >= 100
  ) {
    message.textContent =
      'Diskon persen harus kurang dari 100%.';
    message.className =
      'promo-message error';
    return;
  }

  button.disabled = true;
  button.textContent =
    'Menyimpan...';

  message.textContent = '';

  try {
    await apiFetch(
      '/api/merchant/promos/v1',
      {
        method:'POST',
        body:JSON.stringify({
          name:
            document.getElementById(
              'promoName'
            ).value.trim(),

          description:
            document.getElementById(
              'promoDescription'
            ).value.trim(),

          promotion_type:type,

          discount_value:discount,

          starts_at:
            new Date(start)
              .toISOString(),

          ends_at:
            new Date(end)
              .toISOString(),

          product_ids:selected
        })
      }
    );

    message.textContent =
      'Draft promo berhasil dibuat.';
    message.className =
      'promo-message success';

    document.getElementById(
      'promoForm'
    ).reset();

    updateSelectedProductCount();

    await loadPromotions();

  } catch (err) {
    message.textContent =
      err.message;

    message.className =
      'promo-message error';

  } finally {
    button.disabled = false;
    button.textContent =
      'Simpan Draft';
  }
}

async function submitPromo(id) {
  const confirmed =
    window.confirm(
      'Ajukan promo ini ke Pasar Pintar untuk ditinjau?'
    );

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(
      '/api/merchant/promos/v1/' +
      encodeURIComponent(id) +
      '/submit',
      {
        method:'POST',
        body:JSON.stringify({})
      }
    );

    await loadPromotions();

  } catch (err) {
    window.alert(
      err.message
    );
  }
}

loadMembership();
