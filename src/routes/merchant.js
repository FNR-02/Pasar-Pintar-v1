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

const bulkProductPhotoUpload =
    multer({
        storage:
            productPhotoStorage,
        limits: {
            fileSize:
                5 * 1024 * 1024,
            files:
                50
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
function cleanupBulkProductPhotoFiles(
    files
) {
    for (const file of files || []) {
        if (!file || !file.filename) {
            continue;
        }

        deleteProductPhotoFile(
            `/uploads/products/${file.filename}`
        );
    }
}

const { verifyToken, requireRole } = require('../middleware/auth');

module.exports = (pool, CommerceKernel) => {

// --- MODUL CRM & PROFIL PELANGGAN ---

// 1. Mengambil semua daftar pelanggan untuk CRM
router.get('/crm/customers', verifyToken, requireRole(4), async (req, res) => {
    try {
        const query = `
            SELECT
                c.id AS customer_id,
                c.user_id,
                c.full_name,
                c.phone,
                c.tier_status,
                u.username,
                u.email,
                COALESCE(l.total_points, 0) AS points,
                COALESCE(l.member_tier, 'Silver') AS loyalty_tier
            FROM tbl_customers c
            LEFT JOIN tbl_users u
              ON u.id = c.user_id
            LEFT JOIN tbl_customer_loyalty_v2 l
              ON l.customer_id = c.id
            ORDER BY c.created_at DESC
        `;
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
                c.full_name,
                c.phone,
                c.phone_verified_at,
                c.default_address,
                c.default_address_line,
                c.default_village,
                c.default_district,
                c.default_city,
                c.default_province,
                c.default_postal_code,
                c.default_landmark,
                c.default_place_id,
                c.default_latitude,
                c.default_longitude,
                COALESCE(l.total_points, 0) AS points,
                COALESCE(u.tier_status, 'Regular') AS tier_status
             FROM tbl_users u
             LEFT JOIN tbl_customers c
                ON c.user_id = u.id
             LEFT JOIN tbl_customer_loyalty_v2 l
                ON l.customer_id = c.id
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


// Customer memperbarui profil miliknya sendiri.
    //
    // full_name, phone, dan default_address disimpan di tbl_customers.
    // phone_verified_at hanya dihapus apabila nomor benar-benar berubah.
    router.patch('/customer/profile/me', verifyToken, requireRole(1), async (req, res) => {
        const fullName =
            String(req.body.full_name || '').trim();

        const defaultAddress =
            String(req.body.default_address || '').trim();

        const hasStructuredAddress =
            (field) =>
                Object.prototype.hasOwnProperty.call(
                    req.body,
                    field
                );

        const structuredText =
            (field) =>
                hasStructuredAddress(field)
                    ? (
                        String(
                            req.body[field] ?? ''
                        ).trim() || null
                    )
                    : undefined;

        const defaultAddressLine =
            structuredText(
                'default_address_line'
            );

        const defaultVillage =
            structuredText(
                'default_village'
            );

        const defaultDistrict =
            structuredText(
                'default_district'
            );

        const defaultCity =
            structuredText(
                'default_city'
            );

        const defaultProvince =
            structuredText(
                'default_province'
            );

        const defaultPostalCode =
            structuredText(
                'default_postal_code'
            );

        const defaultLandmark =
            structuredText(
                'default_landmark'
            );

        const defaultPlaceId =
            structuredText(
                'default_place_id'
            );

        const hasLatitudeField =
            hasStructuredAddress(
                'default_latitude'
            );

        const hasLongitudeField =
            hasStructuredAddress(
                'default_longitude'
            );

        if (
            hasLatitudeField !==
            hasLongitudeField
        ) {
            return res.status(400).json({
                error:
                    'Latitude dan longitude harus dikirim bersamaan',
                code:
                    'ADDRESS_COORDINATE_FIELDS_INCOMPLETE'
            });
        }

        const latRaw =
            req.body.default_latitude;

        const lngRaw =
            req.body.default_longitude;

        const hasLatValue =
            hasLatitudeField &&
            latRaw !== null &&
            String(latRaw).trim() !== '';

        const hasLngValue =
            hasLongitudeField &&
            lngRaw !== null &&
            String(lngRaw).trim() !== '';

        if (
            hasLatValue !==
            hasLngValue
        ) {
            return res.status(400).json({
                error:
                    'Latitude dan longitude harus diisi atau dikosongkan bersamaan',
                code:
                    'ADDRESS_COORDINATES_INCOMPLETE'
            });
        }

        let defaultLatitude = null;
        let defaultLongitude = null;

        if (
            hasLatValue &&
            hasLngValue
        ) {
            defaultLatitude =
                Number(latRaw);

            defaultLongitude =
                Number(lngRaw);

            if (
                !Number.isFinite(defaultLatitude) ||
                !Number.isFinite(defaultLongitude) ||
                defaultLatitude < -90 ||
                defaultLatitude > 90 ||
                defaultLongitude < -180 ||
                defaultLongitude > 180
            ) {
                return res.status(400).json({
                    error:
                        'Koordinat alamat tidak valid',
                    code:
                        'INVALID_ADDRESS_COORDINATES'
                });
            }
        }

        const structuredLimits = [
            [
                'default_address_line',
                defaultAddressLine,
                1000
            ],
            [
                'default_village',
                defaultVillage,
                120
            ],
            [
                'default_district',
                defaultDistrict,
                120
            ],
            [
                'default_city',
                defaultCity,
                120
            ],
            [
                'default_province',
                defaultProvince,
                120
            ],
            [
                'default_postal_code',
                defaultPostalCode,
                12
            ],
            [
                'default_landmark',
                defaultLandmark,
                1000
            ],
            [
                'default_place_id',
                defaultPlaceId,
                255
            ]
        ];

        for (
            const [
                field,
                value,
                maxLength
            ] of structuredLimits
        ) {
            if (
                value !== undefined &&
                value !== null &&
                value.length > maxLength
            ) {
                return res.status(400).json({
                    error:
                        field +
                        ' maksimal ' +
                        maxLength +
                        ' karakter',
                    code:
                        'STRUCTURED_ADDRESS_TOO_LONG',
                    field,
                    max_length:
                        maxLength
                });
            }
        }

        let phone =
            String(req.body.phone || '').trim();

        if (!fullName) {
            return res.status(400).json({
                error: 'Nama lengkap wajib diisi',
                code: 'FULL_NAME_REQUIRED'
            });
        }

        if (fullName.length > 150) {
            return res.status(400).json({
                error: 'Nama lengkap maksimal 150 karakter',
                code: 'FULL_NAME_TOO_LONG'
            });
        }

        if (!defaultAddress) {
            return res.status(400).json({
                error: 'Alamat utama wajib diisi',
                code: 'DEFAULT_ADDRESS_REQUIRED'
            });
        }

        if (defaultAddress.length > 1000) {
            return res.status(400).json({
                error: 'Alamat utama maksimal 1000 karakter',
                code: 'DEFAULT_ADDRESS_TOO_LONG'
            });
        }

        phone =
            phone.replace(/[^\d+]/g, '');

        if (phone.startsWith('+')) {
            phone = phone.slice(1);
        }

        if (phone.startsWith('0')) {
            phone =
                '62' + phone.slice(1);
        }

        if (
            !phone.startsWith('62') ||
            !/^62\d{8,13}$/.test(phone)
        ) {
            return res.status(400).json({
                error: 'Nomor telepon tidak valid',
                message: 'Gunakan nomor Indonesia yang valid',
                code: 'INVALID_PHONE'
            });
        }

        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            const currentResult =
                await client.query(
                    `SELECT
                        id,
                        full_name,
                        phone,
                        phone_verified_at,
                        default_address
                     FROM tbl_customers
                     WHERE user_id = $1
                     LIMIT 1
                     FOR UPDATE`,
                    [req.user.id]
                );

            if (currentResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const current =
                currentResult.rows[0];

            const phoneChanged =
                String(current.phone || '') !==
                phone;

            const result =
                await client.query(
                    `UPDATE tbl_customers
                     SET
                        full_name = $1,
                        phone = $2,
                        default_address = $3,
                        phone_verified_at =
                            CASE
                                WHEN $4::boolean
                                THEN NULL
                                ELSE phone_verified_at
                            END,
                        default_address_line =
                            CASE
                                WHEN $16::boolean
                                THEN $5
                                ELSE default_address_line
                            END,
                        default_village =
                            CASE
                                WHEN $17::boolean
                                THEN $6
                                ELSE default_village
                            END,
                        default_district =
                            CASE
                                WHEN $18::boolean
                                THEN $7
                                ELSE default_district
                            END,
                        default_city =
                            CASE
                                WHEN $19::boolean
                                THEN $8
                                ELSE default_city
                            END,
                        default_province =
                            CASE
                                WHEN $20::boolean
                                THEN $9
                                ELSE default_province
                            END,
                        default_postal_code =
                            CASE
                                WHEN $21::boolean
                                THEN $10
                                ELSE default_postal_code
                            END,
                        default_landmark =
                            CASE
                                WHEN $22::boolean
                                THEN $11
                                ELSE default_landmark
                            END,
                        default_place_id =
                            CASE
                                WHEN $23::boolean
                                THEN $12
                                ELSE default_place_id
                            END,
                        default_latitude =
                            CASE
                                WHEN $24::boolean
                                THEN $13
                                ELSE default_latitude
                            END,
                        default_longitude =
                            CASE
                                WHEN $24::boolean
                                THEN $14
                                ELSE default_longitude
                            END
                     WHERE user_id = $15
                     RETURNING
                        id,
                        user_id,
                        full_name,
                        phone,
                        phone_verified_at,
                        default_address,
                        default_address_line,
                        default_village,
                        default_district,
                        default_city,
                        default_province,
                        default_postal_code,
                        default_landmark,
                        default_place_id,
                        default_latitude,
                        default_longitude,
                        tier_status`,
                    [
                        fullName,
                        phone,
                        defaultAddress,
                        phoneChanged,
                        defaultAddressLine,
                        defaultVillage,
                        defaultDistrict,
                        defaultCity,
                        defaultProvince,
                        defaultPostalCode,
                        defaultLandmark,
                        defaultPlaceId,
                        defaultLatitude,
                        defaultLongitude,
                        req.user.id,
                        hasStructuredAddress(
                            'default_address_line'
                        ),
                        hasStructuredAddress(
                            'default_village'
                        ),
                        hasStructuredAddress(
                            'default_district'
                        ),
                        hasStructuredAddress(
                            'default_city'
                        ),
                        hasStructuredAddress(
                            'default_province'
                        ),
                        hasStructuredAddress(
                            'default_postal_code'
                        ),
                        hasStructuredAddress(
                            'default_landmark'
                        ),
                        hasStructuredAddress(
                            'default_place_id'
                        ),
                        hasStructuredAddress(
                            'default_latitude'
                        ) ||
                        hasStructuredAddress(
                            'default_longitude'
                        )
                    ]
                );

            await client.query('COMMIT');

            return res.json({
                status: 'success',
                message: 'Profil berhasil diperbarui',
                phone_changed: phoneChanged,
                customer: result.rows[0]
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            if (err.code === '23505') {
                return res.status(409).json({
                    error:
                        'Nomor telepon sudah digunakan customer lain',
                    code:
                        'PHONE_ALREADY_USED'
                });
            }

            console.error(
                '[CUSTOMER PROFILE UPDATE]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });

        } finally {
            client.release();
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

            const challengeUpsert = await pool.query(
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
                    consumed_at = NULL
                   WHERE tbl_phone_verification_challenges.consumed_at IS NOT NULL
                      OR tbl_phone_verification_challenges.requested_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
                   RETURNING id`,
                [
                    customer.id,
                    customer.phone,
                    codeHash,
                    expiresAt
                ]
            );

            if (challengeUpsert.rowCount === 0) {
                return res.status(429).json({
                    error: 'Terlalu banyak permintaan',
                    message: 'Tunggu 60 detik sebelum meminta kode baru'
                });
            }

            try {
                await PhoneVerificationDeliveryService.sendCode({
                    phone: customer.phone,
                    code
                });
            } catch (deliveryErr) {
                await pool.query(
                    `DELETE FROM tbl_phone_verification_challenges
                     WHERE customer_id = $1
                       AND code_hash = $2`,
                    [customer.id, codeHash]
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
            `SELECT
                u.username,
                u.email,
                COALESCE(l.total_points, 0) AS points,
                COALESCE(u.tier_status, 'Regular') AS tier_status
             FROM tbl_users u
             LEFT JOIN tbl_customers c
                ON c.user_id = u.id
             LEFT JOIN tbl_customer_loyalty_v2 l
                ON l.customer_id = c.id
             WHERE u.id = $1`,
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


async function resolveLeafCategory(
    db,
    categoryId
) {
    if (
        categoryId === undefined ||
        categoryId === null ||
        String(categoryId).trim() === ''
    ) {
        return {
            valid: true,
            id: null
        };
    }

    const numericCategoryId =
        Number(categoryId);

    if (
        !Number.isInteger(
            numericCategoryId
        ) ||
        numericCategoryId <= 0
    ) {
        return {
            valid: false,
            id: null
        };
    }

    const result = await db.query(
        `SELECT
            c.id,
            c.parent_id,
            EXISTS (
                SELECT 1
                FROM tbl_product_categories child
                WHERE child.parent_id = c.id
            ) AS has_children
         FROM tbl_product_categories c
         WHERE c.id = $1
         LIMIT 1`,
        [numericCategoryId]
    );

    if (
        result.rowCount === 0 ||
        result.rows[0].parent_id === null ||
        result.rows[0].has_children
    ) {
        return {
            valid: false,
            id: null
        };
    }

    return {
        valid: true,
        id: result.rows[0].id
    };
}


// Endpoint Daftar Kategori Produk
router.get('/categories', verifyToken, requireRole(2, 4), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                c.id,
                c.name,
                c.parent_id,
                parent.name AS parent_name
             FROM tbl_product_categories c
             LEFT JOIN tbl_product_categories parent
                ON parent.id = c.parent_id
             WHERE c.parent_id IS NOT NULL
               AND NOT EXISTS (
                SELECT 1
                FROM tbl_product_categories child
                WHERE child.parent_id = c.id
             )
             ORDER BY
                COALESCE(parent.name, c.name) ASC,
                c.name ASC`
        );

        return res.json({
            status: "success",
            count: result.rows.length,
            data: result.rows
        });
    } catch (err) {
        console.error("Gagal mengambil kategori produk:", err);
        return res.status(500).json({
            error: err.message
        });
    }
});

// Endpoint Daftar Warehouse Merchant
router.get('/warehouses', verifyToken, requireRole(2, 4), async (req, res) => {
    try {
        const merchantResult = await pool.query(
            `SELECT id
             FROM tbl_merchants
             WHERE user_id = $1
               AND status = 'ACTIVE'
             LIMIT 1`,
            [req.user.id]
        );

        if (merchantResult.rowCount === 0) {
            return res.status(403).json({
                error: "Merchant aktif tidak ditemukan untuk user ini"
            });
        }

        const merchantId = merchantResult.rows[0].id;

        const result = await pool.query(
            `SELECT id, warehouse_name, location
             FROM tbl_warehouses
             WHERE merchant_id = $1
               AND warehouse_type = 'MERCHANT_STORE'
             ORDER BY warehouse_name ASC`,
            [merchantId]
        );

        return res.json({
            status: "success",
            count: result.rows.length,
            data: result.rows
        });
    } catch (err) {
        console.error("Gagal mengambil warehouse merchant:", err);
        return res.status(500).json({
            error: "Terjadi kesalahan saat mengambil warehouse"
        });
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
                p.parent_product_id,
                p.variant_label,
                parent.name AS parent_product_name,
                parent.sku AS parent_product_sku,
                p.image_url,
                p.customer_visible,
                COALESCE(pp.amount, 0) AS price,
                COALESCE(i.quantity_on_hand, 0) AS stock,
                COALESCE(i.min_stock_level, 5) AS min_stock_level,
                w.id AS warehouse_id,
                w.warehouse_name,
                p.created_at,
                p.updated_at
             FROM tbl_products p
             LEFT JOIN tbl_products parent
                ON parent.id = p.parent_product_id
               AND parent.merchant_id = p.merchant_id
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
        pack_size_unit,
        parent_product_id,
        variant_label
    } = req.body;

    try {
        const merchantResult = await pool.query(
            `SELECT id, store_name, address
             FROM tbl_merchants
             WHERE user_id = $1
               AND status = 'ACTIVE'
             LIMIT 1`,
            [req.user.id]
        );

        const merchantId = merchantResult.rows.length
            ? merchantResult.rows[0].id
            : null;
        const merchantStoreName = merchantResult.rows.length
            ? merchantResult.rows[0].store_name
            : null;
        const merchantAddress = merchantResult.rows.length
            ? merchantResult.rows[0].address
            : null;

        if (!merchantId) {
            return res.status(403).json({
                error: "Merchant aktif tidak ditemukan untuk user ini"
            });
        }

        const normalizedParentProductId =
            parent_product_id === undefined ||
            parent_product_id === null ||
            String(parent_product_id).trim() === ''
                ? null
                : String(
                    parent_product_id
                  ).trim();

        const normalizedVariantLabel =
            variant_label === undefined ||
            variant_label === null ||
            String(variant_label).trim() === ''
                ? null
                : String(
                    variant_label
                  ).trim();

        if (
            normalizedVariantLabel &&
            !normalizedParentProductId
        ) {
            return res.status(400).json({
                error:
                    "variant_label membutuhkan parent_product_id"
            });
        }

        if (
            normalizedVariantLabel &&
            normalizedVariantLabel.length > 120
        ) {
            return res.status(400).json({
                error:
                    "variant_label maksimal 120 karakter"
            });
        }

        if (normalizedParentProductId) {
            const parentResult =
                await pool.query(
                    `SELECT id
                     FROM tbl_products
                     WHERE id = $1
                       AND merchant_id = $2
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [
                        normalizedParentProductId,
                        merchantId
                    ]
                );

            if (!parentResult.rowCount) {
                return res.status(400).json({
                    error:
                        "Parent product tidak valid atau bukan milik merchant ini"
                });
            }
        }

        if (!sku || !nama_produk || harga == null || stok == null) {
            return res.status(400).json({
                error: "sku, nama_produk, harga, dan stok wajib diisi"
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

            const categoryValidation =
                await resolveLeafCategory(
                    client,
                    category_id
                );

            if (!categoryValidation.valid) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: "Kategori produk tidak valid atau bukan kategori akhir"
                });
            }

            let effectiveWarehouseId =
                warehouse_id === undefined ||
                warehouse_id === null ||
                String(warehouse_id).trim() === ''
                    ? null
                    : String(warehouse_id).trim();

            if (effectiveWarehouseId) {
                const warehouseResult = await client.query(
                    `SELECT id
                     FROM tbl_warehouses
                     WHERE id = $1
                       AND merchant_id = $2
                       AND warehouse_type = 'MERCHANT_STORE'
                     LIMIT 1`,
                    [effectiveWarehouseId, merchantId]
                );

                if (warehouseResult.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        error: "Warehouse tidak valid atau bukan milik merchant ini"
                    });
                }
            } else {
                await client.query(
                    `SELECT pg_advisory_xact_lock(hashtext($1))`,
                    [String(merchantId)]
                );

                const safeStoreName =
                    String(merchantStoreName || 'Merchant').trim() ||
                    'Merchant';

                const defaultWarehouseName =
                    `Stok Toko - ${safeStoreName}`;

                let defaultWarehouseResult =
                    await client.query(
                        `SELECT id
                         FROM tbl_warehouses
                         WHERE merchant_id = $1
                           AND warehouse_name = $2
                           AND warehouse_type = 'MERCHANT_STORE'
                         ORDER BY created_at ASC
                         LIMIT 1`,
                        [merchantId, defaultWarehouseName]
                    );

                if (defaultWarehouseResult.rowCount === 0) {
                    defaultWarehouseResult =
                        await client.query(
                            `INSERT INTO tbl_warehouses
                             (
                                warehouse_name,
                                location,
                                merchant_id,
                                warehouse_type
                             )
                             VALUES (
                                $1,
                                $2,
                                $3,
                                'MERCHANT_STORE'
                             )
                             RETURNING id`,
                            [
                                defaultWarehouseName,
                                merchantAddress ||
                                    'Lokasi usaha merchant',
                                merchantId
                            ]
                        );
                }

                effectiveWarehouseId =
                    defaultWarehouseResult.rows[0].id;
            }

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
                    pack_size_unit,
                    parent_product_id,
                    variant_label,
                    customer_visible
                 )
                 VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    FALSE
                 )
                 RETURNING *`,
                [
                    merchantId,
                    categoryValidation.id,
                    sku,
                    nama_produk,
                    description || null,
                    normalizedSellingUnit,
                    numericPackSizeValue,
                    normalizedPackSizeUnit,
                    normalizedParentProductId,
                    normalizedVariantLabel
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
                    effectiveWarehouseId,
                    savedProduct.id,
                    numericStok,
                    numericMinStock
                ]
            );

            if (numericStok > 0) {
                await client.query(
                    `INSERT INTO tbl_inventory_movements
                     (
                        product_id,
                        warehouse_id,
                        movement_type,
                        quantity,
                        reference_doc,
                        created_by,
                        notes
                     )
                     VALUES ($1, $2, 'OPENING_STOCK', $3, $4, $5, $6)`,
                    [
                        savedProduct.id,
                        effectiveWarehouseId,
                        numericStok,
                        `PRODUCT-${savedProduct.id}`,
                        req.user.id,
                        'Stok awal saat produk dibuat'
                    ]
                );
            }

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
        if (
            err.code === '23505' &&
            err.constraint ===
                'tbl_products_merchant_sku_key'
        ) {
            return res.status(409).json({
                error:
                    'SKU sudah digunakan oleh produk lain pada merchant ini'
            });
        }

        console.error(
            "Gagal menyimpan produk:",
            err
        );

        return res.status(500).json({
            error:
                "Terjadi kesalahan saat menyimpan produk"
        });
    }
});

// UPDATE Produk Merchant
router.put('/products/:id', verifyToken, requireRole(2, 4), async (req, res) => {
    const { id } = req.params;
    const {
        nama_produk,
        harga,
        sku,
        description,
        category_id,
        warehouse_id,
        min_stock_level,
        selling_unit,
        pack_size_value,
        pack_size_unit,
        parent_product_id,
        variant_label
    } = req.body;

    if (
        !sku ||
        !nama_produk ||
        harga == null
    ) {
        return res.status(400).json({
            error: "sku, nama_produk, dan harga wajib diisi"
        });
    }

    const numericHarga = Number(harga);

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

    if (
        !Number.isInteger(numericMinStock) ||
        numericMinStock < 0
    ) {
        return res.status(400).json({
            error:
                "min_stock_level harus berupa bilangan bulat >= 0"
        });
    }

    const normalizedParentProductId =
        parent_product_id === undefined ||
        parent_product_id === null ||
        String(parent_product_id).trim() === ''
            ? null
            : String(
                parent_product_id
              ).trim();

    const normalizedVariantLabel =
        variant_label === undefined ||
        variant_label === null ||
        String(variant_label).trim() === ''
            ? null
            : String(
                variant_label
              ).trim();

    if (
        normalizedVariantLabel &&
        !normalizedParentProductId
    ) {
        return res.status(400).json({
            error:
                "variant_label membutuhkan parent_product_id"
        });
    }

    if (
        normalizedVariantLabel &&
        normalizedVariantLabel.length > 120
    ) {
        return res.status(400).json({
            error:
                "variant_label maksimal 120 karakter"
        });
    }

    if (
        normalizedParentProductId &&
        normalizedParentProductId ===
            String(id)
    ) {
        return res.status(400).json({
            error:
                "Produk tidak boleh menjadi parent dirinya sendiri"
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const merchantResult = await client.query(
            `SELECT id, store_name, address
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
        const merchantStoreName =
            merchantResult.rows[0].store_name;
        const merchantAddress =
            merchantResult.rows[0].address;


        const productResult = await client.query(
            `SELECT
                id,
                image_url,
                customer_visible
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

        const categoryValidation =
            await resolveLeafCategory(
                client,
                category_id
            );

        if (!categoryValidation.valid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: "Kategori produk tidak valid atau bukan kategori akhir"
            });
        }

        let effectiveWarehouseId =
            warehouse_id === undefined ||
            warehouse_id === null ||
            String(warehouse_id).trim() === ''
                ? null
                : String(warehouse_id).trim();

        if (!effectiveWarehouseId) {
            const existingInventory =
                await client.query(
                    `SELECT warehouse_id
                     FROM tbl_inventory
                     WHERE product_id = $1
                     ORDER BY updated_at DESC NULLS LAST`,
                    [id]
                );

            if (
                existingInventory.rowCount === 1 &&
                existingInventory.rows[0].warehouse_id
            ) {
                effectiveWarehouseId =
                    existingInventory.rows[0].warehouse_id;
            } else if (existingInventory.rowCount > 1) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error:
                        "Produk memiliki stok di lebih dari satu warehouse; warehouse_id wajib dipilih"
                });
            }
        }

        if (!effectiveWarehouseId) {
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext($1))`,
                [String(merchantId)]
            );

            const safeStoreName =
                String(merchantStoreName || 'Merchant').trim() ||
                'Merchant';

            const defaultWarehouseName =
                `Stok Toko - ${safeStoreName}`;

            let defaultWarehouseResult =
                await client.query(
                    `SELECT id
                     FROM tbl_warehouses
                     WHERE merchant_id = $1
                       AND warehouse_name = $2
                       AND warehouse_type = 'MERCHANT_STORE'
                     ORDER BY created_at ASC
                     LIMIT 1`,
                    [merchantId, defaultWarehouseName]
                );

            if (defaultWarehouseResult.rowCount === 0) {
                defaultWarehouseResult =
                    await client.query(
                        `INSERT INTO tbl_warehouses
                         (
                            warehouse_name,
                            location,
                            merchant_id,
                            warehouse_type
                         )
                         VALUES (
                            $1,
                            $2,
                            $3,
                            'MERCHANT_STORE'
                         )
                         RETURNING id`,
                        [
                            defaultWarehouseName,
                            merchantAddress ||
                                'Lokasi usaha merchant',
                            merchantId
                        ]
                    );
            }

            effectiveWarehouseId =
                defaultWarehouseResult.rows[0].id;
        }

        const warehouseResult = await client.query(
            `SELECT id
             FROM tbl_warehouses
             WHERE id = $1
               AND merchant_id = $2
               AND warehouse_type = 'MERCHANT_STORE'
             LIMIT 1`,
            [effectiveWarehouseId, merchantId]
        );

        if (warehouseResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: "Warehouse tidak valid atau bukan milik merchant ini"
            });
        }

        if (normalizedParentProductId) {
            const parentResult =
                await client.query(
                    `SELECT id
                     FROM tbl_products
                     WHERE id = $1
                       AND merchant_id = $2
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [
                        normalizedParentProductId,
                        merchantId
                    ]
                );

            if (!parentResult.rowCount) {
                await client.query(
                    'ROLLBACK'
                );

                return res.status(400).json({
                    error:
                        "Parent product tidak valid atau bukan milik merchant ini"
                });
            }
        }

        const currentProduct =
            productResult.rows[0];

        const remainsPublishReady =
            Boolean(
                String(description || '').trim()
            ) &&
            Boolean(
                String(
                    currentProduct.image_url || ''
                ).trim()
            ) &&
            numericHarga > 0;

        const keepCustomerVisible =
            currentProduct.customer_visible === true &&
            remainsPublishReady;

        const updatedProduct = await client.query(
            `UPDATE tbl_products
             SET sku = $1,
                 name = $2,
                 description = $3,
                 category_id = $4,
                 selling_unit = $5,
                 pack_size_value = $6,
                 pack_size_unit = $7,
                 parent_product_id = $8,
                 variant_label = $9,
                 customer_visible = $10,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $11
             RETURNING *`,
            [
                sku,
                nama_produk,
                description || null,
                categoryValidation.id,
                normalizedSellingUnit,
                numericPackSizeValue,
                normalizedPackSizeUnit,
                normalizedParentProductId,
                normalizedVariantLabel,
                keepCustomerVisible,
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
            [id, effectiveWarehouseId]
        );
        if (inventoryResult.rowCount > 0) {
            await client.query(
                `UPDATE tbl_inventory
                 SET min_stock_level = $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [
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
                 VALUES ($1, $2, 0, $3)`,
                [
                    effectiveWarehouseId,
                    id,
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
            [id, effectiveWarehouseId]
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

        if (
            err.code === '23505' &&
            err.constraint ===
                'tbl_products_merchant_sku_key'
        ) {
            return res.status(409).json({
                error:
                    'SKU sudah digunakan oleh produk lain pada merchant ini'
            });
        }

        console.error(
            "Gagal memperbarui produk:",
            err
        );

        return res.status(500).json({
            error:
                "Terjadi kesalahan saat memperbarui produk"
        });
    } finally {
        if (client) {
            client.release();
        }
    }
});



// Penyesuaian stok merchant melalui inventory ledger
router.post(
    '/products/:id/stock-adjustment',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        const productId = String(req.params.id || '').trim();
        const direction = String(req.body.direction || '').trim().toUpperCase();
        const quantity = Number(req.body.quantity);
        const reason = String(req.body.reason || '').trim();
        const referenceKey = String(req.body.reference_key || '').trim();
        const requestedWarehouseId =
            req.body.warehouse_id == null
                ? ''
                : String(req.body.warehouse_id).trim();

        if (!['IN', 'OUT'].includes(direction)) {
            return res.status(400).json({
                error: 'direction harus IN atau OUT'
            });
        }

        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            return res.status(400).json({
                error: 'quantity harus bilangan bulat positif'
            });
        }

        if (!reason || reason.length > 500) {
            return res.status(400).json({
                error: 'reason wajib diisi, maksimal 500 karakter'
            });
        }

        if (
            !referenceKey ||
            referenceKey.length > 60 ||
            !/^[A-Za-z0-9._:-]+$/.test(referenceKey)
        ) {
            return res.status(400).json({
                error: 'reference_key tidak valid'
            });
        }

        const referenceDoc = `ADJ-${referenceKey}`;
        const movementType =
            direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';

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

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    error: 'Merchant aktif tidak ditemukan'
                });
            }

            const merchantId = merchantResult.rows[0].id;

            const productResult = await client.query(
                `SELECT id
                 FROM tbl_products
                 WHERE id = $1
                   AND merchant_id = $2
                 FOR UPDATE`,
                [productId, merchantId]
            );

            if (!productResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    error: 'Produk tidak ditemukan atau bukan milik merchant ini'
                });
            }

            const inventoryResult = await client.query(
                `SELECT
                    i.id AS inventory_id,
                    i.warehouse_id,
                    i.quantity_on_hand
                 FROM tbl_inventory i
                 JOIN tbl_warehouses w
                   ON w.id = i.warehouse_id
                 WHERE i.product_id = $1
                   AND w.merchant_id = $2
                   AND w.warehouse_type = 'MERCHANT_STORE'
                   AND ($3 = '' OR i.warehouse_id::text = $3)
                 ORDER BY i.updated_at DESC NULLS LAST
                 FOR UPDATE OF i`,
                [productId, merchantId, requestedWarehouseId]
            );

            if (!inventoryResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    error: 'Inventory tidak ditemukan untuk warehouse tersebut'
                });
            }

            if (!requestedWarehouseId && inventoryResult.rowCount > 1) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: 'Produk memiliki beberapa warehouse; warehouse_id wajib dipilih'
                });
            }

            const inventory = inventoryResult.rows[0];

            const existingMovement = await client.query(
                `SELECT
                    id,
                    warehouse_id,
                    movement_type,
                    quantity,
                    created_by,
                    notes
                 FROM tbl_inventory_movements
                 WHERE reference_doc = $1
                   AND product_id = $2
                   AND movement_type IN (
                       'ADJUSTMENT_IN',
                       'ADJUSTMENT_OUT'
                   )
                 LIMIT 1`,
                [referenceDoc, productId]
            );

            if (existingMovement.rowCount) {
                const existing = existingMovement.rows[0];
                const sameRequest =
                    existing.movement_type === movementType &&
                    Number(existing.quantity) === quantity &&
                    String(existing.warehouse_id) === String(inventory.warehouse_id) &&
                    String(existing.created_by) === String(req.user.id) &&
                    String(existing.notes || '') === reason;

                if (!sameRequest) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({
                        error: 'reference_key sudah digunakan untuk penyesuaian berbeda'
                    });
                }

                await client.query('COMMIT');
                return res.json({
                    status: 'success',
                    duplicate: true,
                    message: 'Penyesuaian ini sudah pernah diproses',
                    data: {
                        movement_id: existing.id,
                        warehouse_id: inventory.warehouse_id,
                        stock: Number(inventory.quantity_on_hand)
                    }
                });
            }

            const currentStock = Number(inventory.quantity_on_hand);

            if (
                direction === 'OUT' &&
                currentStock < quantity
            ) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: 'Stok tidak mencukupi untuk penyesuaian keluar',
                    current_stock: currentStock
                });
            }

            const movementResult = await client.query(
                `INSERT INTO tbl_inventory_movements
                 (
                    product_id,
                    warehouse_id,
                    movement_type,
                    quantity,
                    reference_doc,
                    created_by,
                    notes
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id`,
                [
                    productId,
                    inventory.warehouse_id,
                    movementType,
                    quantity,
                    referenceDoc,
                    req.user.id,
                    reason
                ]
            );

            const updatedInventory = await client.query(
                `UPDATE tbl_inventory
                 SET quantity_on_hand = quantity_on_hand ${direction === 'IN' ? '+' : '-'} $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2
                 RETURNING quantity_on_hand`,
                [quantity, inventory.inventory_id]
            );

            await client.query('COMMIT');

            return res.json({
                status: 'success',
                duplicate: false,
                message: 'Penyesuaian stok berhasil dicatat',
                data: {
                    movement_id: movementResult.rows[0].id,
                    warehouse_id: inventory.warehouse_id,
                    movement_type: movementType,
                    quantity,
                    stock: Number(updatedInventory.rows[0].quantity_on_hand)
                }
            });

        } catch (err) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {}
            }

            if (err.code === '23505') {
                return res.status(409).json({
                    error: 'Penyesuaian dengan reference_key tersebut sudah tercatat'
                });
            }

            console.error('Gagal melakukan penyesuaian stok:', err);
            return res.status(500).json({
                error: 'Terjadi kesalahan saat menyesuaikan stok'
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);


// Publish Produk Merchant
router.post(
    '/products/:id/publish',
    verifyToken,
    requireRole(2, 4),
    async (req, res) => {
        const { id } = req.params;

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const merchantResult =
                await client.query(
                    `SELECT id
                     FROM tbl_merchants
                     WHERE user_id = $1
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [req.user.id]
                );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const result = await client.query(
                `SELECT
                    p.id,
                    p.sku,
                    p.name,
                    p.description,
                    p.image_url,
                    p.category_id,
                    p.selling_unit,
                    p.status,
                    p.customer_visible,
                    c.parent_id AS category_parent_id,
                    EXISTS (
                        SELECT 1
                        FROM tbl_product_categories child
                        WHERE child.parent_id = c.id
                    ) AS category_has_children,
                    (
                        SELECT pp.amount
                        FROM tbl_product_prices pp
                        WHERE pp.product_id = p.id
                          AND pp.price_type = 'RETAIL'
                        ORDER BY pp.effective_date DESC
                        LIMIT 1
                    ) AS price,
                    EXISTS (
                        SELECT 1
                        FROM tbl_inventory i
                        WHERE i.product_id = p.id
                          AND i.warehouse_id IS NOT NULL
                    ) AS has_inventory
                 FROM tbl_products p
                 LEFT JOIN tbl_product_categories c
                   ON c.id = p.category_id
                 WHERE p.id = $1
                   AND p.merchant_id = $2
                 LIMIT 1
                 FOR UPDATE OF p`,
                [id, merchantResult.rows[0].id]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    error:
                        'Produk tidak ditemukan atau bukan milik merchant ini'
                });
            }

            const product = result.rows[0];
            const missing = [];

            if (product.status !== 'ACTIVE') {
                missing.push('produk tidak aktif');
            }
            if (!String(product.sku || '').trim()) {
                missing.push('SKU');
            }
            if (!String(product.name || '').trim()) {
                missing.push('nama produk');
            }
            if (!String(product.description || '').trim()) {
                missing.push('deskripsi');
            }
            if (!String(product.image_url || '').trim()) {
                missing.push('foto');
            }
            if (
                !product.category_id ||
                product.category_parent_id === null ||
                product.category_has_children
            ) {
                missing.push('kategori akhir');
            }
            if (
                !Number.isFinite(Number(product.price)) ||
                Number(product.price) <= 0
            ) {
                missing.push('harga');
            }
            if (!product.has_inventory) {
                missing.push('gudang/inventory');
            }
            if (!String(product.selling_unit || '').trim()) {
                missing.push('satuan jual');
            }

            if (missing.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error:
                        'Produk belum siap dipublikasikan',
                    missing
                });
            }

            const updated = await client.query(
                `UPDATE tbl_products
                 SET customer_visible = TRUE,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                   AND merchant_id = $2
                 RETURNING
                    id,
                    sku,
                    name,
                    customer_visible`,
                [id, merchantResult.rows[0].id]
            );

            await client.query('COMMIT');

            return res.json({
                status: 'success',
                message:
                    'Produk berhasil dipublikasikan',
                data: updated.rows[0]
            });
        } catch (err) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {}
            }

            console.error(
                '[PRODUCT PUBLISH]',
                err
            );

            return res.status(500).json({
                error:
                    'Gagal mempublikasikan produk'
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);

// Unpublish Produk Merchant
router.post(
    '/products/:id/unpublish',
    verifyToken,
    requireRole(2, 4),
    async (req, res) => {
        const { id } = req.params;

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

            if (!merchantResult.rowCount) {
                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const updated = await pool.query(
                `UPDATE tbl_products
                 SET customer_visible = FALSE,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                   AND merchant_id = $2
                   AND status = 'ACTIVE'
                 RETURNING
                    id,
                    sku,
                    name,
                    customer_visible`,
                [id, merchantResult.rows[0].id]
            );

            if (!updated.rowCount) {
                return res.status(404).json({
                    error:
                        'Produk aktif tidak ditemukan atau bukan milik merchant ini'
                });
            }

            return res.json({
                status: 'success',
                message:
                    'Produk disembunyikan dari customer',
                data: updated.rows[0]
            });
        } catch (err) {
            console.error(
                '[PRODUCT UNPUBLISH]',
                err
            );

            return res.status(500).json({
                error:
                    'Gagal menyembunyikan produk'
            });
        }
    }
);

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

// Daftar Produk Yang Menunggu Foto Import
router.get(
    '/products/photos/pending',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const merchantResult =
                await pool.query(
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
                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant aktif tidak ditemukan'
                    });
            }

            const merchantId =
                merchantResult.rows[0].id;

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        sku,
                        name,
                        import_photo_filename,
                        image_url,
                        customer_visible
                    FROM tbl_products
                    WHERE merchant_id = $1
                      AND status = 'ACTIVE'
                      AND import_photo_filename IS NOT NULL
                      AND BTRIM(
                            import_photo_filename
                          ) <> ''
                    ORDER BY
                        name ASC,
                        sku ASC
                    `,
                    [merchantId]
                );

            return res.json({
                status:
                    'success',
                pending_count:
                    result.rowCount,
                products:
                    result.rows
            });
        } catch (err) {
            console.error(
                '[PENDING PRODUCT PHOTOS]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal mengambil daftar foto yang belum dipasang'
                });
        }
    }
);

// Bulk Upload Foto Produk Merchant
router.post(
    '/products/photos/bulk',
    verifyToken,
    requireRole(2),
    (
        req,
        res,
        next
    ) => {
        bulkProductPhotoUpload.array(
            'photos',
            50
        )(
            req,
            res,
            err => {
                if (!err) {
                    return next();
                }

                cleanupBulkProductPhotoFiles(
                    req.files
                );

                if (
                    err instanceof
                        multer.MulterError
                ) {
                    if (
                        err.code ===
                        'LIMIT_FILE_SIZE'
                    ) {
                        return res
                            .status(413)
                            .json({
                                error:
                                    'Ukuran setiap foto maksimal 5 MB'
                            });
                    }

                    if (
                        err.code ===
                        'LIMIT_FILE_COUNT'
                    ) {
                        return res
                            .status(413)
                            .json({
                                error:
                                    'Maksimal 50 foto per upload'
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
        const files =
            Array.isArray(req.files)
                ? req.files
                : [];

        if (files.length === 0) {
            return res
                .status(400)
                .json({
                    error:
                        'Minimal satu foto harus diupload'
                });
        }

        const seenNames =
            new Set();

        for (const file of files) {
            const originalName =
                path.basename(
                    String(
                        file.originalname || ''
                    )
                ).trim();

            const normalizedName =
                originalName.toLowerCase();

            if (
                !originalName ||
                seenNames.has(
                    normalizedName
                )
            ) {
                cleanupBulkProductPhotoFiles(
                    files
                );

                return res
                    .status(400)
                    .json({
                        error:
                            !originalName
                                ? 'Nama file foto tidak valid'
                                : `Nama file foto duplikat: ${originalName}`
                    });
            }

            seenNames.add(
                normalizedName
            );

            const detected =
                detectProductPhotoType(
                    file.path
                );

            if (
                !detected ||
                detected.mime !==
                    file.mimetype
            ) {
                cleanupBulkProductPhotoFiles(
                    files
                );

                return res
                    .status(415)
                    .json({
                        error:
                            `Isi file foto tidak valid: ${originalName}`
                    });
            }
        }

        let client;
        let committed = false;

        const updatedProducts = [];
        const oldImageUrls = [];

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

                cleanupBulkProductPhotoFiles(
                    files
                );

                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant aktif tidak ditemukan'
                    });
            }

            const merchantId =
                merchantResult.rows[0].id;

            for (const file of files) {
                const originalName =
                    path.basename(
                        String(
                            file.originalname ||
                            ''
                        )
                    ).trim();

                const productResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            sku,
                            name,
                            image_url,
                            import_photo_filename
                        FROM tbl_products
                        WHERE merchant_id = $1
                          AND status = 'ACTIVE'
                          AND LOWER(
                                import_photo_filename
                              ) = LOWER($2)
                        FOR UPDATE
                        `,
                        [
                            merchantId,
                            originalName
                        ]
                    );

                if (
                    productResult.rowCount !== 1
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    cleanupBulkProductPhotoFiles(
                        files
                    );

                    return res
                        .status(400)
                        .json({
                            error:
                                `Tidak ada produk yang menunggu foto: ${originalName}`
                        });
                }

                const product =
                    productResult.rows[0];

                const newImageUrl =
                    `/uploads/products/${file.filename}`;

                const updateResult =
                    await client.query(
                        `
                        UPDATE tbl_products
                        SET
                            image_url = $1,
                            import_photo_filename = NULL,
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE id = $2
                          AND merchant_id = $3
                        RETURNING
                            id,
                            sku,
                            name,
                            image_url,
                            import_photo_filename,
                            updated_at
                        `,
                        [
                            newImageUrl,
                            product.id,
                            merchantId
                        ]
                    );

                if (
                    product.image_url &&
                    product.image_url !==
                        newImageUrl
                ) {
                    oldImageUrls.push(
                        product.image_url
                    );
                }

                updatedProducts.push(
                    updateResult.rows[0]
                );
            }

            await client.query(
                'COMMIT'
            );

            committed = true;

            for (
                const oldImageUrl
                of oldImageUrls
            ) {
                deleteProductPhotoFile(
                    oldImageUrl
                );
            }

            setImmediate(() => {
                for (
                    const product
                    of updatedProducts
                ) {
                    try {
                        CommerceKernel.emitEvent(
                            'PRODUCT_PHOTO_UPDATED',
                            'PRODUCT',
                            product.id,
                            product
                        );
                    } catch (err) {
                        console.error(
                            '[BULK PRODUCT PHOTO EVENT]',
                            err.message
                        );
                    }
                }
            });

            return res.json({
                status:
                    'success',
                message:
                    'Foto produk berhasil dipasang',
                updated_count:
                    updatedProducts.length,
                products:
                    updatedProducts
            });
        } catch (err) {
            if (
                client &&
                !committed
            ) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}
            }

            if (!committed) {
                cleanupBulkProductPhotoFiles(
                    files
                );
            }

            console.error(
                '[BULK PRODUCT PHOTO UPLOAD]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal memasang foto produk'
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
                 customer_visible = FALSE,
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

