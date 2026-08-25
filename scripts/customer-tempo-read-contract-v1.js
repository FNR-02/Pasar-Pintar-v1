require('dotenv').config();

const assert = require('assert');
const pool = require('../src/config/db');

const CustomerTempoReadService =
    require(
        '../src/services/credit/CustomerTempoReadService'
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

async function resolveDomain(client) {
    const merchantResult =
        await client.query(`
            SELECT id, user_id, store_name
            FROM tbl_merchants
            WHERE status = 'ACTIVE'
              AND user_id IS NOT NULL
            ORDER BY created_at
            LIMIT 1
        `);

    if (!merchantResult.rowCount) {
        throw new Error(
            'Merchant aktif tidak tersedia'
        );
    }

    const customersResult =
        await client.query(`
            SELECT
                c.id,
                c.user_id,
                c.full_name
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
            'Diperlukan minimal dua Customer'
        );
    }

    return {
        merchant: merchantResult.rows[0],
        owner: customersResult.rows[0],
        stranger: customersResult.rows[1]
    };
}

async function buildScenario(
    client,
    domain
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
                500000,
                7,
                'ACTIVE',
                CURRENT_TIMESTAMP
            )
            RETURNING *
            `,
            [
                domain.owner.id,
                domain.merchant.id
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
                'Synthetic Customer Tempo Read',
                300000,
                'DELIVERY',
                'TEMPO',
                $3,
                CURRENT_TIMESTAMP -
                    INTERVAL '1 day'
            )
            RETURNING *
            `,
            [
                domain.owner.id,
                domain.merchant.id,
                account.id
            ]
        );

    return {
        account,
        overdueOrder:
            orderResult.rows[0]
    };
}

async function addOverdueObligation(
    client,
    scenario
) {
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
                300000,
                100000,
                CURRENT_TIMESTAMP -
                    INTERVAL '1 day',
                'PARTIAL',
                'Synthetic Customer Tempo Read'
            )
            RETURNING *
            `,
            [
                scenario.account.id,
                scenario.overdueOrder.id
            ]
        );

    const obligation =
        obligationResult.rows[0];

    await client.query(
        `
        INSERT INTO tbl_credit_settlements (
            obligation_id,
            amount,
            payment_method,
            reference_number,
            notes,
            received_by,
            idempotency_key
        )
        VALUES (
            $1,
            100000,
            'CASH',
            'SYNTHETIC-TEMPO-READ',
            'Synthetic Customer Tempo Read settlement',
            NULL,
            'SYNTHETIC-TEMPO-READ-KEY'
        )
        `,
        [obligation.id]
    );

    scenario.overdueObligation =
        obligation;

    return scenario;
}

async function addOpenObligation(
    client,
    domain,
    scenario
) {
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
                'Synthetic Customer Tempo Read',
                50000,
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

    const openOrder =
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
                50000,
                0,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days',
                'OPEN',
                'Synthetic Customer Tempo Read'
            )
            RETURNING *
            `,
            [
                scenario.account.id,
                openOrder.id
            ]
        );

    scenario.openOrder =
        openOrder;

    scenario.openObligation =
        obligationResult.rows[0];

    return scenario;
}

async function testAccountSummary(
    client,
    domain,
    scenario
) {
    const service =
        new CustomerTempoReadService(
            client
        );

    const result =
        await service
            .listAccountsForCustomer(
                domain.owner.user_id
            );

    assert.equal(
        result.accounts.length,
        1
    );

    const account =
        result.accounts[0];

    assert.equal(
        String(account.customer_id),
        String(domain.owner.id)
    );

    assert.equal(
        Number(account.credit_limit),
        500000
    );

    assert.equal(
        Number(account.outstanding_amount),
        250000
    );

    assert.equal(
        Number(account.available_credit),
        250000
    );

    assert.equal(
        Number(account.active_obligations),
        2
    );

    assert.equal(
        Number(account.overdue_obligations),
        1
    );

    assert.equal(
        String(account.id),
        String(scenario.account.id)
    );

    passed(
        'Customer read lists own TEMPO account summary'
    );

    return service;
}

async function testObligationList(
    service,
    client,
    domain,
    scenario
) {
    const result =
        await service
            .listObligationsForCustomer(
                domain.owner.user_id
            );

    assert.equal(
        result.obligations.length,
        2
    );

    const overdue =
        result.obligations.find(
            row =>
                String(row.id) ===
                String(
                    scenario.overdueObligation.id
                )
        );

    assert.ok(overdue);

    assert.equal(
        Number(overdue.principal_amount),
        300000
    );

    assert.equal(
        Number(overdue.paid_amount),
        100000
    );

    assert.equal(
        Number(overdue.remaining_amount),
        200000
    );

    assert.equal(
        overdue.stored_status,
        'PARTIAL'
    );

    assert.equal(
        overdue.effective_status,
        'OVERDUE'
    );

    passed(
        'Customer read calculates overdue effective status'
    );

    const stored =
        await client.query(
            `
            SELECT status
            FROM tbl_credit_obligations
            WHERE id = $1
            `,
            [
                scenario.overdueObligation.id
            ]
        );

    assert.equal(
        stored.rows[0].status,
        'PARTIAL'
    );

    passed(
        'Customer read does not mutate stored obligation status'
    );
}

async function testObligationDetail(
    service,
    domain,
    scenario
) {
    const detail =
        await service
            .getObligationForCustomer({
                userId:
                    domain.owner.user_id,
                obligationId:
                    scenario.overdueObligation.id
            });

    assert.equal(
        String(detail.obligation.id),
        String(
            scenario.overdueObligation.id
        )
    );

    assert.equal(
        Number(
            detail.obligation
                .remaining_amount
        ),
        200000
    );

    assert.equal(
        detail.obligation
            .effective_status,
        'OVERDUE'
    );

    assert.equal(
        detail.settlements.length,
        1
    );

    assert.equal(
        Number(
            detail.settlements[0].amount
        ),
        100000
    );

    assert.equal(
        detail.settlements[0]
            .payment_method,
        'CASH'
    );

    passed(
        'Customer read detail includes settlement history'
    );

    let strangerRejected = false;

    try {
        await service
            .getObligationForCustomer({
                userId:
                    domain.stranger.user_id,
                obligationId:
                    scenario.overdueObligation.id
            });

    } catch (err) {
        strangerRejected =
            /tidak ditemukan/i.test(
                String(err.message || '')
            );
    }

    assert.equal(
        strangerRejected,
        true
    );

    passed(
        'Other Customer cannot read owner TEMPO obligation'
    );

    const strangerAccounts =
        await service
            .listAccountsForCustomer(
                domain.stranger.user_id
            );

    assert.equal(
        strangerAccounts.accounts.length,
        0
    );

    passed(
        'Other Customer cannot see owner TEMPO account'
    );
}

async function main() {
    console.log(
        '===== CUSTOMER TEMPO READ CONTRACT V1 ====='
    );

    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const domain =
            await resolveDomain(client);

        let scenario =
            await buildScenario(
                client,
                domain
            );

        scenario =
            await addOverdueObligation(
                client,
                scenario
            );

        scenario =
            await addOpenObligation(
                client,
                domain,
                scenario
            );

        passed(
            'Synthetic Customer TEMPO read fixture created'
        );

        const service =
            await testAccountSummary(
                client,
                domain,
                scenario
            );

        await testObligationList(
            service,
            client,
            domain,
            scenario
        );

        await testObligationDetail(
            service,
            domain,
            scenario
        );

        await client.query('ROLLBACK');

        passed(
            'Synthetic Customer TEMPO read transaction rolled back'
        );

    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        failed(
            'Customer TEMPO read contract',
            err
        );

    } finally {
        client.release();
    }

    console.log(
        '===== CUSTOMER TEMPO READ CONTRACT RESULT ====='
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

main();
