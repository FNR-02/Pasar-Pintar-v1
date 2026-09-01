const PaymentGateway =
    require('../payments/PaymentGateway');

const MarketOrderCancellationService =
    require('./MarketOrderCancellationService');

class MarketOrderCancellationCoordinator {
    constructor(db) {
        this.db = db;
    }

    async cancel({
        marketOrderId,
        reason = 'MARKET_ORDER_CANCELLED'
    }) {
        if (!marketOrderId) {
            throw new Error(
                'market_order_id wajib'
            );
        }

        const orderResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_market_orders
                WHERE id = $1
                FOR UPDATE
                `,
                [marketOrderId]
            );

        if (!orderResult.rowCount) {
            return {
                status:
                    'market_order_not_found'
            };
        }

        const marketOrder =
            orderResult.rows[0];

        if (
            marketOrder.status ===
            'CANCELLED'
        ) {
            return {
                status:
                    'already_cancelled',
                market_order_id:
                    marketOrder.id
            };
        }

        if (
            marketOrder.status !==
            'PENDING'
        ) {
            return {
                status:
                    'market_order_not_pending',
                current_status:
                    marketOrder.status
            };
        }

        const paymentResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_market_payments
                WHERE market_order_id = $1
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                FOR UPDATE
                `,
                [marketOrder.id]
            );

        const payment =
            paymentResult.rowCount
                ? paymentResult.rows[0]
                : null;

        if (
            payment &&
            payment.payment_status ===
                'PAID'
        ) {
            return {
                status:
                    'payment_already_paid',
                market_payment_id:
                    payment.id
            };
        }

        let gatewayResult = null;

        if (
            payment &&
            payment.payment_status ===
                'UNPAID' &&
            payment.external_transaction_id
        ) {
            const provider =
                String(
                    payment.provider || ''
                ).toUpperCase();

            if (provider !== 'MIDTRANS') {
                return {
                    status:
                        'gateway_cancel_unsupported',
                    provider
                };
            }

            const gatewayStatus =
                await PaymentGateway
                    .getTransactionStatus({
                        provider,
                        transaction_id:
                            payment
                                .external_transaction_id
                    });

            const transactionStatus =
                String(
                    gatewayStatus
                        .transaction_status ||
                    ''
                ).toLowerCase();

            if (
                [
                    'settlement',
                    'capture'
                ].includes(
                    transactionStatus
                )
            ) {
                return {
                    status:
                        'gateway_already_paid',
                    transaction_status:
                        transactionStatus
                };
            }

            if (
                ![
                    'cancel',
                    'expire',
                    'deny',
                    'failure'
                ].includes(
                    transactionStatus
                )
            ) {
                gatewayResult =
                    await PaymentGateway
                        .cancelTransaction({
                            provider,
                            transaction_id:
                                payment
                                    .external_transaction_id
                        });
            } else {
                gatewayResult =
                    gatewayStatus;
            }
        }

        if (
            payment &&
            payment.payment_status ===
                'UNPAID'
        ) {
            const updatePayment =
                await this.db.query(
                    `
                    UPDATE tbl_market_payments
                    SET
                        payment_status =
                            'CANCELLED',
                        gateway_response =
                            COALESCE(
                                gateway_response,
                                '{}'::jsonb
                            ) ||
                            $2::jsonb,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND payment_status =
                            'UNPAID'
                    RETURNING *
                    `,
                    [
                        payment.id,
                        JSON.stringify({
                            cancellation_reason:
                                reason,
                            cancelled_at:
                                new Date()
                                    .toISOString(),
                            gateway_cancellation:
                                gatewayResult
                                    ? {
                                        transaction_status:
                                            gatewayResult
                                                .transaction_status ||
                                            null,
                                        status_code:
                                            gatewayResult
                                                .status_code ||
                                            null
                                    }
                                    : null
                        })
                    ]
                );

            if (
                updatePayment.rowCount !==
                1
            ) {
                throw new Error(
                    'Market payment berubah secara bersamaan'
                );
            }
        }

        const cancellationService =
            new MarketOrderCancellationService(
                this.db
            );

        const cancellation =
            await cancellationService
                .cancelPendingMarketOrder({
                    marketOrderId:
                        marketOrder.id,
                    reason
                });

        if (
            ![
                'cancelled',
                'already_cancelled'
            ].includes(
                cancellation.status
            )
        ) {
            throw new Error(
                `Market cancellation gagal: ${cancellation.status}`
            );
        }

        return {
            ...cancellation,
            market_payment_id:
                payment
                    ? payment.id
                    : null,
            payment_status:
                payment
                    ? (
                        payment.payment_status ===
                            'UNPAID'
                            ? 'CANCELLED'
                            : payment.payment_status
                    )
                    : null,
            gateway_transaction_status:
                gatewayResult
                    ? gatewayResult
                        .transaction_status ||
                      null
                    : null
        };
    }
}

module.exports =
    MarketOrderCancellationCoordinator;
