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


    async listTasksForCourier(courierUserId) {
        const client =
            await this.db.connect();

        try {
            const courierResult =
                await client.query(
                    `
                    SELECT c.*
                    FROM tbl_couriers c
                    JOIN tbl_users u
                      ON u.id = c.user_id
                    WHERE c.user_id = $1
                      AND c.status = 'ACTIVE'
                      AND u.is_active = TRUE
                    LIMIT 1
                    `,
                    [courierUserId]
                );

            if (courierResult.rowCount !== 1) {
                const err = new Error(
                    'Profil Courier ACTIVE tidak ditemukan'
                );
                err.statusCode = 403;
                throw err;
            }

            const courier =
                courierResult.rows[0];

            const taskResult =
                await client.query(
                    `
                    SELECT
                        t.*,
                        mo.status AS market_order_status,
                        mo.fulfillment_type,
                        mo.shipping_address,
                        mo.total_amount,
                        mo.created_at AS market_order_created_at,
                        c.full_name AS customer_name,
                        c.phone AS customer_phone
                    FROM tbl_collector_tasks t
                    JOIN tbl_market_orders mo
                      ON mo.id = t.market_order_id
                    LEFT JOIN tbl_customers c
                      ON c.id = mo.customer_id
                    WHERE
                        (
                            t.status = 'PENDING'
                            AND t.courier_id IS NULL
                            AND mo.status = 'COLLECTING'
                            AND EXISTS (
                                SELECT 1
                                FROM tbl_collector_task_stops sr
                                WHERE sr.collector_task_id = t.id
                            )
                            AND NOT EXISTS (
                                SELECT 1
                                FROM tbl_collector_task_stops sr
                                WHERE sr.collector_task_id = t.id
                                  AND sr.status <> 'READY'
                            )
                        )
                        OR t.courier_id = $1
                    ORDER BY
                        CASE
                            WHEN t.courier_id = $1 THEN 0
                            ELSE 1
                        END,
                        t.created_at DESC
                    `,
                    [courier.id]
                );

            const tasks =
                taskResult.rows;

            if (!tasks.length) {
                return {
                    courier,
                    tasks: []
                };
            }

            const taskIds =
                tasks.map(task => task.id);

            const stopResult =
                await client.query(
                    `
                    SELECT
                        s.*,
                        o.merchant_id,
                        o.status AS order_status,
                        o.total_amount AS order_total_amount,
                        o.fulfillment_type AS order_fulfillment_type,
                        m.store_name,
                        m.address AS merchant_address,
                        m.phone AS merchant_phone
                    FROM tbl_collector_task_stops s
                    JOIN tbl_orders_v2 o
                      ON o.id = s.order_id
                    JOIN tbl_merchants m
                      ON m.id = o.merchant_id
                    WHERE s.collector_task_id =
                          ANY($1::uuid[])
                    ORDER BY
                        s.collector_task_id,
                        s.sequence_no NULLS LAST,
                        s.created_at
                    `,
                    [taskIds]
                );

            const stopsByTask =
                new Map();

            for (const stop of stopResult.rows) {
                const key =
                    String(stop.collector_task_id);

                if (!stopsByTask.has(key)) {
                    stopsByTask.set(key, []);
                }

                stopsByTask.get(key).push(stop);
            }

            return {
                courier,
                tasks: tasks.map(task => {
                    const stops =
                        stopsByTask.get(
                            String(task.id)
                        ) || [];
                    const isMine =
                        task.courier_id === courier.id;
                    const isAvailable =
                        task.status === 'PENDING' &&
                        !task.courier_id &&
                        task.market_order_status ===
                            'COLLECTING' &&
                        stops.length > 0 &&
                        stops.every(
                            stop =>
                                stop.status === 'READY'
                        );
                    return {
                        ...task,
                        customer_name:
                            isMine
                                ? task.customer_name
                                : null,
                        customer_phone:
                            isMine
                                ? task.customer_phone
                                : null,
                        shipping_address:
                            isMine
                                ? task.shipping_address
                                : null,
                        is_available:
                            isAvailable,
                        is_mine:
                            isMine,
                        stops
                    };
                })
            };
        } finally {
            client.release();
        }
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

            const marketOrderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status
                    FROM tbl_market_orders
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [
                        task.market_order_id
                    ]
                );

            if (marketOrderResult.rowCount !== 1) {
                const err = new Error(
                    'Market order Collector tidak ditemukan'
                );
                err.statusCode = 409;
                throw err;
            }

            const stopReadinessResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status
                    FROM tbl_collector_task_stops
                    WHERE collector_task_id = $1
                    ORDER BY id
                    FOR UPDATE
                    `,
                    [
                        task.id
                    ]
                );

            const allStopsReady =
                stopReadinessResult.rowCount > 0 &&
                stopReadinessResult.rows.every(
                    stop =>
                        stop.status === 'READY'
                );

            if (
                marketOrderResult.rows[0].status !==
                    'COLLECTING' ||
                !allStopsReady
            ) {
                const err = new Error(
                    'Semua merchant harus siap sebelum tugas dapat diambil'
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

            const remainingStopsResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_collector_task_stops
                    WHERE collector_task_id = $1
                      AND status <> 'PICKED_UP'
                    `,
                    [stop.collector_task_id]
                );

            const remainingStops =
                Number(
                    remainingStopsResult
                        .rows[0]
                        .total
                );

            let collectionCompleted = false;
            let completedTask = null;
            let marketOrder = null;

            if (remainingStops === 0) {
                const taskResult =
                    await client.query(
                        `
                        UPDATE tbl_collector_tasks
                        SET
                            status = 'COLLECTED',
                            collection_completed_at =
                                CURRENT_TIMESTAMP,
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE id = $1
                          AND status = 'COLLECTING'
                          AND courier_id = $2
                        RETURNING *
                        `,
                        [
                            stop.collector_task_id,
                            courier.id
                        ]
                    );

                if (taskResult.rowCount !== 1) {
                    throw new Error(
                        'Collector task gagal diselesaikan'
                    );
                }

                const marketOrderResult =
                    await client.query(
                        `
                        UPDATE tbl_market_orders
                        SET
                            status =
                                'READY_FOR_DELIVERY',
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE id = $1
                          AND status = 'COLLECTING'
                        RETURNING *
                        `,
                        [stop.market_order_id]
                    );

                if (
                    marketOrderResult.rowCount !== 1
                ) {
                    throw new Error(
                        'Market order gagal menjadi READY_FOR_DELIVERY'
                    );
                }

                collectionCompleted = true;
                completedTask =
                    taskResult.rows[0];
                marketOrder =
                    marketOrderResult.rows[0];
            }

            await client.query('COMMIT');

            return {
                already_picked_up: false,
                stop:
                    updatedStopResult.rows[0],
                order:
                    updatedOrderResult.rows[0],
                collection_completed:
                    collectionCompleted,
                task:
                    completedTask,
                market_order:
                    marketOrder
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



    async startDelivery({
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

            const marketResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_market_orders
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [task.market_order_id]
                );

            if (marketResult.rowCount !== 1) {
                const err = new Error(
                    'Market order tidak ditemukan'
                );
                err.statusCode = 404;
                throw err;
            }

            const marketOrder =
                marketResult.rows[0];

            if (
                task.status === 'OUT_FOR_DELIVERY' &&
                marketOrder.status ===
                    'OUT_FOR_DELIVERY'
            ) {
                await client.query('COMMIT');

                return {
                    already_started: true,
                    task,
                    market_order:
                        marketOrder
                };
            }

            if (task.status !== 'COLLECTED') {
                const err = new Error(
                    'Collector task harus berstatus COLLECTED'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                marketOrder.status !==
                    'READY_FOR_DELIVERY'
            ) {
                const err = new Error(
                    'Market order harus berstatus READY_FOR_DELIVERY'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                marketOrder.fulfillment_type !==
                    'DELIVERY'
            ) {
                const err = new Error(
                    'Combined delivery hanya untuk DELIVERY'
                );
                err.statusCode = 409;
                throw err;
            }

            const stopResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_collector_task_stops
                    WHERE collector_task_id = $1
                      AND status <> 'PICKED_UP'
                    `,
                    [task.id]
                );

            if (
                Number(
                    stopResult.rows[0].total
                ) !== 0
            ) {
                const err = new Error(
                    'Semua collector stop harus PICKED_UP'
                );
                err.statusCode = 409;
                throw err;
            }

            const childResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_orders_v2
                    WHERE market_order_id = $1
                      AND status <> 'DISPATCHED'
                    `,
                    [marketOrder.id]
                );

            if (
                Number(
                    childResult.rows[0].total
                ) !== 0
            ) {
                const err = new Error(
                    'Semua child order harus DISPATCHED'
                );
                err.statusCode = 409;
                throw err;
            }

            const taskUpdate =
                await client.query(
                    `
                    UPDATE tbl_collector_tasks
                    SET
                        status = 'OUT_FOR_DELIVERY',
                        delivery_started_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'COLLECTED'
                      AND courier_id = $2
                    RETURNING *
                    `,
                    [
                        task.id,
                        courier.id
                    ]
                );

            if (taskUpdate.rowCount !== 1) {
                throw new Error(
                    'Collector task berubah secara bersamaan'
                );
            }

            const marketUpdate =
                await client.query(
                    `
                    UPDATE tbl_market_orders
                    SET
                        status = 'OUT_FOR_DELIVERY',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status =
                            'READY_FOR_DELIVERY'
                    RETURNING *
                    `,
                    [marketOrder.id]
                );

            if (marketUpdate.rowCount !== 1) {
                throw new Error(
                    'Market order berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_started: false,
                task:
                    taskUpdate.rows[0],
                market_order:
                    marketUpdate.rows[0]
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

    async completeDelivery({
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

            const marketResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_market_orders
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [task.market_order_id]
                );

            if (marketResult.rowCount !== 1) {
                const err = new Error(
                    'Market order tidak ditemukan'
                );
                err.statusCode = 404;
                throw err;
            }

            const marketOrder =
                marketResult.rows[0];

            const childResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_orders_v2
                    WHERE market_order_id = $1
                    ORDER BY created_at, id
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            const childOrders =
                childResult.rows;

            if (
                task.status === 'COMPLETED' &&
                marketOrder.status ===
                    'DELIVERED' &&
                childOrders.length > 0 &&
                childOrders.every(
                    order =>
                        order.status === 'DELIVERED'
                )
            ) {
                await client.query('COMMIT');

                return {
                    already_completed: true,
                    task,
                    market_order:
                        marketOrder,
                    orders:
                        childOrders
                };
            }

            if (
                task.status !==
                    'OUT_FOR_DELIVERY'
            ) {
                const err = new Error(
                    'Collector task harus berstatus OUT_FOR_DELIVERY'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                marketOrder.status !==
                    'OUT_FOR_DELIVERY'
            ) {
                const err = new Error(
                    'Market order harus berstatus OUT_FOR_DELIVERY'
                );
                err.statusCode = 409;
                throw err;
            }

            if (childOrders.length === 0) {
                const err = new Error(
                    'Child order marketplace tidak ditemukan'
                );
                err.statusCode = 409;
                throw err;
            }

            const invalidChild =
                childOrders.find(
                    order =>
                        order.status !==
                            'DISPATCHED'
                );

            if (invalidChild) {
                const err = new Error(
                    'Semua child order harus DISPATCHED'
                );
                err.statusCode = 409;
                throw err;
            }

            const shipmentResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM tbl_shipments s
                    JOIN tbl_orders_v2 o
                      ON o.id = s.order_id
                    WHERE o.market_order_id = $1
                    `,
                    [marketOrder.id]
                );

            if (
                Number(
                    shipmentResult.rows[0].total
                ) !== 0
            ) {
                const err = new Error(
                    'Combined delivery tidak boleh memiliki child shipment'
                );
                err.statusCode = 409;
                throw err;
            }

            const ordersUpdate =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'DELIVERED'
                    WHERE market_order_id = $1
                      AND status = 'DISPATCHED'
                    RETURNING *
                    `,
                    [marketOrder.id]
                );

            if (
                ordersUpdate.rowCount !==
                    childOrders.length
            ) {
                throw new Error(
                    'Child order berubah secara bersamaan'
                );
            }

            const taskUpdate =
                await client.query(
                    `
                    UPDATE tbl_collector_tasks
                    SET
                        status = 'COMPLETED',
                        completed_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status =
                            'OUT_FOR_DELIVERY'
                      AND courier_id = $2
                    RETURNING *
                    `,
                    [
                        task.id,
                        courier.id
                    ]
                );

            if (taskUpdate.rowCount !== 1) {
                throw new Error(
                    'Collector task gagal diselesaikan'
                );
            }

            const marketUpdate =
                await client.query(
                    `
                    UPDATE tbl_market_orders
                    SET
                        status = 'DELIVERED',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status =
                            'OUT_FOR_DELIVERY'
                    RETURNING *
                    `,
                    [marketOrder.id]
                );

            if (marketUpdate.rowCount !== 1) {
                throw new Error(
                    'Market order gagal diselesaikan'
                );
            }

            await client.query('COMMIT');

            return {
                already_completed: false,
                task:
                    taskUpdate.rows[0],
                market_order:
                    marketUpdate.rows[0],
                orders:
                    ordersUpdate.rows
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
