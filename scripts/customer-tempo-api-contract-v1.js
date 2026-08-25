require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

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

async function apiRequest({
    path,
    token,
    method = 'POST',
    body = null
}) {
    const response =
        await fetch(
            `http://127.0.0.1:3000${path}`,
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

    let data = null;

    try {
        data = await response.json();
    } catch (_) {
        data = {};
    }

    return {
        statusCode:
            response.status,
        data
    };
}

async function resolveDomain(client) {
    const merchantResult =
        await client.query(`
            SELECT
                id,
                user_id,
                store_name
            FROM tbl_merchants
            WHERE status = 'ACTIVE'
              AND user_id IS NOT NULL
            ORDER BY created_at
            LIMIT 1
        `);

    if (!merchantResult.rowCount) {
        throw new Error(
            'Merchant synthetic tidak tersedia'
        );
    }

    const merchant =
        merchantResult.rows[0];

    const customersResult =
        await client.query(`
            SELECT
                c.id,
                c.user_id,
                c.full_name,
                u.role_id
            FROM tbl_customers c
            JOIN tbl_users u
                ON u.id = c.user_id
            WHERE u.role_id = 1
              AND u.is_active = TRUE
            ORDER BY c.created_at
            LIMIT 2
        `);

    if (customersResult.rowCount < 2) {
        throw new Error(
            'Diperlukan minimal dua Customer untuk ownership contract'
        );
    }

    return {
        merchant,
        owner:
            customersResult.rows[0],
        stranger:
            customersResult.rows[1]
    };
}

function makeCustomerToken(customer) {
    if (!process.env.JWT_SECRET) {
        throw new Error(
            'JWT_SECRET tidak tersedia'
        );
    }

    return jwt.sign(
        {
            id:
                customer.user_id,
            role_id:
                1
        },
        process.env.JWT_SECRET,
        {
            expiresIn:
                '10m'
        }
    );
}

async function createScenario(
    client,
    domain,
    {
        creditLimit = 100000,
        orderAmount = 3500
    } = {}
) {
    const accountResult =
        await client.query(
            `
            INSERT INTO tbl_credit_accounts (
                account_type,
                customer_id,
                merchant_id,
                credit_limit,
                default_term_days,
                status,
                approved_at
            )
            VALUES (
                'CUSTOMER',
                $1,
                $2,
                $3,
                7,
                'ACTIVE',
                CURRENT_TIMESTAMP
            )
            RETURNING *
            `,
            [
                domain.owner.id,
                domain.merchant.id,
                creditLimit
            ]
        );

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
                'Synthetic Customer Tempo API',
                $3,
                'DELIVERY',
                'DIRECT'
            )
            RETURNING *
            `,
            [
                domain.owner.id,
                domain.merchant.id,
                orderAmount
            ]
        );

    const productResult =
        await client.query(
            `
            SELECT
                p.id AS product_id,
                i.quantity_on_hand
            FROM tbl_products p
            JOIN tbl_inventory i
                ON i.product_id = p.id
            WHERE p.merchant_id = $1
              AND p.status = 'ACTIVE'
              AND COALESCE(
                    i.quantity_on_hand,
                    0
                  ) >= 1
            ORDER BY
                i.quantity_on_hand DESC,
                p.id
            LIMIT 1
            `,
            [
                domain.merchant.id
            ]
        );

    if (!productResult.rowCount) {
        throw new Error(
            'Synthetic TEMPO fixture product tidak tersedia'
        );
    }

    const product =
        productResult.rows[0];

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
            1,
            $3
        )
        `,
        [
            orderResult.rows[0].id,
            product.product_id,
            orderAmount
        ]
    );

    return {
        account:
            accountResult.rows[0],
        order:
            orderResult.rows[0],
        product
    };
}

async function cleanupScenario({
    orderId,
    accountId
}) {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        /*
         * Hapus jurnal synthetic ORDER terlebih dahulu.
         */
        if (orderId) {
            /*
             * =================================================
             * Restore inventory dari synthetic SALE movement.
             *
             * API contract memanggil endpoint production yang
             * COMMIT fulfillment. Karena scenario test kemudian
             * dihapus, stock + movement juga harus dikompensasi.
             *
             * Hanya movement milik synthetic order ini yang
             * disentuh.
             * =================================================
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

            /*
             * Settlement seharusnya tidak ada,
             * tetapi cleanup dibuat defensif.
             */
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

async function getScenarioState({
    orderId,
    accountId
}) {
    const result =
        await pool.query(
            `
            SELECT
                (
                    SELECT COUNT(*)
                    FROM tbl_orders_v2
                    WHERE id = $1
                )::int AS orders,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_accounts
                    WHERE id = $2
                )::int AS accounts,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_obligations
                    WHERE source_type = 'ORDER'
                      AND source_id = $1
                )::int AS obligations,

                (
                    SELECT COUNT(*)
                    FROM tbl_payments
                    WHERE order_id = $1
                )::int AS payments,

                (
                    SELECT COUNT(*)
                    FROM tbl_general_ledger
                    WHERE transaction_reference = $3
                )::int AS ledger_rows
            `,
            [
                orderId,
                accountId,
                `ORD-${orderId}`
            ]
        );

    return result.rows[0];
}

async function createCommittedScenario() {
    const client =
        await pool.connect();

    let scenario = null;

    try {
        await client.query('BEGIN');

        const domain =
            await resolveDomain(client);

        const created =
            await createScenario(
                client,
                domain,
                {
                    creditLimit:
                        100000,
                    orderAmount:
                        3500
                }
            );

        scenario = {
            domain,
            account:
                created.account,
            order:
                created.order,
            product:
                created.product,
            ownerToken:
                makeCustomerToken(
                    domain.owner
                ),
            strangerToken:
                makeCustomerToken(
                    domain.stranger
                )
        };

        await client.query('COMMIT');

        return scenario;

    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        throw err;

    } finally {
        client.release();
    }
}

async function loadInventoryState({
    orderId,
    productId
}) {
    const result = await pool.query(
        `
        SELECT
            (
                SELECT COALESCE(
                    SUM(quantity_on_hand),
                    0
                )::int
                FROM tbl_inventory
                WHERE product_id = $1
            ) AS inventory_quantity,
            (
                SELECT COUNT(*)::int
                FROM tbl_inventory_movements
                WHERE product_id = $1
                  AND movement_type = 'SALE'
                  AND reference_doc = $2
            ) AS sale_movements,
            (
                SELECT COALESCE(
                    SUM(quantity),
                    0
                )::int
                FROM tbl_inventory_movements
                WHERE product_id = $1
                  AND movement_type = 'SALE'
                  AND reference_doc = $2
            ) AS sale_quantity
        `,
        [
            productId,
            `ORD-${orderId}`
        ]
    );

    return result.rows[0];
}

async function loadOrderState(orderId) {
    const result =
        await pool.query(
            `
            SELECT
                id,
                customer_id,
                merchant_id,
                status,
                total_amount,
                payment_mode,
                credit_account_id,
                tempo_due_at
            FROM tbl_orders_v2
            WHERE id = $1
            `,
            [
                orderId
            ]
        );

    if (!result.rowCount) {
        return null;
    }

    return result.rows[0];
}

async function loadObligations(orderId) {
    const result =
        await pool.query(
            `
            SELECT *
            FROM tbl_credit_obligations
            WHERE source_type = 'ORDER'
              AND source_id = $1
            ORDER BY created_at
            `,
            [
                orderId
            ]
        );

    return result.rows;
}

async function loadOrderPayments(orderId) {
    const result =
        await pool.query(
            `
            SELECT *
            FROM tbl_payments
            WHERE order_id = $1
            ORDER BY created_at
            `,
            [
                orderId
            ]
        );

    return result.rows;
}

async function loadOrderLedger(orderId) {
    const result =
        await pool.query(
            `
            SELECT
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit
            FROM tbl_general_ledger
            WHERE transaction_reference = $1
            ORDER BY account_code
            `,
            [
                `ORD-${orderId}`
            ]
        );

    return result.rows;
}

async function testCustomerTempoApi() {
    let scenario = null;

    try {
        scenario =
            await createCommittedScenario();

        const orderId =
            scenario.order.id;

        const accountId =
            scenario.account.id;

        /*
         * ====================================================
         * 1. PRECONDITION
         * ====================================================
         */
        const before =
            await getScenarioState({
                orderId,
                accountId
            });

        assert.equal(
            before.orders,
            1
        );

        assert.equal(
            before.accounts,
            1
        );

        assert.equal(
            before.obligations,
            0
        );

        assert.equal(
            before.payments,
            0
        );

        assert.equal(
            before.ledger_rows,
            0
        );

        passed(
            'Synthetic Customer TEMPO API fixture created'
        );

        /*
         * ====================================================
         * 2. CUSTOMER LAIN TIDAK BOLEH MENGAKTIFKAN
         * ====================================================
         */
        const forbidden =
            await apiRequest({
                path:
                    `/api/customer/credit-orders-v1/${orderId}/tempo`,
                token:
                    scenario.strangerToken,
                body: {
                    credit_account_id:
                        accountId
                }
            });

        assert.equal(
            forbidden.statusCode,
            403
        );

        passed(
            'Other Customer cannot activate TEMPO order'
        );

        const afterForbidden =
            await loadOrderState(
                orderId
            );

        assert.equal(
            afterForbidden.payment_mode,
            'DIRECT'
        );

        assert.equal(
            afterForbidden.status,
            'PENDING'
        );

        assert.equal(
            (
                await loadObligations(
                    orderId
                )
            ).length,
            0
        );

        assert.equal(
            (
                await loadOrderLedger(
                    orderId
                )
            ).length,
            0
        );

        passed(
            'Rejected ownership attempt leaves order unchanged'
        );

        /*
         * ====================================================
         * 3. OWNER MENGAKTIFKAN TEMPO
         * ====================================================
         */
        const inventoryBefore =
            await loadInventoryState({
                orderId:
                    orderId,
                productId:
                    scenario.product.product_id
            });

        const activation =
            await apiRequest({
                path:
                    `/api/customer/credit-orders-v1/${orderId}/tempo`,
                token:
                    scenario.ownerToken,
                body: {
                    credit_account_id:
                        accountId
                }
            });

        assert.equal(
            activation.statusCode,
            201
        );

        assert.equal(
            activation.data.status,
            'success'
        );

        assert.equal(
            activation.data.idempotent,
            false
        );

        passed(
            'Order owner can activate Customer TEMPO'
        );

        /*
         * ====================================================
         * 4. ORDER CONTRACT
         * ====================================================
         */
        const tempoOrder =
            await loadOrderState(
                orderId
            );

        assert.ok(
            tempoOrder
        );

        assert.equal(
            tempoOrder.status,
            'PACKING'
        );

        assert.equal(
            tempoOrder.payment_mode,
            'TEMPO'
        );

        assert.equal(
            String(
                tempoOrder.credit_account_id
            ),
            String(
                accountId
            )
        );

        assert.ok(
            tempoOrder.tempo_due_at
        );

        passed(
            'TEMPO order enters PACKING with credit snapshot'
        );


        const inventoryAfter =
            await loadInventoryState({
                orderId:
                    orderId,
                productId:
                    scenario.product.product_id
            });

        assert.equal(
            Number(
                inventoryAfter.inventory_quantity
            ),
            Number(
                inventoryBefore.inventory_quantity
            ) - 1
        );

        passed(
            'Customer TEMPO decreases inventory exactly once'
        );

        assert.equal(
            inventoryAfter.sale_movements,
            1
        );

        assert.equal(
            inventoryAfter.sale_quantity,
            1
        );

        passed(
            'Customer TEMPO creates exactly one SALE movement'
        );

        /*
         * ====================================================
         * 5. OBLIGATION CONTRACT
         * ====================================================
         */
        const obligations =
            await loadObligations(
                orderId
            );

        assert.equal(
            obligations.length,
            1
        );

        const obligation =
            obligations[0];

        assert.equal(
            String(
                obligation.credit_account_id
            ),
            String(
                accountId
            )
        );

        assert.equal(
            Number(
                obligation.principal_amount
            ),
            3500
        );

        assert.equal(
            Number(
                obligation.paid_amount
            ),
            0
        );

        assert.equal(
            obligation.status,
            'OPEN'
        );

        passed(
            'Customer TEMPO creates one receivable obligation'
        );

        /*
         * ====================================================
         * 6. TEMPO BUKAN PAYMENT
         * ====================================================
         */
        const payments =
            await loadOrderPayments(
                orderId
            );

        assert.equal(
            payments.length,
            0
        );

        passed(
            'Customer TEMPO creates no payment row'
        );

        /*
         * ====================================================
         * 7. FINANCE CONTRACT
         *
         * Dr 1300 Piutang Usaha
         * Cr 4000 Pendapatan Penjualan
         * ====================================================
         */
        const ledger =
            await loadOrderLedger(
                orderId
            );

        assert.equal(
            ledger.length,
            2
        );

        const receivable =
            ledger.find(
                row =>
                    row.account_code ===
                    '1300'
            );

        const revenue =
            ledger.find(
                row =>
                    row.account_code ===
                    '4000'
            );

        assert.ok(
            receivable
        );

        assert.ok(
            revenue
        );

        assert.equal(
            Number(
                receivable.debit
            ),
            3500
        );

        assert.equal(
            Number(
                receivable.credit
            ),
            0
        );

        assert.equal(
            Number(
                revenue.debit
            ),
            0
        );

        assert.equal(
            Number(
                revenue.credit
            ),
            3500
        );

        assert.equal(
            Number(receivable.debit) +
                Number(revenue.debit),
            Number(receivable.credit) +
                Number(revenue.credit)
        );

        passed(
            'Customer TEMPO posts balanced receivable journal'
        );

        /*
         * ====================================================
         * 8. RETRY IDEMPOTENT
         * ====================================================
         */
        const retry =
            await apiRequest({
                path:
                    `/api/customer/credit-orders-v1/${orderId}/tempo`,
                token:
                    scenario.ownerToken,
                body: {
                    credit_account_id:
                        accountId
                }
            });

        assert.equal(
            retry.statusCode,
            200
        );

        assert.equal(
            retry.data.idempotent,
            true
        );

        passed(
            'Customer TEMPO API retry is idempotent'
        );


        const inventoryAfterRetry =
            await loadInventoryState({
                orderId:
                    orderId,
                productId:
                    scenario.product.product_id
            });

        assert.equal(
            Number(
                inventoryAfterRetry.inventory_quantity
            ),
            Number(
                inventoryAfter.inventory_quantity
            )
        );

        passed(
            'Customer TEMPO retry does not decrease inventory twice'
        );

        assert.equal(
            inventoryAfterRetry.sale_movements,
            1
        );

        assert.equal(
            inventoryAfterRetry.sale_quantity,
            1
        );

        passed(
            'Customer TEMPO retry does not duplicate SALE movement'
        );

        assert.equal(
            (
                await loadObligations(
                    orderId
                )
            ).length,
            1
        );

        assert.equal(
            (
                await loadOrderPayments(
                    orderId
                )
            ).length,
            0
        );

        assert.equal(
            (
                await loadOrderLedger(
                    orderId
                )
            ).length,
            2
        );

        passed(
            'TEMPO retry creates no duplicate financial records'
        );

    } finally {
        if (scenario) {
            await cleanupScenario({
                orderId:
                    scenario.order.id,
                accountId:
                    scenario.account.id
            });
        }
    }
}


async function testCustomerTempoInsufficientStock() {
    let scenario = null;

    try {
        scenario =
            await createCommittedScenario();

        const orderId =
            scenario.order.id;

        const accountId =
            scenario.account.id;

        const productId =
            scenario.product.product_id;

        /*
         * Snapshot inventory sebelum failure test.
         */
        const inventoryBefore =
            await loadInventoryState({
                orderId,
                productId
            });

        const currentStock =
            Number(
                inventoryBefore.inventory_quantity
            );

        assert.ok(
            currentStock >= 0
        );

        /*
         * Paksa quantity order melebihi stok tersedia.
         * Order + account adalah fixture synthetic.
         */
        await pool.query(
            `
            UPDATE tbl_order_items
            SET quantity = $2
            WHERE order_id = $1
              AND product_id = $3
            `,
            [
                orderId,
                currentStock + 1,
                productId
            ]
        );

        const activation =
            await apiRequest({
                path:
                    `/api/customer/credit-orders-v1/${orderId}/tempo`,
                token:
                    scenario.ownerToken,
                body: {
                    credit_account_id:
                        accountId
                }
            });

        assert.equal(
            activation.statusCode,
            409
        );

        passed(
            'Insufficient stock rejects Customer TEMPO with 409'
        );

        /*
         * Karena route memakai satu PostgreSQL transaction,
         * perubahan finance sebelum inventory failure harus
         * ikut rollback.
         */
        const orderAfter =
            await loadOrderState(
                orderId
            );

        assert.equal(
            orderAfter.payment_mode,
            'DIRECT'
        );

        assert.equal(
            orderAfter.status,
            'PENDING'
        );

        assert.equal(
            orderAfter.credit_account_id,
            null
        );

        assert.equal(
            orderAfter.tempo_due_at,
            null
        );

        passed(
            'Insufficient stock rolls order back to DIRECT PENDING'
        );

        assert.equal(
            (
                await loadObligations(
                    orderId
                )
            ).length,
            0
        );

        passed(
            'Insufficient stock rolls back Customer receivable obligation'
        );

        assert.equal(
            (
                await loadOrderLedger(
                    orderId
                )
            ).length,
            0
        );

        passed(
            'Insufficient stock rolls back Customer TEMPO ledger'
        );

        assert.equal(
            (
                await loadOrderPayments(
                    orderId
                )
            ).length,
            0
        );

        passed(
            'Insufficient stock creates no payment'
        );

        const inventoryAfter =
            await loadInventoryState({
                orderId,
                productId
            });

        assert.equal(
            Number(
                inventoryAfter.inventory_quantity
            ),
            currentStock
        );

        assert.equal(
            inventoryAfter.sale_movements,
            0
        );

        assert.equal(
            inventoryAfter.sale_quantity,
            0
        );

        passed(
            'Insufficient stock leaves inventory and SALE unchanged'
        );

    } finally {
        if (scenario) {
            await cleanupScenario({
                orderId:
                    scenario.order.id,
                accountId:
                    scenario.account.id
            });
        }
    }
}

async function main() {
    console.log(
        '===== CUSTOMER TEMPO API CONTRACT V1 ====='
    );

    try {
        await testCustomerTempoApi();
        await testCustomerTempoInsufficientStock();

    } catch (err) {
        failed(
            'Customer TEMPO API contract',
            err
        );

    } finally {
        try {
            const residue =
                await pool.query(`
                    SELECT
                        COUNT(*) FILTER (
                            WHERE shipping_address =
                                'Synthetic Customer Tempo API'
                        )::int AS synthetic_orders
                    FROM tbl_orders_v2
                `);

            assert.equal(
                residue.rows[0]
                    .synthetic_orders,
                0
            );

            passed(
                'Synthetic Customer TEMPO API data leaves zero residue'
            );

        } catch (err) {
            failed(
                'Synthetic cleanup verification',
                err
            );
        }

        console.log(
            '===== CUSTOMER TEMPO API CONTRACT RESULT ====='
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
}

main();
