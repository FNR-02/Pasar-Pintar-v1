const MerchantEntitlementReleaseService =
    require('./MerchantEntitlementReleaseService');

class CodCashRemittanceService {
    constructor(db) {
        this.db = db;
    }

    normalize(value) {
        return String(value || '')
            .trim()
            .toUpperCase();
    }

    async recordRemittance({
        marketPaymentIds,
        remittanceReference,
        createdBy = null
    }) {
        const paymentIds = [
            ...new Set(
                (
                    Array.isArray(marketPaymentIds)
                        ? marketPaymentIds
                        : []
                )
                    .map(id =>
                        String(id || '').trim()
                    )
                    .filter(Boolean)
            )
        ];

        const reference =
            String(
                remittanceReference || ''
            ).trim();

        if (!paymentIds.length) {
            throw new Error(
                'market_payment_ids wajib'
            );
        }

        if (!reference) {
            throw new Error(
                'remittance_reference wajib'
            );
        }

        const client =
            await this.db.connect();

        try {
            await client.query('BEGIN');

            const existingReference =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_cod_cash_remittances
                    WHERE remittance_reference = $1
                    FOR UPDATE
                    `,
                    [reference]
                );

            if (existingReference.rowCount) {
                const existing =
                    existingReference.rows[0];

                const existingAllocations =
                    await client.query(
                        `
                        SELECT
                            market_payment_id
                        FROM tbl_cod_cash_remittance_allocations
                        WHERE remittance_id = $1
                        ORDER BY market_payment_id
                        FOR UPDATE
                        `,
                        [existing.id]
                    );

                const requestedIds =
                    [...paymentIds].sort();

                const existingIds =
                    existingAllocations.rows
                        .map(
                            row =>
                                String(
                                    row.market_payment_id
                                )
                        )
                        .sort();

                const samePayments =
                    requestedIds.length ===
                        existingIds.length &&
                    requestedIds.every(
                        (id, index) =>
                            id ===
                            existingIds[index]
                    );

                if (!samePayments) {
                    throw new Error(
                        'Remittance reference sudah digunakan untuk payment berbeda'
                    );
                }

                await client.query('COMMIT');

                return {
                    status:
                        'already_recorded',
                    remittance:
                        existing,
                    payment_count:
                        existingIds.length,
                    gross_amount:
                        Number(
                            existing.gross_amount
                        )
                };
            }

            const payments = [];

            for (const paymentId of paymentIds) {
                const result =
                    await client.query(
                        `
                        SELECT
                            mp.id,
                            mp.market_order_id,
                            mp.payment_method,
                            mp.payment_status,
                            mp.provider,
                            mp.amount,
                            ct.id AS collector_task_id,
                            ct.courier_id,
                            ct.status AS collector_task_status
                        FROM tbl_market_payments mp
                        INNER JOIN tbl_collector_tasks ct
                          ON ct.market_order_id =
                                mp.market_order_id
                        WHERE mp.id = $1
                        FOR UPDATE OF mp, ct
                        `,
                        [paymentId]
                    );

                if (result.rowCount !== 1) {
                    throw new Error(
                        'Market payment COD tidak ditemukan'
                    );
                }

                const payment =
                    result.rows[0];

                if (
                    payment.payment_status !==
                        'PAID' ||
                    this.normalize(
                        payment.payment_method
                    ) !== 'COD' ||
                    this.normalize(
                        payment.provider
                    ) !== 'CASH'
                ) {
                    throw new Error(
                        'Market payment bukan COD CASH PAID'
                    );
                }

                if (
                    payment.collector_task_status !==
                    'COMPLETED'
                ) {
                    throw new Error(
                        'Delivery COD belum COMPLETED'
                    );
                }

                if (!payment.courier_id) {
                    throw new Error(
                        'Courier COD tidak ditemukan'
                    );
                }

                const allocation =
                    await client.query(
                        `
                        SELECT
                            id,
                            remittance_id
                        FROM tbl_cod_cash_remittance_allocations
                        WHERE market_payment_id = $1
                        FOR UPDATE
                        `,
                        [payment.id]
                    );

                if (allocation.rowCount) {
                    throw new Error(
                        'Market payment COD sudah dialokasikan'
                    );
                }

                payments.push(payment);
            }

            const courierIds = [
                ...new Set(
                    payments.map(
                        row => row.courier_id
                    )
                )
            ];

            if (courierIds.length !== 1) {
                throw new Error(
                    'Semua payment COD harus berasal dari courier yang sama'
                );
            }

            const grossAmount =
                payments.reduce(
                    (total, row) =>
                        total +
                        Number(row.amount),
                    0
                );

            if (
                !Number.isFinite(grossAmount) ||
                grossAmount <= 0
            ) {
                throw new Error(
                    'gross_amount remittance tidak valid'
                );
            }

            const remittanceResult =
                await client.query(
                    `
                    INSERT INTO tbl_cod_cash_remittances (
                        courier_id,
                        remittance_reference,
                        status,
                        gross_amount,
                        created_by
                    )
                    VALUES (
                        $1,
                        $2,
                        'RECORDED',
                        $3,
                        $4
                    )
                    RETURNING *
                    `,
                    [
                        courierIds[0],
                        reference,
                        grossAmount,
                        createdBy
                    ]
                );

            const remittance =
                remittanceResult.rows[0];

            for (const payment of payments) {
                await client.query(
                    `
                    INSERT INTO
                        tbl_cod_cash_remittance_allocations (
                            remittance_id,
                            market_payment_id,
                            collector_task_id,
                            amount
                        )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4
                    )
                    `,
                    [
                        remittance.id,
                        payment.id,
                        payment.collector_task_id,
                        Number(payment.amount)
                    ]
                );
            }

            await client.query('COMMIT');

            return {
                status: 'recorded',
                remittance,
                payment_count:
                    payments.length,
                gross_amount:
                    grossAmount
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

    async reconcileRemittance({
        remittanceId,
        receivedAmount,
        receiptReference,
        evidenceReference,
        reconciledBy,
        remittedAt
    }) {
        if (!remittanceId) {
            throw new Error(
                'remittance_id wajib'
            );
        }

        if (!reconciledBy) {
            throw new Error(
                'reconciled_by wajib'
            );
        }

        const receipt =
            String(
                receiptReference || ''
            ).trim();

        const evidence =
            String(
                evidenceReference || ''
            ).trim();

        if (!receipt) {
            throw new Error(
                'receipt_reference wajib'
            );
        }

        if (!evidence) {
            throw new Error(
                'evidence_reference wajib'
            );
        }

        if (!remittedAt) {
            throw new Error(
                'remitted_at wajib'
            );
        }

        const received =
            Number(receivedAmount);

        if (
            !Number.isFinite(received) ||
            received < 0
        ) {
            throw new Error(
                'received_amount tidak valid'
            );
        }

        const client =
            await this.db.connect();

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
                    'Rekonsiliasi COD hanya dapat dilakukan admin'
                );
            }

            const remittanceResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_cod_cash_remittances
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [remittanceId]
                );

            if (!remittanceResult.rowCount) {
                throw new Error(
                    'COD remittance tidak ditemukan'
                );
            }

            const remittance =
                remittanceResult.rows[0];

            if (
                ![
                    'RECORDED',
                    'RECONCILED'
                ].includes(remittance.status)
            ) {
                throw new Error(
                    'Status COD remittance tidak dapat direkonsiliasi'
                );
            }

            const grossAmount =
                Number(
                    remittance.gross_amount
                );

            if (
                !Number.isFinite(grossAmount) ||
                grossAmount <= 0
            ) {
                throw new Error(
                    'gross_amount remittance tidak valid'
                );
            }

            if (received !== grossAmount) {
                throw new Error(
                    'Setoran COD memiliki selisih yang belum dapat direkonsiliasi'
                );
            }

            const allocationResult =
                await client.query(
                    `
                    SELECT
                        a.id,
                        a.market_payment_id,
                        a.collector_task_id,
                        a.amount,
                        mp.market_order_id,
                        mp.payment_method,
                        mp.payment_status,
                        mp.provider,
                        mp.amount AS payment_amount,
                        ct.courier_id,
                        ct.status AS collector_task_status
                    FROM tbl_cod_cash_remittance_allocations a
                    INNER JOIN tbl_market_payments mp
                      ON mp.id =
                         a.market_payment_id
                    INNER JOIN tbl_collector_tasks ct
                      ON ct.id =
                         a.collector_task_id
                    WHERE a.remittance_id = $1
                    ORDER BY a.id
                    FOR UPDATE OF a, mp, ct
                    `,
                    [remittance.id]
                );

            if (!allocationResult.rowCount) {
                throw new Error(
                    'COD remittance tidak memiliki allocation'
                );
            }

            const allocatedAmount =
                allocationResult.rows.reduce(
                    (total, row) =>
                        total +
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
                    'Total allocation COD tidak sesuai gross remittance'
                );
            }

            for (
                const row
                of allocationResult.rows
            ) {
                if (
                    row.payment_status !==
                        'PAID' ||
                    this.normalize(
                        row.payment_method
                    ) !== 'COD' ||
                    this.normalize(
                        row.provider
                    ) !== 'CASH'
                ) {
                    throw new Error(
                        'Allocation bukan COD CASH PAID'
                    );
                }

                if (
                    row.collector_task_status !==
                    'COMPLETED'
                ) {
                    throw new Error(
                        'Delivery COD belum COMPLETED'
                    );
                }

                if (
                    row.courier_id !==
                    remittance.courier_id
                ) {
                    throw new Error(
                        'Courier allocation tidak sesuai remittance'
                    );
                }

                if (
                    Number(row.amount) !==
                    Number(
                        row.payment_amount
                    )
                ) {
                    throw new Error(
                        'Nominal allocation tidak sesuai market payment'
                    );
                }

                const collectionRef =
                    `CODCOL-${row.market_payment_id}`;

                const ledgerResult =
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
                        [collectionRef]
                    );

                const debit1500 =
                    ledgerResult.rows.find(
                        item =>
                            item.account_code ===
                            '1500'
                    );

                const credit2200 =
                    ledgerResult.rows.find(
                        item =>
                            item.account_code ===
                            '2200'
                    );

                if (
                    !debit1500 ||
                    !credit2200 ||
                    Number(
                        debit1500.debit
                    ) !== Number(row.amount) ||
                    Number(
                        debit1500.credit
                    ) !== 0 ||
                    Number(
                        credit2200.credit
                    ) !== Number(row.amount) ||
                    Number(
                        credit2200.debit
                    ) !== 0
                ) {
                    throw new Error(
                        `Ledger penerimaan COD tidak valid: ${row.market_payment_id}`
                    );
                }
            }

            const marketOrderIds = [
                ...new Set(
                    allocationResult.rows
                        .map(
                            row =>
                                row.market_order_id
                        )
                        .filter(Boolean)
                )
            ];

            if (
                remittance.status ===
                'RECONCILED'
            ) {
                const same =
                    Number(
                        remittance.received_amount
                    ) === received &&
                    Number(
                        remittance.unresolved_amount
                    ) === 0 &&
                    String(
                        remittance.receipt_reference ||
                        ''
                    ).trim() === receipt &&
                    String(
                        remittance.evidence_reference ||
                        ''
                    ).trim() === evidence;

                if (!same) {
                    throw new Error(
                        'COD remittance sudah direkonsiliasi dengan data berbeda'
                    );
                }

                const releaseService =
                    new MerchantEntitlementReleaseService(
                        client
                    );

                const releaseResults = [];

                for (
                    const marketOrderId
                    of marketOrderIds
                ) {
                    const result =
                        await releaseService
                            .releaseByMarketOrderId(
                                marketOrderId
                            );

                    releaseResults.push({
                        market_order_id:
                            marketOrderId,
                        ...result
                    });
                }

                await client.query('COMMIT');

                return {
                    status:
                        'already_reconciled',
                    remittance,
                    entitlement_release:
                        releaseResults
                };
            }

            const ledgerRef =
                `CODREM-${remittance.id}`;

            const existingLedger =
                await client.query(
                    `
                    SELECT account_code
                    FROM tbl_general_ledger
                    WHERE transaction_reference =
                        $1
                    FOR UPDATE
                    `,
                    [ledgerRef]
                );

            if (
                existingLedger.rowCount
            ) {
                throw new Error(
                    'Ledger COD remittance sudah ada sebelum status RECONCILED'
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
                    received,
                    `Setoran COD ${remittance.remittance_reference}`
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
                    '1500',
                    'Dana COD di Tangan Kurir',
                    0,
                    $2,
                    $3
                )
                `,
                [
                    ledgerRef,
                    grossAmount,
                    `Reklasifikasi setoran COD ${remittance.remittance_reference}`
                ]
            );

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_cod_cash_remittances
                    SET
                        status =
                            'RECONCILED',
                        received_amount =
                            $2,
                        unresolved_amount =
                            0,
                        remitted_at =
                            $3,
                        receipt_reference =
                            $4,
                        evidence_reference =
                            $5,
                        reconciled_by =
                            $6,
                        reconciled_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status =
                            'RECORDED'
                    RETURNING *
                    `,
                    [
                        remittance.id,
                        received,
                        remittedAt,
                        receipt,
                        evidence,
                        reconciledBy
                    ]
                );

            if (
                updatedResult.rowCount !== 1
            ) {
                throw new Error(
                    'COD remittance berubah secara bersamaan'
                );
            }

            const releaseService =
                new MerchantEntitlementReleaseService(
                    client
                );

            const releaseResults = [];

            for (
                const marketOrderId
                of marketOrderIds
            ) {
                const result =
                    await releaseService
                        .releaseByMarketOrderId(
                            marketOrderId
                        );

                releaseResults.push({
                    market_order_id:
                        marketOrderId,
                    ...result
                });
            }

            await client.query('COMMIT');

            return {
                status:
                    'reconciled',
                remittance:
                    updatedResult.rows[0],
                ledger_reference:
                    ledgerRef,
                entitlement_release:
                    releaseResults
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
    CodCashRemittanceService;
