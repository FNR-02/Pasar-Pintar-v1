class WhatsAppRetryHealthService {
    constructor(pool) {
        this.pool = pool;
    }

    async getStatus({
        maxAttempts = 5,
        retryAfterSeconds = 60
    } = {}) {
        const safeMaxAttempts =
            Math.max(
                1,
                Math.min(
                    Number(maxAttempts) || 5,
                    20
                )
            );

        const safeRetryAfterSeconds =
            Math.max(
                0,
                Math.min(
                    Number(retryAfterSeconds) || 60,
                    3600
                )
            );

        const deliveryResult =
            await this.pool.query(
                `
                SELECT
                    COUNT(*) FILTER (
                        WHERE status = 'SENT'
                    )::int AS sent,
                    COUNT(*) FILTER (
                        WHERE status = 'FAILED'
                    )::int AS failed,
                    COUNT(*) FILTER (
                        WHERE status = 'FAILED'
                          AND attempts < $1
                          AND updated_at <=
                              CURRENT_TIMESTAMP -
                              ($2 * INTERVAL '1 second')
                    )::int AS retryable,
                    COUNT(*) FILTER (
                        WHERE status = 'FAILED'
                          AND attempts >= $1
                    )::int AS exhausted,
                    MIN(updated_at) FILTER (
                        WHERE status = 'FAILED'
                    ) AS oldest_failure_at,
                    MAX(sent_at) FILTER (
                        WHERE status = 'SENT'
                    ) AS last_sent_at
                FROM tbl_whatsapp_notification_deliveries
                WHERE notification_type = 'AUTO_REPLY'
                `,
                [
                    safeMaxAttempts,
                    safeRetryAfterSeconds
                ]
            );

        const heartbeatResult =
            await this.pool.query(
                `
                SELECT
                    worker_name,
                    status,
                    last_started_at,
                    last_completed_at,
                    last_duration_ms,
                    last_candidates,
                    last_processed,
                    last_sent,
                    last_failed,
                    last_skipped,
                    last_error,
                    updated_at
                FROM tbl_worker_heartbeats
                WHERE worker_name =
                    'whatsapp-auto-reply-retry'
                LIMIT 1
                `
            );

        const delivery =
            deliveryResult.rows[0];

        const worker =
            heartbeatResult.rows[0] || null;

        const heartbeatAgeSeconds =
            worker?.updated_at
                ? Math.max(
                    0,
                    Math.floor(
                        (
                            Date.now() -
                            new Date(worker.updated_at).getTime()
                        ) / 1000
                    )
                )
                : null;

        const workerStale =
            heartbeatAgeSeconds === null ||
            heartbeatAgeSeconds > 180;

        let status =
            'healthy';

        if (
            workerStale ||
            Number(delivery.exhausted) > 0
        ) {
            status =
                'unhealthy';
        } else if (
            Number(delivery.failed) > 0 ||
            worker?.status === 'DEGRADED'
        ) {
            status =
                'degraded';
        }

        return {
            status,
            policy: {
                maxAttempts:
                    safeMaxAttempts,
                retryAfterSeconds:
                    safeRetryAfterSeconds
            },
            autoReply: {
                sent:
                    Number(delivery.sent) || 0,
                failed:
                    Number(delivery.failed) || 0,
                retryable:
                    Number(delivery.retryable) || 0,
                exhausted:
                    Number(delivery.exhausted) || 0,
                oldestFailureAt:
                    delivery.oldest_failure_at || null,
                lastSentAt:
                    delivery.last_sent_at || null
            },
            worker: worker
                ? {
                    status:
                        worker.status,
                    heartbeatAgeSeconds,
                    stale:
                        workerStale,
                    lastStartedAt:
                        worker.last_started_at,
                    lastCompletedAt:
                        worker.last_completed_at,
                    lastDurationMs:
                        worker.last_duration_ms,
                    lastCandidates:
                        worker.last_candidates,
                    lastProcessed:
                        worker.last_processed,
                    lastSent:
                        worker.last_sent,
                    lastFailed:
                        worker.last_failed,
                    lastSkipped:
                        worker.last_skipped,
                    lastError:
                        worker.last_error
                }
                : {
                    status:
                        'UNKNOWN',
                    heartbeatAgeSeconds:
                        null,
                    stale:
                        true
                }
        };
    }
}

module.exports =
    WhatsAppRetryHealthService;
