const token =
  localStorage.getItem('token');

if (!token) {
  location.replace('/login.html');
}

const excelFile =
  document.getElementById('excelFile');

const fileName =
  document.getElementById('fileName');

const downloadBtn =
  document.getElementById('downloadBtn');

const previewBtn =
  document.getElementById('previewBtn');

const importBtn =
  document.getElementById('importBtn');

const previewArea =
  document.getElementById('previewArea');

const previewErrors =
  document.getElementById('previewErrors');

const totalRows =
  document.getElementById('totalRows');

const validRows =
  document.getElementById('validRows');

const errorRows =
  document.getElementById('errorRows');

const statusBox =
  document.getElementById('statusBox');
const photoUploadArea =
  document.getElementById('photoUploadArea');
const photoFiles =
  document.getElementById('photoFiles');
const photoFileName =
  document.getElementById('photoFileName');
const photoSummary =
  document.getElementById('photoSummary');
const photoFileList =
  document.getElementById('photoFileList');
const uploadPhotosBtn =
  document.getElementById('uploadPhotosBtn');
const pendingPhotoCount =
  document.getElementById('pendingPhotoCount');
const pendingPhotoList =
  document.getElementById('pendingPhotoList');

let pendingPhotoProducts = [];

let selectedFile = null;
let previewReady = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showStatus(message, type) {
  statusBox.textContent = message;
  statusBox.className =
    `import-status show ${type}`;
}

function clearStatus() {
  statusBox.textContent = '';
  statusBox.className =
    'import-status';
}

function handleAuthFailure(response) {
  if (
    response.status === 401 ||
    response.status === 403
  ) {
    localStorage.removeItem('token');
    location.replace('/login.html');
    return true;
  }

  return false;
}

async function loadPendingPhotos() {
  pendingPhotoCount.textContent =
    '...';

  pendingPhotoList.textContent =
    'Memuat daftar produk...';

  try {
    const response =
      await fetch(
        '/api/products/photos/pending',
        {
          headers: {
            Authorization:
              `Bearer ${token}`
          }
        }
      );

    if (handleAuthFailure(response)) {
      return;
    }

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        'Daftar foto gagal dimuat'
      );
    }

    const products =
      Array.isArray(data.products)
        ? data.products
        : [];

    pendingPhotoProducts =
      products;

    pendingPhotoCount.textContent =
      String(products.length);

    pendingPhotoList.innerHTML = '';

    if (products.length === 0) {
      pendingPhotoList.textContent =
        'Tidak ada produk yang menunggu foto.';
      return;
    }

    products.forEach(product => {
      const item =
        document.createElement('div');

      item.className =
        'pending-photo-item';

      item.textContent =
        `${product.name} · ${product.sku} · ${product.import_photo_filename}`;

      pendingPhotoList.appendChild(
        item
      );
    });

  } catch (err) {
    pendingPhotoCount.textContent =
      '-';

    pendingPhotoList.textContent =
      err.message ||
      'Daftar foto gagal dimuat.';
  }
}

function resetPreview() {
  previewReady = false;
  previewArea.classList.remove('show');
  previewErrors.innerHTML = '';
  totalRows.textContent = '0';
  validRows.textContent = '0';
  errorRows.textContent = '0';
  importBtn.disabled = true;
}

function renderPreview(data) {
  const errors =
    Array.isArray(data.errors)
      ? data.errors
      : [];

  const rows =
    Array.isArray(data.rows)
      ? data.rows
      : [];

  const count =
    Number(data.total_rows ?? rows.length ?? 0);

  const invalidRowNumbers =
    new Set(
      errors
        .map(item => Number(item.row))
        .filter(Number.isFinite)
    );

  const validCount =
    Math.max(
      0,
      count - invalidRowNumbers.size
    );

  totalRows.textContent =
    String(count);

  validRows.textContent =
    String(validCount);

  errorRows.textContent =
    String(errors.length);

  previewErrors.innerHTML = '';

  if (errors.length === 0) {
    previewErrors.innerHTML =
      '<div class="import-note">' +
      'Semua data lolos validasi. ' +
      'Produk siap diimport sebagai draft.' +
      '</div>';
  } else {
    errors.forEach(item => {
      const box =
        document.createElement('div');

      box.className =
        'preview-error';

      const rowText =
        item.row
          ? `Baris ${escapeHtml(item.row)} · `
          : '';

      const fieldText =
        item.field
          ? `${escapeHtml(item.field)} · `
          : '';

      box.innerHTML =
        rowText +
        fieldText +
        escapeHtml(
          item.message ||
          'Data tidak valid'
        );

      previewErrors.appendChild(box);
    });
  }

  previewReady =
    Boolean(data.can_import);

  importBtn.disabled =
    !previewReady;

  previewArea.classList.add('show');
}

excelFile.addEventListener(
  'change',
  () => {
    clearStatus();
    resetPreview();

    selectedFile =
      excelFile.files &&
      excelFile.files[0]
        ? excelFile.files[0]
        : null;

    if (!selectedFile) {
      fileName.textContent =
        'Belum ada file dipilih.';
      previewBtn.disabled = true;
      return;
    }

    if (
      !selectedFile.name
        .toLowerCase()
        .endsWith('.xlsx')
    ) {
      fileName.textContent =
        selectedFile.name;

      previewBtn.disabled = true;

      showStatus(
        'Gunakan file Excel berformat .xlsx.',
        'error'
      );

      return;
    }

    fileName.textContent =
      selectedFile.name;

    previewBtn.disabled = false;
  }
);

downloadBtn.addEventListener(
  'click',
  async () => {
    clearStatus();
    downloadBtn.disabled = true;
    downloadBtn.textContent =
      'Menyiapkan Template...';

    try {
      const response =
        await fetch(
          '/api/merchant/product-import-v1/template',
          {
            headers: {
              Authorization:
                `Bearer ${token}`
            }
          }
        );

      if (handleAuthFailure(response)) {
        return;
      }

      if (!response.ok) {
        throw new Error(
          'Template tidak dapat diunduh'
        );
      }

      const blob =
        await response.blob();

      const url =
        URL.createObjectURL(blob);

      const link =
        document.createElement('a');

      link.href = url;
      link.download =
        'template-import-produk-pasar-pintar.xlsx';

      document.body.appendChild(link);
      link.click();
      link.remove();

      URL.revokeObjectURL(url);

      showStatus(
        'Template Excel berhasil diunduh.',
        'success'
      );
    } catch (err) {
      showStatus(
        err.message ||
        'Gagal mengunduh template.',
        'error'
      );
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent =
        'Unduh Template Excel';
    }
  }
);

previewBtn.addEventListener(
  'click',
  async () => {
    if (!selectedFile) {
      return;
    }

    clearStatus();
    resetPreview();

    previewBtn.disabled = true;
    previewBtn.textContent =
      'Memeriksa Data...';

    try {
      const formData =
        new FormData();

      formData.append(
        'file',
        selectedFile
      );

      const response =
        await fetch(
          '/api/merchant/product-import-v1/preview',
          {
            method: 'POST',
            headers: {
              Authorization:
                `Bearer ${token}`
            },
            body: formData
          }
        );

      if (handleAuthFailure(response)) {
        return;
      }

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          data.message ||
          'Preview gagal'
        );
      }

      renderPreview(data);

      if (data.can_import) {
        showStatus(
          'File lolos validasi dan siap diimport.',
          'success'
        );
      } else {
        showStatus(
          'Masih ada data yang perlu diperbaiki.',
          'error'
        );
      }
    } catch (err) {
      showStatus(
        err.message ||
        'Gagal memeriksa file Excel.',
        'error'
      );
    } finally {
      previewBtn.disabled =
        !selectedFile;

      previewBtn.textContent =
        'Preview & Periksa Data';
    }
  }
);

importBtn.addEventListener(
  'click',
  async () => {
    if (
      !selectedFile ||
      !previewReady
    ) {
      return;
    }

    clearStatus();

    importBtn.disabled = true;
    importBtn.textContent =
      'Mengimport Produk...';

    try {
      const formData =
        new FormData();

      formData.append(
        'file',
        selectedFile
      );

      const response =
        await fetch(
          '/api/merchant/product-import-v1/import',
          {
            method: 'POST',
            headers: {
              Authorization:
                `Bearer ${token}`
            },
            body: formData
          }
        );

      if (handleAuthFailure(response)) {
        return;
      }

      const data =
        await response.json();

      if (!response.ok) {
        if (
          data.errors &&
          Array.isArray(data.errors)
        ) {
          renderPreview(data);
        }

        throw new Error(
          data.error ||
          data.message ||
          'Import gagal'
        );
      }

      const importedCount =
        Number(
          data.imported_count || 0
        );

      previewReady = false;
      importBtn.disabled = true;

      showStatus(
        `${importedCount} produk berhasil diimport sebagai draft.`,
        'success'
      );

      importBtn.textContent =
        'Import Selesai';

      await loadPendingPhotos();

      photoUploadArea.classList.add(
        'show'
      );

      photoUploadArea.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    } catch (err) {
      showStatus(
        err.message ||
        'Import produk gagal.',
        'error'
      );

      importBtn.disabled =
        !previewReady;

      importBtn.textContent =
        'Import Produk';
    }
  }
);


photoFiles.addEventListener(
  'change',
  () => {
    clearStatus();

    const files =
      Array.from(
        photoFiles.files || []
      );

    uploadPhotosBtn.disabled = true;
    photoFileList.innerHTML = '';
    photoSummary.textContent = '';

    if (files.length === 0) {
      photoFileName.textContent =
        'Belum ada foto dipilih.';
      photoFileList.style.display =
        'none';
      return;
    }

    photoFileName.textContent =
      files.length === 1
        ? files[0].name
        : `${files.length} foto dipilih`;

    if (files.length > 50) {
      showStatus(
        'Maksimal 50 foto per sekali upload.',
        'error'
      );
      return;
    }

    const allowedExtensions =
      /\.(jpe?g|png|webp)$/i;

    const invalidFile =
      files.find(
        file =>
          !allowedExtensions.test(
            file.name
          )
      );

    if (invalidFile) {
      showStatus(
        `Format foto tidak didukung: ${invalidFile.name}`,
        'error'
      );
      return;
    }

    const duplicateNames =
      new Set();

    const seenNames =
      new Set();

    for (const file of files) {
      const key =
        file.name
          .trim()
          .toLowerCase();

      if (seenNames.has(key)) {
        duplicateNames.add(
          file.name
        );
      }

      seenNames.add(key);
    }

    if (duplicateNames.size > 0) {
      showStatus(
        'Ada nama file foto yang duplikat.',
        'error'
      );
      return;
    }

    files.forEach((file, index) => {
      const item =
        document.createElement('div');

      item.className =
        'photo-file-item';

      const label =
        document.createElement('div');

      label.textContent =
        'File dari HP: ' + file.name;

      const select =
        document.createElement('select');

      select.className =
        'photo-match-name';

      select.dataset.index =
        String(index);

      select.setAttribute(
        'aria-label',
        'Pilih produk tujuan foto'
      );

      const placeholder =
        document.createElement('option');

      placeholder.value = '';
      placeholder.textContent =
        'Pilih produk tujuan';

      select.appendChild(
        placeholder
      );

      const fileKey =
        file.name
          .trim()
          .toLowerCase();

      let exactMatchFound =
        false;

      pendingPhotoProducts.forEach(
        product => {
          const option =
            document.createElement(
              'option'
            );

          option.value =
            product.import_photo_filename;

          option.textContent =
            `${product.sku} — ${product.name}`;

          const expectedKey =
            String(
              product.import_photo_filename ||
              ''
            )
              .trim()
              .toLowerCase();

          if (
            !exactMatchFound &&
            expectedKey === fileKey
          ) {
            option.selected = true;
            exactMatchFound = true;
          }

          select.appendChild(
            option
          );
        }
      );

      item.appendChild(label);
      item.appendChild(select);

      photoFileList.appendChild(
        item
      );
    });

    photoSummary.textContent =
      `${files.length} foto siap diupload.`;

    photoFileList.style.display =
      'block';

    uploadPhotosBtn.disabled =
      false;
  }
);

uploadPhotosBtn.addEventListener(
  'click',
  async () => {
    const files =
      Array.from(
        photoFiles.files || []
      );

    if (
      files.length === 0 ||
      files.length > 50
    ) {
      return;
    }

    clearStatus();

    uploadPhotosBtn.disabled = true;
    uploadPhotosBtn.textContent =
      'Mengupload Foto...';

    try {
      const formData =
        new FormData();

      const matchInputs =
        Array.from(
          photoFileList.querySelectorAll(
            '.photo-match-name'
          )
        );

      const mappedNames =
        matchInputs.map(
          input =>
            input.value.trim()
        );

      if (
        mappedNames.some(
          name => !name
        )
      ) {
        throw new Error(
          'Pilih produk tujuan untuk setiap foto.'
        );
      }

      const normalizedMapped =
        mappedNames.map(
          name =>
            name.toLowerCase()
        );

      if (
        new Set(normalizedMapped).size !==
        normalizedMapped.length
      ) {
        throw new Error(
          'Satu produk tidak boleh dipilih untuk dua foto.'
        );
      }

      files.forEach(
        (file, index) => {
          formData.append(
            'photos',
            file,
            mappedNames[index]
          );
        }
      );

      const response =
        await fetch(
          '/api/products/photos/bulk',
          {
            method: 'POST',
            headers: {
              Authorization:
                `Bearer ${token}`
            },
            body: formData
          }
        );

      if (
        handleAuthFailure(response)
      ) {
        return;
      }

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          data.message ||
          'Upload foto gagal'
        );
      }

      const updatedCount =
        Number(
          data.updated_count || 0
        );

      showStatus(
        `${updatedCount} foto produk berhasil dipasang.`,
        'success'
      );

      await loadPendingPhotos();

      photoFiles.value = '';
      photoFileName.textContent =
        'Belum ada foto dipilih.';
      photoSummary.textContent = '';
      photoFileList.innerHTML = '';
      photoFileList.style.display =
        'none';

      uploadPhotosBtn.disabled =
        true;
      uploadPhotosBtn.textContent =
        'Upload Foto Produk';

    } catch (err) {
      showStatus(
        err.message ||
        'Upload foto produk gagal.',
        'error'
      );

      uploadPhotosBtn.disabled =
        false;
      uploadPhotosBtn.textContent =
        'Upload Foto Produk';
    }
  }
);

loadPendingPhotos();

function logout() {
  localStorage.removeItem('token');
  location.href = '/login.html';
}
