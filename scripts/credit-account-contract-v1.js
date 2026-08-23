require('dotenv').config();

const assert =
    require('assert');

const pool =
    require('../src/config/db');

const CreditAccountService =
    require(
        '../src/services/credit/CreditAccountService'
    );


async function main() {
    const client =
        await pool.connect();

    let pass = 0;

    function passed(name) {
        pass++;
        console.log(
            `PASS  ${name}`
        );
    }

    try {
        await client.query('BEGIN');

        const merchantResult =
            await client.query(`
                SELECT
                    id,
                    user_id
                FROM tbl_merchants
                WHERE status='ACTIVE'
                ORDER BY created_at
                LIMIT 1
            `);

        assert.ok(
            merchantResult.rowCount,
            'Merchant test tidak tersedia'
        );

        const merchant =
            merchantResult.rows[0];


        const customerResult =
            await client.query(`
                SELECT id
                FROM tbl_customers
                ORDER BY created_at
                LIMIT 1
            `);

        assert.ok(
            customerResult.rowCount,
            'Customer test tidak tersedia'
        );

        const customer =
            customerResult.rows[0];


        const supplierResult =
            await client.query(`
                SELECT id
                FROM tbl_suppliers
                ORDER BY created_at
                LIMIT 1
            `);

        assert.ok(
            supplierResult.rowCount,
            'Supplier test tidak tersedia'
        );

        const supplier =
            supplierResult.rows[0];


        const service =
            new CreditAccountService(
                client
            );


        // =====================================================
        // 1. CUSTOMER ACCOUNT
        // =====================================================

        const customerAccount =
            await service.upsertCustomerAccount({
                merchantUserId:
                    merchant.user_id,

                customerId:
                    customer.id,

                creditLimit:
                    1000000,

                defaultTermDays:
                    7,

                notes:
                    'Synthetic contract test'
            });

        assert.equal(
            Number(
                customerAccount.credit_limit
            ),
            1000000
        );

        assert.equal(
            Number(
                customerAccount.outstanding_amount
            ),
            0
        );

        assert.equal(
            Number(
                customerAccount.available_credit
            ),
            1000000
        );

        passed(
            'Customer credit account creation'
        );


        // =====================================================
        // 2. OUTSTANDING
        //
        // Principal : 600.000
        // Paid      : 200.000
        // Outstanding: 400.000
        // Available : 600.000
        // =====================================================

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
                gen_random_uuid(),
                600000,
                200000,
                CURRENT_TIMESTAMP +
                    INTERVAL '7 days',
                'PARTIAL',
                'Synthetic customer obligation'
            )
            `,
            [
                customerAccount.id
            ]
        );

        const customerSummary =
            await service.getAccountSummary(
                customerAccount.id
            );

        assert.equal(
            Number(
                customerSummary.outstanding_amount
            ),
            400000
        );

        assert.equal(
            Number(
                customerSummary.available_credit
            ),
            600000
        );

        assert.equal(
            Number(
                customerSummary.active_obligations
            ),
            1
        );

        passed(
            'Customer outstanding calculation'
        );


        // =====================================================
        // 3. UPSERT IDEMPOTENCY
        // =====================================================

        await service.upsertCustomerAccount({
            merchantUserId:
                merchant.user_id,

            customerId:
                customer.id,

            creditLimit:
                1200000,

            defaultTermDays:
                7
        });

        const customerCount =
            await client.query(
                `
                SELECT
                    COUNT(*)::int AS total
                FROM tbl_credit_accounts
                WHERE account_type='CUSTOMER'
                  AND customer_id=$1
                  AND merchant_id=$2
                `,
                [
                    customer.id,
                    merchant.id
                ]
            );

        assert.equal(
            customerCount.rows[0].total,
            1
        );

        passed(
            'Customer credit account idempotency'
        );


        // =====================================================
        // 4. SUPPLIER ACCOUNT
        //
        // Limit       : 5.000.000
        // Outstanding : 2.000.000
        // Available   : 3.000.000
        // =====================================================

        const supplierAccount =
            await service.upsertSupplierAccount({
                merchantId:
                    merchant.id,

                supplierId:
                    supplier.id,

                creditLimit:
                    5000000,

                defaultTermDays:
                    3,

                notes:
                    'Synthetic supplier test'
            });

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
                gen_random_uuid(),
                2000000,
                0,
                CURRENT_TIMESTAMP +
                    INTERVAL '3 days',
                'OPEN',
                'Synthetic supplier obligation'
            )
            `,
            [
                supplierAccount.id
            ]
        );

        const supplierSummary =
            await service.getAccountSummary(
                supplierAccount.id
            );

        assert.equal(
            Number(
                supplierSummary.outstanding_amount
            ),
            2000000
        );

        assert.equal(
            Number(
                supplierSummary.available_credit
            ),
            3000000
        );

        passed(
            'Supplier outstanding calculation'
        );


        // =====================================================
        // 5. SAME-DAY TERM
        // =====================================================

        const sameDay =
            await service.upsertSupplierAccount({
                merchantId:
                    merchant.id,

                supplierId:
                    supplier.id,

                creditLimit:
                    5000000,

                defaultTermDays:
                    0,

                sameDayDueTime:
                    '13:00'
            });

        assert.equal(
            Number(
                sameDay.default_term_days
            ),
            0
        );

        assert.ok(
            sameDay.same_day_due_time
        );

        passed(
            'Same-day supplier payment term'
        );


        // =====================================================
        // 6. INVALID TENOR
        // =====================================================

        let rejected = false;

        try {
            await service.upsertCustomerAccount({
                merchantUserId:
                    merchant.user_id,

                customerId:
                    customer.id,

                creditLimit:
                    1000000,

                defaultTermDays:
                    999
            });

        } catch (_) {
            rejected = true;
        }

        assert.equal(
            rejected,
            true
        );

        passed(
            'Invalid tenor rejected'
        );


        // Semua data sintetis dibatalkan.
        await client.query('ROLLBACK');


        console.log('');
        console.log(
            '===== CREDIT ACCOUNT CONTRACT RESULT ====='
        );
        console.log(
            `PASS: ${pass}`
        );
        console.log(
            'FAIL: 0'
        );
        console.log(
            'STATUS: HEALTHY'
        );

    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        console.error(
            'FAIL ',
            err.message
        );

        process.exitCode = 1;

    } finally {
        client.release();
        await pool.end();
    }
}


main();
