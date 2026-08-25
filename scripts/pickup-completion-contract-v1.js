'use strict';

const assert = require('assert');
const pool = require('../src/config/db');
const OrderFSM = require('../src/kernel/OrderFSM');

let pass = 0;
let fail = 0;

function passed(message) {
    pass += 1;
    console.log(`PASS  ${message}`);
}

function failed(message, err) {
    fail += 1;
    console.error(
        `FAIL  ${message}:`,
        err && err.message
            ? err.message
            : err
    );
}

async function resolveDomain(client) {
    const merchantResult =
        await client.query(
            `
            SELECT
                m.id AS merchant_id,
                m.user_id AS merchant_user_id,
                m.store_name,
                u.username AS merchant_username
            FROM tbl_merchants m
            JOIN tbl_users u
              ON u.id = m.user_id
            WHERE m.status = 'ACTIVE'
              AND u.is_active = TRUE
              AND u.role_id = 2
            ORDER BY m.created_at ASC
            LIMIT 1
            `
        );

    assert.equal(
        merchantResult.rowCount,
        1,
        'Active merchant fixture domain not found'
    );

    const customerResult =
        await client.query(
            `
            SELECT
                c.id AS customer_id,
                c.user_id AS customer_user_id,
                c.full_name,
                u.username AS customer_username
            FROM tbl_customers c
            JOIN tbl_users u
              ON u.id = c.user_id
            WHERE u.is_active = TRUE
              AND u.role_id = 1
            ORDER BY c.created_at ASC
            LIMIT 1
            `
        );

    assert.equal(
        customerResult.rowCount,
        1,
        'Active customer fixture domain not found'
    );

    return {
        merchant:
            merchantResult.rows[0],
        customer:
            customerResult.rows[0]
    };
}

async function createPickupOrder(
    client,
    {
        merchantId,
        customerId,
        status = 'PACKING',
        paymentMode = 'DIRECT'
    }
) {
    assert.ok(
        [
            'PACKING',
            'DISPATCHED'
        ].includes(status),
        'Synthetic pickup status must be PACKING or DISPATCHED'
    );

    assert.equal(
        paymentMode,
        'DIRECT',
        'Initial pickup lifecycle fixture uses DIRECT only'
    );

    const result =
        await client.query(
            `
            INSERT INTO tbl_orders_v2 (
                customer_id,
                merchant_id,
                status,
                shipping_address,
                total_amount,
                fulfillment_type,
                pickup_location_snapshot,
                payment_mode,
                credit_account_id,
                tempo_due_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                'PICKUP',
                $6,
                'DIRECT',
                NULL,
                NULL
            )
            RETURNING *
            `,
            [
                customerId,
                merchantId,
                status,
                'Synthetic Pickup Completion Contract',
                1000,
                'Synthetic Pickup Outlet'
            ]
        );

    assert.equal(
        result.rowCount,
        1,
        'Synthetic pickup order was not created'
    );

    return result.rows[0];
}

async function countShipments(
    client,
    orderId
) {
    const result =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_shipments
            WHERE order_id = $1
            `,
            [orderId]
        );

    return Number(
        result.rows[0].total
    );
}

async function testPickupLifecycleModel() {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const domain =
            await resolveDomain(client);

        const order =
            await createPickupOrder(
                client,
                {
                    merchantId:
                        domain.merchant.merchant_id,
                    customerId:
                        domain.customer.customer_id,
                    status:
                        'PACKING'
                }
            );

        assert.equal(
            order.fulfillment_type,
            'PICKUP'
        );
        passed(
            'Synthetic PICKUP order created'
        );

        assert.equal(
            order.status,
            'PACKING'
        );
        passed(
            'Synthetic PICKUP starts in PACKING'
        );

        assert.equal(
            await countShipments(
                client,
                order.id
            ),
            0
        );
        passed(
            'PICKUP starts with zero shipment'
        );

        assert.equal(
            OrderFSM.canTransition(
                'PACKING',
                'DISPATCHED'
            ),
            true
        );
        passed(
            'FSM allows PICKUP ready transition PACKING -> DISPATCHED'
        );

        assert.equal(
            OrderFSM.canTransition(
                'DISPATCHED',
                'DELIVERED'
            ),
            true
        );
        passed(
            'FSM allows PICKUP handover transition DISPATCHED -> DELIVERED'
        );

        assert.equal(
            OrderFSM.canTransition(
                'PACKING',
                'DELIVERED'
            ),
            false
        );
        passed(
            'FSM rejects skipping PICKUP ready state'
        );

        /*
         * Contract invariant:
         *
         * PICKUP:
         * PACKING
         *   -> DISPATCHED = siap diambil
         *   -> DELIVERED  = sudah diserahkan
         *
         * Tidak pernah membuat tbl_shipments.
         */

        await client.query('ROLLBACK');

        passed(
            'Synthetic PICKUP lifecycle transaction rolled back'
        );
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        throw err;
    } finally {
        client.release();
    }
}

async function verifyProductionSafety() {
    const result =
        await pool.query(
            `
            SELECT
                COUNT(*) FILTER (
                    WHERE shipping_address =
                        'Synthetic Pickup Completion Contract'
                )::int AS synthetic_orders,
                COUNT(*) FILTER (
                    WHERE fulfillment_type = 'PICKUP'
                      AND shipping_address =
                        'Synthetic Pickup Completion Contract'
                )::int AS synthetic_pickups
            FROM tbl_orders_v2
            `
        );

    assert.equal(
        Number(
            result.rows[0].synthetic_orders
        ),
        0
    );

    assert.equal(
        Number(
            result.rows[0].synthetic_pickups
        ),
        0
    );

    passed(
        'Synthetic PICKUP data leaves zero residue'
    );
}

async function main() {
    console.log(
        '===== PICKUP COMPLETION CONTRACT V1 ====='
    );

    try {
        await testPickupLifecycleModel();
        await verifyProductionSafety();
    } catch (err) {
        failed(
            'Pickup completion contract',
            err
        );
    }

    console.log(
        '===== PICKUP COMPLETION CONTRACT RESULT ====='
    );
    console.log(`PASS: ${pass}`);
    console.log(`FAIL: ${fail}`);
    console.log(
        fail === 0
            ? 'STATUS: HEALTHY'
            : 'STATUS: FAILED'
    );

    await pool.end();

    if (fail > 0) {
        process.exitCode = 1;
    }
}

main().catch(async err => {
    failed(
        'Unhandled pickup completion contract error',
        err
    );

    try {
        await pool.end();
    } catch (_) {}

    process.exitCode = 1;
});
