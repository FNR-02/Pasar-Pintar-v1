class WhatsAppInboundRecoveryProcessor {
    constructor(pool) {
        this.pool = pool;

        this.port =
            Number(process.env.PORT || 3000);

        this.webhookSecret =
            String(
                process.env.EVOLUTION_WEBHOOK_SECRET || ''
            ).trim();
    }

    async getFailed({ messageId }) {
        if (!messageId) {
            throw new Error(
                'messageId wajib tersedia'
            );
        }

        const result =
            await this.pool.query(
                `
                SELECT
                    message_id,
                    payload_json,
                    event_name,
                    sender_jid,
                    status,
                    attempts,
                    last_error,
                    updated_at
                FROM tbl_whatsapp_inbound_messages
                WHERE message_id = $1
                  AND status = 'FAILED'
                LIMIT 1
                `,
                [messageId]
            );

        if (!result.rowCount) {
            return {
                status: 'not_found'
            };
        }

        const row = result.rows[0];

        if (!row.payload_json) {
            return {
                status: 'payload_missing',
                messageId: row.message_id
            };
        }

        return {
            status: 'ready',
            messageId: row.message_id,
            payload: row.payload_json,
            attempts: row.attempts
        };
    }

    async processBatch({
        limit = 20,
        maxAttempts = 5,
        retryAfterSeconds = 60
    } = {}) {
        const safeLimit =
            Math.max(1, Math.min(Number(limit) || 20, 100));
        const safeMaxAttempts =
            Math.max(1, Math.min(Number(maxAttempts) || 5, 20));
        const safeRetryAfter =
            Math.max(0, Math.min(Number(retryAfterSeconds) || 60, 3600));

        const result =
            await this.pool.query(
                `
                SELECT message_id
                FROM tbl_whatsapp_inbound_messages
                WHERE status = 'FAILED'
                  AND payload_json IS NOT NULL
                  AND attempts < $2
                  AND updated_at <=
                      CURRENT_TIMESTAMP -
                      ($3 * INTERVAL '1 second')
                ORDER BY updated_at ASC
                LIMIT $1
                `,
                [
                    safeLimit,
                    safeMaxAttempts,
                    safeRetryAfter
                ]
            );

        const results = [];

        for (const row of result.rows) {
            try {
                results.push(
                    await this.processOne({
                        messageId: row.message_id
                    })
                );
            } catch (err) {
                results.push({
                    status: 'failed',
                    messageId: row.message_id,
                    error: err.message
                });
            }
        }

        return {
            status: 'completed',
            candidates: result.rowCount,
            processed: results.length,
            recovered:
                results.filter(
                    item => item.status === 'recovered'
                ).length,
            results
        };
    }

    async processOne({ messageId }) {
        const failed =
            await this.getFailed({
                messageId
            });

        if (failed.status !== 'ready') {
            return failed;
        }

        if (!this.webhookSecret) {
            throw new Error(
                'EVOLUTION_WEBHOOK_SECRET tidak tersedia'
            );
        }

        const response =
            await fetch(
                `http://127.0.0.1:${this.port}` +
                '/api/integrations/evolution/webhook',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json',
                        'x-pasar-pintar-webhook-secret':
                            this.webhookSecret
                    },
                    body:
                        JSON.stringify(
                            failed.payload
                        )
                }
            );

        let body = null;

        try {
            body = await response.json();
        } catch {
            body = null;
        }

        const stateResult =
            await this.pool.query(
                `
                SELECT
                    status,
                    attempts,
                    last_error,
                    processed_at
                FROM tbl_whatsapp_inbound_messages
                WHERE message_id = $1
                LIMIT 1
                `,
                [messageId]
            );

        const state =
            stateResult.rows[0] || null;

        return {
            status:
                state?.status === 'PROCESSED'
                    ? 'recovered'
                    : 'not_recovered',
            httpStatus:
                response.status,
            messageId,
            inboundStatus:
                state?.status || null,
            attempts:
                state?.attempts || null,
            lastError:
                state?.last_error || null,
            response:
                body
        };
    }
}

module.exports =
    WhatsAppInboundRecoveryProcessor;
