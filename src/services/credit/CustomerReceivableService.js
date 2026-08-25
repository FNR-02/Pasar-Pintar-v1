class CustomerReceivableService {
    constructor(db) {
        this.db = db;
    }

    normalizeAmount(value) {
        const amount =
            Number(value);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            throw new Error(
                'Jumlah piutang tidak valid'
            );
        }

        return amount;
    }

    /*
     * ========================================================
     * CUSTOMER CREDIT ACCOUNT VALIDATION
     *
     * Account harus:
     * - CUSTOMER
     * - customer sesuai order
     * - merchant sesuai order
     * - ACTIVE
     *
     * forUpdate=true digunakan pada transaction yang akan
     * membuka piutang agar dua transaksi paralel tidak dapat
     * memakai limit yang sama.
     * ========================================================
     */
    async validateCustomerTempo({
        creditAccountId,
        customerId,
        merchantId,
        amount,
        forUpdate = false
    }) {
        if (!creditAccountId) {
            throw new Error(
                'credit_account_id wajib untuk Customer TEMPO'
            );
        }

        if (!customerId) {
            throw new Error(
                'customer_id wajib untuk Customer TEMPO'
            );
        }

        if (!merchantId) {
            throw new Error(
                'merchant_id wajib untuk Customer TEMPO'
            );
        }

        const normalizedAmount =
            this.normalizeAmount(
                amount
            );

        const lock =
            forUpdate
                ? 'FOR UPDATE'
                : '';

        const accountResult =
            await this.db.query(
                `
                SELECT
                    ca.id,
                    ca.account_type,
                    ca.customer_id,
                    ca.merchant_id,
                    ca.credit_limit,
                    ca.default_term_days,
                    ca.same_day_due_time,
                    ca.status
                FROM tbl_credit_accounts ca
                WHERE ca.id = $1
                  AND ca.account_type =
                      'CUSTOMER'
                  AND ca.customer_id = $2
                  AND ca.merchant_id = $3
                ${lock}
                `,
                [
                    creditAccountId,
                    customerId,
                    merchantId
                ]
            );

        if (!accountResult.rowCount) {
            throw new Error(
                'Fasilitas tempo Customer tidak ditemukan'
            );
        }

        const account =
            accountResult.rows[0];

        if (account.status !== 'ACTIVE') {
            throw new Error(
                'Fasilitas tempo Customer tidak ACTIVE'
            );
        }

        const outstandingResult =
            await this.db.query(
                `
                SELECT
                    COALESCE(
                        SUM(
                            principal_amount -
                            paid_amount
                        ),
                        0
                    ) AS outstanding
                FROM tbl_credit_obligations
                WHERE credit_account_id = $1
                  AND status IN (
                      'OPEN',
                      'PARTIAL',
                      'OVERDUE'
                  )
                `,
                [
                    account.id
                ]
            );

        const outstanding =
            Number(
                outstandingResult
                    .rows[0]
                    .outstanding || 0
            );

        const creditLimit =
            Number(
                account.credit_limit || 0
            );

        const availableCredit =
            creditLimit -
            outstanding;

        if (
            normalizedAmount >
            availableCredit
        ) {
            throw new Error(
                'Limit tempo Customer tidak cukup'
            );
        }

        return {
            account,
            amount:
                normalizedAmount,
            outstanding,
            available_credit:
                availableCredit
        };
    }

    /*
     * ========================================================
     * LOAD ORDER FOR CUSTOMER TEMPO
     *
     * Row order dikunci agar aktivasi tempo tidak bisa
     * diproses paralel.
     * ========================================================
     */
    async loadOrderForUpdate(orderId) {
        if (!orderId) {
            throw new Error(
                'order_id wajib'
            );
        }

        const result =
            await this.db.query(
                `
                SELECT
                    id,
                    customer_id,
                    merchant_id,
                    status,
                    total_amount,
                    payment_mode,
                    credit_account_id,
                    tempo_due_at
                FROM tbl_orders_v2
                WHERE id = $1
                FOR UPDATE
                `,
                [
                    orderId
                ]
            );

        if (!result.rowCount) {
            throw new Error(
                'Order tidak ditemukan'
            );
        }

        return result.rows[0];
    }

    /*
     * ========================================================
     * CALCULATE DUE DATE
     *
     * PostgreSQL menghitung tanggal berdasarkan timezone
     * server sehingga mengikuti kontrak Supplier Tempo.
     * ========================================================
     */
    async calculateDueAt(account) {
        const result =
            await this.db.query(
                `
                SELECT
                    (
                        (
                            CURRENT_DATE +
                            $1::integer
                        ) +
                        COALESCE(
                            $2::time,
                            TIME '23:59:59'
                        )
                    )
                    AT TIME ZONE
                        current_setting('TimeZone')
                    AS due_at
                `,
                [
                    Number(
                        account
                            .default_term_days
                    ),
                    account
                        .same_day_due_time
                ]
            );

        const dueAt =
            result.rows[0].due_at;

        if (!dueAt) {
            throw new Error(
                'Gagal menentukan jatuh tempo Customer'
            );
        }

        return dueAt;
    }

    /*
     * ========================================================
     * CUSTOMER TEMPO ACTIVATION
     *
     * Caller wajib mengontrol BEGIN / COMMIT / ROLLBACK.
     *
     * Atomic financial boundary:
     *
     * 1. Lock order
     * 2. Order harus PENDING
     * 3. Order belum boleh memiliki payment PAID
     * 4. Validasi Customer credit account
     * 5. Hitung due_at
     * 6. Snapshot TEMPO contract pada order
     * 7. Buat credit obligation source ORDER
     * 8. Dr 1300 Piutang Usaha
     * 9. Cr 4000 Pendapatan Penjualan
     *
     * Inventory BELUM diproses pada Part 2.
     *
     * TEMPO bukan ORDER_PAID.
     * ========================================================
     */
    async activateOrderTempo({
        orderId,
        creditAccountId
    }) {
        const order =
            await this.loadOrderForUpdate(
                orderId
            );

        /*
         * Replay idempotent.
         *
         * Kalau order sudah TEMPO dengan account yang sama,
         * kembalikan obligation existing.
         */
        if (
            order.payment_mode === 'TEMPO'
        ) {
            if (
                String(
                    order.credit_account_id
                ) !==
                String(
                    creditAccountId
                )
            ) {
                throw new Error(
                    'Order sudah menggunakan fasilitas tempo lain'
                );
            }

            const existing =
                await this.db.query(
                    `
                    SELECT *
                    FROM tbl_credit_obligations
                    WHERE source_type = 'ORDER'
                      AND source_id = $1
                    LIMIT 1
                    `,
                    [
                        order.id
                    ]
                );

            if (!existing.rowCount) {
                throw new Error(
                    'Order TEMPO tidak memiliki piutang'
                );
            }

            return {
                status:
                    'existing',
                order,
                obligation:
                    existing.rows[0],
                ledger_reference:
                    `ORD-${order.id}`
            };
        }

        if (
            order.payment_mode !== 'DIRECT'
        ) {
            throw new Error(
                'Mode pembayaran order tidak valid'
            );
        }

        if (
            order.status !== 'PENDING'
        ) {
            throw new Error(
                'Order harus berstatus PENDING untuk menggunakan TEMPO'
            );
        }

        /*
         * TEMPO tidak boleh ditempel ke order yang sudah
         * memiliki pembayaran PAID.
         */
        const paidPayment =
            await this.db.query(
                `
                SELECT id
                FROM tbl_payments
                WHERE order_id = $1
                  AND payment_status = 'PAID'
                LIMIT 1
                `,
                [
                    order.id
                ]
            );

        if (paidPayment.rowCount) {
            throw new Error(
                'Order sudah memiliki pembayaran PAID'
            );
        }

        /*
         * Existing UNPAID direct payment intent juga tidak
         * boleh hidup berdampingan dengan TEMPO.
         *
         * Kita fail closed dulu daripada mengubah intent
         * pembayaran secara diam-diam.
         */
        const unpaidPayment =
            await this.db.query(
                `
                SELECT id
                FROM tbl_payments
                WHERE order_id = $1
                  AND payment_status = 'UNPAID'
                LIMIT 1
                `,
                [
                    order.id
                ]
            );

        if (unpaidPayment.rowCount) {
            throw new Error(
                'Order masih memiliki pembayaran UNPAID aktif'
            );
        }

        const validation =
            await this.validateCustomerTempo({
                creditAccountId,
                customerId:
                    order.customer_id,
                merchantId:
                    order.merchant_id,
                amount:
                    order.total_amount,
                forUpdate:
                    true
            });

        const account =
            validation.account;

        const dueAt =
            await this.calculateDueAt(
                account
            );

        const updatedOrderResult =
            await this.db.query(
                `
                UPDATE tbl_orders_v2
                SET
                    payment_mode = 'TEMPO',
                    credit_account_id = $2,
                    tempo_due_at = $3
                WHERE id = $1
                  AND status = 'PENDING'
                  AND payment_mode = 'DIRECT'
                RETURNING *
                `,
                [
                    order.id,
                    account.id,
                    dueAt
                ]
            );

        if (!updatedOrderResult.rowCount) {
            throw new Error(
                'Order gagal diubah menjadi TEMPO'
            );
        }

        const updatedOrder =
            updatedOrderResult.rows[0];

        /*
         * uq_credit_obligation_source menjamin satu order
         * hanya memiliki satu obligation.
         */
        const obligationResult =
            await this.db.query(
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
                    $4,
                    'OPEN',
                    $5
                )
                ON CONFLICT (
                    source_type,
                    source_id
                )
                DO NOTHING
                RETURNING *
                `,
                [
                    account.id,
                    order.id,
                    Number(
                        order.total_amount
                    ),
                    dueAt,
                    `Piutang Customer untuk Order ${order.id}`
                ]
            );

        let obligation =
            obligationResult.rows[0];

        if (!obligation) {
            const existing =
                await this.db.query(
                    `
                    SELECT *
                    FROM tbl_credit_obligations
                    WHERE source_type = 'ORDER'
                      AND source_id = $1
                    LIMIT 1
                    `,
                    [
                        order.id
                    ]
                );

            if (!existing.rowCount) {
                throw new Error(
                    'Gagal membuat piutang Customer'
                );
            }

            obligation =
                existing.rows[0];
        }

        const amount =
            Number(
                order.total_amount
            );

        const ledgerRef =
            `ORD-${order.id}`;

        /*
         * Penjualan TEMPO:
         *
         * Dr 1300 Piutang Usaha
         * Cr 4000 Pendapatan Penjualan
         *
         * uq_ledger_reference_account membuat replay aman.
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
                '1300',
                'Piutang Usaha',
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
                ledgerRef,
                amount,
                `Piutang penjualan TEMPO ${ledgerRef}`
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
                '4000',
                'Pendapatan Penjualan',
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
                ledgerRef,
                amount,
                `Pendapatan penjualan TEMPO ${ledgerRef}`
            ]
        );

        return {
            status:
                'created',
            order:
                updatedOrder,
            obligation,
            credit: {
                credit_limit:
                    account.credit_limit,
                outstanding_before_order:
                    validation.outstanding,
                available_credit_before_order:
                    validation.available_credit
            },
            ledger_reference:
                ledgerRef
        };
    }

}

module.exports =
    CustomerReceivableService;
