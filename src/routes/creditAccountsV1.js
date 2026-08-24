const express = require('express');
const router = express.Router();

const pool =
    require('../config/db');

const {
    verifyToken,
    requireRole
} =
    require('../middleware/auth');

const CreditAccountService =
    require(
        '../services/credit/CreditAccountService'
    );
const SupplierPayableService =
    require(
        '../services/credit/SupplierPayableService'
    );

const service =
    new CreditAccountService(pool);


// ============================================================
// CUSTOMER TEMPO — MERCHANT
// ============================================================

// Merchant melihat semua fasilitas tempo Customer miliknya.
router.get(
    '/merchant/credit-accounts-v1/customers',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const result =
                await service
                    .listCustomerAccountsForMerchant(
                        req.user.id
                    );

            return res.json({
                status: 'success',
                merchant: result.merchant,
                count: result.accounts.length,
                accounts: result.accounts
            });

        } catch (err) {
            console.error(
                '[CUSTOMER CREDIT LIST]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });
        }
    }
);


// Merchant memberi / memperbarui fasilitas tempo Customer.
//
// Endpoint ini hanya mengelola CREDIT ACCOUNT.
// Belum membuat piutang/order tempo.
router.post(
    '/merchant/credit-accounts-v1/customers',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const account =
                await service.upsertCustomerAccount({
                    merchantUserId:
                        req.user.id,

                    customerId:
                        req.body.customer_id,

                    creditLimit:
                        req.body.credit_limit,

                    defaultTermDays:
                        req.body.default_term_days ?? 0,

                    sameDayDueTime:
                        req.body.same_day_due_time ?? null,

                    notes:
                        req.body.notes ?? null,

                    approvedBy:
                        req.user.id
                });

            return res.status(201).json({
                status: 'success',
                message:
                    'Fasilitas tempo Customer berhasil disimpan',
                account
            });

        } catch (err) {
            const message =
                String(err.message || '');

            const isClientError =
                /wajib|tidak valid|tidak ditemukan|harus/i
                    .test(message);

            console.error(
                '[CUSTOMER CREDIT SAVE]',
                message
            );

            return res
                .status(
                    isClientError
                        ? 400
                        : 500
                )
                .json({
                    error: message
                });
        }
    }
);


// ============================================================
// SUPPLIER TEMPO — ADMIN
// ============================================================

// Admin melihat seluruh fasilitas tempo Supplier -> Merchant.
router.get(
    '/admin/credit-accounts-v1/suppliers',
    verifyToken,
    requireRole(4),
    async (_req, res) => {
        try {
            const accounts =
                await service
                    .listSupplierAccounts();

            return res.json({
                status: 'success',
                count: accounts.length,
                accounts
            });

        } catch (err) {
            console.error(
                '[SUPPLIER CREDIT LIST]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });
        }
    }
);


// Admin mencatat / memperbarui kesepakatan tempo Supplier.
router.post(
    '/admin/credit-accounts-v1/suppliers',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        try {
            const account =
                await service.upsertSupplierAccount({
                    merchantId:
                        req.body.merchant_id,

                    supplierId:
                        req.body.supplier_id,

                    creditLimit:
                        req.body.credit_limit,

                    defaultTermDays:
                        req.body.default_term_days ?? 0,

                    sameDayDueTime:
                        req.body.same_day_due_time ?? null,

                    notes:
                        req.body.notes ?? null,

                    approvedBy:
                        req.user.id
                });

            return res.status(201).json({
                status: 'success',
                message:
                    'Fasilitas tempo Supplier berhasil disimpan',
                account
            });

        } catch (err) {
            const message =
                String(err.message || '');

            const isClientError =
                /wajib|tidak valid|tidak ditemukan|harus/i
                    .test(message);

            console.error(
                '[SUPPLIER CREDIT SAVE]',
                message
            );

            return res
                .status(
                    isClientError
                        ? 400
                        : 500
                )
                .json({
                    error: message
                });
        }
    }
);


// ============================================================
// SUPPLIER TEMPO SETTLEMENT — ADMIN
// ============================================================
//
// Pembayaran Supplier tidak menggunakan tbl_payments.
// tbl_payments tetap merupakan domain pembayaran Customer.
//
// Atomic:
// settlement + obligation + ledger berada dalam transaction
// PostgreSQL yang sama.
//
router.post(
    '/admin/credit-obligations-v1/:id/settlements',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            const payableService =
                new SupplierPayableService(
                    client
                );

            const result =
                await payableService
                    .settleSupplierObligation({
                        obligationId:
                            req.params.id,
                        amount:
                            req.body.amount,
                        paymentMethod:
                            req.body.payment_method,
                        idempotencyKey:
                            req.body.idempotency_key,
                        referenceNumber:
                            req.body.reference_number ??
                            null,
                        notes:
                            req.body.notes ??
                            null,
                        receivedBy:
                            req.user.id
                    });

            await client.query('COMMIT');

            return res
                .status(
                    result.status ===
                    'existing'
                        ? 200
                        : 201
                )
                .json({
                    status: 'success',
                    idempotent:
                        result.status ===
                        'existing',
                    message:
                        result.status ===
                        'existing'
                            ? 'Settlement sudah pernah diproses'
                            : 'Pembayaran utang Supplier berhasil dicatat',
                    settlement:
                        result.settlement,
                    obligation:
                        result.obligation,
                    ledger_reference:
                        result.ledger_reference ||
                        null
                });

        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            const message =
                String(
                    err.message || ''
                );

            const isClientError =
                /wajib|tidak valid|tidak ditemukan|bukan utang|tidak ACTIVE|sudah lunas|CANCELLED|melebihi/i
                    .test(message);

            console.error(
                '[SUPPLIER TEMPO SETTLEMENT]',
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
