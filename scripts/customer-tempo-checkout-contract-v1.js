require('dotenv').config();

const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

const BASE_URL =
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;

function passed(name) {
    pass++;
    console.log(`PASS  ${name}`);
}

function failed(name, err) {
    fail++;
    console.error(
        `FAIL  ${name}: ${err.message}`
    );
}

function tokenFor(user) {
    return jwt.sign(
        {
            id: user.user_id,
            role_id: 1
        },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
    );
}

async function apiRequest({
    path,
    token,
    body
}) {
    const response = await fetch(
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
        data = await response.json();
    } catch (_) {}

    return {
        statusCode: response.status,
        data
    };
}

async function resolveDomain(client) {
    const result =
        await client.query(`
            SELECT
                m.id AS merchant_id,
                m.store_name,
                c.id AS customer_id,
                c.user_id,
                c.full_name,
                p.id AS product_id,
                p.name AS product_name,
                price.amount AS unit_price,
                inv.available_stock
            FROM tbl_merchants m
            JOIN tbl_customers c
                ON c.user_id IS NOT NULL
            JOIN tbl_users u
                ON u.id = c.user_id
               AND u.role_id = 1
               AND u.is_active = TRUE
            JOIN tbl_products p
                ON p.merchant_id = m.id
               AND p.status = 'ACTIVE'
            JOIN LATERAL (
                SELECT amount
                FROM tbl_product_prices
                WHERE product_id = p.id
                  AND price_type = 'RETAIL'
                ORDER BY effective_date DESC
                LIMIT 1
            ) price ON TRUE
            JOIN LATERAL (
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS available_stock
                FROM tbl_inventory
                WHERE product_id = p.id
            ) inv ON TRUE
            WHERE m.status = 'ACTIVE'
              AND inv.available_stock > 0
            ORDER BY
                m.created_at,
                c.created_at,
                p.created_at
            LIMIT 1
        `);

    if (!result.rowCount) {
        throw new Error(
            'Domain synthetic checkout TEMPO tidak tersedia'
        );
    }

    const row = result.rows[0];

    return {
        merchant: {
            id: row.merchant_id,
            store_name: row.store_name
        },
        customer: {
            id: row.customer_id,
            user_id: row.user_id,
            full_name: row.full_name
        },
        product: {
            id: row.product_id,
            name: row.product_name,
            unit_price:
                Number(row.unit_price),
            available_stock:
                Number(row.available_stock)
        }
    };
}

async function createCreditAccount(
    client,
    domain,
    creditLimit = 100000
) {
    const result =
        await client.query(
            `
            INSERT INTO tbl_credit_accounts (
                account_type,
                customer_id,
                merchant_id,
                supplier_id,
                credit_limit,
                default_term_days,
                status,
                approved_at
            )
            VALUES (
                'CUSTOMER',
                $1,
                $2,
                NULL,
                $3,
                7,
                'ACTIVE',
                CURRENT_TIMESTAMP
            )
            RETURNING *
            `,
            [
                domain.customer.id,
                domain.merchant.id,
                creditLimit
            ]
        );

    return result.rows[0];
}

async function checkoutTempo({
    domain,
    account,
    quantity = 1
}) {
    return apiRequest({
        path:
            '/api/orders/checkout-v2',
        token:
            tokenFor(domain.customer),
        body: {
            items: [
                {
                    product_id:
                        domain.product.id,
                    quantity
                }
            ],
            fulfillment_type:
                'DELIVERY',
            shipping_address:
                'Synthetic Customer Tempo Atomic Checkout',
            payment_mode:
                'TEMPO',
            credit_account_id:
                account.id
        }
    });
}

async function loadAtomicState({
    orderId,
    productId
}) {
    const result =
        await pool.query(
            `
            SELECT
                (
                    SELECT status
                    FROM tbl_orders_v2
                    WHERE id = $1
                ) AS order_status,

                (
                    SELECT payment_mode
                    FROM tbl_orders_v2
                    WHERE id = $1
                ) AS payment_mode,

                (
                    SELECT COUNT(*)::int
                    FROM tbl_credit_obligations
                    WHERE source_type = 'ORDER'
                      AND source_id = $1
                ) AS obligations,

                (
                    SELECT COUNT(*)::int
                    FROM tbl_payments
                    WHERE order_id = $1
                ) AS payments,

                (
                    SELECT COUNT(*)::int
                    FROM tbl_general_ledger
                    WHERE transaction_reference = $2
                ) AS ledger_rows,

                (
                    SELECT COUNT(*)::int
                    FROM tbl_inventory_movements
                    WHERE product_id = $3
                      AND movement_type = 'SALE'
                      AND reference_doc = $2
                ) AS sale_movements,

                (
                    SELECT COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int
                    FROM tbl_inventory
                    WHERE product_id = $3
                ) AS inventory_quantity
            `,
            [
                orderId,
                `ORD-${orderId}`,
                productId
            ]
        );

    return result.rows[0];
}

async function cleanupAtomicCheckout({
    orderId,
    accountId
}) {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        if (orderId) {
            /*
             * Restore inventory dari SALE movement
             * milik synthetic checkout.
             */
            await client.query(
                `
                UPDATE tbl_inventory i
                SET
                    quantity_on_hand =
                        i.quantity_on_hand +
                        x.quantity,
                    updated_at =
                        CURRENT_TIMESTAMP
                FROM (
                    SELECT
                        product_id,
                        warehouse_id,
                        SUM(quantity)::int
                            AS quantity
                    FROM tbl_inventory_movements
                    WHERE reference_doc = $1
                      AND movement_type = 'SALE'
                    GROUP BY
                        product_id,
                        warehouse_id
                ) x
                WHERE i.product_id =
                        x.product_id
                  AND i.warehouse_id =
                        x.warehouse_id
                `,
                [
                    `ORD-${orderId}`
                ]
            );

            await client.query(
                `
                DELETE FROM tbl_inventory_movements
                WHERE reference_doc = $1
                  AND movement_type = 'SALE'
                `,
                [
                    `ORD-${orderId}`
                ]
            );

            await client.query(
                `
                DELETE FROM tbl_general_ledger
                WHERE transaction_reference = $1
                `,
                [
                    `ORD-${orderId}`
                ]
            );

            await client.query(
                `
                DELETE FROM tbl_credit_settlements
                WHERE obligation_id IN (
                    SELECT id
                    FROM tbl_credit_obligations
                    WHERE source_type = 'ORDER'
                      AND source_id = $1
                )
                `,
                [
                    orderId
                ]
            );

            await client.query(
                `
                DELETE FROM tbl_credit_obligations
                WHERE source_type = 'ORDER'
                  AND source_id = $1
                `,
                [
                    orderId
                ]
            );

            /*
             * Defensive cleanup bila payment pernah
             * tercipta karena regression.
             */
            await client.query(
                `
                DELETE FROM tbl_payments
                WHERE order_id = $1
                `,
                [
                    orderId
                ]
            );

            /*
             * Hapus item sebelum parent order.
             */
            await client.query(
                `
                DELETE FROM tbl_order_items
                WHERE order_id = $1
                `,
                [
                    orderId
                ]
            );

            await client.query(
                `
                DELETE FROM tbl_orders_v2
                WHERE id = $1
                `,
                [
                    orderId
                ]
            );
        }

        if (accountId) {
            await client.query(
                `
                DELETE FROM tbl_credit_accounts
                WHERE id = $1
                `,
                [
                    accountId
                ]
            );
        }

        await client.query('COMMIT');

    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        throw err;

    } finally {
        client.release();
    }
}

async function testAtomicTempoHappyPath() {
    let account = null;
    let orderId = null;

    const client =
        await pool.connect();

    try {
        const domain =
            await resolveDomain(client);

        account =
            await createCreditAccount(
                client,
                domain,
                100000
            );

        const before =
            await pool.query(
                `
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS stock
                FROM tbl_inventory
                WHERE product_id = $1
                `,
                [
                    domain.product.id
                ]
            );

        const stockBefore =
            Number(before.rows[0].stock);

        const response =
            await checkoutTempo({
                domain,
                account,
                quantity: 1
            });

        assert.equal(
            response.statusCode,
            201
        );

        assert.equal(
            response.data.status,
            'success'
        );

        assert.equal(
            response.data.order.payment_mode,
            'TEMPO'
        );

        assert.equal(
            response.data.order.status,
            'PACKING'
        );

        orderId =
            response.data.order.id;

        const state =
            await loadAtomicState({
                orderId,
                productId:
                    domain.product.id
            });

        assert.equal(
            state.payment_mode,
            'TEMPO'
        );

        assert.equal(
            state.order_status,
            'PACKING'
        );

        assert.equal(
            Number(state.obligations),
            1
        );

        assert.equal(
            Number(state.payments),
            0
        );

        assert.equal(
            Number(state.ledger_rows),
            2
        );

        assert.equal(
            Number(state.sale_movements),
            1
        );

        assert.equal(
            Number(state.inventory_quantity),
            stockBefore - 1
        );

        passed(
            'Atomic Customer TEMPO checkout succeeds'
        );

        passed(
            'Atomic TEMPO checkout enters PACKING'
        );

        passed(
            'Atomic TEMPO checkout creates receivable'
        );

        passed(
            'Atomic TEMPO checkout creates no payment'
        );

        passed(
            'Atomic TEMPO checkout posts balanced sale ledger'
        );

        passed(
            'Atomic TEMPO checkout fulfills inventory exactly once'
        );

    } finally {
        client.release();

        await cleanupAtomicCheckout({
            orderId,
            accountId:
                account
                    ? account.id
                    : null
        });
    }
}

async function main() {
    console.log(
        '===== CUSTOMER TEMPO ATOMIC CHECKOUT CONTRACT V1 ====='
    );

    try {
        await testAtomicTempoHappyPath();
        await testAtomicTempoInsufficientLimit();
        await testAtomicTempoFulfillmentRollback();
    } catch (err) {
        failed(
            'Atomic Customer TEMPO checkout contract',
            err
        );
    } finally {
        console.log(
            '===== ATOMIC CHECKOUT CONTRACT RESULT ====='
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
}

main();

async function testAtomicTempoInsufficientLimit() {
    let account = null;

    const client =
        await pool.connect();

    try {
        const domain =
            await resolveDomain(client);

        assert.ok(
            domain.product.unit_price > 0
        );

        const lowLimit =
            Math.max(
                0.01,
                domain.product.unit_price / 2
            );

        account =
            await createCreditAccount(
                client,
                domain,
                lowLimit
            );

        const response =
            await checkoutTempo({
                domain,
                account,
                quantity: 1
            });

        assert.equal(
            response.statusCode,
            409
        );

        passed(
            'Insufficient TEMPO limit returns 409'
        );

        const residue =
            await pool.query(
                `
                SELECT
                    COUNT(*)::int AS orders
                FROM tbl_orders_v2
                WHERE shipping_address =
                    'Synthetic Customer Tempo Atomic Checkout'
                `
            );

        assert.equal(
            residue.rows[0].orders,
            0
        );

        passed(
            'Insufficient TEMPO limit rolls back checkout order'
        );

        const financialResidue =
            await pool.query(
                `
                SELECT
                    (
                        SELECT COUNT(*)::int
                        FROM tbl_credit_obligations
                        WHERE credit_account_id = $1
                    ) AS obligations,

                    (
                        SELECT COUNT(*)::int
                        FROM tbl_general_ledger
                        WHERE description ILIKE
                            '%TEMPO%'
                          AND transaction_reference
                              LIKE 'ORD-%'
                    ) AS tempo_ledger
                `,
                [
                    account.id
                ]
            );

        assert.equal(
            financialResidue.rows[0]
                .obligations,
            0
        );

        passed(
            'Rejected atomic TEMPO creates no obligation'
        );

    } finally {
        client.release();

        await cleanupAtomicCheckout({
            orderId: null,
            accountId:
                account
                    ? account.id
                    : null
        });
    }
}

async function createSplitInventoryFixture({
    productId,
    quantity = 1
}) {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const warehouseResult =
            await client.query(
                `
                INSERT INTO tbl_warehouses (
                    warehouse_name,
                    location
                )
                VALUES (
                    $1,
                    $2
                )
                RETURNING *
                `,
                [
                    'Synthetic Atomic TEMPO Warehouse',
                    'Synthetic Contract Test Only'
                ]
            );

        const warehouse =
            warehouseResult.rows[0];

        const inventoryResult =
            await client.query(
                `
                INSERT INTO tbl_inventory (
                    warehouse_id,
                    product_id,
                    quantity_on_hand,
                    min_stock_level,
                    max_stock_level
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    0,
                    $3
                )
                RETURNING *
                `,
                [
                    warehouse.id,
                    productId,
                    quantity
                ]
            );

        await client.query('COMMIT');

        return {
            warehouse,
            inventory:
                inventoryResult.rows[0]
        };

    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        throw err;

    } finally {
        client.release();
    }
}

async function cleanupSplitInventoryFixture({
    warehouseId
}) {
    if (!warehouseId) {
        return;
    }

    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        /*
         * Hanya fixture dengan nama synthetic yang boleh
         * dihapus oleh contract test ini.
         */
        const warehouseResult =
            await client.query(
                `
                SELECT
                    id,
                    warehouse_name
                FROM tbl_warehouses
                WHERE id = $1
                FOR UPDATE
                `,
                [
                    warehouseId
                ]
            );

        if (!warehouseResult.rowCount) {
            await client.query('ROLLBACK');
            return;
        }

        if (
            warehouseResult.rows[0]
                .warehouse_name !==
            'Synthetic Atomic TEMPO Warehouse'
        ) {
            throw new Error(
                'Refuse cleanup non-synthetic warehouse'
            );
        }

        await client.query(
            `
            DELETE FROM tbl_inventory
            WHERE warehouse_id = $1
            `,
            [
                warehouseId
            ]
        );

        await client.query(
            `
            DELETE FROM tbl_warehouses
            WHERE id = $1
              AND warehouse_name =
                  'Synthetic Atomic TEMPO Warehouse'
            `,
            [
                warehouseId
            ]
        );

        await client.query('COMMIT');

    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        throw err;

    } finally {
        client.release();
    }
}

async function testAtomicTempoFulfillmentRollback() {
    let account = null;
    let splitFixture = null;

    const client =
        await pool.connect();

    try {
        const domain =
            await resolveDomain(client);

        const inventoryBefore =
            await pool.query(
                `
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS total_stock,
                    COALESCE(
                        MAX(quantity_on_hand),
                        0
                    )::int AS max_single_row
                FROM tbl_inventory
                WHERE product_id = $1
                `,
                [
                    domain.product.id
                ]
            );

        const originalTotal =
            Number(
                inventoryBefore.rows[0]
                    .total_stock
            );

        const originalMax =
            Number(
                inventoryBefore.rows[0]
                    .max_single_row
            );

        assert.ok(originalTotal > 0);
        assert.ok(originalMax > 0);

        /*
         * Tambah satu row inventory synthetic di warehouse
         * terpisah.
         *
         * Checkout validation akan melihat SUM:
         * originalTotal + 1.
         *
         * Fulfillment hanya boleh mengambil dari SATU row.
         * Maka quantity originalMax + 1 akan lolos hanya bila
         * total stock cukup, tetapi tidak ada satu row yang
         * mampu memenuhinya.
         */
        splitFixture =
            await createSplitInventoryFixture({
                productId:
                    domain.product.id,
                quantity: 1
            });

        const totalWithFixture =
            originalTotal + 1;

        const requestedQuantity =
            originalMax + 1;

        assert.ok(
            totalWithFixture >=
            requestedQuantity
        );

        account =
            await createCreditAccount(
                client,
                domain,
                Math.max(
                    100000,
                    domain.product.unit_price *
                    requestedQuantity *
                    2
                )
            );

        const saleBeforeResult =
            await pool.query(
                `
                SELECT
                    COUNT(*)::int AS total
                FROM tbl_inventory_movements
                WHERE product_id = $1
                  AND movement_type = 'SALE'
                `,
                [
                    domain.product.id
                ]
            );

        const saleBefore =
            Number(
                saleBeforeResult.rows[0].total
            );

        const response =
            await checkoutTempo({
                domain,
                account,
                quantity:
                    requestedQuantity
            });

        assert.equal(
            response.statusCode,
            409
        );

        passed(
            'Fulfillment failure returns 409'
        );

        const orderResidue =
            await pool.query(
                `
                SELECT
                    COUNT(*)::int AS total
                FROM tbl_orders_v2
                WHERE shipping_address =
                    'Synthetic Customer Tempo Atomic Checkout'
                `
            );

        assert.equal(
            orderResidue.rows[0].total,
            0
        );

        passed(
            'Fulfillment failure rolls back checkout order'
        );

        const obligationResidue =
            await pool.query(
                `
                SELECT
                    COUNT(*)::int AS total
                FROM tbl_credit_obligations
                WHERE credit_account_id = $1
                `,
                [
                    account.id
                ]
            );

        assert.equal(
            obligationResidue.rows[0].total,
            0
        );

        passed(
            'Fulfillment failure rolls back receivable'
        );

        const ledgerResidue =
            await pool.query(
                `
                SELECT
                    COUNT(*)::int AS total
                FROM tbl_general_ledger
                WHERE description ILIKE
                    '%TEMPO%'
                  AND transaction_reference
                      LIKE 'ORD-%'
                `
            );

        assert.equal(
            ledgerResidue.rows[0].total,
            0
        );

        passed(
            'Fulfillment failure rolls back TEMPO ledger'
        );

        const saleAfterResult =
            await pool.query(
                `
                SELECT
                    COUNT(*)::int AS total
                FROM tbl_inventory_movements
                WHERE product_id = $1
                  AND movement_type = 'SALE'
                `,
                [
                    domain.product.id
                ]
            );

        const saleAfter =
            Number(
                saleAfterResult.rows[0].total
            );

        assert.equal(
            saleAfter,
            saleBefore
        );

        passed(
            'Fulfillment failure creates no new SALE movement'
        );

        const inventoryAfter =
            await pool.query(
                `
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS total_stock
                FROM tbl_inventory
                WHERE product_id = $1
                  AND warehouse_id <> $2
                `,
                [
                    domain.product.id,
                    splitFixture.warehouse.id
                ]
            );

        assert.equal(
            Number(
                inventoryAfter.rows[0]
                    .total_stock
            ),
            originalTotal
        );

        passed(
            'Fulfillment failure leaves production inventory unchanged'
        );

    } finally {
        client.release();

        if (account) {
            await cleanupAtomicCheckout({
                orderId: null,
                accountId:
                    account.id
            });
        }

        if (splitFixture) {
            await cleanupSplitInventoryFixture({
                warehouseId:
                    splitFixture.warehouse.id
            });
        }
    }
}
