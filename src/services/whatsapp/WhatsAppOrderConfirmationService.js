class WhatsAppOrderConfirmationService {
    constructor(pool, CommerceKernel = null) {
        this.pool = pool;
        this.CommerceKernel = CommerceKernel;
    }

    async confirm({ customerId }) {
        if (!customerId) {
            const err = new Error('customerId wajib tersedia');
            err.code = 'CUSTOMER_REQUIRED';
            throw err;
        }

        const client = await this.pool.connect();

        let committedOrder = null;

        try {
            await client.query('BEGIN');

            /*
             * Lock draft agar dua request KONFIRMASI paralel
             * tidak dapat membuat dua order.
             */
            const draftResult = await client.query(
                `
                SELECT
                    d.id,
                    d.customer_id,
                    d.product_id,
                    d.quantity,
                    d.unit_price,
                    d.subtotal,
                    d.status,
                    d.expires_at,
                    d.confirmed_order_id
                FROM tbl_whatsapp_order_drafts d
                WHERE d.customer_id = $1
                  AND d.status = 'PENDING_CONFIRMATION'
                ORDER BY d.created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [customerId]
            );

            if (draftResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status: 'draft_not_found',
                    order: null
                };
            }

            const draft = draftResult.rows[0];

            if (
                new Date(draft.expires_at).getTime() <=
                Date.now()
            ) {
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET status = 'EXPIRED'
                    WHERE id = $1
                    `,
                    [draft.id]
                );

                await client.query('COMMIT');

                return {
                    status: 'draft_expired',
                    order: null
                };
            }

            /*
             * Product canonical.
             */
            const productResult = await client.query(
                `
                SELECT
                    id,
                    merchant_id,
                    sku,
                    name
                FROM tbl_products
                WHERE id = $1
                  AND status = 'ACTIVE'
                LIMIT 1
                `,
                [draft.product_id]
            );

            if (productResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status: 'product_unavailable',
                    order: null
                };
            }

            const product = productResult.rows[0];

            if (!product.merchant_id) {
                await client.query('ROLLBACK');

                return {
                    status: 'merchant_missing',
                    order: null
                };
            }

            /*
             * Revalidate current stock.
             * Sama seperti checkoutV2: validasi saja,
             * belum melakukan pengurangan stok.
             */
            const stockResult = await client.query(
                `
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS stock
                FROM tbl_inventory
                WHERE product_id = $1
                `,
                [product.id]
            );

            const stock =
                Number(stockResult.rows[0]?.stock || 0);

            const quantity =
                Number(draft.quantity);

            if (stock < quantity) {
                await client.query('ROLLBACK');

                return {
                    status: 'insufficient_stock',
                    availableStock: stock,
                    requestedQuantity: quantity,
                    order: null
                };
            }

            /*
             * Revalidate retail price.
             */
            const priceResult = await client.query(
                `
                SELECT amount
                FROM tbl_product_prices
                WHERE product_id = $1
                  AND price_type = 'RETAIL'
                ORDER BY effective_date DESC
                LIMIT 1
                `,
                [product.id]
            );

            if (priceResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status: 'price_unavailable',
                    order: null
                };
            }

            const currentPrice =
                Number(priceResult.rows[0].amount);

            const draftPrice =
                Number(draft.unit_price);

            if (currentPrice !== draftPrice) {
                await client.query('ROLLBACK');

                return {
                    status: 'price_changed',
                    currentPrice,
                    draftPrice,
                    order: null
                };
            }

            const subtotal =
                currentPrice * quantity;

            if (
                subtotal !==
                Number(draft.subtotal)
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'subtotal_mismatch',
                    order: null
                };
            }

            /*
             * Create canonical order.
             */
            const orderResult = await client.query(
                `
                INSERT INTO tbl_orders_v2 (
                    customer_id,
                    merchant_id,
                    status,
                    shipping_address,
                    total_amount
                )
                VALUES (
                    $1,
                    $2,
                    'PENDING',
                    NULL,
                    $3
                )
                RETURNING
                    id,
                    customer_id,
                    merchant_id,
                    status,
                    shipping_address,
                    total_amount,
                    created_at
                `,
                [
                    customerId,
                    product.merchant_id,
                    subtotal
                ]
            );

            const order = orderResult.rows[0];

            await client.query(
                `
                INSERT INTO tbl_order_items (
                    order_id,
                    product_id,
                    quantity,
                    unit_price
                )
                VALUES ($1, $2, $3, $4)
                `,
                [
                    order.id,
                    product.id,
                    quantity,
                    currentPrice
                ]
            );

            /*
             * Draft menjadi immutable confirmation record.
             */
            const draftUpdate = await client.query(
                `
                UPDATE tbl_whatsapp_order_drafts
                SET
                    status = 'CONFIRMED',
                    confirmed_at = CURRENT_TIMESTAMP,
                    confirmed_order_id = $1
                WHERE id = $2
                  AND status = 'PENDING_CONFIRMATION'
                RETURNING id
                `,
                [
                    order.id,
                    draft.id
                ]
            );

            if (draftUpdate.rowCount !== 1) {
                throw new Error(
                    'Draft confirmation state berubah secara tidak terduga'
                );
            }

            await client.query('COMMIT');

            committedOrder = {
                ...order,
                product: {
                    id: product.id,
                    sku: product.sku,
                    name: product.name,
                    quantity,
                    unitPrice: currentPrice
                }
            };
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {
                // Ignore secondary rollback error.
            }

            throw err;
        } finally {
            client.release();
        }

        /*
         * Event hanya diterbitkan SETELAH COMMIT berhasil.
         */
        if (
            committedOrder &&
            this.CommerceKernel
        ) {
            this.CommerceKernel.emitEvent(
                'ORDER_CREATED',
                'ORDER',
                committedOrder.id,
                committedOrder
            );
        }

        return {
            status: 'confirmed',
            order: committedOrder
        };
    }
}

module.exports = WhatsAppOrderConfirmationService;
