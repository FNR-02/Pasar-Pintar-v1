class CreditAccountService {
    constructor(db) {
        this.db = db;
    }

    normalizeMoney(value, fieldName) {
        const amount = Number(value);

        if (
            !Number.isFinite(amount) ||
            amount < 0
        ) {
            throw new Error(
                `${fieldName} tidak valid`
            );
        }

        return amount;
    }

    normalizeTermDays(value) {
        const days = Number(value);

        if (
            !Number.isInteger(days) ||
            days < 0 ||
            days > 365
        ) {
            throw new Error(
                'default_term_days harus 0 sampai 365 hari'
            );
        }

        return days;
    }

    normalizeDueTime(value) {
        if (
            value === null ||
            value === undefined ||
            String(value).trim() === ''
        ) {
            return null;
        }

        const normalized =
            String(value).trim();

        if (
            !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/
                .test(normalized)
        ) {
            throw new Error(
                'same_day_due_time harus format HH:MM atau HH:MM:SS'
            );
        }

        return normalized;
    }

    async resolveMerchantByUserId(userId) {
        const result =
            await this.db.query(
                `
                SELECT
                    id,
                    user_id,
                    store_name,
                    status
                FROM tbl_merchants
                WHERE user_id = $1
                  AND status = 'ACTIVE'
                LIMIT 1
                `,
                [userId]
            );

        return result.rows[0] || null;
    }

    async assertCustomerExists(customerId) {
        const result =
            await this.db.query(
                `
                SELECT
                    id,
                    full_name,
                    phone
                FROM tbl_customers
                WHERE id = $1
                LIMIT 1
                `,
                [customerId]
            );

        if (!result.rowCount) {
            throw new Error(
                'Customer tidak ditemukan'
            );
        }

        return result.rows[0];
    }

    async assertMerchantExists(merchantId) {
        const result =
            await this.db.query(
                `
                SELECT
                    id,
                    store_name,
                    status
                FROM tbl_merchants
                WHERE id = $1
                  AND status = 'ACTIVE'
                LIMIT 1
                `,
                [merchantId]
            );

        if (!result.rowCount) {
            throw new Error(
                'Merchant aktif tidak ditemukan'
            );
        }

        return result.rows[0];
    }

    async assertSupplierExists(supplierId) {
        const result =
            await this.db.query(
                `
                SELECT
                    id,
                    supplier_name
                FROM tbl_suppliers
                WHERE id = $1
                LIMIT 1
                `,
                [supplierId]
            );

        if (!result.rowCount) {
            throw new Error(
                'Supplier tidak ditemukan'
            );
        }

        return result.rows[0];
    }

    async upsertCustomerAccount({
        merchantUserId,
        customerId,
        creditLimit,
        defaultTermDays = 0,
        sameDayDueTime = null,
        notes = null,
        approvedBy = null
    }) {
        if (!merchantUserId) {
            throw new Error(
                'merchantUserId wajib tersedia'
            );
        }

        if (!customerId) {
            throw new Error(
                'customerId wajib diisi'
            );
        }

        const merchant =
            await this.resolveMerchantByUserId(
                merchantUserId
            );

        if (!merchant) {
            throw new Error(
                'Merchant aktif tidak ditemukan'
            );
        }

        await this.assertCustomerExists(
            customerId
        );

        const limit =
            this.normalizeMoney(
                creditLimit,
                'credit_limit'
            );

        const termDays =
            this.normalizeTermDays(
                defaultTermDays
            );

        const dueTime =
            this.normalizeDueTime(
                sameDayDueTime
            );

        const result =
            await this.db.query(
                `
                INSERT INTO tbl_credit_accounts (
                    account_type,
                    customer_id,
                    merchant_id,
                    supplier_id,
                    credit_limit,
                    default_term_days,
                    same_day_due_time,
                    status,
                    notes,
                    approved_by,
                    approved_at
                )
                VALUES (
                    'CUSTOMER',
                    $1,
                    $2,
                    NULL,
                    $3,
                    $4,
                    $5,
                    'ACTIVE',
                    $6,
                    $7,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (
                    customer_id,
                    merchant_id
                )
                WHERE account_type = 'CUSTOMER'
                DO UPDATE SET
                    credit_limit =
                        EXCLUDED.credit_limit,
                    default_term_days =
                        EXCLUDED.default_term_days,
                    same_day_due_time =
                        EXCLUDED.same_day_due_time,
                    notes =
                        EXCLUDED.notes,
                    approved_by =
                        EXCLUDED.approved_by,
                    approved_at =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                RETURNING *
                `,
                [
                    customerId,
                    merchant.id,
                    limit,
                    termDays,
                    dueTime,
                    notes
                        ? String(notes).trim()
                        : null,
                    approvedBy || null
                ]
            );

        return this.getAccountSummary(
            result.rows[0].id
        );
    }

    async upsertSupplierAccount({
        merchantId,
        supplierId,
        creditLimit,
        defaultTermDays = 0,
        sameDayDueTime = null,
        notes = null,
        approvedBy = null
    }) {
        if (!merchantId) {
            throw new Error(
                'merchantId wajib diisi'
            );
        }

        if (!supplierId) {
            throw new Error(
                'supplierId wajib diisi'
            );
        }

        await this.assertMerchantExists(
            merchantId
        );

        await this.assertSupplierExists(
            supplierId
        );

        const limit =
            this.normalizeMoney(
                creditLimit,
                'credit_limit'
            );

        const termDays =
            this.normalizeTermDays(
                defaultTermDays
            );

        const dueTime =
            this.normalizeDueTime(
                sameDayDueTime
            );

        const result =
            await this.db.query(
                `
                INSERT INTO tbl_credit_accounts (
                    account_type,
                    customer_id,
                    merchant_id,
                    supplier_id,
                    credit_limit,
                    default_term_days,
                    same_day_due_time,
                    status,
                    notes,
                    approved_by,
                    approved_at
                )
                VALUES (
                    'SUPPLIER',
                    NULL,
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    'ACTIVE',
                    $6,
                    $7,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (
                    supplier_id,
                    merchant_id
                )
                WHERE account_type = 'SUPPLIER'
                DO UPDATE SET
                    credit_limit =
                        EXCLUDED.credit_limit,
                    default_term_days =
                        EXCLUDED.default_term_days,
                    same_day_due_time =
                        EXCLUDED.same_day_due_time,
                    notes =
                        EXCLUDED.notes,
                    approved_by =
                        EXCLUDED.approved_by,
                    approved_at =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                RETURNING *
                `,
                [
                    merchantId,
                    supplierId,
                    limit,
                    termDays,
                    dueTime,
                    notes
                        ? String(notes).trim()
                        : null,
                    approvedBy || null
                ]
            );

        return this.getAccountSummary(
            result.rows[0].id
        );
    }

    async getAccountSummary(accountId) {
        const result =
            await this.db.query(
                `
                SELECT
                    ca.id,
                    ca.account_type,
                    ca.customer_id,
                    c.full_name
                        AS customer_name,
                    ca.merchant_id,
                    m.store_name,
                    ca.supplier_id,
                    s.supplier_name,
                    ca.credit_limit,
                    ca.default_term_days,
                    ca.same_day_due_time,
                    ca.status,
                    ca.notes,
                    ca.approved_by,
                    ca.approved_at,
                    ca.created_at,
                    ca.updated_at,

                    COALESCE(
                        SUM(
                            CASE
                                WHEN co.status IN (
                                    'OPEN',
                                    'PARTIAL',
                                    'OVERDUE'
                                )
                                THEN
                                    co.principal_amount -
                                    co.paid_amount
                                ELSE 0
                            END
                        ),
                        0
                    )::numeric(18,2)
                        AS outstanding_amount,

                    GREATEST(
                        ca.credit_limit -
                        COALESCE(
                            SUM(
                                CASE
                                    WHEN co.status IN (
                                        'OPEN',
                                        'PARTIAL',
                                        'OVERDUE'
                                    )
                                    THEN
                                        co.principal_amount -
                                        co.paid_amount
                                    ELSE 0
                                END
                            ),
                            0
                        ),
                        0
                    )::numeric(18,2)
                        AS available_credit,

                    COUNT(co.id) FILTER (
                        WHERE co.status IN (
                            'OPEN',
                            'PARTIAL',
                            'OVERDUE'
                        )
                    )::int
                        AS active_obligations,

                    COUNT(co.id) FILTER (
                        WHERE co.status = 'OVERDUE'
                    )::int
                        AS overdue_obligations

                FROM tbl_credit_accounts ca

                JOIN tbl_merchants m
                    ON m.id = ca.merchant_id

                LEFT JOIN tbl_customers c
                    ON c.id = ca.customer_id

                LEFT JOIN tbl_suppliers s
                    ON s.id = ca.supplier_id

                LEFT JOIN tbl_credit_obligations co
                    ON co.credit_account_id = ca.id

                WHERE ca.id = $1

                GROUP BY
                    ca.id,
                    c.full_name,
                    m.store_name,
                    s.supplier_name
                `,
                [accountId]
            );

        return result.rows[0] || null;
    }

    async listCustomerAccountsForMerchant(
        merchantUserId
    ) {
        const merchant =
            await this.resolveMerchantByUserId(
                merchantUserId
            );

        if (!merchant) {
            throw new Error(
                'Merchant aktif tidak ditemukan'
            );
        }

        const result =
            await this.db.query(
                `
                SELECT ca.id
                FROM tbl_credit_accounts ca
                WHERE ca.account_type = 'CUSTOMER'
                  AND ca.merchant_id = $1
                ORDER BY ca.created_at DESC
                `,
                [merchant.id]
            );

        const accounts = [];

        for (const row of result.rows) {
            accounts.push(
                await this.getAccountSummary(
                    row.id
                )
            );
        }

        return {
            merchant,
            accounts
        };
    }

    async listSupplierAccounts() {
        const result =
            await this.db.query(
                `
                SELECT id
                FROM tbl_credit_accounts
                WHERE account_type = 'SUPPLIER'
                ORDER BY created_at DESC
                `
            );

        const accounts = [];

        for (const row of result.rows) {
            accounts.push(
                await this.getAccountSummary(
                    row.id
                )
            );
        }

        return accounts;
    }
}

module.exports = CreditAccountService;
