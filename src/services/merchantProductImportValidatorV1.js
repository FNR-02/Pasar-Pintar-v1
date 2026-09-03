const EXPECTED_HEADERS = [
  'sku',
  'nama produk',
  'harga jual',
  'stok awal',
  'stok minimum',
  'satuan jual',
  'isi kemasan',
  'satuan isi',
  'kategori',
  'deskripsi',
  'produk induk sku',
  'nama varian',
  'nama file foto',
  'tampilkan di marketplace'
];

const ALLOWED_SELLING_UNITS = new Set([
  'PCS',
  'PACK',
  'BUNGKUS',
  'IKAT',
  'BOTOL',
  'DUS',
  'KARUNG',
  'SACHET',
  'KALENG',
  'TRAY',
  'PAPAN'
]);

const ALLOWED_PACK_UNITS = new Set([
  'GRAM',
  'KG',
  'ML',
  'LITER',
  'PCS'
]);

const ALLOWED_PHOTO_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp'
]);

function text(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object') {
    if (value.text !== undefined) {
      return String(value.text).trim();
    }

    if (value.result !== undefined) {
      return String(value.result).trim();
    }

    if (Array.isArray(value.richText)) {
      return value.richText
        .map(item => item.text || '')
        .join('')
        .trim();
    }
  }

  return String(value).trim();
}

function normalized(value) {
  return text(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function headerKey(value) {
  return normalized(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function numberValue(value) {
  if (
    value === undefined ||
    value === null ||
    text(value) === ''
  ) {
    return null;
  }

  if (typeof value === 'number') {
    return value;
  }

  const cleaned = text(value)
    .replace(/\s/g, '')
    .replace(/^rp/iu, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const result = Number(cleaned);

  return Number.isFinite(result)
    ? result
    : NaN;
}

function integerValue(value) {
  const result = numberValue(value);

  if (result === null) {
    return null;
  }

  return Number.isInteger(result)
    ? result
    : NaN;
}

function visibilityValue(value) {
  const raw = normalized(value);

  if (
    raw === '' ||
    raw === 'tidak' ||
    raw === 'no' ||
    raw === 'false' ||
    raw === '0'
  ) {
    return false;
  }

  if (
    raw === 'ya' ||
    raw === 'yes' ||
    raw === 'true' ||
    raw === '1'
  ) {
    return true;
  }

  return null;
}

function addError(
  errors,
  row,
  field,
  message
) {
  errors.push({
    row,
    field,
    message
  });
}

function rowIsEmpty(
  row,
  headerColumns
) {
  return EXPECTED_HEADERS.every(key => {
    const column = headerColumns[key];

    if (!column) {
      return true;
    }

    return text(
      row.getCell(column).value
    ) === '';
  });
}

async function validateWorkbook({
  workbook,
  pool,
  merchantId
}) {
  const worksheet =
    workbook.getWorksheet(
      'Template Produk'
    ) ||
    workbook.worksheets[0];

  if (!worksheet) {
    return {
      worksheet: null,
      rows: [],
      errors: [{
        row: 0,
        field: 'file',
        message:
          'Worksheet Template Produk tidak ditemukan'
      }],
      can_import: false
    };
  }

  const headerColumns = {};

  worksheet
    .getRow(1)
    .eachCell(
      { includeEmpty: false },
      (cell, columnNumber) => {
        const key =
          headerKey(cell.value);

        if (key) {
          headerColumns[key] =
            columnNumber;
        }
      }
    );

  const errors = [];

  for (const key of EXPECTED_HEADERS) {
    if (!headerColumns[key]) {
      addError(
        errors,
        1,
        key,
        `Kolom "${key}" tidak ditemukan`
      );
    }
  }

  if (errors.length > 0) {
    return {
      worksheet:
        worksheet.name,
      rows: [],
      errors,
      can_import: false
    };
  }

  const rawRows = [];

  for (
    let rowNumber = 2;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row =
      worksheet.getRow(rowNumber);

    if (
      rowIsEmpty(
        row,
        headerColumns
      )
    ) {
      continue;
    }

    rawRows.push({
      rowNumber,

      sku:
        text(
          row.getCell(
            headerColumns.sku
          ).value
        ),

      name:
        text(
          row.getCell(
            headerColumns[
              'nama produk'
            ]
          ).value
        ),

      price:
        numberValue(
          row.getCell(
            headerColumns[
              'harga jual'
            ]
          ).value
        ),

      stock:
        integerValue(
          row.getCell(
            headerColumns[
              'stok awal'
            ]
          ).value
        ),

      minStock:
        integerValue(
          row.getCell(
            headerColumns[
              'stok minimum'
            ]
          ).value
        ),

      sellingUnit:
        text(
          row.getCell(
            headerColumns[
              'satuan jual'
            ]
          ).value
        ).toUpperCase(),

      packSizeValue:
        numberValue(
          row.getCell(
            headerColumns[
              'isi kemasan'
            ]
          ).value
        ),

      packSizeUnit:
        text(
          row.getCell(
            headerColumns[
              'satuan isi'
            ]
          ).value
        ).toUpperCase(),

      category:
        text(
          row.getCell(
            headerColumns.kategori
          ).value
        ),

      description:
        text(
          row.getCell(
            headerColumns.deskripsi
          ).value
        ),

      parentSku:
        text(
          row.getCell(
            headerColumns[
              'produk induk sku'
            ]
          ).value
        ),

      variantLabel:
        text(
          row.getCell(
            headerColumns[
              'nama varian'
            ]
          ).value
        ),

      photoFilename:
        text(
          row.getCell(
            headerColumns[
              'nama file foto'
            ]
          ).value
        ),

      requestedVisible:
        visibilityValue(
          row.getCell(
            headerColumns[
              'tampilkan di marketplace'
            ]
          ).value
        )
    });
  }

  if (rawRows.length === 0) {
    addError(
      errors,
      0,
      'file',
      'Tidak ada produk untuk diimport'
    );
  }

  if (rawRows.length > 500) {
    addError(
      errors,
      0,
      'file',
      'Maksimal 500 produk dalam satu kali import'
    );
  }

  validateBasicRows(rawRows, errors);
  await validateExistingSkus(pool, merchantId, rawRows, errors);
  await validateCategories(pool, rawRows, errors);
  await validateParentVariants(pool, merchantId, rawRows, errors);
  validateParentCycles(rawRows, errors);
  validatePhotosAndVisibility(rawRows, errors);

  return {
    worksheet:
      worksheet.name,
    total_rows:
      rawRows.length,
    rows:
      rawRows,
    errors,
    can_import:
      rawRows.length > 0 &&
      rawRows.length <= 500 &&
      errors.length === 0
  };
}

module.exports = {
  EXPECTED_HEADERS,
  validateWorkbook
};

function validateBasicRows(rawRows, errors) {
  const skuMap = new Map();

  for (const item of rawRows) {
    const row = item.rowNumber;
    const skuKey = normalized(item.sku);

    if (!item.sku) {
      addError(errors, row, 'SKU', 'SKU wajib diisi');
    } else if (item.sku.length > 64) {
      addError(
        errors,
        row,
        'SKU',
        'SKU maksimal 64 karakter'
      );
    } else if (skuMap.has(skuKey)) {
      addError(
        errors,
        row,
        'SKU',
        `SKU duplikat di file: ${item.sku}`
      );
    } else {
      skuMap.set(skuKey, row);
    }

    if (!item.name) {
      addError(
        errors,
        row,
        'Nama Produk',
        'Nama produk wajib diisi'
      );
    }

    if (
      !Number.isFinite(item.price) ||
      item.price < 0
    ) {
      addError(
        errors,
        row,
        'Harga Jual',
        'Harga harus berupa angka minimal 0'
      );
    }

    if (
      !Number.isInteger(item.stock) ||
      item.stock < 0
    ) {
      addError(
        errors,
        row,
        'Stok Awal',
        'Stok harus bilangan bulat minimal 0'
      );
    }

    if (item.minStock === null) {
      item.minStock = 5;
    }

    if (
      !Number.isInteger(item.minStock) ||
      item.minStock < 0
    ) {
      addError(
        errors,
        row,
        'Stok Minimum',
        'Stok minimum harus bilangan bulat minimal 0'
      );
    }

    if (
      !ALLOWED_SELLING_UNITS.has(
        item.sellingUnit
      )
    ) {
      addError(
        errors,
        row,
        'Satuan Jual',
        'Satuan jual tidak valid'
      );
    }

    const hasPackValue =
      item.packSizeValue !== null;

    const hasPackUnit =
      item.packSizeUnit !== '';

    if (hasPackValue !== hasPackUnit) {
      addError(
        errors,
        row,
        'Isi Kemasan',
        'Isi Kemasan dan Satuan Isi harus diisi bersamaan'
      );
    }

    if (
      hasPackValue &&
      (
        !Number.isFinite(item.packSizeValue) ||
        item.packSizeValue <= 0
      )
    ) {
      addError(
        errors,
        row,
        'Isi Kemasan',
        'Isi kemasan harus lebih dari 0'
      );
    }

    if (
      hasPackUnit &&
      !ALLOWED_PACK_UNITS.has(
        item.packSizeUnit
      )
    ) {
      addError(
        errors,
        row,
        'Satuan Isi',
        'Satuan isi tidak valid'
      );
    }
  }
}

async function validateExistingSkus(
  pool,
  merchantId,
  rawRows,
  errors
) {
  const result = await pool.query(
    `SELECT sku
     FROM tbl_products
     WHERE merchant_id = $1
       AND status = 'ACTIVE'`,
    [merchantId]
  );

  const existingSkus = new Set(
    result.rows.map(
      item => normalized(item.sku)
    )
  );

  for (const item of rawRows) {
    if (!item.sku) {
      continue;
    }

    if (
      existingSkus.has(
        normalized(item.sku)
      )
    ) {
      addError(
        errors,
        item.rowNumber,
        'SKU',
        `SKU sudah digunakan: ${item.sku}`
      );
    }
  }
}

async function validateCategories(
  pool,
  rawRows,
  errors
) {
  const result = await pool.query(
    `SELECT
       c.id,
       c.name,
       p.name AS parent_name
     FROM tbl_product_categories c
     LEFT JOIN tbl_product_categories p
       ON p.id = c.parent_id
     WHERE NOT EXISTS (
       SELECT 1
       FROM tbl_product_categories child
       WHERE child.parent_id = c.id
     )`
  );

  const categoryMap = new Map();

  for (const category of result.rows) {
    const key = normalized(category.name);

    if (!categoryMap.has(key)) {
      categoryMap.set(key, []);
    }

    categoryMap.get(key).push(category);
  }

  for (const item of rawRows) {
    if (!item.category) {
      addError(
        errors,
        item.rowNumber,
        'Kategori',
        'Kategori wajib diisi'
      );
      continue;
    }

    const key = normalized(item.category);
    const matches = categoryMap.get(key) || [];

    if (matches.length === 0) {
      addError(
        errors,
        item.rowNumber,
        'Kategori',
        `Kategori tidak ditemukan: ${item.category}`
      );
      continue;
    }

    if (matches.length > 1) {
      addError(
        errors,
        item.rowNumber,
        'Kategori',
        `Kategori ambigu: ${item.category}`
      );
    }
  }
}

async function validateParentVariants(
  pool,
  merchantId,
  rawRows,
  errors
) {
  const fileSkus = new Set(
    rawRows
      .filter(item => item.sku)
      .map(item => normalized(item.sku))
  );

  const result = await pool.query(
    `SELECT sku
     FROM tbl_products
     WHERE merchant_id = $1
       AND status = 'ACTIVE'`,
    [merchantId]
  );

  const existingSkus = new Set(
    result.rows.map(
      item => normalized(item.sku)
    )
  );

  for (const item of rawRows) {
    if (
      item.variantLabel &&
      item.variantLabel.length > 120
    ) {
      addError(
        errors,
        item.rowNumber,
        'Nama Varian',
        'Nama varian maksimal 120 karakter'
      );
    }

    if (!item.parentSku) {
      if (item.variantLabel) {
        addError(
          errors,
          item.rowNumber,
          'Produk Induk (SKU)',
          'Nama varian membutuhkan Produk Induk (SKU)'
        );
      }

      continue;
    }

    if (!item.variantLabel) {
      addError(
        errors,
        item.rowNumber,
        'Nama Varian',
        'Nama varian wajib untuk produk varian'
      );
    }

    const parentKey =
      normalized(item.parentSku);

    const ownKey =
      normalized(item.sku);

    if (
      ownKey &&
      parentKey === ownKey
    ) {
      addError(
        errors,
        item.rowNumber,
        'Produk Induk (SKU)',
        'Produk tidak boleh menjadi induk dirinya sendiri'
      );

      continue;
    }

    if (
      !fileSkus.has(parentKey) &&
      !existingSkus.has(parentKey)
    ) {
      addError(
        errors,
        item.rowNumber,
        'Produk Induk (SKU)',
        `SKU produk induk tidak ditemukan: ${item.parentSku}`
      );
    }
  }
}

function validatePhotosAndVisibility(
  rawRows,
  errors
) {
  const photoNames = new Set();

  for (const item of rawRows) {
    if (item.requestedVisible === null) {
      addError(
        errors,
        item.rowNumber,
        'Tampilkan di Marketplace',
        'Isi dengan YA atau TIDAK'
      );
    }

    if (!item.photoFilename) {
      continue;
    }

    if (
      item.photoFilename.includes('/') ||
      item.photoFilename.includes('\\')
    ) {
      addError(
        errors,
        item.rowNumber,
        'Nama File Foto',
        'Gunakan nama file saja tanpa folder'
      );
      continue;
    }

    const photoKey =
      normalized(item.photoFilename);

    if (photoNames.has(photoKey)) {
      addError(
        errors,
        item.rowNumber,
        'Nama File Foto',
        `Nama file foto duplikat: ${item.photoFilename}`
      );
    } else {
      photoNames.add(photoKey);
    }

    const parts =
      item.photoFilename.toLowerCase().split('.');

    const extension =
      parts.length > 1
        ? parts.pop()
        : '';

    if (
      !ALLOWED_PHOTO_EXTENSIONS.has(
        extension
      )
    ) {
      addError(
        errors,
        item.rowNumber,
        'Nama File Foto',
        'Foto harus JPG, JPEG, PNG, atau WebP'
      );
    }
  }
}

function validateParentCycles(
  rawRows,
  errors
) {
  const parentBySku = new Map();

  for (const item of rawRows) {
    const sku = normalized(item.sku);
    const parentSku =
      normalized(item.parentSku);

    if (sku && parentSku) {
      parentBySku.set(
        sku,
        parentSku
      );
    }
  }

  for (const item of rawRows) {
    const start =
      normalized(item.sku);

    if (!start) {
      continue;
    }

    const visited = new Set();
    let current = start;

    while (
      current &&
      parentBySku.has(current)
    ) {
      if (visited.has(current)) {
        addError(
          errors,
          item.rowNumber,
          'Produk Induk (SKU)',
          `Relasi produk induk membentuk siklus: ${item.sku}`
        );
        break;
      }

      visited.add(current);
      current =
        parentBySku.get(current);
    }
  }
}
