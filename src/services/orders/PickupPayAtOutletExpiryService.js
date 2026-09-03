const OrderInventoryReservationService =
    require('./OrderInventoryReservationService');

class PickupPayAtOutletExpiryService {
    constructor(pool) {
        this.pool = pool;
    }

    async findExpired(limit = 20) {
        const safeLimit =
            Math.max(
                1,
                Math.min(
                    Number(limit) || 20,
                    100
                )
            );

        const result =
            await this.pool.query(
                `
                SELECT DISTINCT
                    o.id AS order_id
                FROM tbl_orders_v2 o
                JOIN tbl_payments p
                  ON p.order_id = o.id
                JOIN tbl_inventory_reservations r
                  ON r.order_id = o.id
                WHERE
                    o.status = 'DISPATCHED'
                    AND UPPER(
                        COALESCE(
                            o.fulfillment_type,
                            ''
                        )
                    ) = 'PICKUP'
                    AND UPPER(
                        COALESCE(
                            o.payment_mode,
                            ''
                        )
                    ) = 'DIRECT'
                    AND UPPER(
                        COALESCE(
                            p.provider,
                            ''
                        )
                    ) = 'OUTLET'
                    AND UPPER(
                        COALESCE(
                            p.payment_method,
                            ''
                        )
                    ) = 'PAY_AT_OUTLET'
                    AND UPPER(
                        COALESCE(
                            p.payment_status,
                            ''
                        )
                    ) = 'UNPAID'
                    AND r.status = 'RESERVED'
                    AND r.expires_at IS NOT NULL
                    AND r.expires_at <=
                        CURRENT_TIMESTAMP
                ORDER BY o.id
                LIMIT $1
                `,
                [safeLimit]
            );

        return result.rows;
    }

    async expireOrder(orderId) {
        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const orderResult =
                await client.query(
                    `
                    SELECT
                        o.id,
                        o.status,
                        o.fulfillment_type,
                        o.payment_mode
                    FROM tbl_orders_v2 o
                    WHERE o.id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'order_not_found'
                };
            }

            const order =
                orderResult.rows[0];

            if (
                order.status !== 'DISPATCHED' ||
                String(
                    order.fulfillment_type ||
                    ''
                ).toUpperCase() !== 'PICKUP' ||
                String(
                    order.payment_mode ||
                    ''
                ).toUpperCase() !== 'DIRECT'
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'order_not_eligible'
                };
            }

            const paymentResult =
                await client.query(
                    `
                    SELECT
                        id,
                        payment_status,
                        payment_method,
                        provider
                    FROM tbl_payments
                    WHERE order_id = $1
                      AND provider = 'OUTLET'
                      AND payment_method =
                          'PAY_AT_OUTLET'
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [order.id]
                );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'payment_not_found'
                };
            }

            const payment =
                paymentResult.rows[0];

            if (
                payment.payment_status !==
                'UNPAID'
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'payment_not_unpaid'
                };
            }

            const expiredReservationResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_inventory_reservations
                    WHERE order_id = $1
                      AND status = 'RESERVED'
                      AND expires_at IS NOT NULL
                      AND expires_at <=
                          CURRENT_TIMESTAMP
                    FOR UPDATE
                    `,
                    [order.id]
                );

            if (
                !expiredReservationResult.rowCount
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'reservation_not_expired'
                };
            }

            const reservationService =
                new OrderInventoryReservationService(
                    client
                );

            const expireResult =
                await reservationService
                    .expireOrder({
                        orderId:
                            order.id
                    });

            await client.query('COMMIT');

            return {
                status:
                    expireResult.status,
                order_id:
                    order.id,
                reservations:
                    expireResult.reservations
            };
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports =
    PickupPayAtOutletExpiryService;
