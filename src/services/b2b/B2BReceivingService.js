class B2BReceivingService {
    constructor(pool) {
        this.pool = pool;
    }

    fail(status, message, extra = {}) {
        const err = new Error(message);
        err.httpStatus = status;
        Object.assign(err, extra);
        throw err;
    }

    async receive({
        orderId,
        userId
    }) {
        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const buyerResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name
                    FROM tbl_merchants
                    WHERE user_id = $1
                      AND status = 'ACTIVE'
                    LIMIT 1
                    `,
                    [userId]
                );

            if (!buyerResult.rowCount) {
                this.fail(
                    403,
                    'Merchant pembeli aktif tidak ditemukan'
                );
            }

            const buyer =
                buyerResult.rows[0];

            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        seller_merchant_id,
                        buyer_merchant_id,
                        source_warehouse_id,
                        destination_warehouse_id,
                        status,
                        payment_mode,
                        total_amount,
                        received_at
                    FROM tbl_b2b_orders
                    WHERE id = $1
                      AND buyer_merchant_id = $2
                    FOR UPDATE
                    `,
                    [
                        orderId,
                        buyer.id
                    ]
                );

            if (!orderResult.rowCount) {
                this.fail(
                    404,
                    'PO B2B tidak ditemukan'
                );
            }

            const order =
                orderResult.rows[0];

            if (order.status === 'RECEIVED') {
                await client.query('COMMIT');

                return {
                    already_received: true,
                    order: {
                        id: order.id,
                        status: order.status,
                        total_amount:
                            order.total_amount,
                        received_at:
                            order.received_at
                    }
                };
            }

            if (order.status !== 'APPROVED') {
                this.fail(
                    409,
                    `PO dengan status ${order.status} tidak dapat diterima`
                );
            }

            if (order.payment_mode !== 'CASH') {
                this.fail(
                    409,
                    'B2B V1 hanya mendukung CASH'
                );
            }

            const sourceWarehouseResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_warehouses
                    WHERE id = $1
                      AND merchant_id = $2
                      AND warehouse_type =
                            'MERCHANT_STORE'
                    LIMIT 1
                    `,
                    [
                        order.source_warehouse_id,
                        order.seller_merchant_id
                    ]
                );

            if (!sourceWarehouseResult.rowCount) {
                this.fail(
                    409,
                    'Warehouse sumber B2B tidak valid'
                );
            }

            const destinationWarehouseResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_warehouses
                    WHERE id = $1
                      AND merchant_id = $2
                      AND warehouse_type =
                            'MERCHANT_STORE'
                    LIMIT 1
                    `,
                    [
                        order.destination_warehouse_id,
                        buyer.id
                    ]
                );

            if (
                !destinationWarehouseResult.rowCount
            ) {
                this.fail(
                    409,
                    'Warehouse tujuan B2B tidak valid'
                );
            }

            const itemsResult =
                await client.query(
                    `
                    SELECT
                        id,
                        source_product_id,
                        buyer_product_id,
                        quantity
                    FROM tbl_b2b_order_items
                    WHERE b2b_order_id = $1
                    ORDER BY created_at ASC
                    `,
                    [order.id]
                );

            if (!itemsResult.rowCount) {
                this.fail(
                    409,
                    'PO B2B tidak memiliki item'
                );
            }

            const receivedItems = [];

            for (
                const item
                of itemsResult.rows
            ) {
                const qty =
                    Number(item.quantity);

                const productResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            category_id,
                            sku,
                            name,
                            description,
                            selling_unit,
                            image_url,
                            pack_size_value,
                            pack_size_unit,
                            variant_label
                        FROM tbl_products
                        WHERE id = $1
                          AND merchant_id = $2
                          AND status = 'ACTIVE'
                        LIMIT 1
                        `,
                        [
                            item.source_product_id,
                            order.seller_merchant_id
                        ]
                    );

                if (!productResult.rowCount) {
                    this.fail(
                        409,
                        'Produk sumber B2B tidak valid'
                    );
                }

                const sourceProduct =
                    productResult.rows[0];

                const sourceInventoryResult =
                    await client.query(
                        `
                        SELECT
                            quantity_on_hand
                        FROM tbl_inventory
                        WHERE warehouse_id = $1
                          AND product_id = $2
                        FOR UPDATE
                        `,
                        [
                            order.source_warehouse_id,
                            sourceProduct.id
                        ]
                    );

                if (
                    !sourceInventoryResult.rowCount
                ) {
                    this.fail(
                        409,
                        `Stok sumber ${sourceProduct.name} tidak ditemukan`
                    );
                }

                const sourceStock =
                    Number(
                        sourceInventoryResult
                            .rows[0]
                            .quantity_on_hand
                    );

                if (sourceStock < qty) {
                    this.fail(
                        409,
                        `Stok ${sourceProduct.name} tidak mencukupi`,
                        {
                            available_stock:
                                sourceStock
                        }
                    );
                }

                /*
                 * Serialisasi mapping produk untuk
                 * buyer + source product yang sama.
                 */
                await client.query(
                    `
                    SELECT pg_advisory_xact_lock(
                        hashtext($1)
                    )
                    `,
                    [
                        `${buyer.id}:${sourceProduct.id}`
                    ]
                );

                const linkResult =
                    await client.query(
                        `
                        SELECT
                            buyer_product_id
                        FROM tbl_b2b_product_links
                        WHERE buyer_merchant_id = $1
                          AND seller_merchant_id = $2
                          AND source_product_id = $3
                        LIMIT 1
                        `,
                        [
                            buyer.id,
                            order.seller_merchant_id,
                            sourceProduct.id
                        ]
                    );

                let buyerProductId;

                if (linkResult.rowCount) {
                    buyerProductId =
                        linkResult.rows[0]
                            .buyer_product_id;
                } else {
                    const compact =
                        sourceProduct.id
                            .replaceAll('-', '')
                            .slice(0, 16)
                            .toUpperCase();

                    const buyerSku =
                        `B2B-${compact}`;

                    const buyerProductResult =
                        await client.query(
                            `
                            INSERT INTO tbl_products (
                                id,
                                merchant_id,
                                category_id,
                                sku,
                                name,
                                description,
                                status,
                                selling_unit,
                                image_url,
                                pack_size_value,
                                pack_size_unit,
                                parent_product_id,
                                variant_label,
                                customer_visible
                            )
                            VALUES (
                                gen_random_uuid(),
                                $1,
                                $2,
                                $3,
                                $4,
                                $5,
                                'ACTIVE',
                                $6,
                                $7,
                                $8,
                                $9,
                                NULL,
                                $10,
                                FALSE
                            )
                            RETURNING id
                            `,
                            [
                                buyer.id,
                                sourceProduct.category_id,
                                buyerSku,
                                sourceProduct.name,
                                sourceProduct.description,
                                sourceProduct.selling_unit,
                                sourceProduct.image_url,
                                sourceProduct.pack_size_value,
                                sourceProduct.pack_size_unit,
                                sourceProduct.variant_label
                            ]
                        );

                    buyerProductId =
                        buyerProductResult
                            .rows[0]
                            .id;

                    await client.query(
                        `
                        INSERT INTO tbl_b2b_product_links (
                            seller_merchant_id,
                            buyer_merchant_id,
                            source_product_id,
                            buyer_product_id
                        )
                        VALUES ($1,$2,$3,$4)
                        `,
                        [
                            order.seller_merchant_id,
                            buyer.id,
                            sourceProduct.id,
                            buyerProductId
                        ]
                    );
                }

                const sourceUpdate =
                    await client.query(
                        `
                        UPDATE tbl_inventory
                        SET
                            quantity_on_hand =
                                quantity_on_hand - $3,
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE warehouse_id = $1
                          AND product_id = $2
                          AND quantity_on_hand >= $3
                        RETURNING
                            quantity_on_hand
                        `,
                        [
                            order.source_warehouse_id,
                            sourceProduct.id,
                            qty
                        ]
                    );

                if (sourceUpdate.rowCount !== 1) {
                    throw new Error(
                        'B2B source stock update gagal'
                    );
                }

                const destinationUpdate =
                    await client.query(
                        `
                        INSERT INTO tbl_inventory (
                            id,
                            warehouse_id,
                            product_id,
                            quantity_on_hand,
                            updated_at
                        )
                        VALUES (
                            gen_random_uuid(),
                            $1,
                            $2,
                            $3,
                            CURRENT_TIMESTAMP
                        )
                        ON CONFLICT (
                            warehouse_id,
                            product_id
                        )
                        DO UPDATE SET
                            quantity_on_hand =
                                tbl_inventory.quantity_on_hand
                                + EXCLUDED.quantity_on_hand,
                            updated_at =
                                CURRENT_TIMESTAMP
                        RETURNING
                            quantity_on_hand
                        `,
                        [
                            order.destination_warehouse_id,
                            buyerProductId,
                            qty
                        ]
                    );

                const referenceDoc =
                    `B2B-${order.id}`;

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
                    VALUES
                        ($1,$2,'B2B_OUT',$3,$4,$5),
                        ($6,$7,'B2B_IN',$3,$4,$5)
                    `,
                    [
                        sourceProduct.id,
                        order.source_warehouse_id,
                        qty,
                        referenceDoc,
                        userId,
                        buyerProductId,
                        order.destination_warehouse_id
                    ]
                );

                await client.query(
                    `
                    UPDATE tbl_b2b_order_items
                    SET buyer_product_id = $2
                    WHERE id = $1
                    `,
                    [
                        item.id,
                        buyerProductId
                    ]
                );

                receivedItems.push({
                    source_product_id:
                        sourceProduct.id,
                    buyer_product_id:
                        buyerProductId,
                    name:
                        sourceProduct.name,
                    quantity:
                        qty,
                    source_stock_after:
                        Number(
                            sourceUpdate
                                .rows[0]
                                .quantity_on_hand
                        ),
                    destination_stock_after:
                        Number(
                            destinationUpdate
                                .rows[0]
                                .quantity_on_hand
                        )
                });
            }

            const receiveResult =
                await client.query(
                    `
                    UPDATE tbl_b2b_orders
                    SET
                        status = 'RECEIVED',
                        received_at =
                            CURRENT_TIMESTAMP,
                        received_by = $2,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'APPROVED'
                    RETURNING
                        id,
                        status,
                        total_amount,
                        received_at
                    `,
                    [
                        order.id,
                        userId
                    ]
                );

            if (receiveResult.rowCount !== 1) {
                throw new Error(
                    'B2B receive transition gagal'
                );
            }

            await client.query('COMMIT');

            return {
                already_received: false,
                order: {
                    ...receiveResult.rows[0],
                    buyer_store_name:
                        buyer.store_name,
                    items:
                        receivedItems
                }
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
}

module.exports = B2BReceivingService;
