const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/db');
const OrderFSM = require('../kernel/OrderFSM');
const CommerceKernel = require('../kernel/EventKernel');
const PaymentIntentService =
    require('../services/payments/PaymentIntentService');

const OrderInventoryFulfillmentService =
    require(
        '../services/orders/OrderInventoryFulfillmentService'
    );

const OrderInventoryReservationService =
    require(
        '../services/orders/OrderInventoryReservationService'
    );
const { verifyToken, requireRole } = require('../middleware/auth');

const paymentIntentService =
    new PaymentIntentService(pool);

// Customer membaca status pembayaran order miliknya sendiri.
// Endpoint read-only: tidak mengubah payment maupun order.
router.get(
    '/orders/:orderId/payment-status',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        const { orderId } = req.params;

        try {
            const orderResult = await pool.query(
                `SELECT
                    o.id,
                    o.status AS order_status,
                    o.total_amount,
                    c.user_id
                 FROM tbl_orders_v2 o
                 JOIN tbl_customers c
                    ON c.id = o.customer_id
                 WHERE o.id = $1
                 LIMIT 1`,
                [orderId]
            );

            if (orderResult.rowCount === 0) {
                return res.status(404).json({
                    error: 'Order tidak ditemukan'
                });
            }

            const order = orderResult.rows[0];

            if (
                Number(req.user.role_id) === 1 &&
                order.user_id !== req.user.id
            ) {
                return res.status(403).json({
                    error: 'Akses ditolak',
                    message: 'Order bukan milik Customer ini'
                });
            }

            const paymentResult = await pool.query(
                `SELECT
                    id,
                    provider,
                    payment_method,
                    channel,
                    payment_status,
                    amount,
                    external_transaction_id,
                    expires_at,
                    created_at,
                    updated_at
                 FROM tbl_payments
                 WHERE order_id = $1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [order.id]
            );

            const payment =
                paymentResult.rowCount > 0
                    ? paymentResult.rows[0]
                    : null;

            return res.json({
                status: 'success',
                order: {
                    id: order.id,
                    status: order.order_status,
                    total_amount: order.total_amount
                },
                payment
            });
        } catch (err) {
            console.error('[PAYMENT STATUS]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

// Customer memilih bayar saat mengambil barang di outlet.
// Endpoint ini hanya membuat payment UNPAID.
// Uang BELUM dianggap diterima.
router.post(
    '/orders/:orderId/pay-at-outlet',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        const { orderId } = req.params;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const orderResult = await client.query(
                `
                SELECT
                    o.id,
                    o.customer_id,
                    o.merchant_id,
                    o.status,
                    o.fulfillment_type,
                    o.pickup_location_snapshot,
                    o.total_amount,
                    c.user_id
                FROM tbl_orders_v2 o
                JOIN tbl_customers c
                    ON c.id = o.customer_id
                WHERE o.id = $1
                FOR UPDATE
                `,
                [orderId]
            );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error: 'Order tidak ditemukan'
                });
            }

            const order = orderResult.rows[0];

            if (
                Number(req.user.role_id) === 1 &&
                order.user_id !== req.user.id
            ) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error: 'Order bukan milik Customer ini'
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
                        'Bayar di outlet hanya tersedia untuk order PICKUP'
                });
            }

            if (order.status !== 'PENDING') {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Order tidak berada pada status PENDING',
                    current_status:
                        order.status
                });
            }

            /*
             * Idempotency:
             * jika PAY_AT_OUTLET UNPAID sudah ada,
             * jangan buat baris kedua.
             */
            const existingOutlet = await client.query(
                `
                SELECT *
                FROM tbl_payments
                WHERE order_id = $1
                  AND provider = 'OUTLET'
                  AND payment_method = 'PAY_AT_OUTLET'
                  AND payment_status = 'UNPAID'
                ORDER BY created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [order.id]
            );

            if (existingOutlet.rowCount) {
                await client.query('COMMIT');

                return res.json({
                    status: 'success',
                    message:
                        'Pembayaran di outlet sudah dipilih',
                    payment:
                        existingOutlet.rows[0]
                });
            }

            /*
             * Jangan izinkan perpindahan ke outlet jika
             * payment gateway aktif masih hidup.
             *
             * Ini mencegah risiko pelanggan membayar QR lama
             * setelah kasir juga menerima pembayaran outlet.
             */
            const activeGateway = await client.query(
                `
                SELECT
                    id,
                    provider,
                    payment_method,
                    external_transaction_id,
                    expires_at
                FROM tbl_payments
                WHERE order_id = $1
                  AND payment_status = 'UNPAID'
                  AND external_transaction_id IS NOT NULL
                  AND (
                        expires_at IS NULL
                        OR expires_at > CURRENT_TIMESTAMP
                  )
                ORDER BY created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [order.id]
            );

            if (activeGateway.rowCount) {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Masih ada pembayaran online aktif. Tunggu pembayaran tersebut kedaluwarsa sebelum memilih bayar di outlet.',
                    payment:
                        activeGateway.rows[0]
                });
            }

            const paymentResult = await client.query(
                `
                INSERT INTO tbl_payments (
                    order_id,
                    payment_method,
                    payment_status,
                    amount,
                    gateway_response,
                    provider,
                    channel,
                    external_transaction_id,
                    expires_at,
                    updated_at
                )
                VALUES (
                    $1,
                    'PAY_AT_OUTLET',
                    'UNPAID',
                    $2,
                    $3::jsonb,
                    'OUTLET',
                    'PICKUP',
                    NULL,
                    NULL,
                    CURRENT_TIMESTAMP
                )
                RETURNING *
                `,
                [
                    order.id,
                    order.total_amount,
                    JSON.stringify({
                        type:
                            'PAY_AT_OUTLET',
                        selected_at:
                            new Date().toISOString()
                    })
                ]
            );

            await client.query('COMMIT');

            return res.status(201).json({
                status: 'success',
                message:
                    'Bayar di outlet berhasil dipilih. Bayar saat mengambil barang.',
                order: {
                    id:
                        order.id,
                    status:
                        order.status,
                    fulfillment_type:
                        order.fulfillment_type,
                    pickup_location_snapshot:
                        order.pickup_location_snapshot,
                    total_amount:
                        order.total_amount
                },
                payment:
                    paymentResult.rows[0]
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[PAY AT OUTLET]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });

        } finally {
            client.release();
        }
    }
);

// Customer membuat payment intent.
// Endpoint ini TIDAK menandai pembayaran sebagai PAID.
router.post(
    '/orders/:orderId/payment-intent',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        const { orderId } = req.params;

        const {
            provider,
            payment_method,
            channel
        } = req.body;

        try {
            const result =
                await paymentIntentService.create({
                    orderId,
                    userId:
                        req.user.id,
                    roleId:
                        req.user.role_id,
                    provider,
                    paymentMethod:
                        payment_method,
                    channel
                });

            switch (result.status) {
                case 'created':
                    return res.status(201).json({
                        status: 'success',
                        message:
                            'Payment intent berhasil dibuat',
                        payment:
                            result.payment
                    });

                case 'updated':
                    return res.status(200).json({
                        status: 'success',
                        message:
                            'Pilihan metode pembayaran diperbarui',
                        payment:
                            result.payment
                    });

                case 'existing':
                    return res.status(200).json({
                        status: 'success',
                        message:
                            'Payment intent gateway aktif sudah tersedia',
                        payment:
                            result.payment
                    });

                case 'invalid_input':
                    return res.status(400).json({
                        error:
                            'orderId, provider dan payment_method wajib diisi'
                    });

                case 'unsupported_provider':
                    return res.status(400).json({
                        error:
                            'Provider pembayaran tidak didukung',
                        allowed_providers: [
                            'MIDTRANS',
                            'XENDIT'
                        ]
                    });

                case 'unsupported_method':
                    return res.status(400).json({
                        error:
                            'Metode pembayaran tidak didukung',
                        allowed_methods: [
                            'QRIS',
                            'VIRTUAL_ACCOUNT',
                            'BANK_TRANSFER'
                        ]
                    });

                case 'channel_required':
                    return res.status(400).json({
                        error:
                            'Channel bank wajib diisi untuk metode pembayaran ini'
                    });

                case 'order_not_found':
                    return res.status(404).json({
                        error:
                            'Order tidak ditemukan'
                    });

                case 'forbidden':
                    return res.status(403).json({
                        error:
                            'Akses ditolak',
                        message:
                            'Order bukan milik Customer ini'
                    });

                case 'order_not_pending':
                    return res.status(409).json({
                        error:
                            'Order tidak berada pada status PENDING',
                        current_status:
                            result.currentStatus
                    });

                case 'already_paid':
                    return res.status(409).json({
                        error:
                            'Order sudah dibayar'
                    });

                default:
                    return res.status(500).json({
                        error:
                            'Status payment intent tidak dikenal'
                    });
            }
        } catch (err) {
            console.error(
                '[PAYMENT INTENT]',
                err.message
            );

            return res.status(500).json({
                error:
                    err.message
            });
        }
    }
);


router.post('/orders/:orderId/payment-v2', verifyToken, requireRole(4), async (req, res) => {
    const { orderId } = req.params;
    const { payment_method, gateway_response } = req.body;

    if (!orderId || !payment_method) {
        return res.status(400).json({
            error: 'orderId dan payment_method wajib diisi'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const orderResult = await client.query(
            `SELECT
                id,
                customer_id,
                merchant_id,
                status,
                shipping_address,
                total_amount,
                payment_mode,
                credit_account_id,
                tempo_due_at,
                created_at
             FROM tbl_orders_v2
             WHERE id = $1
             FOR UPDATE`,
            [orderId]
        );

        if (orderResult.rowCount === 0) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Order tidak ditemukan',
                order_id: orderId
            });
        }

        const order = orderResult.rows[0];

        if (order.status !== 'PENDING') {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'Order tidak berada pada status PENDING',
                current_status: order.status
            });
        }


        if (
            String(
                order.payment_mode || 'DIRECT'
            ).toUpperCase() === 'TEMPO'
        ) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error:
                    'Order TEMPO tidak dapat dibayar melalui payment langsung',
                payment_mode:
                    order.payment_mode
            });
        }

        OrderFSM.assertTransition(order.status, 'PAID');

        const existingPayment = await client.query(
            `SELECT
                id,
                payment_method,
                payment_status,
                amount,
                created_at
             FROM tbl_payments
             WHERE order_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [order.id]
        );

        if (
            existingPayment.rowCount > 0 &&
            existingPayment.rows[0].payment_status === 'PAID'
        ) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'Order sudah memiliki pembayaran PAID',
                payment: existingPayment.rows[0]
            });
        }

        const paymentResult = await client.query(
            `INSERT INTO tbl_payments (
                order_id,
                payment_method,
                payment_status,
                amount,
                gateway_response
             )
             VALUES ($1, $2, 'PAID', $3, $4)
             RETURNING *`,
            [
                order.id,
                payment_method,
                order.total_amount,
                gateway_response || {}
            ]
        );

        const payment = paymentResult.rows[0];

        const updatedOrderResult = await client.query(
            `UPDATE tbl_orders_v2
             SET status = 'PAID'
             WHERE id = $1
             RETURNING *`,
            [order.id]
        );

        const updatedOrder = updatedOrderResult.rows[0];


        await client.query('COMMIT');

        const eventPacket = CommerceKernel.emitEvent(
            'ORDER_PAID',
            'ORDER',
            updatedOrder.id,
            {
                version: 'v2',
                ...updatedOrder,
                orderId: updatedOrder.id,
                order_reference: updatedOrder.id,
                payment_id: payment.id,
                payment_method: payment.payment_method,
                payment_status: payment.payment_status,
                amount: payment.amount
            }
        );

        return res.status(201).json({
            status: 'success',
            message: 'Pembayaran berhasil dicatat dan order menjadi PAID',
            order: updatedOrder,
            payment: payment,
            event: {
                event_name: eventPacket.eventName,
                aggregate_type: eventPacket.aggregateType,
                aggregate_id: eventPacket.aggregateId
            }
        });

    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {}
        }

        console.error('[PAYMENT V2]', err.message);

        return res.status(500).json({
            error: err.message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});


// Midtrans HTTP Notification / Webhook
router.post('/payments/midtrans/webhook', async (req, res) => {
    const notification = req.body || {};

    const {
        order_id,
        transaction_id,
        transaction_status,
        fraud_status,
        status_code,
        gross_amount,
        signature_key
    } = notification;

    if (
        !order_id ||
        !transaction_status ||
        !status_code ||
        !gross_amount ||
        !signature_key
    ) {
        return res.status(400).json({
            error: 'Payload webhook Midtrans tidak lengkap'
        });
    }

    const serverKey = process.env.MIDTRANS_SERVER_KEY;

    if (!serverKey) {
        console.error('[MIDTRANS WEBHOOK] Server key tidak tersedia');

        return res.status(500).json({
            error: 'Konfigurasi Midtrans tidak tersedia'
        });
    }

    const expectedSignature = crypto
        .createHash('sha512')
        .update(
            String(order_id) +
            String(status_code) +
            String(gross_amount) +
            String(serverKey)
        )
        .digest('hex');

    if (expectedSignature !== signature_key) {
        console.error(
            `[MIDTRANS WEBHOOK] Signature tidak valid untuk ${order_id}`
        );

        return res.status(403).json({
            error: 'Signature Midtrans tidak valid'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const paymentResult = await client.query(
            `SELECT *
             FROM tbl_payments
             WHERE order_id = $1
               AND provider = 'MIDTRANS'
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [order_id]
        );

        if (!paymentResult.rowCount) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Payment Midtrans tidak ditemukan'
            });
        }

        const payment = paymentResult.rows[0];

        const orderResult = await client.query(
            `SELECT *
             FROM tbl_orders_v2
             WHERE id = $1
             FOR UPDATE`,
            [order_id]
        );

        if (!orderResult.rowCount) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Order tidak ditemukan'
            });
        }

        const order = orderResult.rows[0];

        const webhookAmount = Number(gross_amount);
        const paymentAmount = Number(payment.amount);
        const orderAmount = Number(order.total_amount);

        if (!Number.isFinite(webhookAmount) ||
            webhookAmount !== paymentAmount ||
            webhookAmount !== orderAmount) {
            await client.query("ROLLBACK");
            console.error(`[MIDTRANS WEBHOOK] Nominal tidak cocok untuk ${order_id}`);
            return res.status(400).json({
                error: "Nominal pembayaran tidak sesuai"
            });
        }

        const isSuccess =
            ['settlement', 'capture'].includes(transaction_status) &&
            String(status_code) === '200' &&
            (!fraud_status || fraud_status === 'accept');

        const isFailed =
            ['deny', 'cancel', 'expire', 'failure'].includes(
                transaction_status
            );

        if (isSuccess) {
            /*
             * =====================================================
             * ATOMIC MIDTRANS DIRECT FULFILLMENT
             *
             * Satu transaction:
             *
             * payment -> PAID
             * order   -> PAID
             * inventory SALE
             * reservation -> CONSUMED
             * order   -> PACKING
             *
             * ORDER_PAID diterbitkan hanya setelah COMMIT.
             * =====================================================
             */

            /*
             * Retry setelah transaction atomic sukses.
             *
             * Payment PAID + Order PACKING/lebih lanjut berarti
             * webhook ini sudah pernah diproses.
             */
            if (
                payment.payment_status === 'PAID'
            ) {
                const saleResult =
                    await client.query(
                        `
                        SELECT
                            COUNT(*)::int AS total
                        FROM tbl_inventory_movements
                        WHERE movement_type = 'SALE'
                          AND reference_doc =
                              $1
                        `,
                        [
                            `ORD-${order.id}`
                        ]
                    );

                const reservationResult =
                    await client.query(
                        `
                        SELECT
                            COUNT(*) FILTER (
                                WHERE status = 'RESERVED'
                            )::int
                                AS reserved,
                            COUNT(*) FILTER (
                                WHERE status = 'CONSUMED'
                            )::int
                                AS consumed
                        FROM tbl_inventory_reservations
                        WHERE order_id = $1
                        `,
                        [
                            order.id
                        ]
                    );

                const reservationState =
                    reservationResult.rows[0];

                if (
                    Number(
                        saleResult.rows[0].total
                    ) > 0 &&
                    Number(
                        reservationState.reserved
                    ) === 0
                ) {
                    await client.query('COMMIT');

                    return res.status(200).json({
                        status:
                            'success',
                        message:
                            'Webhook sudah pernah diproses'
                    });
                }

                /*
                 * Legacy PAID yang belum mempunyai atomic
                 * fulfillment tidak boleh diam-diam dianggap
                 * selesai.
                 */
                throw new Error(
                    'Payment PAID tetapi atomic inventory fulfillment belum lengkap'
                );
            }

            if (order.status !== 'PENDING') {
                throw new Error(
                    `Order ${order.id} tidak berada pada status PENDING`
                );
            }

            OrderFSM.assertTransition(
                order.status,
                'PAID'
            );

            const updatedPaymentResult =
                await client.query(
                    `
                    UPDATE tbl_payments
                    SET
                        payment_status =
                            'PAID',
                        external_transaction_id =
                            COALESCE(
                                $2,
                                external_transaction_id
                            ),
                        gateway_response =
                            COALESCE(
                                gateway_response,
                                '{}'::jsonb
                            ) ||
                            $3::jsonb,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND payment_status =
                          'UNPAID'
                    RETURNING *
                    `,
                    [
                        payment.id,
                        transaction_id || null,
                        notification
                    ]
                );

            if (
                updatedPaymentResult.rowCount !==
                1
            ) {
                throw new Error(
                    'Payment berubah secara bersamaan'
                );
            }

            const paidOrderResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'PAID'
                    WHERE id = $1
                      AND status = 'PENDING'
                    RETURNING *
                    `,
                    [
                        order.id
                    ]
                );

            if (
                paidOrderResult.rowCount !== 1
            ) {
                throw new Error(
                    'Order berubah secara bersamaan'
                );
            }

            const inventoryService =
                new OrderInventoryFulfillmentService(
                    client
                );

            const fulfillment =
                await inventoryService
                    .fulfillOrderSale({
                        orderId:
                            order.id
                    });

            const reservationService =
                new OrderInventoryReservationService(
                    client
                );

            const consumeResult =
                await reservationService
                    .consumeOrder({
                        orderId:
                            order.id
                    });

            /*
             * DIRECT checkout baru harus mempunyai reservation.
             *
             * Untuk compatibility data lama, nothing_to_consume
             * masih diperbolehkan hanya bila fulfillment SALE
             * benar-benar sukses.
             */
            if (
                ![
                    'consumed',
                    'already_consumed',
                    'nothing_to_consume'
                ].includes(
                    consumeResult.status
                )
            ) {
                throw new Error(
                    `Reservation consume gagal: ${consumeResult.status}`
                );
            }

            const packingResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'PACKING'
                    WHERE id = $1
                      AND status = 'PAID'
                    RETURNING *
                    `,
                    [
                        order.id
                    ]
                );

            if (
                packingResult.rowCount !== 1
            ) {
                throw new Error(
                    'Order gagal masuk PACKING'
                );
            }

            const finalPayment =
                updatedPaymentResult.rows[0];

            const finalOrder =
                packingResult.rows[0];

            await client.query('COMMIT');

            /*
             * Event hanya setelah seluruh state canonical
             * berhasil COMMIT.
             *
             * Subscriber lama menjadi idempotent:
             * - orderSubscriber melihat PACKING dan skip.
             * - warehouseSubscriber melihat SALE existing
             *   dan skip.
             */
            CommerceKernel.emitEvent(
                'ORDER_PAID',
                'ORDER',
                finalOrder.id,
                {
                    version:
                        'v2',
                    ...finalOrder,
                    orderId:
                        finalOrder.id,
                    order_reference:
                        finalOrder.id,
                    payment_id:
                        finalPayment.id,
                    payment_method:
                        finalPayment.payment_method,
                    payment_status:
                        finalPayment.payment_status,
                    amount:
                        finalPayment.amount,
                    inventory_reference:
                        fulfillment.reference_doc,
                    reservation_status:
                        consumeResult.status,
                    atomic_fulfillment:
                        true
                }
            );

            return res.status(200).json({
                status:
                    'success',
                message:
                    'Pembayaran Midtrans dikonfirmasi PAID dan pesanan masuk PACKING'
            });
        }

        if (isFailed) {
            /*
             * =====================================================
             * ATOMIC MIDTRANS FAILURE RESERVATION RELEASE
             *
             * Failure gateway tidak pernah menyentuh physical stock.
             *
             * Dalam transaction yang sama:
             *
             * payment -> FAILED
             * RESERVED -> RELEASED
             *
             * Payment yang sudah PAID tidak boleh pernah
             * me-release reservation.
             * =====================================================
             */

            if (
                payment.payment_status ===
                    'PAID'
            ) {
                await client.query('COMMIT');

                return res.status(200).json({
                    status:
                        'success',
                    message:
                        'Webhook gagal diabaikan karena pembayaran sudah PAID'
                });
            }

            const failedPaymentResult =
                await client.query(
                    `
                    UPDATE tbl_payments
                    SET
                        payment_status =
                            'FAILED',
                        gateway_response =
                            COALESCE(
                                gateway_response,
                                '{}'::jsonb
                            ) ||
                            $2::jsonb,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND payment_status <>
                            'PAID'
                    RETURNING *
                    `,
                    [
                        payment.id,
                        notification
                    ]
                );

            if (
                failedPaymentResult.rowCount !==
                    1
            ) {
                throw new Error(
                    'Payment gagal diperbarui menjadi FAILED'
                );
            }

            const reservationService =
                new OrderInventoryReservationService(
                    client
                );

            const releaseResult =
                await reservationService
                    .releaseOrder({
                        orderId:
                            order.id,
                        reason:
                            `MIDTRANS_${String(
                                transaction_status
                            ).toUpperCase()}`
                    });

            if (
                ![
                    'released',
                    'nothing_to_release'
                ].includes(
                    releaseResult.status
                )
            ) {
                throw new Error(
                    `Reservation release gagal: ${releaseResult.status}`
                );
            }

            await client.query('COMMIT');

            return res.status(200).json({
                status:
                    'success',
                message:
                    'Status pembayaran Midtrans diperbarui FAILED dan reservation dilepas',
                reservation_status:
                    releaseResult.status
            });
        }

        await client.query(
            `UPDATE tbl_payments
             SET gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $2::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [
                payment.id,
                notification
            ]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            status: 'success',
            message: 'Webhook Midtrans diterima',
            transaction_status
        });

    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}
        }

        console.error('[MIDTRANS WEBHOOK ERROR]', err.message);

        return res.status(500).json({
            error: err.message
        });

    } finally {
        if (client) client.release();
    }
});

module.exports = router;
