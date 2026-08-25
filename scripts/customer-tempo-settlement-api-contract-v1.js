require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');

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
        data =
            await response.json();
    } catch (_) {
        data = {};
    }

    return {
        statusCode:
            response.status,
        data
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

async function resolveDomain(client) {
    const merchantResult =
        await client.query(
            `
            SELECT
                id,
                user_id,
                store_name
            FROM tbl_merchants
            WHERE status = 'ACTIVE'
              AND user_id IS NOT NULL
            ORDER BY created_at
            LIMIT 1
            `
        );

    if (!merchantResult.rowCount) {
        throw new Error(
            'Merchant synthetic tidak tersedia'
        );
    }

    const customersResult =
        await client.query(
            `
            SELECT
                c.id,
                c.user_id,
                c.full_name,
                u.role_id
            FROM tbl_customers c
            JOIN tbl_users u
                ON u.id =
                    c.user_id
            WHERE u.role_id = 1
              AND u.is_active = TRUE
            ORDER BY c.created_at
            LIMIT 2
            `
        );

    if (
        customersResult.rowCount < 2
    ) {
        throw new Error(
            'Diperlukan minimal dua Customer untuk settlement ownership contract'
        );
    }

    return {
        merchant:
            merchantResult.rows[0],

        owner:
            customersResult.rows[0],

        stranger:
            customersResult.rows[1]
    };
}

async function createScenario(
    client,
    domain,
    {
        principalAmount = 300000
    } = {}
) {
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
                domain.owner.id,
                domain.merchant.id,
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
                'Synthetic Customer Settlement API',
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
                domain.owner.id,
                domain.merchant.id,
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
                'Synthetic Customer Settlement API'
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
        account,
        order,
        obligation:
            obligationResult.rows[0]
    };
}

async function testSettlementOwnership() {
    const client =
        await pool.connect();

    let scenario = null;

    try {
        const domain =
            await resolveDomain(client);

        scenario =
            await createScenario(
                client,
                domain,
                {
                    principalAmount:
                        300000
                }
            );

        passed(
            'Synthetic Customer settlement API fixture created'
        );

        const ownerToken =
            makeCustomerToken(
                domain.owner
            );

        const strangerToken =
            makeCustomerToken(
                domain.stranger
            );

        /*
         * =====================================================
         * STRANGER OWNERSHIP REJECTION
         *
         * Customer lain tidak boleh membayar obligation milik
         * Customer owner.
         * =====================================================
         */

        const beforeResult =
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

        const strangerKey =
            'CUSTOMER-SETTLEMENT-STRANGER-' +
            crypto.randomUUID();

        const strangerResponse =
            await apiRequest({
                path:
                    `/api/customer/credit-obligations-v1/${scenario.obligation.id}/settlements`,

                token:
                    strangerToken,

                body: {
                    amount:
                        100000,

                    payment_method:
                        'CASH',

                    idempotency_key:
                        strangerKey,

                    reference_number:
                        'SYNTHETIC-STRANGER',

                    notes:
                        'Synthetic ownership rejection'
                }
            });

        assert.equal(
            strangerResponse.statusCode,
            403
        );

        passed(
            'Other Customer cannot settle owner receivable'
        );

        const afterResult =
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

        assert.equal(
            Number(
                afterResult.rows[0]
                    .paid_amount
            ),
            Number(
                beforeResult.rows[0]
                    .paid_amount
            )
        );

        assert.equal(
            afterResult.rows[0].status,
            beforeResult.rows[0].status
        );

        const strangerSettlementResult =
            await client.query(
                `
                SELECT COUNT(*)::int AS count
                FROM tbl_credit_settlements
                WHERE obligation_id = $1
                  AND idempotency_key = $2
                `,
                [
                    scenario.obligation.id,
                    strangerKey
                ]
            );

        assert.equal(
            strangerSettlementResult
                .rows[0]
                .count,
            0
        );

        passed(
            'Rejected ownership attempt leaves receivable unchanged'
        );

        /*
         * Return context untuk test owner pada STEP berikutnya.
         */
        return {
            client,
            domain,
            scenario,
            ownerToken
        };

    } catch (err) {
        /*
         * Karena fixture dibuat langsung pada database,
         * failure harus dibersihkan sebelum error dilempar lagi.
         */
        if (scenario) {
            try {
                await client.query(
                    `
                    DELETE FROM tbl_credit_settlements
                    WHERE obligation_id = $1
                    `,
                    [
                        scenario.obligation.id
                    ]
                );

                await client.query(
                    `
                    DELETE FROM tbl_general_ledger
                    WHERE transaction_reference LIKE 'CSET-%'
                      AND description LIKE '%Customer%'
                    `
                );

                await client.query(
                    `
                    DELETE FROM tbl_credit_obligations
                    WHERE id = $1
                    `,
                    [
                        scenario.obligation.id
                    ]
                );

                await client.query(
                    `
                    DELETE FROM tbl_orders_v2
                    WHERE id = $1
                    `,
                    [
                        scenario.order.id
                    ]
                );

                await client.query(
                    `
                    DELETE FROM tbl_credit_accounts
                    WHERE id = $1
                    `,
                    [
                        scenario.account.id
                    ]
                );

            } catch (_) {}
        }

        client.release();
        throw err;
    }
}

async function testOwnerPartialSettlement(
    context
) {
    const {
        client,
        scenario,
        ownerToken
    } = context;

    const idempotencyKey =
        'CUSTOMER-SETTLEMENT-PARTIAL-' +
        crypto.randomUUID();

    const response =
        await apiRequest({
            path:
                `/api/customer/credit-obligations-v1/${scenario.obligation.id}/settlements`,

            token:
                ownerToken,

            body: {
                amount:
                    100000,

                payment_method:
                    'CASH',

                idempotency_key:
                    idempotencyKey,

                reference_number:
                    'SYNTHETIC-CUSTOMER-PARTIAL-API',

                notes:
                    'Synthetic Customer partial API settlement'
            }
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
        response.data.idempotent,
        false
    );

    assert.ok(
        response.data.settlement
    );

    assert.equal(
        Number(
            response.data
                .settlement
                .amount
        ),
        100000
    );

    assert.equal(
        response.data
            .obligation
            .status,
        'PARTIAL'
    );

    assert.equal(
        Number(
            response.data
                .obligation
                .paid_amount
        ),
        100000
    );

    passed(
        'Owner can partially settle Customer receivable'
    );

    passed(
        'Customer partial settlement changes receivable to PARTIAL'
    );

    const settlementId =
        response.data
            .settlement
            .id;

    const ledgerRef =
        `CSET-${settlementId}`;

    assert.equal(
        response.data
            .ledger_reference,
        ledgerRef
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
                ledgerRef
            ]
        );

    assert.equal(
        ledgerResult.rowCount,
        2
    );

    const cashRow =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1100'
        );

    const receivableRow =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1300'
        );

    assert.ok(cashRow);
    assert.ok(receivableRow);

    assert.equal(
        Number(cashRow.debit),
        100000
    );

    assert.equal(
        Number(cashRow.credit),
        0
    );

    assert.equal(
        Number(receivableRow.debit),
        0
    );

    assert.equal(
        Number(receivableRow.credit),
        100000
    );

    passed(
        'Customer settlement API debits Cash & Bank'
    );

    passed(
        'Customer settlement API credits Customer receivable'
    );

    /*
     * Settlement piutang bukan pembayaran order.
     */
    const paymentResult =
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
        paymentResult.rows[0].count,
        0
    );

    passed(
        'Customer settlement API creates no order payment'
    );

    /*
     * Lifecycle order tidak boleh berubah karena settlement.
     */
    const orderResult =
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
        orderResult.rows[0].status,
        'PACKING'
    );

    assert.equal(
        orderResult.rows[0]
            .payment_mode,
        'TEMPO'
    );

    passed(
        'Customer settlement API leaves order lifecycle unchanged'
    );

    return {
        ...context,
        idempotencyKey,
        settlement:
            response.data.settlement,
        ledgerRef
    };
}

async function testSettlementRetry(
    context
) {
    const {
        client,
        scenario,
        ownerToken,
        idempotencyKey,
        settlement,
        ledgerRef
    } = context;

    /*
     * =====================================================
     * IDEMPOTENT RETRY
     *
     * Request dengan obligation + idempotency_key yang sama
     * tidak boleh:
     *
     * - menambah paid_amount lagi
     * - membuat settlement kedua
     * - membuat jurnal kedua
     * =====================================================
     */

    const retry =
        await apiRequest({
            path:
                `/api/customer/credit-obligations-v1/${scenario.obligation.id}/settlements`,

            token:
                ownerToken,

            body: {
                amount:
                    100000,

                payment_method:
                    'CASH',

                idempotency_key:
                    idempotencyKey,

                reference_number:
                    'SYNTHETIC-CUSTOMER-PARTIAL-API',

                notes:
                    'Synthetic Customer settlement API retry'
            }
        });

    assert.equal(
        retry.statusCode,
        200
    );

    assert.equal(
        retry.data.status,
        'success'
    );

    assert.equal(
        retry.data.idempotent,
        true
    );

    assert.ok(
        retry.data.settlement
    );

    assert.equal(
        String(
            retry.data.settlement.id
        ),
        String(
            settlement.id
        )
    );

    passed(
        'Customer settlement API retry is idempotent'
    );

    const stateResult =
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
                ledgerRef
            ]
        );

    assert.equal(
        stateResult.rowCount,
        1
    );

    const state =
        stateResult.rows[0];

    assert.equal(
        Number(
            state.paid_amount
        ),
        100000
    );

    assert.equal(
        state.status,
        'PARTIAL'
    );

    assert.equal(
        Number(
            state.settlement_rows
        ),
        1
    );

    assert.equal(
        Number(
            state.ledger_rows
        ),
        2
    );

    passed(
        'Customer settlement API retry does not double paid amount'
    );

    passed(
        'Customer settlement API retry does not duplicate settlement'
    );

    passed(
        'Customer settlement API retry does not duplicate ledger'
    );

    /*
     * Retry settlement juga tidak boleh mengubah order.
     */
    const orderResult =
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
        orderResult.rows[0].status,
        'PACKING'
    );

    assert.equal(
        orderResult.rows[0]
            .payment_mode,
        'TEMPO'
    );

    passed(
        'Customer settlement API retry leaves order lifecycle unchanged'
    );

    return context;
}

async function testOwnerFinalSettlement(
    context
) {
    const {
        client,
        scenario,
        ownerToken
    } = context;

    const finalKey =
        'CUSTOMER-SETTLEMENT-FINAL-' +
        crypto.randomUUID();

    /*
     * Sisa piutang:
     *
     * Principal : 300000
     * Dibayar   : 100000
     * Final     : 200000
     */

    const response =
        await apiRequest({
            path:
                `/api/customer/credit-obligations-v1/${scenario.obligation.id}/settlements`,

            token:
                ownerToken,

            body: {
                amount:
                    200000,

                payment_method:
                    'BANK_TRANSFER',

                idempotency_key:
                    finalKey,

                reference_number:
                    'SYNTHETIC-CUSTOMER-FINAL-API',

                notes:
                    'Synthetic Customer final settlement API'
            }
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
        response.data.idempotent,
        false
    );

    assert.ok(
        response.data.settlement
    );

    assert.ok(
        response.data.obligation
    );

    assert.equal(
        response.data.obligation.status,
        'PAID'
    );

    assert.equal(
        Number(
            response.data.obligation
                .paid_amount
        ),
        300000
    );

    assert.ok(
        response.data.obligation
            .paid_at
    );

    passed(
        'Owner can fully settle Customer receivable'
    );

    passed(
        'Customer final settlement changes receivable to PAID'
    );

    passed(
        'Customer final settlement fully pays receivable'
    );

    /*
     * Verifikasi settlement total.
     */

    const settlementResult =
        await client.query(
            `
            SELECT
                COUNT(*)::int
                    AS settlement_rows,

                COALESCE(
                    SUM(amount),
                    0
                )::numeric
                    AS settlement_total

            FROM tbl_credit_settlements
            WHERE obligation_id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        Number(
            settlementResult.rows[0]
                .settlement_rows
        ),
        2
    );

    assert.equal(
        Number(
            settlementResult.rows[0]
                .settlement_total
        ),
        300000
    );

    passed(
        'Customer settlement API total equals receivable principal'
    );

    /*
     * Verifikasi jurnal final settlement.
     */

    const finalLedgerRef =
        response.data
            .ledger_reference;

    assert.ok(
        finalLedgerRef
    );

    const ledgerResult =
        await client.query(
            `
            SELECT
                account_code,
                debit,
                credit
            FROM tbl_general_ledger
            WHERE transaction_reference =
                $1
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

    const cashEntry =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1100'
        );

    const receivableEntry =
        ledgerResult.rows.find(
            row =>
                row.account_code ===
                '1300'
        );

    assert.ok(
        cashEntry
    );

    assert.ok(
        receivableEntry
    );

    assert.equal(
        Number(cashEntry.debit),
        200000
    );

    assert.equal(
        Number(cashEntry.credit),
        0
    );

    assert.equal(
        Number(receivableEntry.debit),
        0
    );

    assert.equal(
        Number(receivableEntry.credit),
        200000
    );

    const totalDebit =
        ledgerResult.rows.reduce(
            (
                total,
                row
            ) =>
                total +
                Number(
                    row.debit || 0
                ),
            0
        );

    const totalCredit =
        ledgerResult.rows.reduce(
            (
                total,
                row
            ) =>
                total +
                Number(
                    row.credit || 0
                ),
            0
        );

    assert.equal(
        totalDebit,
        totalCredit
    );

    assert.equal(
        totalDebit,
        200000
    );

    passed(
        'Customer final settlement API posts balanced receivable journal'
    );

    /*
     * Settlement piutang BUKAN payment order.
     */

    const paymentResult =
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
        Number(
            paymentResult.rows[0].count
        ),
        0
    );

    passed(
        'Paid Customer receivable API creates no order payment'
    );

    /*
     * Lifecycle operasional order tidak boleh berubah.
     *
     * Pelunasan piutang bukan event ORDER_PAID.
     */

    const orderResult =
        await client.query(
            `
            SELECT
                status,
                payment_mode,
                credit_account_id
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

    assert.equal(
        orderResult.rows[0].status,
        'PACKING'
    );

    assert.equal(
        orderResult.rows[0]
            .payment_mode,
        'TEMPO'
    );

    assert.equal(
        String(
            orderResult.rows[0]
                .credit_account_id
        ),
        String(
            scenario.account.id
        )
    );

    passed(
        'Paid Customer receivable API leaves order lifecycle unchanged'
    );

    return {
        ...context,
        finalSettlement:
            response.data.settlement,
        finalLedgerRef
    };
}

async function testPaidReceivableGuard(
    context
) {
    const {
        client,
        scenario,
        ownerToken
    } = context;

    /*
     * Snapshot setelah receivable PAID.
     */

    const beforeResult =
        await client.query(
            `
            SELECT
                paid_amount,
                status,
                paid_at
            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        beforeResult.rowCount,
        1
    );

    assert.equal(
        beforeResult.rows[0].status,
        'PAID'
    );

    assert.equal(
        Number(
            beforeResult.rows[0]
                .paid_amount
        ),
        300000
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

    const ledgerBefore =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_general_ledger
            WHERE transaction_reference LIKE
                'CSET-%'
              AND description LIKE
                '%' || $1::text || '%'
            `,
            [
                scenario.obligation.id
            ]
        );

    /*
     * Idempotency key BARU.
     *
     * Ini bukan retry request lama.
     * Karena receivable sudah PAID,
     * settlement tambahan wajib ditolak.
     */

    const response =
        await apiRequest({
            path:
                `/api/customer/credit-obligations-v1/${scenario.obligation.id}/settlements`,

            token:
                ownerToken,

            body: {
                amount:
                    1000,

                payment_method:
                    'CASH',

                idempotency_key:
                    'CUSTOMER-SETTLEMENT-AFTER-PAID-' +
                    crypto.randomUUID(),

                reference_number:
                    'SYNTHETIC-CUSTOMER-AFTER-PAID',

                notes:
                    'Must be rejected because receivable is PAID'
            }
        });

    assert.ok(
        response.statusCode >= 400 &&
        response.statusCode < 500,
        `Expected 4xx, got ${response.statusCode}`
    );

    assert.match(
        String(
            response.data.error || ''
        ),
        /lunas|PAID/i
    );

    passed(
        'Paid Customer receivable API rejects additional settlement'
    );

    /*
     * Verifikasi tidak ada mutation.
     */

    const afterResult =
        await client.query(
            `
            SELECT
                paid_amount,
                status,
                paid_at
            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        afterResult.rowCount,
        1
    );

    assert.equal(
        afterResult.rows[0].status,
        'PAID'
    );

    assert.equal(
        Number(
            afterResult.rows[0]
                .paid_amount
        ),
        300000
    );

    assert.equal(
        String(
            afterResult.rows[0]
                .paid_at
        ),
        String(
            beforeResult.rows[0]
                .paid_at
        )
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
        Number(
            settlementsAfter.rows[0]
                .count
        ),
        Number(
            settlementsBefore.rows[0]
                .count
        )
    );

    const ledgerAfter =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_general_ledger
            WHERE transaction_reference LIKE
                'CSET-%'
              AND description LIKE
                '%' || $1::text || '%'
            `,
            [
                scenario.obligation.id
            ]
        );

    assert.equal(
        Number(
            ledgerAfter.rows[0]
                .count
        ),
        Number(
            ledgerBefore.rows[0]
                .count
        )
    );

    /*
     * Order tetap TEMPO + PACKING.
     */

    const orderResult =
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
        orderResult.rowCount,
        1
    );

    assert.equal(
        orderResult.rows[0].status,
        'PACKING'
    );

    assert.equal(
        orderResult.rows[0]
            .payment_mode,
        'TEMPO'
    );

    passed(
        'Rejected paid Customer settlement API leaves receivable unchanged'
    );

    passed(
        'Rejected paid Customer settlement API leaves order lifecycle unchanged'
    );

    return context;
}

async function testCustomerOverpaymentApi(
    context
) {
    const {
        client,
        domain,
        scenario,
        ownerToken
    } = context;

    /*
     * Gunakan credit account yang sama.
     * Buat order + obligation baru khusus overpayment test.
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
                'Synthetic Customer Settlement API Overpayment',
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
                domain.owner.id,
                domain.merchant.id,
                scenario.account.id
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
                'Synthetic Customer Settlement API Overpayment'
            )
            RETURNING *
            `,
            [
                scenario.account.id,
                order.id
            ]
        );

    const obligation =
        obligationResult.rows[0];

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

    const response =
        await apiRequest({
            path:
                `/api/customer/credit-obligations-v1/${obligation.id}/settlements`,

            token:
                ownerToken,

            body: {
                amount:
                    100001,

                payment_method:
                    'QRIS',

                idempotency_key:
                    'CUSTOMER-SETTLEMENT-OVERPAYMENT-' +
                    crypto.randomUUID(),

                reference_number:
                    'SYNTHETIC-CUSTOMER-OVERPAYMENT-API',

                notes:
                    'Synthetic Customer overpayment API'
            }
        });

    assert.ok(
        response.statusCode >= 400 &&
        response.statusCode < 500,
        `Expected 4xx, got ${response.statusCode}`
    );

    assert.match(
        String(
            response.data.error || ''
        ),
        /melebihi sisa piutang/i
    );

    passed(
        'Customer settlement API rejects overpayment'
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
                obligation.id
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

    const settlementRows =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_credit_settlements
            WHERE obligation_id = $1
            `,
            [
                obligation.id
            ]
        );

    assert.equal(
        Number(
            settlementRows.rows[0].count
        ),
        0
    );

    const ledgerRows =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_general_ledger
            WHERE description LIKE
                '%' || $1::text || '%'
            `,
            [
                obligation.id
            ]
        );

    assert.equal(
        Number(
            ledgerRows.rows[0].count
        ),
        0
    );

    const paymentRows =
        await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM tbl_payments
            WHERE order_id = $1
            `,
            [
                order.id
            ]
        );

    assert.equal(
        Number(
            paymentRows.rows[0].count
        ),
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
                order.id
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
        'Rejected Customer overpayment API leaves receivable unchanged'
    );

    passed(
        'Rejected Customer overpayment API creates no financial mutation'
    );

    passed(
        'Rejected Customer overpayment API leaves order lifecycle unchanged'
    );

    return context;
}

async function cleanupApiScenario(
    context
) {
    if (
        !context ||
        !context.scenario ||
        !context.scenario.account
    ) {
        return;
    }

    const accountId =
        context.scenario.account.id;

    /*
     * =====================================================
     * CLEANUP SYNTHETIC CUSTOMER SETTLEMENT API
     *
     * Urutan:
     *
     * 1. Ledger milik settlement synthetic
     * 2. Settlement
     * 3. Obligation
     * 4. Order
     * 5. Credit account
     *
     * Semua dibatasi oleh account synthetic yang dibuat
     * khusus contract ini.
     * =====================================================
     */

    const cleanupClient =
        await pool.connect();

    try {
        await cleanupClient.query(
            'BEGIN'
        );

        /*
         * Hapus ledger CSET berdasarkan settlement yang
         * benar-benar terkait obligation account synthetic.
         */
        await cleanupClient.query(
            `
            DELETE FROM tbl_general_ledger
            WHERE transaction_reference IN (
                SELECT
                    'CSET-' || cs.id::text
                FROM tbl_credit_settlements cs
                JOIN tbl_credit_obligations co
                    ON co.id =
                        cs.obligation_id
                WHERE co.credit_account_id =
                    $1
            )
            `,
            [
                accountId
            ]
        );

        await cleanupClient.query(
            `
            DELETE FROM tbl_credit_settlements
            WHERE obligation_id IN (
                SELECT id
                FROM tbl_credit_obligations
                WHERE credit_account_id =
                    $1
            )
            `,
            [
                accountId
            ]
        );

        await cleanupClient.query(
            `
            DELETE FROM tbl_credit_obligations
            WHERE credit_account_id =
                $1
            `,
            [
                accountId
            ]
        );

        await cleanupClient.query(
            `
            DELETE FROM tbl_orders_v2
            WHERE credit_account_id =
                $1
            `,
            [
                accountId
            ]
        );

        await cleanupClient.query(
            `
            DELETE FROM tbl_credit_accounts
            WHERE id = $1
            `,
            [
                accountId
            ]
        );

        await cleanupClient.query(
            'COMMIT'
        );

    } catch (err) {
        try {
            await cleanupClient.query(
                'ROLLBACK'
            );
        } catch (_) {}

        throw err;

    } finally {
        cleanupClient.release();
    }
}


async function verifyZeroResidue() {
    const residue =
        await pool.query(
            `
            SELECT

                (
                    SELECT COUNT(*)
                    FROM tbl_orders_v2
                    WHERE shipping_address IN (
                        'Synthetic Customer Settlement API',
                        'Synthetic Customer Settlement API Overpayment'
                    )
                )::int
                    AS synthetic_orders,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_obligations
                    WHERE description IN (
                        'Synthetic Customer Settlement API',
                        'Synthetic Customer Settlement API Overpayment'
                    )
                )::int
                    AS synthetic_obligations,

                (
                    SELECT COUNT(*)
                    FROM tbl_credit_settlements
                    WHERE reference_number LIKE
                        'SYNTHETIC-CUSTOMER-%'
                       OR reference_number =
                        'SYNTHETIC-STRANGER'
                )::int
                    AS synthetic_settlements,

                (
                    SELECT COUNT(*)
                    FROM tbl_general_ledger
                    WHERE transaction_reference LIKE
                        'CSET-%'
                      AND (
                            description LIKE
                                '%Synthetic Customer Settlement API%'
                            OR description LIKE
                                '%Synthetic Customer Settlement API Overpayment%'
                          )
                )::int
                    AS synthetic_ledger
            `
        );

    const row =
        residue.rows[0];

    assert.equal(
        row.synthetic_orders,
        0
    );

    assert.equal(
        row.synthetic_obligations,
        0
    );

    assert.equal(
        row.synthetic_settlements,
        0
    );

    /*
     * Service ledger description menggunakan obligation UUID,
     * sehingga cleanup account-scoped adalah invariant utama.
     * Query ini tetap menjadi defense tambahan.
     */
    assert.equal(
        row.synthetic_ledger,
        0
    );

    passed(
        'Synthetic Customer settlement API data leaves zero residue'
    );
}


async function main() {
    console.log(
        '===== CUSTOMER TEMPO SETTLEMENT API CONTRACT V1 ====='
    );

    let context = null;

    try {
        context =
            await testSettlementOwnership();

        context =
            await testOwnerPartialSettlement(
                context
            );

        context =
            await testSettlementRetry(
                context
            );

        context =
            await testOwnerFinalSettlement(
                context
            );

        context =
            await testPaidReceivableGuard(
                context
            );

        context =
            await testCustomerOverpaymentApi(
                context
            );

    } catch (err) {
        failed(
            'Customer TEMPO settlement API contract',
            err
        );

    } finally {
        /*
         * Context sukses mempertahankan client dari ownership
         * test. Release setelah seluruh HTTP contract selesai.
         */
        if (
            context &&
            context.client
        ) {
            context.client.release();
            context.client = null;
        }

        /*
         * Cleanup harus tetap dilakukan walaupun assertion
         * di tengah contract gagal.
         */
        try {
            await cleanupApiScenario(
                context
            );

        } catch (err) {
            failed(
                'Customer settlement API cleanup',
                err
            );
        }

        try {
            await verifyZeroResidue();

        } catch (err) {
            failed(
                'Customer settlement API zero residue',
                err
            );
        }

        console.log(
            '===== CUSTOMER TEMPO SETTLEMENT API CONTRACT RESULT ====='
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
