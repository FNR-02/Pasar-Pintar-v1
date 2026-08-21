const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

// Monitoring inventory aktif - Admin only
router.get(
    '/warehouse/inventory',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT
                    i.id,
                    i.product_id,
                    p.sku,
                    p.name AS product_name,
                    i.warehouse_id,
                    w.warehouse_name,
                    i.quantity_on_hand,
                    i.min_stock_level,
                    i.max_stock_level,
                    i.updated_at
                 FROM tbl_inventory i
                 JOIN tbl_products p
                    ON p.id = i.product_id
                 LEFT JOIN tbl_warehouses w
                    ON w.id = i.warehouse_id
                 WHERE p.status = 'ACTIVE'
                 ORDER BY
                    w.warehouse_name,
                    p.name`
            );

            return res.json({
                status: 'success',
                total_inventory: result.rowCount,
                inventory: result.rows
            });
        } catch (err) {
            console.error(
                '[WAREHOUSE INVENTORY ERROR]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

// Monitoring seluruh shipment - Admin only
router.get(
    '/warehouse/shipments',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT
                    s.id,
                    s.order_id,
                    s.courier_id,
                    s.tracking_number,
                    s.shipping_status,
                    s.notes,
                    s.updated_at,
                    o.customer_id,
                    o.merchant_id,
                    o.status AS order_status,
                    o.shipping_address,
                    o.total_amount,
                    c.full_name AS customer_name,
                    u.username AS courier_username
                 FROM tbl_shipments s
                 JOIN tbl_orders_v2 o
                    ON o.id = s.order_id
                 LEFT JOIN tbl_customers c
                    ON c.id = o.customer_id
                 LEFT JOIN tbl_users u
                    ON u.id = s.courier_id
                 ORDER BY s.updated_at DESC
                 LIMIT 50`
            );

            return res.json({
                status: "success",
                total_shipments: result.rowCount,
                shipments: result.rows
            });
        } catch (err) {
            console.error("[WAREHOUSE SHIPMENTS ERROR]", err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

module.exports = router;
