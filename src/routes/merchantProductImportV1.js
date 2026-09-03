const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { validateWorkbook } = require('../services/merchantProductImportValidatorV1');
const { buildTemplate } = require('../services/merchant/MerchantProductImportTemplateV1');
const { executeImport } = require('../services/merchant/MerchantProductImportServiceV1');

const pool = require('../config/db');
const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const router = express.Router();

const excelUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const filename =
            String(file.originalname || '')
                .trim()
                .toLowerCase();

        if (!filename.endsWith('.xlsx')) {
            const err =
                new Error(
                    'File import harus berformat .xlsx'
                );
            err.code =
                'INVALID_PRODUCT_EXCEL_TYPE';
            return cb(err);
        }

        return cb(null, true);
    }
});

function cellText(value) {
    if (
        value === undefined ||
        value === null
    ) {
        return '';
    }

    if (
        typeof value === 'object'
    ) {
        if (
            value.text !== undefined
        ) {
            return String(
                value.text
            ).trim();
        }

        if (
            value.result !== undefined
        ) {
            return String(
                value.result
            ).trim();
        }

        if (
            Array.isArray(
                value.richText
            )
        ) {
            return value.richText
                .map(
                    item =>
                        item.text || ''
                )
                .join('')
                .trim();
        }
    }

    return String(value).trim();
}

function headerKey(value) {
    return cellText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}


router.get(
    '/merchant/product-import-v1/template',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const merchantResult =
                await pool.query(
                    `SELECT id
                     FROM tbl_merchants
                     WHERE user_id = $1
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [req.user.id]
                );

            if (merchantResult.rowCount === 0) {
                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const { workbook } =
                await buildTemplate(pool);

            const buffer =
                await workbook.xlsx.writeBuffer();

            const filename =
                'template-import-produk-pasar-pintar.xlsx';

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );

            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${filename}"`
            );

            return res.send(
                Buffer.from(buffer)
            );
        } catch (err) {
            console.error(
                '[PRODUCT IMPORT TEMPLATE]',
                err
            );

            return res.status(500).json({
                error:
                    'Gagal membuat template Excel'
            });
        }
    }
);

router.post(
    '/merchant/product-import-v1/preview',
    verifyToken,
    requireRole(2),
    excelUpload.single('file'),
    async (req, res) => {
        try {
            if (
                !req.file ||
                !req.file.buffer
            ) {
                return res.status(400).json({
                    error:
                        'File Excel wajib diunggah'
                });
            }

            const merchantResult =
                await pool.query(
                    `SELECT id, store_name
                     FROM tbl_merchants
                     WHERE user_id = $1
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [req.user.id]
                );

            if (
                merchantResult.rowCount === 0
            ) {
                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const workbook =
                new ExcelJS.Workbook();

            await workbook.xlsx.load(
                req.file.buffer
            );

            const preview = await validateWorkbook({
                workbook,
                pool,
                merchantId: merchantResult.rows[0].id
            });

            return res.json({
                status: "success",
                preview_only: true,
                merchant: {
                    id: merchantResult.rows[0].id,
                    store_name: merchantResult.rows[0].store_name
                },
                ...preview
            });
        } catch (err) {
            console.error(
                '[PRODUCT IMPORT PREVIEW]',
                err
            );

            return res.status(400).json({
                error:
                    'Gagal membaca file Excel'
            });
        }
    }
);


router.post(
    '/merchant/product-import-v1/import',
    verifyToken,
    requireRole(2),
    excelUpload.single('file'),
    async (req, res) => {
        try {
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({
                    error: 'File Excel wajib diunggah'
                });
            }

            const merchantResult =
                await pool.query(
                    `SELECT id
                     FROM tbl_merchants
                     WHERE user_id = $1
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [req.user.id]
                );

            if (merchantResult.rowCount === 0) {
                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const workbook =
                new ExcelJS.Workbook();

            await workbook.xlsx.load(
                req.file.buffer
            );

            const preview =
                await validateWorkbook({
                    workbook,
                    pool,
                    merchantId:
                        merchantResult.rows[0].id
                });

            if (!preview.can_import) {
                return res.status(400).json({
                    status: 'validation_error',
                    message:
                        'File belum dapat diimport',
                    ...preview
                });
            }

            const result =
                await executeImport(
                    pool,
                    req.user.id,
                    preview.rows
                );

            return res.status(201).json({
                status: 'success',
                message:
                    'Produk berhasil diimport',
                imported_count:
                    result.inserted.length,
                products:
                    result.inserted.map(
                        entry => ({
                            id:
                                entry.product.id,
                            sku:
                                entry.product.sku,
                            name:
                                entry.product.name,
                            parent_product_id:
                                entry.product.parent_product_id,
                            variant_label:
                                entry.product.variant_label,
                            customer_visible:
                                entry.product.customer_visible
                        })
                    )
            });
        } catch (err) {
            console.error(
                '[PRODUCT IMPORT EXECUTE]',
                err
            );

            if (err.code === '23505') {
                return res.status(409).json({
                    error:
                        'SKU berubah atau sudah digunakan. Preview ulang file.'
                });
            }

            return res.status(500).json({
                error:
                    'Import produk gagal dan dibatalkan'
            });
        }
    }
);

module.exports = router;
