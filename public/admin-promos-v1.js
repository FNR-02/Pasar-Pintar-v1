const token =
  localStorage.getItem('token');

let memberships = [];
let promotions = [];
let toastTimer = null;

function requireAdminRole() {
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

    if (Number(payload.role_id) !== 4) {
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
  requireAdminRole();

if (!sessionUser) {
  throw new Error(
    'ADMIN_PROMO_ACCESS_BLOCKED'
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

function formatDate(value) {
  if (!value) {
    return '-';
  }

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

function membershipStatusLabel(status) {
  return ({
    PENDING:'Menunggu Review',
    APPROVED:'Disetujui',
    REJECTED:'Ditolak',
    SUSPENDED:'Ditangguhkan'
  })[status] || status || '-';
}

function promotionStatusLabel(status) {
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

function rupiah(value) {
  return 'Rp ' +
    Number(value || 0)
      .toLocaleString('id-ID');
}

function showToast(
  message,
  type = 'success'
) {
  const toast =
    document.getElementById(
      'promoAdminToast'
    );

  toast.textContent = message;
  toast.className =
    'promo-admin-toast show ' +
    type;

  clearTimeout(toastTimer);

  toastTimer =
    setTimeout(() => {
      toast.className =
        'promo-admin-toast';
    }, 2800);
}

async function apiFetch(
  url,
  options = {}
) {
  const headers = {
    Authorization:
      'Bearer ' + token,
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
    localStorage.removeItem('token');
    location.replace('/login.html');

    throw new Error(
      'Sesi admin telah berakhir'
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

function updateStats() {
  const pendingMembership =
    memberships.filter(
      row => row.status === 'PENDING'
    ).length;

  const pendingPromotion =
    promotions.filter(
      row => row.status === 'SUBMITTED'
    ).length;

  const approvedPromotion =
    promotions.filter(
      row =>
        row.status === 'APPROVED' ||
        row.status === 'ACTIVE'
    ).length;

  document.getElementById(
    'pendingMembershipCount'
  ).textContent =
    pendingMembership;

  document.getElementById(
    'pendingPromotionCount'
  ).textContent =
    pendingPromotion;

  document.getElementById(
    'approvedPromotionCount'
  ).textContent =
    approvedPromotion;
}

async function loadMemberships() {
  const box =
    document.getElementById(
      'membershipList'
    );

  box.innerHTML = `
    <div class="promo-admin-empty">
      Memuat pendaftaran...
    </div>
  `;

  try {
    const data =
      await apiFetch(
        '/api/admin/promos/v1/memberships'
      );

    memberships =
      Array.isArray(data.data)
        ? data.data
        : [];

    renderMemberships();
    updateStats();

  } catch (err) {
    box.innerHTML = `
      <div class="promo-admin-empty">
        ${esc(err.message)}
      </div>
    `;

    showToast(
      err.message,
      'error'
    );
  }
}

function renderMemberships() {
  const box =
    document.getElementById(
      'membershipList'
    );

  if (!memberships.length) {
    box.innerHTML = `
      <div class="promo-admin-empty">
        Belum ada pendaftaran Program Promo.
      </div>
    `;
    return;
  }

  box.innerHTML =
    memberships.map(row => {
      const pending =
        row.status === 'PENDING';

      return `
        <article class="promo-admin-card">

          <div class="promo-admin-card-top">

            <div class="promo-admin-card-title">
              <small>MERCHANT</small>

              <h3>
                ${esc(
                  row.store_name ||
                  'Merchant'
                )}
              </h3>
            </div>

            <span class="promo-admin-status ${
              esc(
                String(
                  row.status
                ).toLowerCase()
              )
            }">
              ${esc(
                membershipStatusLabel(
                  row.status
                )
              )}
            </span>

          </div>

          <div class="promo-admin-meta">

            <span>
              Status merchant:
              <strong>
                ${esc(
                  row.merchant_status ||
                  '-'
                )}
              </strong>
            </span>

            <span>
              Daftar:
              ${formatDate(
                row.applied_at
              )}
            </span>

            ${
              row.approved_at
                ? `
                  <span>
                    Disetujui:
                    ${formatDate(
                      row.approved_at
                    )}
                  </span>
                `
                : ''
            }

          </div>

          ${
            row.rejection_reason
              ? `
                <div class="promo-admin-rejection">
                  Alasan sebelumnya:
                  ${esc(
                    row.rejection_reason
                  )}
                </div>
              `
              : ''
          }

          ${
            pending
              ? `
                <div class="promo-admin-actions">

                  <button
                    type="button"
                    class="promo-admin-action promo-admin-approve"
                    onclick="approveMembership(
                      '${esc(row.id)}'
                    )">
                    Setujui
                  </button>

                  <button
                    type="button"
                    class="promo-admin-action promo-admin-reject"
                    onclick="rejectMembership(
                      '${esc(row.id)}'
                    )">
                    Tolak
                  </button>

                </div>
              `
              : ''
          }

        </article>
      `;
    }).join('');
}

async function approveMembership(id) {
  const confirmed =
    window.confirm(
      'Setujui merchant mengikuti Program Promo Pasar Pintar?'
    );

  if (!confirmed) {
    return;
  }

  try {
    const data =
      await apiFetch(
        '/api/admin/promos/v1/memberships/' +
        encodeURIComponent(id) +
        '/approve',
        {
          method:'POST',
          body:JSON.stringify({})
        }
      );

    showToast(
      data.message ||
      'Merchant disetujui'
    );

    await loadMemberships();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}

async function rejectMembership(id) {
  const reason =
    window.prompt(
      'Alasan penolakan pendaftaran merchant:'
    );

  if (reason === null) {
    return;
  }

  const cleanReason =
    String(reason).trim();

  if (!cleanReason) {
    showToast(
      'Alasan penolakan wajib diisi',
      'error'
    );
    return;
  }

  try {
    const data =
      await apiFetch(
        '/api/admin/promos/v1/memberships/' +
        encodeURIComponent(id) +
        '/reject',
        {
          method:'POST',
          body:JSON.stringify({
            reason:cleanReason
          })
        }
      );

    showToast(
      data.message ||
      'Pendaftaran ditolak'
    );

    await loadMemberships();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}

function promotionDiscountLabel(row) {
  if (row.promotion_type === 'PERCENT') {
    return (
      Number(row.discount_value || 0)
        .toLocaleString('id-ID') +
      '% OFF'
    );
  }

  if (row.promotion_type === 'FIXED') {
    return (
      'Potongan ' +
      rupiah(row.discount_value)
    );
  }

  if (
    row.promotion_type ===
    'FREE_SHIPPING'
  ) {
    return 'Gratis Ongkir';
  }

  return row.promotion_type || '-';
}

async function loadPromotions() {
  const box =
    document.getElementById(
      'promotionList'
    );

  box.innerHTML = `
    <div class="promo-admin-empty">
      Memuat pengajuan promo...
    </div>
  `;

  try {
    const data =
      await apiFetch(
        '/api/admin/promos/v1/promotions'
      );

    promotions =
      Array.isArray(data.data)
        ? data.data
        : [];

    renderPromotions();
    updateStats();

  } catch (err) {
    box.innerHTML = `
      <div class="promo-admin-empty">
        ${esc(err.message)}
      </div>
    `;

    showToast(
      err.message,
      'error'
    );
  }
}

function renderPromotions() {
  const box =
    document.getElementById(
      'promotionList'
    );

  if (!promotions.length) {
    box.innerHTML = `
      <div class="promo-admin-empty">
        Belum ada pengajuan promo merchant.
      </div>
    `;
    return;
  }

  box.innerHTML =
    promotions.map(row => {
      const submitted =
        row.status === 'SUBMITTED';

      return `
        <article class="promo-admin-card">

          <div class="promo-admin-card-top">

            <div class="promo-admin-card-title">

              <small>
                ${esc(
                  row.store_name ||
                  'MERCHANT'
                )}
              </small>

              <h3>
                ${esc(
                  row.name ||
                  'Promo'
                )}
              </h3>

            </div>

            <span class="promo-admin-status ${
              esc(
                String(
                  row.status
                ).toLowerCase()
              )
            }">
              ${esc(
                promotionStatusLabel(
                  row.status
                )
              )}
            </span>

          </div>

          <div class="promo-admin-meta">

            <span>
              <strong>
                ${esc(
                  promotionDiscountLabel(
                    row
                  )
                )}
              </strong>
            </span>

            <span>
              ${
                Number(
                  row.product_count || 0
                )
              }
              produk
            </span>

            <span>
              Mulai:
              ${formatDate(
                row.starts_at
              )}
            </span>

            <span>
              Selesai:
              ${formatDate(
                row.ends_at
              )}
            </span>

          </div>


          ${
            Array.isArray(row.product_names) &&
            row.product_names.length
              ? `
                <div class="promo-admin-description">
                  <strong>Produk promo:</strong><br>
                  ${row.product_names
                    .map(name => esc(name))
                    .join('<br>')}
                </div>
              `
              : ''
          }

          ${
            row.description
              ? `
                <div class="promo-admin-description">
                  ${esc(
                    row.description
                  )}
                </div>
              `
              : ''
          }

          ${
            row.rejection_reason
              ? `
                <div class="promo-admin-rejection">
                  Alasan penolakan:
                  ${esc(
                    row.rejection_reason
                  )}
                </div>
              `
              : ''
          }

          ${
            submitted
              ? `
                <div class="promo-admin-actions">

                  <button
                    type="button"
                    class="promo-admin-action promo-admin-approve"
                    onclick="approvePromotion(
                      '${esc(row.id)}'
                    )">
                    Setujui
                  </button>

                  <button
                    type="button"
                    class="promo-admin-action promo-admin-reject"
                    onclick="rejectPromotion(
                      '${esc(row.id)}'
                    )">
                    Tolak
                  </button>

                </div>
              `
              : ''
          }

        </article>
      `;
    }).join('');
}

async function approvePromotion(id) {
  const promo =
    promotions.find(
      row => row.id === id
    );

  const promoName =
    promo?.name || 'promo ini';

  const confirmed =
    window.confirm(
      'Setujui "' +
      promoName +
      '" untuk ditampilkan di marketplace?'
    );

  if (!confirmed) {
    return;
  }

  try {
    const data =
      await apiFetch(
        '/api/admin/promos/v1/promotions/' +
        encodeURIComponent(id) +
        '/approve',
        {
          method:'POST',
          body:JSON.stringify({})
        }
      );

    showToast(
      data.message ||
      'Promo berhasil disetujui'
    );

    await loadPromotions();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}

async function rejectPromotion(id) {
  const reason =
    window.prompt(
      'Alasan penolakan promo:'
    );

  if (reason === null) {
    return;
  }

  const cleanReason =
    String(reason).trim();

  if (!cleanReason) {
    showToast(
      'Alasan penolakan wajib diisi',
      'error'
    );
    return;
  }

  try {
    const data =
      await apiFetch(
        '/api/admin/promos/v1/promotions/' +
        encodeURIComponent(id) +
        '/reject',
        {
          method:'POST',
          body:JSON.stringify({
            reason:cleanReason
          })
        }
      );

    showToast(
      data.message ||
      'Promo berhasil ditolak'
    );

    await loadPromotions();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}

async function loadAdminPromoPage() {
  await Promise.all([
    loadMemberships(),
    loadPromotions()
  ]);
}

loadAdminPromoPage();
