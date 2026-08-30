const PaymentGateway =
    require('../payments/PaymentGateway');

class MarketPaymentIntentService {
    constructor(db) {
        this.db = db;
    }

    async create({
        marketPaymentId,
        userId,
        provider,
        paymentMethod,
        channel = null
    }) {
        if (!marketPaymentId) {
            throw new Error(
                'market_payment_id wajib'
            );
        }

        if (!userId) {
            throw new Error(
                'user_id wajib'
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
            ![
                'MIDTRANS',
                'XENDIT'
            ].includes(normalizedProvider)
        ) {
            return {
                status:
                    'unsupported_provider'
            };
        }

        if (
            ![
                'QRIS',
                'VIRTUAL_ACCOUNT',
                'BANK_TRANSFER'
            ].includes(normalizedMethod)
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
            ].includes(normalizedMethod) &&
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

        const customerResult =
            await this.db.query(
                `
                SELECT id
                FROM tbl_customers
                WHERE user_id = $1
                `,
                [userId]
            );

        if (!customerResult.rowCount) {
            return {
                status:
                    'customer_not_found'
            };
        }

        const customerId =
            customerResult.rows[0].id;

        const paymentResult =
            await this.db.query(
                `
                SELECT
                    mp.*,
                    mo.customer_id,
                    mo.status
                        AS market_order_status,
                    mo.total_amount
                        AS market_order_total
                FROM tbl_market_payments mp
                INNER JOIN tbl_market_orders mo
                    ON mo.id =
                        mp.market_order_id
                WHERE mp.id = $1
                  AND mo.customer_id = $2
                FOR UPDATE OF mp, mo
                `,
                [
                    marketPaymentId,
                    customerId
                ]
            );

        if (!paymentResult.rowCount) {
            return {
                status:
                    'payment_not_found'
            };
        }

        const payment =
            paymentResult.rows[0];

        const paymentAmount =
            Number(payment.amount);

        const orderAmount =
            Number(
                payment.market_order_total
            );

        if (
            !Number.isFinite(paymentAmount) ||
            !Number.isFinite(orderAmount) ||
            paymentAmount !== orderAmount
        ) {
            throw new Error(
                'Nominal market payment tidak sesuai'
            );
        }

        if (
            payment.payment_status ===
                'PAID'
        ) {
            return {
                status:
                    'already_paid',
                payment
            };
        }

        if (
            payment.market_order_status !==
                'PENDING'
        ) {
            return {
                status:
                    'order_not_pending',
                currentStatus:
                    payment.market_order_status
            };
        }

        if (
            payment.payment_status !==
                'UNPAID'
        ) {
            return {
                status:
                    'payment_not_unpaid',
                currentStatus:
                    payment.payment_status
            };
        }

        if (
            payment.external_transaction_id
        ) {
            const expiresAt =
                payment.expires_at
                    ? new Date(
                        payment.expires_at
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

            return {
                status:
                    stillActive
                        ? 'existing'
                        : 'expired',
                payment
            };
        }

        const gatewayOrderId =
            `MARKET-${payment.id}`;

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
                        paymentAmount,
                    order_id:
                        gatewayOrderId
                });

        if (
            Number(gatewayIntent.amount) !==
                paymentAmount
        ) {
            throw new Error(
                'Nominal gateway intent tidak sesuai'
            );
        }

        const gatewayResponse =
            gatewayIntent.gateway_response ||
            {};

        if (
            gatewayResponse.order_id &&
            gatewayResponse.order_id !==
                gatewayOrderId
        ) {
            throw new Error(
                'Gateway order_id tidak sesuai'
            );
        }

        const updatedResult =
            await this.db.query(
                `
                UPDATE tbl_market_payments
                SET
                    provider = $2,
                    payment_method = $3,
                    channel = $4,
                    external_transaction_id = $5,
                    expires_at = $6,
                    gateway_response = $7::jsonb,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                  AND payment_status =
                        'UNPAID'
                RETURNING *
                `,
                [
                    payment.id,
                    gatewayIntent.provider,
                    gatewayIntent.payment_method,
                    gatewayIntent.channel,
                    gatewayIntent
                        .external_transaction_id,
                    gatewayIntent.expires_at,
                    JSON.stringify(
                        gatewayResponse
                    )
                ]
            );

        if (
            updatedResult.rowCount !== 1
        ) {
            throw new Error(
                'Market payment berubah secara bersamaan'
            );
        }

        return {
            status:
                'updated',
            payment:
                updatedResult.rows[0]
        };
    }
}

module.exports =
    MarketPaymentIntentService;
