const ExcelJS = require('exceljs');

const HEADERS = [
    'SKU',
    'Nama Produk',
    'Harga Jual',
    'Stok Awal',
    'Stok Minimum',
    'Satuan Jual',
    'Isi Kemasan',
    'Satuan Isi',
    'Kategori',
    'Deskripsi',
    'Produk Induk (SKU)',
    'Nama Varian',
    'Nama File Foto',
    'Tampilkan di Marketplace'
];

const SELLING_UNITS = [
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
];

const PACK_UNITS = [
    'GRAM',
    'KG',
    'ML',
    'LITER',
    'PCS'
];

async function getLeafCategories(pool) {
    const result = await pool.query(
        `SELECT c.name
         FROM tbl_product_categories c
         WHERE NOT EXISTS (
             SELECT 1
             FROM tbl_product_categories child
             WHERE child.parent_id = c.id
         )
         ORDER BY c.name ASC`
    );

    return result.rows.map(
        row => String(row.name || '').trim()
    ).filter(Boolean);
}

async function buildTemplate(pool) {
    const categories =
        await getLeafCategories(pool);

    const workbook =
        new ExcelJS.Workbook();

    workbook.creator = 'Pasar Pintar';
    workbook.title =
        'Template Import Produk Merchant';

    const sheet =
        workbook.addWorksheet(
            'Template Produk'
        );

    sheet.addRow(HEADERS);

    sheet.addRow([
        'CONTOH-001',
        'Sosis Ayam 500gr',
        25000,
        10,
        3,
        'PACK',
        500,
        'GRAM',
        categories[0] || '',
        'Contoh produk. Hapus baris ini sebelum import.',
        '',
        '',
        'sosis-ayam-500gr.jpg',
        'TIDAK'
    ]);


    decorateTemplate(
        workbook,
        sheet,
        categories
    );

    addInstructions(workbook);

    return {
        workbook,
        sheet,
        categories
    };
}

module.exports = {
    HEADERS,
    SELLING_UNITS,
    PACK_UNITS,
    buildTemplate
};

function decorateTemplate(
    workbook,
    sheet,
    categories
) {
    sheet.views = [
        {
            state: 'frozen',
            ySplit: 1
        }
    ];

    const widths = [
        20, 30, 16, 14, 16, 16, 16,
        16, 26, 40, 22, 20, 28, 24
    ];

    widths.forEach((width, index) => {
        sheet.getColumn(index + 1).width =
            width;
    });

    sheet.getRow(1).font = {
        bold: true
    };

    sheet.getColumn(3).numFmt =
        '#,##0';

    sheet.getColumn(4).numFmt =
        '0';

    sheet.getColumn(5).numFmt =
        '0';

    sheet.getColumn(7).numFmt =
        '0.###';

    const lists =
        workbook.addWorksheet('_Pilihan');

    lists.state = 'hidden';

    SELLING_UNITS.forEach(
        (value, index) => {
            lists.getCell(
                index + 1,
                1
            ).value = value;
        }
    );

    PACK_UNITS.forEach(
        (value, index) => {
            lists.getCell(
                index + 1,
                2
            ).value = value;
        }
    );

    categories.forEach(
        (value, index) => {
            lists.getCell(
                index + 1,
                3
            ).value = value;
        }
    );

    lists.getCell(1, 4).value = 'YA';
    lists.getCell(2, 4).value = 'TIDAK';

    for (let row = 2; row <= 501; row++) {
        sheet.getCell(row, 6)
            .dataValidation = {
                type: 'list',
                allowBlank: false,
                formulae: [
                    `'${lists.name}'!$A$1:$A$${SELLING_UNITS.length}`
                ]
            };

        sheet.getCell(row, 8)
            .dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [
                    `'${lists.name}'!$B$1:$B$${PACK_UNITS.length}`
                ]
            };

        if (categories.length > 0) {
            sheet.getCell(row, 9)
                .dataValidation = {
                    type: 'list',
                    allowBlank: false,
                    formulae: [
                        `'${lists.name}'!$C$1:$C$${categories.length}`
                    ]
                };
        }

        sheet.getCell(row, 14)
            .dataValidation = {
                type: 'list',
                allowBlank: false,
                formulae: [
                    `'${lists.name}'!$D$1:$D$2`
                ]
            };
    }
}

function addInstructions(workbook) {
    const sheet =
        workbook.addWorksheet('Petunjuk');

    sheet.columns = [
        {
            header: 'Bagian',
            key: 'section',
            width: 28
        },
        {
            header: 'Petunjuk',
            key: 'instruction',
            width: 85
        }
    ];

    sheet.getRow(1).font = {
        bold: true
    };

    const rows = [
        [
            'Cara Menggunakan',
            'Isi produk pada sheet Template Produk. Satu baris untuk satu produk atau varian.'
        ],
        [
            'SKU',
            'Wajib unik untuk setiap produk. Maksimal 64 karakter.'
        ],
        [
            'Harga Jual',
            'Isi angka tanpa simbol Rp.'
        ],
        [
            'Stok',
            'Stok Awal dan Stok Minimum harus berupa bilangan bulat minimal 0.'
        ],
        [
            'Satuan',
            'Gunakan pilihan dropdown yang tersedia pada template.'
        ],
        [
            'Isi Kemasan',
            'Jika diisi, Satuan Isi juga wajib diisi. Contoh: 500 dan GRAM.'
        ],
        [
            'Kategori',
            'Pilih kategori dari dropdown yang tersedia.'
        ],
        [
            'Produk Induk',
            'Untuk varian, isi SKU produk induk dan Nama Varian. Produk induk dapat berada sebelum atau sesudah baris varian.'
        ],
        [
            'Foto Produk',
            'Isi nama file foto saja, contoh sosis-ayam.jpg. Jangan menggunakan nama folder.'
        ],
        [
            'Format Foto',
            'Format yang didukung: JPG, JPEG, PNG, dan WEBP.'
        ],
        [
            'Marketplace',
            'Pilih YA atau TIDAK. Produk hasil import tetap disimpan sebagai draft sampai proses publikasi dipenuhi.'
        ],
        [
            'Batas Import',
            'Maksimal 500 produk dalam satu file.'
        ],
        [
            'Baris Contoh',
            'Hapus atau ganti baris CONTOH-001 sebelum melakukan import.'
        ]
    ];

    for (const row of rows) {
        sheet.addRow(row);
    }

    sheet.views = [
        {
            state: 'frozen',
            ySplit: 1
        }
    ];

    sheet.getColumn(2).alignment = {
        wrapText: true,
        vertical: 'top'
    };
}
