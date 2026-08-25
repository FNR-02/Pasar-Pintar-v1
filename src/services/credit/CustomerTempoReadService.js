class CustomerTempoReadService {
    constructor(db) {
        this.db = db;
    }

    async resolveCustomerByUserId(userId) {
        const result =
            await this.db.query(
                `
                SELECT
                    id,
                    user_id,
                    full_name,
                    phone
                FROM tbl_customers
                WHERE user_id = $1
                LIMIT 1
                `,
                [userId]
            );

        return result.rows[0] || null;
    }

    async requireCustomer(userId) {
        const customer =
            await this.resolveCustomerByUserId(
                userId
            );

        if (!customer) {
            const err =
                new Error(
                    'Customer tidak ditemukan'
                );

            err.statusCode = 404;
            throw err;
        }

        return customer;
    }

    async listAccountsForCustomer(userId) {
        const customer =
            await this.requireCustomer(
                userId
            );

        const result =
            await this.db.query(
                `
                SELECT
                    ca.id,
                    ca.account_type,
                    ca.customer_id,
                    ca.merchant_id,
                    m.store_name,
                    ca.credit_limit,
                    ca.default_term_days,
                    ca.same_day_due_time,
                    ca.status,
                    ca.notes,
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
                           OR (
                                co.status IN (
                                    'OPEN',
                                    'PARTIAL'
                                )
                                AND co.due_at <
                                    CURRENT_TIMESTAMP
                           )
                    )::int
                        AS overdue_obligations

                FROM tbl_credit_accounts ca

                JOIN tbl_merchants m
                    ON m.id = ca.merchant_id

                LEFT JOIN tbl_credit_obligations co
                    ON co.credit_account_id =
                        ca.id

                WHERE ca.account_type =
                        'CUSTOMER'
                  AND ca.customer_id =
                        $1

                GROUP BY
                    ca.id,
                    m.store_name

                ORDER BY
                    ca.created_at DESC
                `,
                [customer.id]
            );

        return {
            customer,
            accounts:
                result.rows
        };
    }

    async listObligationsForCustomer(
        userId
    ) {
        const customer =
            await this.requireCustomer(
                userId
            );

        const result =
            await this.db.query(
                `
                SELECT
                    co.id,
                    co.credit_account_id,
                    co.source_type,
                    co.source_id,
                    co.principal_amount,
                    co.paid_amount,

                    (
                        co.principal_amount -
                        co.paid_amount
                    )::numeric(18,2)
                        AS remaining_amount,

                    co.due_at,
                    co.status
                        AS stored_status,

                    CASE
                        WHEN co.status IN (
                            'OPEN',
                            'PARTIAL'
                        )
                        AND co.due_at <
                            CURRENT_TIMESTAMP
                        THEN 'OVERDUE'
                        ELSE co.status
                    END
                        AS effective_status,

                    co.description,
                    co.opened_at,
                    co.paid_at,
                    co.created_at,
                    co.updated_at,

                    ca.merchant_id,
                    m.store_name,

                    o.id
                        AS order_id,
                    o.status
                        AS order_status,
                    o.total_amount
                        AS order_total_amount,
                    o.payment_mode,
                    o.fulfillment_type,
                    o.tempo_due_at,
                    o.created_at
                        AS order_created_at

                FROM tbl_credit_obligations co

                JOIN tbl_credit_accounts ca
                    ON ca.id =
                        co.credit_account_id

                JOIN tbl_merchants m
                    ON m.id =
                        ca.merchant_id

                LEFT JOIN tbl_orders_v2 o
                    ON co.source_type =
                        'ORDER'
                   AND o.id =
                        co.source_id

                WHERE ca.account_type =
                        'CUSTOMER'
                  AND ca.customer_id =
                        $1

                ORDER BY
                    CASE
                        WHEN co.status IN (
                            'OPEN',
                            'PARTIAL'
                        )
                        AND co.due_at <
                            CURRENT_TIMESTAMP
                        THEN 0
                        WHEN co.status =
                            'OVERDUE'
                        THEN 0
                        WHEN co.status IN (
                            'OPEN',
                            'PARTIAL'
                        )
                        THEN 1
                        ELSE 2
                    END,
                    co.due_at ASC,
                    co.created_at DESC
                `,
                [customer.id]
            );

        return {
            customer,
            obligations:
                result.rows
        };
    }

    async getObligationForCustomer({
        userId,
        obligationId
    }) {
        const customer =
            await this.requireCustomer(
                userId
            );

        const obligationResult =
            await this.db.query(
                `
                SELECT
                    co.id,
                    co.credit_account_id,
                    co.source_type,
                    co.source_id,
                    co.principal_amount,
                    co.paid_amount,

                    (
                        co.principal_amount -
                        co.paid_amount
                    )::numeric(18,2)
                        AS remaining_amount,

                    co.due_at,
                    co.status
                        AS stored_status,

                    CASE
                        WHEN co.status IN (
                            'OPEN',
                            'PARTIAL'
                        )
                        AND co.due_at <
                            CURRENT_TIMESTAMP
                        THEN 'OVERDUE'
                        ELSE co.status
                    END
                        AS effective_status,

                    co.description,
                    co.opened_at,
                    co.paid_at,
                    co.created_at,
                    co.updated_at,

                    ca.credit_limit,
                    ca.default_term_days,
                    ca.same_day_due_time,
                    ca.status
                        AS credit_account_status,

                    m.id
                        AS merchant_id,
                    m.store_name,

                    o.id
                        AS order_id,
                    o.status
                        AS order_status,
                    o.total_amount
                        AS order_total_amount,
                    o.payment_mode,
                    o.fulfillment_type,
                    o.shipping_address,
                    o.tempo_due_at,
                    o.created_at
                        AS order_created_at

                FROM tbl_credit_obligations co

                JOIN tbl_credit_accounts ca
                    ON ca.id =
                        co.credit_account_id

                JOIN tbl_merchants m
                    ON m.id =
                        ca.merchant_id

                LEFT JOIN tbl_orders_v2 o
                    ON co.source_type =
                        'ORDER'
                   AND o.id =
                        co.source_id

                WHERE co.id = $1
                  AND ca.account_type =
                        'CUSTOMER'
                  AND ca.customer_id =
                        $2

                LIMIT 1
                `,
                [
                    obligationId,
                    customer.id
                ]
            );

        if (!obligationResult.rowCount) {
            const err =
                new Error(
                    'Tagihan Customer tidak ditemukan'
                );

            err.statusCode = 404;
            throw err;
        }

        const obligation =
            obligationResult.rows[0];

        const settlementResult =
            await this.db.query(
                `
                SELECT
                    cs.id,
                    cs.amount,
                    cs.payment_method,
                    cs.reference_number,
                    cs.notes,
                    cs.settled_at,
                    cs.created_at
                FROM tbl_credit_settlements cs
                WHERE cs.obligation_id = $1
                ORDER BY
                    cs.settled_at ASC,
                    cs.created_at ASC
                `,
                [obligation.id]
            );

        return {
            customer,
            obligation,
            settlements:
                settlementResult.rows
        };
    }
}

module.exports =
    CustomerTempoReadService;
