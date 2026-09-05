class MerchantPayoutService {
    constructor(pool) {
        this.pool = pool;
    }

    async completePayout({
        merchantId,
        entitlementIds,
        payoutReference,
        evidenceReference,
        payoutAt,
        confirmedBy
    }) {
        if (
            !merchantId ||
            !Array.isArray(entitlementIds) ||
            entitlementIds.length === 0 ||
            !String(payoutReference || '').trim() ||
            !String(evidenceReference || '').trim() ||
            !payoutAt ||
            !confirmedBy
        ) {
            return {
                status: 'invalid_input'
            };
        }

        const uniqueIds =
            [...new Set(entitlementIds)];

        if (
            uniqueIds.length !==
            entitlementIds.length
        ) {
            return {
                status:
                    'duplicate_entitlement_input'
            };
        }

        const client =
            await this.pool.connect();

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
                    [confirmedBy]
                );

            if (
                !adminResult.rowCount ||
                Number(
                    adminResult.rows[0].role_id
                ) !== 4
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'admin_not_authorized'
                };
            }

            const merchantResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name,
                        status
                    FROM tbl_merchants
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [merchantId]
                );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'merchant_not_found'
                };
            }

            const merchant =
                merchantResult.rows[0];

            if (
                String(
                    merchant.status || ''
                ).toUpperCase() !== 'ACTIVE'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'merchant_not_active',
                    current_status:
                        merchant.status
                };
            }

            /*
             * Lock entitlement rows terlebih dahulu.
             *
             * Jangan gabungkan FOR UPDATE dengan
             * aggregate/GROUP BY karena PostgreSQL
             * tidak mengizinkannya.
             */
            const entitlementResult =
                await client.query(
                    `
                    SELECT
                        e.id,
                        e.merchant_id,
                        e.order_id,
                        e.market_order_id,
                        e.merchant_entitlement,
                        e.platform_commission,
                        e.status
                    FROM tbl_merchant_entitlements e
                    WHERE e.id =
                        ANY($1::uuid[])
                    ORDER BY e.id
                    FOR UPDATE
                    `,
                    [uniqueIds]
                );

            const adjustmentResult =
                await client.query(
                    `
                    SELECT
                        entitlement_id,
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS adjustment_amount
                    FROM
                        tbl_merchant_entitlement_adjustments
                    WHERE entitlement_id =
                        ANY($1::uuid[])
                    GROUP BY entitlement_id
                    `,
                    [uniqueIds]
                );

            const adjustmentByEntitlement =
                new Map(
                    adjustmentResult.rows.map(
                        row => [
                            row.entitlement_id,
                            Number(
                                row.adjustment_amount
                            )
                        ]
                    )
                );

            for (
                const entitlement
                of entitlementResult.rows
            ) {
                entitlement.adjustment_amount =
                    adjustmentByEntitlement.get(
                        entitlement.id
                    ) || 0;
            }

            if (
                entitlementResult.rowCount !==
                uniqueIds.length
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'entitlement_not_found'
                };
            }

            let grossEntitlement = 0;
            let adjustmentAmount = 0;
            let payoutAmount = 0;

            const allocations = [];

            for (
                const entitlement
                of entitlementResult.rows
            ) {
                if (
                    entitlement.merchant_id !==
                    merchantId
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return {
                        status:
                            'entitlement_merchant_mismatch'
                    };
                }

                if (
                    entitlement.status !==
                    'AVAILABLE'
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return {
                        status:
                            'entitlement_not_available',
                        entitlement_id:
                            entitlement.id,
                        current_status:
                            entitlement.status
                    };
                }

                const gross =
                    Number(
                        entitlement
                            .merchant_entitlement
                    );

                const commission =
                    Number(
                        entitlement
                            .platform_commission
                    );

                const adjusted =
                    Number(
                        entitlement
                            .adjustment_amount
                    );

                if (
                    !Number.isFinite(gross) ||
                    !Number.isFinite(commission) ||
                    !Number.isFinite(adjusted) ||
                    gross <= 0 ||
                    commission !== 0 ||
                    adjusted < 0 ||
                    adjusted > gross
                ) {
                    throw new Error(
                        'Merchant entitlement finance invariant invalid'
                    );
                }

                const net =
                    gross - adjusted;

                if (net <= 0) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return {
                        status:
                            'entitlement_no_payable_balance',
                        entitlement_id:
                            entitlement.id
                    };
                }

                grossEntitlement += gross;
                adjustmentAmount += adjusted;
                payoutAmount += net;

                allocations.push({
                    entitlement_id:
                        entitlement.id,
                    gross_amount:
                        gross,
                    adjustment_amount:
                        adjusted,
                    payout_amount:
                        net
                });
            }

            const existingAllocation =
                await client.query(
                    `
                    SELECT
                        entitlement_id,
                        payout_id
                    FROM
                        tbl_merchant_payout_allocations
                    WHERE entitlement_id =
                        ANY($1::uuid[])
                    FOR UPDATE
                    `,
                    [uniqueIds]
                );

            if (existingAllocation.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'entitlement_already_paid',
                    entitlement_id:
                        existingAllocation
                            .rows[0]
                            .entitlement_id
                };
            }

            const existingReference =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_merchant_payouts
                    WHERE payout_reference = $1
                    FOR UPDATE
                    `,
                    [
                        String(
                            payoutReference
                        ).trim()
                    ]
                );

            if (existingReference.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'payout_reference_used'
                };
            }

            /*
             * Payout V1 hanya dicatat setelah
             * bukti transfer benar-benar tersedia.
             *
             * Seluruh perubahan berikut atomik:
             * - payout header
             * - payout allocations
             * - ledger Dr2200 / Cr1100
             * - AVAILABLE -> SETTLED
             */
            const normalizedPayoutReference =
                String(
                    payoutReference
                ).trim();

            const normalizedEvidenceReference =
                String(
                    evidenceReference
                ).trim();

            const payoutResult =
                await client.query(
                    `
                    INSERT INTO tbl_merchant_payouts (
                        merchant_id,
                        payout_reference,
                        status,
                        gross_entitlement,
                        adjustment_amount,
                        payout_amount,
                        evidence_reference,
                        payout_at,
                        confirmed_by
                    )
                    VALUES (
                        $1,
                        $2,
                        'COMPLETED',
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8
                    )
                    RETURNING *
                    `,
                    [
                        merchant.id,
                        normalizedPayoutReference,
                        grossEntitlement,
                        adjustmentAmount,
                        payoutAmount,
                        normalizedEvidenceReference,
                        payoutAt,
                        confirmedBy
                    ]
                );

            const payout =
                payoutResult.rows[0];

            for (
                const allocation
                of allocations
            ) {
                await client.query(
                    `
                    INSERT INTO
                        tbl_merchant_payout_allocations (
                            payout_id,
                            entitlement_id,
                            gross_amount,
                            adjustment_amount,
                            payout_amount
                        )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5
                    )
                    `,
                    [
                        payout.id,
                        allocation.entitlement_id,
                        allocation.gross_amount,
                        allocation.adjustment_amount,
                        allocation.payout_amount
                    ]
                );
            }

            const ledgerReference =
                `MPAYOUT-${payout.id}`;

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
                    FOR UPDATE
                    `,
                    [ledgerReference]
                );

            if (existingLedger.rowCount) {
                throw new Error(
                    'Merchant payout ledger sudah ada sebelum payout'
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
                    '2200',
                    'Kewajiban kepada Merchant',
                    $2,
                    0,
                    $3
                )
                `,
                [
                    ledgerReference,
                    payoutAmount,
                    `Pembayaran hak merchant ${merchant.store_name}`
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
                    '1100',
                    'Kas & Bank',
                    0,
                    $2,
                    $3
                )
                `,
                [
                    ledgerReference,
                    payoutAmount,
                    `Kas keluar payout merchant ${merchant.store_name}`
                ]
            );

            const settledResult =
                await client.query(
                    `
                    UPDATE tbl_merchant_entitlements
                    SET
                        status = 'SETTLED',
                        settled_at =
                            CURRENT_TIMESTAMP
                    WHERE id =
                        ANY($1::uuid[])
                      AND merchant_id = $2
                      AND status = 'AVAILABLE'
                    RETURNING id
                    `,
                    [
                        uniqueIds,
                        merchant.id
                    ]
                );

            if (
                settledResult.rowCount !==
                uniqueIds.length
            ) {
                throw new Error(
                    'Merchant entitlement berubah secara bersamaan saat payout'
                );
            }

            await client.query('COMMIT');

            return {
                status: 'completed',
                payout,
                merchant: {
                    id: merchant.id,
                    store_name:
                        merchant.store_name
                },
                gross_entitlement:
                    grossEntitlement,
                adjustment_amount:
                    adjustmentAmount,
                payout_amount:
                    payoutAmount,
                ledger_reference:
                    ledgerReference,
                entitlement_settled:
                    settledResult.rowCount,
                allocations
            };
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = MerchantPayoutService;
