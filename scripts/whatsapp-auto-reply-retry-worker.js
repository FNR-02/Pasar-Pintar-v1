require('dotenv').config();

const pool =
    require('../src/config/db');

const WhatsAppAutoReplyRetryProcessor =
    require(
        '../src/services/whatsapp/WhatsAppAutoReplyRetryProcessor'
    );

const processor =
    new WhatsAppAutoReplyRetryProcessor(pool);

const INTERVAL_MS =
    Math.max(
        30000,
        Number(
            process.env.WHATSAPP_RETRY_INTERVAL_MS ||
            60000
        )
    );

const BATCH_LIMIT =
    Math.max(
        1,
        Math.min(
            Number(
                process.env.WHATSAPP_RETRY_BATCH_LIMIT ||
                20
            ),
            100
        )
    );

const MAX_ATTEMPTS =
    Math.max(
        1,
        Math.min(
            Number(
                process.env.WHATSAPP_RETRY_MAX_ATTEMPTS ||
                5
            ),
            20
        )
    );

const RETRY_AFTER_SECONDS =
    Math.max(
        0,
        Math.min(
            Number(
                process.env.WHATSAPP_RETRY_AFTER_SECONDS ||
                60
            ),
            3600
        )
    );

let running = false;
let shuttingDown = false;

const WORKER_NAME =
    'whatsapp-auto-reply-retry';

async function markWorkerStarted() {
    await pool.query(
        `
        INSERT INTO tbl_worker_heartbeats (
            worker_name,
            status,
            last_started_at,
            updated_at
        )
        VALUES (
            $1,
            'RUNNING',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT (worker_name)
        DO UPDATE SET
            status = 'RUNNING',
            last_started_at = CURRENT_TIMESTAMP,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        `,
        [WORKER_NAME]
    );
}

async function markWorkerCompleted({
    startedAt,
    result
}) {
    const durationMs =
        Math.max(
            0,
            Date.now() - startedAt
        );

    await pool.query(
        `
        UPDATE tbl_worker_heartbeats
        SET
            status =
                CASE
                    WHEN $3 > 0
                        THEN 'DEGRADED'
                    ELSE 'HEALTHY'
                END,
            last_completed_at = CURRENT_TIMESTAMP,
            last_duration_ms = $2,
            last_candidates = $4,
            last_processed = $5,
            last_sent = $6,
            last_failed = $3,
            last_skipped = $7,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE worker_name = $1
        `,
        [
            WORKER_NAME,
            durationMs,
            Number(result.failed) || 0,
            Number(result.candidates) || 0,
            Number(result.processed) || 0,
            Number(result.sent) || 0,
            Number(result.skipped) || 0
        ]
    );
}

async function markWorkerFailed({
    startedAt,
    error
}) {
    const durationMs =
        Math.max(
            0,
            Date.now() - startedAt
        );

    await pool.query(
        `
        INSERT INTO tbl_worker_heartbeats (
            worker_name,
            status,
            last_started_at,
            last_completed_at,
            last_duration_ms,
            last_error,
            updated_at
        )
        VALUES (
            $1,
            'DEGRADED',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            $2,
            $3,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT (worker_name)
        DO UPDATE SET
            status = 'DEGRADED',
            last_completed_at = CURRENT_TIMESTAMP,
            last_duration_ms = $2,
            last_error = $3,
            updated_at = CURRENT_TIMESTAMP
        `,
        [
            WORKER_NAME,
            durationMs,
            String(
                error?.message ||
                error ||
                'Unknown worker error'
            ).slice(0, 2000)
        ]
    );
}

async function runBatch() {
    if (
        running ||
        shuttingDown
    ) {
        return;
    }

    running = true;

    const startedAt =
        Date.now();

    try {
        await markWorkerStarted();

        const result =
            await processor.processBatch({
                limit:
                    BATCH_LIMIT,
                maxAttempts:
                    MAX_ATTEMPTS,
                retryAfterSeconds:
                    RETRY_AFTER_SECONDS
            });

        await markWorkerCompleted({
            startedAt,
            result
        });

        if (
            result.candidates > 0 ||
            result.failed > 0
        ) {
            console.log(
                '[WHATSAPP RETRY WORKER]',
                JSON.stringify({
                    candidates:
                        result.candidates,
                    processed:
                        result.processed,
                    sent:
                        result.sent,
                    failed:
                        result.failed,
                    skipped:
                        result.skipped
                })
            );
        }
    } catch (err) {
        try {
            await markWorkerFailed({
                startedAt,
                error:
                    err
            });
        } catch (heartbeatErr) {
            console.error(
                '[WHATSAPP RETRY HEARTBEAT ERROR]',
                heartbeatErr.message
            );
        }

        console.error(
            '[WHATSAPP RETRY WORKER ERROR]',
            err.message
        );
    } finally {
        running = false;
    }
}

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `[WHATSAPP RETRY WORKER] ${signal}, shutting down`
    );

    try {
        await pool.end();
    } catch (_) {}

    process.exit(0);
}

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);

async function main() {
    const once =
        process.argv.includes('--once');

    console.log(
        '[WHATSAPP RETRY WORKER] started',
        JSON.stringify({
            once,
            intervalMs:
                INTERVAL_MS,
            batchLimit:
                BATCH_LIMIT,
            maxAttempts:
                MAX_ATTEMPTS,
            retryAfterSeconds:
                RETRY_AFTER_SECONDS
        })
    );

    await runBatch();

    if (once) {
        await pool.end();
        process.exit(0);
    }

    setInterval(
        runBatch,
        INTERVAL_MS
    );
}

main().catch(async err => {
    console.error(
        '[WHATSAPP RETRY WORKER FATAL]',
        err.message
    );

    try {
        await pool.end();
    } catch (_) {}

    process.exit(1);
});
