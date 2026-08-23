const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const CreditObligationService =
    require('../services/credit/CreditObligationService');

router.get('/purchase-orders/drafts', verifyToken, requireRole(4), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                po.id,
                po.status,
                po.supplier_id,
                s.supplier_name,
                po.warehouse_id,
                w.warehouse_name,
                w.location,
                po.total_amount,
                po.created_at,
                poi.product_id,
                p.sku,
                p.name,
                poi.quantity,
                poi.unit_cost
            FROM tbl_purchase_orders po
            LEFT JOIN tbl_suppliers s ON s.id = po.supplier_id
            LEFT JOIN tbl_warehouses w ON w.id = po.warehouse_id
            JOIN tbl_purchase_order_items poi
                ON poi.purchase_order_id = po.id
            JOIN tbl_products p
                ON p.id = poi.product_id
            WHERE po.status = 'DRAFT'
            ORDER BY po.created_at DESC
        `);

        res.json({
            status: 'success',
            total: result.rowCount,
            purchase_orders: result.rows
        });
    } catch (err) {
        console.error('[PURCHASE ORDER ERROR]', err.message);
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});


// ============================================================
// PURCHASE ORDER PAYMENT MODE V1
//
// Hanya DRAFT yang boleh memilih / mengubah cara pembayaran.
//
// CASH:
//   tidak memakai fasilitas Supplier.
//
// TEMPO:
//   wajib memakai credit account Supplier -> Merchant.
//   tempo_due_at disimpan sebagai snapshot kontrak.
// ============================================================

router.patch(
    '/purchase-orders/:id/payment-mode',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        const purchaseOrderId =
            req.params.id;

        const paymentMode =
            String(
                req.body.payment_mode || ''
            )
                .trim()
                .toUpperCase();

        const creditAccountId =
            req.body.credit_account_id || null;

        if (
            ![
                'CASH',
                'TEMPO'
            ].includes(paymentMode)
        ) {
            return res.status(400).json({
                error:
                    'payment_mode harus CASH atau TEMPO'
            });
        }

        if (
            paymentMode === 'TEMPO' &&
            !creditAccountId
        ) {
            return res.status(400).json({
                error:
                    'credit_account_id wajib untuk PO TEMPO'
            });
        }

        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            const poResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        merchant_id,
                        supplier_id,
                        warehouse_id,
                        total_amount,
                        payment_mode,
                        credit_account_id,
                        tempo_due_at
                    FROM tbl_purchase_orders
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [purchaseOrderId]
                );

            if (!poResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Purchase Order tidak ditemukan'
                });
            }

            const po =
                poResult.rows[0];

            if (po.status !== 'DRAFT') {
                await client.query('ROLLBACK');

                return res.status(409).json({
                    error:
                        'Payment mode hanya dapat diubah saat PO berstatus DRAFT',
                    current_status:
                        po.status
                });
            }

            /*
             * CASH membersihkan seluruh metadata TEMPO.
             */
            if (paymentMode === 'CASH') {
                const result =
                    await client.query(
                        `
                        UPDATE tbl_purchase_orders
                        SET
                            payment_mode = 'CASH',
                            credit_account_id = NULL,
                            tempo_due_at = NULL
                        WHERE id = $1
                        RETURNING
                            id,
                            status,
                            merchant_id,
                            supplier_id,
                            warehouse_id,
                            total_amount,
                            payment_mode,
                            credit_account_id,
                            tempo_due_at
                        `,
                        [po.id]
                    );

                await client.query('COMMIT');

                return res.json({
                    status: 'success',
                    message:
                        'Purchase Order menggunakan pembayaran CASH',
                    purchase_order:
                        result.rows[0]
                });
            }

            /*
             * TEMPO:
             * re-use validation canonical dari
             * CreditObligationService.
             */
            const creditService =
                new CreditObligationService(
                    client
                );

            const validation =
                await creditService
                    .validateSupplierTempo({
                        creditAccountId:
                            creditAccountId,
                        merchantId:
                            po.merchant_id,
                        supplierId:
                            po.supplier_id,
                        amount:
                            po.total_amount,
                        forUpdate:
                            true
                    });

            const account =
                validation.account;

            /*
             * Hitung due_at di PostgreSQL.
             *
             * default_term_days = 0:
             * jatuh tempo hari ini.
             *
             * default_term_days = 3:
             * jatuh tempo 3 hari kalender dari hari ini.
             *
             * same_day_due_time:
             * waktu jatuh tempo yang disepakati.
             *
             * Jika waktu tidak diatur:
             * default akhir hari 23:59:59.
             *
             * PostgreSQL server menggunakan Asia/Jakarta.
             */
            const dueResult =
                await client.query(
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
                            account.default_term_days
                        ),
                        account.same_day_due_time
                    ]
                );

            const dueAt =
                dueResult.rows[0].due_at;

            if (!dueAt) {
                throw new Error(
                    'Gagal menentukan jatuh tempo Purchase Order'
                );
            }

            const result =
                await client.query(
                    `
                    UPDATE tbl_purchase_orders
                    SET
                        payment_mode = 'TEMPO',
                        credit_account_id = $2,
                        tempo_due_at = $3
                    WHERE id = $1
                    RETURNING
                        id,
                        status,
                        merchant_id,
                        supplier_id,
                        warehouse_id,
                        total_amount,
                        payment_mode,
                        credit_account_id,
                        tempo_due_at
                    `,
                    [
                        po.id,
                        account.id,
                        dueAt
                    ]
                );

            await client.query('COMMIT');

            return res.json({
                status: 'success',
                message:
                    'Purchase Order menggunakan fasilitas TEMPO Supplier',
                purchase_order:
                    result.rows[0],
                credit: {
                    credit_limit:
                        account.credit_limit,
                    outstanding_amount:
                        validation.outstanding,
                    available_credit_before_po:
                        validation.available_credit,
                    default_term_days:
                        account.default_term_days,
                    same_day_due_time:
                        account.same_day_due_time
                }
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            const message =
                String(
                    err.message || ''
                );

            const isClientError =
                /tidak ditemukan|tidak cukup|tidak active|wajib|harus|limit_tempo/i
                    .test(message);

            console.error(
                '[PO PAYMENT MODE V1]',
                message
            );

            return res
                .status(
                    isClientError
                        ? 409
                        : 500
                )
                .json({
                    error: message
                });

        } finally {
            client.release();
        }
    }
);

module.exports = router;
