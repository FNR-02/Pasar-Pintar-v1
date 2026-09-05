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
                        id,
                        market_order_id,
                        payment_method,
                        payment_status,
                        amount,
                        provider,
                        external_transaction_id
                    FROM tbl_market_payments
                    WHERE id = $1
                    FOR UPDATE
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
}

module.exports =
    GatewaySettlementService;
