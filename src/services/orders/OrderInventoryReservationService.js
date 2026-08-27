class OrderInventoryReservationService {
    constructor(db) {
        this.db = db;
    }

    /*
     * =========================================================
     * RESERVE ORDER INVENTORY
     *
     * Caller mengontrol BEGIN / COMMIT / ROLLBACK.
     *
     * Kontrak:
     * - Order harus sudah ada.
     * - Order items menjadi canonical demand.
     * - quantity_on_hand TIDAK dikurangi.
     * - Active RESERVED order lain dikurangi dari available.
     * - Inventory row dipilih dan di-lock FOR UPDATE.
     * - Idempotent per order_id + product_id.
     * =========================================================
     */
    async reserveOrder({
        orderId,
        expiresAt = null
    }) {
        if (!orderId) {
            throw new Error(
                'orderId wajib untuk reservation inventory'
            );
        }

        const orderResult =
            await this.db.query(
                `
                SELECT
                    id,
                    merchant_id,
                    status,
                    payment_mode
                FROM tbl_orders_v2
                WHERE id = $1
                FOR UPDATE
                `,
                [orderId]
            );

        if (!orderResult.rowCount) {
            throw new Error(
                'Order tidak ditemukan untuk reservation inventory'
            );
        }

        const order =
            orderResult.rows[0];

        const itemsResult =
            await this.db.query(
                `
                SELECT
                    oi.product_id,
                    SUM(oi.quantity)::int AS quantity,
                    p.merchant_id AS product_merchant_id
                FROM tbl_order_items oi
                JOIN tbl_products p
                    ON p.id = oi.product_id
                WHERE oi.order_id = $1
                GROUP BY
                    oi.product_id,
                    p.merchant_id
                ORDER BY oi.product_id
                `,
                [order.id]
            );

        if (!itemsResult.rowCount) {
            throw new Error(
                `Order ${order.id} tidak memiliki item`
            );
        }

        const reservations = [];

        for (
            const item of
            itemsResult.rows
        ) {
            if (
                String(
                    item.product_merchant_id
                ) !==
                String(
                    order.merchant_id
                )
            ) {
                throw new Error(
                    `Produk ${item.product_id} bukan milik Merchant order`
                );
            }

            const quantity =
                Number(item.quantity);

            if (
                !Number.isInteger(quantity) ||
                quantity <= 0
            ) {
                throw new Error(
                    `Quantity reservation tidak valid untuk ${item.product_id}`
                );
            }

            /*
             * Idempotency.
             */
            const existingResult =
                await this.db.query(
                    `
                    SELECT *
                    FROM tbl_inventory_reservations
                    WHERE order_id = $1
                      AND product_id = $2
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        order.id,
                        item.product_id
                    ]
                );

            if (existingResult.rowCount) {
                const existing =
                    existingResult.rows[0];

                if (
                    Number(
                        existing.quantity
                    ) !== quantity
                ) {
                    throw new Error(
                        `Reservation ${item.product_id} tidak konsisten dengan quantity order`
                    );
                }

                if (
                    existing.status ===
                        'RESERVED' ||
                    existing.status ===
                        'CONSUMED'
                ) {
                    reservations.push({
                        status:
                            'existing',
                        reservation:
                            existing
                    });

                    continue;
                }

                throw new Error(
                    `Reservation ${item.product_id} sudah berstatus ${existing.status}`
                );
            }

            /*
             * =====================================================
             * CONCURRENT RESERVATION LOCK
             *
             * Lock inventory row Product lebih dulu.
             * Setelah lock didapat, hitung RESERVED aktif.
             * =====================================================
             */
            const inventoryResult =
                await this.db.query(
                    `
                    SELECT
                        id,
                        warehouse_id,
                        product_id,
                        COALESCE(
                            quantity_on_hand,
                            0
                        )::int AS quantity_on_hand
                    FROM tbl_inventory
                    WHERE product_id = $1
                    ORDER BY
                        quantity_on_hand DESC,
                        id
                    FOR UPDATE
                    `,
                    [
                        item.product_id
                    ]
                );

            if (!inventoryResult.rowCount) {
                throw new Error(
                    `Inventory tidak tersedia untuk ${item.product_id}`
                );
            }

            const reservedResult =
                await this.db.query(
                    `
                    SELECT
                        warehouse_id,
                        COALESCE(
                            SUM(quantity),
                            0
                        )::int AS reserved_quantity
                    FROM tbl_inventory_reservations
                    WHERE product_id = $1
                      AND status = 'RESERVED'
                      AND (
                            expires_at IS NULL
                            OR expires_at >
                                CURRENT_TIMESTAMP
                      )
                    GROUP BY warehouse_id
                    `,
                    [
                        item.product_id
                    ]
                );

            const reservedByWarehouse =
                new Map(
                    reservedResult.rows.map(
                        row => [
                            String(
                                row.warehouse_id
                            ),
                            Number(
                                row.reserved_quantity ||
                                0
                            )
                        ]
                    )
                );

            let selectedInventory =
                null;

            for (
                const inventory of
                inventoryResult.rows
            ) {
                const reservedQuantity =
                    reservedByWarehouse.get(
                        String(
                            inventory.warehouse_id
                        )
                    ) || 0;

                const available =
                    Number(
                        inventory.quantity_on_hand
                    ) -
                    reservedQuantity;

                if (available >= quantity) {
                    selectedInventory = {
                        ...inventory,
                        reserved_quantity:
                            reservedQuantity,
                        available
                    };

                    break;
                }
            }

            if (!selectedInventory) {
                throw new Error(
                    `Stok tersedia tidak mencukupi untuk ${item.product_id}`
                );
            }

            const reservationResult =
                await this.db.query(
                    `
                    INSERT INTO
                    tbl_inventory_reservations (
                        order_id,
                        product_id,
                        warehouse_id,
                        quantity,
                        status,
                        expires_at
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        'RESERVED',
                        $5
                    )
                    RETURNING *
                    `,
                    [
                        order.id,
                        item.product_id,
                        selectedInventory
                            .warehouse_id,
                        quantity,
                        expiresAt
                    ]
                );

            reservations.push({
                status:
                    'created',
                available_before:
                    selectedInventory
                        .available,
                reservation:
                    reservationResult
                        .rows[0]
            });
        }

        return {
            order,
            reservations
        };
    }

    /*
     * =========================================================
     * CONSUME ORDER RESERVATIONS
     *
     * Dipanggil setelah inventory SALE berhasil.
     * Tidak mengurangi quantity_on_hand.
     * Hanya mengubah RESERVED -> CONSUMED.
     * Retry aman.
     * =========================================================
     */
    async consumeOrder({
        orderId
    }) {
        if (!orderId) {
            throw new Error(
                'orderId wajib untuk consume reservation'
            );
        }

        const result =
            await this.db.query(
                `
                UPDATE
                    tbl_inventory_reservations
                SET
                    status =
                        'CONSUMED',
                    consumed_at =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE
                    order_id = $1
                    AND status =
                        'RESERVED'
                RETURNING *
                `,
                [orderId]
            );

        if (result.rowCount) {
            return {
                status:
                    'consumed',
                reservations:
                    result.rows
            };
        }

        const existing =
            await this.db.query(
                `
                SELECT *
                FROM
                    tbl_inventory_reservations
                WHERE
                    order_id = $1
                ORDER BY
                    product_id
                `,
                [orderId]
            );

        if (
            existing.rowCount &&
            existing.rows.every(
                row =>
                    row.status ===
                    'CONSUMED'
            )
        ) {
            return {
                status:
                    'already_consumed',
                reservations:
                    existing.rows
            };
        }

        return {
            status:
                'nothing_to_consume',
            reservations:
                existing.rows
        };
    }

    /*
     * =========================================================
     * RELEASE ORDER RESERVATIONS
     *
     * Tidak mengubah quantity_on_hand karena reservation
     * belum pernah mengurangi stok fisik.
     * =========================================================
     */
    async releaseOrder({
        orderId,
        reason = 'ORDER_RELEASED'
    }) {
        if (!orderId) {
            throw new Error(
                'orderId wajib untuk release reservation'
            );
        }

        const result =
            await this.db.query(
                `
                UPDATE
                    tbl_inventory_reservations
                SET
                    status =
                        'RELEASED',
                    released_at =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE
                    order_id = $1
                    AND status =
                        'RESERVED'
                RETURNING *
                `,
                [orderId]
            );

        return {
            status:
                result.rowCount
                    ? 'released'
                    : 'nothing_to_release',
            reason,
            reservations:
                result.rows
        };
    }

    /*
     * =========================================================
     * EXPIRE ORDER RESERVATIONS
     * =========================================================
     */
    async expireOrder({
        orderId
    }) {
        if (!orderId) {
            throw new Error(
                'orderId wajib untuk expire reservation'
            );
        }

        const result =
            await this.db.query(
                `
                UPDATE
                    tbl_inventory_reservations
                SET
                    status =
                        'EXPIRED',
                    released_at =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE
                    order_id = $1
                    AND status =
                        'RESERVED'
                RETURNING *
                `,
                [orderId]
            );

        return {
            status:
                result.rowCount
                    ? 'expired'
                    : 'nothing_to_expire',
            reservations:
                result.rows
        };
    }
}

module.exports =
    OrderInventoryReservationService;
