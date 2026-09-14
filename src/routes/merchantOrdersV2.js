const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');
const OrderFSM = require('../kernel/OrderFSM');
const OrderInventoryFulfillmentService =
    require('../services/orders/OrderInventoryFulfillmentService');
const OrderInventoryReservationService =
    require('../services/orders/OrderInventoryReservationService');
const { verifyToken, requireRole } = require('../middleware/auth');

async function assertPickupPaymentReady(
    client,
    order
) {
    /*
     * ========================================================
     * PICKUP PAYMENT SAFETY
     *
     * Bila order mempunyai payment contract:
     *
     * provider       = OUTLET
     * payment_method = PAY_AT_OUTLET
     *
     * barang tidak boleh masuk lifecycle handover PICKUP
     * sebelum uang benar-benar dikonfirmasi PAID.
     *
     * Order TEMPO / payment flow lain tidak dipaksa memiliki
     * row PAY_AT_OUTLET.
     * ========================================================
     */
    const paymentResult =
        await client.query(
            `
            SELECT
                id,
                provider,
                payment_method,
                payment_status,
                amount
            FROM tbl_payments
            WHERE order_id = $1
              AND provider = 'OUTLET'
              AND payment_method = 'PAY_AT_OUTLET'
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
            `,
            [
                order.id
            ]
        );

    if (!paymentResult.rowCount) {
        return {
            payment:
                null,
            pay_at_outlet:
                false
        };
    }

    const payment =
        paymentResult.rows[0];

    if (
        String(
            payment.payment_status || ''
        ).toUpperCase() !== 'PAID'
    ) {
        const err =
            new Error(
                'Pembayaran di outlet harus diterima sebelum pesanan dapat diserahkan'
            );

        err.statusCode = 409;
        err.paymentStatus =
            payment.payment_status;

        throw err;
    }

    return {
        payment,
        pay_at_outlet:
            true
    };
}

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
                    o.fulfillment_type,
                    o.pickup_location_snapshot,
                    o.total_amount,
                    o.created_at,
                    pay.provider AS payment_provider,
                    pay.payment_method,
                    pay.payment_status,
                    pay.payment_amount,
                    (
                        SELECT s.status
                        FROM tbl_collector_task_stops s
                        JOIN tbl_collector_tasks ct
                          ON ct.id = s.collector_task_id
                        WHERE s.order_id = o.id
                          AND (
                              o.market_order_id IS NULL
                              OR ct.market_order_id =
                                 o.market_order_id
                          )
                        ORDER BY s.created_at DESC
                        LIMIT 1
                    ) AS collector_stop_status,
                    (
                        SELECT MAX(r.expires_at)
                        FROM tbl_inventory_reservations r
                        WHERE r.order_id = o.id
                    ) AS pickup_reservation_expires_at,
                    CASE
                        WHEN
                            o.status = 'DISPATCHED'
                            AND UPPER(
                                COALESCE(
                                    o.fulfillment_type,
                                    'DELIVERY'
                                )
                            ) = 'PICKUP'
                            AND UPPER(
                                COALESCE(
                                    pay.provider,
                                    ''
                                )
                            ) = 'OUTLET'
                            AND UPPER(
                                COALESCE(
                                    pay.payment_method,
                                    ''
                                )
                            ) = 'PAY_AT_OUTLET'
                            AND UPPER(
                                COALESCE(
                                    pay.payment_status,
                                    ''
                                )
                            ) = 'UNPAID'
                            AND EXISTS (
                                SELECT 1
                                FROM tbl_inventory_reservations r
                                WHERE r.order_id = o.id
                            )
                            AND NOT EXISTS (
                                SELECT 1
                                FROM tbl_inventory_reservations r
                                WHERE r.order_id = o.id
                                  AND r.status = 'RESERVED'
                                  AND (
                                      r.expires_at IS NULL
                                      OR r.expires_at >
                                          CURRENT_TIMESTAMP
                                  )
                            )
                        THEN TRUE
                        ELSE FALSE
                    END AS pickup_expired,
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
                                'unit_price', oi.unit_price,
                                'selling_unit_snapshot',
                                    oi.selling_unit_snapshot,
                                'pack_size_value_snapshot',
                                    oi.pack_size_value_snapshot,
                                'pack_size_unit_snapshot',
                                    oi.pack_size_unit_snapshot
                            )
                        ) FILTER (WHERE oi.id IS NOT NULL),
                        '[]'::json
                    ) AS items
                 FROM tbl_orders_v2 o
                 LEFT JOIN tbl_customers c
                    ON c.id = o.customer_id
                 LEFT JOIN tbl_order_items oi
                    ON oi.order_id = o.id
                 LEFT JOIN LATERAL (
                    SELECT
                        src.provider,
                        src.payment_method,
                        src.payment_status,
                        src.payment_amount
                    FROM (
                        SELECT
                            mp.provider,
                            mp.payment_method,
                            mp.payment_status,
                            mp.amount AS payment_amount,
                            mp.created_at,
                            1 AS source_priority
                        FROM tbl_market_payments mp
                        WHERE o.market_order_id IS NOT NULL
                          AND mp.market_order_id =
                              o.market_order_id

                        UNION ALL

                        SELECT
                            pmt.provider,
                            pmt.payment_method,
                            pmt.payment_status,
                            pmt.amount AS payment_amount,
                            pmt.created_at,
                            2 AS source_priority
                        FROM tbl_payments pmt
                        WHERE pmt.order_id = o.id
                    ) src
                    ORDER BY
                        src.source_priority,
                        src.created_at DESC
                    LIMIT 1
                 ) pay ON TRUE
                 LEFT JOIN tbl_products p
                    ON p.id = oi.product_id
                 WHERE o.merchant_id = $1
                 GROUP BY
                    o.id,
                    c.full_name,
                    c.phone,
                    pay.provider,
                    pay.payment_method,
                    pay.payment_status,
                    pay.payment_amount
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

            
            if (
                String(
                    order.fulfillment_type || 'DELIVERY'
                ).toUpperCase() === 'PICKUP'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order PICKUP tidak boleh diserahkan ke Courier'
                });
            }

            /*
             * MARKETPLACE MULTI-MERCHANT
             * -----------------------------------------------------
             * Child order marketplace tidak membuat tbl_shipments.
             *
             * Merchant hanya menandai barang siap diambil Collector.
             * Child order tetap PACKING sampai benar-benar PICKED_UP.
             */
            if (order.market_order_id) {
                if (order.status !== 'PACKING') {
                    await client.query('ROLLBACK');

                    return res.status(409).json({
                        error:
                            'Order marketplace harus berstatus PACKING sebelum siap diambil Collector',
                        current_status:
                            order.status
                    });
                }

                const marketOrderResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            status
                        FROM tbl_market_orders
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [
                            order.market_order_id
                        ]
                    );

                if (
                    marketOrderResult.rowCount !== 1
                ) {
                    throw new Error(
                        'Market order tidak ditemukan'
                    );
                }

                const marketOrder =
                    marketOrderResult.rows[0];

                if (
                    marketOrder.status !==
                    'COLLECTING'
                ) {
                    await client.query('ROLLBACK');

                    return res.status(409).json({
                        error:
                            'Market order belum berada pada fase COLLECTING',
                        market_order_status:
                            marketOrder.status
                    });
                }

                const stopResult =
                    await client.query(
                        `
                        SELECT
                            s.*
                        FROM tbl_collector_task_stops s
                        JOIN tbl_collector_tasks t
                          ON t.id =
                             s.collector_task_id
                        WHERE s.order_id = $1
                          AND t.market_order_id = $2
                        LIMIT 1
                        FOR UPDATE OF s
                        `,
                        [
                            order.id,
                            order.market_order_id
                        ]
                    );

                if (
                    stopResult.rowCount !== 1
                ) {
                    throw new Error(
                        'Collector stop untuk order marketplace tidak ditemukan'
                    );
                }

                const stop =
                    stopResult.rows[0];

                if (stop.status === 'READY') {
                    await client.query('COMMIT');

                    return res.json({
                        status: 'success',
                        message:
                            'Barang marketplace sudah siap diambil Collector',
                        already_ready: true,
                        order,
                        collector_stop:
                            stop
                    });
                }

                if (stop.status !== 'PENDING') {
                    await client.query('ROLLBACK');

                    return res.status(409).json({
                        error:
                            'Collector stop tidak dapat ditandai READY dari status saat ini',
                        stop_status:
                            stop.status
                    });
                }

                const updatedStopResult =
                    await client.query(
                        `
                        UPDATE tbl_collector_task_stops
                        SET
                            status = 'READY',
                            ready_at =
                                CURRENT_TIMESTAMP,
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE id = $1
                          AND status = 'PENDING'
                        RETURNING *
                        `,
                        [
                            stop.id
                        ]
                    );

                if (
                    updatedStopResult.rowCount !== 1
                ) {
                    throw new Error(
                        'Collector stop berubah secara bersamaan'
                    );
                }

                const updatedStop =
                    updatedStopResult.rows[0];

                await client.query('COMMIT');

                CommerceKernel.emitEvent(
                    'COLLECTOR_STOP_READY',
                    'COLLECTOR_STOP',
                    updatedStop.id,
                    {
                        collectorStopId:
                            updatedStop.id,
                        collectorTaskId:
                            updatedStop.collector_task_id,
                        marketOrderId:
                            order.market_order_id,
                        orderId:
                            order.id,
                        merchantId:
                            merchant.id,
                        actor:
                            req.user.username
                    }
                );

                return res.json({
                    status: 'success',
                    message:
                        'Barang marketplace siap diambil Collector',
                    marketplace_collection_ready:
                        true,
                    order,
                    collector_stop:
                        updatedStop
                });
            }

            /*
             * DELIVERY BIASA
             * Order non-marketplace tetap memakai tbl_shipments.
             */
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



// Merchant menandai order PICKUP sebagai siap diambil.
// PICKUP tidak membuat shipment; DISPATCHED berarti siap diambil.
router.patch(
    '/merchant/orders-v2/:id/start-preparing',
    verifyToken,
    requireRole(2),
    async (req, res) => {
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
            const orderId = req.params.id;

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

            if (
                String(order.fulfillment_type || 'DELIVERY')
                    .toUpperCase() !== 'PICKUP' ||
                String(order.payment_mode || '')
                    .toUpperCase() !== 'DIRECT'
            ) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Mulai siapkan tanpa pembayaran hanya berlaku untuk PICKUP PAY_AT_OUTLET'
                });
            }

            const paymentResult = await client.query(
                `SELECT *
                 FROM tbl_payments
                 WHERE order_id = $1
                   AND provider = 'OUTLET'
                   AND payment_method = 'PAY_AT_OUTLET'
                 ORDER BY created_at DESC
                 LIMIT 1
                 FOR UPDATE`,
                [order.id]
            );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: 'Payment PAY_AT_OUTLET tidak ditemukan'
                });
            }

            const payment = paymentResult.rows[0];

            if (payment.payment_status !== 'UNPAID') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Pesanan ini tidak lagi menunggu pembayaran di outlet'
                });
            }

            if (order.status === 'PACKING') {
                await client.query('COMMIT');
                return res.json({
                    status: 'success',
                    already_preparing: true,
                    message: 'Pesanan sudah sedang disiapkan',
                    order,
                    payment
                });
            }

            if (order.status !== 'PENDING') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Pesanan harus berstatus PENDING untuk mulai disiapkan',
                    current_status: order.status
                });
            }

            const reservationResult = await client.query(
                `UPDATE tbl_inventory_reservations
                 SET expires_at = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE order_id = $1
                   AND status = 'RESERVED'
                   AND (
                       expires_at IS NULL
                       OR expires_at > CURRENT_TIMESTAMP
                   )
                 RETURNING id`,
                [order.id]
            );

            if (!reservationResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Stok pesanan tidak lagi terkunci. Pesanan perlu diperiksa ulang.'
                });
            }

            const updatedResult = await client.query(
                `UPDATE tbl_orders_v2
                 SET status = 'PACKING'
                 WHERE id = $1
                   AND status = 'PENDING'
                 RETURNING *`,
                [order.id]
            );

            if (updatedResult.rowCount !== 1) {
                throw new Error(
                    'Order berubah secara bersamaan'
                );
            }

            const updatedOrder = updatedResult.rows[0];

            await client.query('COMMIT');

            CommerceKernel.emitEvent(
                'ORDER_STATUS_CHANGED',
                'ORDER',
                updatedOrder.id,
                {
                    orderId: updatedOrder.id,
                    old_status: 'PENDING',
                    new_status: 'PACKING',
                    fulfillment_type: 'PICKUP',
                    pickup_state: 'PREPARING',
                    merchantId: merchant.id,
                    actor: req.user.username
                }
            );

            return res.json({
                status: 'success',
                message: 'Pesanan mulai disiapkan',
                order: updatedOrder,
                payment
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[START PICKUP PREPARING]',
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

// Merchant mulai menyiapkan child order marketplace COD.
router.patch(
    '/merchant/orders-v2/:id/start-preparing-market-cod',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const merchantResult =
                await client.query(
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
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const merchant =
                merchantResult.rows[0];

            const orderResult =
                await client.query(
                    `SELECT *
                     FROM tbl_orders_v2
                     WHERE id = $1
                       AND merchant_id = $2
                     FOR UPDATE`,
                    [
                        req.params.id,
                        merchant.id
                    ]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Order tidak ditemukan'
                });
            }

            const order =
                orderResult.rows[0];

            if (
                String(
                    order.fulfillment_type ||
                    ''
                ).toUpperCase() !== 'DELIVERY' ||
                String(
                    order.payment_mode ||
                    ''
                ).toUpperCase() !== 'DIRECT' ||
                !order.market_order_id
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order bukan marketplace COD delivery'
                });
            }

            const marketOrderResult =
                await client.query(
                    `SELECT *
                     FROM tbl_market_orders
                     WHERE id = $1
                     FOR UPDATE`,
                    [order.market_order_id]
                );

            if (!marketOrderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Market order tidak ditemukan'
                });
            }

            const marketOrder =
                marketOrderResult.rows[0];

            if (
                marketOrder.status !==
                'COLLECTING'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Market order belum dalam proses pengumpulan',
                    current_status:
                        marketOrder.status
                });
            }

            const paymentResult =
                await client.query(
                    `SELECT *
                     FROM tbl_market_payments
                     WHERE market_order_id = $1
                     ORDER BY created_at DESC
                     LIMIT 1
                     FOR UPDATE`,
                    [marketOrder.id]
                );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Payment COD marketplace tidak ditemukan'
                });
            }

            const payment =
                paymentResult.rows[0];

            if (
                String(
                    payment.payment_method ||
                    ''
                ).toUpperCase() !== 'COD' ||
                String(
                    payment.provider ||
                    ''
                ).toUpperCase() !== 'CASH' ||
                payment.payment_status !==
                    'UNPAID'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Payment marketplace bukan COD CASH UNPAID'
                });
            }

            if (order.status === 'PACKING') {
                await client.query('COMMIT');

                return res.json({
                    status: 'success',
                    already_preparing: true,
                    message:
                        'Pesanan COD sudah sedang disiapkan',
                    order,
                    payment
                });
            }

            if (order.status !== 'PENDING') {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Pesanan harus PENDING untuk mulai disiapkan',
                    current_status:
                        order.status
                });
            }

            const reservationResult =
                await client.query(
                    `UPDATE tbl_inventory_reservations
                     SET expires_at = NULL,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE order_id = $1
                       AND status = 'RESERVED'
                       AND (
                           expires_at IS NULL
                           OR expires_at > CURRENT_TIMESTAMP
                       )
                     RETURNING id`,
                    [order.id]
                );

            if (!reservationResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Stok pesanan tidak lagi terkunci. Pesanan perlu diperiksa ulang.'
                });
            }

            const updatedResult =
                await client.query(
                    `UPDATE tbl_orders_v2
                     SET status = 'PACKING'
                     WHERE id = $1
                       AND status = 'PENDING'
                     RETURNING *`,
                    [order.id]
                );

            if (updatedResult.rowCount !== 1) {
                throw new Error(
                    'Order berubah secara bersamaan'
                );
            }

            const updatedOrder =
                updatedResult.rows[0];

            await client.query('COMMIT');

            CommerceKernel.emitEvent(
                'ORDER_STATUS_CHANGED',
                'ORDER',
                updatedOrder.id,
                {
                    orderId:
                        updatedOrder.id,
                    old_status:
                        'PENDING',
                    new_status:
                        'PACKING',
                    fulfillment_type:
                        'DELIVERY',
                    payment_method:
                        'COD',
                    merchantId:
                        merchant.id,
                    actor:
                        req.user.username
                }
            );

            return res.json({
                status: 'success',
                message:
                    'Pesanan COD mulai disiapkan',
                order:
                    updatedOrder,
                payment
            });

        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            console.error(
                '[START MARKET COD PREPARING]',
                err.message
            );

            return res.status(400).json({
                error:
                    err.message
            });

        } finally {
            client.release();
        }
    }
);

router.patch(
    '/merchant/orders-v2/:id/ready-for-pickup',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        const orderId =
            req.params.id;

        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            const merchantResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name
                    FROM tbl_merchants
                    WHERE user_id = $1
                      AND status = 'ACTIVE'
                    LIMIT 1
                    `,
                    [
                        req.user.id
                    ]
                );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const merchant =
                merchantResult.rows[0];

            const orderResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_orders_v2
                    WHERE id = $1
                      AND merchant_id = $2
                    FOR UPDATE
                    `,
                    [
                        orderId,
                        merchant.id
                    ]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Order tidak ditemukan'
                });
            }

            const order =
                orderResult.rows[0];

            if (
                String(
                    order.fulfillment_type ||
                    'DELIVERY'
                ).toUpperCase() !== 'PICKUP'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Endpoint ini hanya untuk order PICKUP'
                });
            }

            /*
             * Retry aman:
             * DISPATCHED untuk PICKUP berarti sudah siap diambil.
             */
            if (
                order.status === 'DISPATCHED'
            ) {
                const shipmentResult =
                    await client.query(
                        `
                        SELECT COUNT(*)::int AS total
                        FROM tbl_shipments
                        WHERE order_id = $1
                        `,
                        [
                            order.id
                        ]
                    );

                if (
                    Number(
                        shipmentResult.rows[0].total
                    ) !== 0
                ) {
                    throw new Error(
                        'Order PICKUP tidak boleh memiliki shipment'
                    );
                }

                await client.query('COMMIT');

                return res.json({
                    status:
                        'success',
                    message:
                        'Pesanan sudah siap diambil',
                    already_ready:
                        true,
                    order
                });
            }

            if (
                order.status !== 'PACKING'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order PICKUP harus berstatus PACKING sebelum siap diambil',
                    current_status:
                        order.status
                });
            }

            const shipmentResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_shipments
                    WHERE order_id = $1
                    `,
                    [
                        order.id
                    ]
                );

            if (
                Number(
                    shipmentResult.rows[0].total
                ) !== 0
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order PICKUP tidak boleh memiliki shipment'
                });
            }


            /*
             * Saat pesanan dinyatakan siap diambil,
             * stok tetap RESERVED selama 1 jam.
             * Belum ada SALE dan belum CONSUMED.
             */
            const reservationExpiryResult =
                await client.query(
                    `
                    UPDATE tbl_inventory_reservations
                    SET
                        expires_at =
                            CURRENT_TIMESTAMP +
                            INTERVAL '1 hour',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE order_id = $1
                      AND status = 'RESERVED'
                    RETURNING id, expires_at
                    `,
                    [
                        order.id
                    ]
                );

            if (!reservationExpiryResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Stok pesanan tidak lagi terkunci'
                });
            }

            OrderFSM.assertTransition(
                order.status,
                'DISPATCHED'
            );

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'DISPATCHED'
                    WHERE id = $1
                      AND status = 'PACKING'
                    RETURNING *
                    `,
                    [
                        order.id
                    ]
                );

            if (
                updatedResult.rowCount !== 1
            ) {
                throw new Error(
                    'Order PICKUP berubah secara bersamaan'
                );
            }

            const updatedOrder =
                updatedResult.rows[0];

            await client.query('COMMIT');

            /*
             * Event hanya setelah COMMIT.
             */
            CommerceKernel.emitEvent(
                'ORDER_STATUS_CHANGED',
                'ORDER',
                updatedOrder.id,
                {
                    orderId:
                        updatedOrder.id,
                    old_status:
                        order.status,
                    new_status:
                        'DISPATCHED',
                    fulfillment_type:
                        'PICKUP',
                    pickup_state:
                        'READY_FOR_PICKUP',
                    merchantId:
                        merchant.id,
                    actor:
                        req.user.username
                }
            );

            return res.json({
                status:
                    'success',
                message:
                    'Pesanan siap diambil di outlet',
                order:
                    updatedOrder
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[PICKUP READY V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                error:
                    err.message
            });

        } finally {
            client.release();
        }
    }
);


// Merchant menyerahkan order PICKUP kepada Customer.
// PICKUP tidak memakai shipment.
// DISPATCHED berarti siap diambil;
// DELIVERED berarti barang benar-benar telah diambil.
router.patch(
    '/merchant/orders-v2/:id/complete-pickup',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        const orderId =
            req.params.id;

        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            const merchantResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name
                    FROM tbl_merchants
                    WHERE user_id = $1
                      AND status = 'ACTIVE'
                    LIMIT 1
                    `,
                    [
                        req.user.id
                    ]
                );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const merchant =
                merchantResult.rows[0];

            const orderResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_orders_v2
                    WHERE id = $1
                      AND merchant_id = $2
                    FOR UPDATE
                    `,
                    [
                        orderId,
                        merchant.id
                    ]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Order tidak ditemukan'
                });
            }

            const order =
                orderResult.rows[0];

            if (
                String(
                    order.fulfillment_type ||
                    'DELIVERY'
                ).toUpperCase() !== 'PICKUP'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Endpoint ini hanya untuk order PICKUP'
                });
            }

            /*
             * PICKUP secara invariant tidak boleh mempunyai
             * shipment. Cek juga pada retry agar data corruption
             * tidak disembunyikan oleh idempotency.
             */
            const shipmentResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_shipments
                    WHERE order_id = $1
                    `,
                    [
                        order.id
                    ]
                );

            if (
                Number(
                    shipmentResult.rows[0].total
                ) !== 0
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order PICKUP tidak boleh memiliki shipment'
                });
            }

            /*
             * Retry aman.
             * DELIVERED untuk PICKUP berarti barang sudah
             * diserahkan langsung kepada Customer di outlet.
             */
            if (
                order.status === 'DELIVERED'
            ) {
                await client.query('COMMIT');

                return res.json({
                    status:
                        'success',
                    message:
                        'Pesanan sudah pernah diambil Customer',
                    already_completed:
                        true,
                    order
                });
            }

            if (
                order.status !== 'DISPATCHED'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order PICKUP harus berstatus DISPATCHED sebelum diserahkan kepada Customer',
                    current_status:
                        order.status
                });
            }

            await assertPickupPaymentReady(
                client,
                order
            );

            const inventoryService =
                new OrderInventoryFulfillmentService(client);

            await inventoryService.fulfillOrderSale({
                orderId: order.id
            });

            const reservationService =
                new OrderInventoryReservationService(client);

            const consumeResult =
                await reservationService.consumeOrder({
                    orderId: order.id
                });

            if (
                consumeResult.status !==
                'consumed'
            ) {
                throw new Error(
                    `Reservation PICKUP tidak valid saat handover: ${consumeResult.status}`
                );
            }

            OrderFSM.assertTransition(
                order.status,
                'DELIVERED'
            );

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'DELIVERED'
                    WHERE id = $1
                      AND status = 'DISPATCHED'
                    RETURNING *
                    `,
                    [
                        order.id
                    ]
                );

            if (
                updatedResult.rowCount !== 1
            ) {
                throw new Error(
                    'Order PICKUP berubah secara bersamaan'
                );
            }

            const updatedOrder =
                updatedResult.rows[0];

            await client.query('COMMIT');

            /*
             * Semua event HARUS setelah COMMIT.
             *
             * ORDER_STATUS_CHANGED:
             * lifecycle generik Order.
             *
             * PICKUP_COMPLETED:
             * event domain khusus handover di outlet.
             *
             * Jangan menerbitkan DELIVERY_COMPLETED karena
             * PICKUP tidak mempunyai Shipment/Courier.
             */
            CommerceKernel.emitEvent(
                'ORDER_STATUS_CHANGED',
                'ORDER',
                updatedOrder.id,
                {
                    orderId:
                        updatedOrder.id,
                    old_status:
                        order.status,
                    new_status:
                        'DELIVERED',
                    fulfillment_type:
                        'PICKUP',
                    pickup_state:
                        'PICKUP_COMPLETED',
                    merchantId:
                        merchant.id,
                    actor:
                        req.user.username
                }
            );

            CommerceKernel.emitEvent(
                'PICKUP_COMPLETED',
                'ORDER',
                updatedOrder.id,
                {
                    orderId:
                        updatedOrder.id,
                    merchantId:
                        merchant.id,
                    fulfillment_type:
                        'PICKUP',
                    oldOrderStatus:
                        order.status,
                    newOrderStatus:
                        'DELIVERED',
                    pickup_state:
                        'PICKUP_COMPLETED',
                    actor:
                        req.user.username,
                    ip:
                        req.ip
                }
            );

            return res.json({
                status:
                    'success',
                message:
                    'Pesanan berhasil diserahkan kepada Customer',
                order:
                    updatedOrder
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[PICKUP COMPLETE V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                error:
                    err.message
            });
        } finally {
            client.release();
        }
    }
);

// Merchant mengonfirmasi uang PAY_AT_OUTLET benar-benar diterima.
// Setelah COMMIT, ORDER_PAID diterbitkan untuk proses pembayaran,
// finance, CRM dan notifikasi. Inventory PAY_AT_OUTLET tetap ditahan
// sampai handover PICKUP selesai.
router.post(
    '/merchant/orders-v2/:id/confirm-outlet-payment',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        const orderId = req.params.id;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const merchantResult = await client.query(
                `
                SELECT
                    id,
                    store_name
                FROM tbl_merchants
                WHERE user_id = $1
                  AND status = 'ACTIVE'
                LIMIT 1
                `,
                [req.user.id]
            );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error:
                        'Merchant aktif tidak ditemukan'
                });
            }

            const merchant =
                merchantResult.rows[0];

            const orderResult = await client.query(
                `
                SELECT *
                FROM tbl_orders_v2
                WHERE id = $1
                  AND merchant_id = $2
                FOR UPDATE
                `,
                [
                    orderId,
                    merchant.id
                ]
            );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Order tidak ditemukan'
                });
            }

            const order =
                orderResult.rows[0];

            if (
                String(
                    order.payment_mode || 'DIRECT'
                ).toUpperCase() === 'TEMPO'
            ) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Order TEMPO tidak dapat dikonfirmasi sebagai PAY_AT_OUTLET',
                    payment_mode:
                        order.payment_mode
                });
            }

            if (
                String(
                    order.fulfillment_type || 'DELIVERY'
                ).toUpperCase() !== 'PICKUP'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Konfirmasi pembayaran outlet hanya berlaku untuk order PICKUP'
                });
            }

            const paymentResult = await client.query(
                `
                SELECT *
                FROM tbl_payments
                WHERE order_id = $1
                  AND provider = 'OUTLET'
                  AND payment_method = 'PAY_AT_OUTLET'
                ORDER BY created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [order.id]
            );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Payment PAY_AT_OUTLET tidak ditemukan'
                });
            }

            const payment =
                paymentResult.rows[0];

            /*
             * Retry pembayaran harus idempotent.
             * Payment PAID tidak berarti barang sudah diserahkan.
             */
            if (
                payment.payment_status === 'PAID'
            ) {
                if (
                    order.status === 'DISPATCHED' ||
                    order.status === 'DELIVERED'
                ) {
                    await client.query('COMMIT');
                    return res.json({
                        status: 'success',
                        message:
                            'Pembayaran outlet sudah pernah dikonfirmasi',
                        already_confirmed: true,
                        order,
                        payment
                    });
                }

                throw new Error(
                    'Payment PAID tetapi status order tidak sesuai lifecycle PICKUP'
                );
            }

            if (
                payment.payment_status !== 'UNPAID'
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Payment outlet tidak berada pada status UNPAID',
                    payment_status:
                        payment.payment_status
                });
            }

            if (order.status !== 'DISPATCHED') {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Pembayaran outlet hanya dapat diterima setelah pesanan siap diambil',
                    current_status:
                        order.status
                });
            }

            /*
             * PAY_AT_OUTLET hanya boleh dibayar selama
             * reservation pengambilan masih aktif.
             *
             * Setelah pembayaran diterima, expires_at
             * dibuat NULL lagi agar stok tetap terkunci
             * sampai barang benar-benar diserahkan.
             */
            const reservationCheck =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        expires_at
                    FROM tbl_inventory_reservations
                    WHERE order_id = $1
                    FOR UPDATE
                    `,
                    [
                        order.id
                    ]
                );

            const activeReservations =
                reservationCheck.rows.filter(
                    row =>
                        row.status === 'RESERVED' &&
                        (
                            row.expires_at === null ||
                            new Date(row.expires_at).getTime() >
                                Date.now()
                        )
                );

            if (
                !reservationCheck.rowCount ||
                activeReservations.length !==
                    reservationCheck.rowCount
            ) {
                const reservationService =
                    new OrderInventoryReservationService(
                        client
                    );

                await reservationService.expireOrder({
                    orderId: order.id
                });

                await client.query('COMMIT');

                return res.status(409).json({
                    error:
                        'Batas waktu pengambilan 1 jam sudah berakhir. Pesanan tidak dapat dibayar.',
                    pickup_expired:
                        true
                });
            }

            await client.query(
                `
                UPDATE tbl_inventory_reservations
                SET
                    expires_at = NULL,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE order_id = $1
                  AND status = 'RESERVED'
                `,
                [
                    order.id
                ]
            );

            const paymentAmount =
                Number(payment.amount);

            const orderAmount =
                Number(order.total_amount);

            if (
                !Number.isFinite(paymentAmount) ||
                !Number.isFinite(orderAmount) ||
                paymentAmount !== orderAmount
            ) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Nominal payment tidak sesuai dengan total order'
                });
            }


            const updatedPaymentResult =
                await client.query(
                    `
                    UPDATE tbl_payments
                    SET
                        payment_status = 'PAID',
                        gateway_response =
                            COALESCE(
                                gateway_response,
                                '{}'::jsonb
                            ) ||
                            $2::jsonb,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND payment_status = 'UNPAID'
                    RETURNING *
                    `,
                    [
                        payment.id,
                        JSON.stringify({
                            confirmed_at:
                                new Date().toISOString(),
                            confirmed_by:
                                req.user.username ||
                                req.user.id
                        })
                    ]
                );

            if (
                updatedPaymentResult.rowCount !== 1
            ) {
                throw new Error(
                    'Payment outlet berubah secara bersamaan'
                );
            }

            const updatedPayment =
                updatedPaymentResult.rows[0];

            /*
             * Payment confirmation hanya mencatat uang diterima.
             * Order tetap DISPATCHED sampai barang benar-benar
             * diserahkan kepada Customer.
             */
            const updatedOrder =
                order;

            const orderPaidPayload = {
                version:
                    'v2',
                ...updatedOrder,
                orderId:
                    updatedOrder.id,
                order_reference:
                    updatedOrder.id,
                payment_id:
                    updatedPayment.id,
                payment_method:
                    updatedPayment.payment_method,
                payment_status:
                    updatedPayment.payment_status,
                provider:
                    updatedPayment.provider,
                amount:
                    updatedPayment.amount
            };

            await client.query(
                `INSERT INTO tbl_order_paid_outbox
                 (order_id, payload)
                 VALUES ($1, $2::jsonb)
                 ON CONFLICT (order_id) DO NOTHING`,
                [
                    updatedOrder.id,
                    JSON.stringify(orderPaidPayload)
                ]
            );

            await client.query('COMMIT');

            /*
             * Immediate delivery setelah durable outbox COMMIT.
             * Recovery worker akan menangani event yang belum selesai.
             */
            CommerceKernel.emitEvent(
                'ORDER_PAID',
                'ORDER',
                updatedOrder.id,
                orderPaidPayload
            );

            return res.json({
                status: 'success',
                message:
                    'Pembayaran di outlet diterima',
                order:
                    updatedOrder,
                payment:
                    updatedPayment
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[CONFIRM OUTLET PAYMENT]',
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
