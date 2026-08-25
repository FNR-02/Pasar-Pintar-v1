'use strict';

require('dotenv').config();

const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

const BASE_URL =
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3000';

const SYNTHETIC_ADDRESS =
    'Synthetic Atomic Outlet Checkout V1';

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

function customerToken(customer) {
    if (!process.env.JWT_SECRET) {
        throw new Error(
            'JWT_SECRET tidak tersedia'
        );
    }

    return jwt.sign(
        {
            id: customer.user_id,
            username:
                customer.username ||
                'atomic-outlet-contract',
            role_id: 1
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
    body
}) {
    const response =
        await fetch(
            `${BASE_URL}${path}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/json',
                    Authorization:
                        `Bearer ${token}`
                },
                body:
                    JSON.stringify(body)
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
    const result =
        await pool.query(
            `
            SELECT
                c.id AS customer_id,
                c.user_id,
                u.username,
                p.id AS product_id,
                p.merchant_id,
                m.store_name,
                m.address,
                COALESCE(
                    (
                        SELECT SUM(i.quantity_on_hand)
                        FROM tbl_inventory i
                        WHERE i.product_id = p.id
                    ),
                    0
                )::int AS stock
            FROM tbl_customers c
            JOIN tbl_users u
                ON u.id = c.user_id
            CROSS JOIN LATERAL (
                SELECT
                    p2.id,
                    p2.merchant_id
                FROM tbl_products p2
                JOIN tbl_merchants m2
                    ON m2.id = p2.merchant_id
                WHERE p2.status = 'ACTIVE'
                  AND m2.status = 'ACTIVE'
                  AND NULLIF(
                        BTRIM(m2.address),
                        ''
                      ) IS NOT NULL
                  AND EXISTS (
                        SELECT 1
                        FROM tbl_product_prices pp
                        WHERE pp.product_id = p2.id
                          AND pp.price_type = 'RETAIL'
                    )
                  AND COALESCE(
                        (
                            SELECT SUM(i2.quantity_on_hand)
                            FROM tbl_inventory i2
                            WHERE i2.product_id = p2.id
                        ),
                        0
                      ) > 0
                ORDER BY p2.created_at, p2.id
                LIMIT 1
            ) p
            JOIN tbl_merchants m
                ON m.id = p.merchant_id
            WHERE u.role_id = 1
              AND u.is_active = TRUE
            ORDER BY c.created_at, c.id
            LIMIT 1
            `
        );

    if (!result.rowCount) {
        throw new Error(
            'Fixture Customer/Product aktif tidak tersedia'
        );
    }

    return result.rows[0];
}

async function cleanup() {
    await pool.query(
        `
        DELETE FROM tbl_orders_v2
        WHERE pickup_location_snapshot
              LIKE $1
        `,
        [`%${SYNTHETIC_ADDRESS}%`]
    );

    /*
     * Checkout menggunakan snapshot merchant asli,
     * sehingga cleanup utama memakai marker gateway_response.
     */
    await pool.query(
        `
        DELETE FROM tbl_orders_v2
        WHERE id IN (
            SELECT order_id
            FROM tbl_payments
            WHERE gateway_response->>'contract_marker'
                  = $1
        )
        `,
        [SYNTHETIC_ADDRESS]
    );
}

async function cleanupOrder(orderId) {
    if (!orderId) return;

    await pool.query(
        `
        DELETE FROM tbl_orders_v2
        WHERE id = $1
        `,
        [orderId]
    );
}

async function main() {
    console.log(
        '===== ATOMIC PICKUP OUTLET CHECKOUT CONTRACT V1 ====='
    );

    let orderId = null;

    try {
        const domain =
            await resolveDomain();

        const token =
            customerToken(domain);

        const response =
            await apiRequest({
                path:
                    '/api/orders/checkout-v2',
                token,
                body: {
                    items: [
                        {
                            product_id:
                                domain.product_id,
                            quantity: 1
                        }
                    ],
                    fulfillment_type:
                        'PICKUP',
                    payment_mode:
                        'DIRECT',
                    pickup_payment:
                        'OUTLET'
                }
            });

        assert.equal(
            response.statusCode,
            201
        );
        passed(
            'Atomic outlet checkout succeeds'
        );

        assert.equal(
            response.data.status,
            'success'
        );

        assert.ok(
            response.data.order &&
            response.data.order.id
        );

        orderId =
            response.data.order.id;

        assert.ok(
            response.data.payment
        );
        passed(
            'Checkout returns outlet payment'
        );

        assert.equal(
            response.data.payment.provider,
            'OUTLET'
        );

        assert.equal(
            response.data.payment.payment_method,
            'PAY_AT_OUTLET'
        );

        assert.equal(
            response.data.payment.payment_status,
            'UNPAID'
        );

        passed(
            'Outlet payment starts UNPAID'
        );

        const state =
            await pool.query(
                `
                SELECT
                    o.status,
                    o.fulfillment_type,
                    o.payment_mode,
                    COUNT(p.id)::int
                        AS payment_count,
                    COUNT(p.id) FILTER (
                        WHERE
                            p.provider = 'OUTLET'
                            AND
                            p.payment_method =
                                'PAY_AT_OUTLET'
                            AND
                            p.payment_status =
                                'UNPAID'
                    )::int
                        AS outlet_unpaid
                FROM tbl_orders_v2 o
                LEFT JOIN tbl_payments p
                    ON p.order_id = o.id
                WHERE o.id = $1
                GROUP BY
                    o.id,
                    o.status,
                    o.fulfillment_type,
                    o.payment_mode
                `,
                [orderId]
            );

        assert.equal(
            state.rowCount,
            1
        );

        const row =
            state.rows[0];

        assert.equal(
            row.status,
            'PENDING'
        );

        assert.equal(
            row.fulfillment_type,
            'PICKUP'
        );

        assert.equal(
            row.payment_mode,
            'DIRECT'
        );

        assert.equal(
            Number(row.payment_count),
            1
        );

        assert.equal(
            Number(row.outlet_unpaid),
            1
        );

        passed(
            'Order and outlet payment persist together'
        );

        const deliveryResponse =
            await apiRequest({
                path:
                    '/api/orders/checkout-v2',
                token,
                body: {
                    items: [
                        {
                            product_id:
                                domain.product_id,
                            quantity: 1
                        }
                    ],
                    fulfillment_type:
                        'DELIVERY',
                    shipping_address:
                        SYNTHETIC_ADDRESS,
                    payment_mode:
                        'DIRECT',
                    pickup_payment:
                        'OUTLET'
                }
            });

        assert.equal(
            deliveryResponse.statusCode,
            400
        );

        passed(
            'DELIVERY cannot request outlet payment'
        );

        const invalidResponse =
            await apiRequest({
                path:
                    '/api/orders/checkout-v2',
                token,
                body: {
                    items: [
                        {
                            product_id:
                                domain.product_id,
                            quantity: 1
                        }
                    ],
                    fulfillment_type:
                        'PICKUP',
                    payment_mode:
                        'DIRECT',
                    pickup_payment:
                        'INVALID'
                }
            });

        assert.equal(
            invalidResponse.statusCode,
            400
        );

        passed(
            'Invalid pickup payment rejected'
        );

    } catch (err) {
        failed(
            'Atomic pickup outlet checkout',
            err
        );
    } finally {
        try {
            await cleanupOrder(orderId);
        } catch (err) {
            failed(
                'Contract cleanup',
                err
            );
        }

        try {
            const residue =
                orderId
                    ? await pool.query(
                        `
                        SELECT COUNT(*)::int AS total
                        FROM tbl_orders_v2
                        WHERE id = $1
                        `,
                        [orderId]
                    )
                    : {
                        rows: [
                            {
                                total: 0
                            }
                        ]
                    };

            assert.equal(
                Number(
                    residue.rows[0].total
                ),
                0
            );

            passed(
                'Atomic outlet checkout leaves zero residue'
            );
        } catch (err) {
            failed(
                'Residue verification',
                err
            );
        }

        console.log(
            '===== ATOMIC PICKUP OUTLET CHECKOUT CONTRACT RESULT ====='
        );
        console.log(`PASS: ${pass}`);
        console.log(`FAIL: ${fail}`);

        if (fail) {
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
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
