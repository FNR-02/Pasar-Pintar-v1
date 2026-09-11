class WhatsAppCartStore {
    constructor(pool) {
        this.pool = pool;
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
        language = null
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
        quantity
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

        const result = await this.pool.query(
            `
            UPDATE tbl_whatsapp_cart_items i
            SET
                quantity = $3,
                updated_at = CURRENT_TIMESTAMP
            FROM tbl_whatsapp_carts c
            WHERE i.cart_id = c.id
              AND c.customer_id = $1
              AND c.status = 'ACTIVE'
              AND i.product_id = $2
              AND $3 <= i.available_stock_snapshot
            RETURNING i.id
            `,
            [
                customerId,
                productId,
                parsed
            ]
        );

        if (result.rowCount !== 1) {
            return {
                status: 'item_not_updated',
                cart: await this.getCart(customerId)
            };
        }

        await this.touch(customerId);

        return this.getCart(customerId);
    }

    async removeItem({
        customerId,
        productId
    }) {
        if (!customerId || !productId) {
            return {
                status: 'invalid_item',
                cart: null
            };
        }

        const result = await this.pool.query(
            `
            DELETE FROM tbl_whatsapp_cart_items i
            USING tbl_whatsapp_carts c
            WHERE i.cart_id = c.id
              AND c.customer_id = $1
              AND c.status = 'ACTIVE'
              AND i.product_id = $2
            RETURNING i.id
            `,
            [
                customerId,
                productId
            ]
        );

        if (result.rowCount === 0) {
            return {
                status: 'item_not_found',
                cart: await this.getCart(customerId)
            };
        }

        await this.touch(customerId);

        return this.getCart(customerId);
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
