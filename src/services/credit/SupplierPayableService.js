class SupplierPayableService {
    constructor(db) {
        this.db = db;
    }

    normalizeAmount(value) {
        const amount = Number(value);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            throw new Error(
                'amount harus lebih besar dari 0'
            );
        }

        return amount;
    }

    normalizeMethod(value) {
        const method =
            String(value || '')
                .trim()
                .toUpperCase();

        const allowed = [
            'CASH',
            'BANK_TRANSFER',
            'QRIS',
            'OTHER'
        ];

        if (!allowed.includes(method)) {
            throw new Error(
                'payment_method tidak valid'
            );
        }

        return method;
    }

    normalizeIdempotencyKey(value) {
        const key =
            String(value || '').trim();

        if (!key) {
            throw new Error(
                'idempotency_key wajib diisi'
            );
        }

        if (key.length > 120) {
            throw new Error(
                'idempotency_key terlalu panjang'
            );
        }

        return key;
    }

    /*
     * ========================================================
     * JOURNAL PO TEMPO
     *
     * Dr 1200 Persediaan
     * Cr 2100 Utang Usaha
     *
     * Harus dipanggil menggunakan transaction client yang
     * sama dengan receiving PO.
     * ========================================================
     */
    async recordTempoPurchaseReceipt({
        purchaseOrderId
    }) {
        if (!purchaseOrderId) {
            throw new Error(
                'purchaseOrderId wajib diisi'
            );
        }

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
                LIMIT 1
                `,
                [purchaseOrderId]
            );

        if (!poResult.rowCount) {
            throw new Error(
                'Purchase Order tidak ditemukan'
            );
        }

        const po = poResult.rows[0];

        if (
            String(
                po.payment_mode || ''
            ).toUpperCase() !== 'TEMPO'
        ) {
            throw new Error(
                'Purchase Order bukan TEMPO'
            );
        }

        if (!po.credit_account_id) {
            throw new Error(
                'PO TEMPO tidak memiliki credit_account_id'
            );
        }

        const amount =
            this.normalizeAmount(
                po.total_amount
            );

        const ref =
            `PO-${po.id}`;

        /*
         * Idempotency juga dijaga oleh:
         * uq_ledger_reference_account
         */
        await this.db.query(
            `
            INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
            )
            VALUES (
                $1,
                '1200',
                'Persediaan',
                $2,
                0,
                $3
            )
            ON CONFLICT (
                transaction_reference,
                account_code
            )
            DO NOTHING
            `,
            [
                ref,
                amount,
                `Penerimaan persediaan PO TEMPO ${ref}`
            ]
        );

        await this.db.query(
            `
            INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
            )
            VALUES (
                $1,
                '2100',
                'Utang Usaha',
                0,
                $2,
                $3
            )
            ON CONFLICT (
                transaction_reference,
                account_code
            )
            DO NOTHING
            `,
            [
                ref,
                amount,
                `Utang Supplier dari PO TEMPO ${ref}`
            ]
        );

        return {
            transaction_reference:
                ref,
            amount
        };
    }

    /*
     * ========================================================
     * SETTLEMENT UTANG SUPPLIER
     *
     * Atomic boundary:
     *
     * 1. Lock obligation.
     * 2. Validasi Supplier credit account.
     * 3. Insert settlement idempotent.
     * 4. Update paid_amount + status.
     * 5. Dr 2100 Utang Usaha.
     * 6. Cr 1100 Kas & Bank.
     *
     * Caller mengontrol BEGIN / COMMIT.
     * ========================================================
     */
    async settleSupplierObligation({
        obligationId,
        amount,
        paymentMethod,
        idempotencyKey,
        referenceNumber = null,
        notes = null,
        receivedBy = null
    }) {
        if (!obligationId) {
            throw new Error(
                'obligationId wajib diisi'
            );
        }

        const normalizedAmount =
            this.normalizeAmount(
                amount
            );

        const normalizedMethod =
            this.normalizeMethod(
                paymentMethod
            );

        const normalizedKey =
            this.normalizeIdempotencyKey(
                idempotencyKey
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
                    co.due_at,
                    co.status,
                    co.paid_at,
                    ca.account_type,
                    ca.merchant_id,
                    ca.supplier_id,
                    ca.status AS account_status
                FROM tbl_credit_obligations co
                JOIN tbl_credit_accounts ca
                    ON ca.id =
                        co.credit_account_id
                WHERE co.id = $1
                FOR UPDATE
                `,
                [obligationId]
            );

        if (!obligationResult.rowCount) {
            throw new Error(
                'Kewajiban kredit tidak ditemukan'
            );
        }

        const obligation =
            obligationResult.rows[0];

        if (
            obligation.account_type !==
            'SUPPLIER'
        ) {
            throw new Error(
                'Kewajiban bukan utang Supplier'
            );
        }

        if (
            obligation.account_status !==
            'ACTIVE'
        ) {
            throw new Error(
                'Credit account Supplier tidak ACTIVE'
            );
        }

        if (
            obligation.status ===
            'CANCELLED'
        ) {
            throw new Error(
                'Kewajiban sudah CANCELLED'
            );
        }

        /*
         * Retry harus diperiksa SEBELUM menolak status PAID.
         */
        const existingResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_credit_settlements
                WHERE obligation_id = $1
                  AND idempotency_key = $2
                LIMIT 1
                `,
                [
                    obligation.id,
                    normalizedKey
                ]
            );

        if (existingResult.rowCount) {
            return {
                status:
                    'existing',
                settlement:
                    existingResult.rows[0],
                obligation
            };
        }

        if (
            obligation.status === 'PAID'
        ) {
            throw new Error(
                'Kewajiban sudah lunas'
            );
        }

        const principal =
            Number(
                obligation.principal_amount
            );

        const alreadyPaid =
            Number(
                obligation.paid_amount || 0
            );

        const outstanding =
            principal - alreadyPaid;

        if (
            normalizedAmount >
            outstanding
        ) {
            throw new Error(
                'Jumlah pembayaran melebihi sisa utang'
            );
        }

        const settlementResult =
            await this.db.query(
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
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7
                )
                RETURNING *
                `,
                [
                    obligation.id,
                    normalizedAmount,
                    normalizedMethod,
                    referenceNumber,
                    notes,
                    receivedBy,
                    normalizedKey
                ]
            );

        const settlement =
            settlementResult.rows[0];

        const newPaid =
            alreadyPaid +
            normalizedAmount;

        const fullyPaid =
            newPaid >= principal;

        const updatedResult =
            await this.db.query(
                `
                UPDATE tbl_credit_obligations
                SET
                    paid_amount = $2,
                    status = $3::varchar,
                    paid_at =
                        CASE
                            WHEN $3::varchar = 'PAID'
                            THEN CURRENT_TIMESTAMP
                            ELSE NULL
                        END,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING *
                `,
                [
                    obligation.id,
                    newPaid,
                    fullyPaid
                        ? 'PAID'
                        : 'PARTIAL'
                ]
            );

        const updatedObligation =
            updatedResult.rows[0];

        const ledgerRef =
            `CSET-${settlement.id}`;

        await this.db.query(
            `
            INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
            )
            VALUES (
                $1,
                '2100',
                'Utang Usaha',
                $2,
                0,
                $3
            )
            `,
            [
                ledgerRef,
                normalizedAmount,
                `Pembayaran utang Supplier ${obligation.id}`
            ]
        );

        await this.db.query(
            `
            INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
            )
            VALUES (
                $1,
                '1100',
                'Kas & Bank',
                0,
                $2,
                $3
            )
            `,
            [
                ledgerRef,
                normalizedAmount,
                `Kas keluar pembayaran utang Supplier ${obligation.id}`
            ]
        );

        return {
            status:
                'created',
            settlement,
            obligation:
                updatedObligation,
            ledger_reference:
                ledgerRef
        };
    }
}

module.exports =
    SupplierPayableService;
