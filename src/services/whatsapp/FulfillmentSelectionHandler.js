class FulfillmentSelectionHandler {
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
                status: 'customer_missing',
                responseText:
                    'Data customer belum tersedia.'
            };
        }

        const normalizedAction =
            String(action || '')
                .trim()
                .toUpperCase();

        if (
            ![
                'SET_DELIVERY',
                'SET_PICKUP'
            ].includes(
                normalizedAction
            )
        ) {
            return {
                status: 'invalid_action',
                responseText:
                    'Pilihan pengiriman belum dikenali.'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Lock draft aktif.
             */
            const draftResult =
                await client.query(
                    `
                    SELECT
                        d.id,
                        d.customer_id,
                        d.product_id,
                        d.fulfillment_type,
                        d.pickup_payment,
                        d.pickup_location_snapshot,
                        d.shipping_address,
                        d.status,
                        d.expires_at,

                        p.merchant_id,
                        p.name AS product_name,

                        m.store_name,
                        m.address AS merchant_address,
                        m.status AS merchant_status

                    FROM tbl_whatsapp_order_drafts d

                    JOIN tbl_products p
                        ON p.id =
                            d.product_id

                    LEFT JOIN tbl_merchants m
                        ON m.id =
                            p.merchant_id

                    WHERE d.customer_id = $1
                      AND d.status =
                          'PENDING_CONFIRMATION'
                      AND d.expires_at >
                          CURRENT_TIMESTAMP

                    ORDER BY
                        d.created_at DESC

                    LIMIT 1
                    FOR UPDATE OF d
                    `,
                    [
                        customerId
                    ]
                );

            if (
                draftResult.rowCount === 0
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
             * =================================================
             * DELIVERY
             *
             * Switching kembali ke DELIVERY harus membersihkan
             * metadata PICKUP lama agar state tidak ambigu.
             * =================================================
             */
            if (
                normalizedAction ===
                'SET_DELIVERY'
            ) {
                const updatedResult =
                    await client.query(
                        `
                        UPDATE tbl_whatsapp_order_drafts
                        SET
                            fulfillment_type =
                                'DELIVERY',
                            fulfillment_selection_explicit =
                                TRUE,
                            pickup_payment =
                                NULL,
                            delivery_payment =
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
                            status
                        `,
                        [
                            draft.id
                        ]
                    );

                if (
                    updatedResult.rowCount !==
                    1
                ) {
                    throw new Error(
                        'Draft fulfillment berubah secara bersamaan'
                    );
                }

                await client.query(
                    'COMMIT'
                );

                const updated =
                    updatedResult.rows[0];

                const hasAddress =
                    Boolean(
                        String(
                            updated.shipping_address ||
                            ''
                        ).trim()
                    );

                return {
                    status:
                        'delivery_selected',
                    draft:
                        updated,
                    responseText:
                        hasAddress
                            ? (
                                'Sip, pesanannya akan diantar ke alamat kamu.\n\n' +
                                'Kalau semuanya sudah benar, balas KONFIRMASI ya.'
                              )
                            : (
                                'Sip, pesanannya akan diantar.\n\n' +
                                'Kirim alamat lengkapnya ya. Contoh:\n' +
                                '"antar ke Jl. Merdeka No. 10 Bandung"'
                              )
                };
            }

            /*
             * =================================================
             * PICKUP
             *
             * Lokasi pickup WAJIB berasal dari Merchant
             * canonical product draft, bukan text customer.
             * =================================================
             */
            if (
                !draft.merchant_id
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'merchant_missing',
                    responseText:
                        'Outlet produk ini belum tersedia.'
                };
            }

            if (
                String(
                    draft.merchant_status ||
                    ''
                ).toUpperCase() !==
                'ACTIVE'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'merchant_inactive',
                    responseText:
                        'Outlet produk ini sedang tidak aktif.'
                };
            }

            const storeName =
                String(
                    draft.store_name ||
                    ''
                ).trim();

            const merchantAddress =
                String(
                    draft.merchant_address ||
                    ''
                ).trim();

            if (
                !storeName ||
                !merchantAddress
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return {
                    status:
                        'pickup_location_unavailable',
                    responseText:
                        'Lokasi outlet belum lengkap. Untuk sekarang pilih diantar dulu ya.'
                };
            }

            const pickupLocationSnapshot =
                `${storeName} - ${merchantAddress}`;

            /*
             * Memilih PICKUP:
             * - shipping_address dibersihkan karena tidak dipakai.
             * - pickup_payment dikosongkan supaya customer memilih
             *   ONLINE atau OUTLET secara eksplisit.
             */
            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET
                        fulfillment_type =
                            'PICKUP',
                        fulfillment_selection_explicit =
                            TRUE,
                        pickup_payment =
                            NULL,
                        delivery_payment =
                            NULL,
                        pickup_location_snapshot =
                            $2,
                        shipping_address =
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
                        status
                    `,
                    [
                        draft.id,
                        pickupLocationSnapshot
                    ]
                );

            if (
                updatedResult.rowCount !==
                1
            ) {
                throw new Error(
                    'Draft fulfillment berubah secara bersamaan'
                );
            }

            await client.query(
                'COMMIT'
            );

            const updated =
                updatedResult.rows[0];

            return {
                status:
                    'pickup_selected',
                draft:
                    updated,
                responseText:
                    'Sip, kamu ambil sendiri di outlet ya.\n\n' +
                    `Lokasi:\n${pickupLocationSnapshot}\n\n` +
                    'Mau bayar online atau bayar di outlet pas ambil?'
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
    FulfillmentSelectionHandler;
