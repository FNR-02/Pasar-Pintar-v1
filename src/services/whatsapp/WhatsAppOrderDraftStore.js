class WhatsAppOrderDraftStore {
    constructor(pool) {
        this.pool = pool;
    }

    async createOrReplace({
        customerId,
        draft,
        sourceMessageId
    }) {
        if (
            !customerId ||
            !draft ||
            !draft.productId ||
            !sourceMessageId
        ) {
            const err = new Error(
                'Data draft WhatsApp tidak lengkap'
            );
            err.code = 'INVALID_DRAFT_INPUT';
            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const duplicateResult =
                await client.query(
                    `
                    SELECT
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
                        source_message_id,
                        status,
                        created_at,
                        expires_at
                    FROM tbl_whatsapp_order_drafts
                    WHERE source_message_id = $1
                    LIMIT 1
                    `,
                    [sourceMessageId]
                );

            if (duplicateResult.rowCount > 0) {
                await client.query('COMMIT');

                return {
                    status: 'duplicate',
                    draft:
                        duplicateResult.rows[0]
                };
            }

            await client.query(
                `
                UPDATE tbl_whatsapp_order_drafts
                SET
                    status = 'EXPIRED'
                WHERE customer_id = $1
                  AND status = 'PENDING_CONFIRMATION'
                `,
                [customerId]
            );

            const result =
                await client.query(
                    `
                    INSERT INTO tbl_whatsapp_order_drafts (
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
                        source_message_id,
                        status
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        $11,
                        $12,
                        $13,
                        $14,
                        $15,
                        'PENDING_CONFIRMATION'
                    )
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
                        source_message_id,
                        status,
                        created_at,
                        expires_at
                    `,
                    [
                        customerId,
                        draft.productId,
                        draft.quantity,
                        draft.unitPrice,
                        draft.subtotal,
                        draft.availableStock,
                        String(
                            draft.sellingUnit || 'PCS'
                        ).toUpperCase(),
                        draft.packSizeValue === null ||
                        draft.packSizeValue === undefined
                            ? null
                            : Number(
                                draft.packSizeValue
                            ),
                        draft.packSizeUnit
                            ? String(
                                draft.packSizeUnit
                              ).toUpperCase()
                            : null,
                        String(
                            draft.fulfillmentType ||
                            'DELIVERY'
                        ).toUpperCase(),
                        draft.fulfillmentSelectionExplicit === true,
                        draft.pickupPayment
                            ? String(
                                draft.pickupPayment
                              ).toUpperCase()
                            : null,
                        draft.deliveryPayment
                            ? String(
                                draft.deliveryPayment
                              ).toUpperCase()
                            : null,
                        draft.pickupLocationSnapshot
                            ? String(
                                draft.pickupLocationSnapshot
                              ).trim()
                            : null,
                        sourceMessageId
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'stored',
                draft:
                    result.rows[0]
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async getPending(customerId) {
        const result =
            await this.pool.query(
                `
                SELECT
                    d.id,
                    d.customer_id,
                    d.product_id,
                    d.quantity,
                    d.unit_price,
                    d.subtotal,
                    d.available_stock_snapshot,
                    d.selling_unit_snapshot,
                    d.pack_size_value_snapshot,
                    d.pack_size_unit_snapshot,
                    d.fulfillment_type,
                    d.fulfillment_selection_explicit,
                    d.pickup_payment,
                    d.delivery_payment,
                    d.pickup_location_snapshot,
                    d.shipping_address,
                    d.source_message_id,
                    d.status,
                    d.created_at,
                    d.expires_at,
                    p.sku,
                    p.name AS product_name
                FROM tbl_whatsapp_order_drafts d
                JOIN tbl_products p
                    ON p.id = d.product_id
                WHERE d.customer_id = $1
                  AND d.status = 'PENDING_CONFIRMATION'
                  AND d.expires_at > CURRENT_TIMESTAMP
                ORDER BY d.created_at DESC
                LIMIT 1
                `,
                [customerId]
            );

        return result.rowCount > 0
            ? result.rows[0]
            : null;
    }
}

module.exports = WhatsAppOrderDraftStore;
