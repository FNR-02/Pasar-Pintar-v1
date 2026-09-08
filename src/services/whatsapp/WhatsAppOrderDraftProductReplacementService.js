class WhatsAppOrderDraftProductReplacementService {
    constructor(pool) {
        this.pool = pool;
    }

    async replace({
        customerId,
        productId
    }) {
        if (
            !customerId ||
            !productId
        ) {
            return {
                status: 'invalid_input',
                responseText:
                    'Produk penggantinya belum jelas kak.'
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

            const contextResult =
                await client.query(
                    `
                    SELECT
                        id,
                        context_type,
                        context_payload
                    FROM tbl_whatsapp_product_contexts
                    WHERE customer_id = $1
                      AND status = 'ACTIVE'
                      AND expires_at >
                          CURRENT_TIMESTAMP
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [customerId]
                );

            if (
                contextResult.rowCount === 0 ||
                contextResult.rows[0]
                    .context_type !==
                    'DRAFT_PRODUCT_ALTERNATIVES'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'product_context_required',
                    responseText:
                        'Pilihan produk penggantinya belum jelas kak.'
                };
            }

            const context =
                contextResult.rows[0];

            const alternatives =
                Array.isArray(
                    context.context_payload
                        ?.products
                )
                    ? context.context_payload.products
                    : [];

            const selectedAlternative =
                alternatives.find(
                    product =>
                        String(product?.id) ===
                        String(productId)
                );

            if (!selectedAlternative) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'product_not_in_alternatives',
                    responseText:
                        'Produk itu bukan dari pilihan yang tadi kak.'
                };
            }

            const productResult =
                await client.query(
                    `
                    SELECT
                        p.id,
                        p.sku,
                        p.name,
                        p.selling_unit,
                        p.pack_size_value,
                        p.pack_size_unit,
                        COALESCE((
                            SELECT pp.amount
                            FROM tbl_product_prices pp
                            WHERE pp.product_id = p.id
                              AND pp.price_type =
                                  'RETAIL'
                            ORDER BY
                                pp.effective_date DESC
                            LIMIT 1
                        ), 0) AS price,
                        COALESCE((
                            SELECT
                                SUM(
                                    i.quantity_on_hand
                                )
                            FROM tbl_inventory i
                            WHERE i.product_id = p.id
                        ), 0)::int AS stock
                    FROM tbl_products p
                    WHERE p.id = $1
                      AND p.status = 'ACTIVE'
                      AND p.customer_visible = TRUE
                    LIMIT 1
                    `,
                    [productId]
                );

            if (productResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'product_not_available',
                    responseText:
                        'Produk penggantinya sudah tidak tersedia di katalog kak.'
                };
            }

            const product =
                productResult.rows[0];

            const quantity =
                Number(draft.quantity);

            const stock =
                Number(product.stock);

            const price =
                Number(product.price);

            if (
                !Number.isFinite(price) ||
                price <= 0
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'product_not_available',
                    responseText:
                        'Harga produk penggantinya belum tersedia kak.'
                };
            }

            if (stock < quantity) {
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
                price * quantity;

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET
                        product_id = $2,
                        unit_price = $3,
                        subtotal = $4,
                        available_stock_snapshot =
                            $5,
                        selling_unit_snapshot =
                            $6,
                        pack_size_value_snapshot =
                            $7,
                        pack_size_unit_snapshot =
                            $8
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
                        product.id,
                        price,
                        subtotal,
                        stock,
                        String(
                            product.selling_unit ||
                            'PCS'
                        ).toUpperCase(),
                        product.pack_size_value ===
                            null ||
                        product.pack_size_value ===
                            undefined
                            ? null
                            : Number(
                                product.pack_size_value
                            ),
                        product.pack_size_unit
                            ? String(
                                product.pack_size_unit
                              ).toUpperCase()
                            : null
                    ]
                );

            if (updatedResult.rowCount !== 1) {
                throw new Error(
                    'Draft produk berubah secara bersamaan'
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
                    'product_replaced',
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
                previousProductId:
                    draft.product_id,
                responseText:
                    `Siap kak, produknya diganti ke ${product.name}. ` +
                    `Jumlah tetap ${quantity} ${String(
                        product.selling_unit ||
                        'PCS'
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
    WhatsAppOrderDraftProductReplacementService;
