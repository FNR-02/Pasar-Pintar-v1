const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

router.get('/purchase-orders/drafts', verifyToken, requireRole(4), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                po.id,
                po.status,
                po.supplier_id,
                s.supplier_name,
                po.warehouse_id,
                w.warehouse_name,
                w.location,
                po.total_amount,
                po.created_at,
                poi.product_id,
                p.sku,
                p.name,
                poi.quantity,
                poi.unit_cost
            FROM tbl_purchase_orders po
            LEFT JOIN tbl_suppliers s ON s.id = po.supplier_id
            LEFT JOIN tbl_warehouses w ON w.id = po.warehouse_id
            JOIN tbl_purchase_order_items poi
                ON poi.purchase_order_id = po.id
            JOIN tbl_products p
                ON p.id = poi.product_id
            WHERE po.status = 'DRAFT'
            ORDER BY po.created_at DESC
        `);

        res.json({
            status: 'success',
            total: result.rowCount,
            purchase_orders: result.rows
        });
    } catch (err) {
        console.error('[PURCHASE ORDER ERROR]', err.message);
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

module.exports = router;
