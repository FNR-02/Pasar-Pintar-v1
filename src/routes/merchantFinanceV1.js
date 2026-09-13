const express = require('express');

const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const MerchantWithdrawalService =
    require(
        '../services/finance/MerchantWithdrawalService'
    );

module.exports = (pool) => {
    const router = express.Router();

    const withdrawalService =
        new MerchantWithdrawalService(pool);

    async function getActiveMerchant(
        db,
        userId,
        forUpdate = false
    ) {
        const result = await db.query(
            `
            SELECT
                id,
                user_id,
                store_name,
                status
            FROM tbl_merchants
            WHERE user_id = $1
            LIMIT 1
            ${forUpdate ? 'FOR UPDATE' : ''}
            `,
            [userId]
        );

        if (!result.rowCount) {
            return {
                status: 'merchant_not_found'
            };
        }

        const merchant =
            result.rows[0];

        if (
            merchant.status !==
            'ACTIVE'
        ) {
            return {
                status: 'merchant_not_active'
            };
        }

        return {
            status: 'ok',
            merchant
        };
    }

    /*
     * GET /api/merchant/finance/summary
     */
    router.get(
        '/merchant/finance/summary',
        verifyToken,
        requireRole(2),
        async (req, res) => {
            try {
                const merchantState =
                    await getActiveMerchant(
                        pool,
                        req.user.id
                    );

                if (
                    merchantState.status !==
                    'ok'
                ) {
                    return res
                        .status(403)
                        .json({
                            status:
                                'error',
                            code:
                                merchantState.status
                        });
                }

                const merchant =
                    merchantState.merchant;

                const balanceResult =
                    await pool.query(
                        `
                        WITH adjustment_totals AS (
                            SELECT
                                entitlement_id,
                                COALESCE(
                                    SUM(amount),
                                    0
                                ) AS adjustment_amount
                            FROM
                                tbl_merchant_entitlement_adjustments
                            GROUP BY
                                entitlement_id
                        ),
                        available_balance AS (
                            SELECT
                                COALESCE(
                                    SUM(
                                        e.merchant_entitlement -
                                        COALESCE(
                                            a.adjustment_amount,
                                            0
                                        )
                                    ),
                                    0
                                ) AS amount,
                                COUNT(e.id)::int
                                    AS entitlement_count
                            FROM
                                tbl_merchant_entitlements e
                            LEFT JOIN
                                adjustment_totals a
                              ON a.entitlement_id =
                                 e.id
                            WHERE
                                e.merchant_id = $1
                              AND e.status =
                                  'AVAILABLE'
                              AND e.merchant_entitlement > 0
                              AND e.platform_commission = 0
                              AND COALESCE(
                                  a.adjustment_amount,
                                  0
                              ) >= 0
                              AND COALESCE(
                                  a.adjustment_amount,
                                  0
                              ) <=
                                  e.merchant_entitlement
                              AND (
                                  e.merchant_entitlement -
                                  COALESCE(
                                      a.adjustment_amount,
                                      0
                                  )
                              ) > 0
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM
                                      tbl_merchant_withdrawal_allocations wa
                                  WHERE
                                      wa.entitlement_id =
                                          e.id
                                    AND wa.status =
                                        'RESERVED'
                              )
                        ),
                        reserved_balance AS (
                            SELECT
                                COALESCE(
                                    SUM(
                                        wa.payout_amount
                                    ),
                                    0
                                ) AS amount,
                                COUNT(wa.id)::int
                                    AS entitlement_count
                            FROM
                                tbl_merchant_withdrawal_allocations wa
                            JOIN
                                tbl_merchant_withdrawal_requests wr
                              ON wr.id =
                                 wa.withdrawal_request_id
                            WHERE
                                wr.merchant_id = $1
                              AND wa.status =
                                  'RESERVED'
                        )
                        SELECT
                            available_balance.amount
                                AS available_balance,
                            available_balance.entitlement_count
                                AS available_entitlement_count,
                            reserved_balance.amount
                                AS reserved_balance,
                            reserved_balance.entitlement_count
                                AS reserved_entitlement_count
                        FROM
                            available_balance,
                            reserved_balance
                        `,
                        [merchant.id]
                    );

                const accountResult =
                    await pool.query(
                        `
                        SELECT
                            id,
                            bank_name,
                            account_number,
                            account_holder_name,
                            status,
                            verified_at,
                            rejection_reason,
                            created_at,
                            updated_at
                        FROM
                            tbl_merchant_payout_accounts
                        WHERE merchant_id = $1
                        LIMIT 1
                        `,
                        [merchant.id]
                    );

                const activeResult =
                    await pool.query(
                        `
                        SELECT
                            id,
                            requested_amount,
                            status,
                            requested_at
                        FROM
                            tbl_merchant_withdrawal_requests
                        WHERE merchant_id = $1
                          AND status =
                              'REQUESTED'
                        ORDER BY
                            requested_at ASC
                        LIMIT 1
                        `,
                        [merchant.id]
                    );

                const row =
                    balanceResult.rows[0];

                const available =
                    Number(
                        row.available_balance ||
                        0
                    );

                const reserved =
                    Number(
                        row.reserved_balance ||
                        0
                    );

                return res.json({
                    status: 'success',
                    data: {
                        merchant: {
                            id:
                                merchant.id,
                            store_name:
                                merchant.store_name
                        },
                        balance: {
                            available,
                            reserved,
                            total_unsettled:
                                available +
                                reserved,
                            available_entitlement_count:
                                Number(
                                    row
                                        .available_entitlement_count ||
                                    0
                                ),
                            reserved_entitlement_count:
                                Number(
                                    row
                                        .reserved_entitlement_count ||
                                    0
                                )
                        },
                        payout_account:
                            accountResult
                                .rowCount
                                ? accountResult
                                    .rows[0]
                                : null,
                        active_withdrawal:
                            activeResult
                                .rowCount
                                ? activeResult
                                    .rows[0]
                                : null
                    }
                });
            } catch (err) {
                console.error(
                    '[MERCHANT FINANCE SUMMARY V1]',
                    err
                );

                return res
                    .status(500)
                    .json({
                        status:
                            'error',
                        code:
                            'MERCHANT_FINANCE_SUMMARY_INTERNAL_ERROR'
                    });
            }
        }
    );

    /*
     * PUT /api/merchant/finance/payout-account
     *
     * Rekening baru atau rekening yang berubah
     * selalu kembali ke PENDING.
     *
     * Rekening tidak boleh diubah ketika masih ada
     * withdrawal REQUESTED.
     */
    router.put(
        '/merchant/finance/payout-account',
        verifyToken,
        requireRole(2),
        async (req, res) => {
            const bankName =
                String(
                    req.body?.bank_name || ''
                ).trim();

            const accountNumber =
                String(
                    req.body?.account_number || ''
                ).trim();

            const accountHolderName =
                String(
                    req.body
                        ?.account_holder_name ||
                    ''
                ).trim();

            if (
                !bankName ||
                !accountNumber ||
                !accountHolderName
            ) {
                return res
                    .status(400)
                    .json({
                        status: 'error',
                        code:
                            'INVALID_PAYOUT_ACCOUNT'
                    });
            }

            const client =
                await pool.connect();

            try {
                await client.query('BEGIN');

                const merchantState =
                    await getActiveMerchant(
                        client,
                        req.user.id,
                        true
                    );

                if (
                    merchantState.status !==
                    'ok'
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(403)
                        .json({
                            status:
                                'error',
                            code:
                                merchantState.status
                        });
                }

                const merchant =
                    merchantState.merchant;

                const existingResult =
                    await client.query(
                        `
                        SELECT *
                        FROM
                            tbl_merchant_payout_accounts
                        WHERE merchant_id = $1
                        LIMIT 1
                        FOR UPDATE
                        `,
                        [merchant.id]
                    );

                if (existingResult.rowCount) {
                    const existing =
                        existingResult.rows[0];

                    const unchanged =
                        String(
                            existing.bank_name ||
                            ''
                        ).trim() ===
                            bankName &&
                        String(
                            existing
                                .account_number ||
                            ''
                        ).trim() ===
                            accountNumber &&
                        String(
                            existing
                                .account_holder_name ||
                            ''
                        ).trim() ===
                            accountHolderName;

                    if (unchanged) {
                        await client.query(
                            'COMMIT'
                        );

                        return res.json({
                            status:
                                'success',
                            code:
                                'PAYOUT_ACCOUNT_UNCHANGED',
                            payout_account:
                                existing
                        });
                    }

                    const activeResult =
                        await client.query(
                            `
                            SELECT id
                            FROM
                                tbl_merchant_withdrawal_requests
                            WHERE merchant_id = $1
                              AND status =
                                  'REQUESTED'
                            LIMIT 1
                            FOR UPDATE
                            `,
                            [merchant.id]
                        );

                    if (
                        activeResult.rowCount
                    ) {
                        await client.query(
                            'ROLLBACK'
                        );

                        return res
                            .status(409)
                            .json({
                                status:
                                    'error',
                                code:
                                    'ACTIVE_WITHDRAWAL_EXISTS'
                            });
                    }

                    const updatedResult =
                        await client.query(
                            `
                            UPDATE
                                tbl_merchant_payout_accounts
                            SET
                                bank_name = $2,
                                account_number = $3,
                                account_holder_name = $4,
                                status = 'PENDING',
                                verified_by = NULL,
                                verified_at = NULL,
                                rejection_reason = NULL,
                                updated_at =
                                    CURRENT_TIMESTAMP
                            WHERE merchant_id = $1
                            RETURNING *
                            `,
                            [
                                merchant.id,
                                bankName,
                                accountNumber,
                                accountHolderName
                            ]
                        );

                    await client.query(
                        'COMMIT'
                    );

                    return res.json({
                        status: 'success',
                        code:
                            'PAYOUT_ACCOUNT_UPDATED',
                        payout_account:
                            updatedResult.rows[0]
                    });
                }

                const insertedResult =
                    await client.query(
                        `
                        INSERT INTO
                            tbl_merchant_payout_accounts (
                                merchant_id,
                                bank_name,
                                account_number,
                                account_holder_name,
                                status
                            )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            'PENDING'
                        )
                        RETURNING *
                        `,
                        [
                            merchant.id,
                            bankName,
                            accountNumber,
                            accountHolderName
                        ]
                    );

                await client.query('COMMIT');

                return res
                    .status(201)
                    .json({
                        status:
                            'success',
                        code:
                            'PAYOUT_ACCOUNT_CREATED',
                        payout_account:
                            insertedResult.rows[0]
                    });
            } catch (err) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}

                console.error(
                    '[MERCHANT PAYOUT ACCOUNT V1]',
                    err
                );

                return res
                    .status(500)
                    .json({
                        status:
                            'error',
                        code:
                            'MERCHANT_PAYOUT_ACCOUNT_INTERNAL_ERROR'
                    });
            } finally {
                client.release();
            }
        }
    );


    /*
     * GET /api/merchant/finance/withdrawals
     */
    router.get(
        '/merchant/finance/withdrawals',
        verifyToken,
        requireRole(2),
        async (req, res) => {
            try {
                const merchantState =
                    await getActiveMerchant(
                        pool,
                        req.user.id
                    );

                if (
                    merchantState.status !==
                    'ok'
                ) {
                    return res
                        .status(403)
                        .json({
                            status: 'error',
                            code:
                                merchantState.status
                        });
                }

                const merchant =
                    merchantState.merchant;

                const result =
                    await pool.query(
                        `
                        SELECT
                            wr.id,
                            wr.requested_amount,
                            wr.status,
                            wr.payout_account_snapshot,
                            wr.payout_id,
                            wr.requested_at,
                            wr.reviewed_at,
                            wr.rejection_reason,
                            wr.completed_at,
                            COUNT(wa.id)::int
                                AS entitlement_count,
                            COALESCE(
                                SUM(
                                    wa.payout_amount
                                ),
                                0
                            ) AS allocated_amount,
                            p.payout_reference,
                            p.evidence_reference,
                            p.payout_at
                        FROM
                            tbl_merchant_withdrawal_requests wr
                        LEFT JOIN
                            tbl_merchant_withdrawal_allocations wa
                          ON wa.withdrawal_request_id =
                             wr.id
                        LEFT JOIN
                            tbl_merchant_payouts p
                          ON p.id =
                             wr.payout_id
                        WHERE
                            wr.merchant_id = $1
                        GROUP BY
                            wr.id,
                            p.id
                        ORDER BY
                            wr.requested_at DESC,
                            wr.id DESC
                        LIMIT 100
                        `,
                        [merchant.id]
                    );

                return res.json({
                    status: 'success',
                    data: {
                        withdrawals:
                            result.rows,
                        count:
                            result.rowCount
                    }
                });
            } catch (err) {
                console.error(
                    '[MERCHANT WITHDRAWAL HISTORY V1]',
                    err
                );

                return res
                    .status(500)
                    .json({
                        status:
                            'error',
                        code:
                            'MERCHANT_WITHDRAWAL_HISTORY_INTERNAL_ERROR'
                    });
            }
        }
    );

    /*
     * POST /api/merchant/finance/withdrawals
     *
     * Merchant tidak mengirim nominal.
     * Nominal dihitung server.
     */
    router.post(
        '/merchant/finance/withdrawals',
        verifyToken,
        requireRole(2),
        async (req, res) => {
            const idempotencyKey =
                String(
                    req.get(
                        'X-Idempotency-Key'
                    ) ||
                    req.body
                        ?.idempotency_key ||
                    ''
                ).trim();

            if (!idempotencyKey) {
                return res
                    .status(400)
                    .json({
                        status: 'error',
                        code:
                            'IDEMPOTENCY_KEY_REQUIRED'
                    });
            }

            try {
                const result =
                    await withdrawalService
                        .createRequest({
                            userId:
                                req.user.id,
                            idempotencyKey
                        });

                switch (result.status) {
                case 'requested':
                    return res
                        .status(201)
                        .json({
                            status:
                                'success',
                            code:
                                'MERCHANT_WITHDRAWAL_REQUESTED',
                            data:
                                result
                        });

                case 'idempotent_replay':
                    return res.json({
                        status:
                            'success',
                        code:
                            'MERCHANT_WITHDRAWAL_IDEMPOTENT_REPLAY',
                        data:
                            result
                    });

                case 'invalid_input':
                    return res
                        .status(400)
                        .json({
                            status:
                                'error',
                            code:
                                'MERCHANT_WITHDRAWAL_INVALID_INPUT'
                        });

                case 'merchant_not_found':
                case 'merchant_not_active':
                    return res
                        .status(403)
                        .json({
                            status:
                                'error',
                            code:
                                result.status
                        });

                case 'payout_account_not_found':
                    return res
                        .status(409)
                        .json({
                            status:
                                'error',
                            code:
                                'PAYOUT_ACCOUNT_REQUIRED'
                        });

                case 'payout_account_not_verified':
                    return res
                        .status(409)
                        .json({
                            status:
                                'error',
                            code:
                                'PAYOUT_ACCOUNT_NOT_VERIFIED',
                            account_status:
                                result.account_status ||
                                null
                        });

                case 'no_available_balance':
                    return res
                        .status(409)
                        .json({
                            status:
                                'error',
                            code:
                                'NO_AVAILABLE_WITHDRAWAL_BALANCE'
                        });

                case 'reservation_conflict':
                    return res
                        .status(409)
                        .json({
                            status:
                                'error',
                            code:
                                'WITHDRAWAL_RESERVATION_CONFLICT'
                        });

                case 'active_withdrawal_exists':
                    return res
                        .status(409)
                        .json({
                            status:
                                'error',
                            code:
                                'ACTIVE_WITHDRAWAL_EXISTS',
                            active_withdrawal:
                                result.request || null
                        });

                default:
                    return res
                        .status(409)
                        .json({
                            status:
                                'error',
                            code:
                                'MERCHANT_WITHDRAWAL_NOT_ALLOWED',
                            result_status:
                                result.status
                        });
                }
            } catch (err) {
                console.error(
                    '[MERCHANT WITHDRAWAL CREATE V1]',
                    err
                );

                return res
                    .status(500)
                    .json({
                        status:
                            'error',
                        code:
                            'MERCHANT_WITHDRAWAL_CREATE_INTERNAL_ERROR'
                    });
            }
        }
    );


    return router;
};
