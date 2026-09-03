require('dotenv').config();

const pool =
    require('../src/config/db');

const PickupPayAtOutletExpiryService =
    require(
        '../src/services/orders/PickupPayAtOutletExpiryService'
    );

const service =
    new PickupPayAtOutletExpiryService(pool);

const INTERVAL_MS =
    Math.max(
        30000,
        Number(
            process.env
                .PICKUP_PAY_AT_OUTLET_EXPIRY_INTERVAL_MS ||
            60000
        )
    );

const BATCH_LIMIT =
    Math.max(
        1,
        Math.min(
            Number(
                process.env
                    .PICKUP_PAY_AT_OUTLET_EXPIRY_BATCH_LIMIT ||
                20
            ),
            100
        )
    );

const ONCE =
    process.argv.includes('--once');

let running = false;
let shuttingDown = false;

async function runBatch() {
    if (running || shuttingDown) {
        return;
    }

    running = true;

    try {
        const rows =
            await service.findExpired(
                BATCH_LIMIT
            );

        let expired = 0;
        let skipped = 0;
        let failed = 0;

        for (const row of rows) {
            try {
                const result =
                    await service.expireOrder(
                        row.order_id
                    );

                if (
                    result.status ===
                    'expired'
                ) {
                    expired += 1;
                } else {
                    skipped += 1;
                }
            } catch (err) {
                failed += 1;

                console.error(
                    '[PICKUP PAY AT OUTLET EXPIRY ITEM ERROR]',
                    JSON.stringify({
                        orderId:
                            row.order_id,
                        error:
                            err.message
                    })
                );
            }
        }

        console.log(
            '[PICKUP PAY AT OUTLET EXPIRY]',
            JSON.stringify({
                candidates:
                    rows.length,
                expired,
                skipped,
                failed
            })
        );
    } catch (err) {
        console.error(
            '[PICKUP PAY AT OUTLET EXPIRY ERROR]',
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
        `[PICKUP PAY AT OUTLET EXPIRY] ${signal}`
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
