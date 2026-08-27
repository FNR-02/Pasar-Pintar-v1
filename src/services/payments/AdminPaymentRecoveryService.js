const OrderInventoryReservationService =
    require(
        '../orders/OrderInventoryReservationService'
    );

const PaymentIntentService =
    require('./PaymentIntentService');

class AdminPaymentRecoveryService {
    constructor(pool) {
        this.pool = pool;
    }

    async recover({
        orderId,
        adminUserId,
        provider,
        paymentMethod,
        channel = null
    }) {
        if (
            !orderId ||
            !adminUserId ||
            !provider ||
            !paymentMethod
        ) {
            return {
                status: 'invalid_input'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        payment_mode,
                        fulfillment_type,
                        shipping_address,
                        pickup_location_snapshot,
                        total_amount
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_found'
                };
            }

            const order =
                orderResult.rows[0];

            if (
                String(order.status || '')
                    .toUpperCase() !==
                'PENDING'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_pending',
                    current_status:
                        order.status
                };
            }

            if (
                String(
                    order.payment_mode ||
                    'DIRECT'
                ).toUpperCase() !==
                'DIRECT'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'tempo_not_allowed'
                };
            }

            if (
                String(
                    order.fulfillment_type ||
                    'DELIVERY'
                ).toUpperCase() ===
                    'DELIVERY' &&
                !String(
                    order.shipping_address ||
                    ''
                ).trim()
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'delivery_address_required'
                };
            }

            const paidResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_payments
                    WHERE order_id = $1
                      AND payment_status = 'PAID'
                    LIMIT 1
                    `,
                    [order.id]
                );

            if (paidResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'already_paid'
                };
            }

            /*
             * =====================================================
             * PAYMENT RECOVERY POLICY V1
             *
             * Recovery pertama sengaja sempit:
             *
             * - NO_PAYMENT
             * - FAILED
             * - UNPAID tanpa external transaction reference
             *
             * UNPAID yang sudah mempunyai external reference
             * tidak boleh disentuh oleh recovery V1.
             *
             * Active reference harus dipakai apa adanya.
             * Expired reference membutuhkan explicit retry policy
             * pada versi berikutnya.
             * =====================================================
             */
            const latestPaymentResult =
                await client.query(
                    `
                    SELECT
                        id,
                        payment_status,
                        payment_method,
                        provider,
                        channel,
                        external_transaction_id,
                        expires_at,
                        created_at
                    FROM tbl_payments
                    WHERE order_id = $1
                    ORDER BY
                        created_at DESC,
                        id DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [order.id]
                );

            const latestPayment =
                latestPaymentResult.rowCount
                    ? latestPaymentResult.rows[0]
                    : null;

            let recoveryPaymentState =
                'NO_PAYMENT';

            if (latestPayment) {
                const paymentStatus =
                    String(
                        latestPayment.payment_status ||
                        ''
                    ).toUpperCase();

                if (
                    paymentStatus ===
                    'FAILED'
                ) {
                    recoveryPaymentState =
                        'FAILED_PAYMENT';

                } else if (
                    paymentStatus ===
                    'UNPAID'
                ) {
                    if (
                        !latestPayment
                            .external_transaction_id
                    ) {
                        recoveryPaymentState =
                            'UNPAID_WITHOUT_REFERENCE';

                    } else {
                        const expiresAt =
                            latestPayment.expires_at
                                ? new Date(
                                    latestPayment
                                        .expires_at
                                )
                                : null;

                        const active =
                            !expiresAt ||
                            (
                                !Number.isNaN(
                                    expiresAt
                                        .getTime()
                                ) &&
                                expiresAt
                                    .getTime() >
                                    Date.now()
                            );

                        await client.query(
                            'ROLLBACK'
                        );

                        return {
                            status:
                                active
                                    ? 'active_payment_exists'
                                    : 'expired_payment_requires_explicit_retry',
                            recovery_payment_state:
                                active
                                    ? 'ACTIVE_UNPAID'
                                    : 'EXPIRED_UNPAID',
                            payment:
                                latestPayment
                        };
                    }

                } else {
                    await client.query(
                        'ROLLBACK'
                    );

                    return {
                        status:
                            'payment_state_not_recoverable',
                        recovery_payment_state:
                            paymentStatus ||
                            'UNKNOWN',
                        payment:
                            latestPayment
                    };
                }
            }

            /*
             * Reservation hidup selama 30 menit.
             *
             * reviveOrder() menghitung ulang available stock
             * dan hanya mengubah reservation terminal
             * RELEASED / EXPIRED menjadi RESERVED bila aman.
             */
            const reservationExpiresAt =
                new Date(
                    Date.now() +
                    30 * 60 * 1000
                );

            const reservationService =
                new OrderInventoryReservationService(
                    client
                );

            const reservation =
                await reservationService
                    .reviveOrder({
                        orderId: order.id,
                        expiresAt:
                            reservationExpiresAt
                    });

            const paymentIntentService =
                new PaymentIntentService(
                    this.pool
                );

            const payment =
                await paymentIntentService
                    .createWithClient({
                        client,
                        orderId:
                            order.id,
                        userId:
                            adminUserId,
                        roleId:
                            4,
                        provider,
                        paymentMethod,
                        channel
                    });

            const acceptableStatuses = [
                'created',
                'updated',
                'existing'
            ];

            if (
                !acceptableStatuses.includes(
                    payment.status
                )
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'payment_recovery_rejected',
                    payment_status:
                        payment.status,
                    payment
                };
            }

            await client.query('COMMIT');

            return {
                status: 'success',
                order: {
                    id:
                        order.id,
                    status:
                        order.status,
                    payment_mode:
                        order.payment_mode,
                    fulfillment_type:
                        order.fulfillment_type
                },
                recovery_payment_state:
                    recoveryPaymentState,
                reservation,
                payment
            };

        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            throw err;

        } finally {
            client.release();
        }
    }
}

module.exports =
    AdminPaymentRecoveryService;
