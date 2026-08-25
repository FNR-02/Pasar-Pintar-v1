'use strict';

require('dotenv').config();

const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

const BASE_URL =
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3000';

const SYNTHETIC_ADDRESS =
    'Synthetic Pickup Payment Guard API Contract';

let pass = 0;
let fail = 0;

function passed(name) {
    pass += 1;
    console.log(`PASS  ${name}`);
}

function failed(name, err) {
    fail += 1;
    console.error(
        `FAIL  ${name}:`,
        err && err.message
            ? err.message
            : err
    );
}

function merchantToken(merchant) {
    if (!process.env.JWT_SECRET) {
        throw new Error(
            'JWT_SECRET tidak tersedia'
        );
    }

    return jwt.sign(
        {
            id: merchant.user_id,
            username:
                merchant.username ||
                'pickup-payment-guard-contract',
            role_id: 2
        },
        process.env.JWT_SECRET,
        {
            expiresIn: '10m'
        }
    );
}

async function apiRequest({
    path,
    token
}) {
    const response =
        await fetch(
            `${BASE_URL}${path}`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type':
                        'application/json',
                    Authorization:
                        `Bearer ${token}`
                }
            }
        );

    let data = {};

    try {
        data =
            await response.json();
    } catch (_) {}

    return {
        statusCode:
            response.status,
        data
    };
}

async function resolveDomain() {
    const merchantResult =
        await pool.query(
            `
            SELECT
                m.id,
                m.user_id,
                m.store_name,
                u.username
            FROM tbl_merchants m
            JOIN tbl_users u
              ON u.id = m.user_id
            WHERE m.status = 'ACTIVE'
              AND m.user_id IS NOT NULL
              AND u.role_id = 2
              AND u.is_active = TRUE
            ORDER BY
                m.created_at,
                m.id
            LIMIT 1
            `
        );

    if (!merchantResult.rowCount) {
        throw new Error(
            'Merchant aktif untuk contract tidak tersedia'
        );
    }

    const customerResult =
        await pool.query(
            `
            SELECT id
            FROM tbl_customers
            ORDER BY
                created_at,
                id
            LIMIT 1
            `
        );

    if (!customerResult.rowCount) {
        throw new Error(
            'Customer fixture tidak tersedia'
        );
    }

    return {
        merchant:
            merchantResult.rows[0],
        customer:
            customerResult.rows[0]
    };
}

async function createOrder(
    domain,
    status
) {
    const result =
        await pool.query(
            `
            INSERT INTO tbl_orders_v2 (
                customer_id,
                merchant_id,
                status,
                shipping_address,
                total_amount,
                fulfillment_type,
                pickup_location_snapshot,
                payment_mode
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                3500,
                'PICKUP',
                $5,
                'DIRECT'
            )
            RETURNING *
            `,
            [
                domain.customer.id,
                domain.merchant.id,
                status,
                SYNTHETIC_ADDRESS,
                domain.merchant.store_name ||
                    'Synthetic Pickup Counter'
            ]
        );

    return result.rows[0];
}

async function createUnpaidOutletPayment(
    order
) {
    const result =
        await pool.query(
            `
            INSERT INTO tbl_payments (
                order_id,
                payment_method,
                payment_status,
                amount,
                provider,
                channel
            )
            VALUES (
                $1,
                'PAY_AT_OUTLET',
                'UNPAID',
                $2,
                'OUTLET',
                'OUTLET'
            )
            RETURNING *
            `,
            [
                order.id,
                order.total_amount
            ]
        );

    return result.rows[0];
}

async function loadOrder(orderId) {
    const result =
        await pool.query(
            `
            SELECT *
            FROM tbl_orders_v2
            WHERE id = $1
            `,
            [orderId]
        );

    return result.rows[0] || null;
}

async function shipmentCount(orderId) {
    const result =
        await pool.query(
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

async function eventCount(
    orderId,
    eventName
) {
    const result =
        await pool.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_event_store
            WHERE event_name = $1
              AND (
                    aggregate_id::text =
                        $2::text
                    OR payload ->> 'orderId' =
                        $2::text
                  )
            `,
            [
                eventName,
                String(orderId)
            ]
        );

    return Number(
        result.rows[0].total
    );
}

async function cleanup() {
    /*
     * Event store lebih dahulu karena audit event
     * dapat hidup independen dari lifecycle row.
     */
    await pool.query(
        `
        DELETE FROM tbl_event_store
        WHERE aggregate_id::text IN (
            SELECT id::text
            FROM tbl_orders_v2
            WHERE shipping_address = $1
        )
        OR payload ->> 'orderId' IN (
            SELECT id::text
            FROM tbl_orders_v2
            WHERE shipping_address = $1
        )
        `,
        [SYNTHETIC_ADDRESS]
    );

    await pool.query(
        `
        DELETE FROM tbl_shipments
        WHERE order_id IN (
            SELECT id
            FROM tbl_orders_v2
            WHERE shipping_address = $1
        )
        `,
        [SYNTHETIC_ADDRESS]
    );

    await pool.query(
        `
        DELETE FROM tbl_order_items
        WHERE order_id IN (
            SELECT id
            FROM tbl_orders_v2
            WHERE shipping_address = $1
        )
        `,
        [SYNTHETIC_ADDRESS]
    );

    await pool.query(
        `
        DELETE FROM tbl_payments
        WHERE order_id IN (
            SELECT id
            FROM tbl_orders_v2
            WHERE shipping_address = $1
        )
        `,
        [SYNTHETIC_ADDRESS]
    );

    await pool.query(
        `
        DELETE FROM tbl_orders_v2
        WHERE shipping_address = $1
        `,
        [SYNTHETIC_ADDRESS]
    );
}

async function testReadyRejected(
    domain,
    token
) {
    const order =
        await createOrder(
            domain,
            'PACKING'
        );

    const payment =
        await createUnpaidOutletPayment(
            order
        );

    assert.equal(
        payment.payment_status,
        'UNPAID'
    );

    passed(
        'Ready fixture has UNPAID PAY_AT_OUTLET'
    );

    assert.equal(
        await shipmentCount(order.id),
        0
    );

    passed(
        'Ready fixture starts without shipment'
    );

    const beforeStatusEvents =
        await eventCount(
            order.id,
            'ORDER_STATUS_CHANGED'
        );

    const response =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/ready-for-pickup`,
            token
        });

    assert.equal(
        response.statusCode,
        409
    );

    passed(
        'UNPAID pickup cannot become ready'
    );

    assert.match(
        String(
            response.data.error || ''
        ),
        /pembayaran/i
    );

    passed(
        'Ready rejection exposes payment conflict'
    );

    const after =
        await loadOrder(
            order.id
        );

    assert(after);

    assert.equal(
        after.status,
        'PACKING'
    );

    passed(
        'Rejected ready pickup remains PACKING'
    );

    assert.equal(
        await shipmentCount(order.id),
        0
    );

    passed(
        'Rejected ready pickup creates no shipment'
    );

    const afterStatusEvents =
        await eventCount(
            order.id,
            'ORDER_STATUS_CHANGED'
        );

    assert.equal(
        afterStatusEvents,
        beforeStatusEvents
    );

    passed(
        'Rejected ready pickup emits no status event'
    );
}

async function testCompleteRejected(
    domain,
    token
) {
    const order =
        await createOrder(
            domain,
            'DISPATCHED'
        );

    const payment =
        await createUnpaidOutletPayment(
            order
        );

    assert.equal(
        payment.payment_status,
        'UNPAID'
    );

    passed(
        'Complete fixture has UNPAID PAY_AT_OUTLET'
    );

    assert.equal(
        await shipmentCount(order.id),
        0
    );

    passed(
        'Complete fixture starts without shipment'
    );

    const beforeStatusEvents =
        await eventCount(
            order.id,
            'ORDER_STATUS_CHANGED'
        );

    const beforePickupEvents =
        await eventCount(
            order.id,
            'PICKUP_COMPLETED'
        );

    const beforeDeliveryEvents =
        await eventCount(
            order.id,
            'DELIVERY_COMPLETED'
        );

    const response =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/complete-pickup`,
            token
        });

    assert.equal(
        response.statusCode,
        409
    );

    passed(
        'UNPAID pickup cannot be completed'
    );

    assert.match(
        String(
            response.data.error || ''
        ),
        /pembayaran/i
    );

    passed(
        'Complete rejection exposes payment conflict'
    );

    const after =
        await loadOrder(
            order.id
        );

    assert(after);

    assert.equal(
        after.status,
        'DISPATCHED'
    );

    passed(
        'Rejected complete pickup remains DISPATCHED'
    );

    assert.equal(
        await shipmentCount(order.id),
        0
    );

    passed(
        'Rejected complete pickup creates no shipment'
    );

    assert.equal(
        await eventCount(
            order.id,
            'ORDER_STATUS_CHANGED'
        ),
        beforeStatusEvents
    );

    passed(
        'Rejected complete pickup emits no status event'
    );

    assert.equal(
        await eventCount(
            order.id,
            'PICKUP_COMPLETED'
        ),
        beforePickupEvents
    );

    passed(
        'Rejected complete pickup emits no PICKUP_COMPLETED'
    );

    assert.equal(
        await eventCount(
            order.id,
            'DELIVERY_COMPLETED'
        ),
        beforeDeliveryEvents
    );

    passed(
        'Rejected complete pickup emits no DELIVERY_COMPLETED'
    );
}

async function verifyNoResidue() {
    const result =
        await pool.query(
            `
            SELECT
                (
                    SELECT COUNT(*)::int
                    FROM tbl_orders_v2
                    WHERE shipping_address = $1
                ) AS orders,
                (
                    SELECT COUNT(*)::int
                    FROM tbl_payments p
                    JOIN tbl_orders_v2 o
                      ON o.id = p.order_id
                    WHERE o.shipping_address = $1
                ) AS payments,
                (
                    SELECT COUNT(*)::int
                    FROM tbl_shipments s
                    JOIN tbl_orders_v2 o
                      ON o.id = s.order_id
                    WHERE o.shipping_address = $1
                ) AS shipments
            `,
            [SYNTHETIC_ADDRESS]
        );

    const row =
        result.rows[0];

    assert.equal(
        Number(row.orders),
        0
    );

    assert.equal(
        Number(row.payments),
        0
    );

    assert.equal(
        Number(row.shipments),
        0
    );

    passed(
        'Pickup payment guard contract leaves zero residue'
    );
}

async function runTest(
    name,
    fn
) {
    try {
        await fn();
    } catch (err) {
        failed(
            name,
            err
        );
    }
}

async function main() {
    console.log(
        '===== PICKUP PAYMENT GUARD API CONTRACT V1 ====='
    );

    try {
        await cleanup();

        const domain =
            await resolveDomain();

        const token =
            merchantToken(
                domain.merchant
            );

        await runTest(
            'Ready PAY_AT_OUTLET guard',
            async () => {
                await testReadyRejected(
                    domain,
                    token
                );
            }
        );

        await cleanup();

        await runTest(
            'Complete PAY_AT_OUTLET guard',
            async () => {
                await testCompleteRejected(
                    domain,
                    token
                );
            }
        );

    } finally {
        try {
            await cleanup();
        } catch (err) {
            failed(
                'Contract cleanup',
                err
            );
        }

        await runTest(
            'Residue verification',
            verifyNoResidue
        );

        console.log(
            '===== PICKUP PAYMENT GUARD API CONTRACT RESULT ====='
        );

        console.log(
            `PASS: ${pass}`
        );

        console.log(
            `FAIL: ${fail}`
        );

        if (fail > 0) {
            console.log(
                'STATUS: UNHEALTHY'
            );
            process.exitCode = 1;
        } else {
            console.log(
                'STATUS: HEALTHY'
            );
        }

        await pool.end();
    }
}

main().catch(async err => {
    console.error(
        'FATAL:',
        err
    );

    try {
        await cleanup();
    } catch (_) {}

    try {
        await pool.end();
    } catch (_) {}

    process.exit(1);
});
