const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');

const { verifyToken, requireRole } = require('../middleware/auth');
const OrderFSM = require('../kernel/OrderFSM');

// Endpoint Transisi Status Order dengan Validasi FSM
router.patch('/orders/:id/transition', verifyToken, requireRole(4), async (req, res) => {
    const { id } = req.params;
    const { new_status } = req.body;

    try {
        // 1. Ambil status order saat ini dari database
        const currentOrderResult = await pool.query(`SELECT * FROM tbl_orders WHERE id = $1`, [id]);
        if (currentOrderResult.rowCount === 0) {
            return res.status(404).json({ error: "Order tidak ditemukan." });
        }

        const order = currentOrderResult.rows[0];
        const currentStatus = order.status_order;

        // 2. Validasi menggunakan FSM
        OrderFSM.assertTransition(currentStatus, new_status);

        // 3. Eksekusi update status jika valid
        await pool.query(`UPDATE tbl_orders SET status_order = $1 WHERE id = $2`, [new_status, id]);

        // 4. Pancarkan event ke Event Store (Layer 1)
        CommerceKernel.emitEvent('ORDER_STATUS_CHANGED', 'ORDER', order.id, {
            order_id: order.id,
            order_reference: order.order_reference,
            old_status: currentStatus,
            new_status: new_status
        });

        res.json({
            status: "success",
            message: `Status order berhasil diubah dari ${currentStatus} ke ${new_status} (FSM Validated).`
        });

    } catch (err) {
        console.error("[FSM ERROR]", err.message);
        res.status(400).json({ error: err.message });
    }
});

// Endpoint Simulasi Checkout / Pembuatan Pesanan
router.post('/orders/checkout', (req, res) => {
    return res.status(410).json({
        status: "error",
        error: "Legacy checkout dinonaktifkan",
        message: "Gunakan POST /api/orders/checkout-v2"
    });
});


// Customer melihat daftar pesanan miliknya sendiri
router.get(
    '/orders/my',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        try {
            let userId = req.user.id;

            if (Number(req.user.role_id) === 4 && req.query.user_id) {
                userId = req.query.user_id;
            }

            const customerResult = await pool.query(
                `SELECT id
                 FROM tbl_customers
                 WHERE user_id = $1
                 LIMIT 1`,
                [userId]
            );

            if (customerResult.rowCount === 0) {
                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const customerId = customerResult.rows[0].id;

            const result = await pool.query(
                `SELECT
                    o.id,
                    o.status,
                    o.shipping_address,
                    o.total_amount,
                    o.created_at,
                    o.merchant_id,
                    CASE
                        WHEN s.id IS NULL THEN NULL
                        ELSE json_build_object(
                            'id', s.id,
                            'shipping_status', s.shipping_status,
                            'tracking_number', s.tracking_number,
                            'courier_id', s.courier_id,
                            'courier_username', cu.username,
                            'notes', s.notes,
                            'updated_at', s.updated_at
                        )
                    END AS shipment,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', oi.id,
                                'product_id', oi.product_id,
                                'product_name', p.name,
                                'sku', p.sku,
                                'quantity', oi.quantity,
                                'unit_price', oi.unit_price
                            )
                        ) FILTER (WHERE oi.id IS NOT NULL),
                        '[]'::json
                    ) AS items
                 FROM tbl_orders_v2 o
                 LEFT JOIN tbl_order_items oi
                    ON oi.order_id = o.id
                 LEFT JOIN tbl_products p
                    ON p.id = oi.product_id
                 LEFT JOIN tbl_shipments s
                    ON s.order_id = o.id
                 LEFT JOIN tbl_users cu
                    ON cu.id = s.courier_id
                 WHERE o.customer_id = $1
                 GROUP BY
                    o.id,
                    s.id,
                    s.shipping_status,
                    s.tracking_number,
                    s.courier_id,
                    cu.username,
                    s.notes,
                    s.updated_at
                 ORDER BY o.created_at DESC`,
                [customerId]
            );

            return res.json({
                status: 'success',
                data: result.rows
            });

        } catch (err) {
            console.error('[MY ORDERS]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

module.exports = router;
