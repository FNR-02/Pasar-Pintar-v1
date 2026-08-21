const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

// Endpoint melihat daftar Draft PO hasil keputusan Autonomous Inventory Agent
router.get('/brain/agents/purchase-orders', verifyToken, requireRole(4), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                po.id,
                po.status,
                po.supplier_id,
                po.warehouse_id,
                po.total_amount,
                po.created_at,
                poi.product_id,
                p.sku,
                p.name,
                poi.quantity,
                poi.unit_cost
             FROM tbl_purchase_orders po
             JOIN tbl_purchase_order_items poi
                ON poi.purchase_order_id = po.id
             JOIN tbl_products p
                ON p.id = poi.product_id
             WHERE po.status = 'DRAFT'
             ORDER BY po.created_at DESC`
        );
        res.json({
            status: "success",
            engine: "Commerce Brain - Autonomous Inventory Agent",
            total_draft_po: result.rowCount,
            purchase_orders: result.rows
        });
    } catch (err) {
        console.error("Gagal memuat PO Agent:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
