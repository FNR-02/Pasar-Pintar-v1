const crypto = require('crypto');


class MarketPaymentRefundService {
    constructor(pool) {
        this.pool = pool;
    }

    static buildRefundKey() {
        return `MREF-${crypto.randomUUID()}`;
    }

    async requestRefund({
        marketPaymentId,
        requestedBy = null,
        reasonCode,
        reason,
        amount = null,
        refundType = 'FULL',
        requestSource = 'ADMIN',
        customerNote = null,
        reconciliationData = null
    }) {
        if (
            !marketPaymentId ||
            !String(reasonCode || '').trim() ||
            !String(reason || '').trim()
        ) {
            return { status: 'invalid_input' };
        }

        const type =
            String(refundType).trim().toUpperCase();
        const source =
            String(requestSource).trim().toUpperCase();

        if (!['FULL', 'PARTIAL'].includes(type)) {
            return {
                status: 'invalid_refund_type'
            };
        }

        if (
            !['CUSTOMER', 'ADMIN', 'SYSTEM']
                .includes(source)
        ) {
            return {
                status: 'invalid_request_source'
            };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const paymentResult =
                await client.query(
                    `
                    SELECT
                        mp.*,
                        mo.status AS market_order_status,
                        mo.total_amount AS market_order_total
                    FROM tbl_market_payments mp
                    JOIN tbl_market_orders mo
                      ON mo.id = mp.market_order_id
                    WHERE mp.id = $1
                    FOR UPDATE OF mp, mo
                    `,
                    [marketPaymentId]
                );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');
                return {
                    status: 'payment_not_found'
                };
            }

            const payment = paymentResult.rows[0];

            if (
                String(payment.payment_status)
                    .toUpperCase() !== 'PAID'
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'payment_not_paid',
                    current_status:
                        payment.payment_status
                };
            }

            const paymentAmount =
                Number(payment.amount);

            const refundAmount =
                amount === null ||
                amount === undefined
                    ? paymentAmount
                    : Number(amount);

            if (
                !Number.isFinite(refundAmount) ||
                refundAmount <= 0
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'refund_amount_invalid'
                };
            }

            if (
                type === 'FULL' &&
                refundAmount !== paymentAmount
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'full_refund_amount_mismatch'
                };
            }

            if (
                type === 'PARTIAL' &&
                refundAmount >= paymentAmount
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'partial_refund_amount_invalid'
                };
            }

            const totalResult =
                await client.query(
                    `
                    SELECT
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS committed_amount
                    FROM tbl_market_payment_refunds
                    WHERE market_payment_id = $1
                      AND status <> 'REJECTED'
                    `,
                    [payment.id]
                );

            const committedAmount =
                Number(
                    totalResult.rows[0]
                        .committed_amount
                );

            const remainingAmount =
                paymentAmount - committedAmount;

            if (refundAmount > remainingAmount) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'refund_amount_exceeds_remaining',
                    payment_amount:
                        paymentAmount,
                    committed_amount:
                        committedAmount,
                    remaining_amount:
                        remainingAmount
                };
            }

            if (
                type === 'FULL' &&
                committedAmount > 0
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'full_refund_conflicts_existing'
                };
            }

            const refundKey =
                MarketPaymentRefundService
                    .buildRefundKey();

            const inserted =
                await client.query(
                    `
                    INSERT INTO
                        tbl_market_payment_refunds
                    (
                        market_payment_id,
                        market_order_id,
                        amount,
                        status,
                        reason_code,
                        reason,
                        provider,
                        refund_key,
                        requested_by,
                        refund_type,
                        request_source,
                        customer_note,
                        reconciliation_data
                    )
                    VALUES (
                        $1, $2, $3,
                        'REQUESTED',
                        $4, $5, $6, $7,
                        $8, $9, $10, $11,
                        $12::jsonb
                    )
                    RETURNING *
                    `,
                    [
                        payment.id,
                        payment.market_order_id,
                        refundAmount,
                        String(reasonCode)
                            .trim()
                            .toUpperCase(),
                        String(reason).trim(),
                        payment.provider,
                        refundKey,
                        requestedBy,
                        type,
                        source,
                        customerNote
                            ? String(customerNote).trim()
                            : null,
                        reconciliationData
                            ? JSON.stringify(
                                reconciliationData
                            )
                            : null
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'success',
                refund: inserted.rows[0],
                payment,
                remaining_amount_after:
                    remainingAmount - refundAmount
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

    async startReview({
        refundId,
        adminUserId
    }) {
        if (!refundId || !adminUserId) {
            return { status: 'invalid_input' };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM tbl_market_payment_refunds
                WHERE id = $1
                FOR UPDATE
                `,
                [refundId]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'refund_not_found' };
            }

            const refund = result.rows[0];

            if (refund.status === 'UNDER_REVIEW') {
                await client.query('ROLLBACK');
                return {
                    status: 'already_under_review',
                    refund
                };
            }

            if (refund.status !== 'REQUESTED') {
                await client.query('ROLLBACK');
                return {
                    status: 'refund_not_reviewable',
                    current_status: refund.status
                };
            }

            const updated = await client.query(
                `
                UPDATE tbl_market_payment_refunds
                SET
                    status = 'UNDER_REVIEW',
                    reviewed_by = $2,
                    reviewed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'REQUESTED'
                RETURNING *
                `,
                [refundId, adminUserId]
            );

            await client.query('COMMIT');

            return {
                status: 'under_review',
                refund: updated.rows[0]
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

    async approveRefund({
        refundId,
        adminUserId,
        payoutMethod,
        payoutDestination,
        payoutAccountName,
        payoutDueAt = null
    }) {
        if (
            !refundId ||
            !adminUserId ||
            !String(payoutMethod || '').trim() ||
            !String(payoutDestination || '').trim() ||
            !String(payoutAccountName || '').trim()
        ) {
            return { status: 'invalid_input' };
        }

        const method =
            String(payoutMethod).trim().toUpperCase();

        if (
            !['BANK_TRANSFER', 'E_WALLET', 'OTHER']
                .includes(method)
        ) {
            return {
                status: 'invalid_payout_method'
            };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT
                    r.*,
                    mp.payment_status
                FROM tbl_market_payment_refunds r
                JOIN tbl_market_payments mp
                  ON mp.id = r.market_payment_id
                WHERE r.id = $1
                FOR UPDATE OF r, mp
                `,
                [refundId]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'refund_not_found' };
            }

            const refund = result.rows[0];

            if (refund.status === 'APPROVED') {
                await client.query('ROLLBACK');
                return {
                    status: 'already_approved',
                    refund
                };
            }

            if (refund.status !== 'UNDER_REVIEW') {
                await client.query('ROLLBACK');
                return {
                    status: 'refund_not_approvable',
                    current_status: refund.status
                };
            }

            if (
                String(refund.payment_status)
                    .toUpperCase() !== 'PAID'
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'payment_not_paid',
                    current_status:
                        refund.payment_status
                };
            }

            const updated = await client.query(
                `
                UPDATE tbl_market_payment_refunds
                SET
                    status = 'APPROVED',
                    approved_by = $2,
                    approved_at = CURRENT_TIMESTAMP,
                    payout_due_at = COALESCE(
                        $3::timestamptz,
                        CURRENT_TIMESTAMP +
                            INTERVAL '1 day'
                    ),
                    payout_method = $4,
                    payout_destination = $5,
                    payout_account_name = $6,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'UNDER_REVIEW'
                RETURNING *
                `,
                [
                    refundId,
                    adminUserId,
                    payoutDueAt,
                    method,
                    String(payoutDestination).trim(),
                    String(payoutAccountName).trim()
                ]
            );

            await client.query('COMMIT');

            return {
                status: 'approved',
                refund: updated.rows[0]
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

    async rejectRefund({
        refundId,
        adminUserId,
        rejectionReason
    }) {
        if (
            !refundId ||
            !adminUserId ||
            !String(rejectionReason || '').trim()
        ) {
            return { status: 'invalid_input' };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const updated = await client.query(
                `
                UPDATE tbl_market_payment_refunds
                SET
                    status = 'REJECTED',
                    rejected_by = $2,
                    rejected_at = CURRENT_TIMESTAMP,
                    rejection_reason = $3,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status IN (
                      'REQUESTED',
                      'UNDER_REVIEW'
                  )
                RETURNING *
                `,
                [
                    refundId,
                    adminUserId,
                    String(rejectionReason).trim()
                ]
            );

            if (!updated.rowCount) {
                const current = await client.query(
                    `
                    SELECT *
                    FROM tbl_market_payment_refunds
                    WHERE id = $1
                    `,
                    [refundId]
                );

                await client.query('ROLLBACK');

                if (!current.rowCount) {
                    return {
                        status: 'refund_not_found'
                    };
                }

                return {
                    status: 'refund_not_rejectable',
                    current_status:
                        current.rows[0].status
                };
            }

            await client.query('COMMIT');

            return {
                status: 'rejected',
                refund: updated.rows[0]
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

    async startPayout({
        refundId,
        adminUserId
    }) {
        if (!refundId || !adminUserId) {
            return { status: 'invalid_input' };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT
                    r.*,
                    mp.payment_status
                FROM tbl_market_payment_refunds r
                JOIN tbl_market_payments mp
                  ON mp.id = r.market_payment_id
                WHERE r.id = $1
                FOR UPDATE OF r, mp
                `,
                [refundId]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'refund_not_found' };
            }

            const refund = result.rows[0];

            if (
                !['APPROVED', 'FAILED']
                    .includes(refund.status)
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'refund_not_processable',
                    current_status: refund.status
                };
            }

            if (
                String(refund.payment_status)
                    .toUpperCase() !== 'PAID'
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'payment_not_paid',
                    current_status:
                        refund.payment_status
                };
            }

            if (
                !refund.payout_method ||
                !refund.payout_destination ||
                !refund.payout_account_name
            ) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'payout_destination_incomplete'
                };
            }

            const updated = await client.query(
                `
                UPDATE tbl_market_payment_refunds
                SET
                    status = 'PROCESSING',
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status IN (
                      'APPROVED',
                      'FAILED'
                  )
                RETURNING *
                `,
                [refundId]
            );

            await client.query('COMMIT');

            return {
                status: 'processing',
                refund: updated.rows[0]
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

    async failPayout({
        refundId,
        adminUserId,
        error
    }) {
        if (
            !refundId ||
            !adminUserId ||
            !String(error || '').trim()
        ) {
            return { status: 'invalid_input' };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const updated = await client.query(
                `
                UPDATE tbl_market_payment_refunds
                SET
                    status = 'FAILED',
                    processed_by = $2,
                    processed_at = CURRENT_TIMESTAMP,
                    last_error = $3,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'PROCESSING'
                RETURNING *
                `,
                [
                    refundId,
                    adminUserId,
                    String(error).trim()
                ]
            );

            if (!updated.rowCount) {
                await client.query('ROLLBACK');
                return {
                    status:
                        'refund_not_processing'
                };
            }

            await client.query('COMMIT');

            return {
                status: 'failed',
                refund: updated.rows[0]
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

    async completePayout({
        refundId,
        adminUserId,
        payoutReference,
        payoutProofUrl = null
    }) {
        if (
            !refundId ||
            !adminUserId ||
            !String(payoutReference || '').trim()
        ) {
            return { status: 'invalid_input' };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT
                    r.*,
                    mp.payment_status,
                    c.user_id AS customer_user_id
                FROM tbl_market_payment_refunds r
                JOIN tbl_market_payments mp
                  ON mp.id = r.market_payment_id
                JOIN tbl_market_orders mo
                  ON mo.id = r.market_order_id
                JOIN tbl_customers c
                  ON c.id = mo.customer_id
                WHERE r.id = $1
                FOR UPDATE OF r, mp
                `,
                [refundId]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                return { status: 'refund_not_found' };
            }

            const refund = result.rows[0];

            if (refund.status === 'COMPLETED') {
                await client.query('ROLLBACK');
                return {
                    status: 'completed',
                    already_completed: true,
                    refund
                };
            }

            if (refund.status !== 'PROCESSING') {
                await client.query('ROLLBACK');
                return {
                    status:
                        'refund_not_processing',
                    current_status:
                        refund.status
                };
            }

            if (
                String(refund.payment_status)
                    .toUpperCase() !== 'PAID'
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'payment_not_paid',
                    current_status:
                        refund.payment_status
                };
            }

            const updated = await client.query(
                `
                UPDATE tbl_market_payment_refunds
                SET
                    status = 'COMPLETED',
                    payout_reference = $2,
                    payout_proof_url = $3,
                    processed_by = $4,
                    processed_at = CURRENT_TIMESTAMP,
                    completed_at = CURRENT_TIMESTAMP,
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'PROCESSING'
                RETURNING *
                `,
                [
                    refundId,
                    String(payoutReference).trim(),
                    payoutProofUrl
                        ? String(payoutProofUrl).trim()
                        : null,
                    adminUserId
                ]
            );


            if (refund.customer_user_id) {
                await client.query(
                    `INSERT INTO tbl_notifications
                     (user_id, title, message, event_key)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (event_key)
                     WHERE event_key IS NOT NULL
                     DO NOTHING`,
                    [
                        refund.customer_user_id,
                        'Refund Pesanan Selesai',
                        `Refund pesanan marketplace sebesar Rp${refund.amount} sudah selesai diproses.`,
                        `MARKET_REFUND_COMPLETED:${refund.id}`
                    ]
                );
            }


            const financeRefundReference =
                `MARKET-REFUND-${refund.id}`;

            await client.query(
                `INSERT INTO tbl_general_ledger
                 (
                     transaction_reference,
                     account_code,
                     account_name,
                     debit,
                     credit,
                     description
                 )
                 VALUES
                 ($1, '4000', 'Pendapatan Penjualan', $2, 0, $3)
                 ON CONFLICT
                 (transaction_reference, account_code)
                 DO NOTHING`,
                [
                    financeRefundReference,
                    refund.amount,
                    `Pembalikan pendapatan refund marketplace ${refund.market_order_id}`
                ]
            );

            await client.query(
                `INSERT INTO tbl_general_ledger
                 (
                     transaction_reference,
                     account_code,
                     account_name,
                     debit,
                     credit,
                     description
                 )
                 VALUES
                 ($1, '1100', 'Kas & Bank', 0, $2, $3)
                 ON CONFLICT
                 (transaction_reference, account_code)
                 DO NOTHING`,
                [
                    financeRefundReference,
                    refund.amount,
                    `Kas keluar refund marketplace ${refund.market_order_id}`
                ]
            );

            await client.query('COMMIT');

            return {
                status: 'completed',
                refund: updated.rows[0]
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
    MarketPaymentRefundService;
