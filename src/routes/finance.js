const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

// Endpoint Laporan Buku Besar (General Ledger) & Ringkasan Kas
router.get('/finance/ledger', verifyToken, requireRole(4), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tbl_general_ledger ORDER BY created_at DESC LIMIT 50`
        );
        res.json({
            status: "success",
            total_records: result.rowCount,
            ledger: result.rows
        });
    } catch (err) {
        console.error("Gagal memuat ledger:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

