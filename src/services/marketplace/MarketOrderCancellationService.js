const OrderInventoryReservationService =
    require(
        '../orders/OrderInventoryReservationService'
    );

class MarketOrderCancellationService {
    constructor(db) {
        this.db = db;
    }

    async cancelPendingMarketOrder({
        marketOrderId,
        reason = 'MARKET_ORDER_CANCELLED'
    }) {
        if (!marketOrderId) {
            throw new Error(
                'marketOrderId wajib untuk cancellation'
            );
        }

        const marketResult =
            await this.db.query(
                `
                SELECT
                    id,
                    status
                FROM tbl_market_orders
                WHERE id = $1
                FOR UPDATE
                `,
                [marketOrderId]
            );

        if (!marketResult.rowCount) {
            return {
                status: 'market_order_not_found'
            };
        }

        const marketOrder =
            marketResult.rows[0];

        if (
            marketOrder.status ===
            'CANCELLED'
        ) {
            return {
                status: 'already_cancelled'
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

        const childResult =
            await this.db.query(
                `
                SELECT
                    id,
                    status
                FROM tbl_orders_v2
                WHERE market_order_id = $1
                ORDER BY created_at ASC
                FOR UPDATE
                `,
                [marketOrderId]
            );

        if (!childResult.rowCount) {
            throw new Error(
                'Child market order tidak ditemukan'
            );
        }

        const invalidChild =
            childResult.rows.find(
                row =>
                    row.status !==
                    'PENDING'
            );

        if (invalidChild) {
            return {
                status:
                    'child_order_not_pending',
                child_order_id:
                    invalidChild.id,
                current_status:
                    invalidChild.status
            };
        }

        const reservationService =
            new OrderInventoryReservationService(
                this.db
            );

        for (
            const child of
            childResult.rows
        ) {
            const releaseResult =
                await reservationService
                    .releaseOrder({
                        orderId:
                            child.id,
                        reason
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
                    `Reservation release gagal untuk ${child.id}: ${releaseResult.status}`
                );
            }
        }

        await this.db.query(
            `
            UPDATE tbl_orders_v2
            SET status = 'CANCELLED'
            WHERE market_order_id = $1
              AND status = 'PENDING'
            `,
            [marketOrderId]
        );

        const childStates =
            await this.db.query(
                `
                SELECT
                    id,
                    status
                FROM tbl_orders_v2
                WHERE market_order_id = $1
                ORDER BY created_at ASC
                `,
                [marketOrderId]
            );

        if (
            childStates.rowCount !==
                childResult.rowCount ||
            childStates.rows.some(
                row =>
                    row.status !==
                    'CANCELLED'
            )
        ) {
            throw new Error(
                'Child market order belum seluruhnya CANCELLED'
            );
        }

        await this.db.query(
            `
            UPDATE tbl_collector_task_stops
            SET
                status = 'CANCELLED',
                issue_reason =
                    COALESCE(
                        issue_reason,
                        $2
                    ),
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE collector_task_id IN (
                SELECT id
                FROM tbl_collector_tasks
                WHERE market_order_id = $1
            )
              AND status = 'PENDING'
            `,
            [
                marketOrderId,
                reason
            ]
        );

        const stopStates =
            await this.db.query(
                `
                SELECT
                    s.id,
                    s.status
                FROM tbl_collector_task_stops s
                JOIN tbl_collector_tasks t
                  ON t.id =
                     s.collector_task_id
                WHERE t.market_order_id = $1
                `,
                [marketOrderId]
            );

        if (
            stopStates.rowCount !==
                childResult.rowCount ||
            stopStates.rows.some(
                row =>
                    row.status !==
                    'CANCELLED'
            )
        ) {
            throw new Error(
                'Collector stops belum seluruhnya CANCELLED'
            );
        }

        await this.db.query(
            `
            UPDATE tbl_collector_tasks
            SET
                status = 'CANCELLED',
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE market_order_id = $1
              AND status = 'PENDING'
            `,
            [marketOrderId]
        );

        const taskStates =
            await this.db.query(
                `
                SELECT
                    id,
                    status
                FROM tbl_collector_tasks
                WHERE market_order_id = $1
                `,
                [marketOrderId]
            );

        if (
            taskStates.rowCount !== 1 ||
            taskStates.rows[0].status !==
                'CANCELLED'
        ) {
            throw new Error(
                'Collector task belum CANCELLED'
            );
        }

        const cancelMarketResult =
            await this.db.query(
                `
                UPDATE tbl_market_orders
                SET
                    status = 'CANCELLED',
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'PENDING'
                RETURNING
                    id,
                    status
                `,
                [marketOrderId]
            );

        if (
            cancelMarketResult.rowCount !== 1
        ) {
            throw new Error(
                'Market order gagal CANCELLED'
            );
        }

        return {
            status: 'cancelled',

            market_order_id:
                marketOrderId,

            child_count:
                childResult.rowCount,

            collector_stop_count:
                stopStates.rowCount,

            reason
        };
    }
}

module.exports =
    MarketOrderCancellationService;
