const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // Sesuaikan jalur pool

// Ambil laporan lengkap status inventaris enterprise
router.get('/inventory/status', async (req, res) => {
    try {
        const query = `
            SELECT p.id, p.nama_produk, 
                   COALESCE(i.current_stock, 0) as current_stock,
                   COALESCE(i.reserved, 0) as reserved,
                   COALESCE(i.incoming, 0) as incoming,
                   COALESCE(i.outgoing, 0) as outgoing,
                   COALESCE(i.damaged, 0) as damaged,
                   COALESCE(i.expired, 0) as expired,
                   (COALESCE(i.current_stock, 0) - COALESCE(i.reserved, 0) - COALESCE(i.damaged, 0) - COALESCE(i.expired, 0)) as available,
                   COALESCE(i.safety_stock, 0) as safety_stock,
                   COALESCE(i.reorder_point, 0) as reorder_point
            FROM tbl_produk p
            LEFT JOIN tbl_inventory i ON p.id = i.product_id
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Gagal memuat inventory:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
