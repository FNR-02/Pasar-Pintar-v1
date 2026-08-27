const OrderFSM =
    require('../../kernel/OrderFSM');

const OrderInventoryReservationService =
    require('./OrderInventoryReservationService');

class AdminStaleOrderCancellationService {
    constructor(pool) {
        this.pool = pool;
    }

    async cancel({
        orderId,
        adminUserId,
        minimumAgeHours = 72
    }) {
        if (
            !orderId ||
            !adminUserId
        ) {
            return {
                status: 'invalid_input'
            };
        }

        const normalizedMinimumAgeHours =
            Number(minimumAgeHours);

        if (
            !Number.isFinite(
                normalizedMinimumAgeHours
            ) ||
            normalizedMinimumAgeHours < 72
        ) {
            return {
                status:
                    'minimum_age_invalid'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Canonical order-v2 row lock.
             */
            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        payment_mode,
                        fulfillment_type,
                        created_at,
                        EXTRACT(
                            EPOCH FROM (
                                CURRENT_TIMESTAMP -
                                created_at
                            )
                        ) / 3600
                            AS age_hours
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );

            if (!orderResult.rowCount) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'order_not_found'
                };
            }

            const order =
                orderResult.rows[0];

            if (
                String(
                    order.status || ''
                ).toUpperCase() !==
                'PENDING'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'order_not_pending',
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
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'order_not_direct',
                    payment_mode:
                        order.payment_mode
                };
            }

            const ageHours =
                Number(
                    order.age_hours || 0
                );

            if (
                ageHours <
                normalizedMinimumAgeHours
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'order_not_stale',
                    age_hours:
                        ageHours,
                    minimum_age_hours:
                        normalizedMinimumAgeHours
                };
            }

            /*
             * Lock payment rows before cancellation policy.
             */
            const paymentResult =
                await client.query(
                    `
                    SELECT
                        id,
                        payment_status,
                        payment_method,
                        provider,
                        external_transaction_id,
                        expires_at,
                        created_at
                    FROM tbl_payments
                    WHERE order_id = $1
                    ORDER BY
                        created_at DESC,
                        id DESC
                    FOR UPDATE
                    `,
                    [order.id]
                );

            const payments =
                paymentResult.rows;

            const paidPayment =
                payments.find(
                    payment =>
                        String(
                            payment.payment_status ||
                            ''
                        ).toUpperCase() ===
                        'PAID'
                );

            if (paidPayment) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'paid_payment_exists',
                    payment:
                        paidPayment
                };
            }

            const activeUnpaid =
                payments.find(
                    payment => {
                        if (
                            String(
                                payment.payment_status ||
                                ''
                            ).toUpperCase() !==
                            'UNPAID'
                        ) {
                            return false;
                        }

                        if (
                            !payment
                                .external_transaction_id
                        ) {
                            return false;
                        }

                        if (
                            !payment.expires_at
                        ) {
                            return true;
                        }

                        const expiresAt =
                            new Date(
                                payment.expires_at
                            );

                        return (
                            !Number.isNaN(
                                expiresAt.getTime()
                            ) &&
                            expiresAt.getTime() >
                                Date.now()
                        );
                    }
                );

            if (activeUnpaid) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'active_payment_exists',
                    payment:
                        activeUnpaid
                };
            }

            /*
             * Consumed reservation means physical fulfillment
             * may already have happened. Cancellation must stop.
             */
            const consumedResult =
                await client.query(
                    `
                    SELECT
                        id,
                        product_id,
                        warehouse_id,
                        quantity,
                        status
                    FROM
                        tbl_inventory_reservations
                    WHERE
                        order_id = $1
                        AND status =
                            'CONSUMED'
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [order.id]
                );

            if (consumedResult.rowCount) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'consumed_reservation_exists',
                    reservation:
                        consumedResult.rows[0]
                };
            }

            /*
             * FSM remains canonical state-transition authority.
             */
            OrderFSM.assertTransition(
                String(order.status).toUpperCase(),
                'CANCELLED'
            );

            /*
             * RESERVED -> RELEASED.
             * This does not reduce or restore quantity_on_hand
             * because reservation never changed physical stock.
             */
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
                            'ADMIN_STALE_ORDER_CANCELLED'
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

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET
                        status =
                            'CANCELLED'
                    WHERE
                        id = $1
                        AND status =
                            'PENDING'
                    RETURNING
                        id,
                        status,
                        payment_mode,
                        fulfillment_type,
                        created_at
                    `,
                    [order.id]
                );

            if (
                updatedResult.rowCount !== 1
            ) {
                throw new Error(
                    'Order stale gagal diubah menjadi CANCELLED'
                );
            }

            await client.query('COMMIT');

            return {
                status: 'success',
                order:
                    updatedResult.rows[0],
                age_hours:
                    ageHours,
                minimum_age_hours:
                    normalizedMinimumAgeHours,
                reservation:
                    releaseResult
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
    AdminStaleOrderCancellationService;
