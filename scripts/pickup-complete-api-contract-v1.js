'use strict';

require('dotenv').config();

const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

const BASE_URL =
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3000';

const SYNTHETIC_ADDRESS =
    'Synthetic Pickup Complete API Contract';

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
            id:
                merchant.user_id,
            username:
                merchant.username ||
                'pickup-complete-contract',
            role_id:
                2
        },
        process.env.JWT_SECRET,
        {
            expiresIn:
                '10m'
        }
    );
}

async function apiRequest({
    path,
    token,
    method = 'PATCH',
    body = null
}) {
    const response =
        await fetch(
            `${BASE_URL}${path}`,
            {
                method,
                headers: {
                    'Content-Type':
                        'application/json',
                    Authorization:
                        `Bearer ${token}`
                },
                body:
                    body === null
                        ? undefined
                        : JSON.stringify(body)
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

async function resolveDomain(client) {
    const merchantResult =
        await client.query(
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
            ORDER BY m.created_at, m.id
            LIMIT 1
            `
        );

    if (!merchantResult.rowCount) {
        throw new Error(
            'Merchant aktif untuk contract tidak tersedia'
        );
    }

    const customerResult =
        await client.query(
            `
            SELECT id
            FROM tbl_customers
            ORDER BY created_at, id
            LIMIT 1
            `
        );

    if (!customerResult.rowCount) {
        throw new Error(
            'Customer untuk contract tidak tersedia'
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
    client,
    domain,
    {
        fulfillmentType = 'PICKUP',
        status = 'DISPATCHED'
    } = {}
) {
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
                payment_mode
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                1000,
                $5,
                $6,
                'DIRECT'
            )
            RETURNING *
            `,
            [
                domain.customer.id,
                domain.merchant.id,
                status,
                SYNTHETIC_ADDRESS,
                fulfillmentType,
                fulfillmentType === 'PICKUP'
                    ? domain.merchant.store_name
                    : null
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
            [
                orderId
            ]
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
            [
                orderId
            ]
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
                    aggregate_id = $2
                    OR payload ->> 'orderId' = $3
                  )
            `,
            [
                eventName,
                orderId,
                String(orderId)
            ]
        );

    return Number(
        result.rows[0].total
    );
}

async function waitForEvent(
    orderId,
    eventName,
    minimum = 1
) {
    for (
        let attempt = 0;
        attempt < 20;
        attempt += 1
    ) {
        const total =
            await eventCount(
                orderId,
                eventName
            );

        if (total >= minimum) {
            return total;
        }

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    100
                )
        );
    }

    return eventCount(
        orderId,
        eventName
    );
}

async function cleanup() {
    /*
     * Event store mempunyai FK-independent audit history,
     * jadi hapus synthetic event lebih dahulu.
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
        [
            SYNTHETIC_ADDRESS
        ]
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
        [
            SYNTHETIC_ADDRESS
        ]
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
        [
            SYNTHETIC_ADDRESS
        ]
    );

    await pool.query(
        `
        DELETE FROM tbl_orders_v2
        WHERE shipping_address = $1
        `,
        [
            SYNTHETIC_ADDRESS
        ]
    );
}

async function testHappyPath() {
    const client =
        await pool.connect();

    let order = null;
    let token = null;

    try {
        const domain =
            await resolveDomain(client);

        token =
            merchantToken(
                domain.merchant
            );

        order =
            await createOrder(
                client,
                domain,
                {
                    fulfillmentType:
                        'PICKUP',
                    status:
                        'DISPATCHED'
                }
            );

        passed(
            'Synthetic PICKUP starts in DISPATCHED'
        );

        assert.equal(
            await shipmentCount(order.id),
            0
        );

        passed(
            'Synthetic PICKUP starts without shipment'
        );

        const response =
            await apiRequest({
                path:
                    `/api/merchant/orders-v2/${order.id}/complete-pickup`,
                token
            });

        assert.equal(
            response.statusCode,
            200
        );

        assert.equal(
            response.data.status,
            'success'
        );

        assert.equal(
            response.data.order.status,
            'DELIVERED'
        );

        passed(
            'Merchant completes PICKUP handover'
        );

        const persisted =
            await loadOrder(
                order.id
            );

        assert.equal(
            persisted.status,
            'DELIVERED'
        );

        passed(
            'PICKUP persists DELIVERED state'
        );

        assert.equal(
            await shipmentCount(order.id),
            0
        );

        passed(
            'Completed PICKUP creates no shipment'
        );

        const pickupEvents =
            await waitForEvent(
                order.id,
                'PICKUP_COMPLETED'
            );

        assert.ok(
            pickupEvents >= 1
        );

        passed(
            'PICKUP_COMPLETED event persisted'
        );

        const statusEvents =
            await waitForEvent(
                order.id,
                'ORDER_STATUS_CHANGED'
            );

        assert.ok(
            statusEvents >= 1
        );

        passed(
            'ORDER_STATUS_CHANGED event persisted'
        );

        const deliveryEvents =
            await eventCount(
                order.id,
                'DELIVERY_COMPLETED'
            );

        assert.equal(
            deliveryEvents,
            0
        );

        passed(
            'PICKUP emits no DELIVERY_COMPLETED event'
        );

        const pickupBeforeRetry =
            await eventCount(
                order.id,
                'PICKUP_COMPLETED'
            );

        const retry =
            await apiRequest({
                path:
                    `/api/merchant/orders-v2/${order.id}/complete-pickup`,
                token
            });

        assert.equal(
            retry.statusCode,
            200
        );

        assert.equal(
            retry.data.already_completed,
            true
        );

        const pickupAfterRetry =
            await eventCount(
                order.id,
                'PICKUP_COMPLETED'
            );

        assert.equal(
            pickupAfterRetry,
            pickupBeforeRetry
        );

        passed(
            'Complete PICKUP retry is idempotent'
        );
    } finally {
        client.release();
    }
}

async function testPackingRejected() {
    const client =
        await pool.connect();

    try {
        const domain =
            await resolveDomain(client);

        const order =
            await createOrder(
                client,
                domain,
                {
                    fulfillmentType:
                        'PICKUP',
                    status:
                        'PACKING'
                }
            );

        const response =
            await apiRequest({
                path:
                    `/api/merchant/orders-v2/${order.id}/complete-pickup`,
                token:
                    merchantToken(
                        domain.merchant
                    )
            });

        assert.equal(
            response.statusCode,
            409
        );

        const persisted =
            await loadOrder(
                order.id
            );

        assert.equal(
            persisted.status,
            'PACKING'
        );

        passed(
            'PICKUP cannot skip ready state'
        );
    } finally {
        client.release();
    }
}

async function testDeliveryRejected() {
    const client =
        await pool.connect();

    try {
        const domain =
            await resolveDomain(client);

        const order =
            await createOrder(
                client,
                domain,
                {
                    fulfillmentType:
                        'DELIVERY',
                    status:
                        'DISPATCHED'
                }
            );

        const response =
            await apiRequest({
                path:
                    `/api/merchant/orders-v2/${order.id}/complete-pickup`,
                token:
                    merchantToken(
                        domain.merchant
                    )
            });

        assert.equal(
            response.statusCode,
            409
        );

        const persisted =
            await loadOrder(
                order.id
            );

        assert.equal(
            persisted.status,
            'DISPATCHED'
        );

        passed(
            'DELIVERY order cannot use complete-pickup'
        );
    } finally {
        client.release();
    }
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
                    FROM tbl_shipments
                    WHERE order_id IN (
                        SELECT id
                        FROM tbl_orders_v2
                        WHERE shipping_address = $1
                    )
                ) AS shipments
            `,
            [
                SYNTHETIC_ADDRESS
            ]
        );

    assert.equal(
        Number(result.rows[0].orders),
        0
    );

    assert.equal(
        Number(result.rows[0].shipments),
        0
    );

    passed(
        'Pickup complete API contract leaves zero residue'
    );
}

async function main() {
    console.log(
        '===== PICKUP COMPLETE API CONTRACT V1 ====='
    );

    try {
        await cleanup();

        try {
            await testHappyPath();
        } catch (err) {
            failed(
                'Happy path contract',
                err
            );
        }

        try {
            await testPackingRejected();
        } catch (err) {
            failed(
                'PACKING rejection contract',
                err
            );
        }

        try {
            await testDeliveryRejected();
        } catch (err) {
            failed(
                'DELIVERY rejection contract',
                err
            );
        }
    } finally {
        try {
            await cleanup();
            await verifyNoResidue();
        } catch (err) {
            failed(
                'Cleanup / residue verification',
                err
            );
        }

        await pool.end();
    }

    console.log(
        '===== PICKUP COMPLETE API CONTRACT RESULT ====='
    );
    console.log(
        `PASS: ${pass}`
    );
    console.log(
        `FAIL: ${fail}`
    );

    if (fail > 0) {
        console.log(
            'STATUS: FAILED'
        );
        process.exitCode = 1;
    } else {
        console.log(
            'STATUS: HEALTHY'
        );
    }
}

main().catch(async err => {
    console.error(
        'FATAL:',
        err
    );

    try {
        await pool.end();
    } catch (_) {}

    process.exit(1);
});
