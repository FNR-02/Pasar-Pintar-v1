class WhatsAppCartStore {
    constructor(pool) {
        this.pool = pool;
    }

    normalizeOperationIndex(value) {
        const parsed = Number(value);

        return (
            Number.isInteger(parsed) &&
            parsed >= 0
        ) ? parsed : null;
    }

    async claimOperation({
        db,
        cartId,
        customerId,
        sourceMessageId,
        operationIndex,
        operationType
    }) {
        const index =
            this.normalizeOperationIndex(
                operationIndex
            );

        if (
            !sourceMessageId ||
            index === null
        ) {
            return {
                enabled: false,
                claimed: true,
                operationId: null,
                conflict: false
            };
        }

        const inserted = await db.query(
            `
            INSERT INTO tbl_whatsapp_cart_operations (
                cart_id,
                customer_id,
                source_message_id,
                operation_index,
                operation_type,
                status
            )
            VALUES ($1,$2,$3,$4,$5,'CLAIMED')
            ON CONFLICT (
                customer_id,
                source_message_id,
                operation_index
            )
            DO NOTHING
            RETURNING id
            `,
            [
                cartId,
                customerId,
                sourceMessageId,
                index,
                operationType
            ]
        );

        if (inserted.rowCount === 1) {
            return {
                enabled: true,
                claimed: true,
                operationId:
                    inserted.rows[0].id,
                conflict: false
            };
        }

        const existing =
            await db.query(
                `
                SELECT
                    id,
                    operation_type,
                    status
                FROM tbl_whatsapp_cart_operations
                WHERE customer_id = $1
                  AND source_message_id = $2
                  AND operation_index = $3
                LIMIT 1
                `,
                [
                    customerId,
                    sourceMessageId,
                    index
                ]
            );

        const row =
            existing.rows[0] || null;

        if (!row) {
            return {
                enabled: true,
                claimed: false,
                operationId: null,
                conflict: true,
                existingOperationType: null,
                requestedOperationType:
                    operationType,
                existingStatus: null
            };
        }

        if (
            row.operation_type !==
            operationType
        ) {
            return {
                enabled: true,
                claimed: false,
                operationId: row.id,
                conflict: true,
                existingOperationType:
                    row.operation_type,
                requestedOperationType:
                    operationType,
                existingStatus:
                    row.status
            };
        }

        return {
            enabled: true,
            claimed: false,
            operationId: row.id,
            conflict: false,
            existingOperationType:
                row.operation_type,
            requestedOperationType:
                operationType,
            existingStatus:
                row.status
        };
    }

    async completeOperation({
        db,
        operationId
    }) {
        if (!operationId) return;

        await db.query(
            `
            UPDATE tbl_whatsapp_cart_operations
            SET
                status = 'COMPLETED',
                completed_at =
                    CURRENT_TIMESTAMP
            WHERE id = $1
              AND status = 'CLAIMED'
            `,
            [operationId]
        );
    }

    async getCompletedOperation({
        customerId,
        sourceMessageId,
        operationIndex,
        operationType = null
    }, db = this.pool) {
        const index =
            this.normalizeOperationIndex(
                operationIndex
            );

        if (
            !customerId ||
            !sourceMessageId ||
            index === null
        ) {
            return null;
        }

        const params = [
            customerId,
            sourceMessageId,
            index
        ];

        let typeClause = '';

        if (operationType) {
            params.push(operationType);

            typeClause =
                ' AND operation_type = $4';
        }

        const result = await db.query(
            `
            SELECT
                id,
                cart_id,
                customer_id,
                source_message_id,
                operation_index,
                operation_type,
                status,
                completed_at
            FROM tbl_whatsapp_cart_operations
            WHERE customer_id = $1
              AND source_message_id = $2
              AND operation_index = $3
              AND status = 'COMPLETED'
              ${typeClause}
            LIMIT 1
            `,
            params
        );

        return result.rows[0] || null;
    }

    async getActive(customerId, db = this.pool) {
        if (!customerId) return null;

        const result = await db.query(
            `
            SELECT *
            FROM tbl_whatsapp_carts
            WHERE customer_id = $1
              AND status = 'ACTIVE'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [customerId]
        );

        return result.rows[0] || null;
    }

    async getOrCreate({
        customerId,
        sourceMessageId = null,
        language = null
    }) {
        if (!customerId) {
            return {
                status: 'customer_required',
                cart: null
            };
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            let cart = await this.getActive(
                customerId,
                client
            );

            if (!cart) {
                const created = await client.query(
                    `
                    INSERT INTO tbl_whatsapp_carts (
                        customer_id,
                        conversation_language,
                        source_message_id
                    )
                    VALUES ($1, $2, $3)
                    ON CONFLICT (customer_id)
                        WHERE status = 'ACTIVE'
                    DO NOTHING
                    RETURNING *
                    `,
                    [
                        customerId,
                        language || null,
                        sourceMessageId || null
                    ]
                );

                cart =
                    created.rows[0] ||
                    await this.getActive(
                        customerId,
                        client
                    );
            } else {
                const updated = await client.query(
                    `
                    UPDATE tbl_whatsapp_carts
                    SET
                        conversation_language =
                            COALESCE(
                                conversation_language,
                                $2
                            ),
                        source_message_id =
                            COALESCE(
                                $3,
                                source_message_id
                            ),
                        updated_at = CURRENT_TIMESTAMP,
                        expires_at =
                            CURRENT_TIMESTAMP +
                            interval '30 minutes'
                    WHERE id = $1
                      AND status = 'ACTIVE'
                    RETURNING *
                    `,
                    [
                        cart.id,
                        language || null,
                        sourceMessageId || null
                    ]
                );

                cart = updated.rows[0] || cart;
            }

            await client.query('COMMIT');

            return {
                status: 'cart_ready',
                cart
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async addItem({
        customerId,
        draft,
        sourceMessageId = null,
        language = null,
        operationIndex = null,
        operationType = 'ADD_PRODUCT'
    }) {
        if (
            !customerId ||
            !draft?.productId ||
            !Number.isInteger(Number(draft.quantity)) ||
            Number(draft.quantity) < 1
        ) {
            return {
                status: 'invalid_item',
                cart: null
            };
        }

        const cartResult = await this.getOrCreate({
            customerId,
            sourceMessageId,
            language
        });

        if (
            cartResult.status !== 'cart_ready' ||
            !cartResult.cart?.id
        ) {
            return cartResult;
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const cartResultLocked =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_whatsapp_carts
                    WHERE id = $1
                      AND customer_id = $2
                      AND status = 'ACTIVE'
                    FOR UPDATE
                    `,
                    [
                        cartResult.cart.id,
                        customerId
                    ]
                );

            if (cartResultLocked.rowCount !== 1) {
                await client.query('ROLLBACK');
                return {
                    status: 'cart_not_active',
                    cart: null
                };
            }

            const operationClaim =
                await this.claimOperation({
                    db: client,
                    cartId:
                        cartResult.cart.id,
                    customerId,
                    sourceMessageId,
                    operationIndex,
                    operationType
                });

            if (
                operationClaim.conflict
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'idempotency_operation_conflict',
                    cart:
                        await this.getCart(
                            customerId
                        )
                };
            }

            if (
                operationClaim.enabled &&
                !operationClaim.claimed
            ) {
                await client.query('COMMIT');

                const replayCart =
                    await this.getCart(
                        customerId
                    );

                return {
                    ...replayCart,
                    idempotentReplay: true
                };
            }

            const quantity = Number(draft.quantity);
            const stock =
                Number(draft.availableStock);

            if (
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 100 ||
                !Number.isFinite(stock) ||
                stock < quantity
            ) {
                await client.query('ROLLBACK');
                return {
                    status: 'invalid_quantity',
                    cart: null
                };
            }

            await client.query(
                `
                INSERT INTO tbl_whatsapp_cart_items (
                    cart_id,
                    product_id,
                    quantity,
                    unit_price_snapshot,
                    selling_unit_snapshot,
                    pack_size_value_snapshot,
                    pack_size_unit_snapshot,
                    available_stock_snapshot,
                    source_message_id
                )
                VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9
                )
                ON CONFLICT (cart_id, product_id)
                DO UPDATE SET
                    quantity =
                        LEAST(
                            100,
                            tbl_whatsapp_cart_items.quantity +
                            EXCLUDED.quantity
                        ),
                    unit_price_snapshot =
                        EXCLUDED.unit_price_snapshot,
                    selling_unit_snapshot =
                        EXCLUDED.selling_unit_snapshot,
                    pack_size_value_snapshot =
                        EXCLUDED.pack_size_value_snapshot,
                    pack_size_unit_snapshot =
                        EXCLUDED.pack_size_unit_snapshot,
                    available_stock_snapshot =
                        EXCLUDED.available_stock_snapshot,
                    source_message_id =
                        EXCLUDED.source_message_id,
                    updated_at = CURRENT_TIMESTAMP
                `,
                [
                    cartResult.cart.id,
                    draft.productId,
                    quantity,
                    Number(draft.unitPrice),
                    String(
                        draft.sellingUnit || 'PCS'
                    ).toUpperCase(),
                    draft.packSizeValue ?? null,
                    draft.packSizeUnit
                        ? String(
                            draft.packSizeUnit
                          ).toUpperCase()
                        : null,
                    stock,
                    sourceMessageId || null
                ]
            );

            /*
             * Jangan hanya percaya snapshot stok.
             * Cegah quantity hasil penjumlahan
             * melebihi snapshot yang baru divalidasi.
             */
            const itemCheck = await client.query(
                `
                SELECT quantity,
                       available_stock_snapshot
                FROM tbl_whatsapp_cart_items
                WHERE cart_id = $1
                  AND product_id = $2
                `,
                [
                    cartResult.cart.id,
                    draft.productId
                ]
            );

            const stored = itemCheck.rows[0];

            if (
                !stored ||
                Number(stored.quantity) >
                    Number(
                        stored.available_stock_snapshot
                    )
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'insufficient_stock',
                    availableStock: stock,
                    cart: null
                };
            }

            await client.query(
                `
                UPDATE tbl_whatsapp_carts
                SET
                    updated_at = CURRENT_TIMESTAMP,
                    expires_at =
                        CURRENT_TIMESTAMP +
                        interval '30 minutes'
                WHERE id = $1
                `,
                [cartResult.cart.id]
            );

            await this.completeOperation({
                db: client,
                operationId:
                    operationClaim.operationId
            });

            await client.query('COMMIT');

            return this.getCart(customerId);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async setQuantity({
        customerId,
        productId,
        quantity,
        sourceMessageId = null,
        operationIndex = null,
        operationType = 'SET_QUANTITY'
    }) {
        const parsed = Number(quantity);

        if (
            !customerId ||
            !productId ||
            !Number.isInteger(parsed) ||
            parsed < 1 ||
            parsed > 100
        ) {
            return {
                status: 'invalid_quantity',
                cart: null
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const cartResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_whatsapp_carts
                    WHERE customer_id = $1
                      AND status = 'ACTIVE'
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [customerId]
                );

            if (cartResult.rowCount !== 1) {
                await client.query('ROLLBACK');

                return {
                    status: 'cart_not_active',
                    cart: null
                };
            }

            const cart =
                cartResult.rows[0];

            const operationClaim =
                await this.claimOperation({
                    db: client,
                    cartId: cart.id,
                    customerId,
                    sourceMessageId,
                    operationIndex,
                    operationType
                });

            if (
                operationClaim.conflict
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'idempotency_operation_conflict',
                    cart:
                        await this.getCart(
                            customerId
                        )
                };
            }

            if (
                operationClaim.enabled &&
                !operationClaim.claimed
            ) {
                await client.query('COMMIT');

                const replayCart =
                    await this.getCart(
                        customerId
                    );

                return {
                    ...replayCart,
                    idempotentReplay: true
                };
            }

            const result =
                await client.query(
                    `
                    UPDATE tbl_whatsapp_cart_items
                    SET
                        quantity = $3,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE cart_id = $1
                      AND product_id = $2
                      AND $3 <=
                          available_stock_snapshot
                    RETURNING id
                    `,
                    [
                        cart.id,
                        productId,
                        parsed
                    ]
                );

            if (result.rowCount !== 1) {
                await client.query('ROLLBACK');

                return {
                    status: 'item_not_updated',
                    cart:
                        await this.getCart(
                            customerId
                        )
                };
            }

            await client.query(
                `
                UPDATE tbl_whatsapp_carts
                SET
                    updated_at =
                        CURRENT_TIMESTAMP,
                    expires_at =
                        CURRENT_TIMESTAMP +
                        interval '30 minutes'
                WHERE id = $1
                `,
                [cart.id]
            );

            await this.completeOperation({
                db: client,
                operationId:
                    operationClaim.operationId
            });

            await client.query('COMMIT');

            return this.getCart(
                customerId
            );

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;

        } finally {
            client.release();
        }
    }

    async removeItem({
        customerId,
        productId,
        sourceMessageId = null,
        operationIndex = null,
        operationType = 'REMOVE_PRODUCT'
    }) {
        if (!customerId || !productId) {
            return {
                status: 'invalid_item',
                cart: null
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const cartResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_whatsapp_carts
                    WHERE customer_id = $1
                      AND status = 'ACTIVE'
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [customerId]
                );

            if (cartResult.rowCount !== 1) {
                await client.query('ROLLBACK');

                return {
                    status: 'cart_not_active',
                    cart: null
                };
            }

            const cart =
                cartResult.rows[0];

            const operationClaim =
                await this.claimOperation({
                    db: client,
                    cartId: cart.id,
                    customerId,
                    sourceMessageId,
                    operationIndex,
                    operationType
                });

            if (
                operationClaim.conflict
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'idempotency_operation_conflict',
                    cart:
                        await this.getCart(
                            customerId
                        )
                };
            }

            if (
                operationClaim.enabled &&
                !operationClaim.claimed
            ) {
                await client.query('COMMIT');

                const replayCart =
                    await this.getCart(
                        customerId
                    );

                return {
                    ...replayCart,
                    idempotentReplay: true
                };
            }

            const result =
                await client.query(
                    `
                    DELETE FROM
                        tbl_whatsapp_cart_items
                    WHERE cart_id = $1
                      AND product_id = $2
                    RETURNING id
                    `,
                    [
                        cart.id,
                        productId
                    ]
                );

            if (result.rowCount !== 1) {
                await client.query('ROLLBACK');

                return {
                    status: 'item_not_found',
                    cart:
                        await this.getCart(
                            customerId
                        )
                };
            }

            await client.query(
                `
                UPDATE tbl_whatsapp_carts
                SET
                    updated_at =
                        CURRENT_TIMESTAMP,
                    expires_at =
                        CURRENT_TIMESTAMP +
                        interval '30 minutes'
                WHERE id = $1
                `,
                [cart.id]
            );

            await this.completeOperation({
                db: client,
                operationId:
                    operationClaim.operationId
            });

            await client.query('COMMIT');

            return this.getCart(
                customerId
            );

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;

        } finally {
            client.release();
        }
    }

    async touch(customerId) {
        await this.pool.query(
            `
            UPDATE tbl_whatsapp_carts
            SET
                updated_at = CURRENT_TIMESTAMP,
                expires_at =
                    CURRENT_TIMESTAMP +
                    interval '30 minutes'
            WHERE customer_id = $1
              AND status = 'ACTIVE'
            `,
            [customerId]
        );
    }

    async getCart(customerId) {
        const cart = await this.getActive(customerId);

        if (!cart) {
            return {
                status: 'cart_not_found',
                cart: null,
                items: [],
                totalAmount: 0
            };
        }

        const itemsResult = await this.pool.query(
            `
            SELECT
                i.id,
                i.product_id,
                p.name AS product_name,
                p.sku,
                p.merchant_id,
                i.quantity,
                i.unit_price_snapshot,
                i.selling_unit_snapshot,
                i.pack_size_value_snapshot,
                i.pack_size_unit_snapshot,
                i.available_stock_snapshot,
                (
                    i.quantity *
                    i.unit_price_snapshot
                ) AS subtotal
            FROM tbl_whatsapp_cart_items i
            JOIN tbl_products p
              ON p.id = i.product_id
            WHERE i.cart_id = $1
            ORDER BY i.created_at, i.id
            `,
            [cart.id]
        );

        const items = itemsResult.rows.map(
            item => ({
                ...item,
                quantity:
                    Number(item.quantity),
                unit_price_snapshot:
                    Number(
                        item.unit_price_snapshot
                    ),
                available_stock_snapshot:
                    Number(
                        item.available_stock_snapshot
                    ),
                subtotal:
                    Number(item.subtotal)
            })
        );

        const totalAmount =
            items.reduce(
                (sum, item) =>
                    sum + item.subtotal,
                0
            );

        return {
            status: 'cart_ready',
            cart,
            items,
            itemCount: items.length,
            totalQuantity:
                items.reduce(
                    (sum, item) =>
                        sum + item.quantity,
                    0
                ),
            totalAmount
        };
    }
}

module.exports = WhatsAppCartStore;
