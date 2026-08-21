const express = require('express');
const router = express.Router();
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
                COALESCE(pp.amount, 0) AS price,
                COALESCE(i.quantity_on_hand, 0) AS stock,
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
        warehouse_id
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

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const newProd = await client.query(
                `INSERT INTO tbl_products
                 (merchant_id, category_id, sku, name, description)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [
                    merchantId,
                    category_id || null,
                    sku,
                    nama_produk,
                    description || null
                ]
            );

            const savedProduct = newProd.rows[0];

            await client.query(
                `INSERT INTO tbl_product_prices
                 (product_id, price_type, amount)
                 VALUES ($1, 'RETAIL', $2)`,
                [savedProduct.id, harga]
            );

            await client.query(
                `INSERT INTO tbl_inventory
                 (warehouse_id, product_id, quantity_on_hand)
                 VALUES ($1, $2, $3)`,
                [warehouse_id, savedProduct.id, Number(stok)]
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
        warehouse_id
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
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING *`,
            [
                sku,
                nama_produk,
                description || null,
                category_id || null,
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
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [numericStok, inventoryResult.rows[0].id]
            );
        } else {
            await client.query(
                `INSERT INTO tbl_inventory
                 (warehouse_id, product_id, quantity_on_hand)
                 VALUES ($1, $2, $3)`,
                [warehouse_id, id, numericStok]
            );
        }

        await client.query('COMMIT');

        const finalResult = await client.query(
            `SELECT
                p.id,
                p.sku,
                p.name,
                p.description,
                pp.amount AS price,
                i.quantity_on_hand AS stock,
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
            message: "Gunakan GET /api/deliveries/:courierId"
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

