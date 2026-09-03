const {
    notifyMerchantOrderActionable
} = require('../../kernel/merchantWhatsAppSubscribers');

class MerchantOrderActionableRecoveryProcessor {
    constructor(pool) {
        this.pool = pool;
    }

    async findCandidates({
        limit = 20,
        maxAttempts = 5,
        retryAfterSeconds = 60
    } = {}) {
        const safeLimit =
            Math.max(
                1,
                Math.min(Number(limit) || 20, 100)
            );

        const safeMaxAttempts =
            Math.max(
                1,
                Math.min(Number(maxAttempts) || 5, 20)
            );

        const safeRetryAfterSeconds =
            Math.max(
                0,
                Math.min(
                    Number(retryAfterSeconds) || 60,
                    3600
                )
            );

        const result =
            await this.pool.query(
                `
                SELECT
                    o.id
                FROM tbl_orders_v2 o
                JOIN tbl_merchants m
                  ON m.id = o.merchant_id
                 AND m.status = 'ACTIVE'
                 AND m.phone IS NOT NULL
                 AND BTRIM(m.phone) <> ''
                JOIN LATERAL (
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
                LEFT JOIN
                    tbl_whatsapp_notification_deliveries wd
                  ON wd.event_key =
                    'WHATSAPP:MERCHANT:ORDER_ACTIONABLE:' ||
                    o.id::text
                WHERE o.fulfillment_type = 'PICKUP'
                  AND o.payment_mode = 'DIRECT'
                  AND o.status IN (
                      'PENDING',
                      'PACKING',
                      'DISPATCHED'
                  )
                  AND pmt.provider = 'OUTLET'
                  AND pmt.payment_method = 'PAY_AT_OUTLET'
                  AND pmt.payment_status = 'UNPAID'
                  AND EXISTS (
                      SELECT 1
                      FROM tbl_inventory_reservations r
                      WHERE r.order_id = o.id
                        AND r.status = 'RESERVED'
                        AND (
                            r.expires_at IS NULL
                            OR r.expires_at > CURRENT_TIMESTAMP
                        )
                  )
                  AND (
                      wd.id IS NULL
                      OR (
                          wd.notification_type =
                              'MERCHANT_ORDER_ACTIONABLE'
                          AND wd.status = 'FAILED'
                          AND wd.attempts < $2
                          AND wd.updated_at <=
                              CURRENT_TIMESTAMP -
                              ($3 * INTERVAL '1 second')
                      )
                  )
                ORDER BY o.created_at ASC
                LIMIT $1
                `,
                [
                    safeLimit,
                    safeMaxAttempts,
                    safeRetryAfterSeconds
                ]
            );

        return result.rows;
    }

    async processOne({ orderId }) {
        if (!orderId) {
            throw new Error(
                'orderId wajib tersedia'
            );
        }

        await notifyMerchantOrderActionable(
            {
                aggregateId:
                    orderId,
                payload: {
                    id:
                        orderId
                }
            },
            'ORDER_CREATED'
        );

        const result =
            await this.pool.query(
                `
                SELECT
                    status,
                    attempts,
                    outbound_message_id,
                    last_error
                FROM tbl_whatsapp_notification_deliveries
                WHERE event_key =
                    'WHATSAPP:MERCHANT:ORDER_ACTIONABLE:' ||
                    $1::text
                LIMIT 1
                `,
                [orderId]
            );

        if (!result.rowCount) {
            return {
                status:
                    'not_recovered',
                orderId
            };
        }

        const delivery =
            result.rows[0];

        return {
            status:
                delivery.status === 'SENT'
                    ? 'recovered'
                    : 'not_recovered',
            orderId,
            deliveryStatus:
                delivery.status,
            attempts:
                delivery.attempts,
            error:
                delivery.last_error || null
        };
    }

    async processBatch(options = {}) {
        const candidates =
            await this.findCandidates(options);

        const results = [];

        for (const row of candidates) {
            try {
                results.push(
                    await this.processOne({
                        orderId:
                            row.id
                    })
                );
            } catch (err) {
                results.push({
                    status:
                        'failed',
                    orderId:
                        row.id,
                    error:
                        err.message
                });
            }
        }

        return {
            status:
                'completed',
            candidates:
                candidates.length,
            processed:
                results.length,
            recovered:
                results.filter(
                    item =>
                        item.status === 'recovered'
                ).length,
            failed:
                results.filter(
                    item =>
                        item.status === 'failed'
                ).length,
            skipped:
                results.filter(
                    item =>
                        item.status !== 'recovered' &&
                        item.status !== 'failed'
                ).length,
            results
        };
    }
}

module.exports =
    MerchantOrderActionableRecoveryProcessor;
