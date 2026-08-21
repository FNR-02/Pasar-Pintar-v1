const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');
const { verifyToken, requireRole } = require('../middleware/auth');

router.post('/purchase-orders/:id/approve', verifyToken, requireRole(4), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `UPDATE tbl_purchase_orders
             SET status = 'APPROVED'
             WHERE id = $1 AND status = 'DRAFT'
             RETURNING id, status, supplier_id, warehouse_id, total_amount`,
            [id]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                status: 'error',
                error: 'PO tidak ditemukan atau bukan DRAFT'
            });
        }

        const po = result.rows[0];

        CommerceKernel.emitEvent(
            'PURCHASE_ORDER_APPROVED',
            'PURCHASE_ORDER',
            po.id,
            po
        );

        res.json({
            status: 'success',
            message: 'Purchase Order berhasil di-APPROVE',
            purchase_order: po
        });
    } catch (err) {
        console.error('[PO APPROVAL ERROR]', err.message);
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

module.exports = router;
