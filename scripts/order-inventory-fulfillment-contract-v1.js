require('dotenv').config();

const assert = require('assert');
const pool = require('../src/config/db');

const OrderInventoryFulfillmentService =
    require(
        '../src/services/orders/OrderInventoryFulfillmentService'
    );

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

async function resolveFixture(client) {
    /*
     * Pilih product yang:
     * - punya merchant
     * - punya inventory
     * - stok minimal 3
     *
     * Kita tidak membuat product/inventory synthetic baru.
     * Semua perubahan akan berada dalam transaction test.
     */
    const result =
        await client.query(
            `
            SELECT
                p.id AS product_id,
                p.merchant_id,
                p.name AS product_name,
                i.id AS inventory_id,
                i.warehouse_id,
                i.quantity_on_hand
            FROM tbl_products p
            JOIN tbl_inventory i
                ON i.product_id = p.id
            WHERE p.merchant_id IS NOT NULL
              AND COALESCE(
                    i.quantity_on_hand,
                    0
                  ) >= 3
            ORDER BY
                i.quantity_on_hand DESC,
                p.id,
                i.id
            LIMIT 1
            `
        );

    if (!result.rowCount) {
        throw new Error(
            'Fixture product dengan stok >= 3 tidak tersedia'
        );
    }

    return result.rows[0];
}

async function resolveCustomer(client) {
    const result =
        await client.query(
            `
            SELECT id
            FROM tbl_customers
            ORDER BY created_at, id
            LIMIT 1
            `
        );

    if (!result.rowCount) {
        throw new Error(
            'Customer fixture tidak tersedia'
        );
    }

    return result.rows[0];
}

async function createOrder({
    client,
    customerId,
    merchantId,
    productId,
    quantity = 2
}) {
    const orderResult =
        await client.query(
            `
            INSERT INTO tbl_orders_v2 (
                customer_id,
                merchant_id,
                status,
                shipping_address,
                total_amount,
                fulfillment_type,
                payment_mode
            )
            VALUES (
                $1,
                $2,
                'PENDING',
                'Synthetic Inventory Fulfillment Contract',
                $3,
                'DELIVERY',
                'DIRECT'
            )
            RETURNING *
            `,
            [
                customerId,
                merchantId,
                quantity * 1000
            ]
        );

    const order =
        orderResult.rows[0];

    await client.query(
        `
        INSERT INTO tbl_order_items (
            order_id,
            product_id,
            quantity,
            unit_price
        )
        VALUES (
            $1,
            $2,
            $3,
            1000
        )
        `,
        [
            order.id,
            productId,
            quantity
        ]
    );

    return order;
}

async function testHappyPathAndRetry() {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const fixture =
            await resolveFixture(client);

        const customer =
            await resolveCustomer(client);

        const quantity = 2;

        const beforeResult =
            await client.query(
                `
                SELECT quantity_on_hand
                FROM tbl_inventory
                WHERE id = $1
                FOR UPDATE
                `,
                [
                    fixture.inventory_id
                ]
            );

        const before =
            Number(
                beforeResult.rows[0]
                    .quantity_on_hand
            );

        const order =
            await createOrder({
                client,
                customerId:
                    customer.id,
                merchantId:
                    fixture.merchant_id,
                productId:
                    fixture.product_id,
                quantity
            });

        const service =
            new OrderInventoryFulfillmentService(
                client
            );

        const first =
            await service.fulfillOrderSale({
                orderId:
                    order.id
            });

        assert.equal(
            first.movements.length,
            1
        );

        assert.equal(
            first.movements[0].status,
            'created'
        );

        passed(
            'SALE fulfillment created'
        );

        const afterFirstResult =
            await client.query(
                `
                SELECT quantity_on_hand
                FROM tbl_inventory
                WHERE id = $1
                `,
                [
                    fixture.inventory_id
                ]
            );

        const afterFirst =
            Number(
                afterFirstResult.rows[0]
                    .quantity_on_hand
            );

        assert.equal(
            afterFirst,
            before - quantity
        );

        passed(
            'SALE fulfillment decreases inventory'
        );

        const movementResult =
            await client.query(
                `
                SELECT
                    COUNT(*)::int AS rows,
                    COALESCE(
                        SUM(quantity),
                        0
                    )::int AS quantity
                FROM tbl_inventory_movements
                WHERE reference_doc = $1
                  AND product_id = $2
                  AND movement_type = 'SALE'
                `,
                [
                    `ORD-${order.id}`,
                    fixture.product_id
                ]
            );

        assert.equal(
            movementResult.rows[0].rows,
            1
        );

        assert.equal(
            movementResult.rows[0].quantity,
            quantity
        );

        passed(
            'SALE fulfillment creates exactly one movement'
        );

        /*
         * Replay.
         */
        const second =
            await service.fulfillOrderSale({
                orderId:
                    order.id
            });

        assert.equal(
            second.movements.length,
            1
        );

        assert.equal(
            second.movements[0].status,
            'existing'
        );

        passed(
            'SALE fulfillment retry is idempotent'
        );

        const afterRetryResult =
            await client.query(
                `
                SELECT quantity_on_hand
                FROM tbl_inventory
                WHERE id = $1
                `,
                [
                    fixture.inventory_id
                ]
            );

        assert.equal(
            Number(
                afterRetryResult.rows[0]
                    .quantity_on_hand
            ),
            afterFirst
        );

        passed(
            'SALE retry does not decrease inventory twice'
        );

        const movementRetryResult =
            await client.query(
                `
                SELECT COUNT(*)::int AS rows
                FROM tbl_inventory_movements
                WHERE reference_doc = $1
                  AND product_id = $2
                  AND movement_type = 'SALE'
                `,
                [
                    `ORD-${order.id}`,
                    fixture.product_id
                ]
            );

        assert.equal(
            movementRetryResult.rows[0].rows,
            1
        );

        passed(
            'SALE retry does not duplicate movement'
        );

        await client.query('ROLLBACK');

        passed(
            'Happy-path fulfillment transaction rolled back'
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

async function testInsufficientStock() {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const fixture =
            await resolveFixture(client);

        const customer =
            await resolveCustomer(client);

        const stock =
            Number(
                fixture.quantity_on_hand
            );

        const quantity =
            stock + 100;

        const order =
            await createOrder({
                client,
                customerId:
                    customer.id,
                merchantId:
                    fixture.merchant_id,
                productId:
                    fixture.product_id,
                quantity
            });

        const service =
            new OrderInventoryFulfillmentService(
                client
            );

        let rejected = false;

        try {
            await service.fulfillOrderSale({
                orderId:
                    order.id
            });
        } catch (err) {
            rejected =
                /Stok tidak mencukupi/i
                    .test(
                        String(
                            err.message || ''
                        )
                    );
        }

        assert.equal(
            rejected,
            true
        );

        passed(
            'Insufficient stock rejected'
        );

        const movementResult =
            await client.query(
                `
                SELECT COUNT(*)::int AS rows
                FROM tbl_inventory_movements
                WHERE reference_doc = $1
                  AND movement_type = 'SALE'
                `,
                [
                    `ORD-${order.id}`
                ]
            );

        assert.equal(
            movementResult.rows[0].rows,
            0
        );

        passed(
            'Rejected stock creates no SALE movement'
        );

        await client.query('ROLLBACK');

        passed(
            'Insufficient-stock transaction rolled back'
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

async function testMerchantOwnershipGuard() {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const fixture =
            await resolveFixture(client);

        const customer =
            await resolveCustomer(client);

        /*
         * Buat Merchant synthetic kedua.
         *
         * tbl_merchants.user_id tidak memiliki UNIQUE constraint,
         * jadi user existing dapat dipakai sebagai fixture
         * di dalam transaction test.
         */
        const merchantUserResult =
            await client.query(
                `
                SELECT id
                FROM tbl_users
                WHERE id IS NOT NULL
                ORDER BY created_at, id
                LIMIT 1
                `
            );

        if (!merchantUserResult.rowCount) {
            throw new Error(
                'User fixture tidak tersedia'
            );
        }

        const syntheticMerchantResult =
            await client.query(
                `
                INSERT INTO tbl_merchants (
                    user_id,
                    store_name,
                    address,
                    status
                )
                VALUES (
                    $1,
                    'Synthetic Ownership Merchant',
                    'Synthetic Ownership Test',
                    'ACTIVE'
                )
                RETURNING id
                `,
                [
                    merchantUserResult.rows[0].id
                ]
            );

        const syntheticMerchant =
            syntheticMerchantResult.rows[0];

        assert.notEqual(
            String(
                syntheticMerchant.id
            ),
            String(
                fixture.merchant_id
            )
        );

        /*
         * Order mengaku milik synthetic merchant,
         * sedangkan product tetap milik merchant asli.
         */
        const order =
            await createOrder({
                client,
                customerId:
                    customer.id,
                merchantId:
                    syntheticMerchant.id,
                productId:
                    fixture.product_id,
                quantity:
                    1
            });

        const service =
            new OrderInventoryFulfillmentService(
                client
            );

        let rejected = false;

        try {
            await service.fulfillOrderSale({
                orderId:
                    order.id
            });

        } catch (err) {
            rejected =
                /bukan milik Merchant order/i
                    .test(
                        String(
                            err.message || ''
                        )
                    );
        }

        assert.equal(
            rejected,
            true
        );

        passed(
            'Wrong merchant product rejected'
        );

        const movementResult =
            await client.query(
                `
                SELECT COUNT(*)::int AS rows
                FROM tbl_inventory_movements
                WHERE reference_doc = $1
                  AND movement_type = 'SALE'
                `,
                [
                    `ORD-${order.id}`
                ]
            );

        assert.equal(
            movementResult.rows[0].rows,
            0
        );

        passed(
            'Wrong merchant rejection creates no SALE movement'
        );

        const inventoryResult =
            await client.query(
                `
                SELECT quantity_on_hand
                FROM tbl_inventory
                WHERE id = $1
                `,
                [
                    fixture.inventory_id
                ]
            );

        assert.equal(
            Number(
                inventoryResult.rows[0]
                    .quantity_on_hand
            ),
            Number(
                fixture.quantity_on_hand
            )
        );

        passed(
            'Wrong merchant rejection leaves inventory unchanged'
        );

        await client.query('ROLLBACK');

        passed(
            'Merchant ownership transaction rolled back'
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

async function verifyZeroResidue() {
    const result =
        await pool.query(
            `
            SELECT
                COUNT(*)::int AS orders
            FROM tbl_orders_v2
            WHERE shipping_address =
                'Synthetic Inventory Fulfillment Contract'
            `
        );

    assert.equal(
        result.rows[0].orders,
        0
    );

    passed(
        'Synthetic inventory fulfillment data leaves zero residue'
    );
}

async function main() {
    console.log(
        '===== ORDER INVENTORY FULFILLMENT CONTRACT V1 ====='
    );

    const tests = [
        [
            'Happy path and retry',
            testHappyPathAndRetry
        ],
        [
            'Insufficient stock',
            testInsufficientStock
        ],
        [
            'Merchant ownership',
            testMerchantOwnershipGuard
        ],
        [
            'Zero residue',
            verifyZeroResidue
        ]
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (err) {
            failed(
                name,
                err
            );
        }
    }

    console.log(
        '===== ORDER INVENTORY FULFILLMENT CONTRACT RESULT ====='
    );

    console.log(
        `PASS: ${pass}`
    );

    console.log(
        `FAIL: ${fail}`
    );

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

main();
