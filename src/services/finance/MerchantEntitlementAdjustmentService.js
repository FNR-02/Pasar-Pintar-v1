class MerchantEntitlementAdjustmentService {
    constructor(db) {
        this.db = db;
    }

    async recordRefundCompleted({
        refundAllocationId
    }) {
        if (!refundAllocationId) {
            return {
                status: 'invalid_input'
            };
        }

        /*
         * Lock entitlement terlebih dahulu.
         *
         * Allocation menjadi sumber kebenaran:
         * - merchant
         * - child order
         * - refund
         * - nominal adjustment
         */
        const source = await this.db.query(
            `
            SELECT
                a.id AS refund_allocation_id,
                a.refund_id,
                a.order_id,
                a.merchant_id,
                a.amount,
                o.market_order_id,
                r.status AS refund_status,
                e.id AS entitlement_id,
                e.merchant_entitlement,
                e.status AS entitlement_status
            FROM tbl_market_refund_allocations a
            JOIN tbl_market_payment_refunds r
              ON r.id = a.refund_id
            JOIN tbl_orders_v2 o
              ON o.id = a.order_id
            JOIN tbl_merchant_entitlements e
              ON e.order_id = a.order_id
             AND e.merchant_id = a.merchant_id
            WHERE a.id = $1
            FOR UPDATE OF e
            `,
            [refundAllocationId]
        );

        if (!source.rowCount) {
            return {
                status:
                    'refund_allocation_entitlement_not_found'
            };
        }

        const row = source.rows[0];

        /*
         * Adjustment hanya boleh lahir dari refund
         * yang benar-benar COMPLETED.
         */
        if (row.refund_status !== 'COMPLETED') {
            return {
                status: 'refund_not_completed',
                current_status:
                    row.refund_status
            };
        }

        /*
         * Defense in depth:
         * child order harus benar-benar marketplace.
         */
        if (!row.market_order_id) {
            return {
                status:
                    'market_order_not_found'
            };
        }

        /*
         * Refund hanya boleh mengurangi hak merchant
         * yang belum dibayarkan.
         *
         * SETTLED berarti uang sudah diterima merchant.
         * V1 belum memiliki merchant clawback /
         * receivable, sehingga harus fail-closed.
         */
        if (
            ![
                'PENDING',
                'AVAILABLE'
            ].includes(
                row.entitlement_status
            )
        ) {
            return {
                status:
                    'entitlement_not_adjustable',
                entitlement_status:
                    row.entitlement_status
            };
        }


        /*
         * Idempotency:
         * satu refund allocation hanya boleh
         * menghasilkan satu adjustment.
         */
        const existing = await this.db.query(
            `
            SELECT *
            FROM tbl_merchant_entitlement_adjustments
            WHERE refund_allocation_id = $1
            `,
            [refundAllocationId]
        );

        if (existing.rowCount) {
            return {
                status: 'already_exists',
                adjustment:
                    existing.rows[0]
            };
        }

        /*
         * Hitung semua adjustment yang sudah
         * mengurangi entitlement ini.
         *
         * Entitlement sudah di-lock sehingga
         * transaksi paralel untuk entitlement
         * yang sama akan terserialisasi.
         */
        const adjusted = await this.db.query(
            `
            SELECT
                COALESCE(
                    SUM(amount),
                    0
                ) AS adjusted_amount
            FROM tbl_merchant_entitlement_adjustments
            WHERE entitlement_id = $1
            `,
            [row.entitlement_id]
        );

        const entitlementAmount =
            Number(row.merchant_entitlement);

        const adjustedAmount =
            Number(
                adjusted.rows[0]
                    .adjusted_amount
            );

        const adjustmentAmount =
            Number(row.amount);

        const remainingAmount =
            entitlementAmount -
            adjustedAmount;

        if (
            !Number.isFinite(adjustmentAmount) ||
            adjustmentAmount <= 0
        ) {
            return {
                status:
                    'invalid_adjustment_amount'
            };
        }

        if (
            adjustmentAmount >
            remainingAmount
        ) {
            return {
                status:
                    'entitlement_adjustment_exceeds_remaining',
                entitlement_amount:
                    entitlementAmount,
                adjusted_amount:
                    adjustedAmount,
                adjustment_amount:
                    adjustmentAmount,
                remaining_amount:
                    remainingAmount
            };
        }

        const inserted = await this.db.query(
            `
            INSERT INTO
                tbl_merchant_entitlement_adjustments
            (
                entitlement_id,
                merchant_id,
                order_id,
                market_order_id,
                refund_id,
                refund_allocation_id,
                adjustment_type,
                amount
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                'REFUND_COMPLETED',
                $7
            )
            ON CONFLICT (
                refund_allocation_id
            )
            DO NOTHING
            RETURNING *
            `,
            [
                row.entitlement_id,
                row.merchant_id,
                row.order_id,
                row.market_order_id,
                row.refund_id,
                row.refund_allocation_id,
                adjustmentAmount
            ]
        );

        if (!inserted.rowCount) {
            const duplicate =
                await this.db.query(
                    `
                    SELECT *
                    FROM
                        tbl_merchant_entitlement_adjustments
                    WHERE refund_allocation_id = $1
                    `,
                    [refundAllocationId]
                );

            return {
                status: 'already_exists',
                adjustment:
                    duplicate.rows[0] || null
            };
        }

        return {
            status: 'created',
            adjustment:
                inserted.rows[0],
            entitlement_amount:
                entitlementAmount,
            adjusted_before:
                adjustedAmount,
            adjusted_after:
                adjustedAmount +
                adjustmentAmount,
            remaining_after:
                remainingAmount -
                adjustmentAmount
        };
    }
}

module.exports =
    MerchantEntitlementAdjustmentService;
