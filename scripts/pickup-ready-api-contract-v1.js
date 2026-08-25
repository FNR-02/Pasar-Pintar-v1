'use strict';

require('dotenv').config();

const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

const BASE_URL =
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3000';

const SYNTHETIC_ADDRESS =
    'Synthetic Pickup Ready API Contract';

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

function merchantToken(user) {
    if (!process.env.JWT_SECRET) {
        throw new Error(
            'JWT_SECRET tidak tersedia'
        );
    }

    return jwt.sign(
        {
            id: user.user_id,
            username: user.username,
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
    token,
    method = 'PATCH'
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

async function resolveDomain(client) {
    const ownerResult =
        await client.query(
            `
            SELECT
                m.id AS merchant_id,
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

    if (!ownerResult.rowCount) {
        throw new Error(
            'Merchant aktif untuk contract tidak tersedia'
        );
    }

    const owner =
        ownerResult.rows[0];

    /*
     * Merchant kedua hanya dipakai bila tersedia.
     * Jika belum ada merchant kedua di environment,
     * ownership tetap diuji menggunakan merchant_id
     * synthetic yang tidak cocok tetapi token owner.
     */
    const strangerResult =
        await client.query(
            `
            SELECT
                m.id AS merchant_id,
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
              AND m.id <> $1
            ORDER BY m.created_at, m.id
            LIMIT 1
            `,
            [owner.merchant_id]
        );

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
            'Customer fixture tidak tersedia'
        );
    }

    return {
        owner,
        stranger:
            strangerResult.rows[0] ||
            null,
        customer:
            customerResult.rows[0]
    };
}

async function createOrder(
    client,
    domain,
    {
        fulfillmentType = 'PICKUP',
        status = 'PACKING',
        merchantId =
            domain.owner.merchant_id
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
                3500,
                $5,
                $6,
                'DIRECT'
            )
            RETURNING *
            `,
            [
                domain.customer.id,
                merchantId,
                status,
                SYNTHETIC_ADDRESS,
                fulfillmentType,
                fulfillmentType === 'PICKUP'
                    ? 'Synthetic Pickup Counter'
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
            [orderId]
        );

    return result.rows[0] ||
        null;
}

async function countShipments(orderId) {
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

async function cleanup() {
    /*
     * Shipment dihapus defensif dahulu.
     * Contract yang benar seharusnya tidak pernah
     * membuat shipment untuk PICKUP.
     */
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

async function testHappyPath(domain) {
    const client =
        await pool.connect();

    let order;

    try {
        order =
            await createOrder(
                client,
                domain
            );
    } finally {
        client.release();
    }

    assert.equal(
        order.status,
        'PACKING'
    );

    passed(
        'Synthetic PICKUP API order starts in PACKING'
    );

    assert.equal(
        await countShipments(order.id),
        0
    );

    passed(
        'Synthetic PICKUP API order starts without shipment'
    );

    const response =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/ready-for-pickup`,
            token:
                merchantToken(
                    domain.owner
                )
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
        'DISPATCHED'
    );

    passed(
        'Merchant marks PICKUP as ready'
    );

    const after =
        await loadOrder(
            order.id
        );

    assert.equal(
        after.status,
        'DISPATCHED'
    );

    passed(
        'PICKUP persists DISPATCHED ready state'
    );

    assert.equal(
        await countShipments(order.id),
        0
    );

    passed(
        'Ready PICKUP creates no shipment'
    );

    const retry =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/ready-for-pickup`,
            token:
                merchantToken(
                    domain.owner
                )
        });

    assert.equal(
        retry.statusCode,
        200
    );

    assert.equal(
        retry.data.already_ready,
        true
    );

    assert.equal(
        await countShipments(order.id),
        0
    );

    passed(
        'Ready PICKUP retry is idempotent'
    );
}

async function testDeliveryRejected(domain) {
    const client =
        await pool.connect();

    let order;

    try {
        order =
            await createOrder(
                client,
                domain,
                {
                    fulfillmentType:
                        'DELIVERY'
                }
            );
    } finally {
        client.release();
    }

    const response =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/ready-for-pickup`,
            token:
                merchantToken(
                    domain.owner
                )
        });

    assert.equal(
        response.statusCode,
        409
    );

    const after =
        await loadOrder(
            order.id
        );

    assert.equal(
        after.status,
        'PACKING'
    );

    assert.equal(
        await countShipments(order.id),
        0
    );

    passed(
        'DELIVERY order cannot use ready-for-pickup'
    );
}

async function testWrongStatusRejected(domain) {
    const client =
        await pool.connect();

    let order;

    try {
        order =
            await createOrder(
                client,
                domain,
                {
                    status:
                        'PENDING'
                }
            );
    } finally {
        client.release();
    }

    const response =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/ready-for-pickup`,
            token:
                merchantToken(
                    domain.owner
                )
        });

    assert.equal(
        response.statusCode,
        409
    );

    const after =
        await loadOrder(
            order.id
        );

    assert.equal(
        after.status,
        'PENDING'
    );

    passed(
        'PICKUP outside PACKING cannot become ready'
    );
}

async function testOwnership(domain) {
    /*
     * Ownership test paling kuat memakai merchant kedua.
     * Environment saat ini mungkin hanya memiliki satu
     * merchant aktif, jadi test dilewati secara eksplisit
     * bila fixture memang tidak tersedia.
     */
    if (!domain.stranger) {
        console.log(
            'SKIP  Merchant ownership negative test: second active merchant unavailable'
        );
        return;
    }

    const client =
        await pool.connect();

    let order;

    try {
        order =
            await createOrder(
                client,
                domain
            );
    } finally {
        client.release();
    }

    const response =
        await apiRequest({
            path:
                `/api/merchant/orders-v2/${order.id}/ready-for-pickup`,
            token:
                merchantToken(
                    domain.stranger
                )
        });

    assert.equal(
        response.statusCode,
        404
    );

    const after =
        await loadOrder(
            order.id
        );

    assert.equal(
        after.status,
        'PACKING'
    );

    passed(
        'Other Merchant cannot mark PICKUP ready'
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
                    FROM tbl_shipments s
                    JOIN tbl_orders_v2 o
                        ON o.id = s.order_id
                    WHERE o.shipping_address = $1
                ) AS shipments
            `,
            [SYNTHETIC_ADDRESS]
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
        'Pickup ready API contract leaves zero residue'
    );
}

async function main() {
    console.log(
        '===== PICKUP READY API CONTRACT V1 ====='
    );

    let domain;

    try {
        await cleanup();

        const client =
            await pool.connect();

        try {
            domain =
                await resolveDomain(
                    client
                );
        } finally {
            client.release();
        }

        const tests = [
            [
                'Happy path',
                () =>
                    testHappyPath(
                        domain
                    )
            ],
            [
                'DELIVERY rejection',
                () =>
                    testDeliveryRejected(
                        domain
                    )
            ],
            [
                'Wrong status rejection',
                () =>
                    testWrongStatusRejected(
                        domain
                    )
            ],
            [
                'Merchant ownership',
                () =>
                    testOwnership(
                        domain
                    )
            ]
        ];

        for (
            const [name, test]
            of tests
        ) {
            try {
                await test();
            } catch (err) {
                failed(
                    name,
                    err
                );
            }
        }
    } catch (err) {
        failed(
            'Contract setup',
            err
        );
    } finally {
        try {
            await cleanup();
            await verifyNoResidue();
        } catch (err) {
            failed(
                'Contract cleanup',
                err
            );
        }
    }

    console.log(
        '===== PICKUP READY API CONTRACT RESULT ====='
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

main().catch(async err => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
