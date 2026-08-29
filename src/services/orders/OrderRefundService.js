
class OrderRefundService {
    constructor(pool) {
        this.pool = pool;
    }

    async requestRefund({
        orderId,
        adminUserId,
        reason
    }) {
        if (
            !orderId ||
            !adminUserId ||
            !String(reason || '').trim()
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

            if (
                ![
                    'PAID',
                    'PACKING'
                ].includes(orderStatus)
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_refundable',
                    current_status:
                        order.status
                };
            }

            const existingRefundResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        amount,
                        provider,
                        created_at
                    FROM tbl_order_refunds
                    WHERE order_id = $1
                    FOR UPDATE
                    `,
                    [order.id]
                );

            if (existingRefundResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_already_exists',
                    refund:
                        existingRefundResult.rows[0]
                };
            }

            const paymentResult =
                await client.query(
                    `
                    SELECT
                        id,
                        payment_status,
                        payment_method,
                        provider,
                        channel,
                        amount, (amount = $2::numeric) AS amount_matches_order,
                        external_transaction_id,
                        created_at
                    FROM tbl_payments
                    WHERE order_id = $1
                    ORDER BY created_at DESC, id DESC
                    FOR UPDATE
                    `,
                    [order.id, order.total_amount]
                );

            const paidPayments =
                paymentResult.rows.filter(
                    payment =>
                        String(
                            payment.payment_status || ''
                        ).toUpperCase() === 'PAID'
                );

            if (paidPayments.length !== 1) {
                await client.query('ROLLBACK');

                return {
                    status: 'paid_payment_count_invalid',
                    paid_payment_count:
                        paidPayments.length
                };
            }

            const payment =
                paidPayments[0];

            if (payment.amount_matches_order !== true) { await client.query('ROLLBACK'); return { status: 'payment_amount_mismatch', order_amount: order.total_amount, payment_amount: payment.amount }; }

            const provider =
                String(
                    payment.provider || ''
                ).toUpperCase();

            if (provider !== 'OUTLET') {
                await client.query('ROLLBACK');

                return {
                    status: 'provider_refund_not_supported',
                    provider:
                        provider || 'UNKNOWN',
                    payment_id:
                        payment.id
                };
            }

            const refundResult = await client.query(`INSERT INTO tbl_order_refunds (order_id, payment_id, amount, status, reason, provider, requested_by) VALUES ($1, $2, $3, 'PENDING', $4, $5, $6) RETURNING *`, [order.id, payment.id, payment.amount, String(reason).trim(), provider, adminUserId]);
            await client.query('COMMIT');
            return { status: 'success', refund: refundResult.rows[0], order, payment };
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

module.exports = OrderRefundService;
