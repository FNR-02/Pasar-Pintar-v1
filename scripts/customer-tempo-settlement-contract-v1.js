require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const pool = require('../src/config/db');

const CustomerReceivableService =
    require(
        '../src/services/credit/CustomerReceivableService'
    );

let passCount = 0;
let failCount = 0;

function passed(name) {
    passCount += 1;
    console.log(`PASS  ${name}`);
}

function failed(name, err) {
    failCount += 1;
    console.error(
        `FAIL  ${name}: ${err.message}`
    );
}

async function resolveDomain(client) {
    const result =
        await client.query(
            `
            SELECT
                c.id AS customer_id,
                m.id AS merchant_id
            FROM tbl_customers c
            CROSS JOIN LATERAL (
                SELECT id
                FROM tbl_merchants
                WHERE status = 'ACTIVE'
                ORDER BY created_at
                LIMIT 1
            ) m
            ORDER BY c.created_at
            LIMIT 1
            `
        );

    if (!result.rowCount) {
        throw new Error(
            'Synthetic Customer settlement domain tidak tersedia'
        );
    }

    return result.rows[0];
}

async function buildScenario(
    client,
    {
        principalAmount = 300000
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
                principalAmount * 2
            ]
        );

    const account =
        accountResult.rows[0];

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
                payment_mode,
                credit_account_id,
                tempo_due_at
            )
            VALUES (
                $1,
                $2,
                'PACKING',
                'Synthetic Customer Settlement',
                $3,
                'DELIVERY',
                'TEMPO',
                $4,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days'
            )
            RETURNING *
            `,
            [
                domain.customer_id,
                domain.merchant_id,
                principalAmount,
                account.id
            ]
        );

    const order =
        orderResult.rows[0];

    const obligationResult =
        await client.query(
            `
            INSERT INTO tbl_credit_obligations (
                credit_account_id,
                source_type,
                source_id,
                principal_amount,
                paid_amount,
                due_at,
                status,
                description
            )
            VALUES (
                $1,
                'ORDER',
                $2,
                $3,
                0,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days',
                'OPEN',
                'Synthetic Customer settlement'
            )
            RETURNING *
            `,
            [
                account.id,
                order.id,
                principalAmount
            ]
        );

    return {
        domain,
        account,
        order,
        obligation:
            obligationResult.rows[0]
    };
}

async function testPartialSettlement(client) {
    const scenario =
        await buildScenario(
            client,
            {
                principalAmount:
                    300000
            }
        );

    const service =
        new CustomerReceivableService(
            client
        );

    const idempotencyKey =
        'CUSTOMER-PARTIAL-' +
        crypto.randomUUID();

    const result =
        await service
            .settleCustomerObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    100000,
                paymentMethod:
                    'CASH',
                idempotencyKey,
                referenceNumber:
                    'SYNTHETIC-CUSTOMER-PARTIAL',
                notes:
                    'Synthetic Customer partial settlement',
                receivedBy:
                    null
            });

    assert.equal(
        result.status,
        'created'
    );

    assert.equal(
        Number(
            result.settlement.amount
        ),
        100000
    );

    assert.equal(
        result.obligation.status,
        'PARTIAL'
    );

    assert.equal(
        Number(
            result.obligation.paid_amount
        ),
        100000
    );

    passed(
        'Customer partial settlement creates settlement row'
    );

    passed(
        'Customer partial settlement changes obligation to PARTIAL'
    );

    const ledgerRef =
        `CSET-${result.settlement.id}`;

    assert.equal(
        result.ledger_reference,
        ledgerRef
    );

    const ledger =
        await client.query(
            `
            SELECT
                account_code,
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
        ledger.rowCount,
        2
    );

    const cash =
        ledger.rows.find(
            row =>
                row.account_code ===
                '1100'
        );

    const receivable =
        ledger.rows.find(
            row =>
                row.account_code ===
                '1300'
        );

    assert.ok(
        cash
    );

    assert.ok(
        receivable
    );

    assert.equal(
        Number(cash.debit),
        100000
    );

    assert.equal(
        Number(cash.credit),
        0
    );

    assert.equal(
        Number(receivable.debit),
        0
    );

    assert.equal(
        Number(receivable.credit),
        100000
    );

    passed(
        'Customer settlement debits Cash & Bank'
    );

    passed(
        'Customer settlement credits Customer receivable'
    );

    const payments =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_payments
            WHERE order_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        payments.rows[0].count,
        0
    );

    passed(
        'Customer settlement creates no order payment'
    );

    const orderState =
        await client.query(
            `
            SELECT
                status,
                payment_mode
            FROM tbl_orders_v2
            WHERE id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        orderState.rows[0].status,
        'PACKING'
    );

    assert.equal(
        orderState.rows[0]
            .payment_mode,
        'TEMPO'
    );

    passed(
        'Customer settlement leaves order lifecycle unchanged'
    );

    return {
        scenario,
        service,
        idempotencyKey,
        settlement:
            result.settlement,
        ledgerRef
    };
}

async function testSettlementRetry(
    client,
    context
) {
    const {
        scenario,
        service,
        idempotencyKey,
        settlement,
        ledgerRef
    } = context;

    const retry =
        await service
            .settleCustomerObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    100000,
                paymentMethod:
                    'CASH',
                idempotencyKey,
                referenceNumber:
                    'SYNTHETIC-CUSTOMER-PARTIAL',
                notes:
                    'Synthetic Customer settlement retry',
                receivedBy:
                    null
            });

    assert.equal(
        retry.status,
        'existing'
    );

    assert.equal(
        String(
            retry.settlement.id
        ),
        String(
            settlement.id
        )
    );

    const state =
        await client.query(
            `
            SELECT
                co.paid_amount,
                co.status,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_settlements cs
                    WHERE cs.obligation_id =
                        co.id
                )::int AS settlement_rows,

                (
                    SELECT COUNT(*)
                    FROM tbl_general_ledger gl
                    WHERE gl.transaction_reference =
                        $2
                )::int AS ledger_rows

            FROM tbl_credit_obligations co
            WHERE co.id = $1
            `,
            [
                scenario.obligation.id,
                ledgerRef
            ]
        );

    assert.equal(
        Number(
            state.rows[0]
                .paid_amount
        ),
        100000
    );

    assert.equal(
        state.rows[0].status,
        'PARTIAL'
    );

    assert.equal(
        state.rows[0]
            .settlement_rows,
        1
    );

    assert.equal(
        state.rows[0]
            .ledger_rows,
        2
    );

    passed(
        'Customer settlement retry is idempotent'
    );

    passed(
        'Customer settlement retry does not double paid amount'
    );

    passed(
        'Customer settlement retry does not duplicate settlement row'
    );

    passed(
        'Customer settlement retry does not duplicate ledger'
    );

    return context;
}

async function testFullSettlement(
    client,
    context
) {
    const {
        scenario,
        service
    } = context;

    const finalKey =
        'CUSTOMER-FINAL-' +
        crypto.randomUUID();

    const result =
        await service
            .settleCustomerObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    200000,
                paymentMethod:
                    'BANK_TRANSFER',
                idempotencyKey:
                    finalKey,
                referenceNumber:
                    'SYNTHETIC-CUSTOMER-FINAL',
                notes:
                    'Synthetic Customer final settlement',
                receivedBy:
                    null
            });

    assert.equal(
        result.status,
        'created'
    );

    assert.equal(
        result.obligation.status,
        'PAID'
    );

    assert.equal(
        Number(
            result.obligation
                .paid_amount
        ),
        300000
    );

    assert.ok(
        result.obligation.paid_at
    );

    passed(
        'Customer final settlement changes obligation to PAID'
    );

    passed(
        'Customer final settlement fully pays receivable'
    );

    const ledgerRef =
        `CSET-${result.settlement.id}`;

    assert.equal(
        result.ledger_reference,
        ledgerRef
    );

    const ledger =
        await client.query(
            `
            SELECT
                account_code,
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
        ledger.rowCount,
        2
    );

    const cash =
        ledger.rows.find(
            row =>
                row.account_code ===
                '1100'
        );

    const receivable =
        ledger.rows.find(
            row =>
                row.account_code ===
                '1300'
        );

    assert.ok(cash);
    assert.ok(receivable);

    assert.equal(
        Number(cash.debit),
        200000
    );

    assert.equal(
        Number(cash.credit),
        0
    );

    assert.equal(
        Number(receivable.debit),
        0
    );

    assert.equal(
        Number(receivable.credit),
        200000
    );

    assert.equal(
        Number(cash.debit) +
            Number(receivable.debit),
        Number(cash.credit) +
            Number(receivable.credit)
    );

    passed(
        'Customer final settlement posts balanced receivable journal'
    );

    const completeState =
        await client.query(
            `
            SELECT
                co.principal_amount,
                co.paid_amount,
                co.status,
                co.paid_at,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_settlements cs
                    WHERE cs.obligation_id =
                        co.id
                )::int AS settlement_rows,

                (
                    SELECT COALESCE(
                        SUM(cs.amount),
                        0
                    )
                    FROM tbl_credit_settlements cs
                    WHERE cs.obligation_id =
                        co.id
                )::numeric AS settlement_total

            FROM tbl_credit_obligations co
            WHERE co.id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        completeState.rowCount,
        1
    );

    assert.equal(
        Number(
            completeState.rows[0]
                .principal_amount
        ),
        300000
    );

    assert.equal(
        Number(
            completeState.rows[0]
                .paid_amount
        ),
        300000
    );

    assert.equal(
        Number(
            completeState.rows[0]
                .settlement_total
        ),
        300000
    );

    assert.equal(
        completeState.rows[0]
            .settlement_rows,
        2
    );

    assert.equal(
        completeState.rows[0].status,
        'PAID'
    );

    passed(
        'Customer settlement total equals receivable principal'
    );

    const payments =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_payments
            WHERE order_id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        payments.rows[0].count,
        0
    );

    const orderState =
        await client.query(
            `
            SELECT
                status,
                payment_mode
            FROM tbl_orders_v2
            WHERE id = $1
            `,
            [
                scenario.order.id
            ]
        );

    assert.equal(
        orderState.rows[0].status,
        'PACKING'
    );

    assert.equal(
        orderState.rows[0]
            .payment_mode,
        'TEMPO'
    );

    passed(
        'Paid Customer receivable creates no order payment'
    );

    passed(
        'Paid Customer receivable does not alter order lifecycle'
    );

    return context;
}

async function testPaidObligationGuard(
    client,
    context
) {
    const {
        scenario,
        service
    } = context;

    const before =
        await client.query(
            `
            SELECT
                paid_amount,
                status
            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    const settlementsBefore =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_credit_settlements
            WHERE obligation_id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    await client.query(
        'SAVEPOINT before_paid_customer_rejection'
    );

    let rejected = false;

    try {
        await service
            .settleCustomerObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    1,
                paymentMethod:
                    'CASH',
                idempotencyKey:
                    'CUSTOMER-PAID-REJECT-' +
                    crypto.randomUUID(),
                referenceNumber:
                    'SYNTHETIC-PAID-REJECT',
                receivedBy:
                    null
            });

    } catch (err) {
        rejected =
            /sudah lunas/i.test(
                String(
                    err.message || ''
                )
            );

        await client.query(
            'ROLLBACK TO SAVEPOINT before_paid_customer_rejection'
        );
    }

    assert.equal(
        rejected,
        true
    );

    passed(
        'Paid Customer receivable rejects additional settlement'
    );

    const after =
        await client.query(
            `
            SELECT
                paid_amount,
                status
            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    const settlementsAfter =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_credit_settlements
            WHERE obligation_id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        Number(after.rows[0].paid_amount),
        Number(before.rows[0].paid_amount)
    );

    assert.equal(
        after.rows[0].status,
        before.rows[0].status
    );

    assert.equal(
        settlementsAfter.rows[0].count,
        settlementsBefore.rows[0].count
    );

    passed(
        'Rejected paid Customer settlement leaves receivable unchanged'
    );
}

async function testCustomerOverpayment(
    client,
    context
) {
    const {
        scenario:
            existingScenario
    } = context;

    /*
     * Gunakan credit account CUSTOMER yang sama.
     *
     * Database memang menjamin hanya satu credit account
     * untuk pasangan Customer + Merchant.
     *
     * Overpayment diuji menggunakan obligation/order kedua,
     * bukan membuat account Customer kedua.
     */
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
                payment_mode,
                credit_account_id,
                tempo_due_at
            )
            VALUES (
                $1,
                $2,
                'PACKING',
                'Synthetic Customer Settlement',
                100000,
                'DELIVERY',
                'TEMPO',
                $3,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days'
            )
            RETURNING *
            `,
            [
                existingScenario
                    .domain
                    .customer_id,
                existingScenario
                    .domain
                    .merchant_id,
                existingScenario
                    .account
                    .id
            ]
        );

    const order =
        orderResult.rows[0];

    const obligationResult =
        await client.query(
            `
            INSERT INTO tbl_credit_obligations (
                credit_account_id,
                source_type,
                source_id,
                principal_amount,
                paid_amount,
                due_at,
                status,
                description
            )
            VALUES (
                $1,
                'ORDER',
                $2,
                100000,
                0,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days',
                'OPEN',
                'Synthetic Customer settlement'
            )
            RETURNING *
            `,
            [
                existingScenario
                    .account
                    .id,
                order.id
            ]
        );

    const obligation =
        obligationResult.rows[0];

    const service =
        new CustomerReceivableService(
            client
        );

    const before =
        await client.query(
            `
            SELECT
                paid_amount,
                status
            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                obligation.id
            ]
        );

    await client.query(
        'SAVEPOINT before_customer_overpayment'
    );

    let rejected = false;

    try {
        await service
            .settleCustomerObligation({
                obligationId:
                    obligation.id,
                amount:
                    100001,
                paymentMethod:
                    'QRIS',
                idempotencyKey:
                    'CUSTOMER-OVERPAYMENT-' +
                    crypto.randomUUID(),
                referenceNumber:
                    'SYNTHETIC-OVERPAYMENT',
                receivedBy:
                    null
            });

    } catch (err) {
        rejected =
            /melebihi sisa piutang/i
                .test(
                    String(
                        err.message || ''
                    )
                );

        await client.query(
            'ROLLBACK TO SAVEPOINT before_customer_overpayment'
        );
    }

    assert.equal(
        rejected,
        true
    );

    passed(
        'Customer receivable rejects overpayment'
    );

    const after =
        await client.query(
            `
            SELECT
                paid_amount,
                status,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_settlements
                    WHERE obligation_id = $1
                )::int AS settlement_rows

            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                obligation.id
            ]
        );

    assert.equal(
        Number(
            after.rows[0].paid_amount
        ),
        Number(
            before.rows[0].paid_amount
        )
    );

    assert.equal(
        after.rows[0].status,
        before.rows[0].status
    );

    assert.equal(
        after.rows[0].settlement_rows,
        0
    );

    passed(
        'Rejected Customer overpayment leaves receivable unchanged'
    );
}

async function main() {
    console.log(
        '===== CUSTOMER TEMPO SETTLEMENT CONTRACT V1 ====='
    );

    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const context =
            await testPartialSettlement(
                client
            );

        await testSettlementRetry(
            client,
            context
        );

        await testFullSettlement(
            client,
            context
        );

        await testPaidObligationGuard(
            client,
            context
        );

        await testCustomerOverpayment(
            client,
            context
        );

        /*
         * Seluruh fixture contract bersifat synthetic.
         * Jangan pernah meninggalkan data test.
         */
        await client.query('ROLLBACK');

        passed(
            'Synthetic Customer settlement transaction rolled back'
        );

    } catch (err) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (_) {}

        failed(
            'Customer TEMPO settlement contract',
            err
        );

    } finally {
        client.release();
    }

    /*
     * ========================================================
     * ZERO RESIDUE
     * ========================================================
     *
     * Verifikasi dilakukan menggunakan pool setelah transaction
     * test sudah ROLLBACK.
     * ========================================================
     */
    try {
        const residue =
            await pool.query(
                `
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM tbl_orders_v2
                        WHERE shipping_address =
                            'Synthetic Customer settlement'
                    )::int
                        AS synthetic_orders,

                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_obligations
                        WHERE description =
                            'Synthetic Customer settlement'
                    )::int
                        AS synthetic_obligations
                `
            );

        assert.equal(
            residue.rows[0]
                .synthetic_orders,
            0
        );

        assert.equal(
            residue.rows[0]
                .synthetic_obligations,
            0
        );

        passed(
            'Synthetic Customer settlement data leaves zero residue'
        );

    } catch (err) {
        failed(
            'Synthetic Customer settlement zero residue',
            err
        );
    }

    console.log(
        '===== CUSTOMER TEMPO SETTLEMENT CONTRACT RESULT ====='
    );

    console.log(
        `PASS: ${passCount}`
    );

    console.log(
        `FAIL: ${failCount}`
    );

    console.log(
        failCount === 0
            ? 'STATUS: HEALTHY'
            : 'STATUS: FAILED'
    );

    await pool.end();

    if (failCount > 0) {
        process.exitCode = 1;
    }
}

main();
