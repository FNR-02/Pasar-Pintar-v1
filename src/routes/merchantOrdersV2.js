const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');
const OrderFSM = require('../kernel/OrderFSM');
const { verifyToken, requireRole } = require('../middleware/auth');

async function resolveMerchant(userId) {
    const result = await pool.query(
        `SELECT id, user_id, store_name, status
         FROM tbl_merchants
         WHERE user_id = $1
           AND status = 'ACTIVE'
         LIMIT 1`,
        [userId]
    );

    return result.rows[0] || null;
}

// Daftar order milik merchant yang sedang login
router.get(
    '/merchant/orders-v2',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const merchant = await resolveMerchant(req.user.id);

            if (!merchant) {
                return res.status(403).json({
                    error: 'Merchant aktif tidak ditemukan'
                });
            }

            const result = await pool.query(
                `SELECT
                    o.id,
                    o.status,
                    o.shipping_address,
                    o.total_amount,
                    o.created_at,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
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
                 LEFT JOIN tbl_customers c
                    ON c.id = o.customer_id
                 LEFT JOIN tbl_order_items oi
                    ON oi.order_id = o.id
                 LEFT JOIN tbl_products p
                    ON p.id = oi.product_id
                 WHERE o.merchant_id = $1
                 GROUP BY o.id, c.full_name, c.phone
                 ORDER BY o.created_at DESC`,
                [merchant.id]
            );

            return res.json({
                status: 'success',
                merchant,
                count: result.rows.length,
                data: result.rows
            });
        } catch (err) {
            console.error('[MERCHANT ORDERS V2]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

// Merchant menyerahkan order PACKING ke courier
router.patch(
    '/merchant/orders-v2/:id/dispatch',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        const orderId = req.params.id;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const merchantResult = await client.query(
                `SELECT id, store_name
                 FROM tbl_merchants
                 WHERE user_id = $1
                   AND status = 'ACTIVE'
                 LIMIT 1`,
                [req.user.id]
            );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error: 'Merchant aktif tidak ditemukan'
                });
            }

            const merchant = merchantResult.rows[0];

            const orderResult = await client.query(
                `SELECT *
                 FROM tbl_orders_v2
                 WHERE id = $1
                   AND merchant_id = $2
                 FOR UPDATE`,
                [orderId, merchant.id]
            );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error: 'Order tidak ditemukan'
                });
            }

            const order = orderResult.rows[0];

            OrderFSM.assertTransition(
                order.status,
                'DISPATCHED'
            );

            const courierResult = await client.query(
                `SELECT
                    u.id,
                    u.username,
                    COUNT(s.id) FILTER (
                        WHERE s.shipping_status <> 'DELIVERED'
                    )::int AS active_shipments
                 FROM tbl_users u
                 LEFT JOIN tbl_shipments s
                    ON s.courier_id = u.id
                 WHERE u.role_id = 3
                   AND u.is_active = TRUE
                 GROUP BY u.id, u.username
                 ORDER BY active_shipments ASC, u.created_at ASC
                 LIMIT 1`
            );

            if (!courierResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error: 'Courier aktif tidak tersedia'
                });
            }

            const courier = courierResult.rows[0];

            const existingShipment = await client.query(
                `SELECT id
                 FROM tbl_shipments
                 WHERE order_id = $1
                 LIMIT 1`,
                [order.id]
            );

            if (existingShipment.rowCount > 0) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error: 'Shipment untuk order ini sudah tersedia'
                });
            }

            const trackingNumber =
                'PP-' +
                Date.now().toString(36).toUpperCase() +
                '-' +
                crypto.randomBytes(3).toString('hex').toUpperCase();

            const shipmentResult = await client.query(
                `INSERT INTO tbl_shipments (
                    order_id,
                    courier_id,
                    tracking_number,
                    shipping_status,
                    notes,
                    updated_at
                 )
                 VALUES (
                    $1,
                    $2,
                    $3,
                    'ASSIGNED',
                    $4,
                    CURRENT_TIMESTAMP
                 )
                 RETURNING *`,
                [
                    order.id,
                    courier.id,
                    trackingNumber,
                    `Pesanan diserahkan oleh ${merchant.store_name}`
                ]
            );

            const updatedOrder = await client.query(
                `UPDATE tbl_orders_v2
                 SET status = 'DISPATCHED'
                 WHERE id = $1
                 RETURNING *`,
                [order.id]
            );

            await client.query('COMMIT');

            const shipment = shipmentResult.rows[0];

            CommerceKernel.emitEvent(
                'ORDER_STATUS_CHANGED',
                'ORDER',
                order.id,
                {
                    orderId: order.id,
                    old_status: order.status,
                    new_status: 'DISPATCHED',
                    merchantId: merchant.id,
                    actor: req.user.username
                }
            );

            CommerceKernel.emitEvent(
                'SHIPMENT_ASSIGNED',
                'SHIPMENT',
                shipment.id,
                {
                    shipmentId: shipment.id,
                    orderId: order.id,
                    courierId: courier.id,
                    trackingNumber,
                    actor: req.user.username
                }
            );

            return res.json({
                status: 'success',
                message: 'Pesanan berhasil diserahkan ke Courier',
                order: updatedOrder.rows[0],
                shipment: {
                    ...shipment,
                    courier_username: courier.username
                }
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[MERCHANT DISPATCH V2]',
                err.message
            );

            return res.status(400).json({
                error: err.message
            });

        } finally {
            client.release();
        }
    }
);

module.exports = router;
