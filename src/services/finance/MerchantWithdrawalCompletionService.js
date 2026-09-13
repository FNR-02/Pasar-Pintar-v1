class MerchantWithdrawalCompletionService {
    constructor(pool) {
        this.pool = pool;
    }

    async complete({
        withdrawalId,
        payoutReference,
        evidenceReference,
        payoutAt,
        confirmedBy
    }) {
        const normalizedWithdrawalId =
            String(withdrawalId || '').trim();

        const normalizedPayoutReference =
            String(payoutReference || '').trim();

        const normalizedEvidenceReference =
            String(evidenceReference || '').trim();

        const parsedPayoutAt =
            Date.parse(
                String(payoutAt || '')
            );

        const maxFuturePayoutAt =
            Date.now() +
            (5 * 60 * 1000);

        if (
            !normalizedWithdrawalId ||
            !normalizedPayoutReference ||
            normalizedPayoutReference.length > 150 ||
            !normalizedEvidenceReference ||
            !Number.isFinite(parsedPayoutAt) ||
            parsedPayoutAt > maxFuturePayoutAt ||
            !confirmedBy
        ) {
            return {
                status: 'invalid_input'
            };
        }

        const normalizedPayoutAt =
            new Date(
                parsedPayoutAt
            ).toISOString();

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const adminResult =
                await client.query(
                    `
                    SELECT id, role_id
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

            /*
             * Ambil merchant_id tanpa lock terlebih dahulu.
             *
             * Setelah itu lock order wajib:
             *   merchant
             *   -> withdrawal request
             *   -> entitlement
             *   -> withdrawal allocation
             *
             * Status withdrawal selalu direvalidasi setelah
             * row request benar-benar terkunci.
             */
            const requestLookupResult =
                await client.query(
                    `
                    SELECT
                        id,
                        merchant_id
                    FROM
                        tbl_merchant_withdrawal_requests
                    WHERE id = $1
                    `,
                    [normalizedWithdrawalId]
                );

            if (!requestLookupResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'withdrawal_not_found'
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
                    [
                        requestLookupResult
                            .rows[0]
                            .merchant_id
                    ]
                );

            if (!merchantResult.rowCount) {
                throw new Error(
                    'Withdrawal merchant tidak ditemukan'
                );
            }

            const merchant =
                merchantResult.rows[0];

            const requestResult =
                await client.query(
                    `
                    SELECT *
                    FROM
                        tbl_merchant_withdrawal_requests
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [normalizedWithdrawalId]
                );

            if (!requestResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'withdrawal_not_found'
                };
            }

            const withdrawal =
                requestResult.rows[0];

            /*
             * Pastikan lookup awal masih menunjuk merchant
             * yang sama setelah request terkunci.
             */
            if (
                withdrawal.merchant_id !==
                merchant.id
            ) {
                throw new Error(
                    'Withdrawal merchant berubah saat locking'
                );
            }

            if (
                withdrawal.status ===
                    'COMPLETED' &&
                withdrawal.payout_id
            ) {
                const existingPayout =
                    await client.query(
                        `
                        SELECT *
                        FROM tbl_merchant_payouts
                        WHERE id = $1
                        `,
                        [withdrawal.payout_id]
                    );

                await client.query('COMMIT');

                return {
                    status:
                        'idempotent_replay',
                    withdrawal,
                    payout:
                        existingPayout.rows[0] ||
                        null
                };
            }

            if (
                withdrawal.status !==
                'REQUESTED'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'withdrawal_not_requested',
                    current_status:
                        withdrawal.status
                };
            }

            if (merchant.status !== 'ACTIVE') {
                await client.query('ROLLBACK');

                return {
                    status:
                        'merchant_not_active'
                };
            }

            /*
             * Ambil ID allocation dahulu.
             * Lock entitlement selalu sebelum
             * withdrawal allocation, sama dengan
             * MerchantPayoutService.
             */
            const allocationIdsResult =
                await client.query(
                    `
                    SELECT entitlement_id
                    FROM
                        tbl_merchant_withdrawal_allocations
                    WHERE
                        withdrawal_request_id = $1
                      AND status = 'RESERVED'
                    ORDER BY entitlement_id
                    `,
                    [withdrawal.id]
                );

            if (!allocationIdsResult.rowCount) {
                throw new Error(
                    'Withdrawal tidak memiliki RESERVED allocation'
                );
            }

            const entitlementIds =
                allocationIdsResult.rows.map(
                    row => row.entitlement_id
                );

            const entitlementResult =
                await client.query(
                    `
                    SELECT
                        id,
                        merchant_id,
                        merchant_entitlement,
                        status
                    FROM
                        tbl_merchant_entitlements
                    WHERE id =
                        ANY($1::uuid[])
                    ORDER BY id
                    FOR UPDATE
                    `,
                    [entitlementIds]
                );

            if (
                entitlementResult.rowCount !==
                entitlementIds.length
            ) {
                throw new Error(
                    'Withdrawal entitlement tidak lengkap'
                );
            }

            const allocationResult =
                await client.query(
                    `
                    SELECT
                        id,
                        entitlement_id,
                        gross_amount,
                        adjustment_amount,
                        payout_amount,
                        status
                    FROM
                        tbl_merchant_withdrawal_allocations
                    WHERE
                        withdrawal_request_id = $1
                      AND status = 'RESERVED'
                    ORDER BY entitlement_id
                    FOR UPDATE
                    `,
                    [withdrawal.id]
                );

            if (
                allocationResult.rowCount !==
                entitlementIds.length
            ) {
                throw new Error(
                    'Withdrawal reservation berubah saat completion'
                );
            }

            const entitlementById =
                new Map(
                    entitlementResult.rows.map(
                        row => [row.id, row]
                    )
                );

            for (
                const allocation
                of allocationResult.rows
            ) {
                const entitlement =
                    entitlementById.get(
                        allocation.entitlement_id
                    );

                if (
                    !entitlement ||
                    entitlement.merchant_id !==
                        merchant.id ||
                    entitlement.status !==
                        'AVAILABLE'
                ) {
                    throw new Error(
                        'Reserved entitlement tidak lagi AVAILABLE'
                    );
                }
            }

            /*
             * Adjustment harus sama dengan snapshot saat request.
             * Jika refund/adjustment berubah setelah request,
             * completion dibatalkan agar nominal tidak salah.
             */
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
                    [entitlementIds]
                );

            const adjustmentById =
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

            let grossEntitlement = 0;
            let adjustmentAmount = 0;
            let payoutAmount = 0;

            for (
                const allocation
                of allocationResult.rows
            ) {
                const currentAdjustment =
                    adjustmentById.get(
                        allocation.entitlement_id
                    ) || 0;

                const reservedAdjustment =
                    Number(
                        allocation.adjustment_amount
                    );

                if (
                    !Number.isFinite(
                        currentAdjustment
                    ) ||
                    currentAdjustment !==
                        reservedAdjustment
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return {
                        status:
                            'adjustment_changed',
                        entitlement_id:
                            allocation
                                .entitlement_id
                    };
                }

                grossEntitlement +=
                    Number(
                        allocation.gross_amount
                    );

                adjustmentAmount +=
                    reservedAdjustment;

                payoutAmount +=
                    Number(
                        allocation.payout_amount
                    );
            }

            if (
                payoutAmount <= 0 ||
                payoutAmount !==
                    Number(
                        withdrawal
                            .requested_amount
                    )
            ) {
                throw new Error(
                    'Withdrawal payout amount invariant invalid'
                );
            }

            /*
             * Database unique constraint pada
             * payout_reference menjadi pagar replay/reference.
             */
            const referenceResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_merchant_payouts
                    WHERE payout_reference = $1
                    FOR UPDATE
                    `,
                    [normalizedPayoutReference]
                );

            if (referenceResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'payout_reference_used'
                };
            }

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
                        normalizedPayoutAt,
                        confirmedBy
                    ]
                );

            const payout =
                payoutResult.rows[0];

            for (
                const allocation
                of allocationResult.rows
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
                        $1, $2, $3, $4, $5
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
                    `Pembayaran withdrawal merchant ${merchant.store_name}`
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
                    `Kas keluar withdrawal merchant ${merchant.store_name}`
                ]
            );

            const settledEntitlementResult =
                await client.query(
                    `
                    UPDATE
                        tbl_merchant_entitlements
                    SET
                        status = 'SETTLED',
                        settled_at =
                            CURRENT_TIMESTAMP
                    WHERE
                        id = ANY($1::uuid[])
                      AND merchant_id = $2
                      AND status = 'AVAILABLE'
                    RETURNING id
                    `,
                    [
                        entitlementIds,
                        merchant.id
                    ]
                );

            if (
                settledEntitlementResult.rowCount !==
                entitlementIds.length
            ) {
                throw new Error(
                    'Entitlement berubah saat withdrawal completion'
                );
            }

            const settledAllocationResult =
                await client.query(
                    `
                    UPDATE
                        tbl_merchant_withdrawal_allocations
                    SET
                        status = 'SETTLED',
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE
                        withdrawal_request_id = $1
                      AND status = 'RESERVED'
                    RETURNING id
                    `,
                    [withdrawal.id]
                );

            if (
                settledAllocationResult.rowCount !==
                entitlementIds.length
            ) {
                throw new Error(
                    'Withdrawal allocation gagal SETTLED'
                );
            }

            const completedRequestResult =
                await client.query(
                    `
                    UPDATE
                        tbl_merchant_withdrawal_requests
                    SET
                        status = 'COMPLETED',
                        payout_id = $2,
                        reviewed_by = $3,
                        reviewed_at =
                            CURRENT_TIMESTAMP,
                        rejection_reason = NULL,
                        completed_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE
                        id = $1
                      AND status = 'REQUESTED'
                    RETURNING *
                    `,
                    [
                        withdrawal.id,
                        payout.id,
                        confirmedBy
                    ]
                );

            if (
                !completedRequestResult.rowCount
            ) {
                throw new Error(
                    'Withdrawal berubah saat completion'
                );
            }

            await client.query('COMMIT');

            return {
                status: 'completed',
                withdrawal:
                    completedRequestResult.rows[0],
                payout,
                merchant: {
                    id: merchant.id,
                    store_name:
                        merchant.store_name
                },
                payout_amount:
                    payoutAmount,
                entitlement_count:
                    entitlementIds.length,
                ledger_reference:
                    ledgerReference
            };
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            if (err.code === '23505') {
                return {
                    status:
                        'finance_conflict'
                };
            }

            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports =
    MerchantWithdrawalCompletionService;
