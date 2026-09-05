class GatewaySettlementService {
    constructor(db) {
        this.db = db;
    }

    normalizeProvider(value) {
        return String(value || '')
            .trim()
            .toUpperCase();
    }

    normalizeMethod(value) {
        return String(value || '')
            .trim()
            .toUpperCase();
    }

    assertSupportedPayment(payment) {
        const provider =
            this.normalizeProvider(
                payment.provider
            );

        const method =
            this.normalizeMethod(
                payment.payment_method
            );

        if (provider !== 'MIDTRANS') {
            throw new Error(
                `Provider settlement belum didukung: ${provider || 'EMPTY'}`
            );
        }

        if (
            method !== 'QRIS' &&
            method !== 'VIRTUAL_ACCOUNT'
        ) {
            throw new Error(
                `Metode settlement belum didukung: ${method || 'EMPTY'}`
            );
        }
    }

    async recordSettlement({
        provider,
        settlementReference,
        marketPaymentId,
        amount,
        settlementAt = null,
        createdBy = null,
        reconciliationData = null
    }) {
        const normalizedProvider =
            this.normalizeProvider(provider);

        const normalizedReference =
            String(
                settlementReference || ''
            ).trim();

        const numericAmount =
            Number(amount);

        if (!normalizedProvider) {
            throw new Error(
                'provider wajib'
            );
        }

        if (!normalizedReference) {
            throw new Error(
                'settlement_reference wajib'
            );
        }

        if (!marketPaymentId) {
            throw new Error(
                'market_payment_id wajib'
            );
        }

        if (
            !Number.isFinite(numericAmount) ||
            numericAmount <= 0
        ) {
            throw new Error(
                'amount settlement tidak valid'
            );
        }

        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const paymentResult =
                await client.query(
                    `
                    SELECT
                        mp.id,
                        mp.market_order_id,
                        mp.payment_method,
                        mp.payment_status,
                        mp.amount,
                        mp.provider,
                        mp.external_transaction_id,
                        mo.status AS market_order_status
                    FROM tbl_market_payments mp
                    INNER JOIN tbl_market_orders mo
                      ON mo.id = mp.market_order_id
                    WHERE mp.id = $1
                    FOR UPDATE OF mp, mo
                    `,
                    [marketPaymentId]
                );

            if (!paymentResult.rowCount) {
                throw new Error(
                    'Market payment tidak ditemukan'
                );
            }

            const payment =
                paymentResult.rows[0];

            if (
                payment.payment_status !==
                'PAID'
            ) {
                throw new Error(
                    'Market payment belum PAID'
                );
            }

            if (
                payment.market_order_status !==
                'DELIVERED'
            ) {
                throw new Error(
                    'Market order belum DELIVERED'
                );
            }
            this.assertSupportedPayment(
                payment
            );

            if (
                this.normalizeProvider(
                    payment.provider
                ) !== normalizedProvider
            ) {
                throw new Error(
                    'Provider settlement tidak sesuai dengan market payment'
                );
            }

            const paymentAmount =
                Number(payment.amount);

            if (
                !Number.isFinite(
                    paymentAmount
                ) ||
                paymentAmount !==
                    numericAmount
            ) {
                throw new Error(
                    'Nominal settlement tidak sesuai dengan market payment'
                );
            }

            const allocationResult =
                await client.query(
                    `
                    SELECT
                        a.id,
                        a.settlement_id,
                        a.market_payment_id,
                        a.amount,
                        s.provider,
                        s.settlement_reference,
                        s.status,
                        s.gross_amount
                    FROM tbl_gateway_settlement_allocations a
                    INNER JOIN tbl_gateway_settlements s
                        ON s.id =
                            a.settlement_id
                    WHERE a.market_payment_id = $1
                    FOR UPDATE OF a, s
                    `,
                    [payment.id]
                );

            if (allocationResult.rowCount) {
                const existing =
                    allocationResult.rows[0];

                if (
                    this.normalizeProvider(
                        existing.provider
                    ) ===
                        normalizedProvider &&
                    String(
                        existing
                            .settlement_reference
                    ).trim() ===
                        normalizedReference &&
                    Number(existing.amount) ===
                        numericAmount &&
                    Number(
                        existing.gross_amount
                    ) === numericAmount
                ) {
                    await client.query(
                        'COMMIT'
                    );

                    return {
                        status:
                            'already_recorded',
                        settlement:
                            existing
                    };
                }

                throw new Error(
                    'Market payment sudah dialokasikan ke settlement lain'
                );
            }

            const referenceResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_gateway_settlements
                    WHERE provider = $1
                      AND settlement_reference =
                            $2
                    FOR UPDATE
                    `,
                    [
                        normalizedProvider,
                        normalizedReference
                    ]
                );

            if (referenceResult.rowCount) {
                throw new Error(
                    'Settlement reference sudah digunakan untuk payment lain'
                );
            }

            const settlementResult =
                await client.query(
                    `
                    INSERT INTO tbl_gateway_settlements (
                        provider,
                        settlement_reference,
                        status,
                        gross_amount,
                        settlement_at,
                        reconciliation_data,
                        created_by
                    )
                    VALUES (
                        $1,
                        $2,
                        'RECORDED',
                        $3,
                        $4,
                        $5::jsonb,
                        $6
                    )
                    RETURNING *
                    `,
                    [
                        normalizedProvider,
                        normalizedReference,
                        numericAmount,
                        settlementAt,
                        reconciliationData
                            ? JSON.stringify(
                                reconciliationData
                            )
                            : null,
                        createdBy
                    ]
                );

            const settlement =
                settlementResult.rows[0];

            await client.query(
                `
                INSERT INTO
                    tbl_gateway_settlement_allocations (
                        settlement_id,
                        market_payment_id,
                        amount
                    )
                VALUES (
                    $1,
                    $2,
                    $3
                )
                `,
                [
                    settlement.id,
                    payment.id,
                    numericAmount
                ]
            );

            await client.query('COMMIT');

            return {
                status: 'recorded',
                settlement,
                market_payment_id:
                    payment.id,
                amount:
                    numericAmount
            };
        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            throw err;
        } finally {
            client.release();
        }
    }

    async reconcileSettlement({
        settlementId,
        bankReceivedAmount,
        bankReference,
        evidenceReference,
        reconciledBy,
        settlementAt
    }) {
        if (!settlementId) {
            throw new Error(
                'settlement_id wajib'
            );
        }

        if (!reconciledBy) {
            throw new Error(
                'reconciled_by wajib'
            );
        }

        const normalizedBankReference =
            String(bankReference || '')
                .trim();

        const normalizedEvidenceReference =
            String(evidenceReference || '')
                .trim();

        if (!normalizedBankReference) {
            throw new Error(
                'bank_reference wajib'
            );
        }

        if (!normalizedEvidenceReference) {
            throw new Error(
                'evidence_reference wajib'
            );
        }

        if (!settlementAt) {
            throw new Error(
                'settlement_at wajib'
            );
        }

        const bankAmount =
            Number(bankReceivedAmount);

        if (
            !Number.isFinite(bankAmount) ||
            bankAmount < 0
        ) {
            throw new Error(
                'bank_received_amount tidak valid'
            );
        }

        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const adminResult =
                await client.query(
                    `
                    SELECT
                        id,
                        role_id
                    FROM tbl_users
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [reconciledBy]
                );

            if (!adminResult.rowCount) {
                throw new Error(
                    'User rekonsiliasi tidak ditemukan'
                );
            }

            if (
                Number(
                    adminResult.rows[0].role_id
                ) !== 4
            ) {
                throw new Error(
                    'Rekonsiliasi gateway hanya dapat dilakukan admin'
                );
            }


            const settlementResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_gateway_settlements
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [settlementId]
                );

            if (!settlementResult.rowCount) {
                throw new Error(
                    'Gateway settlement tidak ditemukan'
                );
            }

            const settlement =
                settlementResult.rows[0];

            if (
                settlement.status !==
                    'RECORDED' &&
                settlement.status !==
                    'RECONCILED'
            ) {
                throw new Error(
                    `Gateway settlement tidak dapat direkonsiliasi dari status ${settlement.status}`
                );
            }

            const grossAmount =
                Number(
                    settlement.gross_amount
                );

            if (
                !Number.isFinite(grossAmount) ||
                grossAmount <= 0
            ) {
                throw new Error(
                    'gross_amount settlement tidak valid'
                );
            }

            /*
             * V1 fail-closed:
             * belum ada kebijakan akuntansi
             * untuk selisih/fee gateway.
             */
            if (bankAmount !== grossAmount) {
                throw new Error(
                    'Settlement memiliki selisih yang belum dapat direkonsiliasi'
                );
            }

            const allocationResult =
                await client.query(
                    `
                    SELECT
                        a.id,
                        a.market_payment_id,
                        a.amount
                    FROM
                        tbl_gateway_settlement_allocations a
                    WHERE a.settlement_id = $1
                    ORDER BY a.id
                    FOR UPDATE
                    `,
                    [settlement.id]
                );

            if (!allocationResult.rowCount) {
                throw new Error(
                    'Gateway settlement tidak memiliki allocation'
                );
            }

            const allocatedAmount =
                allocationResult.rows.reduce(
                    (sum, row) =>
                        sum +
                        Number(row.amount),
                    0
                );

            if (
                !Number.isFinite(
                    allocatedAmount
                ) ||
                allocatedAmount !==
                    grossAmount
            ) {
                throw new Error(
                    'Total allocation tidak sesuai gross settlement'
                );
            }

            for (
                const allocation
                of allocationResult.rows
            ) {
                const paymentResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            market_order_id,
                            payment_method,
                            payment_status,
                            amount,
                            provider
                        FROM tbl_market_payments
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [
                            allocation
                                .market_payment_id
                        ]
                    );

                if (!paymentResult.rowCount) {
                    throw new Error(
                        'Market payment allocation tidak ditemukan'
                    );
                }

                const payment =
                    paymentResult.rows[0];

                if (
                    payment.payment_status !==
                    'PAID'
                ) {
                    throw new Error(
                        'Market payment allocation belum PAID'
                    );
                }

                this.assertSupportedPayment(
                    payment
                );

                if (
                    this.normalizeProvider(
                        payment.provider
                    ) !==
                    this.normalizeProvider(
                        settlement.provider
                    )
                ) {
                    throw new Error(
                        'Provider allocation tidak sesuai settlement'
                    );
                }

                if (
                    Number(payment.amount) !==
                    Number(allocation.amount)
                ) {
                    throw new Error(
                        'Nominal allocation tidak sesuai market payment'
                    );
                }
            }

            const entitlementResult =
                await client.query(
                    `
                    SELECT
                        e.id,
                        e.order_id,
                        e.market_order_id,
                        e.merchant_id,
                        e.gross_amount,
                        e.platform_commission,
                        e.merchant_entitlement,
                        e.status
                    FROM tbl_merchant_entitlements e
                    INNER JOIN tbl_orders_v2 o
                        ON o.id = e.order_id
                    INNER JOIN
                        tbl_gateway_settlement_allocations a
                        ON a.settlement_id = $1
                    INNER JOIN tbl_market_payments mp
                        ON mp.id =
                            a.market_payment_id
                       AND mp.market_order_id =
                            o.market_order_id
                    ORDER BY e.id
                    FOR UPDATE OF e
                    `,
                    [settlement.id]
                );

            if (!entitlementResult.rowCount) {
                throw new Error(
                    'Gateway settlement tidak memiliki merchant entitlement'
                );
            }

            const entitlementTotal =
                entitlementResult.rows.reduce(
                    (sum, row) =>
                        sum +
                        Number(
                            row.merchant_entitlement
                        ),
                    0
                );

            if (
                !Number.isFinite(
                    entitlementTotal
                ) ||
                entitlementTotal !==
                    grossAmount
            ) {
                throw new Error(
                    'Total entitlement tidak sesuai gross settlement'
                );
            }

            for (
                const entitlement
                of entitlementResult.rows
            ) {
                if (
                    Number(
                        entitlement
                            .platform_commission
                    ) !== 0
                ) {
                    throw new Error(
                        'Platform commission marketplace harus 0'
                    );
                }

                if (
                    Number(
                        entitlement.gross_amount
                    ) !==
                    Number(
                        entitlement
                            .merchant_entitlement
                    )
                ) {
                    throw new Error(
                        'Merchant entitlement tidak sama dengan gross amount'
                    );
                }

                if (
                    entitlement.status !==
                        'PENDING' &&
                    entitlement.status !==
                        'AVAILABLE'
                ) {
                    throw new Error(
                        `Merchant entitlement tidak dapat direkonsiliasi dari status ${entitlement.status}`
                    );
                }
            }


            if (
                settlement.status ===
                'RECONCILED'
            ) {
                const same =
                    Number(
                        settlement
                            .bank_received_amount
                    ) === bankAmount &&
                    Number(
                        settlement
                            .unresolved_amount
                    ) === 0 &&
                    String(
                        settlement.bank_reference ||
                        ''
                    ).trim() ===
                        normalizedBankReference &&
                    String(
                        settlement.evidence_reference ||
                        ''
                    ).trim() ===
                        normalizedEvidenceReference;

                if (!same) {
                    throw new Error(
                        'Gateway settlement sudah direkonsiliasi dengan data berbeda'
                    );
                }

                await client.query('COMMIT');

                return {
                    status:
                        'already_reconciled',
                    settlement
                };
            }

            const ledgerRef =
                `GSET-${settlement.id}`;

            const existingLedger =
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
                    FOR UPDATE
                    `,
                    [ledgerRef]
                );

            if (existingLedger.rowCount) {
                throw new Error(
                    'Ledger gateway settlement sudah ada sebelum status RECONCILED'
                );
            }

            await client.query(
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
                    $2,
                    0,
                    $3
                )
                `,
                [
                    ledgerRef,
                    bankAmount,
                    `Penerimaan settlement gateway ${settlement.settlement_reference}`
                ]
            );

            await client.query(
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
                    '1400',
                    'Dana di Payment Gateway',
                    0,
                    $2,
                    $3
                )
                `,
                [
                    ledgerRef,
                    grossAmount,
                    `Reklasifikasi dana gateway ${settlement.settlement_reference}`
                ]
            );

            const entitlementUpdate =
                await client.query(
                    `
                    UPDATE tbl_merchant_entitlements
                    SET
                        status = 'AVAILABLE',
                        available_at =
                            CURRENT_TIMESTAMP
                    WHERE id = ANY($1::uuid[])
                      AND status = 'PENDING'
                    RETURNING id
                    `,
                    [
                        entitlementResult.rows.map(
                            row => row.id
                        )
                    ]
                );

            const expectedPending =
                entitlementResult.rows.filter(
                    row =>
                        row.status ===
                        'PENDING'
                ).length;

            if (
                entitlementUpdate.rowCount !==
                expectedPending
            ) {
                throw new Error(
                    'Merchant entitlement berubah secara bersamaan'
                );
            }

            const updatedSettlement =
                await client.query(
                    `
                    UPDATE tbl_gateway_settlements
                    SET
                        status = 'RECONCILED',
                        bank_received_amount =
                            $2,
                        unresolved_amount = 0,
                        settlement_at = $3,
                        bank_reference = $4,
                        evidence_reference = $5,
                        reconciled_by = $6,
                        reconciled_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'RECORDED'
                    RETURNING *
                    `,
                    [
                        settlement.id,
                        bankAmount,
                        settlementAt,
                        normalizedBankReference,
                        normalizedEvidenceReference,
                        reconciledBy
                    ]
                );

            if (
                updatedSettlement.rowCount !== 1
            ) {
                throw new Error(
                    'Gateway settlement berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                status: 'reconciled',
                settlement:
                    updatedSettlement.rows[0],
                ledger_reference:
                    ledgerRef,
                entitlement_available:
                    entitlementUpdate.rowCount
            };
        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            throw err;
        } finally {
            client.release();
        }
    }

}

module.exports =
    GatewaySettlementService;
