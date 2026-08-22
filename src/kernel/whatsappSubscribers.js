const CommerceKernel =
    require('./EventKernel');

const pool =
    require('../config/db');

const WhatsAppOutboundMessageService =
    require('../services/whatsapp/WhatsAppOutboundMessageService');

const outboundService =
    new WhatsAppOutboundMessageService();

CommerceKernel.on(
    'ORDER_PAID',
    async (packet) => {
        const order =
            packet?.payload || {};

        const orderId =
            order.id ||
            order.orderId ||
            packet?.aggregateId ||
            null;

        const customerId =
            order.customer_id || null;

        if (!orderId || !customerId) {
            console.error(
                '[WHATSAPP ORDER_PAID] ' +
                'orderId/customerId tidak tersedia'
            );
            return;
        }

        const eventKey =
            `WHATSAPP:ORDER_PAID:${orderId}`;

        let deliveryId = null;

        try {
            /*
             * Resolve Customer hanya jika phone sudah diverifikasi.
             */
            const customerResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        full_name,
                        phone,
                        phone_verified_at
                    FROM tbl_customers
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [customerId]
                );

            if (customerResult.rowCount === 0) {
                console.log(
                    `[WHATSAPP ORDER_PAID] SKIP ${orderId}: ` +
                    'Customer tidak ditemukan'
                );
                return;
            }

            const customer =
                customerResult.rows[0];

            if (
                !customer.phone ||
                !customer.phone_verified_at
            ) {
                console.log(
                    `[WHATSAPP ORDER_PAID] SKIP ${orderId}: ` +
                    'nomor WhatsApp belum terverifikasi'
                );
                return;
            }

            /*
             * Claim delivery secara idempotent.
             *
             * INSERT hanya berhasil pertama kali untuk event_key.
             * Replay ORDER_PAID tidak akan mengirim pesan kedua.
             */
            const claimResult =
                await pool.query(
                    `
                    INSERT INTO
                        tbl_whatsapp_notification_deliveries
                    (
                        event_key,
                        notification_type,
                        order_id,
                        customer_id,
                        phone,
                        status,
                        attempts
                    )
                    VALUES (
                        $1,
                        'ORDER_PAID',
                        $2,
                        $3,
                        $4,
                        'PENDING',
                        1
                    )
                    ON CONFLICT (event_key)
                    DO NOTHING
                    RETURNING id
                    `,
                    [
                        eventKey,
                        orderId,
                        customerId,
                        customer.phone
                    ]
                );

            if (claimResult.rowCount === 0) {
                const existingResult =
                    await pool.query(
                        `
                        SELECT
                            id,
                            status,
                            outbound_message_id,
                            attempts
                        FROM
                            tbl_whatsapp_notification_deliveries
                        WHERE event_key = $1
                        LIMIT 1
                        `,
                        [eventKey]
                    );

                const existing =
                    existingResult.rows[0] || null;

                console.log(
                    `[WHATSAPP ORDER_PAID] SKIP ${orderId}: ` +
                    `delivery sudah ada ` +
                    `(${existing?.status || 'UNKNOWN'})`
                );

                return;
            }

            deliveryId =
                claimResult.rows[0].id;

            const total =
                Number(
                    order.total_amount ||
                    order.amount ||
                    0
                );

            const name =
                String(
                    customer.full_name || ''
                ).trim();

            const lines = [
                name
                    ? `Halo ${name} 👋`
                    : 'Halo 👋',
                '',
                'Pembayaran berhasil diterima ✅',
                '',
                `Order: ${orderId}`,
                `Total: Rp ${total.toLocaleString('id-ID')}`,
                'Status pembayaran: PAID',
                '',
                'Pesanan Anda sedang diproses.'
            ];

            const outboundResult =
                await outboundService.sendText({
                    phone:
                        customer.phone,
                    text:
                        lines.join('\n')
                });

            await pool.query(
                `
                UPDATE
                    tbl_whatsapp_notification_deliveries
                SET
                    status = 'SENT',
                    outbound_message_id = $2,
                    sent_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP,
                    last_error = NULL
                WHERE id = $1
                `,
                [
                    deliveryId,
                    outboundResult.messageId || null
                ]
            );

            console.log(
                `[WHATSAPP ORDER_PAID] SENT ${orderId} ` +
                `${outboundResult.messageId || ''}`
            );
        } catch (err) {
            console.error(
                `[WHATSAPP ORDER_PAID ERROR] ${orderId}:`,
                err.message
            );

            if (deliveryId) {
                try {
                    await pool.query(
                        `
                        UPDATE
                            tbl_whatsapp_notification_deliveries
                        SET
                            status = 'FAILED',
                            last_error = $2,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = $1
                        `,
                        [
                            deliveryId,
                            String(err.message || err)
                                .slice(0, 2000)
                        ]
                    );
                } catch (updateErr) {
                    console.error(
                        '[WHATSAPP DELIVERY UPDATE ERROR]',
                        updateErr.message
                    );
                }
            }
        }
    }
);

console.log(
    '[WHATSAPP SUBSCRIBER] ORDER_PAID subscriber aktif'
);
