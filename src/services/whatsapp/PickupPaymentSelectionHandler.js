class PickupPaymentSelectionHandler {
    constructor(pool) {
        this.pool = pool;
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
                    'Data customer belum tersedia.'
            };
        }

        const normalizedAction =
            String(action || '')
                .trim()
                .toUpperCase();

        const paymentMap = {
            SET_OUTLET_PAYMENT:
                'OUTLET',
            SET_ONLINE_PAYMENT:
                'ONLINE'
        };

        const pickupPayment =
            paymentMap[
                normalizedAction
            ] || null;

        if (!pickupPayment) {
            return {
                status:
                    'invalid_action',
                responseText:
                    'Pilihan pembayarannya belum dikenali.'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query(
                'BEGIN'
            );

            /*
             * Lock draft terbaru.
             */
            const draftResult =
                await client.query(
                    `
                    SELECT
                        id,
                        customer_id,
                        product_id,
                        fulfillment_type,
                        pickup_payment,
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
                        'Belum ada pesanan sementara yang aktif nih. Pesan produknya dulu ya.'
                };
            }

            const draft =
                draftResult.rows[0];

            /*
             * Pickup payment hanya boleh dipilih
             * jika fulfillment canonical sudah PICKUP.
             */
            if (
                String(
                    draft.fulfillment_type ||
                    ''
                )
                    .trim()
                    .toUpperCase() !==
                'PICKUP'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'pickup_required',
                    responseText:
                        'Pilihan bayar ini khusus pesanan yang diambil sendiri di outlet.\n\n' +
                        'Kalau mau ambil sendiri, balas "ambil sendiri".'
                };
            }

            if (
                !String(
                    draft.pickup_location_snapshot ||
                    ''
                ).trim()
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'pickup_location_missing',
                    responseText:
                        'Lokasi pickup belum tersedia. Coba pilih "ambil sendiri" lagi ya.'
                };
            }

            /*
             * Idempotent selection.
             */
            if (
                String(
                    draft.pickup_payment ||
                    ''
                )
                    .trim()
                    .toUpperCase() ===
                pickupPayment
            ) {
                await client.query(
                    'COMMIT'
                );

                return {
                    status:
                        pickupPayment ===
                        'OUTLET'
                            ? 'outlet_payment_selected'
                            : 'online_payment_selected',

                    already_selected:
                        true,

                    draft,

                    responseText:
                        pickupPayment ===
                        'OUTLET'
                            ? (
                                'Sip, bayarnya di outlet pas kamu ambil pesanan ya.\n\n' +
                                'Kalau semuanya sudah benar, balas KONFIRMASI.'
                              )
                            : (
                                'Sip, kamu pilih bayar online.\n\n' +
                                'Kalau semuanya sudah benar, balas KONFIRMASI.'
                              )
                };
            }

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET
                        pickup_payment = $2
                    WHERE id = $1
                      AND status =
                          'PENDING_CONFIRMATION'
                    RETURNING
                        id,
                        customer_id,
                        product_id,
                        fulfillment_type,
                        pickup_payment,
                        pickup_location_snapshot,
                        shipping_address,
                        status
                    `,
                    [
                        draft.id,
                        pickupPayment
                    ]
                );

            if (
                updatedResult.rowCount !==
                1
            ) {
                throw new Error(
                    'Draft pickup payment berubah secara bersamaan'
                );
            }

            await client.query(
                'COMMIT'
            );

            const updated =
                updatedResult.rows[0];

            return {
                status:
                    pickupPayment ===
                    'OUTLET'
                        ? 'outlet_payment_selected'
                        : 'online_payment_selected',

                already_selected:
                    false,

                draft:
                    updated,

                responseText:
                    pickupPayment ===
                    'OUTLET'
                        ? (
                            'Sip, bayarnya di outlet pas kamu ambil pesanan ya.\n\n' +
                            'Kalau semuanya sudah benar, balas KONFIRMASI.'
                          )
                        : (
                            'Sip, kamu pilih bayar online.\n\n' +
                            'Kalau semuanya sudah benar, balas KONFIRMASI.'
                          )
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
    PickupPaymentSelectionHandler;
