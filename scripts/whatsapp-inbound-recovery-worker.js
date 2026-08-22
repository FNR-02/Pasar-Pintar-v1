require('dotenv').config();

const pool =
    require('../src/config/db');

const WhatsAppInboundRecoveryProcessor =
    require(
        '../src/services/whatsapp/WhatsAppInboundRecoveryProcessor'
    );

const processor =
    new WhatsAppInboundRecoveryProcessor(pool);

const INTERVAL_MS =
    Math.max(
        30000,
        Number(
            process.env.WHATSAPP_INBOUND_RECOVERY_INTERVAL_MS ||
            60000
        )
    );

const BATCH_LIMIT =
    Math.max(
        1,
        Math.min(
            Number(
                process.env.WHATSAPP_INBOUND_RECOVERY_BATCH_LIMIT ||
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
                process.env.WHATSAPP_INBOUND_RECOVERY_MAX_ATTEMPTS ||
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
                process.env.WHATSAPP_INBOUND_RECOVERY_AFTER_SECONDS ||
                60
            ),
            3600
        )
    );

const ONCE =
    process.argv.includes('--once');

let running = false;
let shuttingDown = false;

const WORKER_NAME =
    'whatsapp-inbound-recovery';

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
            updated_at = CURRENT_TIMESTAMP
        `,
        [WORKER_NAME]
    );
}

async function markWorkerCompleted(result, durationMs) {
    await pool.query(
        `
        UPDATE tbl_worker_heartbeats
        SET
            status = 'HEALTHY',
            last_completed_at = CURRENT_TIMESTAMP,
            last_duration_ms = $2,
            last_candidates = $3,
            last_processed = $4,
            last_sent = $5,
            last_failed = $6,
            last_skipped = $7,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE worker_name = $1
        `,
        [
            WORKER_NAME,
            durationMs,
            result.candidates || 0,
            result.processed || 0,
            result.recovered || 0,
            0,
            Math.max(
                0,
                (result.processed || 0) -
                (result.recovered || 0)
            )
        ]
    );
}

async function markWorkerFailed(err) {
    await pool.query(
        `
        INSERT INTO tbl_worker_heartbeats (
            worker_name,
            status,
            last_error,
            updated_at
        )
        VALUES (
            $1,
            'DEGRADED',
            $2,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT (worker_name)
        DO UPDATE SET
            status = 'DEGRADED',
            last_error = EXCLUDED.last_error,
            updated_at = CURRENT_TIMESTAMP
        `,
        [
            WORKER_NAME,
            String(err?.message || err)
                .slice(0, 2000)
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
    const startedAt = Date.now();

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

        await markWorkerCompleted(
            result,
            Date.now() - startedAt
        );

        if (
            result.candidates > 0
        ) {
            console.log(
                '[WHATSAPP INBOUND RECOVERY]',
                JSON.stringify({
                    candidates:
                        result.candidates,
                    processed:
                        result.processed,
                    recovered:
                        result.recovered
                })
            );
        }
    } catch (err) {
        try {
            await markWorkerFailed(err);
        } catch (heartbeatErr) {
            console.error(
                '[WHATSAPP INBOUND HEARTBEAT ERROR]',
                heartbeatErr.message
            );
        }

        console.error(
            '[WHATSAPP INBOUND RECOVERY ERROR]',
            err.message
        );

        if (ONCE) {
            process.exitCode = 1;
        }
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
        `[WHATSAPP INBOUND RECOVERY] ${signal}`
    );

    try {
        await pool.end();
    } finally {
        process.exit(0);
    }
}

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);

(async () => {
    console.log(
        '[WHATSAPP INBOUND RECOVERY] started ' +
        JSON.stringify({
            once:
                ONCE,
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

    if (ONCE) {
        await pool.end();
        return;
    }

    setInterval(
        runBatch,
        INTERVAL_MS
    );
})();
