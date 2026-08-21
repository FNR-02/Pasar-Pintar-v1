const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');
const OrderFSM = require('../kernel/OrderFSM');

module.exports = function(pool, CommerceKernel) {
    const router = express.Router();

    // Daftar pengiriman Courier / Admin
    router.get(
        '/deliveries/:courierId',
        verifyToken,
        requireRole(3, 4),
        async (req, res) => {
            try {
                const courierId =
                    Number(req.user.role_id) === 3
                        ? req.user.id
                        : req.params.courierId;

                const deliveries = await pool.query(
                    `SELECT
                        s.id,
                        s.order_id,
                        s.courier_id,
                        s.tracking_number,
                        s.shipping_status,
                        s.notes,
                        s.updated_at,
                        o.shipping_address,
                        o.total_amount,
                        c.full_name AS customer_name
                     FROM tbl_shipments s
                     JOIN tbl_orders_v2 o
                        ON o.id = s.order_id
                     LEFT JOIN tbl_customers c
                        ON c.id = o.customer_id
                     WHERE s.courier_id = $1
                     ORDER BY s.updated_at DESC`,
                    [courierId]
                );

                return res.json({
                    status: "success",
                    deliveries: deliveries.rows
                });
            } catch (err) {
                return res.status(500).json({
                    error: err.message
                });
            }
        }
    );

    // Courier menyelesaikan shipment + order V2 secara atomik.
    // Courier hanya boleh menyelesaikan shipment miliknya sendiri.
    router.post(
        '/complete-delivery',
        verifyToken,
        requireRole(3, 4),
        async (req, res) => {
            const { shipmentId, notes } = req.body;

            if (!shipmentId) {
                return res.status(400).json({
                    error: 'shipmentId wajib diisi'
                });
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                const shipmentResult = await client.query(
                    `SELECT *
                     FROM tbl_shipments
                     WHERE id = $1
                     FOR UPDATE`,
                    [shipmentId]
                );

                if (!shipmentResult.rowCount) {
                    await client.query('ROLLBACK');

                    return res.status(404).json({
                        error: 'Shipment tidak ditemukan'
                    });
                }

                const shipment = shipmentResult.rows[0];

                if (
                    Number(req.user.role_id) === 3 &&
                    shipment.courier_id !== req.user.id
                ) {
                    await client.query('ROLLBACK');

                    return res.status(403).json({
                        error: 'Shipment bukan milik Courier ini'
                    });
                }

                const orderResult = await client.query(
                    `SELECT *
                     FROM tbl_orders_v2
                     WHERE id = $1
                     FOR UPDATE`,
                    [shipment.order_id]
                );

                if (!orderResult.rowCount) {
                    await client.query('ROLLBACK');

                    return res.status(404).json({
                        error: 'Order shipment tidak ditemukan'
                    });
                }

                const order = orderResult.rows[0];

                // Idempotent: request ulang tidak merusak data.
                if (
                    shipment.shipping_status === 'DELIVERED' &&
                    order.status === 'DELIVERED'
                ) {
                    await client.query('COMMIT');

                    return res.json({
                        status: 'success',
                        message: 'Pengiriman sudah pernah diselesaikan',
                        shipment,
                        order
                    });
                }

                OrderFSM.assertTransition(
                    order.status,
                    'DELIVERED'
                );

                const updatedShipment = await client.query(
                    `UPDATE tbl_shipments
                     SET shipping_status = 'DELIVERED',
                         notes = $2,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1
                     RETURNING *`,
                    [
                        shipment.id,
                        notes ||
                        'Paket telah diterima dengan baik oleh pelanggan.'
                    ]
                );

                const updatedOrder = await client.query(
                    `UPDATE tbl_orders_v2
                     SET status = 'DELIVERED'
                     WHERE id = $1
                     RETURNING *`,
                    [order.id]
                );

                await client.query('COMMIT');

                const finalShipment =
                    updatedShipment.rows[0];

                const finalOrder =
                    updatedOrder.rows[0];

                CommerceKernel.emitEvent(
                    'DELIVERY_COMPLETED',
                    'SHIPMENT',
                    finalShipment.id,
                    {
                        shipmentId: finalShipment.id,
                        orderId: finalOrder.id,
                        courierId: finalShipment.courier_id,
                        oldOrderStatus: order.status,
                        newOrderStatus: 'DELIVERED',
                        actor: req.user.username,
                        ip: req.ip
                    }
                );

                return res.json({
                    status: 'success',
                    message:
                        'Pengiriman selesai dan Order menjadi DELIVERED',
                    shipment: finalShipment,
                    order: finalOrder
                });

            } catch (err) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error(
                    '[COMPLETE DELIVERY V2]',
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

    return router;
};
