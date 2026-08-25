const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const PhoneVerificationDeliveryService =
    require('../services/whatsapp/PhoneVerificationDeliveryService');
const router = express.Router();

const productPhotoDirectory = path.join(
    __dirname,
    '../../public/uploads/products'
);

fs.mkdirSync(
    productPhotoDirectory,
    {
        recursive: true
    }
);

const allowedProductPhotoMimeTypes =
    new Set([
        'image/jpeg',
        'image/png',
        'image/webp'
    ]);

const productPhotoStorage =
    multer.diskStorage({
        destination:
            (
                req,
                file,
                cb
            ) => {
                cb(
                    null,
                    productPhotoDirectory
                );
            },

        filename:
            (
                req,
                file,
                cb
            ) => {
                const extensionByMime = {
                    'image/jpeg':
                        '.jpg',
                    'image/png':
                        '.png',
                    'image/webp':
                        '.webp'
                };

                const extension =
                    extensionByMime[
                        file.mimetype
                    ] || '';

                const randomName =
                    crypto.randomUUID();

                cb(
                    null,
                    `product-${randomName}${extension}`
                );
            }
    });

const productPhotoUpload =
    multer({
        storage:
            productPhotoStorage,

        limits: {
            fileSize:
                5 * 1024 * 1024,
            files:
                1
        },

        fileFilter:
            (
                req,
                file,
                cb
            ) => {
                if (
                    !allowedProductPhotoMimeTypes
                        .has(file.mimetype)
                ) {
                    const err =
                        new Error(
                            'Format foto harus JPG, PNG, atau WebP'
                        );

                    err.code =
                        'INVALID_PRODUCT_PHOTO_TYPE';

                    return cb(err);
                }

                return cb(
                    null,
                    true
                );
            }
    });

function detectProductPhotoType(
    filePath
) {
    let fd;

    try {
        fd = fs.openSync(
            filePath,
            'r'
        );

        const buffer =
            Buffer.alloc(16);

        const bytesRead =
            fs.readSync(
                fd,
                buffer,
                0,
                buffer.length,
                0
            );

        const data =
            buffer.subarray(
                0,
                bytesRead
            );

        /*
         * PNG
         * 89 50 4E 47 0D 0A 1A 0A
         */
        if (
            data.length >= 8 &&
            data[0] === 0x89 &&
            data[1] === 0x50 &&
            data[2] === 0x4e &&
            data[3] === 0x47 &&
            data[4] === 0x0d &&
            data[5] === 0x0a &&
            data[6] === 0x1a &&
            data[7] === 0x0a
        ) {
            return {
                mime:
                    'image/png',
                extension:
                    '.png'
            };
        }

        /*
         * JPEG
         * FF D8 FF
         */
        if (
            data.length >= 3 &&
            data[0] === 0xff &&
            data[1] === 0xd8 &&
            data[2] === 0xff
        ) {
            return {
                mime:
                    'image/jpeg',
                extension:
                    '.jpg'
            };
        }

        /*
         * WebP
         * RIFF....WEBP
         */
        if (
            data.length >= 12 &&
            data.subarray(
                0,
                4
            ).toString('ascii') ===
                'RIFF' &&
            data.subarray(
                8,
                12
            ).toString('ascii') ===
                'WEBP'
        ) {
            return {
                mime:
                    'image/webp',
                extension:
                    '.webp'
            };
        }

        return null;

    } catch (err) {
        console.error(
            '[PRODUCT PHOTO SIGNATURE]',
            err.message
        );

        return null;

    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch (_) {}
        }
    }
}

function deleteProductPhotoFile(
    imageUrl
) {
    if (
        !imageUrl ||
        typeof imageUrl !== 'string'
    ) {
        return;
    }

    const prefix =
        '/uploads/products/';

    if (
        !imageUrl.startsWith(prefix)
    ) {
        return;
    }

    const fileName =
        path.basename(imageUrl);

    const filePath =
        path.join(
            productPhotoDirectory,
            fileName
        );

    try {
        if (
            fs.existsSync(filePath)
        ) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error(
            '[PRODUCT PHOTO CLEANUP]',
            err.message
        );
    }
}
const { verifyToken, requireRole } = require('../middleware/auth');

module.exports = (pool, CommerceKernel) => {

// --- MODUL CRM & PROFIL PELANGGAN ---

// 1. Mengambil semua daftar pelanggan untuk CRM
router.get('/crm/customers', verifyToken, requireRole(4), async (req, res) => {
    try {
        const query = "SELECT c.id AS customer_id, c.user_id, c.full_name, c.phone, c.tier_status, u.username, u.email, COALESCE(u.points, 0) AS points FROM tbl_customers c LEFT JOIN tbl_users u ON u.id = c.user_id ORDER BY c.created_at DESC";
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Gagal memuat data CRM:", err);
        res.status(500).json({ error: err.message });
    }
});


// Customer mengambil profil miliknya sendiri dari identitas JWT
router.get('/customer/profile/me', verifyToken, requireRole(1), async (req, res) => {
    try {
        const userRes = await pool.query(
            `SELECT
                u.username,
                u.email,
                c.phone,
                c.phone_verified_at,
                COALESCE(u.points, 0) AS points,
                COALESCE(u.tier_status, 'Regular') AS tier_status
             FROM tbl_users u
             LEFT JOIN tbl_customers c
                ON c.user_id = u.id
             WHERE u.id = $1`,
            [req.user.id]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({
                error: "Pelanggan tidak ditemukan"
            });
        }

        return res.json({
            user: userRes.rows[0]
        });
    } catch (err) {
        console.error("[CUSTOMER PROFILE ME ERROR]", err.message);
        return res.status(500).json({
            error: err.message
        });
    }
});


// Customer memperbarui nomor telepon miliknya sendiri.
// Nomor disimpan dalam format internasional Indonesia: 62xxxxxxxxxx.
router.patch('/customer/profile/me', verifyToken, requireRole(1), async (req, res) => {
    let phone = String(req.body.phone || '').trim();

    phone = phone.replace(/[^\d+]/g, '');

    if (phone.startsWith('+')) {
        phone = phone.slice(1);
    }

    if (phone.startsWith('0')) {
        phone = '62' + phone.slice(1);
    }

    if (!phone.startsWith('62') || !/^62\d{8,13}$/.test(phone)) {
        return res.status(400).json({
            error: 'Nomor telepon tidak valid',
            message: 'Gunakan nomor Indonesia yang valid'
        });
    }

    try {
        const customerResult = await pool.query(
            `SELECT id
             FROM tbl_customers
             WHERE user_id = $1
             LIMIT 1`,
            [req.user.id]
        );

        if (customerResult.rowCount === 0) {
            return res.status(404).json({
                error: 'Customer tidak ditemukan'
            });
        }

        const result = await pool.query(
            `UPDATE tbl_customers
             SET phone = $1,
                 phone_verified_at = NULL
             WHERE user_id = $2
             RETURNING id, user_id, full_name, phone, phone_verified_at`,
            [phone, req.user.id]
        );

        return res.json({
            status: 'success',
            message: 'Nomor telepon berhasil diperbarui',
            customer: result.rows[0]
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({
                error: 'Nomor telepon sudah digunakan customer lain'
            });
        }

        console.error('[CUSTOMER PHONE UPDATE]', err.message);

        return res.status(500).json({
            error: err.message
        });
    }
});


// Customer meminta challenge verifikasi nomor telepon.
// Kode OTP tidak pernah dikembalikan ke client.
router.post(
    '/customer/phone-verification/request',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        try {
            const customerResult = await pool.query(
                `SELECT id, phone, phone_verified_at
                 FROM tbl_customers
                 WHERE user_id = $1
                 LIMIT 1`,
                [req.user.id]
            );

            if (customerResult.rowCount === 0) {
                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const customer = customerResult.rows[0];

            if (!customer.phone) {
                return res.status(400).json({
                    error: 'Nomor telepon belum diisi'
                });
            }

            if (customer.phone_verified_at) {
                return res.status(409).json({
                    error: 'Nomor telepon sudah terverifikasi'
                });
            }

            const existing = await pool.query(
                `SELECT requested_at, expires_at, consumed_at
                 FROM tbl_phone_verification_challenges
                 WHERE customer_id = $1
                 LIMIT 1`,
                [customer.id]
            );

            if (existing.rowCount > 0) {
                const last = existing.rows[0];

                if (
                    !last.consumed_at &&
                    Date.now() - new Date(last.requested_at).getTime() < 60000
                ) {
                    return res.status(429).json({
                        error: 'Terlalu banyak permintaan',
                        message: 'Tunggu 60 detik sebelum meminta kode baru'
                    });
                }
            }

            const code =
                String(crypto.randomInt(0, 1000000)).padStart(6, '0');

            const codeHash = await bcrypt.hash(code, 10);

            const expiresAt =
                new Date(Date.now() + 10 * 60 * 1000);

            await pool.query(
                `INSERT INTO tbl_phone_verification_challenges
                 (
                    customer_id,
                    phone,
                    code_hash,
                    attempts,
                    requested_at,
                    expires_at,
                    consumed_at
                 )
                 VALUES ($1, $2, $3, 0, CURRENT_TIMESTAMP, $4, NULL)
                 ON CONFLICT (customer_id)
                 DO UPDATE SET
                    phone = EXCLUDED.phone,
                    code_hash = EXCLUDED.code_hash,
                    attempts = 0,
                    requested_at = CURRENT_TIMESTAMP,
                    expires_at = EXCLUDED.expires_at,
                    consumed_at = NULL`,
                [
                    customer.id,
                    customer.phone,
                    codeHash,
                    expiresAt
                ]
            );

            try {
                await PhoneVerificationDeliveryService.sendCode({
                    phone: customer.phone,
                    code
                });
            } catch (deliveryErr) {
                await pool.query(
                    `DELETE FROM tbl_phone_verification_challenges
                     WHERE customer_id = $1`,
                    [customer.id]
                );

                if (deliveryErr.code === 'OTP_DELIVERY_UNAVAILABLE') {
                    return res.status(503).json({
                        error: 'Layanan verifikasi WhatsApp belum tersedia'
                    });
                }

                console.error(
                    '[PHONE VERIFICATION DELIVERY]',
                    deliveryErr.message
                );

                return res.status(502).json({
                    error: 'Pengiriman kode verifikasi gagal'
                });
            }

            return res.status(202).json({
                status: 'success',
                message: 'Kode verifikasi sedang diproses',
                expires_in_seconds: 600
            });
        } catch (err) {
            console.error(
                '[PHONE VERIFICATION REQUEST]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });
        }
    }
);


// Customer memverifikasi nomor telepon menggunakan OTP WhatsApp.
router.post(
    '/customer/phone-verification/verify',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        const code = String(req.body.code || '').trim();

        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({
                error: 'Kode verifikasi tidak valid',
                message: 'Kode verifikasi harus terdiri dari 6 digit'
            });
        }

        let client;

        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const customerResult = await client.query(
                `SELECT id, phone, phone_verified_at
                 FROM tbl_customers
                 WHERE user_id = $1
                 LIMIT 1
                 FOR UPDATE`,
                [req.user.id]
            );

            if (customerResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const customer = customerResult.rows[0];

            if (!customer.phone) {
                await client.query('ROLLBACK');

                return res.status(400).json({
                    error: 'Nomor telepon belum diisi'
                });
            }

            if (customer.phone_verified_at) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error: 'Nomor telepon sudah terverifikasi'
                });
            }

            const challengeResult = await client.query(
                `SELECT
                    id,
                    phone,
                    code_hash,
                    attempts,
                    expires_at,
                    consumed_at
                 FROM tbl_phone_verification_challenges
                 WHERE customer_id = $1
                 LIMIT 1
                 FOR UPDATE`,
                [customer.id]
            );

            if (challengeResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error: 'Challenge verifikasi tidak ditemukan',
                    message: 'Silakan minta kode verifikasi baru'
                });
            }

            const challenge = challengeResult.rows[0];

            if (challenge.consumed_at) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error: 'Kode verifikasi sudah digunakan',
                    message: 'Silakan minta kode verifikasi baru'
                });
            }

            if (challenge.phone !== customer.phone) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error: 'Nomor telepon telah berubah',
                    message: 'Silakan minta kode verifikasi baru'
                });
            }

            if (new Date(challenge.expires_at).getTime() <= Date.now()) {
                await client.query('ROLLBACK');

                return res.status(410).json({
                    error: 'Kode verifikasi sudah kedaluwarsa',
                    message: 'Silakan minta kode verifikasi baru'
                });
            }

            if (Number(challenge.attempts) >= 5) {
                await client.query('ROLLBACK');

                return res.status(429).json({
                    error: 'Batas percobaan kode verifikasi tercapai',
                    message: 'Silakan minta kode verifikasi baru'
                });
            }

            const match = await bcrypt.compare(
                code,
                challenge.code_hash
            );

            if (!match) {
                const attemptResult = await client.query(
                    `UPDATE tbl_phone_verification_challenges
                     SET attempts = attempts + 1
                     WHERE id = $1
                     RETURNING attempts`,
                    [challenge.id]
                );

                await client.query('COMMIT');

                const attempts =
                    Number(attemptResult.rows[0].attempts);

                return res.status(400).json({
                    error: 'Kode verifikasi salah',
                    attempts_remaining: Math.max(0, 5 - attempts)
                });
            }

            const verifiedResult = await client.query(
                `UPDATE tbl_customers
                 SET phone_verified_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                   AND phone = $2
                 RETURNING
                    id,
                    user_id,
                    full_name,
                    phone,
                    phone_verified_at`,
                [customer.id, challenge.phone]
            );

            if (verifiedResult.rowCount !== 1) {
                throw new Error(
                    'Customer phone berubah selama proses verifikasi'
                );
            }

            await client.query(
                `UPDATE tbl_phone_verification_challenges
                 SET consumed_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [challenge.id]
            );

            await client.query('COMMIT');

            return res.json({
                status: 'success',
                message: 'Nomor telepon berhasil diverifikasi',
                customer: verifiedResult.rows[0]
            });
        } catch (err) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {
                    // Abaikan rollback error.
                }
            }

            console.error(
                '[PHONE VERIFICATION VERIFY]',
                err.message
            );

            return res.status(500).json({
                error: 'Gagal memverifikasi nomor telepon'
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);

// 2. Mengambil profil lengkap & riwayat notifikasi untuk Pelanggan tertentu
router.get('/customer/profile/:user_id', verifyToken, requireRole(1, 4), async (req, res) => {
    const requestedUserId = req.params.user_id;
    const effectiveUserId =
        Number(req.user.role_id) === 1
            ? req.user.id
            : requestedUserId;

    try {
        // Ambil info dasar user
        const userRes = await pool.query(
            `SELECT username, email, COALESCE(points, 0) as points, COALESCE(tier_status, 'Regular') as tier_status 
             FROM tbl_users WHERE id = $1`, 
            [effectiveUserId]
        );

        // Ambil notifikasi user
        const notifRes = await pool.query(
            `SELECT message, created_at FROM tbl_notifications 
             WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, 
            [effectiveUserId]
        );
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "Pelanggan tidak ditemukan" });
        }

        res.json({
            user: userRes.rows[0],
            notifications: notifRes.rows
        });
    } catch (err) {
        console.error("Gagal memuat profil:", err);
        res.status(500).json({ error: err.message });
    }
});


// Endpoint Daftar Produk Merchant
router.get('/products', verifyToken, requireRole(2, 4), async (req, res) => {
    try {
        const merchantResult = await pool.query(
            "SELECT id, store_name FROM tbl_merchants WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
            [req.user.id]
        );

        if (merchantResult.rows.length === 0) {
            return res.status(403).json({
                error: "Merchant aktif tidak ditemukan untuk user ini"
            });
        }

        const merchantId = merchantResult.rows[0].id;

        const result = await pool.query(
            `SELECT
                p.category_id,
                p.id,
                p.sku,
                p.name,
                p.description,
                p.selling_unit,
                p.pack_size_value,
                p.pack_size_unit,
                p.image_url,
                COALESCE(pp.amount, 0) AS price,
                COALESCE(i.quantity_on_hand, 0) AS stock,
                COALESCE(i.min_stock_level, 5) AS min_stock_level,
                w.id AS warehouse_id,
                w.warehouse_name,
                p.created_at,
                p.updated_at
             FROM tbl_products p
             LEFT JOIN tbl_product_prices pp
                ON pp.product_id = p.id
                AND pp.price_type = 'RETAIL'
             LEFT JOIN tbl_inventory i
                ON i.product_id = p.id
             LEFT JOIN tbl_warehouses w
                ON w.id = i.warehouse_id
             WHERE p.merchant_id = $1
               AND p.status = 'ACTIVE'
             ORDER BY p.created_at DESC`,
            [merchantId]
        );

        return res.json({
            status: "success",
            merchant: merchantResult.rows[0],
            count: result.rows.length,
            data: result.rows
        });
    } catch (err) {
        console.error("Gagal mengambil daftar produk merchant:", err);
        return res.status(500).json({
            error: err.message
        });
    }
});

// Endpoint Simpan Produk via Commerce Kernel
router.post('/products', verifyToken, requireRole(2, 4), async (req, res) => {
    const {
        nama_produk,
        harga,
        stok,
        sku,
        description,
        category_id,
        warehouse_id,
        min_stock_level,
        selling_unit,
        pack_size_value,
        pack_size_unit
    } = req.body;

    try {
        const merchantResult = await pool.query(
            "SELECT id FROM tbl_merchants WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
            [req.user.id]
        );

        const merchantId = merchantResult.rows.length
            ? merchantResult.rows[0].id
            : null;

        if (!merchantId) {
            return res.status(403).json({
                error: "Merchant aktif tidak ditemukan untuk user ini"
            });
        }

        if (!sku || !nama_produk || harga == null || stok == null || !warehouse_id) {
            return res.status(400).json({
                error: "sku, nama_produk, harga, stok, dan warehouse_id wajib diisi"
            });
        }

        const numericHarga = Number(harga);
        const numericStok = Number(stok);

        const normalizedSellingUnit =
            String(selling_unit || 'PCS')
                .trim()
                .toUpperCase();

        const allowedSellingUnits = [
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

        if (
            !allowedSellingUnits.includes(
                normalizedSellingUnit
            )
        ) {
            return res.status(400).json({
                error:
                    "selling_unit tidak valid"
            });
        }

        const normalizedPackSizeUnit =
            pack_size_unit === undefined ||
            pack_size_unit === null ||
            String(pack_size_unit).trim() === ''
                ? null
                : String(pack_size_unit)
                    .trim()
                    .toUpperCase();

        const numericPackSizeValue =
            pack_size_value === undefined ||
            pack_size_value === null ||
            pack_size_value === ''
                ? null
                : Number(pack_size_value);

        const allowedPackSizeUnits = [
            'GRAM',
            'KG',
            'ML',
            'LITER',
            'PCS'
        ];

        if (
            (
                numericPackSizeValue === null &&
                normalizedPackSizeUnit !== null
            ) ||
            (
                numericPackSizeValue !== null &&
                normalizedPackSizeUnit === null
            )
        ) {
            return res.status(400).json({
                error:
                    "pack_size_value dan pack_size_unit harus diisi bersama"
            });
        }

        if (
            numericPackSizeValue !== null &&
            (
                !Number.isFinite(
                    numericPackSizeValue
                ) ||
                numericPackSizeValue <= 0
            )
        ) {
            return res.status(400).json({
                error:
                    "pack_size_value harus lebih besar dari 0"
            });
        }

        if (
            normalizedPackSizeUnit !== null &&
            !allowedPackSizeUnits.includes(
                normalizedPackSizeUnit
            )
        ) {
            return res.status(400).json({
                error:
                    "pack_size_unit tidak valid"
            });
        }

        const numericMinStock =
            min_stock_level === undefined ||
            min_stock_level === null ||
            min_stock_level === ''
                ? 5
                : Number(min_stock_level);

        if (!Number.isFinite(numericHarga) || numericHarga < 0) {
            return res.status(400).json({
                error: "harga tidak valid"
            });
        }

        if (!Number.isInteger(numericStok) || numericStok < 0) {
            return res.status(400).json({
                error: "stok harus berupa bilangan bulat >= 0"
            });
        }

        if (
            !Number.isInteger(numericMinStock) ||
            numericMinStock < 0
        ) {
            return res.status(400).json({
                error:
                    "min_stock_level harus berupa bilangan bulat >= 0"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const newProd = await client.query(
                `INSERT INTO tbl_products
                 (
                    merchant_id,
                    category_id,
                    sku,
                    name,
                    description,
                    selling_unit,
                    pack_size_value,
                    pack_size_unit
                 )
                 VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8
                 )
                 RETURNING *`,
                [
                    merchantId,
                    category_id || null,
                    sku,
                    nama_produk,
                    description || null,
                    normalizedSellingUnit,
                    numericPackSizeValue,
                    normalizedPackSizeUnit
                ]
            );

            const savedProduct = newProd.rows[0];

            await client.query(
                `INSERT INTO tbl_product_prices
                 (product_id, price_type, amount)
                 VALUES ($1, 'RETAIL', $2)`,
                [savedProduct.id, numericHarga]
            );

            await client.query(
                `INSERT INTO tbl_inventory
                 (
                    warehouse_id,
                    product_id,
                    quantity_on_hand,
                    min_stock_level
                 )
                 VALUES ($1, $2, $3, $4)`,
                [
                    warehouse_id,
                    savedProduct.id,
                    numericStok,
                    numericMinStock
                ]
            );

            await client.query('COMMIT');

            setImmediate(() => {
                CommerceKernel.emitEvent(
                    'PRODUCT_CREATED',
                    'PRODUCT',
                    savedProduct.id,
                    savedProduct
                );
            });

            return res.status(201).json({
                status: "success",
                message: "Produk berhasil disimpan via Commerce Kernel Pipeline!",
                data: savedProduct
            });

        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

    } catch (err) {
        console.error("Gagal menyimpan produk:", err);
        res.status(500).json({
            error: err.message
        });
    }
});

// UPDATE Produk Merchant
router.put('/products/:id', verifyToken, requireRole(2, 4), async (req, res) => {
    const { id } = req.params;
    const {
        nama_produk,
        harga,
        stok,
        sku,
        description,
        category_id,
        warehouse_id,
        min_stock_level,
        selling_unit,
        pack_size_value,
        pack_size_unit
    } = req.body;

    if (
        !sku ||
        !nama_produk ||
        harga == null ||
        stok == null ||
        !warehouse_id
    ) {
        return res.status(400).json({
            error: "sku, nama_produk, harga, stok, dan warehouse_id wajib diisi"
        });
    }

    const numericHarga = Number(harga);
    const numericStok = Number(stok);

    const normalizedSellingUnit =
        String(selling_unit || 'PCS')
            .trim()
            .toUpperCase();

    const allowedSellingUnits = [
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

    if (
        !allowedSellingUnits.includes(
            normalizedSellingUnit
        )
    ) {
        return res.status(400).json({
            error:
                "selling_unit tidak valid"
        });
    }

    const normalizedPackSizeUnit =
        pack_size_unit === undefined ||
        pack_size_unit === null ||
        String(pack_size_unit).trim() === ''
            ? null
            : String(pack_size_unit)
                .trim()
                .toUpperCase();

    const numericPackSizeValue =
        pack_size_value === undefined ||
        pack_size_value === null ||
        pack_size_value === ''
            ? null
            : Number(pack_size_value);

    const allowedPackSizeUnits = [
        'GRAM',
        'KG',
        'ML',
        'LITER',
        'PCS'
    ];

    if (
        (
            numericPackSizeValue === null &&
            normalizedPackSizeUnit !== null
        ) ||
        (
            numericPackSizeValue !== null &&
            normalizedPackSizeUnit === null
        )
    ) {
        return res.status(400).json({
            error:
                "pack_size_value dan pack_size_unit harus diisi bersama"
        });
    }

    if (
        numericPackSizeValue !== null &&
        (
            !Number.isFinite(
                numericPackSizeValue
            ) ||
            numericPackSizeValue <= 0
        )
    ) {
        return res.status(400).json({
            error:
                "pack_size_value harus lebih besar dari 0"
        });
    }

    if (
        normalizedPackSizeUnit !== null &&
        !allowedPackSizeUnits.includes(
            normalizedPackSizeUnit
        )
    ) {
        return res.status(400).json({
            error:
                "pack_size_unit tidak valid"
        });
    }

    const numericMinStock =
        min_stock_level === undefined ||
        min_stock_level === null ||
        min_stock_level === ''
            ? 5
            : Number(min_stock_level);

    if (!Number.isFinite(numericHarga) || numericHarga < 0) {
        return res.status(400).json({
            error: "harga tidak valid"
        });
    }

    if (!Number.isInteger(numericStok) || numericStok < 0) {
        return res.status(400).json({
            error: "stok harus berupa bilangan bulat >= 0"
        });
    }

    if (
        !Number.isInteger(numericMinStock) ||
        numericMinStock < 0
    ) {
        return res.status(400).json({
            error:
                "min_stock_level harus berupa bilangan bulat >= 0"
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const merchantResult = await client.query(
            `SELECT id
             FROM tbl_merchants
             WHERE user_id = $1
               AND status = 'ACTIVE'
             LIMIT 1`,
            [req.user.id]
        );

        if (merchantResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                error: "Merchant aktif tidak ditemukan untuk user ini"
            });
        }

        const merchantId = merchantResult.rows[0].id;

        const productResult = await client.query(
            `SELECT id
             FROM tbl_products
             WHERE id = $1
               AND merchant_id = $2
             FOR UPDATE`,
            [id, merchantId]
        );

        if (productResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                error: "Produk tidak ditemukan atau bukan milik merchant ini"
            });
        }

        const updatedProduct = await client.query(
            `UPDATE tbl_products
             SET sku = $1,
                 name = $2,
                 description = $3,
                 category_id = $4,
                 selling_unit = $5,
                 pack_size_value = $6,
                 pack_size_unit = $7,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [
                sku,
                nama_produk,
                description || null,
                category_id || null,
                normalizedSellingUnit,
                numericPackSizeValue,
                normalizedPackSizeUnit,
                id
            ]
        );

        const priceResult = await client.query(
            `SELECT id
             FROM tbl_product_prices
             WHERE product_id = $1
               AND price_type = 'RETAIL'
             ORDER BY effective_date DESC
             LIMIT 1`,
            [id]
        );

        if (priceResult.rowCount > 0) {
            await client.query(
                `UPDATE tbl_product_prices
                 SET amount = $1
                 WHERE id = $2`,
                [numericHarga, priceResult.rows[0].id]
            );
        } else {
            await client.query(
                `INSERT INTO tbl_product_prices
                 (product_id, price_type, amount)
                 VALUES ($1, 'RETAIL', $2)`,
                [id, numericHarga]
            );
        }

        const inventoryResult = await client.query(
            `SELECT id
             FROM tbl_inventory
             WHERE product_id = $1
               AND warehouse_id = $2
             LIMIT 1`,
            [id, warehouse_id]
        );

        if (inventoryResult.rowCount > 0) {
            await client.query(
                `UPDATE tbl_inventory
                 SET quantity_on_hand = $1,
                     min_stock_level = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [
                    numericStok,
                    numericMinStock,
                    inventoryResult.rows[0].id
                ]
            );
        } else {
            await client.query(
                `INSERT INTO tbl_inventory
                 (
                    warehouse_id,
                    product_id,
                    quantity_on_hand,
                    min_stock_level
                 )
                 VALUES ($1, $2, $3, $4)`,
                [
                    warehouse_id,
                    id,
                    numericStok,
                    numericMinStock
                ]
            );
        }

        await client.query('COMMIT');

        const finalResult = await client.query(
            `SELECT
                p.id,
                p.sku,
                p.name,
                p.description,
                p.selling_unit,
                p.pack_size_value,
                p.pack_size_unit,
                p.image_url,
                pp.amount AS price,
                i.quantity_on_hand AS stock,
                i.min_stock_level,
                i.warehouse_id,
                w.warehouse_name,
                p.created_at,
                p.updated_at
             FROM tbl_products p
             LEFT JOIN tbl_product_prices pp
                ON pp.product_id = p.id
               AND pp.price_type = 'RETAIL'
             LEFT JOIN tbl_inventory i
                ON i.product_id = p.id
               AND i.warehouse_id = $2
             LEFT JOIN tbl_warehouses w
                ON w.id = i.warehouse_id
             WHERE p.id = $1
             ORDER BY pp.effective_date DESC
             LIMIT 1`,
            [id, warehouse_id]
        );

        return res.json({
            status: "success",
            message: "Produk berhasil diperbarui!",
            data: finalResult.rows[0] || updatedProduct.rows[0]
        });

    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}
        }

        console.error("Gagal memperbarui produk:", err);

        return res.status(500).json({
            error: err.message
        });
    } finally {
        if (client) {
            client.release();
        }
    }
});


// Upload / Replace Foto Produk Merchant
router.post(
    '/products/:id/photo',
    verifyToken,
    requireRole(2, 4),
    (
        req,
        res,
        next
    ) => {
        productPhotoUpload.single('photo')(
            req,
            res,
            err => {
                if (!err) {
                    return next();
                }

                if (
                    err instanceof multer.MulterError
                ) {
                    if (
                        err.code ===
                        'LIMIT_FILE_SIZE'
                    ) {
                        return res
                            .status(413)
                            .json({
                                error:
                                    'Ukuran foto maksimal 5 MB'
                            });
                    }

                    return res
                        .status(400)
                        .json({
                            error:
                                `Upload foto gagal: ${err.message}`
                        });
                }

                if (
                    err.code ===
                    'INVALID_PRODUCT_PHOTO_TYPE'
                ) {
                    return res
                        .status(415)
                        .json({
                            error:
                                err.message
                        });
                }

                return res
                    .status(400)
                    .json({
                        error:
                            err.message ||
                            'Upload foto gagal'
                    });
            }
        );
    },
    async (req, res) => {
        const productId =
            req.params.id;

        if (!req.file) {
            return res
                .status(400)
                .json({
                    error:
                        'File foto wajib dikirim dengan field photo'
                });
        }

        const newImageUrl =
            `/uploads/products/${req.file.filename}`;

        /*
         * Jangan percaya Content-Type multipart.
         *
         * Multer fileFilter hanya memeriksa MIME yang
         * dikirim client. Verifikasi kembali signature
         * binary file yang benar-benar tersimpan.
         */
        const detectedPhotoType =
            detectProductPhotoType(
                req.file.path
            );

        if (!detectedPhotoType) {
            deleteProductPhotoFile(
                newImageUrl
            );

            return res
                .status(415)
                .json({
                    error:
                        'Isi file bukan gambar JPG, PNG, atau WebP yang valid'
                });
        }

        if (
            detectedPhotoType.mime !==
                req.file.mimetype
        ) {
            deleteProductPhotoFile(
                newImageUrl
            );

            return res
                .status(415)
                .json({
                    error:
                        'Format isi foto tidak sesuai dengan tipe file yang dikirim'
                });
        }

        let client;

        try {
            client =
                await pool.connect();

            await client.query(
                'BEGIN'
            );

            const merchantResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_merchants
                    WHERE user_id = $1
                      AND status = 'ACTIVE'
                    LIMIT 1
                    `,
                    [req.user.id]
                );

            if (
                merchantResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                deleteProductPhotoFile(
                    newImageUrl
                );

                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant aktif tidak ditemukan'
                    });
            }

            const productResult =
                await client.query(
                    `
                    SELECT
                        id,
                        sku,
                        name,
                        image_url
                    FROM tbl_products
                    WHERE id = $1
                      AND merchant_id = $2
                      AND status = 'ACTIVE'
                    FOR UPDATE
                    `,
                    [
                        productId,
                        merchantResult.rows[0].id
                    ]
                );

            if (
                productResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                deleteProductPhotoFile(
                    newImageUrl
                );

                return res
                    .status(404)
                    .json({
                        error:
                            'Produk aktif tidak ditemukan atau bukan milik merchant ini'
                    });
            }

            const oldImageUrl =
                productResult.rows[0]
                    .image_url;

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_products
                    SET
                        image_url = $1,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $2
                    RETURNING
                        id,
                        sku,
                        name,
                        image_url,
                        updated_at
                    `,
                    [
                        newImageUrl,
                        productId
                    ]
                );

            await client.query(
                'COMMIT'
            );

            if (
                oldImageUrl &&
                oldImageUrl !==
                    newImageUrl
            ) {
                deleteProductPhotoFile(
                    oldImageUrl
                );
            }

            CommerceKernel.emitEvent(
                'PRODUCT_PHOTO_UPDATED',
                'PRODUCT',
                productId,
                updatedResult.rows[0]
            );

            return res.json({
                status:
                    'success',
                message:
                    'Foto produk berhasil disimpan',
                data:
                    updatedResult.rows[0]
            });

        } catch (err) {
            if (client) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}
            }

            deleteProductPhotoFile(
                newImageUrl
            );

            console.error(
                '[PRODUCT PHOTO UPLOAD]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal menyimpan foto produk'
                });

        } finally {
            if (client) {
                client.release();
            }
        }
    }
);

// Soft Delete Produk Merchant
router.delete('/products/:id', verifyToken, requireRole(2, 4), async (req, res) => {
    try {
        const merchant = await pool.query(
            "SELECT id FROM tbl_merchants WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
            [req.user.id]
        );

        if (merchant.rowCount === 0) {
            return res.status(403).json({
                error: "Merchant aktif tidak ditemukan"
            });
        }

        const result = await pool.query(
            `UPDATE tbl_products
             SET status = 'INACTIVE',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
               AND merchant_id = $2
               AND status = 'ACTIVE'
             RETURNING id, sku, name, status, updated_at`,
            [req.params.id, merchant.rows[0].id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: "Produk aktif tidak ditemukan atau bukan milik merchant ini"
            });
        }

        CommerceKernel.emitEvent(
            'PRODUCT_DEACTIVATED',
            'PRODUCT',
            result.rows[0].id,
            result.rows[0]
        );

        return res.json({
            status: "success",
            message: "Produk berhasil dinonaktifkan",
            data: result.rows[0]
        });

    } catch (err) {
        console.error("Gagal menonaktifkan produk:", err);
        return res.status(500).json({
            error: err.message
        });
    }
});

    // 5. Endpoint Pembelian / Simulasi Bayar QRIS oleh Pelanggan
    router.post('/purchase', (req, res) => {
        return res.status(410).json({
            status: "error",
            error: "Legacy purchase dinonaktifkan",
            message: "Gunakan POST /api/orders/checkout-v2"
        });
    });

    // 6. Legacy Courier Tasks dinonaktifkan
    router.get('/courier/tasks', verifyToken, requireRole(3, 4), (req, res) => {
        return res.status(410).json({
            status: "error",
            error: "Legacy courier tasks dinonaktifkan",
            message: "Gunakan GET /api/deliveries/me"
        });
    });

    // 7. Legacy Courier Update dinonaktifkan
    router.post('/courier/update', verifyToken, requireRole(3, 4), (req, res) => {
        return res.status(410).json({
            status: "error",
            error: "Legacy courier update dinonaktifkan",
            message: "Gunakan POST /api/complete-delivery"
        });
    });

    router.get('/metrics', verifyToken, requireRole(4), async (req, res) => {
        try {
            const productCount = await pool.query(
                `SELECT COUNT(*) AS total
                 FROM tbl_products
                 WHERE status = 'ACTIVE'`
            );

            const userCount = await pool.query(
                `SELECT COUNT(*) AS total
                 FROM tbl_users`
            );

            const orderCount = await pool.query(
                `SELECT COUNT(*) AS total
                 FROM tbl_orders_v2`
            );

            const revenueResult = await pool.query(
                `SELECT COALESCE(SUM(credit), 0) AS revenue
                 FROM tbl_general_ledger
                 WHERE account_code = '4000'`
            );

            return res.json({
                revenue: Number(revenueResult.rows[0].revenue || 0),
                orders: Number(orderCount.rows[0].total || 0),
                products: Number(productCount.rows[0].total || 0),
                users: Number(userCount.rows[0].total || 0)
            });
        } catch (err) {
            console.error("[METRICS V2 ERROR]", err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    });

    return router;
};

