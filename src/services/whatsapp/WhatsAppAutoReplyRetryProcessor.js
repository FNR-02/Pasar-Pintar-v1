const WhatsAppNotificationDeliveryStore =
    require('./WhatsAppNotificationDeliveryStore');

const WhatsAppOutboundMessageService =
    require('./WhatsAppOutboundMessageService');

class WhatsAppAutoReplyRetryProcessor {
    constructor(pool) {
        this.pool = pool;

        this.deliveryStore =
            new WhatsAppNotificationDeliveryStore(pool);

        this.outboundService =
            new WhatsAppOutboundMessageService();
    }


    async processBatch({
        limit = 20
    } = {}) {
        const safeLimit =
            Math.max(
                1,
                Math.min(
                    Number(limit) || 20,
                    100
                )
            );

        /*
         * Hanya pilih FAILED AUTO_REPLY yang memiliki
         * phone + immutable payload.
         *
         * Claim atomik tetap dilakukan di processOne(),
         * sehingga dua worker paralel tidak akan sama-sama
         * mengirim delivery yang sama.
         */
        const candidates =
            await this.pool.query(
                `
                SELECT
                    event_key
                FROM tbl_whatsapp_notification_deliveries
                WHERE notification_type = 'AUTO_REPLY'
                  AND status = 'FAILED'
                  AND phone IS NOT NULL
                  AND payload_text IS NOT NULL
                  AND payload_text <> ''
                ORDER BY updated_at ASC, created_at ASC
                LIMIT $1
                `,
                [safeLimit]
            );

        const results = [];

        for (const row of candidates.rows) {
            const result =
                await this.processOne({
                    eventKey:
                        row.event_key
                });

            results.push({
                eventKey:
                    row.event_key,
                status:
                    result.status,
                deliveryStatus:
                    result.delivery?.status || null,
                attempts:
                    result.delivery?.attempts || null,
                outboundMessageId:
                    result.delivery?.outbound_message_id || null,
                error:
                    result.error || null
            });
        }

        return {
            status:
                'completed',
            requestedLimit:
                safeLimit,
            candidates:
                candidates.rowCount,
            processed:
                results.length,
            sent:
                results.filter(
                    item => item.status === 'sent'
                ).length,
            failed:
                results.filter(
                    item => item.status === 'failed'
                ).length,
            skipped:
                results.filter(
                    item =>
                        item.status !== 'sent' &&
                        item.status !== 'failed'
                ).length,
            results
        };
    }

    async processOne({
        eventKey
    }) {
        if (!eventKey) {
            throw new Error(
                'eventKey wajib tersedia'
            );
        }

        /*
         * Ambil FAILED AUTO_REPLY.
         * Payload harus berasal dari ledger immutable.
         */
        const existingResult =
            await this.pool.query(
                `
                SELECT
                    event_key,
                    notification_type,
                    customer_id,
                    phone,
                    status,
                    attempts,
                    payload_text
                FROM tbl_whatsapp_notification_deliveries
                WHERE event_key = $1
                  AND notification_type = 'AUTO_REPLY'
                LIMIT 1
                `,
                [eventKey]
            );

        if (!existingResult.rowCount) {
            return {
                status:
                    'not_found'
            };
        }

        const existing =
            existingResult.rows[0];

        if (
            existing.status ===
            'SENT'
        ) {
            return {
                status:
                    'already_sent',
                delivery:
                    existing
            };
        }

        if (
            existing.status !==
            'FAILED'
        ) {
            return {
                status:
                    'not_retryable',
                delivery:
                    existing
            };
        }

        if (
            !existing.phone ||
            !existing.payload_text
        ) {
            return {
                status:
                    'invalid_delivery',
                delivery:
                    existing
            };
        }

        /*
         * Atomic FAILED -> PENDING claim.
         */
        const claim =
            await this.deliveryStore.claim({
                eventKey:
                    existing.event_key,
                notificationType:
                    existing.notification_type,
                customerId:
                    existing.customer_id,
                phone:
                    existing.phone,
                payloadText:
                    existing.payload_text
            });

        if (
            claim.status !==
            'claimed'
        ) {
            return {
                status:
                    'not_claimed',
                delivery:
                    claim.delivery || null
            };
        }

        const delivery =
            claim.delivery;

        try {
            const outbound =
                await this.outboundService
                    .sendText({
                        phone:
                            delivery.phone,
                        text:
                            delivery.payload_text
                    });

            const sent =
                await this.deliveryStore
                    .markSent({
                        deliveryId:
                            delivery.id,
                        outboundMessageId:
                            outbound.messageId || null
                    });

            return {
                status:
                    'sent',
                delivery:
                    sent
            };
        } catch (err) {
            const failed =
                await this.deliveryStore
                    .markFailed({
                        deliveryId:
                            delivery.id,
                        error:
                            err
                    });

            return {
                status:
                    'failed',
                error:
                    err.message,
                delivery:
                    failed
            };
        }
    }
}

module.exports =
    WhatsAppAutoReplyRetryProcessor;
