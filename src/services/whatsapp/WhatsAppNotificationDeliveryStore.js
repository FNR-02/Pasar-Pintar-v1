class WhatsAppNotificationDeliveryStore {
    constructor(pool) {
        this.pool = pool;
    }

    async claim({
        eventKey,
        notificationType,
        orderId,
        customerId,
        phone,
        payloadText = null
    }) {
        if (
            !eventKey ||
            !notificationType
        ) {
            const err = new Error(
                'eventKey dan notificationType wajib tersedia'
            );

            err.code =
                'INVALID_NOTIFICATION_DELIVERY_INPUT';

            throw err;
        }

        /*
         * Satu statement atomik:
         *
         * - Event baru:
         *      INSERT PENDING / attempts = 1
         *
         * - Event FAILED:
         *      claim ulang menjadi PENDING / attempts + 1
         *
         * - Event SENT atau PENDING:
         *      tidak diubah dan RETURNING kosong
         *
         * Dengan unique event_key, dua retry paralel tidak dapat
         * sama-sama memperoleh claim.
         */
        const result =
            await this.pool.query(
                `
                INSERT INTO
                    tbl_whatsapp_notification_deliveries
                (
                    event_key,
                    notification_type,
                    order_id,
                    customer_id,
                    phone,
                    payload_text,
                    status,
                    attempts,
                    last_error,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    'PENDING',
                    1,
                    NULL,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (event_key)
                DO UPDATE SET
                    status = 'PENDING',
                    attempts =
                        tbl_whatsapp_notification_deliveries.attempts + 1,
                    phone =
                        EXCLUDED.phone,
                    payload_text =
                        COALESCE(
                            tbl_whatsapp_notification_deliveries.payload_text,
                            EXCLUDED.payload_text
                        ),
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE
                    tbl_whatsapp_notification_deliveries.status =
                        'FAILED'
                RETURNING
                    id,
                    event_key,
                    notification_type,
                    order_id,
                    customer_id,
                    phone,
                    payload_text,
                    status,
                    attempts,
                    outbound_message_id,
                    last_error,
                    created_at,
                    updated_at,
                    sent_at
                `,
                [
                    eventKey,
                    notificationType,
                    orderId || null,
                    customerId || null,
                    phone || null,
                    payloadText !== null
                        ? String(payloadText)
                        : null
                ]
            );

        if (result.rowCount > 0) {
            return {
                status: 'claimed',
                delivery: result.rows[0]
            };
        }

        const existingResult =
            await this.pool.query(
                `
                SELECT
                    id,
                    event_key,
                    notification_type,
                    order_id,
                    customer_id,
                    phone,
                    payload_text,
                    status,
                    attempts,
                    outbound_message_id,
                    last_error,
                    created_at,
                    updated_at,
                    sent_at
                FROM
                    tbl_whatsapp_notification_deliveries
                WHERE event_key = $1
                LIMIT 1
                `,
                [eventKey]
            );

        return {
            status: 'not_claimed',
            delivery:
                existingResult.rows[0] || null
        };
    }

    async markSent({
        deliveryId,
        outboundMessageId
    }) {
        if (!deliveryId) {
            throw new Error(
                'deliveryId wajib tersedia'
            );
        }

        const result =
            await this.pool.query(
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
                  AND status = 'PENDING'
                RETURNING *
                `,
                [
                    deliveryId,
                    outboundMessageId || null
                ]
            );

        return result.rows[0] || null;
    }

    async markFailed({
        deliveryId,
        error
    }) {
        if (!deliveryId) {
            throw new Error(
                'deliveryId wajib tersedia'
            );
        }

        const result =
            await this.pool.query(
                `
                UPDATE
                    tbl_whatsapp_notification_deliveries
                SET
                    status = 'FAILED',
                    last_error = $2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'PENDING'
                RETURNING *
                `,
                [
                    deliveryId,
                    String(
                        error?.message ||
                        error ||
                        'Unknown WhatsApp delivery error'
                    ).slice(0, 2000)
                ]
            );

        return result.rows[0] || null;
    }
}

module.exports =
    WhatsAppNotificationDeliveryStore;
