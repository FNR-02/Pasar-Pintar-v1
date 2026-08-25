require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');
const pool = require('../src/config/db');

const CustomerReceivableService =
    require(
        '../src/services/credit/CustomerReceivableService'
    );

let pass = 0;
let fail = 0;

function passed(name) {
    pass++;
    console.log(
        `PASS  ${name}`
    );
}

function failed(name, err) {
    fail++;
    console.error(
        `FAIL  ${name}: ${err.message}`
    );
}

async function resolveDomain(client) {
    const result =
        await client.query(`
            SELECT
                c.id AS customer_id,
                c.full_name,
                m.id AS merchant_id,
                m.store_name,
                p.id AS product_id,
                p.name AS product_name,
                i.warehouse_id
            FROM tbl_customers c
            CROSS JOIN LATERAL (
                SELECT
                    id,
                    store_name
                FROM tbl_merchants
                WHERE status='ACTIVE'
                ORDER BY created_at
                LIMIT 1
            ) m
            CROSS JOIN LATERAL (
                SELECT
                    p.id,
                    p.name
                FROM tbl_products p
                WHERE p.merchant_id=m.id
                  AND p.status='ACTIVE'
                ORDER BY p.created_at
                LIMIT 1
            ) p
            CROSS JOIN LATERAL (
                SELECT
                    warehouse_id
                FROM tbl_inventory
                WHERE product_id=p.id
                LIMIT 1
            ) i
            ORDER BY c.created_at
            LIMIT 1
        `);

    if (!result.rowCount) {
        throw new Error(
            'Synthetic Customer Tempo domain tidak tersedia'
        );
    }

    return result.rows[0];
}

async function createScenario(
    client,
    {
        creditLimit = 100000,
        orderAmount = 3500
    } = {}
) {
    const domain =
        await resolveDomain(client);

    const accountResult =
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
                domain.customer_id,
                domain.merchant_id,
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
                'Synthetic Customer Tempo',
                $3,
                'DELIVERY',
                'DIRECT'
            )
            RETURNING *
            `,
            [
                domain.customer_id,
                domain.merchant_id,
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
                domain.merchant_id
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
        domain,
        account:
            accountResult.rows[0],
        order:
            orderResult.rows[0],
        product
    };
}

async function testTempoActivation(client) {
    const scenario =
        await createScenario(
            client,
            {
                creditLimit: 100000,
                orderAmount: 3500
            }
        );

    const service =
        new CustomerReceivableService(
            client
        );

    const result =
        await service.activateOrderTempo({
            orderId:
                scenario.order.id,
            creditAccountId:
                scenario.account.id
        });

    assert.equal(
        result.status,
        'created'
    );

    passed(
        'Customer TEMPO activation created'
    );

    assert.equal(
        result.order.payment_mode,
        'TEMPO'
    );

    assert.equal(
        String(
            result.order.credit_account_id
        ),
        String(
            scenario.account.id
        )
    );

    assert.ok(
        result.order.tempo_due_at
    );

    passed(
        'Order stores TEMPO credit contract'
    );

    /*
     * TEMPO bukan PAID.
     */
    assert.equal(
        result.order.status,
        'PENDING'
    );

    passed(
        'TEMPO order remains PENDING'
    );

    /*
     * Satu obligation ORDER harus terbentuk.
     */
    const obligationResult =
        await client.query(
            `
            SELECT *
            FROM tbl_credit_obligations
            WHERE source_type = 'ORDER'
              AND source_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        obligationResult.rowCount,
        1
    );

    const obligation =
        obligationResult.rows[0];

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

    assert.equal(
        String(
            obligation.credit_account_id
        ),
        String(
            scenario.account.id
        )
    );

    passed(
        'Customer receivable obligation matches order'
    );

    /*
     * TEMPO tidak boleh membuat payment.
     */
    const paymentResult =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_payments
            WHERE order_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        paymentResult.rows[0].total,
        0
    );

    passed(
        'TEMPO creates no payment row'
    );

    /*
     * Jurnal:
     *
     * Dr 1300 Piutang Usaha 3.500
     * Cr 4000 Pendapatan     3.500
     */
    const ledgerRef =
        `ORD-${scenario.order.id}`;

    const ledgerResult =
        await client.query(
            `
            SELECT
                account_code,
                account_name,
                debit,
                credit
            FROM tbl_general_ledger
            WHERE transaction_reference = $1
            ORDER BY account_code
            `,
            [
                ledgerRef
            ]
        );

    assert.equal(
        ledgerResult.rowCount,
        2
    );

    const receivable =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1300'
        );

    const revenue =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '4000'
        );

    assert.ok(
        receivable
    );

    assert.equal(
        Number(receivable.debit),
        3500
    );

    assert.equal(
        Number(receivable.credit),
        0
    );

    passed(
        'TEMPO debits Customer receivable'
    );

    assert.ok(
        revenue
    );

    assert.equal(
        Number(revenue.debit),
        0
    );

    assert.equal(
        Number(revenue.credit),
        3500
    );

    passed(
        'TEMPO credits sales revenue'
    );

    const totalDebit =
        ledgerResult.rows.reduce(
            (sum, row) =>
                sum +
                Number(row.debit),
            0
        );

    const totalCredit =
        ledgerResult.rows.reduce(
            (sum, row) =>
                sum +
                Number(row.credit),
            0
        );

    assert.equal(
        totalDebit,
        totalCredit
    );

    passed(
        'Customer TEMPO journal is balanced'
    );

    /*
     * Retry dengan order + account yang sama
     * harus idempotent.
     */
    const retry =
        await service.activateOrderTempo({
            orderId:
                scenario.order.id,
            creditAccountId:
                scenario.account.id
        });

    assert.equal(
        retry.status,
        'existing'
    );

    passed(
        'Customer TEMPO retry is idempotent'
    );

    const obligationAfterRetry =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_credit_obligations
            WHERE source_type = 'ORDER'
              AND source_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        obligationAfterRetry
            .rows[0]
            .total,
        1
    );

    passed(
        'Customer TEMPO retry does not duplicate obligation'
    );

    const ledgerAfterRetry =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_general_ledger
            WHERE transaction_reference = $1
            `,
            [
                ledgerRef
            ]
        );

    assert.equal(
        ledgerAfterRetry
            .rows[0]
            .total,
        2
    );

    passed(
        'Customer TEMPO retry does not duplicate ledger'
    );

    return scenario;
}

async function testInsufficientLimit(client) {
    const scenario =
        await createScenario(
            client,
            {
                creditLimit: 1000,
                orderAmount: 3500
            }
        );

    const service =
        new CustomerReceivableService(
            client
        );

    let rejected = false;

    try {
        await service.activateOrderTempo({
            orderId:
                scenario.order.id,
            creditAccountId:
                scenario.account.id
        });
    } catch (err) {
        rejected =
            /limit tempo customer tidak cukup/i
                .test(
                    String(err.message || '')
                );
    }

    assert.equal(
        rejected,
        true
    );

    passed(
        'Insufficient Customer credit limit rejected'
    );

    const orderResult =
        await client.query(
            `
            SELECT
                status,
                payment_mode,
                credit_account_id,
                tempo_due_at
            FROM tbl_orders_v2
            WHERE id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        orderResult.rowCount,
        1
    );

    const order =
        orderResult.rows[0];

    assert.equal(
        order.status,
        'PENDING'
    );

    assert.equal(
        order.payment_mode,
        'DIRECT'
    );

    assert.equal(
        order.credit_account_id,
        null
    );

    assert.equal(
        order.tempo_due_at,
        null
    );

    passed(
        'Rejected TEMPO leaves order DIRECT and PENDING'
    );

    const obligationResult =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_credit_obligations
            WHERE source_type = 'ORDER'
              AND source_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        obligationResult
            .rows[0]
            .total,
        0
    );

    passed(
        'Rejected TEMPO creates no obligation'
    );

    const ledgerResult =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_general_ledger
            WHERE transaction_reference = $1
            `,
            [
                `ORD-${scenario.order.id}`
            ]
        );

    assert.equal(
        ledgerResult
            .rows[0]
            .total,
        0
    );

    passed(
        'Rejected TEMPO creates no ledger'
    );

    const paymentResult =
        await client.query(
            `
            SELECT COUNT(*)::int AS total
            FROM tbl_payments
            WHERE order_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        paymentResult
            .rows[0]
            .total,
        0
    );

    passed(
        'Rejected TEMPO creates no payment'
    );
}

async function main() {
    const client =
        await pool.connect();

    console.log(
        '===== CUSTOMER TEMPO FINANCE CONTRACT V1 ====='
    );

    try {
        /*
         * ====================================================
         * HAPPY PATH
         * ====================================================
         */
        await client.query(
            'BEGIN'
        );

        await testTempoActivation(
            client
        );

        await client.query(
            'ROLLBACK'
        );

        passed(
            'Customer TEMPO happy-path transaction rolled back'
        );

        /*
         * ====================================================
         * FAILURE PATH
         * ====================================================
         */
        await client.query(
            'BEGIN'
        );

        await testInsufficientLimit(
            client
        );

        await client.query(
            'ROLLBACK'
        );

        passed(
            'Customer TEMPO failure-path transaction rolled back'
        );

        /*
         * ====================================================
         * ZERO RESIDUE
         * ====================================================
         */
        const residue =
            await client.query(
                `
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_accounts
                    )::int AS accounts,

                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_obligations
                    )::int AS obligations,

                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_settlements
                    )::int AS settlements,

                    (
                        SELECT COUNT(*)
                        FROM tbl_orders_v2
                        WHERE payment_mode='TEMPO'
                    )::int AS tempo_orders,

                    (
                        SELECT COUNT(*)
                        FROM tbl_general_ledger
                        WHERE account_code='1300'
                    )::int AS receivable_rows
                `
            );

        assert.equal(
            residue.rows[0].accounts,
            0
        );

        assert.equal(
            residue.rows[0].obligations,
            0
        );

        assert.equal(
            residue.rows[0].settlements,
            0
        );

        assert.equal(
            residue.rows[0].tempo_orders,
            0
        );

        assert.equal(
            residue.rows[0].receivable_rows,
            0
        );

        passed(
            'Synthetic Customer TEMPO data leaves zero residue'
        );

    } catch (err) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (_) {}

        failed(
            'Customer TEMPO finance contract',
            err
        );

    } finally {
        client.release();

        console.log(
            '===== CUSTOMER TEMPO FINANCE CONTRACT RESULT ====='
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
