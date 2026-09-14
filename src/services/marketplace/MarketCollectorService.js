const OrderInventoryFulfillmentService =
    require('../orders/OrderInventoryFulfillmentService');
const OrderInventoryReservationService =
    require('../orders/OrderInventoryReservationService');
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
                        c.phone AS customer_phone,
                        mp.payment_method,
                        mp.provider AS payment_provider,
                        mp.payment_status
                    FROM tbl_collector_tasks t
                    JOIN tbl_market_orders mo
                      ON mo.id = t.market_order_id
                    LEFT JOIN tbl_customers c
                      ON c.id = mo.customer_id
                    LEFT JOIN LATERAL (
                        SELECT
                            p.payment_method,
                            p.provider,
                            p.payment_status
                        FROM tbl_market_payments p
                        WHERE p.market_order_id = mo.id
                        ORDER BY p.created_at DESC
                        LIMIT 1
                    ) mp ON TRUE
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

            const inventoryService =
                new OrderInventoryFulfillmentService(
                    client
                );
            const reservationService =
                new OrderInventoryReservationService(
                    client
                );

            await inventoryService
                .fulfillOrderSale({
                    orderId: order.id
                });

            const consumeResult =
                await reservationService
                    .consumeOrder({
                        orderId: order.id
                    });

            if (
                ![
                    'consumed',
                    'already_consumed'
                ].includes(
                    consumeResult.status
                )
            ) {
                throw new Error(
                    `Reservation consume gagal untuk ${order.id}: ${consumeResult.status}`
                );
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

    async ensureCodEntitlements(client, marketOrderId, codAmount) {
        const child = await client.query(`
            SELECT
                COUNT(*)::int AS count,
                COALESCE(SUM(total_amount),0) AS total,
                BOOL_AND(
                    merchant_id IS NOT NULL
                    AND status = 'DISPATCHED'
                ) AS valid
            FROM tbl_orders_v2
            WHERE market_order_id = $1
        `,[marketOrderId]);

        const c = child.rows[0];
        if (
            c.count < 1 ||
            !c.valid ||
            Number(c.total) !== codAmount
        ) {
            throw new Error(
                'Child order COD tidak valid untuk entitlement'
            );
        }

        await client.query(`
            INSERT INTO tbl_merchant_entitlements (
                merchant_id, order_id, market_order_id,
                gross_amount, platform_commission,
                merchant_entitlement, status, source_event
            )
            SELECT
                merchant_id, id, market_order_id,
                total_amount, 0, total_amount,
                'PENDING', 'COD_PAYMENT_COLLECTED'
            FROM tbl_orders_v2
            WHERE market_order_id = $1
            ON CONFLICT (order_id) DO NOTHING
        `,[marketOrderId]);

        const ent = await client.query(`
            SELECT
                COUNT(*)::int AS count,
                COALESCE(SUM(gross_amount),0) AS gross,
                COALESCE(SUM(platform_commission),0) AS commission,
                COALESCE(SUM(merchant_entitlement),0) AS net,
                BOOL_AND(
                    status = 'PENDING'
                    AND source_event = 'COD_PAYMENT_COLLECTED'
                ) AS valid
            FROM tbl_merchant_entitlements
            WHERE market_order_id = $1
        `,[marketOrderId]);

        const e = ent.rows[0];
        if (
            e.count !== c.count ||
            !e.valid ||
            Number(e.gross) !== codAmount ||
            Number(e.commission) !== 0 ||
            Number(e.net) !== codAmount
        ) {
            throw new Error(
                'Entitlement COD tidak sesuai child order'
            );
        }
    }

    async collectCodPayment({
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
                task.status !==
                    'OUT_FOR_DELIVERY' ||
                marketOrder.status !==
                    'OUT_FOR_DELIVERY'
            ) {
                const err = new Error(
                    'COD hanya dapat diterima saat pesanan sedang dikirim'
                );
                err.statusCode = 409;
                throw err;
            }

            const paymentResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_market_payments
                    WHERE market_order_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            if (!paymentResult.rowCount) {
                const err = new Error(
                    'Market payment tidak ditemukan'
                );
                err.statusCode = 409;
                throw err;
            }

            const payment =
                paymentResult.rows[0];

            if (
                String(
                    payment.payment_method ||
                    ''
                ).toUpperCase() !== 'COD' ||
                String(
                    payment.provider ||
                    ''
                ).toUpperCase() !== 'CASH'
            ) {
                const err = new Error(
                    'Market payment bukan COD CASH'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                payment.payment_status === 'PAID'
            ) {
                await client.query('COMMIT');

                return {
                    already_collected: true,
                    payment,
                    task,
                    market_order:
                        marketOrder
                };
            }

            if (
                payment.payment_status !==
                    'UNPAID'
            ) {
                const err = new Error(
                    `COD tidak dapat diterima dari status ${payment.payment_status}`
                );
                err.statusCode = 409;
                throw err;
            }

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_market_payments
                    SET
                        payment_status = 'PAID',
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
                            source:
                                'COURIER_COD_CASH',
                            collected_by_courier_id:
                                courier.id,
                            collected_by_user_id:
                                courierUserId,
                            collected_at:
                                new Date()
                                    .toISOString()
                        })
                    ]
                );

            if (
                updatedResult.rowCount !== 1
            ) {
                throw new Error(
                    'COD payment berubah secara bersamaan'
                );
            }

            const collectedPayment =
                updatedResult.rows[0];

            const codAmount =
                Number(
                    collectedPayment.amount
                );

            if (
                !Number.isFinite(codAmount) ||
                codAmount <= 0
            ) {
                throw new Error(
                    'Nominal COD tidak valid'
                );
            }

            const ledgerRef =
                `CODCOL-${collectedPayment.id}`;

            await client.query(
                `
                INSERT INTO tbl_general_ledger (
                    transaction_reference,
                    account_code,
                    account_name,
                    debit,
                    credit,
                    description
                )
                VALUES (
                    $1,
                    '1500',
                    'Dana COD di Tangan Kurir',
                    $2,
                    0,
                    $3
                )
                ON CONFLICT (
                    transaction_reference,
                    account_code
                )
                DO NOTHING
                `,
                [
                    ledgerRef,
                    codAmount,
                    `Dana COD diterima kurir ${ledgerRef}`
                ]
            );

            await client.query(
                `
                INSERT INTO tbl_general_ledger (
                    transaction_reference,
                    account_code,
                    account_name,
                    debit,
                    credit,
                    description
                )
                VALUES (
                    $1,
                    '2200',
                    'Kewajiban kepada Merchant',
                    0,
                    $2,
                    $3
                )
                ON CONFLICT (
                    transaction_reference,
                    account_code
                )
                DO NOTHING
                `,
                [
                    ledgerRef,
                    codAmount,
                    `Hak Merchant COD ${ledgerRef}`
                ]
            );

            await this.ensureCodEntitlements(
                client,
                marketOrder.id,
                codAmount
            );

            await client.query('COMMIT');

            return {
                already_collected: false,
                payment:
                    updatedResult.rows[0],
                task,
                market_order:
                    marketOrder
            };

        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            throw err;

        } finally {
            client.release();
        }
    }

    async markCodDeliveryFailed({
        taskId,
        courierUserId,
        reason
    }) {
        const cleanReason =
            String(reason || '').trim();

        if (!cleanReason) {
            const err = new Error(
                'Alasan gagal COD wajib diisi'
            );
            err.statusCode = 400;
            throw err;
        }

        if (cleanReason.length > 500) {
            const err = new Error(
                'Alasan gagal COD terlalu panjang'
            );
            err.statusCode = 400;
            throw err;
        }

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

            const paymentResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_market_payments
                    WHERE market_order_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            if (!paymentResult.rowCount) {
                const err = new Error(
                    'Market payment tidak ditemukan'
                );
                err.statusCode = 409;
                throw err;
            }

            const payment =
                paymentResult.rows[0];

            const isCodCash =
                String(
                    payment.payment_method || ''
                ).toUpperCase() === 'COD' &&
                String(
                    payment.provider || ''
                ).toUpperCase() === 'CASH';

            if (!isCodCash) {
                const err = new Error(
                    'Market payment bukan COD CASH'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                payment.payment_status !==
                    'UNPAID'
            ) {
                const err = new Error(
                    `COD gagal delivery hanya berlaku untuk payment UNPAID, status saat ini ${payment.payment_status}`
                );
                err.statusCode = 409;
                throw err;
            }

            const childResult =
                await client.query(
                    `
                    SELECT id, status
                    FROM tbl_orders_v2
                    WHERE market_order_id = $1
                    ORDER BY created_at, id
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            if (
                !childResult.rowCount ||
                childResult.rows.some(
                    row =>
                        row.status !==
                        'DISPATCHED'
                )
            ) {
                const err = new Error(
                    'Semua child order COD harus DISPATCHED'
                );
                err.statusCode = 409;
                throw err;
            }

            const stopResult =
                await client.query(
                    `
                    SELECT id, status, issue_reason
                    FROM tbl_collector_task_stops
                    WHERE collector_task_id = $1
                    ORDER BY sequence_no NULLS LAST, id
                    FOR UPDATE
                    `,
                    [task.id]
                );

            if (
                stopResult.rowCount !==
                    childResult.rowCount ||
                stopResult.rows.some(
                    row =>
                        row.status !==
                        'PICKED_UP'
                )
            ) {
                const err = new Error(
                    'Semua barang harus sudah PICKED_UP sebelum return COD'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                task.status === 'RETURNING' &&
                marketOrder.status ===
                    'RETURNING'
            ) {
                await client.query('COMMIT');

                return {
                    already_marked: true,
                    task,
                    market_order:
                        marketOrder,
                    payment,
                    reason:
                        cleanReason
                };
            }

            if (
                task.status !==
                    'OUT_FOR_DELIVERY' ||
                marketOrder.status !==
                    'OUT_FOR_DELIVERY'
            ) {
                const err = new Error(
                    'Pesanan harus OUT_FOR_DELIVERY untuk ditandai gagal COD'
                );
                err.statusCode = 409;
                throw err;
            }

            await client.query(
                `
                UPDATE tbl_collector_task_stops
                SET
                    issue_reason = $2,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE collector_task_id = $1
                  AND status = 'PICKED_UP'
                `,
                [
                    task.id,
                    `COD_DELIVERY_FAILED: ${cleanReason}`
                ]
            );

            const taskUpdate =
                await client.query(
                    `
                    UPDATE tbl_collector_tasks
                    SET
                        status = 'RETURNING',
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
                    'Collector task berubah secara bersamaan'
                );
            }

            const marketUpdate =
                await client.query(
                    `
                    UPDATE tbl_market_orders
                    SET
                        status = 'RETURNING',
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
                    'Market order berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_marked: false,
                task:
                    taskUpdate.rows[0],
                market_order:
                    marketUpdate.rows[0],
                payment,
                reason:
                    cleanReason
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

    async completeCodReturn({
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

            const paymentResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_market_payments
                    WHERE market_order_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            if (!paymentResult.rowCount) {
                const err = new Error(
                    'Market payment tidak ditemukan'
                );
                err.statusCode = 409;
                throw err;
            }

            const payment =
                paymentResult.rows[0];

            const isCodCash =
                String(
                    payment.payment_method || ''
                ).toUpperCase() === 'COD' &&
                String(
                    payment.provider || ''
                ).toUpperCase() === 'CASH';

            if (!isCodCash) {
                const err = new Error(
                    'Market payment bukan COD CASH'
                );
                err.statusCode = 409;
                throw err;
            }

            const childResult =
                await client.query(
                    `
                    SELECT id, status
                    FROM tbl_orders_v2
                    WHERE market_order_id = $1
                    ORDER BY created_at, id
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            if (!childResult.rowCount) {
                throw new Error(
                    'Child order market tidak ditemukan'
                );
            }

            const stopResult =
                await client.query(
                    `
                    SELECT id, order_id, status
                    FROM tbl_collector_task_stops
                    WHERE collector_task_id = $1
                    ORDER BY sequence_no NULLS LAST, id
                    FOR UPDATE
                    `,
                    [task.id]
                );

            if (
                stopResult.rowCount !==
                childResult.rowCount
            ) {
                throw new Error(
                    'Jumlah collector stop tidak sesuai child order'
                );
            }

            if (
                task.status === 'RETURNED' &&
                marketOrder.status === 'RETURNED'
            ) {
                const validReplay =
                    payment.payment_status ===
                        'CANCELLED' &&
                    childResult.rows.every(
                        row =>
                            row.status ===
                            'RETURNED'
                    ) &&
                    stopResult.rows.every(
                        row =>
                            row.status ===
                            'RETURNED'
                    );

                if (!validReplay) {
                    throw new Error(
                        'State return COD tidak konsisten'
                    );
                }

                await client.query('COMMIT');

                return {
                    already_completed: true,
                    task,
                    market_order:
                        marketOrder,
                    payment,
                    orders:
                        childResult.rows,
                    stops:
                        stopResult.rows
                };
            }

            if (
                task.status !== 'RETURNING' ||
                marketOrder.status !==
                    'RETURNING'
            ) {
                const err = new Error(
                    'Return COD harus berstatus RETURNING'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                payment.payment_status !==
                    'UNPAID'
            ) {
                const err = new Error(
                    `Return COD hanya boleh untuk payment UNPAID, status saat ini ${payment.payment_status}`
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                childResult.rows.some(
                    row =>
                        row.status !==
                        'DISPATCHED'
                )
            ) {
                const err = new Error(
                    'Semua child order COD harus DISPATCHED'
                );
                err.statusCode = 409;
                throw err;
            }

            if (
                stopResult.rows.some(
                    row =>
                        row.status !==
                        'PICKED_UP'
                )
            ) {
                const err = new Error(
                    'Semua collector stop harus PICKED_UP'
                );
                err.statusCode = 409;
                throw err;
            }

            const entitlementResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM tbl_merchant_entitlements
                    WHERE market_order_id = $1
                    `,
                    [marketOrder.id]
                );

            if (
                entitlementResult.rows[0].count !== 0
            ) {
                throw new Error(
                    'Return COD ditolak karena entitlement sudah tercatat'
                );
            }

            const codLedgerRef =
                `CODCOL-${payment.id}`;

            const ledgerResult =
                await client.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM tbl_general_ledger
                    WHERE transaction_reference = $1
                    `,
                    [codLedgerRef]
                );

            if (
                ledgerResult.rows[0].count !== 0
            ) {
                throw new Error(
                    'Return COD ditolak karena kas COD sudah tercatat'
                );
            }

            for (
                const order of childResult.rows
            ) {
                const itemResult =
                    await client.query(
                        `
                        SELECT
                            product_id,
                            SUM(quantity)::int AS quantity
                        FROM tbl_order_items
                        WHERE order_id = $1
                        GROUP BY product_id
                        ORDER BY product_id
                        `,
                        [order.id]
                    );

                if (!itemResult.rowCount) {
                    throw new Error(
                        `Item order tidak ditemukan untuk ${order.id}`
                    );
                }

                const saleRef =
                    `ORD-${order.id}`;

                const saleResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            product_id,
                            warehouse_id,
                            quantity
                        FROM tbl_inventory_movements
                        WHERE reference_doc = $1
                          AND movement_type = 'SALE'
                        ORDER BY product_id
                        FOR UPDATE
                        `,
                        [saleRef]
                    );

                if (
                    saleResult.rowCount !==
                    itemResult.rowCount
                ) {
                    throw new Error(
                        `SALE movement tidak lengkap untuk ${order.id}`
                    );
                }

                const expected =
                    new Map(
                        itemResult.rows.map(
                            row => [
                                String(
                                    row.product_id
                                ),
                                Number(
                                    row.quantity
                                )
                            ]
                        )
                    );

                for (
                    const sale of saleResult.rows
                ) {
                    const expectedQty =
                        expected.get(
                            String(
                                sale.product_id
                            )
                        );

                    const saleQty =
                        Number(
                            sale.quantity
                        );

                    if (
                        !expected.has(
                            String(
                                sale.product_id
                            )
                        ) ||
                        expectedQty !==
                            saleQty ||
                        saleQty <= 0 ||
                        !sale.warehouse_id
                    ) {
                        throw new Error(
                            `SALE movement tidak sesuai item order ${order.id}`
                        );
                    }

                    const inventoryResult =
                        await client.query(
                            `
                            SELECT *
                            FROM tbl_inventory
                            WHERE product_id = $1
                              AND warehouse_id = $2
                            FOR UPDATE
                            `,
                            [
                                sale.product_id,
                                sale.warehouse_id
                            ]
                        );

                    if (
                        inventoryResult.rowCount !==
                        1
                    ) {
                        throw new Error(
                            `Inventory asal SALE tidak ditemukan untuk ${order.id}`
                        );
                    }

                    const returnRef =
                        `CODRET-${order.id}`;

                    const movementResult =
                        await client.query(
                            `
                            INSERT INTO tbl_inventory_movements (
                                product_id,
                                warehouse_id,
                                movement_type,
                                quantity,
                                reference_doc,
                                created_by
                            )
                            VALUES (
                                $1,
                                $2,
                                'COD_RETURN',
                                $3,
                                $4,
                                $5
                            )
                            ON CONFLICT (
                                reference_doc,
                                product_id,
                                movement_type
                            )
                            WHERE movement_type =
                                'COD_RETURN'
                            DO NOTHING
                            RETURNING id
                            `,
                            [
                                sale.product_id,
                                sale.warehouse_id,
                                saleQty,
                                returnRef,
                                courierUserId
                            ]
                        );

                    if (
                        movementResult.rowCount === 1
                    ) {
                        const stockUpdate =
                            await client.query(
                                `
                                UPDATE tbl_inventory
                                SET
                                    quantity_on_hand =
                                        quantity_on_hand +
                                        $3,
                                    updated_at =
                                        CURRENT_TIMESTAMP
                                WHERE product_id = $1
                                  AND warehouse_id = $2
                                RETURNING *
                                `,
                                [
                                    sale.product_id,
                                    sale.warehouse_id,
                                    saleQty
                                ]
                            );

                        if (
                            stockUpdate.rowCount !==
                            1
                        ) {
                            throw new Error(
                                `Restore inventory gagal untuk ${order.id}`
                            );
                        }
                    }
                }
            }

            const childUpdate =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET
                        status = 'RETURNED'
                    WHERE market_order_id = $1
                      AND status = 'DISPATCHED'
                    RETURNING id, status
                    `,
                    [marketOrder.id]
                );

            if (
                childUpdate.rowCount !==
                childResult.rowCount
            ) {
                throw new Error(
                    'Update child order RETURNED tidak lengkap'
                );
            }

            const stopUpdate =
                await client.query(
                    `
                    UPDATE tbl_collector_task_stops
                    SET
                        status = 'RETURNED',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE collector_task_id = $1
                      AND status = 'PICKED_UP'
                    RETURNING id, order_id, status
                    `,
                    [task.id]
                );

            if (
                stopUpdate.rowCount !==
                stopResult.rowCount
            ) {
                throw new Error(
                    'Update collector stop RETURNED tidak lengkap'
                );
            }

            const paymentUpdate =
                await client.query(
                    `
                    UPDATE tbl_market_payments
                    SET
                        payment_status =
                            'CANCELLED',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND payment_status =
                            'UNPAID'
                    RETURNING *
                    `,
                    [payment.id]
                );

            if (
                paymentUpdate.rowCount !== 1
            ) {
                throw new Error(
                    'COD payment berubah secara bersamaan'
                );
            }

            const taskUpdate =
                await client.query(
                    `
                    UPDATE tbl_collector_tasks
                    SET
                        status = 'RETURNED',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'RETURNING'
                      AND courier_id = $2
                    RETURNING *
                    `,
                    [
                        task.id,
                        courier.id
                    ]
                );

            if (
                taskUpdate.rowCount !== 1
            ) {
                throw new Error(
                    'Collector task berubah secara bersamaan'
                );
            }

            const marketUpdate =
                await client.query(
                    `
                    UPDATE tbl_market_orders
                    SET
                        status = 'RETURNED',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'RETURNING'
                    RETURNING *
                    `,
                    [marketOrder.id]
                );

            if (
                marketUpdate.rowCount !== 1
            ) {
                throw new Error(
                    'Market order berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                already_completed: false,
                task:
                    taskUpdate.rows[0],
                market_order:
                    marketUpdate.rows[0],
                payment:
                    paymentUpdate.rows[0],
                orders:
                    childUpdate.rows,
                stops:
                    stopUpdate.rows
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

            const marketPaymentResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_market_payments
                    WHERE market_order_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [marketOrder.id]
                );

            if (!marketPaymentResult.rowCount) {
                const err = new Error(
                    'Market payment tidak ditemukan'
                );
                err.statusCode = 409;
                throw err;
            }

            const marketPayment =
                marketPaymentResult.rows[0];

            const isCodCash =
                String(
                    marketPayment.payment_method ||
                    ''
                ).toUpperCase() === 'COD' &&
                String(
                    marketPayment.provider ||
                    ''
                ).toUpperCase() === 'CASH';

            if (
                isCodCash &&
                marketPayment.payment_status !==
                    'PAID'
            ) {
                const err = new Error(
                    'Pembayaran COD harus diterima sebelum pesanan diselesaikan'
                );
                err.statusCode = 409;
                err.code =
                    'COD_PAYMENT_NOT_COLLECTED';
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
