class OrderInventoryFulfillmentService {
    constructor(db) {
        this.db = db;
    }

    /*
     * ========================================================
     * FULFILL ORDER SALE
     *
     * Caller mengontrol BEGIN / COMMIT / ROLLBACK.
     *
     * Contract:
     * - order harus ada
     * - order harus memiliki item
     * - seluruh product harus milik merchant order
     * - SALE movement idempotent berdasarkan:
     *   ORD-{orderId} + product_id + SALE
     * - inventory dikurangi dalam transaction caller
     * ========================================================
     */
    async fulfillOrderSale({
        orderId
    }) {
        if (!orderId) {
            throw new Error(
                'order_id wajib untuk fulfillment inventory'
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
                [
                    orderId
                ]
            );

        if (!orderResult.rowCount) {
            throw new Error(
                'Order tidak ditemukan untuk fulfillment inventory'
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
                [
                    order.id
                ]
            );

        if (!itemsResult.rowCount) {
            throw new Error(
                `Order ${order.id} tidak memiliki item`
            );
        }

        const referenceDoc =
            `ORD-${order.id}`;

        const movements = [];

        for (const item of itemsResult.rows) {
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
                Number(
                    item.quantity
                );

            if (
                !Number.isInteger(quantity) ||
                quantity <= 0
            ) {
                throw new Error(
                    `Quantity tidak valid untuk ${item.product_id}`
                );
            }

            /*
             * Replay / retry:
             * movement existing dianggap sudah fulfilled.
             */
            const existingResult =
                await this.db.query(
                    `
                    SELECT
                        id,
                        warehouse_id,
                        quantity
                    FROM tbl_inventory_movements
                    WHERE product_id = $1
                      AND movement_type = 'SALE'
                      AND reference_doc = $2
                    LIMIT 1
                    `,
                    [
                        item.product_id,
                        referenceDoc
                    ]
                );

            if (existingResult.rowCount) {
                const existing =
                    existingResult.rows[0];

                if (
                    Number(existing.quantity) !==
                    quantity
                ) {
                    throw new Error(
                        `SALE movement ${item.product_id} tidak konsisten dengan quantity order`
                    );
                }

                movements.push({
                    status:
                        'existing',
                    movement:
                        existing
                });

                continue;
            }

            /*
             * Pilih inventory yang mampu memenuhi seluruh
             * quantity item.
             *
             * Kontrak ini sama dengan warehouse subscriber V2
             * yang sedang berjalan saat ini.
             */
            const inventoryResult =
                await this.db.query(
                    `
                    SELECT
                        id,
                        warehouse_id,
                        product_id,
                        quantity_on_hand
                    FROM tbl_inventory
                    WHERE product_id = $1
                      AND COALESCE(
                            quantity_on_hand,
                            0
                          ) >= $2
                    ORDER BY
                        quantity_on_hand DESC,
                        id
                    FOR UPDATE
                    LIMIT 1
                    `,
                    [
                        item.product_id,
                        quantity
                    ]
                );

            if (!inventoryResult.rowCount) {
                throw new Error(
                    `Stok tidak mencukupi untuk ${item.product_id}`
                );
            }

            const inventory =
                inventoryResult.rows[0];

            const updateResult =
                await this.db.query(
                    `
                    UPDATE tbl_inventory
                    SET
                        quantity_on_hand =
                            quantity_on_hand - $1,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $2
                      AND quantity_on_hand >= $1
                    RETURNING
                        id,
                        warehouse_id,
                        product_id,
                        quantity_on_hand
                    `,
                    [
                        quantity,
                        inventory.id
                    ]
                );

            if (!updateResult.rowCount) {
                throw new Error(
                    `Gagal mengurangi stok ${item.product_id}`
                );
            }

            const movementResult =
                await this.db.query(
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
                        'SALE',
                        $3,
                        $4,
                        NULL
                    )
                    RETURNING
                        id,
                        product_id,
                        warehouse_id,
                        movement_type,
                        quantity,
                        reference_doc,
                        created_at
                    `,
                    [
                        item.product_id,
                        inventory.warehouse_id,
                        quantity,
                        referenceDoc
                    ]
                );

            movements.push({
                status:
                    'created',
                movement:
                    movementResult.rows[0],
                inventory:
                    updateResult.rows[0]
            });
        }

        return {
            order,
            reference_doc:
                referenceDoc,
            movements
        };
    }
}

module.exports =
    OrderInventoryFulfillmentService;
