const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const bannerDirectory = path.join(
    __dirname,
    '../../public/uploads/banners'
);

fs.mkdirSync(
    bannerDirectory,
    { recursive: true }
);

const allowedBannerMimeTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp'
]);

const bannerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, bannerDirectory);
    },

    filename: (req, file, cb) => {
        const extensions = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp'
        };

        cb(
            null,
            'banner-' +
            crypto.randomUUID() +
            (extensions[file.mimetype] || '')
        );
    }
});

const bannerUpload = multer({
    storage: bannerStorage,

    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },

    fileFilter: (req, file, cb) => {
        if (!allowedBannerMimeTypes.has(file.mimetype)) {
            const err = new Error(
                'Format banner harus JPG, PNG, atau WebP'
            );

            err.code =
                'INVALID_BANNER_IMAGE_TYPE';

            return cb(err);
        }

        cb(null, true);
    }
});

function detectBannerImageType(filePath) {
    let fd;

    try {
        fd = fs.openSync(filePath, 'r');

        const buffer = Buffer.alloc(16);

        const bytesRead = fs.readSync(
            fd,
            buffer,
            0,
            buffer.length,
            0
        );

        const data =
            buffer.subarray(0, bytesRead);

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
            return 'image/png';
        }

        if (
            data.length >= 3 &&
            data[0] === 0xff &&
            data[1] === 0xd8 &&
            data[2] === 0xff
        ) {
            return 'image/jpeg';
        }

        if (
            data.length >= 12 &&
            data.subarray(0, 4)
                .toString('ascii') === 'RIFF' &&
            data.subarray(8, 12)
                .toString('ascii') === 'WEBP'
        ) {
            return 'image/webp';
        }

        return null;

    } catch (err) {
        console.error(
            '[BANNER SIGNATURE]',
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

function deleteBannerFile(imageUrl) {
    if (
        !imageUrl ||
        typeof imageUrl !== 'string' ||
        !imageUrl.startsWith(
            '/uploads/banners/'
        )
    ) {
        return;
    }

    const filePath = path.join(
        bannerDirectory,
        path.basename(imageUrl)
    );

    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error(
            '[BANNER FILE CLEANUP]',
            err.message
        );
    }
}

const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

module.exports = (pool) => {
    const router = express.Router();

    /*
     * PUBLIC MARKETPLACE BANNERS
     *
     * Hanya ACTIVE dan sedang berada
     * dalam jadwal tayang.
     */
    router.get(
        '/public/marketplace/banners',
        async (req, res) => {
            try {
                const marketCode =
                    String(
                        req.query.market_code ||
                        'PASAR-SEDERHANA'
                    ).trim();

                const result =
                    await pool.query(`
                        SELECT
                            b.id,
                            b.market_id,
                            m.name AS market_name,
                            m.code AS market_code,
                            b.placement,
                            b.image_url,
                            b.title,
                            b.subtitle,
                            b.target_url,
                            b.sort_order,
                            b.starts_at,
                            b.ends_at
                        FROM tbl_marketplace_banners b
                        LEFT JOIN tbl_markets m
                            ON m.id = b.market_id
                        WHERE b.status = 'ACTIVE'
                          AND (
                              b.starts_at IS NULL
                              OR b.starts_at <= now()
                          )
                          AND (
                              b.ends_at IS NULL
                              OR b.ends_at > now()
                          )
                          AND (
                              b.market_id IS NULL
                              OR (
                                  m.code = $1
                                  AND m.status = 'ACTIVE'
                              )
                          )
                        ORDER BY
                            CASE b.placement
                                WHEN 'HERO' THEN 1
                                WHEN 'MIDDLE' THEN 2
                                ELSE 9
                            END,
                            b.sort_order ASC,
                            b.created_at DESC
                    `, [marketCode]);

                return res.json({
                    status: 'success',
                    data: result.rows
                });
            } catch (err) {
                console.error(
                    '[PUBLIC MARKETPLACE BANNERS]',
                    err.message
                );

                return res.status(500).json({
                    error:
                        'Gagal memuat banner marketplace'
                });
            }
        }
    );

    /*
     * ADMIN BANNER LIST
     */
    router.get(
        '/admin/marketplace/banners',
        verifyToken,
        requireRole(4),
        async (req, res) => {
            try {
                const result =
                    await pool.query(`
                        SELECT
                            b.*,
                            m.name AS market_name,
                            m.code AS market_code
                        FROM tbl_marketplace_banners b
                        LEFT JOIN tbl_markets m
                            ON m.id = b.market_id
                        ORDER BY
                            b.created_at DESC
                    `);

                return res.json({
                    status: 'success',
                    data: result.rows
                });
            } catch (err) {
                console.error(
                    '[ADMIN MARKETPLACE BANNERS]',
                    err.message
                );

                return res.status(500).json({
                    error:
                        'Gagal memuat banner admin'
                });
            }
        }
    );

    /*
     * ADMIN CREATE BANNER
     */
    router.post(
        '/admin/marketplace/banners',
        verifyToken,
        requireRole(4),

        (req, res, next) => {
            bannerUpload.single('image')(
                req,
                res,
                err => {
                    if (!err) {
                        return next();
                    }

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
                                        'Ukuran banner maksimal 5 MB'
                                });
                        }

                        return res
                            .status(400)
                            .json({
                                error:
                                    'Upload banner gagal: ' +
                                    err.message
                            });
                    }

                    if (
                        err.code ===
                        'INVALID_BANNER_IMAGE_TYPE'
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
                                'Upload banner gagal'
                        });
                }
            );
        },

        async (req, res) => {
            if (!req.file) {
                return res
                    .status(400)
                    .json({
                        error:
                            'File banner wajib dikirim dengan field image'
                    });
            }

            const imageUrl =
                '/uploads/banners/' +
                req.file.filename;

            const detectedType =
                detectBannerImageType(
                    req.file.path
                );

            if (!detectedType) {
                deleteBannerFile(imageUrl);

                return res
                    .status(415)
                    .json({
                        error:
                            'Isi file bukan gambar JPG, PNG, atau WebP yang valid'
                    });
            }

            if (
                detectedType !==
                req.file.mimetype
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(415)
                    .json({
                        error:
                            'Format isi banner tidak sesuai dengan tipe file'
                    });
            }

            const placement =
                String(
                    req.body.placement || ''
                )
                    .trim()
                    .toUpperCase();

            if (
                ![
                    'HERO',
                    'MIDDLE'
                ].includes(placement)
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(400)
                    .json({
                        error:
                            'Placement harus HERO atau MIDDLE'
                    });
            }

            const status =
                String(
                    req.body.status ||
                    'DRAFT'
                )
                    .trim()
                    .toUpperCase();

            if (
                ![
                    'DRAFT',
                    'ACTIVE',
                    'INACTIVE'
                ].includes(status)
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(400)
                    .json({
                        error:
                            'Status banner tidak valid'
                    });
            }

            const rawSortOrder =
                req.body.sort_order ?? 0;

            const sortOrder =
                Number(rawSortOrder);

            if (
                !Number.isInteger(sortOrder) ||
                sortOrder < 0
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(400)
                    .json({
                        error:
                            'sort_order harus bilangan bulat >= 0'
                    });
            }

            const marketId =
                String(
                    req.body.market_id || ''
                ).trim() || null;

            const title =
                String(
                    req.body.title || ''
                ).trim() || null;

            const subtitle =
                String(
                    req.body.subtitle || ''
                ).trim() || null;

            const targetUrl =
                String(
                    req.body.target_url || ''
                ).trim() || null;

            const startsAt =
                String(
                    req.body.starts_at || ''
                ).trim() || null;

            const endsAt =
                String(
                    req.body.ends_at || ''
                ).trim() || null;

            if (
                startsAt &&
                Number.isNaN(
                    Date.parse(startsAt)
                )
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(400)
                    .json({
                        error:
                            'starts_at tidak valid'
                    });
            }

            if (
                endsAt &&
                Number.isNaN(
                    Date.parse(endsAt)
                )
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(400)
                    .json({
                        error:
                            'ends_at tidak valid'
                    });
            }

            if (
                startsAt &&
                endsAt &&
                new Date(endsAt) <=
                    new Date(startsAt)
            ) {
                deleteBannerFile(imageUrl);

                return res
                    .status(400)
                    .json({
                        error:
                            'ends_at harus setelah starts_at'
                    });
            }

            let client;

            try {
                client =
                    await pool.connect();

                await client.query('BEGIN');

                if (marketId) {
                    const marketResult =
                        await client.query(
                            `
                            SELECT id
                            FROM tbl_markets
                            WHERE id = $1::uuid
                              AND status = 'ACTIVE'
                            LIMIT 1
                            `,
                            [marketId]
                        );

                    if (
                        marketResult.rowCount === 0
                    ) {
                        await client.query(
                            'ROLLBACK'
                        );

                        deleteBannerFile(
                            imageUrl
                        );

                        return res
                            .status(404)
                            .json({
                                error:
                                    'Market aktif tidak ditemukan'
                            });
                    }
                }

                const insertResult =
                    await client.query(
                        `
                        INSERT INTO
                            tbl_marketplace_banners
                        (
                            market_id,
                            placement,
                            image_url,
                            title,
                            subtitle,
                            target_url,
                            sort_order,
                            starts_at,
                            ends_at,
                            status,
                            created_by
                        )
                        VALUES (
                            $1::uuid,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6,
                            $7,
                            $8::timestamptz,
                            $9::timestamptz,
                            $10,
                            $11::uuid
                        )
                        RETURNING *
                        `,
                        [
                            marketId,
                            placement,
                            imageUrl,
                            title,
                            subtitle,
                            targetUrl,
                            sortOrder,
                            startsAt,
                            endsAt,
                            status,
                            req.user.id
                        ]
                    );

                await client.query('COMMIT');

                return res
                    .status(201)
                    .json({
                        status:
                            'success',
                        data:
                            insertResult.rows[0]
                    });

            } catch (err) {
                if (client) {
                    try {
                        await client.query(
                            'ROLLBACK'
                        );
                    } catch (_) {}
                }

                deleteBannerFile(imageUrl);

                if (
                    err.code === '22P02'
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                'ID atau format data banner tidak valid'
                        });
                }

                console.error(
                    '[ADMIN CREATE BANNER]',
                    err.message
                );

                return res
                    .status(500)
                    .json({
                        error:
                            'Gagal membuat banner'
                    });

            } finally {
                if (client) {
                    client.release();
                }
            }
        }
    );

    /*
     * ADMIN UPDATE BANNER
     *
     * Tahap ini mengubah metadata/status.
     * Penggantian file gambar ditambahkan terpisah.
     */
    router.put(
        '/admin/marketplace/banners/:id',
        verifyToken,
        requireRole(4),
        express.json(),
        async (req, res) => {
            const bannerId =
                String(req.params.id || '').trim();

            const allowedFields = new Set([
                'market_id',
                'placement',
                'title',
                'subtitle',
                'target_url',
                'sort_order',
                'starts_at',
                'ends_at',
                'status'
            ]);

            const suppliedFields =
                Object.keys(req.body || {})
                    .filter(key =>
                        allowedFields.has(key)
                    );

            if (suppliedFields.length === 0) {
                return res.status(400).json({
                    error:
                        'Tidak ada data banner yang diperbarui'
                });
            }

            const values = [];
            const assignments = [];

            function addAssignment(
                column,
                value,
                cast = ''
            ) {
                values.push(value);

                assignments.push(
                    `${column} = $${values.length}${cast}`
                );
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    req.body,
                    'market_id'
                )
            ) {
                const value =
                    String(
                        req.body.market_id || ''
                    ).trim() || null;

                addAssignment(
                    'market_id',
                    value,
                    '::uuid'
                );
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    req.body,
                    'placement'
                )
            ) {
                const value =
                    String(
                        req.body.placement || ''
                    )
                        .trim()
                        .toUpperCase();

                if (
                    ![
                        'HERO',
                        'MIDDLE'
                    ].includes(value)
                ) {
                    return res.status(400).json({
                        error:
                            'Placement harus HERO atau MIDDLE'
                    });
                }

                addAssignment(
                    'placement',
                    value
                );
            }

            for (const field of [
                'title',
                'subtitle',
                'target_url'
            ]) {
                if (
                    Object.prototype
                        .hasOwnProperty.call(
                            req.body,
                            field
                        )
                ) {
                    const value =
                        String(
                            req.body[field] || ''
                        ).trim() || null;

                    addAssignment(
                        field,
                        value
                    );
                }
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    req.body,
                    'sort_order'
                )
            ) {
                const value =
                    Number(req.body.sort_order);

                if (
                    !Number.isInteger(value) ||
                    value < 0
                ) {
                    return res.status(400).json({
                        error:
                            'sort_order harus bilangan bulat >= 0'
                    });
                }

                addAssignment(
                    'sort_order',
                    value
                );
            }

            for (const field of [
                'starts_at',
                'ends_at'
            ]) {
                if (
                    Object.prototype
                        .hasOwnProperty.call(
                            req.body,
                            field
                        )
                ) {
                    const raw =
                        String(
                            req.body[field] || ''
                        ).trim();

                    if (
                        raw &&
                        Number.isNaN(
                            Date.parse(raw)
                        )
                    ) {
                        return res.status(400).json({
                            error:
                                `${field} tidak valid`
                        });
                    }

                    addAssignment(
                        field,
                        raw || null,
                        '::timestamptz'
                    );
                }
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    req.body,
                    'status'
                )
            ) {
                const value =
                    String(
                        req.body.status || ''
                    )
                        .trim()
                        .toUpperCase();

                if (
                    ![
                        'DRAFT',
                        'ACTIVE',
                        'INACTIVE'
                    ].includes(value)
                ) {
                    return res.status(400).json({
                        error:
                            'Status banner tidak valid'
                    });
                }

                addAssignment(
                    'status',
                    value
                );
            }

            let client;

            try {
                client = await pool.connect();
                await client.query('BEGIN');

                const currentResult =
                    await client.query(
                        `
                        SELECT *
                        FROM tbl_marketplace_banners
                        WHERE id = $1::uuid
                          AND status <> 'ARCHIVED'
                        FOR UPDATE
                        `,
                        [bannerId]
                    );

                if (
                    currentResult.rowCount === 0
                ) {
                    await client.query('ROLLBACK');

                    return res.status(404).json({
                        error:
                            'Banner tidak ditemukan'
                    });
                }

                const current =
                    currentResult.rows[0];

                const requestedMarketId =
                    Object.prototype
                        .hasOwnProperty.call(
                            req.body,
                            'market_id'
                        )
                        ? (
                            String(
                                req.body.market_id || ''
                            ).trim() || null
                        )
                        : current.market_id;

                if (requestedMarketId) {
                    const marketResult =
                        await client.query(
                            `
                            SELECT id
                            FROM tbl_markets
                            WHERE id = $1::uuid
                              AND status = 'ACTIVE'
                            LIMIT 1
                            `,
                            [requestedMarketId]
                        );

                    if (
                        marketResult.rowCount === 0
                    ) {
                        await client.query(
                            'ROLLBACK'
                        );

                        return res.status(404).json({
                            error:
                                'Market aktif tidak ditemukan'
                        });
                    }
                }

                const finalStartsAt =
                    Object.prototype
                        .hasOwnProperty.call(
                            req.body,
                            'starts_at'
                        )
                        ? (
                            String(
                                req.body.starts_at || ''
                            ).trim() || null
                        )
                        : current.starts_at;

                const finalEndsAt =
                    Object.prototype
                        .hasOwnProperty.call(
                            req.body,
                            'ends_at'
                        )
                        ? (
                            String(
                                req.body.ends_at || ''
                            ).trim() || null
                        )
                        : current.ends_at;

                if (
                    finalStartsAt &&
                    finalEndsAt &&
                    new Date(finalEndsAt) <=
                        new Date(finalStartsAt)
                ) {
                    await client.query('ROLLBACK');

                    return res.status(400).json({
                        error:
                            'ends_at harus setelah starts_at'
                    });
                }

                assignments.push(
                    'updated_at = now()'
                );

                values.push(bannerId);

                const updateResult =
                    await client.query(
                        `
                        UPDATE tbl_marketplace_banners
                        SET ${assignments.join(', ')}
                        WHERE id =
                            $${values.length}::uuid
                        RETURNING *
                        `,
                        values
                    );

                await client.query('COMMIT');

                return res.json({
                    status: 'success',
                    data: updateResult.rows[0]
                });

            } catch (err) {
                if (client) {
                    try {
                        await client.query(
                            'ROLLBACK'
                        );
                    } catch (_) {}
                }

                if (err.code === '22P02') {
                    return res.status(400).json({
                        error:
                            'ID atau format data banner tidak valid'
                    });
                }

                console.error(
                    '[ADMIN UPDATE BANNER]',
                    err.message
                );

                return res.status(500).json({
                    error:
                        'Gagal memperbarui banner'
                });

            } finally {
                if (client) {
                    client.release();
                }
            }
        }
    );

    /*
     * ADMIN REPLACE BANNER IMAGE
     *
     * File baru divalidasi sebelum DB diubah.
     * File lama hanya dihapus setelah COMMIT.
     */
    router.post(
        '/admin/marketplace/banners/:id/image',
        verifyToken,
        requireRole(4),
        (req, res, next) => {
            bannerUpload.single('image')(
                req,
                res,
                err => {
                    if (!err) {
                        return next();
                    }

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
                                        'Ukuran banner maksimal 5 MB'
                                });
                        }

                        return res
                            .status(400)
                            .json({
                                error:
                                    'Upload banner gagal: ' +
                                    err.message
                            });
                    }

                    if (
                        err.code ===
                        'INVALID_BANNER_IMAGE_TYPE'
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
                                'Upload banner gagal'
                        });
                }
            );
        },
        async (req, res) => {
            const bannerId =
                String(
                    req.params.id || ''
                ).trim();

            if (!req.file) {
                return res
                    .status(400)
                    .json({
                        error:
                            'File banner wajib dikirim dengan field image'
                    });
            }

            const newImageUrl =
                '/uploads/banners/' +
                req.file.filename;

            const detectedType =
                detectBannerImageType(
                    req.file.path
                );

            if (!detectedType) {
                deleteBannerFile(
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
                detectedType !==
                req.file.mimetype
            ) {
                deleteBannerFile(
                    newImageUrl
                );

                return res
                    .status(415)
                    .json({
                        error:
                            'Format isi banner tidak sesuai dengan tipe file'
                    });
            }

            let client;
            let oldImageUrl = null;
            let committed = false;

            try {
                client =
                    await pool.connect();

                await client.query(
                    'BEGIN'
                );

                const currentResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            image_url,
                            status
                        FROM tbl_marketplace_banners
                        WHERE id = $1::uuid
                          AND status <> 'ARCHIVED'
                        FOR UPDATE
                        `,
                        [bannerId]
                    );

                if (
                    currentResult.rowCount === 0
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    deleteBannerFile(
                        newImageUrl
                    );

                    return res
                        .status(404)
                        .json({
                            error:
                                'Banner tidak ditemukan'
                        });
                }

                oldImageUrl =
                    currentResult
                        .rows[0]
                        .image_url;

                const updateResult =
                    await client.query(
                        `
                        UPDATE tbl_marketplace_banners
                        SET
                            image_url = $1,
                            updated_at = now()
                        WHERE id = $2::uuid
                        RETURNING *
                        `,
                        [
                            newImageUrl,
                            bannerId
                        ]
                    );

                await client.query(
                    'COMMIT'
                );

                committed = true;

                if (
                    oldImageUrl &&
                    oldImageUrl !==
                        newImageUrl
                ) {
                    deleteBannerFile(
                        oldImageUrl
                    );
                }

                return res.json({
                    status:
                        'success',
                    data:
                        updateResult.rows[0]
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
                    deleteBannerFile(
                        newImageUrl
                    );
                }

                if (
                    err.code === '22P02'
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                'ID banner tidak valid'
                        });
                }

                console.error(
                    '[ADMIN REPLACE BANNER IMAGE]',
                    err.message
                );

                return res
                    .status(500)
                    .json({
                        error:
                            'Gagal mengganti gambar banner'
                    });

            } finally {
                if (client) {
                    client.release();
                }
            }
        }
    );

    /*
     * ADMIN ARCHIVE BANNER
     *
     * Tidak hard-delete supaya histori tetap ada.
     */
    router.delete(
        '/admin/marketplace/banners/:id',
        verifyToken,
        requireRole(4),
        async (req, res) => {
            const bannerId =
                String(req.params.id || '').trim();

            try {
                const result =
                    await pool.query(
                        `
                        UPDATE tbl_marketplace_banners
                        SET
                            status = 'ARCHIVED',
                            updated_at = now()
                        WHERE id = $1::uuid
                          AND status <> 'ARCHIVED'
                        RETURNING *
                        `,
                        [bannerId]
                    );

                if (result.rowCount === 0) {
                    return res.status(404).json({
                        error:
                            'Banner tidak ditemukan'
                    });
                }

                return res.json({
                    status: 'success',
                    data: result.rows[0]
                });

            } catch (err) {
                if (err.code === '22P02') {
                    return res.status(400).json({
                        error:
                            'ID banner tidak valid'
                    });
                }

                console.error(
                    '[ADMIN ARCHIVE BANNER]',
                    err.message
                );

                return res.status(500).json({
                    error:
                        'Gagal mengarsipkan banner'
                });
            }
        }
    );

    return router;
};
