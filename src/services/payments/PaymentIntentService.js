const PaymentGateway =
    require('./PaymentGateway');

const {
    isMidtransProductionReady
} = require('./MidtransProductionPolicy');

class PaymentIntentService {
    constructor(pool) {
        this.pool = pool;
    }

    async create({
        orderId,
        customerId = null,
        userId = null,
        roleId = null,
        provider,
        paymentMethod,
        channel = null
    }) {
        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const result =
                await this.createWithClient({
                    client,
                    orderId,
                    customerId,
                    userId,
                    roleId,
                    provider,
                    paymentMethod,
                    channel
                });

            const commitStatuses = [
                'existing',
                'expired',
                'updated',
                'created'
            ];

            if (
                commitStatuses.includes(
                    result.status
                )
            ) {
                await client.query('COMMIT');
            } else {
                await client.query('ROLLBACK');
            }

            return result;

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

    /*
     * Existing-client primitive untuk recovery orchestration.
     *
     * Caller mengontrol BEGIN / COMMIT / ROLLBACK.
     *
     * Logic payment intent belum dipindahkan pada tahap ini.
     */
    async createWithClient({
        client,
        orderId,
        customerId = null,
        userId = null,
        roleId = null,
        provider,
        paymentMethod,
        channel = null
    }) {
        if (!client) {
            throw new Error(
                'client wajib untuk createWithClient'
            );
        }

        const normalizedProvider =
            String(provider || '')
                .trim()
                .toUpperCase();

        const normalizedMethod =
            String(paymentMethod || '')
                .trim()
                .toUpperCase();

        const normalizedChannel =
            channel
                ? String(channel)
                    .trim()
                    .toUpperCase()
                : null;

        if (
            normalizedProvider === 'MIDTRANS' &&
            !isMidtransProductionReady()
        ) {
            return {
                status:
                    'midtrans_not_ready'
            };
        }

        const allowedProviders = [
            'MIDTRANS',
            'XENDIT'
        ];

        const allowedMethods = [
            'QRIS',
            'VIRTUAL_ACCOUNT',
            'BANK_TRANSFER'
        ];

        if (
            !orderId ||
            (
                !customerId &&
                !userId
            ) ||
            !normalizedProvider ||
            !normalizedMethod
        ) {
            return {
                status: 'invalid_input'
            };
        }

        if (
            !allowedProviders.includes(
                normalizedProvider
            )
        ) {
            return {
                status:
                    'unsupported_provider'
            };
        }

        if (
            !allowedMethods.includes(
                normalizedMethod
            )
        ) {
            return {
                status:
                    'unsupported_method'
            };
        }

        if (
            [
                'VIRTUAL_ACCOUNT',
                'BANK_TRANSFER'
            ].includes(
                normalizedMethod
            ) &&
            !normalizedChannel
        ) {
            return {
                status:
                    'channel_required'
            };
        }

        const effectiveChannel =
            normalizedMethod === 'QRIS'
                ? null
                : normalizedChannel;

        const orderResult =
            await client.query(
                `
                SELECT
                    o.id,
                    o.customer_id,
                    o.merchant_id,
                    o.status,
                    o.total_amount,
                    (
                        SELECT c.user_id
                        FROM tbl_customers c
                        WHERE c.id =
                            o.customer_id
                        LIMIT 1
                    ) AS user_id
                FROM tbl_orders_v2 o
                WHERE o.id = $1
                FOR UPDATE
                `,
                [orderId]
            );

        if (
            orderResult.rowCount === 0
        ) {
            return {
                status:
                    'order_not_found'
            };
        }

        const order =
            orderResult.rows[0];

        if (
            customerId &&
            order.customer_id !==
                customerId
        ) {
            return {
                status:
                    'forbidden'
            };
        }

        if (
            !customerId &&
            Number(roleId) === 1 &&
            order.user_id !==
                userId
        ) {
            return {
                status:
                    'forbidden'
            };
        }

        if (
            !customerId &&
            Number(roleId) !== 1 &&
            Number(roleId) !== 4
        ) {
            return {
                status:
                    'forbidden'
            };
        }

        if (
            order.status !==
                'PENDING'
        ) {
            return {
                status:
                    'order_not_pending',
                currentStatus:
                    order.status
            };
        }

        const paidResult =
            await client.query(
                `
                SELECT id
                FROM tbl_payments
                WHERE order_id = $1
                  AND payment_status =
                      'PAID'
                LIMIT 1
                `,
                [order.id]
            );

        if (
            paidResult.rowCount > 0
        ) {
            return {
                status:
                    'already_paid'
            };
        }

        const existingIntent =
            await client.query(
                `
                SELECT *
                FROM tbl_payments
                WHERE order_id = $1
                  AND payment_status =
                      'UNPAID'
                ORDER BY
                    created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [order.id]
            );

        const existing =
            existingIntent.rowCount > 0
                ? existingIntent.rows[0]
                : null;

        if (
            existing &&
            existing.external_transaction_id
        ) {
            const expiresAt =
                existing.expires_at
                    ? new Date(
                        existing.expires_at
                    )
                    : null;

            const stillActive =
                !expiresAt ||
                (
                    !Number.isNaN(
                        expiresAt.getTime()
                    ) &&
                    expiresAt.getTime() >
                        Date.now()
                );

            if (stillActive) {
                return {
                    status:
                        'existing',
                    payment:
                        existing
                };
            }

            return {
                status:
                    'expired',
                payment:
                    existing
            };
        }

        const gatewayIntent =
            await PaymentGateway
                .createPaymentIntent({
                    provider:
                        normalizedProvider,
                    payment_method:
                        normalizedMethod,
                    channel:
                        effectiveChannel,
                    amount:
                        Number(
                            order.total_amount
                        ),
                    order_id:
                        order.id
                });

        if (existing) {
            const updated =
                await client.query(
                    `
                    UPDATE tbl_payments
                    SET
                        provider = $2,
                        payment_method = $3,
                        channel = $4,
                        external_transaction_id = $5,
                        expires_at = $6,
                        gateway_response = $7,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                    RETURNING *
                    `,
                    [
                        existing.id,
                        gatewayIntent.provider,
                        gatewayIntent.payment_method,
                        gatewayIntent.channel,
                        gatewayIntent
                            .external_transaction_id,
                        gatewayIntent.expires_at,
                        gatewayIntent
                            .gateway_response
                    ]
                );

            return {
                status:
                    'updated',
                payment:
                    updated.rows[0]
            };
        }

        const paymentResult =
            await client.query(
                `
                INSERT INTO tbl_payments (
                    order_id,
                    provider,
                    payment_method,
                    channel,
                    payment_status,
                    amount,
                    external_transaction_id,
                    expires_at,
                    gateway_response
                )
                VALUES (
                    $1, $2, $3, $4,
                    'UNPAID',
                    $5, $6, $7, $8
                )
                RETURNING *
                `,
                [
                    order.id,
                    gatewayIntent.provider,
                    gatewayIntent.payment_method,
                    gatewayIntent.channel,
                    order.total_amount,
                    gatewayIntent
                        .external_transaction_id,
                    gatewayIntent.expires_at,
                    gatewayIntent
                        .gateway_response
                ]
            );

        return {
            status:
                'created',
            payment:
                paymentResult.rows[0]
        };
    }
}

module.exports = PaymentIntentService;
