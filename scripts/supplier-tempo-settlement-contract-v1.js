require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');
const pool = require('../src/config/db');

const SupplierPayableService =
    require(
        '../src/services/credit/SupplierPayableService'
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
                p.id AS product_id,
                p.merchant_id,
                p.name AS product_name,
                i.warehouse_id,
                COALESCE(
                    i.quantity_on_hand,
                    0
                ) AS quantity_on_hand,
                s.id AS supplier_id,
                s.supplier_name
            FROM tbl_products p
            JOIN tbl_inventory i
                ON i.product_id = p.id
            CROSS JOIN LATERAL (
                SELECT
                    id,
                    supplier_name
                FROM tbl_suppliers
                ORDER BY created_at
                LIMIT 1
            ) s
            WHERE p.status = 'ACTIVE'
              AND p.merchant_id IS NOT NULL
            ORDER BY p.created_at
            LIMIT 1
        `);

    if (!result.rowCount) {
        throw new Error(
            'Synthetic domain tidak tersedia'
        );
    }

    return result.rows[0];
}

async function buildSupplierTempoScenario(
    client,
    {
        creditLimit = 1000000,
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
                merchant_id,
                supplier_id,
                credit_limit,
                default_term_days,
                status,
                approved_at
            )
            VALUES (
                'SUPPLIER',
                $1,
                $2,
                $3,
                3,
                'ACTIVE',
                CURRENT_TIMESTAMP
            )
            RETURNING *
            `,
            [
                domain.merchant_id,
                domain.supplier_id,
                creditLimit
            ]
        );

    const account =
        accountResult.rows[0];

    const sourceId =
        crypto.randomUUID();

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
                'PURCHASE_ORDER',
                $2,
                $3,
                0,
                CURRENT_TIMESTAMP +
                    INTERVAL '3 days',
                'OPEN',
                'Synthetic Supplier Tempo Settlement'
            )
            RETURNING *
            `,
            [
                account.id,
                sourceId,
                principalAmount
            ]
        );

    return {
        domain,
        account,
        obligation:
            obligationResult.rows[0]
    };
}

async function testPartialSettlement(client) {
    const scenario =
        await buildSupplierTempoScenario(
            client,
            {
                creditLimit: 1000000,
                principalAmount: 300000
            }
        );

    const service =
        new SupplierPayableService(
            client
        );

    const idempotencyKey =
        'SETTLEMENT-PARTIAL-' +
        crypto.randomUUID();

    const settlementResult =
        await service
            .settleSupplierObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    100000,
                paymentMethod:
                    'CASH',
                idempotencyKey,
                referenceNumber:
                    'SYNTHETIC-PARTIAL',
                notes:
                    'Synthetic partial settlement',
                receivedBy:
                    null
            });

    assert.equal(
        settlementResult.status,
        'created'
    );

    assert.ok(
        settlementResult.settlement
    );

    assert.equal(
        Number(
            settlementResult
                .settlement
                .amount
        ),
        100000
    );

    assert.equal(
        settlementResult
            .obligation
            .status,
        'PARTIAL'
    );

    assert.equal(
        Number(
            settlementResult
                .obligation
                .paid_amount
        ),
        100000
    );

    passed(
        'Partial settlement creates settlement row'
    );

    passed(
        'Partial settlement changes obligation to PARTIAL'
    );

    const settlementId =
        settlementResult
            .settlement
            .id;

    const expectedLedgerRef =
        `CSET-${settlementId}`;

    assert.equal(
        settlementResult
            .ledger_reference,
        expectedLedgerRef
    );

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
                expectedLedgerRef
            ]
        );

    assert.equal(
        ledgerResult.rowCount,
        2
    );

    const payableRow =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '2100'
        );

    const cashRow =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1100'
        );

    assert.ok(
        payableRow
    );

    assert.ok(
        cashRow
    );

    assert.equal(
        Number(
            payableRow.debit
        ),
        100000
    );

    assert.equal(
        Number(
            payableRow.credit
        ),
        0
    );

    assert.equal(
        Number(
            cashRow.debit
        ),
        0
    );

    assert.equal(
        Number(
            cashRow.credit
        ),
        100000
    );

    passed(
        'Partial settlement debits Supplier payable'
    );

    passed(
        'Partial settlement credits Cash & Bank'
    );

    /*
     * ========================================================
     * IDEMPOTENT RETRY
     *
     * Retry dengan obligation + idempotency_key yang sama
     * tidak boleh:
     *
     * - membuat settlement kedua,
     * - menambah paid_amount lagi,
     * - membuat jurnal kedua.
     * ========================================================
     */

    const retry =
        await service
            .settleSupplierObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    100000,
                paymentMethod:
                    'CASH',
                idempotencyKey,
                referenceNumber:
                    'SYNTHETIC-PARTIAL',
                notes:
                    'Synthetic retry',
                receivedBy:
                    null
            });

    assert.equal(
        retry.status,
        'existing'
    );

    assert.equal(
        retry.settlement.id,
        settlementId
    );

    const retryState =
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
                )::int
                    AS settlement_rows,
                (
                    SELECT COUNT(*)
                    FROM tbl_general_ledger gl
                    WHERE gl.transaction_reference =
                        $2
                )::int
                    AS ledger_rows
            FROM tbl_credit_obligations co
            WHERE co.id = $1
            `,
            [
                scenario.obligation.id,
                expectedLedgerRef
            ]
        );

    assert.equal(
        Number(
            retryState.rows[0]
                .paid_amount
        ),
        100000
    );

    assert.equal(
        retryState.rows[0]
            .status,
        'PARTIAL'
    );

    assert.equal(
        Number(
            retryState.rows[0]
                .settlement_rows
        ),
        1
    );

    assert.equal(
        Number(
            retryState.rows[0]
                .ledger_rows
        ),
        2
    );

    passed(
        'Settlement retry is idempotent'
    );

    passed(
        'Settlement retry does not double paid amount'
    );

    passed(
        'Settlement retry does not duplicate ledger'
    );

    return {
        scenario,
        service
    };
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
        'SETTLEMENT-FINAL-' +
        crypto.randomUUID();

    const finalSettlement =
        await service
            .settleSupplierObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    200000,
                paymentMethod:
                    'BANK_TRANSFER',
                idempotencyKey:
                    finalKey,
                referenceNumber:
                    'SYNTHETIC-FINAL',
                notes:
                    'Synthetic final settlement',
                receivedBy:
                    null
            });

    assert.equal(
        finalSettlement.status,
        'created'
    );

    assert.equal(
        finalSettlement
            .obligation
            .status,
        'PAID'
    );

    assert.equal(
        Number(
            finalSettlement
                .obligation
                .paid_amount
        ),
        300000
    );

    assert.ok(
        finalSettlement
            .obligation
            .paid_at
    );

    passed(
        'Final settlement changes obligation to PAID'
    );

    passed(
        'Final settlement fully pays principal'
    );

    const finalLedgerRef =
        finalSettlement
            .ledger_reference;

    assert.equal(
        finalLedgerRef,
        `CSET-${finalSettlement.settlement.id}`
    );

    const ledgerResult =
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
                finalLedgerRef
            ]
        );

    assert.equal(
        ledgerResult.rowCount,
        2
    );

    const payableRow =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '2100'
        );

    const cashRow =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1100'
        );

    assert.ok(
        payableRow
    );

    assert.ok(
        cashRow
    );

    assert.equal(
        Number(payableRow.debit),
        200000
    );

    assert.equal(
        Number(payableRow.credit),
        0
    );

    assert.equal(
        Number(cashRow.debit),
        0
    );

    assert.equal(
        Number(cashRow.credit),
        200000
    );

    passed(
        'Final settlement posts balanced payable journal'
    );

    /*
     * ========================================================
     * COMPLETE SETTLEMENT STATE
     * ========================================================
     */

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
                )::int
                    AS settlement_rows,
                (
                    SELECT COALESCE(
                        SUM(cs.amount),
                        0
                    )
                    FROM tbl_credit_settlements cs
                    WHERE cs.obligation_id =
                        co.id
                )::numeric
                    AS settlement_total
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

    const state =
        completeState.rows[0];

    assert.equal(
        Number(state.principal_amount),
        300000
    );

    assert.equal(
        Number(state.paid_amount),
        300000
    );

    assert.equal(
        state.status,
        'PAID'
    );

    assert.ok(
        state.paid_at
    );

    assert.equal(
        Number(state.settlement_rows),
        2
    );

    assert.equal(
        Number(state.settlement_total),
        300000
    );

    passed(
        'Settlement total equals obligation principal'
    );

    /*
     * ========================================================
     * OVERPAYMENT / PAID OBLIGATION MUST BE REJECTED
     * ========================================================
     */

    const beforeOverpayment =
        await client.query(
            `
            SELECT
                paid_amount,
                status,
                (
                    SELECT COUNT(*)
                    FROM tbl_credit_settlements cs
                    WHERE cs.obligation_id =
                        co.id
                )::int
                    AS settlements
            FROM tbl_credit_obligations co
            WHERE co.id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    await client.query(
        'SAVEPOINT before_overpayment'
    );

    let overpaymentRejected = false;

    try {
        await service
            .settleSupplierObligation({
                obligationId:
                    scenario.obligation.id,
                amount:
                    1,
                paymentMethod:
                    'CASH',
                idempotencyKey:
                    'OVERPAY-' +
                    crypto.randomUUID(),
                referenceNumber:
                    'SHOULD-NOT-EXIST',
                notes:
                    'Overpayment rejection test',
                receivedBy:
                    null
            });
    } catch (err) {
        overpaymentRejected =
            /sudah lunas|melebihi|paid/i
                .test(
                    String(
                        err.message || ''
                    )
                );

        await client.query(
            'ROLLBACK TO SAVEPOINT before_overpayment'
        );
    }

    assert.equal(
        overpaymentRejected,
        true
    );

    passed(
        'Paid obligation rejects additional settlement'
    );

    const afterOverpayment =
        await client.query(
            `
            SELECT
                paid_amount,
                status,
                (
                    SELECT COUNT(*)
                    FROM tbl_credit_settlements cs
                    WHERE cs.obligation_id =
                        co.id
                )::int
                    AS settlements
            FROM tbl_credit_obligations co
            WHERE co.id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        Number(
            afterOverpayment
                .rows[0]
                .paid_amount
        ),
        Number(
            beforeOverpayment
                .rows[0]
                .paid_amount
        )
    );

    assert.equal(
        afterOverpayment
            .rows[0]
            .status,
        beforeOverpayment
            .rows[0]
            .status
    );

    assert.equal(
        Number(
            afterOverpayment
                .rows[0]
                .settlements
        ),
        Number(
            beforeOverpayment
                .rows[0]
                .settlements
        )
    );

    passed(
        'Rejected overpayment leaves obligation unchanged'
    );
}

async function main() {
    const client =
        await pool.connect();

    console.log(
        '===== SUPPLIER TEMPO SETTLEMENT CONTRACT V1 ====='
    );

    try {
        await client.query(
            'BEGIN'
        );

        try {
            const context =
                await testPartialSettlement(
                    client
                );

            await testFullSettlement(
                client,
                context
            );

        } catch (err) {
            failed(
                'Supplier tempo settlement contract',
                err
            );

            throw err;
        }

        await client.query(
            'ROLLBACK'
        );

        passed(
            'Synthetic settlement transaction rolled back'
        );

        const residue =
            await pool.query(
                `
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_accounts
                    )::int
                        AS accounts,
                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_obligations
                    )::int
                        AS obligations,
                    (
                        SELECT COUNT(*)
                        FROM tbl_credit_settlements
                    )::int
                        AS settlements
                `
            );

        assert.equal(
            Number(
                residue.rows[0].accounts
            ),
            0
        );

        assert.equal(
            Number(
                residue.rows[0].obligations
            ),
            0
        );

        assert.equal(
            Number(
                residue.rows[0].settlements
            ),
            0
        );

        passed(
            'Synthetic credit data leaves zero residue'
        );

    } catch (err) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (_) {}

        if (fail === 0) {
            failed(
                'Unexpected contract failure',
                err
            );
        }

    } finally {
        client.release();

        console.log(
            '===== SUPPLIER TEMPO SETTLEMENT CONTRACT RESULT ====='
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
