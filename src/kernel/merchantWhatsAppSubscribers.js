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

async function notifyMerchantOrderActionable(
    packet,
    sourceEvent
) {
    const order =
        packet?.payload || {};

    const orderId =
        order.id ||
        order.orderId ||
        packet?.aggregateId ||
        null;

    if (!orderId) {
        console.error(
            '[WHATSAPP MERCHANT ORDER_ACTIONABLE] ' +
            'orderId tidak tersedia'
        );
        return;
    }

    const eventKey =
        `WHATSAPP:MERCHANT:ORDER_ACTIONABLE:${orderId}`;

    let deliveryId = null;

    try {
        const result =
            await pool.query(
                `
                SELECT
                    o.id,
                    o.market_order_id,
                    o.merchant_id,
                    o.total_amount,
                    o.fulfillment_type,
                    o.payment_mode,
                    m.store_name,
                    m.phone,

                    pmt.provider,
                    pmt.payment_method,
                    pmt.payment_status,

                    COALESCE(
                        json_agg(
                            json_build_object(
                                'name', pr.name,
                                'quantity', oi.quantity,
                                'unit_price', oi.unit_price
                            )
                            ORDER BY pr.name
                        ) FILTER (
                            WHERE oi.id IS NOT NULL
                        ),
                        '[]'::json
                    ) AS items

                FROM tbl_orders_v2 o

                JOIN tbl_merchants m
                  ON m.id = o.merchant_id

                LEFT JOIN LATERAL (
                    SELECT
                        p.provider,
                        p.payment_method,
                        p.payment_status
                    FROM tbl_payments p
                    WHERE p.order_id = o.id
                    ORDER BY p.created_at DESC
                    LIMIT 1
                ) pmt
                  ON TRUE

                LEFT JOIN tbl_order_items oi
                  ON oi.order_id = o.id

                LEFT JOIN tbl_products pr
                  ON pr.id = oi.product_id

                WHERE o.id = $1
                  AND m.status = 'ACTIVE'

                GROUP BY
                    o.id,
                    m.id,
                    m.store_name,
                    m.phone,
                    pmt.provider,
                    pmt.payment_method,
                    pmt.payment_status

                LIMIT 1
                `,
                [orderId]
            );

        if (!result.rowCount) {
            console.log(
                `[WHATSAPP MERCHANT ORDER_ACTIONABLE] SKIP ${orderId}: ` +
                'merchant/order tidak ditemukan'
            );
            return;
        }

        const row =
            result.rows[0];

        const fulfillmentType =
            String(
                row.fulfillment_type || ''
            ).toUpperCase();

        const provider =
            String(
                row.provider || ''
            ).toUpperCase();

        const paymentMethod =
            String(
                row.payment_method || ''
            ).toUpperCase();

        const paymentStatus =
            String(
                row.payment_status || ''
            ).toUpperCase();

        const isPayAtOutlet =
            fulfillmentType === 'PICKUP' &&
            provider === 'OUTLET' &&
            paymentMethod === 'PAY_AT_OUTLET';

        /*
         * ORDER_CREATED hanya actionable langsung untuk
         * PICKUP + PAY_AT_OUTLET.
         */
        if (
            sourceEvent === 'ORDER_CREATED' &&
            !isPayAtOutlet
        ) {
            return;
        }

        /*
         * PAY_AT_OUTLET sudah actionable sejak ORDER_CREATED.
         * ORDER_PAID berikutnya tidak boleh mengirim ulang.
         */
        if (
            sourceEvent === 'ORDER_PAID' &&
            isPayAtOutlet
        ) {
            return;
        }

        /*
         * Jalur ORDER_PAID lainnya harus benar-benar PAID.
         */
        if (
            sourceEvent === 'ORDER_PAID' &&
            paymentStatus !== 'PAID'
        ) {
            console.log(
                `[WHATSAPP MERCHANT ORDER_ACTIONABLE] SKIP ${orderId}: ` +
                `payment status ${paymentStatus || 'UNKNOWN'}`
            );
            return;
        }

        if (!row.phone) {
            console.log(
                `[WHATSAPP MERCHANT ORDER_ACTIONABLE] SKIP ${orderId}: ` +
                'nomor merchant tidak tersedia'
            );
            return;
        }

        const items =
            Array.isArray(row.items)
                ? row.items
                : [];

        const lines = [
            `Halo ${row.store_name || 'Merchant'} 👋`,
            '',
            'Ada pesanan baru yang harus disiapkan.',
            '',
            `Order: ${row.id}`,
            ''
        ];

        for (const item of items) {
            const quantity =
                Number(item.quantity || 0);

            const name =
                String(
                    item.name || 'Produk'
                );

            lines.push(
                `- ${quantity}x ${name}`
            );
        }

        lines.push(
            '',
            `Total: Rp ${Number(
                row.total_amount || 0
            ).toLocaleString('id-ID')}`,
            `Pengantaran: ${
                row.fulfillment_type || '-'
            }`,
            '',
            'Silakan buka Pasar Pintar untuk memproses pesanan.'
        );

        const text =
            lines.join('\n');

        const claim =
            await deliveryStore.claim({
                eventKey,
                notificationType:
                    'MERCHANT_ORDER_ACTIONABLE',
                orderId:
                    row.id,
                marketOrderId:
                    row.market_order_id,
                customerId:
                    null,
                merchantId:
                    row.merchant_id,
                phone:
                    row.phone,
                payloadText:
                    text
            });

        if (
            claim.status !== 'claimed' ||
            !claim.delivery
        ) {
            console.log(
                `[WHATSAPP MERCHANT ORDER_ACTIONABLE] SKIP ${orderId}: ` +
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
                text
            });

        await deliveryStore.markSent({
            deliveryId,
            outboundMessageId:
                outboundResult.messageId || null
        });

        console.log(
            `[WHATSAPP MERCHANT ORDER_ACTIONABLE] SENT ${orderId} ` +
            `via ${sourceEvent}`
        );
    } catch (err) {
        console.error(
            `[WHATSAPP MERCHANT ORDER_ACTIONABLE ERROR] ${orderId}:`,
            err.message
        );

        if (deliveryId) {
            try {
                await deliveryStore.markFailed({
                    deliveryId,
                    error:
                        err
                });
            } catch (updateErr) {
                console.error(
                    '[WHATSAPP MERCHANT DELIVERY UPDATE ERROR]',
                    updateErr.message
                );
            }
        }
    }
}

CommerceKernel.on(
    'ORDER_CREATED',
    async (packet) => {
        await notifyMerchantOrderActionable(
            packet,
            'ORDER_CREATED'
        );
    }
);

CommerceKernel.on(
    'ORDER_PAID',
    async (packet) => {
        await notifyMerchantOrderActionable(
            packet,
            'ORDER_PAID'
        );
    }
);

console.log(
    '[WHATSAPP SUBSCRIBER] MERCHANT ORDER_ACTIONABLE subscriber aktif'
);

module.exports = {
    notifyMerchantOrderActionable
};
