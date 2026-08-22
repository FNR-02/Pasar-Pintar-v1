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

async function runBatch() {
    if (
        running ||
        shuttingDown
    ) {
        return;
    }

    running = true;

    try {
        const result =
            await processor.processBatch({
                limit:
                    BATCH_LIMIT,
                maxAttempts:
                    MAX_ATTEMPTS,
                retryAfterSeconds:
                    RETRY_AFTER_SECONDS
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
