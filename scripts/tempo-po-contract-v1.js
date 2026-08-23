require('dotenv').config();

const assert = require('assert');
const pool = require('../src/config/db');

const CreditObligationService =
    require(
        '../src/services/credit/CreditObligationService'
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
    const result = await client.query(`
        SELECT
            p.id AS product_id,
            p.merchant_id,
            p.name AS product_name,
            i.warehouse_id,
            i.quantity_on_hand,
            pp.amount AS unit_cost,
            s.id AS supplier_id
        FROM tbl_products p

        JOIN tbl_inventory i
            ON i.product_id = p.id

        JOIN LATERAL (
            SELECT amount
            FROM tbl_product_prices
            WHERE product_id = p.id
              AND UPPER(price_type) <> 'RETAIL'
            ORDER BY effective_date DESC
            LIMIT 1
        ) pp ON TRUE

        CROSS JOIN LATERAL (
            SELECT id
            FROM tbl_suppliers
            ORDER BY created_at
            LIMIT 1
        ) s

        WHERE p.status = 'ACTIVE'
          AND p.merchant_id IS NOT NULL
          AND i.warehouse_id IS NOT NULL
          AND pp.amount > 0

        ORDER BY p.created_at
        LIMIT 1
    `);

    assert.strictEqual(
        result.rowCount,
        1,
        'Synthetic domain tidak tersedia'
    );

    return result.rows[0];
}

async function createSupplierCreditAccount(
    client,
    domain,
    limit,
    termDays
) {
    const result = await client.query(
        `
        INSERT INTO tbl_credit_accounts (
            account_type,
            merchant_id,
            supplier_id,
            customer_id,
            credit_limit,
            default_term_days,
            same_day_due_time,
            status,
            notes,
            approved_at
        )
        VALUES (
            'SUPPLIER',
            $1,
            $2,
            NULL,
            $3,
            $4,
            NULL,
            'ACTIVE',
            'SYNTHETIC TEMPO CONTRACT',
            CURRENT_TIMESTAMP
        )
        RETURNING *
        `,
        [
            domain.merchant_id,
            domain.supplier_id,
            limit,
            termDays
        ]
    );

    return result.rows[0];
}

async function createTempoPo(
    client,
    domain,
    account,
    quantity
) {
    const unitCost =
        Number(domain.unit_cost);

    const total =
        unitCost * quantity;

    const dueResult =
        await client.query(
            `
            SELECT
                CURRENT_TIMESTAMP +
                ($1::int * INTERVAL '1 day')
                    AS due_at
            `,
            [
                Number(
                    account.default_term_days
                )
            ]
        );

    const dueAt =
        dueResult.rows[0].due_at;

    const poResult = await client.query(
        `
        INSERT INTO tbl_purchase_orders (
            supplier_id,
            merchant_id,
            warehouse_id,
            status,
            total_amount,
            payment_mode,
            credit_account_id,
            tempo_due_at
        )
        VALUES (
            $1,
            $2,
            $3,
            'APPROVED',
            $4,
            'TEMPO',
            $5,
            $6
        )
        RETURNING *
        `,
        [
            domain.supplier_id,
            domain.merchant_id,
            domain.warehouse_id,
            total,
            account.id,
            dueAt
        ]
    );

    const po =
        poResult.rows[0];

    await client.query(
        `
        INSERT INTO tbl_purchase_order_items (
            purchase_order_id,
            product_id,
            quantity,
            unit_cost
        )
        VALUES ($1,$2,$3,$4)
        `,
        [
            po.id,
            domain.product_id,
            quantity,
            unitCost
        ]
    );

    return po;
}

/*
 * Mimic canonical receiving transaction.
 *
 * Seluruh operasi:
 *
 * inventory
 * movement
 * obligation
 * PO RECEIVED
 *
 * berada dalam PostgreSQL transaction
 * yang sama.
 */
async function receiveTempoPo(
    client,
    po
) {
    const current =
        await client.query(
            `
            SELECT *
            FROM tbl_purchase_orders
            WHERE id = $1
            FOR UPDATE
            `,
            [po.id]
        );

    assert.strictEqual(
        current.rowCount,
        1
    );

    const locked =
        current.rows[0];

    if (locked.status !== 'APPROVED') {
        throw new Error(
            `PO harus APPROVED, sekarang ${locked.status}`
        );
    }

    const items =
        await client.query(
            `
            SELECT
                product_id,
                SUM(quantity)::int AS quantity
            FROM tbl_purchase_order_items
            WHERE purchase_order_id = $1
            GROUP BY product_id
            `,
            [po.id]
        );

    assert.ok(
        items.rowCount > 0
    );

    for (const item of items.rows) {
        const updated =
            await client.query(
                `
                UPDATE tbl_inventory
                SET
                    quantity_on_hand =
                        COALESCE(
                            quantity_on_hand,
                            0
                        ) + $1,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE warehouse_id = $2
                  AND product_id = $3
                RETURNING *
                `,
                [
                    item.quantity,
                    locked.warehouse_id,
                    item.product_id
                ]
            );

        if (!updated.rowCount) {
            await client.query(
                `
                INSERT INTO tbl_inventory (
                    warehouse_id,
                    product_id,
                    quantity_on_hand
                )
                VALUES ($1,$2,$3)
                `,
                [
                    locked.warehouse_id,
                    item.product_id,
                    item.quantity
                ]
            );
        }

        await client.query(
            `
            INSERT INTO tbl_inventory_movements (
                product_id,
                warehouse_id,
                movement_type,
                quantity,
                reference_doc
            )
            VALUES (
                $1,
                $2,
                'PURCHASE_RECEIPT',
                $3,
                $4
            )
            `,
            [
                item.product_id,
                locked.warehouse_id,
                item.quantity,
                `PO-${locked.id}`
            ]
        );
    }

    let obligation = null;

    if (
        String(
            locked.payment_mode
        ).toUpperCase() === 'TEMPO'
    ) {
        const service =
            new CreditObligationService(
                client
            );

        const result =
            await service
                .openPurchaseOrderObligation({
                    purchaseOrderId:
                        locked.id
                });

        assert.ok(
            result &&
            result.obligation,
            'Credit obligation tidak terbentuk'
        );

        obligation =
            result.obligation;
    }

    const update =
        await client.query(
            `
            UPDATE tbl_purchase_orders
            SET status = 'RECEIVED'
            WHERE id = $1
              AND status = 'APPROVED'
            RETURNING *
            `,
            [locked.id]
        );

    assert.strictEqual(
        update.rowCount,
        1
    );

    return {
        purchaseOrder:
            update.rows[0],
        obligation
    };
}

async function happyPath() {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const domain =
            await resolveDomain(client);

        const beforeStock =
            Number(
                domain.quantity_on_hand
            );

        const account =
            await createSupplierCreditAccount(
                client,
                domain,
                100000000,
                7
            );

        const po =
            await createTempoPo(
                client,
                domain,
                account,
                2
            );

        const received =
            await receiveTempoPo(
                client,
                po
            );

        assert.strictEqual(
            received.purchaseOrder.status,
            'RECEIVED'
        );

        passed(
            'TEMPO PO becomes RECEIVED'
        );

        const inventory =
            await client.query(
                `
                SELECT quantity_on_hand
                FROM tbl_inventory
                WHERE warehouse_id = $1
                  AND product_id = $2
                `,
                [
                    domain.warehouse_id,
                    domain.product_id
                ]
            );

        assert.strictEqual(
            Number(
                inventory.rows[0]
                    .quantity_on_hand
            ),
            beforeStock + 2
        );

        passed(
            'TEMPO receiving increases inventory'
        );

        const movement =
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
                  AND movement_type =
                      'PURCHASE_RECEIPT'
                `,
                [`PO-${po.id}`]
            );

        assert.strictEqual(
            movement.rows[0].rows,
            1
        );

        assert.strictEqual(
            movement.rows[0].quantity,
            2
        );

        passed(
            'PURCHASE_RECEIPT movement created once'
        );

        const obligations =
            await client.query(
                `
                SELECT *
                FROM tbl_credit_obligations
                WHERE source_type =
                    'PURCHASE_ORDER'
                  AND source_id = $1
                `,
                [po.id]
            );

        assert.strictEqual(
            obligations.rowCount,
            1
        );

        const obligation =
            obligations.rows[0];

        assert.strictEqual(
            obligation.credit_account_id,
            account.id
        );

        assert.strictEqual(
            Number(
                obligation.principal_amount
            ),
            Number(po.total_amount)
        );

        assert.strictEqual(
            Number(
                obligation.paid_amount
            ),
            0
        );

        assert.strictEqual(
            obligation.status,
            'OPEN'
        );

        assert.strictEqual(
            new Date(
                obligation.due_at
            ).getTime(),
            new Date(
                po.tempo_due_at
            ).getTime()
        );

        passed(
            'Supplier obligation matches PO contract'
        );

        /*
         * Idempotency pada obligation service.
         */
        const service =
            new CreditObligationService(
                client
            );

        const retry =
            await service
                .openPurchaseOrderObligation({
                    purchaseOrderId:
                        po.id
                });

        assert.ok(
            retry.obligation
        );

        const afterRetry =
            await client.query(
                `
                SELECT COUNT(*)::int AS total
                FROM tbl_credit_obligations
                WHERE source_type =
                    'PURCHASE_ORDER'
                  AND source_id = $1
                `,
                [po.id]
            );

        assert.strictEqual(
            afterRetry.rows[0].total,
            1
        );

        passed(
            'Obligation retry is idempotent'
        );

        await client.query(
            'ROLLBACK'
        );

        passed(
            'Happy-path transaction rolled back'
        );

    } catch (err) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (_) {}

        failed(
            'Happy path',
            err
        );

        throw err;

    } finally {
        client.release();
    }
}

async function insufficientLimitRollback() {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const domain =
            await resolveDomain(client);

        const beforeStock =
            Number(
                domain.quantity_on_hand
            );

        const account =
            await createSupplierCreditAccount(
                client,
                domain,
                1,
                7
            );

        const po =
            await createTempoPo(
                client,
                domain,
                account,
                2
            );

        /*
         * SAVEPOINT dipakai agar kita dapat
         * memverifikasi rollback atomic di
         * dalam transaksi synthetic.
         */
        await client.query(
            'SAVEPOINT before_receiving'
        );

        let rejected = false;

        try {
            await receiveTempoPo(
                client,
                po
            );

        } catch (err) {
            rejected = true;

            await client.query(
                'ROLLBACK TO SAVEPOINT before_receiving'
            );
        }

        assert.strictEqual(
            rejected,
            true,
            'Receiving harus ditolak saat limit tidak cukup'
        );

        passed(
            'Insufficient supplier limit rejects receiving'
        );

        const poAfter =
            await client.query(
                `
                SELECT status
                FROM tbl_purchase_orders
                WHERE id = $1
                `,
                [po.id]
            );

        assert.strictEqual(
            poAfter.rows[0].status,
            'APPROVED'
        );

        passed(
            'Failed TEMPO receiving leaves PO APPROVED'
        );

        const inventoryAfter =
            await client.query(
                `
                SELECT quantity_on_hand
                FROM tbl_inventory
                WHERE warehouse_id = $1
                  AND product_id = $2
                `,
                [
                    domain.warehouse_id,
                    domain.product_id
                ]
            );

        assert.strictEqual(
            Number(
                inventoryAfter.rows[0]
                    .quantity_on_hand
            ),
            beforeStock
        );

        passed(
            'Failed TEMPO receiving rolls inventory back'
        );

        const movements =
            await client.query(
                `
                SELECT COUNT(*)::int AS total
                FROM tbl_inventory_movements
                WHERE reference_doc = $1
                  AND movement_type =
                      'PURCHASE_RECEIPT'
                `,
                [`PO-${po.id}`]
            );

        assert.strictEqual(
            movements.rows[0].total,
            0
        );

        passed(
            'Failed TEMPO receiving leaves no movement'
        );

        const obligations =
            await client.query(
                `
                SELECT COUNT(*)::int AS total
                FROM tbl_credit_obligations
                WHERE source_type =
                    'PURCHASE_ORDER'
                  AND source_id = $1
                `,
                [po.id]
            );

        assert.strictEqual(
            obligations.rows[0].total,
            0
        );

        passed(
            'Failed TEMPO receiving leaves no obligation'
        );

        await client.query(
            'ROLLBACK'
        );

        passed(
            'Failure-path transaction rolled back'
        );

    } catch (err) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (_) {}

        failed(
            'Failure path',
            err
        );

        throw err;

    } finally {
        client.release();
    }
}

async function verifyNoResidue() {
    const result =
        await pool.query(`
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
                )::int AS settlements
        `);

    assert.strictEqual(
        result.rows[0].accounts,
        0
    );

    assert.strictEqual(
        result.rows[0].obligations,
        0
    );

    assert.strictEqual(
        result.rows[0].settlements,
        0
    );

    passed(
        'Synthetic credit data leaves zero residue'
    );
}

async function main() {
    console.log(
        '===== TEMPO PO CONTRACT V1 ====='
    );

    try {
        await happyPath();
        await insufficientLimitRollback();
        await verifyNoResidue();

        console.log(
            '===== TEMPO PO CONTRACT RESULT ====='
        );

        console.log(`PASS: ${pass}`);
        console.log(`FAIL: ${fail}`);

        if (fail > 0) {
            process.exitCode = 1;
            return;
        }

        console.log(
            'STATUS: HEALTHY'
        );

    } catch (err) {
        console.error(
            '===== TEMPO PO CONTRACT FAILED ====='
        );
        console.error(
            err.stack || err.message
        );

        process.exitCode = 1;

    } finally {
        await pool.end();
    }
}

main();
