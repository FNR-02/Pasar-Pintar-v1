const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');
const { verifyToken, requireRole } = require('../middleware/auth');
// Katalog Produk untuk Customer
router.get(
    '/catalog/products',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    p.id,
                    p.merchant_id,
                    p.sku,
                    p.name,
                    p.description,
                    m.store_name,
                    COALESCE(price.amount, 0) AS price,
                    COALESCE(inv.stock, 0) AS stock
                FROM tbl_products p
                LEFT JOIN tbl_merchants m
                    ON m.id = p.merchant_id
                LEFT JOIN LATERAL (
                    SELECT pp.amount
                    FROM tbl_product_prices pp
                    WHERE pp.product_id = p.id
                      AND pp.price_type = 'RETAIL'
                    ORDER BY pp.effective_date DESC
                    LIMIT 1
                ) price ON TRUE
                LEFT JOIN LATERAL (
                    SELECT
                        SUM(i.quantity_on_hand)::int AS stock
                    FROM tbl_inventory i
                    WHERE i.product_id = p.id
                ) inv ON TRUE
                WHERE p.status = 'ACTIVE'
                ORDER BY p.created_at DESC
            `);

            return res.json({
                status: 'success',
                count: result.rowCount,
                data: result.rows
            });
        } catch (err) {
            console.error('[CUSTOMER CATALOG ERROR]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

router.post('/orders/checkout-v2', verifyToken, requireRole(1, 4), async (req, res) => {
    const { customer_id, items, shipping_address } = req.body;
    const effectiveCustomerId = Number(req.user.role_id) === 1 ? req.user.id : customer_id;
    if (!effectiveCustomerId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            error: 'customer_id dan items wajib diisi'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const customerResult = await client.query(
            'SELECT id FROM tbl_customers WHERE user_id = $1',
            [effectiveCustomerId]
        );

        if (customerResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                error: 'Customer tidak ditemukan'
            });
        }

        const internalCustomerId = customerResult.rows[0].id;
        const validatedItems = [];
        for (const item of items) {
            const quantity = Number(item.quantity || 1);
            if (!item.product_id) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "product_id wajib diisi" });
            }
            if (!Number.isInteger(quantity) || quantity <= 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Quantity tidak valid", product_id: item.product_id });
            }
            const productResult = await client.query("SELECT id, merchant_id, sku, name FROM tbl_products WHERE id = $1 AND status = 'ACTIVE'", [item.product_id]);
            if (productResult.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Produk tidak ditemukan", product_id: item.product_id });
            }
            const product = productResult.rows[0];

            const stockResult = await client.query(
                `SELECT COALESCE(SUM(quantity_on_hand), 0)::int AS available_stock
                 FROM tbl_inventory
                 WHERE product_id = $1`,
                [product.id]
            );

            const availableStock =
                Number(stockResult.rows[0].available_stock || 0);

            if (availableStock < quantity) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: "Stok tidak mencukupi",
                    product_id: product.id,
                    requested_quantity: quantity,
                    available_stock: availableStock
                });
            }

            const priceResult = await client.query("SELECT amount FROM tbl_product_prices WHERE product_id = $1 AND price_type = 'RETAIL' ORDER BY effective_date DESC LIMIT 1", [product.id]);
            if (priceResult.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Harga RETAIL produk belum tersedia", product_id: product.id });
            }
            const unitPrice = Number(priceResult.rows[0].amount);
            const subtotal = unitPrice * quantity;
            validatedItems.push({
                product_id: product.id,
                merchant_id: product.merchant_id,
                sku: product.sku,
                name: product.name,
                quantity: quantity,
                unit_price: unitPrice,
                subtotal: subtotal
            });
        }

        const totalAmount = validatedItems.reduce(
            (sum, item) => sum + item.subtotal,
            0
        );

        const merchantIds = [...new Set(validatedItems.map(item => item.merchant_id).filter(Boolean))];

        if (merchantIds.length !== 1) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: "Checkout V2 saat ini harus berasal dari satu merchant"
            });
        }

        const merchantId = merchantIds[0];
        const orderResult = await client.query(
            "INSERT INTO tbl_orders_v2 (customer_id, merchant_id, status, shipping_address, total_amount) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [internalCustomerId, merchantId, "PENDING", shipping_address || null, totalAmount]
        );

        const order = orderResult.rows[0];
        for (const item of validatedItems) {
            await client.query(
                "INSERT INTO tbl_order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)",
                [order.id, item.product_id, item.quantity, item.unit_price]
            );
        }

        await client.query("COMMIT");

        CommerceKernel.emitEvent(
            "ORDER_CREATED",
            "ORDER",
            order.id,
            order
        );

        return res.status(201).json({
            status: "success",
            message: "Order berhasil dibuat",
            order: order,
            items: validatedItems
        });
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {}
        }

        console.error("[CHECKOUT V2]", err.message);

        return res.status(500).json({
            error: err.message
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
