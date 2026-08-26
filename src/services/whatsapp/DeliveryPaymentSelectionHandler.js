class DeliveryPaymentSelectionHandler {
    constructor(pool) {
        this.pool = pool;
    }

    normalizeAction(action) {
        const value =
            String(action || '')
                .trim()
                .toUpperCase();

        const mapping = {
            SET_ONLINE_PAYMENT:
                'ONLINE'
        };

        return mapping[value] || null;
    }

    async handle({
        customer,
        action
    }) {
        const customerId =
            customer?.customer_id || null;

        if (!customerId) {
            return {
                status:
                    'customer_missing',
                responseText:
                    'Data akun kamu belum ketemu.'
            };
        }

        const deliveryPayment =
            this.normalizeAction(
                action
            );

        if (!deliveryPayment) {
            return {
                status:
                    'invalid_action',
                responseText:
                    'Pilihan pembayaran pengantaran belum dikenali.'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query(
                'BEGIN'
            );

            /*
             * Lock draft aktif terbaru agar selection
             * payment tidak race dengan fulfillment
             * switch atau confirmation.
             */
            const draftResult =
                await client.query(
                    `
                    SELECT
                        id,
                        customer_id,
                        product_id,
                        fulfillment_type,
                        fulfillment_selection_explicit,
                        pickup_payment,
                        delivery_payment,
                        pickup_location_snapshot,
                        shipping_address,
                        status,
                        expires_at
                    FROM tbl_whatsapp_order_drafts
                    WHERE customer_id = $1
                      AND status =
                          'PENDING_CONFIRMATION'
                      AND expires_at >
                          CURRENT_TIMESTAMP
                    ORDER BY created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        customerId
                    ]
                );

            if (
                draftResult.rowCount ===
                0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'draft_not_found',
                    responseText:
                        'Belum ada pesanan yang lagi diproses.\n\n' +
                        'Coba buat pesanan dulu ya.'
                };
            }

            const draft =
                draftResult.rows[0];

            const fulfillmentType =
                String(
                    draft.fulfillment_type ||
                    ''
                )
                    .trim()
                    .toUpperCase();

            /*
             * delivery_payment hanya sah untuk
             * fulfillment DELIVERY yang benar-benar
             * telah dipilih Customer.
             */
            if (
                fulfillmentType !==
                    'DELIVERY' ||
                draft
                    .fulfillment_selection_explicit !==
                    true
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'delivery_required',
                    responseText:
                        'Pilihan bayar ini khusus pesanan yang diantar.\n\n' +
                        'Kalau mau pesanannya diantar, balas "antar".'
                };
            }

            /*
             * Alamat wajib sudah tersedia sebelum
             * pembayaran DELIVERY dipilih.
             */
            const shippingAddress =
                String(
                    draft.shipping_address ||
                    ''
                ).trim();

            if (!shippingAddress) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'shipping_address_required',
                    responseText:
                        'Alamat pengirimannya belum ada.\n\n' +
                        'Kirim alamat lengkapnya dulu ya, contoh:\n' +
                        '"antar ke Jl. Merdeka No. 10 Bandung"'
                };
            }

            const currentPayment =
                draft.delivery_payment
                    ? String(
                        draft.delivery_payment
                      )
                        .trim()
                        .toUpperCase()
                    : null;

            /*
             * Idempotent selection.
             */
            if (
                currentPayment ===
                deliveryPayment
            ) {
                await client.query(
                    'COMMIT'
                );

                return {
                    status:
                        'online_payment_selected',
                    already_selected:
                        true,
                    draft: {
                        ...draft,
                        fulfillment_type:
                            fulfillmentType,
                        delivery_payment:
                            currentPayment,
                        shipping_address:
                            shippingAddress
                    },
                    responseText:
                        'Sip, pembayaran online sudah dipilih.\n\n' +
                        'Kalau semuanya sudah benar, balas KONFIRMASI.'
                };
            }

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET
                        delivery_payment =
                            $2,
                        pickup_payment =
                            NULL,
                        pickup_location_snapshot =
                            NULL
                    WHERE id = $1
                      AND status =
                          'PENDING_CONFIRMATION'
                    RETURNING
                        id,
                        customer_id,
                        product_id,
                        fulfillment_type,
                        fulfillment_selection_explicit,
                        pickup_payment,
                        delivery_payment,
                        pickup_location_snapshot,
                        shipping_address,
                        status,
                        expires_at
                    `,
                    [
                        draft.id,
                        deliveryPayment
                    ]
                );

            if (
                updatedResult.rowCount !==
                1
            ) {
                throw new Error(
                    'Draft delivery payment berubah secara bersamaan'
                );
            }

            await client.query(
                'COMMIT'
            );

            return {
                status:
                    'online_payment_selected',
                already_selected:
                    false,
                draft:
                    updatedResult.rows[0],
                responseText:
                    'Sip, pembayaran online sudah dipilih.\n\n' +
                    'Kalau semuanya sudah benar, balas KONFIRMASI.'
            };

        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {
                // Ignore secondary rollback error.
            }

            throw err;

        } finally {
            client.release();
        }
    }
}

module.exports =
    DeliveryPaymentSelectionHandler;
