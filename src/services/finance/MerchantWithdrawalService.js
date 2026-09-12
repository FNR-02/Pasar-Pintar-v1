class MerchantWithdrawalService {
    constructor(pool) {
        this.pool = pool;
    }

    /*
     * ============================================================
     * MERCHANT WITHDRAWAL REQUEST V1
     *
     * V1 policy:
     * - merchant tidak mengirim nominal
     * - server mengambil seluruh entitlement AVAILABLE
     * - entitlement yang sudah RESERVED tidak boleh dipakai
     * - rekening wajib VERIFIED
     * - nilai payout dihitung server
     * - entitlement utama tetap AVAILABLE sampai payout selesai
     *
     * Lock order harus konsisten dengan MerchantPayoutService:
     *   1. merchant / payout account
     *   2. entitlement FOR UPDATE
     *   3. withdrawal allocation FOR UPDATE
     * ============================================================
     */
    async createRequest({
        userId,
        idempotencyKey
    }) {
        const normalizedKey =
            String(idempotencyKey || '').trim();

        if (
            !userId ||
            !normalizedKey ||
            normalizedKey.length > 100
        ) {
            return {
                status: 'invalid_input'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Merchant identity berasal dari token user.
             * Client tidak pernah memilih merchant_id sendiri.
             */
            const merchantResult =
                await client.query(
                    `
                    SELECT
                        id,
                        user_id,
                        store_name,
                        status
                    FROM tbl_merchants
                    WHERE user_id = $1
                    ORDER BY
                        created_at DESC NULLS LAST,
                        id
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [userId]
                );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'merchant_not_found'
                };
            }

            const merchant =
                merchantResult.rows[0];

            if (merchant.status !== 'ACTIVE') {
                await client.query('ROLLBACK');

                return {
                    status: 'merchant_not_active'
                };
            }

            /*
             * Idempotency replay.
             *
             * Request yang sama tidak boleh membuat reservation
             * kedua.
             */
            const existingRequestResult =
                await client.query(
                    `
                    SELECT
                        id,
                        merchant_id,
                        payout_account_id,
                        requested_amount,
                        payout_account_snapshot,
                        status,
                        idempotency_key,
                        payout_id,
                        requested_at,
                        reviewed_at,
                        completed_at
                    FROM
                        tbl_merchant_withdrawal_requests
                    WHERE merchant_id = $1
                      AND idempotency_key = $2
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        merchant.id,
                        normalizedKey
                    ]
                );

            if (existingRequestResult.rowCount) {
                await client.query('COMMIT');

                return {
                    status: 'idempotent_replay',
                    request:
                        existingRequestResult.rows[0],
                    merchant: {
                        id: merchant.id,
                        store_name:
                            merchant.store_name
                    }
                };
            }

            /*
             * Rekening pencairan harus sudah diverifikasi.
             */
            const accountResult =
                await client.query(
                    `
                    SELECT
                        id,
                        merchant_id,
                        bank_name,
                        account_number,
                        account_holder_name,
                        status,
                        verified_by,
                        verified_at
                    FROM
                        tbl_merchant_payout_accounts
                    WHERE merchant_id = $1
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [merchant.id]
                );

            if (!accountResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'payout_account_not_found'
                };
            }

            const payoutAccount =
                accountResult.rows[0];

            if (
                payoutAccount.status !==
                'VERIFIED'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'payout_account_not_verified',
                    account_status:
                        payoutAccount.status
                };
            }

            /*
             * Lock seluruh entitlement AVAILABLE merchant.
             *
             * ORDER BY id penting agar lock order sama dengan
             * MerchantPayoutService.
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
                        e.status,
                        e.available_at,
                        e.created_at
                    FROM
                        tbl_merchant_entitlements e
                    WHERE e.merchant_id = $1
                      AND e.status = 'AVAILABLE'
                    ORDER BY e.id
                    FOR UPDATE
                    `,
                    [merchant.id]
                );

            if (!entitlementResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'no_available_balance'
                };
            }

            const entitlementIds =
                entitlementResult.rows.map(
                    row => row.id
                );

            /*
             * Entitlement bisa tetap AVAILABLE di tabel utama
             * tetapi sedang RESERVED oleh withdrawal aktif.
             *
             * Lock allocation setelah entitlement agar lock order
             * sama dengan MerchantPayoutService.
             */
            const reservedResult =
                await client.query(
                    `
                    SELECT
                        entitlement_id,
                        withdrawal_request_id
                    FROM
                        tbl_merchant_withdrawal_allocations
                    WHERE entitlement_id =
                        ANY($1::uuid[])
                      AND status = 'RESERVED'
                    ORDER BY entitlement_id
                    FOR UPDATE
                    `,
                    [entitlementIds]
                );

            const reservedIds =
                new Set(
                    reservedResult.rows.map(
                        row =>
                            row.entitlement_id
                    )
                );

            const candidateEntitlements =
                entitlementResult.rows.filter(
                    row =>
                        !reservedIds.has(row.id)
                );

            if (!candidateEntitlements.length) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'no_available_balance'
                };
            }

            const candidateIds =
                candidateEntitlements.map(
                    row => row.id
                );

            /*
             * Adjustment dihitung dari finance truth saat request
             * dibuat, lalu disimpan sebagai snapshot allocation.
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
                    [candidateIds]
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

            const allocations = [];

            let requestedAmount = 0;

            for (
                const entitlement
                of candidateEntitlements
            ) {
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

                const adjustment =
                    adjustmentByEntitlement.get(
                        entitlement.id
                    ) || 0;

                /*
                 * Invariant dibuat konsisten dengan
                 * MerchantPayoutService V1.
                 */
                if (
                    !Number.isFinite(gross) ||
                    !Number.isFinite(commission) ||
                    !Number.isFinite(adjustment) ||
                    gross <= 0 ||
                    commission !== 0 ||
                    adjustment < 0 ||
                    adjustment > gross
                ) {
                    throw new Error(
                        'Merchant withdrawal finance invariant invalid'
                    );
                }

                const payoutAmount =
                    gross - adjustment;

                /*
                 * Entitlement yang habis oleh adjustment tidak
                 * mempunyai nilai yang bisa dicairkan.
                 */
                if (payoutAmount <= 0) {
                    continue;
                }

                allocations.push({
                    entitlement_id:
                        entitlement.id,

                    gross_amount:
                        gross,

                    adjustment_amount:
                        adjustment,

                    payout_amount:
                        payoutAmount
                });

                requestedAmount +=
                    payoutAmount;
            }

            if (
                !allocations.length ||
                requestedAmount <= 0
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'no_available_balance'
                };
            }

            /*
             * Monetary value yang masuk tabel numeric(18,2).
             */
            const normalizedRequestedAmount =
                Number(
                    requestedAmount.toFixed(2)
                );

            const payoutAccountSnapshot = {
                payout_account_id:
                    payoutAccount.id,

                bank_name:
                    payoutAccount.bank_name,

                account_number:
                    payoutAccount.account_number,

                account_holder_name:
                    payoutAccount.account_holder_name,

                verified_at:
                    payoutAccount.verified_at
            };

            const requestResult =
                await client.query(
                    `
                    INSERT INTO
                        tbl_merchant_withdrawal_requests (
                            merchant_id,
                            payout_account_id,
                            requested_amount,
                            payout_account_snapshot,
                            status,
                            idempotency_key
                        )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4::jsonb,
                        'REQUESTED',
                        $5
                    )
                    RETURNING *
                    `,
                    [
                        merchant.id,
                        payoutAccount.id,
                        normalizedRequestedAmount,
                        JSON.stringify(
                            payoutAccountSnapshot
                        ),
                        normalizedKey
                    ]
                );

            const withdrawalRequest =
                requestResult.rows[0];

            /*
             * Reserve seluruh entitlement yang menjadi bagian
             * withdrawal.
             *
             * Partial unique index pada entitlement_id dengan
             * status RESERVED menjadi pagar database terakhir.
             */
            for (
                const allocation
                of allocations
            ) {
                await client.query(
                    `
                    INSERT INTO
                        tbl_merchant_withdrawal_allocations (
                            withdrawal_request_id,
                            entitlement_id,
                            gross_amount,
                            adjustment_amount,
                            payout_amount,
                            status
                        )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        'RESERVED'
                    )
                    `,
                    [
                        withdrawalRequest.id,
                        allocation
                            .entitlement_id,
                        Number(
                            allocation
                                .gross_amount
                                .toFixed(2)
                        ),
                        Number(
                            allocation
                                .adjustment_amount
                                .toFixed(2)
                        ),
                        Number(
                            allocation
                                .payout_amount
                                .toFixed(2)
                        )
                    ]
                );
            }

            await client.query('COMMIT');

            return {
                status: 'requested',

                request:
                    withdrawalRequest,

                merchant: {
                    id: merchant.id,
                    store_name:
                        merchant.store_name
                },

                payout_account: {
                    id:
                        payoutAccount.id,
                    bank_name:
                        payoutAccount.bank_name,
                    account_number:
                        payoutAccount.account_number,
                    account_holder_name:
                        payoutAccount
                            .account_holder_name
                },

                requested_amount:
                    normalizedRequestedAmount,

                entitlement_count:
                    allocations.length,

                entitlement_ids:
                    allocations.map(
                        allocation =>
                            allocation
                                .entitlement_id
                    )
            };
        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            /*
             * Unique violation dapat terjadi jika request lain
             * memenangkan race sebelum reservation ini selesai.
             */
            if (err.code === '23505') {
                return {
                    status:
                        'reservation_conflict'
                };
            }

            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports =
    MerchantWithdrawalService;
