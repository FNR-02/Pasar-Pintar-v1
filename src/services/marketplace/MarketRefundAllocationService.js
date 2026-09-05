class MarketRefundAllocationService {
    constructor(db) {
        this.db = db;
    }

    async validateAllocation({
        refundId,
        orderId,
        orderItemId = null,
        amount
    }) {
        if (!refundId || !orderId) {
            return { status: 'invalid_input' };
        }

        const allocationAmount = Number(amount);

        if (
            !Number.isFinite(allocationAmount) ||
            allocationAmount <= 0
        ) {
            return { status: 'invalid_amount' };
        }

        const result = await this.db.query(
            `
            SELECT
                r.id AS refund_id,
                r.market_order_id,
                r.amount AS refund_amount,
                r.status AS refund_status,

                o.id AS order_id,
                o.merchant_id,
                o.total_amount AS order_total,

                oi.id AS order_item_id,
                oi.quantity,
                oi.unit_price

            FROM tbl_market_payment_refunds r

            JOIN tbl_orders_v2 o
              ON o.id = $2
             AND o.market_order_id = r.market_order_id

            LEFT JOIN tbl_order_items oi
              ON oi.id = $3
             AND oi.order_id = o.id

            WHERE r.id = $1
            LIMIT 1
            `,
            [
                refundId,
                orderId,
                orderItemId
            ]
        );

        if (!result.rowCount) {
            return { status: 'allocation_target_invalid' };
        }

        const row = result.rows[0];

        if (orderItemId && !row.order_item_id) {
            return { status: 'order_item_invalid' };
        }

        const maximumAmount =
            orderItemId
                ? Number(row.quantity) *
                  Number(row.unit_price)
                : Number(row.order_total);

        if (allocationAmount > maximumAmount) {
            return {
                status: 'amount_exceeds_target',
                maximum_amount: maximumAmount
            };
        }

        return {
            status: 'valid',
            refund_id: row.refund_id,
            market_order_id: row.market_order_id,
            order_id: row.order_id,
            merchant_id: row.merchant_id,
            order_item_id:
                row.order_item_id || null,
            amount: allocationAmount,
            maximum_amount: maximumAmount,
            refund_amount:
                Number(row.refund_amount),
            refund_status:
                row.refund_status
        };
    }

    async recordAllocation(input) {
        const validation =
            await this.validateAllocation(input);

        if (validation.status !== 'valid') {
            return validation;
        }

        const paymentLock = await this.db.query(
            `
            SELECT mp.id
            FROM tbl_market_payments mp
            JOIN tbl_market_payment_refunds r
              ON r.market_payment_id = mp.id
            WHERE r.id = $1
            FOR UPDATE OF mp
            `,
            [validation.refund_id]
        );

        if (!paymentLock.rowCount) {
            return {
                status:
                    'refund_payment_not_found'
            };
        }


        const lockedRefund = await this.db.query(
            `
            SELECT id, amount, status
            FROM tbl_market_payment_refunds
            WHERE id = $1
            FOR UPDATE
            `,
            [validation.refund_id]
        );

        if (!lockedRefund.rowCount) {
            return { status: 'refund_not_found' };
        }

        const allocated = await this.db.query(
            `
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM tbl_market_refund_allocations
            WHERE refund_id = $1
            `,
            [validation.refund_id]
        );

        const refundStatus =
            String(
                lockedRefund.rows[0].status || ''
            ).toUpperCase();

        if (
            !['REQUESTED', 'UNDER_REVIEW']
                .includes(refundStatus)
        ) {
            return {
                status: 'refund_allocation_locked',
                refund_status: refundStatus
            };
        }

        const refundAmount =
            Number(lockedRefund.rows[0].amount);

        const allocatedAmount =
            Number(allocated.rows[0].total);

        if (
            allocatedAmount + validation.amount >
            refundAmount
        ) {
            return {
                status: 'refund_amount_exceeded',
                refund_amount: refundAmount,
                allocated_amount: allocatedAmount,
                requested_amount: validation.amount
            };
        }

        if (validation.order_item_id) {
            const priorResult =
                await this.db.query(
                    `
                    SELECT
                        COALESCE(
                            SUM(a.amount),
                            0
                        ) AS refunded_amount
                    FROM tbl_market_refund_allocations a
                    JOIN tbl_market_payment_refunds r
                      ON r.id = a.refund_id
                    WHERE a.order_item_id = $1
                      AND a.refund_id <> $2
                      AND r.status <> 'REJECTED'
                    `,
                    [
                        validation.order_item_id,
                        validation.refund_id
                    ]
                );

            const priorRefundedAmount =
                Number(
                    priorResult.rows[0]
                        .refunded_amount
                );

            if (
                priorRefundedAmount +
                    validation.amount >
                validation.maximum_amount
            ) {
                return {
                    status:
                        'target_refund_capacity_exceeded',
                    maximum_amount:
                        validation.maximum_amount,
                    previously_refunded_amount:
                        priorRefundedAmount,
                    requested_amount:
                        validation.amount,
                    remaining_target_amount:
                        Math.max(
                            0,
                            validation.maximum_amount -
                                priorRefundedAmount
                        )
                };
            }
        }


        if (validation.order_item_id) {
            const childCapacityResult =
                await this.db.query(
                    `
                    SELECT
                        o.total_amount AS order_total,
                        COALESCE(
                            SUM(a.amount) FILTER (
                                WHERE
                                    a.refund_id <> $2
                                    AND r.status <> 'REJECTED'
                            ),
                            0
                        ) AS previously_refunded_amount
                    FROM tbl_orders_v2 o
                    LEFT JOIN
                        tbl_market_refund_allocations a
                      ON a.order_id = o.id
                    LEFT JOIN
                        tbl_market_payment_refunds r
                      ON r.id = a.refund_id
                    WHERE o.id = $1
                    GROUP BY o.id, o.total_amount
                    `,
                    [
                        validation.order_id,
                        validation.refund_id
                    ]
                );

            if (!childCapacityResult.rowCount) {
                return {
                    status:
                        'allocation_target_invalid'
                };
            }

            const childMaximumAmount =
                Number(
                    childCapacityResult.rows[0]
                        .order_total
                );

            const childPreviouslyRefunded =
                Number(
                    childCapacityResult.rows[0]
                        .previously_refunded_amount
                );

            if (
                childPreviouslyRefunded +
                    validation.amount >
                childMaximumAmount
            ) {
                return {
                    status:
                        'item_child_capacity_exceeded',
                    maximum_amount:
                        childMaximumAmount,
                    previously_refunded_amount:
                        childPreviouslyRefunded,
                    requested_amount:
                        validation.amount,
                    remaining_target_amount:
                        Math.max(
                            0,
                            childMaximumAmount -
                                childPreviouslyRefunded
                        )
                };
            }
        }


        if (!validation.order_item_id) {
            const priorResult =
                await this.db.query(
                    `
                    SELECT
                        COALESCE(
                            SUM(a.amount),
                            0
                        ) AS refunded_amount
                    FROM tbl_market_refund_allocations a
                    JOIN tbl_market_payment_refunds r
                      ON r.id = a.refund_id
                    WHERE a.order_id = $1
                      AND a.refund_id <> $2
                      AND r.status <> 'REJECTED'
                    `,
                    [
                        validation.order_id,
                        validation.refund_id
                    ]
                );

            const priorRefundedAmount =
                Number(
                    priorResult.rows[0]
                        .refunded_amount
                );

            if (
                priorRefundedAmount +
                    validation.amount >
                validation.maximum_amount
            ) {
                return {
                    status:
                        'child_refund_capacity_exceeded',
                    maximum_amount:
                        validation.maximum_amount,
                    previously_refunded_amount:
                        priorRefundedAmount,
                    requested_amount:
                        validation.amount,
                    remaining_target_amount:
                        Math.max(
                            0,
                            validation.maximum_amount -
                                priorRefundedAmount
                        )
                };
            }
        }


        const granularityResult =
            await this.db.query(
                `
                SELECT
                    COUNT(*) FILTER (
                        WHERE order_item_id IS NULL
                    ) AS child_level_count,
                    COUNT(*) FILTER (
                        WHERE order_item_id IS NOT NULL
                    ) AS item_level_count
                FROM tbl_market_refund_allocations
                WHERE refund_id = $1
                  AND order_id = $2
                `,
                [
                    validation.refund_id,
                    validation.order_id
                ]
            );

        const childLevelCount =
            Number(
                granularityResult.rows[0]
                    .child_level_count
            );

        const itemLevelCount =
            Number(
                granularityResult.rows[0]
                    .item_level_count
            );

        if (
            validation.order_item_id &&
            childLevelCount > 0
        ) {
            return {
                status:
                    'mixed_allocation_granularity'
            };
        }

        if (
            !validation.order_item_id &&
            itemLevelCount > 0
        ) {
            return {
                status:
                    'mixed_allocation_granularity'
            };
        }

        const inserted = await this.db.query(
            `
            INSERT INTO tbl_market_refund_allocations (
                refund_id,
                order_id,
                merchant_id,
                order_item_id,
                amount
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING *
            `,
            [
                validation.refund_id,
                validation.order_id,
                validation.merchant_id,
                validation.order_item_id,
                validation.amount
            ]
        );

        if (!inserted.rowCount) {
            return {
                status: 'duplicate_allocation',
                refund_id:
                    validation.refund_id,
                order_id:
                    validation.order_id,
                order_item_id:
                    validation.order_item_id
            };
        }

        return {
            status: 'created',
            allocation: inserted.rows[0],
            refund_amount: refundAmount,
            allocated_amount:
                allocatedAmount + validation.amount
        };
    }
}

module.exports = MarketRefundAllocationService;
