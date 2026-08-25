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
            id: user.id,
            role_id: Number(user.role_id)
        },
        process.env.JWT_SECRET,
        {
            expiresIn: '10m'
        }
    );
}

async function apiRequest({
    path,
    token
}) {
    const response =
        await fetch(
            `${BASE_URL}${path}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${token}`
                }
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
            'Merchant aktif tidak tersedia'
        );
    }

    const customerResult =
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

    if (customerResult.rowCount < 2) {
        throw new Error(
            'Diperlukan minimal dua Customer'
        );
    }

    return {
        merchant:
            merchantResult.rows[0],
        owner: {
            id:
                customerResult.rows[0]
                    .user_id,
            customer_id:
                customerResult.rows[0]
                    .id,
            role_id:
                customerResult.rows[0]
                    .role_id
        },
        stranger: {
            id:
                customerResult.rows[1]
                    .user_id,
            customer_id:
                customerResult.rows[1]
                    .id,
            role_id:
                customerResult.rows[1]
                    .role_id
        }
    };
}

async function createAccount(
    client,
    domain
) {
    const result =
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
                500000,
                7,
                'ACTIVE',
                CURRENT_TIMESTAMP
            )
            RETURNING *
            `,
            [
                domain.owner.customer_id,
                domain.merchant.id
            ]
        );

    return result.rows[0];
}

async function createOverdueFixture(
    client,
    domain,
    account
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
                'Synthetic Customer Tempo Read API',
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
                domain.owner.customer_id,
                domain.merchant.id,
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
                300000,
                100000,
                CURRENT_TIMESTAMP -
                    INTERVAL '1 day',
                'PARTIAL',
                'Synthetic Customer Tempo Read API'
            )
            RETURNING *
            `,
            [
                account.id,
                order.id
            ]
        );

    return {
        order,
        obligation:
            obligationResult.rows[0]
    };
}

async function createSettlement(
    client,
    obligation,
    domain
) {
    const result =
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
                'SYNTHETIC-READ-API',
                'Synthetic Customer Tempo Read API',
                $2,
                'SYNTHETIC-READ-API-KEY'
            )
            RETURNING *
            `,
            [
                obligation.id,
                domain.owner.id
            ]
        );

    return result.rows[0];
}

async function createOpenFixture(
    client,
    domain,
    account
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
                'Synthetic Customer Tempo Read API',
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
                domain.owner.customer_id,
                domain.merchant.id,
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
                50000,
                0,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days',
                'OPEN',
                'Synthetic Customer Tempo Read API'
            )
            RETURNING *
            `,
            [
                account.id,
                order.id
            ]
        );

    return {
        order,
        obligation:
            obligationResult.rows[0]
    };
}

async function testAccountApi(
    domain
) {
    const response =
        await apiRequest({
            path:
                '/api/customer/credit-accounts-v1',
            token:
                tokenFor(domain.owner)
        });

    assert.equal(
        response.statusCode,
        200
    );

    assert.equal(
        response.data.status,
        'success'
    );

    assert.equal(
        response.data.count,
        1
    );

    assert.equal(
        response.data.accounts.length,
        1
    );

    const account =
        response.data.accounts[0];

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

    passed(
        'Customer account read API returns own TEMPO summary'
    );
}

async function testObligationListApi(
    domain,
    overdueFixture
) {
    const response =
        await apiRequest({
            path:
                '/api/customer/credit-obligations-v1',
            token:
                tokenFor(domain.owner)
        });

    assert.equal(
        response.statusCode,
        200
    );

    assert.equal(
        response.data.status,
        'success'
    );

    assert.equal(
        response.data.count,
        2
    );

    const overdue =
        response.data.obligations.find(
            row =>
                String(row.id) ===
                String(
                    overdueFixture.obligation.id
                )
        );

    assert.ok(overdue);

    assert.equal(
        Number(overdue.remaining_amount),
        200000
    );

    assert.equal(
        overdue.effective_status,
        'OVERDUE'
    );

    passed(
        'Customer obligation list API returns effective overdue'
    );
}

async function testObligationDetailApi(
    domain,
    overdueFixture
) {
    const id =
        overdueFixture.obligation.id;

    const response =
        await apiRequest({
            path:
                '/api/customer/credit-obligations-v1/' +
                encodeURIComponent(id),
            token:
                tokenFor(domain.owner)
        });

    assert.equal(
        response.statusCode,
        200
    );

    assert.equal(
        response.data.status,
        'success'
    );

    assert.equal(
        String(response.data.obligation.id),
        String(id)
    );

    assert.equal(
        Number(
            response.data.obligation
                .remaining_amount
        ),
        200000
    );

    assert.equal(
        response.data.obligation
            .effective_status,
        'OVERDUE'
    );

    assert.equal(
        response.data.settlements.length,
        1
    );

    assert.equal(
        Number(
            response.data.settlements[0]
                .amount
        ),
        100000
    );

    passed(
        'Customer obligation detail API includes settlement history'
    );
}

async function testOwnershipApi(
    domain,
    overdueFixture
) {
    const id =
        overdueFixture.obligation.id;

    const response =
        await apiRequest({
            path:
                '/api/customer/credit-obligations-v1/' +
                encodeURIComponent(id),
            token:
                tokenFor(domain.stranger)
        });

    assert.ok(
        response.statusCode === 403 ||
        response.statusCode === 404
    );

    passed(
        'Other Customer cannot read owner TEMPO obligation API'
    );

    const accounts =
        await apiRequest({
            path:
                '/api/customer/credit-accounts-v1',
            token:
                tokenFor(domain.stranger)
        });

    assert.equal(
        accounts.statusCode,
        200
    );

    assert.equal(
        accounts.data.count,
        0
    );

    passed(
        'Other Customer cannot see owner TEMPO account API'
    );
}

async function cleanupScenario(
    client,
    scenario
) {
    if (!scenario) return;

    if (scenario.open) {
        await client.query(
            `DELETE FROM tbl_credit_obligations
             WHERE id = $1`,
            [scenario.open.obligation.id]
        );

        await client.query(
            `DELETE FROM tbl_orders_v2
             WHERE id = $1`,
            [scenario.open.order.id]
        );
    }

    if (scenario.overdue) {
        await client.query(
            `DELETE FROM tbl_credit_settlements
             WHERE obligation_id = $1`,
            [scenario.overdue.obligation.id]
        );

        await client.query(
            `DELETE FROM tbl_credit_obligations
             WHERE id = $1`,
            [scenario.overdue.obligation.id]
        );

        await client.query(
            `DELETE FROM tbl_orders_v2
             WHERE id = $1`,
            [scenario.overdue.order.id]
        );
    }

    if (scenario.account) {
        await client.query(
            `DELETE FROM tbl_credit_accounts
             WHERE id = $1`,
            [scenario.account.id]
        );
    }
}

async function main() {
    console.log(
        '===== CUSTOMER TEMPO READ API CONTRACT V1 ====='
    );

    const client =
        await pool.connect();

    let scenario = null;

    try {
        const domain =
            await resolveDomain(client);

        const account =
            await createAccount(
                client,
                domain
            );

        const overdue =
            await createOverdueFixture(
                client,
                domain,
                account
            );

        await createSettlement(
            client,
            overdue.obligation,
            domain
        );

        const open =
            await createOpenFixture(
                client,
                domain,
                account
            );

        scenario = {
            account,
            overdue,
            open
        };

        await testAccountApi(
            domain
        );

        await testObligationListApi(
            domain,
            overdue
        );

        await testObligationDetailApi(
            domain,
            overdue
        );

        await testOwnershipApi(
            domain,
            overdue
        );

    } catch (err) {
        failed(
            'Customer TEMPO read API contract',
            err
        );
    } finally {
        try {
            await cleanupScenario(
                client,
                scenario
            );

            passed(
                'Synthetic Customer TEMPO read API data cleaned'
            );
        } catch (err) {
            failed(
                'Synthetic Customer TEMPO read API cleanup',
                err
            );
        }

        client.release();
    }

    console.log(
        '===== CUSTOMER TEMPO READ API CONTRACT RESULT ====='
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
