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
const CustomerReceivableService =
    require(
        '../services/credit/CustomerReceivableService'
    );

const CustomerTempoReadService =
    require(
        '../services/credit/CustomerTempoReadService'
    );
const OrderInventoryFulfillmentService =
    require(
        '../services/orders/OrderInventoryFulfillmentService'
    );

const service =
    new CreditAccountService(pool);


// ============================================================
// CUSTOMER TEMPO READ — CUSTOMER
// ============================================================

router.get(
    '/customer/credit-accounts-v1',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        try {
            const readService =
                new CustomerTempoReadService(
                    pool
                );

            const result =
                await readService
                    .listAccountsForCustomer(
                        req.user.id
                    );

            return res.json({
                status:
                    'success',
                customer:
                    result.customer,
                count:
                    result.accounts.length,
                accounts:
                    result.accounts
            });

        } catch (err) {
            const status =
                Number(
                    err.statusCode || 500
                );

            console.error(
                '[CUSTOMER TEMPO ACCOUNT READ]',
                err.message
            );

            return res
                .status(status)
                .json({
                    error:
                        err.message
                });
        }
    }
);



// Customer melihat daftar tagihan TEMPO miliknya.
router.get(
    '/customer/credit-obligations-v1',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        try {
            const service =
                new CustomerTempoReadService(pool);

            const result =
                await service
                    .listObligationsForCustomer(
                        req.user.id
                    );

            return res.json({
                status: 'success',
                customer: result.customer,
                count: result.obligations.length,
                obligations: result.obligations
            });
        } catch (err) {
            console.error(
                '[CUSTOMER TEMPO OBLIGATION LIST]',
                err.message
            );

            return res
                .status(err.statusCode || 500)
                .json({
                    error: err.message
                });
        }
    }
);


// Customer melihat detail satu tagihan TEMPO miliknya.
router.get(
    '/customer/credit-obligations-v1/:id',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        try {
            const service =
                new CustomerTempoReadService(pool);

            const result =
                await service
                    .getObligationForCustomer({
                        userId: req.user.id,
                        obligationId: req.params.id
                    });

            return res.json({
                status: 'success',
                ...result
            });
        } catch (err) {
            console.error(
                '[CUSTOMER TEMPO OBLIGATION DETAIL]',
                err.message
            );

            return res
                .status(err.statusCode || 500)
                .json({
                    error: err.message
                });
        }
    }
);

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



// ============================================================
// CUSTOMER TEMPO ORDER ACTIVATION V1
// ============================================================
//
// Customer hanya dapat mengaktifkan TEMPO untuk order miliknya.
//
// TEMPO:
// - bukan pembayaran PAID
// - tidak membuat tbl_payments
// - tidak menerbitkan ORDER_PAID
//
// Atomic:
// order + obligation + ledger berada dalam transaction yang sama.
// ============================================================

router.post(
    '/customer/credit-orders-v1/:orderId/tempo',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Resolve customer langsung dari JWT user.
             * Jangan percaya customer_id dari request body.
             */
            const customerResult =
                await client.query(
                    `
                    SELECT
                        id,
                        user_id,
                        full_name
                    FROM tbl_customers
                    WHERE user_id = $1
                    LIMIT 1
                    `,
                    [
                        req.user.id
                    ]
                );

            if (!customerResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Customer tidak ditemukan'
                });
            }

            const customer =
                customerResult.rows[0];

            /*
             * Ownership check sebelum service dipanggil.
             */
            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        customer_id,
                        merchant_id,
                        status,
                        total_amount,
                        payment_mode
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [
                        req.params.orderId
                    ]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Order tidak ditemukan'
                });
            }

            const order =
                orderResult.rows[0];

            if (
                String(order.customer_id) !==
                String(customer.id)
            ) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error:
                        'Order bukan milik Customer ini'
                });
            }

            const creditAccountId =
                req.body.credit_account_id;

            if (!creditAccountId) {
                await client.query('ROLLBACK');

                return res.status(400).json({
                    error:
                        'credit_account_id wajib'
                });
            }

            const receivableService =
                new CustomerReceivableService(
                    client
                );

            const result =
                await receivableService
                    .activateOrderTempo({
                        orderId:
                            order.id,
                        creditAccountId:
                            creditAccountId
                    });

            /*
             * =================================================
             * CUSTOMER TEMPO ATOMIC FULFILLMENT
             *
             * Transaction yang SAMA:
             *
             * 1. Credit account validation
             * 2. Order DIRECT -> TEMPO
             * 3. Receivable obligation
             * 4. Dr Piutang / Cr Pendapatan
             * 5. Inventory SALE
             * 6. PENDING -> PACKING
             *
             * Jika inventory gagal, seluruh TEMPO activation
             * ikut ROLLBACK.
             *
             * Tidak pernah menerbitkan ORDER_PAID.
             * =================================================
             */
            const inventoryService =
                new OrderInventoryFulfillmentService(
                    client
                );

            const fulfillment =
                await inventoryService
                    .fulfillOrderSale({
                        orderId:
                            order.id
                    });

            const packingResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'PACKING'
                    WHERE id = $1
                      AND payment_mode = 'TEMPO'
                      AND status = 'PENDING'
                    RETURNING *
                    `,
                    [
                        order.id
                    ]
                );

            let operationalOrder = null;

            if (packingResult.rowCount) {
                operationalOrder =
                    packingResult.rows[0];
            } else {
                const currentOrderResult =
                    await client.query(
                        `
                        SELECT *
                        FROM tbl_orders_v2
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [
                            order.id
                        ]
                    );

                if (!currentOrderResult.rowCount) {
                    throw new Error(
                        'Order TEMPO tidak ditemukan setelah fulfillment'
                    );
                }

                operationalOrder =
                    currentOrderResult.rows[0];

                /*
                 * Retry yang sah sudah berada di PACKING.
                 * Status selain PACKING fail closed.
                 */
                if (
                    operationalOrder.payment_mode !==
                        'TEMPO' ||
                    operationalOrder.status !==
                        'PACKING'
                ) {
                    throw new Error(
                        'Status operasional Order TEMPO tidak valid'
                    );
                }
            }

            await client.query('COMMIT');

            return res
                .status(
                    result.status === 'existing'
                        ? 200
                        : 201
                )
                .json({
                    status:
                        'success',
                    idempotent:
                        result.status === 'existing',
                    message:
                        result.status === 'existing'
                            ? 'Order sudah menggunakan fasilitas TEMPO ini'
                            : 'Fasilitas TEMPO berhasil digunakan untuk order',
                    order:
                        operationalOrder,
                    obligation:
                        result.obligation,
                    fulfillment: {
                        reference_doc:
                            fulfillment.reference_doc,
                        movements:
                            fulfillment.movements
                    },
                    credit:
                        result.credit || null,
                    ledger_reference:
                        result.ledger_reference
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
                /wajib|tidak ditemukan|bukan milik|tidak cukup|stok tidak mencukupi|gagal mengurangi stok|tidak memiliki item|tidak ACTIVE|harus berstatus|sudah memiliki pembayaran|pembayaran UNPAID|fasilitas tempo lain|mode pembayaran|gagal diubah|status operasional/i
                    .test(message);

            console.error(
                '[CUSTOMER TEMPO ACTIVATION V1]',
                message
            );

            return res
                .status(
                    isClientError
                        ? 409
                        : 500
                )
                .json({
                    error:
                        message
                });

        } finally {
            client.release();
        }
    }
);



// ============================================================
// CUSTOMER TEMPO SETTLEMENT V1
// ============================================================
//
// Customer hanya dapat membayar piutang TEMPO miliknya.
//
// Security boundary:
//
// JWT user
// -> tbl_customers.user_id
// -> tbl_credit_accounts.customer_id
// -> tbl_credit_obligations.credit_account_id
//
// Settlement:
//
// Dr 1100 Kas & Bank
// Cr 1300 Piutang Usaha
//
// Tidak membuat tbl_payments.
// Tidak mengubah lifecycle operasional Order.
// Atomic dalam satu PostgreSQL transaction.
// ============================================================

router.post(
    '/customer/credit-obligations-v1/:id/settlements',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Resolve Customer dari JWT.
             * customer_id dari request body tidak dipercaya.
             */
            const customerResult =
                await client.query(
                    `
                    SELECT
                        id,
                        user_id,
                        full_name
                    FROM tbl_customers
                    WHERE user_id = $1
                    LIMIT 1
                    `,
                    [
                        req.user.id
                    ]
                );

            if (!customerResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Customer tidak ditemukan'
                });
            }

            const customer =
                customerResult.rows[0];

            /*
             * Ownership check.
             *
             * Lock obligation supaya ownership validation dan
             * settlement berada pada transaction yang sama.
             */
            const ownershipResult =
                await client.query(
                    `
                    SELECT
                        co.id,
                        co.credit_account_id,
                        co.source_type,
                        co.source_id,
                        co.principal_amount,
                        co.paid_amount,
                        co.status,
                        ca.customer_id,
                        ca.merchant_id,
                        ca.account_type
                    FROM tbl_credit_obligations co
                    JOIN tbl_credit_accounts ca
                        ON ca.id =
                            co.credit_account_id
                    WHERE co.id = $1
                    FOR UPDATE OF co
                    `,
                    [
                        req.params.id
                    ]
                );

            if (!ownershipResult.rowCount) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Piutang Customer tidak ditemukan'
                });
            }

            const obligation =
                ownershipResult.rows[0];

            if (
                obligation.account_type !==
                'CUSTOMER' ||
                obligation.source_type !==
                'ORDER'
            ) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error:
                        'Piutang Customer tidak ditemukan'
                });
            }

            if (
                String(
                    obligation.customer_id
                ) !==
                String(
                    customer.id
                )
            ) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error:
                        'Piutang bukan milik Customer ini'
                });
            }

            /*
             * Defense in depth:
             * obligation ORDER juga harus menunjuk order milik
             * Customer yang sama.
             */
            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        customer_id,
                        merchant_id,
                        payment_mode,
                        status
                    FROM tbl_orders_v2
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [
                        obligation.source_id
                    ]
                );

            if (!orderResult.rowCount) {
                throw new Error(
                    'Order sumber piutang tidak ditemukan'
                );
            }

            const order =
                orderResult.rows[0];

            if (
                String(order.customer_id) !==
                    String(customer.id) ||
                String(order.merchant_id) !==
                    String(obligation.merchant_id) ||
                order.payment_mode !==
                    'TEMPO'
            ) {
                throw new Error(
                    'Kontrak ownership piutang Customer tidak valid'
                );
            }

            const receivableService =
                new CustomerReceivableService(
                    client
                );

            const result =
                await receivableService
                    .settleCustomerObligation({
                        obligationId:
                            obligation.id,

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
                    status:
                        'success',

                    idempotent:
                        result.status ===
                        'existing',

                    message:
                        result.status ===
                        'existing'
                            ? 'Pembayaran piutang sudah pernah diproses'
                            : 'Pembayaran piutang Customer berhasil dicatat',

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
                /wajib|tidak valid|tidak ditemukan|bukan piutang|tidak ACTIVE|sudah lunas|CANCELLED|melebihi|ownership/i
                    .test(message);

            console.error(
                '[CUSTOMER TEMPO SETTLEMENT API]',
                message
            );

            return res
                .status(
                    isClientError
                        ? 409
                        : 500
                )
                .json({
                    error:
                        message
                });

        } finally {
            client.release();
        }
    }
);

module.exports = router;
