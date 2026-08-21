const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');
const { verifyToken, requireRole } = require('../middleware/auth');

router.post('/purchase-orders/:id/receive', verifyToken, requireRole(4), async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;

        await client.query('BEGIN');

        const poRes = await client.query(
            `SELECT id, status, warehouse_id, total_amount
             FROM tbl_purchase_orders
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );

        if (!poRes.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                status: 'error',
                error: 'Purchase Order tidak ditemukan'
            });
        }

        const po = poRes.rows[0];

        if (po.status === 'RECEIVED') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                status: 'error',
                error: 'Purchase Order sudah berstatus RECEIVED. Receiving tidak boleh diproses ulang.'
            });
        }

        if (po.status !== 'APPROVED') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                status: 'error',
                error: `PO harus berstatus APPROVED. Status saat ini: ${po.status}`
            });
        }

        const itemsRes = await client.query(
              `SELECT product_id, SUM(quantity) AS quantity FROM tbl_purchase_order_items WHERE purchase_order_id = $1 GROUP BY product_id`,
            [id]
        );

        if (!itemsRes.rowCount) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                status: 'error',
                error: 'PO tidak memiliki item'
            });
        }

        for (const item of itemsRes.rows) {
            const invRes = await client.query(
                `UPDATE tbl_inventory
                 SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE warehouse_id = $2
                   AND product_id = $3
                 RETURNING id, quantity_on_hand`,
                [item.quantity, po.warehouse_id, item.product_id]
            );
            if (!invRes.rowCount) {
                await client.query(
                    `INSERT INTO tbl_inventory
                     (warehouse_id, product_id, quantity_on_hand)
                     VALUES ($1, $2, $3)`,
                    [po.warehouse_id, item.product_id, item.quantity]
                );
            }
        }


          for (const item of itemsRes.rows) {
              await client.query(
                  `INSERT INTO tbl_inventory_movements
                   (product_id, warehouse_id, movement_type,
                    quantity, reference_doc)
                   VALUES ($1, $2, 'PURCHASE_RECEIPT', $3, $4)`,
                  [
                      item.product_id,
                      po.warehouse_id,
                      item.quantity,
                      `PO-${id}`
                  ]
              );
          }

        const updatePo = await client.query(
            `UPDATE tbl_purchase_orders
             SET status = 'RECEIVED'
             WHERE id = $1
             RETURNING id, status, warehouse_id, total_amount`,
            [id]
        );

        await client.query('COMMIT');

        const receivedPo = updatePo.rows[0];

        CommerceKernel.emitEvent(
            'PURCHASE_ORDER_RECEIVED',
            'PURCHASE_ORDER',
            receivedPo.id,
            receivedPo
        );
        return res.json({
            status: 'success',
            message: 'Purchase Order berhasil diterima dan stok diperbarui',
            purchase_order: receivedPo
        });

    } catch (err) {
        await client.query('ROLLBACK');

        console.error('[PO RECEIVING ERROR]', err.message);

        return res.status(500).json({
            status: 'error',
            error: err.message
        });

    } finally {
        client.release();
    }
});

module.exports = router;
