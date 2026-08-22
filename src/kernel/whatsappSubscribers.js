const CommerceKernel =
    require('./EventKernel');

const pool =
    require('../config/db');

const WhatsAppOutboundMessageService =
    require('../services/whatsapp/WhatsAppOutboundMessageService');
const WhatsAppNotificationDeliveryStore =
    require('../services/whatsapp/WhatsAppNotificationDeliveryStore');

const outboundService =
    new WhatsAppOutboundMessageService();

const deliveryStore =
    new WhatsAppNotificationDeliveryStore(pool);

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
            const claim =
                await deliveryStore.claim({
                    eventKey,
                    notificationType:
                        'ORDER_PAID',
                    orderId,
                    customerId,
                    phone:
                        customer.phone
                });

            if (
                claim.status !== 'claimed' ||
                !claim.delivery
            ) {
                console.log(
                    `[WHATSAPP ORDER_PAID] SKIP ${orderId}: ` +
                    `delivery sudah ada ` +
                    `(${claim.delivery?.status || 'UNKNOWN'})`
                );
                return;
            }

            deliveryId =
                claim.delivery.id;

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

            await deliveryStore.markSent({
                deliveryId,
                outboundMessageId:
                    outboundResult.messageId || null
            });

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
                    await deliveryStore.markFailed({
                        deliveryId,
                        error: err
                    });
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

async function sendLifecycleNotification({
    eventKey,
    notificationType,
    orderId,
    textBuilder
}) {
    if (!orderId) {
        console.error(
            `[WHATSAPP ${notificationType}] orderId tidak tersedia`
        );
        return;
    }

    let deliveryId = null;

    try {
        const orderResult =
            await pool.query(
                `
                SELECT
                    o.id,
                    o.customer_id,
                    o.status,
                    o.total_amount,
                    c.full_name,
                    c.phone,
                    c.phone_verified_at,
                    (
                        SELECT s.tracking_number
                        FROM tbl_shipments s
                        WHERE s.order_id = o.id
                        ORDER BY s.updated_at DESC NULLS LAST
                        LIMIT 1
                    ) AS tracking_number
                FROM tbl_orders_v2 o
                JOIN tbl_customers c
                    ON c.id = o.customer_id
                WHERE o.id = $1
                LIMIT 1
                `,
                [orderId]
            );

        if (!orderResult.rowCount) {
            console.log(
                `[WHATSAPP ${notificationType}] SKIP ${orderId}: ` +
                'order/customer tidak ditemukan'
            );
            return;
        }

        const row =
            orderResult.rows[0];

        if (
            !row.phone ||
            !row.phone_verified_at
        ) {
            console.log(
                `[WHATSAPP ${notificationType}] SKIP ${orderId}: ` +
                'nomor WhatsApp belum terverifikasi'
            );
            return;
        }

        const claim =
            await deliveryStore.claim({
                eventKey,
                notificationType,
                orderId,
                customerId:
                    row.customer_id,
                phone:
                    row.phone
            });

        if (
            claim.status !== 'claimed' ||
            !claim.delivery
        ) {
            console.log(
                `[WHATSAPP ${notificationType}] SKIP ${orderId}: ` +
                `delivery sudah ada ` +
                `(${claim.delivery?.status || 'UNKNOWN'})`
            );
            return;
        }

        deliveryId =
            claim.delivery.id;

        const outboundResult =
            await outboundService.sendText({
                phone:
                    row.phone,
                text:
                    textBuilder(row)
            });

        await deliveryStore.markSent({
            deliveryId,
            outboundMessageId:
                outboundResult.messageId || null
        });

        console.log(
            `[WHATSAPP ${notificationType}] SENT ${orderId} ` +
            `${outboundResult.messageId || ''}`
        );
    } catch (err) {
        console.error(
            `[WHATSAPP ${notificationType} ERROR] ${orderId}:`,
            err.message
        );

        if (deliveryId) {
            try {
                await deliveryStore.markFailed({
                    deliveryId,
                    error: err
                });
            } catch (updateErr) {
                console.error(
                    '[WHATSAPP DELIVERY UPDATE ERROR]',
                    updateErr.message
                );
            }
        }
    }
}

/*
 * Merchant menyerahkan order ke courier.
 */
CommerceKernel.on(
    'ORDER_STATUS_CHANGED',
    async (packet) => {
        const payload =
            packet?.payload || {};

        if (
            String(
                payload.new_status || ''
            ).toUpperCase() !== 'DISPATCHED'
        ) {
            return;
        }

        const orderId =
            payload.orderId ||
            packet?.aggregateId ||
            null;

        await sendLifecycleNotification({
            eventKey:
                `WHATSAPP:ORDER_DISPATCHED:${orderId}`,
            notificationType:
                'ORDER_DISPATCHED',
            orderId,
            textBuilder: row => {
                const name =
                    String(
                        row.full_name || ''
                    ).trim();

                const lines = [
                    name
                        ? `Halo ${name} 👋`
                        : 'Halo 👋',
                    '',
                    'Pesanan Anda sudah diserahkan ke kurir 🚚',
                    '',
                    `Order: ${row.id}`,
                    'Status: Dalam pengiriman'
                ];

                if (row.tracking_number) {
                    lines.push(
                        `Nomor tracking: ${row.tracking_number}`,
                        '',
                        'Silakan simpan nomor tracking ini.'
                    );
                }

                return lines.join('\n');
            }
        });
    }
);

/*
 * Courier menyelesaikan pengiriman.
 */
CommerceKernel.on(
    'DELIVERY_COMPLETED',
    async (packet) => {
        const payload =
            packet?.payload || {};

        if (
            String(
                payload.newOrderStatus || ''
            ).toUpperCase() !== 'DELIVERED'
        ) {
            return;
        }

        const orderId =
            payload.orderId || null;

        await sendLifecycleNotification({
            eventKey:
                `WHATSAPP:ORDER_DELIVERED:${orderId}`,
            notificationType:
                'ORDER_DELIVERED',
            orderId,
            textBuilder: row => {
                const name =
                    String(
                        row.full_name || ''
                    ).trim();

                const lines = [
                    name
                        ? `Halo ${name} 👋`
                        : 'Halo 👋',
                    '',
                    'Pesanan Anda telah diterima ✅',
                    '',
                    `Order: ${row.id}`,
                    'Status: DELIVERED',
                    '',
                    'Terima kasih telah menggunakan Pasar Pintar.'
                ];

                return lines.join('\n');
            }
        });
    }
);

console.log(
    '[WHATSAPP SUBSCRIBER] lifecycle subscribers aktif'
);
