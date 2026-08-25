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

    return {
        account:
            accountResult.rows[0],
        order:
            orderResult.rows[0]
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
            'PENDING'
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
            'TEMPO order remains PENDING with credit snapshot'
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

async function main() {
    console.log(
        '===== CUSTOMER TEMPO API CONTRACT V1 ====='
    );

    try {
        await testCustomerTempoApi();

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
