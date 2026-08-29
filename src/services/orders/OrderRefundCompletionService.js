const OrderFSM = require('../../kernel/OrderFSM');

class OrderRefundCompletionService {
    constructor(pool) {
        this.pool = pool;
    }

    async completeRefund({
        refundId,
        adminUserId
    }) {
        if (!refundId || !adminUserId) {
            return {
                status: 'invalid_input'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Lock refund terlebih dahulu.
             *
             * Hanya refund PENDING yang boleh diselesaikan.
             */
            const refundResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_order_refunds
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [refundId]
                );

            if (!refundResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_not_found'
                };
            }

            const refund =
                refundResult.rows[0];

            if (
                String(
                    refund.status || ''
                ).toUpperCase() !== 'PENDING'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_not_pending',
                    current_status:
                        refund.status
                };
            }

            /*
             * Lock order yang menjadi pemilik refund.
             */
            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        payment_mode,
                        total_amount
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [refund.order_id]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_found'
                };
            }

            const order =
                orderResult.rows[0];

            /*
             * Refund V1 hanya berlaku untuk DIRECT payment.
             */
            if (
                String(
                    order.payment_mode || ''
                ).toUpperCase() !== 'DIRECT'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_direct'
                };
            }

            const orderStatus =
                String(
                    order.status || ''
                ).toUpperCase();

            /*
             * FSM menjadi source of truth lifecycle order.
             *
             * Saat ini hanya:
             * PAID    -> REFUNDED
             * PACKING -> REFUNDED
             */
            if (
                !OrderFSM.canTransition(
                    orderStatus,
                    'REFUNDED'
                )
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_refundable',
                    current_status:
                        order.status
                };
            }

            /*
             * Payment yang direfund harus payment persis
             * yang direferensikan refund.
             *
             * Payment tetap PAID setelah refund selesai.
             * History bahwa uang pernah diterima tidak
             * boleh dihapus atau ditimpa.
             */
            const paymentResult =
                await client.query(
                    `
                    SELECT
                        id,
                        order_id,
                        payment_status,
                        payment_method,
                        provider,
                        channel,
                        amount,
                        external_transaction_id,
                        (amount = $3::numeric)
                            AS amount_matches_refund,
                        (amount = $4::numeric)
                            AS amount_matches_order
                    FROM tbl_payments
                    WHERE id = $1
                      AND order_id = $2
                    FOR UPDATE
                    `,
                    [
                        refund.payment_id,
                        order.id,
                        refund.amount,
                        order.total_amount
                    ]
                );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'payment_not_found'
                };
            }

            const payment =
                paymentResult.rows[0];

            if (
                String(
                    payment.payment_status || ''
                ).toUpperCase() !== 'PAID'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'payment_not_paid',
                    current_status:
                        payment.payment_status
                };
            }

            if (
                payment.amount_matches_refund !== true ||
                payment.amount_matches_order !== true
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_amount_mismatch',
                    refund_amount:
                        refund.amount,
                    payment_amount:
                        payment.amount,
                    order_amount:
                        order.total_amount
                };
            }

            const refundProvider =
                String(
                    refund.provider || ''
                ).toUpperCase();

            const paymentProvider =
                String(
                    payment.provider || ''
                ).toUpperCase();

            /*
             * Refund completion V1 adalah refund manual
             * uang outlet.
             *
             * Gateway refund belum diaktifkan di service ini.
             */
            if (
                refundProvider !== 'OUTLET' ||
                paymentProvider !== 'OUTLET'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'provider_refund_not_supported',
                    refund_provider:
                        refundProvider || 'UNKNOWN',
                    payment_provider:
                        paymentProvider || 'UNKNOWN'
                };
            }

            /*
             * Finalisasi refund.
             */
            const completedRefundResult =
                await client.query(
                    `
                    UPDATE tbl_order_refunds
                    SET
                        status = 'COMPLETED',
                        completed_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP,
                        last_error = NULL
                    WHERE id = $1
                    RETURNING *
                    `,
                    [refund.id]
                );

            /*
             * Lifecycle order selesai sebagai REFUNDED.
             *
             * Tidak mengubah tbl_payments.payment_status.
             */
            const refundedOrderResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'REFUNDED'
                    WHERE id = $1
                    RETURNING
                        id,
                        status,
                        payment_mode,
                        total_amount
                    `,
                    [order.id]
                );

            await client.query('COMMIT');

            return {
                status: 'success',
                refund:
                    completedRefundResult.rows[0],
                order:
                    refundedOrderResult.rows[0],
                payment: {
                    id:
                        payment.id,
                    payment_status:
                        payment.payment_status,
                    provider:
                        payment.provider,
                    amount:
                        payment.amount
                },
                completed_by:
                    adminUserId
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

module.exports = OrderRefundCompletionService;
