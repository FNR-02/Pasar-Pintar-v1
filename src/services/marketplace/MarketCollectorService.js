class MarketCollectorService {
    constructor(db) {
        this.db = db;
    }

    async getActiveCourierByUserId(client, userId) {
        const result = await client.query(
            `
            SELECT
                c.*
            FROM tbl_couriers c
            JOIN tbl_users u
              ON u.id = c.user_id
            WHERE c.user_id = $1
              AND c.status = 'ACTIVE'
              AND u.is_active = TRUE
            LIMIT 1
            FOR UPDATE OF c
            `,
            [userId]
        );

        if (result.rowCount !== 1) {
            const err = new Error(
                'Profil Courier ACTIVE tidak ditemukan'
            );
            err.statusCode = 403;
            throw err;
        }

        return result.rows[0];
    }

    async getTaskForUpdate(client, taskId) {
        const result = await client.query(
            `
            SELECT *
            FROM tbl_collector_tasks
            WHERE id = $1
            FOR UPDATE
            `,
            [taskId]
        );

        if (result.rowCount !== 1) {
            const err = new Error(
                'Collector task tidak ditemukan'
            );
            err.statusCode = 404;
            throw err;
        }

        return result.rows[0];
    }

    assertTaskOwnership(task, courierId) {
        if (
            task.courier_id &&
            task.courier_id !== courierId
        ) {
            const err = new Error(
                'Collector task bukan milik Courier ini'
            );
            err.statusCode = 403;
            throw err;
        }
    }

    async assignTask({
        taskId,
        courierUserId
    }) {
        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const courier =
                await this.getActiveCourierByUserId(
                    client,
                    courierUserId
                );

            const task =
                await this.getTaskForUpdate(
                    client,
                    taskId
                );

            if (
                task.status === 'ASSIGNED' &&
                task.courier_id === courier.id
            ) {
                await client.query('COMMIT');

                return {
                    already_assigned: true,
                    task
                };
            }

            if (
                task.status !== 'PENDING'
            ) {
                const err = new Error(
                    'Collector task harus berstatus PENDING'
                );
                err.statusCode = 409;
                throw err;
            }

            if (task.courier_id) {
                const err = new Error(
                    'Collector task sudah memiliki Courier'
                );
                err.statusCode = 409;
                throw err;
            }

            const result =
                await client.query(
                    `
                    UPDATE tbl_collector_tasks
                    SET
                        courier_id = $2,
                        status = 'ASSIGNED',
                        assigned_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'PENDING'
                      AND courier_id IS NULL
                    RETURNING *
                    `,
                    [
                        task.id,
                        courier.id
                    ]
                );

            if (result.rowCount !== 1) {
                throw new Error(
                    'Collector task berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_assigned: false,
                task: result.rows[0]
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

    async startCollection({
        taskId,
        courierUserId
    }) {
        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const courier =
                await this.getActiveCourierByUserId(
                    client,
                    courierUserId
                );

            const task =
                await this.getTaskForUpdate(
                    client,
                    taskId
                );

            this.assertTaskOwnership(
                task,
                courier.id
            );

            if (
                task.status === 'COLLECTING'
            ) {
                await client.query('COMMIT');

                return {
                    already_started: true,
                    task
                };
            }

            if (
                task.status !== 'ASSIGNED'
            ) {
                const err = new Error(
                    'Collector task harus berstatus ASSIGNED'
                );
                err.statusCode = 409;
                throw err;
            }

            const result =
                await client.query(
                    `
                    UPDATE tbl_collector_tasks
                    SET
                        status = 'COLLECTING',
                        collection_started_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'ASSIGNED'
                      AND courier_id = $2
                    RETURNING *
                    `,
                    [
                        task.id,
                        courier.id
                    ]
                );

            if (result.rowCount !== 1) {
                throw new Error(
                    'Collector task berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_started: false,
                task: result.rows[0]
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

    async getStopForUpdate(client, stopId) {
        const result = await client.query(
            `
            SELECT
                s.*,
                t.market_order_id,
                t.courier_id,
                t.status AS task_status
            FROM tbl_collector_task_stops s
            JOIN tbl_collector_tasks t
              ON t.id = s.collector_task_id
            WHERE s.id = $1
            FOR UPDATE OF s, t
            `,
            [stopId]
        );

        if (result.rowCount !== 1) {
            const err = new Error(
                'Collector stop tidak ditemukan'
            );
            err.statusCode = 404;
            throw err;
        }

        return result.rows[0];
    }

    async arriveAtStop({
        stopId,
        courierUserId
    }) {
        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const courier =
                await this.getActiveCourierByUserId(
                    client,
                    courierUserId
                );

            const stop =
                await this.getStopForUpdate(
                    client,
                    stopId
                );

            if (
                !stop.courier_id ||
                stop.courier_id !== courier.id
            ) {
                const err = new Error(
                    'Collector stop bukan milik Courier ini'
                );
                err.statusCode = 403;
                throw err;
            }

            if (
                stop.task_status !== 'COLLECTING'
            ) {
                const err = new Error(
                    'Collector task harus berstatus COLLECTING'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                stop.status === 'ARRIVED'
            ) {
                await client.query('COMMIT');

                return {
                    already_arrived: true,
                    stop
                };
            }

            if (
                stop.status !== 'READY'
            ) {
                const err = new Error(
                    'Collector stop harus berstatus READY'
                );
                err.statusCode = 409;
                throw err;
            }

            const result =
                await client.query(
                    `
                    UPDATE tbl_collector_task_stops
                    SET
                        status = 'ARRIVED',
                        arrived_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'READY'
                    RETURNING *
                    `,
                    [stop.id]
                );

            if (result.rowCount !== 1) {
                throw new Error(
                    'Collector stop berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_arrived: false,
                stop: result.rows[0]
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

    async pickupStop({
        stopId,
        courierUserId
    }) {
        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const courier =
                await this.getActiveCourierByUserId(
                    client,
                    courierUserId
                );

            const stop =
                await this.getStopForUpdate(
                    client,
                    stopId
                );

            if (
                !stop.courier_id ||
                stop.courier_id !== courier.id
            ) {
                const err = new Error(
                    'Collector stop bukan milik Courier ini'
                );
                err.statusCode = 403;
                throw err;
            }

            if (
                stop.task_status !== 'COLLECTING'
            ) {
                const err = new Error(
                    'Collector task harus berstatus COLLECTING'
                );
                err.statusCode = 409;
                throw err;
            }

            const orderResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [stop.order_id]
                );

            if (
                orderResult.rowCount !== 1
            ) {
                const err = new Error(
                    'Child order marketplace tidak ditemukan'
                );
                err.statusCode = 404;
                throw err;
            }

            const order =
                orderResult.rows[0];

            if (
                order.market_order_id !==
                stop.market_order_id
            ) {
                throw new Error(
                    'Collector stop dan market order tidak konsisten'
                );
            }

            if (
                String(
                    order.fulfillment_type ||
                    'DELIVERY'
                ).toUpperCase() !== 'DELIVERY'
            ) {
                const err = new Error(
                    'Collector hanya dapat mengambil order DELIVERY'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                stop.status === 'PICKED_UP' &&
                order.status === 'DISPATCHED'
            ) {
                await client.query('COMMIT');

                return {
                    already_picked_up: true,
                    stop,
                    order
                };
            }

            if (
                stop.status !== 'ARRIVED'
            ) {
                const err = new Error(
                    'Collector stop harus berstatus ARRIVED'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                order.status !== 'PACKING'
            ) {
                const err = new Error(
                    'Child order marketplace harus berstatus PACKING'
                );
                err.statusCode = 409;
                throw err;
            }

            const shipmentResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_shipments
                    WHERE order_id = $1
                    `,
                    [order.id]
                );

            if (
                Number(
                    shipmentResult.rows[0].total
                ) !== 0
            ) {
                const err = new Error(
                    'Child order marketplace tidak boleh memiliki shipment'
                );
                err.statusCode = 409;
                throw err;
            }

            const updatedOrderResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'DISPATCHED'
                    WHERE id = $1
                      AND status = 'PACKING'
                    RETURNING *
                    `,
                    [order.id]
                );

            if (
                updatedOrderResult.rowCount !== 1
            ) {
                throw new Error(
                    'Child order berubah secara bersamaan'
                );
            }

            const updatedStopResult =
                await client.query(
                    `
                    UPDATE tbl_collector_task_stops
                    SET
                        status = 'PICKED_UP',
                        picked_up_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'ARRIVED'
                    RETURNING *
                    `,
                    [stop.id]
                );

            if (
                updatedStopResult.rowCount !== 1
            ) {
                throw new Error(
                    'Collector stop berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_picked_up: false,
                stop:
                    updatedStopResult.rows[0],
                order:
                    updatedOrderResult.rows[0]
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
    MarketCollectorService;
