class WhatsAppInboundMessageStore {
    constructor(pool) {
        this.pool = pool;
    }

    async claim({
        messageId,
        phone = null
    }) {
        if (!messageId) {
            const err =
                new Error(
                    'messageId wajib tersedia untuk inbound WhatsApp'
                );

            err.code =
                'MESSAGE_ID_REQUIRED';

            throw err;
        }

        /*
         * Atomic claim.
         *
         * 1. Message baru:
         *      INSERT PROCESSING / attempts=1
         *
         * 2. FAILED:
         *      claim ulang → PROCESSING / attempts+1
         *
         * 3. PROCESSING stale >5 menit:
         *      boleh direclaim setelah kemungkinan worker lama mati
         *
         * 4. PROCESSING aktif / PROCESSED:
         *      tidak berubah dan tidak dikembalikan RETURNING.
         */
        const result =
            await this.pool.query(
                `
                INSERT INTO tbl_whatsapp_inbound_messages (
                    message_id,
                    phone,
                    status,
                    attempts,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    'PROCESSING',
                    1,
                    CURRENT_TIMESTAMP
                )

                ON CONFLICT (message_id)
                DO UPDATE SET
                    phone =
                        COALESCE(
                            EXCLUDED.phone,
                            tbl_whatsapp_inbound_messages.phone
                        ),

                    status =
                        'PROCESSING',

                    attempts =
                        tbl_whatsapp_inbound_messages.attempts + 1,

                    last_error =
                        NULL,

                    updated_at =
                        CURRENT_TIMESTAMP

                WHERE
                    tbl_whatsapp_inbound_messages.status = 'FAILED'

                    OR (
                        tbl_whatsapp_inbound_messages.status = 'PROCESSING'
                        AND
                        tbl_whatsapp_inbound_messages.updated_at <
                            CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                    )

                RETURNING
                    id,
                    message_id,
                    phone,
                    status,
                    attempts,
                    created_at,
                    updated_at
                `,
                [
                    messageId,
                    phone
                ]
            );

        if (result.rowCount > 0) {
            return {
                status: 'claimed',
                delivery:
                    result.rows[0]
            };
        }

        const existingResult =
            await this.pool.query(
                `
                SELECT
                    id,
                    message_id,
                    phone,
                    status,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    processed_at
                FROM tbl_whatsapp_inbound_messages
                WHERE message_id = $1
                LIMIT 1
                `,
                [messageId]
            );

        return {
            status: 'duplicate',
            delivery:
                existingResult.rows[0] || null
        };
    }

    async markProcessed({
        deliveryId
    }) {
        if (!deliveryId) {
            throw new Error(
                'deliveryId wajib tersedia'
            );
        }

        const result =
            await this.pool.query(
                `
                UPDATE tbl_whatsapp_inbound_messages
                SET
                    status = 'PROCESSED',
                    processed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP,
                    last_error = NULL
                WHERE id = $1
                  AND status = 'PROCESSING'
                RETURNING
                    id,
                    message_id,
                    status,
                    attempts,
                    processed_at
                `,
                [deliveryId]
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

        const message =
            String(
                error?.message ||
                error ||
                'Unknown inbound processing failure'
            ).slice(0, 2000);

        const result =
            await this.pool.query(
                `
                UPDATE tbl_whatsapp_inbound_messages
                SET
                    status = 'FAILED',
                    last_error = $2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status = 'PROCESSING'
                RETURNING
                    id,
                    message_id,
                    status,
                    attempts,
                    last_error
                `,
                [
                    deliveryId,
                    message
                ]
            );

        return result.rows[0] || null;
    }
}

module.exports =
    WhatsAppInboundMessageStore;
