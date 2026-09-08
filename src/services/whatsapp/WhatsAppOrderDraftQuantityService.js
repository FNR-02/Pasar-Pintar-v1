class WhatsAppOrderDraftQuantityService {
    constructor(pool) {
        this.pool = pool;
    }

    async update({
        customerId,
        quantity
    }) {
        const parsedQuantity =
            Number(quantity);

        if (
            !customerId ||
            !Number.isInteger(parsedQuantity) ||
            parsedQuantity < 1 ||
            parsedQuantity > 100
        ) {
            return {
                status: 'invalid_quantity',
                responseText:
                    'Jumlah pesanannya bisa dari 1 sampai 100 ya kak.'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const draftResult =
                await client.query(
                    `
                    SELECT
                        d.id,
                        d.customer_id,
                        d.product_id,
                        d.quantity,
                        d.status,
                        d.expires_at
                    FROM tbl_whatsapp_order_drafts d
                    WHERE d.customer_id = $1
                      AND d.status =
                          'PENDING_CONFIRMATION'
                      AND d.expires_at >
                          CURRENT_TIMESTAMP
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
                    responseText:
                        'Belum ada pesanan yang lagi diproses kak.'
                };
            }

            const draft =
                draftResult.rows[0];

            const productResult =
                await client.query(
                    `
                    SELECT
                        p.id,
                        p.name,
                        p.selling_unit,

                        COALESCE((
                            SELECT pp.amount
                            FROM tbl_product_prices pp
                            WHERE pp.product_id = p.id
                              AND pp.price_type = 'RETAIL'
                            ORDER BY
                                pp.effective_date DESC
                            LIMIT 1
                        ), 0) AS price,

                        COALESCE((
                            SELECT
                                SUM(i.quantity_on_hand)
                            FROM tbl_inventory i
                            WHERE i.product_id = p.id
                        ), 0)::int AS stock

                    FROM tbl_products p
                    WHERE p.id = $1
                      AND p.status = 'ACTIVE'
                      AND p.customer_visible = TRUE
                    LIMIT 1
                    `,
                    [draft.product_id]
                );

            if (productResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'product_not_available',
                    responseText:
                        'Produknya sudah tidak tersedia di katalog kak.'
                };
            }

            const product =
                productResult.rows[0];

            const stock =
                Number(product.stock);

            const price =
                Number(product.price);

            if (stock < parsedQuantity) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'insufficient_stock',
                    availableStock:
                        stock,
                    responseText:
                        `Stok ${product.name} sekarang tinggal ${stock} kak.`
                };
            }

            const subtotal =
                price * parsedQuantity;

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET
                        quantity = $2,
                        unit_price = $3,
                        subtotal = $4,
                        available_stock_snapshot =
                            $5
                    WHERE id = $1
                      AND status =
                          'PENDING_CONFIRMATION'
                    RETURNING
                        id,
                        customer_id,
                        product_id,
                        quantity,
                        unit_price,
                        subtotal,
                        available_stock_snapshot,
                        selling_unit_snapshot,
                        pack_size_value_snapshot,
                        pack_size_unit_snapshot,
                        fulfillment_type,
                        fulfillment_selection_explicit,
                        pickup_payment,
                        delivery_payment,
                        pickup_location_snapshot,
                        shipping_address,
                        source_message_id,
                        status,
                        created_at,
                        expires_at
                    `,
                    [
                        draft.id,
                        parsedQuantity,
                        price,
                        subtotal,
                        stock
                    ]
                );

            if (updatedResult.rowCount !== 1) {
                throw new Error(
                    'Draft quantity berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            const rupiah =
                value =>
                    new Intl.NumberFormat(
                        'id-ID',
                        {
                            style: 'currency',
                            currency: 'IDR',
                            maximumFractionDigits: 0
                        }
                    ).format(value);

            return {
                status:
                    'quantity_updated',
                draft:
                    updatedResult.rows[0],
                product: {
                    id:
                        product.id,
                    name:
                        product.name,
                    stock,
                    price
                },
                responseText:
                    `Siap kak, jumlah ${product.name} jadi ${parsedQuantity} ${String(
                        product.selling_unit || 'PCS'
                    ).toLowerCase()}.\n` +
                    `Total sementara: ${rupiah(subtotal)}`
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

module.exports =
    WhatsAppOrderDraftQuantityService;
