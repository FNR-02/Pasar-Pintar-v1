require('dotenv').config();

const pool =
    require('../src/config/db');

const CommerceKernel =
    require('../src/kernel/EventKernel');

const OrderPaidOutboxService =
    require(
        '../src/services/orders/OrderPaidOutboxService'
    );

require('../src/kernel/orderSubscribers');
require('../src/kernel/financeSubscribers');
require('../src/kernel/warehouseSubscribers');
require('../src/kernel/crmSubscribers');
require('../src/kernel/whatsappSubscribers');
require('../src/kernel/merchantWhatsAppSubscribers');
require('../src/brain/GraphBuilder');

const service =
    new OrderPaidOutboxService(pool);

const INTERVAL_MS =
    Math.max(
        30000,
        Number(
            process.env.ORDER_PAID_OUTBOX_INTERVAL_MS ||
            60000
        )
    );

const BATCH_LIMIT =
    Math.max(
        1,
        Math.min(
            Number(
                process.env.ORDER_PAID_OUTBOX_BATCH_LIMIT ||
                10
            ),
            100
        )
    );

const ONCE =
    process.argv.includes('--once');

let running = false;
let shuttingDown = false;

function missingChecks(verification) {
    if (!verification.found) {
        return ['canonical_order'];
    }

    return Object.entries(
        verification.checks || {}
    )
        .filter(([key, value]) =>
            key.endsWith('_ok') &&
            value !== true
        )
        .map(([key]) => key);
}

async function replayOrderPaid(packet) {
    const listeners =
        CommerceKernel.listeners('ORDER_PAID');

    const results =
        await Promise.allSettled(
            listeners.map(listener =>
                Promise.resolve().then(() =>
                    listener.call(
                        CommerceKernel,
                        packet
                    )
                )
            )
        );

    const rejected =
        results.filter(
            result =>
                result.status === 'rejected'
        );

    if (rejected.length > 0) {
        console.error(
            '[ORDER PAID OUTBOX] listener rejection ' +
            JSON.stringify({
                orderId: packet.aggregateId,
                rejected: rejected.length,
                listeners: listeners.length
            })
        );
    }

    return {
        listeners: listeners.length,
        rejected: rejected.length
    };
}

async function runBatch() {
    if (running || shuttingDown) {
        return;
    }

    running = true;

    try {
        const rows =
            await service.findDuePending(
                BATCH_LIMIT
            );

        let processed = 0;
        let replayed = 0;
        let skipped = 0;

        for (const row of rows) {
            const verification =
                await service.verifyCompletion(
                    row.order_id
                );

            if (verification.complete) {
                const result =
                    await service.markProcessed(
                        row.order_id
                    );

                if (result.status === 'processed') {
                    processed += 1;
                } else {
                    skipped += 1;
                }

                continue;
            }

            const missing =
                missingChecks(verification);

            await service.recoverStaleWhatsAppPending(
                row.order_id
            );

            const claimed =
                await service.scheduleReplay(
                    row.order_id,
                    `pending: ${missing.join(', ')}`
                );

            if (!claimed) {
                skipped += 1;
                continue;
            }

            const packet = {
                eventName: 'ORDER_PAID',
                aggregateType: 'ORDER',
                aggregateId: row.order_id,
                payload: claimed.payload || {},
                timestamp: new Date().toISOString()
            };

            await replayOrderPaid(
                packet
            );

            replayed += 1;
        }

        console.log(
            '[ORDER PAID OUTBOX]',
            JSON.stringify({
                candidates: rows.length,
                processed,
                replayed,
                skipped
            })
        );
    } catch (err) {
        console.error(
            '[ORDER PAID OUTBOX ERROR]',
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
        `[ORDER PAID OUTBOX] ${signal}`
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
        '[ORDER PAID OUTBOX] started ' +
        JSON.stringify({
            once: ONCE,
            intervalMs: INTERVAL_MS,
            batchLimit: BATCH_LIMIT
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
