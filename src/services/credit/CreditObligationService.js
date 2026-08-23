class CreditObligationService {
    constructor(db) {
        this.db = db;
    }

    normalizeAmount(value, fieldName) {
        const amount = Number(value);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            throw new Error(
                `${fieldName} harus lebih besar dari 0`
            );
        }

        return amount;
    }

    async getSupplierCreditAccount(
        {
            creditAccountId,
            merchantId,
            supplierId,
            forUpdate = false
        }
    ) {
        const lock =
            forUpdate
                ? 'FOR UPDATE'
                : '';

        const result =
            await this.db.query(
                `
                SELECT
                    ca.id,
                    ca.account_type,
                    ca.merchant_id,
                    ca.supplier_id,
                    ca.credit_limit,
                    ca.default_term_days,
                    ca.same_day_due_time,
                    ca.status,
                    ca.notes,
                    ca.approved_at
                FROM tbl_credit_accounts ca
                WHERE ca.id = $1
                  AND ca.account_type = 'SUPPLIER'
                  AND ca.merchant_id = $2
                  AND ca.supplier_id = $3
                LIMIT 1
                ${lock}
                `,
                [
                    creditAccountId,
                    merchantId,
                    supplierId
                ]
            );

        return result.rows[0] || null;
    }

    async calculateOutstanding(
        creditAccountId
    ) {
        const result =
            await this.db.query(
                `
                SELECT
                    COALESCE(
                        SUM(
                            principal_amount -
                            paid_amount
                        ),
                        0
                    )::numeric
                        AS outstanding_amount
                FROM tbl_credit_obligations
                WHERE credit_account_id = $1
                  AND status IN (
                      'OPEN',
                      'PARTIAL',
                      'OVERDUE'
                  )
                `,
                [creditAccountId]
            );

        return Number(
            result.rows[0]
                .outstanding_amount || 0
        );
    }

    async validateSupplierTempo({
        creditAccountId,
        merchantId,
        supplierId,
        amount,
        forUpdate = false
    }) {
        const principal =
            this.normalizeAmount(
                amount,
                'amount'
            );

        const account =
            await this.getSupplierCreditAccount({
                creditAccountId,
                merchantId,
                supplierId,
                forUpdate
            });

        if (!account) {
            throw new Error(
                'Fasilitas tempo Supplier tidak ditemukan untuk Merchant ini'
            );
        }

        if (
            String(account.status)
                .toUpperCase() !== 'ACTIVE'
        ) {
            throw new Error(
                'Fasilitas tempo Supplier tidak ACTIVE'
            );
        }

        const outstanding =
            await this.calculateOutstanding(
                account.id
            );

        const limit =
            Number(account.credit_limit || 0);

        const availableCredit =
            Math.max(
                limit - outstanding,
                0
            );

        if (principal > availableCredit) {
            throw new Error(
                'LIMIT_TEMPO_TIDAK_CUKUP: ' +
                `limit=${limit}, ` +
                `outstanding=${outstanding}, ` +
                `available=${availableCredit}, ` +
                `requested=${principal}`
            );
        }

        return {
            account,
            principal,
            outstanding,
            available_credit:
                availableCredit
        };
    }

    async openPurchaseOrderObligation({
        purchaseOrderId
    }) {
        if (!purchaseOrderId) {
            throw new Error(
                'purchaseOrderId wajib diisi'
            );
        }

        /*
         * Method ini sengaja tidak BEGIN/COMMIT sendiri.
         *
         * Caller dapat memberikan pg Client sebagai this.db
         * sehingga obligation menjadi bagian dari transaksi
         * receiving Purchase Order.
         */

        const poResult =
            await this.db.query(
                `
                SELECT
                    po.id,
                    po.status,
                    po.merchant_id,
                    po.supplier_id,
                    po.total_amount,
                    po.payment_mode,
                    po.credit_account_id,
                    po.tempo_due_at
                FROM tbl_purchase_orders po
                WHERE po.id = $1
                FOR UPDATE
                `,
                [purchaseOrderId]
            );

        if (!poResult.rowCount) {
            throw new Error(
                'Purchase Order tidak ditemukan'
            );
        }

        const po =
            poResult.rows[0];

        if (
            String(po.payment_mode)
                .toUpperCase() !== 'TEMPO'
        ) {
            return {
                status: 'not_tempo',
                obligation: null
            };
        }

        if (!po.credit_account_id) {
            throw new Error(
                'PO TEMPO tidak memiliki credit_account_id'
            );
        }

        if (!po.tempo_due_at) {
            throw new Error(
                'PO TEMPO tidak memiliki tempo_due_at'
            );
        }

        const validation =
            await this.validateSupplierTempo({
                creditAccountId:
                    po.credit_account_id,
                merchantId:
                    po.merchant_id,
                supplierId:
                    po.supplier_id,
                amount:
                    po.total_amount,
                forUpdate: true
            });

        /*
         * source_type + source_id memiliki UNIQUE INDEX.
         * Replay receiving tidak boleh membuat utang kedua.
         */
        const existing =
            await this.db.query(
                `
                SELECT *
                FROM tbl_credit_obligations
                WHERE source_type =
                    'PURCHASE_ORDER'
                  AND source_id = $1
                LIMIT 1
                `,
                [po.id]
            );

        if (existing.rowCount) {
            return {
                status: 'existing',
                obligation:
                    existing.rows[0],
                credit:
                    validation
            };
        }

        const obligationResult =
            await this.db.query(
                `
                INSERT INTO
                    tbl_credit_obligations (
                        credit_account_id,
                        source_type,
                        source_id,
                        principal_amount,
                        paid_amount,
                        due_at,
                        status,
                        description,
                        opened_at,
                        created_at,
                        updated_at
                    )
                VALUES (
                    $1,
                    'PURCHASE_ORDER',
                    $2,
                    $3,
                    0,
                    $4,
                    'OPEN',
                    $5,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (
                    source_type,
                    source_id
                )
                DO NOTHING
                RETURNING *
                `,
                [
                    po.credit_account_id,
                    po.id,
                    validation.principal,
                    po.tempo_due_at,
                    `Utang Supplier untuk Purchase Order ${po.id}`
                ]
            );

        if (!obligationResult.rowCount) {
            const replay =
                await this.db.query(
                    `
                    SELECT *
                    FROM tbl_credit_obligations
                    WHERE source_type =
                        'PURCHASE_ORDER'
                      AND source_id = $1
                    LIMIT 1
                    `,
                    [po.id]
                );

            return {
                status: 'existing',
                obligation:
                    replay.rows[0] || null,
                credit:
                    validation
            };
        }

        return {
            status: 'created',
            obligation:
                obligationResult.rows[0],
            credit:
                validation
        };
    }
}

module.exports =
    CreditObligationService;
